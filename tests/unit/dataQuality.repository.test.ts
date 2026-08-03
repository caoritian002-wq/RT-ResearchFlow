import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { getLatestDataQualityRun, saveDataQualityRun } from '../../electron/main/database/dataQualityRepository'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE data_quality_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checked_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  return db
}

describe('dataQualityRepository', () => {
  it('保存并读取最近一次正式质量快照', () => {
    const db = createDb()
    try {
      const id = saveDataQualityRun(db, {
        checkedAt: 100,
        status: 'degraded',
        fingerprint: 'fingerprint-1',
        snapshot: { fingerprint: 'fingerprint-1', datasets: [{ key: 'dailyMarket' }] },
      })
      expect(getLatestDataQualityRun(db)).toMatchObject({ id, checkedAt: 100, status: 'degraded', fingerprint: 'fingerprint-1' })
    } finally {
      db.close()
    }
  })

  it('跳过损坏的新记录并回退到最近可解析快照', () => {
    const db = createDb()
    try {
      saveDataQualityRun(db, {
        checkedAt: 100,
        status: 'reliable',
        fingerprint: 'valid',
        snapshot: { fingerprint: 'valid', datasets: [] },
      })
      db.prepare(`
        INSERT INTO data_quality_runs (checked_at, status, fingerprint, snapshot_json, created_at)
        VALUES (200, 'blocked', 'broken', '{bad-json', 200)
      `).run()
      expect(getLatestDataQualityRun(db)).toMatchObject({ checkedAt: 100, fingerprint: 'valid' })
    } finally {
      db.close()
    }
  })
})
