import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getLatestMarketSyncRun,
  getMarketSyncRunByRequestId,
  listSecurityAdjustmentFactors,
  listSecurityValuationDaily,
  saveMarketSyncRun,
  upsertSecurityAdjustmentFactors,
  upsertSecurityValuationDaily,
} from '../database/industryResearchMarketRepository'
import { getLatestDailyCloseTradeDate, queryDailyClose, upsertDailyClose } from '../database/dailyCloseCacheRepository'
import type { IndustryResearchMarketSyncRunRow, IndustryResearchSecurityRow } from '../database/types'
import {
  fetchAdjustmentFactorHistory,
  fetchDailyForCandidates,
  fetchIndexDailyForCodes,
  fetchSecurityValuationDailyHistory,
  type AdjustmentFactorRow,
  type DailyRow,
  type SecurityValuationDailyApiRow,
} from './tushareService'

export const INDUSTRY_RESEARCH_MARKET_METHOD_VERSION = 'market-context-v1'
const DATE_PATTERN = /^\d{4}-?\d{2}-?\d{2}$/
const MARKET_WINDOWS = [20, 60, 120, 250] as const

const BENCHMARKS: Record<string, string> = {
  '000001.SH': '上证指数',
  '399001.SZ': '深证成指',
  '399006.SZ': '创业板指',
  '000688.SH': '科创50',
}

export class IndustryResearchMarketError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

interface ScopeRow extends IndustryResearchSecurityRow {
  project_id: string
}

export interface MarketReason {
  code: string
  message: string
  scope?: string
}

export interface MarketWindowResult {
  days: number
  status: 'ok' | 'blocked'
  startDate: string | null
  endDate: string | null
  stockReturnPct: number | null
  benchmarkReturnPct: number | null
  excessReturnPct: number | null
  reason: string | null
}

export interface MarketSeriesPoint {
  tradeDate: string
  stock: number | null
  benchmark: number | null
}

export interface MarketEventWindow {
  id: string
  kind: string
  label: string
  availableDate: string
  anchorDate: string | null
  timing: 'known' | 'date_only'
  pre5Pct: number | null
  post5Pct: number | null
  benchmarkPost5Pct: number | null
  excessPost5Pct: number | null
}

export interface MarketComparableResult {
  status: 'ok' | 'blocked'
  sampleCount: number
  minimumSample: number
  rows: Array<{
    companyId: string
    companyName: string
    securityId: string
    tsCode: string
    tradeDate: string
    peTtm: number | null
    pb: number | null
    psTtm: number | null
  }>
  currentPercentiles: Record<'peTtm' | 'pb' | 'psTtm', number | null>
}

export interface IndustryResearchMarketContext {
  projectId: string
  companyId: string
  securityId: string
  tsCode: string
  requestedValuationDate: string
  marketDate: string | null
  rawClose: number | null
  benchmarkCode: string | null
  benchmarkName: string | null
  status: 'ok' | 'degraded' | 'blocked'
  reasons: MarketReason[]
  windows: MarketWindowResult[]
  series: MarketSeriesPoint[]
  events: MarketEventWindow[]
  valuationDaily: {
    tradeDate: string
    totalShare: number | null
    floatShare: number | null
    totalMv: number | null
    circMv: number | null
    peTtm: number | null
    pb: number | null
    psTtm: number | null
    dvTtm: number | null
  } | null
  valuationHistory: Record<'peTtm' | 'pb' | 'psTtm', { sampleCount: number; percentile: number | null }>
  comparables: MarketComparableResult
  factFingerprint: string
  methodologyVersion: string
  latestSync: Record<string, unknown> | null
}

export interface IndustryResearchMarketFetchers {
  daily: (token: string, tsCodes: string[], startDate: string, endDate?: string) => Promise<DailyRow[]>
  adjustment: (token: string, tsCode: string, startDate: string, endDate?: string) => Promise<AdjustmentFactorRow[]>
  valuation: (token: string, tsCode: string, startDate: string, endDate?: string) => Promise<SecurityValuationDailyApiRow[]>
  indexDaily: (token: string, codes: string[], startDate: string, endDate?: string) => Promise<DailyRow[]>
}

const DEFAULT_FETCHERS: IndustryResearchMarketFetchers = {
  daily: fetchDailyForCandidates,
  adjustment: fetchAdjustmentFactorHistory,
  valuation: fetchSecurityValuationDailyHistory,
  indexDaily: fetchIndexDailyForCodes,
}

function compactDate(value: string): string {
  if (!DATE_PATTERN.test(value)) throw new IndustryResearchMarketError('INVALID_PARAM', '估值日期格式无效')
  return value.replaceAll('-', '')
}

function displayDate(value: string): string {
  const date = compactDate(value)
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
}

function requireScope(
  db: Database.Database,
  projectId: string,
  companyId: string,
  securityId: string,
): ScopeRow {
  const row = db.prepare(`
    SELECT security.*, scope.project_id
    FROM industry_research_securities security
    JOIN industry_research_project_companies scope ON scope.company_id = security.company_id
    WHERE scope.project_id = ? AND security.company_id = ? AND security.id = ?
  `).get(projectId, companyId, securityId) as ScopeRow | undefined
  if (!row) throw new IndustryResearchMarketError('NOT_FOUND', '项目公司或证券不存在')
  return row
}

export function benchmarkForSecurity(tsCode: string, override?: string | null): { code: string; name: string } | null {
  if (override) return BENCHMARKS[override] ? { code: override, name: BENCHMARKS[override] } : null
  const symbol = tsCode.split('.')[0]
  if (/^68/.test(symbol)) return { code: '000688.SH', name: BENCHMARKS['000688.SH'] }
  if (/^(30|301)/.test(symbol)) return { code: '399006.SZ', name: BENCHMARKS['399006.SZ'] }
  if (tsCode.endsWith('.SH')) return { code: '000001.SH', name: BENCHMARKS['000001.SH'] }
  if (tsCode.endsWith('.SZ')) return { code: '399001.SZ', name: BENCHMARKS['399001.SZ'] }
  return null
}

function round(value: number | null, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function percentile(values: number[], current: number | null): { sampleCount: number; percentile: number | null } {
  const samples = values.filter((value) => Number.isFinite(value) && value > 0)
  if (current == null || current <= 0 || samples.length < 120) return { sampleCount: samples.length, percentile: null }
  return { sampleCount: samples.length, percentile: round(samples.filter((value) => value <= current).length / samples.length * 100, 2) }
}

function comparablePercentile(values: number[], current: number | null): number | null {
  const samples = values.filter((value) => Number.isFinite(value) && value > 0)
  if (current == null || current <= 0 || samples.length < 3) return null
  return round(samples.filter((value) => value <= current).length / samples.length * 100, 2)
}

function buildComparableResult(
  db: Database.Database,
  projectId: string,
  currentTsCode: string,
  endDate: string,
): MarketComparableResult {
  const candidates = db.prepare(`
    SELECT scope.company_id, COALESCE(company.short_name, company.legal_name) AS company_name,
      security.id AS security_id, security.ts_code, valuation.trade_date,
      valuation.pe_ttm, valuation.pb, valuation.ps_ttm
    FROM industry_research_project_companies scope
    JOIN industry_research_companies company ON company.id = scope.company_id
    JOIN industry_research_securities security ON security.company_id = scope.company_id
    JOIN security_valuation_daily_cache valuation ON valuation.ts_code = security.ts_code
      AND valuation.trade_date = (
        SELECT MAX(latest.trade_date) FROM security_valuation_daily_cache latest
        WHERE latest.ts_code = security.ts_code AND latest.trade_date <= ?
      )
    WHERE scope.project_id = ? AND scope.status <> 'excluded'
    ORDER BY scope.company_id, security.ts_code
  `).all(endDate, projectId) as Array<{
    company_id: string
    company_name: string
    security_id: string
    ts_code: string
    trade_date: string
    pe_ttm: number | null
    pb: number | null
    ps_ttm: number | null
  }>
  const rows = [...new Map(candidates.map((row) => [row.company_id, row])).values()].map((row) => ({
    companyId: row.company_id,
    companyName: row.company_name,
    securityId: row.security_id,
    tsCode: row.ts_code,
    tradeDate: row.trade_date,
    peTtm: row.pe_ttm,
    pb: row.pb,
    psTtm: row.ps_ttm,
  }))
  const current = rows.find((row) => row.tsCode === currentTsCode) ?? null
  const status = rows.length >= 3 ? 'ok' : 'blocked'
  return {
    status,
    sampleCount: rows.length,
    minimumSample: 3,
    rows,
    currentPercentiles: {
      peTtm: status === 'ok' ? comparablePercentile(rows.map((row) => row.peTtm ?? Number.NaN), current?.peTtm ?? null) : null,
      pb: status === 'ok' ? comparablePercentile(rows.map((row) => row.pb ?? Number.NaN), current?.pb ?? null) : null,
      psTtm: status === 'ok' ? comparablePercentile(rows.map((row) => row.psTtm ?? Number.NaN), current?.psTtm ?? null) : null,
    },
  }
}

function adjustedReturn(
  start: DailyRow,
  end: DailyRow,
  factors: Map<string, number>,
): number | null {
  const startFactor = factors.get(start.tradeDate)
  const endFactor = factors.get(end.tradeDate)
  if (!startFactor || !endFactor || start.close <= 0) return null
  return (end.close * endFactor) / (start.close * startFactor) - 1
}

function rawReturn(start: DailyRow, end: DailyRow): number | null {
  if (start.close <= 0) return null
  return end.close / start.close - 1
}

function eventCandidates(db: Database.Database, projectId: string, companyId: string): Array<{ id: string; kind: string; label: string; date: string }> {
  const rows = db.prepare(`
    SELECT id, 'evidence' AS kind, title AS label, fact_date AS available_date
    FROM industry_research_evidence
    WHERE project_id = ? AND fact_date IS NOT NULL
    UNION ALL
    SELECT fact.id, 'financial' AS kind, fact.source_api || ' · ' || fact.metric_name AS label,
      COALESCE(NULLIF(fact.f_ann_date, ''), NULLIF(fact.ann_date, '')) AS available_date
    FROM industry_research_financial_facts fact
    JOIN industry_research_project_companies scope ON scope.company_id = fact.company_id
    WHERE scope.project_id = ? AND fact.company_id = ?
      AND COALESCE(NULLIF(fact.f_ann_date, ''), NULLIF(fact.ann_date, '')) IS NOT NULL
    UNION ALL
    SELECT event.id, 'decision' AS kind, '研究决策 · ' || event.action AS label, event.data_as_of AS available_date
    FROM industry_research_decision_events event
    JOIN industry_research_decisions decision ON decision.id = event.decision_id
    WHERE event.project_id = ? AND (decision.company_id IS NULL OR decision.company_id = ?)
    UNION ALL
    SELECT observation.id, 'monitoring' AS kind, item.name AS label, observation.data_as_of AS available_date
    FROM industry_research_monitoring_observations observation
    JOIN industry_research_monitoring_item_versions item ON item.id = observation.monitoring_item_version_id
    WHERE observation.project_id = ? AND item.value_kind = 'event'
  `).all(projectId, projectId, companyId, projectId, companyId, projectId) as Array<{
    id: string
    kind: string
    label: string
    available_date: string
  }>
  return rows
    .filter((row) => DATE_PATTERN.test(row.available_date))
    .map((row) => ({ id: row.id, kind: row.kind, label: row.label, date: compactDate(row.available_date) }))
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 12)
}

function parseSyncRun(row: IndustryResearchMarketSyncRunRow | null): Record<string, unknown> | null {
  if (!row) return null
  let result: unknown = {}
  try { result = JSON.parse(row.result_json) } catch { result = { dataStatus: 'corrupt' } }
  return {
    id: row.id,
    status: row.status,
    result,
    dataStart: row.data_start,
    dataEnd: row.data_end,
    errorCode: row.error_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

export function buildIndustryResearchMarketContext(
  db: Database.Database,
  input: { projectId: string; companyId: string; securityId: string; valuationDate?: string; benchmarkCode?: string | null },
): IndustryResearchMarketContext {
  const scope = requireScope(db, input.projectId, input.companyId, input.securityId)
  const requested = compactDate(input.valuationDate ?? new Date().toISOString().slice(0, 10))
  const benchmark = benchmarkForSecurity(scope.ts_code, input.benchmarkCode)
  const reasons: MarketReason[] = []
  if (!benchmark) reasons.push({ code: 'BENCHMARK_UNAVAILABLE', message: '当前证券没有受控基准指数映射', scope: 'benchmark' })
  const codes = benchmark ? [scope.ts_code, benchmark.code] : [scope.ts_code]
  const priceMap = queryDailyClose(db, codes, '00000000')
  const stockRows = (priceMap.get(scope.ts_code) ?? []).filter((row) => row.tradeDate <= requested)
  const benchmarkRows = benchmark ? (priceMap.get(benchmark.code) ?? []).filter((row) => row.tradeDate <= requested) : []
  const stockByDate = new Map(stockRows.map((row) => [row.tradeDate, row]))
  const benchmarkByDate = new Map(benchmarkRows.map((row) => [row.tradeDate, row]))
  const commonDates = benchmarkRows.map((row) => row.tradeDate).filter((date) => stockByDate.has(date)).sort()
  const marketDate = commonDates.at(-1) ?? null
  const factors = new Map(listSecurityAdjustmentFactors(db, scope.ts_code, '00000000', requested).map((row) => [row.trade_date, row.adj_factor]))
  if (!stockRows.length) reasons.push({ code: 'MARKET_DATA_BLOCKED', message: '缺少所选证券日线', scope: 'stock' })
  if (benchmark && !benchmarkRows.length) reasons.push({ code: 'MARKET_DATA_BLOCKED', message: '缺少基准指数日线', scope: 'benchmark' })
  if (!factors.size) reasons.push({ code: 'ADJUSTMENT_FACTOR_MISSING', message: '缺少所选证券调整因子', scope: 'adjustment' })

  const windows: MarketWindowResult[] = MARKET_WINDOWS.map((days) => {
    if (!marketDate || commonDates.length <= days) {
      return { days, status: 'blocked', startDate: null, endDate: marketDate, stockReturnPct: null, benchmarkReturnPct: null, excessReturnPct: null, reason: '共同交易日样本不足' }
    }
    const endIndex = commonDates.length - 1
    const startDate = commonDates[endIndex - days]
    const startStock = stockByDate.get(startDate)!
    const endStock = stockByDate.get(marketDate)!
    const startBenchmark = benchmarkByDate.get(startDate)!
    const endBenchmark = benchmarkByDate.get(marketDate)!
    const stockReturn = adjustedReturn(startStock, endStock, factors)
    const benchmarkReturn = rawReturn(startBenchmark, endBenchmark)
    if (stockReturn == null || benchmarkReturn == null) {
      return { days, status: 'blocked', startDate, endDate: marketDate, stockReturnPct: null, benchmarkReturnPct: null, excessReturnPct: null, reason: stockReturn == null ? '窗口调整因子缺失' : '窗口基准行情无效' }
    }
    return {
      days,
      status: 'ok',
      startDate,
      endDate: marketDate,
      stockReturnPct: round(stockReturn * 100, 2),
      benchmarkReturnPct: round(benchmarkReturn * 100, 2),
      excessReturnPct: round((stockReturn - benchmarkReturn) * 100, 2),
      reason: null,
    }
  })

  const seriesDates = commonDates.slice(-120)
  const baseDate = seriesDates[0]
  const baseStock = baseDate ? stockByDate.get(baseDate) : null
  const baseBenchmark = baseDate ? benchmarkByDate.get(baseDate) : null
  const series: MarketSeriesPoint[] = seriesDates.map((date) => {
    const stock = stockByDate.get(date)!
    const index = benchmarkByDate.get(date)!
    const stockReturn = baseStock ? adjustedReturn(baseStock, stock, factors) : null
    const indexReturn = baseBenchmark ? rawReturn(baseBenchmark, index) : null
    return { tradeDate: date, stock: stockReturn == null ? null : round((1 + stockReturn) * 100, 3), benchmark: indexReturn == null ? null : round((1 + indexReturn) * 100, 3) }
  })

  const events = eventCandidates(db, input.projectId, input.companyId).map((event): MarketEventWindow => {
    const anchorIndex = commonDates.findIndex((date) => date >= event.date)
    if (anchorIndex < 0 || !marketDate) {
      return { id: event.id, kind: event.kind, label: event.label, availableDate: event.date, anchorDate: null, timing: 'date_only', pre5Pct: null, post5Pct: null, benchmarkPost5Pct: null, excessPost5Pct: null }
    }
    const anchorDate = commonDates[anchorIndex]
    const preDate = anchorIndex >= 5 ? commonDates[anchorIndex - 5] : null
    const postDate = anchorIndex + 5 < commonDates.length ? commonDates[anchorIndex + 5] : null
    const pre = preDate ? adjustedReturn(stockByDate.get(preDate)!, stockByDate.get(anchorDate)!, factors) : null
    const post = postDate ? adjustedReturn(stockByDate.get(anchorDate)!, stockByDate.get(postDate)!, factors) : null
    const benchmarkPost = postDate ? rawReturn(benchmarkByDate.get(anchorDate)!, benchmarkByDate.get(postDate)!) : null
    return {
      id: event.id,
      kind: event.kind,
      label: event.label,
      availableDate: event.date,
      anchorDate,
      timing: 'date_only',
      pre5Pct: pre == null ? null : round(pre * 100, 2),
      post5Pct: post == null ? null : round(post * 100, 2),
      benchmarkPost5Pct: benchmarkPost == null ? null : round(benchmarkPost * 100, 2),
      excessPost5Pct: post == null || benchmarkPost == null ? null : round((post - benchmarkPost) * 100, 2),
    }
  })

  const valuationRows = listSecurityValuationDaily(db, scope.ts_code, '00000000', marketDate ?? requested)
  const latestValuation = valuationRows.at(-1) ?? null
  if (!latestValuation) reasons.push({ code: 'VALUATION_INPUT_BLOCKED', message: '缺少点时估值与股本数据', scope: 'valuation' })
  const latestGlobalDate = getLatestDailyCloseTradeDate(db)
  if (marketDate && latestGlobalDate && marketDate < latestGlobalDate) {
    reasons.push({ code: 'MARKET_DATA_STALE', message: `共同行情日落后于本地最新交易日 ${latestGlobalDate}`, scope: 'freshness' })
  }
  const comparables = buildComparableResult(db, input.projectId, scope.ts_code, marketDate ?? requested)

  const fingerprintPayload = {
    tsCode: scope.ts_code,
    benchmark: benchmark?.code ?? null,
    requested,
    stockRows: stockRows.map((row) => [row.tradeDate, row.close]),
    benchmarkRows: benchmarkRows.map((row) => [row.tradeDate, row.close]),
    factors: [...factors.entries()],
    valuationRows: valuationRows.map((row) => [row.trade_date, row.total_share, row.total_mv, row.pe_ttm, row.pb, row.ps_ttm]),
    comparables: comparables.rows.map((row) => [row.companyId, row.tsCode, row.tradeDate, row.peTtm, row.pb, row.psTtm]),
  }
  const factFingerprint = createHash('sha256').update(JSON.stringify(fingerprintPayload)).digest('hex')
  const blocked = !marketDate || !benchmark || !stockRows.length || !benchmarkRows.length
  const degraded = reasons.length > 0 || windows.some((window) => window.status === 'blocked')
  return {
    projectId: input.projectId,
    companyId: input.companyId,
    securityId: input.securityId,
    tsCode: scope.ts_code,
    requestedValuationDate: displayDate(requested),
    marketDate,
    rawClose: marketDate ? stockByDate.get(marketDate)?.close ?? null : null,
    benchmarkCode: benchmark?.code ?? null,
    benchmarkName: benchmark?.name ?? null,
    status: blocked ? 'blocked' : degraded ? 'degraded' : 'ok',
    reasons,
    windows,
    series,
    events,
    valuationDaily: latestValuation ? {
      tradeDate: latestValuation.trade_date,
      totalShare: latestValuation.total_share,
      floatShare: latestValuation.float_share,
      totalMv: latestValuation.total_mv,
      circMv: latestValuation.circ_mv,
      peTtm: latestValuation.pe_ttm,
      pb: latestValuation.pb,
      psTtm: latestValuation.ps_ttm,
      dvTtm: latestValuation.dv_ttm,
    } : null,
    valuationHistory: {
      peTtm: percentile(valuationRows.map((row) => row.pe_ttm ?? Number.NaN), latestValuation?.pe_ttm ?? null),
      pb: percentile(valuationRows.map((row) => row.pb ?? Number.NaN), latestValuation?.pb ?? null),
      psTtm: percentile(valuationRows.map((row) => row.ps_ttm ?? Number.NaN), latestValuation?.ps_ttm ?? null),
    },
    comparables,
    factFingerprint,
    methodologyVersion: INDUSTRY_RESEARCH_MARKET_METHOD_VERSION,
    latestSync: parseSyncRun(getLatestMarketSyncRun(db, input.projectId, input.securityId)),
  }
}

function startDateForSync(now: number): string {
  const date = new Date(now - 850 * 24 * 60 * 60 * 1000)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

function errorCode(error: unknown): string {
  if (error instanceof IndustryResearchMarketError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  if (/empty|空响应/i.test(message)) return 'EMPTY_RESPONSE'
  if (/quota|permission|积分|权限/i.test(message)) return 'PERMISSION_REQUIRED'
  if (/429|limit|频率|限流/i.test(message)) return 'RATE_LIMITED'
  if (/token|未配置/i.test(message)) return 'TOKEN_REQUIRED'
  return 'UPSTREAM_ERROR'
}

function requireRows<T>(rows: T[], label: string): T[] {
  if (!rows.length) throw new IndustryResearchMarketError('EMPTY_RESPONSE', `${label}返回空响应`)
  return rows
}

export async function syncIndustryResearchMarketData(
  db: Database.Database,
  token: string,
  input: { projectId: string; companyId: string; securityId: string; requestId: string; valuationDate?: string },
  now = Date.now(),
  fetchers: IndustryResearchMarketFetchers = DEFAULT_FETCHERS,
): Promise<Record<string, unknown>> {
  const existing = getMarketSyncRunByRequestId(db, input.requestId)
  if (existing) {
    if (existing.project_id !== input.projectId || existing.company_id !== input.companyId || existing.security_id !== input.securityId) {
      throw new IndustryResearchMarketError('NOT_FOUND', '幂等请求不属于当前项目证券')
    }
    return parseSyncRun(existing)!
  }
  const scope = requireScope(db, input.projectId, input.companyId, input.securityId)
  const benchmark = benchmarkForSecurity(scope.ts_code)
  const startDate = startDateForSync(now)
  const endDate = compactDate(input.valuationDate ?? new Date(now).toISOString().slice(0, 10))
  const results: Record<string, { status: 'success' | 'failed'; rows: number; errorCode: string | null }> = {}
  const failures: string[] = []

  try {
    const rows = requireRows(await fetchers.daily(token, [scope.ts_code], startDate, endDate), '个股日线')
    upsertDailyClose(db, rows)
    results.daily = { status: 'success', rows: rows.length, errorCode: null }
  } catch (error) {
    const code = errorCode(error); failures.push(code)
    results.daily = { status: 'failed', rows: 0, errorCode: code }
  }
  try {
    const rows = requireRows(await fetchers.adjustment(token, scope.ts_code, startDate, endDate), '调整因子')
    upsertSecurityAdjustmentFactors(db, rows.map((row) => ({ ts_code: row.tsCode, trade_date: row.tradeDate, adj_factor: row.adjFactor, source: 'tushare:adj_factor', fetched_at: now })))
    results.adjustment = { status: 'success', rows: rows.length, errorCode: null }
  } catch (error) {
    const code = errorCode(error); failures.push(code)
    results.adjustment = { status: 'failed', rows: 0, errorCode: code }
  }
  try {
    const rows = requireRows(await fetchers.valuation(token, scope.ts_code, startDate, endDate), '点时估值')
    upsertSecurityValuationDaily(db, rows.map((row) => ({
      ts_code: row.tsCode, trade_date: row.tradeDate, total_share: row.totalShare,
      float_share: row.floatShare, total_mv: row.totalMv, circ_mv: row.circMv,
      pe_ttm: row.peTtm, pb: row.pb, ps_ttm: row.psTtm, dv_ttm: row.dvTtm,
      source: 'tushare:daily_basic', fetched_at: now,
    })))
    results.valuation = { status: 'success', rows: rows.length, errorCode: null }
  } catch (error) {
    const code = errorCode(error); failures.push(code)
    results.valuation = { status: 'failed', rows: 0, errorCode: code }
  }
  if (benchmark) {
    try {
      const rows = requireRows(await fetchers.indexDaily(token, [benchmark.code], startDate, endDate), '基准指数日线')
      upsertDailyClose(db, rows)
      results.benchmark = { status: 'success', rows: rows.length, errorCode: null }
    } catch (error) {
      const code = errorCode(error); failures.push(code)
      results.benchmark = { status: 'failed', rows: 0, errorCode: code }
    }
  } else {
    failures.push('BENCHMARK_UNAVAILABLE')
    results.benchmark = { status: 'failed', rows: 0, errorCode: 'BENCHMARK_UNAVAILABLE' }
  }

  const successCount = Object.values(results).filter((result) => result.status === 'success').length
  const context = buildIndustryResearchMarketContext(db, input)
  const status: IndustryResearchMarketSyncRunRow['status'] = successCount === 4 ? 'success' : successCount > 0 ? 'partial' : 'failed'
  const row = saveMarketSyncRun(db, {
    id: randomUUID(), request_id: input.requestId, project_id: input.projectId,
    company_id: input.companyId, security_id: input.securityId, ts_code: scope.ts_code,
    benchmark_code: benchmark?.code ?? null, status, result_json: JSON.stringify(results),
    data_start: startDate, data_end: context.marketDate, fact_fingerprint: context.factFingerprint,
    error_code: failures[0] ?? null, started_at: now, completed_at: Date.now(),
  })
  return parseSyncRun(row)!
}
