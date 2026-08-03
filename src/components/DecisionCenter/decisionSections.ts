import type { DecisionSignalItem } from './SignalCard'

export type DecisionSectionKey = 'portfolio' | 'risk' | 'market' | 'strategy' | 'news' | 'latest'

export interface DecisionSection {
  key: DecisionSectionKey
  title: string
  subtitle: string
  emptyText: string
  signals: DecisionSignalItem[]
}

export interface DecisionHomeModel {
  prioritySignals: DecisionSignalItem[]
  sections: DecisionSection[]
  counts: {
    portfolio: number
    risk: number
    market: number
    strategy: number
    news: number
  }
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function isPortfolioSignal(signal: DecisionSignalItem): boolean {
  return parseJson(signal.reasonJson)?.isPortfolio === true || parseJson(signal.sourceRefJson)?.isPortfolio === true
}

export function isRiskSignal(signal: DecisionSignalItem): boolean {
  if (signal.signalType === 'RISK') return true
  if (signal.direction === 'BEARISH') return true
  return signal.sourceModule === 'trend' && signal.priority >= 4
}

function priorityScore(signal: DecisionSignalItem): number {
  let score = signal.priority * 1000 + signal.signalTime / 100000000
  if (signal.status === 'NEW') score += 700
  if (signal.status === 'WATCHING') score += 500
  if (isPortfolioSignal(signal)) score += 350
  if (isRiskSignal(signal)) score += 300
  if (signal.confidence != null) score += signal.confidence
  if (signal.score != null) score += signal.score / 2
  return score
}

export function sortDecisionSignals(signals: DecisionSignalItem[]): DecisionSignalItem[] {
  return [...signals].sort((left, right) => {
    const scoreDelta = priorityScore(right) - priorityScore(left)
    if (Math.abs(scoreDelta) > 0.001) return scoreDelta
    return right.id - left.id
  })
}

function bySource(signal: DecisionSignalItem, sources: string[]): boolean {
  return sources.includes(signal.sourceModule)
}

export function buildDecisionHomeModel(signals: DecisionSignalItem[]): DecisionHomeModel {
  const sorted = sortDecisionSignals(signals)
  const portfolioSignals = sorted.filter(isPortfolioSignal)
  const riskSignals = sorted.filter(isRiskSignal)
  const marketSignals = sorted.filter((signal) => bySource(signal, ['market', 'sector_flow']) && !isRiskSignal(signal))
  const strategySignals = sorted.filter((signal) => bySource(signal, ['short_term', 'trend']) && !isPortfolioSignal(signal) && !isRiskSignal(signal))
  const newsSignals = sorted.filter((signal) => bySource(signal, ['news', 'ai']) && !isPortfolioSignal(signal) && !isRiskSignal(signal))
  const latestSignals = [...signals].sort((left, right) => right.signalTime - left.signalTime || right.id - left.id)

  return {
    prioritySignals: sorted.filter((signal) => signal.status !== 'DISMISSED' && signal.status !== 'EXPIRED').slice(0, 8),
    sections: [
      {
        key: 'portfolio',
        title: '持仓',
        subtitle: '真实资产相关的机会和风险',
        emptyText: '当前筛选条件下暂无持仓信号',
        signals: portfolioSignals.slice(0, 6),
      },
      {
        key: 'risk',
        title: '风险',
        subtitle: '趋势破位、负面资讯和偏空信号',
        emptyText: '当前筛选条件下暂无风险提醒',
        signals: riskSignals.slice(0, 6),
      },
      {
        key: 'market',
        title: '市场',
        subtitle: '大盘、板块资金和市场状态',
        emptyText: '当前筛选条件下暂无市场信号',
        signals: marketSignals.slice(0, 6),
      },
      {
        key: 'strategy',
        title: '策略',
        subtitle: '短线策略和长线趋势机会',
        emptyText: '当前筛选条件下暂无策略信号',
        signals: strategySignals.slice(0, 6),
      },
      {
        key: 'news',
        title: '资讯',
        subtitle: '重大资讯和 AI 提炼出的信号',
        emptyText: '当前筛选条件下暂无资讯信号',
        signals: newsSignals.slice(0, 6),
      },
      {
        key: 'latest',
        title: '最新',
        subtitle: '按发生时间排列的兜底视图',
        emptyText: '当前筛选条件下暂无最新信号',
        signals: latestSignals.slice(0, 10),
      },
    ],
    counts: {
      portfolio: portfolioSignals.length,
      risk: riskSignals.length,
      market: marketSignals.length,
      strategy: strategySignals.length,
      news: newsSignals.length,
    },
  }
}
