import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { createSession, getSession } from '../../electron/main/database/aiAnalysisSessionRepository'
import {
  CandidateRecoveryError,
  recoverSessionCandidates,
} from '../../electron/main/services/aiCandidateRecoveryService'

function createArticleSession(db: Database.Database, response = '首轮研判\nSTOCK_CODES: NONE'): number {
  return createSession(db, {
    provider: 'chatgpt',
    model: 'gpt-5.6-sol',
    articleUrls: ['https://example.com/news'],
    promptSent: 'prompt',
    response,
    scanRunId: null,
    isError: false,
  })
}

describe('FR-240 历史会话候选恢复', () => {
  it('把一次恢复结果追加写回原会话并返回合法代码', async () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const sessionId = createArticleSession(db)
      const attempt = vi.fn(async (response: string) => ({
        response: `${response}\n\n## A股标的映射补充\nSTOCK_CODES: 600000|浦发银行`,
      }))
      const result = await recoverSessionCandidates(db, sessionId, attempt)
      expect(result).toEqual(expect.objectContaining({ recovered: true, updated: true, stockCodes: ['600000'] }))
      expect(getSession(db, sessionId)?.response).toContain('A股标的映射补充')
    } finally {
      db.close()
    }
  })

  it('已有合法代码时直接返回且不再次调用模型', async () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const sessionId = createArticleSession(db, '首轮研判\nSTOCK_CODES: 000001|平安银行')
      const attempt = vi.fn()
      const result = await recoverSessionCandidates(db, sessionId, attempt)
      expect(result).toEqual(expect.objectContaining({ recovered: false, updated: false, stockCodes: ['000001'] }))
      expect(attempt).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('恢复调用失败时保留原响应', async () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const sessionId = createArticleSession(db)
      const before = getSession(db, sessionId)?.response
      await expect(recoverSessionCandidates(db, sessionId, async () => {
        throw new Error('upstream timeout')
      })).rejects.toThrow('upstream timeout')
      expect(getSession(db, sessionId)?.response).toBe(before)
    } finally {
      db.close()
    }
  })

  it('损坏的文章来源JSON被隔离为稳定无效状态', async () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const sessionId = createArticleSession(db)
      db.prepare('UPDATE ai_analysis_sessions SET articleUrls = ? WHERE id = ?').run('{broken', sessionId)
      await expect(recoverSessionCandidates(db, sessionId, vi.fn())).rejects.toMatchObject<Partial<CandidateRecoveryError>>({
        code: 'INVALID_STATE',
      })
    } finally {
      db.close()
    }
  })
})
