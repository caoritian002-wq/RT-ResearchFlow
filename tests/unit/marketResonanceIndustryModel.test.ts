import { describe, expect, it } from 'vitest'
import { SHENWAN_L1_INDUSTRIES, SHENWAN_L2_TO_L1_NAME } from '../../electron/main/services/eastmoneyIndustryHierarchy'
import {
  buildMarketIndustryStructure,
  getShenwanL2Names,
} from '../../electron/main/services/marketResonanceIndustryModel'

function electronicFacts(changes: number[]) {
  return getShenwanL2Names('电子').map((name, index) => ({
    name,
    weightedChange: changes[index] ?? 0,
  }))
}

describe('FR-262 二级行业结构模型', () => {
  it('申万二级名称全部有唯一父级且31个一级均可下钻', () => {
    expect(Object.keys(SHENWAN_L2_TO_L1_NAME)).toHaveLength(128)
    expect(new Set(Object.values(SHENWAN_L2_TO_L1_NAME))).toEqual(
      new Set(SHENWAN_L1_INDUSTRIES.map((industry) => industry.name)),
    )
  })

  it('区分普遍走强、普遍走弱、集中领涨和内部分化', () => {
    expect(buildMarketIndustryStructure('电子', 1.1, electronicFacts([2, 1.8, 1.4, 1.2, 0.8, -0.1])).state)
      .toBe('broad_strength')
    expect(buildMarketIndustryStructure('电子', -1, electronicFacts([-0.2, -0.5, -0.8, -1, -1.2, 0.1])).state)
      .toBe('broad_weakness')
    expect(buildMarketIndustryStructure('电子', 0.4, electronicFacts([2, 0.2, -0.1, -0.2, -0.3, -0.4])).state)
      .toBe('concentrated_lead')
    expect(buildMarketIndustryStructure('电子', 0.4, electronicFacts([0.9, 0.5, 0.2, -0.1, -0.4, -0.6])).state)
      .toBe('divergent')
  })

  it('覆盖不足时保持证据不足并披露真实覆盖', () => {
    const result = buildMarketIndustryStructure('电子', 1, electronicFacts([1.2, 0.8]).slice(0, 2))
    expect(result).toMatchObject({ state: 'insufficient', available: 2, total: 6 })
    expect(result.summary).toContain('2/6')
  })

  it('分化摘要不会把下跌行业同时列为领涨或把上涨行业列为拖累', () => {
    const names = getShenwanL2Names('房地产')
    const result = buildMarketIndustryStructure('房地产', 0, [
      { name: names[0], weightedChange: 1.2 },
      { name: names[1], weightedChange: -0.8 },
    ])

    expect(result).toMatchObject({
      state: 'divergent',
      leaders: [names[0]],
      laggards: [names[1]],
    })
    expect(result.summary).toContain(`${names[0]}走强`)
    expect(result.summary).toContain(`${names[1]}形成拖累`)
  })
})
