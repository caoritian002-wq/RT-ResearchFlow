import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureTrendBenchmarkFreshness } from '../../electron/main/services/tushareService'
import {
  getSettledCutoffDate,
  inspectTrendBenchmarkHealth,
} from '../../electron/main/services/trendBenchmarkFreshness'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec([
    'CREATE TABLE stock_info (stockCode TEXT PRIMARY KEY, stockName TEXT NOT NULL, fetchedAt INTEGER NOT NULL);',
    'CREATE TABLE stock_price_cache (stockCode TEXT NOT NULL, tradeDate TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume REAL, amount REAL, fetchedAt INTEGER NOT NULL, PRIMARY KEY (stockCode, tradeDate));',
    'CREATE TABLE daily_close_cache (ts_code TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL NOT NULL, pct_chg REAL, vol REAL, turnover_rate REAL, PRIMARY KEY (ts_code, trade_date));',
    'CREATE TABLE trade_cal (cal_date TEXT NOT NULL PRIMARY KEY, is_open INTEGER NOT NULL, pretrade_date TEXT);',
  ].join('\n'))
  return db
}

function atBeijing(value: string): number {
  return new Date(`${value}+08:00`).getTime()
}

function seedCalendar(db: Database.Database, rows: Array<[string, number]>): void {
  const statement = db.prepare('INSERT INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, ?, NULL)')
  for (const row of rows) statement.run(...row)
}

function seedBenchmark(db: Database.Database, latestDate: string, count = 21): void {
  const latest = new Date(Date.UTC(
    Number(latestDate.slice(0, 4)),
    Number(latestDate.slice(4, 6)) - 1,
    Number(latestDate.slice(6, 8)),
  ))
  const statement = db.prepare(`
    INSERT INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate)
    VALUES ('000300.SH', ?, ?, 0, ?, ?, ?, 1000, NULL)
  `)
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(latest)
    date.setUTCDate(date.getUTCDate() - index)
    const ymd = date.toISOString().slice(0, 10).replace(/-/g, '')
    const close = 3800 + count - index
    statement.run(ymd, close, close - 2, close + 2, close - 4)
  }
}

function benchmarkKlines(latestDate: string, count = 30): string[] {
  const latest = new Date(Date.UTC(
    Number(latestDate.slice(0, 4)),
    Number(latestDate.slice(4, 6)) - 1,
    Number(latestDate.slice(6, 8)),
  ))
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(latest)
    date.setUTCDate(date.getUTCDate() - (count - 1 - index))
    const close = 3800 + index
    return `${date.toISOString().slice(0, 10)},${close - 2},${close},${close + 2},${close - 4},1000,1000000`
  })
}

describe('FR-252 trend benchmark freshness', () => {
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

  it('switches the expected fact date only after 18:00 Beijing time', () => {
    seedCalendar(db, [
      ['20260724', 1],
      ['20260725', 0],
      ['20260726', 0],
      ['20260727', 1],
    ])
    seedBenchmark(db, '20260724')

    const before = inspectTrendBenchmarkHealth(db, atBeijing('2026-07-27T17:59:00'))
    const after = inspectTrendBenchmarkHealth(db, atBeijing('2026-07-27T18:00:00'))

    expect(getSettledCutoffDate(atBeijing('2026-07-27T17:59:00'))).toBe('20260726')
    expect(before).toMatchObject({ state: 'current', expectedTradeDate: '20260724', calendarSource: 'trade-calendar' })
    expect(after).toMatchObject({ state: 'stale', expectedTradeDate: '20260727', errorCode: 'EXPECTED_DATE_MISSING' })
  })

  it('reuses the previous session on an exchange holiday without requesting upstream', async () => {
    seedCalendar(db, [
      ['20260930', 1],
      ['20261001', 0],
      ['20261002', 0],
    ])
    seedBenchmark(db, '20260930')

    const result = await ensureTrendBenchmarkFreshness(db, atBeijing('2026-10-01T18:00:00'))

    expect(result).toMatchObject({ state: 'current', expectedTradeDate: '20260930', refreshOutcome: 'not-needed', attempted: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks a lagging weekday fallback as calendar-unknown instead of stale', () => {
    db.exec('DELETE FROM trade_cal')
    seedBenchmark(db, '20260930')

    const result = inspectTrendBenchmarkHealth(db, atBeijing('2026-10-01T18:00:00'))

    expect(result).toMatchObject({
      state: 'calendar-unknown',
      expectedTradeDate: '20261001',
      calendarSource: 'weekday-fallback',
      errorCode: 'CALENDAR_UNAVAILABLE',
    })
  })

  it('deduplicates a failed refresh for the same expected fact date', async () => {
    seedCalendar(db, [['20260724', 1], ['20260727', 1]])
    seedBenchmark(db, '20260724')
    fetchMock.mockRejectedValue(new Error('offline'))
    const now = atBeijing('2026-07-27T18:00:00')

    const first = await ensureTrendBenchmarkFreshness(db, now)
    const second = await ensureTrendBenchmarkFreshness(db, now + 60_000)

    expect(first).toMatchObject({ state: 'stale', refreshOutcome: 'failed', attempted: true, errorCode: 'NETWORK_ERROR' })
    expect(second).toMatchObject({ state: 'stale', refreshOutcome: 'deduplicated', attempted: false, errorCode: 'NETWORK_ERROR' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight request and reports the refreshed expected date', async () => {
    seedCalendar(db, [['20260724', 1], ['20260727', 1]])
    seedBenchmark(db, '20260724')
    let resolveFetch: ((value: unknown) => void) | null = null
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))
    const now = atBeijing('2026-07-27T18:00:00')

    const first = ensureTrendBenchmarkFreshness(db, now)
    const second = ensureTrendBenchmarkFreshness(db, now)
    expect(first).toBe(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch?.({
      ok: true,
      json: async () => ({ rc: 0, data: { name: '沪深300', klines: benchmarkKlines('20260727') } }),
    })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual(secondResult)
    expect(firstResult).toMatchObject({ state: 'current', latestTradeDate: '20260727', refreshOutcome: 'updated', attempted: true })
    expect(firstResult.bars).toBeGreaterThanOrEqual(21)
  })
})
