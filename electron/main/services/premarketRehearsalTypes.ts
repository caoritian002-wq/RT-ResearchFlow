import type {
  EvidenceConfidence,
  ExternalAssetRole,
  ExternalRiskTone,
  PremarketOutcomeInput,
  PremarketOutcomeLabel,
  PremarketOutcomeResult,
} from './premarketScenarioTypes'
import type { ResearchFactToolStatus } from './researchFactToolRegistry'
import type { TrendState } from './trendScoreModel'

export type PremarketScenarioStage = 'asia_open' | 'auction_confirmed'
export type PremarketScenarioStatus = 'ready' | 'partial' | 'blocked'
export type PremarketScenarioKey = 'base' | 'reinforced' | 'risk'
export type PremarketScenarioSupport = 'supported' | 'watching' | 'insufficient'
export type PremarketScenarioRevisionKind = 'scheduled' | 'startup_catch_up' | 'manual_backfill'

export interface PremarketEvidenceReference {
  id: string
  layer: 'market' | 'sector' | 'holding'
  kind: 'external' | 'briefing' | 'sector_flow' | 'trend' | 'chip' | 'announcement' | 'auction'
  label: string
  factDate: string | null
  sourceId: string
}

export interface PremarketMarketEvidence {
  baseFactSnapshotId: string | null
  snapshotStatus: 'ready' | 'partial' | 'blocked' | 'failed' | 'missing'
  snapshotRevision?: number
  snapshotRevisionKind?: import('./premarketScenarioTypes').PremarketFactRevisionKind
  snapshotCapturedAt?: number
  providerId?: string
  sourceStates?: Array<{
    sourceId: string
    status: 'ready' | 'partial' | 'blocked' | 'failed'
    observationCount: number
    expectedCount: number
    errorCode: string | null
  }>
  externalRiskTone: ExternalRiskTone
  confidence: EvidenceConfidence
  eligibleAssetCount: number
  regionCount: number
  medianChangePercent: number | null
  observations: Array<{
    assetId: string
    name: string
    role: ExternalAssetRole
    changePercent: number
    observedAt: number
  }>
  briefings: Array<{
    title: string
    sourceName: string
    publishedAt: number
    publishedDate: string
    publicationTimeStatus?: 'exact' | 'date_only' | 'collected_fallback'
    collectedAt?: number
    impactRating: 'CRITICAL' | 'IMPORTANT' | 'GENERAL'
  }>
  referenceIds: string[]
}

export interface PremarketSectorEvidence {
  key: string
  kind: 'industry' | 'concept'
  name: string
  holdingCodes: string[]
  flowTradeDate: string | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
  weightedChange: number | null
  referenceId: string
}

export interface PremarketHoldingEvidence {
  tsCode: string
  stockName: string
  industry: string | null
  concepts: Array<{ code: string; name: string }>
  trend: {
    status: ResearchFactToolStatus
    tradeDate: string | null
    bars: number
    totalScore: number | null
    validWeight: number
    trendState: TrendState
    stockReturn20d: number | null
    excessReturn20d: number | null
    maxDrawdown20d: number | null
  }
  chip: {
    status: 'ready' | 'partial' | 'missing'
    tradeDate: string | null
    winnerRate: number | null
    trappedPct: number | null
    concentration: number | null
    costDeviationPct: number | null
    loosening1d: number | null
    missingReasons: string[]
  }
  announcements: Array<{
    title: string
    noticeDate: string
    attentionTags: string[]
    displayAt?: number | null
    collectedAt?: number
  }>
  briefings: Array<{
    title: string
    sourceName: string
    publishedDate: string
    impactRating: 'CRITICAL' | 'IMPORTANT' | 'GENERAL'
  }>
  auction: {
    tradeDate: string
    price: number | null
    previousClose: number | null
    gapPercent: number | null
    amount: number | null
    turnoverRate: number | null
    volumeRatio: number | null
    fetchedAt: number
    factAt?: number
  } | null
  referenceIds: string[]
  warnings: string[]
}

export interface PremarketScenarioEvidenceV1 {
  schemaVersion: 1
  tradeDate: string
  stage: PremarketScenarioStage
  cutoffAt: number
  previousTradeDate: string | null
  holdingsCapturedAt: number
  portfolioSnapshotKind: 'current-only'
  market: PremarketMarketEvidence
  sectors: PremarketSectorEvidence[]
  holdings: PremarketHoldingEvidence[]
  auctionMatchedCount: number
  references: PremarketEvidenceReference[]
  warnings: string[]
}

export interface PremarketHoldingScenarioState {
  tsCode: string
  stockName: string
  state: 'aligned' | 'watching' | 'risk' | 'insufficient'
  summary: string
  referenceIds: string[]
}

export interface PremarketScenarioBranch {
  key: PremarketScenarioKey
  label: string
  support: PremarketScenarioSupport
  confidence: EvidenceConfidence
  summary: string
  supportingReferenceIds: string[]
  counterReferenceIds: string[]
  confirmConditions: string[]
  invalidationConditions: string[]
  unknowns: string[]
}

export interface PremarketScenarioResultV1 {
  schemaVersion: 1
  ruleVersion: 'premarket-scenario-v1'
  tradeDate: string
  stage: PremarketScenarioStage
  status: PremarketScenarioStatus
  marketState: 'constructive' | 'mixed' | 'defensive' | 'insufficient'
  confidence: EvidenceConfidence
  headline: string
  branches: PremarketScenarioBranch[]
  holdings: PremarketHoldingScenarioState[]
  warnings: string[]
}

export interface PremarketScenarioVersion {
  id: string
  tradeDate: string
  stage: PremarketScenarioStage
  status: PremarketScenarioStatus
  schemaVersion: 1
  ruleVersion: 'premarket-scenario-v1'
  baseFactSnapshotId: string | null
  parentVersionId: string | null
  previousRevisionId: string | null
  revision: number
  revisionKind: PremarketScenarioRevisionKind
  requestedAt: number
  cutoffAt: number
  factCutoffAt: number
  generatedAt: number
  evidence: PremarketScenarioEvidenceV1
  evidenceSha256: string
  scenario: PremarketScenarioResultV1
  scenarioSha256: string
  warnings: string[]
  createdAt: number
}

export type PremarketScenarioView = Omit<
  PremarketScenarioVersion,
  'evidenceSha256' | 'scenarioSha256'
>

export interface PremarketScenarioRevisionSummary {
  id: string
  revision: number
  revisionKind: PremarketScenarioRevisionKind
  status: PremarketScenarioStatus
  stage: PremarketScenarioStage
  cutoffAt: number
  factCutoffAt: number
  requestedAt: number
  generatedAt: number
  auctionMatchedCount: number
  briefingCount: number
  announcementCount: number
  warningCount: number
}

export interface PremarketScenarioDisplayContext {
  requestedTradeDate: string
  displayTradeDate: string
  isFallback: boolean
  requestedTradingDay: boolean
  fallbackReason: 'non_trading_day' | 'current_version_unavailable' | null
}

export type PremarketScenarioReadResponse =
  | {
      ok: true
      version: PremarketScenarioView
      revisions: PremarketScenarioRevisionSummary[]
      displayContext: PremarketScenarioDisplayContext
      outcome: PremarketOutcomeReadView
      calibration: PremarketCalibrationView
      explanation: PremarketAIExplanationView | null
    }
  | { ok: false; code: 'SCENARIO_NOT_AVAILABLE' | 'SCENARIO_READ_FAILED'; message: string }

export type PremarketPreparationStatus = 'ready' | 'partial' | 'failed'
export type PremarketPreparationScanStatus = 'completed' | 'busy' | 'failed'

export interface PremarketPreparationExternalV1 {
  schemaVersion: 1
  targetTradeDate: string
  capturedAt: number
  status: import('./premarketScenarioTypes').ExternalFactStatus
  observations: import('./premarketScenarioTypes').ExternalAssetObservation[]
  externalRisk: import('./premarketScenarioTypes').ExternalRiskBreadthResult
  source: import('./premarketScenarioTypes').PremarketSourceRecord
}

export interface PremarketPreparationBriefingsV1 {
  schemaVersion: 1
  scanStatus: PremarketPreparationScanStatus
  scanRunId: number | null
  newBriefingsFound: number
  recentCount: number
  sourceCount: number
  latestPublishedAt: number | null
  windowHours: 72
  errorCode: string | null
}

export interface PremarketPreparationSnapshot {
  id: string
  targetTradeDate: string
  status: PremarketPreparationStatus
  schemaVersion: 1
  ruleVersion: 'premarket-preparation-v1'
  capturedAt: number
  external: PremarketPreparationExternalV1
  externalSha256: string
  briefings: PremarketPreparationBriefingsV1
  briefingsSha256: string
  warnings: string[]
  createdAt: number
}

export type PremarketPreparationView = Omit<
  PremarketPreparationSnapshot,
  'externalSha256' | 'briefingsSha256'
>

export interface PremarketPreparationReadResponse {
  ok: true
  targetTradeDate: string | null
  preparation: PremarketPreparationView | null
}

export type PremarketPreparationRefreshResponse =
  | { ok: true; preparation: PremarketPreparationView }
  | {
      ok: false
      code:
        | 'PREMARKET_NETWORK_DISABLED'
        | 'PREMARKET_PREPARATION_TARGET_UNAVAILABLE'
        | 'PREMARKET_PREPARATION_FAILED'
      message: string
    }

export type PremarketOutcomeItemStatus = 'matured' | 'missing'
export type PremarketOutcomeValidationStatus = 'matured' | 'partial' | 'missing'
export type PremarketHoldingState = PremarketHoldingScenarioState['state']

export interface PremarketOutcomeValidationItem {
  tsCode: string
  stockName: string
  premarketState: PremarketHoldingState
  status: PremarketOutcomeItemStatus
  previousTradeDate: string | null
  source: 'daily_close_cache' | 'stock_price_cache' | 'missing'
  input: PremarketOutcomeInput
  outcome: PremarketOutcomeResult
  warnings: string[]
}

export interface PremarketOutcomeValidationPayloadV1 {
  schemaVersion: 1
  ruleVersion: 'premarket-validation-v1'
  tradeDate: string
  scenarioVersionId: string
  scenarioRuleVersion: 'premarket-scenario-v1'
  marketState: PremarketScenarioResultV1['marketState']
  status: PremarketOutcomeValidationStatus
  validatedAt: number
  items: PremarketOutcomeValidationItem[]
  counts: {
    total: number
    matured: number
    missing: number
  }
  coverageRate: number | null
  outcomeCounts: Record<PremarketOutcomeLabel, number>
  warnings: string[]
}

export interface PremarketOutcomeValidationRecord {
  id: string
  tradeDate: string
  scenarioVersionId: string
  status: PremarketOutcomeValidationStatus
  ruleVersion: 'premarket-validation-v1'
  sourceFingerprint: string
  validation: PremarketOutcomeValidationPayloadV1
  validationSha256: string
  createdAt: number
}

export type PremarketOutcomeValidationView = Omit<
  PremarketOutcomeValidationRecord,
  'sourceFingerprint' | 'validationSha256'
>

export type PremarketOutcomeReadView =
  | { state: 'pending'; message: string; validation: null }
  | { state: 'missing'; message: string; validation: null }
  | { state: 'available'; message: string; validation: PremarketOutcomeValidationView }

export interface PremarketCalibrationConfusionRow {
  premarketState: PremarketHoldingState
  outcomeLabel: PremarketOutcomeLabel
  count: number
}

export interface PremarketCalibrationMarketRow {
  marketState: PremarketScenarioResultV1['marketState']
  outcomeLabel: PremarketOutcomeLabel
  count: number
  averageCloseChangePercent: number | null
}

export interface PremarketCalibrationView {
  generatedAt: number
  rangeTradeDays: number
  versionCount: number
  totalSamples: number
  maturedSamples: number
  missingSamples: number
  coverageRate: number | null
  confusion: PremarketCalibrationConfusionRow[]
  marketGroups: PremarketCalibrationMarketRow[]
  probabilityGate: {
    enabled: false
    reason: 'NO_PROBABILITY_MODEL'
    brierScore: null
    reliabilityBins: []
  }
}

export interface PremarketAIExplanationObservation {
  text: string
  referenceIds: string[]
}

export interface PremarketAIExplanationV1 {
  schemaVersion: 1
  summary: string
  observations: PremarketAIExplanationObservation[]
  uncertainties: string[]
  watchItems: string[]
}

export interface PremarketAIExplanationView {
  id: string
  scenarioVersionId: string
  outcomeValidationId: string | null
  provider: string
  model: string
  generatedAt: number
  explanation: PremarketAIExplanationV1
}

export type PremarketExplainResponse =
  | { ok: true; explanation: PremarketAIExplanationView; reused: boolean }
  | {
      ok: false
      code:
        | 'SCENARIO_NOT_AVAILABLE'
        | 'AI_NOT_CONFIGURED'
        | 'AI_EXPLANATION_INVALID'
        | 'AI_EXPLANATION_POLICY_VIOLATION'
        | 'AI_EXPLANATION_FAILED'
      message: string
    }

export type PremarketScenarioRetryPhase =
  | 'starting'
  | 'external'
  | 'auction'
  | 'briefings'
  | 'announcements'
  | 'generating'
  | 'completed'

export interface PremarketScenarioRetryProgress {
  phase: PremarketScenarioRetryPhase
  message: string
  current: number | null
  total: number | null
}

export interface PremarketScenarioRetrySourceResult {
  source: 'external' | 'auction' | 'briefings' | 'announcements'
  status: 'completed' | 'partial' | 'unavailable' | 'failed'
  itemCount: number
  errorCode: string | null
}

export type PremarketScenarioRetryResponse =
  | {
      ok: true
      tradeDate: string
      revision: PremarketScenarioRevisionSummary
      sources: PremarketScenarioRetrySourceResult[]
    }
  | {
      ok: false
      code:
        | 'PREMARKET_RETRY_BEFORE_CONFIRMATION'
        | 'PREMARKET_RETRY_TARGET_UNAVAILABLE'
        | 'PREMARKET_RETRY_FAILED'
      message: string
    }
