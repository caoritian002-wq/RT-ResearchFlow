/**
 * FR-159 早盘竞价历史回测服务
 *
 * 核心逻辑：
 * 1. 按 limit_list_daily 获取最近 N 个交易日列表（已有回测的日期跳过，force=true 则全量重算）
 * 2. 对每个交易日 T：
 *    a. 从 stk_auction_cache（DB-first）或 Tushare stk_auction（补拉）获取竞价数据
 *    b. 读 T 前一个交易日的 limit_list_daily，将股票分类到四个池
 *    c. 顺带将 prevLimitRows 的股票名批量 upsert 到 stock_info（供明细表名称列展示）
 *    d. 按池的竞价涨幅/成交金额阈值过滤，得到"入选信号"
 *    e. 从 daily_close_cache 取 T+1/+2/+3/+5 收盘价，计算收益率
 * 3. 批量写入 stk_auction_backtest_detail
 * 4. 通过 BrowserWindow.webContents.send 推送进度事件
 *
 * 池分类（基于前一交易日 limit_list_daily）：
 *   - brokenBoard  (炸板封回): limit='U' AND open_times >= 1，竞价涨幅 >= 3%
 *   - firstBoard   (首板):      limit='U' AND limit_times = 1  AND open_times = 0，竞价涨幅 >= 9.8%
 *   - secondBoard  (二板+):     limit='U' AND limit_times >= 2 AND open_times = 0，竞价涨幅 >= 9.8%
 *   - brokenConsec (断板):      limit!='U' AND limit_times >= 2，竞价涨幅 >= 5%
 *
 * 优先级（同一股票命中多池取最高优先）：brokenBoard > firstBoard > secondBoard
 * brokenConsec 独立（前一日未收涨停，不与其他池冲突）
 *
 * daily_close_cache.ts_code 与 stk_auction_cache.ts_code 均存带后缀格式（如 600036.SH），
 * 无需格式转换，直接用全 tsCode 查询 daily_close_cache。
 * stock_info.stockCode 存 6 位纯数字，upsert 时需截取前 6 位。
 */

import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import type { LimitListDailyRow, BacktestDetailRow } from '../database/types'
import type { DailyRow } from './tushareService'
import { fetchStkAuction, fetchDailyForCandidates, fetchIndexDailyForCodes, fetchLimitListDaily } from './tushareService'
import {
  upsertStkAuctionCache,
  queryByDate as queryAuctionByDate,
} from '../database/stkAuctionCacheRepository'
import {
  upsertBacktestDetail,
  getComputedDates,
  queryDetails,
} from '../database/backtestDetailRepository'
import {
  getLatestDailyCloseTradeDate,
  queryDailyClose,
  upsertDailyClose,
} from '../database/dailyCloseCacheRepository'
import { getLimitListByDate, upsertLimitList } from '../database/limitListDailyRepository'
import { getRtKCache } from './sharedRtKCache'

// ── 模块级防重入守卫 ──────────────────────────────────────────────────
let _syncRunning = false

/** 等待指定毫秒（防止 stk_auction 频率超限） */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type BacktestPool = 'firstBoard' | 'secondBoard' | 'brokenBoard' | 'brokenConsec'
export type AllPool = BacktestPool | 'allMarket'

// ── 阈值常量 ──────────────────────────────────────────────────────────
const AMOUNT_MIN = 5_000_000 // 竞价成交金额下限（元）
const PCT_THRESHOLD: Record<BacktestPool, number> = {
  firstBoard: 9.8,
  secondBoard: 9.8,
  brokenBoard: 3.0,
  brokenConsec: 5.0,
}
// allMarket 筛选条件常量
const ALL_MARKET_PCT_MIN = 3.0        // 竞价涨幅下限（%）
const ALL_MARKET_AMOUNT_MIN = 5_000_000 // 竞价金额下限（元）
const ALL_MARKET_TURNOVER_MIN = 0.15  // 竞价换手率下限（%）
const ALL_MARKET_FLOAT_CAP_MIN = 3_000_000_000 // 流通市值下限（元，30亿）

// FR-163: 基准指数代码（与个股所属市场匹配）
// tsCode 前缀规则：
//   6xxxxx.SH  → 沪市主板  → 上证指数 000001.SH
//   688xxx.SH  → 科创板    → 科创50   000688.SH
//   3xxxxx.SZ  → 创业板    → 创业板指 399006.SZ
//   0xxxxx.SZ  → 深主板    → 深证成指 399001.SZ
//   8xxxxx.BJ  → 北交所    → fallback 上证  000001.SH
const INDEX_CODES = ['000001.SH', '399001.SZ', '399006.SZ', '000688.SH']

type BacktestReturnKey = 'ret1d' | 'ret2d' | 'ret3d' | 'ret5d'
type BacktestIndexReturnKey = 'idxRet1d' | 'idxRet2d' | 'idxRet3d' | 'idxRet5d'
const RETURN_HORIZONS: Array<{
  days: 1 | 2 | 3 | 5
  returnKey: BacktestReturnKey
  indexReturnKey: BacktestIndexReturnKey
}> = [
  { days: 1, returnKey: 'ret1d', indexReturnKey: 'idxRet1d' },
  { days: 2, returnKey: 'ret2d', indexReturnKey: 'idxRet2d' },
  { days: 3, returnKey: 'ret3d', indexReturnKey: 'idxRet3d' },
  { days: 5, returnKey: 'ret5d', indexReturnKey: 'idxRet5d' },
]

/** 根据个股 tsCode 匹配对应的基准指数 tsCode */
function getIndexForStock(tsCode: string): string {
  const code = tsCode.split('.')[0]
  const suffix = tsCode.split('.')[1] ?? ''
  if (suffix === 'SH') {
    if (code.startsWith('688')) return '000688.SH' // 科创板
    return '000001.SH' // 沪市主板
  }
  if (suffix === 'SZ') {
    if (code.startsWith('3')) return '399006.SZ' // 创业板
    return '399001.SZ' // 深主板
  }
  return '000001.SH' // 北交所 / 其他： fallback 上证
}

function subtractCalendarDays(ymd: string, days: number): string {
  const date = new Date(Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)) - 1,
    Number(ymd.slice(6, 8)),
  ))
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function getNthCloseAfter(
  rows: Array<{ tradeDate: string; close: number }>,
  tradeDate: string,
  days: number,
): number | null {
  return rows.filter((row) => row.tradeDate > tradeDate)[days - 1]?.close ?? null
}

function mergeDailyCloseMaps(
  target: Map<string, DailyRow[]>,
  source: ReturnType<typeof queryDailyClose>,
): void {
  for (const [code, rows] of source) target.set(code, rows)
}

/**
 * 只使用本地日线补齐已落库信号的空收益，不发起外部请求，也不覆盖既有结果。
 * 返回实际被更新的信号行数。
 */
export function repairBacktestDetailsFromLocalDaily(
  db: Database.Database,
  opts: { startDate: string; endDate: string },
): number {
  const details = queryDetails(db, opts)
  if (details.length === 0) return 0

  const codes = [...new Set([
    ...details.map((row) => row.tsCode),
    ...INDEX_CODES,
  ])]
  const closeMap = new Map<string, DailyRow[]>()
  const queryStart = subtractCalendarDays(opts.startDate, 14)
  for (let index = 0; index < codes.length; index += 400) {
    mergeDailyCloseMaps(closeMap, queryDailyClose(db, codes.slice(index, index + 400), queryStart))
  }

  const repaired: BacktestDetailRow[] = []
  for (const detail of details) {
    if (!detail.buyPrice) continue
    const stockSeries = closeMap.get(detail.tsCode) ?? []
    const indexSeries = closeMap.get(getIndexForStock(detail.tsCode)) ?? []
    const signalIndexRow = indexSeries.find((row) => row.tradeDate === detail.tradeDate)
    const previousIndexRow = [...indexSeries].reverse().find((row) => row.tradeDate < detail.tradeDate)
    let changed = false
    const next: BacktestDetailRow = { ...detail }

    if (next.idxTodayPct == null && signalIndexRow?.close && previousIndexRow?.close) {
      next.idxTodayPct = computeRet(previousIndexRow.close, signalIndexRow.close)
      changed = next.idxTodayPct != null
    }

    for (const horizon of RETURN_HORIZONS) {
      if (next[horizon.returnKey] == null) {
        const value = computeRet(
          detail.buyPrice,
          getNthCloseAfter(stockSeries, detail.tradeDate, horizon.days),
        )
        if (value != null) {
          next[horizon.returnKey] = value
          changed = true
        }
      }
      if (next[horizon.indexReturnKey] == null && signalIndexRow?.close) {
        const value = computeRet(
          signalIndexRow.close,
          getNthCloseAfter(indexSeries, detail.tradeDate, horizon.days),
        )
        if (value != null) {
          next[horizon.indexReturnKey] = value
          changed = true
        }
      }
    }

    if (changed) repaired.push({ ...next, computedAt: Date.now() })
  }

  if (repaired.length > 0) upsertBacktestDetail(db, repaired)
  return repaired.length
}

export function getMatureIncompleteBacktestDates(
  details: BacktestDetailRow[],
  tradeDates: string[],
  latestCloseTradeDate: string | null,
): string[] {
  if (!latestCloseTradeDate || tradeDates.length === 0) return []
  const dateIndex = new Map(tradeDates.map((date, index) => [date, index]))
  const latestIndex = [...tradeDates]
    .map((date, index) => ({ date, index }))
    .filter((item) => item.date <= latestCloseTradeDate)
    .at(-1)?.index
  if (latestIndex == null) return []

  const dates = new Set<string>()
  for (const detail of details) {
    const signalIndex = dateIndex.get(detail.tradeDate)
    if (signalIndex == null) continue
    const maturedSessions = latestIndex - signalIndex
    if (RETURN_HORIZONS.some((item) => maturedSessions >= item.days && detail[item.returnKey] == null)) {
      dates.add(detail.tradeDate)
    }
  }
  return [...dates].sort()
}

// ── 工具函数 ──────────────────────────────────────────────────────────

/** 将带交易所后缀的 tsCode（600036.SH）转为 6 位纯数字（600036），用于 stock_info 主键 */
function toStockCode(tsCode: string): string {
  return tsCode.split('.')[0]
}

/**
 * 获取最近 n 个交易日（升序）。
 * 优先读 trade_cal （含调休补班），fallback 到 limit_list_daily。
 */
function getRecentTradeDates(db: Database.Database, n: number): string[] {
  // 取当前北京时日期作为上界
  const todayBj = (() => {
    const d = new Date(Date.now() + 8 * 60 * 60 * 1000)
    return (
      `${d.getUTCFullYear()}` +
      `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
      `${String(d.getUTCDate()).padStart(2, '0')}`
    )
  })()
  const calRows = db
    .prepare(
      'SELECT cal_date FROM trade_cal WHERE cal_date <= ? AND is_open = 1 ORDER BY cal_date DESC LIMIT ?'
    )
    .all(todayBj, n) as { cal_date: string }[]
  if (calRows.length > 0) return calRows.map((r) => r.cal_date).reverse() // 升序
  // fallback: 从 limit_list_daily 取，升序
  const rows = db
    .prepare('SELECT DISTINCT trade_date FROM limit_list_daily ORDER BY trade_date DESC LIMIT ?')
    .all(n) as { trade_date: string }[]
  return rows.map((r) => r.trade_date).reverse()
}

/**
 * 获取 date 的前一个交易日。
 * 优先读 trade_cal（含调休补班），fallback 到 limit_list_daily。
 */
function getPrevTradeDate(db: Database.Database, date: string): string | null {
  // 优先从 trade_cal 取，保证调休补班准确
  const calRow = db
    .prepare(
      'SELECT cal_date FROM trade_cal WHERE cal_date < ? AND is_open = 1 ORDER BY cal_date DESC LIMIT 1'
    )
    .get(date) as { cal_date: string } | undefined
  if (calRow) return calRow.cal_date
  // fallback: 从 limit_list_daily 取
  const row = db
    .prepare(
      'SELECT DISTINCT trade_date FROM limit_list_daily WHERE trade_date < ? ORDER BY trade_date DESC LIMIT 1'
    )
    .get(date) as { trade_date: string } | undefined
  return row?.trade_date ?? null
}

/**
 * 对前一日 limit_list 中的一行做池分类。
 * 优先级：brokenBoard > firstBoard > secondBoard；brokenConsec 独立判定。
 * 返回 null 表示不属于任何池。
 */
function classifyPool(row: LimitListDailyRow): BacktestPool | null {
  const limit = row.limit
  const limitTimes = row.limitTimes ?? 0
  const openTimes = row.openTimes ?? 0

  // 断板：前一日未收涨停，但历史连板次数 >= 2
  if (limit !== 'U' && limitTimes >= 2) return 'brokenConsec'

  // 只处理前一日收涨停（limit='U'）的股票
  if (limit !== 'U') return null

  // 炸板封回（优先级最高）：涨停但有开板
  if (openTimes >= 1) return 'brokenBoard'

  // 首板
  if (limitTimes === 1) return 'firstBoard'

  // 二板+
  if (limitTimes >= 2) return 'secondBoard'

  return null
}

/**
 * 判断某竞价数据条目是否满足对应池的入选条件：
 * 1. 竞价成交额 >= AMOUNT_MIN
 * 2. 竞价涨幅 >= 对应阈值
 */
function passesFilter(pool: BacktestPool, price: number | null, preClose: number | null, amount: number | null): boolean {
  if ((amount ?? 0) < AMOUNT_MIN) return false
  if (!price || !preClose || preClose <= 0) return false
  const pctChg = ((price - preClose) / preClose) * 100
  return pctChg >= PCT_THRESHOLD[pool]
}

// ── 主函数 ─────────────────────────────────────────────────────────────

/** 回测同步运行中标志（只读） */
export function isBacktestRunning(): boolean {
  return _syncRunning
}

/**
 * 运行竞价回测同步任务。
 * 调用方应 fire-and-forget 此函数，通过 win.webContents.send 接收进度推送。
 *
 * @param db      数据库连接
 * @param token   Tushare API token
 * @param days    回看最近几个交易日（默认 90）
 * @param win     BrowserWindow，用于推送 shortTerm:backtest:progress 事件
 * @param force   强制重算所有日期（忽略已有回测记录），默认 false
 */
export async function runBacktestSync(
  db: Database.Database,
  token: string,
  days = 90,
  win?: BrowserWindow,
  force = false
): Promise<void> {
  if (_syncRunning) return
  _syncRunning = true

  const pushProgress = (pct: number, message: string) => {
    try {
      win?.webContents.send('shortTerm:backtest:progress', { pct, message })
    } catch {
      // 窗口已关闭，忽略
    }
  }

  try {
    pushProgress(0, '正在初始化…')

    // 1. 获取需要计算的交易日列表（force=true 时忽略已有记录，全量重算）
    const allDates = getRecentTradeDates(db, days)
    const pendingDates = force
      ? allDates
      : (() => {
          const computedSet = new Set(getComputedDates(db))
          if (allDates.length === 0) return []
          repairBacktestDetailsFromLocalDaily(db, {
            startDate: allDates[0],
            endDate: allDates[allDates.length - 1],
          })
          const details = queryDetails(db, {
            startDate: allDates[0],
            endDate: allDates[allDates.length - 1],
          })
          const incompleteSet = new Set(getMatureIncompleteBacktestDates(
            details,
            allDates,
            getLatestDailyCloseTradeDate(db),
          ))
          return allDates.filter((date) => !computedSet.has(date) || incompleteSet.has(date))
        })()

    if (pendingDates.length === 0) {
      pushProgress(100, '已是最新，无需重新计算')
      return
    }

    // Phase 1: 补拉缺失的 limit_list_daily（含 pendingDates 本身及其 prevDate）
    // limit_list_d 接口无严格速率限制，间隔 300ms 即可
    {
      const limitDatesNeeded = new Set<string>(allDates)
      for (const d of allDates) {
        const prev = getPrevTradeDate(db, d)
        if (prev) limitDatesNeeded.add(prev)
      }
      const limitMissing = [...limitDatesNeeded]
        .filter((d) => getLimitListByDate(db, d).length === 0)
        .sort()
      if (limitMissing.length > 0) {
        pushProgress(0, `正在补拉涨跌停历史数据（共 ${limitMissing.length} 天）…`)
        for (let li = 0; li < limitMissing.length; li++) {
          const d = limitMissing[li]
          const pct = Math.round(((li + 1) / limitMissing.length) * 15)
          pushProgress(pct, `补拉涨跌停数据 ${d}（${li + 1}/${limitMissing.length}）`)
          try {
            await sleep(300)
            const rows = await fetchLimitListDaily(token, d)
            if (rows.length > 0) upsertLimitList(db, rows)
          } catch (err) {
            console.warn(`[Backtest] 补拉 limit_list_daily ${d} 失败:`, err)
          }
        }
      }
    }

    const total = pendingDates.length

    for (let i = 0; i < total; i++) {
      const tradeDate = pendingDates[i]
      // 进度占 15%-95%，留 5% 给最终完成
      const pct = 15 + Math.round((i / total) * 80)
      pushProgress(pct, `正在处理 ${tradeDate}（${i + 1}/${total}）`)

      // 2a. 获取当日竞价数据（DB-first，缺失则补拉 Tushare）
      let auctionRows = queryAuctionByDate(db, tradeDate)
      if (auctionRows.length === 0) {
        try {
          // stk_auction 接口限制 10次/分钟，间隔 6.5s 确保频率 ≤ 9次/min
          await sleep(6500)
          const fetched = await fetchStkAuction(token, tradeDate)
          if (fetched.length > 0) {
            upsertStkAuctionCache(db, fetched)
            auctionRows = fetched
          }
        } catch (err) {
          const errMsg = String(err)
          if (errMsg.includes('超限') || errMsg.includes('频率')) {
            // 速率超限：等 65s（1 分钟窗口重置 + 5s 安全边距）后重试一次
            pushProgress(pct, `${tradeDate} 速率超限，等待 65 秒后重试…`)
            await sleep(65000)
            try {
              const fetched2 = await fetchStkAuction(token, tradeDate)
              if (fetched2.length > 0) {
                upsertStkAuctionCache(db, fetched2)
                auctionRows = fetched2
              }
            } catch (retryErr) {
              console.warn(`[Backtest] 重试 ${tradeDate} 竞价数据仍失败:`, retryErr)
              continue
            }
          } else {
            console.warn(`[Backtest] 拉取 ${tradeDate} 竞价数据失败:`, err)
            continue
          }
        }
      }
      if (auctionRows.length === 0) continue

      // 2b. 获取前一个交易日的 limit_list_daily 做池分类
      const prevDate = getPrevTradeDate(db, tradeDate)
      if (!prevDate) continue
      const prevLimitRows = getLimitListByDate(db, prevDate)
      if (prevLimitRows.length === 0) continue

      // 2c. 为每只出现在前日 limit_list 的股票做池分类
      const poolMap = new Map<string, BacktestPool>()
      for (const row of prevLimitRows) {
        // stk_auction_cache 使用 tsCode（带后缀），limit_list_daily 也使用带后缀 tsCode
        const pool = classifyPool(row)
        if (pool) poolMap.set(row.tsCode, pool)
      }

      // 2c.1 顺带将本批 prevLimitRows 的股票名批量写入 stock_info（供明细表名称列展示）
      // stock_info.stockCode = 6 位纯数字；INSERT OR IGNORE 避免覆盖更新的记录
      try {
        const insertName = db.prepare(
          'INSERT OR IGNORE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)'
        )
        const batchInsert = db.transaction((rows: LimitListDailyRow[]) => {
          const now = Date.now()
          for (const r of rows) {
            if (r.name) insertName.run(toStockCode(r.tsCode), r.name, now)
          }
        })
        batchInsert(prevLimitRows)
      } catch {
        // 写 stock_info 失败不影响主流程
      }

      // 2d. 按池过滤竞价数据，得到入选信号
      interface Signal {
        tsCode: string
        pool: BacktestPool
        buyPrice: number
        preClose: number
      }
      const signals: Signal[] = []
      const auctionMap = new Map<string, (typeof auctionRows)[0]>()
      for (const ar of auctionRows) auctionMap.set(ar.tsCode, ar)

      for (const [tsCode, pool] of poolMap) {
        const ar = auctionMap.get(tsCode)
        if (!ar) continue
        if (passesFilter(pool, ar.price, ar.preClose, ar.amount) && ar.price && ar.preClose) {
          signals.push({ tsCode, pool, buyPrice: ar.price, preClose: ar.preClose })
        }
      }

      // allMarket 候选：直接从竞价数据筛选，条件与晨间竞价全市场Tab一致
      interface AllMarketSignal { tsCode: string; buyPrice: number; preClose: number }
      const allMarketSignals: AllMarketSignal[] = []
      for (const ar of auctionRows) {
        if (!ar.price || !ar.preClose || ar.preClose <= 0) continue
        const pctChg = ((ar.price - ar.preClose) / ar.preClose) * 100
        if (pctChg < ALL_MARKET_PCT_MIN) continue
        if ((ar.amount ?? 0) < ALL_MARKET_AMOUNT_MIN) continue
        if ((ar.turnoverRate ?? 0) < ALL_MARKET_TURNOVER_MIN) continue
        if (!ar.floatShare || ar.floatShare <= 0) continue
        // floatShare 单位为万股，流通市值(元) = floatShare * 10000 * price
        if (ar.floatShare * 10000 * ar.price < ALL_MARKET_FLOAT_CAP_MIN) continue
        allMarketSignals.push({ tsCode: ar.tsCode, buyPrice: ar.price, preClose: ar.preClose })
      }

      // 从 rtKCache 补充 allMarket 候选股的名称到 stock_info（供明细表名称列展示）
      // INSERT OR IGNORE 不覆盖已有记录；rtKCache 为空（盘后历史回测）时静默跳过
      if (allMarketSignals.length > 0) {
        const rtCache = getRtKCache()
        if (rtCache) {
          try {
            const insertName = db.prepare(
              'INSERT OR IGNORE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)'
            )
            const batchInsertAM = db.transaction((sigs: AllMarketSignal[]) => {
              const now = Date.now()
              for (const sig of sigs) {
                const entry = rtCache.get(sig.tsCode)
                if (entry?.name) insertName.run(toStockCode(sig.tsCode), entry.name, now)
              }
            })
            batchInsertAM(allMarketSignals)
          } catch {
            // 写 stock_info 失败不影响主流程
          }
        }
      }

      if (signals.length === 0 && allMarketSignals.length === 0) continue

      // 2e. 从 daily_close_cache 取 T+1/+2/+3/+5 收盘价
      // daily_close_cache.ts_code 与 stk_auction_cache.ts_code 同为带后缀格式（如 600036.SH），
      // 直接使用完整 tsCode 查询，无需格式转换。
      // 合并 4池 + allMarket 的 tsCode，并加入 4 个基准指数，单次查询避免重复
      const tsCodes = [
        ...new Set([...signals.map((s) => s.tsCode), ...allMarketSignals.map((s) => s.tsCode)]),
        ...INDEX_CODES,
      ]
      // 指数需要从 prevDate 开始查，才能计算信号日当日指数涨跌幅（上一交易日收盘 → 信号日收盘）
      const closeQueryStart = prevDate ?? tradeDate

      let closeMap = queryDailyClose(db, tsCodes, closeQueryStart)

      // 计算补拉 endDate（tradeDate + 20 日历天，足够覆盖含节假日的 T+5）
      const endDateObj = new Date(
        `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
      )
      endDateObj.setDate(endDateObj.getDate() + 20)
      const fetchEndDate = endDateObj.toISOString().slice(0, 10).replace(/-/g, '')

      // 检测哪些个股 T+N 数据不足（< 6 行无法覆盖 T+5），使用 daily 接口补拉
      const insufficientCodes = tsCodes
        .filter((c) => !INDEX_CODES.includes(c))
        .filter((c) => (closeMap.get(c)?.length ?? 0) < 6)
      if (insufficientCodes.length > 0) {
        try {
          const fetched = await fetchDailyForCandidates(token, insufficientCodes, closeQueryStart, fetchEndDate)
          if (fetched.length > 0) {
            upsertDailyClose(db, fetched)
            // 重新查询，将补拉结果合并到 closeMap
            const updated = queryDailyClose(db, insufficientCodes, closeQueryStart)
            for (const [k, v] of updated) closeMap.set(k, v)
          }
        } catch (err) {
          console.warn(`[Backtest] ${tradeDate} 补拉个股收盘价失败，T+N 部分结果将为 null:`, err)
        }
      }

      // FR-163: 补拉基准指数日线（index_daily 接口，daily 接口不支持指数代码）
      // 指数数据行数 < 3 时触发补拉（prevDate + tradeDate + 至少一个 T+N 行才够用）
      const missingIndexCodes = INDEX_CODES.filter((c) => (closeMap.get(c)?.length ?? 0) < 3)
      if (missingIndexCodes.length > 0) {
        try {
          const indexFetched = await fetchIndexDailyForCodes(token, missingIndexCodes, closeQueryStart, fetchEndDate)
          if (indexFetched.length > 0) {
            upsertDailyClose(db, indexFetched)
            const updatedIdx = queryDailyClose(db, missingIndexCodes, closeQueryStart)
            for (const [k, v] of updatedIdx) closeMap.set(k, v)
          }
        } catch (err) {
          console.warn(`[Backtest] ${tradeDate} 补拉基准指数收盘价失败，Alpha 将为 null:`, err)
        }
      }

      // FR-163: 构建基准指数同期收益辅助函数
      // 指数序列是从 closeQueryStart 开始的，需定位 tradeDate 对应的上一行（prevDate收盘）和当日行
      const makeIdxHelper = (indexCode: string) => {
        const idxSeries = closeMap.get(indexCode) ?? []
        // 找 prevDate 在序列中的位置（用作 T+0 基准）
        const prevIdx = prevDate ? idxSeries.findIndex((r) => r.tradeDate === prevDate) : -1
        // 找 tradeDate 在序列中的位置（用于计算当日涨跌幅）
        const tradIdx = idxSeries.findIndex((r) => r.tradeDate === tradeDate)
        const prevClose = prevIdx >= 0 ? (idxSeries[prevIdx]?.close ?? null) : null
        const tradClose = tradIdx >= 0 ? (idxSeries[tradIdx]?.close ?? null) : null
        // idxTodayPct: 信号日指数涨跌幅 = (tradClose - prevClose) / prevClose * 100
        const idxTodayPct: number | null =
          prevClose && tradClose ? parseFloat((((tradClose - prevClose) / prevClose) * 100).toFixed(2)) : null
        // 指数 T+N 收盘价辅助（从 tradIdx 往后数）
        const getIdxClose = (n: number): number | null => {
          const pos = tradIdx >= 0 ? tradIdx + n : n - 1
          return idxSeries[pos]?.close ?? null
        }
        const idxBuyRef = tradClose // 用信号日指数收盘价作为基准
        const idxRet = (n: number): number | null => computeRet(idxBuyRef, getIdxClose(n))
        return { idxTodayPct, idxRet }
      }

      // 2f. 构建回测明细行
      const detailRows: BacktestDetailRow[] = []
      for (const sig of signals) {
        const closeSeries = closeMap.get(sig.tsCode) ?? []
        const getClose = (n: number): number | null => getNthCloseAfter(closeSeries, tradeDate, n)
        const { idxTodayPct, idxRet } = makeIdxHelper(getIndexForStock(sig.tsCode))

        detailRows.push({
          tradeDate,
          tsCode: sig.tsCode,
          pool: sig.pool,
          buyPrice: sig.buyPrice,
          ret1d: computeRet(sig.buyPrice, getClose(1)),
          ret2d: computeRet(sig.buyPrice, getClose(2)),
          ret3d: computeRet(sig.buyPrice, getClose(3)),
          ret5d: computeRet(sig.buyPrice, getClose(5)),
          computedAt: Date.now(),
          // FR-161: 竞价涨幅 >= 9.5% 则为一字涨停，布罗大多数 A 股涨停板
          isOneWord: sig.preClose > 0 && (sig.buyPrice - sig.preClose) / sig.preClose * 100 >= 9.5 ? 1 : 0,
          idxTodayPct,
          idxRet1d: idxRet(1),
          idxRet2d: idxRet(2),
          idxRet3d: idxRet(3),
          idxRet5d: idxRet(5),
        })
      }

      if (detailRows.length > 0) {
        upsertBacktestDetail(db, detailRows)
      }

      // 2g. 构建并写入 allMarket 回测明细
      if (allMarketSignals.length > 0) {
        const allMarketRows: BacktestDetailRow[] = allMarketSignals.map((sig) => {
          const closeSeries = closeMap.get(sig.tsCode) ?? []
          const getClose = (n: number): number | null => getNthCloseAfter(closeSeries, tradeDate, n)
          const { idxTodayPct, idxRet } = makeIdxHelper(getIndexForStock(sig.tsCode))
          return {
            tradeDate,
            tsCode: sig.tsCode,
            pool: 'allMarket',
            buyPrice: sig.buyPrice,
            ret1d: computeRet(sig.buyPrice, getClose(1)),
            ret2d: computeRet(sig.buyPrice, getClose(2)),
            ret3d: computeRet(sig.buyPrice, getClose(3)),
            ret5d: computeRet(sig.buyPrice, getClose(5)),
            computedAt: Date.now(),
            // FR-161: 竞价涨幅 >= 9.5% 则为一字涨停
            isOneWord: sig.preClose > 0 && (sig.buyPrice - sig.preClose) / sig.preClose * 100 >= 9.5 ? 1 : 0,
            idxTodayPct,
            idxRet1d: idxRet(1),
            idxRet2d: idxRet(2),
            idxRet3d: idxRet(3),
            idxRet5d: idxRet(5),
          }
        })
        upsertBacktestDetail(db, allMarketRows)
      }
    }

    pushProgress(100, `完成，共处理 ${total} 个交易日`)
  } catch (err) {
    console.error('[Backtest] 回测任务异常:', err)
    pushProgress(-1, `计算失败: ${String(err)}`)
  } finally {
    _syncRunning = false
  }
}

/** 计算持有收益率（%），buyPrice 或 sellPrice 为 null/0 时返回 null */
function computeRet(buyPrice: number | null, sellPrice: number | null): number | null {
  if (!buyPrice || !sellPrice || buyPrice <= 0) return null
  return parseFloat((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2))
}
