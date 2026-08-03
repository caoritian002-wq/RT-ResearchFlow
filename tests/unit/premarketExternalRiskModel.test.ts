import { describe, expect, it } from 'vitest'
import { evaluateExternalRiskBreadth } from '../../electron/main/services/premarketExternalRiskModel'
import type { ExternalAssetObservation, ExternalAssetRegion } from '../../electron/main/services/premarketScenarioTypes'

function observation(assetId: string, region: ExternalAssetRegion, changePercent: number): ExternalAssetObservation {
  return {
    assetId,
    providerSecurityId: assetId,
    name: assetId,
    region,
    role: 'risk_asset',
    latest: 100,
    open: 99,
    previousClose: 98,
    changePercent,
    observedAt: 1,
  }
}

describe('premarketExternalRiskModel', () => {
  it('跨地区广泛上涨只形成外部risk-on证据，不声称A股方向', () => {
    const result = evaluateExternalRiskBreadth([
      observation('us.dow', 'us', 1.2),
      observation('us.nasdaq', 'us', 2.8),
      observation('us.sp500', 'us', 1.6),
      observation('asia.nikkei225', 'asia', 4.0),
      observation('asia.kospi', 'asia', -0.1),
    ])

    expect(result).toMatchObject({
      tone: 'broad_risk_on',
      confidence: 'high',
      positiveCount: 4,
      negativeCount: 1,
      medianChangePercent: 1.6,
    })
    expect(result.warnings).toContain('EXTERNAL_EVIDENCE_NOT_A_SHARE_DIRECTION')
  })

  it('广泛下跌、分化和单地区覆盖分别输出稳定状态', () => {
    const riskOff = evaluateExternalRiskBreadth([
      observation('a', 'us', -1),
      observation('b', 'us', -2),
      observation('c', 'asia', -0.8),
      observation('d', 'asia', 0.1),
    ])
    const mixed = evaluateExternalRiskBreadth([
      observation('a', 'us', 1),
      observation('b', 'us', -1),
      observation('c', 'asia', 0.2),
      observation('d', 'asia', -0.2),
    ])
    const insufficient = evaluateExternalRiskBreadth([
      observation('a', 'us', 2),
      observation('b', 'us', 1.5),
      observation('c', 'us', 1),
    ])

    expect(riskOff.tone).toBe('broad_risk_off')
    expect(mixed.tone).toBe('mixed')
    expect(insufficient.tone).toBe('insufficient')
    expect(insufficient.confidence).toBe('low')
  })
})
