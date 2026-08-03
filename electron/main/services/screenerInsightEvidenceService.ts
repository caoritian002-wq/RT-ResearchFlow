import type Database from 'better-sqlite3'
import type { DecisionSignalRow, PortfolioStockRow, ScreenerMoneyFlowSummary, ScreenerRankBreakdownItem, ScreenerSignalKey, StockScreenerResultRow } from '../database/types'
import { getByDate } from '../database/stockScreenerResultsRepository'
import { listPortfolioStocks } from '../database/portfolioRepository'
import { getConceptSource } from '../database/settingsRepository'
import { getStockInfo } from '../database/stockPriceCacheRepository'
import { getConceptsByStockRouted } from './conceptRouter'
import { buildLatestChipSummaryMap, type ChipSummary } from './chipSummaryService'
import { getTodayDecisionSignals } from './decisionSignalService'
import { getTrendScoreSnapshot, type TrendScoreDetail } from './trendWatchlistService'
import { sha256 } from '../utils/hashUtils'

export interface ScreenerInsightEvidence {
  version: 'fr207-v1'
  tradeDate: string
  tsCode: string
  stockName: string | null
  screener: {
    close: number | null
    pctChg: number | null
    turnoverRate: number | null
    amount: number | null
    signalScore: number
    conditionsMet: string[]
    concepts: string[]
    rankScore: number | null
    rankBreakdown: ScreenerRankBreakdownItem[]
    signalStrength: Partial<Record<ScreenerSignalKey, number>>
    moneyFlow: ScreenerMoneyFlowSummary | null
  }
  topic: {
    source: 'kpl' | 'ths' | 'dc'
    concepts: string[]
  }
  trend: Pick<TrendScoreDetail,
    'totalScore' | 'maScore' | 'maAbove60' | 'alphaScore' | 'drawdown' |
    'turnoverRatio' | 'macdAboveZero' | 'bollAboveMid' | 'dataSource' | 'dataTime'
  > | null
  chip: ChipSummary | null
  portfolio: {
    isPortfolio: boolean
    costPrice: number | null
    profitPct: number | null
    positionAdvice: TrendScoreDetail['positionAdvice'] | null
    positionAdviceReason: string | null
  }
  todaySignals: Array<Pick<DecisionSignalRow,
    'id' | 'sourceModule' | 'strategyKey' | 'signalType' | 'priority' | 'title' | 'summary' | 'status' | 'occurrenceCount'
  >>
  evidenceGaps: string[]
}

export interface BuiltScreenerInsightEvidence {
  evidence: ScreenerInsightEvidence
  evidenceHash: string
}

function codeKeys(tsCode: string): string[] {
  const clean = tsCode.trim().toUpperCase()
  const stripped = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  return Array.from(new Set([clean, stripped]))
}

function normalizeCode(tsCode: string): string {
  return tsCode.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function safeParseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
  } catch {
    return []
  }
}

function safeParseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function findScreenerRow(rows: StockScreenerResultRow[], tsCode: string): StockScreenerResultRow | null {
  const wanted = new Set(codeKeys(tsCode).map(normalizeCode))
  return rows.find(row => wanted.has(normalizeCode(row.tsCode))) ?? null
}

function findPortfolio(rows: PortfolioStockRow[], tsCode: string): PortfolioStockRow | null {
  const wanted = new Set(codeKeys(tsCode).map(normalizeCode))
  return rows.find(row => wanted.has(normalizeCode(row.tsCode))) ?? null
}

function findTrend(rows: TrendScoreDetail[], tsCode: string): TrendScoreDetail | null {
  const wanted = new Set(codeKeys(tsCode).map(normalizeCode))
  return rows.find(row => wanted.has(normalizeCode(row.tsCode))) ?? null
}

function findSignals(signals: DecisionSignalRow[], tsCode: string): DecisionSignalRow[] {
  const wanted = new Set(codeKeys(tsCode).map(normalizeCode))
  return signals.filter(signal => signal.tsCode != null && wanted.has(normalizeCode(signal.tsCode))).slice(0, 6)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (val as Record<string, unknown>)[key]
          return acc
        }, {})
    }
    return val
  })
}

export function buildScreenerInsightEvidence(
  db: Database.Database,
  tradeDate: string,
  tsCode: string,
): BuiltScreenerInsightEvidence | null {
  const screenerRows = getByDate(db, tradeDate)
  const row = findScreenerRow(screenerRows, tsCode)
  if (!row) return null

  const source = getConceptSource()
  const topicConcepts = getConceptsByStockRouted(db, row.tsCode, source, tradeDate).map(c => c.conceptName).filter(Boolean)
  const screenerConcepts = safeParseStringArray(row.concepts)
  const trend = findTrend(getTrendScoreSnapshot(db), row.tsCode)
  const portfolio = findPortfolio(listPortfolioStocks(db), row.tsCode)
  const chipMap = buildLatestChipSummaryMap(db)
  const chip = chipMap.get(row.tsCode) ?? chipMap.get(normalizeCode(row.tsCode)) ?? null
  const signals = findSignals(getTodayDecisionSignals(db, { limit: 500 }), row.tsCode)
  const stockInfo = getStockInfo(db, normalizeCode(row.tsCode))

  const evidenceGaps: string[] = []
  if (topicConcepts.length === 0 && screenerConcepts.length === 0) evidenceGaps.push('题材数据缺失')
  if (!trend) evidenceGaps.push('趋势评分缺失')
  if (!chip) evidenceGaps.push('筹码摘要缺失')
  if (!portfolio) evidenceGaps.push('非持仓股')
  if (signals.length === 0) evidenceGaps.push('今日看板无同股信号')

  const evidence: ScreenerInsightEvidence = {
    version: 'fr207-v1',
    tradeDate,
    tsCode: normalizeCode(row.tsCode),
    stockName: row.stockName ?? stockInfo?.stockName ?? null,
    screener: {
      close: row.close,
      pctChg: row.pctChg,
      turnoverRate: row.turnoverRate,
      amount: row.amount,
      signalScore: row.signalScore,
      conditionsMet: safeParseStringArray(row.conditionsMet),
      concepts: Array.from(new Set([...screenerConcepts, ...topicConcepts])).slice(0, 12),
      rankScore: row.rankScore ?? row.signalScore,
      rankBreakdown: safeParseJson<ScreenerRankBreakdownItem[]>(row.rankBreakdownJson, []),
      signalStrength: safeParseJson<Partial<Record<ScreenerSignalKey, number>>>(row.signalStrengthJson, {}),
      moneyFlow: safeParseJson<ScreenerMoneyFlowSummary | null>(row.moneyflowJson, null),
    },
    topic: {
      source,
      concepts: Array.from(new Set(topicConcepts)).slice(0, 12),
    },
    trend: trend ? {
      totalScore: trend.totalScore,
      maScore: trend.maScore,
      maAbove60: trend.maAbove60,
      alphaScore: trend.alphaScore,
      drawdown: trend.drawdown,
      turnoverRatio: trend.turnoverRatio,
      macdAboveZero: trend.macdAboveZero,
      bollAboveMid: trend.bollAboveMid,
      dataSource: trend.dataSource,
      dataTime: trend.dataTime,
    } : null,
    chip,
    portfolio: {
      isPortfolio: portfolio != null,
      costPrice: portfolio?.costPrice ?? null,
      profitPct: trend?.profitPct ?? null,
      positionAdvice: trend?.positionAdvice ?? null,
      positionAdviceReason: trend?.positionAdviceReason ?? null,
    },
    todaySignals: signals.map(signal => ({
      id: signal.id,
      sourceModule: signal.sourceModule,
      strategyKey: signal.strategyKey,
      signalType: signal.signalType,
      priority: signal.priority,
      title: signal.title,
      summary: signal.summary,
      status: signal.status,
      occurrenceCount: signal.occurrenceCount,
    })),
    evidenceGaps,
  }

  const evidenceHash = sha256(stableStringify(evidence))
  return { evidence, evidenceHash }
}