import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { saveDecisionJudgmentVersion } from '../../electron/main/database/decisionJudgmentRepository'
import { listDueDecisionJudgmentFollowUps } from '../../electron/main/database/decisionJudgmentFollowUpRepository'
import { completeDecisionJudgmentFollowUp } from '../../electron/main/services/decisionJudgmentFollowUpService'

function judgmentInput(overrides: Partial<Parameters<typeof saveDecisionJudgmentVersion>[1]> = {}) {
  return {
    requestId: randomUUID(),
    tsCode: '600000.SH',
    stockName: '浦发银行',
    tag: 'watch' as const,
    note: '等待量能确认',
    evidenceSnapshot: {
      primaryTitle: '突破 20 日高点',
      primarySummary: '价格突破，量能仍待确认',
      sourceCount: 2,
      maxPriority: 4,
      trustHint: '两项本地事实可用',
      evidence: [{ key: 'volume', label: '量能', status: 'missing' as const, detail: '尚未放量' }],
    },
    ...overrides,
  }
}

describe('判断回访仓库', () => {
  let db: Database.Database
  const dueAt = Date.UTC(2026, 6, 15, 9)
  const now = Date.UTC(2026, 6, 15, 12)

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  it('只列出最新且到期的未完成判断，并以 requestId 幂等完成回访', () => {
    const original = saveDecisionJudgmentVersion(db, judgmentInput({ reviewDueAt: dueAt }), dueAt - 1)

    expect(listDueDecisionJudgmentFollowUps(db, { now })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ judgmentId: original.id, status: 'due' })],
    })

    const requestId = randomUUID()
    const completed = completeDecisionJudgmentFollowUp(db, {
      requestId,
      judgmentId: original.id,
      action: 'maintain',
      note: '量能仍未确认，继续观察',
      nextReviewDueAt: now + 86_400_000,
    }, now)
    const retried = completeDecisionJudgmentFollowUp(db, {
      requestId,
      judgmentId: original.id,
      action: 'maintain',
      note: '重试不得覆盖',
      nextReviewDueAt: null,
    }, now + 1)

    expect(retried).toEqual(completed)
    expect(completed).toMatchObject({
      action: 'maintain',
      sourceJudgmentId: original.id,
      resultJudgment: { versionNumber: 2, reviewDueAt: now + 86_400_000 },
    })
    expect(listDueDecisionJudgmentFollowUps(db, { now })).toMatchObject({ total: 0, items: [] })
  })

  it('修正判断使用新标签，结束观察固定写入 done 且不再安排回访', () => {
    const reviseSource = saveDecisionJudgmentVersion(db, judgmentInput({ reviewDueAt: dueAt }), dueAt - 2)
    const revised = completeDecisionJudgmentFollowUp(db, {
      requestId: randomUUID(),
      judgmentId: reviseSource.id,
      action: 'revise',
      tag: 'risk_off',
      note: '风险证据增强',
      nextReviewDueAt: now + 3 * 86_400_000,
    }, now)
    const closeSource = saveDecisionJudgmentVersion(db, judgmentInput({
      requestId: randomUUID(),
      judgmentGroupId: revised.resultJudgment.judgmentGroupId,
      tag: 'risk_off',
      reviewDueAt: now,
    }), now)
    const closed = completeDecisionJudgmentFollowUp(db, {
      requestId: randomUUID(),
      judgmentId: closeSource.id,
      action: 'close',
      note: '观察目标已结束',
      nextReviewDueAt: now + 14 * 86_400_000,
    }, now + 1)

    expect(revised.resultJudgment).toMatchObject({ tag: 'risk_off', versionNumber: 2 })
    expect(closed.resultJudgment).toMatchObject({ tag: 'done', reviewDueAt: null, versionNumber: 4 })
  })

  it('拒绝未到期判断和缺少新标签的修正', () => {
    const future = saveDecisionJudgmentVersion(db, judgmentInput({ reviewDueAt: now + 1 }), now)
    expect(() => completeDecisionJudgmentFollowUp(db, {
      requestId: randomUUID(), judgmentId: future.id, action: 'maintain',
    }, now)).toThrowError(expect.objectContaining({ code: 'INVALID_PARAM' }))

    const due = saveDecisionJudgmentVersion(db, judgmentInput({ reviewDueAt: dueAt }), dueAt - 1)
    expect(() => completeDecisionJudgmentFollowUp(db, {
      requestId: randomUUID(), judgmentId: due.id, action: 'revise',
    }, now)).toThrowError(expect.objectContaining({ code: 'INVALID_PARAM' }))
  })

  it('回访事实写入失败时回滚新判断版本', () => {
    const source = saveDecisionJudgmentVersion(db, judgmentInput({ reviewDueAt: dueAt }), dueAt - 1)
    db.exec(`
      CREATE TRIGGER fail_follow_up_insert
      BEFORE INSERT ON decision_judgment_follow_ups
      BEGIN
        SELECT RAISE(ABORT, 'follow-up insert failed');
      END;
    `)

    expect(() => completeDecisionJudgmentFollowUp(db, {
      requestId: randomUUID(),
      judgmentId: source.id,
      action: 'maintain',
      note: '继续观察',
      nextReviewDueAt: now + 86_400_000,
    }, now)).toThrow('follow-up insert failed')
    expect((db.prepare('SELECT COUNT(*) AS count FROM decision_judgments').get() as { count: number }).count).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS count FROM decision_judgment_follow_ups').get() as { count: number }).count).toBe(0)
    expect(listDueDecisionJudgmentFollowUps(db, { now })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ judgmentId: source.id })],
    })
  })
})