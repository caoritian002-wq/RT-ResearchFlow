import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFacts: vi.fn(),
  fetchCurrentFacts: vi.fn(),
  fetchTrend: vi.fn(),
}))

vi.mock('../../electron/main/services/marketResonanceService', () => ({
  readMarketIndustryBoardFacts: mocks.readFacts,
  fetchCurrentMarketIndustryBoardFacts: mocks.fetchCurrentFacts,
  fetchMarketTrendSeries: mocks.fetchTrend,
}))

import { getMarketResonanceIndustryChildren } from '../../electron/main/services/marketResonanceIndustryService'
import { getShenwanL2Names } from '../../electron/main/services/marketResonanceIndustryModel'

const db = {} as never

function electronicFactMap() {
  const map = new Map<string, {
    boardCode: string
    name: string
    weightedChange: number
    upCount: number
    downCount: number
    flatCount: number
    breadthRate: number
    mainNetInflow: number
    mainNetInflowRate: number
  }>()
  map.set('BK1201', {
    boardCode: 'BK1201', name: '电子', weightedChange: 0.5,
    upCount: 60, downCount: 30, flatCount: 10, breadthRate: 0.6,
    mainNetInflow: 1_000, mainNetInflowRate: 1,
  })
  getShenwanL2Names('电子').forEach((name, index) => {
    map.set(`BK99${String(index).padStart(4, '0')}`, {
      boardCode: `BK99${String(index).padStart(4, '0')}`,
      name,
      weightedChange: 2 - index * 0.4,
      upCount: 60 - index,
      downCount: 30 + index,
      flatCount: 10,
      breadthRate: (60 - index) / 100,
      mainNetInflow: 1_000 - index * 100,
      mainNetInflowRate: 1 - index * 0.1,
    })
  })
  return map
}

beforeEach(() => {
  mocks.readFacts.mockReset()
  mocks.fetchCurrentFacts.mockReset()
  mocks.fetchTrend.mockReset()
})

describe('FR-262 二级行业按需读取', () => {
  it('只请求当前父行业的二级分钟并按相对父级超额排序', async () => {
    mocks.readFacts.mockReturnValue(electronicFactMap())
    mocks.fetchTrend.mockImplementation(async (_secid, code, name, tradeDate) => ({
      availableTradeDates: [tradeDate],
      series: { code, name, tradeDate, change: 1, points: [{ time: '09:31', change: 0.1 }] },
    }))

    const result = await getMarketResonanceIndustryChildren(db, {
      tradeDate: '20260807',
      parentIndustryCode: 'BK1201',
      forceRefresh: true,
    })

    expect(mocks.fetchTrend).toHaveBeenCalledTimes(getShenwanL2Names('电子').length)
    expect(result.children).toHaveLength(getShenwanL2Names('电子').length)
    expect(result.children.map((child) => child.excessVsParent)).toEqual(
      [...result.children.map((child) => child.excessVsParent)].sort((left, right) => (right ?? 0) - (left ?? 0)),
    )
    expect(result.trendCoverage).toEqual({ available: 6, total: 6 })
  })

  it('历史分钟全部失败时仍返回同日二级日级事实', async () => {
    mocks.readFacts.mockReturnValue(electronicFactMap())
    mocks.fetchTrend.mockRejectedValue(new Error('EASTMONEY_TREND_DATE_UNAVAILABLE'))

    const result = await getMarketResonanceIndustryChildren(db, {
      tradeDate: '20260806',
      parentIndustryCode: 'BK1201',
      forceRefresh: true,
    })

    expect(result.children).toHaveLength(6)
    expect(result.children.every((child) => child.tradeDate === '20260806' && child.points.length === 0)).toBe(true)
    expect(result.trendCoverage).toEqual({ available: 0, total: 6 })
    expect(mocks.fetchTrend).toHaveBeenCalledTimes(1)
    expect(mocks.fetchCurrentFacts).not.toHaveBeenCalled()
  })

  it('当前交易日单个二级分钟失败不阻断同组其他行业', async () => {
    mocks.readFacts.mockReturnValue(electronicFactMap())
    mocks.fetchTrend.mockImplementation(async (_secid, code, name, tradeDate) => {
      if (code === 'BK990000') throw new Error('NETWORK_UNAVAILABLE')
      return {
        availableTradeDates: [tradeDate],
        series: { code, name, tradeDate, change: 1, points: [{ time: '09:31', change: 0.1 }] },
      }
    })
    const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const tradeDate = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`

    const result = await getMarketResonanceIndustryChildren(db, {
      tradeDate,
      parentIndustryCode: 'BK1201',
      forceRefresh: true,
    })

    expect(mocks.fetchTrend).toHaveBeenCalledTimes(getShenwanL2Names('电子').length)
    expect(result.trendCoverage).toEqual({ available: 5, total: 6 })
  })

  it('同一父级的并发强制重试复用一次请求', async () => {
    mocks.readFacts.mockReturnValue(electronicFactMap())
    mocks.fetchTrend.mockImplementation(async (_secid, code, name, tradeDate) => ({
      availableTradeDates: [tradeDate],
      series: { code, name, tradeDate, change: 1, points: [{ time: '09:31', change: 0.1 }] },
    }))
    const request = {
      tradeDate: '20260805',
      parentIndustryCode: 'BK1201',
      forceRefresh: true,
    }

    const [first, second] = await Promise.all([
      getMarketResonanceIndustryChildren(db, request),
      getMarketResonanceIndustryChildren(db, request),
    ])

    expect(first).toBe(second)
    expect(mocks.fetchTrend).toHaveBeenCalledTimes(getShenwanL2Names('电子').length)
  })
})
