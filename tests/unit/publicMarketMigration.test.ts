import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'

describe('FR-273 public market data migration', () => {
  it('adds provenance and resumable request state without changing legacy rows', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE daily_close_cache (
        ts_code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        close REAL NOT NULL,
        PRIMARY KEY (ts_code, trade_date)
      );
      INSERT INTO daily_close_cache (ts_code, trade_date, close)
      VALUES ('600000.SH', '20260814', 10.5);
    `)

    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 137))

    const columns = db.prepare(`PRAGMA table_info(daily_close_cache)`).all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'amount',
      'data_source',
      'amount_source',
      'turnover_source',
      'fetched_at',
    ]))
    expect(db.prepare(`
      SELECT close, amount, data_source, fetched_at
      FROM daily_close_cache WHERE ts_code = '600000.SH'
    `).get()).toEqual({ close: 10.5, amount: null, data_source: 'legacy', fetched_at: null })
    const tables = (db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'public_%'
    `).all() as Array<{ name: string }>).map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining([
      'public_market_request_global_state',
      'public_market_provider_states',
      'public_market_sync_jobs',
      'public_daily_sync_checkpoints',
    ]))
    db.close()
  })
})
