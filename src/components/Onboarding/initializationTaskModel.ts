import type { DiagnosticRunAction, DiagnosticsHealthSnapshot } from './onboardingModel'

export type InitializationTaskKey = 'refresh-before' | 'sync-stock-basic' | 'sync-historical-daily' | 'sync-concepts' | 'backfill-decision' | 'refresh-after'
export type InitializationTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'deferred' | 'retryable'
export type InitializationFailurePolicy = 'stop' | 'continue'

export interface InitializationTaskDefinition {
  key: InitializationTaskKey
  title: string
  description: string
  action: DiagnosticRunAction
  quickStart: 'run' | 'defer'
  requiresTushare: boolean
  failurePolicy: InitializationFailurePolicy
}

export interface InitializationTaskState extends InitializationTaskDefinition {
  status: InitializationTaskStatus
  startedAt?: number
  endedAt?: number
  message?: string
  error?: string
}

export interface InitializationFlowState {
  running: boolean
  startedAt?: number
  endedAt?: number
  tasks: InitializationTaskState[]
  currentTaskKey?: InitializationTaskKey
  message?: string
  error?: string
}

export const INITIALIZATION_TASKS: InitializationTaskDefinition[] = [
  {
    key: 'refresh-before',
    title: '刷新诊断状态',
    description: '先确认当前配置和本地缓存状态。',
    action: 'refreshHealth',
    quickStart: 'run',
    requiresTushare: false,
    failurePolicy: 'stop'
  },
  {
    key: 'sync-stock-basic',
    title: '同步股票基础数据',
    description: '准备名称和代码索引；有Tushare时快速同步，无Token时在后台低频补齐。',
    action: 'syncStockBasic',
    quickStart: 'run',
    requiresTushare: false,
    failurePolicy: 'continue'
  },
  {
    key: 'sync-historical-daily',
    title: '同步全市场历史日线',
    description: '准备近 2 年全市场日线底座, 支撑条件积木扫描、策略回测和历史筛选。',
    action: 'syncHistoricalDaily',
    quickStart: 'defer',
    requiresTushare: false,
    failurePolicy: 'continue'
  },
  {
    key: 'sync-concepts',
    title: '同步题材成分',
    description: '准备短线策略、产业链和板块资金流向所需的题材关系。',
    action: 'syncConceptMembers',
    quickStart: 'defer',
    requiresTushare: true,
    failurePolicy: 'continue'
  },
  {
    key: 'backfill-decision',
    title: '补种今日看板',
    description: '基于已有本地数据生成今日看板初始信号。',
    action: 'backfillDecisionSignals',
    quickStart: 'run',
    requiresTushare: false,
    failurePolicy: 'continue'
  },
  {
    key: 'refresh-after',
    title: '刷新完成状态',
    description: '重新读取诊断结果并更新首页空态。',
    action: 'refreshHealth',
    quickStart: 'run',
    requiresTushare: false,
    failurePolicy: 'continue'
  }
]

export const QUICK_START_HISTORY_DEFERRED_MESSAGE = '完整两年全市场日线属于增强能力，首次初始化暂不阻塞；可稍后在后台低频回补，并从本地检查点跨会话继续。'

export function getQuickStartDeferral(task: InitializationTaskDefinition, singleTask: boolean): string | null {
  if (singleTask || task.quickStart !== 'defer') return null
  if (task.key === 'sync-historical-daily') return QUICK_START_HISTORY_DEFERRED_MESSAGE
  if (task.key === 'sync-concepts') return '全市场题材成分属于增强能力，首次初始化暂不阻塞；可稍后按当前题材源单独同步。'
  return '该增强任务已延后，可稍后单独执行。'
}

export function createInitialFlowState(): InitializationFlowState {
  return {
    running: false,
    tasks: INITIALIZATION_TASKS.map(task => ({ ...task, status: 'pending' }))
  }
}

export function findDiagnosticItem(snapshot: DiagnosticsHealthSnapshot | null, keys: string[]) {
  return snapshot?.groups.flatMap(group => group.items).find(item => keys.includes(item.key))
}

export function shouldSkipInitializationTask(snapshot: DiagnosticsHealthSnapshot | null, task: InitializationTaskDefinition): string | null {
  if (!snapshot) return null
  const stockBasic = findDiagnosticItem(snapshot, ['freshness.stockBasic', 'stockBasic'])
  const dailyClose = findDiagnosticItem(snapshot, ['freshness.dailyClose', 'dailyClose'])
  const concept = findDiagnosticItem(snapshot, ['freshness.kplConcept', 'freshness.thsConcept', 'freshness.dcConcept', 'kplConcept', 'thsConcept', 'dcConcept'])
  const decision = findDiagnosticItem(snapshot, ['freshness.decisionSignals', 'decisionSignals'])

  if (task.key === 'sync-stock-basic' && stockBasic?.status === 'ok') return '股票基础数据已可用, 跳过同步。'
  if (task.key === 'sync-historical-daily' && dailyClose?.status === 'ok') return '全市场历史日线底座已可用, 跳过同步。'
  if (task.key === 'sync-concepts' && concept?.status === 'ok') return '题材成分数据已可用, 跳过同步。'
  if (task.key === 'backfill-decision' && decision?.status === 'ok') return '今日看板已有可用状态, 跳过补种。'
  return null
}

export function getFlowProgress(flow: InitializationFlowState): { done: number; total: number; pct: number; failed: number; deferred: number } {
  const total = flow.tasks.length
  const done = flow.tasks.filter(task => task.status === 'success' || task.status === 'skipped').length
  const failed = flow.tasks.filter(task => task.status === 'failed' || task.status === 'retryable').length
  const deferred = flow.tasks.filter(task => task.status === 'deferred').length
  return { done, total, failed, deferred, pct: total > 0 ? Math.round((done / total) * 100) : 0 }
}

export function formatTaskDuration(task: InitializationTaskState): string {
  if (!task.startedAt) return '—'
  const end = task.endedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - task.startedAt) / 1000))
  return `${seconds}s`
}
