import { describe, expect, it } from 'vitest'
import {
  decodeDecisionReturnState,
  encodeDecisionReturnState,
  formatDecisionNumber,
  groupReviewQueue,
  reviewAgenda,
} from '../../src/components/IndustryResearch/industryResearchDecisionModel'
import type { ResearchReviewQueueItem } from '../../src/components/IndustryResearch/industryResearchTypes'

function item(id: string, kind: string, dueAt: number | null): ResearchReviewQueueItem {
  return {
    id, kind, subjectKind: 'decision', subjectId: id, sourceEventId: null,
    reason: `事项${id}`, dueAt, persisted: true, payload: {}, dataStatus: 'ok',
  }
}

describe('产业研究决策前端模型', () => {
  it('缺值、无穷值保持不可用，不会显示为0', () => {
    expect(formatDecisionNumber(null, '%')).toBe('不可用')
    expect(formatDecisionNumber(Number.NaN)).toBe('不可用')
    expect(formatDecisionNumber(Number.POSITIVE_INFINITY)).toBe('不可用')
    expect(formatDecisionNumber(0, '%')).toBe('0.00%')
  })

  it('待复核按业务类型分组且保留未知类型', () => {
    const groups = groupReviewQueue([
      item('1', 'trigger', null), item('2', 'trigger', null), item('3', 'custom_review', null),
    ])
    expect(groups).toEqual([
      expect.objectContaining({ kind: 'trigger', label: '触发命中', items: expect.arrayContaining([expect.objectContaining({ id: '1' }), expect.objectContaining({ id: '2' })]) }),
      expect.objectContaining({ kind: 'custom_review', label: 'custom_review', items: [expect.objectContaining({ id: '3' })] }),
    ])
  })

  it('回访议程稳定区分逾期、今日、本周和更晚', () => {
    const now = Date.parse('2026-07-17T00:00:00Z')
    const day = 86400000
    const agenda = reviewAgenda([
      item('overdue', 'trigger', now - 1),
      item('today', 'trigger', now + 1),
      item('week', 'trigger', now + 2 * day),
      item('later', 'trigger', now + 8 * day),
      item('undated', 'trigger', null),
    ], now)
    expect(agenda.map((bucket) => [bucket.key, bucket.items.map((entry) => entry.id)])).toEqual([
      ['overdue', ['overdue']], ['today', ['today']], ['week', ['week']], ['later', ['later']],
    ])
  })

  it('AI讨论返回状态往返恢复局部视图、公司和证券', () => {
    const encoded = encodeDecisionReturnState('monitoring', 'company-1', 'security-1')
    expect(decodeDecisionReturnState(encoded)).toEqual({
      view: 'monitoring', companyId: 'company-1', securityId: 'security-1',
    })
  })

  it('非法、未知或过长讨论状态安全回退', () => {
    expect(decodeDecisionReturnState('industry-research:decision?view=unknown')).toBeNull()
    expect(decodeDecisionReturnState('industry-research:decision?view=current&company=../secret')).toBeNull()
    expect(decodeDecisionReturnState(`industry-research:decision?view=current&company=${'a'.repeat(200)}`)).toBeNull()
    expect(decodeDecisionReturnState('industry-research:report')).toBeNull()
  })
})
