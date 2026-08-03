import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getCachedPricePage } from '../../electron/main/database/stockPriceCacheRepository'
import {
  countVisibleRows,
  defaultVisibleLogicalRange,
  mergeHistoryRows,
  resolveHistoryRangeSelection,
  shiftLogicalRange,
  shouldLoadOlderHistory,
  visibleLogicalRange,
  INITIAL_HISTORY_BARS,
} from '../../src/components/StockChart/stockChartHistoryModel'

describe('stock chart history pagination', () => {
  let db: Database.Database | null = null

  afterEach(() => {
    db?.close()
    db = null
  })

  it('returns the latest page ascending and exposes older rows', () => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE stock_price_cache (
        stockCode TEXT NOT NULL,
        tradeDate TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume REAL,
        amount REAL,
        fetchedAt INTEGER NOT NULL,
        PRIMARY KEY (stockCode, tradeDate)
      );
    `)
    const insert = db.prepare(`
      INSERT INTO stock_price_cache
        (stockCode, tradeDate, open, high, low, close, volume, amount, fetchedAt)
      VALUES (?, ?, 10, 11, 9, 10.5, 1000, 10000, 1)
    `)
    for (let day = 1; day <= 150; day += 1) {
      insert.run('600000', String(day).padStart(8, '0'))
    }

    const latest = getCachedPricePage(db, '600000', 90)
    expect(latest.rows).toHaveLength(90)
    expect(latest.rows[0].tradeDate).toBe('00000061')
    expect(latest.rows.at(-1)?.tradeDate).toBe('00000150')
    expect(latest.hasMore).toBe(true)

    const older = getCachedPricePage(db, '600000', 120, latest.rows[0].tradeDate)
    expect(older.rows).toHaveLength(60)
    expect(older.rows[0].tradeDate).toBe('00000001')
    expect(older.rows.at(-1)?.tradeDate).toBe('00000060')
    expect(older.hasMore).toBe(false)
  })

  it('merges overlapping pages without duplicating candles', () => {
    const current = [{ tradeDate: '20260702' }, { tradeDate: '20260703' }]
    const incoming = [{ tradeDate: '20260701' }, { tradeDate: '20260702' }]
    expect(mergeHistoryRows(current, incoming)).toEqual({
      rows: [
        { tradeDate: '20260701' },
        { tradeDate: '20260702' },
        { tradeDate: '20260703' },
      ],
      addedBefore: 1,
    })
  })

  it('uses a 30-bar viewport and only loads near the left edge', () => {
    expect(INITIAL_HISTORY_BARS).toBe(149)
    expect(defaultVisibleLogicalRange(90)).toEqual({ from: 60, to: 92 })
    expect(visibleLogicalRange(90, 60)).toEqual({ from: 30, to: 92 })
    expect(visibleLogicalRange(90, 90)).toEqual({ from: 0, to: 92 })
    expect(visibleLogicalRange(140, 'all')).toEqual({ from: 0, to: 142 })
    expect(shouldLoadOlderHistory({ from: 7, to: 37 }, true, false)).toBe(false)
    expect(shouldLoadOlderHistory({ from: 6, to: 36 }, true, false)).toBe(true)
    expect(shouldLoadOlderHistory({ from: 4, to: 34 }, false, false)).toBe(false)
    expect(shouldLoadOlderHistory({ from: 4, to: 34 }, true, true)).toBe(false)
  })

  it('reports the actual visible rows and keeps custom zoom distinguishable', () => {
    expect(countVisibleRows({ from: 60, to: 92 }, 90)).toBe(30)
    expect(countVisibleRows({ from: -2, to: 142 }, 140)).toBe(140)
    expect(resolveHistoryRangeSelection(30, 90, true)).toBe(30)
    expect(resolveHistoryRangeSelection(74, 140, false)).toBe('custom')
    expect(resolveHistoryRangeSelection(140, 140, false)).toBe('all')
  })

  it('keeps the same candles visible after prepending history', () => {
    expect(shiftLogicalRange({ from: 4, to: 34 }, 120)).toEqual({
      from: 124,
      to: 154,
    })
  })
})
