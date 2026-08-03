import { describe, expect, it } from 'vitest'
import {
  AFTER_CLOSE_SYNC_HOUR_BJ,
  getBeijingEpochForYmd,
  getLastSettledCalendarDate,
  isWeekdayYmd,
  offsetYmd,
} from '../../electron/main/services/marketSettlementPolicy'

describe('marketSettlementPolicy', () => {
  it('统一以北京时间18:00切换当日已结算口径', () => {
    expect(AFTER_CLOSE_SYNC_HOUR_BJ).toBe(18)
    expect(getLastSettledCalendarDate(Date.UTC(2026, 6, 31, 9, 59))).toBe('20260730')
    expect(getLastSettledCalendarDate(Date.UTC(2026, 6, 31, 10, 0))).toBe('20260731')
  })

  it('稳定计算北京时间目标时刻和跨月日期', () => {
    expect(getBeijingEpochForYmd('20260731')).toBe(Date.UTC(2026, 6, 31, 10, 0))
    expect(offsetYmd('20260731', 1)).toBe('20260801')
    expect(isWeekdayYmd('20260731')).toBe(true)
    expect(isWeekdayYmd('20260801')).toBe(false)
  })
})
