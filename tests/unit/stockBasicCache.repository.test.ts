import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getStockBasicCacheFreshness,
  isStockBasicCacheStale,
} from '../../electron/main/database/stockBasicCacheRepository'

describe('stockBasicCacheRepository freshness', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE stock_basic_cache (
        ts_code TEXT PRIMARY KEY,
        name TEXT,
        industry TEXT,
        market TEXT,
        list_status TEXT,
        circ_float REAL,
        updated_at INTEGER NOT NULL
      )
    `)
  })

  afterEach(() => db.close())

  it('空缓存和早于北京时间目标日的缓存需要启动补偿', () => {
    expect(getStockBasicCacheFreshness(db)).toEqual({ count: 0, maxUpdatedAt: null })
    expect(isStockBasicCacheStale(db, '20260806')).toBe(true)

    db.prepare(`
      INSERT INTO stock_basic_cache (ts_code, name, list_status, updated_at)
      VALUES (?, ?, 'L', ?)
    `).run('600000.SH', '浦发银行', Date.parse('2026-08-05T15:59:59+08:00'))

    expect(isStockBasicCacheStale(db, '20260806')).toBe(true)
  })

  it('北京时间当天已经完成的缓存不重复执行启动补偿', () => {
    const updatedAt = Date.parse('2026-08-06T00:01:00+08:00')
    db.prepare(`
      INSERT INTO stock_basic_cache (ts_code, name, list_status, updated_at)
      VALUES (?, ?, 'L', ?)
    `).run('688825.SH', '长鑫科技', updatedAt)

    expect(getStockBasicCacheFreshness(db)).toEqual({ count: 1, maxUpdatedAt: updatedAt })
    expect(isStockBasicCacheStale(db, '20260806')).toBe(false)
  })
})
