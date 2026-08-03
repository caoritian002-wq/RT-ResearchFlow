/**
 * FR-164: 长线趋势全市场日线同步服务
 *
 * 职责：
 * - 按日期从 Tushare daily 接口拉取全市场 OHLCV，写入 daily_close_cache
 * - 每次间隔 200ms，防止超过频率限制（≤300次/分钟）
 * - 仅同步缺失日期（已有数据的日期跳过）
 */

import type Database from 'better-sqlite3'
import { BrowserWindow } from 'electron'
import {
  fetchDailyByDate,
  fetchDailyForCandidates,
  fetchEastmoneySingleStockDaily,
  ensureTrendBenchmarkFreshness,
} from './tushareService'
import { inspectTrendBenchmarkHealth, type TrendBenchmarkHealth } from './trendBenchmarkFreshness'
import { upsertDailyClose, queryDailyClose } from '../database/dailyCloseCacheRepository'
import { queryStockOHLCV } from '../database/dailyCloseCacheRepository'
import { getCachedPrices } from '../database/stockPriceCacheRepository'
import { getLastNTradingDays } from '../database/tradeCalRepository'

/** 全市场同步防重入锁 */
let _syncRunning = false
let _candidateBackfillRunning = false

export interface TrendBackfillResult {
  requested: number
  synced: number
  skipped: number
  failed: number
  benchmark: TrendBenchmarkHealth
  stocks: Array<{
    tsCode: string
    provider: 'tushare' | 'eastmoney' | 'local-cache'
    latestTradeDate: string | null
    bars: number
    state: 'ready' | 'partial' | 'missing'
    message: string
    error: string | null
  }>
}

/**
 * 同步最近 N 个交易日的全市场日线数据到 daily_close_cache。
 * - 先查 DB 已有日期，跳过已有数据的日期（减少 API 调用）
 * - 每日间隔 200ms，防频率超限
 * - win 不为 null 时推送 trend:syncProgress 事件
 */
export async function syncTrendDailyData(
  db: Database.Database,
  token: string,
  days = 60,
  win?: BrowserWindow
): Promise<{ synced: number; skipped: number; failed: number }> {
  if (_syncRunning) {
    return { synced: 0, skipped: 0, failed: -1 }
  }
  _syncRunning = true
  const result = { synced: 0, skipped: 0, failed: 0 }

  try {
    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const todayYmd =
      `${bjNow.getUTCFullYear()}` +
      `${String(bjNow.getUTCMonth() + 1).padStart(2, '0')}` +
      `${String(bjNow.getUTCDate()).padStart(2, '0')}`

    // 从交易日历取最近 N 个交易日
    const tradeDates = getLastNTradingDays(db, days, todayYmd)
    if (tradeDates.length === 0) {
      console.warn('[TrendSync] No trading dates found in trade_cal, skipping sync')
      return result
    }

    // 检查哪些日期已有全市场数据（取一个固定的标准股如平安银行 000001.SZ 作为探针）
    const probeTsCode = '000001.SZ'
    const existingMap = queryDailyClose(db, [probeTsCode], tradeDates[0])
    const existingDates = new Set(
      (existingMap.get(probeTsCode) ?? []).map((r) => r.tradeDate)
    )

    // 筛出需要同步的日期
    const toSync = tradeDates.filter((d) => !existingDates.has(d))

    if (toSync.length === 0) {
      result.skipped = tradeDates.length
      console.log(`[TrendSync] All ${tradeDates.length} dates already cached, skip`)
      return result
    }

    console.log(`[TrendSync] Need to sync ${toSync.length} dates, skipping ${tradeDates.length - toSync.length}`)

    for (let i = 0; i < toSync.length; i++) {
      const tradeDate = toSync[i]
      try {
        const rows = await fetchDailyByDate(token, tradeDate)
        if (rows.length > 0) {
          upsertDailyClose(db, rows)
          result.synced++
        } else {
          // 当日可能是非交易日，返回0行是正常的
          result.skipped++
        }

        // 推送进度
        if (win && !win.isDestroyed()) {
          win.webContents.send('trend:syncProgress', {
            current: i + 1,
            total: toSync.length,
            tradeDate,
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[TrendSync] Failed for ${tradeDate}: ${msg}`)
        result.failed++
      }

      // 每次请求后等待 200ms，防超频
      if (i < toSync.length - 1) {
        await new Promise((r) => setTimeout(r, 200))
      }
    }

    console.log(`[TrendSync] Done: synced=${result.synced} skipped=${result.skipped} failed=${result.failed}`)
    return result
  } finally {
    _syncRunning = false
    // 同步完成事件
    if (win && !win.isDestroyed()) {
      win.webContents.send('trend:syncDone', result)
    }
  }
}

/** 判断是否有全市场同步正在进行 */
export function isTrendSyncRunning(): boolean {
  return _syncRunning
}

export async function backfillTrendStockData(
  db: Database.Database,
  token: string | null,
  inputCodes: string[],
  win?: BrowserWindow,
): Promise<TrendBackfillResult> {
  if (_candidateBackfillRunning) throw new Error('TREND_BACKFILL_RUNNING')
  _candidateBackfillRunning = true
  const tsCodes = [...new Set(inputCodes.map(normalizeTsCode).filter(Boolean))].slice(0, 200)
  const startDate = offsetYmd(-240)
  const result: TrendBackfillResult = {
    requested: tsCodes.length,
    synced: 0,
    skipped: 0,
    failed: 0,
    benchmark: inspectTrendBenchmarkHealth(db),
    stocks: [],
  }

  try {
    result.benchmark = await ensureTrendBenchmarkFreshness(db)
    for (let index = 0; index < tsCodes.length; index += 1) {
      const tsCode = tsCodes[index]
      const existing = getLocalCoverage(db, tsCode, startDate)
      if (existing.bars >= 60) {
        result.skipped += 1
        result.stocks.push({
          tsCode,
          provider: 'local-cache',
          latestTradeDate: existing.latestTradeDate,
          bars: existing.bars,
          state: 'ready',
          message: coverageMessage('本地缓存', existing),
          error: null,
        })
        sendBackfillProgress(win, index + 1, tsCodes.length, tsCode, 'skipped', 'local-cache')
        continue
      }

      try {
        const provider = token ? 'tushare' as const : 'eastmoney' as const
        let upstreamMessage = ''
        if (token) {
          const rows = await fetchDailyForCandidates(token, [tsCode], startDate)
          if (rows.length > 0) upsertDailyClose(db, rows)
          upstreamMessage = rows.length > 0 ? `Tushare返回${rows.length}根日线` : 'Tushare未返回新的有效日线'
        } else {
          const fetched = await fetchEastmoneySingleStockDaily(db, stripSuffix(tsCode))
          if (!fetched.ok) throw new Error(fetched.message)
          upstreamMessage = fetched.message
        }

        const coverage = getLocalCoverage(db, tsCode, startDate)
        const ready = coverage.bars >= 60
        if (ready) result.synced += 1
        else result.failed += 1
        const error = ready ? null : coverageGapMessage(coverage)
        result.stocks.push({
          tsCode,
          provider,
          latestTradeDate: coverage.latestTradeDate,
          bars: coverage.bars,
          state: coverage.state,
          message: ready ? coverageMessage(provider === 'tushare' ? 'Tushare行情' : '东方财富公开行情', coverage) : `${upstreamMessage} · ${error}`,
          error,
        })
        sendBackfillProgress(win, index + 1, tsCodes.length, tsCode, ready ? 'synced' : 'failed', provider)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const coverage = getLocalCoverage(db, tsCode, startDate)
        const provider = token ? 'tushare' as const : 'eastmoney' as const
        result.failed += 1
        result.stocks.push({
          tsCode,
          provider,
          latestTradeDate: coverage.latestTradeDate,
          bars: coverage.bars,
          state: coverage.state,
          message: coverage.bars > 0 ? `${message} · 已保留本地${coverage.bars}根日线` : message,
          error: message,
        })
        sendBackfillProgress(win, index + 1, tsCodes.length, tsCode, 'failed', provider)
      }
    }
    return result
  } finally {
    _candidateBackfillRunning = false
    if (win && !win.isDestroyed()) win.webContents.send('trend:backfillDone', result)
  }
}

export function isTrendBackfillRunning(): boolean {
  return _candidateBackfillRunning
}

interface LocalCoverage {
  bars: number
  latestTradeDate: string | null
  state: 'ready' | 'partial' | 'missing'
}

function getLocalCoverage(db: Database.Database, tsCode: string, startDate: string): LocalCoverage {
  const dailyRows = queryStockOHLCV(db, tsCode, startDate)
  const priceRows = getCachedPrices(db, stripSuffix(tsCode))
    .filter((row) => row.tradeDate >= startDate && (row.close ?? 0) > 0)
  const bars = Math.max(dailyRows.length, priceRows.length)
  const latestTradeDate = [dailyRows.at(-1)?.tradeDate, priceRows.at(-1)?.tradeDate]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null
  return {
    bars,
    latestTradeDate,
    state: bars >= 60 ? 'ready' : bars >= 20 ? 'partial' : 'missing',
  }
}

function coverageMessage(source: string, coverage: LocalCoverage): string {
  const date = coverage.latestTradeDate ? formatTradeDate(coverage.latestTradeDate) : '日期待补'
  return `${source} · 截至 ${date} · ${coverage.bars}日`
}

function coverageGapMessage(coverage: LocalCoverage): string {
  if (coverage.bars === 0) return '未取得有效日线'
  return `仅有${coverage.bars}根有效日线，距离基础趋势研判还差${Math.max(0, 60 - coverage.bars)}根`
}

function formatTradeDate(value: string): string {
  if (!/^\d{8}$/.test(value)) return value
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function stripSuffix(tsCode: string): string {
  return tsCode.replace(/\.(SH|SZ|BJ)$/i, '')
}

function normalizeTsCode(value: string): string {
  const clean = value.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(clean)) return clean
  if (!/^\d{6}$/.test(clean)) return ''
  if (/^(600|601|603|605|688|900|110|113|118|127|128|129|131|132)/.test(clean)) return `${clean}.SH`
  if (/^(430|830|87|88|89|92)/.test(clean)) return `${clean}.BJ`
  return `${clean}.SZ`
}

function offsetYmd(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function sendBackfillProgress(
  win: BrowserWindow | undefined,
  current: number,
  total: number,
  tsCode: string,
  status: 'synced' | 'skipped' | 'failed',
  provider: 'tushare' | 'eastmoney' | 'local-cache',
): void {
  if (win && !win.isDestroyed()) win.webContents.send('trend:backfillProgress', { current, total, tsCode, status, provider })
}
