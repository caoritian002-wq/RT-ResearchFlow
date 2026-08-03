/**
 * FR-127: 短线策略 - 打板助手（实时涨停监控 + 龙虎榜砸盘席位过滤）
 *
 * 双模式设计（FR-133）：
 *  - 盘中实时模式（北京工作日 09:30–15:00）：调用 Tushare rt_k 拿全市场实时截面，
 *    过滤 pctChg >= 9.8%（涨停）/ <= -9.8%（跌停），联立 DB 历史数据补充 limitTimes + 题材 + 砸盘席位
 *  - 盘后/非交易日模式（EOD）：从 limit_list_daily 读取最近有效交易日数据（字段完整）
 */

import { getDb } from '../database/db'
import { getLimitListByDate, getLatestAvailableTradeDate } from '../database/limitListDailyRepository'
import { getPrevTradeDay } from '../database/tradeCalRepository'
import { insertConceptMembersIfAbsent } from '../database/kplConceptMembersRepository'
import { getConceptsByStockRouted, computeThemeZtNumLocal } from './conceptRouter'
import { getConceptSource } from '../database/settingsRepository'
import { emitDecisionSignals, type DecisionSignalInput } from './decisionSignalService'
import { getTopListByDate } from '../database/topListDailyRepository'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { getRtKCache, refreshRtKCache, isRtKStale } from './sharedRtKCache'
import { fetchKplConceptConsByStock, fetchStockMinuteDaily } from './tushareService'
import { replaceSignalsByStrategyAndDate, type ShortTermSignalInsert } from '../database/shortTermSignalsRepository'
import {
  LIMIT_BOARD_STRATEGY_KEY,
  LIMIT_BOARD_STRATEGY_VERSION,
  buildLimitBoardWorkbenchJudgment,
  judgeLimitBoardStock,
  type LimitBoardStockQuality,
  type LimitBoardWorkbenchJudgment,
} from './limitBoardJudgmentModel'

/**
 * 补充查询无题材的股票：并发 5 路按股票代码向接口查询历史概念归属，
 * 查到的数据持久化到 DB（INSERT OR IGNORE）并就地更新 stocks 列表。
 * 此函数不抛异常：单股查询失败就跳过，保持展示不受影响。
 */
async function fillMissingConcepts(
  db: ReturnType<typeof getDb>,
  token: string,
  stocks: LimitBoardStock[],
  themeZtNum: Map<string, number>
): Promise<void> {
  const missing = stocks.filter(s => s.conceptName === '无题材')
  if (missing.length === 0) return

  const CONCURRENCY = 5
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY)
    await Promise.allSettled(
      batch.map(async stock => {
        try {
          const rows = await fetchKplConceptConsByStock(token, stock.tsCode)
          if (rows.length === 0) return
          // 持久化到 DB（不覆盖已有数据）
          insertConceptMembersIfAbsent(db, rows)
          // 就地更新内存对象（根据 hot_num 降序取最高的一个）
          rows.sort((a, b) => (b.hotNum ?? 0) - (a.hotNum ?? 0))
          const best = rows[0]
          if (best.name) {
            stock.conceptName = best.name
            stock.conceptZtNum = themeZtNum.get(best.name) ?? 1
          }
        } catch {
          // 单股查询失败就跳过，不影响其他
        }
      })
    )
  }
  if (missing.length > 0) {
    console.log(
      `[LimitBoard] fillMissingConcepts: queried ${missing.length} stocks, ` +
      `${missing.filter(s => s.conceptName !== '无题材').length} resolved`
    )
  }
}

export type LimitTimeWindow = 'before1030' | 'between1030_1130' | 'after1300' | 'unknown'

interface LimitBoardStockFacts {
  tsCode: string
  stockCode: string
  stockName: string
  /** 涨停时间 HH:mm:ss；盘中实时模式为 '—' */
  limitTime: string
  /** 涨停价 */
  limitPrice: number
  /** 当日涨幅（%） */
  pctChg: number
  /** 封单金额（万元）；盘中模式为 bid_price1×bid_volume1（股）/10000 近似值 */
  fundAmount: number
  /** 开板次数；盘中实时模式为 -1（前端识别为不可用，显示 '—'） */
  openTimes: number
  /** 当前连板数；盘中模式只承接交易日历确认的上一交易日连续涨停 */
  limitTimes: number
  /** 主题材 */
  conceptName: string
  /** 板块跟风数（同概念当日涨停股票数） */
  conceptZtNum: number
  /** 是否被龙虎榜砸盘席位标记 */
  hasDumpInstWarning: boolean
  /** 砸盘席位描述（用于 hover 提示） */
  dumpInstDesc: string | null
  /** 时间窗口分类 */
  timeWindow: LimitTimeWindow
}

export interface LimitBoardStock extends LimitBoardStockFacts {
  quality: LimitBoardStockQuality
}

export interface LimitBoardSnapshot {
  tradeDate: string
  generatedAt: number
  isMock: boolean
  /** 是否在交易时段（前端用以决定是否轮询） */
  inTradingHours: boolean
  /** 当日涨停总数 */
  totalLimitCount: number
  /** 题材列表（用于筛选下拉） */
  conceptList: string[]
  stocks: LimitBoardStock[]
  /** 数据模式：realtime=盘中 rt_k 实时，eod=盘后 DB 数据 */
  dataMode: 'realtime' | 'eod'
  /** rt_k 截面时间戳（盘中模式，格式 HH:mm）；盘后模式为 null */
  rtDataTime: string | null
  strategyVersion: string
  workbench: LimitBoardWorkbenchJudgment
}

function isInTradingHoursBj(): boolean {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const dow = now.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  return (totalMin >= 9 * 60 + 15 && totalMin <= 11 * 60 + 30) || (totalMin >= 13 * 60 && totalMin <= 15 * 60)
}

/** FR-133: rt_k 适用时段（09:30–15:00，比集合竞价晚 15 分钟，确保有成交数据） */
function isInTradingHoursForRtK(): boolean {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const dow = now.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  return (totalMin >= 9 * 60 + 30 && totalMin <= 11 * 60 + 30) || (totalMin >= 13 * 60 && totalMin <= 15 * 60)
}

/**
 * 根据股票代码和名称动态计算该股涨局幅度（%）。
 * - ST / *ST : 5%
 * - 北交所 (.BJ) : 30%
 * - 科创板 (688*.SH) / 创业板 (300*.SZ, 301*.SZ) : 20%
 * - 沪深主板其他股 : 10%
 */
function getLimitPct(tsCode: string, name: string | null): number {
  // ST 状态：名称含『ST』（实际匹配 'ST '/' ST'等写法）
  if (name && /\bST\b/i.test(name)) return 5
  // 北交所
  if (tsCode.endsWith('.BJ')) return 30
  const code = tsCode.split('.')[0]
  // 科创板
  if (code.startsWith('688') || code.startsWith('689')) return 20
  // 创业板
  if (code.startsWith('300') || code.startsWith('301')) return 20
  // 汪深主板
  return 10
}

function classifyTimeWindow(hhmm: string): LimitTimeWindow {
  if (!/^\d{2}:\d{2}/.test(hhmm)) return 'unknown'
  const parts = hhmm.split(':')
  const h = Number(parts[0])
  const m = Number(parts[1])
  const total = h * 60 + m
  if (total < 10 * 60 + 30) return 'before1030'
  if (total <= 11 * 60 + 30) return 'between1030_1130'
  return Number.isFinite(total) ? 'after1300' : 'unknown'
}

function finalizeSnapshot(
  base: Omit<LimitBoardSnapshot, 'stocks' | 'strategyVersion' | 'workbench'> & { stocks: LimitBoardStockFacts[] }
): LimitBoardSnapshot {
  const stocks = base.stocks.map((stock) => ({
    ...stock,
    quality: judgeLimitBoardStock({ ...stock, dataMode: base.dataMode }),
  }))
  return {
    ...base,
    stocks,
    strategyVersion: LIMIT_BOARD_STRATEGY_VERSION,
    workbench: buildLimitBoardWorkbenchJudgment(stocks),
  }
}

function refreshSnapshotJudgment(snapshot: LimitBoardSnapshot): void {
  for (const stock of snapshot.stocks) {
    stock.quality = judgeLimitBoardStock({ ...stock, dataMode: snapshot.dataMode })
  }
  snapshot.strategyVersion = LIMIT_BOARD_STRATEGY_VERSION
  snapshot.workbench = buildLimitBoardWorkbenchJudgment(snapshot.stocks)
  snapshot.generatedAt = Date.now()
}

let cachedSnapshot: LimitBoardSnapshot | null = null
let cachedForDate: string | null = null
/** 盘中实时模式缓存时间戳（毫秒），用于 30s TTL 判断 */
let cachedAt = 0

// ---- 分钟级字段补全缓存（涨停时间 + 开板次数）----

interface MinuteCacheEntry {
  /** 首次涨停时间，'HH:mm:00' 格式 */
  limitTime: string
  /** 开板次数 */
  openTimes: number
  cachedAt: number
}
/** 按 tsCode 缓存 rt_min_daily 推导的结果，2 分钟 TTL */
const _minuteCache = new Map<string, MinuteCacheEntry>()
const MINUTE_CACHE_TTL = 2 * 60_000

/**
 * FR-141: 对盘中涨停股（非 ST）按需调 rt_min_daily，推导「涨停时间」和「开板次数」，
 * 结果写入 _minuteCache（2 分钟 TTL）并就地更新 stocks 对象。
 * 采用 fire-and-forget 模式，不阻塞快照返回；下次前端轮询自动拿到更新值。
 */
async function fillMinuteData(stocks: LimitBoardStockFacts[], token: string): Promise<void> {
  const now = Date.now()
  // 筛选需要（重新）查询的股票：非 ST + 缓存未命中或已过期
  const toFetch = stocks.filter(s => {
    if (s.stockName && /\bST\b/i.test(s.stockName)) return false
    const mc = _minuteCache.get(s.tsCode)
    return !mc || now - mc.cachedAt >= MINUTE_CACHE_TTL
  })
  if (toFetch.length === 0) return

  const CONCURRENCY = 5
  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const batch = toFetch.slice(i, i + CONCURRENCY)
    await Promise.allSettled(
      batch.map(async stock => {
        try {
          const rtKEntry = getRtKCache()?.get(stock.tsCode)
          if (!rtKEntry || !rtKEntry.preClose || rtKEntry.preClose <= 0) return
          const preClose = rtKEntry.preClose
          const limitThreshold = preClose * (1 + getLimitPct(stock.tsCode, stock.stockName) / 100) - 0.01

          const minuteRows = await fetchStockMinuteDaily(token, stock.tsCode, '1MIN')
          if (minuteRows.length === 0) return

          let limitTime = '—'
          let openTimes = 0
          let wasLimit = false
          for (const row of minuteRows) {
            const close = row.close ?? 0
            const isLimit = close >= limitThreshold
            if (isLimit && limitTime === '—') {
              // 首次进入涨停板：HH:mm 补 ':00'
              limitTime = `${row.tsMinute}:00`
            }
            if (!isLimit && wasLimit) {
              // 涨停 → 非涨停：开板一次
              openTimes++
            }
            wasLimit = isLimit
          }

          const entry: MinuteCacheEntry = { limitTime, openTimes, cachedAt: Date.now() }
          _minuteCache.set(stock.tsCode, entry)
          // 就地更新（JS 引用语义，下次前端轮询自动拿到）
          stock.limitTime = limitTime
          stock.openTimes = openTimes
          // 同步更新时间窗口（使涨停时间筛选生效）
          if (limitTime !== '—') {
            stock.timeWindow = classifyTimeWindow(limitTime.slice(0, 5))
          }
        } catch {
          // 单股失败静默跳过，不影响其他股票
        }
      })
    )
  }
}

async function buildRealLimitBoardSnapshot(tradeDate: string): Promise<LimitBoardSnapshot> {
  const db = getDb()

  // 今日 limit_list_daily 已有数据（17:40 后 cron 写入）→ 直接用 EOD，字段最完整
  const todayRows = getLimitListByDate(db, tradeDate)
  if (todayRows.length > 0) {
    console.log(`[LimitBoard] today DB has ${todayRows.length} rows, using EOD mode`)
    return buildEodSnapshot(db, tradeDate)
  }

  // 今日 DB 无数据：尝试 rt_k（盘中 or 盘后均可，只要缓存有数据）
  const cfg = getDataSourceConfig(db)
  const token = cfg.tushareEnabled && cfg.tushareTokenEncrypted
    ? decryptApiKey(cfg.tushareTokenEncrypted)
    : null
  if (token) {
    try {
      return await buildRealtimeSnapshot(db, tradeDate, token)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[LimitBoard] rt_k failed, falling back to yesterday EOD: ${msg}`)
    }
  }

  // 最终 fallback：limit_list_daily 最近有效交易日（昨日数据）
  return buildEodSnapshot(db, tradeDate)
}

/** 盘中/盘后实时模式：读取共享 rt_k 缓存；盘中 30s TTL，盘后 2 分钟 TTL */
async function buildRealtimeSnapshot(
  db: ReturnType<typeof getDb>,
  tradeDate: string,
  token: string
): Promise<LimitBoardSnapshot> {
  // 盘中 30s TTL（高频刷新），盘后 120s TTL（避免反复调用）
  const staleTtl = isInTradingHoursForRtK() ? 30_000 : 120_000
  if (isRtKStale(staleTtl)) {
    await refreshRtKCache(token)
  }
  const rtKCache = getRtKCache()
  if (!rtKCache || rtKCache.size === 0) {
    throw new Error('rt_k cache empty after refresh')
  }

  // 过滤涨停和跌停（按上市板块动态计算阈值，容差 0.3%）
  interface FilteredRow {
    tsCode: string
    name: string | null
    pctChg: number
    close: number
    fdAmount: number
    tradeTime: string | null
    timeWindow: LimitTimeWindow
  }
  const filtered: FilteredRow[] = []
  for (const [tsCode, entry] of rtKCache) {
    const limitPct = getLimitPct(tsCode, entry.name)
    // 打板助手只展示涨停股；上界 +1.5% 过滤新股首日/复牌补涨等不受涨跌停限制的异常行情
    const isLimitUp = entry.change >= limitPct - 0.3 && entry.change <= limitPct + 1.5
    if (!isLimitUp) continue
    // 封单额（万元）= 买一价 × 买一量（股）/ 10000
    const fdAmount = entry.bidPrice1 != null && entry.bidVolume1 != null
      ? Math.round(entry.bidPrice1 * entry.bidVolume1 / 10000)
      : 0
    // tradeTime 从 rt_k entry 无法直接拿到（sharedRtKCache 不存）；保留 null，时间窗口默认分类
    filtered.push({
      tsCode,
      name: entry.name,
      pctChg: entry.change,
      close: entry.price,
      fdAmount,
      tradeTime: null,
      timeWindow: 'unknown'
    })
  }

  // 龙虎榜砸盘席位（取最新可用日期）
  const dumpMap = new Map<string, string>()
  const latestTopDate = getLatestAvailableTradeDate(db)
  if (latestTopDate) {
    for (const t of getTopListByDate(db, latestTopDate)) {
      if (t.lSell != null && t.lBuy != null && t.lBuy > 0) {
        const ratio = t.lSell / t.lBuy
        if (ratio > 2.0) {
          const reasonSuffix = t.reason != null ? `·${t.reason}` : ''
          dumpMap.set(t.tsCode, `机构卖出/买入比 ${ratio.toFixed(1)}（龙虎榜${reasonSuffix}）`)
        }
      }
    }
  }

  // 当前连板位置必须连续，不能用遥远历史中的最高板数冒充今天的连板位置。
  const previousTradeDate = getPrevTradeDay(db, tradeDate)
  const previousLimitTimes = new Map<string, number>()
  if (previousTradeDate) {
    for (const row of getLimitListByDate(db, previousTradeDate)) {
      if (row.limit === 'U') previousLimitTimes.set(row.tsCode, Math.max(1, row.limitTimes ?? 1))
    }
  }

  // 题材跟风数（取最新可用日期）
  const conceptSource = getConceptSource()
  const themeZtNum = latestTopDate ? computeThemeZtNumLocal(db, latestTopDate, conceptSource) : new Map<string, number>()

  const stocks: LimitBoardStockFacts[] = []
  for (const row of filtered) {
    const stockCode = row.tsCode.split('.')[0]
    const concepts = getConceptsByStockRouted(db, row.tsCode, conceptSource, latestTopDate ?? undefined)
    const mainConcept = concepts[0]
    const conceptName = mainConcept?.conceptName ?? '无题材'
    const conceptZtNum = mainConcept != null ? (themeZtNum.get(mainConcept.conceptName) ?? 1) : 1
    const hasDump = dumpMap.has(row.tsCode)

    // 优先从 _minuteCache 读已推导的涨停时间和开板次数
    const mc = _minuteCache.get(row.tsCode)
    const mcValid = mc !== undefined && Date.now() - mc.cachedAt < MINUTE_CACHE_TTL
    const limitTimeVal = mcValid ? mc!.limitTime : '—'
    const openTimesVal = mcValid ? mc!.openTimes : -1
    // 若缓存命中且有真实涨停时间，用它推导时间窗口；否则保留默认值
    const timeWindowVal = mcValid && mc!.limitTime !== '—'
      ? classifyTimeWindow(mc!.limitTime.slice(0, 5))
      : row.timeWindow

    stocks.push({
      tsCode: row.tsCode,
      stockCode,
      stockName: row.name ?? '',
      limitTime: limitTimeVal,
      limitPrice: row.close,
      pctChg: Math.round(row.pctChg * 100) / 100,
      fundAmount: row.fdAmount,
      openTimes: openTimesVal,
      limitTimes: (previousLimitTimes.get(row.tsCode) ?? 0) + 1,
      conceptName,
      conceptZtNum,
      hasDumpInstWarning: hasDump,
      dumpInstDesc: hasDump ? (dumpMap.get(row.tsCode) ?? null) : null,
      timeWindow: timeWindowVal
    })
  }

  // 盘中模式按涨幅倒序排列（涨幅最高在前）
  stocks.sort((a, b) => b.pctChg - a.pctChg)
  const conceptList = Array.from(new Set(stocks.map(s => s.conceptName))).sort()

  // 取第一条的 tradeTime 作为快照时间戳，格式化为 HH:mm
  const rtDataTimeRaw = filtered[0]?.tradeTime ?? null
  const rtDataTime = rtDataTimeRaw ? rtDataTimeRaw.slice(11, 16) : null

  const snapshot = finalizeSnapshot({
    tradeDate,
    generatedAt: Date.now(),
    isMock: false,
    inTradingHours: true,
    totalLimitCount: stocks.length,
    conceptList,
    stocks,
    dataMode: 'realtime',
    rtDataTime
  })

  // 后台补充分时事实；补齐后重算并替换同日信号，前端下一次轮询即可读取。
  void fillMinuteData(snapshot.stocks, token).then(() => synchronizeSnapshotOutputs(snapshot, true))
  return snapshot
}

/** EOD 模式：从 limit_list_daily DB 读取最近有效交易日数据 */
function buildEodSnapshot(db: ReturnType<typeof getDb>, tradeDate: string): LimitBoardSnapshot {
  let effectiveDate = tradeDate
  let allRows = getLimitListByDate(db, tradeDate)
  if (allRows.length === 0) {
    const latest = getLatestAvailableTradeDate(db)
    if (latest && latest !== tradeDate) {
      effectiveDate = latest
      allRows = getLimitListByDate(db, latest)
    }
  }
  const limitRows = allRows.filter(r => r.limit === 'U')
  console.log(`[LimitBoard] EOD tradeDate=${tradeDate} effectiveDate=${effectiveDate} allRows=${allRows.length} limitRows(U)=${limitRows.length}`)
  const totalLimitCount = limitRows.length

  const conceptSource = getConceptSource()
  const themeZtNum = computeThemeZtNumLocal(db, effectiveDate, conceptSource)

  // 建立龙虎榜砸盘席位 Map
  const dumpMap = new Map<string, string>()
  for (const t of getTopListByDate(db, effectiveDate)) {
    if (t.lSell != null && t.lBuy != null && t.lBuy > 0) {
      const ratio = t.lSell / t.lBuy
      if (ratio > 2.0) {
        const reasonSuffix = t.reason != null ? `·${t.reason}` : ''
        dumpMap.set(t.tsCode, `机构卖出/买入比 ${ratio.toFixed(1)}（龙虎榜${reasonSuffix}）`)
      }
    }
  }

  const stocks: LimitBoardStockFacts[] = []
  for (const row of limitRows) {
    const tsCode = row.tsCode
    const stockCode = tsCode.split('.')[0]
    const concepts = getConceptsByStockRouted(db, tsCode, conceptSource, effectiveDate)
    const mainConcept = concepts[0]
    const conceptName = mainConcept?.conceptName ?? '无题材'
    const conceptZtNum =
      mainConcept != null ? (themeZtNum.get(mainConcept.conceptName) ?? 1) : 1
    const hasDump = dumpMap.has(tsCode)
    const limitTime = row.firstTime ?? '—'

    stocks.push({
      tsCode,
      stockCode,
      stockName: row.name ?? '',
      limitTime,
      limitPrice: row.close ?? 0,
      pctChg: row.pctChg ?? 0,
      fundAmount: row.fdAmount ?? 0,
      openTimes: row.openTimes ?? -1,
      limitTimes: row.limitTimes ?? 0,
      conceptName,
      conceptZtNum,
      hasDumpInstWarning: hasDump,
      dumpInstDesc: hasDump ? (dumpMap.get(tsCode) ?? null) : null,
      timeWindow: classifyTimeWindow(limitTime)
    })
  }

  stocks.sort((a, b) => a.limitTime.localeCompare(b.limitTime))
  const conceptList = Array.from(new Set(stocks.map(s => s.conceptName))).sort()

  return finalizeSnapshot({
    tradeDate: effectiveDate,
    generatedAt: Date.now(),
    isMock: false,
    inTradingHours: isInTradingHoursBj(),
    totalLimitCount,
    conceptList,
    stocks,
    dataMode: 'eod',
    rtDataTime: null
  })
}

/**
 * fire-and-forget：后台补充无题材股票的概念数据，不阻塞快照返回。
 * fillMissingConcepts 就地修改 snapshot.stocks 里的对象属性，
 * 由于 JS 引用语义，cachedSnapshot 和前端已持有的引用共享同一份数据，
 * 下次前端轮询时会自动拿到已填充题材的快照。
 */
function triggerBackgroundConceptFill(snapshot: LimitBoardSnapshot): void {
  const db = getDb()
  const cfg = getDataSourceConfig(db)
  const token = cfg.tushareEnabled && cfg.tushareTokenEncrypted
    ? decryptApiKey(cfg.tushareTokenEncrypted)
    : null
  if (!token) return
  const conceptSource = getConceptSource()
  const themeZtNum = computeThemeZtNumLocal(db, snapshot.tradeDate, conceptSource)
  void fillMissingConcepts(db, token, snapshot.stocks, themeZtNum).then(() => {
    // 题材补充完成后更新 conceptList（供前端筛选下拉用）
    snapshot.conceptList = Array.from(new Set(snapshot.stocks.map(s => s.conceptName))).sort()
    synchronizeSnapshotOutputs(snapshot, true)
  })
}

export async function getOrCreateLimitBoardSnapshot(tradeDate: string): Promise<LimitBoardSnapshot> {
  const now = Date.now()

  if (cachedSnapshot && cachedForDate === tradeDate) {
    if (cachedSnapshot.dataMode === 'realtime') {
      // rt_k 快照：盘中 30s TTL，盘后 5 分钟 TTL（定期重检今日 DB 是否已发布）
      const ttl = isInTradingHoursForRtK() ? 30_000 : 5 * 60_000
      if (now - cachedAt < ttl) return cachedSnapshot
    } else {
      // EOD 快照：若是今日真实数据则长期复用；若是昨日 fallback 则 5 分钟重检
      const isToday = cachedSnapshot.tradeDate === tradeDate
      if (isToday) return cachedSnapshot
      if (now - cachedAt < 5 * 60_000) return cachedSnapshot
    }
  }

  cachedSnapshot = await buildRealLimitBoardSnapshot(tradeDate)
  cachedForDate = tradeDate
  cachedAt = Date.now()
  synchronizeSnapshotOutputs(cachedSnapshot)
  // fire-and-forget：后台补充无题材股票，不阻塞快照返回
  triggerBackgroundConceptFill(cachedSnapshot)
  return cachedSnapshot
}

export async function refreshLimitBoardSnapshot(tradeDate: string): Promise<LimitBoardSnapshot> {
  cachedSnapshot = await buildRealLimitBoardSnapshot(tradeDate)
  cachedForDate = tradeDate
  cachedAt = Date.now()
  synchronizeSnapshotOutputs(cachedSnapshot)
  // fire-and-forget：后台补充无题材股票，不阻塞快照返回
  triggerBackgroundConceptFill(cachedSnapshot)
  return cachedSnapshot
}

function selectedJudgments(snapshot: LimitBoardSnapshot): LimitBoardStock[] {
  const sorted = [...snapshot.stocks].sort((left, right) => (
    (right.quality.totalScore ?? -1) - (left.quality.totalScore ?? -1)
    || right.fundAmount - left.fundAmount
    || left.tsCode.localeCompare(right.tsCode)
  ))
  return [
    ...sorted.filter((stock) => stock.quality.tier === 'focus' && stock.quality.dataStatus !== 'insufficient'),
    ...sorted.filter((stock) => stock.quality.tier === 'watch' && stock.quality.dataStatus !== 'insufficient').slice(0, 5),
  ]
}

function signalTimeForSnapshot(snapshot: LimitBoardSnapshot): number {
  const nowBj = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
  if (snapshot.tradeDate === nowBj) return snapshot.generatedAt
  if (!/^\d{8}$/.test(snapshot.tradeDate)) return snapshot.generatedAt
  return Date.parse(`${snapshot.tradeDate.slice(0, 4)}-${snapshot.tradeDate.slice(4, 6)}-${snapshot.tradeDate.slice(6, 8)}T07:00:00.000Z`)
}

function persistLimitBoardStrategySignals(snapshot: LimitBoardSnapshot): void {
  const triggerAt = signalTimeForSnapshot(snapshot)
  const rows: ShortTermSignalInsert[] = selectedJudgments(snapshot).map((stock) => ({
    strategy: LIMIT_BOARD_STRATEGY_KEY,
    tsCode: stock.tsCode,
    name: stock.stockName,
    triggerAt,
    tradeDate: snapshot.tradeDate,
    signalStrength: stock.quality.totalScore,
    signalMeta: JSON.stringify({
      strategyVersion: snapshot.strategyVersion,
      dataMode: snapshot.dataMode,
      generatedAt: snapshot.generatedAt,
      tier: stock.quality.tier,
      dataStatus: stock.quality.dataStatus,
      completeness: stock.quality.completeness,
      dimensions: stock.quality.dimensions,
      evidence: stock.quality.evidence,
      risks: stock.quality.risks,
      confirmations: stock.quality.confirmations,
      invalidations: stock.quality.invalidations,
    }),
  }))
  replaceSignalsByStrategyAndDate(getDb(), LIMIT_BOARD_STRATEGY_KEY, snapshot.tradeDate, rows)
}

function synchronizeSnapshotOutputs(snapshot: LimitBoardSnapshot, requireCurrent = false): void {
  if (requireCurrent && cachedSnapshot !== snapshot) return
  refreshSnapshotJudgment(snapshot)
  try {
    persistLimitBoardStrategySignals(snapshot)
  } catch (err) {
    console.warn('[limitBoardMonitor] persist strategy signals failed:', err)
  }
  emitLimitBoardDecisionSignals(snapshot)
}

function emitLimitBoardDecisionSignals(snapshot: LimitBoardSnapshot): void {
  try {
    const candidates = selectedJudgments(snapshot).filter((stock) => stock.quality.dataStatus === 'complete')
    if (candidates.length === 0) return
    const signalTime = signalTimeForSnapshot(snapshot)
    const signals: DecisionSignalInput[] = candidates.map((s) => ({
      sourceModule: 'short_term',
      strategyKey: LIMIT_BOARD_STRATEGY_KEY,
      tsCode: s.tsCode,
      stockName: s.stockName,
      conceptName: s.conceptName,
      signalType: s.quality.tier === 'focus' ? 'OPPORTUNITY' : 'INFO',
      direction: 'BULLISH',
      priority: s.quality.tier === 'focus' ? 4 : 3,
      score: s.quality.totalScore,
      confidence: s.quality.confidence,
      title: `${s.stockName} ${s.quality.title}`,
      summary: `${s.quality.summary}${s.quality.risks[0] ? ` 首要风险：${s.quality.risks[0]}。` : ''}`,
      reason: {
        strategyVersion: snapshot.strategyVersion,
        tier: s.quality.tier,
        dimensions: s.quality.dimensions,
        evidence: s.quality.evidence,
        risks: s.quality.risks,
        confirmations: s.quality.confirmations,
        invalidations: s.quality.invalidations,
        dataMode: snapshot.dataMode,
      },
      sourceRef: { tradeDate: snapshot.tradeDate, dataMode: snapshot.dataMode },
      signalTime,
      dedupKey: `short_term:limitBoardQuality:${snapshot.tradeDate}:${s.tsCode}`,
    }))
    emitDecisionSignals(getDb(), signals)
  } catch (err) {
    console.warn('[limitBoardMonitor] emit decision signals failed:', err)
  }
}

