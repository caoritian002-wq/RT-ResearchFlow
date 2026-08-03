import type { ConfigDrawerTab } from '../ConfigDrawer/ConfigDrawer'
import type { Tab } from '../../store/appStore'
import type { DiagnosticItem, DiagnosticRunAction, DiagnosticsHealthSnapshot, OnboardingAction } from './onboardingModel'

export type InitializationStatus = 'blocked' | 'actionRequired' | 'syncing' | 'usable' | 'complete'
export type InitializationEmptyReason = 'datasourceMissing' | 'stockBasicMissing' | 'initializing' | 'diagnosticsError' | 'readyNoSignals'

export interface InitializationAction {
  type: 'config' | 'run' | 'nav' | 'guide'
  label: string
  tab?: ConfigDrawerTab | Tab
  runAction?: DiagnosticRunAction
}

export interface InitializationModel {
  status: InitializationStatus
  title: string
  description: string
  minimumUsable: boolean
  emptyReason: InitializationEmptyReason
  primaryAction: InitializationAction
  secondaryAction?: InitializationAction
  blockers: DiagnosticItem[]
  warnings: DiagnosticItem[]
}

function allItems(snapshot: DiagnosticsHealthSnapshot | null): DiagnosticItem[] {
  return snapshot?.groups.flatMap(group => group.items) ?? []
}

function findItem(snapshot: DiagnosticsHealthSnapshot | null, keys: string[]): DiagnosticItem | undefined {
  return allItems(snapshot).find(item => keys.includes(item.key))
}

function hasRecords(item: DiagnosticItem | undefined): boolean {
  return (item?.recordCount ?? 0) > 0
}

function isOk(item: DiagnosticItem | undefined): boolean {
  return item?.status === 'ok'
}

function actionFromOnboarding(action: OnboardingAction | undefined): InitializationAction | undefined {
  if (!action) return undefined
  if (action.type === 'config') return { type: 'config', tab: action.tab, label: action.label }
  if (action.type === 'run') return { type: 'run', runAction: action.action, label: action.label }
  return { type: 'nav', tab: action.tab, label: action.label }
}

export function buildInitializationModel(snapshot: DiagnosticsHealthSnapshot | null, nextAction?: OnboardingAction, syncing = false): InitializationModel {
  if (!snapshot) {
    return {
      status: 'syncing',
      title: '正在读取初始化状态',
      description: '正在检查数据源、基础数据和今日看板状态。',
      minimumUsable: false,
      emptyReason: 'initializing',
      primaryAction: { type: 'guide', label: '查看引导' },
      secondaryAction: { type: 'config', tab: 'diagnostics', label: '打开诊断页' },
      blockers: [],
      warnings: []
    }
  }

  const items = allItems(snapshot)
  const tushare = findItem(snapshot, ['config.tushare'])
  const ai = findItem(snapshot, ['config.ai'])
  const stockBasic = findItem(snapshot, ['stockBasic', 'sync.stockBasic'])
  const decisionSignals = findItem(snapshot, ['decisionSignals', 'sync.decisionBackfill'])
  const blockers = items.filter(item => item.status === 'error')
  const warnings = items.filter(item => item.status === 'warning')
  const stockBasicReady = isOk(stockBasic) || hasRecords(stockBasic)
  const decisionReady = isOk(decisionSignals) || hasRecords(decisionSignals)
  const minimumUsable = isOk(tushare) && stockBasicReady

  if (syncing) {
    return {
      status: 'syncing',
      title: '初始化动作正在执行',
      description: '当前同步或补种任务还在执行, 完成后会自动刷新初始化状态。',
      minimumUsable,
      emptyReason: 'initializing',
      primaryAction: { type: 'guide', label: '查看引导' },
      secondaryAction: { type: 'nav', tab: 'decision-center', label: '留在今日看板' },
      blockers,
      warnings
    }
  }

  if (!isOk(tushare)) {
    return {
      status: 'blocked',
      title: '需要先配置 Tushare',
      description: tushare?.message ?? 'Tushare 是股票基础数据、题材同步和今日看板补种的基础数据源。',
      minimumUsable: false,
      emptyReason: 'datasourceMissing',
      primaryAction: { type: 'config', tab: 'datasource', label: '打开数据源配置' },
      secondaryAction: { type: 'guide', label: '查看初始化引导' },
      blockers,
      warnings
    }
  }

  if (!stockBasicReady) {
    return {
      status: 'actionRequired',
      title: '需要同步股票基础数据',
      description: stockBasic?.message ?? '本地股票基础数据为空时, 走势图搜索和今日看板补种都缺少基础索引。',
      minimumUsable: false,
      emptyReason: 'stockBasicMissing',
      primaryAction: { type: 'run', runAction: 'syncStockBasic', label: '同步股票基础数据' },
      secondaryAction: { type: 'guide', label: '查看初始化引导' },
      blockers,
      warnings
    }
  }

  if (blockers.length > 0) {
    return {
      status: 'actionRequired',
      title: '诊断发现需要处理的问题',
      description: blockers[0]?.message ?? '部分关键数据或数据库状态异常, 建议先进入诊断页处理。',
      minimumUsable,
      emptyReason: 'diagnosticsError',
      primaryAction: { type: 'config', tab: 'diagnostics', label: '打开诊断页' },
      secondaryAction: { type: 'guide', label: '查看初始化引导' },
      blockers,
      warnings
    }
  }

  if (!decisionReady) {
    const fallbackAction = actionFromOnboarding(nextAction)
    return {
      status: 'usable',
      title: '基础初始化已可用',
      description: decisionSignals?.message ?? '基础数据已具备, 今日看板可以进入; 若仍为空, 可补种今日信号或等待新的信号产生。',
      minimumUsable: true,
      emptyReason: 'readyNoSignals',
      primaryAction: fallbackAction ?? { type: 'run', runAction: 'backfillDecisionSignals', label: '补种今日看板' },
      secondaryAction: isOk(ai) ? { type: 'guide', label: '查看初始化引导' } : { type: 'config', tab: 'ai-config', label: '配置 AI 模型' },
      blockers,
      warnings
    }
  }

  return {
    status: warnings.length > 0 ? 'usable' : 'complete',
    title: warnings.length > 0 ? '系统已经可用' : '初始化已完成',
    description: warnings.length > 0 ? '核心初始化条件已经满足, 仍有非阻塞诊断项可在诊断页继续优化。' : '基础数据、诊断状态和今日看板已经具备可用条件。',
    minimumUsable: true,
    emptyReason: 'readyNoSignals',
    primaryAction: { type: 'nav', tab: 'decision-center', label: '查看今日看板' },
    secondaryAction: warnings.length > 0 ? { type: 'config', tab: 'diagnostics', label: '查看诊断' } : { type: 'guide', label: '查看初始化引导' },
    blockers,
    warnings
  }
}
