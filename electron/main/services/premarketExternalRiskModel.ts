import type {
  ExternalAssetObservation,
  ExternalRiskBreadthResult,
} from './premarketScenarioTypes'

export const EXTERNAL_RISK_RULE_VERSION = 'external-risk-breadth-v1' as const

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

export function evaluateExternalRiskBreadth(
  observations: readonly ExternalAssetObservation[],
): ExternalRiskBreadthResult {
  const eligible = observations
    .filter((item) => item.role === 'risk_asset' && Number.isFinite(item.changePercent))
    .sort((a, b) => a.assetId.localeCompare(b.assetId))
  const regions = new Set(eligible.map((item) => item.region))
  const positive = eligible.filter((item) => item.changePercent > 0)
  const negative = eligible.filter((item) => item.changePercent < 0)
  const medianChangePercent = median(eligible.map((item) => item.changePercent))
  const hasCoverage = eligible.length >= 3 && regions.size >= 2
  const positiveShare = eligible.length === 0 ? 0 : positive.length / eligible.length
  const negativeShare = eligible.length === 0 ? 0 : negative.length / eligible.length

  let tone: ExternalRiskBreadthResult['tone'] = 'insufficient'
  if (hasCoverage && positiveShare >= 0.75 && (medianChangePercent ?? 0) >= 0.5) {
    tone = 'broad_risk_on'
  } else if (hasCoverage && negativeShare >= 0.75 && (medianChangePercent ?? 0) <= -0.5) {
    tone = 'broad_risk_off'
  } else if (hasCoverage) {
    tone = 'mixed'
  }

  const warnings = ['EXTERNAL_EVIDENCE_NOT_A_SHARE_DIRECTION']
  if (!hasCoverage) warnings.push('EXTERNAL_RISK_COVERAGE_INSUFFICIENT')

  return {
    ruleVersion: EXTERNAL_RISK_RULE_VERSION,
    tone,
    confidence: eligible.length >= 5 && regions.size >= 2 ? 'high' : hasCoverage ? 'medium' : 'low',
    eligibleAssetCount: eligible.length,
    regionCount: regions.size,
    positiveCount: positive.length,
    negativeCount: negative.length,
    medianChangePercent,
    supportingAssetIds: (tone === 'broad_risk_off' ? negative : positive).map((item) => item.assetId),
    counterAssetIds: (tone === 'broad_risk_off' ? positive : negative).map((item) => item.assetId),
    warnings,
  }
}
