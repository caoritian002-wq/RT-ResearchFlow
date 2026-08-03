import type Database from 'better-sqlite3'
import { queryDecisionSignalsByTimeRange } from '../database/decisionSignalsRepository'
import type {
  DecisionSignalResolution,
  DecisionSignalRow,
  DecisionSignalSourceModule,
  DecisionSignalStatus,
  DecisionSignalType,
} from '../database/types'
import { listPortfolioStocks } from '../database/portfolioRepository'

export interface DecisionReviewStatsQuery {
  rangeDays?: number
  sourceModules?: DecisionSignalSourceModule[]
  types?: DecisionSignalType[]
  tsCode?: string
  limit?: number
}

export interface DecisionReviewSignalItem {
  id: number
  sourceModule: DecisionSignalSourceModule
  strategyKey: string
  tsCode: string | null
  stockName: string | null
  conceptCode: string | null
  conceptName: string | null
  signalType: DecisionSignalType
  direction: DecisionSignalRow['direction']
  priority: number
  score: number | null
  confidence: number | null
  title: string
  summary: string
  reasonJson: string | null
  sourceRefJson: string | null
  status: DecisionSignalStatus
  signalTime: number
  firstSeenAt: number | null
  lastSeenAt: number | null
  occurrenceCount: number
  resolution: DecisionSignalResolution | null
  resolutionNote: string | null
}

export interface DecisionReviewStats {
  rangeDays: number
  startTime: number
  endTime: number
  sampleSize: number
  summary: {
    total: number
    resolved: number
    watching: number
    dismissed: number
    unresolved: number
    readUnresolved: number
    repeated: number
  }
  bySource: Partial<Record<DecisionSignalSourceModule, number>>
  byType: Partial<Record<DecisionSignalType, number>>
  byResolution: Partial<Record<DecisionSignalResolution, number>>
  byPriority: Record<'P1' | 'P2' | 'P3' | 'P4' | 'P5', number>
  noiseSuggestions: DecisionReviewNoiseSuggestion[]
  pendingReview: DecisionReviewSignalItem[]
  repeatedSignals: DecisionReviewSignalItem[]
}

export interface DecisionReviewNoiseSuggestion {
  id: string
  level: 'high' | 'medium' | 'low'
  targetType: 'source' | 'strategy' | 'review' | 'data'
  title: string
  summary: string
  metric: string
  actionLabel: string
  sourceModule?: DecisionSignalSourceModule
  strategyKey?: string
}

export interface DecisionHistorySignalsQuery extends DecisionReviewStatsQuery {
  statuses?: DecisionSignalStatus[]
  portfolioOnly?: boolean
  offset?: number
  tradeDate?: string
}

export interface DecisionHistorySignalsResult {
  rangeDays: number
  startTime: number
  endTime: number
  total: number
  offset: number
  limit: number
  items: DecisionReviewSignalItem[]
  availableDates: string[]
  selectedTradeDate: string | null
}

export interface DecisionPortfolioRiskReviewItem {
  tsCode: string
  stockName: string
  costPrice: number | null
  totalSignals: number
  riskSignals: number
  unresolvedSignals: number
  repeatedSignals: number
  latestSignal: DecisionReviewSignalItem | null
}

export interface DecisionPortfolioRiskReview {
  rangeDays: number
  totalPortfolio: number
  missingCostPrice: number
  withRiskSignals: number
  unresolvedRiskSignals: number
  repeatedRiskSignals: number
  items: DecisionPortfolioRiskReviewItem[]
}

export function getDecisionReviewStats(db: Database.Database, query: DecisionReviewStatsQuery = {}): DecisionReviewStats {
  const rangeDays = clampInt(query.rangeDays ?? 30, 1, 180)
  const limit = clampInt(query.limit ?? 8, 1, 50)
  const endTime = Date.now()
  const startTime = endTime - rangeDays * 24 * 60 * 60 * 1000
  const signals = queryDecisionSignalsByTimeRange(db, startTime, endTime, {
    sourceModules: query.sourceModules,
    types: query.types,
    tsCode: normalizeTsCode(query.tsCode),
    limit: 5000,
  })

  const bySource: Partial<Record<DecisionSignalSourceModule, number>> = {}
  const byType: Partial<Record<DecisionSignalType, number>> = {}
  const byResolution: Partial<Record<DecisionSignalResolution, number>> = {}
  const byPriority: DecisionReviewStats['byPriority'] = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 }
  const summary = {
    total: signals.length,
    resolved: 0,
    watching: 0,
    dismissed: 0,
    unresolved: 0,
    readUnresolved: 0,
    repeated: 0,
  }

  for (const signal of signals) {
    bySource[signal.sourceModule] = (bySource[signal.sourceModule] ?? 0) + 1
    byType[signal.signalType] = (byType[signal.signalType] ?? 0) + 1
    const priorityKey = `P${clampInt(signal.priority, 1, 5)}` as keyof DecisionReviewStats['byPriority']
    byPriority[priorityKey] += 1
    if (signal.resolution) {
      summary.resolved += 1
      byResolution[signal.resolution] = (byResolution[signal.resolution] ?? 0) + 1
    }
    if (signal.status === 'WATCHING') summary.watching += 1
    if (signal.status === 'DISMISSED') summary.dismissed += 1
    if (!signal.resolution && signal.status !== 'DISMISSED' && signal.status !== 'EXPIRED') summary.unresolved += 1
    if (!signal.resolution && signal.status === 'READ') summary.readUnresolved += 1
    if ((signal.occurrenceCount ?? 1) > 1) summary.repeated += 1
  }

  const pendingReview = signals
    .filter(signal => !signal.resolution && (signal.status === 'WATCHING' || signal.status === 'READ' || signal.status === 'NEW'))
    .sort((a, b) => reviewSortScore(b) - reviewSortScore(a))
    .slice(0, limit)
    .map(toReviewItem)

  const repeatedSignals = signals
    .filter(signal => (signal.occurrenceCount ?? 1) > 1)
    .sort((a, b) => {
      const countDelta = (b.occurrenceCount ?? 1) - (a.occurrenceCount ?? 1)
      if (countDelta !== 0) return countDelta
      if (b.priority !== a.priority) return b.priority - a.priority
      return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
    })
    .slice(0, limit)
    .map(toReviewItem)
  const noiseSuggestions = buildNoiseSuggestions(signals, summary)

  return {
    rangeDays,
    startTime,
    endTime,
    sampleSize: signals.length,
    summary,
    bySource,
    byType,
    byResolution,
    byPriority,
    noiseSuggestions,
    pendingReview,
    repeatedSignals,
  }
}

export function getDecisionHistorySignals(db: Database.Database, query: DecisionHistorySignalsQuery = {}): DecisionHistorySignalsResult {
  const rangeDays = clampInt(query.rangeDays ?? 30, 1, 180)
  const limit = clampInt(query.limit ?? 30, 1, 100)
  const offset = Math.max(0, clampInt(query.offset ?? 0, 0, 10000))
  const endTime = Date.now()
  const startTime = endTime - rangeDays * 24 * 60 * 60 * 1000
  let signals = queryDecisionSignalsByTimeRange(db, startTime, endTime, {
    sourceModules: query.sourceModules,
    statuses: query.statuses,
    types: query.types,
    tsCode: normalizeTsCode(query.tsCode),
    limit: 5000,
  })
  if (query.portfolioOnly) {
    const portfolioCodes = new Set(listPortfolioStocks(db).map(item => normalizeStockCode(item.tsCode)).filter(Boolean) as string[])
    signals = signals.filter(signal => signal.tsCode != null && portfolioCodes.has(normalizeStockCode(signal.tsCode)))
  }
  const availableDates = [...new Set(signals.map(signal => formatBjDate(signal.signalTime)))].sort().reverse()
  const requestedTradeDate = normalizeTradeDate(query.tradeDate)
  const selectedSignals = requestedTradeDate
    ? signals.filter(signal => formatBjDate(signal.signalTime) === requestedTradeDate)
    : signals
  const total = selectedSignals.length
  const items = selectedSignals.slice(offset, offset + limit).map(toReviewItem)
  return {
    rangeDays,
    startTime,
    endTime,
    total,
    offset,
    limit,
    items,
    availableDates,
    selectedTradeDate: requestedTradeDate,
  }
}

export function getDecisionPortfolioRiskReview(db: Database.Database, query: DecisionReviewStatsQuery = {}): DecisionPortfolioRiskReview {
  const rangeDays = clampInt(query.rangeDays ?? 30, 1, 180)
  const limit = clampInt(query.limit ?? 12, 1, 50)
  const endTime = Date.now()
  const startTime = endTime - rangeDays * 24 * 60 * 60 * 1000
  const portfolio = listPortfolioStocks(db)
  const portfolioMap = new Map(portfolio.map(item => [normalizeStockCode(item.tsCode), item]))
  const signals = queryDecisionSignalsByTimeRange(db, startTime, endTime, { limit: 5000 })
    .filter(signal => signal.tsCode != null && portfolioMap.has(normalizeStockCode(signal.tsCode)))

  const grouped = new Map<string, DecisionSignalRow[]>()
  for (const signal of signals) {
    const key = normalizeStockCode(signal.tsCode ?? '')
    if (!key) continue
    const list = grouped.get(key) ?? []
    list.push(signal)
    grouped.set(key, list)
  }

  const items: DecisionPortfolioRiskReviewItem[] = portfolio.map(stock => {
    const key = normalizeStockCode(stock.tsCode)
    const list = grouped.get(key) ?? []
    const riskSignals = list.filter(isRiskSignal)
    const unresolved = riskSignals.filter(signal => !signal.resolution && signal.status !== 'DISMISSED' && signal.status !== 'EXPIRED')
    const repeated = riskSignals.filter(signal => (signal.occurrenceCount ?? 1) > 1)
    const latest = [...list].sort((a, b) => b.signalTime - a.signalTime)[0]
    return {
      tsCode: stock.tsCode,
      stockName: stock.stockName,
      costPrice: stock.costPrice,
      totalSignals: list.length,
      riskSignals: riskSignals.length,
      unresolvedSignals: unresolved.length,
      repeatedSignals: repeated.length,
      latestSignal: latest ? toReviewItem(latest) : null,
    }
  }).sort((a, b) => {
    const riskDelta = b.unresolvedSignals - a.unresolvedSignals
    if (riskDelta !== 0) return riskDelta
    const repeatedDelta = b.repeatedSignals - a.repeatedSignals
    if (repeatedDelta !== 0) return repeatedDelta
    return b.riskSignals - a.riskSignals
  }).slice(0, limit)

  return {
    rangeDays,
    totalPortfolio: portfolio.length,
    missingCostPrice: portfolio.filter(item => item.costPrice == null).length,
    withRiskSignals: items.filter(item => item.riskSignals > 0).length,
    unresolvedRiskSignals: items.reduce((sum, item) => sum + item.unresolvedSignals, 0),
    repeatedRiskSignals: items.reduce((sum, item) => sum + item.repeatedSignals, 0),
    items,
  }
}

function toReviewItem(signal: DecisionSignalRow): DecisionReviewSignalItem {
  return {
    id: signal.id,
    sourceModule: signal.sourceModule,
    strategyKey: signal.strategyKey,
    tsCode: signal.tsCode,
    stockName: signal.stockName,
    conceptCode: signal.conceptCode,
    conceptName: signal.conceptName,
    signalType: signal.signalType,
    direction: signal.direction,
    priority: signal.priority,
    score: signal.score,
    confidence: signal.confidence,
    title: signal.title,
    summary: signal.summary,
    reasonJson: signal.reasonJson,
    sourceRefJson: signal.sourceRefJson,
    status: signal.status,
    signalTime: signal.signalTime,
    firstSeenAt: signal.firstSeenAt,
    lastSeenAt: signal.lastSeenAt,
    occurrenceCount: signal.occurrenceCount,
    resolution: signal.resolution,
    resolutionNote: signal.resolutionNote,
  }
}

function reviewSortScore(signal: DecisionSignalRow): number {
  const statusWeight = signal.status === 'WATCHING' ? 300 : signal.status === 'NEW' ? 180 : 120
  const repeatedWeight = Math.min(signal.occurrenceCount ?? 1, 10) * 12
  return statusWeight + signal.priority * 30 + repeatedWeight + signal.signalTime / 1_000_000_000
}

function buildNoiseSuggestions(signals: DecisionSignalRow[], summary: DecisionReviewStats['summary']): DecisionReviewNoiseSuggestion[] {
  const suggestions: DecisionReviewNoiseSuggestion[] = []
  const sourceMap = new Map<DecisionSignalSourceModule, { total: number; dismissed: number; invalid: number; duplicate: number; repeated: number }>()
  const strategyMap = new Map<string, { total: number; dismissed: number; repeated: number; sourceModule: DecisionSignalSourceModule }>()
  for (const signal of signals) {
    const source = sourceMap.get(signal.sourceModule) ?? { total: 0, dismissed: 0, invalid: 0, duplicate: 0, repeated: 0 }
    source.total += 1
    if (signal.status === 'DISMISSED') source.dismissed += 1
    if (signal.resolution === 'RESOLVED_INVALID') source.invalid += 1
    if (signal.resolution === 'RESOLVED_DUPLICATE') source.duplicate += 1
    if ((signal.occurrenceCount ?? 1) > 1) source.repeated += 1
    sourceMap.set(signal.sourceModule, source)

    const strategyKey = `${signal.sourceModule}:${signal.strategyKey}`
    const strategy = strategyMap.get(strategyKey) ?? { total: 0, dismissed: 0, repeated: 0, sourceModule: signal.sourceModule }
    strategy.total += 1
    if (signal.status === 'DISMISSED') strategy.dismissed += 1
    if ((signal.occurrenceCount ?? 1) > 1) strategy.repeated += 1
    strategyMap.set(strategyKey, strategy)
  }

  for (const [sourceModule, item] of sourceMap) {
    if (item.total < 3) continue
    const dismissRate = item.dismissed / item.total
    const invalidRate = (item.invalid + item.duplicate) / item.total
    if (dismissRate >= 0.45 || invalidRate >= 0.35) {
      suggestions.push({
        id: `source-${sourceModule}`,
        level: dismissRate >= 0.6 || invalidRate >= 0.5 ? 'high' : 'medium',
        targetType: 'source',
        sourceModule,
        title: `${sourceModule} 来源需要降噪复核`,
        summary: '该来源在当前样本中忽略、误报或重复占比较高, 建议先检查触发阈值和上下文缺口。',
        metric: `${item.dismissed}/${item.total} 已忽略, ${item.invalid + item.duplicate} 条被标记为误报或重复`,
        actionLabel: '查看历史信号',
      })
    }
  }

  for (const [strategyKey, item] of strategyMap) {
    if (item.total < 3) continue
    const repeatRate = item.repeated / item.total
    if (repeatRate >= 0.5) {
      suggestions.push({
        id: `strategy-${strategyKey}`,
        level: repeatRate >= 0.75 ? 'high' : 'medium',
        targetType: 'strategy',
        sourceModule: item.sourceModule,
        strategyKey: strategyKey.split(':').slice(1).join(':'),
        title: '重复触发策略需要合并或抬高阈值',
        summary: '同一策略重复出现较多, 可能适合合并同日同股提醒、延长冷却时间或提高优先级门槛。',
        metric: `${item.repeated}/${item.total} 条重复触发`,
        actionLabel: '查看重复项',
      })
    }
  }

  if (summary.unresolved >= 8 || (summary.total >= 10 && summary.unresolved / Math.max(summary.total, 1) >= 0.45)) {
    suggestions.push({
      id: 'review-backlog',
      level: summary.unresolved >= 15 ? 'high' : 'medium',
      targetType: 'review',
      title: '待复盘信号积压',
      summary: '当前仍有较多关注中或未处置的信号, 建议先按持仓和风险优先收口。',
      metric: `${summary.unresolved} 条待复盘`,
      actionLabel: '处理待复盘',
    })
  }

  return suggestions.sort((a, b) => levelScore(b.level) - levelScore(a.level)).slice(0, 6)
}

function isRiskSignal(signal: DecisionSignalRow): boolean {
  return signal.signalType === 'RISK' || signal.direction === 'BEARISH' || signal.priority >= 4
}

function normalizeStockCode(value: string): string {
  return value.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function levelScore(level: DecisionReviewNoiseSuggestion['level']): number {
  if (level === 'high') return 3
  if (level === 'medium') return 2
  return 1
}

function normalizeTsCode(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeTradeDate(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const compact = value.trim().replace(/-/g, '')
  if (!/^\d{8}$/.test(compact)) return null
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  const day = Number(compact.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

function formatBjDate(timeMs: number): string {
  const bj = new Date(timeMs + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}
