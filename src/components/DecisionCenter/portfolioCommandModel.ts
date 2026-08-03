import type { DecisionSignalItem } from './SignalCard'
import { isPortfolioSignal, isRiskSignal } from './decisionSections'
import type { DecisionPortfolioRiskReviewData } from './decisionReviewStatsModel'
import { buildDecisionProgressModel, type DecisionProgressModel } from './decisionProgressModel'
import type { DecisionActionItem, DecisionActionKind } from './decisionActionQueue'

export interface PortfolioHoldingRow {
  tsCode: string
  stockName: string
  addedAt: number
  costPrice: number | null
}

export type PortfolioProfitSummaryKind = 'ready' | 'partial' | 'blocked' | 'empty'

export interface PortfolioCommandSummary {
  holdingCount: number
  portfolioRiskCount: number
  evidenceGapCount: number
  pendingCount: number
  relatedSignalCount: number
  missingCostCount: number
  /** 可汇总时为平均浮盈百分比; 不可汇总时为 null */
  profitPctAvg: number | null
  profitSummaryKind: PortfolioProfitSummaryKind
  profitSummaryText: string
  metrics: Array<{
    label: string
    value: number
    hint: string
    tone: 'red' | 'green' | 'blue' | 'amber'
    tag: string
  }>
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readProfitPct(signal: DecisionSignalItem): number | null {
  const reason = parseJson(signal.reasonJson)
  const sourceRef = parseJson(signal.sourceRefJson)
  const value = reason?.profitPct ?? sourceRef?.profitPct
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeCode(code: string): string {
  return code.includes('.') ? code.split('.')[0]! : code
}

/**
 * 组合模式指挥台摘要与四指标。
 * 持仓只数优先 portfolio:list; 风险/待办/缺口由当前组合信号与持仓风险复盘派生。
 * 浮盈不得在全缺成本时显示 0%。
 */
export function buildPortfolioCommandSummary(
  signals: DecisionSignalItem[],
  holdings: PortfolioHoldingRow[] | null,
  portfolioRiskData: DecisionPortfolioRiskReviewData | null,
): PortfolioCommandSummary {
  const holdingCount = holdings != null
    ? holdings.length
    : (portfolioRiskData?.totalPortfolio ?? 0)

  const missingCostFromList = holdings != null
    ? holdings.filter((item) => item.costPrice == null).length
    : null
  const missingCostCount = missingCostFromList ?? portfolioRiskData?.missingCostPrice ?? 0

  const portfolioSignals = signals.filter(isPortfolioSignal)
  const relatedSignalCount = portfolioSignals.length
  const portfolioRiskCount = portfolioSignals.filter(isRiskSignal).length
  const progress = buildDecisionProgressModel(portfolioSignals)
  const pendingCount = progress.pending

  // 证据缺口: 缺成本 + 持仓信号中缺成本上下文(去重按票)
  const gapCodes = new Set<string>()
  if (holdings) {
    for (const row of holdings) {
      if (row.costPrice == null) gapCodes.add(normalizeCode(row.tsCode))
    }
  } else if (portfolioRiskData) {
    for (const item of portfolioRiskData.items) {
      if (item.costPrice == null) gapCodes.add(normalizeCode(item.tsCode))
    }
  }
  for (const signal of portfolioSignals) {
    if (!signal.tsCode) continue
    const reason = parseJson(signal.reasonJson)
    const sourceRef = parseJson(signal.sourceRefJson)
    const hasCost = typeof reason?.costPrice === 'number' || typeof sourceRef?.costPrice === 'number'
    if (!hasCost) gapCodes.add(normalizeCode(signal.tsCode))
  }
  const evidenceGapCount = Math.max(gapCodes.size, missingCostCount)

  const profitSamples = portfolioSignals
    .map(readProfitPct)
    .filter((value): value is number => value != null)

  let profitPctAvg: number | null = null
  let profitSummaryKind: PortfolioProfitSummaryKind = 'empty'
  let profitSummaryText = '暂无持仓'

  if (holdingCount === 0) {
    profitSummaryKind = 'empty'
    profitSummaryText = '暂无持仓'
  } else if (missingCostCount >= holdingCount && profitSamples.length === 0) {
    profitSummaryKind = 'blocked'
    profitSummaryText = '成本未补齐'
    profitPctAvg = null
  } else if (profitSamples.length === 0) {
    profitSummaryKind = 'blocked'
    profitSummaryText = '浮盈暂不可汇总'
    profitPctAvg = null
  } else {
    profitPctAvg = profitSamples.reduce((sum, value) => sum + value, 0) / profitSamples.length
    if (missingCostCount > 0 || profitSamples.length < holdingCount) {
      profitSummaryKind = 'partial'
      profitSummaryText = `约 ${formatSignedPct(profitPctAvg)} · ${profitSamples.length}/${holdingCount} 只有信号`
    } else {
      profitSummaryKind = 'ready'
      profitSummaryText = formatSignedPct(profitPctAvg)
    }
  }

  return {
    holdingCount,
    portfolioRiskCount,
    evidenceGapCount,
    pendingCount,
    relatedSignalCount,
    missingCostCount,
    profitPctAvg,
    profitSummaryKind,
    profitSummaryText,
    metrics: [
      {
        label: '持仓数',
        value: holdingCount,
        hint: holdingCount === 0 ? '先添加持仓' : `相关信号 ${relatedSignalCount} 条`,
        tone: 'blue',
        tag: '组合',
      },
      {
        label: '持仓风险',
        value: portfolioRiskCount,
        hint: `未收口 ${portfolioRiskData?.unresolvedRiskSignals ?? portfolioRiskCount} 条`,
        tone: 'red',
        tag: '需先看',
      },
      {
        label: '证据缺口',
        value: evidenceGapCount,
        hint: missingCostCount > 0 ? `缺成本 ${missingCostCount} 只` : '成本/上下文缺口',
        tone: 'amber',
        tag: '待补',
      },
      {
        label: '组合未处理',
        value: pendingCount,
        hint: pendingCount === 0 ? '组合待办已清空' : '未读或关注中',
        tone: 'green',
        tag: '待办',
      },
    ],
  }
}

function formatSignedPct(value: number): string {
  const abs = Math.abs(value).toFixed(2)
  if (value > 0) return `+${abs}%`
  if (value < 0) return `-${abs}%`
  return `${abs}%`
}

function sourceLabel(sourceModule: string): string {
  return {
    news: '资讯',
    ai: 'AI',
    short_term: '短线',
    trend: '趋势',
    market: '市场',
    sector_flow: '板块',
    manual: '手动',
  }[sourceModule] ?? sourceModule
}

function actionScore(signal: DecisionSignalItem): number {
  let score = signal.priority * 1000
  if (isRiskSignal(signal)) score += 500
  if (isPortfolioSignal(signal)) score += 450
  if (signal.status === 'NEW') score += 300
  if (signal.status === 'WATCHING') score += 220
  score += Math.min((signal.occurrenceCount ?? 1) - 1, 5) * 80
  if (signal.confidence != null) score += signal.confidence
  if (signal.score != null) score += signal.score / 2
  score += signal.signalTime / 100000000
  return score
}

function isOpenActionSignal(signal: DecisionSignalItem): boolean {
  if (signal.status === 'DISMISSED' || signal.status === 'EXPIRED') return false
  return !signal.resolvedAt || signal.status === 'WATCHING'
}

function choosePrimaryAction(signal: DecisionSignalItem): DecisionActionKind {
  // FR-232: 有股票代码时主路径为按股研判 (UI 将 lifecycle 映射为「研判」)
  if (signal.tsCode) return 'lifecycle'
  if (signal.resolvedAt || signal.resolution) return 'lifecycle'
  if (signal.sourceModule === 'news' && signal.priority >= 4) return 'chain'
  if (signal.status === 'NEW') return 'read'
  return 'lifecycle'
}

function secondaryActions(primary: DecisionActionKind, signal: DecisionSignalItem): DecisionActionKind[] {
  const actions: DecisionActionKind[] = ['lifecycle']
  if (signal.tsCode) actions.push('stock')
  if (signal.status !== 'WATCHING') actions.push('watch')
  if (signal.status === 'NEW') actions.push('read')
  if (signal.sourceModule === 'news' && signal.priority >= 4) actions.push('chain')
  actions.push('dismiss')
  return actions.filter((action, index) => action !== primary && actions.indexOf(action) === index).slice(0, 4)
}

function buildGapsForSignal(signal: DecisionSignalItem): string[] {
  const reason = parseJson(signal.reasonJson)
  const sourceRef = parseJson(signal.sourceRefJson)
  const context = { ...(sourceRef ?? {}), ...(reason ?? {}) }
  const gaps: string[] = []
  if (isPortfolioSignal(signal) && typeof context.costPrice !== 'number') gaps.push('缺少持仓成本价')
  if (signal.sourceModule === 'trend' && signal.tsCode && typeof context.triggerPrice !== 'number') gaps.push('缺少触发价')
  if (signal.sourceModule === 'ai' && signal.confidence == null) gaps.push('缺少置信度')
  return gaps.slice(0, 3)
}

function makeCostGapSignal(holding: PortfolioHoldingRow): DecisionSignalItem {
  // 仅用于展示与跳转走势图, 不调用 markRead/dismiss(id 为稳定负值)
  const code = normalizeCode(holding.tsCode)
  const syntheticId = -Math.abs(Array.from(code).reduce((sum, ch) => sum + ch.charCodeAt(0), 1))
  return {
    id: syntheticId === 0 ? -1 : syntheticId,
    sourceModule: 'manual',
    strategyKey: 'portfolio.costGap',
    tsCode: holding.tsCode,
    stockName: holding.stockName,
    conceptCode: null,
    conceptName: null,
    signalType: 'INFO',
    direction: 'NEUTRAL',
    priority: 3,
    score: null,
    confidence: null,
    title: `${holding.stockName || code} 待补成本价`,
    summary: '持仓缺少成本价, 组合浮盈与风险复核不完整。',
    reasonJson: JSON.stringify({ isPortfolio: true }),
    sourceRefJson: null,
    status: 'NEW',
    signalTime: holding.addedAt || Date.now(),
    occurrenceCount: 1,
  }
}

/**
 * 组合模式左侧待办: 按 tsCode 聚合, 一票一条主任务。
 * 有持仓待办时只包含持仓相关项, 不会被全市场短线挤出。
 */
export function buildPortfolioActionQueue(
  signals: DecisionSignalItem[],
  holdings: PortfolioHoldingRow[] | null,
  limit = 5,
): DecisionActionItem[] {
  const openSignals = signals.filter(isOpenActionSignal).filter((signal) => {
    // 组合模式下只收持仓相关; 无 isPortfolio 标记但代码在持仓池内的也纳入
    if (isPortfolioSignal(signal)) return true
    if (!holdings || !signal.tsCode) return false
    const code = normalizeCode(signal.tsCode)
    return holdings.some((row) => normalizeCode(row.tsCode) === code)
  })

  const groups = new Map<string, DecisionSignalItem[]>()
  for (const signal of openSignals) {
    const key = signal.tsCode ? `code:${normalizeCode(signal.tsCode)}` : `id:${signal.id}`
    const list = groups.get(key) ?? []
    list.push(signal)
    groups.set(key, list)
  }

  // 持仓有成本缺口但当前无开放信号时, 仍生成待办
  if (holdings) {
    for (const holding of holdings) {
      if (holding.costPrice != null) continue
      const key = `code:${normalizeCode(holding.tsCode)}`
      if (groups.has(key)) continue
      groups.set(key, [makeCostGapSignal(holding)])
    }
  }

  const items: DecisionActionItem[] = []
  for (const groupSignals of groups.values()) {
    const ranked = [...groupSignals].sort((a, b) => actionScore(b) - actionScore(a) || b.id - a.id)
    const primary = ranked[0]!
    const sourceCount = groupSignals.length
    const sourceModules = Array.from(new Set(groupSignals.map((item) => sourceLabel(item.sourceModule))))
    const riskCount = groupSignals.filter(isRiskSignal).length
    const gaps = Array.from(new Set(groupSignals.flatMap(buildGapsForSignal))).slice(0, 3)
    if (holdings && primary.tsCode) {
      const holding = holdings.find((row) => normalizeCode(row.tsCode) === normalizeCode(primary.tsCode!))
      if (holding?.costPrice == null && !gaps.includes('缺少持仓成本价')) gaps.unshift('缺少持仓成本价')
    }

    const reasons: string[] = []
    if (sourceCount > 1) reasons.push(`${sourceCount} 条来源`)
    if (riskCount > 0) reasons.push(`风险 ${riskCount}`)
    if (primary.priority >= 4) reasons.push(`P${primary.priority}`)
    if (primary.status === 'NEW') reasons.push('未读')
    if (primary.status === 'WATCHING') reasons.push('关注中')
    if (sourceModules.length > 0) reasons.push(sourceModules.slice(0, 2).join('/'))
    if (reasons.length === 0) reasons.push('持仓待办')

    const stockLabel = primary.stockName || (primary.tsCode ? normalizeCode(primary.tsCode) : '持仓')
    const displayTitle = sourceCount > 1
      ? `${stockLabel} · ${sourceCount} 条线索`
      : primary.title
    const displaySummary = sourceCount > 1
      ? `主线索: ${primary.title}`
      : primary.summary

    // 成本缺口合成项只允许看走势, 避免对负 id 调状态 API
    const isSyntheticCostGap = primary.id < 0 && primary.strategyKey === 'portfolio.costGap'
    const primaryAction: DecisionActionKind = isSyntheticCostGap ? 'stock' : choosePrimaryAction(primary)
    const secondary = isSyntheticCostGap ? [] : secondaryActions(primaryAction, primary)

    items.push({
      signal: primary,
      rankScore: Math.max(...groupSignals.map(actionScore)),
      reasons: reasons.slice(0, 4),
      trustHint: sourceCount > 1
        ? '同一持仓多条线索已合并, 先处理主线索并补齐证据缺口。'
        : '持仓待办仅作辅助复核, 不构成交易指令。',
      gaps: gaps.slice(0, 3),
      primaryAction,
      secondaryActions: secondary,
      displayTitle,
      displaySummary,
      sourceCount,
    })
  }

  return items
    .sort((left, right) => right.rankScore - left.rankScore || right.signal.id - left.signal.id)
    .slice(0, limit)
}

/** 组合模式进度文案, 与全市场“今日暂无信号”区分 */
export function buildPortfolioProgressModel(
  signals: DecisionSignalItem[],
  holdings: PortfolioHoldingRow[] | null,
): DecisionProgressModel {
  const portfolioSignals = signals.filter((signal) => {
    if (isPortfolioSignal(signal)) return true
    if (!holdings || !signal.tsCode) return false
    const code = normalizeCode(signal.tsCode)
    return holdings.some((row) => normalizeCode(row.tsCode) === code)
  })
  const base = buildDecisionProgressModel(portfolioSignals)
  const holdingCount = holdings?.length ?? 0

  if (holdings != null && holdingCount === 0) {
    return {
      ...base,
      total: 0,
      pending: 0,
      title: '尚未添加持仓',
      description: '先添加持仓后, 这里会统计你的组合待办进度。',
    }
  }

  if (base.total === 0) {
    return {
      ...base,
      title: '组合待办已清空',
      description: '当前没有持仓相关待处理信号, 可切换「全部信号」观察市场。',
    }
  }

  if (base.pending === 0) {
    return {
      ...base,
      title: '组合待办已清空',
      description: '持仓相关信号都已阅读、忽略或完成处置。',
    }
  }

  return {
    ...base,
    title: `组合还有 ${base.pending} 条待处理`,
    description: '优先处理持仓风险与证据缺口, 再决定是否扫全市场。',
  }
}
