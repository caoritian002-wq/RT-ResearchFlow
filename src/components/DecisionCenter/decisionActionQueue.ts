import type { DecisionSignalItem } from './SignalCard'
import { isPortfolioSignal, isRiskSignal } from './decisionSections'

export type DecisionActionKind = 'read' | 'watch' | 'dismiss' | 'lifecycle' | 'stock' | 'chain'

export interface DecisionActionItem {
  signal: DecisionSignalItem
  rankScore: number
  reasons: string[]
  trustHint: string
  gaps: string[]
  primaryAction: DecisionActionKind
  secondaryActions: DecisionActionKind[]
  /** FR-231: 按股聚合后的展示标题, 缺省用 signal.title */
  displayTitle?: string
  displaySummary?: string
  sourceCount?: number
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

function mergedContext(signal: DecisionSignalItem): Record<string, unknown> {
  return {
    ...(parseJson(signal.sourceRefJson) ?? {}),
    ...(parseJson(signal.reasonJson) ?? {})
  }
}

function sourceLabel(sourceModule: string): string {
  return {
    news: '资讯',
    ai: 'AI',
    short_term: '短线策略',
    trend: '趋势',
    market: '市场',
    sector_flow: '板块资金',
    manual: '手动'
  }[sourceModule] ?? sourceModule
}

function buildReasons(signal: DecisionSignalItem): string[] {
  const reasons: string[] = []
  if (signal.priority >= 5) reasons.push('P5 高优先级')
  else if (signal.priority >= 4) reasons.push('P4 以上')
  if (isPortfolioSignal(signal)) reasons.push('持仓相关')
  if (isRiskSignal(signal)) reasons.push('风险优先')
  if (signal.status === 'NEW') reasons.push('未读')
  if (signal.status === 'WATCHING') reasons.push('关注中')
  if ((signal.occurrenceCount ?? 1) > 1) reasons.push(`重复触发 ${signal.occurrenceCount} 次`)
  if (signal.confidence != null && signal.confidence >= 75) reasons.push(`置信度 ${signal.confidence.toFixed(0)}%`)
  if (reasons.length === 0) reasons.push(`${sourceLabel(signal.sourceModule)}信号`)
  return reasons.slice(0, 4)
}

function buildTrustHint(signal: DecisionSignalItem): string {
  if (signal.sourceModule === 'ai') return 'AI 预测需要结合走势、成交量和回测记录复核。'
  if (signal.sourceModule === 'news') return '资讯影响需要确认事件持续性和产业链传导强度。'
  if (signal.sourceModule === 'short_term') return '短线策略信号更依赖流动性和盘中执行窗口。'
  if (signal.sourceModule === 'trend') return '趋势预警适合作为复盘入口, 不等同于交易指令。'
  if (signal.sourceModule === 'sector_flow') return '板块主力资金来自东方财富，仍需用次日竞价与核心股走势确认是否延续。'
  if (signal.sourceModule === 'market') return '市场状态用于判断环境, 不直接替代单股判断。'
  return '该信号仅作为辅助线索, 需要结合行情和个人风险约束复核。'
}

function buildGaps(signal: DecisionSignalItem): string[] {
  const context = mergedContext(signal)
  const gaps: string[] = []
  if (isPortfolioSignal(signal) && typeof context.costPrice !== 'number') gaps.push('缺少持仓成本价')
  if (signal.sourceModule === 'ai' && signal.confidence == null) gaps.push('缺少置信度')
  if (signal.sourceModule === 'ai' && !('backtestMape' in context) && !('backtestDirection' in context)) gaps.push('缺少回测摘要')
  if (signal.sourceModule === 'news' && !signal.conceptName && !signal.tsCode) gaps.push('缺少股票或题材映射')
  if (signal.sourceModule === 'trend' && signal.tsCode && typeof context.triggerPrice !== 'number') gaps.push('缺少触发价')
  return gaps.slice(0, 3)
}

function choosePrimaryAction(signal: DecisionSignalItem): DecisionActionKind {
  // FR-232: 有 tsCode 时优先进入研判/事件路径, 走势图为次动作
  if (signal.tsCode && (isPortfolioSignal(signal) || isRiskSignal(signal))) return 'lifecycle'
  if (signal.resolvedAt || signal.resolution) return 'lifecycle'
  if (isPortfolioSignal(signal) || isRiskSignal(signal)) return signal.tsCode ? 'stock' : 'lifecycle'
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

export function buildDecisionActionQueue(signals: DecisionSignalItem[], limit = 5): DecisionActionItem[] {
  return signals
    .filter(signal => signal.status !== 'DISMISSED' && signal.status !== 'EXPIRED')
    .filter(signal => !signal.resolvedAt || signal.status === 'WATCHING')
    .map(signal => {
      const primaryAction = choosePrimaryAction(signal)
      return {
        signal,
        rankScore: actionScore(signal),
        reasons: buildReasons(signal),
        trustHint: buildTrustHint(signal),
        gaps: buildGaps(signal),
        primaryAction,
        secondaryActions: secondaryActions(primaryAction, signal)
      }
    })
    .sort((left, right) => right.rankScore - left.rankScore || right.signal.id - left.signal.id)
    .slice(0, limit)
}
