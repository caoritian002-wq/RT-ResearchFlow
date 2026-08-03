import type { DecisionSignalItem } from './SignalCard'

export interface DecisionProgressModel {
  total: number
  pending: number
  read: number
  watching: number
  dismissed: number
  resolved: number
  title: string
  description: string
}

export function buildDecisionProgressModel(signals: DecisionSignalItem[]): DecisionProgressModel {
  const total = signals.length
  const read = signals.filter(signal => signal.status === 'READ').length
  const watching = signals.filter(signal => signal.status === 'WATCHING').length
  const dismissed = signals.filter(signal => signal.status === 'DISMISSED').length
  const resolved = signals.filter(signal => !!signal.resolvedAt || !!signal.resolution).length
  const pending = signals.filter(signal => signal.status === 'NEW' || signal.status === 'WATCHING').filter(signal => !signal.resolvedAt).length

  if (total === 0) {
    return {
      total,
      pending,
      read,
      watching,
      dismissed,
      resolved,
      title: '今日暂无信号',
      description: '当前筛选条件下没有需要展示的信号。'
    }
  }

  if (pending === 0) {
    return {
      total,
      pending,
      read,
      watching,
      dismissed,
      resolved,
      title: '待处理已清空',
      description: '今日信号都已阅读、忽略或完成处置, 可以继续复盘关注项。'
    }
  }

  return {
    total,
    pending,
    read,
    watching,
    dismissed,
    resolved,
    title: `还有 ${pending} 条待处理`,
    description: '优先处理持仓、风险、高优先级和重复触发信号。'
  }
}