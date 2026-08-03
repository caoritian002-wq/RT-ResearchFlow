export type ConditionBlockType =
  | 'minute_window_gain'
  | 'minute_window_amount_ratio'
  | 'minute_window_volume_ratio'
  | 'pullback_after_high'
  | 'hold_above_gain_ratio'
  | 'close_retention'

export type ConditionGroupOperator = 'AND' | 'OR' | 'NOT'
export type ConditionExecutionMode = 'strict' | 'score'
export type ConditionDataStatus = 'complete' | 'partial' | 'data_insufficient'
export type ConditionStockPoolSource = 'allMarket' | 'portfolio' | 'trendWatchlist' | 'chipMonitor' | 'manual'
export type ConditionScanRunStatus = 'running' | 'completed' | 'failed'

export interface ConditionParameterDefinition {
  key: string
  label: string
  unit?: string
  min?: number
  max?: number
  step?: number
  defaultValue: number | string | boolean
}

export interface ConditionBlock {
  id: string
  type: ConditionBlockType
  name: string
  description: string
  enabled: boolean
  weight: number
  hardRequired?: boolean
  params: Record<string, number | string | boolean>
}

export interface ConditionGroup {
  id: string
  operator: ConditionGroupOperator
  enabled: boolean
  children: Array<ConditionGroup | ConditionBlock>
}

export interface BlockScanScope {
  dateStart: string
  dateEnd: string
  lookbackDays: number
  stockPoolSources: ConditionStockPoolSource[]
  manualStocks?: Array<{ tsCode: string; stockName?: string | null }>
  excludeST: boolean
  excludeBJ: boolean
  minDailyAmount?: number | null
  dailyPrefilterLimit?: number | null
  autoFetchMinuteLimit?: number | null
  minuteFetchConcurrency?: number | null
  minuteFetchIntervalMs?: number | null
  minuteFetchStopAfterFailures?: number | null
}

export interface BlockStrategyTemplate {
  key: string
  name: string
  description: string
  version: number
  enabled: boolean
  executionMode: ConditionExecutionMode
  scoreThreshold: number
  scope: BlockScanScope
  root: ConditionGroup
}

export interface MinuteBarForCondition {
  tsCode: string
  tradeDate: string
  tsMinute: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  vol: number | null
  amount: number | null
}

export interface MinuteWindowEvidence {
  startMinute?: string
  endMinute?: string
  highMinute?: string
  gainPct?: number | null
  amount?: number | null
  volume?: number | null
  ratio?: number | null
  maxPullbackPct?: number | null
  holdRatio?: number | null
  retentionPct?: number | null
}

export interface ConditionEvaluationResult {
  blockId: string
  type: ConditionBlockType
  name: string
  passed: boolean
  score: number
  weight: number
  contribution: number
  params: Record<string, number | string | boolean>
  hardRequired: boolean
  dataStatus: ConditionDataStatus
  message: string
  evidence: MinuteWindowEvidence
}

export interface GroupEvaluationResult {
  groupId: string
  operator: ConditionGroupOperator
  passed: boolean
  score: number
  maxScore: number
  dataStatus: ConditionDataStatus
  conditions: ConditionEvaluationResult[]
  groups: GroupEvaluationResult[]
}

export interface BlockEvaluationResult {
  passed: boolean
  totalScore: number
  maxScore: number
  dataStatus: ConditionDataStatus
  summary: string
  root: GroupEvaluationResult
  flatConditions: ConditionEvaluationResult[]
}

export interface ConditionScanMatch {
  templateKey: string
  templateVersion: number
  tsCode: string
  stockName: string | null
  tradeDate: string
  windowStart: string | null
  windowEnd: string | null
  totalScore: number
  dataStatus: ConditionDataStatus
  evidence: BlockEvaluationResult
}

export interface ConditionTemplateSummary {
  id: number
  templateKey: string
  name: string
  description: string | null
  version: number
  enabled: boolean
  updatedAt: number
  lastRunAt: number | null
  lastMatchCount: number | null
}

export const CONDITION_BLOCK_PARAMETER_DEFS: Record<ConditionBlockType, ConditionParameterDefinition[]> = {
  minute_window_gain: [
    { key: 'windowMinutes', label: '窗口分钟数', unit: '分钟', min: 1, max: 120, step: 1, defaultValue: 15 },
    { key: 'minGainPct', label: '最小涨幅', unit: '%', min: 0, max: 30, step: 0.1, defaultValue: 3 },
  ],
  minute_window_amount_ratio: [
    { key: 'windowMinutes', label: '窗口分钟数', unit: '分钟', min: 1, max: 120, step: 1, defaultValue: 15 },
    { key: 'baselineMinutes', label: '基准分钟数', unit: '分钟', min: 5, max: 180, step: 1, defaultValue: 30 },
    { key: 'minRatio', label: '最小放大倍数', unit: '倍', min: 1, max: 20, step: 0.1, defaultValue: 2 },
  ],
  minute_window_volume_ratio: [
    { key: 'windowMinutes', label: '窗口分钟数', unit: '分钟', min: 1, max: 120, step: 1, defaultValue: 15 },
    { key: 'baselineMinutes', label: '基准分钟数', unit: '分钟', min: 5, max: 180, step: 1, defaultValue: 30 },
    { key: 'minRatio', label: '最小放大倍数', unit: '倍', min: 1, max: 20, step: 0.1, defaultValue: 1.8 },
  ],
  pullback_after_high: [
    { key: 'afterMinutes', label: '观察分钟数', unit: '分钟', min: 1, max: 180, step: 1, defaultValue: 30 },
    { key: 'maxPullbackPct', label: '最大回撤', unit: '%', min: 0, max: 20, step: 0.1, defaultValue: 1.2 },
  ],
  hold_above_gain_ratio: [
    { key: 'afterMinutes', label: '观察分钟数', unit: '分钟', min: 1, max: 180, step: 1, defaultValue: 30 },
    { key: 'minHoldRatio', label: '站稳比例', unit: '%', min: 0, max: 100, step: 1, defaultValue: 65 },
  ],
  close_retention: [
    { key: 'minRetentionPct', label: '收盘保持度', unit: '%', min: 0, max: 100, step: 1, defaultValue: 60 },
  ],
}

export function isConditionBlock(node: ConditionGroup | ConditionBlock): node is ConditionBlock {
  return 'type' in node
}
