import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('../../electron/main/services/decisionNotificationService', () => ({
  notifyDecisionSignalNative: vi.fn(),
}))

import { emitPriorityNewsSignalsForScan } from '../../electron/main/services/newsDecisionSignalService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      sourceName TEXT NOT NULL,
      originalUrl TEXT,
      impactRating TEXT NOT NULL,
      impactRatingScore REAL NOT NULL,
      publishedAt INTEGER,
      summary TEXT,
      scanRunId INTEGER NOT NULL
    );
    CREATE TABLE decision_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_module TEXT NOT NULL,
      strategy_key TEXT NOT NULL,
      ts_code TEXT,
      stock_name TEXT,
      concept_code TEXT,
      concept_name TEXT,
      signal_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      priority INTEGER NOT NULL,
      score REAL,
      confidence REAL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason_json TEXT,
      source_ref_json TEXT,
      status TEXT NOT NULL DEFAULT 'NEW',
      dedup_key TEXT NOT NULL,
      signal_time INTEGER NOT NULL,
      expire_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      first_seen_at INTEGER,
      last_seen_at INTEGER,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      acknowledged_at INTEGER,
      watched_at INTEGER,
      dismissed_at INTEGER,
      resolved_at INTEGER,
      resolution TEXT,
      resolution_note TEXT
    );
    CREATE TABLE decision_signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      resolution TEXT,
      reason TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_decision_signals_dedup ON decision_signals(dedup_key);
  `)
  return db
}

function insertBriefing(
  db: Database.Database,
  values: {
    title: string
    sourceName: string
    impactRating: string
    impactRatingScore: number
    scanRunId?: number
  },
): number {
  return Number(db.prepare(`
    INSERT INTO briefings (
      title, sourceName, originalUrl, impactRating, impactRatingScore, publishedAt, summary, scanRunId
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.title,
    values.sourceName,
    `https://example.com/${encodeURIComponent(values.title)}`,
    values.impactRating,
    values.impactRatingScore,
    Date.parse('2026-08-05T09:00:00+08:00'),
    `${values.title}摘要`,
    values.scanRunId ?? 77,
  ).lastInsertRowid)
}

describe('FR-260 高优先级资讯信号生成', () => {
  it('不依赖AI配置，为重大和高评分资讯生成带文章深链的P4/P3信号', () => {
    const db = createDb()
    const criticalId = insertBriefing(db, {
      title: '重大资讯',
      sourceName: '交易所公告',
      impactRating: 'CRITICAL',
      impactRatingScore: 20,
    })
    const importantId = insertBriefing(db, {
      title: '重要资讯',
      sourceName: '财联社',
      impactRating: 'IMPORTANT',
      impactRatingScore: 35,
    })
    insertBriefing(db, {
      title: '一般资讯',
      sourceName: '普通来源',
      impactRating: 'GENERAL',
      impactRatingScore: 10,
    })
    insertBriefing(db, {
      title: '其他扫描批次',
      sourceName: '财联社',
      impactRating: 'CRITICAL',
      impactRatingScore: 50,
      scanRunId: 78,
    })
    const send = vi.fn()
    const win = {
      isDestroyed: () => false,
      webContents: { send },
    } as never

    expect(emitPriorityNewsSignalsForScan(db, 77, win)).toBe(2)

    const rows = db.prepare(`
      SELECT priority, title, source_ref_json AS sourceRefJson
      FROM decision_signals
      ORDER BY priority DESC, id ASC
    `).all() as Array<{ priority: number; title: string; sourceRefJson: string }>
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => ({ priority: row.priority, title: row.title }))).toEqual([
      { priority: 4, title: '重大资讯' },
      { priority: 3, title: '重要资讯' },
    ])
    expect(JSON.parse(rows[0].sourceRefJson)).toMatchObject({
      briefingId: criticalId,
      sourceName: '交易所公告',
      scanRunId: 77,
    })
    expect(JSON.parse(rows[1].sourceRefJson)).toMatchObject({
      briefingId: importantId,
      sourceName: '财联社',
      scanRunId: 77,
    })
    expect(send).toHaveBeenCalledTimes(2)
    db.close()
  })
})
