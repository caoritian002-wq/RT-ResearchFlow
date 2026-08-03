import { describe, expect, it } from 'vitest'
import {
  activeChangeSets,
  canResolveChangeSet,
  changeSetActionLabel,
  changeSetStatusLabel,
  discussionStatusLabel,
} from '../../src/components/ResearchDiscussion/researchDiscussionModel'
import type { ResearchChangeSetSummary } from '../../src/components/ResearchDiscussion/researchDiscussionTypes'

function changeSet(status: ResearchChangeSetSummary['status']): ResearchChangeSetSummary {
  return {
    id: status, batchId: 'batch', title: '标题', summary: '摘要', impact: '影响', action: 'follow_up', status,
    risk: 'low', affectedObjects: [], evidenceSummary: [], confidenceBoundary: '边界', requiresExpandedReview: false,
    candidateCount: 1, sourceSessionId: 1, messageStartIndex: 0, messageEndIndex: 2,
  }
}

describe('研究讨论界面模型', () => {
  it('暂存保持中性且仍可继续处理', () => {
    expect(changeSetStatusLabel('deferred')).toBe('已暂存')
    expect(canResolveChangeSet(changeSet('deferred'))).toBe(true)
    expect(changeSetActionLabel('follow_up')).toBe('补充回访')
  })

  it('默认排除被新批次取代和失效的变更包', () => {
    expect(activeChangeSets([changeSet('pending'), changeSet('superseded'), changeSet('invalid')]).map((item) => item.status)).toEqual(['pending'])
    expect(discussionStatusLabel('partially_applied')).toBe('部分已写入')
  })
})
