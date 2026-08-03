import type {
  BlockEvaluationResult,
  BlockStrategyTemplate,
  ConditionBlock,
  ConditionDataStatus,
  ConditionEvaluationResult,
  ConditionGroup,
  GroupEvaluationResult,
  MinuteBarForCondition,
} from './types'
import { isConditionBlock } from './types'
import { createEvaluationContext, evaluateMinuteCondition } from './minuteConditions'

function mergeStatus(items: Array<{ dataStatus: ConditionDataStatus }>): ConditionDataStatus {
  if (items.some((item) => item.dataStatus === 'data_insufficient')) return 'data_insufficient'
  if (items.some((item) => item.dataStatus === 'partial')) return 'partial'
  return 'complete'
}

function flatten(group: GroupEvaluationResult): ConditionEvaluationResult[] {
  return [...group.conditions, ...group.groups.flatMap(flatten)]
}

function hasHardRequiredFailure(group: GroupEvaluationResult): boolean {
  return group.conditions.some(item => item.hardRequired && !item.passed)
    || group.groups.some(hasHardRequiredFailure)
}

function evalGroup(group: ConditionGroup, context: ReturnType<typeof createEvaluationContext>, mode: BlockStrategyTemplate['executionMode'], threshold: number): GroupEvaluationResult {
  if (!group.enabled) {
    return { groupId: group.id, operator: group.operator, passed: true, score: 0, maxScore: 0, dataStatus: 'complete', conditions: [], groups: [] }
  }
  const conditions: ConditionEvaluationResult[] = []
  const groups: GroupEvaluationResult[] = []
  for (const child of group.children) {
    if (!child.enabled) continue
    if (isConditionBlock(child)) conditions.push(evaluateMinuteCondition(child as ConditionBlock, context))
    else groups.push(evalGroup(child, context, mode, threshold))
  }
  const childPasses = [...conditions.map((item) => item.passed), ...groups.map((item) => item.passed)]
  const hardFailed = conditions.some(item => item.hardRequired && !item.passed) || groups.some(hasHardRequiredFailure)
  const operatorPass = group.operator === 'AND'
    ? childPasses.every(Boolean)
    : group.operator === 'OR'
      ? childPasses.some(Boolean)
      : !childPasses.some(Boolean)
  const maxScore = conditions.reduce((sum, item) => sum + item.weight, 0) + groups.reduce((sum, item) => sum + item.maxScore, 0)
  const rawScore = conditions.reduce((sum, item) => sum + item.contribution, 0)
    + groups.reduce((sum, item) => sum + item.score / 100 * item.maxScore, 0)
  const weightedScore = maxScore > 0 ? Math.min(100, rawScore / maxScore * 100) : operatorPass ? 100 : 0
  const childScores = [
    ...conditions.map(item => item.weight > 0 ? item.contribution / item.weight * 100 : item.passed ? 100 : 0),
    ...groups.map(item => item.score),
  ]
  const score = group.operator === 'OR'
    ? Math.max(0, ...childScores)
    : group.operator === 'NOT'
      ? operatorPass ? 100 : 0
      : weightedScore
  const dataStatus = mergeStatus([...conditions, ...groups])
  const dataBlocked = dataStatus === 'data_insufficient'
  const passed = !dataBlocked && !hardFailed && (mode === 'strict'
    ? operatorPass
    : group.operator === 'AND'
      ? score >= threshold
      : operatorPass)
  return { groupId: group.id, operator: group.operator, passed, score, maxScore, dataStatus, conditions, groups }
}

export function evaluateConditionTemplate(template: BlockStrategyTemplate, rows: MinuteBarForCondition[]): BlockEvaluationResult {
  const preferredWindow = findPreferredWindow(template.root) ?? 15
  const context = createEvaluationContext(rows, preferredWindow)
  const root = evalGroup(template.root, context, template.executionMode, template.scoreThreshold)
  const flatConditions = flatten(root)
  return {
    passed: root.passed,
    totalScore: Number(root.score.toFixed(4)),
    maxScore: root.maxScore,
    dataStatus: root.dataStatus,
    summary: root.passed ? '条件积木模板命中' : '条件积木模板未命中',
    root,
    flatConditions,
  }
}

function findPreferredWindow(group: ConditionGroup): number | null {
  for (const child of group.children) {
    if (isConditionBlock(child) && child.type === 'minute_window_gain') {
      const value = child.params.windowMinutes
      const numeric = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(numeric)) return numeric
    }
    if (!isConditionBlock(child)) {
      const nested = findPreferredWindow(child)
      if (nested !== null) return nested
    }
  }
  return null
}
