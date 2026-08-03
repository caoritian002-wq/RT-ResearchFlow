import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  DecisionJudgmentRepositoryError,
  getDecisionJudgment,
  getDecisionJudgmentHistoryAt,
  listDecisionJudgments,
  saveDecisionJudgmentVersion,
} from '../../electron/main/database/decisionJudgmentRepository'

function input(overrides: Partial<Parameters<typeof saveDecisionJudgmentVersion>[1]> = {}) {
  return {
    requestId: randomUUID(),
    tsCode: '600000.SH',
    stockName: '浦发银行',
    tag: 'watch' as const,
    note: '等待量能确认',
    relatedSignalIds: [1, 1, 2],
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

describe('决策判断账本仓库', () => {
  let db: Database.Database
  const now = Date.UTC(2026, 6, 15, 12)

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  it('同一请求幂等，修正追加不可变版本', () => {
    const request = input()
    const first = saveDecisionJudgmentVersion(db, request, now)
    const retried = saveDecisionJudgmentVersion(db, { ...request, note: '重试不应覆盖' }, now + 1)
    const second = saveDecisionJudgmentVersion(db, input({
      judgmentGroupId: first.judgmentGroupId,
      tag: 'risk_off',
      note: '风险上升',
    }), now + 2)

    expect(retried.id).toBe(first.id)
    expect(getDecisionJudgment(db, first.id)).toMatchObject({ versionNumber: 1, note: '等待量能确认' })
    expect(second).toMatchObject({ versionNumber: 2, versionCount: 2 })
    expect(getDecisionJudgment(db, second.id).versions.map((item) => item.versionNumber)).toEqual([2, 1])
    expect(listDecisionJudgments(db).items).toEqual([expect.objectContaining({ id: second.id, versionCount: 2 })])
    expect(listDecisionJudgments(db, { latestPerGroup: false }).items).toHaveLength(2)
  })

  it('拒绝不存在或股票不一致的修正目标', () => {
    expect(() => saveDecisionJudgmentVersion(db, input({ judgmentGroupId: randomUUID() }), now)).toThrowError(
      expect.objectContaining<Partial<DecisionJudgmentRepositoryError>>({ code: 'JUDGMENT_GROUP_NOT_FOUND' }),
    )
    const first = saveDecisionJudgmentVersion(db, input(), now)
    expect(() => saveDecisionJudgmentVersion(db, input({
      judgmentGroupId: first.judgmentGroupId,
      tsCode: '000001.SZ',
    }), now + 1)).toThrowError(
      expect.objectContaining<Partial<DecisionJudgmentRepositoryError>>({ code: 'JUDGMENT_GROUP_MISMATCH' }),
    )
  })

  it('列表不解析快照，详情隔离未知版本和损坏数据', () => {
    const saved = saveDecisionJudgmentVersion(db, input(), now)
    db.prepare('UPDATE decision_judgments SET schema_version = 99 WHERE id = ?').run(saved.id)
    expect(listDecisionJudgments(db).items).toHaveLength(1)
    expect(() => getDecisionJudgment(db, saved.id)).toThrowError(
      expect.objectContaining<Partial<DecisionJudgmentRepositoryError>>({ code: 'UNSUPPORTED_SCHEMA' }),
    )
    expect(() => getDecisionJudgmentHistoryAt(db, saved.id, null)).toThrowError(
      expect.objectContaining<Partial<DecisionJudgmentRepositoryError>>({ code: 'UNSUPPORTED_SCHEMA' }),
    )

    db.prepare('UPDATE decision_judgments SET schema_version = 1, evidence_snapshot_json = ? WHERE id = ?')
      .run('{broken', saved.id)
    expect(() => getDecisionJudgment(db, saved.id)).toThrowError(
      expect.objectContaining<Partial<DecisionJudgmentRepositoryError>>({ code: 'CORRUPT_DATA' }),
    )
    expect(() => getDecisionJudgmentHistoryAt(db, saved.id, null)).toThrowError(
      expect.objectContaining<Partial<DecisionJudgmentRepositoryError>>({ code: 'CORRUPT_DATA' }),
    )
  })
})
