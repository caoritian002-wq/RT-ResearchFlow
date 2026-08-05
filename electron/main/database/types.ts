// ──────────────────────────────────────────────────────────
// Core domain types for the financial news monitor
// ──────────────────────────────────────────────────────────

export type ImpactRating = 'CRITICAL' | 'IMPORTANT' | 'GENERAL'
export type PublicationTimeStatus = 'exact' | 'date_only' | 'collected_fallback'
export type PublicationTimeScope = 'confirmed' | 'uncertain' | 'all'

export type SourceCategory =
  | 'REGULATOR'
  | 'CENTRAL_BANK'
  | 'GOVERNMENT'
  | 'STATE_MEDIA'
  | 'FINANCIAL_PRESS'
  | 'CUSTOM'

export type SourceStatus = 'ACTIVE' | 'UNREACHABLE' | 'DEGRADED' | 'PARSE_FAILED' | 'DISABLED'

export type ParseStrategy = 'RSS' | 'ATOM' | 'HTML_SCRAPE' | 'API'

export type ScanRunType = 'SCHEDULED' | 'MANUAL' | 'CATCH_UP'

export type ResearchProjectStatus = 'draft' | 'active' | 'review_due' | 'archived'
export type ResearchDepth = 'quick' | 'standard' | 'deep'
export type ResearchPurpose = 'learning' | 'strategy' | 'investment'
export type ResearchSourceType = 'manual' | 'briefing' | 'ai_analysis' | 'decision_signal' | 'supply_chain'
export type ResearchStatementKind = 'fact' | 'estimate' | 'hypothesis'
export type EvidenceDirection = 'support' | 'weaken' | 'refute' | 'neutral'
export type EvidenceReliability = 'primary' | 'secondary' | 'tertiary' | 'unknown'
export type EvidenceCreator = 'human' | 'ai' | 'import'
export type HypothesisStatus = 'open' | 'supported' | 'weakened' | 'refuted' | 'reopened'
export type IndustryResearchNodeType =
  | 'industry'
  | 'product'
  | 'material'
  | 'process'
  | 'equipment'
  | 'company'
  | 'country'
  | 'demand'
  | 'metric'
  | 'stock'
  | 'technology'
  | 'policy'
  | 'hypothesis'
  | 'shock'
export type IndustryResearchMasterDataSource = 'manual' | 'tushare'
export type IndustryResearchExposureStatus = 'confirmed' | 'candidate' | 'not_separable' | 'excluded'
export type IndustryResearchExposureSource = 'manual' | 'fina_mainbz'
export type IndustryResearchCompanyStatus = 'candidate' | 'watching' | 'core' | 'excluded'
export type IndustryResearchProfitBridgeStatus = 'estimate' | 'hypothesis'
export type IndustryResearchProfitBridgeItemKey =
  | 'volume'
  | 'price'
  | 'product_mix'
  | 'raw_material'
  | 'depreciation_expense'
  | 'other_business_drag'
  | 'other'
export type IndustryResearchFinancialFactKind = 'reported' | 'derived'
export type IndustryResearchDerivationStatus = 'not_applicable' | 'derived' | 'not_separable' | 'blocked'
export type IndustryResearchFinancialSyncStatus = 'idle' | 'running' | 'success' | 'failed'
export type IndustryResearchFinancialDataset =
  | 'income'
  | 'balancesheet'
  | 'cashflow'
  | 'fina_indicator'
  | 'fina_audit'
  | 'forecast'
  | 'express'
  | 'disclosure_date'
  | 'fina_mainbz'

export type ResearchWebSearchProviderId = 'tavily' | 'bing' | 'custom_openai_compatible_search'
export type ResearchEvidenceCandidateStatus = 'fetched' | 'partial' | 'failed' | 'confirmed' | 'rejected'
export type ResearchEvidenceSourceKind =
  | 'web_search'
  | 'official_detail'
  | 'local_briefing'
  | 'local_research'
  | 'user_url'
export type ResearchRetrievalMode = 'strong' | 'mixed' | 'weak' | 'offline'
export type ResearchQueryIntent =
  | 'policy'
  | 'supply_demand_price'
  | 'capacity_inventory'
  | 'company_exposure'
  | 'tech_substitution_or_shock'
  | 'general'
export type ResearchGenerationStage =
  | 'retrieve'
  | 'scope'
  | 'map'
  | 'evidence'
  | 'hypothesis'
  | 'companies'
  | 'report'
export type ResearchGenerationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type ResearchCompanyCandidateResolution = 'pending' | 'accepted' | 'excluded' | 'unmatched'

// ──────────────────────────────────────────────────────────
// Database row types (snake_case matching SQLite columns)
// ──────────────────────────────────────────────────────────

export interface IndustryResearchProjectRow {
  id: string
  schema_version: number
  title: string
  industry_name: string
  product_scope: string
  region_scope: string
  time_scope: string
  purpose: ResearchPurpose
  depth: ResearchDepth
  status: ResearchProjectStatus
  data_as_of: string | null
  valuation_date: string | null
  source_type: ResearchSourceType
  source_ref: string | null
  source_text_summary: string | null
  skill_id: string
  skill_content_hash: string
  skill_rule_version: string | null
  generation_model: string | null
  next_review_at: number | null
  stop_condition: string | null
  graph_updated_at: number
  created_at: number
  updated_at: number
}

export interface IndustryResearchNodeRow {
  id: string
  project_id: string
  type: IndustryResearchNodeType
  name: string
  stage: string | null
  statement_kind: ResearchStatementKind
  status: string | null
  metrics_json: string
  evidence_ids_json: string
  last_updated: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchEdgeRow {
  id: string
  project_id: string
  source_node_id: string
  target_node_id: string
  relation: string
  statement_kind: ResearchStatementKind
  strength: number | null
  bottleneck: number
  exposure_pct: number | null
  evidence_ids_json: string
  last_updated: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchEvidenceRow {
  id: string
  project_id: string
  title: string
  source_type: string
  source_name: string
  source_url: string | null
  source_ref: string | null
  published_date: string | null
  fact_date: string | null
  collected_at: number
  metric_name: string | null
  metric_value: number | null
  unit: string | null
  region: string | null
  product_spec: string | null
  methodology: string | null
  statement_kind: ResearchStatementKind
  direction: EvidenceDirection
  reliability: EvidenceReliability
  created_by: EvidenceCreator
  primary_source_confirmed: number
  conflict_note: string | null
  excerpt: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchHypothesisRow {
  id: string
  project_id: string
  statement: string
  importance: number
  status: HypothesisStatus
  cheapest_disproof: string
  verification_metric: string | null
  threshold: string | null
  due_at: number | null
  evidence_ids_json: string
  created_at: number
  updated_at: number
}

export interface IndustryResearchHypothesisEventRow {
  id: string
  project_id: string
  hypothesis_id: string
  from_status: HypothesisStatus | null
  to_status: HypothesisStatus
  reason: string
  evidence_ids_json: string
  created_at: number
}

export interface IndustryResearchCompanyRow {
  id: string
  legal_name: string
  short_name: string | null
  unified_credit_code: string | null
  registration_region: string | null
  source_type: IndustryResearchMasterDataSource
  source_ref: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchSecurityRow {
  id: string
  company_id: string
  ts_code: string
  symbol: string | null
  exchange: string
  security_type: string
  list_status: string | null
  list_date: string | null
  delist_date: string | null
  mapping_source: IndustryResearchMasterDataSource
  source_ref: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchDisclosureEvidenceRow {
  id: string
  company_id: string
  project_id: string | null
  title: string
  source_url: string
  published_date: string | null
  actual_published_date: string | null
  excerpt: string | null
  created_by: 'human' | 'import'
  primary_source_confirmed: number
  created_at: number
  updated_at: number
}

export interface IndustryResearchMainBusinessItemRow {
  id: string
  company_id: string
  source_api: string
  source_fact_key: string
  source_version: string
  report_period: string
  dimension: 'product' | 'region' | 'industry'
  item_code: string | null
  item_name: string
  revenue: number | null
  cost: number | null
  profit: number | null
  currency: string | null
  fetched_at: number
  created_at: number
}

export interface IndustryResearchBusinessExposureRow {
  id: string
  project_id: string
  company_id: string
  research_node_id: string | null
  main_business_item_id: string | null
  evidence_id: string | null
  source_key: string
  source_type: IndustryResearchExposureSource
  status: IndustryResearchExposureStatus
  exposure_pct: number | null
  basis: string
  created_by: 'human' | 'import'
  fact_date: string | null
  evidence_ids_json: string
  methodology: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchProjectCompanyRow {
  project_id: string
  company_id: string
  status: IndustryResearchCompanyStatus
  exclusion_reason: string | null
  evidence_ids_json: string
  created_at: number
  updated_at: number
}

export interface IndustryResearchProfitBridgeRow {
  id: string
  project_id: string
  company_id: string
  bridge_key: string
  base_period: string
  target_period: string
  status: IndustryResearchProfitBridgeStatus
  formula: string | null
  input_fact_ids_json: string
  evidence_ids_json: string
  created_by: 'human' | 'import'
  version: number
  previous_version_id: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchProfitBridgeItemRow {
  id: string
  profit_bridge_id: string
  item_key: IndustryResearchProfitBridgeItemKey
  label: string
  amount: number | null
  unit: string | null
  methodology: string | null
  sort_order: number
}

export interface IndustryResearchFinancialFactRow {
  id: string
  company_id: string
  security_id: string | null
  source_api: string
  source_fact_key: string
  source_version: string
  metric_name: string
  metric_value: number | null
  text_value: string | null
  unit: string | null
  currency: string | null
  ann_date: string | null
  f_ann_date: string | null
  report_period: string
  statement_type: string | null
  company_type: string | null
  update_flag: string | null
  fact_kind: IndustryResearchFinancialFactKind
  derivation_formula: string | null
  input_versions_json: string
  derivation_status: IndustryResearchDerivationStatus
  fetched_at: number
  created_at: number
}

export interface IndustryResearchFinancialSyncStateRow {
  company_id: string
  dataset: IndustryResearchFinancialDataset
  status: IndustryResearchFinancialSyncStatus
  last_attempt_at: number | null
  last_success_at: number | null
  last_error_code: string | null
  last_success_fact_date: string | null
  last_success_row_count: number | null
  updated_at: number
}

export interface ResearchWebSearchConfigRow {
  id: 1
  provider_id: ResearchWebSearchProviderId
  enabled: number
  api_key_encrypted: Buffer | null
  base_url: string | null
  last_validated_at: number | null
  last_error_code: string | null
  updated_at: number
}

export interface ResearchEvidenceCandidateRow {
  id: string
  project_id: string | null
  run_id: string | null
  query: string
  source_url: string
  title: string
  summary: string | null
  excerpt: string | null
  provider_id: string
  published_at: string | null
  fetched_at: number
  status: ResearchEvidenceCandidateStatus
  failure_reason: string | null
  confirmed_at: number | null
  source_kind: ResearchEvidenceSourceKind | string | null
  is_detail_page: number | null
  relevance_score: number | null
  authority_score: number | null
  freshness_score: number | null
  rank_score: number | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchGenerationRunRow {
  id: string
  project_id: string
  research_question: string
  status: ResearchGenerationStatus
  current_stage: ResearchGenerationStage
  last_successful_stage: ResearchGenerationStage | null
  progress_current: number
  progress_total: number
  progress_message: string
  cancel_requested: number
  skill_id: string
  skill_content_hash: string
  skill_rule_version: string | null
  provider: string | null
  model: string | null
  error_code: string | null
  error_message: string | null
  retryable: number
  stage_artifacts_json: string
  scope_json: string | null
  enable_web_retrieval: number
  created_at: number
  started_at: number | null
  completed_at: number | null
  updated_at: number
}

// -- FR-256 recoverable single-agent research ledger -------------------------

export type ResearchAgentRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'needs_attention'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type ResearchAgentRunKind = 'single_agent' | 'multi_perspective'
export type ResearchAgentRunPhase = 'planning' | 'tooling' | 'synthesis' | 'audit' | 'persist'
export type ResearchAgentRunOutcome = 'complete' | 'partial' | 'blocked'
export type ResearchAgentUsageStatus = 'not_started' | 'complete' | 'partial' | 'unknown'
export type ResearchAgentStepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type ResearchAgentToolCallStatus =
  | 'prepared'
  | 'running'
  | 'submitted'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'outcome_unknown'
  | 'cancelled'
export type ResearchAgentModelCallStatus =
  | 'prepared'
  | 'submitted'
  | 'succeeded'
  | 'safe_failed'
  | 'outcome_unknown'
  | 'cancelled'

export interface ResearchAgentRunRow {
  id: string
  request_id: string
  request_fingerprint: string
  run_kind: ResearchAgentRunKind
  parent_run_id: string | null
  discussion_session_id: number | null
  question: string
  context_snapshot_json: string
  context_snapshot_sha256: string
  subjects_json: string
  include_portfolio: number
  as_of: string
  status: ResearchAgentRunStatus
  phase: ResearchAgentRunPhase
  outcome: ResearchAgentRunOutcome | null
  provider: string
  model: string
  model_config_fingerprint: string
  prompt_rule_version: string
  tool_registry_version: string
  budget_json: string
  plan_json: string | null
  plan_sha256: string | null
  evidence_snapshot_sha256: string | null
  report_markdown: string | null
  report_sha256: string | null
  audit_json: string | null
  model_call_count: number
  tool_call_count: number
  tool_result_bytes: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  usage_status: ResearchAgentUsageStatus
  estimated_cost: number
  cost_currency: string | null
  cost_status: ResearchAgentUsageStatus
  cancel_requested: number
  lease_owner: string | null
  lease_expires_at: number | null
  revision: number
  error_code: string | null
  error_message: string | null
  retryable: number
  created_at: number
  started_at: number | null
  completed_at: number | null
  updated_at: number
}

export interface ResearchAgentStepRow {
  id: string
  run_id: string
  ordinal: number
  kind: ResearchAgentRunPhase
  status: ResearchAgentStepStatus
  predecessor_step_id: string | null
  input_json: string
  input_sha256: string
  output_sha256: string | null
  artifact_json: string | null
  attempt_count: number
  revision: number
  error_code: string | null
  error_message: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  updated_at: number
}

export interface ResearchAgentToolCallRow {
  id: string
  run_id: string
  step_id: string
  tool_id: string
  attempt: number
  input_json: string
  input_sha256: string
  as_of: string
  status: ResearchAgentToolCallStatus
  envelope_json: string | null
  envelope_sha256: string | null
  model_projection_json: string | null
  model_projection_sha256: string | null
  stable_references_json: string
  fact_date: string | null
  sources_json: string
  coverage_json: string
  warnings_json: string
  duration_ms: number | null
  error_code: string | null
  error_message: string | null
  prepared_at: number
  started_at: number | null
  submitted_at: number | null
  completed_at: number | null
  updated_at: number
}

export interface ResearchAgentModelCallRow {
  id: string
  run_id: string
  step_id: string
  purpose: string
  attempt: number
  status: ResearchAgentModelCallStatus
  provider: string
  model: string
  prompt_rule_version: string
  input_messages_json: string
  input_sha256: string
  response_id: string | null
  response_text: string | null
  response_sha256: string | null
  finish_reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  usage_status: Exclude<ResearchAgentUsageStatus, 'not_started'> | null
  price_snapshot_json: string | null
  estimated_cost: number | null
  cost_currency: string | null
  error_code: string | null
  error_message: string | null
  prepared_at: number
  submitted_at: number | null
  completed_at: number | null
  updated_at: number
}

export interface IndustryResearchCompanyCandidateRow {
  id: string
  run_id: string
  project_id: string
  legal_name_candidate: string
  display_name: string
  research_node_ids_json: string
  rationale: string
  statement_kind: 'estimate'
  matched_securities_json: string
  resolution_status: ResearchCompanyCandidateResolution
  exclusion_reason: string | null
  created_at: number
  updated_at: number
}

// ── FR-239 上下文讨论与产业研究增量 ──────────────────────────

export type ResearchDiscussionOriginType = 'daily_review' | 'weekly_review' | 'decision_signal' | 'judgment' | 'industry_research' | 'briefing' | 'manual'
export type ResearchDiscussionStatus = 'active' | 'changes_ready' | 'partially_applied' | 'applied' | 'archived'
export type ResearchBaseSelectionReason = 'latest_compatible' | 'empty_project' | 'unassigned'
export type ResearchCandidateSourceType = 'discussion' | 'archive'
export type ResearchCandidateBatchStatus = 'draft' | 'ready' | 'partially_resolved' | 'resolved' | 'failed' | 'cancelled'
export type ResearchChangeSetAction = 'add' | 'revise' | 'strengthen' | 'weaken' | 'refute' | 'reopen' | 'follow_up' | 'no_change'
export type ResearchChangeSetStatus = 'pending' | 'accepted' | 'rejected' | 'deferred' | 'superseded' | 'conflicted' | 'invalid'
export type ResearchChangeCandidateKind = 'project' | 'node' | 'edge' | 'evidence' | 'hypothesis' | 'hypothesis_event' | 'company' | 'company_exposure' | 'follow_up'
export type ResearchChangeCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'superseded' | 'conflicted' | 'invalid'
export type ResearchCandidateStatementType = 'fact' | 'estimate' | 'hypothesis' | 'candidate'

export interface AIResearchDiscussionContextRow {
  session_id: number
  start_request_id: string
  context_update_request_id: string | null
  status: ResearchDiscussionStatus
  origin_type: ResearchDiscussionOriginType
  origin_id: string | null
  origin_title: string
  origin_occurred_at: number | null
  origin_available: number
  origin_content_hash: string
  context_snapshot_json: string
  context_keys_json: string
  included_context_keys_json: string
  return_target_json: string
  project_id: string | null
  base_snapshot_id: string | null
  base_selection_reason: ResearchBaseSelectionReason
  summarized_through_message_index: number | null
  latest_batch_id: string | null
  degraded_reason: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchCandidateBatchRow {
  id: string
  request_id: string
  idempotency_key: string
  source_type: ResearchCandidateSourceType
  source_session_id: number | null
  project_id: string | null
  base_snapshot_id: string | null
  message_start_index: number | null
  message_end_index: number | null
  context_hash: string
  provider: string | null
  model: string | null
  rule_version: string
  status: ResearchCandidateBatchStatus
  change_set_count: number
  candidate_count: number
  conflict_count: number
  degraded_reasons_json: string
  archive_meta_json: string | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchChangeSetRow {
  id: string
  batch_id: string
  title: string
  summary: string
  impact: string
  action: ResearchChangeSetAction
  status: ResearchChangeSetStatus
  risk: 'low' | 'medium' | 'high'
  affected_objects_json: string
  evidence_summary_json: string
  confidence_boundary: string
  requires_expanded_review: number
  candidate_count: number
  source_session_id: number | null
  message_start_index: number | null
  message_end_index: number | null
  user_edits_json: string | null
  resolution_action: 'accept' | 'reject' | 'defer' | null
  resolution_reason: string | null
  resolution_request_id: string | null
  resolved_by: string | null
  resolved_at: number | null
  created_at: number
  updated_at: number
}

export interface IndustryResearchChangeCandidateRow {
  id: string
  change_set_id: string
  batch_id: string
  project_id: string | null
  kind: ResearchChangeCandidateKind
  action: string
  status: ResearchChangeCandidateStatus
  external_ref: string | null
  source_locator: string
  message_start_index: number | null
  message_end_index: number | null
  target_entity_id: string | null
  statement_type: ResearchCandidateStatementType
  primary_source: number
  payload_json: string
  conflicts_json: string
  warnings_json: string
  created_at: number
  updated_at: number
}

export interface IndustryResearchExternalRefRow {
  id: string
  project_id: string
  source_scope: string
  external_id: string
  entity_kind: string
  entity_id: string
  source_batch_id: string
  created_at: number
}

export interface IndustryResearchSnapshotRow {
  id: string
  project_id: string
  previous_snapshot_id: string | null
  snapshot_reason: IndustryResearchSnapshotReason
  request_id: string | null
  trigger_batch_id: string | null
  skill_snapshot_id: string | null
  source_session_id: number | null
  source_origin_type: string
  source_origin_id: string | null
  source_return_target_json: string | null
  schema_version: number
  graph_updated_at: number
  title: string
  accepted_change_set_count: number
  snapshot_json: string
  created_at: number
}

// ── FR-230 第181B Skill采用与研究决策事实 ───────────────────

export type IndustryResearchSnapshotReason = 'discussion_merge' | 'archive_import' | 'project_baseline' | 'skill_adoption' | 'decision_basis'
export type ResearchSkillAdoptionEventType = 'initial' | 'adopted' | 'legacy_verified'
export type ResearchEffort = 'quick_pass' | 'standard_validation' | 'deep_research'
export type ResearchDecisionAction = 'continue_research' | 'wait_financial_validation' | 'wait_price' | 'monitor' | 'exclude'
export type ResearchDecisionEventType = 'created' | 'maintained' | 'upgraded' | 'downgraded' | 'invalidated' | 'closed'
export type ResearchMonitoringValueKind = 'number' | 'text' | 'event'
export type ResearchMonitoringFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'event_driven'
export type ResearchMonitoringTiming = 'leading' | 'coincident' | 'lagging' | 'unknown'
export type ResearchTriggerOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'changed'
export type ResearchTriggerEvaluationResult = 'not_triggered' | 'pending_review' | 'blocked' | 'expired'
export type ResearchReviewKind = 'skill_adoption' | 'trigger' | 'project_boundary' | 'hypothesis_due' | 'financial_validation' | 'monitoring_stale' | 'decision_expiry' | 'work_item'
export type ResearchReviewState = 'pending' | 'confirmed' | 'dismissed'
export type IndustryResearchValuationMethod = 'pe' | 'pb_roe' | 'ev_ebitda' | 'dcf' | 'sotp' | 'nav'
export type IndustryResearchMarketStatus = 'ok' | 'degraded' | 'blocked'

export interface IndustryResearchSkillSnapshotRow {
  id: string
  skill_id: string
  content_hash: string
  rule_version: string
  content: string
  source_type: 'builtin' | 'custom'
  source_locator: string
  content_bytes: number
  captured_at: number
}

export interface IndustryResearchSkillAdoptionEventRow {
  id: string
  request_id: string
  project_id: string
  event_type: ResearchSkillAdoptionEventType
  previous_snapshot_id: string | null
  target_snapshot_id: string
  research_snapshot_id: string | null
  migration_note: string
  diff_schema_version: 1
  diff_json: string
  review_summary_json: string
  adopted_at: number
}

export interface IndustryResearchWorkItemVersionRow {
  id: string
  work_item_id: string
  project_id: string
  version: number
  previous_version_id: string | null
  request_id: string
  question: string
  effort: ResearchEffort
  conclusion_sensitivity: 'low' | 'medium' | 'high'
  evidence_uncertainty: 'low' | 'medium' | 'high'
  change_velocity: 'low' | 'medium' | 'high'
  stop_reason: string | null
  next_trigger_metric: string | null
  affected_objects_json: string
  status: 'open' | 'blocked' | 'completed' | 'stopped'
  created_at: number
}

export interface IndustryResearchScenarioSetVersionRow {
  id: string
  scenario_set_id: string
  project_id: string
  company_id: string | null
  version: number
  previous_version_id: string | null
  request_id: string
  data_as_of: string
  valuation_date: string | null
  valuation_method: IndustryResearchValuationMethod | null
  methodology_version: string | null
  created_at: number
}

export interface IndustryResearchScenarioRow {
  id: string
  scenario_set_version_id: string
  name: 'bear' | 'base' | 'bull'
  weight_pct: number | null
  assumptions_json: string
  valuation_inputs_json: string
  fact_ids_json: string
}

export interface IndustryResearchDecisionRow {
  id: string
  project_id: string
  company_id: string | null
  created_at: number
}

export interface IndustryResearchDecisionEventRow {
  id: string
  request_id: string
  decision_id: string
  project_id: string
  previous_event_id: string | null
  event_type: ResearchDecisionEventType
  action: ResearchDecisionAction
  rationale: string
  data_as_of: string
  valuation_date: string | null
  valid_until: number
  invalidation_condition: string
  skill_snapshot_id: string
  research_snapshot_id: string
  scenario_set_version_id: string | null
  work_item_ids_json: string
  fact_ids_json: string
  evidence_ids_json: string
  hypothesis_ids_json: string
  source_trigger_evaluation_id: string | null
  market_snapshot_id: string | null
  valuation_snapshot_id: string | null
  created_at: number
}

export interface SecurityAdjustmentFactorRow {
  ts_code: string
  trade_date: string
  adj_factor: number
  source: string
  fetched_at: number
}

export interface SecurityValuationDailyRow {
  ts_code: string
  trade_date: string
  total_share: number | null
  float_share: number | null
  total_mv: number | null
  circ_mv: number | null
  pe_ttm: number | null
  pb: number | null
  ps_ttm: number | null
  dv_ttm: number | null
  source: string
  fetched_at: number
}

export interface IndustryResearchMarketSyncRunRow {
  id: string
  request_id: string
  project_id: string
  company_id: string
  security_id: string
  ts_code: string
  benchmark_code: string | null
  status: 'running' | 'success' | 'partial' | 'failed'
  result_json: string
  data_start: string | null
  data_end: string | null
  fact_fingerprint: string | null
  error_code: string | null
  started_at: number
  completed_at: number | null
}

export interface IndustryResearchMarketSnapshotRow {
  id: string
  request_id: string
  project_id: string
  company_id: string
  security_id: string
  ts_code: string
  requested_valuation_date: string
  market_date: string | null
  benchmark_code: string | null
  benchmark_name: string | null
  raw_close: number | null
  status: IndustryResearchMarketStatus
  reason_json: string
  market_data_json: string
  fact_fingerprint: string
  methodology_version: string
  created_at: number
}

export interface IndustryResearchValuationSnapshotRow {
  id: string
  request_id: string
  project_id: string
  company_id: string
  scenario_set_version_id: string
  market_snapshot_id: string
  valuation_method: IndustryResearchValuationMethod
  status: IndustryResearchMarketStatus
  input_json: string
  output_json: string
  fact_ids_json: string
  formula_version: string
  created_at: number
}

export interface IndustryResearchMonitoringItemVersionRow {
  id: string
  monitoring_item_id: string
  project_id: string
  version: number
  previous_version_id: string | null
  request_id: string
  name: string
  value_kind: ResearchMonitoringValueKind
  frequency: ResearchMonitoringFrequency
  source_name: string
  source_ref: string | null
  unit: string | null
  timing_type: ResearchMonitoringTiming
  stale_after_ms: number
  next_review_at: number | null
  hypothesis_ids_json: string
  scenario_set_ids_json: string
  decision_ids_json: string
  status: 'active' | 'paused' | 'closed'
  created_at: number
}

export interface IndustryResearchMonitoringObservationRow {
  id: string
  request_id: string
  project_id: string
  monitoring_item_id: string
  monitoring_item_version_id: string
  value_number: number | null
  value_text: string | null
  unit: string | null
  source_ref: string | null
  observed_at: number
  available_at: number
  data_as_of: string
  methodology_version: string
  created_at: number
}

export interface IndustryResearchDecisionTriggerVersionRow {
  id: string
  trigger_id: string
  project_id: string
  decision_id: string
  monitoring_item_id: string
  monitoring_item_version_id: string
  version: number
  previous_version_id: string | null
  request_id: string
  metric_name: string
  operator: ResearchTriggerOperator
  threshold_number: number | null
  threshold_text: string | null
  validation_window_ms: number
  action_if_not_triggered: ResearchDecisionAction
  proposed_action_if_triggered: ResearchDecisionAction
  expires_at: number | null
  status: 'active' | 'disabled'
  created_at: number
}

export interface IndustryResearchDecisionTriggerEvaluationRow {
  id: string
  request_id: string
  project_id: string
  trigger_id: string
  trigger_version_id: string
  observation_id: string | null
  result: ResearchTriggerEvaluationResult
  result_reason: string
  evaluated_at: number
}

export interface IndustryResearchReviewEventRow {
  id: string
  request_id: string
  review_group_id: string
  project_id: string
  previous_event_id: string | null
  kind: ResearchReviewKind
  subject_kind: string
  subject_id: string
  source_event_id: string | null
  state: ResearchReviewState
  reason: string
  payload_json: string
  created_at: number
}

export interface BriefingRow {
  id: number
  sourceId: number
  sourceName: string
  originalUrl: string
  title: string
  summary: string
  fullContent: string | null
  publishedAt: number // UTC milliseconds
  publishedDateBJ: string // YYYY-MM-DD in UTC+8
  publicationTimeStatus: PublicationTimeStatus
  collectedAt: number // UTC milliseconds
  impactRating: ImpactRating
  impactRatingScore: number
  deduplicationHash: string // SHA-256 hex
  titleSimhash: string // 64-bit hex
  isRead: number // 0 or 1 (SQLite boolean)
  readAt: number | null
  scanRunId: number | null
  isCatchUp: number // 0 or 1
}

export interface SourceRow {
  id: number
  nameCN: string
  nameEN: string
  url: string
  feedUrl: string | null
  category: SourceCategory
  authorityWeight: number // 1–10
  isBuiltIn: number // 0 or 1
  isEnabled: number // 0 or 1
  status: SourceStatus
  lastScannedAt: number | null
  successRate: number // 0.0–1.0
  parseStrategy: ParseStrategy
  contentSelector: string | null
  financeSectionFilter: string | null
  detailSelector: string | null // CSS selector to extract full article content from the detail page
}

export interface DetailCacheRow {
  cacheKey: string   // SHA-256 hex of briefingUrl
  briefingUrl: string
  content: string    // Raw extracted HTML from detail page
  fetchedAt: number  // UTC milliseconds
}

export interface ScanRunRow {
  id: number
  type: ScanRunType
  startedAt: number
  completedAt: number | null
  sourcesScanned: number
  newBriefingsFound: number
  errors: string | null // JSON array
  catchUpRangeStart: number | null
  catchUpRangeEnd: number | null
}

export type AIProvider = 'claude' | 'chatgpt' | 'qwen' | 'deepseek'

export interface DecisionCenterFiltersPreference {
  status: string
  type: string
  source: string
  portfolioOnly: boolean
  minPriority: number
  viewMode: 'portfolio' | 'market'
}

export interface AppSettingsRow {
  id: 1
  scanIntervalMinutes: 5 | 10 | 15 | 30 | 60
  retentionDays: number
  catchUpMaxDays: number
  lastSuccessfulScanAt: number | null
  uiLanguage: string
  defaultGroupExpanded: number // 0 or 1 (SQLite boolean)
  autoAiAnalysisPrompt: number // 0 or 1 (SQLite boolean)
  momentumWindowMinutes: number // FR-102: 行业动量计算时间窗口（分钟），默认 3
  short_term_active_sub_tab?: string // FR-124: 短线策略上次激活子页签
  concept_source?: string             // FR-153: 题材数据源选择（'kpl'|'ths'|'dc'，默认 'kpl'）
  sector_concept_source?: string      // FR-157: 板块资金流向题材源（'kpl'|'ths'|'dc'，默认 'ths'）
  decision_notify_windows_enabled?: number // FR-167: Windows 原生通知开关，0/1
  decision_notify_min_priority?: number    // FR-167: Windows 原生通知最低优先级，默认 4
  decision_notify_in_app_enabled?: number  // FR-260: 应用内主动提醒开关，0/1，默认 1
  supply_chain_llm_fallback?: number       // FR-171: 产业链传导分析 LLM 兜底开关，0=关，1=开
  decision_center_filters_json?: string | null // FR-241: 今日看板筛选的跨 renderer-origin 持久偏好
}

// FR-159: 历史回测明细行
export interface BacktestDetailRow {
  tradeDate: string
  tsCode: string
  stockName?: string | null
  pool: 'firstBoard' | 'secondBoard' | 'brokenBoard' | 'brokenConsec' | 'allMarket'
  buyPrice: number | null
  ret1d: number | null
  ret2d: number | null
  ret3d: number | null
  ret5d: number | null
  computedAt: number | null
  // FR-161: 1 = 一字涨停（竞价涨幅 >= 9.5%），0 = 普通
  isOneWord: number
  // FR-163: 对应基准指数同期涨幅（上证/深成/创业/科创，按个股所属市场匹配）
  idxTodayPct?: number | null  // 信号日当日基准指数涨跌幅（供大盘环境分组）
  idxRet1d?: number | null
  idxRet2d?: number | null
  idxRet3d?: number | null
  idxRet5d?: number | null
}

// FR-162: 交易日历行
export interface TradeCalRow {
  calDate: string           // YYYYMMDD
  isOpen: number            // 1=交易日, 0=休市
  pretradeDate: string | null // 上一交易日 YYYYMMDD，可 null
}

// FR-158: 板块资金流向每日存档行
export interface MarketTimelineDailyRow {
  trade_date: string
  time: string
  limit_up: number
  limit_down: number
}

export interface FreeMinuteCacheRow {
  providerId: string
  tsCode: string
  tradeDate: string
  granularity: string
  tsMinute: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  vol: number | null
  amount: number | null
  fetchedAt: number
}

export interface SectorFlowDailyRow {
  trade_date: string
  source: string
  concept_code: string
  concept_name: string
  total_amount: number
  net_inflow: number
  net_inflow_rate: number
  weighted_change: number
  member_count: number
  up_count: number
  down_count: number
}

export interface SectorFlowObservationRow {
  trade_date: string
  provider: 'eastmoney' | 'local_estimate'
  scope: 'concept' | 'industry'
  board_code: string
  board_name: string
  metric_kind: 'verified_flow' | 'turnover_strength'
  total_amount: number
  turnover_direction_strength: number | null
  main_net_inflow: number | null
  main_net_inflow_rate: number | null
  weighted_change: number
  member_count: number
  up_count: number
  down_count: number
  flat_count: number
  source_updated_at: number | null
  captured_at: number
}

export interface AIConfigRow {
  id: 1
  provider: AIProvider | null
  model: string | null
  apiKeyEncrypted: Buffer | null
  baseUrl: string | null
  presetPrompt: string | null
  triggerRating: ImpactRating
  maxArticlesPerBatch: number
  maxContentCharsPerArticle: number
  maxArticleAgeDays: number | null
  autoCleanupDays: number | null
  trendForecastPrompt: string | null
  trendForecastMorrowPrompt: string | null
  maxForecastsPerStock: number
  providerPriority: string | null   // JSON array e.g. '["deepseek","claude"]'
  multiModelProviders: string | null // JSON array e.g. '["deepseek"]'
  maxForecastComparison: number
  selectedSkills: string          // JSON array e.g. '["builtin:buffett"]'
  customSkillPaths: string        // JSON array e.g. '["D:\\mySkills"]'
  skillsForTrend: number          // 0 or 1
  maxSkillChars: number           // default 30000
}

export interface ProviderConfigRow {
  provider: string
  apiKeyEncrypted: Buffer | null
  model: string | null
  baseUrl: string | null
  maxTokens?: number | null
  presetPrompt: string | null
  trendForecastPrompt: string | null
  trendForecastMorrowPrompt: string | null
}

export interface AIAnalysisSessionRow {
  id: number
  createdAt: number // UTC milliseconds
  provider: AIProvider
  model: string
  articleUrls: string // JSON array
  promptSent: string
  response: string | null
  responseRound2: string | null
  messages: string | null // JSON array of {role, content}
  scanRunId: number | null
  briefingId: number | null
  isError: number // 0 or 1
}

export type AIAnalysisStructuredResultStatus = 'completed' | 'parse_failed'

export interface AIAnalysisStructuredResultRow {
  id: number
  sessionId: number
  schemaVersion: number
  status: AIAnalysisStructuredResultStatus
  summary: string | null
  confidence: number | null
  primaryTheme: string | null
  themesJson: string
  candidateStocksJson: string
  riskFactorsJson: string
  verificationItemsJson: string
  sourceRefsJson: string
  rawJson: string | null
  errorMessage: string | null
  generatedAt: number | null
  updatedAt: number
}

export type MorningAuctionInsightStatus = 'completed' | 'partial' | 'failed'
export type MorningAuctionChipStatus = 'available' | 'missing' | 'insufficient'
export type MorningAuctionVerificationStatus = 'pending' | 'checked' | 'blocked' | 'not_applicable'

export type MorningAuctionThemeAttributionState = 'direct' | 'resonance' | 'unresolved'
export type MorningAuctionThemeConfidence = 'high' | 'medium' | 'low' | 'none'

export interface MorningAuctionThemePeer {
  tsCode: string
  stockName: string
  auctionPctChg: number
  auctionAmount: number
}

export interface MorningAuctionThemeEvidence {
  name: string
  score: number
  direct: boolean
  peerCount: number
  activePeerCount: number
  averageAuctionPct: number | null
  totalAuctionAmount: number
  peers: MorningAuctionThemePeer[]
  basis: string[]
}

export interface MorningAuctionThemeAttribution {
  state: MorningAuctionThemeAttributionState
  confidence: MorningAuctionThemeConfidence
  primary: MorningAuctionThemeEvidence | null
  resonance: MorningAuctionThemeEvidence[]
  staticThemes: string[]
  allThemes: string[]
  directReason: string | null
  sourceTradeDate: string | null
  summary: string
}

export type MorningAuctionMarketThemeState =
  | 'confirmed_continuation'
  | 'unconfirmed_continuation'
  | 'new_rotation'
  | 'isolated_risk'
  | 'auction_only'
  | 'insufficient'

export interface MorningAuctionMarketThemeStock {
  tsCode: string
  stockName: string
  auctionPctChg: number
  auctionAmount: number
  role: 'primary' | 'resonance'
}

export interface MorningAuctionMarketThemeFlow {
  tradeDate: string
  boardCode: string
  boardName: string
  mainNetInflow: number
  mainNetInflowRate: number | null
  weightedChange: number
  breadthRate: number | null
  matchKind: 'name' | 'member_overlap'
}

export interface MorningAuctionMarketTheme {
  name: string
  aliases: string[]
  state: MorningAuctionMarketThemeState
  score: number
  confidence: number
  stockCodes: string[]
  stocks: MorningAuctionMarketThemeStock[]
  auction: {
    candidateCount: number
    activeCandidateCount: number
    primaryCandidateCount: number
    directCandidateCount: number
    medianPctChg: number | null
    totalAuctionAmount: number
    leaderConcentration: number | null
    limitUpCount: number
  }
  flow: MorningAuctionMarketThemeFlow | null
  summary: string
  basis: string[]
  risks: string[]
}

export interface MorningAuctionMarketThemeSummary {
  status: 'ready' | 'no_verified_flow' | 'no_auction_theme'
  flowTradeDate: string | null
  candidateStockCount: number
  attributedStockCount: number
  coverageRate: number | null
  summary: string
  themes: MorningAuctionMarketTheme[]
}

export interface MorningAuctionVerificationItem {
  key: string
  label: string
  status: MorningAuctionVerificationStatus
  source: string
  reason: string
  updatedAt: number
  checkedByUser?: boolean
  chipEvidence?: ChipStructureSummary
  themeAttribution?: MorningAuctionThemeAttribution
}

export interface MorningAuctionInsightRow {
  id: number
  tradeDate: string
  tsCode: string
  stockName: string
  poolKey: string
  schemaVersion: number
  score: number
  scoreBreakdownJson: string
  entryReasonsJson: string
  verificationItemsJson: string
  riskFlagsJson: string
  intradayPreviewJson: string | null
  backtestSummaryJson: string | null
  chipStatus: MorningAuctionChipStatus
  status: MorningAuctionInsightStatus
  errorMessage: string | null
  generatedAt: number
  updatedAt: number
}

export interface DataSourceConfigRow {
  id: 1
  tushareTokenEncrypted: Buffer | null
  tushareEnabled: number // 0 or 1
}

export interface StockInfoRow {
  stockCode: string
  stockName: string
  fetchedAt: number
}

export interface StockPriceCacheRow {
  stockCode: string
  tradeDate: string // YYYYMMDD
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  amount: number | null // 成交额（千元），来自 Tushare amount 字段
  fetchedAt: number // UTC milliseconds
}

export interface DailyArchiveRow {
  date: string // YYYY-MM-DD
  totalCount: number
  unreadCount: number
  criticalCount: number
  uncertainTimeCount: number
  updatedAt: number
}

export interface TrendForecastRow {
  id: number
  stockCode: string
  type: 'today' | 'morrow'
  points: string // JSON array of {time, price}
  aiReason: string | null
  provider: string | null
  model: string | null
  createdAt: number // UTC milliseconds
  targetDate: string | null // YYYYMMDD, 实际预测目标交易日
  backtestDirection: number | null // 0 or 1
  backtestCloseDeviation: number | null // percentage
  backtestMAPE: number | null // percentage
  backtestPearson: number | null // -1 ~ +1
  backtestAt: number | null // UTC milliseconds
  // FR-163f: 结构化 AI 输出
  direction: string | null // 'up' | 'down' | 'flat'
  confidence: number | null // 0-100 置信度
  keySupport: number | null // 关键支撑位
  keyResistance: number | null // 关键阻力位
  // FR-174: 用户反馈再次预测链路
  parentForecastId: number | null
  userFeedback: string | null
  // FR-188: 预测准确率增强闭环
  inputSnapshot: string | null
  errorAnalysis: string | null
  userOutcomeTag: 'valid' | 'invalid' | 'uncertain' | null
  userOutcomeNote: string | null
  userOutcomeUpdatedAt: number | null
}

export interface IntradayCacheRow {
  stockCode: string
  tradeDate: string // YYYYMMDD
  points: string // JSON array of {time, price, volume}
  fetchedAt: number // UTC milliseconds
}

// FR-123: 个股分钟级 K 线缓存（Tushare 374 rt_min）
export interface StockMinuteCacheRow {
  stockCode: string // 6 位纯数字，如 '600036'
  tradeDate: string // YYYYMMDD（北京时间交易日）
  tsMinute: string // HH:mm（北京时间）
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  vol: number | null // 成交量（手）
  amount: number | null // 成交额（千元）
  fetchedAt: number // UTC milliseconds
}

export interface BacktestMetrics {
  direction: 0 | 1
  closeDeviation: number // percentage
  mape: number // percentage
  pearson: number // -1 ~ +1
  errorAnalysis?: string | null // JSON, FR-188 误差归因
}

// ──────────────────────────────────────────────────────────
// FR-124 短线策略数据基础设施: 5 个新表 + 信号表行类型
// ──────────────────────────────────────────────────────────

/** 涨停板每日明细（来自 Tushare limit_list_d） */
export interface LimitListDailyRow {
  tradeDate: string // YYYYMMDD
  tsCode: string // 含交易所后缀
  name: string | null
  close: number | null
  pctChg: number | null
  amount: number | null
  floatMv: number | null
  totalMv: number | null
  turnoverRatio: number | null
  fdAmount: number | null // 封单金额
  firstTime: string | null // HH:mm:ss
  lastTime: string | null
  openTimes: number | null // 开板次数
  upStat: string | null // 连板属性 e.g. "3/5"
  limitTimes: number | null // 连板数
  limit: string | null // 'U' / 'D' / 'Z'
  fetchedAt: number
}

/** 开盘啦榜单每日明细（来自 Tushare kpl_list，一行对应一只个股） */
export interface KplListRow {
  tradeDate: string
  tsCode: string
  name: string | null
  luTime: string | null     // 涨停时间
  luDesc: string | null     // 涨停原因
  tag: string | null        // 涨停/炸板/跌停/自然涨停/竞价
  theme: string | null      // 板块（题材，逗号分隔可多个）
  bidAmount: number | null  // 竞价成交额（元）
  status: string | null     // 状态：首板 / N连板
  bidTurnover: number | null // 竞价换手%
  bidPctChg: number | null  // 竞价涨幅%
  pctChg: number | null     // 涨跌幅%
  fetchedAt: number
}

/** 集合竞价实时快照（来自 Tushare stk_auction，09:25~09:29 可拉取） */
export interface StkAuctionRow {
  tsCode: string
  tradeDate: string
  vol: number | null        // 竞价成交量（股）
  price: number | null      // 竞价成交均价（元）
  amount: number | null     // 竞价成交金额（元）
  preClose: number | null   // 昨收价（元）
  turnoverRate: number | null // 竞价换手率（%）
  volumeRatio: number | null  // 量比
  floatShare: number | null   // 流通股本（万股）
  fetchedAt: number
}

/** 开盘啦概念成分股映射（来自 Tushare kpl_concept_cons） */
export interface KplConceptMembersRow {
  conCode: string
  conName: string | null
  tsCode: string
  name: string | null
  hotNum: number | null
  desc: string | null
  fetchedAt: number
}

/** 龙虎榜每日明细（来自 Tushare top_list） */
export interface TopListDailyRow {
  tradeDate: string
  tsCode: string
  name: string | null
  close: number | null
  pctChange: number | null
  turnoverRate: number | null
  amount: number | null
  lSell: number | null
  lBuy: number | null
  lAmount: number | null
  netAmount: number | null
  netRate: number | null
  amountRate: number | null
  floatValues: number | null
  reason: string | null
  fetchedAt: number
}

/** 龙虎榜机构席位（来自 Tushare top_inst） */
export interface TopInstDailyRow {
  tradeDate: string
  tsCode: string
  exalter: string | null // 席位名称
  side: number | null // 0 买入 1 卖出
  buy: number | null
  buyRate: number | null
  sell: number | null
  sellRate: number | null
  netBuy: number | null
  reason: string | null
  fetchedAt: number
}

export type TopInstCoverageStatus = 'success' | 'failed'

export interface TopInstSyncCoverageRow {
  tradeDate: string
  status: TopInstCoverageStatus
  rowCount: number
  errorCode: string | null
  attemptedAt: number
  completedAt: number | null
}

/** 个股资金流向（来自 Tushare moneyflow） */
export interface MoneyFlowDailyRow {
  tsCode: string
  tradeDate: string
  buySmVol: number | null
  buySmAmount: number | null
  sellSmVol: number | null
  sellSmAmount: number | null
  buyMdVol: number | null
  buyMdAmount: number | null
  sellMdVol: number | null
  sellMdAmount: number | null
  buyLgVol: number | null
  buyLgAmount: number | null
  sellLgVol: number | null
  sellLgAmount: number | null
  buyElgVol: number | null
  buyElgAmount: number | null
  sellElgVol: number | null
  sellElgAmount: number | null
  netMfVol: number | null
  netMfAmount: number | null
  fetchedAt: number
}

export type ScreenerSignalKey = 'crossUp' | 'volAmplified' | 'bullTrend' | 'macdBull' | 'hasTurnover' | 'moneyInflow'
export type ScreenerTieBreaker = 'pctChg' | 'turnoverRate' | 'amount'

export interface ScreenerRankBreakdownItem {
  key: ScreenerSignalKey
  label: string
  matched: boolean
  weight: number
  strength: number
  contribution: number
}

export interface ScreenerMoneyFlowSummary {
  source: 'real' | 'estimated' | 'none'
  mainNetInflow: number | null
  mainNetInflowRatio: number | null
  netMfAmount: number | null
  detail?: {
    small: { buy: number | null; sell: number | null }
    medium: { buy: number | null; sell: number | null }
    large: { buy: number | null; sell: number | null }
    extraLarge: { buy: number | null; sell: number | null }
  }
}

/** 短线策略信号统一存储 */
export interface ShortTermSignalRow {
  id: number
  strategy: string // e.g. 'morningAuction.threeOne' / 'closingHalfHour' / ...
  tsCode: string | null
  name: string | null
  triggerAt: number | null // UTC ms
  tradeDate: string | null // YYYYMMDD
  signalStrength: number | null // 0~100
  signalMeta: string | null // JSON string
  createdAt: number
}

export type ShortTermSubTab =
  | 'morningAuction'
  | 'closingHalfHour'
  | 'limitBoardMonitor'
  | 'secondBoardLeader'
  | 'firstYinDip'
  | 'dipBuyRadar'
  | 'strategyLab'
  | 'personalScreener'
  | 'chipMonitor'
  | 'conditionBlocks'
  | 'strategyBacktest'

export type StrategyLabStrategySource = 'screener' | 'conditionBlocks' | 'custom'
export type StrategyLabStrategyStatus = 'draft' | 'ready' | 'disabled'
export type StrategyLabRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface StrategyLabStrategyRow {
  id: number
  strategyKey: string
  name: string
  description: string | null
  source: StrategyLabStrategySource
  status: StrategyLabStrategyStatus
  enabled: number
  isBuiltin: number
  version: number
  ruleDraftJson: string
  runConfigJson: string
  actionsJson: string
  lastRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface StrategyLabRunRow {
  id: number
  strategyId: number
  strategyKey: string
  strategyName: string
  source: StrategyLabStrategySource
  status: StrategyLabRunStatus
  dateStart: string | null
  dateEnd: string | null
  runConfigJson: string
  summaryJson: string | null
  errorMessage: string | null
  backtestRunId: number | null
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface StrategyLabMatchRow {
  id: number
  runId: number
  strategyId: number
  strategyKey: string
  source: StrategyLabStrategySource
  tsCode: string
  stockName: string | null
  tradeDate: string
  score: number
  signalStrength: number | null
  matchedFrom: string
  evidenceJson: string
  actionJson: string | null
  createdAt: number
}

/** 筹码监控股池行（chip_monitor_stocks 表） */
export interface ChipMonitorStockRow {
  tsCode: string
  source: 'watchlist' | 'screener' | 'morningAuction' | 'portfolio'
  stockName: string | null
  addedAt: number
}

/** 筹码监控计算结果行（chip_monitor_results 表） */
export interface ChipMonitorResultRow {
  tsCode: string
  source?: 'watchlist' | 'screener' | 'morningAuction' | 'portfolio' | null
  stockName?: string | null
  tradeDate: string         // YYYYMMDD
  mode?: 'relative' | 'absolute'
  bottomPct: number | null  // 底部筹码占比（%）
  bottomAvgCost: number | null // 底部加权均价（元）
  loosening1d: number | null   // 较前 1 日松动（%），正=松动，负=固化
  loosening3d: number | null
  loosening5d: number | null
  loosening1dReason?: 'INSUFFICIENT_HISTORY' | 'LOW_BASE_PCT' | null
  loosening3dReason?: 'INSUFFICIENT_HISTORY' | 'LOW_BASE_PCT' | null
  loosening5dReason?: 'INSUFFICIENT_HISTORY' | 'LOW_BASE_PCT' | null
  updatedAt: number
  pctChg: number | null        // 当日涨跌幅（%），来自 daily_close_cache，辅助判断筹码行为
  turnoverRate: number | null  // 当日换手率（%），来自 daily_close_cache
  currentPrice: number | null  // 现价：盘中由 sharedRtKCache 覆盖，盘后来自 daily_close_cache.close
}

// ── FR-228 P1 筹码结构事实层 ─────────────────────────────────────

export type ChipStructureFreshnessStatus = 'current' | 'stale' | 'unknown'
export type ChipStructureCompletenessStatus = 'complete' | 'partial' | 'blocked'
export type ChipStructureConsistencyStatus = 'matched' | 'warning' | 'not_comparable'
export type ChipStructurePercentUnit = 'percent' | 'ratio'
export type ChipStructureMissingReason =
  | 'CYQ_PERF_MISSING'
  | 'CYQ_CHIPS_MISSING'
  | 'DAILY_CLOSE_MISSING'
  | 'INSUFFICIENT_HISTORY'
  | 'DATE_MISMATCH'
  | 'UPSTREAM_UNAVAILABLE'
  | 'QUOTA_INSUFFICIENT'

/** cyq_perf_cache 表行。winnerRate 保留上游原值，单位由 winnerRateUnit 明确声明。 */
export interface CyqPerfCacheRow {
  tsCode: string
  tradeDate: string
  hisLow: number | null
  hisHigh: number | null
  cost5Pct: number | null
  cost15Pct: number | null
  cost50Pct: number | null
  cost85Pct: number | null
  cost95Pct: number | null
  weightAvg: number | null
  winnerRate: number | null
  winnerRateUnit: ChipStructurePercentUnit
  fetchedAt: number
}

export interface ChipStructureMetrics {
  winnerRatePct: number | null
  recomputedWinnerRatePct: number | null
  thickProfitPct: number | null
  thinProfitPct: number | null
  trappedPct: number | null
  deepLowPct: number | null
  costConcentration: number | null
  costDeviationPct: number | null
  consistencyDeviationPct: number | null
}

export interface ChipStructureSnapshot {
  tradeDate: string | null
  metrics: ChipStructureMetrics
  freshnessStatus: ChipStructureFreshnessStatus
  completenessStatus: ChipStructureCompletenessStatus
  consistencyStatus: ChipStructureConsistencyStatus
  missingReasons: ChipStructureMissingReason[]
}

export type ChipStructureMetricName =
  | 'winnerRate'
  | 'thickProfitPct'
  | 'thinProfitPct'
  | 'trappedPct'
  | 'deepLowPct'
  | 'concentration'
  | 'costDeviationPct'

export interface ChipMetricChange {
  days: 1 | 3 | 5 | 12
  value: number | null
  reason: 'INSUFFICIENT_HISTORY' | null
}

export interface ChipStructureSummary {
  tsCode: string
  stockName: string | null
  tradeDate: string | null
  dateRelation: 'same_day' | 'history' | 'missing'
  winnerRate: number | null
  thickProfitPct: number | null
  thinProfitPct: number | null
  trappedPct: number | null
  deepLowPct: number | null
  concentration: number | null
  costDeviationPct: number | null
  bottomPct: number | null
  bottomAvgCost: number | null
  loosening1d: number | null
  loosening3d: number | null
  loosening5d: number | null
  pctChg: number | null
  turnoverRate: number | null
  primaryChange: {
    metric: ChipStructureMetricName
    days: 1 | 3 | 5 | 12
    value: number
  } | null
  freshnessStatus: ChipStructureFreshnessStatus
  completenessStatus: ChipStructureCompletenessStatus
  consistencyStatus: ChipStructureConsistencyStatus
  missingReasons: ChipStructureMissingReason[]
  updatedAt: number | null
}

export type ChipInstitutionCoverageStatus =
  | 'available'
  | 'no_record'
  | 'not_synced'
  | 'failed'

export interface ChipInstitutionRecord {
  institutionName: string
  buyAmount: number | null
  sellAmount: number | null
  netAmount: number | null
  buyRate: number | null
  sellRate: number | null
  reason: string | null
}

export interface ChipInstitutionEvidence {
  tradeDate: string | null
  coverageStatus: ChipInstitutionCoverageStatus
  buyAmount: number | null
  sellAmount: number | null
  netAmount: number | null
  institutionCount: number
  records: ChipInstitutionRecord[]
  limitation: string
  updatedAt: number | null
}

export interface ChipStructureDetail extends ChipStructureSummary {
  close: number | null
  priceRange: { historicalLow: number | null; historicalHigh: number | null }
  costPercentiles: {
    cost5Pct: number | null
    cost15Pct: number | null
    cost50Pct: number | null
    cost85Pct: number | null
    cost95Pct: number | null
    weightedAvg: number | null
  }
  structure: {
    winnerRateFromPerf: number | null
    winnerRateFromChips: number | null
    thickProfitPct: number | null
    thinProfitPct: number | null
    trappedPct: number | null
    deepLowPct: number | null
    concentration: number | null
    costDeviationPct: number | null
  }
  changes: Record<ChipStructureMetricName, ChipMetricChange[]>
  consistency: {
    officialWinnerRate: number | null
    recomputedWinnerRate: number | null
    differencePctPoint: number | null
    thresholdPctPoint: number
    status: ChipStructureConsistencyStatus
    reason: string | null
  }
  chips: Array<{ price: number; percent: number }>
  institutionEvidence: ChipInstitutionEvidence
  legacy: {
    mode: 'relative' | 'absolute'
    bottomPct: number | null
    bottomAvgCost: number | null
    loosening1d: number | null
    loosening3d: number | null
    loosening5d: number | null
  } | null
  sources: Array<{
    source: 'cyq_perf' | 'cyq_chips' | 'daily_close' | 'chip_monitor'
    tradeDate: string | null
    fetchedAt: number | null
    status: 'available' | 'missing' | 'stale'
  }>
}

// ── FR-151a 个性选股缓存表行类型 ────────────────────────────────────

/** stock_basic 全量接口行（来自 Tushare stock_basic，每周一全量更新） */
export interface StockBasicCacheRow {
  tsCode: string
  name: string | null
  industry: string | null
  market: string | null       // 主板 / 创业板 / 科创板 / 北交所
  listStatus: string | null   // 'L' 上市 / 'D' 退市 / 'P' 暂停
  circFloat: number | null    // 流通股本（万股），用于计算换手率
  updatedAt: number           // UTC ms
}

// ── FR-153 多源题材成分股行类型 ────────────────────────────────────

/** 同花顺题材指数目录（ths_concept_index 表，来自 Tushare ths_index） */
export interface ThsConceptIndexRow {
  tsCode: string      // 同花顺概念代码，如 'BK0001'
  name: string | null
  count: number | null // 成分股数量
  syncedAt: number    // UTC ms，上次全量同步时间
}

/** 同花顺题材成分股（ths_concept_members 表，来自 Tushare ths_member） */
// 标准语义：ts_code=股票代码，con_code=概念代码
export interface ThsConceptMembersRow {
  tsCode: string     // 股票代码（含交易所后缀）
  conCode: string    // 概念代码
  conName: string | null // 概念名称
}

/** 东方财富题材成分股（dc_concept_members 表，来自 Tushare dc_concept_cons） */
// 按日期存储，支持历史查询
export interface DcConceptMembersRow {
  tsCode: string        // 股票代码（含交易所后缀）
  tradeDate: string     // YYYYMMDD
  name: string | null   // 股票名称
  themeCode: string     // 题材代码
  themeName: string | null // 题材名称
  industryCode: string | null // 行业代码
  industry: string | null     // 行业名称
}

/** 选股结果持久化行（stock_screener_results 表） */
export interface StockScreenerResultRow {
  tsCode: string
  tradeDate: string           // YYYYMMDD
  stockName: string | null
  close: number | null
  pctChg: number | null
  turnoverRate: number | null // 换手率（%），= vol / (circFloat * 10000) * 100
  vol: number | null          // 成交量（手）
  amount: number | null       // 成交额（元）
  signalScore: number         // FR-209 后为 0–6，满足的信号数
  conditionsMet: string | null // JSON string，如 '["天使魔鬼金叉","量能放大"]'
  concepts: string | null     // JSON string，题材名称数组
  rankScore?: number | null
  rankBreakdownJson?: string | null
  moneyflowJson?: string | null
  signalStrengthJson?: string | null
}

/** 个性选股 AI 解读缓存行（screener_insights 表） */
export interface ScreenerInsightRow {
  id: number
  tradeDate: string
  tsCode: string
  stockName: string | null
  evidenceHash: string
  evidenceJson: string
  insightJson: string
  provider: AIProvider | null
  model: string | null
  usageJson: string | null
  finishReason: string | null
  complianceBlocked: number
  createdAt: number
  updatedAt: number
}

// ── FR-211 统一策略级回测引擎行类型 ───────────────────────────────

export type StrategyBacktestRunStatus = 'running' | 'completed' | 'failed'
export type StrategyBacktestTradeStatus = 'executed' | 'data_insufficient'

export interface StrategyBacktestRunRow {
  id: number
  strategyKey: string
  dateStart: string
  dateEnd: string
  planJson: string
  paramHash: string
  reportJson: string
  status: StrategyBacktestRunStatus
  errorMessage: string | null
  createdAt: number
  completedAt: number | null
}

export interface StrategyBacktestTradeRow {
  runId: number
  strategyKey: string
  tsCode: string
  stockName?: string | null
  signalDate: string
  entryDate: string | null
  entryPrice: number | null
  exitDate: string | null
  exitPrice: number | null
  grossReturnPct: number | null
  netReturnPct: number | null
  returnPct: number | null
  exitReason: string | null
  status: StrategyBacktestTradeStatus
  strength: number | null
  metaJson: string | null
}

// ── FR-212 条件积木策略引擎行类型 ───────────────────────────────

export type ConditionBlockScanRunStatus = 'running' | 'completed' | 'failed'
export type ConditionBlockDataStatus = 'complete' | 'partial' | 'data_insufficient'

export interface ConditionBlockTemplateRow {
  id: number
  templateKey: string
  name: string
  description: string | null
  version: number
  enabled: number
  templateJson: string
  createdAt: number
  updatedAt: number
}

export interface ConditionBlockScanRunRow {
  id: number
  templateId: number
  templateKey: string
  templateVersion: number
  dateStart: string
  dateEnd: string
  scopeJson: string
  paramHash: string
  status: ConditionBlockScanRunStatus
  errorMessage: string | null
  totalStocks: number
  matchedCount: number
  summaryJson: string | null
  createdAt: number
  completedAt: number | null
}

export interface ConditionBlockMatchRow {
  id: number
  runId: number
  templateKey: string
  templateVersion: number
  tsCode: string
  stockName: string | null
  tradeDate: string
  windowStart: string | null
  windowEnd: string | null
  totalScore: number
  dataStatus: ConditionBlockDataStatus
  evidenceJson: string
  createdAt: number
}

// ── FR-165 统一决策信号行类型 ────────────────────────────────────

export type DecisionSignalSourceModule =
  | 'news'
  | 'ai'
  | 'short_term'
  | 'trend'
  | 'market'
  | 'sector_flow'
  | 'manual'

export type DecisionSignalType = 'ALERT' | 'OPPORTUNITY' | 'RISK' | 'INFO'
export type DecisionSignalDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export type DecisionSignalStatus = 'NEW' | 'READ' | 'WATCHING' | 'DISMISSED' | 'EXPIRED'
export type DecisionSignalResolution =
  | 'RESOLVED_VALID'
  | 'RESOLVED_INVALID'
  | 'RESOLVED_MISSED'
  | 'RESOLVED_DUPLICATE'
  | 'RESOLVED_DATA_ISSUE'
  | 'RESOLVED_MANUAL'
export type DecisionSignalEventType =
  | 'CREATED'
  | 'UPDATED'
  | 'READ'
  | 'WATCHED'
  | 'DISMISSED'
  | 'EXPIRED'
  | 'RESOLVED'
  | 'REOPENED'
  | 'NOTE_ADDED'

export interface DecisionSignalRow {
  id: number
  sourceModule: DecisionSignalSourceModule
  strategyKey: string
  tsCode: string | null
  stockName: string | null
  conceptCode: string | null
  conceptName: string | null
  signalType: DecisionSignalType
  direction: DecisionSignalDirection
  priority: number
  score: number | null
  confidence: number | null
  title: string
  summary: string
  reasonJson: string | null
  sourceRefJson: string | null
  status: DecisionSignalStatus
  dedupKey: string
  signalTime: number
  expireAt: number | null
  createdAt: number
  updatedAt: number
  firstSeenAt: number | null
  lastSeenAt: number | null
  occurrenceCount: number
  acknowledgedAt: number | null
  watchedAt: number | null
  dismissedAt: number | null
  resolvedAt: number | null
  resolution: DecisionSignalResolution | null
  resolutionNote: string | null
}

export interface DecisionSignalEventRow {
  id: number
  signalId: number
  eventType: DecisionSignalEventType
  fromStatus: DecisionSignalStatus | null
  toStatus: DecisionSignalStatus | null
  resolution: DecisionSignalResolution | null
  reason: string | null
  note: string | null
  createdAt: number
}

// ── FR-236 复盘报告快照 ────────────────────────────────────────

export type DecisionReviewReportKind = 'daily' | 'weekly'

export interface DecisionReviewReportSnapshot {
  kind: DecisionReviewReportKind
  rangeDays: number
  generatedAt: number
  title: string
  headline: string
  summary: {
    holdingCount: number
    portfolioSignalCount: number
    processedCount: number
    openRiskCount: number
    evidenceGapCount: number
    followUpCount: number
  }
  processed: unknown[]
  openRisks: unknown[]
  evidenceGaps: unknown[]
  followUps: unknown[]
  disclaimer: string
  emptyDay: boolean
}

export interface DecisionReviewReportRow {
  id: string
  requestId: string
  kind: DecisionReviewReportKind
  periodStart: string
  periodEnd: string
  rangeDays: number
  generatedAt: number
  savedAt: number
  schemaVersion: number
  title: string
  headline: string
  openRiskCount: number
  evidenceGapCount: number
  followUpCount: number
  versionNumber: number
  snapshotJson: string
}

export interface SavedReviewReportSummary extends Omit<DecisionReviewReportRow, 'requestId' | 'snapshotJson'> {
  versionCount: number
}

export interface SavedReviewReportDetail extends SavedReviewReportSummary {
  snapshot: DecisionReviewReportSnapshot
}

// ── FR-237 决策判断账本 ────────────────────────────────────────

export type DecisionJudgmentTag = 'watch' | 'risk_off' | 'noise' | 'insufficient' | 'done'

export interface DecisionJudgmentEvidenceItem {
  key: string
  label: string
  status: 'ready' | 'missing' | 'blocked'
  detail: string
}

export interface DecisionJudgmentEvidenceSnapshot {
  primaryTitle: string
  primarySummary: string
  sourceCount: number
  maxPriority: number
  trustHint: string
  evidence: DecisionJudgmentEvidenceItem[]
}

export interface DecisionJudgmentRow {
  id: string
  requestId: string
  judgmentGroupId: string
  versionNumber: number
  tsCode: string
  stockName: string | null
  tag: DecisionJudgmentTag
  note: string
  sourceSignalId: number | null
  relatedSignalIdsJson: string
  evidenceSnapshotJson: string
  reviewDueAt: number | null
  createdAt: number
  schemaVersion: number
}

export interface DecisionJudgmentSummary extends Omit<DecisionJudgmentRow, 'requestId' | 'relatedSignalIdsJson' | 'evidenceSnapshotJson'> {
  versionCount: number
  sourceSignalAvailable: boolean
}

export interface DecisionJudgmentDetail extends DecisionJudgmentSummary {
  relatedSignalIds: number[]
  evidenceSnapshot: DecisionJudgmentEvidenceSnapshot
  versions: DecisionJudgmentSummary[]
}

// ── FR-238 T+N 判断回访 ───────────────────────────────────────

export type DecisionJudgmentFollowUpAction = 'maintain' | 'revise' | 'close'

export interface DecisionJudgmentFollowUpTask {
  judgmentId: string
  judgmentGroupId: string
  tsCode: string
  stockName: string | null
  tag: DecisionJudgmentTag
  note: string
  reviewDueAt: number
  createdAt: number
  overdueMs: number
  status: 'due'
}

export interface DecisionJudgmentFollowUpRecord {
  id: string
  requestId: string
  sourceJudgmentId: string
  resultJudgmentId: string
  action: DecisionJudgmentFollowUpAction
  note: string
  completedAt: number
  schemaVersion: number
}

// ──────────────────────────────────────────────────────────
// Application-layer types (camelCase, with boolean conversion)
// ──────────────────────────────────────────────────────────

export interface Briefing extends Omit<BriefingRow, 'isRead' | 'isCatchUp'> {
  isRead: boolean
  isCatchUp: boolean
}

export interface Source extends Omit<SourceRow, 'isBuiltIn' | 'isEnabled'> {
  isBuiltIn: boolean
  isEnabled: boolean
}

export interface ScanStatus {
  isScanning: boolean
  lastScanAt: number | null
  nextScanAt: number | null
  currentRun: ScanRunRow | null
}

export interface BriefingListOptions {
  date?: string // YYYY-MM-DD filter
  impactRating?: ImpactRating | null
  sourceId?: number | null
  isRead?: boolean | null
  search?: string | null
  publicationTimeScope?: PublicationTimeScope
  limit?: number
  offset?: number
}

export interface BriefingSourceStat {
  sourceId: number
  sourceName: string
  total: number
  unread: number
  highImpact: number
}

export interface BriefingListResult {
  items: Briefing[]
  total: number
  unreadCount: number
  sourceStats: BriefingSourceStat[]
}

// ──────────────────────────────────────────────────────────────────────────
// FR-164: 长线趋势相关行类型
// ──────────────────────────────────────────────────────────────────────────

/** trend_watchlist 表行 */
export interface TrendWatchlistRow {
  tsCode: string
  stockName: string
  groupTag: string
  addedAt: number
  /** 一级大类，如 "AI算力" / "半导体设备" */
  category: string
  /** 细分赛道，如 "光模块"，与 tsCode 构成复合主键 */
  subCategory: string
  /** 自定义备注文本 */
  notes: string
}

/** trend_scores 表行（每日七维评分存档） */
export interface TrendScoreRow {
  tsCode: string
  tradeDate: string
  maScore: number | null
  maAbove60: number | null
  alphaScore: number | null
  drawdown: number | null
  turnoverRatio: number | null
  macdAboveZero: number | null
  bollAboveMid: number | null
  totalScore: number | null
  computedAt: number | null
}

/** trend_alerts 表行 */
export interface TrendAlertRow {
  id?: number
  tsCode: string
  stockName: string
  alertType: string
  alertDate: string
  price: number | null
  refPrice: number | null
  createdAt: number
}

/** portfolio_stocks 表行（FR-168 持仓批量 AI 预测） */
export interface PortfolioStockRow {
  tsCode: string
  stockName: string
  addedAt: number
  costPrice: number | null
}

/** supply_chain_edges 表行（FR-171 产业链传导分析） */
export interface SupplyChainEdgeRow {
  id: number
  upstreamConcept: string
  downstreamConcept: string
  relationLabel: string
  chainGroup: string
  sortOrder: number
  isEnabled: number  // 0 或 1
}
