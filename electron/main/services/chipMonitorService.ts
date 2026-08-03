/**
 * FR-156 筹码监控服务
 *
 * 核心功能：
 * - 计算底部筹码占比与加权均价（价格 ≤ close × 0.8 视为底部）
 * - 批量拉取监控股池近 5 个交易日的 cyq_chips 数据
 * - 计算 1/3/5 日松动指标并写入 chip_monitor_results
 * - 进度通过 BrowserWindow.webContents.send 推送给渲染进程
 */

import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import type { CyqChipsRow } from './tushareService'
import type { ChipMonitorResultRow, ChipMonitorStockRow } from '../database/types'
import { fetchDailyForCandidates } from './tushareService'
import { fetchCyqChipsSingleflight } from './cyqChipsFetchService'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import { upsertChips, queryChips } from '../database/cyqChipsCacheRepository'
import {
  getMonitorStocks,
  upsertMonitorResults,
} from '../database/chipMonitorRepository'
import { upsertDailyClose } from '../database/dailyCloseCacheRepository'

// ── 模块级防重入守卫 ────────────────────────────────────────────────
let _jobRunning = false

type ChipMonitorSource = ChipMonitorStockRow['source']
type ChipMonitorMode = 'relative' | 'absolute'
type LooseningMissingReason = 'INSUFFICIENT_HISTORY' | 'LOW_BASE_PCT'

const CHIP_HISTORY_DAYS = 10
const CHIP_FETCH_BATCH_SIZE = 2
const CHIP_FETCH_BATCH_DELAY_MS = 1100

// ── tsCode 格式转换 ──────────────────────────────────────────────────

/**
 * 将股票代码转换为 Tushare API 所需的带后缀格式（如 688008 → 688008.SH）。
 * 兼容已带后缀的代码（如 688008.SH）直接透传。
 */
function toTushareCode(code: string): string {
  // 已带后缀，直接返回
  if (code.includes('.')) return code
  // 北交所前缀判断
  if (/^(43|83|87|92|88|430|831|832|833|834|835|836|837|838|839|870|871|872|873|874|875|876|877|878|879|880|881|882|883|884|885|886|887|888|889|890|891|892|893|894|895|896|897|898|899|900|901|902|903|904|905|906|907|908|909|910|911|912|913|914|915|916|917|918|919|920)/.test(code)) return `${code}.BJ`
  if (code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) return `${code}.SH`
  return `${code}.SZ`
}

export interface BottomChipMetrics {
  bottomPct: number | null
  bottomAvgCost: number | null
}

/**
 * 计算底部筹码指标
 * @param chips 升序筹码分布数组
 * @param currentClose 对应日收盘价（relative 模式下必传）
 * @param mode relative：相对低位（close×0.8，默认）；absolute：绝对低位（min + range×30%）
 * @returns bottomPct（底部筹码占比%）和 bottomAvgCost（底部加权均价元）
 */
export function computeBottomChips(
  chips: CyqChipsRow[],
  currentClose: number,
  mode: 'relative' | 'absolute' = 'relative'
): BottomChipMetrics {
  // 筹码数据过于稀疏（少于 3 个价格节点）时不可靠，直接跳过
  // 典型场景：Tushare 对某些股票只返回 1 个价格点（price≈close），
  // 会导致 boundary=close，所有筹码都被判为底部，均价等于收盘价，结果失真
  if (chips.length < 3) return { bottomPct: null, bottomAvgCost: null }
  let boundary: number
  if (mode === 'absolute') {
    // 绝对低位：boundary = min_cost + (max_cost - min_cost) × 30%
    // 不依赖当前价，反映历史成本的绝对低位区域，适合判断"有没有套牢盘"
    const prices = chips.map((c) => c.price)
    const minCost = Math.min(...prices)
    const maxCost = Math.max(...prices)
    boundary = minCost + (maxCost - minCost) * 0.3
  } else {
    // 相对低位：boundary = close × 0.8，体现与当前价格的距离关系
    boundary = currentClose * 0.8
  }
  const bottomRows = chips.filter((c) => c.price <= boundary)
  if (bottomRows.length === 0) return { bottomPct: null, bottomAvgCost: null }

  const totalPct = bottomRows.reduce((s, c) => s + c.percent, 0)
  if (totalPct <= 0) return { bottomPct: null, bottomAvgCost: null }

  const weightedCost =
    bottomRows.reduce((s, c) => s + c.price * c.percent, 0) / totalPct

  return { bottomPct: totalPct, bottomAvgCost: weightedCost }
}

// ── 辅助：取近 N 个交易日 ─────────────────────────────────────────────

/**
 * 从 daily_close_cache 取最近 n 个交易日（升序，最旧→最新）
 * 若行数不足 n 则返回实际可用条数
 */
export function getRecentTradeDates(db: Database.Database, n: number): string[] {
  // 优先从 trade_cal 表获取精确交易日，fallback 到 daily_close_cache
  try {
    const latestRow = db
      .prepare('SELECT MAX(trade_date) AS trade_date FROM daily_close_cache')
      .get() as { trade_date: string | null } | undefined
    if (latestRow?.trade_date) {
      const dates = getLastNTradingDays(db, n, latestRow.trade_date)
      if (dates.length > 0) return dates
    }
  } catch {
    // trade_cal 表不可用时降级
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT trade_date FROM daily_close_cache
       ORDER BY trade_date DESC LIMIT ?`
    )
    .all(n) as { trade_date: string }[]
  return rows.map((r) => r.trade_date).reverse() // 转为升序
}

// ── 主 Job ────────────────────────────────────────────────────────────

/**
 * 运行筹码监控同步任务
 * - 拉取监控股池近 5 个交易日的筹码数据（跳过已缓存组合）
 * - 计算底部筹码及松动指标并写入 DB
 * - 通过 win.webContents.send 推送进度事件
 * @throws {Error} code='JOB_RUNNING' 若另一任务正在执行
 */
export async function runChipMonitorJob(
  db: Database.Database,
  token: string,
  win?: BrowserWindow,
  mode: ChipMonitorMode = 'relative',
  source?: ChipMonitorSource
): Promise<{ success: number; failed: number }> {
  if (_jobRunning) {
    const err = new Error('JOB_RUNNING')
    err.name = 'JOB_RUNNING'
    throw err
  }
  _jobRunning = true

  let success = 0
  let failed = 0

  try {
    const stocks = source == null
      ? getMonitorStocks(db)
      : getMonitorStocks(db).filter((stock) => stock.source === source)
    if (stocks.length === 0) {
      return { success: 0, failed: 0 }
    }

    // 将 tsCode 统一转换为 Tushare 带后缀格式（如 688008 → 688008.SH），
    // 避免 stock_price_cache 里的 6 位纯数字代码导致 cyq_chips API 返回"指定数据不存在"
    const normalizedStocks = stocks.map((s) => ({ ...s, tsCode: toTushareCode(s.tsCode) }))

    // 先补全监控股池近 14 天的日线收盘价，确保 daily_close_cache 包含最新交易日，
    // 使 getRecentTradeDates 能返回最新数据而不是上次定时任务的过期日期
    const startDateForDaily = (() => {
      const d = new Date()
      d.setDate(d.getDate() - 14)
      const yyyy = d.getFullYear()
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${yyyy}${mm}${dd}`
    })()
    try {
      const dailyRows = await fetchDailyForCandidates(
        token,
        normalizedStocks.map((s) => s.tsCode),
        startDateForDaily
      )
      if (dailyRows.length > 0) upsertDailyClose(db, dailyRows)
    } catch (e) {
      console.warn('[ChipMonitor] 补全日线数据失败，将使用 DB 现有数据:', e)
    }

    // 5日松动需要 6 个有效筹码日。扩大窗口可容忍个别日期上游无筹码或本地缺缓存。
    const tradeDates = getRecentTradeDates(db, CHIP_HISTORY_DAYS)
    if (tradeDates.length === 0) {
      return { success: 0, failed: 0 }
    }

    // 收集缺失的 (tsCode, tradeDate) 组合
    const missing: { tsCode: string; tradeDate: string }[] = []
    for (const stock of normalizedStocks) {
      for (const td of tradeDates) {
        const cached = queryChips(db, stock.tsCode, td)
        if (cached.length === 0) {
          missing.push({ tsCode: stock.tsCode, tradeDate: td })
        }
      }
    }

    // 分批拉取（每批 3 只股票，批间延迟 1000ms）
    // 按股票分组，同股不同日顺序执行；不同股可并发
    const byStock = new Map<string, string[]>()
    for (const { tsCode, tradeDate } of missing) {
      if (!byStock.has(tsCode)) byStock.set(tsCode, [])
      byStock.get(tsCode)!.push(tradeDate)
    }

    const stocksWithMissing = Array.from(byStock.keys())
    const totalStocks = stocks.length
    let done = totalStocks - stocksWithMissing.length

    if (done > 0) {
      win?.webContents.send('shortTerm:chipMonitor:progress', {
        done,
        total: totalStocks,
        currentStock: '本地缓存',
      })
    }

    for (let i = 0; i < stocksWithMissing.length; i += CHIP_FETCH_BATCH_SIZE) {
      const batch = stocksWithMissing.slice(i, i + CHIP_FETCH_BATCH_SIZE)
      await Promise.all(
        batch.map(async (tsCode) => {
          const wantedDates = new Set(byStock.get(tsCode) ?? [])
          try {
            const chips = await fetchCyqChipsSingleflight(token, tsCode)
            const relevantRows = chips.filter((row) => wantedDates.has(row.tradeDate))
            if (relevantRows.length > 0) {
              upsertChips(db, relevantRows)
            }
          } catch (e) {
            console.warn(`[ChipMonitor] fetchCyqChips 历史同步失败 ${tsCode}:`, e)
          }
        })
      )
      done += batch.length
      win?.webContents.send('shortTerm:chipMonitor:progress', {
        done: Math.min(done, totalStocks),
        total: totalStocks,
        currentStock:
          normalizedStocks.find((s) => s.tsCode === batch[batch.length - 1])?.stockName ??
          batch[batch.length - 1],
      })
      // 批间延迟（最后一批不需要等待）
      if (i + CHIP_FETCH_BATCH_SIZE < stocksWithMissing.length) {
        await new Promise((resolve) => setTimeout(resolve, CHIP_FETCH_BATCH_DELAY_MS))
      }
    }

    // 拉取完成后计算指标并写入结果
    const now = Date.now()
    const results: ChipMonitorResultRow[] = []

    // 取 daily_close_cache 中各日收盘价、涨跌幅、换手率（后两者用于结果行的辅助字段）
    interface DailyRecord { close: number; pctChg: number | null; turnoverRate: number | null }
    const closePrices = new Map<string, Map<string, DailyRecord>>() // tsCode → tradeDate → record
    for (const stock of normalizedStocks) {
      const rows = db
        .prepare(
          `SELECT trade_date, close, pct_chg, turnover_rate FROM daily_close_cache
           WHERE ts_code = ? AND trade_date IN (${tradeDates.map(() => '?').join(',')})
           ORDER BY trade_date ASC`
        )
        .all(stock.tsCode, ...tradeDates) as {
          trade_date: string
          close: number
          pct_chg: number | null
          turnover_rate: number | null
        }[]
      const m = new Map<string, DailyRecord>()
      for (const r of rows) m.set(r.trade_date, { close: r.close, pctChg: r.pct_chg ?? null, turnoverRate: r.turnover_rate ?? null })
      closePrices.set(stock.tsCode, m)
    }

    for (const stock of normalizedStocks) {
      const closeMap = closePrices.get(stock.tsCode) ?? new Map<string, DailyRecord>()

      // 相对模式：固定使用最新交易日的收盘价作为 boundary 基准（close × 0.8），
      // 避免因价格上涨导致历史日 boundary 偏低、跨日底部占比不可比，进而产生虚假松动信号。
      // absolute 模式 boundary 由各日筹码自身 min/max 决定，不依赖 close，无此问题。
      let latestCloseForRelative: number | null = null
      if (mode === 'relative') {
        for (let i = tradeDates.length - 1; i >= 0; i--) {
          const rec = closeMap.get(tradeDates[i])
          if (rec != null) { latestCloseForRelative = rec.close; break }
        }
      }

      // 计算各日底部筹码指标
      const dailyMetrics: { tradeDate: string; metrics: BottomChipMetrics }[] = []
      for (const td of tradeDates) {
        const rec = closeMap.get(td)
        if (rec == null) continue
        const chips = queryChips(db, stock.tsCode, td)
        if (chips.length === 0) continue
        // queryChips 返回 {price, percent}，转为 CyqChipsRow 兼容类型
        const cyqRows = chips.map((c) => ({
          tsCode: stock.tsCode,
          tradeDate: td,
          price: c.price,
          percent: c.percent,
        })) as CyqChipsRow[]
        // 相对模式统一用最新收盘价作 boundary 基准，确保跨日底部占比在同一口径下可比
        const refClose = mode === 'relative' ? (latestCloseForRelative ?? rec.close) : rec.close
        dailyMetrics.push({ tradeDate: td, metrics: computeBottomChips(cyqRows, refClose, mode) })
      }

      if (dailyMetrics.length === 0) {
        failed++
        continue
      }

      // 取最新一日
      const latestEntry = dailyMetrics[dailyMetrics.length - 1]
      const latestPct = latestEntry.metrics.bottomPct

      const l1 = calcLoosening(dailyMetrics, latestPct, 1, mode)
      const l3 = calcLoosening(dailyMetrics, latestPct, 3, mode)
      const l5 = calcLoosening(dailyMetrics, latestPct, 5, mode)

      results.push({
        tsCode: stock.tsCode,
        tradeDate: latestEntry.tradeDate,
        mode,
        bottomPct: latestEntry.metrics.bottomPct,
        bottomAvgCost: latestEntry.metrics.bottomAvgCost,
        loosening1d: l1.value,
        loosening3d: l3.value,
        loosening5d: l5.value,
        loosening1dReason: l1.reason,
        loosening3dReason: l3.reason,
        loosening5dReason: l5.reason,
        updatedAt: now,
        pctChg: closeMap.get(latestEntry.tradeDate)?.pctChg ?? null,
        turnoverRate: closeMap.get(latestEntry.tradeDate)?.turnoverRate ?? null,
        currentPrice: null, // 盗中由 getResults handler 用 sharedRtKCache 覆盖
      })
      success++
    }

    upsertMonitorResults(db, results)
    win?.webContents.send('shortTerm:chipMonitor:done', { success, failed })
    return { success, failed }
  } finally {
    _jobRunning = false
  }
}

/** 返回当前 job 是否正在执行 */
export function isChipMonitorJobRunning(): boolean {
  return _jobRunning
}

/**
 * 用 DB 现有数据重算筹码监控指标，不发起任何 API 请求。
 * 适用于切换「相对低位/绝对低位」模式时立即重算，避免触发不必要的进度条。
 */
export function recomputeChipMonitorResults(
  db: Database.Database,
  mode: ChipMonitorMode = 'relative'
): { success: number; failed: number } {
  const stocks = getMonitorStocks(db)
  if (stocks.length === 0) return { success: 0, failed: 0 }

  const normalizedStocks = stocks.map((s) => ({ ...s, tsCode: toTushareCode(s.tsCode) }))

  // 从 cyq_chips_cache 取实际有筹码数据的最近 N 个交易日，
  // 避免用 daily_close_cache 的日期（可能包含尚未拉取筹码的最新交易日）
  const tsCodeList = normalizedStocks.map((s) => s.tsCode)
  const placeholders = tsCodeList.map(() => '?').join(',')
  const tradeDateRows = db
    .prepare(
      `SELECT DISTINCT trade_date FROM cyq_chips_cache
       WHERE ts_code IN (${placeholders})
       ORDER BY trade_date DESC LIMIT ?`
    )
     .all(...tsCodeList, CHIP_HISTORY_DAYS) as { trade_date: string }[]
  const tradeDates = tradeDateRows.map((r) => r.trade_date).reverse() // 升序
  if (tradeDates.length === 0) return { success: 0, failed: 0 }

  const now = Date.now()
  const results: ChipMonitorResultRow[] = []

  // 取各交易日收盘价、涨跌幅、换手率
  interface DailyRecord { close: number; pctChg: number | null; turnoverRate: number | null }
  const closePrices = new Map<string, Map<string, DailyRecord>>()
  for (const stock of normalizedStocks) {
    const rows = db
      .prepare(
        `SELECT trade_date, close, pct_chg, turnover_rate FROM daily_close_cache
         WHERE ts_code = ? AND trade_date IN (${tradeDates.map(() => '?').join(',')})
         ORDER BY trade_date ASC`
      )
      .all(stock.tsCode, ...tradeDates) as {
        trade_date: string
        close: number
        pct_chg: number | null
        turnover_rate: number | null
      }[]
    const m = new Map<string, DailyRecord>()
    for (const r of rows) {
      m.set(r.trade_date, {
        close: r.close,
        pctChg: r.pct_chg ?? null,
        turnoverRate: r.turnover_rate ?? null,
      })
    }
    closePrices.set(stock.tsCode, m)
  }

  let success = 0
  let failed = 0

  for (const stock of normalizedStocks) {
    const closeMap = closePrices.get(stock.tsCode) ?? new Map<string, DailyRecord>()

    // relative 模式统一用最新交易日收盘价作 boundary 基准，保证跨日底部占比口径一致
    let latestCloseForRelative: number | null = null
    if (mode === 'relative') {
      for (let i = tradeDates.length - 1; i >= 0; i--) {
        const rec = closeMap.get(tradeDates[i])
        if (rec != null) { latestCloseForRelative = rec.close; break }
      }
    }

    const dailyMetrics: { tradeDate: string; metrics: BottomChipMetrics }[] = []
    for (const td of tradeDates) {
      const rec = closeMap.get(td)
      if (rec == null) continue
      const chips = queryChips(db, stock.tsCode, td)
      if (chips.length === 0) continue
      const cyqRows = chips.map((c) => ({
        tsCode: stock.tsCode,
        tradeDate: td,
        price: c.price,
        percent: c.percent,
      })) as CyqChipsRow[]
      const refClose = mode === 'relative' ? (latestCloseForRelative ?? rec.close) : rec.close
      dailyMetrics.push({ tradeDate: td, metrics: computeBottomChips(cyqRows, refClose, mode) })
    }

    if (dailyMetrics.length === 0) { failed++; continue }

    const latestEntry = dailyMetrics[dailyMetrics.length - 1]
    const latestPct = latestEntry.metrics.bottomPct

    const l1 = calcLoosening(dailyMetrics, latestPct, 1, mode)
    const l3 = calcLoosening(dailyMetrics, latestPct, 3, mode)
    const l5 = calcLoosening(dailyMetrics, latestPct, 5, mode)

    results.push({
      tsCode: stock.tsCode,
      tradeDate: latestEntry.tradeDate,
      mode,
      bottomPct: latestEntry.metrics.bottomPct,
      bottomAvgCost: latestEntry.metrics.bottomAvgCost,
      loosening1d: l1.value,
      loosening3d: l3.value,
      loosening5d: l5.value,
      loosening1dReason: l1.reason,
      loosening3dReason: l3.reason,
      loosening5dReason: l5.reason,
      updatedAt: now,
      pctChg: closeMap.get(latestEntry.tradeDate)?.pctChg ?? null,
      turnoverRate: closeMap.get(latestEntry.tradeDate)?.turnoverRate ?? null,
      currentPrice: null, // 盗中由 getResults handler 用 sharedRtKCache 覆盖
    })
    success++
  }

  if (results.length > 0) upsertMonitorResults(db, results)
  return { success, failed }
}

function calcLoosening(
  dailyMetrics: { tradeDate: string; metrics: BottomChipMetrics }[],
  latestPct: number | null,
  daysBack: 1 | 3 | 5,
  mode: ChipMonitorMode
): { value: number | null; reason: LooseningMissingReason | null } {
  const targetIdx = dailyMetrics.length - 1 - daysBack
  if (targetIdx < 0 || latestPct == null) {
    return { value: null, reason: 'INSUFFICIENT_HISTORY' }
  }

  const prevPct = dailyMetrics[targetIdx].metrics.bottomPct
  if (prevPct == null) {
    return { value: null, reason: 'INSUFFICIENT_HISTORY' }
  }

  // relative 模式下小于 1% 的历史底部占比属于异常小分母，松动率会被放大。
  // absolute 模式只排除接近 0 的极端情况，保留高位集中筹码的低占比判断。
  const minPct = mode === 'absolute' ? 0.05 : 1.0
  if (prevPct < minPct) {
    return { value: null, reason: 'LOW_BASE_PCT' }
  }

  return { value: ((prevPct - latestPct) / prevPct) * 100, reason: null }
}
