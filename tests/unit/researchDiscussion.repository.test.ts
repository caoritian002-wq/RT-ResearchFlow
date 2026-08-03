import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createSession, deleteAllSessions, listSessions } from '../../electron/main/database/aiAnalysisSessionRepository'
import { runMigrations } from '../../electron/main/database/db'
import {
  createResearchDiscussionContext,
  findResumableResearchDiscussion,
  listResearchDiscussionContexts,
  updateResearchDiscussionProgress,
} from '../../electron/main/database/researchDiscussionRepository'
import { deleteAllResearchDiscussions } from '../../electron/main/services/researchDiscussionContextService'

describe('研究讨论上下文仓库', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  function createDiscussion(index: number): number {
    const sessionId = createSession(db, {
      provider: 'qwen', model: 'test', articleUrls: [], promptSent: '', response: null,
      scanRunId: null, isError: false, messages: [{ role: 'user', content: `讨论 ${index}` }],
    })
    createResearchDiscussionContext(db, {
      sessionId,
      requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      originType: 'decision_signal', originId: String(index), originTitle: `信号 ${index}`,
      originOccurredAt: index, originContentHash: `hash-${index}`,
      contextSnapshotJson: JSON.stringify({ items: [{ key: 'signal', excerpt: `信号 ${index}` }] }),
      contextKeysJson: '["signal"]', includedContextKeysJson: '["signal"]',
      returnTargetJson: JSON.stringify({ tab: 'decision-center', entityId: String(index), stateKey: 'signal-detail' }),
      projectId: null, baseSnapshotId: null, baseSelectionReason: 'unassigned', now: index + 1,
    })
    return sessionId
  }

  it('普通清除会话保护全部研究讨论且列表可分页超过100条', () => {
    for (let index = 1; index <= 105; index += 1) createDiscussion(index)
    createSession(db, { provider: 'qwen', model: 'test', articleUrls: [], promptSent: '', response: null, scanRunId: null, isError: false })

    expect(deleteAllSessions(db, false)).toBe(1)
    expect(listSessions(db)).toHaveLength(105)
    expect(listResearchDiscussionContexts(db, { offset: 0, limit: 100 })).toMatchObject({ total: 105, items: { length: 100 } })
    expect(listResearchDiscussionContexts(db, { offset: 100, limit: 100 }).items).toHaveLength(5)
    expect(deleteAllResearchDiscussions(db)).toBe(105)
    expect(listResearchDiscussionContexts(db, { limit: 100 }).total).toBe(0)
    expect(listSessions(db)).toHaveLength(0)
  })

  it('仅恢复仍可继续的同来源讨论', () => {
    const sessionId = createDiscussion(7)
    expect(findResumableResearchDiscussion(db, 'decision_signal', '7', null)?.session_id).toBe(sessionId)

    updateResearchDiscussionProgress(db, sessionId, { status: 'applied' })
    expect(findResumableResearchDiscussion(db, 'decision_signal', '7', null)).toBeNull()
  })
})
