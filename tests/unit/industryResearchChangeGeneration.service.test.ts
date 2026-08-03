import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '../../electron/main/database/aiAnalysisSessionRepository'
import { runMigrations } from '../../electron/main/database/db'
import { createResearchDiscussionContext } from '../../electron/main/database/researchDiscussionRepository'
import { prepareDiscussionChanges } from '../../electron/main/services/industryResearchChangeGenerationService'

describe('讨论语义变更包生成服务', () => {
  let db: Database.Database
  let sessionId: number

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    sessionId = createSession(db, {
      provider: 'qwen', model: 'test-model', articleUrls: [], promptSent: '', response: null, scanRunId: null, isError: false,
      messages: [{ role: 'user', content: '讨论供给拐点' }, { role: 'assistant', content: '需要区分规划产能和有效供给' }],
    })
    createResearchDiscussionContext(db, {
      sessionId, requestId: '00000000-0000-4000-8000-000000000030', originType: 'manual', originId: null,
      originTitle: '主动研究问题', originOccurredAt: null, originContentHash: 'context-hash',
      contextSnapshotJson: JSON.stringify({ question: '光纤供给拐点' }), contextKeysJson: '["question"]', includedContextKeysJson: '["question"]',
      returnTargetJson: JSON.stringify({ tab: 'ai-analysis' }), projectId: null, baseSnapshotId: null, baseSelectionReason: 'unassigned',
    })
  })

  it('模型返回十个主题和50项候选时聚合为七个语义包', async () => {
    const modelChangeSets = Array.from({ length: 10 }, (_, setIndex) => ({
      title: `主题 ${setIndex}`, summary: '摘要', impact: '影响研究判断', action: 'revise', risk: 'low',
      affectedObjects: [{ type: 'graph', id: null, label: `主题 ${setIndex}` }], evidenceSummary: [],
      confidenceBoundary: '来自讨论，保持估算', requiresExpandedReview: false,
      candidates: Array.from({ length: 5 }, (_, candidateIndex) => ({
        kind: 'node', action: 'add', externalRef: `N-${setIndex}-${candidateIndex}`,
        sourceLocator: `discussion:message:${candidateIndex}`, statementType: 'estimate', primarySource: false,
        payload: { name: `节点 ${setIndex}-${candidateIndex}`, type: 'product' }, conflicts: [], warnings: [],
      })),
    }))
    const callAI = vi.fn(async () => ({ provider: 'qwen' as const, model: 'test-model', text: JSON.stringify({ noMaterialChange: false, summary: '已整理', changeSets: modelChangeSets }) }))

    const result = await prepareDiscussionChanges(db, {
      requestId: '00000000-0000-4000-8000-000000000031', sessionId, throughMessageIndex: 1,
    }, callAI)

    expect(result.changeSets).toHaveLength(7)
    expect(result.batch).toMatchObject({ changeSetCount: 7, candidateCount: 50 })
    expect(result.changeSets.find((item) => item.title === '其他相关研究增量')).toMatchObject({ candidateCount: 20 })
  })

  it('相同消息范围和上下文哈希幂等复用结果', async () => {
    const callAI = vi.fn(async () => ({ provider: 'qwen' as const, model: 'test-model', text: JSON.stringify({
      noMaterialChange: false,
      changeSets: [{ title: '新增假设', summary: '摘要', impact: '影响', action: 'add', risk: 'low', candidates: [{ kind: 'hypothesis', action: 'add', sourceLocator: 'discussion:message:1', statementType: 'hypothesis', payload: { statement: '价格上涨来自有效供给偏紧' } }] }],
    }) }))
    const input = { requestId: '00000000-0000-4000-8000-000000000032', sessionId, throughMessageIndex: 1 }
    const first = await prepareDiscussionChanges(db, input, callAI)
    const second = await prepareDiscussionChanges(db, { ...input, requestId: '00000000-0000-4000-8000-000000000033' }, callAI)

    expect(second.batch?.id).toBe(first.batch?.id)
    expect(callAI).toHaveBeenCalledTimes(1)
  })
})
