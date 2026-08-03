import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchEastmoneySingleStockDaily } from '../../electron/main/services/tushareService'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec([
    'CREATE TABLE stock_info (stockCode TEXT PRIMARY KEY, stockName TEXT NOT NULL, fetchedAt INTEGER NOT NULL);',
    'CREATE TABLE stock_price_cache (stockCode TEXT NOT NULL, tradeDate TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL, fetchedAt INTEGER NOT NULL, PRIMARY KEY (stockCode, tradeDate));',
    'CREATE TABLE daily_close_cache (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL NOT NULL, pct_chg REAL, vol REAL, turnover_rate REAL, PRIMARY KEY (ts_code, trade_date));',
  ].join('\n'))
  return db
}

function buildKlines(count: number): string[] {
  const rows: string[] = []
  const beijingToday = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const cursor = new Date(Date.UTC(
    beijingToday.getUTCFullYear(),
    beijingToday.getUTCMonth(),
    beijingToday.getUTCDate(),
  ))
  cursor.setUTCDate(cursor.getUTCDate() - count + 1)
  for (let index = 0; index < count; index += 1) {
    const date = cursor.toISOString().slice(0, 10)
    const close = 10 + index / 10
    rows.push([
      date,
      (close - 0.1).toFixed(2),
      close.toFixed(2),
      (close + 0.2).toFixed(2),
      (close - 0.2).toFixed(2),
      String(1000 + index),
      (1_000_000 + index * 1000).toFixed(0),
    ].join(','))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return rows
}

describe('FR-252 zero-key single-stock daily fetch', () => {
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

  it('caps the response at 149 bars and writes the same facts to both existing caches', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        rc: 0,
        data: { name: '贵州茅台', klines: buildKlines(160) },
      }),
    })

    const result = await fetchEastmoneySingleStockDaily(db, '600519')

    expect(result).toMatchObject({
      ok: true,
      stockCode: '600519',
      tsCode: '600519.SH',
      stockName: '贵州茅台',
      provider: 'eastmoney',
      rowsWritten: 149,
      totalRows: 149,
      dataState: 'complete',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]))
    const benchmarkUrl = new URL(String(fetchMock.mock.calls[1][0]))
    expect(requestUrl.protocol).toBe('https:')
    expect(requestUrl.searchParams.get('secid')).toBe('1.600519')
    expect(requestUrl.searchParams.get('lmt')).toBe('149')
    expect(benchmarkUrl.searchParams.get('secid')).toBe('1.000300')

    const priceRows = db.prepare(
      'SELECT stockCode, tradeDate, close, amount FROM stock_price_cache WHERE stockCode = ? ORDER BY tradeDate',
    ).all('600519') as Array<{ stockCode: string; tradeDate: string; close: number; amount: number }>
    const dailyRows = db.prepare(
      'SELECT ts_code, trade_date, close, pct_chg, turnover_rate FROM daily_close_cache WHERE ts_code = ? ORDER BY trade_date',
    ).all('600519.SH') as Array<{
      ts_code: string
      trade_date: string
      close: number
      pct_chg: number
      turnover_rate: number | null
    }>
    const stockInfo = db.prepare('SELECT stockName FROM stock_info WHERE stockCode = ?').get('600519') as {
      stockName: string
    }

    expect(priceRows).toHaveLength(149)
    expect(dailyRows).toHaveLength(149)
    expect(priceRows.map((row) => row.tradeDate)).toEqual(dailyRows.map((row) => row.trade_date))
    expect(priceRows[0].stockCode).toBe('600519')
    expect(dailyRows[0].ts_code).toBe('600519.SH')
    expect(dailyRows[0].pct_chg).toBe(0)
    expect(dailyRows[1].pct_chg).toBeCloseTo(
      (dailyRows[1].close - dailyRows[0].close) / dailyRows[0].close * 100,
    )
    expect(dailyRows.every((row) => row.turnover_rate == null)).toBe(true)
    expect(priceRows[0].amount).toBeGreaterThan(1000)
    expect(stockInfo.stockName).toBe('贵州茅台')
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM daily_close_cache WHERE ts_code = ?',
    ).get('000300.SH')).toEqual({ count: 160 })
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM stock_price_cache WHERE stockCode = ?',
    ).get('000300.SH')).toEqual({ count: 0 })
  })

  it('marks real but insufficient history as degraded without inventing turnover', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        rc: 0,
        data: { name: '测试股份', klines: buildKlines(20) },
      }),
    })

    const result = await fetchEastmoneySingleStockDaily(db, '000001')

    expect(result).toMatchObject({
      ok: true,
      tsCode: '000001.SZ',
      totalRows: 20,
      dataState: 'degraded',
    })
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM daily_close_cache WHERE turnover_rate IS NOT NULL',
    ).get()).toEqual({ count: 0 })
  })

  it('rejects invalid or unknown codes without creating placeholder facts', async () => {
    const invalid = await fetchEastmoneySingleStockDaily(db, '60051x')
    expect(invalid).toEqual({
      ok: false,
      code: 'INVALID_STOCK_CODE',
      message: '请输入六位股票代码',
    })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ rc: 0, data: { name: '', klines: [] } }),
    })
    const missing = await fetchEastmoneySingleStockDaily(db, '999999')
    expect(missing).toMatchObject({ ok: false, code: 'STOCK_NOT_FOUND' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_info').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM stock_price_cache').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM daily_close_cache').get()).toEqual({ count: 0 })
  })
})
