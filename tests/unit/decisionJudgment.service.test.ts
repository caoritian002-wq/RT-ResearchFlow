import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  getDecisionSignalEvents,
  upsertDecisionSignal,
} from '../../electron/main/database/decisionSignalsRepository'
import {
  DecisionJudgmentServiceError,
  saveDecisionJudgment,
} from '../../electron/main/services/decisionJudgmentService'

function judgmentInput(signalId?: number) {
  return {
    requestId: randomUUID(),
    tsCode: '600000.SH',
    stockName: '浦发银行',
    tag: 'insufficient' as const,
    note: '等待成交量证据',
    sourceSignalId: signalId,
    relatedSignalIds: signalId == null ? [] : [signalId],
    evidenceSnapshot: {
      primaryTitle: '突破 20 日高点',
      primarySummary: '量能证据尚不完整',
      sourceCount: 1,
      maxPriority: 4,
      trustHint: '需要补充证据',
      evidence: [{ key: 'volume', label: '量能', status: 'missing' as const, detail: '当前缺失' }],
    },
  }
}

describe('决策判断原子服务', () => {
  let db: Database.Database
  const now = Date.UTC(2026, 6, 15, 12)

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  function createSignal() {
    return upsertDecisionSignal(db, {
      sourceModule: 'trend',
      strategyKey: 'trend.breakHigh20',
      tsCode: '600000.SH',
      stockName: '浦发银行',
      conceptCode: null,
      conceptName: null,
      signalType: 'OPPORTUNITY',
      direction: 'BULLISH',
      priority: 4,
      score: null,
      confidence: null,
      title: '突破 20 日高点',
      summary: '测试信号',
      reasonJson: null,
      sourceRefJson: null,
      status: 'NEW',
      dedupKey: randomUUID(),
      signalTime: now,
      expireAt: now + 86_400_000,
      createdAt: now,
      updatedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      acknowledgedAt: null,
      watchedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      resolution: null,
      resolutionNote: null,
    }).signal
  }

  it('在同一事务中保存判断并投影信号，重试不重复事件', () => {
    const signal = createSignal()
    const input = judgmentInput(signal.id)
    const first = saveDecisionJudgment(db, input, now)
    const eventCount = getDecisionSignalEvents(db, signal.id).length
    const retried = saveDecisionJudgment(db, { ...input, note: '重试不覆盖' }, now + 1)

    expect(first).toMatchObject({ versionNumber: 1, sourceSignalId: signal.id })
    expect(first.projectedSignal).toMatchObject({
      status: 'WATCHING',
      resolution: 'RESOLVED_DATA_ISSUE',
      resolutionNote: '[judgment:insufficient] 等待成交量证据',
    })
    expect(retried.id).toBe(first.id)
    expect(getDecisionSignalEvents(db, signal.id)).toHaveLength(eventCount)
  })

  it('来源信号不存在时不保存判断', () => {
    expect(() => saveDecisionJudgment(db, judgmentInput(999), now)).toThrowError(
      expect.objectContaining<Partial<DecisionJudgmentServiceError>>({ code: 'SOURCE_SIGNAL_NOT_FOUND' }),
    )
    expect((db.prepare('SELECT COUNT(*) AS count FROM decision_judgments').get() as { count: number }).count).toBe(0)
  })

  it('信号投影失败时回滚判断和信号事件', () => {
    const signal = createSignal()
    const eventsBefore = getDecisionSignalEvents(db, signal.id).length
    db.exec(`
      CREATE TRIGGER fail_judgment_projection
      BEFORE UPDATE ON decision_signals
      BEGIN
        SELECT RAISE(ABORT, 'projection failed');
      END;
    `)

    expect(() => saveDecisionJudgment(db, judgmentInput(signal.id), now)).toThrow('projection failed')
    expect((db.prepare('SELECT COUNT(*) AS count FROM decision_judgments').get() as { count: number }).count).toBe(0)
    expect(getDecisionSignalEvents(db, signal.id)).toHaveLength(eventsBefore)
  })
})