import { describe, expect, it } from 'vitest'
import { buildPremarketScenarioResult } from '../../electron/main/services/premarketScenarioModel'
import type {
  PremarketHoldingEvidence,
  PremarketScenarioEvidenceV1,
} from '../../electron/main/services/premarketRehearsalTypes'

function holding(overrides: Partial<PremarketHoldingEvidence> = {}): PremarketHoldingEvidence {
  return {
    tsCode: '600487.SH',
    stockName: '亨通光电',
    industry: '通信设备',
    concepts: [{ code: 'C1', name: '光通信' }],
    trend: {
      status: 'ready',
      tradeDate: '20260730',
      bars: 120,
      totalScore: 75,
      validWeight: 1,
      trendState: 'strong',
      stockReturn20d: 8,
      excessReturn20d: 3,
      maxDrawdown20d: -5,
    },
    chip: {
      status: 'ready',
      tradeDate: '20260730',
      winnerRate: 55,
      trappedPct: 30,
      concentration: 12,
      costDeviationPct: 1,
      loosening1d: 0.5,
      missingReasons: [],
    },
    announcements: [],
    briefings: [],
    auction: null,
    referenceIds: ['PM-HOLDING-001-TREND', 'PM-HOLDING-001-CHIP'],
    warnings: [],
    ...overrides,
  }
}

function evidence(overrides: Partial<PremarketScenarioEvidenceV1> = {}): PremarketScenarioEvidenceV1 {
  return {
    schemaVersion: 1,
    tradeDate: '20260731',
    stage: 'asia_open',
    cutoffAt: Date.parse('2026-07-31T08:45:00+08:00'),
    previousTradeDate: '20260730',
    holdingsCapturedAt: Date.parse('2026-07-31T08:45:10+08:00'),
    portfolioSnapshotKind: 'current-only',
    market: {
      baseFactSnapshotId: '00000000-0000-4000-8000-000000000001',
      snapshotStatus: 'ready',
      externalRiskTone: 'broad_risk_on',
      confidence: 'high',
      eligibleAssetCount: 4,
      regionCount: 2,
      medianChangePercent: 1.2,
      observations: [],
      briefings: [],
      referenceIds: ['PM-MARKET-EXTERNAL'],
    },
    sectors: [{
      key: 'industry:通信设备',
      kind: 'industry',
      name: '通信设备',
      holdingCodes: ['600487.SH'],
      flowTradeDate: '20260730',
      mainNetInflow: 100_000_000,
      mainNetInflowRate: 2,
      weightedChange: 1,
      referenceId: 'PM-SECTOR-001',
    }],
    holdings: [holding()],
    auctionMatchedCount: 0,
    references: [],
    warnings: [],
    ...overrides,
  }
}

describe('premarketScenarioModel', () => {
  it('完整08:45证据形成三情景但不输出概率或交易动作', () => {
    const result = buildPremarketScenarioResult(evidence())
    expect(result.status).toBe('ready')
    expect(result.marketState).toBe('constructive')
    expect(result.branches.map((item) => item.key)).toEqual(['base', 'reinforced', 'risk'])
    expect(result.branches[1].support).toBe('supported')
    expect(JSON.stringify(result)).not.toMatch(/概率|买入|卖出|目标价|仓位/)
  })

  it('局部筹码缺失降级为partial而不是填充或阻断', () => {
    const incomplete = holding({
      chip: { ...holding().chip, status: 'missing', tradeDate: null, winnerRate: null },
      warnings: ['CHIP_INCOMPLETE'],
    })
    const result = buildPremarketScenarioResult(evidence({
      holdings: [incomplete],
      warnings: ['600487.SH:CHIP_INCOMPLETE'],
    }))
    expect(result.status).toBe('partial')
    expect(result.holdings[0].state).toBe('aligned')
  })

  it('09:25无任何持仓竞价匹配时稳定阻断', () => {
    const result = buildPremarketScenarioResult(evidence({
      stage: 'auction_confirmed',
      cutoffAt: Date.parse('2026-07-31T09:25:00+08:00'),
      auctionMatchedCount: 0,
    }))
    expect(result.status).toBe('blocked')
    expect(result.confidence).toBe('low')
  })

  it('趋势破坏与负竞价只形成风险验证状态，不形成交易指令', () => {
    const risky = holding({
      trend: { ...holding().trend, trendState: 'broken', totalScore: 25 },
      auction: {
        tradeDate: '20260731',
        price: 16.2,
        previousClose: 16.8,
        gapPercent: -3.57,
        amount: 30_000_000,
        turnoverRate: 0.8,
        volumeRatio: 1.5,
        fetchedAt: Date.parse('2026-07-31T09:25:10+08:00'),
      },
    })
    const result = buildPremarketScenarioResult(evidence({
      stage: 'auction_confirmed',
      cutoffAt: Date.parse('2026-07-31T09:25:00+08:00'),
      holdings: [risky],
      auctionMatchedCount: 1,
    }))
    expect(result.status).toBe('ready')
    expect(result.holdings[0].state).toBe('risk')
    expect(result.branches.find((item) => item.key === 'risk')?.support).toBe('supported')
    expect(JSON.stringify(result)).not.toMatch(/止损|减仓|卖出/)
  })
})
