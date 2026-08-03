import { describe, expect, it } from 'vitest'
import { buildMorningAuctionRecoveryState } from '../../src/components/ShortTermStrategy/morningAuctionRecoveryModel'

const baseInput = {
  loadError: null,
  insightError: null,
  tradeDateStatus: { isTradeDay: true, previousTradeDate: '20260709', nextTradeDate: '20260713', recommendedTradeDate: null },
  uniqueStockCount: 93,
  candidateRecordCount: 185,
  generatedInsightCount: 0,
  missingInsightCount: 185,
  blockedEvidenceCount: 0,
  insights: [],
}

describe('早盘恢复状态模型', () => {
  it('将非交易日解释为日历状态并提供最近交易日', () => {
    const state = buildMorningAuctionRecoveryState({
      ...baseInput,
      tradeDateStatus: { isTradeDay: false, previousTradeDate: '20260710', nextTradeDate: '20260713', recommendedTradeDate: '20260710' },
      uniqueStockCount: 0,
      candidateRecordCount: 0,
      missingInsightCount: 0,
    })

    expect(state.recommendedTradeDate).toBe('20260710')
    expect(state.issues).toContainEqual(expect.objectContaining({
      kind: 'calendar',
      actions: ['switchTradeDate'],
    }))
  })

  it('将运行时失败与业务数据缺失分开并保留 P1 降级说明', () => {
    const state = buildMorningAuctionRecoveryState({
      ...baseInput,
      insightError: {
        code: 'INSIGHT_GENERATION_FAILED',
        message: '结构化竞价研判生成失败。',
        details: 'getCachedMorningAuctionSnapshot is not defined',
      },
    })

    expect(state.issues).toContainEqual(expect.objectContaining({
      kind: 'application',
      actions: ['relaunch', 'regenerateInsights'],
      impact: expect.stringContaining('P1 白盒研判仍可使用'),
    }))
  })

  it('按证据类型聚合受阻项并给出对应恢复动作', () => {
    const state = buildMorningAuctionRecoveryState({
      ...baseInput,
      blockedEvidenceCount: 3,
      insights: [{
        verificationItems: [
          { key: 'intradayAcceptance', label: '分时承接', source: 'stock_minute_cache', status: 'blocked' },
          { key: 'chipConsistency', label: '筹码一致性', source: 'chip_structure_summary', status: 'blocked' },
          { key: 'conceptResonance', label: '题材共振', source: 'concept_members', status: 'blocked' },
        ],
      }],
    })

    expect(state.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'intradayAcceptance', count: 1, actions: ['openStock'] }),
      expect.objectContaining({ key: 'chipConsistency', count: 1, actions: ['syncChips'] }),
      expect.objectContaining({ key: 'conceptResonance', count: 1, actions: ['openDataTools'] }),
    ]))
    expect(state.stats).toEqual(expect.objectContaining({
      uniqueStockCount: 93,
      candidateRecordCount: 185,
      missingInsightCount: 185,
      blockedEvidenceCount: 3,
    }))
  })
})