import type Database from 'better-sqlite3'
import { getLastSettledCalendarDate } from './marketSettlementPolicy'

export const TREND_BENCHMARK_CODE = '000300.SH' as const

export type TrendBenchmarkFreshnessState = 'current' | 'stale' | 'missing' | 'insufficient' | 'calendar-unknown'
export type TrendBenchmarkCalendarSource = 'trade-calendar' | 'weekday-fallback'
export type TrendBenchmarkRefreshOutcome = 'not-requested' | 'not-needed' | 'updated' | 'unchanged' | 'failed' | 'deduplicated'
export type TrendBenchmarkErrorCode =
  | 'HTTP_ERROR'
  | 'UPSTREAM_ERROR'
  | 'EMPTY_RESPONSE'
  | 'NETWORK_ERROR'
  | 'EXPECTED_DATE_MISSING'
  | 'INSUFFICIENT_HISTORY'
  | 'CALENDAR_UNAVAILABLE'
  | null

export interface TrendBenchmarkHealth {
  tsCode: typeof TREND_BENCHMARK_CODE
  state: TrendBenchmarkFreshnessState
  latestTradeDate: string | null
  expectedTradeDate: string | null
  bars: number
  requiredBars: 21
  calendarSource: TrendBenchmarkCalendarSource
  refreshOutcome: TrendBenchmarkRefreshOutcome
  attempted: boolean
  rowsWritten: number
  errorCode: TrendBenchmarkErrorCode
  message: string
}

export function inspectTrendBenchmarkHealth(
  db: Database.Database,
  now = Date.now(),
): TrendBenchmarkHealth {
  const benchmark = getBenchmarkStats(db)
  const cutoffDate = getSettledCutoffDate(now)
  const expected = resolveExpectedTradeDate(db, cutoffDate)
  const state = deriveState(benchmark.latestTradeDate, benchmark.bars, expected.tradeDate, expected.source)
  const errorCode: TrendBenchmarkErrorCode = state === 'calendar-unknown'
      ? 'CALENDAR_UNAVAILABLE'
    : state === 'stale'
      ? 'EXPECTED_DATE_MISSING'
      : state === 'insufficient'
        ? 'INSUFFICIENT_HISTORY'
      : null

  return {
    tsCode: TREND_BENCHMARK_CODE,
    state,
    latestTradeDate: benchmark.latestTradeDate,
    expectedTradeDate: expected.tradeDate,
    bars: benchmark.bars,
    requiredBars: 21,
    calendarSource: expected.source,
    refreshOutcome: 'not-requested',
    attempted: false,
    rowsWritten: 0,
    errorCode,
    message: buildBenchmarkHealthMessage(state, benchmark.latestTradeDate, expected.tradeDate, expected.source, benchmark.bars),
  }
}

export function getSettledCutoffDate(now = Date.now()): string {
  return getLastSettledCalendarDate(now)
}

export function buildBenchmarkHealthMessage(
  state: TrendBenchmarkFreshnessState,
  latestTradeDate: string | null,
  expectedTradeDate: string | null,
  calendarSource: TrendBenchmarkCalendarSource,
  bars = 0,
): string {
  const latest = latestTradeDate ? displayDate(latestTradeDate) : '暂无数据'
  const expected = expectedTradeDate ? displayDate(expectedTradeDate) : '无法确定'
  const source = calendarSource === 'trade-calendar' ? '交易日历' : '工作日推断'
  if (state === 'current') return `沪深300基准截至 ${latest} · 应有 ${expected} · ${source}`
  if (state === 'stale') return `沪深300基准截至 ${latest}，缺少 ${expected} 已结算事实 · ${source}`
  if (state === 'missing') return `沪深300基准尚无有效日线 · 应有 ${expected} · ${source}`
  if (state === 'insufficient') return `沪深300基准截至 ${latest}，仅有 ${bars}/21 根有效日线 · ${source}`
  return `沪深300基准截至 ${latest} · 工作日推断应有 ${expected}，交易日历未覆盖，暂无法区分休市与数据缺口`
}

function resolveExpectedTradeDate(
  db: Database.Database,
  cutoffDate: string,
): { tradeDate: string | null; source: TrendBenchmarkCalendarSource } {
  if (tableExists(db, 'trade_cal')) {
    const coverage = db.prepare('SELECT MAX(cal_date) AS latest FROM trade_cal').get() as { latest: string | null }
    if (coverage.latest && coverage.latest >= cutoffDate) {
      const row = db.prepare(
        'SELECT MAX(cal_date) AS tradeDate FROM trade_cal WHERE is_open = 1 AND cal_date <= ?',
      ).get(cutoffDate) as { tradeDate: string | null }
      if (row.tradeDate) return { tradeDate: row.tradeDate, source: 'trade-calendar' }
    }
  }
  return { tradeDate: previousWeekday(cutoffDate), source: 'weekday-fallback' }
}

function deriveState(
  latestTradeDate: string | null,
  bars: number,
  expectedTradeDate: string | null,
  calendarSource: TrendBenchmarkCalendarSource,
): TrendBenchmarkFreshnessState {
  if (!latestTradeDate) return 'missing'
  if (!expectedTradeDate) return 'calendar-unknown'
  if (latestTradeDate < expectedTradeDate) return calendarSource === 'trade-calendar' ? 'stale' : 'calendar-unknown'
  return bars >= 21 ? 'current' : 'insufficient'
}

function getBenchmarkStats(db: Database.Database): { latestTradeDate: string | null; bars: number } {
  const row = db.prepare(
    'SELECT MAX(trade_date) AS tradeDate, COUNT(*) AS bars FROM daily_close_cache WHERE ts_code = ?',
  ).get(TREND_BENCHMARK_CODE) as { tradeDate: string | null; bars: number }
  return { latestTradeDate: row.tradeDate ?? null, bars: row.bars }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName) as { found: number } | undefined
  return row?.found === 1
}

function previousWeekday(value: string): string | null {
  if (!/^\d{8}$/.test(value)) return null
  const date = new Date(Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
  ))
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1)
  return formatYmd(date)
}

function formatYmd(value: Date): string {
  return `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, '0')}${String(value.getUTCDate()).padStart(2, '0')}`
}

function displayDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}
