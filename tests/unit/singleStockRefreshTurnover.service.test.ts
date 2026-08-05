import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forceFetchSingleStock } from '../../electron/main/services/tushareService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec([
    'CREATE TABLE stock_info (stockCode TEXT PRIMARY KEY, stockName TEXT NOT NULL, fetchedAt INTEGER NOT NULL);',
    'CREATE TABLE stock_price_cache (stockCode TEXT NOT NULL, tradeDate TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL, fetchedAt INTEGER NOT NULL, PRIMARY KEY (stockCode, tradeDate));',
    'CREATE TABLE daily_close_cache (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL NOT NULL, pct_chg REAL, vol REAL, turnover_rate REAL, PRIMARY KEY (ts_code, trade_date));',
  ].join('\n'))
  return db
}

function beijingToday(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

describe('single-stock refresh turnover merge', () => {
  let db: Database.Database
  const fetchMock = vi.fn()

  beforeEach(() => {
    db = createDb()
    fetchMock.mockReset()
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    db.close()
  })

  it('把同区间 daily_basic 换手率写入日线缓存', async () => {
    const today = beijingToday()
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { api_name?: string }
      if (body.api_name === 'stock_basic') {
        return {
          json: async () => ({ code: 0, data: { fields: ['ts_code', 'name'], items: [['600487.SH', '亨通光电']] } }),
        }
      }
      if (body.api_name === 'daily') {
        return {
          json: async () => ({
            code: 0,
            data: {
              fields: ['trade_date', 'open', 'high', 'low', 'close', 'pct_chg', 'vol', 'amount'],
              items: [[today, 50, 52, 49, 51, 2, 100000, 510000]],
            },
          }),
        }
      }
      if (body.api_name === 'daily_basic') {
        return {
          json: async () => ({
            code: 0,
            data: {
              fields: ['ts_code', 'trade_date', 'turnover_rate', 'float_share'],
              items: [['600487.SH', today, 4.08, 245364.6257]],
            },
          }),
        }
      }
      throw new Error(`unexpected api ${body.api_name ?? 'unknown'}`)
    })

    const refresh = forceFetchSingleStock(db, 'token', '600487')
    await vi.runAllTimersAsync()

    await expect(refresh).resolves.toBe(1)
    expect(db.prepare(`
      SELECT ts_code, trade_date, close, pct_chg, turnover_rate
      FROM daily_close_cache WHERE ts_code = '600487.SH'
    `).get()).toEqual({
      ts_code: '600487.SH',
      trade_date: today,
      close: 51,
      pct_chg: 2,
      turnover_rate: 4.08,
    })
    expect(db.prepare(
      "SELECT stockName FROM stock_info WHERE stockCode = '600487'",
    ).get()).toEqual({ stockName: '亨通光电' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
