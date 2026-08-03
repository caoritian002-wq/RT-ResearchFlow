import type Database from 'better-sqlite3'
import type {
  IndustryResearchCompanyCandidateRow,
  IndustryResearchGenerationRunRow,
  ResearchCompanyCandidateResolution,
  ResearchEvidenceCandidateRow,
  ResearchEvidenceCandidateStatus,
  ResearchGenerationStage,
  ResearchGenerationStatus,
  ResearchWebSearchConfigRow,
  ResearchWebSearchProviderId,
} from './types'

export interface GenerationRunCreateInput {
  id: string
  projectId: string
  researchQuestion: string
  skillId: string
  skillContentHash: string
  skillRuleVersion?: string | null
  scopeJson?: string | null
  enableWebRetrieval?: boolean
  stageArtifactsJson?: string
}

export interface GenerationRunProgressInput {
  status?: ResearchGenerationStatus
  currentStage?: ResearchGenerationStage
  lastSuccessfulStage?: ResearchGenerationStage | null
  progressCurrent?: number
  progressTotal?: number
  progressMessage?: string
  cancelRequested?: boolean
  provider?: string | null
  model?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  retryable?: boolean
  stageArtifactsJson?: string
  startedAt?: number | null
  completedAt?: number | null
}

export interface EvidenceCandidateInput {
  id: string
  projectId?: string | null
  runId?: string | null
  query: string
  sourceUrl: string
  title: string
  summary?: string | null
  excerpt?: string | null
  providerId: string
  publishedAt?: string | null
  fetchedAt?: number
  status: ResearchEvidenceCandidateStatus
  failureReason?: string | null
  confirmedAt?: number | null
  sourceKind?: string | null
  isDetailPage?: boolean
  relevanceScore?: number | null
  authorityScore?: number | null
  freshnessScore?: number | null
  rankScore?: number | null
}

export interface CompanyCandidateInput {
  id: string
  runId: string
  projectId: string
  legalNameCandidate: string
  displayName: string
  researchNodeIds?: string[]
  rationale?: string
  matchedSecurities?: Array<{
    tsCode: string
    stockName: string
    exchange: 'SSE' | 'SZSE' | 'BSE'
    matchStatus: 'exact' | 'ambiguous'
  }>
  resolutionStatus?: ResearchCompanyCandidateResolution
  exclusionReason?: string | null
}

const ACTIVE_STATUSES: ResearchGenerationStatus[] = ['queued', 'running']

export function getResearchWebSearchConfig(db: Database.Database): ResearchWebSearchConfigRow | null {
  return db.prepare('SELECT * FROM research_web_search_config WHERE id = 1').get() as ResearchWebSearchConfigRow | null
}

export function saveResearchWebSearchConfig(
  db: Database.Database,
  input: {
    providerId: ResearchWebSearchProviderId
    enabled: boolean
    apiKeyEncrypted?: Buffer | null
    clearApiKey?: boolean
    baseUrl?: string | null
    lastValidatedAt?: number | null
    lastErrorCode?: string | null
  },
): ResearchWebSearchConfigRow {
  const now = Date.now()
  const existing = getResearchWebSearchConfig(db)
  const apiKeyEncrypted = input.clearApiKey
    ? null
    : input.apiKeyEncrypted !== undefined
      ? input.apiKeyEncrypted
      : existing?.api_key_encrypted ?? null
  db.prepare(`
    INSERT INTO research_web_search_config (
      id, provider_id, enabled, api_key_encrypted, base_url, last_validated_at, last_error_code, updated_at
    ) VALUES (
      1, @providerId, @enabled, @apiKeyEncrypted, @baseUrl, @lastValidatedAt, @lastErrorCode, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      provider_id = excluded.provider_id,
      enabled = excluded.enabled,
      api_key_encrypted = excluded.api_key_encrypted,
      base_url = excluded.base_url,
      last_validated_at = excluded.last_validated_at,
      last_error_code = excluded.last_error_code,
      updated_at = excluded.updated_at
  `).run({
    providerId: input.providerId,
    enabled: input.enabled ? 1 : 0,
    apiKeyEncrypted,
    baseUrl: input.baseUrl ?? null,
    lastValidatedAt: input.lastValidatedAt !== undefined
      ? input.lastValidatedAt
      : existing?.last_validated_at ?? null,
    lastErrorCode: input.lastErrorCode !== undefined
      ? input.lastErrorCode
      : existing?.last_error_code ?? null,
    updatedAt: now,
  })
  return getResearchWebSearchConfig(db)!
}

export function createGenerationRun(db: Database.Database, input: GenerationRunCreateInput): IndustryResearchGenerationRunRow {
  const now = Date.now()
  db.prepare(`
    INSERT INTO industry_research_generation_runs (
      id, project_id, research_question, status, current_stage, last_successful_stage,
      progress_current, progress_total, progress_message, cancel_requested,
      skill_id, skill_content_hash, skill_rule_version, provider, model,
      error_code, error_message, retryable, stage_artifacts_json, scope_json,
      enable_web_retrieval, created_at, started_at, completed_at, updated_at
    ) VALUES (
      @id, @projectId, @researchQuestion, 'queued', 'retrieve', NULL,
      0, 7, '等待启动', 0,
      @skillId, @skillContentHash, @skillRuleVersion, NULL, NULL,
      NULL, NULL, 0, @stageArtifactsJson, @scopeJson,
      @enableWebRetrieval, @createdAt, NULL, NULL, @updatedAt
    )
  `).run({
    id: input.id,
    projectId: input.projectId,
    researchQuestion: input.researchQuestion,
    skillId: input.skillId,
    skillContentHash: input.skillContentHash,
    skillRuleVersion: input.skillRuleVersion ?? null,
    stageArtifactsJson: input.stageArtifactsJson ?? '{}',
    scopeJson: input.scopeJson ?? null,
    enableWebRetrieval: input.enableWebRetrieval === false ? 0 : 1,
    createdAt: now,
    updatedAt: now,
  })
  return getGenerationRun(db, input.id)!
}

export function getGenerationRun(db: Database.Database, runId: string): IndustryResearchGenerationRunRow | null {
  return db.prepare('SELECT * FROM industry_research_generation_runs WHERE id = ?').get(runId) as IndustryResearchGenerationRunRow | null
}

export function getLatestGenerationRun(db: Database.Database, projectId: string): IndustryResearchGenerationRunRow | null {
  return db.prepare(`
    SELECT * FROM industry_research_generation_runs
    WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId) as IndustryResearchGenerationRunRow | null
}

export function getLatestSuccessfulGenerationRun(
  db: Database.Database,
  projectId: string,
): IndustryResearchGenerationRunRow | null {
  return db.prepare(`
    SELECT * FROM industry_research_generation_runs
    WHERE project_id = ? AND status = 'succeeded'
    ORDER BY COALESCE(completed_at, updated_at) DESC, created_at DESC
    LIMIT 1
  `).get(projectId) as IndustryResearchGenerationRunRow | null
}

export function getActiveGenerationRun(db: Database.Database, projectId: string): IndustryResearchGenerationRunRow | null {
  return db.prepare(`
    SELECT * FROM industry_research_generation_runs
    WHERE project_id = ? AND status IN ('queued', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(projectId) as IndustryResearchGenerationRunRow | null
}

export function updateGenerationRun(
  db: Database.Database,
  runId: string,
  patch: GenerationRunProgressInput,
): IndustryResearchGenerationRunRow | null {
  const current = getGenerationRun(db, runId)
  if (!current) return null
  const next = {
    status: patch.status ?? current.status,
    currentStage: patch.currentStage ?? current.current_stage,
    lastSuccessfulStage: patch.lastSuccessfulStage === undefined ? current.last_successful_stage : patch.lastSuccessfulStage,
    progressCurrent: patch.progressCurrent ?? current.progress_current,
    progressTotal: patch.progressTotal ?? current.progress_total,
    progressMessage: patch.progressMessage ?? current.progress_message,
    cancelRequested: patch.cancelRequested === undefined ? current.cancel_requested : (patch.cancelRequested ? 1 : 0),
    provider: patch.provider === undefined ? current.provider : patch.provider,
    model: patch.model === undefined ? current.model : patch.model,
    errorCode: patch.errorCode === undefined ? current.error_code : patch.errorCode,
    errorMessage: patch.errorMessage === undefined ? current.error_message : patch.errorMessage,
    retryable: patch.retryable === undefined ? current.retryable : (patch.retryable ? 1 : 0),
    stageArtifactsJson: patch.stageArtifactsJson ?? current.stage_artifacts_json,
    startedAt: patch.startedAt === undefined ? current.started_at : patch.startedAt,
    completedAt: patch.completedAt === undefined ? current.completed_at : patch.completedAt,
    updatedAt: Date.now(),
    id: runId,
  }
  db.prepare(`
    UPDATE industry_research_generation_runs SET
      status = @status,
      current_stage = @currentStage,
      last_successful_stage = @lastSuccessfulStage,
      progress_current = @progressCurrent,
      progress_total = @progressTotal,
      progress_message = @progressMessage,
      cancel_requested = @cancelRequested,
      provider = @provider,
      model = @model,
      error_code = @errorCode,
      error_message = @errorMessage,
      retryable = @retryable,
      stage_artifacts_json = @stageArtifactsJson,
      started_at = @startedAt,
      completed_at = @completedAt,
      updated_at = @updatedAt
    WHERE id = @id
  `).run(next)
  return getGenerationRun(db, runId)
}

export function requestCancelGenerationRun(db: Database.Database, runId: string): IndustryResearchGenerationRunRow | null {
  const current = getGenerationRun(db, runId)
  if (!current) return null
  if (!ACTIVE_STATUSES.includes(current.status)) return current
  return updateGenerationRun(db, runId, {
    cancelRequested: true,
    progressMessage: '已请求取消，等待当前阶段安全停止',
  })
}

export function upsertEvidenceCandidate(db: Database.Database, input: EvidenceCandidateInput): ResearchEvidenceCandidateRow {
  const now = Date.now()
  db.prepare(`
    INSERT INTO research_evidence_candidates (
      id, project_id, run_id, query, source_url, title, summary, excerpt, provider_id,
      published_at, fetched_at, status, failure_reason, confirmed_at,
      source_kind, is_detail_page, relevance_score, authority_score, freshness_score, rank_score,
      created_at, updated_at
    ) VALUES (
      @id, @projectId, @runId, @query, @sourceUrl, @title, @summary, @excerpt, @providerId,
      @publishedAt, @fetchedAt, @status, @failureReason, @confirmedAt,
      @sourceKind, @isDetailPage, @relevanceScore, @authorityScore, @freshnessScore, @rankScore,
      @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      project_id = excluded.project_id,
      run_id = excluded.run_id,
      query = excluded.query,
      source_url = excluded.source_url,
      title = excluded.title,
      summary = excluded.summary,
      excerpt = excluded.excerpt,
      provider_id = excluded.provider_id,
      published_at = excluded.published_at,
      fetched_at = excluded.fetched_at,
      status = excluded.status,
      failure_reason = excluded.failure_reason,
      confirmed_at = excluded.confirmed_at,
      source_kind = excluded.source_kind,
      is_detail_page = excluded.is_detail_page,
      relevance_score = excluded.relevance_score,
      authority_score = excluded.authority_score,
      freshness_score = excluded.freshness_score,
      rank_score = excluded.rank_score,
      updated_at = excluded.updated_at
  `).run({
    id: input.id,
    projectId: input.projectId ?? null,
    runId: input.runId ?? null,
    query: input.query,
    sourceUrl: input.sourceUrl,
    title: input.title,
    summary: input.summary ?? null,
    excerpt: input.excerpt ?? null,
    providerId: input.providerId,
    publishedAt: input.publishedAt ?? null,
    fetchedAt: input.fetchedAt ?? now,
    status: input.status,
    failureReason: input.failureReason ?? null,
    confirmedAt: input.confirmedAt ?? null,
    sourceKind: input.sourceKind ?? 'web_search',
    isDetailPage: input.isDetailPage ? 1 : 0,
    relevanceScore: input.relevanceScore ?? null,
    authorityScore: input.authorityScore ?? null,
    freshnessScore: input.freshnessScore ?? null,
    rankScore: input.rankScore ?? null,
    createdAt: now,
    updatedAt: now,
  })
  return db.prepare('SELECT * FROM research_evidence_candidates WHERE id = ?').get(input.id) as ResearchEvidenceCandidateRow
}

export function listEvidenceCandidates(
  db: Database.Database,
  options: { projectId: string; runId?: string },
): ResearchEvidenceCandidateRow[] {
  if (options.runId) {
    return db.prepare(`
      SELECT * FROM research_evidence_candidates
      WHERE project_id = ? AND run_id = ?
      ORDER BY COALESCE(rank_score, -1) DESC, updated_at DESC, fetched_at DESC
    `).all(options.projectId, options.runId) as ResearchEvidenceCandidateRow[]
  }
  return db.prepare(`
    SELECT * FROM research_evidence_candidates
    WHERE project_id = ?
    ORDER BY COALESCE(rank_score, -1) DESC, updated_at DESC, fetched_at DESC
  `).all(options.projectId) as ResearchEvidenceCandidateRow[]
}

export function getEvidenceCandidate(db: Database.Database, candidateId: string): ResearchEvidenceCandidateRow | null {
  return db.prepare('SELECT * FROM research_evidence_candidates WHERE id = ?').get(candidateId) as ResearchEvidenceCandidateRow | null
}

export function getProjectEvidenceCandidate(
  db: Database.Database,
  projectId: string,
  candidateId: string,
): ResearchEvidenceCandidateRow | null {
  return db.prepare(`
    SELECT candidate.*
    FROM research_evidence_candidates candidate
    INNER JOIN industry_research_generation_runs run
      ON run.id = candidate.run_id AND run.project_id = candidate.project_id
    WHERE candidate.id = ? AND candidate.project_id = ?
  `).get(candidateId, projectId) as ResearchEvidenceCandidateRow | null
}

export function updateEvidenceCandidateStatus(
  db: Database.Database,
  candidateId: string,
  status: ResearchEvidenceCandidateStatus,
): ResearchEvidenceCandidateRow | null {
  const current = getEvidenceCandidate(db, candidateId)
  if (!current) return null
  const now = Date.now()
  db.prepare(`
    UPDATE research_evidence_candidates
    SET status = ?, confirmed_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status, status === 'confirmed' ? now : null, now, candidateId)
  return getEvidenceCandidate(db, candidateId)
}

export function upsertCompanyCandidate(db: Database.Database, input: CompanyCandidateInput): IndustryResearchCompanyCandidateRow {
  const now = Date.now()
  db.prepare(`
    INSERT INTO industry_research_company_candidates (
      id, run_id, project_id, legal_name_candidate, display_name, research_node_ids_json,
      rationale, statement_kind, matched_securities_json, resolution_status, exclusion_reason,
      created_at, updated_at
    ) VALUES (
      @id, @runId, @projectId, @legalNameCandidate, @displayName, @researchNodeIdsJson,
      @rationale, 'estimate', @matchedSecuritiesJson, @resolutionStatus, @exclusionReason,
      @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      legal_name_candidate = excluded.legal_name_candidate,
      display_name = excluded.display_name,
      research_node_ids_json = excluded.research_node_ids_json,
      rationale = excluded.rationale,
      matched_securities_json = excluded.matched_securities_json,
      resolution_status = excluded.resolution_status,
      exclusion_reason = excluded.exclusion_reason,
      updated_at = excluded.updated_at
  `).run({
    id: input.id,
    runId: input.runId,
    projectId: input.projectId,
    legalNameCandidate: input.legalNameCandidate,
    displayName: input.displayName,
    researchNodeIdsJson: JSON.stringify(input.researchNodeIds ?? []),
    rationale: input.rationale ?? '',
    matchedSecuritiesJson: JSON.stringify(input.matchedSecurities ?? []),
    resolutionStatus: input.resolutionStatus ?? 'pending',
    exclusionReason: input.exclusionReason ?? null,
    createdAt: now,
    updatedAt: now,
  })
  return getCompanyCandidate(db, input.id)!
}

export function getCompanyCandidate(db: Database.Database, candidateId: string): IndustryResearchCompanyCandidateRow | null {
  return db.prepare('SELECT * FROM industry_research_company_candidates WHERE id = ?').get(candidateId) as IndustryResearchCompanyCandidateRow | null
}

export function listCompanyCandidates(
  db: Database.Database,
  options: { projectId: string; runId?: string },
): IndustryResearchCompanyCandidateRow[] {
  if (options.runId) {
    return db.prepare(`
      SELECT * FROM industry_research_company_candidates
      WHERE project_id = ? AND run_id = ?
      ORDER BY updated_at DESC
    `).all(options.projectId, options.runId) as IndustryResearchCompanyCandidateRow[]
  }
  return db.prepare(`
    SELECT * FROM industry_research_company_candidates
    WHERE project_id = ?
    ORDER BY updated_at DESC
  `).all(options.projectId) as IndustryResearchCompanyCandidateRow[]
}

export function updateCompanyCandidateResolution(
  db: Database.Database,
  candidateId: string,
  resolutionStatus: ResearchCompanyCandidateResolution,
  exclusionReason: string | null = null,
): IndustryResearchCompanyCandidateRow | null {
  const current = getCompanyCandidate(db, candidateId)
  if (!current) return null
  db.prepare(`
    UPDATE industry_research_company_candidates
    SET resolution_status = ?, exclusion_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(resolutionStatus, exclusionReason, Date.now(), candidateId)
  return getCompanyCandidate(db, candidateId)
}
