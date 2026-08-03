import type Database from 'better-sqlite3'
import { queryDetails } from '../../database/backtestDetailRepository'
import type { BacktestDetailRow } from '../../database/types'
import { getDataQualitySnapshot } from '../dataQualityService'
import { assessBacktestCredibility } from './credibility'
import type { BacktestCredibilityAssessment } from './types'
import { toSuffixedTsCode } from './signalSources'

export const STRATEGY_EFFECTIVENESS_HORIZONS = [1, 2, 3, 5] as const

export type StrategyEffectivenessHorizon = typeof STRATEGY_EFFECTIVENESS_HORIZONS[number]
export type StrategyEffectivenessSource = 'auction' | 'strategyLab'
export type StrategySignalDirection = 'long' | 'short'
export type StrategyEntryBasis = 'auction_925' | 'next_trade_open'
export type StrategyObservationStatus = 'valid' | 'partial' | 'data_insufficient' | 'excluded'
export type StrategyObservationMissingReason = 'ONE_WORD_LIMIT' | 'NO_ENTRY_PRICE' | 'NO_FUTURE_CLOSE' | null

type HorizonRecord = Record<'1' | '2' | '3' | '5', number | null>

export interface StrategyEffectivenessCatalogItem {
  id: string
  label: string
  description: string
  source: StrategyEffectivenessSource
  direction: StrategySignalDirection
  version: string
  entryBasis: StrategyEntryBasis
  latestRunAt: number | null
  availableDateStart: string | null
  availableDateEnd: string | null
  available: boolean
  unavailableReason: string | null
}

export interface StrategySignalObservation {
  id: string
  strategyId: string
  strategyLabel: string
  source: StrategyEffectivenessSource
  version: string
  tsCode: string
  stockName: string | null
  signalDate: string
  direction: StrategySignalDirection
  entryBasis: StrategyEntryBasis
  entryDate: string | null
  entryPrice: number | null
  score: number | null
  status: StrategyObservationStatus
  missingReason: StrategyObservationMissingReason
  returns: HorizonRecord
  benchmarkReturns: HorizonRecord
  excessReturns: HorizonRecord
}

export interface StrategyHorizonMetrics {
  horizon: StrategyEffectivenessHorizon
  validCount: number
  missingRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  winRate: number | null
  profitFactor: number | null
  dateWeightedReturn: number | null
  avgExcess: number | null
  p25: number | null
  p75: number | null
  best: number | null
  worst: number | null
}

export interface StrategyEffectivenessRanking {
  strategyId: string
  label: string
  source: StrategyEffectivenessSource
  direction: StrategySignalDirection
  version: string
  entryBasis: StrategyEntryBasis
  signalCount: number
  signalDayCount: number
  metrics: StrategyHorizonMetrics[]
}

export interface StrategyOverlap {
  leftStrategyId: string
  rightStrategyId: string
  intersectionCount: number
  unionCount: number
  overlapRate: number | null
}

export interface StrategyEffectivenessResult {
  generatedAt: number
  dateRange: { start: string; end: string }
  horizons: typeof STRATEGY_EFFECTIVENESS_HORIZONS
  selectedStrategyIds: string[]
  catalog: StrategyEffectivenessCatalogItem[]
  rankings: StrategyEffectivenessRanking[]
  overlaps: StrategyOverlap[]
  observations: StrategySignalObservation[]
  credibility: BacktestCredibilityAssessment
  coverage: {
    totalSignals: number
    validSignals: number
    partialSignals: number
    excludedSignals: number
    insufficientSignals: number
    truncated: boolean
    note: string
  }
}

export interface StrategyEffectivenessRequest {
  dateStart: string
  dateEnd: string
  strategyIds?: string[]
  excludeUntradeable?: boolean
}

interface LatestStrategyLabRun {
  runId: number
  strategyId: number
  strategyKey: string
  strategyName: string
  description: string | null
  runConfigJson: string
  currentVersion: number
  completedAt: number | null
}

interface StrategyLabMatch {
  id: number
  runId: number
  strategyId: number
  strategyKey: string
  tsCode: string
  stockName: string | null
  tradeDate: string
  score: number | null
  actionJson: string | null
  evidenceJson: string | null
}

interface DailyPriceRow {
  tsCode: string
  tradeDate: string
  open: number | null
  close: number
}

const AUCTION_POOLS = ['firstBoard', 'secondBoard', 'brokenBoard', 'brokenConsec'] as const

const AUCTION_CATALOG: Array<{
  id: string
  label: string
  description: string
  pools: BacktestDetailRow['pool'][]
}> = [
  {
    id: 'auction.threeOne',
    label: '板票竞价双第一',
    description: '聚合首板、二板及以上、炸板封回和断板四个板票竞价池。',
    pools: [...AUCTION_POOLS],
  },
  { id: 'auction.firstBoard', label: '首板竞价', description: '前一交易日首板且竞价满足既有阈值。', pools: ['firstBoard'] },
  { id: 'auction.secondBoard', label: '二板及以上竞价', description: '前一交易日二板及以上且竞价满足既有阈值。', pools: ['secondBoard'] },
  { id: 'auction.brokenBoard', label: '炸板封回竞价', description: '前一交易日涨停开板后封回且竞价满足既有阈值。', pools: ['brokenBoard'] },
  { id: 'auction.brokenConsec', label: '断板竞价', description: '前一交易日断板且历史连板次数满足既有阈值。', pools: ['brokenConsec'] },
  { id: 'auction.allMarket', label: '竞价全市场异动', description: '复用早盘竞价全市场异动筛选结果。', pools: ['allMarket'] },
]

const EMPTY_HORIZONS = (): HorizonRecord => ({ '1': null, '2': null, '3': null, '5': null })

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) as { present: number } | undefined
  return row?.present === 1
}

function finiteOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function average(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null
}

function percentile(sortedValues: number[], percentileValue: number): number | null {
  if (sortedValues.length === 0) return null
  if (sortedValues.length === 1) return round(sortedValues[0])
  const index = (sortedValues.length - 1) * percentileValue
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const weight = index - lower
  return round(sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight)
}

function directionAdjustedReturn(direction: StrategySignalDirection, entryPrice: number | null, close: number | null): number | null {
  if (!entryPrice || entryPrice <= 0 || !close || close <= 0) return null
  const longReturn = ((close - entryPrice) / entryPrice) * 100
  return round(direction === 'short' ? -longReturn : longReturn)
}

function directionFromPayload(actionJson: string | null, evidenceJson: string | null): StrategySignalDirection {
  for (const raw of [actionJson, evidenceJson]) {
    if (!raw) continue
    try {
      const value = JSON.parse(raw) as { direction?: unknown }
      if (value?.direction === 'short' || value?.direction === 'bearish' || value?.direction === 'down') return 'short'
    } catch {
      // 损坏的可选方向元数据不影响命中事实，按首批看多口径处理。
    }
  }
  return 'long'
}

function normalizeTsCode(tsCode: string): string {
  return toSuffixedTsCode(tsCode) ?? tsCode
}

function indexCodeForStock(tsCode: string): string {
  const normalized = normalizeTsCode(tsCode)
  const [code, exchange] = normalized.split('.')
  if (exchange === 'SH') return code.startsWith('688') ? '000688.SH' : '000001.SH'
  if (exchange === 'SZ') return code.startsWith('3') ? '399006.SZ' : '399001.SZ'
  return '000001.SH'
}

function parseStrategyVersion(run: LatestStrategyLabRun): string {
  try {
    const parsed = JSON.parse(run.runConfigJson) as { strategyVersion?: unknown }
    const version = finiteOrNull(parsed.strategyVersion)
    if (version != null) return `v${Math.max(1, Math.round(version))} · 运行 #${run.runId}`
  } catch {
    // 历史运行配置损坏时仍使用策略当前版本作为可见降级口径。
  }
  return `v${Math.max(1, run.currentVersion)} · 运行 #${run.runId}`
}

function latestStrategyLabRuns(db: Database.Database): LatestStrategyLabRun[] {
  if (!tableExists(db, 'strategy_lab_runs') || !tableExists(db, 'strategy_lab_strategies')) return []
  const rows = db.prepare(`
    SELECT
      r.id AS run_id,
      r.strategy_id,
      r.strategy_key,
      r.strategy_name,
      r.run_config_json,
      r.completed_at,
      s.description,
      s.version AS current_version
    FROM strategy_lab_runs r
    JOIN strategy_lab_strategies s ON s.id = r.strategy_id
    WHERE r.status = 'completed'
      AND r.id = (
        SELECT r2.id
        FROM strategy_lab_runs r2
        WHERE r2.strategy_id = r.strategy_id AND r2.status = 'completed'
        ORDER BY COALESCE(r2.completed_at, r2.created_at) DESC, r2.id DESC
        LIMIT 1
      )
    ORDER BY COALESCE(r.completed_at, r.created_at) DESC, r.id DESC
  `).all() as Array<{
    run_id: number
    strategy_id: number
    strategy_key: string
    strategy_name: string
    description: string | null
    run_config_json: string
    current_version: number
    completed_at: number | null
  }>
  return rows.map(row => ({
    runId: row.run_id,
    strategyId: row.strategy_id,
    strategyKey: row.strategy_key,
    strategyName: row.strategy_name,
    description: row.description,
    runConfigJson: row.run_config_json,
    currentVersion: row.current_version,
    completedAt: row.completed_at,
  }))
}

function auctionCatalog(db: Database.Database): StrategyEffectivenessCatalogItem[] {
  const availablePools = new Map<string, { count: number; latestAt: number | null; dateStart: string | null; dateEnd: string | null }>()
  if (tableExists(db, 'stk_auction_backtest_detail')) {
    const rows = db.prepare(`
      SELECT pool, COUNT(*) AS count, MAX(computed_at) AS latest_at,
             MIN(trade_date) AS date_start, MAX(trade_date) AS date_end
      FROM stk_auction_backtest_detail
      GROUP BY pool
    `).all() as Array<{ pool: string; count: number; latest_at: number | null; date_start: string | null; date_end: string | null }>
    for (const row of rows) {
      availablePools.set(row.pool, {
        count: row.count,
        latestAt: row.latest_at,
        dateStart: row.date_start,
        dateEnd: row.date_end,
      })
    }
  }
  return AUCTION_CATALOG.map(item => {
    const available = item.pools.some(pool => (availablePools.get(pool)?.count ?? 0) > 0)
    const latestRunAt = item.pools.reduce<number | null>((latest, pool) => {
      const candidate = availablePools.get(pool)?.latestAt ?? null
      return candidate != null && (latest == null || candidate > latest) ? candidate : latest
    }, null)
    const availableDateStart = item.pools.reduce<string | null>((earliest, pool) => {
      const candidate = availablePools.get(pool)?.dateStart ?? null
      return candidate != null && (earliest == null || candidate < earliest) ? candidate : earliest
    }, null)
    const availableDateEnd = item.pools.reduce<string | null>((latest, pool) => {
      const candidate = availablePools.get(pool)?.dateEnd ?? null
      return candidate != null && (latest == null || candidate > latest) ? candidate : latest
    }, null)
    return {
      id: item.id,
      label: item.label,
      description: item.description,
      source: 'auction' as const,
      direction: 'long' as const,
      version: '竞价规则 v1',
      entryBasis: 'auction_925' as const,
      latestRunAt,
      availableDateStart,
      availableDateEnd,
      available,
      unavailableReason: available ? null : '尚无竞价历史明细',
    }
  })
}

function strategyLabCatalog(db: Database.Database, runs: LatestStrategyLabRun[]): StrategyEffectivenessCatalogItem[] {
  if (!tableExists(db, 'strategy_lab_strategies')) return []
  const latestRunByStrategy = new Map(runs.map(run => [run.strategyId, run]))
  const runRanges = new Map<number, { dateStart: string | null; dateEnd: string | null }>()
  if (runs.length > 0 && tableExists(db, 'strategy_lab_matches')) {
    const placeholders = runs.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT run_id, MIN(trade_date) AS date_start, MAX(trade_date) AS date_end
      FROM strategy_lab_matches
      WHERE run_id IN (${placeholders})
      GROUP BY run_id
    `).all(...runs.map(run => run.runId)) as Array<{ run_id: number; date_start: string | null; date_end: string | null }>
    for (const row of rows) runRanges.set(row.run_id, { dateStart: row.date_start, dateEnd: row.date_end })
  }
  const strategies = db.prepare(`
    SELECT id, strategy_key, name, description, version
    FROM strategy_lab_strategies
    WHERE status != 'disabled' AND enabled = 1
    ORDER BY updated_at DESC, id DESC
  `).all() as Array<{ id: number; strategy_key: string; name: string; description: string | null; version: number }>
  return strategies.map(strategy => {
    const run = latestRunByStrategy.get(strategy.id)
    const range = run ? runRanges.get(run.runId) : undefined
    return {
      id: `strategyLab.${strategy.strategy_key}`,
      label: strategy.name,
      description: strategy.description ?? '策略实验室最近完成运行的真实命中。',
      source: 'strategyLab',
      direction: 'long',
      version: run ? parseStrategyVersion(run) : `v${Math.max(1, strategy.version)} · 尚未运行`,
      entryBasis: 'next_trade_open',
      latestRunAt: run?.completedAt ?? null,
      availableDateStart: range?.dateStart ?? null,
      availableDateEnd: range?.dateEnd ?? null,
      available: Boolean(run),
      unavailableReason: run ? null : '尚无完成运行，请先在策略实验室运行该策略',
    }
  })
}

function defaultStrategyIds(catalog: StrategyEffectivenessCatalogItem[]): string[] {
  const selected: string[] = []
  if (catalog.some(item => item.id === 'auction.threeOne' && item.available)) selected.push('auction.threeOne')
  if (catalog.some(item => item.id === 'auction.allMarket' && item.available)) selected.push('auction.allMarket')
  selected.push(...catalog.filter(item => item.source === 'strategyLab' && item.available).slice(0, 6).map(item => item.id))
  if (selected.length === 0) selected.push(...catalog.filter(item => item.available).slice(0, 6).map(item => item.id))
  return selected
}

function observationStatus(returns: HorizonRecord): Pick<StrategySignalObservation, 'status' | 'missingReason'> {
  const values = STRATEGY_EFFECTIVENESS_HORIZONS.map(horizon => returns[String(horizon) as keyof HorizonRecord])
  const validCount = values.filter(value => value != null).length
  if (validCount === 0) return { status: 'data_insufficient', missingReason: 'NO_FUTURE_CLOSE' }
  if (validCount < STRATEGY_EFFECTIVENESS_HORIZONS.length) return { status: 'partial', missingReason: 'NO_FUTURE_CLOSE' }
  return { status: 'valid', missingReason: null }
}

function auctionObservations(
  db: Database.Database,
  dateStart: string,
  dateEnd: string,
  selected: Set<string>,
  catalogById: Map<string, StrategyEffectivenessCatalogItem>,
  excludeUntradeable: boolean,
): StrategySignalObservation[] {
  if (!tableExists(db, 'stk_auction_backtest_detail') || ![...selected].some(id => id.startsWith('auction.'))) return []
  const rows = queryDetails(db, { startDate: dateStart, endDate: dateEnd })
  const observations: StrategySignalObservation[] = []
  const seen = new Set<string>()
  for (const catalogItem of AUCTION_CATALOG) {
    if (!selected.has(catalogItem.id)) continue
    const catalog = catalogById.get(catalogItem.id)
    if (!catalog) continue
    for (const row of rows) {
      if (!catalogItem.pools.includes(row.pool)) continue
      const dedupeKey = `${catalogItem.id}:${row.tradeDate}:${row.tsCode}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const rawReturns: HorizonRecord = {
        '1': finiteOrNull(row.ret1d),
        '2': finiteOrNull(row.ret2d),
        '3': finiteOrNull(row.ret3d),
        '5': finiteOrNull(row.ret5d),
      }
      const benchmarkReturns: HorizonRecord = {
        '1': finiteOrNull(row.idxRet1d),
        '2': finiteOrNull(row.idxRet2d),
        '3': finiteOrNull(row.idxRet3d),
        '5': finiteOrNull(row.idxRet5d),
      }
      const excessReturns = EMPTY_HORIZONS()
      for (const horizon of STRATEGY_EFFECTIVENESS_HORIZONS) {
        const key = String(horizon) as keyof HorizonRecord
        excessReturns[key] = rawReturns[key] != null && benchmarkReturns[key] != null
          ? round(rawReturns[key] - benchmarkReturns[key])
          : null
      }
      const excluded = excludeUntradeable && row.isOneWord === 1
      const baseStatus = observationStatus(rawReturns)
      observations.push({
        id: dedupeKey,
        strategyId: catalogItem.id,
        strategyLabel: catalog.label,
        source: 'auction',
        version: catalog.version,
        tsCode: normalizeTsCode(row.tsCode),
        stockName: row.stockName ?? null,
        signalDate: row.tradeDate,
        direction: 'long',
        entryBasis: 'auction_925',
        entryDate: row.tradeDate,
        entryPrice: finiteOrNull(row.buyPrice),
        score: null,
        status: excluded ? 'excluded' : (row.buyPrice == null ? 'data_insufficient' : baseStatus.status),
        missingReason: excluded ? 'ONE_WORD_LIMIT' : (row.buyPrice == null ? 'NO_ENTRY_PRICE' : baseStatus.missingReason),
        returns: rawReturns,
        benchmarkReturns,
        excessReturns,
      })
    }
  }
  return observations
}

function loadStrategyLabMatches(
  db: Database.Database,
  runs: LatestStrategyLabRun[],
  dateStart: string,
  dateEnd: string,
): StrategyLabMatch[] {
  if (runs.length === 0 || !tableExists(db, 'strategy_lab_matches')) return []
  const placeholders = runs.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT id, run_id, strategy_id, strategy_key, ts_code, stock_name, trade_date,
           score, action_json, evidence_json
    FROM strategy_lab_matches
    WHERE run_id IN (${placeholders}) AND trade_date BETWEEN ? AND ?
    ORDER BY trade_date DESC, score DESC, id DESC
  `).all(...runs.map(run => run.runId), dateStart, dateEnd) as Array<{
    id: number
    run_id: number
    strategy_id: number
    strategy_key: string
    ts_code: string
    stock_name: string | null
    trade_date: string
    score: number | null
    action_json: string | null
    evidence_json: string | null
  }>
  return rows.map(row => ({
    id: row.id,
    runId: row.run_id,
    strategyId: row.strategy_id,
    strategyKey: row.strategy_key,
    tsCode: normalizeTsCode(row.ts_code),
    stockName: row.stock_name,
    tradeDate: row.trade_date,
    score: finiteOrNull(row.score),
    actionJson: row.action_json,
    evidenceJson: row.evidence_json,
  }))
}

function loadDailyPrices(db: Database.Database, tsCodes: string[], dateStart: string): Map<string, DailyPriceRow[]> {
  const result = new Map<string, DailyPriceRow[]>()
  if (tsCodes.length === 0 || !tableExists(db, 'daily_close_cache')) return result
  const uniqueCodes = [...new Set(tsCodes.map(normalizeTsCode))]
  for (let offset = 0; offset < uniqueCodes.length; offset += 400) {
    const chunk = uniqueCodes.slice(offset, offset + 400)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT ts_code, trade_date, open, close
      FROM daily_close_cache
      WHERE ts_code IN (${placeholders}) AND trade_date >= ?
      ORDER BY ts_code ASC, trade_date ASC
    `).all(...chunk, dateStart) as Array<{ ts_code: string; trade_date: string; open: number | null; close: number }>
    for (const row of rows) {
      const code = normalizeTsCode(row.ts_code)
      const list = result.get(code) ?? []
      list.push({ tsCode: code, tradeDate: row.trade_date, open: finiteOrNull(row.open), close: row.close })
      result.set(code, list)
    }
  }
  return result
}

function loadStockNames(db: Database.Database, tsCodes: string[]): Map<string, string> {
  const result = new Map<string, string>()
  const uniqueCodes = [...new Set(tsCodes.map(normalizeTsCode))]
  if (uniqueCodes.length === 0) return result
  if (tableExists(db, 'stock_basic_cache')) {
    for (let offset = 0; offset < uniqueCodes.length; offset += 400) {
      const chunk = uniqueCodes.slice(offset, offset + 400)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db.prepare(`SELECT ts_code, name FROM stock_basic_cache WHERE ts_code IN (${placeholders})`).all(...chunk) as Array<{ ts_code: string; name: string }>
      for (const row of rows) if (row.name) result.set(normalizeTsCode(row.ts_code), row.name)
    }
  }
  if (tableExists(db, 'stock_info')) {
    const pureCodes = uniqueCodes.map(code => code.slice(0, 6))
    for (let offset = 0; offset < pureCodes.length; offset += 400) {
      const chunk = pureCodes.slice(offset, offset + 400)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = db.prepare(`SELECT stockCode, stockName FROM stock_info WHERE stockCode IN (${placeholders})`).all(...chunk) as Array<{ stockCode: string; stockName: string }>
      for (const row of rows) {
        const code = normalizeTsCode(row.stockCode)
        if (row.stockName && !result.has(code)) result.set(code, row.stockName)
      }
    }
  }
  return result
}

function strategyLabObservations(
  db: Database.Database,
  runs: LatestStrategyLabRun[],
  dateStart: string,
  dateEnd: string,
  selected: Set<string>,
  catalogById: Map<string, StrategyEffectivenessCatalogItem>,
): StrategySignalObservation[] {
  const selectedRuns = runs.filter(run => selected.has(`strategyLab.${run.strategyKey}`))
  const matches = loadStrategyLabMatches(db, selectedRuns, dateStart, dateEnd)
  if (matches.length === 0) return []
  const indexCodes = matches.map(match => indexCodeForStock(match.tsCode))
  const priceMap = loadDailyPrices(db, [...matches.map(match => match.tsCode), ...indexCodes], dateStart)
  const stockNames = loadStockNames(db, matches.map(match => match.tsCode))
  const runById = new Map(selectedRuns.map(run => [run.runId, run]))
  const observations: StrategySignalObservation[] = []
  const seen = new Set<string>()

  for (const match of matches) {
    const run = runById.get(match.runId)
    if (!run) continue
    const strategyId = `strategyLab.${run.strategyKey}`
    const catalog = catalogById.get(strategyId)
    if (!catalog) continue
    const dedupeKey = `${strategyId}:${match.tradeDate}:${match.tsCode}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const direction = directionFromPayload(match.actionJson, match.evidenceJson)
    const prices = priceMap.get(match.tsCode) ?? []
    const entryIndex = prices.findIndex(row => row.tradeDate > match.tradeDate && row.open != null && row.open > 0)
    const entry = entryIndex >= 0 ? prices[entryIndex] : null
    const returns = EMPTY_HORIZONS()
    const benchmarkReturns = EMPTY_HORIZONS()
    const excessReturns = EMPTY_HORIZONS()
    const indexPrices = priceMap.get(indexCodeForStock(match.tsCode)) ?? []
    const indexEntry = entry ? indexPrices.find(row => row.tradeDate === entry.tradeDate && row.open != null && row.open > 0) ?? null : null

    if (entry?.open) {
      for (const horizon of STRATEGY_EFFECTIVENESS_HORIZONS) {
        const key = String(horizon) as keyof HorizonRecord
        const target = prices[entryIndex + horizon - 1] ?? null
        returns[key] = directionAdjustedReturn(direction, entry.open, target?.close ?? null)
        const benchmarkTarget = target ? indexPrices.find(row => row.tradeDate === target.tradeDate) ?? null : null
        benchmarkReturns[key] = directionAdjustedReturn(direction, indexEntry?.open ?? null, benchmarkTarget?.close ?? null)
        excessReturns[key] = returns[key] != null && benchmarkReturns[key] != null
          ? round(returns[key] - benchmarkReturns[key])
          : null
      }
    }

    const baseStatus = observationStatus(returns)
    observations.push({
      id: dedupeKey,
      strategyId,
      strategyLabel: catalog.label,
      source: 'strategyLab',
      version: catalog.version,
      tsCode: match.tsCode,
      stockName: match.stockName ?? stockNames.get(match.tsCode) ?? null,
      signalDate: match.tradeDate,
      direction,
      entryBasis: 'next_trade_open',
      entryDate: entry?.tradeDate ?? null,
      entryPrice: entry?.open ?? null,
      score: match.score,
      status: entry?.open ? baseStatus.status : 'data_insufficient',
      missingReason: entry?.open ? baseStatus.missingReason : 'NO_ENTRY_PRICE',
      returns,
      benchmarkReturns,
      excessReturns,
    })
  }
  return observations
}

function metricsForHorizon(observations: StrategySignalObservation[], horizon: StrategyEffectivenessHorizon): StrategyHorizonMetrics {
  const key = String(horizon) as keyof HorizonRecord
  const eligible = observations.filter(observation => observation.status !== 'excluded')
  const values = eligible.map(observation => observation.returns[key]).filter((value): value is number => value != null)
  const sorted = [...values].sort((left, right) => left - right)
  const gains = values.filter(value => value > 0)
  const losses = values.filter(value => value < 0)
  const dayGroups = new Map<string, number[]>()
  for (const observation of eligible) {
    const value = observation.returns[key]
    if (value == null) continue
    const valuesForDay = dayGroups.get(observation.signalDate) ?? []
    valuesForDay.push(value)
    dayGroups.set(observation.signalDate, valuesForDay)
  }
  const dayAverages = [...dayGroups.values()].map(group => average(group)).filter((value): value is number => value != null)
  const excessValues = eligible.map(observation => observation.excessReturns[key]).filter((value): value is number => value != null)
  const lossTotal = Math.abs(losses.reduce((sum, value) => sum + value, 0))
  const gainTotal = gains.reduce((sum, value) => sum + value, 0)
  return {
    horizon,
    validCount: values.length,
    missingRate: observations.length > 0 ? round((observations.length - values.length) / observations.length) : null,
    avgReturn: average(values),
    medianReturn: percentile(sorted, 0.5),
    winRate: values.length > 0 ? round(gains.length / values.length) : null,
    profitFactor: lossTotal > 0 ? round(gainTotal / lossTotal) : null,
    dateWeightedReturn: average(dayAverages),
    avgExcess: average(excessValues),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    best: sorted.length > 0 ? round(sorted[sorted.length - 1]) : null,
    worst: sorted.length > 0 ? round(sorted[0]) : null,
  }
}

export function aggregateStrategyEffectiveness(
  catalog: StrategyEffectivenessCatalogItem[],
  selectedStrategyIds: string[],
  observations: StrategySignalObservation[],
): { rankings: StrategyEffectivenessRanking[]; overlaps: StrategyOverlap[] } {
  const catalogById = new Map(catalog.map(item => [item.id, item]))
  const rankings = selectedStrategyIds.map(strategyId => {
    const catalogItem = catalogById.get(strategyId)
    const strategyObservations = observations.filter(observation => observation.strategyId === strategyId)
    const observedDirections = [...new Set(strategyObservations.map(observation => observation.direction))]
    return {
      strategyId,
      label: catalogItem?.label ?? strategyId,
      source: catalogItem?.source ?? 'strategyLab',
      direction: observedDirections.length === 1 ? observedDirections[0] : (catalogItem?.direction ?? 'long'),
      version: catalogItem?.version ?? '未知版本',
      entryBasis: catalogItem?.entryBasis ?? 'next_trade_open',
      signalCount: strategyObservations.length,
      signalDayCount: new Set(strategyObservations.map(observation => observation.signalDate)).size,
      metrics: STRATEGY_EFFECTIVENESS_HORIZONS.map(horizon => metricsForHorizon(strategyObservations, horizon)),
    } satisfies StrategyEffectivenessRanking
  })

  const signalSets = new Map(selectedStrategyIds.map(strategyId => [
    strategyId,
    new Set(observations.filter(observation => observation.strategyId === strategyId).map(observation => `${observation.signalDate}:${observation.tsCode}`)),
  ]))
  const overlaps: StrategyOverlap[] = []
  for (let leftIndex = 0; leftIndex < selectedStrategyIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectedStrategyIds.length; rightIndex += 1) {
      const leftStrategyId = selectedStrategyIds[leftIndex]
      const rightStrategyId = selectedStrategyIds[rightIndex]
      const left = signalSets.get(leftStrategyId) ?? new Set<string>()
      const right = signalSets.get(rightStrategyId) ?? new Set<string>()
      const intersectionCount = [...left].filter(key => right.has(key)).length
      const unionCount = new Set([...left, ...right]).size
      overlaps.push({
        leftStrategyId,
        rightStrategyId,
        intersectionCount,
        unionCount,
        overlapRate: unionCount > 0 ? round(intersectionCount / unionCount) : null,
      })
    }
  }
  return { rankings, overlaps }
}

export function evaluateStrategySignals(
  db: Database.Database,
  request: StrategyEffectivenessRequest,
): StrategyEffectivenessResult {
  const latestRuns = latestStrategyLabRuns(db)
  const catalog = [...auctionCatalog(db), ...strategyLabCatalog(db, latestRuns)]
  const catalogById = new Map(catalog.map(item => [item.id, item]))
  const requestedIds = request.strategyIds === undefined ? defaultStrategyIds(catalog) : [...new Set(request.strategyIds)]
  const selectedStrategyIds = requestedIds.filter(id => catalogById.has(id)).slice(0, 20)
  const selected = new Set(selectedStrategyIds)
  const observations = [
    ...auctionObservations(db, request.dateStart, request.dateEnd, selected, catalogById, request.excludeUntradeable !== false),
    ...strategyLabObservations(db, latestRuns, request.dateStart, request.dateEnd, selected, catalogById),
  ].sort((left, right) => right.signalDate.localeCompare(left.signalDate) || left.strategyLabel.localeCompare(right.strategyLabel, 'zh-CN') || left.tsCode.localeCompare(right.tsCode))
  const { rankings, overlaps } = aggregateStrategyEffectiveness(catalog, selectedStrategyIds, observations)
  const limitedObservations = observations.slice(0, 1000)
  const selectedCatalog = selectedStrategyIds.map(id => catalogById.get(id)).filter((item): item is StrategyEffectivenessCatalogItem => item != null)
  const selectedRangeNote = selectedCatalog
    .filter(item => item.availableDateStart && item.availableDateEnd)
    .map(item => `${item.label} ${item.availableDateStart}-${item.availableDateEnd}`)
    .join('；')
  const credibility = assessBacktestCredibility({
    dataQuality: getDataQualitySnapshot(db),
    observations: observations.map(observation => ({
      signalDate: observation.signalDate,
      entryDate: observation.entryDate,
      exitDate: null,
      returnPct: observation.returns['1'],
      valid: observation.returns['1'] != null,
      entryBasis: observation.entryBasis,
    })),
    strategyCount: selectedStrategyIds.length,
    executionProfile: 'effectiveness',
  }).assessment
  return {
    generatedAt: Date.now(),
    dateRange: { start: request.dateStart, end: request.dateEnd },
    horizons: STRATEGY_EFFECTIVENESS_HORIZONS,
    selectedStrategyIds,
    catalog,
    rankings,
    overlaps,
    observations: limitedObservations,
    credibility,
    coverage: {
      totalSignals: observations.length,
      validSignals: observations.filter(observation => observation.status === 'valid').length,
      partialSignals: observations.filter(observation => observation.status === 'partial').length,
      excludedSignals: observations.filter(observation => observation.status === 'excluded').length,
      insufficientSignals: observations.filter(observation => observation.status === 'data_insufficient').length,
      truncated: observations.length > limitedObservations.length,
      note: observations.length === 0
        ? `所选日期和策略没有可评估信号；评估不会把空样本记为0收益。${selectedRangeNote ? ` 本地已有范围：${selectedRangeNote}。` : ''}`
        : '按策略、股票和信号日去重；策略实验室只使用每个策略最近完成运行。',
    },
  }
}
