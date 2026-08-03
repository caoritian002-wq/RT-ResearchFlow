import type Database from 'better-sqlite3'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { BlockStrategyTemplate, ConditionScanMatch, MinuteBarForCondition } from './types'
import { evaluateConditionTemplate } from './blockEvaluator'
import { fetchMinuteBarsForUserTier, getDefaultApproximateCapability, resolveMinuteUserTier } from '../minuteData/minuteDataProviderRegistry'
import type { MinuteDataCapability, MinuteDataGranularity, MinuteDataSource, MinuteUserTier } from '../minuteData/minuteDataTypes'
import {
  completeConditionScanRun,
  computeConditionParamHash,
  createConditionScanRun,
  failConditionScanRun,
  findConditionRunByParamHash,
  findCompletedConditionRun,
  getConditionScanRun,
  getConditionTemplate,
  listConditionMatches,
  resetConditionScanRun,
} from '../../database/conditionBlockRepository'
import { getFreeMinuteCacheByDate } from '../../database/freeMinuteCacheRepository'

interface StockCandidate { tsCode: string; stockName: string | null }

interface DailyStockCandidate extends StockCandidate {
  rowCount: number
  avgAmount: number
  maxPctChg: number
  avgTurnoverRate: number | null
}

export type ConditionBlockScanMode = 'complete' | 'quick'

interface DebugDailyCandidateExportRow {
  股票code: string
  股票名称: string | null
  需要分钟交易日数: number
  已有分钟交易日数: number
  补拉成功交易日数: number
  缺失交易日: string[]
  是否参与评估: boolean
  未评估原因: string | null
  数据粒度?: MinuteDataGranularity | null
  数据来源?: string | null
  是否近似?: boolean
}

export interface ConditionScanSummary {
  scanMode: ConditionBlockScanMode
  dateStart: string
  dateEnd: string
  totalStocks: number
  dailyPrefilteredStocks: number
  dailyCandidateStocks: number
  minuteCompleteStocks: number
  minuteIncompleteStocks: number
  evaluatedStocks: number
  unevaluatedStocks: number
  minuteCacheHitGaps: number
  minuteMissingGaps: number
  minuteFetchAttempted: number
  minuteFetchSucceeded: number
  minuteFetchFailed: number
  minuteFetchEmpty: number
  minuteFetchSkippedByLimit: number
  minuteFetchSkippedByFailureGuard: number
  minuteFetchStoppedByFailureGuard: boolean
  minuteUserTier: MinuteUserTier
  minuteDataProviderId: string
  minuteDataProviderLabel: string
  minuteGranularity: MinuteDataGranularity
  minuteDataSource: MinuteDataSource
  minuteDataApproximate: boolean
  minuteExactEvaluatedStocks: number
  minuteApproxEvaluatedStocks: number
  minuteDataQualityNote: string
  stocksWithMinuteData: number
  evaluatedTradeDays: number
  minuteRows: number
  matchedCount: number
}

interface MinuteFetchStats {
  minuteCacheHitGaps: number
  minuteMissingGaps: number
  minuteFetchAttempted: number
  minuteFetchSucceeded: number
  minuteFetchFailed: number
  minuteFetchEmpty: number
  minuteFetchSkippedByLimit: number
  minuteFetchSkippedByFailureGuard: number
  minuteFetchStoppedByFailureGuard: boolean
  approximateFetchSucceeded: number
}

interface MinuteGap { tsCode: string; tradeDate: string }

interface CandidateMinuteCoverage {
  stock: StockCandidate
  requiredTradeDates: string[]
  existingTradeDates: Set<string>
  fetchedSuccessTradeDates: Set<string>
  missingTradeDates: Set<string>
  skippedTradeDates: Set<string>
  failureGuardSkippedTradeDates: Set<string>
  failedTradeDates: Set<string>
  emptyTradeDates: Set<string>
  dataCapability: MinuteDataCapability | null
  approximateBarsByDate: Map<string, MinuteBarForCondition[]>
  complete: boolean
  evaluated: boolean
  unevaluatedReason: string | null
}

export type ConditionBlockScanProgressStage = 'prepare' | 'prefilter' | 'minuteCheck' | 'minuteFetch' | 'evaluate' | 'save' | 'done' | 'failed'

export interface ConditionBlockScanProgress {
  stage: ConditionBlockScanProgressStage
  current: number
  total: number
  message: string
  stats?: Partial<ConditionScanSummary>
}

type ProgressReporter = (progress: ConditionBlockScanProgress) => void

export interface ConditionBlockScanScopeOverride {
  dateStart?: string
  dateEnd?: string
  dailyPrefilterLimit?: number | null
  autoFetchMinuteLimit?: number | null
}

export class ConditionBlockScanCancelledError extends Error {
  constructor() {
    super('条件积木扫描已终止')
    this.name = 'ConditionBlockScanCancelledError'
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConditionBlockScanCancelledError()
}

function emitProgress(onProgress: ProgressReporter | undefined, progress: ConditionBlockScanProgress): void {
  onProgress?.(progress)
}

function isYmd(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8}$/.test(value)
}

function applyScopeOverride(template: BlockStrategyTemplate, override?: ConditionBlockScanScopeOverride): BlockStrategyTemplate {
  if (!override) return template
  const scope = { ...template.scope }
  if (isYmd(override.dateStart)) scope.dateStart = override.dateStart
  if (isYmd(override.dateEnd)) scope.dateEnd = override.dateEnd
  if (override.dailyPrefilterLimit != null) scope.dailyPrefilterLimit = getScanNumber(override.dailyPrefilterLimit, scope.dailyPrefilterLimit ?? 200, 1, 1000)
  if (override.autoFetchMinuteLimit != null) scope.autoFetchMinuteLimit = getScanNumber(override.autoFetchMinuteLimit, scope.autoFetchMinuteLimit ?? 80, 0, 500)
  return { ...template, scope }
}

function todayYmd(): string {
  const now = new Date()
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
  return `${bj.getFullYear()}${String(bj.getMonth() + 1).padStart(2, '0')}${String(bj.getDate()).padStart(2, '0')}`
}

export function resolveConditionScanDateRange(template: BlockStrategyTemplate, availableDates: string[]): { dateStart: string; dateEnd: string } {
  if (template.scope.dateStart && template.scope.dateEnd) return { dateStart: template.scope.dateStart, dateEnd: template.scope.dateEnd }
  const end = template.scope.dateEnd || null
  const lookbackDays = Math.max(1, Math.min(60, Math.round(template.scope.lookbackDays || 1)))
  const dates = Array.from(new Set(availableDates))
    .filter((date) => /^\d{8}$/.test(date) && (!end || date <= end))
    .sort()
    .slice(-lookbackDays)
  if (dates.length === 0) {
    const fallback = end || todayYmd()
    return { dateStart: fallback, dateEnd: fallback }
  }
  return { dateStart: dates[0], dateEnd: dates[dates.length - 1] }
}

function resolveDateRange(db: Database.Database, template: BlockStrategyTemplate): { dateStart: string; dateEnd: string } {
  if (template.scope.dateStart && template.scope.dateEnd) return { dateStart: template.scope.dateStart, dateEnd: template.scope.dateEnd }
  const end = template.scope.dateEnd || null
  const lookbackDays = Math.max(1, Math.min(60, Math.round(template.scope.lookbackDays || 1)))
  const rows = db.prepare(`
    SELECT DISTINCT trade_date AS tradeDate
    FROM daily_close_cache
    WHERE (? IS NULL OR trade_date <= ?)
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(end, end, lookbackDays) as Array<{ tradeDate: string }>
  return resolveConditionScanDateRange(template, rows.map(row => row.tradeDate))
}

function normalizeTsCode(code: string): string {
  const trimmed = code.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(trimmed)) return trimmed
  const pure = trimmed.replace(/\.(SH|SZ|BJ)$/i, '').replace(/^(SH|SZ|BJ)/i, '')
  if (pure.startsWith('6') || pure.startsWith('9')) return `${pure}.SH`
  if (pure.startsWith('8') || pure.startsWith('4')) return `${pure}.BJ`
  return `${pure}.SZ`
}

function getScanNumber(value: number | null | undefined, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.round(numeric)))
}

function loadAllMarketDailyCandidates(db: Database.Database, template: BlockStrategyTemplate, dateStart: string, dateEnd: string): DailyStockCandidate[] {
  const minRows = Math.max(1, Math.min(20, Math.round(template.scope.lookbackDays || 1)))
  const limit = getScanNumber(template.scope.dailyPrefilterLimit, 200, 1, 1000)
  const minDailyAmount = template.scope.minDailyAmount ?? 0
  // daily_close_cache 当前没有 amount 列, 这里用 close * vol 作为本地流动性近似值。
  const liquidityExpr = 'COALESCE(d.close, 0) * COALESCE(d.vol, 0)'
  const rows = db.prepare(`
    SELECT
      d.ts_code AS ts_code,
      COALESCE(s.name, i.stockName) AS stock_name,
      COUNT(*) AS row_count,
      AVG(${liquidityExpr}) AS avg_amount,
      MAX(ABS(COALESCE(d.pct_chg, 0))) AS max_pct_chg,
      AVG(d.turnover_rate) AS avg_turnover_rate
    FROM daily_close_cache d
    LEFT JOIN stock_basic_cache s ON s.ts_code = d.ts_code
    LEFT JOIN stock_info i ON i.stockCode = substr(d.ts_code, 1, 6)
    WHERE d.trade_date BETWEEN ? AND ?
      AND (s.list_status IS NULL OR s.list_status = 'L')
    GROUP BY d.ts_code
    HAVING row_count >= ? AND avg_amount >= ?
    ORDER BY avg_amount DESC, max_pct_chg DESC, d.ts_code ASC
    LIMIT ?
  `).all(dateStart, dateEnd, minRows, minDailyAmount, limit) as Array<{
    ts_code: string
    stock_name: string | null
    row_count: number
    avg_amount: number | null
    max_pct_chg: number | null
    avg_turnover_rate: number | null
  }>
  return rows.map(row => ({
    tsCode: normalizeTsCode(row.ts_code),
    stockName: row.stock_name,
    rowCount: row.row_count,
    avgAmount: row.avg_amount ?? 0,
    maxPctChg: row.max_pct_chg ?? 0,
    avgTurnoverRate: row.avg_turnover_rate,
  }))
}

function writeDailyPrefilterDebugLog(candidates: DailyStockCandidate[], coverages?: CandidateMinuteCoverage[]): void {
  const coverageMap = new Map((coverages ?? []).map(item => [item.stock.tsCode, item]))
  const payload: DebugDailyCandidateExportRow[] = candidates.map(row => {
    const coverage = coverageMap.get(row.tsCode)
    return {
      股票code: row.tsCode,
      股票名称: row.stockName,
      需要分钟交易日数: coverage?.requiredTradeDates.length ?? 0,
      已有分钟交易日数: coverage?.existingTradeDates.size ?? 0,
      补拉成功交易日数: coverage?.fetchedSuccessTradeDates.size ?? 0,
      缺失交易日: coverage ? Array.from(coverage.missingTradeDates).sort() : [],
      是否参与评估: coverage?.evaluated ?? false,
      未评估原因: coverage?.unevaluatedReason ?? null,
      数据粒度: coverage?.dataCapability?.granularity ?? null,
      数据来源: coverage?.dataCapability?.label ?? null,
      是否近似: coverage?.dataCapability?.isApproximate ?? false,
    }
  })
  try {
    writeFileSync(join(process.cwd(), 'log.txt'), JSON.stringify(payload, null, 2), 'utf8')
  } catch (err) {
    console.warn('[ConditionBlocks] Failed to write daily prefilter debug log:', err)
  }
}

function loadStockPool(db: Database.Database, template: BlockStrategyTemplate, dateStart: string, dateEnd: string): { stocks: StockCandidate[]; totalStocks: number; dailyPrefilteredStocks: number; dailyCandidates: DailyStockCandidate[] } {
  const map = new Map<string, StockCandidate>()
  const dailyCandidates: DailyStockCandidate[] = []
  const findStockName = db.prepare(`
    SELECT COALESCE(
      (SELECT name FROM stock_basic_cache WHERE ts_code = ? LIMIT 1),
      (SELECT stockName FROM stock_info WHERE stockCode = ? LIMIT 1)
    ) AS stock_name
  `)
  const add = (code: string | null | undefined, name: string | null | undefined) => {
    if (!code) return
    const tsCode = normalizeTsCode(code)
    const existingName = map.get(tsCode)?.stockName ?? null
    const explicitName = typeof name === 'string' && name.trim() ? name.trim() : null
    const localName = explicitName || existingName
      ? null
      : (findStockName.get(tsCode, pureCode(tsCode)) as { stock_name: string | null } | undefined)?.stock_name ?? null
    const stockName = explicitName ?? existingName ?? localName
    if (template.scope.excludeBJ && tsCode.endsWith('.BJ')) return
    if (template.scope.excludeST && stockName?.toUpperCase().includes('ST')) return
    map.set(tsCode, { tsCode, stockName })
  }
  let totalStocks = 0
  let dailyPrefilteredStocks = 0
  if (template.scope.stockPoolSources.includes('allMarket')) {
    const allCount = db.prepare(`
      SELECT COUNT(DISTINCT d.ts_code) AS count
      FROM daily_close_cache d
      LEFT JOIN stock_basic_cache s ON s.ts_code = d.ts_code
      WHERE d.trade_date BETWEEN ? AND ? AND (s.list_status IS NULL OR s.list_status = 'L')
    `).get(dateStart, dateEnd) as { count: number } | undefined
    totalStocks += allCount?.count ?? 0
    const rows = loadAllMarketDailyCandidates(db, template, dateStart, dateEnd)
    dailyCandidates.push(...rows)
    writeDailyPrefilterDebugLog(rows)
    dailyPrefilteredStocks += rows.length
    rows.forEach((row) => add(row.tsCode, row.stockName))
  }
  if (template.scope.stockPoolSources.includes('portfolio')) {
    const rows = db.prepare('SELECT ts_code, stock_name FROM portfolio_stocks').all() as Array<{ ts_code: string; stock_name: string | null }>
    rows.forEach((row) => add(row.ts_code, row.stock_name))
  }
  if (template.scope.stockPoolSources.includes('trendWatchlist')) {
    const rows = db.prepare('SELECT ts_code, stock_name FROM trend_watchlist').all() as Array<{ ts_code: string; stock_name: string | null }>
    rows.forEach((row) => add(row.ts_code, row.stock_name))
  }
  if (template.scope.stockPoolSources.includes('chipMonitor')) {
    const rows = db.prepare('SELECT ts_code, stock_name FROM chip_monitor_stocks').all() as Array<{ ts_code: string; stock_name: string | null }>
    rows.forEach((row) => add(row.ts_code, row.stock_name))
  }
  for (const item of template.scope.manualStocks ?? []) add(item.tsCode, item.stockName ?? null)
  const stocks = Array.from(map.values()).sort((a, b) => a.tsCode.localeCompare(b.tsCode))
  if (!template.scope.stockPoolSources.includes('allMarket')) {
    totalStocks = stocks.length
    dailyPrefilteredStocks = stocks.length
  } else {
    dailyPrefilteredStocks = Math.max(dailyPrefilteredStocks, stocks.length)
  }
  return { stocks, totalStocks, dailyPrefilteredStocks, dailyCandidates }
}

function listScanTradeDates(db: Database.Database, dateStart: string, dateEnd: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT trade_date AS tradeDate
    FROM daily_close_cache
    WHERE trade_date BETWEEN ? AND ?
    ORDER BY trade_date ASC
  `).all(dateStart, dateEnd) as Array<{ tradeDate: string }>
  return rows.map(row => row.tradeDate)
}

function pureCode(tsCode: string): string {
  return tsCode.replace(/\.(SH|SZ|BJ)$/i, '')
}

function hasMinuteCache(db: Database.Database, tsCode: string, tradeDate: string): boolean {
  const pure = pureCode(tsCode)
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM stock_minute_cache
    WHERE (stock_code = ? OR stock_code = ?) AND trade_date = ?
    LIMIT 1
  `).get(tsCode, pure, tradeDate) as { ok: number } | undefined
  return row?.ok === 1
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ConditionBlockScanCancelledError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new ConditionBlockScanCancelledError())
    }
    signal?.addEventListener('abort', onAbort)
  })
}

interface MinuteGapFetchResult {
  status: 'success' | 'empty' | 'failed'
  capability: MinuteDataCapability | null
  bars: MinuteBarForCondition[]
}

const exactMinuteCapability: MinuteDataCapability = {
  providerId: 'stockMinuteCache1m',
  label: '本地1分钟缓存',
  source: 'localFree',
  granularity: '1m',
  historyDepthDays: null,
  coverage: 'selectedOnly',
  reliability: 'cached',
  isApproximate: false,
  requiresCredential: false,
  isCloud: false,
  enabled: true,
  note: '本地已缓存的1分钟数据',
}

async function fetchMinuteGap(db: Database.Database, tsCode: string, tradeDate: string, userTier: MinuteUserTier): Promise<MinuteGapFetchResult> {
  try {
    const routed = await fetchMinuteBarsForUserTier({
      db,
      tsCode,
      tradeDate,
      userTier,
      purpose: 'conditionBlocks',
      preferredGranularity: '1m',
      allowApproximate: true,
    })
    return {
      status: routed.status === 'success' ? 'success' : routed.status === 'empty' ? 'empty' : routed.status === 'unavailable' ? 'failed' : 'failed',
      capability: routed.capability,
      bars: routed.bars,
    }
  } catch (err) {
    const capability = getDefaultApproximateCapability()
    return { status: 'failed', capability, bars: [], message: err instanceof Error ? err.message : String(err) } as MinuteGapFetchResult
  }
}

function loadFreeApproxBars(db: Database.Database, tsCode: string, tradeDate: string, userTier: MinuteUserTier): MinuteBarForCondition[] {
  if (userTier !== 'free') return []
  return getFreeMinuteCacheByDate(db, 'sinaHistory5m', tsCode, tradeDate, '5m').map(row => ({
    tsCode: row.tsCode,
    tradeDate: row.tradeDate,
    tsMinute: row.tsMinute,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    vol: row.vol,
    amount: row.amount,
  }))
}

function createMinuteCoverages(db: Database.Database, stocks: StockCandidate[], tradeDates: string[], userTier: MinuteUserTier, onProgress?: ProgressReporter): { coverages: CandidateMinuteCoverage[]; missing: MinuteGap[]; stats: Pick<MinuteFetchStats, 'minuteCacheHitGaps' | 'minuteMissingGaps'> } {
  const coverages: CandidateMinuteCoverage[] = []
  const missing: MinuteGap[] = []
  let minuteCacheHitGaps = 0
  const totalGaps = stocks.length * tradeDates.length
  let checkedGaps = 0
  for (const stock of stocks) {
    const coverage: CandidateMinuteCoverage = {
      stock,
      requiredTradeDates: tradeDates,
      existingTradeDates: new Set<string>(),
      fetchedSuccessTradeDates: new Set<string>(),
      missingTradeDates: new Set<string>(),
      skippedTradeDates: new Set<string>(),
      failureGuardSkippedTradeDates: new Set<string>(),
      failedTradeDates: new Set<string>(),
      emptyTradeDates: new Set<string>(),
      dataCapability: null,
      approximateBarsByDate: new Map<string, MinuteBarForCondition[]>(),
      complete: tradeDates.length === 0,
      evaluated: false,
      unevaluatedReason: null,
    }
    for (const tradeDate of tradeDates) {
      checkedGaps += 1
      const cachedApproxBars = loadFreeApproxBars(db, stock.tsCode, tradeDate, userTier)
      if (hasMinuteCache(db, stock.tsCode, tradeDate)) {
        minuteCacheHitGaps += 1
        coverage.existingTradeDates.add(tradeDate)
        coverage.dataCapability = exactMinuteCapability
      } else if (cachedApproxBars.length > 0) {
        minuteCacheHitGaps += 1
        coverage.existingTradeDates.add(tradeDate)
        coverage.dataCapability = getDefaultApproximateCapability()
        coverage.approximateBarsByDate.set(tradeDate, cachedApproxBars)
      } else {
        coverage.missingTradeDates.add(tradeDate)
        missing.push({ tsCode: stock.tsCode, tradeDate })
      }
      if (checkedGaps === 1 || checkedGaps % 100 === 0 || checkedGaps === totalGaps) {
        emitProgress(onProgress, {
          stage: 'minuteCheck',
          current: checkedGaps,
          total: totalGaps,
          message: `检查分钟线缓存 ${checkedGaps}/${totalGaps}`,
          stats: { minuteCacheHitGaps, minuteMissingGaps: missing.length },
        })
      }
    }
    coverage.complete = coverage.missingTradeDates.size === 0
    coverages.push(coverage)
  }
  return { coverages, missing, stats: { minuteCacheHitGaps, minuteMissingGaps: missing.length } }
}

function findCoverage(coverageMap: Map<string, CandidateMinuteCoverage>, gap: MinuteGap): CandidateMinuteCoverage | undefined {
  return coverageMap.get(gap.tsCode)
}

function markGapSuccess(coverage: CandidateMinuteCoverage | undefined, tradeDate: string): void {
  if (!coverage) return
  coverage.fetchedSuccessTradeDates.add(tradeDate)
  coverage.missingTradeDates.delete(tradeDate)
  coverage.complete = coverage.missingTradeDates.size === 0
}

function markGapCapability(coverage: CandidateMinuteCoverage | undefined, capability: MinuteDataCapability | null): void {
  if (!coverage || !capability) return
  if (!coverage.dataCapability || (coverage.dataCapability.isApproximate && !capability.isApproximate)) {
    coverage.dataCapability = capability
  }
}

function shouldCountMinuteFailureForGuard(result: MinuteGapFetchResult, userTier: MinuteUserTier): boolean {
  if (userTier === 'free') return false
  return result.capability?.isApproximate !== true
}

function markGapSkipped(coverage: CandidateMinuteCoverage | undefined, tradeDate: string): void {
  if (!coverage) return
  coverage.skippedTradeDates.add(tradeDate)
}

function markGapSkippedByFailureGuard(coverage: CandidateMinuteCoverage | undefined, tradeDate: string): void {
  if (!coverage) return
  coverage.failureGuardSkippedTradeDates.add(tradeDate)
}

function markGapFailed(coverage: CandidateMinuteCoverage | undefined, tradeDate: string, kind: 'failed' | 'empty'): void {
  if (!coverage) return
  if (kind === 'empty') coverage.emptyTradeDates.add(tradeDate)
  else coverage.failedTradeDates.add(tradeDate)
}

function finalizeMinuteCoverages(coverages: CandidateMinuteCoverage[]): void {
  for (const coverage of coverages) {
    coverage.complete = coverage.missingTradeDates.size === 0
    if (coverage.complete) {
      coverage.unevaluatedReason = null
      continue
    }
    if (coverage.failedTradeDates.size > 0) coverage.unevaluatedReason = `分钟线补拉失败: ${Array.from(coverage.failedTradeDates).sort().join(',')}`
    else if (coverage.emptyTradeDates.size > 0) coverage.unevaluatedReason = `分钟线为空: ${Array.from(coverage.emptyTradeDates).sort().join(',')}`
    else if (coverage.failureGuardSkippedTradeDates.size > 0) coverage.unevaluatedReason = `失败保护停止补拉: ${Array.from(coverage.failureGuardSkippedTradeDates).sort().join(',')}`
    else if (coverage.skippedTradeDates.size > 0) coverage.unevaluatedReason = `分钟线补拉上限跳过: ${Array.from(coverage.skippedTradeDates).sort().join(',')}`
    else coverage.unevaluatedReason = `分钟线缺失: ${Array.from(coverage.missingTradeDates).sort().join(',')}`
  }
}

async function ensureMinuteCaches(db: Database.Database, stocks: StockCandidate[], tradeDates: string[], template: BlockStrategyTemplate, scanMode: ConditionBlockScanMode, userTier: MinuteUserTier, onProgress?: ProgressReporter, signal?: AbortSignal): Promise<{ stats: MinuteFetchStats; coverages: CandidateMinuteCoverage[] }> {
  const stats: MinuteFetchStats = {
    minuteCacheHitGaps: 0,
    minuteMissingGaps: 0,
    minuteFetchAttempted: 0,
    minuteFetchSucceeded: 0,
    minuteFetchFailed: 0,
    minuteFetchEmpty: 0,
    minuteFetchSkippedByLimit: 0,
    minuteFetchSkippedByFailureGuard: 0,
    minuteFetchStoppedByFailureGuard: false,
    approximateFetchSucceeded: 0,
  }
  const { coverages, missing, stats: cacheStats } = createMinuteCoverages(db, stocks, tradeDates, userTier, onProgress)
  stats.minuteCacheHitGaps = cacheStats.minuteCacheHitGaps
  stats.minuteMissingGaps = cacheStats.minuteMissingGaps
  const limit = getScanNumber(template.scope.autoFetchMinuteLimit, 80, 0, 500)
  const intervalMs = getScanNumber(template.scope.minuteFetchIntervalMs, 1200, 500, 10_000)
  const freeWorkerIntervalMs = Math.max(300, Math.min(500, Math.round(intervalMs / 3)))
  const stopAfterFailures = getScanNumber(template.scope.minuteFetchStopAfterFailures, 8, 1, 50)
  const selected = scanMode === 'complete' ? missing : missing.slice(0, limit)
  const coverageMap = new Map(coverages.map(coverage => [coverage.stock.tsCode, coverage]))
  stats.minuteFetchSkippedByLimit = Math.max(0, missing.length - selected.length)
  for (const gap of missing.slice(selected.length)) markGapSkipped(findCoverage(coverageMap, gap), gap.tradeDate)
  emitProgress(onProgress, {
    stage: 'minuteFetch',
    current: 0,
    total: selected.length,
    message: selected.length > 0
      ? `${scanMode === 'complete' ? '完整扫描补齐分钟线' : '快速扫描限速补拉分钟线'} 0/${selected.length}, 剩余 ${stats.minuteFetchSkippedByLimit} 个缺口因上限跳过`
      : `无需补拉分钟线, 剩余 ${stats.minuteFetchSkippedByLimit} 个缺口因上限跳过`,
    stats,
  })
  let consecutiveFailures = 0
  let completedFetchSlots = 0
  const processGap = async (gap: MinuteGap): Promise<void> => {
    throwIfCancelled(signal)
    if (hasMinuteCache(db, gap.tsCode, gap.tradeDate)) {
      stats.minuteCacheHitGaps += 1
      const coverage = findCoverage(coverageMap, gap)
      markGapSuccess(coverage, gap.tradeDate)
      markGapCapability(coverage, exactMinuteCapability)
      return
    }
    stats.minuteFetchAttempted += 1
    const result = await fetchMinuteGap(db, gap.tsCode, gap.tradeDate, userTier)
    const coverage = findCoverage(coverageMap, gap)
    if (result.status === 'success') {
      stats.minuteFetchSucceeded += 1
      if (result.capability?.isApproximate) stats.approximateFetchSucceeded += 1
      consecutiveFailures = 0
      markGapSuccess(coverage, gap.tradeDate)
      markGapCapability(coverage, result.capability)
      if (result.bars.length > 0) coverage?.approximateBarsByDate.set(gap.tradeDate, result.bars)
    } else if (result.status === 'empty') {
      stats.minuteFetchEmpty += 1
      if (shouldCountMinuteFailureForGuard(result, userTier)) consecutiveFailures += 1
      markGapCapability(coverage, result.capability)
      markGapFailed(coverage, gap.tradeDate, 'empty')
    } else {
      stats.minuteFetchFailed += 1
      if (shouldCountMinuteFailureForGuard(result, userTier)) consecutiveFailures += 1
      markGapCapability(coverage, result.capability)
      markGapFailed(coverage, gap.tradeDate, 'failed')
    }
  }
  const emitFetchProgress = (): void => {
    emitProgress(onProgress, {
      stage: 'minuteFetch',
      current: completedFetchSlots,
      total: selected.length,
      message: `补拉分钟线 ${completedFetchSlots}/${selected.length}, 成功 ${stats.minuteFetchSucceeded}, 失败 ${stats.minuteFetchFailed}, 空数据 ${stats.minuteFetchEmpty}, 上限跳过 ${stats.minuteFetchSkippedByLimit}, 失败保护跳过 ${stats.minuteFetchSkippedByFailureGuard}`,
      stats,
    })
  }
  if (userTier === 'free') {
    let nextIndex = 0
    const workerCount = Math.min(4, selected.length)
    const worker = async (): Promise<void> => {
      while (true) {
        throwIfCancelled(signal)
        const index = nextIndex
        nextIndex += 1
        if (index >= selected.length) return
        if (index >= workerCount) await delay(freeWorkerIntervalMs, signal)
        await processGap(selected[index])
        completedFetchSlots += 1
        if (completedFetchSlots === 1 || completedFetchSlots % 20 === 0 || completedFetchSlots === selected.length) emitFetchProgress()
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } else {
    for (let i = 0; i < selected.length; i += 1) {
      throwIfCancelled(signal)
      if (i > 0) await delay(intervalMs, signal)
      await processGap(selected[i])
      completedFetchSlots += 1
      if (consecutiveFailures >= stopAfterFailures) {
      stats.minuteFetchStoppedByFailureGuard = true
      const skippedByFailureGuard = selected.length - i - 1
      stats.minuteFetchSkippedByFailureGuard += skippedByFailureGuard
      for (const skipped of selected.slice(i + 1)) markGapSkippedByFailureGuard(findCoverage(coverageMap, skipped), skipped.tradeDate)
      break
      }
      emitFetchProgress()
    }
  }
  finalizeMinuteCoverages(coverages)
  return { stats, coverages }
}

function loadMinuteRows(db: Database.Database, tsCode: string, dateStart: string, dateEnd: string): MinuteBarForCondition[] {
  const pure = tsCode.replace(/\.(SH|SZ|BJ)$/i, '')
  const rows = db.prepare(`
    SELECT stock_code, trade_date, ts_minute, open, high, low, close, vol, amount
    FROM stock_minute_cache
    WHERE (stock_code = ? OR stock_code = ?) AND trade_date BETWEEN ? AND ?
    ORDER BY trade_date ASC, ts_minute ASC
  `).all(tsCode, pure, dateStart, dateEnd) as any[]
  return rows.map((row) => ({
    tsCode,
    tradeDate: row.trade_date,
    tsMinute: row.ts_minute,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    vol: row.vol,
    amount: row.amount,
  }))
}

export function resolveConditionScanMode(value: unknown): ConditionBlockScanMode {
  return value === 'quick' ? 'quick' : 'complete'
}

export const __privateForConditionBlockScanTests = {
  exactMinuteCapability,
  shouldCountMinuteFailureForGuard,
}

export async function runConditionBlockScan(db: Database.Database, templateId: number, force = false, onProgress?: ProgressReporter, scopeOverride?: ConditionBlockScanScopeOverride, scanMode: ConditionBlockScanMode = 'complete', userTier: MinuteUserTier = 'free', signal?: AbortSignal, templateOverride?: BlockStrategyTemplate): Promise<{ runId: number; cached: boolean; matchedCount: number; totalStocks: number; summary: ConditionScanSummary }> {
  throwIfCancelled(signal)
  const row = getConditionTemplate(db, templateId)
  if (!row) throw new Error('CONDITION_TEMPLATE_NOT_FOUND')
  const template = applyScopeOverride(templateOverride ? JSON.parse(JSON.stringify(templateOverride)) as BlockStrategyTemplate : JSON.parse(row.templateJson) as BlockStrategyTemplate, scopeOverride)
  const resolvedScanMode = resolveConditionScanMode(scanMode)
  const resolvedUserTier = resolveMinuteUserTier(userTier)
  if (template.scope.dateStart && template.scope.dateEnd && template.scope.dateStart > template.scope.dateEnd) {
    throw new Error('INVALID_DATE_RANGE')
  }
  const { dateStart, dateEnd } = resolveDateRange(db, template)
  const defaultApproxCapability = getDefaultApproximateCapability()
  const paramHash = computeConditionParamHash({
    ...template,
    scope: { ...template.scope, dateStart, dateEnd },
    scanMode: resolvedScanMode,
    minuteUserTier: resolvedUserTier,
    minuteDataProviderId: defaultApproxCapability.providerId,
    minuteGranularity: defaultApproxCapability.granularity,
    minuteDataApproximate: defaultApproxCapability.isApproximate,
  } as BlockStrategyTemplate & { scanMode: ConditionBlockScanMode; minuteUserTier: MinuteUserTier; minuteDataProviderId: string; minuteGranularity: MinuteDataGranularity; minuteDataApproximate: boolean })
  const existingRun = findConditionRunByParamHash(db, paramHash)
  if (!force) {
    const cached = existingRun?.status === 'completed' ? existingRun : findCompletedConditionRun(db, paramHash)
    if (cached) {
      const parsedSummary = cached.summaryJson ? JSON.parse(cached.summaryJson) as Partial<ConditionScanSummary> : {}
      return {
        runId: cached.id,
        cached: true,
        matchedCount: cached.matchedCount,
        totalStocks: cached.totalStocks,
        summary: {
          scanMode: (parsedSummary.scanMode as ConditionBlockScanMode | undefined) ?? resolvedScanMode,
          dateStart,
          dateEnd,
          totalStocks: cached.totalStocks,
          dailyPrefilteredStocks: parsedSummary.dailyPrefilteredStocks ?? cached.totalStocks,
          dailyCandidateStocks: parsedSummary.dailyCandidateStocks ?? parsedSummary.dailyPrefilteredStocks ?? cached.totalStocks,
          minuteCompleteStocks: parsedSummary.minuteCompleteStocks ?? parsedSummary.stocksWithMinuteData ?? 0,
          minuteIncompleteStocks: parsedSummary.minuteIncompleteStocks ?? 0,
          evaluatedStocks: parsedSummary.evaluatedStocks ?? parsedSummary.stocksWithMinuteData ?? 0,
          unevaluatedStocks: parsedSummary.unevaluatedStocks ?? 0,
          minuteCacheHitGaps: parsedSummary.minuteCacheHitGaps ?? 0,
          minuteMissingGaps: parsedSummary.minuteMissingGaps ?? 0,
          minuteFetchAttempted: parsedSummary.minuteFetchAttempted ?? 0,
          minuteFetchSucceeded: parsedSummary.minuteFetchSucceeded ?? 0,
          minuteFetchFailed: parsedSummary.minuteFetchFailed ?? 0,
          minuteFetchEmpty: parsedSummary.minuteFetchEmpty ?? 0,
          minuteFetchSkippedByLimit: parsedSummary.minuteFetchSkippedByLimit ?? 0,
          minuteFetchSkippedByFailureGuard: parsedSummary.minuteFetchSkippedByFailureGuard ?? 0,
          minuteFetchStoppedByFailureGuard: parsedSummary.minuteFetchStoppedByFailureGuard ?? false,
          minuteUserTier: parsedSummary.minuteUserTier ?? resolvedUserTier,
          minuteDataProviderId: parsedSummary.minuteDataProviderId ?? defaultApproxCapability.providerId,
          minuteDataProviderLabel: parsedSummary.minuteDataProviderLabel ?? defaultApproxCapability.label,
          minuteGranularity: parsedSummary.minuteGranularity ?? defaultApproxCapability.granularity,
          minuteDataSource: parsedSummary.minuteDataSource ?? defaultApproxCapability.source,
          minuteDataApproximate: parsedSummary.minuteDataApproximate ?? defaultApproxCapability.isApproximate,
          minuteExactEvaluatedStocks: parsedSummary.minuteExactEvaluatedStocks ?? 0,
          minuteApproxEvaluatedStocks: parsedSummary.minuteApproxEvaluatedStocks ?? 0,
          minuteDataQualityNote: parsedSummary.minuteDataQualityNote ?? defaultApproxCapability.note,
          stocksWithMinuteData: parsedSummary.stocksWithMinuteData ?? 0,
          evaluatedTradeDays: parsedSummary.evaluatedTradeDays ?? 0,
          minuteRows: parsedSummary.minuteRows ?? 0,
          matchedCount: cached.matchedCount,
        },
      }
    }
  }
  const runId = existingRun?.id ?? createConditionScanRun(db, {
    templateId: row.id,
    templateKey: template.key,
    templateVersion: template.version,
    dateStart,
    dateEnd,
    scopeJson: JSON.stringify({ ...template.scope, dateStart, dateEnd }),
    paramHash,
  })
  if (existingRun) resetConditionScanRun(db, runId)
  try {
    throwIfCancelled(signal)
    emitProgress(onProgress, { stage: 'prepare', current: 0, total: 1, message: '准备模板与扫描范围' })
    console.info('[conditionBlocks] scan:start', {
      runId,
      templateKey: template.key,
      version: template.version,
      dateStart,
      dateEnd,
      stockPoolSources: template.scope.stockPoolSources,
      scanMode: resolvedScanMode,
      userTier: resolvedUserTier,
    })
    const { stocks, totalStocks, dailyPrefilteredStocks, dailyCandidates } = loadStockPool(db, template, dateStart, dateEnd)
    emitProgress(onProgress, {
      stage: 'prefilter',
      current: dailyPrefilteredStocks,
      total: totalStocks,
      message: `全市场日线覆盖 ${totalStocks} 只, 日线预筛候选 ${dailyPrefilteredStocks} 只`,
      stats: { totalStocks, dailyPrefilteredStocks },
    })
    console.info('[conditionBlocks] scan:stockPool', {
      runId,
      totalStocks,
      dailyPrefilteredStocks,
      selectedStocks: stocks.length,
    })
    const tradeDates = listScanTradeDates(db, dateStart, dateEnd)
    console.info('[conditionBlocks] scan:tradeDates', { runId, tradeDates: tradeDates.length })
    const { stats: minuteStats, coverages } = await ensureMinuteCaches(db, stocks, tradeDates, template, resolvedScanMode, resolvedUserTier, onProgress, signal)
    console.info('[conditionBlocks] scan:minuteCache', { runId, ...minuteStats })
    const matches: ConditionScanMatch[] = []
    let stocksWithMinuteData = 0
    let evaluatedTradeDays = 0
    let minuteRows = 0
    const evaluableCoverages = coverages.filter(coverage => coverage.complete)
    for (const coverage of coverages) coverage.evaluated = coverage.complete
    writeDailyPrefilterDebugLog(dailyCandidates, coverages)
    const minuteCompleteStocks = evaluableCoverages.length
    const minuteIncompleteStocks = Math.max(0, coverages.length - minuteCompleteStocks)
    const unevaluatedStocks = minuteIncompleteStocks
    const evaluatedStocks = minuteCompleteStocks
    for (const coverage of evaluableCoverages) {
      if (!coverage.dataCapability) coverage.dataCapability = exactMinuteCapability
    }
    const minuteApproxEvaluatedStocks = evaluableCoverages.filter(coverage => coverage.dataCapability?.isApproximate).length
    const minuteExactEvaluatedStocks = Math.max(0, evaluableCoverages.length - minuteApproxEvaluatedStocks)
    const attemptedCapability = coverages.find(coverage => coverage.dataCapability)?.dataCapability ?? null
    const primaryCapability = minuteApproxEvaluatedStocks > 0
      ? defaultApproxCapability
      : minuteExactEvaluatedStocks > 0
        ? exactMinuteCapability
        : attemptedCapability ?? (resolvedUserTier === 'free' ? defaultApproxCapability : exactMinuteCapability)
    for (let stockIndex = 0; stockIndex < evaluableCoverages.length; stockIndex += 1) {
      throwIfCancelled(signal)
      const coverage = evaluableCoverages[stockIndex]
      const stock = coverage.stock
      const rows = [
        ...loadMinuteRows(db, stock.tsCode, dateStart, dateEnd),
        ...Array.from(coverage.approximateBarsByDate.values()).flat(),
      ].sort((a, b) => a.tradeDate === b.tradeDate ? a.tsMinute.localeCompare(b.tsMinute) : a.tradeDate.localeCompare(b.tradeDate))
      minuteRows += rows.length
      if (rows.length > 0) stocksWithMinuteData += 1
      const byDate = new Map<string, MinuteBarForCondition[]>()
      for (const item of rows) {
        const list = byDate.get(item.tradeDate) ?? []
        list.push(item)
        byDate.set(item.tradeDate, list)
      }
      for (const [tradeDate, dayRows] of byDate) {
        evaluatedTradeDays += 1
        const evaluation = evaluateConditionTemplate(template, dayRows)
        if (!evaluation.passed) continue
        const primary = evaluation.flatConditions.find((item) => item.evidence.startMinute && item.evidence.endMinute)
        matches.push({
          templateKey: template.key,
          templateVersion: template.version,
          tsCode: stock.tsCode,
          stockName: stock.stockName,
          tradeDate,
          windowStart: primary?.evidence.startMinute ?? null,
          windowEnd: primary?.evidence.endMinute ?? null,
          totalScore: evaluation.totalScore,
          dataStatus: evaluation.dataStatus,
          evidence: evaluation,
        })
      }
      if (stockIndex === 0 || (stockIndex + 1) % 20 === 0 || stockIndex === stocks.length - 1) {
        emitProgress(onProgress, {
          stage: 'evaluate',
          current: stockIndex + 1,
          total: evaluableCoverages.length,
          message: `执行分钟条件 ${stockIndex + 1}/${evaluableCoverages.length}, 已评估 ${stocksWithMinuteData} 只分钟完整股票, 未评估 ${unevaluatedStocks} 只, 命中 ${matches.length} 条`,
          stats: { minuteCompleteStocks, minuteIncompleteStocks, evaluatedStocks, unevaluatedStocks, stocksWithMinuteData, evaluatedTradeDays, minuteRows, matchedCount: matches.length },
        })
      }
    }
    throwIfCancelled(signal)
    const summary: ConditionScanSummary = {
      scanMode: resolvedScanMode,
      dateStart,
      dateEnd,
      totalStocks,
      dailyPrefilteredStocks,
      dailyCandidateStocks: stocks.length,
      minuteCompleteStocks,
      minuteIncompleteStocks,
      evaluatedStocks,
      unevaluatedStocks,
      ...minuteStats,
      minuteUserTier: resolvedUserTier,
      minuteDataProviderId: primaryCapability.providerId,
      minuteDataProviderLabel: primaryCapability.label,
      minuteGranularity: primaryCapability.granularity,
      minuteDataSource: primaryCapability.source,
      minuteDataApproximate: primaryCapability.isApproximate,
      minuteExactEvaluatedStocks,
      minuteApproxEvaluatedStocks,
      minuteDataQualityNote: primaryCapability.isApproximate ? primaryCapability.note : '本次使用1分钟精确数据评估',
      stocksWithMinuteData,
      evaluatedTradeDays,
      minuteRows,
      matchedCount: matches.length,
    }
    console.info('[conditionBlocks] scan:evaluated', {
      runId,
      stocksWithMinuteData,
      evaluatedTradeDays,
      minuteRows,
      matchedCount: matches.length,
    })
    emitProgress(onProgress, { stage: 'save', current: 0, total: 1, message: '写入扫描结果', stats: summary })
    completeConditionScanRun(db, {
      runId,
      totalStocks,
      matchedCount: matches.length,
      summaryJson: JSON.stringify(summary),
      matches,
    })
    emitProgress(onProgress, { stage: 'done', current: 1, total: 1, message: `扫描完成, 日线候选 ${stocks.length} 只, 完整评估 ${evaluatedStocks} 只, 未评估 ${unevaluatedStocks} 只, 命中 ${matches.length} 条`, stats: summary })
    console.info('[conditionBlocks] scan:done', { runId, matchedCount: matches.length })
    return { runId, cached: false, matchedCount: matches.length, totalStocks, summary }
  } catch (err) {
    emitProgress(onProgress, { stage: 'failed', current: 0, total: 1, message: err instanceof Error ? err.message : String(err) })
    console.warn('[conditionBlocks] scan:failed', {
      runId,
      templateKey: template.key,
      error: err instanceof Error ? err.message : String(err),
    })
    failConditionScanRun(db, runId, err instanceof Error ? err.message : String(err))
    throw err
  }
}

export function getConditionScanResult(db: Database.Database, runId: number) {
  return { run: getConditionScanRun(db, runId), matches: listConditionMatches(db, { runId, limit: 200 }) }
}
