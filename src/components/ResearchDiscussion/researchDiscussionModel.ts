import type { ResearchChangeSetSummary, ResearchDiscussionStatus } from './researchDiscussionTypes'

export function discussionStatusLabel(status: ResearchDiscussionStatus): string {
  if (status === 'changes_ready') return '已有研究增量'
  if (status === 'partially_applied') return '部分已写入'
  if (status === 'applied') return '已写入研究'
  if (status === 'archived') return '已归档'
  return '讨论中'
}

export function changeSetStatusLabel(status: ResearchChangeSetSummary['status']): string {
  if (status === 'accepted') return '已写入'
  if (status === 'rejected') return '已忽略'
  if (status === 'deferred') return '已暂存'
  if (status === 'superseded') return '已被新整理取代'
  if (status === 'conflicted') return '存在冲突'
  if (status === 'invalid') return '已失效'
  return '待处理'
}

export function changeSetActionLabel(action: ResearchChangeSetSummary['action']): string {
  if (action === 'revise') return '修正'
  if (action === 'strengthen') return '增强'
  if (action === 'weaken') return '弱化'
  if (action === 'refute') return '证伪'
  if (action === 'reopen') return '重开'
  if (action === 'follow_up') return '补充回访'
  if (action === 'no_change') return '无变化'
  return '新增'
}

export function canResolveChangeSet(item: ResearchChangeSetSummary): boolean {
  return item.status === 'pending' || item.status === 'deferred' || item.status === 'conflicted'
}

export function activeChangeSets(items: ResearchChangeSetSummary[]): ResearchChangeSetSummary[] {
  return items.filter((item) => item.status !== 'superseded' && item.status !== 'invalid')
}

