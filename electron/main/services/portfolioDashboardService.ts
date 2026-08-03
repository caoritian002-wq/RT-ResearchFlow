import type Database from 'better-sqlite3'
import type { DecisionSignalRow, TrendForecastRow } from '../database/types'
import { listPortfolioStocks } from '../database/portfolioRepository'
import { listForecasts } from '../database/trendForecastRepository'
import { getTodayDecisionSignals } from './decisionSignalService'
import { getTrendScoreSnapshot, type TrendScoreDetail } from './trendWatchlistService'
import { getConceptSource } from '../database/settingsRepository'
import { getConceptsByStockRouted } from './conceptRouter'
import { computeSectorFlowSnapshot } from './sectorFlowService'
import { buildLatestChipSummaryMap, type ChipSummary } from './chipSummaryService'

export type PortfolioPositionAdvice = 'HOLD' | 'WATCH' | 'TAKE_PROFIT' | 'STOP_LOSS'

export interface PortfolioDashboardItem {
  tsCode: string
  stockCode: string
  stockName: string
  addedAt: number
  costPrice: number | null
  price: number | null
  change: number | null
  profitPct: number | null
  positionAdvice: PortfolioPositionAdvice | null
  positionAdviceReason: string | null
  chip: ChipSummary | null
  trend: {
    totalScore: number | null
    maScore: number | null
    maAbove60: boolean | null
    drawdown: number | null
    macdAboveZero: boolean | null
    bollAboveMid: boolean | null
    dataSource: 'realtime' | 'eod' | null
    dataTime: string | null
  }
  forecast: {
    id: number
    provider: string
    model: string | null
    targetDate: string | null
    direction: string | null
    summary: string | null
    createdAt: number
    backtestDirection: string | null
    backtestMape: number | null
  } | null
  todaySignals: {
    count: number
    maxPriority: number | null
    latestTitle: string | null
    latestSignalTime: number | null
  }
  news: Array<{
    briefingId: number
    title: string
    impactLevel: string | null
    publishedAt: number | null
  }>
  supplyChain: {
    chainGroup: string | null
    eventType: string | null
    direction: string | null
    confidence: number | null
    topNodes: string[]
  } | null
  sectorFlow: {
    conceptName: string
    metricMode: 'verified_flow' | 'turnover_strength'
    mainNetInflow: number | null
    mainNetInflowRate: number | null
    previousMainNetInflow: number | null
    turnoverDirectionStrength: number | null
    weightedChange: number | null
  } | null
}

export interface PortfolioDashboardResult {
  items: PortfolioDashboardItem[]
  total: number
}

export async function getPortfolioDashboard(
  db: Database.Database,
  options: { limit?: number; offset?: number } = {}
): Promise<PortfolioDashboardResult> {
  const allPositions = listPortfolioStocks(db)
  const offset = clampInt(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = clampInt(options.limit ?? allPositions.length, 1, 500)
  const positions = allPositions.slice(offset, offset + limit)

  const trendByCode = new Map<string, TrendScoreDetail>()
  for (const item of getTrendScoreSnapshot(db)) {
    for (const code of codeKeys(item.tsCode)) trendByCode.set(code, item)
  }

  const todaySignals = getTodayDecisionSignals(db, { portfolioOnly: true, limit: 500 })
  const signalsByCode = groupSignals(todaySignals)
  const sectorSnapshot = await getSectorSnapshot(db)
  const conceptSource = getConceptSource()
  const chipByCode = safeBuildLatestChipSummaryMap(db)

  const items = positions.map((position) => {
    const stockCode = stripTsSuffix(position.tsCode)
    const trend = findByCode(trendByCode, position.tsCode)
    const signals = findByCode(signalsByCode, position.tsCode) ?? []
    const forecast = pickLatestForecast(db, position.tsCode)
    const concepts = safeGetConcepts(db, position.tsCode, conceptSource)
    const conceptNames = concepts
      .map((c) => c.conceptName)
      .filter((name): name is string => Boolean(name))
    const sectorFlow = findSectorFlow(conceptNames, sectorSnapshot)
    return {
      tsCode: position.tsCode,
      stockCode,
      stockName: position.stockName,
      addedAt: position.addedAt,
      costPrice: position.costPrice,
      price: trend?.price ?? null,
      change: trend?.change ?? null,
      profitPct: trend?.profitPct ?? null,
      positionAdvice: trend?.positionAdvice ?? null,
      positionAdviceReason: trend?.positionAdviceReason ?? null,
      chip: findByCode(chipByCode, position.tsCode) ?? null,
      trend: {
        totalScore: trend?.totalScore ?? null,
        maScore: trend?.maScore ?? null,
        maAbove60: trend?.maAbove60 ?? null,
        drawdown: trend?.drawdown ?? null,
        macdAboveZero: trend?.macdAboveZero ?? null,
        bollAboveMid: trend?.bollAboveMid ?? null,
        dataSource: trend?.dataSource ?? null,
        dataTime: trend?.dataTime || null,
      },
      forecast,
      todaySignals: summarizeSignals(signals),
      news: findRelatedNews(db, position.tsCode, position.stockName),
      supplyChain: buildSupplyChainSummary(conceptNames),
      sectorFlow,
    } satisfies PortfolioDashboardItem
  })

  return { items, total: allPositions.length }
}

function groupSignals(signals: DecisionSignalRow[]): Map<string, DecisionSignalRow[]> {
  const map = new Map<string, DecisionSignalRow[]>()
  for (const signal of signals) {
    if (!signal.tsCode) continue
    for (const key of codeKeys(signal.tsCode)) {
      const arr = map.get(key) ?? []
      arr.push(signal)
      map.set(key, arr)
    }
  }
  return map
}

function safeBuildLatestChipSummaryMap(db: Database.Database): Map<string, ChipSummary> {
  try {
    return buildLatestChipSummaryMap(db)
  } catch (err) {
    console.warn('[PortfolioDashboard] chip summary failed:', err)
    return new Map()
  }
}

function summarizeSignals(signals: DecisionSignalRow[]): PortfolioDashboardItem['todaySignals'] {
  if (signals.length === 0) {
    return { count: 0, maxPriority: null, latestTitle: null, latestSignalTime: null }
  }
  const sorted = [...signals].sort((a, b) => b.signalTime - a.signalTime)
  return {
    count: signals.length,
    maxPriority: Math.max(...signals.map((s) => s.priority)),
    latestTitle: sorted[0]?.title ?? null,
    latestSignalTime: sorted[0]?.signalTime ?? null,
  }
}

function pickLatestForecast(db: Database.Database, tsCode: string): PortfolioDashboardItem['forecast'] {
  const candidates = codeKeys(tsCode)
    .flatMap((code) => listForecasts(db, code, 5))
    .sort((a, b) => b.createdAt - a.createdAt)
  const latest = candidates[0]
  if (!latest) return null
  return {
    id: latest.id,
    provider: latest.provider ?? 'unknown',
    model: latest.model ?? null,
    targetDate: inferForecastTargetDate(latest),
    direction: latest.direction ?? null,
    summary: buildForecastSummary(latest),
    createdAt: latest.createdAt,
    backtestDirection: latest.backtestDirection == null ? null : latest.backtestDirection === 1 ? 'correct' : 'wrong',
    backtestMape: latest.backtestMAPE ?? null,
  }
}

function buildForecastSummary(forecast: TrendForecastRow): string | null {
  const parts: string[] = []
  if (forecast.direction) parts.push(`方向 ${forecast.direction}`)
  if (forecast.confidence != null) parts.push(`置信度 ${forecast.confidence}`)
  if (forecast.keySupport != null) parts.push(`支撑 ${forecast.keySupport.toFixed(2)}`)
  if (forecast.keyResistance != null) parts.push(`压力 ${forecast.keyResistance.toFixed(2)}`)
  return parts.length ? parts.join(' · ') : null
}

function inferForecastTargetDate(forecast: TrendForecastRow): string | null {
  const bj = new Date(forecast.createdAt + 8 * 60 * 60 * 1000)
  if (forecast.type === 'morrow') bj.setUTCDate(bj.getUTCDate() + 1)
  return `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, '0')}${String(bj.getUTCDate()).padStart(2, '0')}`
}

function findRelatedNews(db: Database.Database, tsCode: string, stockName: string): PortfolioDashboardItem['news'] {
  const code = stripTsSuffix(tsCode)
  const keywords = [stockName, code].map((x) => x.trim()).filter(Boolean)
  if (keywords.length === 0) return []
  const rows = db
    .prepare(`
      SELECT id, title, summary, impactRating, publishedAt
      FROM briefings
      WHERE publishedAt >= ?
      ORDER BY publishedAt DESC
      LIMIT 200
    `)
    .all(Date.now() - 7 * 24 * 60 * 60 * 1000) as Array<{
      id: number
      title: string
      summary: string
      impactRating: string | null
      publishedAt: number | null
    }>
  return rows
    .filter((row) => keywords.some((keyword) => row.title.includes(keyword) || row.summary.includes(keyword)))
    .slice(0, 3)
    .map((row) => ({
      briefingId: row.id,
      title: row.title,
      impactLevel: row.impactRating,
      publishedAt: row.publishedAt,
    }))
}

function safeGetConcepts(db: Database.Database, tsCode: string, source: string): Array<{ conceptCode: string; conceptName: string | null }> {
  try {
    const candidates = codeKeys(tsCode)
    for (const code of candidates) {
      const concepts = getConceptsByStockRouted(db, code, source as 'kpl' | 'ths' | 'dc')
      if (concepts.length > 0) return concepts
    }
  } catch (err) {
    console.warn('[PortfolioDashboard] concepts failed:', err)
  }
  return []
}

function buildSupplyChainSummary(conceptNames: string[]): PortfolioDashboardItem['supplyChain'] {
  if (conceptNames.length === 0) return null
  return {
    chainGroup: conceptNames[0] ?? null,
    eventType: null,
    direction: null,
    confidence: null,
    topNodes: conceptNames.slice(0, 5),
  }
}

async function getSectorSnapshot(db: Database.Database): Promise<Awaited<ReturnType<typeof computeSectorFlowSnapshot>> | null> {
  try {
    const snapshot = await computeSectorFlowSnapshot(db, false)
    return snapshot.dataMode === 'empty' ? null : snapshot
  } catch (err) {
    console.warn('[PortfolioDashboard] sector flow failed:', err)
    return null
  }
}

function findSectorFlow(
  conceptNames: string[],
  snapshot: Awaited<ReturnType<typeof computeSectorFlowSnapshot>> | null
): PortfolioDashboardItem['sectorFlow'] {
  if (!snapshot || conceptNames.length === 0) return null
  const concepts = new Set(conceptNames)
  const item = snapshot.items.find((x) => concepts.has(x.boardName))
  if (!item) return null
  return {
    conceptName: item.boardName,
    metricMode: item.metricMode,
    mainNetInflow: item.mainNetInflow,
    mainNetInflowRate: item.mainNetInflowRate,
    previousMainNetInflow: item.previousMainNetInflow,
    turnoverDirectionStrength: item.turnoverDirectionStrength,
    weightedChange: item.weightedChange,
  }
}

function findByCode<T>(map: Map<string, T>, tsCode: string): T | undefined {
  for (const key of codeKeys(tsCode)) {
    const value = map.get(key)
    if (value !== undefined) return value
  }
  return undefined
}

function codeKeys(tsCode: string): string[] {
  const clean = tsCode.trim().toUpperCase()
  const stripped = stripTsSuffix(clean)
  return Array.from(new Set([clean, stripped]))
}

function stripTsSuffix(tsCode: string): string {
  return tsCode.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}
