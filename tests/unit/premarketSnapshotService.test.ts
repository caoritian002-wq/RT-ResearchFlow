import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { capturePremarketFactSnapshot } from '../../electron/main/services/premarketSnapshotService'
import type { PremarketFetch } from '../../electron/main/services/premarketGlobalFactProvider'

describe('premarketSnapshotService', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => (
      migration.version === 125 || migration.version === 132
    )))
  })

  afterEach(() => db?.close())

  it('截点前拒绝生成，错过窗口后不联网补造并保存阻断事实', async () => {
    const cutoffAt = Date.parse('2026-07-31T08:45:00+08:00')
    await expect(capturePremarketFactSnapshot(db, {
      tradeDate: '20260731',
      stage: 'asia_open',
      now: cutoffAt - 1,
    })).rejects.toThrow('PREMARKET_CAPTURE_BEFORE_CUTOFF')

    const fetcher = vi.fn() as PremarketFetch
    const missed = await capturePremarketFactSnapshot(db, {
      tradeDate: '20260731',
      stage: 'asia_open',
      now: cutoffAt + 5 * 60_000 + 1,
      fetcher,
    })
    const repeated = await capturePremarketFactSnapshot(db, {
      tradeDate: '20260731',
      stage: 'asia_open',
      now: cutoffAt + 10 * 60_000,
      fetcher,
    })

    expect(fetcher).not.toHaveBeenCalled()
    expect(missed.snapshot.status).toBe('blocked')
    expect(missed.snapshot.warnings).toContain('PREMARKET_CAPTURE_WINDOW_MISSED')
    expect(repeated.reused).toBe(true)
    expect(repeated.snapshot.id).toBe(missed.snapshot.id)
  })
})
