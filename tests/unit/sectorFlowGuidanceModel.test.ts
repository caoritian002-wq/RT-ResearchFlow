import { describe, expect, it } from 'vitest'
import {
  buildSectorFlowGuidance,
  selectSectorFlowMemberCandidateCodes,
} from '../../electron/main/services/sectorFlowGuidanceModel'
import type { SectorFlowItem, SectorFlowStock } from '../../electron/main/services/sectorFlowTypes'

function stock(code: string, flow: number): SectorFlowStock {
  return {
    tsCode: `${code}.SZ`,
    name: `股票${code}`,
    change: flow >= 0 ? 2 : -2,
    totalAmount: 100_000_000,
    mainNetInflow: flow,
    mainNetInflowRate: flow / 100_000_000 * 100,
  }
}

function item(overrides: Partial<SectorFlowItem> = {}): SectorFlowItem {
  return {
    boardCode: 'BK1000',
    boardName: '主线A',
    scope: 'concept',
    metricMode: 'verified_flow',
    totalAmount: 10_000_000_000,
    turnoverDirectionStrength: null,
    mainNetInflow: 800_000_000,
    mainNetInflowRate: 8,
    superLargeNetInflow: 400_000_000,
    superLargeNetInflowRate: 4,
    largeNetInflow: 400_000_000,
    largeNetInflowRate: 4,
    mediumNetInflow: -100_000_000,
    mediumNetInflowRate: -1,
    smallNetInflow: -200_000_000,
    smallNetInflowRate: -2,
    weightedChange: 2.5,
    totalMarketCap: 100_000_000_000,
    memberCount: 10,
    upCount: 8,
    downCount: 2,
    flatCount: 0,
    previousMainNetInflow: 200_000_000,
    leader: null,
    coreStocks: [],
    relatedThemes: [],
    sourceUpdatedAt: Date.now(),
    ...overrides,
  }
}

describe('FR-243 板块竞价指引模型', () => {
  it('把成分高度重合的概念合并为一个代表主题', () => {
    const firstMembers = ['000001', '000002', '000003', '000004'].map((code) => stock(code, 50_000_000))
    const secondMembers = ['000001', '000002', '000003', '000005'].map((code) => stock(code, 40_000_000))
    const isolatedMembers = ['000010', '000011', '000012'].map((code) => stock(code, 30_000_000))
    const result = buildSectorFlowGuidance([
      item(),
      item({ boardCode: 'BK1001', boardName: '同义主题', mainNetInflow: 700_000_000 }),
      item({ boardCode: 'BK1002', boardName: '独立主题', mainNetInflow: 600_000_000 }),
    ], new Map([
      ['BK1000', firstMembers],
      ['BK1001', secondMembers],
      ['BK1002', isolatedMembers],
    ]))

    expect(result.guidance.focusThemes).toHaveLength(2)
    expect(result.guidance.focusThemes[0].relatedThemes).toEqual([
      { boardCode: 'BK1001', boardName: '同义主题' },
    ])
    expect(result.guidance.focusThemes[0].coreStocks).toHaveLength(3)
  })

  it('成分抓取候选与结论评分保持一致，并复用存档中的已确认关联', () => {
    const highScore = item({
      boardCode: 'BK2000', boardName: '高评分主题', mainNetInflow: 300_000_000,
      mainNetInflowRate: 8, weightedChange: 4, upCount: 9, downCount: 1,
      relatedThemes: [{ boardCode: 'BK2001', boardName: '存档同义主题' }],
    })
    const highAmountLowScore = item({
      boardCode: 'BK2001', boardName: '存档同义主题', mainNetInflow: 900_000_000,
      mainNetInflowRate: 1, weightedChange: 0.1, upCount: 5, downCount: 5,
    })

    expect(selectSectorFlowMemberCandidateCodes([highAmountLowScore, highScore], 1, 0)).toEqual(['BK2000'])
    const result = buildSectorFlowGuidance([highScore, highAmountLowScore], new Map())
    expect(result.guidance.focusThemes).toHaveLength(1)
    expect(result.guidance.focusThemes[0].relatedThemes).toContainEqual({
      boardCode: 'BK2001', boardName: '存档同义主题',
    })
  })

  it('区分轮动、分化与退潮，不把流入直接等同为延续', () => {
    const members = new Map([
      ['BK1000', ['000001', '000002', '000003'].map((code) => stock(code, 50_000_000))],
      ['BK2000', ['000010', '000011', '000012'].map((code) => stock(code, -50_000_000))],
      ['BK3000', ['000020', '000021', '000022'].map((code) => stock(code, 20_000_000))],
    ])
    const result = buildSectorFlowGuidance([
      item({ previousMainNetInflow: -100_000_000 }),
      item({ boardCode: 'BK2000', boardName: '弱势主题', mainNetInflow: -900_000_000, mainNetInflowRate: -9, weightedChange: -3, upCount: 2, downCount: 8 }),
      item({ boardCode: 'BK3000', boardName: '资金分化', mainNetInflow: 500_000_000, mainNetInflowRate: 5, weightedChange: -0.5, upCount: 4, downCount: 6 }),
    ], members)

    expect(result.guidance.focusThemes.find((theme) => theme.boardCode === 'BK1000')?.state).toBe('rotation')
    expect(result.guidance.focusThemes.find((theme) => theme.boardCode === 'BK3000')?.state).toBe('divergence')
    expect(result.guidance.riskThemes[0].state).toBe('retreat')
  })

  it('降级成交方向强度只返回证据不足，不生成资金主题', () => {
    const degraded = item({
      metricMode: 'turnover_strength',
      mainNetInflow: null,
      mainNetInflowRate: null,
      turnoverDirectionStrength: 35,
    })
    const result = buildSectorFlowGuidance([degraded], new Map())
    expect(result.guidance.stance).toBe('insufficient')
    expect(result.guidance.focusThemes).toEqual([])
    expect(result.guidance.riskThemes).toEqual([])
    expect(result.guidance.summary).toContain('成交方向强度')
  })

  it('结论保留缺失的净流入率，不把未知值伪装成零', () => {
    const result = buildSectorFlowGuidance([
      item({ mainNetInflowRate: null }),
    ], new Map([
      ['BK1000', ['000001', '000002', '000003'].map((code) => stock(code, 50_000_000))],
    ]))
    expect(result.guidance.focusThemes[0].mainNetInflowRate).toBeNull()
  })
})
