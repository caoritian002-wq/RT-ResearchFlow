import { describe, expect, it } from 'vitest'
import { buildBollingerBandSeries, buildMovingAverageSeries } from '../../src/utils/movingAverage'
import { INITIAL_HISTORY_BARS, MAX_VISIBLE_PRESET_BARS } from '../../src/components/StockChart/stockChartHistoryModel'

describe('个股快捷详情均线', () => {
  it('使用完整日K计算MA5、MA20和MA60，并覆盖最后120日可见区间', () => {
    const rows = Array.from({ length: 216 }, (_, index) => ({
      tradeDate: `2026${String(index + 1).padStart(4, '0')}`,
      close: index + 1,
    }))

    const ma5 = buildMovingAverageSeries(rows, 5)
    const ma20 = buildMovingAverageSeries(rows, 20)
    const ma60 = buildMovingAverageSeries(rows, 60)

    expect(ma5).toHaveLength(212)
    expect(ma5[0]).toEqual({ tradeDate: rows[4].tradeDate, value: 3 })
    expect(ma20).toHaveLength(197)
    expect(ma20[0]).toEqual({ tradeDate: rows[19].tradeDate, value: 10.5 })
    expect(ma60).toHaveLength(157)
    expect(ma60[0]).toEqual({ tradeDate: rows[59].tradeDate, value: 30.5 })
    expect(ma60.at(-1)).toEqual({ tradeDate: rows[215].tradeDate, value: 186.5 })

    const visibleStart = rows.at(-120)!.tradeDate
    expect(ma5[0].tradeDate < visibleStart).toBe(true)
    expect(ma20[0].tradeDate < visibleStart).toBe(true)
    expect(ma60[0].tradeDate < visibleStart).toBe(true)
  })

  it('遇到无效收盘价时不跨越缺口拼接均线', () => {
    const rows = [
      { tradeDate: '20260701', close: 10 },
      { tradeDate: '20260702', close: 11 },
      { tradeDate: '20260703', close: Number.NaN },
      { tradeDate: '20260704', close: 12 },
      { tradeDate: '20260705', close: 13 },
      { tradeDate: '20260706', close: 14 },
    ]

    expect(buildMovingAverageSeries(rows, 3)).toEqual([
      { tradeDate: '20260706', value: 13 },
    ])
  })

  it('首屏预热使MA60和BOLL在90日窗口左边界前已形成', () => {
    const rows = Array.from({ length: INITIAL_HISTORY_BARS }, (_, index) => ({
      tradeDate: `2026${String(index + 1).padStart(4, '0')}`,
      close: index + 1,
    }))
    const visibleStart = rows[rows.length - MAX_VISIBLE_PRESET_BARS].tradeDate
    const ma60 = buildMovingAverageSeries(rows, 60)
    const boll = buildBollingerBandSeries(rows)

    expect(INITIAL_HISTORY_BARS).toBe(149)
    expect(ma60[0].tradeDate).toBe(visibleStart)
    expect(boll[0].tradeDate < visibleStart).toBe(true)
    expect(ma60.filter(point => point.tradeDate >= visibleStart)).toHaveLength(90)
    expect(boll.filter(point => point.tradeDate >= visibleStart)).toHaveLength(90)
  })

  it('按20日总体标准差计算本地BOLL三轨', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      tradeDate: `202607${String(index + 1).padStart(2, '0')}`,
      close: index + 1,
    }))
    const point = buildBollingerBandSeries(rows)[0]
    expect(point.tradeDate).toBe('20260720')
    expect(point.mid).toBe(10.5)
    expect(point.upper).toBeCloseTo(22.0326, 4)
    expect(point.lower).toBeCloseTo(-1.0326, 4)
  })
})
