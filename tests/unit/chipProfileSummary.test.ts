import { describe, expect, it } from 'vitest'
import { calculateChipProfileSummary } from '../../src/utils/drawChipsCanvas'

describe('筹码价格剖面白盒摘要', () => {
  it('按当前价格计算浮盈、套牢、主峰与15%-85%核心成本区', () => {
    const summary = calculateChipProfileSummary([
      { price: 8, percent: 10 },
      { price: 9, percent: 20 },
      { price: 10, percent: 40 },
      { price: 11, percent: 30 },
    ], 10)

    expect(summary).toMatchObject({
      totalPercent: 100,
      profitPercent: 70,
      trappedPercent: 30,
      peakPrice: 10,
      peakPercent: 40,
      distanceToPeakPercent: 0,
      coreLowPrice: 9,
      coreHighPrice: 11,
    })
  })

  it('对非100总量做归一化并在缺少现价时保留未知比例', () => {
    const normalized = calculateChipProfileSummary([
      { price: 9, percent: 2 },
      { price: 10, percent: 4 },
      { price: 11, percent: 4 },
      { price: Number.NaN, percent: 8 },
    ], 10)
    expect(normalized?.profitPercent).toBeCloseTo(60)
    expect(normalized?.trappedPercent).toBeCloseTo(40)

    const withoutPrice = calculateChipProfileSummary([
      { price: 9, percent: 2 },
      { price: 10, percent: 4 },
    ], null)
    expect(withoutPrice?.profitPercent).toBeNull()
    expect(withoutPrice?.trappedPercent).toBeNull()
    expect(withoutPrice?.distanceToPeakPercent).toBeNull()
  })

  it('无有效价格级筹码时返回空结果', () => {
    expect(calculateChipProfileSummary([
      { price: 0, percent: 10 },
      { price: 12, percent: 0 },
    ], 12)).toBeNull()
  })
})
