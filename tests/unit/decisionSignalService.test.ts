import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../../electron/main/services/decisionNotificationService', () => ({
  notifyDecisionSignalNative: vi.fn(),
}))
import {
  dismissDecisionSignal,
  emitDecisionSignal,
  getDecisionSignalSummary,
  getTodayDecisionSignals,
  markDecisionSignalRead,
  watchDecisionSignal,
  expireOldDecisionSignals,
  getDecisionSignalTimeline,
  getTodayDecisionSignalContext,
  cleanupOldDecisionSignals,
  resolveDecisionSignal,
} from '../../electron/main/services/decisionSignalService'
import { getDecisionHistorySignals } from '../../electron/main/services/decisionReviewStatsService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE decision_signals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_module   TEXT NOT NULL,
      strategy_key    TEXT NOT NULL,
      ts_code         TEXT,
      stock_name      TEXT,
      concept_code    TEXT,
      concept_name    TEXT,
      signal_type     TEXT NOT NULL,
      direction       TEXT NOT NULL,
      priority        INTEGER NOT NULL,
      score           REAL,
      confidence      REAL,
      title           TEXT NOT NULL,
      summary         TEXT NOT NULL,
      reason_json     TEXT,
      source_ref_json TEXT,
      status          TEXT NOT NULL DEFAULT 'NEW',
      dedup_key       TEXT NOT NULL,
      signal_time     INTEGER NOT NULL,
      expire_at       INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      first_seen_at   INTEGER,
      last_seen_at    INTEGER,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      acknowledged_at INTEGER,
      watched_at      INTEGER,
      dismissed_at    INTEGER,
      resolved_at     INTEGER,
      resolution      TEXT,
      resolution_note TEXT
    );
    CREATE TABLE decision_signal_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id    INTEGER NOT NULL,
      event_type   TEXT NOT NULL,
      from_status  TEXT,
      to_status    TEXT,
      resolution   TEXT,
      reason       TEXT,
      note         TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_decision_signals_dedup ON decision_signals(dedup_key);
    CREATE INDEX idx_decision_signals_time ON decision_signals(signal_time DESC);
    CREATE INDEX idx_decision_signals_status ON decision_signals(status, priority, signal_time DESC);
    CREATE INDEX idx_decision_signals_stock ON decision_signals(ts_code, signal_time DESC);
    CREATE TABLE trade_cal (
      cal_date TEXT PRIMARY KEY,
      is_open INTEGER NOT NULL,
      pretrade_date TEXT
    );
  `)
  return db
}

function baseSignal(overrides: Partial<Parameters<typeof emitDecisionSignal>[1]> = {}): Parameters<typeof emitDecisionSignal>[1] {
  return {
    sourceModule: 'trend',
    strategyKey: 'trend.breakHigh20',
    tsCode: '600000.SH',
    stockName: '浦发银行',
    signalType: 'OPPORTUNITY',
    direction: 'BULLISH',
    priority: 3,
    score: 80,
    confidence: 72,
    title: '浦发银行突破 20 日高点',
    summary: '测试信号',
    dedupKey: 'test:dedup',
    ...overrides,
  }
}

describe('decisionSignalService', () => {
  it('首次插入P3及以上信号才广播，去重更新和P2不重复推送', () => {
    const db = createDb()
    const send = vi.fn()
    const win = {
      isDestroyed: () => false,
      webContents: { send },
    } as never

    emitDecisionSignal(db, baseSignal({ dedupKey: 'p2', priority: 2 }), win)
    emitDecisionSignal(db, baseSignal({ dedupKey: 'p3', priority: 3 }), win)
    emitDecisionSignal(db, baseSignal({ dedupKey: 'p3', priority: 4, summary: '去重更新' }), win)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('decision:signalCreated', expect.objectContaining({
      dedupKey: 'p3',
      priority: 3,
    }))
    db.close()
  })

  it('按 dedupKey 去重并更新内容', () => {
    const db = createDb()
    const first = emitDecisionSignal(db, baseSignal({ summary: '第一次' }))
    const second = emitDecisionSignal(db, baseSignal({ summary: '第二次', priority: 4 }))

    expect(second.id).toBe(first.id)
    expect(second.summary).toBe('第二次')
    expect(second.priority).toBe(4)
    expect(second.occurrenceCount).toBe(2)
    expect(getTodayDecisionSignals(db)).toHaveLength(1)
    expect(getDecisionSignalTimeline(db, first.id)?.map(event => event.eventType)).toEqual(['CREATED', 'UPDATED'])
    db.close()
  })

  it('重复补种内容无变化时不增加次数或 UPDATED 事件', () => {
    const db = createDb()
    const signalTime = Date.parse('2026-07-24T10:00:00+08:00')
    const first = emitDecisionSignal(db, baseSignal({ signalTime }))
    const second = emitDecisionSignal(db, baseSignal({ signalTime }))

    expect(second.id).toBe(first.id)
    expect(second.occurrenceCount).toBe(1)
    expect(getDecisionSignalTimeline(db, first.id)?.map(event => event.eventType)).toEqual(['CREATED'])
    db.close()
  })

  it('按来源设置默认有效期并保留显式有效期', () => {
    const db = createDb()
    const signalTime = Date.parse('2026-07-24T10:00:00+08:00')
    const shortTerm = emitDecisionSignal(db, baseSignal({ dedupKey: 'short', sourceModule: 'short_term', signalTime }))
    const trend = emitDecisionSignal(db, baseSignal({ dedupKey: 'trend', sourceModule: 'trend', signalTime }))
    const news = emitDecisionSignal(db, baseSignal({ dedupKey: 'news', sourceModule: 'news', signalTime }))
    const explicit = emitDecisionSignal(db, baseSignal({ dedupKey: 'explicit', sourceModule: 'ai', signalTime, expireAt: null }))

    expect(shortTerm.expireAt).toBe(Date.parse('2026-07-24T15:30:00+08:00'))
    expect(trend.expireAt).toBe(signalTime + 7 * 24 * 60 * 60 * 1000)
    expect(news.expireAt).toBe(signalTime + 3 * 24 * 60 * 60 * 1000)
    expect(explicit.expireAt).toBeNull()
    db.close()
  })

  it('支持已读、关注和忽略状态流转', () => {
    const db = createDb()
    const signal = emitDecisionSignal(db, baseSignal())

    expect(markDecisionSignalRead(db, signal.id)?.status).toBe('READ')
    expect(watchDecisionSignal(db, signal.id)?.status).toBe('WATCHING')
    const dismissed = dismissDecisionSignal(db, signal.id, '重复信号', '测试备注')
    expect(dismissed?.status).toBe('DISMISSED')
    const events = getDecisionSignalTimeline(db, signal.id) ?? []
    expect(events.map(event => event.eventType)).toContain('DISMISSED')
    expect(events.at(-1)?.reason).toBe('重复信号')
    expect(getTodayDecisionSignals(db)).toHaveLength(0)
    db.close()
  })

  it('支持处置结果和生命周期时间线', () => {
    const db = createDb()
    const signal = emitDecisionSignal(db, baseSignal())

    const resolved = resolveDecisionSignal(db, signal.id, 'RESOLVED_VALID', '已按计划处理')
    expect(resolved?.resolution).toBe('RESOLVED_VALID')
    expect(resolved?.resolutionNote).toBe('已按计划处理')
    const events = getDecisionSignalTimeline(db, signal.id) ?? []
    expect(events.at(-1)?.eventType).toBe('RESOLVED')
    expect(events.at(-1)?.resolution).toBe('RESOLVED_VALID')
    db.close()
  })

  it('聚合今日摘要', () => {
    const db = createDb()
    emitDecisionSignal(db, baseSignal({ dedupKey: 'a', sourceModule: 'ai', priority: 4, signalType: 'RISK', reason: { isPortfolio: true } }))
    emitDecisionSignal(db, baseSignal({ dedupKey: 'b', sourceModule: 'sector_flow', priority: 2, signalType: 'INFO', conceptCode: 'BK001', tsCode: null }))

    const summary = getDecisionSignalSummary(db)
    expect(summary.totalToday).toBe(2)
    expect(summary.unreadCount).toBe(2)
    expect(summary.highPriorityUnreadCount).toBe(1)
    expect(summary.byType.RISK).toBe(1)
    expect(summary.bySource.ai).toBe(1)
    expect(summary.bySource.sector_flow).toBe(1)
    db.close()
  })

  it('过期信号不再出现在默认今日列表', () => {
    const db = createDb()
    const now = Date.now()
    emitDecisionSignal(db, baseSignal({ dedupKey: 'expired', expireAt: now - 1000 }))

    const changed = expireOldDecisionSignals(db)
    expect(changed).toBe(1)
    expect(getDecisionSignalTimeline(db, 1)?.at(-1)?.eventType).toBe('EXPIRED')
    expect(getTodayDecisionSignals(db)).toHaveLength(0)
    db.close()
  })

  it('休市日回退到最近交易日并带回跨日关注项', () => {
    const db = createDb()
    db.prepare('INSERT INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, ?, ?)').run('20260724', 1, '20260723')
    db.prepare('INSERT INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, ?, ?)').run('20260725', 0, '20260724')
    const prior = emitDecisionSignal(db, baseSignal({
      dedupKey: 'prior-watching',
      signalTime: Date.parse('2026-07-23T10:00:00+08:00'),
      expireAt: null,
    }))
    watchDecisionSignal(db, prior.id)
    emitDecisionSignal(db, baseSignal({
      dedupKey: 'latest-trade-date',
      signalTime: Date.parse('2026-07-24T10:00:00+08:00'),
    }))

    const result = getTodayDecisionSignalContext(db, {}, Date.parse('2026-07-25T10:00:00+08:00'))
    expect(result.context).toEqual({
      today: '20260725',
      displayDate: '20260724',
      latestTradeDate: '20260724',
      isFallback: true,
      isTradingDay: false,
    })
    expect(result.data.map(item => item.dedupKey)).toEqual(['latest-trade-date'])
    expect(result.carryover.map(item => item.dedupKey)).toEqual(['prior-watching'])
    db.close()
  })

  it('历史回看支持精确信号日并返回可用日期', () => {
    const db = createDb()
    emitDecisionSignal(db, baseSignal({ dedupKey: 'day-1', signalTime: Date.parse('2026-07-23T10:00:00+08:00') }))
    emitDecisionSignal(db, baseSignal({ dedupKey: 'day-2', signalTime: Date.parse('2026-07-24T10:00:00+08:00') }))

    const result = getDecisionHistorySignals(db, { rangeDays: 30, tradeDate: '2026-07-23', limit: 100 })
    expect(result.availableDates).toEqual(['2026-07-24', '2026-07-23'])
    expect(result.selectedTradeDate).toBe('2026-07-23')
    expect(result.total).toBe(1)
    expect(result.items[0]?.title).toContain('浦发银行')
    db.close()
  })

  it('180天清理保留关注中的行动项', () => {
    const db = createDb()
    const watching = emitDecisionSignal(db, baseSignal({ dedupKey: 'old-watching', expireAt: null }))
    const oldNew = emitDecisionSignal(db, baseSignal({ dedupKey: 'old-new', expireAt: null }))
    watchDecisionSignal(db, watching.id)
    const now = Date.parse('2026-07-25T10:00:00+08:00')
    db.prepare('UPDATE decision_signals SET created_at = ? WHERE id IN (?, ?)').run(now - 181 * 24 * 60 * 60 * 1000, watching.id, oldNew.id)

    expect(cleanupOldDecisionSignals(db, 180)).toBe(1)
    expect(db.prepare('SELECT status FROM decision_signals WHERE id = ?').get(watching.id)).toEqual({ status: 'WATCHING' })
    db.close()
  })
})
