import type { InitializationAction, InitializationModel } from '../Onboarding/initializationModel'
import type { InitializationFlowState } from '../Onboarding/initializationTaskModel'

export interface DecisionEmptyStateModel {
  title: string
  description: string
  tone: 'amber' | 'blue' | 'red' | 'slate'
  primaryAction: InitializationAction
  secondaryAction?: InitializationAction
  flowMessage?: string
}

export function buildDecisionEmptyStateModel(initialization: InitializationModel | null, flow?: InitializationFlowState): DecisionEmptyStateModel {
  if (flow?.running) {
    return {
      title: '初始化任务正在执行',
      description: flow.message ?? '一键初始化正在后台推进, 完成后今日看板会自动刷新。',
      tone: 'blue',
      primaryAction: { type: 'guide', label: '查看初始化进度' },
      secondaryAction: { type: 'config', tab: 'diagnostics', label: '查看诊断' },
      flowMessage: flow.message
    }
  }

  if (flow?.error) {
    return {
      title: '初始化任务需要处理',
      description: flow.error,
      tone: 'red',
      primaryAction: { type: 'guide', label: '查看失败任务' },
      secondaryAction: { type: 'config', tab: 'diagnostics', label: '查看诊断' },
      flowMessage: flow.error
    }
  }

  if (!initialization) {
    return {
      title: '今日暂时没有需要处理的信号',
      description: '如果刚完成配置, 可以先打开初始化引导或诊断页确认基础数据状态; 若基础数据已可用, 这里为空代表当前规则暂未发现需要处理的机会或风险。',
      tone: 'slate',
      primaryAction: { type: 'guide', label: '打开初始化引导' },
      secondaryAction: { type: 'config', tab: 'diagnostics', label: '查看诊断' }
    }
  }

  if (initialization.emptyReason === 'datasourceMissing') {
    return {
      title: '需要先配置数据源',
      description: initialization.description,
      tone: 'amber',
      primaryAction: initialization.primaryAction,
      secondaryAction: initialization.secondaryAction
    }
  }

  if (initialization.emptyReason === 'stockBasicMissing') {
    return {
      title: '需要同步股票基础数据',
      description: initialization.description,
      tone: 'amber',
      primaryAction: initialization.primaryAction,
      secondaryAction: initialization.secondaryAction
    }
  }

  if (initialization.emptyReason === 'initializing') {
    return {
      title: '初始化任务正在执行',
      description: initialization.description,
      tone: 'blue',
      primaryAction: initialization.primaryAction,
      secondaryAction: initialization.secondaryAction
    }
  }

  if (initialization.emptyReason === 'diagnosticsError') {
    return {
      title: '诊断项需要处理',
      description: initialization.description,
      tone: 'red',
      primaryAction: initialization.primaryAction,
      secondaryAction: initialization.secondaryAction
    }
  }

  return {
    title: '今日暂时没有需要处理的信号',
    description: initialization.minimumUsable ? '核心初始化条件已经满足, 当前规则暂未发现值得处理的机会或风险。可以继续查看股票走势图、持仓趋势或资讯列表做主动复盘。' : initialization.description,
    tone: 'slate',
    primaryAction: initialization.primaryAction,
    secondaryAction: initialization.secondaryAction
  }
}
