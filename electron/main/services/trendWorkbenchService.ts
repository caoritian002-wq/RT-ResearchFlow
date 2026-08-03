import type Database from 'better-sqlite3'
import { queryStockOHLCV } from '../database/dailyCloseCacheRepository'
import { getCachedPrices } from '../database/stockPriceCacheRepository'
import {
  getTrendAlerts,
  getTrendScoreComputationSnapshot,
  getTrendScoreSnapshot,
  type TrendScoreDetail,
} from './trendWatchlistService'
import {
  classifyTrendState,
  computeTrendScoreV2,
  computeWindowReturn,
  type TrendOhlcvBar,
  type TrendScoreComputation,
  type TrendState,
} from './trendScoreModel'
import { inspectTrendBenchmarkHealth, type TrendBenchmarkHealth } from './trendBenchmarkFreshness'

export interface TrendWorkbenchScorePoint {
  tradeDate: string
  totalScore: number
}

export interface TrendWorkbenchItem extends Omit<TrendScoreDetail, 'category' | 'subCategory' | 'groupTag' | 'notes'> {
  stockCode: string
  categories: string[]
  subCategories: string[]
  groupTags: string[]
  notes: string[]
  scoreDelta5d: number | null
  scoreDelta20d: number | null
  trendState: TrendState
  scoreHistory: TrendWorkbenchScorePoint[]
  dataCoverage: {
    bars: number
    requiredBars: number
    latestTradeDate: string | null
    state: 'ready' | 'partial' | 'missing'
  }
  dimensions: TrendScoreComputation['dimensions'] | null
  facts: TrendScoreComputation['facts'] | null
  benchmarkHealth: TrendBenchmarkHealth
}

export interface TrendWorkbenchEvent {
  id: number | undefined
  tsCode: string
  stockCode: string
  stockName: string
  alertType: string
  kind: 'risk' | 'opportunity'
  alertDate: string
  triggerPrice: number | null
  referencePrice: number | null
  currentPrice: number | null
  changeSinceTrigger: number | null
  createdAt: number
  isPortfolio: boolean
  currentState: 'active' | 'recovered' | 'unknown'
}

export interface TrendWorkbenchSnapshot {
  generatedAt: number
  items: TrendWorkbenchItem[]
  events: TrendWorkbenchEvent[]
  dataHealth: {
    total: number
    ready: number
    partial: number
    missing: number
    latestTradeDate: string | null
    benchmark: TrendBenchmarkHealth
  }
}

export function getTrendWorkbench(db: Database.Database, now = Date.now()): TrendWorkbenchSnapshot {
  const details = getTrendScoreSnapshot(db)
  const grouped = groupDetails(details)
  const startDate = offsetYmd(-760)
  const benchmarkBars = loadBars(db, '000300.SH', startDate)
  const benchmarkHealth = inspectTrendBenchmarkHealth(db, now)
  const items = [...grouped.values()].map((group) => buildWorkbenchItem(db, group, benchmarkBars, benchmarkHealth, startDate))
  const itemByCode = new Map(items.map((item) => [normalizeTsCode(item.tsCode), item]))
  const events = getTrendAlerts(db, 90).map((event) => buildEvent(event, itemByCode.get(normalizeTsCode(event.tsCode))))
  const latestTradeDate = items
    .map((item) => item.dataCoverage.latestTradeDate)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null

  return {
    generatedAt: Date.now(),
    items,
    events,
    dataHealth: {
      total: items.length,
      ready: items.filter((item) => item.dataCoverage.state === 'ready').length,
      partial: items.filter((item) => item.dataCoverage.state === 'partial').length,
      missing: items.filter((item) => item.dataCoverage.state === 'missing').length,
      latestTradeDate,
      benchmark: benchmarkHealth,
    },
  }
}

interface DetailGroup {
  primary: TrendScoreDetail
  categories: Set<string>
  subCategories: Set<string>
  groupTags: Set<string>
  notes: Set<string>
}

function groupDetails(details: TrendScoreDetail[]): Map<string, DetailGroup> {
  const groups = new Map<string, DetailGroup>()
  for (const detail of details) {
    const key = normalizeTsCode(detail.tsCode)
    const current = groups.get(key) ?? {
      primary: detail,
      categories: new Set<string>(),
      subCategories: new Set<string>(),
      groupTags: new Set<string>(),
      notes: new Set<string>(),
    }
    addNonEmpty(current.categories, detail.category)
    addNonEmpty(current.subCategories, detail.subCategory)
    addNonEmpty(current.groupTags, detail.groupTag)
    addNonEmpty(current.notes, detail.notes)
    if (detail.isPortfolio && !current.primary.isPortfolio) current.primary = detail
    groups.set(key, current)
  }
  return groups
}

function buildWorkbenchItem(
  db: Database.Database,
  group: DetailGroup,
  benchmarkBars: DatedBar[],
  benchmarkHealth: TrendBenchmarkHealth,
  startDate: string,
): TrendWorkbenchItem {
  const primary = group.primary
  const stockBars = loadBars(db, primary.tsCode, startDate)
  const history = buildRollingHistory(stockBars, benchmarkBars)
  const currentComputation = getTrendScoreComputationSnapshot(primary.tsCode)
    ?? computeLatest(stockBars, benchmarkBars, primary.price)
  const scoreHistory = mergeCurrentScore(history, primary.scoreDate, primary.totalScore)
  const scoreDelta5d = scoreDelta(scoreHistory, 5)
  const scoreDelta20d = scoreDelta(scoreHistory, 20)
  const bars = stockBars.length
  const latestTradeDate = stockBars.at(-1)?.tradeDate ?? null

  return {
    ...primary,
    stockCode: stripSuffix(primary.tsCode),
    categories: [...group.categories],
    subCategories: [...group.subCategories],
    groupTags: [...group.groupTags],
    notes: [...group.notes],
    scoreDelta5d,
    scoreDelta20d,
    trendState: classifyTrendState(primary.totalScore, primary.maAbove60, scoreDelta5d),
    scoreHistory,
    dataCoverage: {
      bars,
      requiredBars: 60,
      latestTradeDate,
      state: bars >= 60 ? 'ready' : bars >= 20 ? 'partial' : 'missing',
    },
    dimensions: currentComputation?.dimensions ?? null,
    facts: currentComputation?.facts ?? null,
    benchmarkHealth,
  }
}

interface DatedBar extends TrendOhlcvBar {
  tradeDate: string
}

function loadBars(db: Database.Database, tsCode: string, startDate: string): DatedBar[] {
  const daily = queryStockOHLCV(db, normalizeTsCode(tsCode), startDate)
  if (daily.length > 0) {
    return daily.map((bar) => ({
      tradeDate: bar.tradeDate,
      close: bar.close,
      high: bar.high ?? bar.close,
      low: bar.low ?? bar.close,
      vol: bar.vol,
      turnoverRate: bar.turnoverRate,
    }))
  }
  return getCachedPrices(db, stripSuffix(tsCode))
    .filter((bar) => bar.tradeDate >= startDate && (bar.close ?? 0) > 0)
    .map((bar) => ({
      tradeDate: bar.tradeDate,
      close: bar.close ?? 0,
      high: bar.high ?? bar.close ?? 0,
      low: bar.low ?? bar.close ?? 0,
      vol: bar.volume,
      turnoverRate: null,
    }))
}

function buildRollingHistory(stockBars: DatedBar[], benchmarkBars: DatedBar[]): TrendWorkbenchScorePoint[] {
  if (stockBars.length < 20) return []
  const result: TrendWorkbenchScorePoint[] = []
  const firstIndex = Math.max(19, stockBars.length - 90)
  let benchmarkIndex = 0
  for (let index = firstIndex; index < stockBars.length; index += 1) {
    const tradeDate = stockBars[index].tradeDate
    while (benchmarkIndex < benchmarkBars.length && benchmarkBars[benchmarkIndex].tradeDate <= tradeDate) {
      benchmarkIndex += 1
    }
    const benchmarkCloses = benchmarkBars.slice(0, benchmarkIndex).map((bar) => bar.close)
    const benchmarkReturn = computeWindowReturn(benchmarkCloses, 20)
    const computation = computeTrendScoreV2(stockBars.slice(0, index + 1), benchmarkReturn)
    if (computation.score.totalScore == null) continue
    result.push({ tradeDate, totalScore: computation.score.totalScore })
  }
  return result.slice(-90)
}

function computeLatest(
  stockBars: DatedBar[],
  benchmarkBars: DatedBar[],
  realtimePrice: number | null,
): TrendScoreComputation | null {
  if (stockBars.length < 20) return null
  const tradeDate = stockBars.at(-1)?.tradeDate ?? ''
  const benchmarkCloses = benchmarkBars.filter((bar) => bar.tradeDate <= tradeDate).map((bar) => bar.close)
  return computeTrendScoreV2(stockBars, computeWindowReturn(benchmarkCloses, 20), realtimePrice)
}

function mergeCurrentScore(
  history: TrendWorkbenchScorePoint[],
  scoreDate: string,
  totalScore: number | null,
): TrendWorkbenchScorePoint[] {
  if (!scoreDate || totalScore == null) return history
  const next = history.filter((point) => point.tradeDate !== scoreDate)
  next.push({ tradeDate: scoreDate, totalScore })
  return next.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)).slice(-90)
}

function scoreDelta(history: TrendWorkbenchScorePoint[], periods: number): number | null {
  if (history.length <= periods) return null
  const latest = history.at(-1)?.totalScore
  const prior = history[history.length - 1 - periods]?.totalScore
  return latest == null || prior == null ? null : latest - prior
}

function buildEvent(
  event: ReturnType<typeof getTrendAlerts>[number],
  current: TrendWorkbenchItem | undefined,
): TrendWorkbenchEvent {
  const currentPrice = current?.price ?? null
  const changeSinceTrigger = currentPrice != null && event.price != null && event.price > 0
    ? (currentPrice - event.price) / event.price * 100
    : null
  return {
    id: event.id,
    tsCode: event.tsCode,
    stockCode: stripSuffix(event.tsCode),
    stockName: event.stockName,
    alertType: event.alertType,
    kind: event.alertType === 'BREAK_HIGH20' ? 'opportunity' : 'risk',
    alertDate: event.alertDate,
    triggerPrice: event.price,
    referencePrice: event.refPrice,
    currentPrice,
    changeSinceTrigger,
    createdAt: event.createdAt,
    isPortfolio: current?.isPortfolio ?? false,
    currentState: deriveEventState(event.alertType, currentPrice, event.refPrice, current?.maAbove60 ?? null),
  }
}

export function deriveEventState(
  alertType: string,
  currentPrice: number | null,
  referencePrice: number | null,
  maAbove60: boolean | null,
): TrendWorkbenchEvent['currentState'] {
  if (alertType === 'BREAK_MA60') {
    return maAbove60 == null ? 'unknown' : maAbove60 ? 'recovered' : 'active'
  }
  if (currentPrice == null || referencePrice == null || referencePrice <= 0) return 'unknown'
  if (alertType === 'BREAK_HIGH20') return currentPrice >= referencePrice ? 'active' : 'recovered'
  if (alertType === 'STOP_LOSS_5PCT') return currentPrice <= referencePrice * 0.95 ? 'active' : 'recovered'
  return 'unknown'
}

function addNonEmpty(target: Set<string>, value: string): void {
  const trimmed = value.trim()
  if (trimmed) target.add(trimmed)
}

function normalizeTsCode(tsCode: string): string {
  const clean = tsCode.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(clean)) return clean
  const code = stripSuffix(clean)
  if (/^(600|601|603|605|688|900|110|113|118|127|128|129|131|132)/.test(code)) return `${code}.SH`
  if (/^(430|830|87|88|89|92)/.test(code)) return `${code}.BJ`
  return `${code}.SZ`
}

function stripSuffix(tsCode: string): string {
  return tsCode.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function offsetYmd(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}
