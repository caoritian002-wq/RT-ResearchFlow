import type Database from 'better-sqlite3'
import { getCachedDates, getCachedPrices, getStockInfo, hasMissingAmount, insertPrices, upsertStockInfo } from '../database/stockPriceCacheRepository'
import { upsertDailyClose } from '../database/dailyCloseCacheRepository'
import type {
  StockPriceCacheRow,
  StockMinuteCacheRow,
  LimitListDailyRow,
  KplListRow,
  StkAuctionRow,
  KplConceptMembersRow,
  TopListDailyRow,
  TopInstDailyRow,
  MoneyFlowDailyRow
} from '../database/types'
import { withRetry } from '../utils/retry'
import {
  inspectTrendBenchmarkHealth,
  type TrendBenchmarkErrorCode,
  type TrendBenchmarkHealth,
} from './trendBenchmarkFreshness'

/** Single data point for intraday (分时) chart */
export interface IntradayItem {
  time: string    // "HH:mm"
  price: number   // close price for the 5-min bar
  volume: number  // trading volume in 手 (100 shares)
}

const TUSHARE_API_URL = 'https://api.tushare.pro'
const EASTMONEY_KLINE_API = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'

/** Eastmoney secid for each preset index (market.code) */
const INDEX_SECID: Record<string, string> = {
  '000001.SH': '1.000001',
  '000300.SH': '1.000300',
  '399001.SZ': '0.399001',
  '399006.SZ': '0.399006',
  '000688.SH': '1.000688'   // 科创50（FR-072）
}

/**
 * FR-072: Infer the board-level secid for a regular stock code.
 * 6xxxx  → SH main board (上证指数 1.000001)
 * 68xxxx → STAR Market (科创50 1.000688)
 * 30xxxx → ChiNext (创业板指 0.399006)
 * 0xxxx  → SZ main board (深成指 0.399001)
 */
export function getBoardSecid(stockCode: string): string {
  if (stockCode.startsWith('68')) return '1.000688'
  if (stockCode.startsWith('30')) return '0.399006'
  if (stockCode.startsWith('6'))  return '1.000001'
  return '0.399001'
}

/** Fallback names in case Eastmoney doesn't return a name field */
const INDEX_NAMES: Record<string, string> = {
  '000001.SH': '上证指数',
  '000300.SH': '沪深300',
  '399001.SZ': '深成指',
  '399006.SZ': '创业板指'
}

interface TushareResponse {
  code: number
  msg: string
  data?: {
    fields: string[]
    items: (string | number | null)[][]
  }
}

/** Tushare Pro REST API: POST JSON body format */
function buildRequest(token: string, apiName: string, params: Record<string, string>, fields: string) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token, params, fields })
  }
}

/** Map 6-digit A-share code to Tushare ts_code format (e.g. 600036 → 600036.SH) */
function toTsCode(code: string): string {
  return code.startsWith('6') ? `${code}.SH` : `${code}.SZ`
}

/** FR-064: Small pause between consecutive Tushare API calls to avoid burst rate limiting */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Helper to compute Beijing time date strings */
function bjDateRange(): { endDate: string; startDate30: string } {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const endDate = bjNow.toISOString().slice(0, 10).replace(/-/g, '')
  // 270 日历天 ≈ 180 个交易日，满足长周期指标及趋势分析需求
  const startDate30 = new Date(bjNow.getTime() - 270 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  return { endDate, startDate30 }
}

/** Validate a Tushare token using the trade_cal API (lightweight, no data cost) */
export async function validateTushareToken(token: string): Promise<{ valid: boolean; message: string }> {
  try {
    const res = await withRetry(() => fetch(
      TUSHARE_API_URL,
      buildRequest(token, 'trade_cal', { exchange: 'SSE', start_date: '20240101', end_date: '20240101' }, 'cal_date')
    ))
    const json = (await res.json()) as TushareResponse
    if (json.code === 0) return { valid: true, message: 'Token 有效' }
    return { valid: false, message: json.msg || 'Token 无效' }
  } catch (err) {
    return { valid: false, message: err instanceof Error ? err.message : '网络错误' }
  }
}

interface EastmoneyKlineResponse {
  rc: number
  data?: {
    name?: string
    klines?: string[]
  }
}

type EastmoneyParsedDailyRow = StockPriceCacheRow & {
  pctChg: number | null
  turnoverRate: number | null
}

export type SingleStockDailyProvider = 'eastmoney'
export type SingleStockDailyState = 'complete' | 'degraded'

export type SingleStockDailyFetchResult =
  | {
      ok: true
      stockCode: string
      tsCode: string
      stockName: string
      provider: SingleStockDailyProvider
      latestTradeDate: string
      rowsWritten: number
      totalRows: number
      dataState: SingleStockDailyState
      benchmark: TrendBenchmarkHealth
      message: string
    }
  | {
      ok: false
      code: 'INVALID_STOCK_CODE' | 'STOCK_NOT_FOUND' | 'FETCH_FAILED'
      message: string
    }

function normalizeAshareCode(value: string): { stockCode: string; tsCode: string; secid: string } | null {
  const clean = value.trim().toUpperCase()
  const stockCode = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  if (!/^\d{6}$/.test(stockCode)) return null

  const isShanghai = /^(600|601|603|605|688|900|110|113|118|127|128|129|131|132)/.test(stockCode)
  const isBeijing = /^(430|830|87|88|89|92)/.test(stockCode)
  const market = isShanghai ? 'SH' : isBeijing ? 'BJ' : 'SZ'
  return {
    stockCode,
    tsCode: `${stockCode}.${market}`,
    secid: `${isShanghai ? '1' : '0'}.${stockCode}`,
  }
}

function parseEastmoneyDailyRows(
  stockCode: string,
  klines: string[],
  fetchedAt: number,
): EastmoneyParsedDailyRow[] {
  const rows = klines.flatMap((kline): EastmoneyParsedDailyRow[] => {
    const parts = kline.split(',')
    if (parts.length < 7) return []
    const tradeDate = parts[0].replace(/-/g, '')
    const close = Number.parseFloat(parts[2])
    if (!/^\d{8}$/.test(tradeDate) || !Number.isFinite(close) || close <= 0) return []
    const numberOrNull = (value: string): number | null => {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    const amountYuan = numberOrNull(parts[6])
    return [{
      stockCode,
      tradeDate,
      open: numberOrNull(parts[1]),
      close,
      high: numberOrNull(parts[3]),
      low: numberOrNull(parts[4]),
      volume: numberOrNull(parts[5]),
      amount: amountYuan == null ? null : amountYuan / 1000,
      pctChg: numberOrNull(parts[8]),
      turnoverRate: numberOrNull(parts[10]),
      fetchedAt,
    }]
  })

  const byDate = new Map(rows.map((row) => [row.tradeDate, row]))
  return [...byDate.values()]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
    .slice(-149)
}

function isUsableStockName(value: string | undefined, stockCode: string): value is string {
  const name = value?.trim()
  return Boolean(name && name !== stockCode && name !== '-' && name !== '--')
}

function formatTradeDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

/**
 * FR-252: Fetch one explicitly selected A-share from Eastmoney without API keys.
 * The result is capped at 149 daily bars and written to both existing daily caches.
 */
export async function fetchEastmoneySingleStockDaily(
  db: Database.Database,
  inputCode: string,
): Promise<SingleStockDailyFetchResult> {
  const normalized = normalizeAshareCode(inputCode)
  if (!normalized) {
    return { ok: false, code: 'INVALID_STOCK_CODE', message: '请输入六位股票代码' }
  }

  const { endDate, startDate30 } = bjDateRange()
  try {
    const url = new URL(EASTMONEY_KLINE_API)
    url.searchParams.set('secid', normalized.secid)
    url.searchParams.set('klt', '101')
    url.searchParams.set('fqt', '0')
    url.searchParams.set('beg', startDate30)
    url.searchParams.set('end', endDate)
    url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61')
    url.searchParams.set('lmt', '149')
    url.searchParams.set('_', String(Date.now()))

    const response = await withRetry(() => fetch(url.toString()))
    if (!response.ok) {
      return { ok: false, code: 'FETCH_FAILED', message: '公开行情请求失败，请稍后重试' }
    }
    const json = (await response.json()) as EastmoneyKlineResponse
    const rows = parseEastmoneyDailyRows(normalized.stockCode, json.data?.klines ?? [], Date.now())
    const existingName = getStockInfo(db, normalized.stockCode)?.stockName
    const stockName = isUsableStockName(json.data?.name, normalized.stockCode)
      ? json.data.name.trim()
      : isUsableStockName(existingName, normalized.stockCode)
        ? existingName.trim()
        : null

    if (json.rc !== 0 || rows.length === 0 || !stockName) {
      return {
        ok: false,
        code: 'STOCK_NOT_FOUND',
        message: `未找到股票代码 ${normalized.stockCode}，请确认代码是否正确`,
      }
    }

    const dailyRows: DailyRow[] = rows.map((row, index) => {
      const previousClose = index > 0 ? rows[index - 1].close : null
      const pctChg = row.pctChg ?? (
        previousClose != null && previousClose > 0 && row.close != null
          ? (row.close - previousClose) / previousClose * 100
          : 0
      )
      return {
        tsCode: normalized.tsCode,
        tradeDate: row.tradeDate,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close!,
        pctChg,
        vol: row.volume,
        turnoverRate: row.turnoverRate,
        amount: row.amount,
      }
    })

    db.transaction(() => {
      insertPrices(db, rows)
      upsertDailyClose(db, dailyRows)
      upsertStockInfo(db, normalized.stockCode, stockName)
    })()

    // Relative strength needs a fixed market benchmark. This is the only
    // companion request and reuses the same local-first, no-key index path.
    const benchmark = await ensureTrendBenchmarkFreshness(db)
    const cached = getCachedPrices(db, normalized.stockCode)
    const latestTradeDate = cached.at(-1)?.tradeDate ?? rows.at(-1)!.tradeDate
    const dataState: SingleStockDailyState = cached.length >= 60 && benchmark.state === 'current'
      ? 'complete'
      : 'degraded'
    const coverage = `${cached.length} 日`
    const benchmarkGap = benchmark.state === 'current' ? '' : ` · ${benchmark.message}`
    return {
      ok: true,
      stockCode: normalized.stockCode,
      tsCode: normalized.tsCode,
      stockName,
      provider: 'eastmoney',
      latestTradeDate,
      rowsWritten: rows.length,
      totalRows: cached.length,
      dataState,
      benchmark,
      message: `东方财富公开行情 · 截至 ${formatTradeDate(latestTradeDate)} · ${coverage}${benchmarkGap}`,
    }
  } catch {
    return { ok: false, code: 'FETCH_FAILED', message: '公开行情请求失败，请稍后重试' }
  }
}

/** Build one daily OHLCV row from intraday 5-min points. */
function buildDailyRowFromIntraday(
  stockCode: string,
  tradeDate: string,
  items: IntradayItem[]
): StockPriceCacheRow | null {
  const valid = items
    .filter((i) => Number.isFinite(i.price))
    .sort((a, b) => a.time.localeCompare(b.time))
  if (valid.length === 0) return null

  const open = valid[0].price
  const close = valid[valid.length - 1].price
  const high = Math.max(...valid.map((i) => i.price))
  const low = Math.min(...valid.map((i) => i.price))
  const volume = valid.reduce((sum, i) => sum + (Number.isFinite(i.volume) ? i.volume : 0), 0)

  return {
    stockCode,
    tradeDate,
    open,
    high,
    low,
    close,
    volume,
    amount: null,
    fetchedAt: Date.now()
  }
}

interface IndexPriceFetchResult {
  outcome: 'skipped' | 'updated' | 'empty' | 'failed'
  rowsWritten: number
  errorCode: Exclude<TrendBenchmarkErrorCode, 'EXPECTED_DATE_MISSING' | 'INSUFFICIENT_HISTORY' | 'CALENDAR_UNAVAILABLE'>
}

interface BenchmarkAttempt {
  key: string
  attemptedAt: number
  result: TrendBenchmarkHealth
}

const BENCHMARK_ATTEMPT_TTL_MS = 6 * 60 * 60 * 1000
const benchmarkAttempts = new WeakMap<Database.Database, BenchmarkAttempt>()
const benchmarkInFlight = new WeakMap<Database.Database, Promise<TrendBenchmarkHealth>>()

/**
 * FR-067: Fetch daily price data for a preset market index using Eastmoney.
 * The number-only return remains for existing callers; FR-252 uses the detailed
 * benchmark freshness wrapper below.
 */
export async function fetchIndexPrices(
  db: Database.Database,
  tsCode: string,
  force = false,
): Promise<number> {
  return (await fetchIndexPricesDetailed(db, tsCode, force)).rowsWritten
}

async function fetchIndexPricesDetailed(
  db: Database.Database,
  tsCode: string,
  force = false,
): Promise<IndexPriceFetchResult> {
  const { endDate, startDate30 } = bjDateRange()
  const dailyOnly = tsCode === '000300.SH'
  let rowsWritten = 0

  // Skip if already up to date (unless force=true)
  if (!force) {
    if (dailyOnly) {
      if (inspectTrendBenchmarkHealth(db).state === 'current') {
        return { outcome: 'skipped', rowsWritten: 0, errorCode: null }
      }
    } else {
      const cachedDates = getCachedDates(db, tsCode)
      if (cachedDates.has(endDate) && !hasMissingAmount(db, tsCode, startDate30)) {
        return { outcome: 'skipped', rowsWritten: 0, errorCode: null }
      }
    }
  }

  const secid = INDEX_SECID[tsCode]
  if (!secid) return { outcome: 'failed', rowsWritten: 0, errorCode: 'UPSTREAM_ERROR' }

  try {
    const url = new URL(EASTMONEY_KLINE_API)
    url.searchParams.set('secid', secid)
    url.searchParams.set('klt', '101')    // daily
    url.searchParams.set('fqt', '0')      // no price adjustment
    url.searchParams.set('beg', startDate30)
    url.searchParams.set('end', endDate)
    url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57')
    url.searchParams.set('lmt', '60')
    url.searchParams.set('_', String(Date.now()))

    const res = await fetch(url.toString())
    if (!res.ok) return { outcome: 'failed', rowsWritten: 0, errorCode: 'HTTP_ERROR' }
    const json = (await res.json()) as EastmoneyKlineResponse

    if (json.rc !== 0) return { outcome: 'failed', rowsWritten: 0, errorCode: 'UPSTREAM_ERROR' }
    if (!json.data?.klines || json.data.klines.length === 0) {
      return { outcome: 'empty', rowsWritten: 0, errorCode: 'EMPTY_RESPONSE' }
    }

    if (json.data.klines.length > 0) {
      const nowMs = Date.now()
      const newRows: StockPriceCacheRow[] = []

      for (const kline of json.data.klines) {
        // Format: "YYYY-MM-DD,open,close,high,low,vol,amount"
        const parts = kline.split(',')
        if (parts.length < 7) continue
        const tradeDate = parts[0].replace(/-/g, '') // → YYYYMMDD
        const open = parseFloat(parts[1]) || null
        const close = parseFloat(parts[2]) || null
        const high = parseFloat(parts[3]) || null
        const low = parseFloat(parts[4]) || null
        const volume = parseFloat(parts[5]) || null
        // Eastmoney amount is in 元; divide by 1000 → 千元 (same unit as Tushare daily)
        const amountYuan = parseFloat(parts[6])
        const amount = isNaN(amountYuan) ? null : amountYuan / 1000

        newRows.push({ stockCode: tsCode, tradeDate, open, close, high, low, volume, amount, fetchedAt: nowMs })
      }

      if (newRows.length > 0) {
        rowsWritten = newRows.length
        const sortedRows = [...newRows].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
        const dailyRows: DailyRow[] = sortedRows.flatMap((row, index): DailyRow[] => {
          if (row.close == null || row.close <= 0) return []
          const previousClose = index > 0 ? sortedRows[index - 1].close : null
          const pctChg = previousClose != null && previousClose > 0
            ? (row.close - previousClose) / previousClose * 100
            : 0
          return [{
            tsCode,
            tradeDate: row.tradeDate,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            pctChg,
            vol: row.volume,
            turnoverRate: null,
            amount: row.amount,
          }]
        })
        db.transaction(() => {
          if (!dailyOnly) insertPrices(db, sortedRows)
          upsertDailyClose(db, dailyRows)
        })()
      }

      // Cache index name — prefer Eastmoney response name, fall back to hardcoded
      if (!getStockInfo(db, tsCode)) {
        const name = json.data.name || INDEX_NAMES[tsCode]
        if (name) upsertStockInfo(db, tsCode, name)
      }
    }

    // FR-093: if today's daily row is still missing, synthesize it from intraday points.
    if (!dailyOnly && await backfillTodayDailyFromIntradayIfMissing(db, tsCode)) rowsWritten += 1
    return rowsWritten > 0
      ? { outcome: 'updated', rowsWritten, errorCode: null }
      : { outcome: 'empty', rowsWritten: 0, errorCode: 'EMPTY_RESPONSE' }
  } catch {
    // Network failure is non-fatal; cached data remains usable
    return { outcome: 'failed', rowsWritten: 0, errorCode: 'NETWORK_ERROR' }
  }
}

export function ensureTrendBenchmarkFreshness(
  db: Database.Database,
  now = Date.now(),
): Promise<TrendBenchmarkHealth> {
  const current = inspectTrendBenchmarkHealth(db, now)
  if (current.state === 'current') {
    return Promise.resolve({ ...current, refreshOutcome: 'not-needed' })
  }

  const inFlight = benchmarkInFlight.get(db)
  if (inFlight) return inFlight

  const key = `${current.expectedTradeDate ?? 'unknown'}:${current.calendarSource}`
  const previous = benchmarkAttempts.get(db)
  if (previous?.key === key && now - previous.attemptedAt >= 0 && now - previous.attemptedAt < BENCHMARK_ATTEMPT_TTL_MS) {
    return Promise.resolve({
      ...current,
      refreshOutcome: 'deduplicated',
      errorCode: previous.result.errorCode ?? current.errorCode,
      message: `${current.message} · 已复用本事实日最近一次刷新诊断`,
    })
  }

  const request = (async (): Promise<TrendBenchmarkHealth> => {
    const fetched = await fetchIndexPricesDetailed(db, '000300.SH', true)
    const after = inspectTrendBenchmarkHealth(db, now)
    const refreshOutcome = fetched.outcome === 'failed'
      ? 'failed' as const
      : after.state === 'current'
        ? 'updated' as const
        : 'unchanged' as const
    const errorCode = fetched.errorCode ?? after.errorCode
    const suffix = refreshOutcome === 'updated'
      ? `本次写入 ${fetched.rowsWritten} 根基准日线`
      : refreshOutcome === 'failed'
        ? `刷新失败：${benchmarkErrorLabel(errorCode)}`
        : `上游仍未形成应有事实：${benchmarkErrorLabel(errorCode)}`
    const result: TrendBenchmarkHealth = {
      ...after,
      refreshOutcome,
      attempted: true,
      rowsWritten: fetched.rowsWritten,
      errorCode,
      message: `${after.message} · ${suffix}`,
    }
    benchmarkAttempts.set(db, { key, attemptedAt: now, result })
    return result
  })().finally(() => {
    benchmarkInFlight.delete(db)
  })

  benchmarkInFlight.set(db, request)
  return request
}

function benchmarkErrorLabel(code: TrendBenchmarkErrorCode): string {
  if (code === 'HTTP_ERROR') return '上游HTTP异常'
  if (code === 'UPSTREAM_ERROR') return '上游拒绝或返回异常'
  if (code === 'EMPTY_RESPONSE') return '上游返回空数据'
  if (code === 'NETWORK_ERROR') return '网络请求失败'
  if (code === 'EXPECTED_DATE_MISSING') return '最近已结算交易日仍缺失'
  if (code === 'INSUFFICIENT_HISTORY') return '基准历史不足21根'
  if (code === 'CALENDAR_UNAVAILABLE') return '本地交易日历未覆盖'
  return '原因待确认'
}

/**
 * FR-066: Force-refresh a single A-share stock's price data, bypassing the date cache check.
 * Used by the "更新数据" button where the user explicitly wants the latest data.
 */
/**
 * FR-066 / FR-069: Force-fetch a single A-share stock's price data.
 * Returns the number of rows inserted (0 means the stock code was not found in Tushare).
 * Throws on network errors so the caller can apply withRetry.
 */
export async function forceFetchSingleStock(
  db: Database.Database,
  token: string,
  stockCode: string
): Promise<number> {
  const { endDate, startDate30 } = bjDateRange()
  const tsCode = toTsCode(stockCode)

  // Always fetch authoritative stock name from Tushare stock_basic (can correct AI hallucinations)
  try {
    const res = await withRetry(() => fetch(
      TUSHARE_API_URL,
      buildRequest(token, 'stock_basic', { ts_code: tsCode, fields: 'ts_code,name' }, 'ts_code,name')
    ))
    const json = (await res.json()) as TushareResponse
    if (json.code === 0 && json.data && json.data.items.length > 0) {
      const nameIdx = json.data.fields.indexOf('name')
      const name = String(json.data.items[0][nameIdx])
      if (name) upsertStockInfo(db, stockCode, name)
    }
  } catch {
    // Name fetch failure is non-fatal
  }
  await sleep(300)

  // Fetch daily price data — throws on network error (caller should use withRetry)
  const res = await withRetry(() => fetch(
    TUSHARE_API_URL,
    buildRequest(
      token,
      'daily',
      { ts_code: tsCode, start_date: startDate30, end_date: endDate },
       'trade_date,open,high,low,close,pct_chg,vol,amount'
    )
  ))
  const json = (await res.json()) as TushareResponse

  if (json.code === 0 && json.data) {
    const { fields, items } = json.data
    const idx = (name: string) => fields.indexOf(name)
    const nowMs = Date.now()
    const newRows: StockPriceCacheRow[] = []
    const dailyRows: DailyRow[] = []
    for (const item of items) {
      const tradeDate = parseStrOrNull(item[idx('trade_date')])
      const close = parseNumOrNull(item[idx('close')])
      if (!tradeDate || close == null) continue
      const open = parseNumOrNull(item[idx('open')])
      const high = parseNumOrNull(item[idx('high')])
      const low = parseNumOrNull(item[idx('low')])
      const pctChg = parseNumOrNull(item[idx('pct_chg')])
      const vol = parseNumOrNull(item[idx('vol')])
      const amount = parseNumOrNull(item[idx('amount')])
      newRows.push({
        stockCode,
        tradeDate,
        open,
        high,
        low,
        close,
        volume: vol,
        amount,
        fetchedAt: nowMs
      })
      dailyRows.push({
        tsCode,
        tradeDate,
        open,
        high,
        low,
        close,
        pctChg: pctChg ?? 0,
        vol,
        turnoverRate: null,
        amount,
      })
    }
    if (newRows.length > 0) {
      try {
        await sleep(300)
        const basics = await fetchDailyBasicForStock(token, tsCode, startDate30, endDate)
        const turnoverByDate = new Map(basics.map((row) => [row.tradeDate, row.turnoverRate]))
        for (const row of dailyRows) {
          row.turnoverRate = turnoverByDate.get(row.tradeDate) ?? null
        }
      } catch (error) {
        console.warn('[SingleStockRefresh] daily_basic merge failed:', error instanceof Error ? error.message : String(error))
      }
      db.transaction(() => {
        insertPrices(db, newRows)
        upsertDailyClose(db, dailyRows)
      })()
    }

    // FR-093: during provider lag (intraday available, daily missing), backfill today's daily row.
    await backfillTodayDailyFromIntradayIfMissing(db, stockCode)
    return newRows.length
  }

  // Even when daily endpoint returns empty/non-zero, try intraday fallback for today.
  await backfillTodayDailyFromIntradayIfMissing(db, stockCode)

  return 0
}

/**
 * Fetch 30-day daily price data for a list of A-share codes.
 * Incremental: only requests dates not already in local DB cache.
 * Returns a Markdown section per stock for use in the second AI prompt.
 *
 * Tushare daily API fields used:
 *   ts_code, trade_date, open, high, low, close, pct_chg, vol, amount
 */
export async function fetchStockPricesForPrompt(
  db: Database.Database,
  token: string,
  stockCodes: string[]
): Promise<string> {
  const { endDate, startDate30 } = bjDateRange()

  const sections: string[] = []

  for (const code of stockCodes) {
    const tsCode = toTsCode(code)
    const cachedDates = getCachedDates(db, code)

    // FR-063/FR-056: Stock names are now supplied by the AI in the STOCK_CODES line
    // (format: "600036|招商银行"), written to stock_info by parseStockCodes() in aiHandlers.ts.
    // The stock_basic API call and its 300ms rate-limit delay are no longer needed here.

    // Call API when today's data is missing OR when existing rows lack amount data (backfill)
    if (!cachedDates.has(endDate) || hasMissingAmount(db, code, startDate30)) {
      try {
        const res = await withRetry(() => fetch(
          TUSHARE_API_URL,
          buildRequest(
            token,
            'daily',
            { ts_code: tsCode, start_date: startDate30, end_date: endDate },
            'trade_date,open,high,low,close,vol,amount'
          )
        ))
        const json = (await res.json()) as TushareResponse

        if (json.code === 0 && json.data) {
          const { fields, items } = json.data
          const idx = (name: string) => fields.indexOf(name)

          const nowMs = Date.now()
          const newRows: StockPriceCacheRow[] = []
          for (const item of items) {
            const tradeDate = String(item[idx('trade_date')])
            // Always include all returned rows: INSERT OR REPLACE handles both new inserts
            // and backfilling amount for rows that were cached before Migration 018
            newRows.push({
              stockCode: code,
              tradeDate,
              open: item[idx('open')] as number | null,
              high: item[idx('high')] as number | null,
              low: item[idx('low')] as number | null,
              close: item[idx('close')] as number | null,
              volume: item[idx('vol')] as number | null,
              amount: item[idx('amount')] as number | null,
              fetchedAt: nowMs
            })
          }
          if (newRows.length > 0) insertPrices(db, newRows)
        }
      } catch {
        // Network failure: fall back to cached data silently
      }
    }

    // Build Markdown table from cache (ascending by date, last 30 trading days)
    const cached = getCachedPrices(db, code)
      .filter((r) => r.tradeDate >= startDate30)
      .slice(-30)

    if (cached.length === 0) continue

    const tableRows = cached
      .map((r) => `| ${r.tradeDate} | ${r.open ?? '-'} | ${r.high ?? '-'} | ${r.low ?? '-'} | ${r.close ?? '-'} | ${r.volume ?? '-'} |`)
      .join('\n')

    sections.push(
      `### ${code}（${tsCode}）近30交易日日线数据\n` +
      `| 日期 | 开盘 | 最高 | 最低 | 收盘 | 成交量(手) |\n` +
      `|------|------|------|------|------|------------|\n` +
      tableRows
    )
  }

  return sections.join('\n\n')
}

/**
 * FR-070: Fetch intraday (分时) 5-min bar data for the current Beijing trading day.
 * Uses Eastmoney free REST API (klt=5, no Tushare token required).
 * Data is NOT persisted — used only for the current view session.
 *
 * Market prefix logic:
 *   - Preset indices: use INDEX_SECID mapping
 *   - Codes starting with '6': SH market → secid = "1.{code}"
 *   - All others: SZ market → secid = "0.{code}"
 */
/** FR-072: Fetch intraday data by raw Eastmoney secid (e.g. "1.000001"). */
export async function fetchIntradayDataBySecid(secid: string): Promise<IntradayItem[]> {
  return fetchIntradayDataInternal(secid)
}

async function fetchIntradayDataInternal(secid: string, dateStr?: string): Promise<IntradayItem[]> {
  const targetDate = dateStr ?? (() => {
    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    return bjNow.toISOString().slice(0, 10).replace(/-/g, '')
  })()

  try {
    const url = new URL(EASTMONEY_KLINE_API)
    url.searchParams.set('secid', secid)
    url.searchParams.set('klt', '5')
    url.searchParams.set('fqt', '0')
    url.searchParams.set('beg', targetDate)
    url.searchParams.set('end', targetDate)
    url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57')
    url.searchParams.set('lmt', '200')
    url.searchParams.set('_', String(Date.now()))

    const res = await fetch(url.toString())
    const json = (await res.json()) as EastmoneyKlineResponse

    if (json.rc !== 0 || !json.data?.klines || json.data.klines.length === 0) {
      return []
    }

    const items: IntradayItem[] = []
    for (const kline of json.data.klines) {
      const parts = kline.split(',')
      if (parts.length < 6) continue
      const timePart = parts[0]
      const timeFull = timePart.includes(' ') ? timePart.split(' ')[1] : timePart
      const price = parseFloat(parts[2])
      const volume = parseFloat(parts[5])
      if (!timeFull || isNaN(price)) continue
      items.push({ time: timeFull, price, volume: isNaN(volume) ? 0 : volume })
    }
    return items
  } catch {
    return []
  }
}

export async function fetchIntradayData(stockCode: string): Promise<IntradayItem[]> {
  let secid: string
  if (INDEX_SECID[stockCode]) {
    secid = INDEX_SECID[stockCode]
  } else if (stockCode.startsWith('6')) {
    secid = `1.${stockCode}`
  } else {
    secid = `0.${stockCode}`
  }
  return fetchIntradayDataInternal(secid)
}

/** Fetch intraday 5-min data for a specific historical date (YYYYMMDD format) */
export async function fetchIntradayDataByDate(
  stockCode: string,
  tradeDate: string
): Promise<IntradayItem[]> {
  let secid: string
  if (INDEX_SECID[stockCode]) {
    secid = INDEX_SECID[stockCode]
  } else if (stockCode.startsWith('6')) {
    secid = `1.${stockCode}`
  } else {
    secid = `0.${stockCode}`
  }
  return fetchIntradayDataInternal(secid, tradeDate)
}

/** 东财分钟 OHLCV bar（无需 Tushare 权限，作为 rt_min 缺失时的专业蜡烛数据源） */
export interface EastmoneyMinuteBar {
  tradeDate: string // YYYYMMDD（北京时间交易日）
  tsMinute: string // HH:mm
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  vol: number | null // 成交量（手）
  amount: number | null // 成交额（千元，已由东财元口径 ÷1000 换算）
}

/**
 * 通过东财 push2his kline 接口拉取单日 1 分钟完整 OHLCV（klt=1，不复权，与日K口径一致）。
 *
 * 用途：当 Tushare 374 rt_min 权限缺失时，作为个股走势图「专业版分时蜡烛」的免费数据源，
 * 复用与日K相同的 lightweight-charts 渲染管线（写入 stock_minute_cache 由 candle 路径自动点亮）。
 *
 * 探针实测（scripts/eastmoney-probe2.mjs）：带 beg/end 时 rc=0，klt=1 单日返回 240 根完整 OHLCV，
 * 1 次/60s 节奏不触发反爬；缺 beg/end 才会回 rc=102（无效请求，非反爬）。
 *
 * @param stockCode 6 位代码或带后缀（如 '600519' / '600519.SH'）；预置指数走 INDEX_SECID
 * @param tradeDate 可选 YYYYMMDD；缺省取北京时间当日
 */
export async function fetchEastmoneyMinuteOHLCV(
  stockCode: string,
  tradeDate?: string
): Promise<EastmoneyMinuteBar[]> {
  const code = stockCode.includes('.') ? stockCode.split('.')[0] : stockCode
  let secid: string
  if (INDEX_SECID[stockCode]) {
    secid = INDEX_SECID[stockCode]
  } else if (INDEX_SECID[code]) {
    secid = INDEX_SECID[code]
  } else if (code.startsWith('6')) {
    secid = `1.${code}`
  } else {
    secid = `0.${code}`
  }

  const targetDate = tradeDate ?? (() => {
    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    return bjNow.toISOString().slice(0, 10).replace(/-/g, '')
  })()

  try {
    const url = new URL(EASTMONEY_KLINE_API)
    url.searchParams.set('secid', secid)
    url.searchParams.set('klt', '1') // 1 分钟精度（专业蜡烛）
    url.searchParams.set('fqt', '0') // 不复权，与日K（Tushare daily fqt=0）口径一致
    url.searchParams.set('beg', targetDate)
    url.searchParams.set('end', targetDate)
    url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57')
    url.searchParams.set('lmt', '300')
    url.searchParams.set('_', String(Date.now()))

    const res = await fetch(url.toString())
    const json = (await res.json()) as EastmoneyKlineResponse
    if (json.rc !== 0 || !json.data?.klines || json.data.klines.length === 0) return []

    const bars: EastmoneyMinuteBar[] = []
    for (const kline of json.data.klines) {
      // 格式：'YYYY-MM-DD HH:mm,open,close,high,low,volume,amount'（f51..f57）
      const parts = kline.split(',')
      if (parts.length < 7) continue
      const dt = parts[0]
      const sp = dt.indexOf(' ')
      if (sp < 0) continue
      const ymd = dt.slice(0, sp).replace(/-/g, '')
      const hm = dt.slice(sp + 1, sp + 6) // HH:mm
      const open = parseFloat(parts[1])
      const close = parseFloat(parts[2])
      const high = parseFloat(parts[3])
      const low = parseFloat(parts[4])
      const vol = parseFloat(parts[5])
      const amountYuan = parseFloat(parts[6])
      if (!hm || isNaN(close)) continue
      bars.push({
        tradeDate: ymd,
        tsMinute: hm,
        open: isNaN(open) ? null : open,
        high: isNaN(high) ? null : high,
        low: isNaN(low) ? null : low,
        close,
        vol: isNaN(vol) ? null : vol,
        amount: isNaN(amountYuan) ? null : amountYuan / 1000 // 元 → 千元
      })
    }
    return bars
  } catch {
    return []
  }
}

/**
 * FR-093: Backfill today's missing daily row from intraday 5-min data.
 * Applies to both regular stocks and preset indices.
 */
export async function backfillTodayDailyFromIntradayIfMissing(
  db: Database.Database,
  stockCode: string
): Promise<boolean> {
  const { endDate } = bjDateRange()
  if (getCachedDates(db, stockCode).has(endDate)) return false

  const intradayItems = await fetchIntradayDataByDate(stockCode, endDate)
  const row = buildDailyRowFromIntraday(stockCode, endDate, intradayItems)
  if (!row) return false

  insertPrices(db, [row])
  return true
}

/**
 * FR-123: Fetch 1-minute K-line data for an A-share stock via Tushare 374 rt_min API.
 * Covers 09:25-15:00 (Beijing) including the auction window. Auto-includes 369 stk_auction.
 *
 * @param token  Decrypted Tushare API token (caller must decrypt before calling)
 * @param tsCode Tushare stock code with suffix, e.g. '600036.SH'
 * @param tradeDate Optional YYYYMMDD; if omitted, Tushare returns the latest trading day
 * @throws Error with descriptive message on any upstream failure (timeout, non-zero code, parse error)
 */
export async function fetchStockMinute(
  token: string,
  tsCode: string,
  _tradeDate?: string
): Promise<StockMinuteCacheRow[]> {
  const params: Record<string, string> = { ts_code: tsCode, freq: '1MIN' }
  // rt_min 为实时接口，不支持 trade_date 参数，始终返回当日数据

  let json: TushareResponse
  try {
    const res = await withRetry(() =>
      fetch(
        TUSHARE_API_URL,
        buildRequest(
          token,
          'rt_min',
          params,
          'ts_code,time,open,high,low,close,vol,amount'
        )
      )
    )
    json = (await res.json()) as TushareResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`fetchStockMinute(${tsCode}) network error: ${msg}`)
  }

  if (json.code !== 0 || !json.data) {
    throw new Error(`fetchStockMinute(${tsCode}) API error: ${json.msg || `code=${json.code}`}`)
  }

  const { fields, items } = json.data
  const idx = (n: string) => fields.indexOf(n)
  const stockCode = tsCode.split('.')[0]
  const nowMs = Date.now()
  const rows: StockMinuteCacheRow[] = []

  for (const it of items) {
    const tradeTime = String(it[idx('time')] ?? '')
    if (!tradeTime) continue
    // trade_time format: "YYYY-MM-DD HH:mm:ss"
    const [datePart, timePart] = tradeTime.split(' ')
    if (!datePart || !timePart) continue
    const tdNorm = datePart.replace(/-/g, '')
    const tmNorm = timePart.slice(0, 5) // HH:mm

    const toNum = (v: unknown): number | null => {
      if (v === null || v === undefined) return null
      const n = typeof v === 'number' ? v : parseFloat(String(v))
      return Number.isFinite(n) ? n : null
    }

    rows.push({
      stockCode,
      tradeDate: tdNorm,
      tsMinute: tmNorm,
      open: toNum(it[idx('open')]),
      high: toNum(it[idx('high')]),
      low: toNum(it[idx('low')]),
      close: toNum(it[idx('close')]),
      vol: toNum(it[idx('vol')]),
      amount: toNum(it[idx('amount')]),
      fetchedAt: nowMs
    })
  }

  return rows
}

// ──────────────────────────────────────────────────────────────────────
// FR-124 短线策略数据基础设施: 6 个新 Tushare 接口封装
// 全部要求 5000+ 积分（374 月度套餐覆盖）；积分不足统一抛 'TUSHARE_QUOTA_INSUFFICIENT'
// ──────────────────────────────────────────────────────────────────────

/** 通用辅助: number 解析（null/非有限值 → null） */
function parseNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

/** 通用辅助: 整数解析（null/非有限值 → null） */
function parseIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? Math.trunc(v) : parseInt(String(v), 10)
  return Number.isFinite(n) ? n : null
}

/** 通用辅助: 字符串解析（null → null，否则 String 转换） */
function parseStrOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s.length === 0 ? null : s
}

/** 通用辅助: 调用 Tushare API + 统一错误转换；积分不足抛 TUSHARE_QUOTA_INSUFFICIENT */
async function callTushareApi(
  token: string,
  apiName: string,
  params: Record<string, string>,
  fields: string
): Promise<TushareResponse> {
  let json: TushareResponse
  try {
    const res = await withRetry(() => fetch(TUSHARE_API_URL, buildRequest(token, apiName, params, fields)))
    json = (await res.json()) as TushareResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`${apiName} network error: ${msg}`)
  }
  if (json.code !== 0) {
    const msg = json.msg || `code=${json.code}`
    // 积分不足判定: Tushare 通常返回 "权限" / "积分" / "购买" 等关键字
    if (/权限|积分|购买|套餐|开通/.test(msg)) {
      throw new Error('TUSHARE_QUOTA_INSUFFICIENT')
    }
    throw new Error(`${apiName} API error: ${msg}`)
  }
  return json
}

/**
 * FR-124: 涨停/跌停股票每日明细（limit_list_d）
 * 字段: 涨跌停时间、封单金额、开板次数、连板数、上榜原因等
 */
export async function fetchLimitListDaily(
  token: string,
  tradeDate?: string
): Promise<LimitListDailyRow[]> {
  const params: Record<string, string> = {}
  if (tradeDate) params.trade_date = tradeDate
  const fields =
    'trade_date,ts_code,name,close,pct_chg,amount,float_mv,total_mv,turnover_ratio,fd_amount,first_time,last_time,open_times,up_stat,limit_times,limit'
  const json = await callTushareApi(token, 'limit_list_d', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const nowMs = Date.now()
  const rows: LimitListDailyRow[] = []
  for (const it of items) {
    const td = parseStrOrNull(it[idx('trade_date')])
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    if (!td || !tsCode) continue
    rows.push({
      tradeDate: td,
      tsCode,
      name: parseStrOrNull(it[idx('name')]),
      close: parseNumOrNull(it[idx('close')]),
      pctChg: parseNumOrNull(it[idx('pct_chg')]),
      amount: parseNumOrNull(it[idx('amount')]),
      floatMv: parseNumOrNull(it[idx('float_mv')]),
      totalMv: parseNumOrNull(it[idx('total_mv')]),
      turnoverRatio: parseNumOrNull(it[idx('turnover_ratio')]),
      fdAmount: parseNumOrNull(it[idx('fd_amount')]),
      firstTime: parseStrOrNull(it[idx('first_time')]),
      lastTime: parseStrOrNull(it[idx('last_time')]),
      openTimes: parseIntOrNull(it[idx('open_times')]),
      upStat: parseStrOrNull(it[idx('up_stat')]),
      limitTimes: parseIntOrNull(it[idx('limit_times')]),
      limit: parseStrOrNull(it[idx('limit')]),
      fetchedAt: nowMs
    })
  }
  return rows
}

/**
 * FR-124: 开盘啦榜单数据（kpl_list）
 * 返回个股维度竞价/涨停明细，包含竞价成交额、竞价换手率、板块题材、连板状态等
 * 次日 8:30 更新（盘后数据，适合每日 15:30 盘后 cron 入库）
 */
export async function fetchKplList(
  token: string,
  tradeDate?: string,
  tag?: string
): Promise<KplListRow[]> {
  const params: Record<string, string> = {}
  if (tradeDate) params.trade_date = tradeDate
  if (tag) params.tag = tag
  const fields =
    'trade_date,ts_code,name,lu_time,lu_desc,tag,theme,bid_amount,status,bid_turnover,bid_pct_chg,pct_chg'
  const json = await callTushareApi(token, 'kpl_list', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const nowMs = Date.now()
  const rows: KplListRow[] = []
  for (const it of items) {
    const td = parseStrOrNull(it[idx('trade_date')])
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    if (!td || !tsCode) continue
    rows.push({
      tradeDate: td,
      tsCode,
      name: parseStrOrNull(it[idx('name')]),
      luTime: parseStrOrNull(it[idx('lu_time')]),
      luDesc: parseStrOrNull(it[idx('lu_desc')]),
      tag: parseStrOrNull(it[idx('tag')]),
      theme: parseStrOrNull(it[idx('theme')]),
      bidAmount: parseNumOrNull(it[idx('bid_amount')]),
      status: parseStrOrNull(it[idx('status')]),
      bidTurnover: parseNumOrNull(it[idx('bid_turnover')]),
      bidPctChg: parseNumOrNull(it[idx('bid_pct_chg')]),
      pctChg: parseNumOrNull(it[idx('pct_chg')]),
      fetchedAt: nowMs
    })
  }
  return rows
}

/**
 * FR-125: 集合竞价实时快照（stk_auction）
 * 09:25~09:29 之间可获取当日全市场集合竞价数据，需开通股票分钟权限。
 * 接口默认 limit 通常 ≤ 5000，A 股全量约 5500 只，必须分页拉取才能覆盖深交所/创业板/北交所。
 * 单股查询（传 tsCode）不需要分页，直接单次请求。
 */
export async function fetchStkAuction(
  token: string,
  tradeDate?: string,
  tsCode?: string
): Promise<StkAuctionRow[]> {
  const fields =
    'ts_code,trade_date,vol,price,amount,pre_close,turnover_rate,volume_ratio,float_share'
  const nowMs = Date.now()
  const allRows: StkAuctionRow[] = []

  const parseItems = (fs: string[], items: unknown[][]) => {
    const idx = (n: string) => fs.indexOf(n)
    for (const it of items) {
      const tc = parseStrOrNull(it[idx('ts_code')])
      const td = parseStrOrNull(it[idx('trade_date')])
      if (!tc || !td) continue
      allRows.push({
        tsCode: tc,
        tradeDate: td,
        vol: parseIntOrNull(it[idx('vol')]),
        price: parseNumOrNull(it[idx('price')]),
        amount: parseNumOrNull(it[idx('amount')]),
        preClose: parseNumOrNull(it[idx('pre_close')]),
        turnoverRate: parseNumOrNull(it[idx('turnover_rate')]),
        volumeRatio: parseNumOrNull(it[idx('volume_ratio')]),
        floatShare: parseNumOrNull(it[idx('float_share')]),
        fetchedAt: nowMs,
      })
    }
  }

  // 单股查询：无需分页
  if (tsCode) {
    const params: Record<string, string> = { ts_code: tsCode }
    if (tradeDate) params.trade_date = tradeDate
    const json = await callTushareApi(token, 'stk_auction', params, fields)
    if (json.data) parseItems(json.data.fields, json.data.items)
    return allRows
  }

  // 全市场拉取：分页循环，每页 5000 条，直到返回数量 < limit 为止
  // 背景：A 股约 5500 只，按 ts_code 字母序 .SH 排在 .SZ 前，
  //       不分页时深交所/创业板/北交所股票会被截断，导致竞价数据缺失。
  const PAGE_SIZE = 5000
  let offset = 0
  while (true) {
    const params: Record<string, string> = { limit: String(PAGE_SIZE), offset: String(offset) }
    if (tradeDate) params.trade_date = tradeDate
    const json = await callTushareApi(token, 'stk_auction', params, fields)
    if (!json.data || json.data.items.length === 0) break
    parseItems(json.data.fields, json.data.items)
    if (json.data.items.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return allRows
}

/**
 * FR-124: 开盘啦概念成分股映射（kpl_concept_cons）
 * 全量拉取（无入参）适合周一 04:00 全量替换
 */
/**
 * 获取开盘啦概念题材成分股（kpl_concept_cons）
 * 接口字段：ts_code=题材ID（000111.KP），con_code=股票代码（600657.SH），name=题材名，con_name=股票名
 * 单次最多 3000 条，需按 offset 分页拉取全量数据。
 * tradeDate 必须传，否则接口返回空。
 */
export async function fetchKplConceptCons(
  token: string,
  tradeDate: string
): Promise<KplConceptMembersRow[]> {
  const fields = 'ts_code,name,con_name,con_code,trade_date,hot_num,desc'
  const allRows: KplConceptMembersRow[] = []
  const nowMs = Date.now()
  let offset = 0
  const limit = 3000

  // 分页循环直到返回行数 < limit（接口用 offset 翻页）
  while (true) {
    const json = await callTushareApi(
      token,
      'kpl_concept_cons',
      { trade_date: tradeDate, offset: String(offset), limit: String(limit) },
      fields
    )
    if (!json.data) break
    const { fields: fs, items } = json.data
    const idx = (n: string) => fs.indexOf(n)
    for (const it of items) {
      // ts_code=题材代码（000111.KP），con_code=股票代码（600657.SH）
      const tc = parseStrOrNull(it[idx('ts_code')])   // 题材代码
      const cc = parseStrOrNull(it[idx('con_code')])  // 股票代码
      if (!tc || !cc) continue
      allRows.push({
        conCode: cc,       // DB: con_code = 股票代码
        conName: parseStrOrNull(it[idx('con_name')]),  // 股票名称
        tsCode: tc,        // DB: ts_code = 题材代码
        name: parseStrOrNull(it[idx('name')]),         // 题材名称
        hotNum: parseIntOrNull(it[idx('hot_num')]),
        desc: parseStrOrNull(it[idx('desc')]),
        fetchedAt: nowMs
      })
    }
    if (items.length < limit) break  // 最后一页
    offset += limit
  }
  return allRows
}

/**
 * 按单只股票查询其历史概念归属（不传 trade_date，接口返回该股全量历史概念）
 * 用于补充查询"无题材"个股的题材数据。
 * conCode: 股票代码，格式 600657.SH（Tushare 标准格式）
 */
export async function fetchKplConceptConsByStock(
  token: string,
  conCode: string
): Promise<KplConceptMembersRow[]> {
  const fields = 'ts_code,name,con_name,con_code,hot_num,desc'
  const json = await callTushareApi(
    token,
    'kpl_concept_cons',
    { con_code: conCode },
    fields
  )
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const nowMs = Date.now()
  const rows: KplConceptMembersRow[] = []
  for (const it of items) {
    const tc = parseStrOrNull(it[idx('ts_code')])   // 题材代码
    const cc = parseStrOrNull(it[idx('con_code')])  // 股票代码
    if (!tc || !cc) continue
    rows.push({
      conCode: cc,
      conName: parseStrOrNull(it[idx('con_name')]),
      tsCode: tc,
      name: parseStrOrNull(it[idx('name')]),
      hotNum: parseIntOrNull(it[idx('hot_num')]),
      desc: parseStrOrNull(it[idx('desc')]),
      fetchedAt: nowMs
    })
  }
  return rows
}

/**
 * FR-124: 龙虎榜每日明细（top_list）
 */
export async function fetchTopList(
  token: string,
  tradeDate?: string
): Promise<TopListDailyRow[]> {
  const params: Record<string, string> = {}
  if (tradeDate) params.trade_date = tradeDate
  const fields =
    'trade_date,ts_code,name,close,pct_change,turnover_rate,amount,l_sell,l_buy,l_amount,net_amount,net_rate,amount_rate,float_values,reason'
  const json = await callTushareApi(token, 'top_list', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const nowMs = Date.now()
  const rows: TopListDailyRow[] = []
  for (const it of items) {
    const td = parseStrOrNull(it[idx('trade_date')])
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    if (!td || !tsCode) continue
    rows.push({
      tradeDate: td,
      tsCode,
      name: parseStrOrNull(it[idx('name')]),
      close: parseNumOrNull(it[idx('close')]),
      pctChange: parseNumOrNull(it[idx('pct_change')]),
      turnoverRate: parseNumOrNull(it[idx('turnover_rate')]),
      amount: parseNumOrNull(it[idx('amount')]),
      lSell: parseNumOrNull(it[idx('l_sell')]),
      lBuy: parseNumOrNull(it[idx('l_buy')]),
      lAmount: parseNumOrNull(it[idx('l_amount')]),
      netAmount: parseNumOrNull(it[idx('net_amount')]),
      netRate: parseNumOrNull(it[idx('net_rate')]),
      amountRate: parseNumOrNull(it[idx('amount_rate')]),
      floatValues: parseNumOrNull(it[idx('float_values')]),
      reason: parseStrOrNull(it[idx('reason')]),
      fetchedAt: nowMs
    })
  }
  return rows
}

/**
 * FR-124: 龙虎榜机构席位（top_inst）
 */
export async function fetchTopInst(
  token: string,
  tradeDate?: string
): Promise<TopInstDailyRow[]> {
  const params: Record<string, string> = {}
  if (tradeDate) params.trade_date = tradeDate
  const fields = 'trade_date,ts_code,exalter,side,buy,buy_rate,sell,sell_rate,net_buy,reason'
  const json = await callTushareApi(token, 'top_inst', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const nowMs = Date.now()
  const rows: TopInstDailyRow[] = []
  for (const it of items) {
    const td = parseStrOrNull(it[idx('trade_date')])
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    if (!td || !tsCode) continue
    rows.push({
      tradeDate: td,
      tsCode,
      exalter: parseStrOrNull(it[idx('exalter')]),
      side: parseIntOrNull(it[idx('side')]),
      buy: parseNumOrNull(it[idx('buy')]),
      buyRate: parseNumOrNull(it[idx('buy_rate')]),
      sell: parseNumOrNull(it[idx('sell')]),
      sellRate: parseNumOrNull(it[idx('sell_rate')]),
      netBuy: parseNumOrNull(it[idx('net_buy')]),
      reason: parseStrOrNull(it[idx('reason')]),
      fetchedAt: nowMs
    })
  }
  return rows
}

/**
 * FR-124: 个股资金流向（moneyflow）
 */
export async function fetchMoneyFlow(
  token: string,
  tsCode?: string,
  tradeDate?: string
): Promise<MoneyFlowDailyRow[]> {
  const params: Record<string, string> = {}
  if (tsCode) params.ts_code = tsCode
  if (tradeDate) params.trade_date = tradeDate
  const fields =
    'ts_code,trade_date,buy_sm_vol,buy_sm_amount,sell_sm_vol,sell_sm_amount,buy_md_vol,buy_md_amount,sell_md_vol,sell_md_amount,buy_lg_vol,buy_lg_amount,sell_lg_vol,sell_lg_amount,buy_elg_vol,buy_elg_amount,sell_elg_vol,sell_elg_amount,net_mf_vol,net_mf_amount'
  const json = await callTushareApi(token, 'moneyflow', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const nowMs = Date.now()
  const rows: MoneyFlowDailyRow[] = []
  for (const it of items) {
    const tc = parseStrOrNull(it[idx('ts_code')])
    const td = parseStrOrNull(it[idx('trade_date')])
    if (!tc || !td) continue
    rows.push({
      tsCode: tc,
      tradeDate: td,
      buySmVol: parseNumOrNull(it[idx('buy_sm_vol')]),
      buySmAmount: parseNumOrNull(it[idx('buy_sm_amount')]),
      sellSmVol: parseNumOrNull(it[idx('sell_sm_vol')]),
      sellSmAmount: parseNumOrNull(it[idx('sell_sm_amount')]),
      buyMdVol: parseNumOrNull(it[idx('buy_md_vol')]),
      buyMdAmount: parseNumOrNull(it[idx('buy_md_amount')]),
      sellMdVol: parseNumOrNull(it[idx('sell_md_vol')]),
      sellMdAmount: parseNumOrNull(it[idx('sell_md_amount')]),
      buyLgVol: parseNumOrNull(it[idx('buy_lg_vol')]),
      buyLgAmount: parseNumOrNull(it[idx('buy_lg_amount')]),
      sellLgVol: parseNumOrNull(it[idx('sell_lg_vol')]),
      sellLgAmount: parseNumOrNull(it[idx('sell_lg_amount')]),
      buyElgVol: parseNumOrNull(it[idx('buy_elg_vol')]),
      buyElgAmount: parseNumOrNull(it[idx('buy_elg_amount')]),
      sellElgVol: parseNumOrNull(it[idx('sell_elg_vol')]),
      sellElgAmount: parseNumOrNull(it[idx('sell_elg_amount')]),
      netMfVol: parseNumOrNull(it[idx('net_mf_vol')]),
      netMfAmount: parseNumOrNull(it[idx('net_mf_amount')]),
      fetchedAt: nowMs
    })
  }
  return rows
}

// ─── FR-126：A 股实时分钟-日累计（rt_min_daily，doc_id=369）───────────────────
// 与 FR-123 的 rt_min（374）区别：
//   - rt_min：单股实时订阅，增量拉取，支持 trade_date 参数，字段名 trade_time
//   - rt_min_daily：当日全量一次性拉取，无 trade_date 参数，字段名 time
// 适合 FR-126 尾盘半小时：每 60s 对候选股批量调用，按需拉取无需预先订阅
/**
 * 获取指定股票当日开盘以来所有分钟数据（一次性全量返回）。
 * 返回类型复用 StockMinuteCacheRow，tradeDate 由调用时北京时间今日推导。
 */
export async function fetchStockMinuteDaily(
  token: string,
  tsCode: string,
  freq: '1MIN' | '5MIN' | '15MIN' | '30MIN' | '60MIN' = '1MIN'
): Promise<StockMinuteCacheRow[]> {
  const json = await callTushareApi(
    token,
    'rt_min_daily',
    { ts_code: tsCode, freq },
    'ts_code,freq,time,open,close,high,low,vol,amount'
  )
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const stockCode = tsCode.split('.')[0]
  // rt_min_daily 只有当日数据，tradeDate 从北京时间今日推导（UTC+8）
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const tradeDate = bjNow.toISOString().slice(0, 10).replace(/-/g, '')
  const nowMs = Date.now()
  const rows: StockMinuteCacheRow[] = []
  for (const it of items) {
    const timeStr = parseStrOrNull(it[idx('time')])
    if (!timeStr) continue
    // time 字段格式：可能为 'HH:mm' 或 'YYYY-MM-DD HH:mm:ss'，统一截取 HH:mm
    const tsMinute = timeStr.includes(' ')
      ? timeStr.split(' ')[1].slice(0, 5)
      : timeStr.slice(0, 5)
    rows.push({
      stockCode,
      tradeDate,
      tsMinute,
      open: parseNumOrNull(it[idx('open')]),
      high: parseNumOrNull(it[idx('high')]),
      low: parseNumOrNull(it[idx('low')]),
      close: parseNumOrNull(it[idx('close')]),
      vol: parseNumOrNull(it[idx('vol')]),
      amount: parseNumOrNull(it[idx('amount')]),
      fetchedAt: nowMs
    })
  }
  return rows
}

// ──────────────────────────────────────────────────────────────────────
// FR-132 行业云图 Tushare 申万实时行情接口封装
// index_classify: 2000积分；rt_sw_k: 申万实时行情月度订阅（200元/月）；
// index_member_all: 2000积分
// ──────────────────────────────────────────────────────────────────────

export interface SwClassifyItem {
  indexCode: string    // 指数代码，如 801010.SI（与 rt_sw_k ts_code 匹配用）
  industryCode: string // 行业分类代码，如 110000（index_member_all l1_code 参数用）
  industryName: string // 行业名称，如 农林牧渔
  level: string        // 层级：L1/L2/L3
  parentCode: string | null // 父行业指数代码（L2/L3 时为父 L1/L2 的 index_code，L1 为 null）
}

export interface SwRealtimeItem {
  tsCode: string
  name: string
  tradeTime: string
  close: number | null
  preClose: number | null
  open: number | null
  high: number | null
  low: number | null
  amount: number | null
  pctChange: number | null
}

export interface SwMemberItem {
  tsCode: string
  name: string
}

/**
 * FR-132: 申万行业分类（index_classify）
 * doc_id=181，2000积分，(level='L1', src='SW2021') 返回 31 个 L1 行业
 */
export async function fetchSwClassify(
  token: string,
  level: string = 'L1',
  src: string = 'SW2021'
): Promise<SwClassifyItem[]> {
  const json = await callTushareApi(
    token,
    'index_classify',
    { level, src },
    'index_code,industry_name,level,industry_code,src,parent_code'
  )
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: SwClassifyItem[] = []
  for (const it of items) {
    const indexCode = parseStrOrNull(it[idx('index_code')])
    const industryCode = parseStrOrNull(it[idx('industry_code')]) ?? ''
    const industryName = parseStrOrNull(it[idx('industry_name')])
    const lv = parseStrOrNull(it[idx('level')])
    const parentCode = parseStrOrNull(it[idx('parent_code')])
    if (!indexCode || !industryName) continue
    results.push({ indexCode, industryCode, industryName, level: lv ?? level, parentCode })
  }
  return results
}

/**
 * FR-132: 申万实时行情（rt_sw_k）
 * doc_id=417，需「申万实时行情」月度订阅（200元/月）
 * 无参数调用返回全部申万指数实时截面（L1/L2/综合指数混合，需配合 index_classify 过滤 L1）
 */
export async function fetchSwRealtime(token: string): Promise<SwRealtimeItem[]> {
  const json = await callTushareApi(
    token,
    'rt_sw_k',
    {},
    'ts_code,name,trade_time,close,pre_close,high,open,low,vol,amount,pct_change'
  )
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: SwRealtimeItem[] = []
  for (const it of items) {
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    const name = parseStrOrNull(it[idx('name')])?.trim() ?? null
    if (!tsCode || !name) continue
    results.push({
      tsCode,
      name,
      tradeTime: parseStrOrNull(it[idx('trade_time')]) ?? '',
      close: parseNumOrNull(it[idx('close')]),
      preClose: parseNumOrNull(it[idx('pre_close')]),
      open: parseNumOrNull(it[idx('open')]),
      high: parseNumOrNull(it[idx('high')]),
      low: parseNumOrNull(it[idx('low')]),
      amount: parseNumOrNull(it[idx('amount')]),
      pctChange: parseNumOrNull(it[idx('pct_change')])
    })
  }
  return results
}

/**
 * FR-132: 申万行业成分（index_member_all）
 * doc_id=335，2000积分
 * 返回指定 L1 行业下的当前全部成分股（ts_code + name）
 */
export async function fetchSwMembers(
  token: string,
  l1Code: string,
  l2Code?: string
): Promise<SwMemberItem[]> {
  const params: Record<string, string> = { l1_code: l1Code, is_new: 'Y' }
  if (l2Code) params.l2_code = l2Code
  const json = await callTushareApi(
    token,
    'index_member_all',
    params,
    'ts_code,name,l1_name'
  )
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: SwMemberItem[] = []
  for (const it of items) {
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    const name = parseStrOrNull(it[idx('name')])
    if (!tsCode || !name) continue
    results.push({ tsCode, name })
  }
  return results
}

/**
 * FR-133: 全市场 A 股实时日线快照（rt_k，doc_id=372）
 * 用于盘中实时涨停监控及行业云图成分股行情补充
 * 单次上限 6000 条，全市场约 5000+ 只；分 4 批并发拉取后合并，每批不超过 2000 条
 * 涨跌幅客户端计算：pctChg = (close - preClose) / preClose * 100
 */
export interface RtKRow {
  tsCode: string
  name: string | null
  preClose: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  vol: number | null
  amount: number | null
  bidPrice1: number | null
  bidVolume1: number | null
  tradeTime: string | null
}

/** 将单批 rt_k 响应解析为 RtKRow 数组 */
function parseRtKBatch(json: Awaited<ReturnType<typeof callTushareApi>>): RtKRow[] {
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: RtKRow[] = []
  for (const it of items) {
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    if (!tsCode) continue
    results.push({
      tsCode,
      name: parseStrOrNull(it[idx('name')]),
      preClose: parseNumOrNull(it[idx('pre_close')]),
      open: parseNumOrNull(it[idx('open')]),
      high: parseNumOrNull(it[idx('high')]),
      low: parseNumOrNull(it[idx('low')]),
      close: parseNumOrNull(it[idx('close')]),
      vol: parseNumOrNull(it[idx('vol')]),
      amount: parseNumOrNull(it[idx('amount')]),
      bidPrice1: parseNumOrNull(it[idx('bid_price1')]),
      bidVolume1: parseNumOrNull(it[idx('bid_volume1')]),
      tradeTime: parseStrOrNull(it[idx('trade_time')]),
    })
  }
  return results
}

export async function fetchRtK(token: string): Promise<RtKRow[]> {
  // 全市场约 5000+ 只，单次限 6000 条但实测通配符超限报 50101；
  // 拆成 4 批并发：沪主板(~1600) / 深主板+创业板(~2500) / 科创板(~600) / 北交所(~250)
  const FIELDS = 'ts_code,name,pre_close,open,high,low,close,vol,amount,bid_price1,bid_volume1,trade_time'
  const batches = ['6*.SH', '0*.SZ,3*.SZ', '688*.SH', '9*.BJ']
  const settled = await Promise.allSettled(
    batches.map(ts_code => callTushareApi(token, 'rt_k', { ts_code }, FIELDS))
  )
  const results: RtKRow[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled') {
      results.push(...parseRtKBatch(r.value))
    }
    // 单批失败静默跳过，不影响其他批次
  }
  return results
}


// ===== FR-134 / FR-139: 日线 OHLCV =====

export interface DailyRow {
  tsCode: string
  tradeDate: string
  // FR-139 新增：蜡烛图所需 OHLCV；旧缓存行（仅由 fetchDailyForCandidates 写入）可能为 null
  open: number | null
  high: number | null
  low: number | null
  close: number
  pctChg: number
  // FR-151a 新增：成交量（手），用于量能信号和换手率计算
  vol: number | null
  // FR-152a 新增：换手率（%），主口径来自 daily_basic.turnover_rate
  turnoverRate: number | null
  /**
   * 成交额（千元）；仅 fetchDailyByDate 返回此字段；fetchDailyForCandidates 不含此字段。
   * 补录板块资金流向时需 ×1000 换算为元。
   */
  amount?: number | null
}

export interface DailyBasicRow {
  tsCode: string
  tradeDate: string
  turnoverRate: number | null
  floatShare: number | null
}

export interface AdjustmentFactorRow {
  tsCode: string
  tradeDate: string
  adjFactor: number
}

export interface SecurityValuationDailyApiRow {
  tsCode: string
  tradeDate: string
  totalShare: number | null
  floatShare: number | null
  totalMv: number | null
  circMv: number | null
  peTtm: number | null
  pb: number | null
  psTtm: number | null
  dvTtm: number | null
}

/**
 * FR-134: 按候选股列表批量拉取日线数据（api_name=daily）。
 * 一次请求以逗号分隔所有 tsCode，传 start_date 窗口，避免逐只调用。
 * 调用本身不消耗积分，但根据积分等级有访问频率限制；5000 积分以上频率上限极高，日常使用几乎无限制。
 * 用于计算近 N 个交易日累计涨跌和均线位置，以及 hover 微缩 K 线按需补拉。
 */
export async function fetchDailyForCandidates(
  token: string,
  tsCodes: string[],
  startDate: string,
  endDate?: string
): Promise<DailyRow[]> {
  if (tsCodes.length === 0) return []
  const fields = 'ts_code,trade_date,open,high,low,close,pct_chg,vol'
  const results: DailyRow[] = []

  const uniqueCodes = [...new Set(tsCodes)]
  for (const tsCode of uniqueCodes) {
    const params: Record<string, string> = {
      ts_code: tsCode,
      start_date: startDate,
    }
    if (endDate) params.end_date = endDate
    const json = await callTushareApi(token, 'daily', params, fields)
    if (!json.data) continue
    const { fields: fs, items } = json.data
    const idx = (n: string) => fs.indexOf(n)
    for (const it of items) {
      const tsCode = parseStrOrNull(it[idx('ts_code')])
      const tradeDate = parseStrOrNull(it[idx('trade_date')])
      const open = parseNumOrNull(it[idx('open')])
      const high = parseNumOrNull(it[idx('high')])
      const low = parseNumOrNull(it[idx('low')])
      const close = parseNumOrNull(it[idx('close')])
      const pctChg = parseNumOrNull(it[idx('pct_chg')])
      const vol = parseNumOrNull(it[idx('vol')])
      if (!tsCode || !tradeDate || close == null || pctChg == null) continue
      results.push({ tsCode, tradeDate, open, high, low, close, pctChg, vol, turnoverRate: null })
    }
  }
  return results
}

/**
 * FR-139: 按交易日拉取全市场 OHLCV（api_name=daily，不传 ts_code）。
 * 约返回 4700-5000 行，覆盖当日全 A 股。
 * 用于 18:00 统一盘后批次全量写入 daily_close_cache，为 hover 微缩蜡烛图提供数据。
 */
export async function fetchDailyByDate(
  token: string,
  tradeDate: string
): Promise<DailyRow[]> {
  const params: Record<string, string> = {
    trade_date: tradeDate,
    limit: '8000',
  }
  const fields = 'ts_code,trade_date,open,high,low,close,pct_chg,vol,amount'
  const json = await callTushareApi(token, 'daily', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: DailyRow[] = []
  for (const it of items) {
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    const tradeDate_ = parseStrOrNull(it[idx('trade_date')])
    const open = parseNumOrNull(it[idx('open')])
    const high = parseNumOrNull(it[idx('high')])
    const low = parseNumOrNull(it[idx('low')])
    const close = parseNumOrNull(it[idx('close')])
    const pctChg = parseNumOrNull(it[idx('pct_chg')])
    const vol = parseNumOrNull(it[idx('vol')])
    const amount = parseNumOrNull(it[idx('amount')])
    if (!tsCode || !tradeDate_ || close == null || pctChg == null) continue
    results.push({ tsCode, tradeDate: tradeDate_, open, high, low, close, pctChg, vol, turnoverRate: null, amount })
  }
  return results
}

/**
 * FR-152a: 按交易日拉取全市场换手率（daily_basic.turnover_rate）。
 */
export async function fetchDailyBasicByDate(
  token: string,
  tradeDate: string
): Promise<DailyBasicRow[]> {
  const params: Record<string, string> = {
    trade_date: tradeDate,
    limit: '8000',
  }
  const fields = 'ts_code,trade_date,turnover_rate,float_share'
  const json = await callTushareApi(token, 'daily_basic', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: DailyBasicRow[] = []
  for (const it of items) {
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    const tradeDate_ = parseStrOrNull(it[idx('trade_date')])
    const turnoverRate = parseNumOrNull(it[idx('turnover_rate')])
    const floatShare = parseNumOrNull(it[idx('float_share')])
    if (!tsCode || !tradeDate_) continue
    results.push({ tsCode, tradeDate: tradeDate_, turnoverRate, floatShare })
  }
  return results
}

/** 按单只股票和日期范围读取历史换手率，用于显式个股刷新。 */
export async function fetchDailyBasicForStock(
  token: string,
  tsCode: string,
  startDate: string,
  endDate?: string,
): Promise<DailyBasicRow[]> {
  const params: Record<string, string> = {
    ts_code: tsCode,
    start_date: startDate,
    limit: '8000',
  }
  if (endDate) params.end_date = endDate
  const fields = 'ts_code,trade_date,turnover_rate,float_share'
  const json = await callTushareApi(token, 'daily_basic', params, fields)
  if (!json.data) return []
  const { fields: responseFields, items } = json.data
  const idx = (name: string) => responseFields.indexOf(name)
  const results: DailyBasicRow[] = []
  for (const item of items) {
    const returnedTsCode = parseStrOrNull(item[idx('ts_code')])
    const tradeDate = parseStrOrNull(item[idx('trade_date')])
    if (!returnedTsCode || !tradeDate) continue
    results.push({
      tsCode: returnedTsCode,
      tradeDate,
      turnoverRate: parseNumOrNull(item[idx('turnover_rate')]),
      floatShare: parseNumOrNull(item[idx('float_share')]),
    })
  }
  return results
}

/** 按所选证券显式读取复权因子历史。 */
export async function fetchAdjustmentFactorHistory(
  token: string,
  tsCode: string,
  startDate: string,
  endDate?: string,
): Promise<AdjustmentFactorRow[]> {
  const params: Record<string, string> = { ts_code: tsCode, start_date: startDate }
  if (endDate) params.end_date = endDate
  const json = await callTushareApi(token, 'adj_factor', params, 'ts_code,trade_date,adj_factor')
  if (!json.data) return []
  const { fields, items } = json.data
  const index = (name: string) => fields.indexOf(name)
  const rows: AdjustmentFactorRow[] = []
  for (const item of items) {
    const code = parseStrOrNull(item[index('ts_code')])
    const tradeDate = parseStrOrNull(item[index('trade_date')])
    const adjFactor = parseNumOrNull(item[index('adj_factor')])
    if (!code || !tradeDate || adjFactor == null || adjFactor <= 0) continue
    rows.push({ tsCode: code, tradeDate, adjFactor })
  }
  return rows.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
}

/** 按所选证券显式读取点时估值与股本历史，Tushare单位保持原样（万股/万元）。 */
export async function fetchSecurityValuationDailyHistory(
  token: string,
  tsCode: string,
  startDate: string,
  endDate?: string,
): Promise<SecurityValuationDailyApiRow[]> {
  const params: Record<string, string> = { ts_code: tsCode, start_date: startDate }
  if (endDate) params.end_date = endDate
  const fields = 'ts_code,trade_date,total_share,float_share,total_mv,circ_mv,pe_ttm,pb,ps_ttm,dv_ttm'
  const json = await callTushareApi(token, 'daily_basic', params, fields)
  if (!json.data) return []
  const index = (name: string) => json.data!.fields.indexOf(name)
  const rows: SecurityValuationDailyApiRow[] = []
  for (const item of json.data.items) {
    const code = parseStrOrNull(item[index('ts_code')])
    const tradeDate = parseStrOrNull(item[index('trade_date')])
    if (!code || !tradeDate) continue
    rows.push({
      tsCode: code,
      tradeDate,
      totalShare: parseNumOrNull(item[index('total_share')]),
      floatShare: parseNumOrNull(item[index('float_share')]),
      totalMv: parseNumOrNull(item[index('total_mv')]),
      circMv: parseNumOrNull(item[index('circ_mv')]),
      peTtm: parseNumOrNull(item[index('pe_ttm')]),
      pb: parseNumOrNull(item[index('pb')]),
      psTtm: parseNumOrNull(item[index('ps_ttm')]),
      dvTtm: parseNumOrNull(item[index('dv_ttm')]),
    })
  }
  return rows.sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
}

// ── FR-259 index_global 全球指数日线接口 ──────────────────────────────

export interface TushareGlobalIndexDailyRow {
  tsCode: string
  tradeDate: string
  open: number | null
  close: number
  high: number | null
  low: number | null
  previousClose: number
  changePercent: number
}

export async function fetchGlobalIndexDaily(
  token: string,
  startDate: string,
  endDate: string,
): Promise<TushareGlobalIndexDailyRow[]> {
  const fields = 'ts_code,trade_date,open,close,high,low,pre_close,pct_chg'
  const json = await callTushareApi(token, 'index_global', {
    start_date: startDate,
    end_date: endDate,
  }, fields)
  if (!json.data) return []
  const positions = Object.fromEntries(json.data.fields.map((field, index) => [field, index]))
  return json.data.items.flatMap((item): TushareGlobalIndexDailyRow[] => {
    const tsCode = parseStrOrNull(item[positions.ts_code])
    const tradeDate = parseStrOrNull(item[positions.trade_date])
    const close = parseNumOrNull(item[positions.close])
    const previousClose = parseNumOrNull(item[positions.pre_close])
    const changePercent = parseNumOrNull(item[positions.pct_chg])
    if (
      !tsCode
      || !tradeDate
      || !/^\d{8}$/.test(tradeDate)
      || close === null
      || previousClose === null
      || previousClose <= 0
      || changePercent === null
    ) return []
    return [{
      tsCode,
      tradeDate,
      open: parseNumOrNull(item[positions.open]),
      close,
      high: parseNumOrNull(item[positions.high]),
      low: parseNumOrNull(item[positions.low]),
      previousClose,
      changePercent,
    }]
  }).sort((left, right) => left.tradeDate.localeCompare(right.tradeDate) || left.tsCode.localeCompare(right.tsCode))
}

// ── FR-163 index_daily 基准指数日线接口 ───────────────────────────────

/**
 * 批量拉取基准指数的日线收盘价（api_name='index_daily'）。
 * Tushare daily 接口仅支持个股，指数需使用此专用接口。
 * 每个指数单独调用（index_daily 一次只接受一个 ts_code），失败静默 warn 继续。
 *
 * @param token      Tushare API token
 * @param indexCodes 指数 tsCode 列表，如 ['000001.SH', '399006.SZ']
 * @param startDate  查询起始日期（YYYYMMDD）
 * @param endDate    查询结束日期（YYYYMMDD，可选）
 */
export async function fetchIndexDailyForCodes(
  token: string,
  indexCodes: string[],
  startDate: string,
  endDate?: string
): Promise<DailyRow[]> {
  if (indexCodes.length === 0) return []
  const results: DailyRow[] = []
  for (const tsCode of indexCodes) {
    try {
      const params: Record<string, string> = { ts_code: tsCode, start_date: startDate }
      if (endDate) params.end_date = endDate
      const fields = 'ts_code,trade_date,open,high,low,close,pct_chg'
      const json = await callTushareApi(token, 'index_daily', params, fields)
      if (!json.data) continue
      const { fields: fs, items } = json.data
      const idx = (n: string) => fs.indexOf(n)
      for (const it of items) {
        const code = parseStrOrNull(it[idx('ts_code')])
        const date = parseStrOrNull(it[idx('trade_date')])
        const close = parseNumOrNull(it[idx('close')])
        if (!code || !date || close == null) continue
        results.push({
          tsCode: code,
          tradeDate: date,
          open: parseNumOrNull(it[idx('open')]),
          high: parseNumOrNull(it[idx('high')]),
          low: parseNumOrNull(it[idx('low')]),
          close,
          pctChg: parseNumOrNull(it[idx('pct_chg')]) ?? 0,
          vol: null,
          turnoverRate: null,
        })
      }
    } catch (err) {
      console.warn(`[fetchIndexDailyForCodes] 拉取 ${tsCode} 失败:`, err)
    }
  }
  return results
}

// ── FR-142 cyq_chips 筹码分布接口 ─────────────────────────────────

export interface CyqChipsRow {
  tsCode: string
  tradeDate: string
  price: number
  percent: number
}

export async function fetchCyqChips(
  token: string,
  tsCode: string,
  tradeDate?: string
): Promise<CyqChipsRow[]> {
  const params: Record<string, string> = { ts_code: tsCode }
  if (tradeDate) params['trade_date'] = tradeDate
  const fields = 'ts_code,trade_date,price,percent'
  const json = await callTushareApi(token, 'cyq_chips', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: CyqChipsRow[] = []
  for (const it of items) {
    const code = parseStrOrNull(it[idx('ts_code')])
    const date = parseStrOrNull(it[idx('trade_date')])
    const price = parseNumOrNull(it[idx('price')])
    const percent = parseNumOrNull(it[idx('percent')])
    if (!code || !date || price == null || !isFinite(price) || percent == null || !isFinite(percent)) continue
    results.push({ tsCode: code, tradeDate: date, price, percent })
  }
  // 按价格升序返回
  results.sort((a, b) => a.price - b.price)
  return results
}

// ── FR-228 P1 cyq_perf 每日筹码成本与获利比例 ──────────────────────

export interface CyqPerfRow {
  tsCode: string
  tradeDate: string
  hisLow: number | null
  hisHigh: number | null
  cost5Pct: number | null
  cost15Pct: number | null
  cost50Pct: number | null
  cost85Pct: number | null
  cost95Pct: number | null
  weightAvg: number | null
  winnerRate: number | null
}

export async function fetchCyqPerf(
  token: string,
  tsCode: string,
  tradeDate?: string,
  startDate?: string,
  endDate?: string,
): Promise<CyqPerfRow[]> {
  const params: Record<string, string> = { ts_code: tsCode }
  if (tradeDate) params.trade_date = tradeDate
  if (startDate) params.start_date = startDate
  if (endDate) params.end_date = endDate
  const fields = [
    'ts_code',
    'trade_date',
    'his_low',
    'his_high',
    'cost_5pct',
    'cost_15pct',
    'cost_50pct',
    'cost_85pct',
    'cost_95pct',
    'weight_avg',
    'winner_rate',
  ].join(',')
  const json = await callTushareApi(token, 'cyq_perf', params, fields)
  if (!json.data) return []
  const { fields: responseFields, items } = json.data
  const idx = (name: string) => responseFields.indexOf(name)
  const results: CyqPerfRow[] = []
  for (const item of items) {
    const code = parseStrOrNull(item[idx('ts_code')])
    const date = parseStrOrNull(item[idx('trade_date')])
    if (!code || !date) continue
    results.push({
      tsCode: code,
      tradeDate: date,
      hisLow: parseNumOrNull(item[idx('his_low')]),
      hisHigh: parseNumOrNull(item[idx('his_high')]),
      cost5Pct: parseNumOrNull(item[idx('cost_5pct')]),
      cost15Pct: parseNumOrNull(item[idx('cost_15pct')]),
      cost50Pct: parseNumOrNull(item[idx('cost_50pct')]),
      cost85Pct: parseNumOrNull(item[idx('cost_85pct')]),
      cost95Pct: parseNumOrNull(item[idx('cost_95pct')]),
      weightAvg: parseNumOrNull(item[idx('weight_avg')]),
      winnerRate: parseNumOrNull(item[idx('winner_rate')]),
    })
  }
  results.sort((left, right) => right.tradeDate.localeCompare(left.tradeDate))
  return results
}

// ── FR-143 stk_factor_pro 技术因子接口（精选字段）────────────────────

export interface StkFactorRow {
  tsCode: string
  tradeDate: string
  close: number | null
  macdBfq: number | null
  macdDifBfq: number | null
  macdDeaBfq: number | null
  kdjKBfq: number | null
  kdjDBfq: number | null
  kdjBfq: number | null
  rsiBfq6: number | null
  rsiBfq12: number | null
  bollUpperBfq: number | null
  bollMidBfq: number | null
  bollLowerBfq: number | null
  maBfq5: number | null
  maBfq10: number | null
  maBfq20: number | null
  maBfq60: number | null
  turnoverRate: number | null
  volumeRatio: number | null
  updays: number | null
  downdays: number | null
}

export async function fetchStkFactorPro(
  token: string,
  tsCode: string,
  tradeDate?: string
): Promise<StkFactorRow | null> {
  const params: Record<string, string> = { ts_code: tsCode }
  if (tradeDate) params['trade_date'] = tradeDate
  const fields = [
    'ts_code', 'trade_date', 'close',
    'macd_bfq', 'macd_dif_bfq', 'macd_dea_bfq',
    'kdj_k_bfq', 'kdj_d_bfq', 'kdj_bfq',
    'rsi_bfq_6', 'rsi_bfq_12',
    'boll_upper_bfq', 'boll_mid_bfq', 'boll_lower_bfq',
    'ma_bfq_5', 'ma_bfq_10', 'ma_bfq_20', 'ma_bfq_60',
    'turnover_rate', 'volume_ratio', 'updays', 'downdays'
  ].join(',')
  const json = await callTushareApi(token, 'stk_factor_pro', params, fields)
  if (!json.data || !json.data.items || json.data.items.length === 0) return null
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  // 取最新一条（按接口默认降序）
  const it = items[0]
  const code = parseStrOrNull(it[idx('ts_code')])
  const date = parseStrOrNull(it[idx('trade_date')])
  if (!code || !date) return null
  return {
    tsCode: code,
    tradeDate: date,
    close: parseNumOrNull(it[idx('close')]),
    macdBfq: parseNumOrNull(it[idx('macd_bfq')]),
    macdDifBfq: parseNumOrNull(it[idx('macd_dif_bfq')]),
    macdDeaBfq: parseNumOrNull(it[idx('macd_dea_bfq')]),
    kdjKBfq: parseNumOrNull(it[idx('kdj_k_bfq')]),
    kdjDBfq: parseNumOrNull(it[idx('kdj_d_bfq')]),
    kdjBfq: parseNumOrNull(it[idx('kdj_bfq')]),
    rsiBfq6: parseNumOrNull(it[idx('rsi_bfq_6')]),
    rsiBfq12: parseNumOrNull(it[idx('rsi_bfq_12')]),
    bollUpperBfq: parseNumOrNull(it[idx('boll_upper_bfq')]),
    bollMidBfq: parseNumOrNull(it[idx('boll_mid_bfq')]),
    bollLowerBfq: parseNumOrNull(it[idx('boll_lower_bfq')]),
    maBfq5: parseNumOrNull(it[idx('ma_bfq_5')]),
    maBfq10: parseNumOrNull(it[idx('ma_bfq_10')]),
    maBfq20: parseNumOrNull(it[idx('ma_bfq_20')]),
    maBfq60: parseNumOrNull(it[idx('ma_bfq_60')]),
    turnoverRate: parseNumOrNull(it[idx('turnover_rate')]),
    volumeRatio: parseNumOrNull(it[idx('volume_ratio')]),
    updays: parseNumOrNull(it[idx('updays')]),
    downdays: parseNumOrNull(it[idx('downdays')]),
  }
}

/** 批量拉取某只股票从 startDate 起的技术因子历史，返回升序数组（最多约 90 条） */
export async function fetchStkFactorProHistory(
  token: string,
  tsCode: string,
  startDate: string,   // YYYYMMDD
  endDate?: string     // YYYYMMDD，缺省不传（Tushare 默认取最新）
): Promise<StkFactorRow[]> {
  const params: Record<string, string> = { ts_code: tsCode, start_date: startDate }
  if (endDate) params['end_date'] = endDate
  const fields = [
    'ts_code', 'trade_date', 'close',
    'macd_bfq', 'macd_dif_bfq', 'macd_dea_bfq',
    'kdj_k_bfq', 'kdj_d_bfq', 'kdj_bfq',
    'rsi_bfq_6', 'rsi_bfq_12',
    'boll_upper_bfq', 'boll_mid_bfq', 'boll_lower_bfq',
    'ma_bfq_5', 'ma_bfq_10', 'ma_bfq_20', 'ma_bfq_60',
    'turnover_rate', 'volume_ratio', 'updays', 'downdays'
  ].join(',')
  const json = await callTushareApi(token, 'stk_factor_pro', params, fields)
  if (!json.data || !json.data.items || json.data.items.length === 0) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const rows: StkFactorRow[] = []
  for (const it of items as unknown[][]) {
    const code = parseStrOrNull(it[idx('ts_code')])
    const date = parseStrOrNull(it[idx('trade_date')])
    if (!code || !date) continue
    rows.push({
      tsCode: code,
      tradeDate: date,
      close: parseNumOrNull(it[idx('close')]),
      macdBfq: parseNumOrNull(it[idx('macd_bfq')]),
      macdDifBfq: parseNumOrNull(it[idx('macd_dif_bfq')]),
      macdDeaBfq: parseNumOrNull(it[idx('macd_dea_bfq')]),
      kdjKBfq: parseNumOrNull(it[idx('kdj_k_bfq')]),
      kdjDBfq: parseNumOrNull(it[idx('kdj_d_bfq')]),
      kdjBfq: parseNumOrNull(it[idx('kdj_bfq')]),
      rsiBfq6: parseNumOrNull(it[idx('rsi_bfq_6')]),
      rsiBfq12: parseNumOrNull(it[idx('rsi_bfq_12')]),
      bollUpperBfq: parseNumOrNull(it[idx('boll_upper_bfq')]),
      bollMidBfq: parseNumOrNull(it[idx('boll_mid_bfq')]),
      bollLowerBfq: parseNumOrNull(it[idx('boll_lower_bfq')]),
      maBfq5: parseNumOrNull(it[idx('ma_bfq_5')]),
      maBfq10: parseNumOrNull(it[idx('ma_bfq_10')]),
      maBfq20: parseNumOrNull(it[idx('ma_bfq_20')]),
      maBfq60: parseNumOrNull(it[idx('ma_bfq_60')]),
      turnoverRate: parseNumOrNull(it[idx('turnover_rate')]),
      volumeRatio: parseNumOrNull(it[idx('volume_ratio')]),
      updays: parseNumOrNull(it[idx('updays')]),
      downdays: parseNumOrNull(it[idx('downdays')]),
    })
  }
  // 接口默认降序，转为升序方便前端按日期索引
  return rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
}

// ── 交易日历 ──────────────────────────────────────────────────────────────────

export interface TradeCalFetchRow {
  /** 日历日期 YYYYMMDD */
  calDate: string
  /** 是否交易日：1=交易，0=休市 */
  isOpen: number
  /** 上一交易日 YYYYMMDD，可能为 null */
  pretradeDate: string | null
}

/**
 * 获取上交所交易日历（trade_cal）。
 * 用于判断调休补班日（如周六上班、周一休市）等非标准情况。
 * 需 2000 积分。
 */
export async function fetchTradeCal(
  token: string,
  exchange = 'SSE',
  startDate?: string,
  endDate?: string
): Promise<TradeCalFetchRow[]> {
  const params: Record<string, string> = { exchange }
  if (startDate) params.start_date = startDate
  if (endDate) params.end_date = endDate
  const json = await callTushareApi(token, 'trade_cal', params, 'cal_date,is_open,pretrade_date')
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  return items
    .map((it) => ({
      calDate: parseStrOrNull(it[idx('cal_date')]) ?? '',
      isOpen: parseIntOrNull(it[idx('is_open')]) ?? 0,
      pretradeDate: parseStrOrNull(it[idx('pretrade_date')]),
    }))
    .filter((r) => r.calDate.length === 8)
}

// ── FR-230: 单公司结构化财务接口 ─────────────────────────────────────────────

export interface TushareFinancialRow {
  tsCode: string
  annDate: string | null
  fAnnDate: string | null
  endDate: string
  reportType: string | null
  compType: string | null
  updateFlag: string | null
  values: Record<string, string | number | null>
}

interface FinancialApiSpec {
  apiName: string
  metadataFields: string[]
  fields: string[]
  numericFields: Set<string>
  textFields: Set<string>
}

async function fetchFinancialRows(
  token: string,
  tsCode: string,
  spec: FinancialApiSpec,
  extraParams: Record<string, string> = {},
): Promise<TushareFinancialRow[]> {
  const requestedFields = Array.from(new Set([
    ...spec.metadataFields,
    ...spec.fields,
  ]))
  const response = await callTushareApi(token, spec.apiName, {
    ts_code: tsCode,
    ...extraParams,
  }, requestedFields.join(','))
  if (!response.data) return []
  const { fields: responseFields, items } = response.data
  const indexOf = (field: string) => responseFields.indexOf(field)
  return items.flatMap((item) => {
    const rowTsCode = parseStrOrNull(item[indexOf('ts_code')])
    const endDate = parseStrOrNull(item[indexOf('end_date')])
    if (!rowTsCode || !endDate) return []
    const values: Record<string, string | number | null> = {}
    for (const field of spec.numericFields) {
      values[field] = parseNumOrNull(item[indexOf(field)])
    }
    for (const field of spec.textFields) {
      values[field] = parseStrOrNull(item[indexOf(field)])
    }
    return [{
      tsCode: rowTsCode,
      annDate: parseStrOrNull(item[indexOf('ann_date')]),
      fAnnDate: parseStrOrNull(item[indexOf('f_ann_date')]),
      endDate,
      reportType: parseStrOrNull(item[indexOf('report_type')]),
      compType: parseStrOrNull(item[indexOf('comp_type')]),
      updateFlag: parseStrOrNull(item[indexOf('update_flag')]),
      values,
    }]
  })
}

const INCOME_SPEC: FinancialApiSpec = {
  apiName: 'income',
  metadataFields: ['ts_code', 'ann_date', 'f_ann_date', 'end_date', 'report_type', 'comp_type', 'update_flag'],
  fields: [
    'total_revenue', 'revenue', 'operate_profit', 'total_profit',
    'n_income_attr_p', 'ebit', 'ebitda',
  ],
  numericFields: new Set([
    'total_revenue', 'revenue', 'operate_profit', 'total_profit',
    'n_income_attr_p', 'ebit', 'ebitda',
  ]),
  textFields: new Set(),
}

export async function fetchIncomeFinancialRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, INCOME_SPEC)
}

export async function fetchBalanceSheetFinancialRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'balancesheet',
    metadataFields: ['ts_code', 'ann_date', 'f_ann_date', 'end_date', 'report_type', 'comp_type', 'update_flag'],
    fields: [
      'accounts_receiv', 'notes_receiv', 'inventories', 'contract_assets',
      'total_assets', 'total_liab', 'total_hldr_eqy_exc_min_int',
    ],
    numericFields: new Set([
      'accounts_receiv', 'notes_receiv', 'inventories', 'contract_assets',
      'total_assets', 'total_liab', 'total_hldr_eqy_exc_min_int',
    ]),
    textFields: new Set(),
  })
}

export async function fetchCashflowFinancialRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'cashflow',
    metadataFields: ['ts_code', 'ann_date', 'f_ann_date', 'end_date', 'report_type', 'comp_type', 'update_flag'],
    fields: ['n_cashflow_act', 'n_cashflow_inv_act', 'n_cash_flows_fnc_act', 'c_pay_acq_const_fiolta'],
    numericFields: new Set(['n_cashflow_act', 'n_cashflow_inv_act', 'n_cash_flows_fnc_act', 'c_pay_acq_const_fiolta']),
    textFields: new Set(),
  })
}

export async function fetchFinancialIndicatorRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'fina_indicator',
    metadataFields: ['ts_code', 'ann_date', 'end_date', 'update_flag'],
    fields: [
      'roe', 'grossprofit_margin', 'netprofit_margin', 'ocf_to_or', 'profit_dedt',
      'q_sales_yoy', 'q_netprofit_yoy', 'q_gsprofit_margin',
    ],
    numericFields: new Set([
      'roe', 'grossprofit_margin', 'netprofit_margin', 'ocf_to_or', 'profit_dedt',
      'q_sales_yoy', 'q_netprofit_yoy', 'q_gsprofit_margin',
    ]),
    textFields: new Set(),
  })
}

export async function fetchFinancialAuditRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'fina_audit',
    metadataFields: ['ts_code', 'ann_date', 'end_date'],
    fields: ['audit_result', 'audit_fees', 'audit_agency', 'audit_sign'],
    numericFields: new Set(['audit_fees']),
    textFields: new Set(['audit_result', 'audit_agency', 'audit_sign']),
  })
}

export async function fetchFinancialForecastRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'forecast',
    metadataFields: ['ts_code', 'ann_date', 'end_date'],
    fields: [
      'type',
      'p_change_min',
      'p_change_max',
      'net_profit_min',
      'net_profit_max',
      'change_reason',
    ],
    numericFields: new Set([
      'p_change_min',
      'p_change_max',
      'net_profit_min',
      'net_profit_max',
    ]),
    textFields: new Set(['type', 'change_reason']),
  })
}

export async function fetchFinancialExpressRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'express',
    metadataFields: ['ts_code', 'ann_date', 'end_date'],
    fields: [
      'revenue',
      'n_income',
      'total_assets',
      'diluted_eps',
      'diluted_roe',
      'audit_result',
    ],
    numericFields: new Set([
      'revenue',
      'n_income',
      'total_assets',
      'diluted_eps',
      'diluted_roe',
    ]),
    textFields: new Set(['audit_result']),
  })
}

export async function fetchFinancialDisclosureDateRows(
  token: string,
  tsCode: string,
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'disclosure_date',
    metadataFields: ['ts_code', 'ann_date', 'end_date'],
    fields: ['pre_date', 'actual_date', 'modify_date'],
    numericFields: new Set(),
    textFields: new Set(['pre_date', 'actual_date', 'modify_date']),
  })
}

export async function fetchFinancialMainBusinessRows(
  token: string,
  tsCode: string,
  dimension: 'P' | 'D' = 'P',
): Promise<TushareFinancialRow[]> {
  return fetchFinancialRows(token, tsCode, {
    apiName: 'fina_mainbz',
    metadataFields: ['ts_code', 'end_date', 'update_flag'],
    fields: ['bz_item', 'bz_sales', 'bz_profit', 'bz_cost', 'curr_type'],
    numericFields: new Set(['bz_sales', 'bz_profit', 'bz_cost']),
    textFields: new Set(['bz_item', 'curr_type']),
  }, { type: dimension })
}

// ── FR-151a stock_basic 全量接口 ───────────────────────────────────────────────

export interface StockBasicRow {
  tsCode: string
  name: string | null
  industry: string | null
  market: string | null
  listStatus: string | null
  floatShare: number | null // 流通股本（万股）
}

/**
 * 拉取全市场股票基础信息（api_name=stock_basic）。
 * 仅请求上市中（list_status=L）的股票，约 5000 条。
 * 每周一 04:00 全量替换 stock_basic_cache 表。
 * 需 2000 积分。
 */
export async function fetchStockBasic(token: string): Promise<StockBasicRow[]> {
  const params: Record<string, string> = { list_status: 'L' }
  const fields = 'ts_code,name,industry,market,list_status'
  const json = await callTushareApi(token, 'stock_basic', params, fields)
  if (!json.data) return []
  const { fields: fs, items } = json.data
  const idx = (n: string) => fs.indexOf(n)
  const results: StockBasicRow[] = []
  for (const it of items) {
    const tsCode = parseStrOrNull(it[idx('ts_code')])
    if (!tsCode) continue
    results.push({
      tsCode,
      name: parseStrOrNull(it[idx('name')]),
      industry: parseStrOrNull(it[idx('industry')]),
      market: parseStrOrNull(it[idx('market')]),
      listStatus: parseStrOrNull(it[idx('list_status')]),
      floatShare: null,
    })
  }
  return results
}

// ── FR-153: 同花顺/东财题材数据接口 ────────────────────────────────────

/** 同花顺概念指数列表（ths_index，exchange='A', type='N'，6000积分） */
export interface ThsIndexItem {
  tsCode: string
  name: string | null
  count: number | null
}

/**
 * 拉取同花顺概念指数列表（A 股 N 类概念全量，支持分页）
 *
 * 接口：ths_index，exchange=A，type=N
 * 单次上限 5000 行，但实际 A 股概念约 300 条；保留分页循环以防接口侧变化。
 *
 * @param token  Tushare token
 * @returns 概念指数列表（全量，与 KPL 独立，切换源必须全量拉取）
 */
export async function fetchThsIndex(token: string): Promise<ThsIndexItem[]> {
  const PAGE_SIZE = 1000
  const all: ThsIndexItem[] = []
  let offset = 0

  while (true) {
    const resp = await callTushareApi(token, 'ths_index', {
      exchange: 'A',
      type: 'N',
      limit: String(PAGE_SIZE),
      offset: String(offset),
    }, 'ts_code,name,count')

    const fields = resp.data?.fields ?? []
    const items = resp.data?.items ?? []
    const idx = (f: string) => fields.indexOf(f)

    const parsed = items.map(it => ({
      tsCode: String(it[idx('ts_code')] ?? ''),
      name: parseStrOrNull(it[idx('name')]),
      count: parseIntOrNull(it[idx('count')]),
    })).filter(r => r.tsCode !== '')

    all.push(...parsed)
    console.log(`[fetchThsIndex] page offset=${offset}, got=${parsed.length}, total=${all.length}`)

    if (parsed.length < PAGE_SIZE) break  // 最后一页
    offset += PAGE_SIZE
  }

  return all
}

/** 同花顺概念成分股（ths_member，6000积分） */
export interface ThsMemberItem {
  tsCode: string   // 股票代码（含交易所后缀）
  conCode: string  // 概念代码
  conName: string | null // 概念名称
}

/**
 * 拉取指定概念的同花顺成分股列表
 * @param token   Tushare token
 * @param conCode 概念代码，如 'BK0001'
 * @returns 成分股列表
 */
export async function fetchThsMembers(token: string, conCode: string): Promise<ThsMemberItem[]> {
  const resp = await callTushareApi(token, 'ths_member', {
    ts_code: conCode,
  }, 'ts_code,con_code,name')

  const fields = resp.data?.fields ?? []
  const items = resp.data?.items ?? []
  const idx = (f: string) => fields.indexOf(f)

  // Tushare ths_member 接口的字段语义：
  //   ts_code  = 概念代码（如 885590.TI）
  //   con_code = 股票代码（如 603045.SH）
  //   name     = 成分股名称
  // 因此 tsCode（股票）← con_code，conCode（概念）← ts_code
  return items.map(it => ({
    tsCode: String(it[idx('con_code')] ?? ''),   // 股票代码
    conCode: String(it[idx('ts_code')] ?? ''),   // 概念代码
    conName: parseStrOrNull(it[idx('name')]),    // 占位，上层 scheduler 会替换为概念名
  })).filter(r => r.tsCode !== '' && r.conCode !== '')
}

/** 东方财富题材成分股（dc_concept_cons，6000积分） */
export interface DcConceptConsItem {
  tsCode: string
  tradeDate: string    // YYYYMMDD
  name: string | null
  themeCode: string
  themeName: string | null
  industryCode: string | null
  industry: string | null
}

/**
 * 拉取东方财富题材成分股（dc_concept_cons）
 * @param token      Tushare token
 * @param tradeDate  交易日 YYYYMMDD，不传则拉最新
 * @param tsCode     指定股票代码（可选），不传则拉全市场
 */
export async function fetchDcConceptCons(
  token: string,
  tradeDate?: string,
  tsCode?: string
): Promise<DcConceptConsItem[]> {
  const params: Record<string, string> = {}
  if (tradeDate) params['trade_date'] = tradeDate
  if (tsCode) params['ts_code'] = tsCode

  const resp = await callTushareApi(token, 'dc_concept_cons', params,
    'ts_code,trade_date,name,theme_code,theme_name,industry_code,industry')

  const fields = resp.data?.fields ?? []
  const items = resp.data?.items ?? []
  const idx = (f: string) => fields.indexOf(f)

  const results: DcConceptConsItem[] = []
  for (const it of items) {
    const tc = parseStrOrNull(it[idx('theme_code')])
    const td = parseStrOrNull(it[idx('trade_date')])
    const ts = parseStrOrNull(it[idx('ts_code')])
    if (!tc || !td || !ts) continue
    results.push({
      tsCode: ts,
      tradeDate: td,
      name: parseStrOrNull(it[idx('name')]),
      themeCode: tc,
      themeName: parseStrOrNull(it[idx('theme_name')]),
      industryCode: parseStrOrNull(it[idx('industry_code')]),
      industry: parseStrOrNull(it[idx('industry')]),
    })
  }
  return results
}
