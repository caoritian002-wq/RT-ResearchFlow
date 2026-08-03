import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchCyqChips: vi.fn(),
  fetchDailyForCandidates: vi.fn(),
  getLastNTradingDays: vi.fn(),
  getMonitorStocks: vi.fn(),
  queryChips: vi.fn(),
  upsertChips: vi.fn(),
  upsertDailyClose: vi.fn(),
  upsertMonitorResults: vi.fn(),
}))

vi.mock('../../electron/main/services/cyqChipsFetchService', () => ({
  fetchCyqChipsSingleflight: mocks.fetchCyqChips,
}))

vi.mock('../../electron/main/services/tushareService', () => ({
  fetchDailyForCandidates: mocks.fetchDailyForCandidates,
}))

vi.mock('../../electron/main/database/tradeCalRepository', () => ({
  getLastNTradingDays: mocks.getLastNTradingDays,
}))

vi.mock('../../electron/main/database/chipMonitorRepository', () => ({
  getMonitorStocks: mocks.getMonitorStocks,
  upsertMonitorResults: mocks.upsertMonitorResults,
}))

vi.mock('../../electron/main/database/cyqChipsCacheRepository', () => ({
  queryChips: mocks.queryChips,
  upsertChips: mocks.upsertChips,
}))

vi.mock('../../electron/main/database/dailyCloseCacheRepository', () => ({
  upsertDailyClose: mocks.upsertDailyClose,
}))

import { runChipMonitorJob } from '../../electron/main/services/chipMonitorService'

const tradeDates = [
  '20260710', '20260713', '20260714', '20260715', '20260716',
  '20260717', '20260720', '20260721', '20260722', '20260723',
]

function rowsForDate(tsCode: string, tradeDate: string) {
  return [
    { tsCode, tradeDate, price: 5, percent: 20 },
    { tsCode, tradeDate, price: 7, percent: 30 },
    { tsCode, tradeDate, price: 10, percent: 50 },
  ]
}

function createDb() {
  return {
    prepare(sql: string) {
      if (sql.includes('MAX(trade_date)')) {
        return { get: () => ({ trade_date: tradeDates.at(-1) }) }
      }
      if (sql.includes('SELECT trade_date, close, pct_chg, turnover_rate')) {
        return {
          all: () => tradeDates.map((tradeDate) => ({
            trade_date: tradeDate,
            close: 10,
            pct_chg: 2.5,
            turnover_rate: 1.2,
          })),
        }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

describe('chipMonitorService 批量筹码同步', () => {
  const cache = new Map<string, ReturnType<typeof rowsForDate>>()

  beforeEach(() => {
    vi.clearAllMocks()
    cache.clear()
    mocks.fetchDailyForCandidates.mockResolvedValue([])
    mocks.getLastNTradingDays.mockReturnValue(tradeDates)
    mocks.getMonitorStocks.mockReturnValue([{
      tsCode: '000533',
      source: 'morningAuction',
      stockName: '顺钠股份',
      addedAt: 1,
    }])
    mocks.queryChips.mockImplementation((_db, tsCode: string, tradeDate: string) => (
      cache.get(`${tsCode}|${tradeDate}`) ?? []
    ))
    mocks.upsertChips.mockImplementation((_db, rows: ReturnType<typeof rowsForDate>) => {
      for (const row of rows) {
        const key = `${row.tsCode}|${row.tradeDate}`
        cache.set(key, [...(cache.get(key) ?? []), row])
      }
    })
  })

  it('每只股票只请求一次历史筹码，并仅落库目标交易日', async () => {
    const returnedRows = [
      ...rowsForDate('000533.SZ', '20260105'),
      ...tradeDates.flatMap((tradeDate) => rowsForDate('000533.SZ', tradeDate)),
    ]
    mocks.fetchCyqChips.mockResolvedValue(returnedRows)
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = []

    const result = await runChipMonitorJob(
      createDb() as never,
      'token',
      { webContents: { send: (channel: string, payload: Record<string, unknown>) => events.push({ channel, payload }) } } as never,
      'relative',
      'morningAuction',
    )

    expect(mocks.fetchCyqChips).toHaveBeenCalledTimes(1)
    expect(mocks.fetchCyqChips).toHaveBeenCalledWith('token', '000533.SZ')
    const persistedRows = mocks.upsertChips.mock.calls.flatMap((call) => call[1])
    expect(new Set(persistedRows.map((row) => row.tradeDate))).toEqual(new Set(tradeDates))
    expect(persistedRows).toHaveLength(tradeDates.length * 3)
    expect(mocks.upsertMonitorResults).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ tsCode: '000533.SZ', tradeDate: '20260723' })],
    )
    expect(result).toEqual({ success: 1, failed: 0 })
    expect(events.find((event) => event.channel === 'shortTerm:chipMonitor:progress')?.payload).toMatchObject({
      done: 1,
      total: 1,
    })
  })

  it('全部命中本地缓存时不联网，并直接报告完整进度', async () => {
    for (const tradeDate of tradeDates) {
      cache.set(`000533.SZ|${tradeDate}`, rowsForDate('000533.SZ', tradeDate))
    }
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = []

    const result = await runChipMonitorJob(
      createDb() as never,
      'token',
      { webContents: { send: (channel: string, payload: Record<string, unknown>) => events.push({ channel, payload }) } } as never,
      'relative',
      'morningAuction',
    )

    expect(mocks.fetchCyqChips).not.toHaveBeenCalled()
    expect(result).toEqual({ success: 1, failed: 0 })
    expect(events.find((event) => event.channel === 'shortTerm:chipMonitor:progress')?.payload).toEqual({
      done: 1,
      total: 1,
      currentStock: '本地缓存',
    })
  })
})
