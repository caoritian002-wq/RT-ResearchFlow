import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTradeDay: vi.fn(),
  getLastNTradingDays: vi.fn(),
  fetchTrend: vi.fn(),
  fetchFacts: vi.fn(),
}))

vi.mock('../../electron/main/database/tradeCalRepository', () => ({
  isTradeDay: mocks.isTradeDay,
  getLastNTradingDays: mocks.getLastNTradingDays,
}))

vi.mock('../../electron/main/services/marketResonanceService', () => ({
  fetchMarketTrendSeries: mocks.fetchTrend,
  fetchCurrentMarketIndustryBoardFacts: mocks.fetchFacts,
}))

import {
  recoverHeatmapMomentum,
  resolveHeatmapMomentumRecoveryTarget,
} from '../../electron/main/services/marketHeatmapMomentumRecoveryService'

const db = {
  prepare: vi.fn(() => ({ get: vi.fn(() => ({ trade_date: null })) })),
} as never

function beijingTimestamp(value: string): number {
  return Date.parse(`${value}+08:00`)
}

function trendSeries(code: string, name: string, tradeDate = '20260811') {
  return {
    availableTradeDates: [tradeDate],
    series: {
      code,
      name,
      tradeDate,
      change: 1.4,
      points: [
        { time: '11:27', change: 1 },
        { time: '11:30', change: 1.25 },
        { time: '14:57', change: 1.1 },
        { time: '15:00', change: 1.4 },
      ],
    },
  }
}

beforeEach(() => {
  mocks.isTradeDay.mockReset()
  mocks.getLastNTradingDays.mockReset()
  mocks.fetchTrend.mockReset()
  mocks.fetchFacts.mockReset()
  mocks.isTradeDay.mockReturnValue(true)
  mocks.getLastNTradingDays.mockReturnValue(['20260807'])
  mocks.fetchFacts.mockResolvedValue(new Map())
  mocks.fetchTrend.mockImplementation(async (_secid: string, code: string, name: string, tradeDate: string) => (
    trendSeries(code, name, tradeDate)
  ))
})

describe('FR-264 午休与盘后历史动量恢复', () => {
  it('只在午休和盘后为当前交易日形成恢复目标', () => {
    expect(resolveHeatmapMomentumRecoveryTarget(db, beijingTimestamp('2026-08-11T11:45:00'))).toEqual({
      tradeDate: '20260811',
      boundary: 'lunch-close',
      boundaryTime: '11:30',
    })
    expect(resolveHeatmapMomentumRecoveryTarget(db, beijingTimestamp('2026-08-11T15:10:00'))).toEqual({
      tradeDate: '20260811',
      boundary: 'market-close',
      boundaryTime: '15:00',
    })
    expect(resolveHeatmapMomentumRecoveryTarget(db, beijingTimestamp('2026-08-11T10:00:00'))).toBeNull()
    expect(resolveHeatmapMomentumRecoveryTarget(db, beijingTimestamp('2026-08-11T13:05:00'))).toBeNull()
  })

  it('休市日恢复本地交易日历确认的最近交易日收盘边界', () => {
    mocks.isTradeDay.mockReturnValue(false)
    expect(resolveHeatmapMomentumRecoveryTarget(db, beijingTimestamp('2026-08-09T12:00:00'))).toEqual({
      tradeDate: '20260807',
      boundary: 'market-close',
      boundaryTime: '15:00',
    })
  })

  it('使用统一的11:27与11:30分钟恢复31个申万一级行业', async () => {
    const result = await recoverHeatmapMomentum(db, {
      windowMinutes: 3,
      includeL2: false,
      forceRefresh: true,
    }, beijingTimestamp('2026-08-11T12:00:00'))

    expect(result).toMatchObject({
      origin: 'historical-recovery',
      sourceProvider: 'eastmoney',
      tradeDate: '2026-08-11',
      boundary: 'lunch-close',
      boundaryTime: '11:30',
      baselineTime: '11:27',
      windowMinutes: 3,
      coverage: {
        l1: { available: 31, total: 31 },
        l2: { available: 0, total: 0 },
      },
    })
    expect(Object.keys(result?.momentum ?? {})).toHaveLength(31)
    expect(result?.momentum.电子).toBe(0.25)
    expect(mocks.fetchTrend).toHaveBeenCalledTimes(31)
  })

  it('本地v2记录已覆盖同一交易边界和窗口时不重复联网', async () => {
    const result = await recoverHeatmapMomentum(db, {
      windowMinutes: 3,
      includeL2: false,
      existingRecord: {
        tradeDate: '2026-08-11',
        boundary: 'lunch-close',
        windowMinutes: 3,
      },
    }, beijingTimestamp('2026-08-11T12:00:00'))

    expect(result).toBeNull()
    expect(mocks.fetchTrend).not.toHaveBeenCalled()
  })

  it('东财与Tushare模式可追加当前总表可识别的申万二级行业', async () => {
    mocks.fetchFacts.mockResolvedValue(new Map([
      ['BK1036', { boardCode: 'BK1036', name: '半导体' }],
      ['BK1037', { boardCode: 'BK1037', name: '消费电子' }],
    ]))
    const result = await recoverHeatmapMomentum(db, {
      windowMinutes: 3,
      includeL2: true,
      forceRefresh: true,
    }, beijingTimestamp('2026-08-11T15:10:00'))

    expect(result?.coverage).toEqual({
      l1: { available: 31, total: 31 },
      l2: { available: 2, total: 2 },
    })
    expect(result?.momentum.半导体).toBe(0.3)
    expect(result?.momentum.消费电子).toBe(0.3)
  })

  it('统一边界或基线分钟缺失时拒绝形成方向性排名', async () => {
    mocks.fetchTrend.mockImplementation(async (_secid: string, code: string, name: string, tradeDate: string) => ({
      ...trendSeries(code, name, tradeDate),
      series: {
        ...trendSeries(code, name, tradeDate).series,
        points: [{ time: '14:58', change: 1.2 }, { time: '15:00', change: 1.4 }],
      },
    }))
    await expect(recoverHeatmapMomentum(db, {
      windowMinutes: 3,
      includeL2: false,
      forceRefresh: true,
    }, beijingTimestamp('2026-08-11T15:10:00'))).rejects.toThrow('HEATMAP_MOMENTUM_BOUNDARY_UNAVAILABLE')
  })
})
