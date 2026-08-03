import type { ConfigDrawerTab } from '../ConfigDrawer/ConfigDrawer'
import type { Tab } from '../../store/appStore'

export type DiagnosticStatus = 'ok' | 'warning' | 'error'
export type DiagnosticRunAction = 'refreshHealth' | 'syncStockBasic' | 'syncHistoricalDaily' | 'syncConceptMembers' | 'backfillDecisionSignals'

export interface DiagnosticAction {
  key: 'open-datasource' | 'open-ai-config' | DiagnosticRunAction
  label: string
  kind: 'navigate' | 'run'
}

export interface DiagnosticItem {
  key: string
  title: string
  status: DiagnosticStatus
  message: string
  detail?: string
  recordCount?: number | null
  latestDate?: string | null
  checkedAt: number
  actions?: DiagnosticAction[]
}

export interface DiagnosticGroup {
  key: 'config' | 'freshness' | 'sync' | 'database'
  title: string
  items: DiagnosticItem[]
}

export interface DiagnosticsHealthSnapshot {
  status: DiagnosticStatus
  checkedAt: number
  summary: Record<DiagnosticStatus, number>
  groups: DiagnosticGroup[]
}

export type OnboardingAction =
  | { type: 'config'; tab: ConfigDrawerTab; label: string }
  | { type: 'run'; action: DiagnosticRunAction; label: string }
  | { type: 'nav'; tab: Tab; label: string }

export interface OnboardingStep {
  key: string
  title: string
  description: string
  status: DiagnosticStatus
  item?: DiagnosticItem
  action?: OnboardingAction
}

export interface OnboardingModel {
  steps: OnboardingStep[]
  completedCount: number
  totalCount: number
  progressPct: number
  shouldPrompt: boolean
  nextStep: OnboardingStep | null
}

export function getAllDiagnosticItems(snapshot: DiagnosticsHealthSnapshot | null): DiagnosticItem[] {
  return snapshot?.groups.flatMap(group => group.items) ?? []
}

function findItem(snapshot: DiagnosticsHealthSnapshot | null, keys: string[]): DiagnosticItem | undefined {
  return getAllDiagnosticItems(snapshot).find(item => keys.includes(item.key))
}

function findActionableConceptItem(snapshot: DiagnosticsHealthSnapshot | null): DiagnosticItem | undefined {
  if (!snapshot) return undefined
  const allItems = getAllDiagnosticItems(snapshot)
  return allItems.find(item => ['kplConcept', 'thsConcept', 'dcConcept'].includes(item.key) && item.actions?.some(action => action.key === 'syncConceptMembers'))
    ?? allItems.find(item => ['kplConcept', 'thsConcept', 'dcConcept'].includes(item.key) && item.status !== 'ok')
    ?? allItems.find(item => ['kplConcept', 'thsConcept', 'dcConcept'].includes(item.key))
}

function itemStatus(item: DiagnosticItem | undefined): DiagnosticStatus {
  return item?.status ?? 'warning'
}

function firstRunAction(item: DiagnosticItem | undefined): DiagnosticRunAction | null {
  const action = item?.actions?.find(candidate => candidate.kind === 'run')
  if (!action) return null
  if (action.key === 'syncStockBasic' || action.key === 'syncHistoricalDaily' || action.key === 'syncConceptMembers' || action.key === 'backfillDecisionSignals') return action.key
  return null
}

export function buildOnboardingModel(snapshot: DiagnosticsHealthSnapshot | null): OnboardingModel {
  const datasourceItem = findItem(snapshot, ['config.tushare'])
  const stockBasicItem = findItem(snapshot, ['freshness.stockBasic', 'stockBasic']) ?? findItem(snapshot, ['sync.stockBasic'])
  const dailyCloseItem = findItem(snapshot, ['freshness.dailyClose', 'dailyClose']) ?? findItem(snapshot, ['sync.historicalDaily'])
  const conceptItem = findActionableConceptItem(snapshot) ?? findItem(snapshot, ['sync.conceptMembers'])
  const aiConfigItem = findItem(snapshot, ['config.ai'])
  const decisionItem = findItem(snapshot, ['freshness.decisionSignals', 'decisionSignals']) ?? findItem(snapshot, ['sync.decisionBackfill'])

  const stockBasicAction = firstRunAction(stockBasicItem) ?? 'syncStockBasic'
  const dailyCloseAction = firstRunAction(dailyCloseItem) ?? 'syncHistoricalDaily'
  const conceptAction = firstRunAction(conceptItem) ?? 'syncConceptMembers'
  const decisionAction = firstRunAction(decisionItem) ?? 'backfillDecisionSignals'

  const steps: OnboardingStep[] = [
    {
      key: 'datasource',
      title: '配置 Tushare 数据源',
      description: datasourceItem?.message ?? '用于股票搜索、行情缓存、题材同步和短线策略数据。',
      status: itemStatus(datasourceItem),
      item: datasourceItem,
      action: { type: 'config', tab: 'datasource', label: '打开数据源' }
    },
    {
      key: 'stock-basic',
      title: '同步股票基础数据',
      description: stockBasicItem?.message ?? '初始化名称和代码索引, 让走势图搜索可以直接使用。',
      status: itemStatus(stockBasicItem),
      item: stockBasicItem,
      action: { type: 'run', action: stockBasicAction, label: '同步股票基础数据' }
    },
    {
      key: 'historical-daily',
      title: '同步全市场历史日线',
      description: dailyCloseItem?.message ?? '准备近 2 年全市场日线底座, 支撑策略扫描和回测。',
      status: itemStatus(dailyCloseItem),
      item: dailyCloseItem,
      action: { type: 'run', action: dailyCloseAction, label: '同步历史日线' }
    },
    {
      key: 'concept-members',
      title: '同步题材成分',
      description: conceptItem?.message ?? '为短线策略、产业链归因和板块资金流向准备本地题材关系。',
      status: itemStatus(conceptItem),
      item: conceptItem,
      action: { type: 'run', action: conceptAction, label: '同步题材成分' }
    },
    {
      key: 'ai-config',
      title: '配置 AI 模型',
      description: aiConfigItem?.message ?? '配置至少一个可用模型后, AI 分析和走势预测才能执行。',
      status: itemStatus(aiConfigItem),
      item: aiConfigItem,
      action: { type: 'config', tab: 'ai-config', label: '打开 AI 配置' }
    },
    {
      key: 'decision-signals',
      title: '补种今日看板信号',
      description: decisionItem?.message ?? '基于已有本地数据生成今日看板的初始信号。',
      status: itemStatus(decisionItem),
      item: decisionItem,
      action: { type: 'run', action: decisionAction, label: '补种今日看板' }
    },
    {
      key: 'enter-home',
      title: '进入今日看板',
      description: '完成初始化后, 从今日看板开始查看持仓、市场、资讯、策略和风险分区。',
      status: snapshot?.status === 'error' ? 'warning' : 'ok',
      action: { type: 'nav', tab: 'decision-center', label: '进入今日看板' }
    }
  ]

  const completedCount = steps.filter(step => step.status === 'ok').length
  const totalCount = steps.length
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const nextStep = steps.find(step => step.status !== 'ok') ?? steps[steps.length - 1] ?? null
  const shouldPrompt = steps.slice(0, -1).some(step => step.status !== 'ok')

  return { steps, completedCount, totalCount, progressPct, shouldPrompt, nextStep }
}
