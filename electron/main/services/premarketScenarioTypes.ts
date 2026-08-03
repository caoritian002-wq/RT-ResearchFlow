export type PremarketStage = 'overnight' | 'asia_open' | 'auction_confirmed' | 'after_close'
export type PremarketSnapshotStatus = 'ready' | 'partial' | 'blocked' | 'failed'
export type PremarketFactRevisionKind = 'scheduled' | 'startup_catch_up' | 'manual_backfill'
export type ExternalFactStatus = 'ready' | 'partial' | 'blocked' | 'failed'

export type ExternalAssetRegion = 'us' | 'asia' | 'china_offshore' | 'global'
export type ExternalAssetRole =
  | 'risk_asset'
  | 'china_proxy'
  | 'currency'
  | 'rates'
  | 'volatility_proxy'
  | 'commodity'

export interface ExternalAssetObservation {
  assetId: string
  providerSecurityId: string
  name: string
  region: ExternalAssetRegion
  role: ExternalAssetRole
  latest: number
  open: number | null
  previousClose: number
  changePercent: number
  observedAt: number
}

export interface PremarketSourceRecord {
  sourceId: string
  status: ExternalFactStatus
  attemptedAt: number
  completedAt: number
  observationCount: number
  expectedCount: number
  errorCode: string | null
}

export type ExternalRiskTone = 'broad_risk_on' | 'broad_risk_off' | 'mixed' | 'insufficient'
export type EvidenceConfidence = 'high' | 'medium' | 'low'

export interface ExternalRiskBreadthResult {
  ruleVersion: 'external-risk-breadth-v1'
  tone: ExternalRiskTone
  confidence: EvidenceConfidence
  eligibleAssetCount: number
  regionCount: number
  positiveCount: number
  negativeCount: number
  medianChangePercent: number | null
  supportingAssetIds: string[]
  counterAssetIds: string[]
  warnings: string[]
}

export interface PremarketFactPayloadV1 {
  schemaVersion: 1
  tradeDate: string
  stage: PremarketStage
  cutoffAt: number
  observations: ExternalAssetObservation[]
  externalRisk: ExternalRiskBreadthResult
}

export interface PremarketFactSnapshot {
  id: string
  tradeDate: string
  stage: PremarketStage
  status: PremarketSnapshotStatus
  schemaVersion: 1
  ruleVersion: string
  previousRevisionId: string | null
  revision: number
  revisionKind: PremarketFactRevisionKind
  requestedAt: number
  cutoffAt: number
  capturedAt: number
  providerId: string
  facts: PremarketFactPayloadV1
  factsSha256: string
  sources: PremarketSourceRecord[]
  warnings: string[]
  createdAt: number
}

export type PremarketOutcomeLabel =
  | 'gap_up_fade'
  | 'gap_up_hold'
  | 'low_or_flat_rebound'
  | 'weak_all_day'
  | 'mixed'
  | 'insufficient'

export interface PremarketOutcomeInput {
  previousClose: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
}

export interface PremarketOutcomeResult {
  ruleVersion: 'premarket-outcome-v1'
  label: PremarketOutcomeLabel
  gapPercent: number | null
  highChangePercent: number | null
  closeChangePercent: number | null
  highGivebackRatio: number | null
  warnings: string[]
}
