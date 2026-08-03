/**
 * FR-125: 短线策略 - 晨间集合竞价快照计算引擎（真实接口版本）
 *
 * 数据来源：
 *  - limit_list_daily（前一交易日）：前一日涨停股分 4 池（首板/二板/炸板/断板）
 *  - Tushare stk_auction（369，当日）：集合竞价成交数据（接口支持历史查询，传 trade_date 参数即可）
 *  - kpl_concept_members：题材归属（板态分类用）
 *  - weakToStrong 5 形态：基于 limit_list_daily 字段（firstTime/lastTime/openTimes/limitTimes/limit）判断，
 *    仅在 auctionMap 有该股竞价数据（09:25 当日已拉取）时生成候选
 *
 * 降级路径：Tushare 未配置时 auctionPrice=0，仍展示分池结构（DB 可用）
 */

import { getDb } from '../database/db'
import { getLimitListByDate, getLatestAvailableTradeDate } from '../database/limitListDailyRepository'
import { getLastNTradingDays, getNextTradeDay, isTradeDay } from '../database/tradeCalRepository'
import { getConceptsByStockRouted } from './conceptRouter'
import { insertConceptMembersIfAbsent } from '../database/kplConceptMembersRepository'
import { getConceptSource } from '../database/settingsRepository'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { fetchStkAuction, fetchDailyForCandidates, fetchKplConceptConsByStock } from './tushareService'
import { getRtKCache, refreshRtKCache, getLimitPct } from './sharedRtKCache'
import { queryDailyClose, upsertDailyClose } from '../database/dailyCloseCacheRepository'
import { queryByDate as queryStkAuctionByDate, upsertStkAuctionCache } from '../database/stkAuctionCacheRepository'
import { getKplListByDate } from '../database/kplConceptDailyRepository'
import {
  getLatestVerifiedObservationDateBefore,
  listSectorFlowObservations,
} from '../database/sectorFlowObservationRepository'
import type {
  LimitListDailyRow,
  MorningAuctionMarketThemeSummary,
  MorningAuctionThemeAttribution,
} from '../database/types'
import { emitDecisionSignals, type DecisionSignalInput } from './decisionSignalService'
import {
  buildMorningAuctionThemeAttributions,
  splitMorningAuctionThemeNames,
  type MorningAuctionDirectThemeFact,
} from './morningAuctionThemeAttributionModel'
import { buildMorningAuctionMarketThemes } from './morningAuctionMarketThemeModel'

export interface MorningAuctionStock {
  /** Tushare 风格代码: 000001.SZ / 600519.SH / 300750.SZ */
  tsCode: string
  /** 6 位纯数字代码: 000001 / 600519，前端 navigateToStock 使用 */
  stockCode: string
  stockName: string
  /** 竞价开盘价（元） */
  auctionPrice: number
  /** 前收盘价（元） */
  prevClose: number
  /** 较前收盘涨跌幅（百分比） */
  pctChg: number
  /** 集合竞价成交金额（万元） */
  auctionAmount: number
  /** 集合竞价换手率（%），来自 369 stk_auction turnover_rate 字段 */
  auctionTurnover: number
  /** 集合竞价成交量比（vs 前 5 日均量），可空 */
  volumeRatio: number | null  /** 当前最新价（元），来自 sharedRtKCache；数据不可用时为 null */
  currentPrice: number | null
  /** 当前涨跌幅（%），来自 sharedRtKCache；数据不可用时为 null */
  currentPctChg: number | null
  /** 当日累计成交额（元），来自 sharedRtKCache；数据不可用时为 null */
  currentAmount: number | null
  /** 近 3 个交易日累计涨跌幅（%），异步填充；未就绪时为 null */
  pctChg3d: number | null
  /** 近 5 个交易日累计涨跌幅（%），异步填充；未就绪时为 null */
  pctChg5d: number | null
  /** 题材列表（按热度降序），异步填充；未就绪时为空数组 */
  conceptNames: string[]
  /** 早盘题材归因。直接原因、竞价共振和静态关联保持分层，不把普通成分关系冒充主炒题材。 */
  themeAttribution?: MorningAuctionThemeAttribution | null
}

/** 弱转强候选股（含前一日形态元信息） */
export interface WeakToStrongStock extends MorningAuctionStock {
  /** 前一日形态描述（烂板炸板次数 / 尾盘偷袭板时间 / 断板连板数 等） */
  prevDayMeta: string
  /** 信号强度评分（0-100，越高越强） */
  signalStrength: number
}

/** 板态分类候选股 */
export interface BoardCategoryStock extends MorningAuctionStock {
  /** 昨日连板数 */
  limitTimes: number
  /** 题材热度（kpl_concept_daily.hot_num） */
  hotNum: number
}

export interface MorningAuctionSnapshot {
  /** 数据交易日 YYYYMMDD */
  tradeDate: string
  /** 快照生成时间戳 (ms) */
  generatedAt: number
  /** 是否为 mock 数据（前端显示提示横幅） */
  isMock: boolean
  /** 竞价三一信号：按昨日运行阶段分 4 个板块池，各池按「竞价金额×竞价换手率」乘积降序 */
  threeOne: {
    firstBoard: MorningAuctionStock[]   // 首板池（昨日 limit_times=1 且 limit='U'）
    secondBoard: MorningAuctionStock[]  // 二板池（昨日 limit_times>=2 且 limit='U'）
    brokenBoard: MorningAuctionStock[]  // 炸板池（昨日 open_times>=1 且 limit='U'）
    brokenConsec: MorningAuctionStock[] // 断板池（昨日 limit!='U' 且 limit_times>=2）
    allMarket: MorningAuctionStock[]    // 全市场池（竹价涨幅≥3%、金额≥5百万、换手率≥0.15%、流通市値≥30亿）
  }
  /** 弱转强 5 形态 */
  weakToStrong: {
    badBoard: WeakToStrongStock[] // 烂板弱转强
    tailAttack: WeakToStrongStock[] // 尾盘偷袭板弱转强
    brokenBoard: WeakToStrongStock[] // 断板弱转强
    afternoonReseal: WeakToStrongStock[] // 午后回封板弱转强
    reversal: WeakToStrongStock[] // 反包弱转强
  }
  /** 板态分类 */
  boardCategory: {
    first: BoardCategoryStock[] // 首板
    second: BoardCategoryStock[] // 二板
    third: BoardCategoryStock[] // 三板
    n: BoardCategoryStock[] // N 板（≥4 板）
  }
  /** 当前竞价候选反向聚合的市场主线及上一交易日真实板块资金双确认。 */
  marketThemes?: MorningAuctionMarketThemeSummary
}

export interface MorningAuctionTradeDateStatus {
  isTradeDay: boolean
  previousTradeDate: string | null
  nextTradeDate: string | null
  recommendedTradeDate: string | null
}

function isWeekdayYmd(tradeDate: string): boolean {
  const year = Number(tradeDate.slice(0, 4))
  const month = Number(tradeDate.slice(4, 6))
  const day = Number(tradeDate.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  const weekday = date.getUTCDay()
  return valid && weekday >= 1 && weekday <= 5
}

export function resolveMorningAuctionTradeDateStatus(tradeDate: string): MorningAuctionTradeDateStatus {
  const db = getDb()
  const calendarResult = isTradeDay(db, tradeDate)
  const tradeDay = calendarResult ?? isWeekdayYmd(tradeDate)
  const recentTradeDates = getLastNTradingDays(db, 2, tradeDate)
  const previousTradeDate = tradeDay
    ? (recentTradeDates.at(-1) === tradeDate ? recentTradeDates.at(-2) ?? null : recentTradeDates.at(-1) ?? null)
    : recentTradeDates.at(-1) ?? null
  const fallbackDate = getLatestAvailableTradeDate(db)
  const recommendedTradeDate = previousTradeDate ?? (fallbackDate && fallbackDate < tradeDate ? fallbackDate : null)

  return {
    isTradeDay: tradeDay,
    previousTradeDate,
    nextTradeDate: getNextTradeDay(db, tradeDate),
    recommendedTradeDate: tradeDay ? null : recommendedTradeDate
  }
}

function createEmptyMorningAuctionSnapshot(tradeDate: string): MorningAuctionSnapshot {
  return {
    tradeDate,
    generatedAt: Date.now(),
    isMock: false,
    threeOne: { firstBoard: [], secondBoard: [], brokenBoard: [], brokenConsec: [], allMarket: [] },
    weakToStrong: { badBoard: [], tailAttack: [], brokenBoard: [], afternoonReseal: [], reversal: [] },
    boardCategory: { first: [], second: [], third: [], n: [] },
    marketThemes: buildMorningAuctionMarketThemes([], [], null),
  }
}

/**
 * 计算弱转强信号强度（0-100）：
 *   竞价涨幅（0-40）+ 竞价金额（0-30，按 300万封顶）+ 换手率（0-30，按 0.3% 封顶）
 */
function calcSignalStrength(
  pctChg: number,
  auctionAmount: number, // 万元
  auctionTurnover: number // %
): number {
  const pctScore = Math.min(Math.max(pctChg, 0) / 10 * 40, 40)      // 0%→0, 10%→40
  const amtScore = Math.min(auctionAmount / 300 * 30, 30)            // 0→0, 300万→30
  const trnScore = Math.min(auctionTurnover / 0.3 * 30, 30)          // 0→0, 0.3%→30
  return Math.round(pctScore + amtScore + trnScore)
}

/** 尝试从 prevRow 构建弱转强候选，不符合竞价门槛则返回 null */
function tryBuildWeakToStrong(
  row: LimitListDailyRow,
  auctionEntry: { price: number | null; preClose: number | null; turnoverRate: number | null; volumeRatio: number | null; amount: number | null } | undefined,
  minPctChg: number,  // 竞价最低涨幅门槛（%）
  prevDayMeta: string
): WeakToStrongStock | null {
  if (!auctionEntry) return null
  const base = buildAuctionStock(row, auctionEntry)
  if (base.pctChg < minPctChg) return null
  return {
    ...base,
    prevDayMeta,
    signalStrength: calcSignalStrength(base.pctChg, base.auctionAmount, base.auctionTurnover)
  }
}

/**
 * 将 Tushare first_time/last_time 字段解析为分钟数，用于数值比较。
 * 兼容格式：'92503'(Hmmss 5位) / '092503'(HHmmss 6位) / '9:25:03' / '09:25:03'
 * 空字符串或无法解析返回 -1。
 */
function parseTimeToMinutes(t: string): number {
  if (!t) return -1
  if (t.includes(':')) {
    const parts = t.split(':')
    const h = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    if (isNaN(h) || isNaN(m)) return -1
    return h * 60 + m
  }
  // 纯数字：5 位 Hmmss 或 6 位 HHmmss
  if (t.length === 5) {
    return parseInt(t[0], 10) * 60 + parseInt(t.slice(1, 3), 10)
  }
  if (t.length === 6) {
    return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2, 4), 10)
  }
  return -1
}

/** 将 Tushare 时间字段格式化为 HH:mm 供显示（兼容多种输入格式） */
function formatTimeField(t: string): string {
  if (!t) return ''
  if (t.includes(':')) return t.slice(0, 5)          // '09:25:03' → '09:25'
  if (t.length === 5) return `0${t[0]}:${t.slice(1, 3)}`  // '92503' → '09:25'
  if (t.length === 6) return `${t.slice(0, 2)}:${t.slice(2, 4)}` // '092503' → '09:25'
  return t
}

function getAuctionLimitPct(stock: MorningAuctionStock): number {
  const code = stock.stockCode || stock.tsCode.split('.')[0]
  const name = stock.stockName.toUpperCase()
  if (name.includes('ST')) return 5
  if (stock.tsCode.endsWith('.BJ') || code.startsWith('8') || code.startsWith('4')) return 30
  if (code.startsWith('300') || code.startsWith('301') || code.startsWith('688') || code.startsWith('689')) return 20
  return 10
}

function isAuctionOneWordBoard(stock: MorningAuctionStock): boolean {
  if (stock.auctionPrice <= 0 || stock.prevClose <= 0) return false
  return stock.pctChg >= getAuctionLimitPct(stock) - 0.3
}

/** 判断当前北京时间是否在集合竞价窗口（09:25-09:29，工作日） */
/** 构建一条 MorningAuctionStock（竞价数据缺失时价格相关字段置 0） */
function buildAuctionStock(
  row: LimitListDailyRow,
  auction: { price: number | null; preClose: number | null; turnoverRate: number | null; volumeRatio: number | null; amount: number | null; floatShare?: number | null } | undefined
): MorningAuctionStock {
  const auctionPrice = auction?.price ?? 0
  const prevClose = auction?.preClose ?? row.close ?? 0
  const pctChg =
    prevClose > 0 && auctionPrice > 0
      ? Number(((auctionPrice - prevClose) / prevClose * 100).toFixed(2))
      : 0
  return {
    tsCode: row.tsCode,
    stockCode: row.tsCode.split('.')[0],
    stockName: row.name ?? '',
    auctionPrice,
    prevClose,
    pctChg,
    // amount 单位为元，转为万元；无竞价数据时为 0
    auctionAmount: auction?.amount != null ? Number((auction.amount / 10000).toFixed(2)) : 0,
    auctionTurnover: auction?.turnoverRate ?? 0,
    volumeRatio: auction?.volumeRatio ?? null,
    currentPrice: null,
    currentPctChg: null,
    currentAmount: null,
    pctChg3d: null,
    pctChg5d: null,
    conceptNames: []
  }
}

/** 构建真实晨间竞价快照 */
async function buildRealMorningAuctionSnapshot(tradeDate: string): Promise<MorningAuctionSnapshot> {
  const db = getDb()

  // 获取候选股基准日期（即「前一交易日」）
  // 始终取 limit_list_daily 中 < tradeDate 的最大日期，无论今日数据是否已发布。
  // 不依赖 getLatestAvailableTradeDate()，避免 DB 日内新增数据后 prevDate 发生漂移。
  const prevRow = db.prepare(
    'SELECT MAX(trade_date) AS prev FROM limit_list_daily WHERE trade_date < ?'
  ).get(tradeDate) as { prev: string | null } | undefined
  const prevDate = prevRow?.prev ?? null

  const emptySnapshot = createEmptyMorningAuctionSnapshot(tradeDate)

  if (!prevDate) return emptySnapshot

  // 读取前一交易日全部涨停/炸板记录
  const prevRows = getLimitListByDate(db, prevDate)
  if (prevRows.length === 0) return emptySnapshot

  // stk_auction 支持历史查询（传 trade_date 参数），任何时段均可调用，不受时间窗口限制
  // 只要 Tushare token 已配置即调用；时间窗口判断仅在调度器自动预热逻辑中使用
  const cfg = getDataSourceConfig(db)
  const token = cfg.tushareEnabled && cfg.tushareTokenEncrypted
    ? decryptApiKey(cfg.tushareTokenEncrypted)
    : null

  const auctionMap = new Map<string, { price: number | null; preClose: number | null; turnoverRate: number | null; volumeRatio: number | null; amount: number | null; floatShare: number | null }>()

  for (const row of queryStkAuctionByDate(db, tradeDate)) {
    auctionMap.set(row.tsCode, {
      price: row.price,
      preClose: row.preClose,
      turnoverRate: row.turnoverRate,
      volumeRatio: row.volumeRatio,
      amount: row.amount,
      floatShare: row.floatShare,
    })
  }

  // stk_auction 支持按 trade_date 查历史，任何时段均可获取当日竞价成交数据
  if (token) {
    try {
      const auctionRows = await fetchStkAuction(token, tradeDate)
      for (const r of auctionRows) {
        auctionMap.set(r.tsCode, {
          price: r.price,
          preClose: r.preClose,
          turnoverRate: r.turnoverRate,
          volumeRatio: r.volumeRatio,
          amount: r.amount,
          floatShare: r.floatShare
        })
      }
      if (auctionRows.length > 0) {
        try {
          upsertStkAuctionCache(db, auctionRows)
        } catch (error) {
          console.warn(`[morningAuction] persist stk_auction ${tradeDate} failed:`, error)
        }
      }
    } catch (err) {
      console.warn('[morningAuction] fetchStkAuction failed:', err)
    }
  }

  // 批量查询 DB 中已有的题材信息，减少重复 IO
  const conceptSource = getConceptSource()
  const dbConceptMap = new Map<string, { names: string[]; hotNum: number | null }>()
  for (const row of prevRows) {
    const concepts = getConceptsByStockRouted(db, row.tsCode, conceptSource)
    if (concepts.length > 0) {
      // 按名称去重（THS 模式下同名概念可能对应多个 conceptCode，避免重复显示）
      const uniqueNames = [...new Set(concepts.map(c => c.conceptName).filter(n => n !== '无题材' && n !== ''))]
      dbConceptMap.set(row.tsCode, { names: uniqueNames.length > 0 ? uniqueNames : concepts.map(c => c.conceptName), hotNum: null })
    }
  }

  // 按昨日数据分 4 池（各池按竞价金额 × 竞价换手率乘积降序——双第一逻辑）
  const firstBoard: MorningAuctionStock[] = []   // 首板：limit='U', openTimes=0, limitTimes=1
  const secondBoard: MorningAuctionStock[] = []  // 二板：limit='U', openTimes=0, limitTimes>=2
  const brokenBoard: MorningAuctionStock[] = []  // 炸板后封回：limit='U', openTimes>=1
  const brokenConsec: MorningAuctionStock[] = [] // 断板：limit!='U', limitTimes>=2


  for (const row of prevRows) {
    const limitTimes = row.limitTimes ?? 0
    const openTimes = row.openTimes ?? 0
    const limit = row.limit
    const stock = buildAuctionStock(row, auctionMap.get(row.tsCode))

    stock.conceptNames = dbConceptMap.get(row.tsCode)?.names ?? []

    // 今日竞价价格已触及跌停（含 0.3% 容差）→ 无可操作性，不进任何池
    // 仅当 auctionMap 有该股数据时才检测，避免 pctChg=0 误杀无竞价记录股
    if (auctionMap.has(row.tsCode)) {
      const downLimit = getLimitPct(row.tsCode, row.name ?? null)
      if (stock.pctChg <= -(downLimit - 0.3)) continue
    }

    if (limit === 'U') {
      if (openTimes >= 1) {
        brokenBoard.push(stock)       // 炸板后最终封回
      } else if (limitTimes >= 2) {
        secondBoard.push(stock)       // 二板及以上干净封板
      } else {
        firstBoard.push(stock)        // 首板干净一字
      }
    } else if (limitTimes >= 2) {
      brokenConsec.push(stock)        // 昨日断板（历史连板 >=2 但昨日未封板）
    }
  }

  const sortByProduct = (arr: MorningAuctionStock[]) =>
    arr.sort((a, b) => b.auctionAmount * b.auctionTurnover - a.auctionAmount * a.auctionTurnover)

  // ── 全市场池：遍历 auctionMap 全量，筛选竞价异动股 ──
  // 筛选条件：竞价涨幅≥3%、竞价金额≥500万元、竞价换手率≥0.15%、流通市值≥30亿
  // 注意：不排除已在其他池中的股票——allMarket 视角纯粹基于今日竞价数据，与昨日连板状态无关

  // 方案A：若 rtK 缓存尚未预热（首次启动或日切），先刷新一次确保名称数据可用
  let rtKCache = getRtKCache()
  if (!rtKCache && token) {
    try {
      await refreshRtKCache(token)
      rtKCache = getRtKCache()
    } catch (e) {
      console.warn('[allMarket] rtK 预热失败，名称将依赖兜底表:', e)
    }
  }

  // 兜底表1：limit_list_daily 历史涨停股名称（stk_auction / rt_k 接口不保证返回 name 字段）
  const histNameRows = db
    .prepare('SELECT DISTINCT ts_code, name FROM limit_list_daily WHERE name IS NOT NULL')
    .all() as { ts_code: string; name: string }[]
  const histNameMap = new Map(histNameRows.map(r => [r.ts_code, r.name]))
  // 兜底表2：kpl_concept_members 题材成分股名称（ts_code=股票代码，name=股票名称）
  const kplNameRows = db
    .prepare('SELECT DISTINCT ts_code, name FROM kpl_concept_members WHERE name IS NOT NULL')
    .all() as { ts_code: string; name: string }[]
  const kplNameMap = new Map(kplNameRows.map(r => [r.ts_code, r.name]))
  // 兜底表3：stock_info（用户历史访问股票，key=6位纯数字 stockCode）
  const stockInfoRows = db
    .prepare('SELECT stockCode, stockName FROM stock_info WHERE stockName IS NOT NULL')
    .all() as { stockCode: string; stockName: string }[]
  const stockInfoMap = new Map(stockInfoRows.map(r => [r.stockCode, r.stockName]))
  const allMarket: MorningAuctionStock[] = []
  for (const [tsCode, entry] of auctionMap.entries()) {
    const { price, preClose, amount, turnoverRate, floatShare } = entry
    if (!price || !preClose || price <= 0 || preClose <= 0) continue
    const pctChg = (price - preClose) / preClose * 100
    if (pctChg < 3) continue
    if (!amount || amount < 5_000_000) continue           // 竞价金额 < 500万元
    if (!turnoverRate || turnoverRate < 0.15) continue    // 竞价换手率 < 0.15%
    // 流通市值 = floatShare(万股) × 10000 × price(元) / 1e8(亿) = floatShare × price / 10000
    if (!floatShare || floatShare * price / 10000 < 30) continue  // 流通市值 < 30亿
    // 构建 MorningAuctionStock（无 LimitListDailyRow，独立构建）
    const rtEntry = rtKCache?.get(tsCode)
    const nameFromRt = rtEntry?.name ?? null
    const nameFromHist = histNameMap.get(tsCode) ?? null
    const nameFromKpl = kplNameMap.get(tsCode) ?? null
    const stockCode6 = tsCode.split('.')[0]
    const nameFromStockInfo = stockInfoMap.get(stockCode6) ?? null
    // 名称优先级：rt_k 缓存 → limit_list_daily 历史 → kpl_concept_members → stock_info → 空字符串
    const resolvedName = nameFromRt ?? nameFromHist ?? nameFromKpl ?? nameFromStockInfo ?? ''
    if (!resolvedName) {
      console.warn(`[allMarket] 无法解析股票名称 tsCode=${tsCode}: rtK=${nameFromRt} hist=${nameFromHist} kpl=${nameFromKpl} stockInfo=${nameFromStockInfo} rtKCacheSize=${rtKCache?.size ?? 0}`)
    }
    const stock: MorningAuctionStock = {
      tsCode,
      stockCode: stockCode6,
      stockName: resolvedName,
      auctionPrice: price,
      prevClose: preClose,
      pctChg: Number(pctChg.toFixed(2)),
      auctionAmount: Number((amount / 10000).toFixed(2)),
      auctionTurnover: turnoverRate,
      volumeRatio: entry.volumeRatio ?? null,
      currentPrice: rtEntry?.price ?? null,
      currentPctChg: rtEntry?.change ?? null,
      currentAmount: rtEntry?.amount ?? null,
      pctChg3d: null,
      pctChg5d: null,
      conceptNames: (() => {
        const cached = dbConceptMap.get(tsCode)
        if (cached) return cached.names
        // allMarket 池可能包含昨日未涨停的股票，dbConceptMap 中无记录，需单独查路由层
        const cs = getConceptsByStockRouted(db, tsCode, conceptSource)
        return [...new Set(cs.map(c => c.conceptName).filter(n => n !== '无题材' && n !== ''))]
      })(),
    }
    allMarket.push(stock)
  }

  // 板态分类（按昨日 limitTimes 分 4 档，补充 kpl_concept_members 题材信息）
  const bcFirst: BoardCategoryStock[] = []
  const bcSecond: BoardCategoryStock[] = []
  const bcThird: BoardCategoryStock[] = []
  const bcN: BoardCategoryStock[] = []

  for (const row of prevRows.filter(r => r.limit === 'U')) {
    const limitTimes = row.limitTimes ?? 1
    const conceptEntry = dbConceptMap.get(row.tsCode)
    const hotNum = conceptEntry?.hotNum ?? 0
    const stock: BoardCategoryStock = {
      ...buildAuctionStock(row, auctionMap.get(row.tsCode)),
      limitTimes,
      conceptNames: conceptEntry?.names ?? [],
      hotNum
    }
    if (limitTimes >= 4) bcN.push(stock)
    else if (limitTimes === 3) bcThird.push(stock)
    else if (limitTimes === 2) bcSecond.push(stock)
    else bcFirst.push(stock)
  }

  // 弱转强 5 形态：基于昨日 limit_list_daily 字段判断，仅有竞价数据的股票才生成候选
  const wkBadBoard: WeakToStrongStock[] = []
  const wkTailAttack: WeakToStrongStock[] = []
  const wkBrokenBoard: WeakToStrongStock[] = []
  const wkAfternoonReseal: WeakToStrongStock[] = []
  const wkReversal: WeakToStrongStock[] = []

  for (const row of prevRows) {
    const openTimes = row.openTimes ?? 0
    const limitTimes = row.limitTimes ?? 0
    const limit = row.limit
    const firstTime = row.firstTime ?? ''
    const lastTime = row.lastTime ?? ''
    const auctionEntry = auctionMap.get(row.tsCode)

    // ① 烂板弱转强：昨日涨停但开板 >= 3 次，竞价高开 >= 1%
    if (limit === 'U' && openTimes >= 3) {
      const s = tryBuildWeakToStrong(row, auctionEntry, 1,
        `昨日开板 ${openTimes} 次后封回，主力昨日卸压重吸筹`)
      if (s) wkBadBoard.push(s)
    }

    // ② 尾盘偷袭板：昨日涨停首封时间 >= 14:30，竞价高开 >= 1%
    if (limit === 'U' && parseTimeToMinutes(firstTime) >= 14 * 60 + 30) {
      const s = tryBuildWeakToStrong(row, auctionEntry, 1,
        `昨日 ${formatTimeField(firstTime)} 尾盘封板，主力全天压盘吸筹`)
      if (s) wkTailAttack.push(s)
    }

    // ③ 断板弱转强：昨日历史连板 >= 2 但当日未涨停，竞价高开 >= 1%
    if (limit !== 'U' && limit !== 'D' && limitTimes >= 2) {
      const s = tryBuildWeakToStrong(row, auctionEntry, 1,
        `历史 ${limitTimes} 连板昨日断板，今日竞价重新发力`)
      if (s) wkBrokenBoard.push(s)
    }

    // ④ 午后回封：昨日早盘封板（firstTime < 12:00）+ 中途炸板 + 午后再封（lastTime > 13:00），竞价高开 >= 1%
    const ftMin = parseTimeToMinutes(firstTime)
    const ltMin = parseTimeToMinutes(lastTime)
    if (
      limit === 'U' &&
      openTimes >= 1 &&
      ftMin > 0 &&
      ftMin < 12 * 60 &&
      ltMin > 13 * 60
    ) {
      const s = tryBuildWeakToStrong(row, auctionEntry, 1,
        `早盘 ${formatTimeField(firstTime)} 封板，午盘炸开后 ${formatTimeField(lastTime)} 回封`)
      if (s) wkAfternoonReseal.push(s)
    }

    // ⑤ 反包弱转强：昨日跌停（limit='D'），竞价高开 >= 3%
    if (limit === 'D') {
      const s = tryBuildWeakToStrong(row, auctionEntry, 3,
        `昨日跌停，今日竞价强势反包`)
      if (s) wkReversal.push(s)
    }
  }

  // 各形态按信号强度降序
  const sortByStrength = (arr: WeakToStrongStock[]) =>
    arr.sort((a, b) => b.signalStrength - a.signalStrength)

  return {
    tradeDate,
    generatedAt: Date.now(),
    isMock: false,
    threeOne: {
      firstBoard: sortByProduct(firstBoard),
      secondBoard: sortByProduct(secondBoard),
      brokenBoard: sortByProduct(brokenBoard),
      brokenConsec: sortByProduct(brokenConsec),
      allMarket: sortByProduct(allMarket),
    },
    weakToStrong: {
      badBoard: sortByStrength(wkBadBoard),
      tailAttack: sortByStrength(wkTailAttack),
      brokenBoard: sortByStrength(wkBrokenBoard),
      afternoonReseal: sortByStrength(wkAfternoonReseal),
      reversal: sortByStrength(wkReversal)
    },
    boardCategory: {
      first: bcFirst.sort((a, b) => b.hotNum - a.hotNum),
      second: bcSecond.sort((a, b) => b.hotNum - a.hotNum),
      third: bcThird.sort((a, b) => b.hotNum - a.hotNum),
      n: bcN.sort((a, b) => b.limitTimes - a.limitTimes || b.hotNum - a.hotNum)
    }
  }
}

/** 内存缓存：避免前端每次切换 Tab 都重新计算 */
let cachedSnapshot: MorningAuctionSnapshot | null = null

// ===== 题材列异步填充 =====
let _conceptCache: { tradeDate: string; data: Map<string, string[]> } | null = null
let _conceptFetchInFlight = false

/** 将缓存好的题材数据 apply 到快照中所有 conceptNames 为空的股票 */
function applyConceptToSnap(snap: MorningAuctionSnapshot, data: Map<string, string[]>): void {
  const pools: MorningAuctionStock[][] = [
    snap.threeOne.firstBoard, snap.threeOne.secondBoard,
    snap.threeOne.brokenBoard, snap.threeOne.brokenConsec,
    snap.threeOne.allMarket,
    snap.weakToStrong.badBoard, snap.weakToStrong.tailAttack,
    snap.weakToStrong.brokenBoard, snap.weakToStrong.afternoonReseal,
    snap.weakToStrong.reversal,
    snap.boardCategory.first, snap.boardCategory.second,
    snap.boardCategory.third, snap.boardCategory.n
  ]
  for (const pool of pools) {
    for (const s of pool) {
      if (s.conceptNames.length === 0 && data.has(s.tsCode)) {
        s.conceptNames = data.get(s.tsCode) ?? []
      }
    }
  }
}

/**
 * 异步补查题材数据（fire-and-forget）。
 * 对 DB 无题材记录的股票，批量调 fetchKplConceptConsByStock 补查并写入 DB，
 * 最终 in-place 更新 cachedSnapshot 中对应字段，前端二次 get() 即可拿到数据。
 */
async function mergeConceptData(snap: MorningAuctionSnapshot, tradeDate: string): Promise<void> {
  // 缓存命中直接 apply
  if (_conceptCache && _conceptCache.tradeDate === tradeDate) {
    applyConceptToSnap(snap, _conceptCache.data)
    applyThemeAttributionToSnapshot(snap)
    return
  }
  if (_conceptFetchInFlight) return
  _conceptFetchInFlight = true
  try {
    const db = getDb()
    const cfg = getDataSourceConfig(db)
    if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) return
    const token = decryptApiKey(cfg.tushareTokenEncrypted)
    if (!token) return

    // 收集全部 conceptName===null 的股票（去重）
    const allPools: MorningAuctionStock[][] = [
      snap.threeOne.firstBoard, snap.threeOne.secondBoard,
      snap.threeOne.brokenBoard, snap.threeOne.brokenConsec,
      snap.threeOne.allMarket,
      snap.weakToStrong.badBoard, snap.weakToStrong.tailAttack,
      snap.weakToStrong.brokenBoard, snap.weakToStrong.afternoonReseal,
      snap.weakToStrong.reversal,
      snap.boardCategory.first, snap.boardCategory.second,
      snap.boardCategory.third, snap.boardCategory.n
    ]
    const missingCodes = [...new Set(allPools.flat().filter(s => s.conceptNames.length === 0).map(s => s.tsCode))]
    if (missingCodes.length === 0) return

    // 分批并发（每批 5 只）补查 Tushare kpl_concept_cons，结果写入 DB
    const resultMap = new Map<string, string[]>()
    const BATCH = 5
    for (let i = 0; i < missingCodes.length; i += BATCH) {
      const batch = missingCodes.slice(i, i + BATCH)
      await Promise.all(batch.map(async (tsCode) => {
        try {
          const rows = await fetchKplConceptConsByStock(token, tsCode)
          if (rows.length > 0) {
            insertConceptMembersIfAbsent(db, rows)
            // 按 hotNum 降序存全部题材名，并去重（API 可能返回同名重复行）
            const sorted = rows.slice().sort((a, b) => (b.hotNum ?? 0) - (a.hotNum ?? 0))
            resultMap.set(tsCode, [...new Set(sorted.map(r => r.name ?? '').filter(s => s !== ''))])
          } else {
            resultMap.set(tsCode, [])
          }
        } catch {
          resultMap.set(tsCode, [])
        }
      }))
    }

    _conceptCache = { tradeDate, data: resultMap }
    applyConceptToSnap(snap, resultMap)
    applyThemeAttributionToSnapshot(snap)
  } catch (err) {
    console.error('[mergeConceptData] failed, conceptNames will remain empty:', err)
  } finally {
    _conceptFetchInFlight = false
  }
}

// ===== FR-134: N 日涨跌风险列 =====
interface HistoryEntry { p3d: number | null; p5d: number | null }
let _historyCache: { tradeDate: string; data: Map<string, HistoryEntry> } | null = null
let _historyFetchPromise: Promise<void> | null = null

/** 计算 YYYYMMDD 向前 N 个日历日 */
function subtractCalendarDays(ymd: string, days: number): string {
  const d = new Date(
    parseInt(ymd.slice(0, 4), 10),
    parseInt(ymd.slice(4, 6), 10) - 1,
    parseInt(ymd.slice(6, 8), 10)
  )
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 从 _historyCache 将已计算的 3d/5d 数据 apply 到 snap 的所有池 */
function applyHistoryToSnap(snap: MorningAuctionSnapshot, data: Map<string, HistoryEntry>): void {
  const pools: MorningAuctionStock[][] = [
    snap.threeOne.firstBoard, snap.threeOne.secondBoard,
    snap.threeOne.brokenBoard, snap.threeOne.brokenConsec,
    snap.threeOne.allMarket,
    snap.weakToStrong.badBoard, snap.weakToStrong.tailAttack,
    snap.weakToStrong.brokenBoard, snap.weakToStrong.afternoonReseal,
    snap.weakToStrong.reversal,
    snap.boardCategory.first, snap.boardCategory.second,
    snap.boardCategory.third, snap.boardCategory.n
  ]
  for (const pool of pools) {
    for (const s of pool) {
      const entry = data.get(s.tsCode)
      if (entry) {
        s.pctChg3d = entry.p3d
        s.pctChg5d = entry.p5d
      }
    }
  }
}

/**
 * 异步填充 3/5 日涨跌数据（fire-and-forget）。
 * 完成后直接更新 cachedSnapshot（in-place），前端二次 get() 即可拿到数据。
 */
async function mergePriceHistory(snap: MorningAuctionSnapshot, tradeDate: string): Promise<void> {
  // 已有内存缓存直接 apply（同一次启动内）
  if (_historyCache && _historyCache.tradeDate === tradeDate) {
    applyHistoryToSnap(snap, _historyCache.data)
    return
  }
  // 防并发：等待已有 in-flight Promise（而非直接 return），确保数据一定被 apply
  if (_historyFetchPromise !== null) {
    await _historyFetchPromise
    // in-flight 完成后缓存已写入，直接 apply
    if (_historyCache && _historyCache.tradeDate === tradeDate) {
      applyHistoryToSnap(snap, _historyCache.data)
    }
    return
  }

  // 启动新的 fetch，记录 Promise 供并发调用方等待
  _historyFetchPromise = (async () => {
    try {
      const db = getDb()

      // 收集全部候选 tsCode（去重）
      const allPools: MorningAuctionStock[][] = [
        snap.threeOne.firstBoard, snap.threeOne.secondBoard,
        snap.threeOne.brokenBoard, snap.threeOne.brokenConsec,
        snap.threeOne.allMarket,
        snap.weakToStrong.badBoard, snap.weakToStrong.tailAttack,
        snap.weakToStrong.brokenBoard, snap.weakToStrong.afternoonReseal,
        snap.weakToStrong.reversal,
        snap.boardCategory.first, snap.boardCategory.second,
        snap.boardCategory.third, snap.boardCategory.n
      ]
      const tsCodes = [...new Set(allPools.flat().map(s => s.tsCode))]
      if (tsCodes.length === 0) return

      // 60 个日历日 ≈ 40+ 个交易日（覆盖五一等长假后仍有足够历史），确保 DB ≥ 20 行阈值
      const startDate = subtractCalendarDays(tradeDate, 60)

      // FR-138: 先查 DB 缓存；行数不足 20 的股票才发起 API 请求
      const cachedMap = queryDailyClose(db, tsCodes, startDate)
      const missingCodes = tsCodes.filter(c => (cachedMap.get(c)?.length ?? 0) < 20)

      // 合并 API 补拉数据到 cachedMap（显式传 end_date=tradeDate 确保 Tushare 返回完整历史范围）
      if (missingCodes.length > 0) {
        const cfg = getDataSourceConfig(db)
        if (cfg.tushareEnabled && cfg.tushareTokenEncrypted) {
          const token = decryptApiKey(cfg.tushareTokenEncrypted)
          const apiRows = token
            ? await fetchDailyForCandidates(token, missingCodes, startDate, tradeDate)
            : []
          if (apiRows.length > 0) {
            upsertDailyClose(db, apiRows)
            for (const r of apiRows) {
              if (!cachedMap.has(r.tsCode)) cachedMap.set(r.tsCode, [])
              cachedMap.get(r.tsCode)!.push(r)
            }
            // 补拉的数据需保证升序
            for (const arr of cachedMap.values()) {
              arr.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
            }
          }
        }
      }

      // 计算每只股票的 pctChg3d / pctChg5d
      const resultMap = new Map<string, HistoryEntry>()
      for (const [tsCode, arr] of cachedMap.entries()) {
        // 找 tradeDate 位置（或最近一个 <= tradeDate 的位置）
        let i = arr.length - 1
        while (i >= 0 && arr[i].tradeDate > tradeDate) i--
        if (i < 0) { resultMap.set(tsCode, { p3d: null, p5d: null }); continue }
        const todayClose = arr[i].close
        const p3d = i >= 3
          ? (todayClose - arr[i - 3].close) / arr[i - 3].close * 100
          : null
        const p5d = i >= 5
          ? (todayClose - arr[i - 5].close) / arr[i - 5].close * 100
          : null
        resultMap.set(tsCode, { p3d, p5d })
      }

      _historyCache = { tradeDate, data: resultMap }
      applyHistoryToSnap(snap, resultMap)
    } catch (err) {
      // 静默失败：3d/5d 保持 null，不影响页面渲染
      console.error('[mergePriceHistory] failed, pctChg3d/5d will remain null:', err)
    } finally {
      _historyFetchPromise = null
    }
  })()

  await _historyFetchPromise
}

/**
 * rt_k 盘中实时缓存可用时，后续调用的 mergeCurrentPrices 会覆盖此处的值。
 */
function mergeTodayClose(snap: MorningAuctionSnapshot, tradeDate: string): void {
  const db = getDb()
  const todayRows = getLimitListByDate(db, tradeDate)
  if (todayRows.length === 0) return
  const closeMap = new Map<string, { close: number | null; pctChg: number | null }>()
  for (const r of todayRows) {
    closeMap.set(r.tsCode, { close: r.close, pctChg: r.pctChg })
  }
  const pools: MorningAuctionStock[][] = [
    snap.threeOne.firstBoard, snap.threeOne.secondBoard,
    snap.threeOne.brokenBoard, snap.threeOne.brokenConsec,
    snap.threeOne.allMarket,
    snap.weakToStrong.badBoard, snap.weakToStrong.tailAttack,
    snap.weakToStrong.brokenBoard, snap.weakToStrong.afternoonReseal,
    snap.weakToStrong.reversal,
    snap.boardCategory.first, snap.boardCategory.second,
    snap.boardCategory.third, snap.boardCategory.n
  ]
  for (const pool of pools) {
    for (const s of pool) {
      if (s.currentPrice != null) continue  // 已有数据不覆盖
      const entry = closeMap.get(s.tsCode)
      if (entry?.close != null) {
        s.currentPrice = entry.close
        s.currentPctChg = entry.pctChg ?? null
      }
    }
  }
}

/**
 * 从 sharedRtKCache 将当前实时价格 merge 到快照中的每条股票。
 * 缓存为 null（尚未拉取或盘前）时静默跳过，currentPrice 保持 null。
 */
function mergeCurrentPrices(snap: MorningAuctionSnapshot): void {
  const cache = getRtKCache()
  if (!cache) return

  const fillStock = (s: MorningAuctionStock): void => {
    const entry = cache.get(s.tsCode)
    if (entry) {
      s.currentPrice = entry.price
      s.currentPctChg = entry.change
      s.currentAmount = entry.amount
    }
  }

  const pools: MorningAuctionStock[][] = [
    snap.threeOne.firstBoard,
    snap.threeOne.secondBoard,
    snap.threeOne.brokenBoard,
    snap.threeOne.brokenConsec,
    snap.threeOne.allMarket,
    snap.weakToStrong.badBoard,
    snap.weakToStrong.tailAttack,
    snap.weakToStrong.brokenBoard,
    snap.weakToStrong.afternoonReseal,
    snap.weakToStrong.reversal,
    snap.boardCategory.first,
    snap.boardCategory.second,
    snap.boardCategory.third,
    snap.boardCategory.n
  ]
  for (const pool of pools) {
    for (const s of pool) fillStock(s)
  }
}

function getSnapshotPools(snap: MorningAuctionSnapshot): MorningAuctionStock[][] {
  return [
    snap.threeOne.firstBoard,
    snap.threeOne.secondBoard,
    snap.threeOne.brokenBoard,
    snap.threeOne.brokenConsec,
    snap.threeOne.allMarket,
    snap.weakToStrong.badBoard,
    snap.weakToStrong.tailAttack,
    snap.weakToStrong.brokenBoard,
    snap.weakToStrong.afternoonReseal,
    snap.weakToStrong.reversal,
    snap.boardCategory.first,
    snap.boardCategory.second,
    snap.boardCategory.third,
    snap.boardCategory.n,
  ]
}

function applyThemeAttributionToSnapshot(snap: MorningAuctionSnapshot): void {
  const uniqueStocks = [...new Map(
    getSnapshotPools(snap).flat().map((stock) => [stock.tsCode, stock]),
  ).values()]

  const db = getDb()
  const candidateDateRow = db.prepare(
    'SELECT MAX(trade_date) AS trade_date FROM limit_list_daily WHERE trade_date < ?',
  ).get(snap.tradeDate) as { trade_date: string | null } | undefined
  const previousTradeDate = candidateDateRow?.trade_date
    ?? resolveMorningAuctionTradeDateStatus(snap.tradeDate).previousTradeDate
  const directFacts = new Map<string, MorningAuctionDirectThemeFact>()
  if (previousTradeDate) {
    for (const row of getKplListByDate(db, previousTradeDate)) {
      const themes = splitMorningAuctionThemeNames(row.theme)
      if (themes.length === 0 && !row.luDesc) continue
      directFacts.set(row.tsCode, {
        tradeDate: row.tradeDate,
        themes,
        reason: row.luDesc,
      })
    }
  }

  const attributionByCode = buildMorningAuctionThemeAttributions(
    uniqueStocks.map((stock) => ({
      tsCode: stock.tsCode,
      stockName: stock.stockName,
      conceptNames: stock.conceptNames,
      pctChg: stock.pctChg,
      auctionAmount: stock.auctionAmount,
    })),
    directFacts,
  )
  for (const pool of getSnapshotPools(snap)) {
    for (const stock of pool) {
      stock.themeAttribution = attributionByCode.get(stock.tsCode) ?? null
    }
  }

  const flowTradeDate = getLatestVerifiedObservationDateBefore(db, snap.tradeDate)
  const flowItems = flowTradeDate
    ? listSectorFlowObservations(db, flowTradeDate, 'eastmoney').filter((item) => item.mainNetInflow != null)
    : []
  snap.marketThemes = buildMorningAuctionMarketThemes(
    uniqueStocks.map((stock) => ({
      tsCode: stock.tsCode,
      stockName: stock.stockName,
      pctChg: stock.pctChg,
      auctionAmount: stock.auctionAmount,
      attribution: stock.themeAttribution ?? null,
    })),
    flowItems,
    flowTradeDate,
  )
}

export async function getOrCreateMorningAuctionSnapshot(tradeDate: string): Promise<MorningAuctionSnapshot> {
  if (!resolveMorningAuctionTradeDateStatus(tradeDate).isTradeDay) {
    cachedSnapshot = createEmptyMorningAuctionSnapshot(tradeDate)
    return cachedSnapshot
  }
  if (!cachedSnapshot || cachedSnapshot.tradeDate !== tradeDate) {
    cachedSnapshot = await buildRealMorningAuctionSnapshot(tradeDate)
  }
  mergeTodayClose(cachedSnapshot, tradeDate)   // 盘后收盘价 fallback
  mergeCurrentPrices(cachedSnapshot)           // 盘中 rt_k 实时覆盖
  // FR-134: 填充 3d/5d 数据
  // DB 全命中时 mergePriceHistory 仅做 SQLite 查询（< 5ms），await 对用户无感知；
  // 仅当候选股为新股/首次使用时才会触发 Tushare API 补拉（~1s），比原来「5s 后二次刷新」快得多。
  await mergePriceHistory(cachedSnapshot, tradeDate)
  applyThemeAttributionToSnapshot(cachedSnapshot)
  emitMorningAuctionDecisionSignals(cachedSnapshot)
  // 题材列异步填充（不阻塞返回）
  void mergeConceptData(cachedSnapshot, tradeDate)
  return cachedSnapshot
}

export function getCachedMorningAuctionSnapshot(tradeDate: string): MorningAuctionSnapshot | null {
  if (!cachedSnapshot || cachedSnapshot.tradeDate !== tradeDate) return null
  return structuredClone(cachedSnapshot)
}

export async function refreshMorningAuctionSnapshot(tradeDate: string): Promise<MorningAuctionSnapshot> {
  if (!resolveMorningAuctionTradeDateStatus(tradeDate).isTradeDay) {
    cachedSnapshot = createEmptyMorningAuctionSnapshot(tradeDate)
    return cachedSnapshot
  }
  // allMarket 池的候选股来自 stk_auction 竞价快照，竞价窗口（09:25）结束后接口可能不再返回数据。
  // 如果快照已存在且 allMarket 非空，说明竞价快照已固化，盘中刷新只需更新现价数据，不能重建。
  // 其余三个池（firstBoard/secondBoard/brokenBoard/brokenConsec）来自 DB 历史数据，重建结果相同，无影响。
  const allMarketAlreadyCaptured =
    cachedSnapshot !== null &&
    cachedSnapshot.tradeDate === tradeDate &&
    cachedSnapshot.threeOne.allMarket.length > 0

  if (allMarketAlreadyCaptured) {
    // 仅刷新现价，保留竞价快照
    mergeCurrentPrices(cachedSnapshot!)
    await mergePriceHistory(cachedSnapshot!, tradeDate)
    applyThemeAttributionToSnapshot(cachedSnapshot!)
    emitMorningAuctionDecisionSignals(cachedSnapshot!)
    void mergeConceptData(cachedSnapshot!, tradeDate)
    return cachedSnapshot!
  }

  // 快照不存在或 allMarket 为空（竞价时段首次构建），完整重建
  cachedSnapshot = await buildRealMorningAuctionSnapshot(tradeDate)
  _historyCache = null  // 强制重新拉取
  _conceptCache = null  // 强制重新拉取题材
  mergeTodayClose(cachedSnapshot, tradeDate)
  mergeCurrentPrices(cachedSnapshot)
  // FR-134: 填充 3d/5d 数据后再返回，避免刷新后表格长期显示横线
  await mergePriceHistory(cachedSnapshot, tradeDate)
  applyThemeAttributionToSnapshot(cachedSnapshot)
  emitMorningAuctionDecisionSignals(cachedSnapshot)
  // 题材列异步填充
  void mergeConceptData(cachedSnapshot, tradeDate)
  return cachedSnapshot
}

function emitMorningAuctionDecisionSignals(snap: MorningAuctionSnapshot): void {
  try {
    dismissOneWordMorningAuctionSignals(snap)
    const candidates = snap.threeOne.allMarket
      .filter((stock) => !isAuctionOneWordBoard(stock))
      .slice(0, 12)
    if (candidates.length === 0) return
    const signals: DecisionSignalInput[] = candidates
      .filter((s) => s.pctChg >= 3 && s.auctionAmount >= 500)
      .map((s, idx) => ({
        sourceModule: 'short_term',
        strategyKey: 'morningAuction.allMarket',
        tsCode: s.tsCode,
        stockName: s.stockName,
        signalType: 'OPPORTUNITY',
        direction: 'BULLISH',
        priority: idx < 3 || s.pctChg >= 6 ? 4 : 3,
        score: Math.min(100, s.pctChg * 8 + s.auctionTurnover * 20),
        confidence: 65,
        title: `${s.stockName} 集合竞价异动`,
        summary: `竞价涨幅 ${s.pctChg.toFixed(2)}%, 竞价金额 ${s.auctionAmount.toFixed(0)} 万元, 换手率 ${s.auctionTurnover.toFixed(2)}%。`,
        reason: {
          auctionPrice: s.auctionPrice,
          pctChg: s.pctChg,
          auctionAmount: s.auctionAmount,
          auctionTurnover: s.auctionTurnover,
          conceptNames: s.conceptNames,
        },
        sourceRef: { tradeDate: snap.tradeDate, pool: 'allMarket' },
        dedupKey: `short_term:morningAuction.allMarket:${snap.tradeDate}:${s.tsCode}`,
      }))
    emitDecisionSignals(getDb(), signals)
  } catch (err) {
    console.warn('[morningAuction] emit decision signals failed:', err)
  }
}

function dismissOneWordMorningAuctionSignals(snap: MorningAuctionSnapshot): void {
  const dedupKeys = snap.threeOne.allMarket
    .filter(isAuctionOneWordBoard)
    .map((stock) => `short_term:morningAuction.allMarket:${snap.tradeDate}:${stock.tsCode}`)
  if (dedupKeys.length === 0) return

  const placeholders = dedupKeys.map(() => '?').join(',')
  getDb().prepare(`
    UPDATE decision_signals
    SET status = 'DISMISSED', updated_at = ?
    WHERE dedup_key IN (${placeholders})
      AND status IN ('NEW', 'READ', 'WATCHING')
  `).run(Date.now(), ...dedupKeys)
}
