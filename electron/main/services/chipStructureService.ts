import type Database from 'better-sqlite3'
import type {
  ChipMetricChange,
  ChipStructureDetail,
  ChipStructureMetricName,
  ChipStructureMissingReason,
  ChipStructurePercentUnit,
  ChipStructureSnapshot,
  ChipStructureSummary,
  CyqPerfCacheRow,
} from '../database/types'
import { listCyqPerfHistories } from '../database/cyqPerfCacheRepository'
import { queryChipHistories } from '../database/cyqChipsCacheRepository'
import {
  getLatestDailyCloseTradeDate,
  queryDailyClose,
  queryDailyCloseExact,
} from '../database/dailyCloseCacheRepository'
import { getLatestMonitorResults } from '../database/chipMonitorRepository'
import { getChipInstitutionEvidence } from './chipInstitutionEvidenceService'

export const CHIP_STRUCTURE_CONSISTENCY_THRESHOLD_PCT = 3
const CHANGE_WINDOWS = [1, 3, 5, 12] as const
const METRIC_NAMES: ChipStructureMetricName[] = [
  'winnerRate',
  'thickProfitPct',
  'thinProfitPct',
  'trappedPct',
  'deepLowPct',
  'concentration',
  'costDeviationPct',
]

export interface ChipStructureChipPoint {
  price: number
  percent: number
}

export interface ChipStructureFacts {
  latestTradeDate: string | null
  close: { tradeDate: string; value: number | null } | null
  perf: CyqPerfCacheRow | null
  chips: { tradeDate: string; points: ChipStructureChipPoint[] } | null
}

export type ChipStructureSummarySelectionPolicy = 'latest_fact' | 'latest_complete'

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function normalizeChipPercent(
  value: number | null | undefined,
  unit: ChipStructurePercentUnit,
): number | null {
  const finiteValue = finiteOrNull(value)
  if (finiteValue == null) return null
  return clampPercent(unit === 'ratio' ? finiteValue * 100 : finiteValue)
}

function sumPercentAtOrBelow(points: ChipStructureChipPoint[], boundary: number): number {
  return clampPercent(points.reduce((sum, point) => {
    if (!Number.isFinite(point.price) || !Number.isFinite(point.percent) || point.price > boundary) {
      return sum
    }
    return sum + Math.max(0, point.percent)
  }, 0))
}

function emptyMetrics(): ChipStructureSnapshot['metrics'] {
  return {
    winnerRatePct: null,
    recomputedWinnerRatePct: null,
    thickProfitPct: null,
    thinProfitPct: null,
    trappedPct: null,
    deepLowPct: null,
    costConcentration: null,
    costDeviationPct: null,
    consistencyDeviationPct: null,
  }
}

export function buildChipStructureSnapshot(facts: ChipStructureFacts): ChipStructureSnapshot {
  const missingReasons = new Set<ChipStructureMissingReason>()
  if (!facts.perf) missingReasons.add('CYQ_PERF_MISSING')
  if (!facts.chips || facts.chips.points.length === 0) missingReasons.add('CYQ_CHIPS_MISSING')
  if (!facts.close || finiteOrNull(facts.close.value) == null) missingReasons.add('DAILY_CLOSE_MISSING')

  const dates = [facts.perf?.tradeDate, facts.chips?.tradeDate, facts.close?.tradeDate].filter(
    (date): date is string => Boolean(date),
  )
  const uniqueDates = new Set(dates)
  if (uniqueDates.size > 1) missingReasons.add('DATE_MISMATCH')

  const tradeDate = uniqueDates.size === 1 ? dates[0] : null
  const freshnessStatus = tradeDate == null || facts.latestTradeDate == null
    ? 'unknown'
    : tradeDate === facts.latestTradeDate
      ? 'current'
      : 'stale'

  const hasPerf = facts.perf != null
  const hasChips = facts.chips != null && facts.chips.points.length > 0
  const hasClose = facts.close != null && finiteOrNull(facts.close.value) != null
  const sameDate = uniqueDates.size === 1
  const completenessStatus = !hasPerf && !hasChips
    ? 'blocked'
    : hasPerf && hasChips && hasClose && sameDate
      ? 'complete'
      : 'partial'

  if (!sameDate || !tradeDate) {
    return {
      tradeDate,
      metrics: emptyMetrics(),
      freshnessStatus,
      completenessStatus,
      consistencyStatus: 'not_comparable',
      missingReasons: [...missingReasons],
    }
  }

  const close = finiteOrNull(facts.close?.value)
  const winnerRatePct = facts.perf
    ? normalizeChipPercent(facts.perf.winnerRate, facts.perf.winnerRateUnit)
    : null
  const points = facts.chips?.points ?? []
  const recomputedWinnerRatePct = close == null || points.length === 0
    ? null
    : sumPercentAtOrBelow(points, close)
  const thickProfitPct = close == null || points.length === 0
    ? null
    : sumPercentAtOrBelow(points, close * 0.9)
  const thinProfitPct = winnerRatePct == null || thickProfitPct == null
    ? null
    : Math.max(winnerRatePct - thickProfitPct, 0)
  const trappedPct = winnerRatePct == null ? null : Math.max(100 - winnerRatePct, 0)
  const deepLowPct = close == null || points.length === 0
    ? null
    : sumPercentAtOrBelow(points, close * 0.8)
  const weightAvg = finiteOrNull(facts.perf?.weightAvg)
  const cost15Pct = finiteOrNull(facts.perf?.cost15Pct)
  const cost85Pct = finiteOrNull(facts.perf?.cost85Pct)
  const costConcentration = weightAvg == null || weightAvg <= 0 || cost15Pct == null || cost85Pct == null
    ? null
    : ((cost85Pct - cost15Pct) / weightAvg) * 100
  const costDeviationPct = close == null || weightAvg == null || weightAvg <= 0
    ? null
    : ((close - weightAvg) / weightAvg) * 100
  const consistencyDeviationPct = winnerRatePct == null || recomputedWinnerRatePct == null
    ? null
    : Math.abs(recomputedWinnerRatePct - winnerRatePct)
  const consistencyStatus = consistencyDeviationPct == null
    ? 'not_comparable'
    : consistencyDeviationPct <= CHIP_STRUCTURE_CONSISTENCY_THRESHOLD_PCT
      ? 'matched'
      : 'warning'

  return {
    tradeDate,
    metrics: {
      winnerRatePct,
      recomputedWinnerRatePct,
      thickProfitPct,
      thinProfitPct,
      trappedPct,
      deepLowPct,
      costConcentration,
      costDeviationPct,
      consistencyDeviationPct,
    },
    freshnessStatus,
    completenessStatus,
    consistencyStatus,
    missingReasons: [...missingReasons],
  }
}

export function selectCurrentChipStructureSnapshot(
  snapshots: ChipStructureSnapshot[],
  tradeDate?: string,
  selectionPolicy: ChipStructureSummarySelectionPolicy = 'latest_fact',
  referenceTradeDate?: string,
): ChipStructureSnapshot | undefined {
  if (tradeDate) return snapshots.find((snapshot) => snapshot.tradeDate === tradeDate)
  if (selectionPolicy === 'latest_complete') {
    const eligibleSnapshots = referenceTradeDate
      ? snapshots.filter((snapshot) => (snapshot.tradeDate ?? '') <= referenceTradeDate)
      : snapshots
    return eligibleSnapshots.filter((snapshot) => snapshot.completenessStatus === 'complete').at(-1)
      ?? eligibleSnapshots.at(-1)
  }
  return snapshots.at(-1)
}

export function normalizeChipStructureTsCode(rawCode: string): string | null {
  const code = rawCode.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
  if (!/^\d{6}$/.test(code)) return null
  if (/^(4|8|920)/.test(code)) return `${code}.BJ`
  if (/^(5|6|9)/.test(code)) return `${code}.SH`
  return `${code}.SZ`
}

function snapshotMetric(
  snapshot: ChipStructureSnapshot,
  metric: ChipStructureMetricName,
): number | null {
  switch (metric) {
    case 'winnerRate': return snapshot.metrics.winnerRatePct
    case 'thickProfitPct': return snapshot.metrics.thickProfitPct
    case 'thinProfitPct': return snapshot.metrics.thinProfitPct
    case 'trappedPct': return snapshot.metrics.trappedPct
    case 'deepLowPct': return snapshot.metrics.deepLowPct
    case 'concentration': return snapshot.metrics.costConcentration
    case 'costDeviationPct': return snapshot.metrics.costDeviationPct
  }
}

function buildChanges(
  snapshots: ChipStructureSnapshot[],
): Record<ChipStructureMetricName, ChipMetricChange[]> {
  const current = snapshots[snapshots.length - 1]
  return Object.fromEntries(METRIC_NAMES.map((metric) => [
    metric,
    CHANGE_WINDOWS.map((days) => {
      const previous = snapshots[snapshots.length - 1 - days]
      const currentValue = current ? snapshotMetric(current, metric) : null
      const previousValue = previous ? snapshotMetric(previous, metric) : null
      return previous == null || currentValue == null || previousValue == null
        ? { days, value: null, reason: 'INSUFFICIENT_HISTORY' as const }
        : { days, value: currentValue - previousValue, reason: null }
    }),
  ])) as Record<ChipStructureMetricName, ChipMetricChange[]>
}

function pickPrimaryChange(
  changes: Record<ChipStructureMetricName, ChipMetricChange[]>,
): ChipStructureSummary['primaryChange'] {
  let primary: ChipStructureSummary['primaryChange'] = null
  for (const metric of METRIC_NAMES) {
    for (const change of changes[metric]) {
      if (change.value == null) continue
      if (primary == null || Math.abs(change.value) > Math.abs(primary.value)) {
        primary = { metric, days: change.days, value: change.value }
      }
    }
  }
  return primary
}

export function buildChipMetricChanges(
  snapshots: ChipStructureSnapshot[],
): Record<ChipStructureMetricName, ChipMetricChange[]> {
  return buildChanges(snapshots)
}

function buildFactsForDate(
  tradeDate: string,
  latestTradeDate: string | null,
  closeByDate: Map<string, number>,
  chipsByDate: Map<string, ChipStructureChipPoint[]>,
  perf?: CyqPerfCacheRow | null,
): ChipStructureFacts {
  const chips = chipsByDate.get(tradeDate) ?? []
  return {
    latestTradeDate,
    close: { tradeDate, value: closeByDate.get(tradeDate) ?? null },
    perf: perf ?? null,
    chips: { tradeDate, points: chips },
  }
}

function blockedSummary(tsCode: string, stockName: string | null): ChipStructureSummary {
  return {
    tsCode,
    stockName,
    tradeDate: null,
    dateRelation: 'missing',
    winnerRate: null,
    thickProfitPct: null,
    thinProfitPct: null,
    trappedPct: null,
    deepLowPct: null,
    concentration: null,
    costDeviationPct: null,
    bottomPct: null,
    bottomAvgCost: null,
    loosening1d: null,
    loosening3d: null,
    loosening5d: null,
    pctChg: null,
    turnoverRate: null,
    primaryChange: null,
    freshnessStatus: 'unknown',
    completenessStatus: 'blocked',
    consistencyStatus: 'not_comparable',
    missingReasons: ['CYQ_PERF_MISSING', 'CYQ_CHIPS_MISSING'],
    updatedAt: null,
  }
}

export function getChipStructureDetail(
  db: Database.Database,
  rawTsCode: string,
  tradeDate?: string,
  mode: 'relative' | 'absolute' = 'relative',
  stockName: string | null = null,
): ChipStructureDetail | null {
  const tsCode = normalizeChipStructureTsCode(rawTsCode)
  if (!tsCode) return null
  const perfHistory = listCyqPerfHistories(db, [tsCode], tradeDate ? 1 : 30, tradeDate).get(tsCode) ?? []
  const chipsByDate = queryChipHistories(db, [tsCode], tradeDate ? 1 : 30, tradeDate).get(tsCode) ?? new Map()
  const latestChipsDate = [...chipsByDate.keys()].at(-1)
  const selectedTradeDate = tradeDate ?? perfHistory[perfHistory.length - 1]?.tradeDate ?? latestChipsDate
  if (!selectedTradeDate) return null

  const chipDates = tradeDate ? [tradeDate] : [...chipsByDate.keys()]
  const snapshotDates = [...new Set([
    ...perfHistory.map((perf) => perf.tradeDate),
    ...chipDates,
    selectedTradeDate,
  ])].sort()
  const dailyRows = (tradeDate
    ? queryDailyCloseExact(db, [tsCode], tradeDate)
    : queryDailyClose(db, [tsCode], snapshotDates[0])).get(tsCode) ?? []
  const closeByDate = new Map(dailyRows.map((row) => [row.tradeDate, row.close]))
  const latestTradeDate = getLatestDailyCloseTradeDate(db)
  const snapshots = snapshotDates.map((snapshotDate) => buildChipStructureSnapshot(
    buildFactsForDate(
      snapshotDate,
      latestTradeDate,
      closeByDate,
      chipsByDate,
      perfHistory.find((row) => row.tradeDate === snapshotDate) ?? null,
    ),
  ))
  const validSnapshots = snapshots.filter((snapshot) => snapshot.completenessStatus === 'complete')
  const current = selectCurrentChipStructureSnapshot(snapshots, tradeDate)
  if (!current) return null
  const perf = perfHistory.find((row) => row.tradeDate === current.tradeDate) ?? null
  const changes = buildChanges(validSnapshots.filter((snapshot) => (
    current.tradeDate == null || (snapshot.tradeDate ?? '') <= current.tradeDate
  )))
  const code6 = tsCode.split('.')[0]
  const chips = current.tradeDate ? chipsByDate.get(current.tradeDate) ?? [] : []
  const close = current.tradeDate ? closeByDate.get(current.tradeDate) ?? null : null
  const legacy = getLatestMonitorResults(db, mode).find((row) => row.tsCode.split('.')[0] === code6) ?? null
  const summary: ChipStructureSummary = {
    tsCode,
    stockName,
    tradeDate: current.tradeDate,
    dateRelation: 'missing',
    winnerRate: current.metrics.winnerRatePct,
    thickProfitPct: current.metrics.thickProfitPct,
    thinProfitPct: current.metrics.thinProfitPct,
    trappedPct: current.metrics.trappedPct,
    deepLowPct: current.metrics.deepLowPct,
    concentration: current.metrics.costConcentration,
    costDeviationPct: current.metrics.costDeviationPct,
    bottomPct: legacy?.bottomPct ?? null,
    bottomAvgCost: legacy?.bottomAvgCost ?? null,
    loosening1d: legacy?.loosening1d ?? null,
    loosening3d: legacy?.loosening3d ?? null,
    loosening5d: legacy?.loosening5d ?? null,
    pctChg: legacy?.pctChg ?? null,
    turnoverRate: legacy?.turnoverRate ?? null,
    primaryChange: pickPrimaryChange(changes),
    freshnessStatus: current.freshnessStatus,
    completenessStatus: current.completenessStatus,
    consistencyStatus: current.consistencyStatus,
    missingReasons: current.missingReasons,
    updatedAt: perf?.fetchedAt ?? null,
  }
  return {
    ...summary,
    close,
    priceRange: { historicalLow: perf?.hisLow ?? null, historicalHigh: perf?.hisHigh ?? null },
    costPercentiles: {
      cost5Pct: perf?.cost5Pct ?? null,
      cost15Pct: perf?.cost15Pct ?? null,
      cost50Pct: perf?.cost50Pct ?? null,
      cost85Pct: perf?.cost85Pct ?? null,
      cost95Pct: perf?.cost95Pct ?? null,
      weightedAvg: perf?.weightAvg ?? null,
    },
    structure: {
      winnerRateFromPerf: current.metrics.winnerRatePct,
      winnerRateFromChips: current.metrics.recomputedWinnerRatePct,
      thickProfitPct: current.metrics.thickProfitPct,
      thinProfitPct: current.metrics.thinProfitPct,
      trappedPct: current.metrics.trappedPct,
      deepLowPct: current.metrics.deepLowPct,
      concentration: current.metrics.costConcentration,
      costDeviationPct: current.metrics.costDeviationPct,
    },
    changes,
    consistency: {
      officialWinnerRate: current.metrics.winnerRatePct,
      recomputedWinnerRate: current.metrics.recomputedWinnerRatePct,
      differencePctPoint: current.metrics.consistencyDeviationPct,
      thresholdPctPoint: CHIP_STRUCTURE_CONSISTENCY_THRESHOLD_PCT,
      status: current.consistencyStatus,
      reason: current.consistencyStatus === 'warning'
        ? '官方获利比例与价格级筹码重算值偏差超过阈值'
        : current.consistencyStatus === 'not_comparable'
          ? '同日事实数据不完整，暂不可比较'
          : null,
    },
    chips,
    institutionEvidence: getChipInstitutionEvidence(db, tsCode, current.tradeDate),
    legacy: legacy ? {
      mode,
      bottomPct: legacy.bottomPct,
      bottomAvgCost: legacy.bottomAvgCost,
      loosening1d: legacy.loosening1d,
      loosening3d: legacy.loosening3d,
      loosening5d: legacy.loosening5d,
    } : null,
    sources: [
      { source: 'cyq_perf', tradeDate: perf?.tradeDate ?? null, fetchedAt: perf?.fetchedAt ?? null, status: perf ? 'available' : 'missing' },
      { source: 'cyq_chips', tradeDate: chips.length > 0 ? current.tradeDate : null, fetchedAt: null, status: chips.length > 0 ? 'available' : 'missing' },
      { source: 'daily_close', tradeDate: close != null ? current.tradeDate : null, fetchedAt: null, status: close != null ? 'available' : 'missing' },
      { source: 'chip_monitor', tradeDate: legacy?.tradeDate || null, fetchedAt: legacy?.updatedAt || null, status: legacy ? 'available' : 'missing' },
    ],
  }
}

export function getChipStructureSummary(
  db: Database.Database,
  rawTsCode: string,
  tradeDate?: string,
  stockName: string | null = null,
  mode: 'relative' | 'absolute' = 'relative',
): ChipStructureSummary {
  const tsCode = normalizeChipStructureTsCode(rawTsCode) ?? rawTsCode
  const detail = getChipStructureDetail(db, tsCode, tradeDate, mode, stockName)
  if (!detail) return blockedSummary(tsCode, stockName)
  const {
    close: _close,
    priceRange: _priceRange,
    costPercentiles: _costPercentiles,
    structure: _structure,
    changes: _changes,
    consistency: _consistency,
    chips: _chips,
    institutionEvidence: _institutionEvidence,
    legacy: _legacy,
    sources: _sources,
    ...summary
  } = detail
  return summary
}

export interface ChipStructureSummaryRequest {
  tsCode: string
  stockName?: string | null
}

/**
 * 批量生成列表摘要。只读取摘要所需事实，不装配机构证据、价格峰详情或兼容详情。
 */
export function getChipStructureSummaries(
  db: Database.Database,
  requests: ChipStructureSummaryRequest[],
  tradeDate?: string,
  selectionPolicy: ChipStructureSummarySelectionPolicy = 'latest_fact',
  referenceTradeDate?: string,
): ChipStructureSummary[] {
  const normalized = requests.flatMap((request) => {
    const tsCode = normalizeChipStructureTsCode(request.tsCode)
    return tsCode ? [{ tsCode, stockName: request.stockName ?? null }] : []
  })
  if (normalized.length === 0) return []

  const tsCodes = [...new Set(normalized.map((request) => request.tsCode))]
  const perfByCode = listCyqPerfHistories(db, tsCodes, tradeDate ? 1 : 30, tradeDate)
  const chipsByCode = queryChipHistories(db, tsCodes, tradeDate ? 1 : 30, tradeDate)
  const snapshotDatesByCode = new Map<string, string[]>()
  let earliestDate: string | null = null

  for (const tsCode of tsCodes) {
    const dates = tradeDate
      ? [tradeDate]
      : [...new Set([
          ...(perfByCode.get(tsCode) ?? []).map((perf) => perf.tradeDate),
          ...[...(chipsByCode.get(tsCode)?.keys() ?? [])],
        ])].sort()
    snapshotDatesByCode.set(tsCode, dates)
    if (dates[0] && (earliestDate == null || dates[0] < earliestDate)) earliestDate = dates[0]
  }

  const dailyByCode = tradeDate
    ? queryDailyCloseExact(db, tsCodes, tradeDate)
    : earliestDate
      ? queryDailyClose(db, tsCodes, earliestDate)
      : new Map()
  const latestTradeDate = getLatestDailyCloseTradeDate(db)
  const requestByCode = new Map(normalized.map((request) => [request.tsCode, request]))

  return tsCodes.map((tsCode) => {
    const request = requestByCode.get(tsCode)!
    const dates = snapshotDatesByCode.get(tsCode) ?? []
    if (dates.length === 0) return blockedSummary(tsCode, request.stockName)
    const perfHistory = perfByCode.get(tsCode) ?? []
    const perfByDate = new Map(perfHistory.map((perf) => [perf.tradeDate, perf]))
    const chipsByDate = chipsByCode.get(tsCode) ?? new Map()
    const closeByDate = new Map<string, number>()
    for (const row of dailyByCode.get(tsCode) ?? []) {
      if (row.close != null) closeByDate.set(row.tradeDate, row.close)
    }
    const snapshots = dates.map((date) => buildChipStructureSnapshot(buildFactsForDate(
      date,
      latestTradeDate,
      closeByDate,
      chipsByDate,
      perfByDate.get(date) ?? null,
    )))
    const validSnapshots = snapshots.filter((snapshot) => snapshot.completenessStatus === 'complete')
    const current = selectCurrentChipStructureSnapshot(
      snapshots,
      tradeDate,
      selectionPolicy,
      referenceTradeDate,
    )
    if (!current) return blockedSummary(tsCode, request.stockName)
    const changes = buildChanges(validSnapshots.filter((snapshot) => (
      current.tradeDate == null || (snapshot.tradeDate ?? '') <= current.tradeDate
    )))
    const perf = current.tradeDate ? perfByDate.get(current.tradeDate) ?? null : null
    return {
      tsCode,
      stockName: request.stockName,
      tradeDate: current.tradeDate,
      dateRelation: 'missing',
      winnerRate: current.metrics.winnerRatePct,
      thickProfitPct: current.metrics.thickProfitPct,
      thinProfitPct: current.metrics.thinProfitPct,
      trappedPct: current.metrics.trappedPct,
      deepLowPct: current.metrics.deepLowPct,
      concentration: current.metrics.costConcentration,
      costDeviationPct: current.metrics.costDeviationPct,
      bottomPct: null,
      bottomAvgCost: null,
      loosening1d: null,
      loosening3d: null,
      loosening5d: null,
      pctChg: null,
      turnoverRate: null,
      primaryChange: pickPrimaryChange(changes),
      freshnessStatus: current.freshnessStatus,
      completenessStatus: current.completenessStatus,
      consistencyStatus: current.consistencyStatus,
      missingReasons: current.missingReasons,
      updatedAt: perf?.fetchedAt ?? null,
    }
  })
}
