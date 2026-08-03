import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'

function tableExists(db: Database.Database, tableName: string): boolean {
  return db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName) !== undefined
}

describe('FR-253 Migration 118', () => {
  it('creates shared profile, versioned financial and source-state tables', () => {
    const db = new Database(':memory:')
    const migration118 = DATABASE_MIGRATIONS.filter((migration) => migration.version === 118)

    try {
      expect(migration118).toHaveLength(1)
      runMigrations(db, migration118)

      expect(tableExists(db, 'stock_fundamental_profiles')).toBe(true)
      expect(tableExists(db, 'stock_fundamental_financials')).toBe(true)
      expect(tableExists(db, 'stock_fundamental_sync_state')).toBe(true)
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 118 }])

      const financialColumns = db.prepare(
        'PRAGMA table_info(stock_fundamental_financials)',
      ).all() as Array<{ name: string; pk: number }>
      expect(financialColumns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
        'ts_code',
        'report_date',
        'source_version',
      ])
      expect(financialColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'notice_date',
        'currency',
        'total_revenue',
        'parent_net_profit',
        'operating_cash_flow',
        'fetched_at',
      ]))

      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_fundamental_financials'",
      ).all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toContain('idx_stock_fundamental_financials_latest')
      expect(() => db.prepare(`
        INSERT INTO stock_fundamental_sync_state (
          ts_code, dataset, status, last_attempt_at
        ) VALUES ('600519.SH', 'announcement', 'available', 1)
      `).run()).toThrow()
    } finally {
      db.close()
    }
  })

  it('Migration 119 adds announcement facts and preserves existing source state', () => {
    const db = new Database(':memory:')
    const migrations = DATABASE_MIGRATIONS.filter(
      (migration) => migration.version === 118 || migration.version === 119,
    )

    try {
      runMigrations(db, migrations.filter((migration) => migration.version === 118))
      db.prepare(`
        INSERT INTO stock_fundamental_sync_state (
          ts_code, dataset, status, last_attempt_at, last_success_at,
          fact_date, last_error_code, rows_written
        ) VALUES ('600519.SH', 'profile', 'available', 1000, 1000, NULL, NULL, 1)
      `).run()
      runMigrations(db, migrations.filter((migration) => migration.version === 119))

      expect(tableExists(db, 'stock_fundamental_announcements')).toBe(true)
      expect(db.prepare(
        'SELECT ts_code, dataset, status, last_success_at FROM stock_fundamental_sync_state',
      ).all()).toEqual([{
        ts_code: '600519.SH',
        dataset: 'profile',
        status: 'available',
        last_success_at: 1000,
      }])
      expect(() => db.prepare(`
        INSERT INTO stock_fundamental_sync_state (
          ts_code, dataset, status, last_attempt_at
        ) VALUES ('600519.SH', 'announcement', 'available', 2000)
      `).run()).not.toThrow()
      expect(() => db.prepare(`
        INSERT INTO stock_fundamental_sync_state (
          ts_code, dataset, status, last_attempt_at
        ) VALUES ('600519.SH', 'pdf', 'available', 2000)
      `).run()).toThrow()

      const announcementColumns = db.prepare(
        'PRAGMA table_info(stock_fundamental_announcements)',
      ).all() as Array<{ name: string; pk: number }>
      expect(announcementColumns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
        'ts_code',
        'article_code',
      ])
      expect(announcementColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'title',
        'notice_date',
        'display_at',
        'category_codes_json',
        'category_names_json',
        'source_url',
      ]))
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stock_fundamental_announcements'",
      ).all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toContain('idx_stock_fundamental_announcements_latest')
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
        { version: 118 },
        { version: 119 },
      ])
    } finally {
      db.close()
    }
  })
})
