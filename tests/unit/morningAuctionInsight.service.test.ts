import { describe, expect, it } from 'vitest'
import { buildMorningAuctionInsight } from '../../electron/main/services/morningAuctionInsightService'
import {
  filterMorningAuctionInsightsBySchema,
  getExistingVerificationJsonForSchema,
  mergeManualVerificationItems,
} from '../../electron/main/database/morningAuctionInsightRepository'
import type { ChipStructureSummary, MorningAuctionInsightRow } from '../../electron/main/database/types'

function createStock(overrides: Record<string, unknown> = {}) {
  return {
    tsCode: '600000.SH',
    stockCode: '600000',
    stockName: '测试股份',
    auctionPrice: 10.5,
    prevClose: 10,
    pctChg: 5,
    auctionAmount: 2000,
    auctionTurnover: 1,
    volumeRatio: 2,
    currentPrice: 10.8,
    currentPctChg: 8,
    currentAmount: 300000000,
    pctChg3d: 8,
    pctChg5d: 12,
    conceptNames: ['测试题材'],
    ...overrides,
  }
}

function createCandidate(stock = createStock()) {
  return {
    stock,
    poolKey: 'firstBoard',
    poolLabel: '首板续强',
    entryReason: '测试入选原因。',
    backtestPool: 'firstBoard' as const,
  }
}

function createChipSummary(overrides: Partial<ChipStructureSummary> = {}): ChipStructureSummary {
  return {
    tsCode: '600000.SH',
    stockName: '测试股份',
    tradeDate: '20260710',
    dateRelation: 'same_day',
    winnerRate: 68,
    thickProfitPct: 24,
    thinProfitPct: 18,
    trappedPct: 32,
    deepLowPct: 10,
    concentration: 62,
    costDeviationPct: 4,
    bottomPct: 30,
    bottomAvgCost: 9.8,
    loosening1d: 15,
    loosening3d: 8,
    loosening5d: 5,
    pctChg: 3,
    turnoverRate: 4,
    primaryChange: null,
    freshnessStatus: 'current',
    completenessStatus: 'complete',
    consistencyStatus: 'matched',
    missingReasons: [],
    updatedAt: 1000,
    ...overrides,
  }
}

function createInsightRow(schemaVersion: number): MorningAuctionInsightRow {
  return {
    id: schemaVersion,
    tradeDate: '20260710',
    tsCode: '600000.SH',
    stockName: '测试股份',
    poolKey: 'firstBoard',
    schemaVersion,
    score: 60,
    scoreBreakdownJson: '[]',
    entryReasonsJson: '[]',
    verificationItemsJson: '[{"key":"chipConsistency"}]',
    riskFlagsJson: '[]',
    intradayPreviewJson: null,
    backtestSummaryJson: null,
    chipStatus: 'available',
    status: 'complete',
    errorMessage: null,
    generatedAt: 1000,
    updatedAt: 1000,
  }
}

describe('morningAuctionInsightService', () => {
  it('极端输入下分数仍限制在 0 到 100', () => {
    const strong = buildMorningAuctionInsight(
      '20260710',
      createCandidate(createStock({ auctionAmount: 999999, auctionTurnover: 99, pctChg: 99, currentPctChg: 99 })),
      null,
      [],
      [],
    )
    const risky = buildMorningAuctionInsight(
      '20260710',
      createCandidate(createStock({ stockName: 'ST测试', pctChg: 99, auctionTurnover: 0, pctChg5d: 99, currentPctChg: -99 })),
      null,
      [],
      [],
    )

    expect(strong.score).toBeGreaterThanOrEqual(0)
    expect(strong.score).toBeLessThanOrEqual(100)
    expect(risky.score).toBeGreaterThanOrEqual(0)
    expect(risky.score).toBeLessThanOrEqual(100)
    expect(risky.scoreBreakdown.find(item => item.key === 'risk')?.contribution).toBeLessThan(0)
  })

  it('缺失本地证据时生成 partial 并标记受阻项', () => {
    const insight = buildMorningAuctionInsight(
      '20260710',
      createCandidate(createStock({ pctChg3d: null, pctChg5d: null, conceptNames: [] })),
      null,
      [],
      [],
      1000,
    )

    expect(insight.status).toBe('partial')
    expect(insight.chipStatus).toBe('missing')
    expect(insight.intradayPreview).toBeNull()
    expect(insight.backtestSummary).toBeNull()
    expect(insight.verificationItems.filter(item => item.status === 'blocked').map(item => item.key)).toEqual([
      'intradayAcceptance',
      'conceptResonance',
      'chipConsistency',
      'priceHistory',
      'historicalPerformance',
    ])
  })

  it('同日筹码结构摘要参与当日评分并进入待复核', () => {
    const insight = buildMorningAuctionInsight(
      '20260710',
      createCandidate(),
      createChipSummary(),
      [],
      [],
      1000,
    )

    expect(insight.chipStatus).toBe('available')
    expect(insight.chipEvidence?.dateRelation).toBe('same_day')
    expect(insight.scoreBreakdown.find(item => item.key === 'chip')?.contribution).toBe(10)
    expect(insight.verificationItems.find(item => item.key === 'chipConsistency')).toMatchObject({
      status: 'pending',
      source: 'chip_structure_summary',
    })
    expect(insight.riskFlags.some(item => item.key === 'chipLoose')).toBe(true)
  })

  it('主炒题材依据参与题材评分并进入结构化验证快照', () => {
    const themeAttribution = {
      state: 'direct' as const,
      confidence: 'high' as const,
      primary: {
        name: '算力', score: 92, direct: true, peerCount: 3, activePeerCount: 2,
        averageAuctionPct: 4.6, totalAuctionAmount: 6200, peers: [], basis: ['直接题材记录'],
      },
      resonance: [],
      staticThemes: ['融资融券'],
      allThemes: ['算力', '融资融券'],
      directReason: '算力订单预期增强',
      sourceTradeDate: '20260709',
      summary: '早盘主驱动优先指向“算力”。',
    }
    const insight = buildMorningAuctionInsight(
      '20260710',
      createCandidate(createStock({ themeAttribution })),
      null,
      [],
      [],
      1000,
    )

    expect(insight.scoreBreakdown.find(item => item.key === 'concept')?.contribution).toBe(10)
    expect(insight.themeAttribution?.primary?.name).toBe('算力')
    expect(insight.verificationItems.find(item => item.key === 'conceptResonance')).toMatchObject({
      source: 'kpl_concept_daily+concept_members+stk_auction',
      themeAttribution: { state: 'direct', confidence: 'high' },
    })
  })

  it('同日空筹码摘要不参与当日评分', () => {
    const insight = buildMorningAuctionInsight(
      '20260710',
      createCandidate(),
      createChipSummary({
        winnerRate: null,
        thickProfitPct: null,
        thinProfitPct: null,
        trappedPct: null,
        deepLowPct: null,
        concentration: null,
        costDeviationPct: null,
        bottomPct: null,
        bottomAvgCost: null,
        loosening1d: null,
        loosening3d: null,
        loosening5d: null,
        pctChg: null,
        turnoverRate: null,
      }),
      [],
      [],
      1000,
    )

    expect(insight.chipStatus).toBe('insufficient')
    expect(insight.scoreBreakdown.find(item => item.key === 'chip')?.contribution).toBe(0)
    expect(insight.verificationItems.find(item => item.key === 'chipConsistency')?.status).toBe('blocked')
  })

  it('历史筹码结构摘要只作参考且不参与当日评分', () => {
    const insight = buildMorningAuctionInsight(
      '20260710',
      createCandidate(),
      createChipSummary({ tradeDate: '20260709', dateRelation: 'history' }),
      [],
      [],
      1000,
    )

    expect(insight.chipStatus).toBe('insufficient')
    expect(insight.chipEvidence).toMatchObject({ tradeDate: '20260709', dateRelation: 'history' })
    expect(insight.scoreBreakdown.find(item => item.key === 'chip')).toMatchObject({
      contribution: 0,
    })
    expect(insight.verificationItems.find(item => item.key === 'chipConsistency')).toMatchObject({
      status: 'blocked',
      chipEvidence: { tradeDate: '20260709', dateRelation: 'history' },
    })
    expect(insight.riskFlags.some(item => item.key === 'chipLoose')).toBe(false)
  })

  it('重新生成时保留用户人工确认状态', () => {
    const existingItems = JSON.stringify([{
      key: 'conceptResonance',
      label: '题材共振',
      status: 'checked',
      source: 'concept_members',
      reason: '用户已核对题材共振。',
      updatedAt: 1000,
      checkedByUser: true,
    }])
    const regeneratedItems = JSON.stringify([{
      key: 'conceptResonance',
      label: '题材共振',
      status: 'pending',
      source: 'concept_members',
      reason: '自动证据已更新。',
      updatedAt: 2000,
    }])
    const savedItems = JSON.parse(mergeManualVerificationItems(regeneratedItems, existingItems)) as Array<{
      status: string
      reason: string
      checkedByUser?: boolean
    }>
    expect(savedItems[0]).toMatchObject({
      status: 'checked',
      reason: '用户已核对题材共振。',
      checkedByUser: true,
    })
  })

  it('自动证据降级为受阻时不保留旧人工通过状态', () => {
    const existingItems = JSON.stringify([{
      key: 'chipConsistency',
      label: '筹码一致性',
      status: 'checked',
      source: 'chip_structure_summary',
      reason: '用户已确认。',
      updatedAt: 1000,
      checkedByUser: true,
    }])
    const blockedItems = JSON.stringify([{
      key: 'chipConsistency',
      label: '筹码一致性',
      status: 'blocked',
      source: 'chip_structure_summary',
      reason: '当前没有同日有效筹码证据。',
      updatedAt: 2000,
    }])

    const savedItems = JSON.parse(mergeManualVerificationItems(blockedItems, existingItems)) as Array<{
      status: string
      checkedByUser?: boolean
    }>
    expect(savedItems[0]).toMatchObject({ status: 'blocked' })
    expect(savedItems[0].checkedByUser).toBeUndefined()
  })

  it('列表只保留当前 schema 且跨 schema 不继承人工验证', () => {
    const oldRow = createInsightRow(1)
    const currentRow = createInsightRow(2)

    expect(filterMorningAuctionInsightsBySchema([oldRow, currentRow], 2)).toEqual([currentRow])
    expect(getExistingVerificationJsonForSchema(oldRow, 2)).toBeNull()
    expect(getExistingVerificationJsonForSchema(currentRow, 2)).toBe(currentRow.verificationItemsJson)
  })
})
