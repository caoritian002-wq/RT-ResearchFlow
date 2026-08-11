import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getMarketOverviewSnapshot } from '../../electron/main/services/marketOverviewService'

describe('FR-261 市场概览历史交易日读取', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE daily_close_cache (
        ts_code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        pct_chg REAL
      );
      CREATE TABLE kpl_concept_daily (trade_date TEXT, theme TEXT);
      CREATE TABLE kpl_concept_members (
        ts_code TEXT,
        con_code TEXT,
        name TEXT,
        con_name TEXT
      );
      CREATE TABLE limit_list_daily (
        trade_date TEXT NOT NULL,
        "limit" TEXT,
        first_time TEXT
      );
      CREATE TABLE market_timeline_daily (
        trade_date TEXT NOT NULL,
        time TEXT NOT NULL,
        limit_up INTEGER NOT NULL,
        limit_down INTEGER NOT NULL
      );
    `)
    db.prepare('INSERT INTO daily_close_cache VALUES (?, ?, ?)').run('600001.SH', '20260807', 2.1)
    db.prepare('INSERT INTO daily_close_cache VALUES (?, ?, ?)').run('600002.SH', '20260810', -8.2)
    db.prepare('INSERT INTO market_timeline_daily VALUES (?, ?, ?, ?)').run('20260807', '09:30', 3, 0)
    db.prepare('INSERT INTO market_timeline_daily VALUES (?, ?, ?, ?)').run('20260807', '10:00', 5, 1)
    db.prepare('INSERT INTO limit_list_daily VALUES (?, ?, ?)').run('20260807', 'U', '093000')
    db.prepare('INSERT INTO kpl_concept_daily VALUES (?, ?)').run('20260807', '算力')
    db.prepare('INSERT INTO kpl_concept_members VALUES (?, ?, ?, ?)').run('BK9999', '600001.SH', '算力', '测试股')
  })

  afterEach(() => db.close())

  it('显式日期只读取同日分布而不混入最新交易日', () => {
    const snapshot = getMarketOverviewSnapshot(db, { tradeDate: '20260807' })

    expect(snapshot.tradeDate).toBe('20260807')
    expect(snapshot.isHistorical).toBe(true)
    expect(snapshot.distribution.find((item) => item.label === '0~3%')?.count).toBe(1)
    expect(snapshot.distribution.find((item) => item.label === '≤-7%')?.count).toBe(0)
    expect(snapshot.conceptHeat).toEqual([])
    expect(snapshot.timeline).toEqual([
      { time: '09:30', limitUp: 3, limitDown: 0 },
      { time: '10:00', limitUp: 5, limitDown: 1 },
    ])
    expect(snapshot.coverage).toEqual({
      distribution: { available: true, sampleCount: 1 },
      timeline: { mode: 'exact', pointCount: 2 },
    })
  })

  it('未指定日期时仍读取本地最新交易日', () => {
    const snapshot = getMarketOverviewSnapshot(db)

    expect(snapshot.tradeDate).toBe('20260810')
    expect(snapshot.distribution.find((item) => item.label === '≤-7%')?.count).toBe(1)
    expect(snapshot.conceptHeat).toEqual([])
    expect(snapshot.coverage.distribution).toEqual({ available: true, sampleCount: 1 })
  })

  it('精确时间线缺失时明确标记同日近似, 无同日事实时标记缺失', () => {
    db.prepare('DELETE FROM market_timeline_daily WHERE trade_date = ?').run('20260807')
    const approximate = getMarketOverviewSnapshot(db, { tradeDate: '20260807' })
    expect(approximate.coverage.timeline).toEqual({ mode: 'approximate', pointCount: 11 })

    db.prepare('DELETE FROM limit_list_daily WHERE trade_date = ?').run('20260807')
    const missing = getMarketOverviewSnapshot(db, { tradeDate: '20260807' })
    expect(missing.coverage.timeline).toEqual({ mode: 'missing', pointCount: 0 })
  })

  it('拒绝非法日期和未来日期', () => {
    expect(() => getMarketOverviewSnapshot(db, { tradeDate: '2026-08-07' }))
      .toThrow('INVALID_MARKET_OVERVIEW_REQUEST')
    expect(() => getMarketOverviewSnapshot(db, { tradeDate: '20990101' }))
      .toThrow('INVALID_MARKET_OVERVIEW_REQUEST')
  })
})
