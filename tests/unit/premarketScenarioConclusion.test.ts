import { describe, expect, it } from 'vitest'
import type { PremarketScenarioView } from '../../electron/main/services/premarketRehearsalTypes'
import { buildPremarketUserConclusion } from '../../src/components/DecisionCenter/premarketScenarioConclusion'

function version(overrides: {
  status?: PremarketScenarioView['status']
  marketState?: PremarketScenarioView['scenario']['marketState']
  holdingState?: PremarketScenarioView['scenario']['holdings'][number]['state']
} = {}): PremarketScenarioView {
  const status = overrides.status ?? 'partial'
  const marketState = overrides.marketState ?? 'constructive'
  const holdingState = overrides.holdingState ?? 'risk'
  return {
    id: '00000000-0000-4000-8000-000000000001',
    tradeDate: '20260803',
    stage: 'auction_confirmed',
    status,
    schemaVersion: 1,
    ruleVersion: 'premarket-scenario-v1',
    baseFactSnapshotId: '00000000-0000-4000-8000-000000000002',
    parentVersionId: null,
    previousRevisionId: null,
    revision: 3,
    revisionKind: 'manual_backfill',
    requestedAt: 1,
    cutoffAt: 2,
    factCutoffAt: 3,
    generatedAt: 4,
    evidence: {
      schemaVersion: 1,
      tradeDate: '20260803',
      stage: 'auction_confirmed',
      cutoffAt: 3,
      previousTradeDate: '20260731',
      holdingsCapturedAt: 4,
      portfolioSnapshotKind: 'current-only',
      market: {
        baseFactSnapshotId: '00000000-0000-4000-8000-000000000002',
        snapshotStatus: 'ready',
        externalRiskTone: marketState === 'constructive' ? 'broad_risk_on' : marketState === 'defensive' ? 'broad_risk_off' : marketState === 'mixed' ? 'mixed' : 'insufficient',
        confidence: 'medium',
        eligibleAssetCount: 6,
        regionCount: 2,
        medianChangePercent: 0.5,
        observations: [],
        briefings: [],
        referenceIds: ['PM-MARKET-EXTERNAL'],
      },
      sectors: [],
      holdings: [],
      auctionMatchedCount: 1,
      references: [],
      warnings: [],
    },
    evidenceSha256: 'a'.repeat(64),
    scenario: {
      schemaVersion: 1,
      ruleVersion: 'premarket-scenario-v1',
      tradeDate: '20260803',
      stage: 'auction_confirmed',
      status,
      marketState,
      confidence: 'medium',
      headline: '旧版技术标题',
      branches: [{
        key: 'risk',
        label: '风险情景',
        support: 'supported',
        confidence: 'medium',
        summary: '反向证据待确认',
        supportingReferenceIds: [],
        counterReferenceIds: [],
        confirmConditions: ['亨通光电开盘后继续弱于竞价参考价'],
        invalidationConditions: ['亨通光电收复竞价参考价且行业同步修复'],
        unknowns: [],
      }],
      holdings: [{
        tsCode: '600487.SH',
        stockName: '亨通光电',
        state: holdingState,
        summary: '趋势、筹码或竞价存在反向证据',
        referenceIds: [],
      }],
      warnings: [],
    },
    scenarioSha256: 'b'.repeat(64),
    warnings: [],
    createdAt: 4,
  }
}

describe('buildPremarketUserConclusion', () => {
  it('把外盘偏暖与持仓风险冲突翻译成明确的谨慎结论', () => {
    const result = buildPremarketUserConclusion(version())

    expect(result.stance).toBe('外暖内弱 · 偏谨慎')
    expect(result.headline).toContain('亨通光电自身结构仍偏弱')
    expect(result.summary).toContain('防范冲高后承接不足')
    expect(result.confirmation).toContain('继续弱于竞价参考价')
    expect(result.invalidation).toContain('收复竞价参考价')
  })

  it('关键证据受阻时给出明确的不判断结论而不是含糊状态', () => {
    const result = buildPremarketUserConclusion(version({
      status: 'blocked',
      marketState: 'insufficient',
      holdingState: 'aligned',
    }))

    expect(result.stance).toBe('暂不判断')
    expect(result.headline).toContain('当前不能判断方向')
    expect(result.summary).toContain('不能据此判断高开、低开或日内强弱')
  })
})
