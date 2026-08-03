import { describe, expect, it } from 'vitest'
import type { ChipProfileSummary } from '../../src/utils/drawChipsCanvas'
import {
  buildStockStructureInsight,
  type StockStructureRow,
} from '../../src/components/shared/stockStructureInsightModel'

function createRows(count: number, closeAt: (index: number) => number): StockStructureRow[] {
  return Array.from({ length: count }, (_, index) => {
    const close = closeAt(index)
    return {
      tradeDate: `2026${String(Math.floor(index / 28) + 1).padStart(2, '0')}${String(index % 28 + 1).padStart(2, '0')}`,
      open: close - 0.1,
      high: close + 0.4,
      low: close - 0.4,
      close,
      pctChg: index === 0 ? null : (close / closeAt(index - 1) - 1) * 100,
      amount: 1000 + index * 10,
    }
  })
}

function createProfile(overrides: Partial<ChipProfileSummary> = {}): ChipProfileSummary {
  return {
    totalPercent: 100,
    profitPercent: 50,
    trappedPercent: 50,
    peakPrice: 10,
    peakPercent: 20,
    distanceToPeakPercent: 0,
    coreLowPrice: 9,
    coreHighPrice: 11,
    ...overrides,
  }
}

describe('股票价格与筹码结构研判模型', () => {
  it('基于完整历史计算MA位置、区间收益和风险，不依赖技术因子缓存', () => {
    const result = buildStockStructureInsight({
      rows: createRows(90, (index) => 10 + index * 0.1),
      visibleRange: 60,
      activeProfile: createProfile(),
      latestProfile: null,
    })

    expect(result.sampleCount).toBe(60)
    expect(result.trend.ma20.distancePercent).toBeGreaterThan(0)
    expect(result.trend.ma20.slopePercent).toBeGreaterThan(0)
    expect(result.trend.ma60.slopePercent).toBeGreaterThan(0)
    expect(result.trend.returns[60]).toBeGreaterThan(0)
    expect(result.trend.rangePositionPercent).toBeGreaterThan(90)
    expect(result.trend.summary).toContain('趋势结构保持偏强')
    expect(result.risk.atrPercent).toBeGreaterThan(0)
    expect(result.risk.maxDrawdownPercent).toBe(0)
  })

  it('历史选点严格截断到所选日，不使用其后的价格形成后视判断', () => {
    const rows = createRows(100, (index) => index <= 69 ? 10 + index * 0.05 : 40 - index * 0.2)
    const selectedDate = rows[69].tradeDate
    const result = buildStockStructureInsight({
      rows,
      activeDate: selectedDate,
      visibleRange: 30,
      activeProfile: createProfile(),
      latestProfile: createProfile({ peakPrice: 12 }),
    })

    expect(result.isHistorical).toBe(true)
    expect(result.activeDate).toBe(selectedDate)
    expect(result.close).toBe(rows[69].close)
    expect(result.sampleCount).toBe(30)
    expect(result.trend.summary).toContain('趋势结构保持偏强')
  })

  it('历史筹码与最新筹码形成中枢、宽度和浮盈比例的可追溯变化', () => {
    const rows = createRows(80, (index) => 10 + index * 0.03)
    const result = buildStockStructureInsight({
      rows,
      activeDate: rows[60].tradeDate,
      visibleRange: 60,
      activeProfile: createProfile({ profitPercent: 35, trappedPercent: 65 }),
      latestProfile: createProfile({
        profitPercent: 65,
        trappedPercent: 35,
        peakPrice: 12,
        coreLowPrice: 11,
        coreHighPrice: 12,
      }),
    })

    expect(result.chips.peakShiftPercent).toBeCloseTo(20)
    expect(result.chips.coreShiftPercent).toBeCloseTo(15)
    expect(result.chips.coreWidthChangePoints).toBeLessThan(-10)
    expect(result.chips.profitChangePoints).toBe(30)
    expect(result.chips.summary).toContain('成本中枢上移')
    expect(result.chips.summary).toContain('核心区收敛')
  })

  it('缺少日线或筹码时保持明确空态，不伪造关键位置', () => {
    const result = buildStockStructureInsight({
      rows: [],
      visibleRange: 60,
      activeProfile: null,
      latestProfile: null,
    })

    expect(result.close).toBeNull()
    expect(result.trend.ma20.value).toBeNull()
    expect(result.risk.support).toBeNull()
    expect(result.risk.resistance).toBeNull()
    expect(result.chips.summary).toContain('没有可用筹码分布')
  })
})
