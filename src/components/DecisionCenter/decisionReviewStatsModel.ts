import type { DecisionSignalItem } from './SignalCard'

type Distribution = Array<{ label: string; value: number; tone: 'blue' | 'green' | 'amber' | 'red' | 'slate' | 'purple' }>

export interface DecisionReviewSignalItem extends DecisionSignalItem {
  firstSeenAt: number | null
  lastSeenAt: number | null
  occurrenceCount: number
}

export interface DecisionReviewStatsData {
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
  bySource: Record<string, number>
  byType: Record<string, number>
  byResolution: Record<string, number>
  byPriority: Record<string, number>
  noiseSuggestions: DecisionNoiseSuggestion[]
  pendingReview: DecisionReviewSignalItem[]
  repeatedSignals: DecisionReviewSignalItem[]
}

export interface DecisionNoiseSuggestion {
  id: string
  level: 'high' | 'medium' | 'low'
  targetType: 'source' | 'strategy' | 'review' | 'data'
  title: string
  summary: string
  metric: string
  actionLabel: string
  sourceModule?: string
  strategyKey?: string
}

export interface DecisionHistorySignalsData {
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

export interface DecisionSignalDateContextData {
  today: string
  displayDate: string
  latestTradeDate: string | null
  isFallback: boolean
  isTradingDay: boolean
}

export interface DecisionPortfolioRiskReviewData {
  rangeDays: number
  totalPortfolio: number
  missingCostPrice: number
  withRiskSignals: number
  unresolvedRiskSignals: number
  repeatedRiskSignals: number
  items: Array<{
    tsCode: string
    stockName: string
    costPrice: number | null
    totalSignals: number
    riskSignals: number
    unresolvedSignals: number
    repeatedSignals: number
    latestSignal: DecisionReviewSignalItem | null
  }>
}

export interface DecisionReviewStatsModel {
  sampleHint: string
  summaryCards: Distribution
  sourceDistribution: Distribution
  typeDistribution: Distribution
  resolutionDistribution: Distribution
  priorityDistribution: Distribution
}

const SOURCE_LABEL: Record<string, string> = {
  news: '资讯',
  ai: 'AI',
  short_term: '短线',
  trend: '趋势',
  market: '大盘',
  sector_flow: '板块',
  manual: '手动',
}

const TYPE_LABEL: Record<string, string> = {
  ALERT: '预警',
  OPPORTUNITY: '机会',
  RISK: '风险',
  INFO: '信息',
}

const RESOLUTION_LABEL: Record<string, string> = {
  RESOLVED_VALID: '有效线索',
  RESOLVED_INVALID: '误报',
  RESOLVED_MISSED: '错过处理',
  RESOLVED_DUPLICATE: '重复信号',
  RESOLVED_DATA_ISSUE: '数据问题',
  RESOLVED_MANUAL: '人工归档',
}

export function buildDecisionReviewStatsModel(data: DecisionReviewStatsData | null): DecisionReviewStatsModel {
  if (!data) {
    return {
      sampleHint: '复盘统计加载中',
      summaryCards: [],
      sourceDistribution: [],
      typeDistribution: [],
      resolutionDistribution: [],
      priorityDistribution: [],
    }
  }
  const sampleHint = data.sampleSize === 0
    ? '当前范围内暂无历史信号'
    : data.sampleSize < 10
      ? `近 ${data.rangeDays} 天仅 ${data.sampleSize} 条样本, 适合做个人回看, 暂不适合下结论`
      : `近 ${data.rangeDays} 天 ${data.sampleSize} 条样本, 用于观察个人处理习惯和信号噪声`
  return {
    sampleHint,
    summaryCards: [
      { label: '总信号', value: data.summary.total, tone: 'blue' },
      { label: '已处置', value: data.summary.resolved, tone: 'green' },
      { label: '关注中', value: data.summary.watching, tone: 'amber' },
      { label: '已忽略', value: data.summary.dismissed, tone: 'slate' },
      { label: '待复盘', value: data.summary.unresolved, tone: 'red' },
      { label: '重复触发', value: data.summary.repeated, tone: 'purple' },
    ],
    sourceDistribution: toDistribution(data.bySource, SOURCE_LABEL, 'blue'),
    typeDistribution: toDistribution(data.byType, TYPE_LABEL, 'green'),
    resolutionDistribution: toDistribution(data.byResolution, RESOLUTION_LABEL, 'amber'),
    priorityDistribution: toDistribution(data.byPriority, {}, 'red'),
  }
}

export function sourceLabel(value: string): string {
  return SOURCE_LABEL[value] ?? value
}

export function typeLabel(value: string): string {
  return TYPE_LABEL[value] ?? value
}

export function statusLabel(value: string): string {
  if (value === 'NEW') return '待处理'
  if (value === 'READ') return '已读'
  if (value === 'WATCHING') return '关注中'
  if (value === 'DISMISSED') return '已忽略'
  if (value === 'EXPIRED') return '已过期'
  return value
}

export function formatReviewDate(ms: number | null | undefined): string {
  if (!ms) return '--'
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export function noiseLevelLabel(level: DecisionNoiseSuggestion['level']): string {
  if (level === 'high') return '优先处理'
  if (level === 'medium') return '建议观察'
  return '低优先级'
}

export function formatFullReviewDate(ms: number | null | undefined): string {
  if (!ms) return '--'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function formatCostPrice(value: number | null): string {
  return value == null ? '--' : value.toFixed(2)
}

function toDistribution(items: Record<string, number>, labels: Record<string, string>, tone: Distribution[number]['tone']): Distribution {
  return Object.entries(items)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ label: labels[key] ?? key, value, tone }))
}
