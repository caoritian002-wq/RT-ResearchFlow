import type { ResearchAuditTraceView } from '../shared/ResearchAuditTrace'

export type ResearchProjectStatus = 'draft' | 'active' | 'review_due' | 'archived'
export type ResearchPurpose = 'learning' | 'strategy' | 'investment'
export type ResearchDepth = 'quick' | 'standard' | 'deep'
export type ResearchStatementKind = 'fact' | 'estimate' | 'hypothesis'
export type HypothesisStatus = 'open' | 'supported' | 'weakened' | 'refuted' | 'reopened'

export interface ResearchProject {
  id: string
  title: string
  industry_name: string
  product_scope: string
  region_scope: string
  time_scope: string
  purpose: ResearchPurpose
  depth: ResearchDepth
  status: ResearchProjectStatus
  data_as_of: string | null
  source_type: string
  skill_rule_version: string | null
  graph_updated_at: number
  stop_condition: string | null
  next_review_at: number | null
  updated_at: number
}

export interface ResearchNode {
  id: string
  type: string
  name: string
  stage: string | null
  statement_kind: ResearchStatementKind
  status: string | null
  metrics_json: string
  evidence_ids_json: string
  last_updated: string | null
}

export interface ResearchEdge {
  id: string
  source_node_id: string
  target_node_id: string
  relation: string
  statement_kind: ResearchStatementKind
  strength: number | null
  bottleneck: number
  exposure_pct: number | null
  evidence_ids_json: string
  last_updated: string | null
}

export interface ResearchGraph {
  projectId: string
  graphUpdatedAt: number
  nodes: ResearchNode[]
  edges: ResearchEdge[]
  mermaid: string
  nodeNames: Record<string, string>
}

export interface ResearchEvidence {
  id: string
  title: string
  source_type: string
  source_name: string
  source_url: string | null
  source_ref: string | null
  fact_date: string | null
  statement_kind: ResearchStatementKind
  direction: 'support' | 'weaken' | 'refute' | 'neutral'
  reliability: 'primary' | 'secondary' | 'tertiary' | 'unknown'
  primary_source_confirmed: number
  conflict_note: string | null
  excerpt: string | null
  updated_at: number
}

export interface ResearchHypothesisEvent {
  id: string
  from_status: HypothesisStatus | null
  to_status: HypothesisStatus
  reason: string
  created_at: number
}

export interface ResearchHypothesis {
  id: string
  statement: string
  importance: number
  status: HypothesisStatus
  cheapest_disproof: string
  verification_metric: string | null
  threshold: string | null
  due_at: number | null
  evidence_ids_json: string
  events: ResearchHypothesisEvent[]
  updated_at: number
}

export interface ResearchReportFinding {
  text: string
  candidateIds: string[]
}

export type ResearchReportFindingInput = string | ResearchReportFinding

export interface ResearchReportPartitions {
  supportedFindings?: ResearchReportFindingInput[]
  modelOnlyFindings?: string[]
  pendingSources?: string[]
  evidenceInsufficient?: boolean
}

export interface ResearchGeneratedReportDocument {
  title: string | null
  summary: string | null
  markdown: string | null
  missingSections: string[]
  conflicts: string[]
  researchTrace?: ResearchAuditTraceView | null
}

export interface ResearchReport {
  summary: string
  dataAsOf: string | null
  missingSections: string[]
  conflicts: Array<{ evidenceId: string; note: string }>
  mermaid: string
  facts: ResearchEvidence[]
  estimates: ResearchEvidence[]
  hypotheses: ResearchHypothesis[]
  reportKind?: 'full_markdown' | 'legacy_projection'
  reportDocument?: ResearchGeneratedReportDocument | null
  reportPartitions?: ResearchReportPartitions | null
}

export type ResearchView = 'overview' | 'changes' | 'review' | 'companies' | 'graph' | 'evidence' | 'hypotheses' | 'report' | 'decision'
export type ResearchDecisionView = 'current' | 'review' | 'monitoring' | 'history'
export type ResearchValuationMethod = 'pe' | 'pb_roe' | 'ev_ebitda' | 'dcf' | 'sotp' | 'nav'
export type ResearchDecisionAction = 'continue_research' | 'wait_financial_validation' | 'wait_price' | 'monitor' | 'exclude'

export interface ResearchValuationInput {
  value: number | null
  unit: string
  sourceKind: 'fact' | 'assumption'
  factId?: string | null
  note?: string | null
}

export interface ResearchWorkItem {
  id: string
  versionId: string
  version: number
  question: string
  effort: 'quick_pass' | 'standard_validation' | 'deep_research'
  conclusionSensitivity: 'low' | 'medium' | 'high'
  evidenceUncertainty: 'low' | 'medium' | 'high'
  changeVelocity: 'low' | 'medium' | 'high'
  stopReason: string | null
  nextTriggerMetric: string | null
  affectedObjectIds: string[]
  status: 'open' | 'blocked' | 'completed' | 'stopped'
  createdAt: number
}

export interface ResearchScenarioSet {
  id: string
  versionId: string
  projectId: string
  companyId: string | null
  version: number
  previousVersionId: string | null
  dataAsOf: string
  valuationDate: string | null
  valuationMethod: ResearchValuationMethod | null
  methodologyVersion: string | null
  createdAt: number
  scenarios: Array<{
    id: string
    name: 'bear' | 'base' | 'bull'
    weightPct: number | null
    assumptions: Record<string, number | string | null>
    valuationInputs: Record<string, ResearchValuationInput>
    factIds: string[]
    dataStatus: 'ok' | 'corrupt'
  }>
}

export interface ResearchDecisionItem {
  id: string
  decisionId: string
  projectId: string
  companyId: string | null
  previousEventId: string | null
  eventType: 'created' | 'maintained' | 'upgraded' | 'downgraded' | 'invalidated' | 'closed'
  action: ResearchDecisionAction
  rationale: string
  dataAsOf: string
  valuationDate: string | null
  validUntil: number
  invalidationCondition: string
  scenarioSetVersionId: string | null
  workItemVersionIds: string[]
  factIds: string[]
  evidenceIds: string[]
  hypothesisIds: string[]
  sourceTriggerEvaluationId: string | null
  marketSnapshotId: string | null
  valuationSnapshotId: string | null
  createdAt: number
}

export interface ResearchMonitoringItem {
  id: string
  versionId: string
  version: number
  name: string
  valueKind: 'number' | 'text' | 'event'
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'event_driven'
  sourceName: string
  sourceRef: string | null
  unit: string | null
  timingType: 'leading' | 'coincident' | 'lagging' | 'unknown'
  staleAfterMs: number
  nextReviewAt: number | null
  status: 'active' | 'paused' | 'closed'
  latestObservation: null | {
    id: string
    value: number | string
    unit: string | null
    observedAt: number
    availableAt: number
    dataAsOf: string
  }
}

export interface ResearchDecisionTrigger {
  id: string
  versionId: string
  version: number
  decisionId: string
  monitoringItemId: string
  metricName: string
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'changed'
  threshold: number | string | null
  validationWindowMs: number
  actionIfNotTriggered: ResearchDecisionAction
  proposedActionIfTriggered: ResearchDecisionAction
  expiresAt: number | null
  status: 'active' | 'disabled'
}

export interface ResearchReviewQueueItem {
  id: string
  kind: string
  subjectKind: string
  subjectId: string
  reason: string
  dueAt: number | null
  persisted: boolean
  createdAt?: number
  sourceEventId?: string | null
  payload?: Record<string, unknown>
}

export interface ResearchMarketContext {
  projectId?: string
  companyId?: string
  securityId?: string
  tsCode?: string
  requestedValuationDate?: string
  marketDate: string | null
  rawClose: number | null
  benchmarkCode?: string | null
  benchmarkName?: string | null
  status: 'ok' | 'degraded' | 'blocked'
  reasons: Array<{ code: string; message: string; scope?: string }>
  windows: Array<{
    days: number
    status: 'ok' | 'blocked'
    startDate: string | null
    endDate: string | null
    stockReturnPct: number | null
    benchmarkReturnPct: number | null
    excessReturnPct: number | null
    reason: string | null
  }>
  series: Array<{ tradeDate: string; stock: number | null; benchmark: number | null }>
  events: Array<{
    id: string
    kind: string
    label: string
    availableDate: string
    anchorDate: string | null
    pre5Pct: number | null
    post5Pct: number | null
    benchmarkPost5Pct: number | null
    excessPost5Pct: number | null
  }>
  valuationDaily?: {
    tradeDate: string
    totalShare: number | null
    totalMv: number | null
    peTtm: number | null
    pb: number | null
    psTtm: number | null
    dvTtm: number | null
  } | null
  valuationHistory?: Record<string, { sampleCount: number; percentile: number | null }>
  comparables?: {
    status: 'ok' | 'blocked'
    sampleCount: number
    minimumSample: number
    rows: Array<{
      companyId: string
      companyName: string
      securityId: string
      tsCode: string
      tradeDate: string
      peTtm: number | null
      pb: number | null
      psTtm: number | null
    }>
    currentPercentiles: Record<'peTtm' | 'pb' | 'psTtm', number | null>
  }
  factFingerprint: string
  methodologyVersion?: string
  latestSync?: Record<string, unknown> | null
}

export interface ResearchValuationPreview {
  valuationMethod: ResearchValuationMethod
  formulaVersion: string
  marketFingerprint: string
  marketDate: string | null
  currentPrice: number | null
  status: 'ok' | 'degraded' | 'blocked'
  scenarios: Array<{
    name: 'bear' | 'base' | 'bull'
    weightPct: number | null
    status: 'ok' | 'degraded' | 'blocked'
    fairPrice: number | null
    equityValue: number | null
    impliedAssumption: number | null
    impliedAssumptionLabel: string | null
    reasons: string[]
  }>
  fairValueLow: number | null
  fairValueHigh: number | null
  weightedFairValue: number | null
  upsidePct: number | null
  downsidePct: number | null
  rewardRiskRatio: number | null
  factIds: string[]
  reasons: string[]
}

export interface ResearchDecisionWorkbenchData {
  companies: Array<{
    company_id: string
    display_name: string
    legal_name: string
    status: ResearchCompanyStatus
    securities: Array<{ id: string; ts_code: string; exchange: string; security_type: string }>
    trend_score: number | null
    trend_score_date: string | null
    trend_score_source: 'realtime' | 'eod' | null
    trend_score_ts_code: string | null
  }>
  selectedCompanyId: string | null
  selectedSecurityId: string | null
  skillAdoption: {
    status: 'current' | 'changed' | 'current_skill_missing' | 'legacy_hash_only' | 'legacy_snapshot_missing'
    projectUpdatedAt: number
    current: { contentHash: string; ruleVersion: string; sourceDisplayName: string } | null
    diff: { status: string; added: string[]; removed: string[]; changed: string[]; unchanged: string[] } | null
  }
  workItems: ResearchWorkItem[]
  scenarioSets: ResearchScenarioSet[]
  decisions: ResearchDecisionItem[]
  monitoringItems: ResearchMonitoringItem[]
  triggers: ResearchDecisionTrigger[]
  reviewQueue: ResearchReviewQueueItem[]
  marketContext: ResearchMarketContext
}

export type {
  IndustryResearchSnapshotSummary,
  ResearchCandidateBatchSummary,
  ResearchChangeCandidate,
  ResearchChangeSetSummary,
  ResearchDiscussionSummary,
} from '../ResearchDiscussion/researchDiscussionTypes'

export interface ResearchChangeResolveResult {
  resolvedChangeSetIds: string[]
  projectId: string | null
  mergedEntityIds: Record<string, string>
  snapshotId: string | null
  graphUpdatedAt: number | null
  batchStatus: string
  appliedSummary: Array<{ type: string; label: string; entityId: string }>
}

export interface ResearchArchiveImportResult {
  archive: {
    archiveType: string
    schemaVersion: number
    archiveVersion: string
    files: Array<{ logicalName: string; sha256: string; size: number }>
  }
  batch: import('../ResearchDiscussion/researchDiscussionTypes').ResearchCandidateBatchSummary | null
  changeSets: import('../ResearchDiscussion/researchDiscussionTypes').ResearchChangeSetSummary[]
  candidateCount: number
  warnings: string[]
  unresolvedRefs: Array<{ sourceLocator: string; ref: string; reason: string }>
}

export interface ResearchSnapshotDetail {
  summary: import('../ResearchDiscussion/researchDiscussionTypes').IndustryResearchSnapshotSummary
  sourceDiscussionAvailable: boolean
  snapshot: {
    schemaVersion: number
    project?: ResearchProject
    graph?: ResearchGraph | null
    evidenceRefs?: Array<{ id: string; title: string; statementKind: string; sourceUrl: string | null; primarySourceConfirmed: boolean }>
    hypotheses?: ResearchHypothesis[]
    companies?: unknown[]
    followUps?: unknown[]
    source?: { sessionId: number | null; originType: string; originId: string | null; returnTarget: unknown }
    acceptedChangeSetIds?: string[]
  }
}

export interface ResearchEvidenceCandidateView {
  id: string
  title: string
  sourceUrl: string
  summary: string | null
  excerpt: string | null
  status: string
  providerId: string
  query: string
  sourceKind?: string
  isDetailPage?: boolean
  relevanceScore?: number | null
  authorityScore?: number | null
  freshnessScore?: number | null
  rankScore?: number | null
  failureReason?: string | null
}

export type ResearchRetrievalMode = 'strong' | 'mixed' | 'weak' | 'offline'

export interface ResearchRetrievalPlanView {
  mode?: ResearchRetrievalMode | string
  queries?: Array<{
    id?: string
    text?: string
    intent?: string
    hitCount?: number
    detailUrlCount?: number
    status?: string
    rationale?: string
  }>
  localHitCount?: number
  webHitCount?: number
  detailPageCount?: number
  selectedTopN?: number
  candidatePoolSize?: number
  degradedCode?: string | null
  message?: string
  enhancedSearch?: {
    providerId?: string | null
    configured?: boolean
    status?: 'disabled' | 'not_configured' | 'key_unavailable' | 'succeeded' | 'empty' | 'failed'
    errorCode?: string | null
  }
}

export interface ResearchNativeWebSearchView {
  status: 'succeeded' | 'fallback' | 'disabled'
  provider: string | null
  model: string | null
  responseId: string | null
  calls: Array<{
    id: string
    status: string
    action: {
      type: 'search' | 'open_page' | 'find_in_page'
      queries: string[]
      url: string | null
      pattern: string | null
      sources: string[]
    }
  }>
  citations: Array<{ url: string; title: string; startIndex: number; endIndex: number }>
  sources: Array<{ url: string; title: string | null; cited: boolean }>
  errorCode?: string | null
  errorMessage?: string | null
}

export interface ResearchCompanyCandidateView {
  id: string
  displayName: string
  legalNameCandidate: string
  rationale: string
  resolutionStatus: string
  exclusionReason: string | null
  matchedSecurities: Array<{ tsCode: string; stockName: string; exchange: string; matchStatus: string }>
}

export const FINANCIAL_DATASETS = [
  'income', 'balancesheet', 'cashflow', 'fina_indicator', 'fina_audit',
  'forecast', 'express', 'disclosure_date', 'fina_mainbz',
] as const

export type FinancialDataset = typeof FINANCIAL_DATASETS[number]
export type ResearchCompanyStatus = 'candidate' | 'watching' | 'core' | 'excluded'
export type BusinessExposureStatus = 'candidate' | 'confirmed' | 'not_separable' | 'excluded'
export type FinancialFactKind = 'reported' | 'derived'
export type FinancialDerivationStatus = 'not_applicable' | 'derived' | 'not_separable' | 'blocked'
export type FinancialSyncStatus = 'idle' | 'running' | 'success' | 'failed'
export type ProfitBridgeStatus = 'estimate' | 'hypothesis'
export type ProfitBridgeItemKey = 'volume' | 'price' | 'product_mix' | 'raw_material' | 'depreciation_expense' | 'other_business_drag' | 'other'

export interface ResearchSecurity {
  id: string
  companyId: string
  tsCode: string
  symbol: string | null
  exchange: string
  securityType: string
  listStatus: string | null
  listDate: string | null
  delistDate: string | null
  mappingSource: string
  sourceRef: string | null
  updatedAt: number | null
}

export interface ResearchCompany {
  companyId: string
  projectId: string
  legalName: string
  shortName: string | null
  displayName: string
  unifiedCreditCode: string | null
  registrationRegion: string | null
  sourceType: string
  sourceRef: string | null
  status: ResearchCompanyStatus
  exclusionReason: string | null
  evidenceIds: string[]
  updatedAt: number | null
  securities: ResearchSecurity[]
  trendScore: number | null
  trendScoreDate: string | null
  trendScoreSource: 'realtime' | 'eod' | null
  trendScoreTsCode: string | null
}

export interface DisclosureEvidence {
  id: string
  companyId: string
  projectId: string | null
  title: string
  sourceUrl: string
  publishedDate: string | null
  actualPublishedDate: string | null
  excerpt: string | null
  createdBy: 'human' | 'import'
  primarySourceConfirmed: boolean
  createdAt: number
  updatedAt: number
}

export interface BusinessExposure {
  id: string
  projectId: string
  companyId: string
  researchNodeId: string | null
  mainBusinessItemId: string | null
  evidenceId: string | null
  sourceKey: string
  sourceType: 'manual' | 'fina_mainbz'
  status: BusinessExposureStatus
  exposurePct: number | null
  basis: string
  createdBy: 'human' | 'import'
  factDate: string | null
  evidenceIds: string[]
  methodology: string | null
  mainBusinessItemName: string | null
  mainBusinessReportPeriod: string | null
  mainBusinessRevenue: number | null
  mainBusinessCost: number | null
  mainBusinessProfit: number | null
  mainBusinessCurrency: string | null
  mainBusinessSourceApi: string | null
  updatedAt: number | null
}

export interface FinancialMetric {
  factId: string
  name: string
  value: number | null
  textValue: string | null
  unit: string | null
  currency: string | null
}

export interface FinancialTimelineRevision {
  key: string
  companyId: string
  securityId: string | null
  tsCode: string | null
  dataset: FinancialDataset
  factKind: FinancialFactKind
  derivationStatus: FinancialDerivationStatus
  announcementDate: string | null
  actualAnnouncementDate: string | null
  knowledgeDate: string | null
  reportPeriod: string
  statementType: string | null
  companyType: string | null
  updateFlag: string | null
  sourceFactKey: string
  sourceVersion: string
  metrics: FinancialMetric[]
  formula: string | null
  inputFactIds: string[]
  fetchedAt: number | null
}

export interface FinancialQualityMetric {
  value: number | null
  reason: string | null
  factId: string | null
}

export interface FinancialValidation {
  companyId: string
  coverage: {
    recentSingleQuarters: string[]
    latestInterimPeriods: string[]
    recentAnnualPeriods: string[]
    latestForecastOrExpress: { dataset: string; periodEnd: string; announcementDate: string | null } | null
    latestForecastOrExpressReason: string | null
  }
  quality: {
    receivables: FinancialQualityMetric
    inventory: FinancialQualityMetric
    contractAssets: FinancialQualityMetric
    operatingCashflow: FinancialQualityMetric
    nonRecurringProfit: FinancialQualityMetric
  }
}

export interface FinancialSyncState {
  companyId: string
  dataset: FinancialDataset
  status: FinancialSyncStatus
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastSuccessFactDate: string | null
  lastSuccessRowCount: number | null
  lastErrorCode: string | null
  updatedAt: number | null
}

export interface ProfitBridgeItem {
  key: ProfitBridgeItemKey
  label: string
  amount: number | null
  unit: string | null
  methodology: string | null
}

export interface ProfitBridge {
  id: string
  bridgeKey: string
  projectId: string
  companyId: string
  basePeriod: string
  targetPeriod: string
  status: ProfitBridgeStatus
  items: ProfitBridgeItem[]
  formula: string | null
  inputFactIds: string[]
  evidenceIds: string[]
  createdBy: 'human' | 'import'
  version: number
  previousVersionId: string | null
  updatedAt: number
}

export interface ResearchCompanyDraft {
  id: string
  legalName: string
  shortName: string
  unifiedCreditCode: string
  registrationRegion: string
  sourceRef: string
  status: ResearchCompanyStatus
  exclusionReason: string
  security: {
    id: string
    tsCode: string
    exchange: string
    securityType: string
    listStatus: string
    listDate: string
    delistDate: string
    sourceRef: string
  } | null
}

export interface DisclosureEvidenceDraft {
  id: string
  title: string
  sourceUrl: string
  publishedDate: string
  actualPublishedDate: string
  excerpt: string
  primarySourceConfirmed: boolean
}

export interface BusinessExposureDraft {
  id: string
  researchNodeId: string
  mainBusinessItemId: string
  evidenceId: string
  sourceKey: string
  sourceType: 'manual' | 'fina_mainbz'
  status: BusinessExposureStatus
  exposurePct: number | null
  basis: string
  factDate: string
  methodology: string
}

export interface ProfitBridgeDraft {
  bridgeKey: string
  basePeriod: string
  targetPeriod: string
  status: ProfitBridgeStatus
  items: ProfitBridgeItem[]
  formula: string
  inputFactIds: string[]
  evidenceIds: string[]
}

export interface ResearchCreateDraft {
  title: string
  industryName: string
  productScope: string
  regionScope: string
  timeScope: string
  purpose: ResearchPurpose
  depth: ResearchDepth
  sourceType: 'manual'
  stopCondition: string
}

export interface ResearchEvidenceDraft {
  title: string
  sourceType: string
  sourceName: string
  sourceUrl: string
  sourceRef: string
  factDate: string
  statementKind: ResearchStatementKind
  direction: 'support' | 'weaken' | 'refute' | 'neutral'
  reliability: 'primary' | 'secondary' | 'tertiary' | 'unknown'
  primarySourceConfirmed: boolean
  conflictNote: string
  excerpt: string
}

export interface ResearchHypothesisDraft {
  statement: string
  importance: number
  cheapestDisproof: string
  verificationMetric: string
  threshold: string
}

export interface IndustryResearchResponse<T> {
  ok: boolean
  data?: T
  code?: string
  message?: string
}
