import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getDailyCloseMaintenanceState } from '../../electron/main/database/dailyCloseCacheRepository'
import { runDailyCloseMaintenance } from '../../electron/main/services/dailyCloseMaintenanceService'

function createMaintenanceDb(path = ':memory:'): Database.Database {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      pct_chg REAL,
      vol REAL,
      turnover_rate REAL,
      PRIMARY KEY (ts_code, trade_date)
    );
    CREATE TABLE daily_close_maintenance_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      retain_trade_days INTEGER NOT NULL,
      removed_rows INTEGER,
      remaining_trade_days INTEGER,
      message TEXT
    );
  `)
  return db
}

function seedTradeDays(db: Database.Database, count: number): void {
  const insert = db.prepare(`
    INSERT INTO daily_close_cache (ts_code, trade_date, close)
    VALUES ('600000.SH', ?, 10)
  `)
  const insertAll = db.transaction(() => {
    let inserted = 0
    const cursor = new Date(Date.UTC(2024, 0, 1))
    while (inserted < count) {
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
        insert.run(cursor.toISOString().slice(0, 10).replace(/-/g, ''))
        inserted += 1
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  })
  insertAll()
}

describe('dailyCloseMaintenanceService', () => {
  it('保存成功清理结果并在重开数据库后保持可读', () => {
    const directory = mkdtempSync(join(tmpdir(), 'daily-close-maintenance-'))
    const databasePath = join(directory, 'maintenance.sqlite')

    try {
      const db = createMaintenanceDb(databasePath)
      seedTradeDays(db, 530)
      const timestamps = [1000, 2000]
      const state = runDailyCloseMaintenance(db, 520, () => timestamps.shift() ?? 2000)

      expect(state).toEqual({
        status: 'success',
        startedAt: 1000,
        completedAt: 2000,
        retainTradeDays: 520,
        removedRows: 10,
        remainingTradeDays: 520,
        message: null,
      })
      db.close()

      const reopened = new Database(databasePath)
      expect(getDailyCloseMaintenanceState(reopened)).toEqual(state)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('清理失败时记录安全摘要且后续可恢复成功', () => {
    const db = createMaintenanceDb()
    seedTradeDays(db, 3)
    db.exec(`
      CREATE TRIGGER fail_daily_close_cleanup
      BEFORE DELETE ON daily_close_cache
      BEGIN
        SELECT RAISE(ABORT, 'database path C:/secret/trade-watch.db');
      END;
    `)

    expect(() => runDailyCloseMaintenance(db, 2, () => 1000)).toThrow(
      'database path C:/secret/trade-watch.db',
    )
    expect(getDailyCloseMaintenanceState(db)).toEqual({
      status: 'failed',
      startedAt: 1000,
      completedAt: 1000,
      retainTradeDays: 2,
      removedRows: null,
      remainingTradeDays: null,
      message: '历史日线清理失败，请查看应用日志',
    })

    db.exec('DROP TRIGGER fail_daily_close_cleanup')
    expect(runDailyCloseMaintenance(db, 2, () => 2000)).toMatchObject({
      status: 'success',
      removedRows: 1,
      remainingTradeDays: 2,
    })
    db.close()
  })
})