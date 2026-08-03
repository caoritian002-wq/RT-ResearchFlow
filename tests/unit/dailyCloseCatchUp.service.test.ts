import { beforeEach, describe, expect, it, vi } from 'vitest'

const runHistoricalDailySync = vi.hoisted(() => vi.fn())

vi.mock('../../electron/main/services/historicalDailySyncService', () => ({
  getHistoricalDailyDefaultEndDate: (now: number) => {
    const date = new Date(now + 8 * 60 * 60 * 1000)
    if (date.getUTCHours() < 18) date.setUTCDate(date.getUTCDate() - 1)
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
  },
  runHistoricalDailySync,
}))

import {
  getLastSettledMarketCalendarDate,
  runStartupDailyCloseCatchUp,
  STARTUP_DAILY_CATCH_UP_TRADE_DAYS,
} from '../../electron/main/services/dailyCloseCatchUpService'

describe('dailyCloseCatchUpService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runHistoricalDailySync.mockResolvedValue({ totalTradeDays: STARTUP_DAILY_CATCH_UP_TRADE_DAYS })
  })

  it('北京时间18点前只补到前一自然日', () => {
    expect(getLastSettledMarketCalendarDate(Date.UTC(2026, 6, 20, 8, 0))).toBe('20260719')
  })

  it('北京时间18点后允许检查当日日线', () => {
    expect(getLastSettledMarketCalendarDate(Date.UTC(2026, 6, 20, 10, 0))).toBe('20260720')
  })

  it('启动时只检查最近20个交易日并复用共享同步服务', async () => {
    await runStartupDailyCloseCatchUp({} as never, 'token', Date.UTC(2026, 6, 20, 8, 0))
    expect(runHistoricalDailySync).toHaveBeenCalledWith(expect.anything(), 'token', undefined, {
      tradeDayCount: 20,
      endDate: '20260719',
    })
  })
})
