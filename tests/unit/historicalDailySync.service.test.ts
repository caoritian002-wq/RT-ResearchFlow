import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  countDailyCloseByTradeDates: vi.fn(),
  upsertDailyClose: vi.fn(),
  getLastNTradingDays: vi.fn(),
  fetchDailyBasicByDate: vi.fn(),
  fetchDailyByDate: vi.fn(),
  syncTradeCalFull: vi.fn(),
  syncTradeCalIfNeeded: vi.fn(),
}))

vi.mock('../../electron/main/database/dailyCloseCacheRepository', () => ({
  countDailyCloseByTradeDates: mocks.countDailyCloseByTradeDates,
  upsertDailyClose: mocks.upsertDailyClose,
}))
vi.mock('../../electron/main/database/tradeCalRepository', () => ({
  getLastNTradingDays: mocks.getLastNTradingDays,
}))
vi.mock('../../electron/main/services/tushareService', () => ({
  fetchDailyBasicByDate: mocks.fetchDailyBasicByDate,
  fetchDailyByDate: mocks.fetchDailyByDate,
}))
vi.mock('../../electron/main/services/tradeCalSyncService', () => ({
  syncTradeCalFull: mocks.syncTradeCalFull,
  syncTradeCalIfNeeded: mocks.syncTradeCalIfNeeded,
}))

import { getHistoricalDailyDefaultEndDate, runHistoricalDailySync } from '../../electron/main/services/historicalDailySyncService'

describe('historicalDailySyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.syncTradeCalIfNeeded.mockResolvedValue(undefined)
    mocks.syncTradeCalFull.mockResolvedValue(undefined)
    mocks.countDailyCloseByTradeDates.mockReturnValue(new Map())
    mocks.fetchDailyBasicByDate.mockResolvedValue([])
    mocks.fetchDailyByDate.mockResolvedValue([])
  })

  it('盘中默认截止前一日，18点后才允许检查当日盘后数据', () => {
    expect(getHistoricalDailyDefaultEndDate(Date.UTC(2026, 6, 20, 9, 59))).toBe('20260719')
    expect(getHistoricalDailyDefaultEndDate(Date.UTC(2026, 6, 20, 10, 0))).toBe('20260720')
  })

  it('历史交易日不足时强制刷新日历，而不是只相信最晚未来日期', async () => {
    mocks.getLastNTradingDays
      .mockReturnValueOnce(['20260716'])
      .mockReturnValueOnce(['20260715', '20260716', '20260717'])
    mocks.countDailyCloseByTradeDates.mockReturnValue(new Map([
      ['20260715', 5000],
      ['20260716', 5000],
      ['20260717', 5000],
    ]))

    const result = await runHistoricalDailySync({} as never, 'token', undefined, {
      tradeDayCount: 3,
      completeRowThreshold: 4000,
      requestDelayMs: 0,
      endDate: '20260720',
    })

    expect(mocks.syncTradeCalIfNeeded).toHaveBeenCalledOnce()
    expect(mocks.syncTradeCalFull).toHaveBeenCalledOnce()
    expect(mocks.getLastNTradingDays).toHaveBeenNthCalledWith(1, expect.anything(), 3, '20260720')
    expect(mocks.getLastNTradingDays).toHaveBeenNthCalledWith(2, expect.anything(), 3, '20260720')
    expect(result.totalTradeDays).toBe(3)
    expect(result.skippedTradeDays).toBe(3)
  })

  it('强制刷新后历史仍不足时明确阻断，不用工作日猜测冒充交易日历', async () => {
    mocks.getLastNTradingDays.mockReturnValue(['20260717'])

    await expect(runHistoricalDailySync({} as never, 'token', undefined, {
      tradeDayCount: 3,
      requestDelayMs: 0,
    })).rejects.toMatchObject({ code: 'TRADE_CAL_HISTORY_INCOMPLETE' })
    expect(mocks.fetchDailyByDate).not.toHaveBeenCalled()
  })

  it('只请求缺失交易日并通过统一进度回调报告结果', async () => {
    const days = ['20260715', '20260716', '20260717']
    mocks.getLastNTradingDays.mockReturnValue(days)
    mocks.countDailyCloseByTradeDates.mockReturnValue(new Map([
      ['20260715', 5000],
      ['20260716', 0],
      ['20260717', 5000],
    ]))
    mocks.fetchDailyByDate.mockResolvedValue([{
      tsCode: '000001.SZ', tradeDate: '20260716', open: 10, high: 11, low: 9, close: 10.5,
      pctChg: 1, vol: 100, turnoverRate: null,
    }])
    const onProgress = vi.fn()

    const result = await runHistoricalDailySync({} as never, 'token', undefined, {
      tradeDayCount: 3,
      completeRowThreshold: 4000,
      requestDelayMs: 0,
      onProgress,
    })

    expect(mocks.syncTradeCalFull).not.toHaveBeenCalled()
    expect(mocks.fetchDailyByDate).toHaveBeenCalledOnce()
    expect(mocks.fetchDailyByDate).toHaveBeenCalledWith('token', '20260716')
    expect(mocks.upsertDailyClose).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ syncedTradeDays: 1, skippedTradeDays: 2, failedTradeDays: 0 })
    expect(onProgress).toHaveBeenCalled()
  })
})
