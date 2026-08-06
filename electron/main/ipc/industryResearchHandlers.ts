import { app, dialog, ipcMain } from 'electron'
import * as path from 'path'
import { getDb } from '../database/db'
import { getAIConfig } from '../database/aiConfigRepository'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import {
  getLatestResearchProfitBridge,
  listResearchDisclosureEvidence,
  listResearchBusinessExposures,
  listResearchFinancialSyncStates,
  listResearchFinancialTimelineFacts,
  listResearchProfitBridgeItems,
  listResearchProjectCompanies,
  listResearchSecurities,
  saveResearchBusinessExposure,
  saveResearchCompany,
  saveResearchDisclosureEvidence,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../database/industryResearchFinancialRepository'
import {
  deleteResearchProject,
  deleteResearchProjects,
  getResearchProject,
  IndustryResearchProjectDeletionError,
  listResearchEvidence,
  listResearchHypotheses,
  listResearchProjects,
  updateResearchProject,
} from '../database/industryResearchRepository'
import { discoverSkills, loadVerifiedSkillBundle } from '../services/skillService'
import { getIndustryResearchFinancialValidation } from '../services/industryResearchFinancialValidationService'
import { syncIndustryResearchCompanyFinancials } from '../services/industryResearchFinancialSyncService'
import { saveIndustryResearchProfitBridge } from '../services/industryResearchProfitBridgeService'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import {
  IndustryResearchError,
  changeIndustryResearchHypothesisStatus,
  createIndustryResearchProject,
  getIndustryResearchGraph,
  getIndustryResearchReport,
  saveIndustryResearchEvidence,
  saveIndustryResearchGraph,
  saveIndustryResearchHypothesis,
  updateIndustryResearchProject,
} from '../services/industryResearchService'
import {
  cancelIndustryResearchGeneration,
  continueIndustryResearchFinancialCollection,
  confirmProjectEvidenceCandidate,
  createGenerationProgressEmitter,
  ensureGeneratedProjectCompanies,
  expandIndustryResearchCompanyCandidates,
  getGenerationRunView,
  getWebSearchConfigView,
  resolveIndustryResearchCompanyCandidate,
  retryIndustryResearchGeneration,
  saveWebSearchConfigAndView,
  startIndustryResearchGeneration,
  validateConfiguredWebSearch,
} from '../services/industryResearchGenerationService'
import { ResearchToolRuntimeError } from '../services/researchToolRuntime'
import type {
  EvidenceCreator,
  EvidenceDirection,
  EvidenceReliability,
  HypothesisStatus,
  IndustryResearchNodeType,
  IndustryResearchCompanyStatus,
  IndustryResearchFinancialDataset,
  IndustryResearchProfitBridgeItemKey,
  IndustryResearchProfitBridgeStatus,
  ResearchDepth,
  ResearchGenerationStage,
  ResearchProjectStatus,
  ResearchPurpose,
  ResearchSourceType,
  ResearchStatementKind,
  ResearchWebSearchProviderId,
  ResearchChangeCandidateKind,
  ResearchChangeCandidateStatus,
  ResearchChangeSetStatus,
  ResearchDecisionAction,
  ResearchDecisionEventType,
  ResearchEffort,
  ResearchMonitoringFrequency,
  ResearchMonitoringTiming,
  ResearchMonitoringValueKind,
  ResearchTriggerOperator,
  IndustryResearchValuationMethod,
} from '../database/types'
import {
  listChangeCandidates,
  listChangeSets,
} from '../database/industryResearchChangeRepository'
import {
  changeCandidateView,
  changeSetSummary,
  prepareDiscussionChanges,
} from '../services/industryResearchChangeGenerationService'
import { IndustryResearchMergeError, resolveIndustryResearchChangeSets } from '../services/industryResearchMergeService'
import {
  getIndustryResearchSnapshot,
  IndustryResearchSnapshotError,
  listIndustryResearchSnapshots,
} from '../services/industryResearchSnapshotService'
import {
  importIndustryResearchArchive,
  SUPPORTED_RESEARCH_ARCHIVE_TYPE,
} from '../services/industryResearchArchiveImportService'
import { ResearchDiscussionError } from '../services/researchDiscussionContextService'
import {
  adoptIndustryResearchSkillVersion,
  appendIndustryResearchDecisionEvent,
  appendIndustryResearchMonitoringObservation,
  evaluateIndustryResearchDecisionTriggers,
  getIndustryResearchDecisionReplay,
  getIndustryResearchReviewQueue,
  getIndustryResearchSkillAdoption,
  IndustryResearchDecisionError,
  listIndustryResearchDecisions,
  listIndustryResearchDecisionTriggers,
  listIndustryResearchMonitoringItems,
  listIndustryResearchScenarios,
  listIndustryResearchWorkItems,
  resolveIndustryResearchReviewItem,
  resolveIndustryResearchTriggerReview,
  saveIndustryResearchDecisionTrigger,
  saveIndustryResearchMonitoringItem,
  saveIndustryResearchScenarioSet,
  saveIndustryResearchWorkItem,
  type AppendDecisionEventInput,
} from '../services/industryResearchDecisionService'
import {
  buildIndustryResearchMarketContext,
  IndustryResearchMarketError,
  syncIndustryResearchMarketData,
} from '../services/industryResearchMarketService'
import {
  captureIndustryResearchValuationSnapshot,
  previewIndustryResearchValuation,
  type ValuationInputValue,
  type ValuationScenarioInput,
} from '../services/industryResearchValuationService'
import { getTrendScoreRankingSnapshot } from '../services/trendWatchlistService'

const PROJECT_STATUSES = new Set<ResearchProjectStatus>(['draft', 'active', 'review_due', 'archived'])
const DEPTHS = new Set<ResearchDepth>(['quick', 'standard', 'deep'])
const PURPOSES = new Set<ResearchPurpose>(['learning', 'strategy', 'investment'])
const SOURCE_TYPES = new Set<ResearchSourceType>(['manual', 'briefing', 'ai_analysis', 'decision_signal', 'supply_chain'])
const STATEMENT_KINDS = new Set<ResearchStatementKind>(['fact', 'estimate', 'hypothesis'])
const EVIDENCE_DIRECTIONS = new Set<EvidenceDirection>(['support', 'weaken', 'refute', 'neutral'])
const EVIDENCE_RELIABILITIES = new Set<EvidenceReliability>(['primary', 'secondary', 'tertiary', 'unknown'])
const EVIDENCE_CREATORS = new Set<EvidenceCreator>(['human', 'ai', 'import'])
const HYPOTHESIS_STATUSES = new Set<HypothesisStatus>(['open', 'supported', 'weakened', 'refuted', 'reopened'])
const NODE_TYPES = new Set<IndustryResearchNodeType>([
  'industry', 'product', 'material', 'process', 'equipment', 'company', 'country', 'demand',
  'metric', 'stock', 'technology', 'policy', 'hypothesis', 'shock',
])
const COMPANY_STATUSES = new Set<IndustryResearchCompanyStatus>(['candidate', 'watching', 'core', 'excluded'])
const FINANCIAL_DATASETS = new Set<IndustryResearchFinancialDataset>([
  'income', 'balancesheet', 'cashflow', 'fina_indicator', 'fina_audit',
  'forecast', 'express', 'disclosure_date', 'fina_mainbz',
])
const PROFIT_BRIDGE_STATUSES = new Set<IndustryResearchProfitBridgeStatus>(['estimate', 'hypothesis'])
const PROFIT_BRIDGE_ITEM_KEYS = new Set<IndustryResearchProfitBridgeItemKey>([
  'volume', 'price', 'product_mix', 'raw_material', 'depreciation_expense', 'other_business_drag', 'other',
])
const EXPOSURE_STATUSES = new Set(['candidate', 'confirmed', 'not_separable', 'excluded'] as const)
const EXPOSURE_CREATORS = new Set(['human', 'import'] as const)
const MASTER_DATA_SOURCES = new Set(['manual', 'tushare'] as const)
const EXPOSURE_SOURCES = new Set(['manual', 'fina_mainbz'] as const)
const WEB_SEARCH_PROVIDERS = new Set<ResearchWebSearchProviderId>(['tavily', 'bing', 'custom_openai_compatible_search'])
const GENERATION_STAGES = new Set<ResearchGenerationStage>([
  'retrieve', 'scope', 'map', 'evidence', 'hypothesis', 'companies', 'report',
])
const CHANGE_SET_STATUSES = new Set<ResearchChangeSetStatus>(['pending', 'accepted', 'rejected', 'deferred', 'superseded', 'conflicted', 'invalid'])
const CHANGE_CANDIDATE_STATUSES = new Set<ResearchChangeCandidateStatus>(['pending', 'accepted', 'rejected', 'superseded', 'conflicted', 'invalid'])
const CHANGE_CANDIDATE_KINDS = new Set<ResearchChangeCandidateKind>([
  'project', 'node', 'edge', 'evidence', 'hypothesis', 'hypothesis_event', 'company', 'company_exposure', 'follow_up',
])
const RESEARCH_EFFORTS = new Set<ResearchEffort>(['quick_pass', 'standard_validation', 'deep_research'])
const DECISION_ACTIONS = new Set<ResearchDecisionAction>(['continue_research', 'wait_financial_validation', 'wait_price', 'monitor', 'exclude'])
const DECISION_EVENT_TYPES = new Set<ResearchDecisionEventType>(['created', 'maintained', 'upgraded', 'downgraded', 'invalidated', 'closed'])
const RESEARCH_LEVELS = new Set(['low', 'medium', 'high'] as const)
const WORK_ITEM_STATUSES = new Set(['open', 'blocked', 'completed', 'stopped'] as const)
const MONITORING_VALUE_KINDS = new Set<ResearchMonitoringValueKind>(['number', 'text', 'event'])
const MONITORING_FREQUENCIES = new Set<ResearchMonitoringFrequency>(['daily', 'weekly', 'monthly', 'quarterly', 'event_driven'])
const MONITORING_TIMINGS = new Set<ResearchMonitoringTiming>(['leading', 'coincident', 'lagging', 'unknown'])
const MONITORING_STATUSES = new Set(['active', 'paused', 'closed'] as const)
const TRIGGER_OPERATORS = new Set<ResearchTriggerOperator>(['gt', 'gte', 'lt', 'lte', 'eq', 'changed'])
const TRIGGER_STATUSES = new Set(['active', 'disabled'] as const)
const REVIEW_RESOLUTIONS = new Set(['confirm', 'dismiss'] as const)
const VALUATION_METHODS = new Set<IndustryResearchValuationMethod>(['pe', 'pb_roe', 'ev_ebitda', 'dcf', 'sotp', 'nav'])
const VALUATION_SOURCE_KINDS = new Set(['fact', 'assumption'] as const)
const VALUATION_UNITS = new Set([
  'yuan', 'thousand_yuan', 'ten_thousand_yuan', 'hundred_million_yuan',
  'share', 'ten_thousand_shares', 'multiple', 'percent', 'ratio', 'count', 'text',
] as const)
const DATE_PATTERN = /^\d{4}-?\d{2}-?\d{2}$/
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function rankResearchProjectCompanies<T extends {
  status: IndustryResearchCompanyStatus
  trend_score: number | null
}>(companies: T[]): T[] {
  return companies
    .map((company, index) => ({ company, index }))
    .sort((left, right) => {
      const leftExcluded = left.company.status === 'excluded' ? 1 : 0
      const rightExcluded = right.company.status === 'excluded' ? 1 : 0
      if (leftExcluded !== rightExcluded) return leftExcluded - rightExcluded
      const leftKnown = Number.isFinite(left.company.trend_score) ? 1 : 0
      const rightKnown = Number.isFinite(right.company.trend_score) ? 1 : 0
      if (leftKnown !== rightKnown) return rightKnown - leftKnown
      if (leftKnown && rightKnown && left.company.trend_score !== right.company.trend_score) {
        return (right.company.trend_score ?? 0) - (left.company.trend_score ?? 0)
      }
      return left.index - right.index
    })
    .map(({ company }) => company)
}

function listRankedResearchProjectCompanies(db: ReturnType<typeof getDb>, projectId: string) {
  const projectCompanies = listResearchProjectCompanies(db, projectId).map((company) => ({
    ...company,
    display_name: company.short_name || company.legal_name,
    securities: listResearchSecurities(db, company.company_id),
  }))
  const trendScores = getTrendScoreRankingSnapshot(
    db,
    projectCompanies.flatMap((company) => company.securities.map((security) => security.ts_code)),
  )
  return rankResearchProjectCompanies(projectCompanies.map((company) => {
    const rankedSecurities = company.securities
      .map((security, index) => ({ security, index, score: trendScores.get(security.ts_code) }))
      .filter((item) => Number.isFinite(item.score?.totalScore))
      .sort((left, right) => (right.score?.totalScore ?? 0) - (left.score?.totalScore ?? 0) || left.index - right.index)
    const best = rankedSecurities[0]
    return {
      ...company,
      trend_score: best?.score?.totalScore ?? null,
      trend_score_date: best?.score?.dataTime ?? null,
      trend_score_source: best?.score?.dataSource ?? null,
      trend_score_ts_code: best?.security.ts_code ?? null,
    }
  }))
}

function ok(data?: unknown) {
  return data === undefined ? { ok: true } : { ok: true, data }
}

function fail(code: string, message: string) {
  return { ok: false, code, message }
}

function text(value: unknown, name: string, max: number, required = true): string | null {
  if (value == null && !required) return null
  if (typeof value !== 'string') throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  const result = value.trim()
  if ((required && !result) || result.length > max) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return result || null
}

function id(value: unknown, name: string): string {
  const result = text(value, name, 128)!
  if (!ID_PATTERN.test(result)) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return result
}

function uuid(value: unknown, name: string): string {
  const result = text(value, name, 36)!
  if (!UUID_PATTERN.test(result)) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return result
}

function nullableDate(value: unknown, name: string): string | null {
  const result = text(value, name, 10, false)
  if (result && !DATE_PATTERN.test(result)) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return result
}

function enumValue<T extends string>(value: unknown, values: Set<T>, name: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return value as T
}

function array(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return value
}

function idArray(value: unknown, name: string, max = 100): string[] {
  return array(value, name, max).map((item) => id(item, name))
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  }
  return value as Record<string, unknown>
}

function assumptions(value: unknown, name: string): Record<string, number | string | null> {
  const result = record(value, name)
  if (Object.keys(result).length > 100 || Object.values(result).some((item) => item !== null
    && typeof item !== 'string' && (typeof item !== 'number' || !Number.isFinite(item)))) {
    throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  }
  return result as Record<string, number | string | null>
}

function valuationInputs(value: unknown, name: string): Record<string, ValuationInputValue> {
  const source = record(value, name)
  if (Object.keys(source).length > 80) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return Object.fromEntries(Object.entries(source).map(([key, raw]) => {
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(key)) throw new IndustryResearchError('INVALID_PARAM', `${name}.${key} 格式无效`)
    const item = record(raw, `${name}.${key}`)
    const sourceKind = enumValue(item.sourceKind, VALUATION_SOURCE_KINDS, `${name}.${key}.sourceKind`)
    const factId = item.factId == null ? null : id(item.factId, `${name}.${key}.factId`)
    const note = text(item.note, `${name}.${key}.note`, 1000, false)
    if (sourceKind === 'fact' && !factId) {
      throw new IndustryResearchError('INVALID_PARAM', `${name}.${key}.factId 格式无效`)
    }
    if (sourceKind === 'assumption' && !note) {
      throw new IndustryResearchError('INVALID_PARAM', `${name}.${key}.note 格式无效`)
    }
    return [key, {
      value: item.value == null ? null : finiteNumber(item.value, `${name}.${key}.value`, true),
      unit: enumValue(item.unit, VALUATION_UNITS, `${name}.${key}.unit`),
      sourceKind,
      factId,
      note,
    }]
  }))
}

function valuationScenarios(value: unknown): ValuationScenarioInput[] {
  return array(value, 'scenarios', 3).map((raw) => {
    const item = record(raw, 'scenario')
    const name = text(item.name, 'scenario.name', 10)!
    if (!['bear', 'base', 'bull'].includes(name)) throw new IndustryResearchError('INVALID_PARAM', 'scenario.name 格式无效')
    return {
      name: name as ValuationScenarioInput['name'],
      weightPct: item.weightPct == null ? null : finiteNumber(item.weightPct, 'scenario.weightPct', true),
      inputs: valuationInputs(item.inputs ?? item.valuationInputs ?? {}, 'scenario.inputs'),
      factIds: idArray(item.factIds ?? [], 'scenario.factIds'),
    }
  })
}

function finiteNumber(value: unknown, name: string, required = false): number | null {
  if (value == null && !required) return null
  const result = Number(value)
  if (!Number.isFinite(result)) throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return result
}

function integerNumber(value: unknown, name: string, minimum = 0): number {
  const result = finiteNumber(value, name, true)!
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  }
  return result
}

function safeJsonArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  return value
}

function httpUrl(value: unknown, name: string, max: number): string {
  const result = text(value, name, max)!
  try {
    const parsed = new URL(result)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('INVALID_PROTOCOL')
    return result
  } catch {
    throw new IndustryResearchError('INVALID_PARAM', `${name} 格式无效`)
  }
}

function requireProjectCompanyScope(projectId: string, companyId: string): void {
  const scope = getDb().prepare(`
    SELECT 1 FROM industry_research_project_companies
    WHERE project_id = ? AND company_id = ?
  `).get(projectId, companyId)
  if (!scope) throw new IndustryResearchError('NOT_FOUND', '项目公司不存在')
}

function disclosureEvidenceView(evidence: ReturnType<typeof listResearchDisclosureEvidence>[number]) {
  return {
    id: evidence.id,
    companyId: evidence.company_id,
    projectId: evidence.project_id,
    title: evidence.title,
    sourceUrl: evidence.source_url,
    publishedDate: evidence.published_date,
    actualPublishedDate: evidence.actual_published_date,
    excerpt: evidence.excerpt,
    createdBy: evidence.created_by,
    primarySourceConfirmed: evidence.primary_source_confirmed === 1,
    createdAt: evidence.created_at,
    updatedAt: evidence.updated_at,
  }
}

function resolveIndustryResearchSkill() {
  const config = getAIConfig(getDb())
  const builtinDir = app.isPackaged ? path.join(process.resourcesPath, 'skills') : path.join(app.getAppPath(), 'skills')
  const skills = discoverSkills(builtinDir, safeJsonArray(config.customSkillPaths))
  return skills.find((skill) => skill.skillId === 'builtin:industry-chain-research')
    ?? skills.find((skill) => skill.skillId.endsWith(':industry-chain-research'))
    ?? null
}

function resolveIndustryResearchSkillBundle() {
  const skill = resolveIndustryResearchSkill()
  return skill ? loadVerifiedSkillBundle(skill) : null
}

function parseDecisionEventInput(payload: Record<string, unknown>): AppendDecisionEventInput {
  return {
    projectId: id(payload.projectId, 'projectId'),
    companyId: payload.companyId == null ? null : id(payload.companyId, 'companyId'),
    requestId: uuid(payload.requestId, 'requestId'),
    decisionId: uuid(payload.decisionId, 'decisionId'),
    expectedLastEventId: payload.expectedLastEventId == null ? null : id(payload.expectedLastEventId, 'expectedLastEventId'),
    eventType: enumValue(payload.eventType, DECISION_EVENT_TYPES, 'eventType'),
    action: enumValue(payload.action, DECISION_ACTIONS, 'action'),
    rationale: text(payload.rationale, 'rationale', 4000)!,
    dataAsOf: nullableDate(payload.dataAsOf, 'dataAsOf')!,
    valuationDate: nullableDate(payload.valuationDate, 'valuationDate'),
    validUntil: integerNumber(payload.validUntil, 'validUntil', 1),
    invalidationCondition: text(payload.invalidationCondition, 'invalidationCondition', 2000)!,
    scenarioSetVersionId: payload.scenarioSetVersionId == null ? null : id(payload.scenarioSetVersionId, 'scenarioSetVersionId'),
    workItemVersionIds: idArray(payload.workItemVersionIds ?? [], 'workItemVersionIds'),
    factIds: idArray(payload.factIds ?? [], 'factIds'),
    evidenceIds: idArray(payload.evidenceIds ?? [], 'evidenceIds'),
    hypothesisIds: idArray(payload.hypothesisIds ?? [], 'hypothesisIds'),
    sourceTriggerEvaluationId: payload.sourceTriggerEvaluationId == null
      ? null : id(payload.sourceTriggerEvaluationId, 'sourceTriggerEvaluationId'),
    marketSnapshotId: payload.marketSnapshotId == null ? null : id(payload.marketSnapshotId, 'marketSnapshotId'),
    valuationSnapshotId: payload.valuationSnapshotId == null ? null : id(payload.valuationSnapshotId, 'valuationSnapshotId'),
  }
}

function handleError(error: unknown) {
  if (error instanceof IndustryResearchError) return fail(error.code, error.message)
  if (error instanceof IndustryResearchProjectDeletionError) return fail(error.code, error.message)
  if (error instanceof ResearchToolRuntimeError) return fail(error.code, error.message)
  if (error instanceof ResearchDiscussionError) return fail(error.code, error.message)
  if (error instanceof IndustryResearchMergeError) return { ...fail(error.code, error.message), details: error.details }
  if (error instanceof IndustryResearchDecisionError) return fail(error.code, error.message)
  if (error instanceof IndustryResearchMarketError) return fail(error.code, error.message)
  if (error instanceof IndustryResearchSnapshotError) return fail(error.code, error.message)
  if (error instanceof Error && error.message === 'NOT_FOUND') return fail('NOT_FOUND', '研究对象不存在')
  console.error('[industryResearch]', error instanceof Error ? error.message : 'Unknown error')
  return fail('DB_ERROR', '产业研究数据操作失败')
}

function generationRunView(
  run: ReturnType<typeof getGenerationRunView>['run'],
  extra?: {
    retrievalMode?: string | null
    retrievalPlan?: unknown
    nativeWebSearch?: unknown
    selectedTopNIds?: string[]
    reportPartitions?: unknown
    reportDocument?: unknown
    financialCollection?: unknown
    companyExpansion?: unknown
  },
) {
  if (!run) return null
  return {
    id: run.id,
    projectId: run.project_id,
    researchQuestion: run.research_question,
    status: run.status,
    currentStage: run.current_stage,
    lastSuccessfulStage: run.last_successful_stage,
    progressCurrent: run.progress_current,
    progressTotal: run.progress_total,
    progressMessage: run.progress_message,
    cancelRequested: run.cancel_requested === 1,
    skillId: run.skill_id,
    skillContentHash: run.skill_content_hash,
    skillRuleVersion: run.skill_rule_version,
    provider: run.provider,
    model: run.model,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    retryable: run.retryable === 1,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    updatedAt: run.updated_at,
    retrievalMode: extra?.retrievalMode ?? null,
    retrievalPlan: extra?.retrievalPlan ?? null,
    nativeWebSearch: extra?.nativeWebSearch ?? null,
    selectedTopNIds: extra?.selectedTopNIds ?? [],
    reportPartitions: extra?.reportPartitions ?? null,
    reportDocument: extra?.reportDocument ?? null,
    financialCollection: extra?.financialCollection ?? null,
    companyExpansion: extra?.companyExpansion ?? null,
  }
}

function evidenceCandidateView(item: ReturnType<typeof getGenerationRunView>['evidenceCandidates'][number]) {
  return {
    id: item.id,
    projectId: item.project_id,
    runId: item.run_id,
    query: item.query,
    sourceUrl: item.source_url,
    title: item.title,
    summary: item.summary,
    excerpt: item.excerpt,
    providerId: item.provider_id,
    publishedAt: item.published_at,
    fetchedAt: item.fetched_at,
    status: item.status,
    failureReason: item.failure_reason,
    confirmedAt: item.confirmed_at,
    sourceKind: item.source_kind || 'web_search',
    isDetailPage: item.is_detail_page === 1,
    relevanceScore: item.relevance_score ?? null,
    authorityScore: item.authority_score ?? null,
    freshnessScore: item.freshness_score ?? null,
    rankScore: item.rank_score ?? null,
  }
}

function companyCandidateView(item: ReturnType<typeof getGenerationRunView>['companyCandidates'][number]) {
  let matchedSecurities: unknown[] = []
  let researchNodeIds: string[] = []
  try { matchedSecurities = JSON.parse(item.matched_securities_json || '[]') } catch { matchedSecurities = [] }
  try { researchNodeIds = JSON.parse(item.research_node_ids_json || '[]') } catch { researchNodeIds = [] }
  return {
    id: item.id,
    runId: item.run_id,
    projectId: item.project_id,
    legalNameCandidate: item.legal_name_candidate,
    displayName: item.display_name,
    researchNodeIds,
    rationale: item.rationale,
    statementKind: item.statement_kind,
    matchedSecurities,
    resolutionStatus: item.resolution_status,
    exclusionReason: item.exclusion_reason,
  }
}

export function registerIndustryResearchHandlers(getMainWindow?: () => Electron.BrowserWindow | null): void {
  const progressEmitter = createGenerationProgressEmitter(() => getMainWindow?.() ?? null)

  ipcMain.handle('industryResearch:listProjects', async (_event, payload: Record<string, unknown> = {}) => {
    try {
      const status = payload.status == null ? undefined : enumValue(payload.status, PROJECT_STATUSES, 'status')
      const query = payload.query == null ? undefined : text(payload.query, 'query', 100, false) ?? undefined
      const limit = typeof payload.limit === 'number' && Number.isInteger(payload.limit) ? payload.limit : 50
      const offset = typeof payload.offset === 'number' && Number.isInteger(payload.offset) ? payload.offset : 0
      // 默认隐藏归档；显式 includeArchived=true 或按 status 过滤时放开
      const includeArchived = payload.includeArchived === true || status != null
      if (limit < 1 || limit > 200 || offset < 0) throw new IndustryResearchError('INVALID_PARAM', '分页参数无效')
      return ok(listResearchProjects(getDb(), { status, query, limit, offset, includeArchived }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getProject', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const project = getResearchProject(getDb(), projectId)
      if (!project) return fail('NOT_FOUND', '研究项目不存在')
      const skill = resolveIndustryResearchSkill()
      return ok({
        project,
        graph: getIndustryResearchGraph(getDb(), projectId),
        evidence: listResearchEvidence(getDb(), projectId),
        hypotheses: listResearchHypotheses(getDb(), projectId),
        skillStatus: !skill ? 'missing' : skill.contentHash === project.skill_content_hash ? 'current' : 'changed',
      })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:createProject', async (_event, payload: Record<string, unknown>) => {
    try {
      const seed = payload.seedSupplyChain as Record<string, unknown> | undefined
      return ok(createIndustryResearchProject(getDb(), {
        title: text(payload.title, 'title', 200)!,
        industryName: text(payload.industryName, 'industryName', 120)!,
        productScope: text(payload.productScope, 'productScope', 500)!,
        regionScope: text(payload.regionScope, 'regionScope', 200)!,
        timeScope: text(payload.timeScope, 'timeScope', 200)!,
        purpose: enumValue(payload.purpose, PURPOSES, 'purpose'),
        depth: enumValue(payload.depth, DEPTHS, 'depth'),
        dataAsOf: nullableDate(payload.dataAsOf, 'dataAsOf'),
        valuationDate: nullableDate(payload.valuationDate, 'valuationDate'),
        sourceType: enumValue(payload.sourceType, SOURCE_TYPES, 'sourceType'),
        sourceRef: text(payload.sourceRef, 'sourceRef', 500, false),
        sourceText: text(payload.sourceText, 'sourceText', 5000, false),
        nextReviewAt: null,
        stopCondition: null,
        seedSupplyChain: seed ? {
          chainGroup: text(seed.chainGroup, 'chainGroup', 120)!,
          hitConcepts: array(seed.hitConcepts, 'hitConcepts', 100).map((item) => text(item, 'hitConcept', 120)!),
          nodes: array(seed.nodes, 'nodes', 500).map((item) => {
            const node = item as Record<string, unknown>
            return {
              concept: text(node.concept, 'concept', 120)!,
              distance: typeof node.distance === 'number' && Number.isInteger(node.distance) ? node.distance : 0,
              isHit: node.isHit === true,
            }
          }),
          edges: array(seed.edges, 'edges', 1000).map((item) => {
            const edge = item as Record<string, unknown>
            return {
              upstreamConcept: text(edge.upstreamConcept, 'upstreamConcept', 120)!,
              downstreamConcept: text(edge.downstreamConcept, 'downstreamConcept', 120)!,
              relationLabel: text(edge.relationLabel, 'relationLabel', 120)!,
            }
          }),
        } : undefined,
      }, resolveIndustryResearchSkillBundle))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:updateProject', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const raw = payload.patch as Record<string, unknown> | undefined
      if (!raw || typeof raw !== 'object') throw new IndustryResearchError('INVALID_PARAM', 'patch 格式无效')
      const patch: Parameters<typeof updateIndustryResearchProject>[2] = {}
      if ('title' in raw) patch.title = text(raw.title, 'title', 200)!
      if ('industryName' in raw) patch.industryName = text(raw.industryName, 'industryName', 120)!
      if ('productScope' in raw) patch.productScope = text(raw.productScope, 'productScope', 500)!
      if ('regionScope' in raw) patch.regionScope = text(raw.regionScope, 'regionScope', 200)!
      if ('timeScope' in raw) patch.timeScope = text(raw.timeScope, 'timeScope', 200)!
      if ('purpose' in raw) patch.purpose = enumValue(raw.purpose, PURPOSES, 'purpose')
      if ('depth' in raw) patch.depth = enumValue(raw.depth, DEPTHS, 'depth')
      if ('status' in raw) patch.status = enumValue(raw.status, PROJECT_STATUSES, 'status')
      if ('dataAsOf' in raw) patch.dataAsOf = nullableDate(raw.dataAsOf, 'dataAsOf')
      if ('valuationDate' in raw) patch.valuationDate = nullableDate(raw.valuationDate, 'valuationDate')
      if ('nextReviewAt' in raw) patch.nextReviewAt = raw.nextReviewAt == null ? null : Number(raw.nextReviewAt)
      if ('stopCondition' in raw) patch.stopCondition = text(raw.stopCondition, 'stopCondition', 1000, false)
      return ok(updateIndustryResearchProject(getDb(), projectId, patch))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:archiveProject', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const project = updateResearchProject(getDb(), projectId, { status: 'archived' })
      return project ? ok(project) : fail('NOT_FOUND', '研究项目不存在')
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:deleteProject', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const deleted = deleteResearchProject(getDb(), projectId)
      if (!deleted) return fail('NOT_FOUND', '研究项目不存在')
      return ok({ projectId, deleted: true })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:purgeProjects', async (_event, payload: Record<string, unknown> = {}) => {
    try {
      const all = payload.all === true
      const projectIds = payload.projectIds == null
        ? undefined
        : array(payload.projectIds, 'projectIds', 200).map((item, index) => id(item, `projectIds[${index}]`))
      if (!all && (!projectIds || projectIds.length === 0)) {
        throw new IndustryResearchError('INVALID_PARAM', '请选择要删除的项目，或显式指定清空全部')
      }
      if (all && projectIds?.length) {
        throw new IndustryResearchError('INVALID_PARAM', '清空全部时不要同时传 projectIds')
      }
      const result = deleteResearchProjects(getDb(), all ? { all: true } : { projectIds })
      return ok(result)
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getGraph', async (_event, payload: Record<string, unknown>) => {
    try { return ok(getIndustryResearchGraph(getDb(), id(payload?.projectId, 'projectId'))) }
    catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveGraph', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const nodes = array(payload.nodes, 'nodes', 500).map((item) => {
        const node = item as Record<string, unknown>
        return {
          id: id(node.id, 'node.id'), type: enumValue(node.type, NODE_TYPES, 'node.type'),
          name: text(node.name, 'node.name', 200)!, stage: text(node.stage, 'node.stage', 120, false),
          statementKind: enumValue(node.statementKind, STATEMENT_KINDS, 'node.statementKind'),
          status: text(node.status, 'node.status', 120, false),
          metrics: array(node.metrics ?? [], 'node.metrics', 100),
          evidenceIds: array(node.evidenceIds ?? [], 'node.evidenceIds', 200).map((item) => id(item, 'evidenceId')),
          lastUpdated: nullableDate(node.lastUpdated, 'node.lastUpdated'),
        }
      })
      const edges = array(payload.edges, 'edges', 1000).map((item) => {
        const edge = item as Record<string, unknown>
        return {
          id: id(edge.id, 'edge.id'), source: id(edge.source, 'edge.source'), target: id(edge.target, 'edge.target'),
          relation: text(edge.relation, 'edge.relation', 120)!,
          statementKind: enumValue(edge.statementKind, STATEMENT_KINDS, 'edge.statementKind'),
          strength: edge.strength == null ? null : Number(edge.strength), bottleneck: edge.bottleneck === true,
          exposurePct: edge.exposurePct == null ? null : Number(edge.exposurePct),
          evidenceIds: array(edge.evidenceIds ?? [], 'edge.evidenceIds', 200).map((value) => id(value, 'evidenceId')),
          lastUpdated: nullableDate(edge.lastUpdated, 'edge.lastUpdated'),
        }
      })
      if (typeof payload.expectedUpdatedAt !== 'number' || !Number.isSafeInteger(payload.expectedUpdatedAt)) {
        throw new IndustryResearchError('INVALID_PARAM', 'expectedUpdatedAt 格式无效')
      }
      return ok({ graphUpdatedAt: saveIndustryResearchGraph(getDb(), projectId, nodes, edges, payload.expectedUpdatedAt) })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listEvidence', async (_event, payload: Record<string, unknown>) => {
    try { return ok(listResearchEvidence(getDb(), id(payload?.projectId, 'projectId'))) }
    catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveEvidence', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const evidence = payload.evidence as Record<string, unknown> | undefined
      if (!evidence) throw new IndustryResearchError('INVALID_PARAM', 'evidence 格式无效')
      return ok(saveIndustryResearchEvidence(getDb(), projectId, {
        id: id(evidence.id, 'evidence.id'), title: text(evidence.title, 'evidence.title', 300)!,
        sourceType: text(evidence.sourceType, 'evidence.sourceType', 120)!,
        sourceName: text(evidence.sourceName, 'evidence.sourceName', 200)!,
        sourceUrl: text(evidence.sourceUrl, 'evidence.sourceUrl', 2000, false),
        sourceRef: text(evidence.sourceRef, 'evidence.sourceRef', 500, false),
        publishedDate: nullableDate(evidence.publishedDate, 'evidence.publishedDate'),
        factDate: nullableDate(evidence.factDate, 'evidence.factDate'),
        metricName: text(evidence.metricName, 'evidence.metricName', 200, false),
        metricValue: evidence.metricValue == null ? null : Number(evidence.metricValue),
        unit: text(evidence.unit, 'evidence.unit', 80, false), region: text(evidence.region, 'evidence.region', 120, false),
        productSpec: text(evidence.productSpec, 'evidence.productSpec', 300, false),
        methodology: text(evidence.methodology, 'evidence.methodology', 1000, false),
        statementKind: enumValue(evidence.statementKind, STATEMENT_KINDS, 'evidence.statementKind'),
        direction: enumValue(evidence.direction, EVIDENCE_DIRECTIONS, 'evidence.direction'),
        reliability: enumValue(evidence.reliability, EVIDENCE_RELIABILITIES, 'evidence.reliability'),
        createdBy: enumValue(evidence.createdBy, EVIDENCE_CREATORS, 'evidence.createdBy'),
        primarySourceConfirmed: evidence.primarySourceConfirmed === true,
        conflictNote: text(evidence.conflictNote, 'evidence.conflictNote', 1000, false),
        excerpt: text(evidence.excerpt, 'evidence.excerpt', 5000, false),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listHypotheses', async (_event, payload: Record<string, unknown>) => {
    try { return ok(listResearchHypotheses(getDb(), id(payload?.projectId, 'projectId'))) }
    catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveHypothesis', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const hypothesis = payload.hypothesis as Record<string, unknown> | undefined
      if (!hypothesis) throw new IndustryResearchError('INVALID_PARAM', 'hypothesis 格式无效')
      const importance = Number(hypothesis.importance)
      if (!Number.isInteger(importance) || importance < 1 || importance > 5) throw new IndustryResearchError('INVALID_PARAM', 'importance 格式无效')
      return ok(saveIndustryResearchHypothesis(getDb(), projectId, {
        id: id(hypothesis.id, 'hypothesis.id'), statement: text(hypothesis.statement, 'hypothesis.statement', 2000)!,
        importance, status: hypothesis.status == null ? undefined : enumValue(hypothesis.status, HYPOTHESIS_STATUSES, 'hypothesis.status'),
        cheapestDisproof: text(hypothesis.cheapestDisproof, 'hypothesis.cheapestDisproof', 2000)!,
        verificationMetric: text(hypothesis.verificationMetric, 'hypothesis.verificationMetric', 300, false),
        threshold: text(hypothesis.threshold, 'hypothesis.threshold', 300, false),
        dueAt: hypothesis.dueAt == null ? null : Number(hypothesis.dueAt),
        evidenceIds: array(hypothesis.evidenceIds ?? [], 'hypothesis.evidenceIds', 200).map((item) => id(item, 'evidenceId')),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:updateHypothesisStatus', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(changeIndustryResearchHypothesisStatus(
        getDb(), id(payload.projectId, 'projectId'), id(payload.hypothesisId, 'hypothesisId'),
        enumValue(payload.status, HYPOTHESIS_STATUSES, 'status'), text(payload.reason, 'reason', 2000)!,
        array(payload.evidenceIds ?? [], 'evidenceIds', 200).map((item) => id(item, 'evidenceId')),
      ))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getReport', async (_event, payload: Record<string, unknown>) => {
    try { return ok(getIndustryResearchReport(getDb(), id(payload?.projectId, 'projectId'))) }
    catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listCompanies', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const db = getDb()
      ensureGeneratedProjectCompanies(db, projectId)
      return ok(listRankedResearchProjectCompanies(db, projectId))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveCompany', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const company = payload.company as Record<string, unknown> | undefined
      if (!company) throw new IndustryResearchError('INVALID_PARAM', 'company 格式无效')
      const db = getDb()
      const companyId = id(company.id, 'company.id')
      const savedCompany = saveResearchCompany(db, {
        id: companyId,
        legalName: text(company.legalName, 'company.legalName', 300)!,
        shortName: text(company.shortName, 'company.shortName', 120, false),
        unifiedCreditCode: text(company.unifiedCreditCode, 'company.unifiedCreditCode', 64, false),
        registrationRegion: text(company.registrationRegion, 'company.registrationRegion', 120, false),
        sourceType: enumValue(company.sourceType, MASTER_DATA_SOURCES, 'company.sourceType'),
        sourceRef: text(company.sourceRef, 'company.sourceRef', 1000, false),
      })
      const relation = saveResearchProjectCompany(db, {
        projectId,
        companyId,
        status: enumValue(company.status, COMPANY_STATUSES, 'company.status'),
        exclusionReason: text(company.exclusionReason, 'company.exclusionReason', 1000, false),
        evidenceIds: array(company.evidenceIds ?? [], 'company.evidenceIds', 200).map((value) => id(value, 'evidenceId')),
      })
      const security = company.security as Record<string, unknown> | undefined
      const savedSecurity = security ? saveResearchSecurity(db, {
        id: id(security.id, 'security.id'), companyId,
        tsCode: text(security.tsCode, 'security.tsCode', 16)!,
        exchange: text(security.exchange, 'security.exchange', 20)!,
        securityType: text(security.securityType, 'security.securityType', 40)!,
        listStatus: text(security.listStatus, 'security.listStatus', 40)!,
        listDate: nullableDate(security.listDate, 'security.listDate'),
        delistDate: nullableDate(security.delistDate, 'security.delistDate'),
        mappingSource: enumValue(security.mappingSource, MASTER_DATA_SOURCES, 'security.mappingSource'),
        sourceRef: text(security.sourceRef, 'security.sourceRef', 1000, false),
      }) : null
      return ok({ company: savedCompany, relation, security: savedSecurity })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listBusinessExposure', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const companyId = payload?.companyId == null ? undefined : id(payload.companyId, 'companyId')
      return ok(listResearchBusinessExposures(getDb(), projectId, companyId))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listDisclosureEvidence', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const companyId = id(payload?.companyId, 'companyId')
      requireProjectCompanyScope(projectId, companyId)
      return ok(listResearchDisclosureEvidence(getDb(), projectId, companyId).map(disclosureEvidenceView))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveDisclosureEvidence', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const companyId = id(payload?.companyId, 'companyId')
      const evidence = payload?.evidence as Record<string, unknown> | undefined
      if (!evidence) throw new IndustryResearchError('INVALID_PARAM', 'evidence 格式无效')
      const sourceUrl = httpUrl(evidence.sourceUrl, 'evidence.sourceUrl', 2000)
      requireProjectCompanyScope(projectId, companyId)
      return ok(disclosureEvidenceView(saveResearchDisclosureEvidence(getDb(), {
        id: id(evidence.id, 'evidence.id'),
        projectId,
        companyId,
        title: text(evidence.title, 'evidence.title', 300)!,
        sourceUrl,
        publishedDate: nullableDate(evidence.publishedDate, 'evidence.publishedDate'),
        actualPublishedDate: nullableDate(evidence.actualPublishedDate, 'evidence.actualPublishedDate'),
        excerpt: text(evidence.excerpt, 'evidence.excerpt', 5000, false),
        createdBy: 'human',
        primarySourceConfirmed: booleanValue(evidence.primarySourceConfirmed, 'evidence.primarySourceConfirmed'),
      })))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveBusinessExposure', async (_event, payload: Record<string, unknown>) => {
    try {
      const exposure = payload.exposure as Record<string, unknown> | undefined
      if (!exposure) throw new IndustryResearchError('INVALID_PARAM', 'exposure 格式无效')
      const status = enumValue(exposure.status, EXPOSURE_STATUSES, 'exposure.status')
      const evidenceIds = array(exposure.evidenceIds ?? [], 'exposure.evidenceIds', 200).map((value) => id(value, 'evidenceId'))
      if (status === 'confirmed' && evidenceIds.length === 0) {
        throw new IndustryResearchError('FACT_REQUIRES_SOURCE', '已确认业务暴露必须绑定证据')
      }
      return ok(saveResearchBusinessExposure(getDb(), {
        id: id(exposure.id, 'exposure.id'), projectId: id(payload.projectId, 'projectId'),
        companyId: id(exposure.companyId, 'exposure.companyId'),
        researchNodeId: exposure.researchNodeId == null ? null : id(exposure.researchNodeId, 'exposure.researchNodeId'),
        mainBusinessItemId: exposure.mainBusinessItemId == null ? null : id(exposure.mainBusinessItemId, 'exposure.mainBusinessItemId'),
        evidenceId: evidenceIds[0] ?? null,
        sourceKey: text(exposure.sourceKey, 'exposure.sourceKey', 500)!,
        sourceType: enumValue(exposure.sourceType, EXPOSURE_SOURCES, 'exposure.sourceType'), status,
        exposurePct: finiteNumber(exposure.exposurePct, 'exposure.exposurePct'),
        basis: text(exposure.basis, 'exposure.basis', 2000)!,
        createdBy: enumValue(exposure.createdBy, EXPOSURE_CREATORS, 'exposure.createdBy'),
        factDate: nullableDate(exposure.factDate, 'exposure.factDate'), evidenceIds,
        methodology: text(exposure.methodology, 'exposure.methodology', 2000, false),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:syncCompanyFinancials', async (_event, payload: Record<string, unknown>) => {
    try {
      const db = getDb()
      const config = getDataSourceConfig(db)
      if (!config.tushareEnabled || !config.tushareTokenEncrypted) {
        return fail('FINANCIAL_SOURCE_DISABLED', 'Tushare 财务数据源未启用')
      }
      const token = decryptApiKey(config.tushareTokenEncrypted)
      if (!token) return fail('FINANCIAL_SOURCE_DISABLED', 'Tushare Token 不可用')
      const datasets = array(payload.datasets, 'datasets', 9).map((value) => enumValue(value, FINANCIAL_DATASETS, 'dataset'))
      if (datasets.length === 0) throw new IndustryResearchError('INVALID_PARAM', 'datasets 格式无效')
      const result = await syncIndustryResearchCompanyFinancials(db, token, {
        projectId: id(payload.projectId, 'projectId'), companyId: id(payload.companyId, 'companyId'),
        securityId: id(payload.securityId, 'securityId'), tsCode: text(payload.tsCode, 'tsCode', 16)!, datasets,
      })
      return ok({
        ...result,
        datasets: result.datasets.map((item) => ({
          ...item,
          status: item.status === 'success' ? 'success'
            : item.errorCode === 'EMPTY_RESPONSE' ? 'empty'
              : item.errorCode === 'PERMISSION_REQUIRED' ? 'permission_required' : 'failed',
        })),
      })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getFinancialTimeline', async (_event, payload: Record<string, unknown>) => {
    try {
      const datasets = payload.datasets == null ? undefined
        : array(payload.datasets, 'datasets', 9).map((value) => enumValue(value, FINANCIAL_DATASETS, 'dataset'))
      return ok(listResearchFinancialTimelineFacts(getDb(), {
        companyId: id(payload.companyId, 'companyId'),
        securityId: payload.securityId == null ? undefined : id(payload.securityId, 'securityId'),
        datasets,
        fromAnnouncementDate: payload.fromAnnouncementDate == null ? undefined : nullableDate(payload.fromAnnouncementDate, 'fromAnnouncementDate')!,
        toAnnouncementDate: payload.toAnnouncementDate == null ? undefined : nullableDate(payload.toAnnouncementDate, 'toAnnouncementDate')!,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getFinancialValidation', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(getIndustryResearchFinancialValidation(
        getDb(), id(payload.projectId, 'projectId'), id(payload.companyId, 'companyId'),
      ))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveProfitBridge', async (_event, payload: Record<string, unknown>) => {
    try {
      const bridge = payload.bridge as Record<string, unknown> | undefined
      if (!bridge) throw new IndustryResearchError('INVALID_PARAM', 'bridge 格式无效')
      const expectedUpdatedAt = payload.expectedUpdatedAt == null ? null : finiteNumber(payload.expectedUpdatedAt, 'expectedUpdatedAt', true)
      return ok(saveIndustryResearchProfitBridge(
        getDb(), id(payload.projectId, 'projectId'), id(payload.companyId, 'companyId'), {
          id: bridge.id == null ? undefined : id(bridge.id, 'bridge.id'),
          bridgeKey: bridge.bridgeKey == null ? undefined : id(bridge.bridgeKey, 'bridge.bridgeKey'),
          basePeriod: text(bridge.basePeriod, 'bridge.basePeriod', 32)!,
          targetPeriod: text(bridge.targetPeriod, 'bridge.targetPeriod', 32)!,
          status: enumValue(bridge.status, PROFIT_BRIDGE_STATUSES, 'bridge.status'),
          items: array(bridge.items, 'bridge.items', 20).map((value) => {
            const item = value as Record<string, unknown>
            return {
              key: enumValue(item.key, PROFIT_BRIDGE_ITEM_KEYS, 'bridge.item.key'),
              label: text(item.label, 'bridge.item.label', 120)!,
              amount: finiteNumber(item.amount, 'bridge.item.amount'),
              unit: text(item.unit, 'bridge.item.unit', 40, false),
              methodology: text(item.methodology, 'bridge.item.methodology', 1000, false),
            }
          }),
          formula: text(bridge.formula, 'bridge.formula', 2000, false),
          inputFactIds: array(bridge.inputFactIds ?? [], 'bridge.inputFactIds', 200).map((value) => id(value, 'factId')),
          evidenceIds: array(bridge.evidenceIds ?? [], 'bridge.evidenceIds', 200).map((value) => id(value, 'evidenceId')),
          createdBy: enumValue(bridge.createdBy, EXPOSURE_CREATORS, 'bridge.createdBy'),
        }, expectedUpdatedAt,
      ))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getProfitBridge', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload?.projectId, 'projectId')
      const companyId = id(payload?.companyId, 'companyId')
      const bridgeKey = id(payload?.bridgeKey, 'bridgeKey')
      requireProjectCompanyScope(projectId, companyId)
      const bridge = getLatestResearchProfitBridge(getDb(), projectId, companyId, bridgeKey)
      if (!bridge) return ok(null)
      return ok({
        id: bridge.id,
        bridgeKey: bridge.bridge_key,
        projectId: bridge.project_id,
        companyId: bridge.company_id,
        basePeriod: bridge.base_period,
        targetPeriod: bridge.target_period,
        status: bridge.status,
        items: listResearchProfitBridgeItems(getDb(), bridge.id).map((item) => ({
          key: item.item_key,
          label: item.label,
          amount: item.amount,
          unit: item.unit,
          methodology: item.methodology,
        })),
        formula: bridge.formula,
        inputFactIds: safeJsonArray(bridge.input_fact_ids_json),
        evidenceIds: safeJsonArray(bridge.evidence_ids_json),
        createdBy: bridge.created_by,
        version: bridge.version,
        previousVersionId: bridge.previous_version_id,
        updatedAt: bridge.updated_at,
      })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getFinancialSyncStatus', async (_event, payload: Record<string, unknown>) => {
    try {
      const companyId = id(payload.companyId, 'companyId')
      const states = new Map(listResearchFinancialSyncStates(getDb(), companyId).map((state) => [state.dataset, state]))
      return ok([...FINANCIAL_DATASETS].map((dataset) => states.get(dataset) ?? ({
        company_id: companyId, dataset, status: 'idle', last_attempt_at: null,
        last_success_at: null, last_success_fact_date: null, last_success_row_count: null,
        last_error_code: null, updated_at: null,
      })))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getWebSearchConfig', async () => {
    try { return ok(getWebSearchConfigView(getDb())) }
    catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveWebSearchConfig', async (_event, payload: Record<string, unknown> = {}) => {
    try {
      const providerId = enumValue(payload.providerId, WEB_SEARCH_PROVIDERS, 'providerId')
      const enabled = booleanValue(payload.enabled, 'enabled')
      const apiKey = payload.apiKey === undefined
        ? undefined
        : payload.apiKey === null
          ? null
          : text(payload.apiKey, 'apiKey', 500, false)
      const baseUrl = payload.baseUrl === undefined ? undefined : text(payload.baseUrl, 'baseUrl', 500, false)
      return ok(saveWebSearchConfigAndView(getDb(), {
        providerId,
        enabled,
        apiKey,
        baseUrl: baseUrl === undefined ? undefined : baseUrl,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:validateWebSearchConfig', async () => {
    try { return ok(await validateConfiguredWebSearch(getDb())) }
    catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listEvidenceCandidates', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const runId = payload.runId == null ? undefined : id(payload.runId, 'runId')
      return ok(getGenerationRunView(getDb(), projectId, runId).evidenceCandidates.map(evidenceCandidateView))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:confirmEvidenceCandidate', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const candidateId = id(payload.candidateId, 'candidateId')
      const action = enumValue(payload.action, new Set(['confirm', 'reject'] as const), 'action')
      return ok(evidenceCandidateView(confirmProjectEvidenceCandidate(getDb(), projectId, candidateId, action)))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:startGeneration', async (_event, payload: Record<string, unknown> = {}) => {
    try {
      const scopeRaw = payload.scope && typeof payload.scope === 'object'
        ? payload.scope as Record<string, unknown>
        : undefined
      const result = await startIndustryResearchGeneration(getDb(), {
        researchQuestion: text(payload.researchQuestion, 'researchQuestion', 4000)!,
        projectId: payload.projectId == null ? undefined : id(payload.projectId, 'projectId'),
        sourceType: payload.sourceType == null ? 'manual' : enumValue(payload.sourceType, SOURCE_TYPES, 'sourceType'),
        sourceRef: text(payload.sourceRef, 'sourceRef', 500, false),
        sourceText: text(payload.sourceText, 'sourceText', 5000, false),
        scope: scopeRaw ? {
          title: text(scopeRaw.title, 'scope.title', 200, false),
          industryName: text(scopeRaw.industryName, 'scope.industryName', 120, false),
          productScope: text(scopeRaw.productScope, 'scope.productScope', 500, false),
          regionScope: text(scopeRaw.regionScope, 'scope.regionScope', 200, false),
          timeScope: text(scopeRaw.timeScope, 'scope.timeScope', 200, false),
          purpose: scopeRaw.purpose == null ? undefined : enumValue(scopeRaw.purpose, PURPOSES, 'scope.purpose'),
          depth: scopeRaw.depth == null ? undefined : enumValue(scopeRaw.depth, DEPTHS, 'scope.depth'),
          dataAsOf: nullableDate(scopeRaw.dataAsOf, 'scope.dataAsOf'),
          stopCondition: text(scopeRaw.stopCondition, 'scope.stopCondition', 1000, false),
          enableWebRetrieval: scopeRaw.enableWebRetrieval == null ? true : booleanValue(scopeRaw.enableWebRetrieval, 'scope.enableWebRetrieval'),
        } : undefined,
      }, resolveIndustryResearchSkill, {
        createProject: (input) => createIndustryResearchProject(getDb(), {
          ...input,
          nextReviewAt: null,
          stopCondition: null,
        }, resolveIndustryResearchSkillBundle),
        emitter: progressEmitter,
      })
      const view = getGenerationRunView(getDb(), result.projectId, result.run.id)
      return ok({
        projectId: result.projectId,
        run: generationRunView(view.run, {
          retrievalMode: view.retrievalMode,
          retrievalPlan: view.retrievalPlan,
          nativeWebSearch: view.nativeWebSearch,
          selectedTopNIds: view.selectedTopNIds,
          reportPartitions: view.reportPartitions,
          reportDocument: view.reportDocument,
          financialCollection: view.financialCollection,
          companyExpansion: view.companyExpansion,
        }),
      })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getGenerationRun', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const runId = payload.runId == null ? undefined : id(payload.runId, 'runId')
      const view = getGenerationRunView(getDb(), projectId, runId)
      return ok({
        run: generationRunView(view.run, {
          retrievalMode: view.retrievalMode,
          retrievalPlan: view.retrievalPlan,
          nativeWebSearch: view.nativeWebSearch,
          selectedTopNIds: view.selectedTopNIds,
          reportPartitions: view.reportPartitions,
          reportDocument: view.reportDocument,
          financialCollection: view.financialCollection,
          companyExpansion: view.companyExpansion,
        }),
        evidenceCandidates: view.evidenceCandidates.map(evidenceCandidateView),
        companyCandidates: view.companyCandidates.map(companyCandidateView),
        retrievalMode: view.retrievalMode,
        retrievalPlan: view.retrievalPlan,
        nativeWebSearch: view.nativeWebSearch,
        selectedTopNIds: view.selectedTopNIds,
        reportPartitions: view.reportPartitions,
        reportDocument: view.reportDocument,
        financialCollection: view.financialCollection,
        companyExpansion: view.companyExpansion,
      })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:cancelGeneration', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const runId = id(payload.runId, 'runId')
      const run = cancelIndustryResearchGeneration(getDb(), projectId, runId)
      if (!run) return fail('NOT_FOUND', '生成运行不存在')
      const view = getGenerationRunView(getDb(), projectId, run.id)
      return ok(generationRunView(view.run, {
        retrievalMode: view.retrievalMode,
        retrievalPlan: view.retrievalPlan,
        nativeWebSearch: view.nativeWebSearch,
        selectedTopNIds: view.selectedTopNIds,
        reportPartitions: view.reportPartitions,
        reportDocument: view.reportDocument,
        financialCollection: view.financialCollection,
        companyExpansion: view.companyExpansion,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:continueFinancialCollection', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const runId = id(payload.runId, 'runId')
      const run = continueIndustryResearchFinancialCollection(
        getDb(),
        projectId,
        runId,
        resolveIndustryResearchSkill,
        progressEmitter,
      )
      const view = getGenerationRunView(getDb(), projectId, run.id)
      return ok(generationRunView(view.run, {
        retrievalMode: view.retrievalMode,
        retrievalPlan: view.retrievalPlan,
        nativeWebSearch: view.nativeWebSearch,
        selectedTopNIds: view.selectedTopNIds,
        reportPartitions: view.reportPartitions,
        reportDocument: view.reportDocument,
        financialCollection: view.financialCollection,
        companyExpansion: view.companyExpansion,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:expandCompanyCandidates', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const runId = id(payload.runId, 'runId')
      return ok(await expandIndustryResearchCompanyCandidates(
        getDb(),
        projectId,
        runId,
        resolveIndustryResearchSkill,
        { emitter: progressEmitter },
      ))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:retryGenerationStage', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const runId = id(payload.runId, 'runId')
      const stage = payload.stage == null ? undefined : enumValue(payload.stage, GENERATION_STAGES, 'stage')
      const run = await retryIndustryResearchGeneration(
        getDb(),
        projectId,
        runId,
        resolveIndustryResearchSkill,
        progressEmitter,
        stage,
      )
      const view = getGenerationRunView(getDb(), projectId, run.id)
      return ok(generationRunView(view.run, {
        retrievalMode: view.retrievalMode,
        retrievalPlan: view.retrievalPlan,
        nativeWebSearch: view.nativeWebSearch,
        selectedTopNIds: view.selectedTopNIds,
        reportPartitions: view.reportPartitions,
        reportDocument: view.reportDocument,
        financialCollection: view.financialCollection,
        companyExpansion: view.companyExpansion,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:resolveCompanyCandidate', async (_event, payload: Record<string, unknown>) => {
    try {
      const projectId = id(payload.projectId, 'projectId')
      const runId = id(payload.runId, 'runId')
      const candidateId = id(payload.candidateId, 'candidateId')
      const action = enumValue(payload.action, new Set(['accept', 'exclude'] as const), 'action')
      const securityTsCode = text(payload.securityTsCode, 'securityTsCode', 20, false)
      const exclusionReason = text(payload.exclusionReason, 'exclusionReason', 500, false)
      return ok(companyCandidateView(resolveIndustryResearchCompanyCandidate(getDb(), {
        projectId,
        runId,
        candidateId,
        action,
        securityTsCode,
        exclusionReason,
      })!))
    } catch (error) { return handleError(error) }
  })

  // ── FR-239 contextual discussion changes ────────────────────────────────────
  ipcMain.handle('industryResearch:prepareDiscussionChanges', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(await prepareDiscussionChanges(getDb(), {
        requestId: uuid(payload.requestId, 'requestId'),
        sessionId: finiteNumber(payload.sessionId, 'sessionId', true)!,
        throughMessageIndex: finiteNumber(payload.throughMessageIndex, 'throughMessageIndex', true)!,
        projectId: payload.projectId == null ? null : id(payload.projectId, 'projectId'),
        baseSnapshotId: payload.baseSnapshotId == null ? null : id(payload.baseSnapshotId, 'baseSnapshotId'),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listChangeSets', async (_event, payload: Record<string, unknown> = {}) => {
    try {
      if (payload.sessionId == null && payload.projectId == null && payload.batchId == null) {
        throw new IndustryResearchError('INVALID_PARAM', 'sessionId、projectId 或 batchId 至少提供一个')
      }
      const result = listChangeSets(getDb(), {
        sessionId: payload.sessionId == null ? undefined : finiteNumber(payload.sessionId, 'sessionId', true)!,
        projectId: payload.projectId == null ? undefined : id(payload.projectId, 'projectId'),
        batchId: payload.batchId == null ? undefined : id(payload.batchId, 'batchId'),
        status: payload.status == null ? undefined : enumValue(payload.status, CHANGE_SET_STATUSES, 'status'),
        offset: payload.offset == null ? undefined : finiteNumber(payload.offset, 'offset', true)!,
        limit: payload.limit == null ? undefined : finiteNumber(payload.limit, 'limit', true)!,
      })
      return ok({ ...result, items: result.items.map(changeSetSummary) })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listChangeCandidates', async (_event, payload: Record<string, unknown>) => {
    try {
      const result = listChangeCandidates(getDb(), {
        changeSetId: id(payload.changeSetId, 'changeSetId'),
        status: payload.status == null ? undefined : enumValue(payload.status, CHANGE_CANDIDATE_STATUSES, 'status'),
        kind: payload.kind == null ? undefined : enumValue(payload.kind, CHANGE_CANDIDATE_KINDS, 'kind'),
        offset: payload.offset == null ? undefined : finiteNumber(payload.offset, 'offset', true)!,
        limit: payload.limit == null ? undefined : finiteNumber(payload.limit, 'limit', true)!,
      })
      return ok({ ...result, items: result.items.map(changeCandidateView) })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:resolveChangeSets', async (_event, payload: Record<string, unknown>) => {
    try {
      const action = enumValue(payload.action, new Set(['accept', 'reject', 'defer'] as const), 'action')
      const changeSetIds = array(payload.changeSetIds, 'changeSetIds', 20).map((value) => id(value, 'changeSetId'))
      const targetRaw = payload.target && typeof payload.target === 'object' ? payload.target as Record<string, unknown> : null
      const target = targetRaw?.mode === 'existing'
        ? { mode: 'existing' as const, projectId: id(targetRaw.projectId, 'target.projectId') }
        : targetRaw?.mode === 'create'
          ? (() => {
              const project = targetRaw.project && typeof targetRaw.project === 'object' ? targetRaw.project as Record<string, unknown> : null
              if (!project) throw new IndustryResearchError('INVALID_PARAM', 'target.project 格式无效')
              return {
                mode: 'create' as const,
                project: {
                  title: text(project.title, 'target.project.title', 200)!,
                  industry: text(project.industry, 'target.project.industry', 120)!,
                  product: text(project.product, 'target.project.product', 500)!,
                  region: text(project.region, 'target.project.region', 200)!,
                  timeHorizon: text(project.timeHorizon, 'target.project.timeHorizon', 200)!,
                  purpose: enumValue(project.purpose, PURPOSES, 'target.project.purpose'),
                  depth: enumValue(project.depth, DEPTHS, 'target.project.depth'),
                },
              }
            })()
          : undefined
      const userEdits = payload.userEdits == null ? undefined : array(payload.userEdits, 'userEdits', 20).map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        return {
          changeSetId: id(item.changeSetId, 'userEdits.changeSetId'),
          title: item.title == null ? undefined : text(item.title, 'userEdits.title', 160)!,
          summary: item.summary == null ? undefined : text(item.summary, 'userEdits.summary', 2000)!,
          payloadPatch: item.payloadPatch,
        }
      })
      const factConfirmations = payload.factConfirmations == null ? undefined : array(payload.factConfirmations, 'factConfirmations', 100).map((value) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        if (item.primarySourceConfirmed !== true || item.confirmedBy !== 'human') {
          throw new IndustryResearchError('INVALID_PARAM', 'factConfirmations 格式无效')
        }
        return {
          candidateId: id(item.candidateId, 'factConfirmations.candidateId'),
          primarySourceConfirmed: true as const,
          confirmedBy: 'human' as const,
          originalSourceUrl: httpUrl(item.originalSourceUrl, 'factConfirmations.originalSourceUrl', 2000),
        }
      })
      const db = getDb()
      return ok(resolveIndustryResearchChangeSets(db, {
        requestId: uuid(payload.requestId, 'requestId'),
        batchId: id(payload.batchId, 'batchId'),
        changeSetIds,
        action,
        reason: payload.reason == null ? undefined : text(payload.reason, 'reason', 1000)!,
        userEdits,
        target,
        expectedGraphUpdatedAt: payload.expectedGraphUpdatedAt == null ? undefined : finiteNumber(payload.expectedGraphUpdatedAt, 'expectedGraphUpdatedAt', true)!,
        expectedSnapshotId: payload.expectedSnapshotId === undefined
          ? undefined
          : payload.expectedSnapshotId === null ? null : id(payload.expectedSnapshotId, 'expectedSnapshotId'),
        factConfirmations,
      }, (project) => createIndustryResearchProject(db, {
        title: project.title,
        industryName: project.industry,
        productScope: project.product,
        regionScope: project.region,
        timeScope: project.timeHorizon,
        purpose: project.purpose,
        depth: project.depth,
        dataAsOf: null,
        valuationDate: null,
        sourceType: 'ai_analysis',
        sourceRef: `discussion-batch:${String(payload.batchId).slice(0, 128)}`,
        nextReviewAt: null,
        stopCondition: null,
      }, resolveIndustryResearchSkillBundle)))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:importCandidateArchive', async (_event, payload: Record<string, unknown>) => {
    try {
      const archiveType = text(payload.archiveType, 'archiveType', 100)!
      if (archiveType !== SUPPORTED_RESEARCH_ARCHIVE_TYPE) return fail('UNSUPPORTED_ARCHIVE', '暂不支持该研究档案类型')
      const mainWindow = getMainWindow?.() ?? null
      const options = {
        title: '选择研究档案的五个 Markdown 文件',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      }
      const selection = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      if (selection.canceled) return fail('CANCELLED', '已取消导入')
      return ok(importIndustryResearchArchive(getDb(), {
        requestId: uuid(payload.requestId, 'requestId'),
        projectId: payload.projectId == null ? null : id(payload.projectId, 'projectId'),
        archiveType,
        dryRun: payload.dryRun === true,
        filePaths: selection.filePaths,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listSnapshots', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(listIndustryResearchSnapshots(
        getDb(), id(payload.projectId, 'projectId'),
        payload.offset == null ? 0 : finiteNumber(payload.offset, 'offset', true)!,
        payload.limit == null ? 20 : finiteNumber(payload.limit, 'limit', true)!,
      ))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getSnapshot', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(getIndustryResearchSnapshot(getDb(), id(payload.projectId, 'projectId'), id(payload.snapshotId, 'snapshotId')))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getDecisionWorkbench', async (_event, payload: Record<string, unknown>) => {
    try {
      const db = getDb()
      const projectId = id(payload.projectId, 'projectId')
      if (!getResearchProject(db, projectId)) throw new IndustryResearchError('NOT_FOUND', '研究项目不存在')
      ensureGeneratedProjectCompanies(db, projectId)
      const companies = listRankedResearchProjectCompanies(db, projectId)
      const requestedCompanyId = payload.companyId == null ? null : id(payload.companyId, 'companyId')
      const selectedCompany = requestedCompanyId
        ? companies.find((company) => company.company_id === requestedCompanyId)
        : companies.find((company) => company.status !== 'excluded') ?? companies[0]
      if (requestedCompanyId && !selectedCompany) throw new IndustryResearchError('NOT_FOUND', '项目公司不存在')
      const requestedSecurityId = payload.securityId == null ? null : id(payload.securityId, 'securityId')
      const selectedSecurity = requestedSecurityId
        ? selectedCompany?.securities.find((security) => security.id === requestedSecurityId)
        : selectedCompany?.securities[0]
      if (requestedSecurityId && !selectedSecurity) throw new IndustryResearchError('NOT_FOUND', '项目证券不存在')
      const marketContext = selectedCompany && selectedSecurity
        ? buildIndustryResearchMarketContext(db, {
            projectId,
            companyId: selectedCompany.company_id,
            securityId: selectedSecurity.id,
            valuationDate: nullableDate(payload.valuationDate, 'valuationDate') ?? undefined,
          })
        : {
            status: 'blocked',
            reasons: [{ code: 'MARKET_DATA_BLOCKED', message: selectedCompany ? '当前公司尚未映射证券' : '项目尚未纳入公司' }],
            marketDate: null,
            rawClose: null,
            windows: [],
            series: [],
            events: [],
            valuationDaily: null,
            valuationHistory: {
              peTtm: { sampleCount: 0, percentile: null },
              pb: { sampleCount: 0, percentile: null },
              psTtm: { sampleCount: 0, percentile: null },
            },
            comparables: {
              status: 'blocked', sampleCount: 0, minimumSample: 3, rows: [],
              currentPercentiles: { peTtm: null, pb: null, psTtm: null },
            },
            factFingerprint: '',
          }
      return ok({
        companies,
        selectedCompanyId: selectedCompany?.company_id ?? null,
        selectedSecurityId: selectedSecurity?.id ?? null,
        skillAdoption: getIndustryResearchSkillAdoption(db, projectId, resolveIndustryResearchSkillBundle()),
        workItems: listIndustryResearchWorkItems(db, projectId),
        scenarioSets: listIndustryResearchScenarios(db, projectId, selectedCompany?.company_id ?? undefined),
        decisions: listIndustryResearchDecisions(db, projectId),
        monitoringItems: listIndustryResearchMonitoringItems(db, projectId),
        triggers: listIndustryResearchDecisionTriggers(db, projectId),
        reviewQueue: getIndustryResearchReviewQueue(db, projectId),
        marketContext,
      })
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:syncMarketData', async (_event, payload: Record<string, unknown>) => {
    try {
      const db = getDb()
      const config = getDataSourceConfig(db)
      if (!config.tushareEnabled || !config.tushareTokenEncrypted) return fail('TOKEN_REQUIRED', 'Tushare 行情数据源未启用')
      const token = decryptApiKey(config.tushareTokenEncrypted)
      if (!token) return fail('TOKEN_REQUIRED', 'Tushare Token 不可用')
      return ok(await syncIndustryResearchMarketData(db, token, {
        projectId: id(payload.projectId, 'projectId'),
        companyId: id(payload.companyId, 'companyId'),
        securityId: id(payload.securityId, 'securityId'),
        requestId: uuid(payload.requestId, 'requestId'),
        valuationDate: nullableDate(payload.valuationDate, 'valuationDate') ?? undefined,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:previewValuation', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(previewIndustryResearchValuation(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        companyId: id(payload.companyId, 'companyId'),
        securityId: id(payload.securityId, 'securityId'),
        valuationDate: nullableDate(payload.valuationDate, 'valuationDate')!,
        valuationMethod: enumValue(payload.valuationMethod, VALUATION_METHODS, 'valuationMethod'),
        scenarios: valuationScenarios(payload.scenarios),
        marketFingerprint: text(payload.marketFingerprint, 'marketFingerprint', 64)!,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:captureValuationSnapshot', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(captureIndustryResearchValuationSnapshot(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        companyId: id(payload.companyId, 'companyId'),
        securityId: id(payload.securityId, 'securityId'),
        requestId: uuid(payload.requestId, 'requestId'),
        scenarioSetVersionId: id(payload.scenarioSetVersionId, 'scenarioSetVersionId'),
        valuationDate: nullableDate(payload.valuationDate, 'valuationDate')!,
        marketFingerprint: text(payload.marketFingerprint, 'marketFingerprint', 64)!,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getSkillAdoption', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(getIndustryResearchSkillAdoption(
        getDb(), id(payload.projectId, 'projectId'), resolveIndustryResearchSkillBundle(),
      ))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:adoptSkillVersion', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(adoptIndustryResearchSkillVersion(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        requestId: uuid(payload.requestId, 'requestId'),
        targetContentHash: text(payload.targetContentHash, 'targetContentHash', 64)!,
        migrationNote: text(payload.migrationNote, 'migrationNote', 4000)!,
        expectedUpdatedAt: integerNumber(payload.expectedUpdatedAt, 'expectedUpdatedAt'),
      }, resolveIndustryResearchSkillBundle()))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listWorkItems', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(listIndustryResearchWorkItems(getDb(), id(payload.projectId, 'projectId')))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveWorkItem', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(saveIndustryResearchWorkItem(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        requestId: uuid(payload.requestId, 'requestId'),
        workItemId: uuid(payload.workItemId, 'workItemId'),
        expectedVersion: integerNumber(payload.expectedVersion, 'expectedVersion'),
        question: text(payload.question, 'question', 4000)!,
        effort: enumValue(payload.effort, RESEARCH_EFFORTS, 'effort'),
        conclusionSensitivity: enumValue(payload.conclusionSensitivity, RESEARCH_LEVELS, 'conclusionSensitivity'),
        evidenceUncertainty: enumValue(payload.evidenceUncertainty, RESEARCH_LEVELS, 'evidenceUncertainty'),
        changeVelocity: enumValue(payload.changeVelocity, RESEARCH_LEVELS, 'changeVelocity'),
        stopReason: text(payload.stopReason, 'stopReason', 2000, false),
        nextTriggerMetric: text(payload.nextTriggerMetric, 'nextTriggerMetric', 500, false),
        affectedObjectIds: idArray(payload.affectedObjectIds ?? [], 'affectedObjectIds'),
        status: enumValue(payload.status, WORK_ITEM_STATUSES, 'status'),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listScenarios', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(listIndustryResearchScenarios(
        getDb(), id(payload.projectId, 'projectId'),
        payload.companyId === undefined ? undefined : payload.companyId === null ? null : id(payload.companyId, 'companyId'),
      ))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveScenarioSet', async (_event, payload: Record<string, unknown>) => {
    try {
      const scenarios = array(payload.scenarios, 'scenarios', 3).map((value) => {
        const item = record(value, 'scenario')
        const name = text(item.name, 'scenario.name', 10)!
        if (!['bear', 'base', 'bull'].includes(name)) throw new IndustryResearchError('INVALID_PARAM', 'scenario.name 格式无效')
        return {
          name: name as 'bear' | 'base' | 'bull',
          weightPct: item.weightPct == null ? null : finiteNumber(item.weightPct, 'scenario.weightPct', true),
          assumptions: assumptions(item.assumptions ?? {}, 'scenario.assumptions'),
          valuationInputs: valuationInputs(item.valuationInputs ?? {}, 'scenario.valuationInputs'),
          factIds: idArray(item.factIds ?? [], 'scenario.factIds'),
        }
      })
      return ok(saveIndustryResearchScenarioSet(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        companyId: payload.companyId == null ? null : id(payload.companyId, 'companyId'),
        requestId: uuid(payload.requestId, 'requestId'),
        scenarioSetId: uuid(payload.scenarioSetId, 'scenarioSetId'),
        expectedVersion: integerNumber(payload.expectedVersion, 'expectedVersion'),
        dataAsOf: nullableDate(payload.dataAsOf, 'dataAsOf')!,
        valuationDate: nullableDate(payload.valuationDate, 'valuationDate'),
        valuationMethod: payload.valuationMethod == null ? null : enumValue(payload.valuationMethod, VALUATION_METHODS, 'valuationMethod'),
        methodologyVersion: text(payload.methodologyVersion, 'methodologyVersion', 200, false),
        scenarios,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listDecisions', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(listIndustryResearchDecisions(getDb(), id(payload.projectId, 'projectId')))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:appendDecisionEvent', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(appendIndustryResearchDecisionEvent(getDb(), parseDecisionEventInput(payload)))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listMonitoringItems', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(listIndustryResearchMonitoringItems(getDb(), id(payload.projectId, 'projectId')))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveMonitoringItem', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(saveIndustryResearchMonitoringItem(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        requestId: uuid(payload.requestId, 'requestId'),
        monitoringItemId: uuid(payload.monitoringItemId, 'monitoringItemId'),
        expectedVersion: integerNumber(payload.expectedVersion, 'expectedVersion'),
        name: text(payload.name, 'name', 500)!,
        valueKind: enumValue(payload.valueKind, MONITORING_VALUE_KINDS, 'valueKind'),
        frequency: enumValue(payload.frequency, MONITORING_FREQUENCIES, 'frequency'),
        sourceName: text(payload.sourceName, 'sourceName', 500)!,
        sourceRef: text(payload.sourceRef, 'sourceRef', 2000, false),
        unit: text(payload.unit, 'unit', 100, false),
        timingType: enumValue(payload.timingType, MONITORING_TIMINGS, 'timingType'),
        staleAfterMs: integerNumber(payload.staleAfterMs, 'staleAfterMs', 1),
        nextReviewAt: payload.nextReviewAt == null ? null : integerNumber(payload.nextReviewAt, 'nextReviewAt', 1),
        hypothesisIds: idArray(payload.hypothesisIds ?? [], 'hypothesisIds'),
        scenarioSetVersionIds: idArray(payload.scenarioSetVersionIds ?? [], 'scenarioSetVersionIds'),
        decisionIds: idArray(payload.decisionIds ?? [], 'decisionIds'),
        status: enumValue(payload.status, MONITORING_STATUSES, 'status'),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:appendMonitoringObservation', async (_event, payload: Record<string, unknown>) => {
    try {
      const value = payload.value
      if (typeof value !== 'string' && typeof value !== 'number') throw new IndustryResearchError('INVALID_PARAM', 'value 格式无效')
      return ok(appendIndustryResearchMonitoringObservation(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        requestId: uuid(payload.requestId, 'requestId'),
        monitoringItemId: uuid(payload.monitoringItemId, 'monitoringItemId'),
        expectedVersion: integerNumber(payload.expectedVersion, 'expectedVersion'),
        value,
        unit: text(payload.unit, 'unit', 100, false),
        sourceRef: text(payload.sourceRef, 'sourceRef', 2000, false),
        observedAt: integerNumber(payload.observedAt, 'observedAt', 1),
        availableAt: integerNumber(payload.availableAt, 'availableAt', 1),
        dataAsOf: nullableDate(payload.dataAsOf, 'dataAsOf')!,
        methodologyVersion: text(payload.methodologyVersion, 'methodologyVersion', 200)!,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:listDecisionTriggers', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(listIndustryResearchDecisionTriggers(getDb(), id(payload.projectId, 'projectId')))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:saveDecisionTrigger', async (_event, payload: Record<string, unknown>) => {
    try {
      const threshold = payload.threshold
      if (threshold != null && typeof threshold !== 'string' && typeof threshold !== 'number') {
        throw new IndustryResearchError('INVALID_PARAM', 'threshold 格式无效')
      }
      return ok(saveIndustryResearchDecisionTrigger(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        requestId: uuid(payload.requestId, 'requestId'),
        triggerId: uuid(payload.triggerId, 'triggerId'),
        expectedVersion: integerNumber(payload.expectedVersion, 'expectedVersion'),
        decisionId: uuid(payload.decisionId, 'decisionId'),
        monitoringItemId: uuid(payload.monitoringItemId, 'monitoringItemId'),
        metricName: text(payload.metricName, 'metricName', 500)!,
        operator: enumValue(payload.operator, TRIGGER_OPERATORS, 'operator'),
        threshold: threshold ?? null,
        validationWindowMs: integerNumber(payload.validationWindowMs, 'validationWindowMs', 1),
        actionIfNotTriggered: enumValue(payload.actionIfNotTriggered, DECISION_ACTIONS, 'actionIfNotTriggered'),
        proposedActionIfTriggered: enumValue(payload.proposedActionIfTriggered, DECISION_ACTIONS, 'proposedActionIfTriggered'),
        expiresAt: payload.expiresAt == null ? null : integerNumber(payload.expiresAt, 'expiresAt', 1),
        status: enumValue(payload.status, TRIGGER_STATUSES, 'status'),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:evaluateDecisionTriggers', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(evaluateIndustryResearchDecisionTriggers(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        requestId: uuid(payload.requestId, 'requestId'),
        triggerIds: idArray(payload.triggerIds, 'triggerIds', 50),
        evaluatedAt: payload.evaluatedAt == null ? undefined : integerNumber(payload.evaluatedAt, 'evaluatedAt', 1),
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:resolveTriggerReview', async (_event, payload: Record<string, unknown>) => {
    try {
      const resolution = enumValue(payload.resolution, REVIEW_RESOLUTIONS, 'resolution')
      const decisionPayload = payload.decisionEvent == null ? undefined : record(payload.decisionEvent, 'decisionEvent')
      return ok(resolveIndustryResearchTriggerReview(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        evaluationId: id(payload.evaluationId, 'evaluationId'),
        requestId: uuid(payload.requestId, 'requestId'),
        resolution,
        reason: text(payload.reason, 'reason', 2000)!,
        decisionEvent: decisionPayload ? parseDecisionEventInput(decisionPayload) : undefined,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getReviewQueue', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(getIndustryResearchReviewQueue(getDb(), id(payload.projectId, 'projectId')))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:resolveReviewItem', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(resolveIndustryResearchReviewItem(getDb(), {
        projectId: id(payload.projectId, 'projectId'),
        reviewGroupId: id(payload.reviewGroupId, 'reviewGroupId'),
        requestId: uuid(payload.requestId, 'requestId'),
        resolution: enumValue(payload.resolution, REVIEW_RESOLUTIONS, 'resolution'),
        reason: text(payload.reason, 'reason', 2000)!,
      }))
    } catch (error) { return handleError(error) }
  })

  ipcMain.handle('industryResearch:getDecisionReplay', async (_event, payload: Record<string, unknown>) => {
    try {
      return ok(getIndustryResearchDecisionReplay(
        getDb(), id(payload.projectId, 'projectId'), uuid(payload.decisionId, 'decisionId'),
      ))
    } catch (error) { return handleError(error) }
  })
}
