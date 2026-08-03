import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import { backfillTrendStockData } from '../../electron/main/services/trendSyncService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec([
    'CREATE TABLE stock_info (stockCode TEXT PRIMARY KEY, stockName TEXT NOT NULL, fetchedAt INTEGER NOT NULL);',
    'CREATE TABLE stock_price_cache (stockCode TEXT NOT NULL, tradeDate TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL, fetchedAt INTEGER NOT NULL, PRIMARY KEY (stockCode, tradeDate));',
    'CREATE TABLE daily_close_cache (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL NOT NULL, pct_chg REAL, vol REAL, turnover_rate REAL, PRIMARY KEY (ts_code, trade_date));',
  ].join('\n'))
  return db
}

function ymdOffset(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function seedDaily(db: Database.Database, tsCode: string, count: number): void {
  upsertDailyClose(db, Array.from({ length: count }, (_, index) => ({
    tsCode,
    tradeDate: ymdOffset(index - count + 1),
    open: 10 + index * 0.1,
    high: 10.3 + index * 0.1,
    low: 9.8 + index * 0.1,
    close: 10.1 + index * 0.1,
    pctChg: index === 0 ? 0 : 0.5,
    vol: 10_000 + index,
    turnoverRate: null,
  })))
}

function buildKlines(count: number, base: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const close = base + index * 0.2
    return [
      formatYmd(ymdOffset(index - count + 1)),
      (close - 0.1).toFixed(2),
      close.toFixed(2),
      (close + 0.2).toFixed(2),
      (close - 0.2).toFixed(2),
      String(10_000 + index),
      String(1_000_000 + index * 10_000),
    ].join(',')
  })
}

function formatYmd(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

describe('FR-252 zero-key portfolio gap backfill', () => {
  let db: Database.Database
  const fetchMock = vi.fn()

  beforeEach(() => {
    db = createDb()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    db.close()
  })

  it('reuses complete local stock and benchmark coverage without a network request', async () => {
    seedDaily(db, '600001.SH', 60)
    seedDaily(db, '000300.SH', 21)

    const result = await backfillTrendStockData(db, null, ['600001.SH'])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ requested: 1, synced: 0, skipped: 1, failed: 0 })
    expect(result.stocks[0]).toMatchObject({
      tsCode: '600001.SH',
      provider: 'local-cache',
      bars: 60,
      state: 'ready',
      error: null,
    })
    expect(result.stocks[0].latestTradeDate).toMatch(/^\d{8}$/)
  })

  it('fills selected stocks one by one without Tushare and preserves partial success', async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const secid = url.searchParams.get('secid')
      if (secid === '1.000300') {
        return { ok: true, json: async () => ({ rc: 0, data: { name: '沪深300', klines: buildKlines(60, 3800) } }) }
      }
      if (secid === '1.600519') {
        return { ok: true, json: async () => ({ rc: 0, data: { name: '贵州茅台', klines: buildKlines(80, 1400) } }) }
      }
      return { ok: true, json: async () => ({ rc: 0, data: { name: '', klines: [] } }) }
    })

    const result = await backfillTrendStockData(db, null, ['600519.SH', '600999.SH'])

    expect(result).toMatchObject({ requested: 2, synced: 1, skipped: 0, failed: 1 })
    expect(result.stocks[0]).toMatchObject({
      tsCode: '600519.SH',
      provider: 'eastmoney',
      bars: 80,
      state: 'ready',
      error: null,
    })
    expect(result.stocks[1]).toMatchObject({
      tsCode: '600999.SH',
      provider: 'eastmoney',
      bars: 0,
      state: 'missing',
    })
    expect(result.stocks[1].error).toContain('未找到股票代码')
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_price_cache WHERE stockCode = ?').get('600519')).toEqual({ count: 80 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_close_cache WHERE ts_code = ?').get('600519.SH')).toEqual({ count: 80 })
    expect(db.prepare('SELECT stockName FROM stock_info WHERE stockCode = ?').get('600519')).toEqual({ stockName: '贵州茅台' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_info WHERE stockCode = ?').get('600999')).toEqual({ count: 0 })
  })
})
