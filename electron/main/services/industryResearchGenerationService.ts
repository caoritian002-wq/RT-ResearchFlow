import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import {
  createGenerationRun,
  getActiveGenerationRun,
  getCompanyCandidate,
  getGenerationRun,
  getLatestGenerationRun,
  getLatestSuccessfulGenerationRun,
  listCompanyCandidates,
  listEvidenceCandidates,
  listRemappableUnmatchedCompanyCandidates,
  requestCancelGenerationRun,
  updateCompanyCandidateResolution,
  updateGenerationRun,
  updateUnmatchedCompanyCandidateMatches,
  upsertCompanyCandidate,
  type GenerationRunCreateInput,
} from '../database/industryResearchGenerationRepository'
import {
  getResearchProjectCompany,
  getResearchSecurityByTsCode,
  listResearchProjectCompanies,
  listResearchProjectStockCodes,
  saveResearchCompany,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../database/industryResearchFinancialRepository'
import {
  getResearchProject,
  replaceResearchGraph,
  saveResearchEvidence,
  saveResearchHypothesis,
  updateResearchProject,
  type ResearchEdgeInput,
  type ResearchNodeInput,
} from '../database/industryResearchRepository'
import { searchByNameOrCode } from '../database/stockBasicCacheRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import type {
  IndustryResearchCompanyCandidateRow,
  IndustryResearchGenerationRunRow,
  IndustryResearchNodeType,
  ResearchDepth,
  ResearchGenerationStage,
  ResearchPurpose,
  ResearchSourceType,
} from '../database/types'
import { callWithFallback } from './aiFallbackService'
import { IndustryResearchError } from './industryResearchError'
import {
  collectIndustryResearchProjectFinancials,
  reconcileIndustryResearchProjectMainBusinessExposures,
  type ProjectFinancialCollectionState,
} from './industryResearchFinancialCollectionService'
import type { IndustryResearchFinancialFetchers } from './industryResearchFinancialSyncService'
import { runOpenAINativeResearchSearch } from './industryResearchNativeWebSearchService'
import {
  confirmProjectEvidenceCandidate,
  getWebSearchConfigView,
  listProjectEvidenceCandidates,
  retrieveResearchEvidenceCandidates,
  saveWebSearchConfigAndView,
  validateConfiguredWebSearch,
} from './researchToolRuntime'
import { loadSkillContent, type SkillMeta } from './skillService'
import {
  buildStockResearchFactBundle,
  isReusableStockResearchFactBundle,
} from './researchFactPromptService'
import {
  auditResearchText,
  buildBlockedResearchText,
  buildResearchAuditTraceView,
} from './researchEvidenceAuditService'

const STAGES: ResearchGenerationStage[] = [
  'retrieve', 'scope', 'map', 'evidence', 'hypothesis', 'companies', 'report',
]
const NODE_TYPES = new Set<IndustryResearchNodeType>([
  'industry', 'product', 'material', 'process', 'equipment', 'company', 'country', 'demand',
  'metric', 'stock', 'technology', 'policy', 'hypothesis', 'shock',
])

export interface GenerationScopeInput {
  title?: string | null
  industryName?: string | null
  productScope?: string | null
  regionScope?: string | null
  timeScope?: string | null
  purpose?: ResearchPurpose
  depth?: ResearchDepth
  dataAsOf?: string | null
  stopCondition?: string | null
  enableWebRetrieval?: boolean
}

export interface StartGenerationInput {
  researchQuestion: string
  projectId?: string
  scope?: GenerationScopeInput
  sourceType?: ResearchSourceType
  sourceRef?: string | null
  sourceText?: string | null
}

type ProgressEmitter = (payload: {
  projectId: string
  runId: string
  status: IndustryResearchGenerationRunRow['status']
  stage: ResearchGenerationStage
  progressCurrent: number
  progressTotal: number
  message: string
  updatedAt: number
  financialCollection?: ProjectFinancialCollectionState | null
}) => void

const activeGenerationRunIds = new Set<string>()

interface GenerationFinancialOptions {
  token?: string | null
  fetchers?: IndustryResearchFinancialFetchers
}

function launchGenerationPipeline(
  db: Database.Database,
  runId: string,
  skill: SkillMeta,
  emitter?: ProgressEmitter,
  resumeAfterCompanies = false,
  financialOptions?: GenerationFinancialOptions,
): void {
  activeGenerationRunIds.add(runId)
  void runGenerationPipeline(db, runId, skill, emitter, resumeAfterCompanies, financialOptions)
    .finally(() => activeGenerationRunIds.delete(runId))
}

function stageIndex(stage: ResearchGenerationStage): number {
  return Math.max(0, STAGES.indexOf(stage))
}

function stableId(projectId: string, kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(`${projectId}:${kind}:${value}`).digest('hex').slice(0, 20)}`
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // continue
  }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  try {
    const parsed = JSON.parse(trimmed.slice(first, last + 1))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return null
  }
  return null
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const fencedBlocks = Array.from(raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((item) => item[1] || '')
  const candidates = [...fencedBlocks, raw]
  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate)
    if (parsed) return parsed
  }
  throw new IndustryResearchError('GENERATION_SCHEMA_INVALID', '模型未返回可解析 JSON')
}

function looksLikeMarkdownDocument(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 200) return false
  // 拒绝图谱节点管道串、纯列表碎片等非报告正文
  const pipeCount = (trimmed.match(/\s\|\s|→|-->/g) || []).length
  const headingCount = (trimmed.match(/^#{1,3}\s+\S+/gm) || []).length
  if (pipeCount >= 12 && headingCount < 2) return false
  if (headingCount >= 3) return true
  if (/^#\s+\S+/m.test(trimmed) && headingCount >= 2 && trimmed.length >= 400) return true
  return false
}

function stripMarkdownFences(text: string): string {
  const fenced = text.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i)
  return (fenced?.[1] || text).trim()
}

function compactMapForWriting(map: unknown): { nodes: string[]; edges: string[] } {
  const payload = (map && typeof map === 'object') ? map as { nodes?: unknown[]; edges?: unknown[] } : {}
  const nodes = Array.isArray(payload.nodes)
    ? payload.nodes.slice(0, 40).map((item) => {
      const row = item as Record<string, unknown>
      const name = asString(row.name, 80)
      const type = asString(row.type, 40)
      return name ? `${name}${type ? `（${type}）` : ''}` : ''
    }).filter(Boolean)
    : []
  const edges = Array.isArray(payload.edges)
    ? payload.edges.slice(0, 40).map((item) => {
      const row = item as Record<string, unknown>
      const source = asString(row.source, 80)
      const target = asString(row.target, 80)
      const relation = asString(row.relation, 40) || '关联'
      return source && target ? `${source} -[${relation}]-> ${target}` : ''
    }).filter(Boolean)
    : []
  return { nodes, edges }
}

function compactHypothesesForWriting(hypotheses: unknown): string[] {
  if (!Array.isArray(hypotheses)) return []
  return hypotheses.slice(0, 12).map((item) => {
    const row = item as Record<string, unknown>
    const statement = asString(row.statement, 300)
    const disproof = asString(row.cheapestDisproof, 200)
    if (!statement) return ''
    return disproof ? `${statement}（反证：${disproof}）` : statement
  }).filter(Boolean)
}

function compactCompaniesForWriting(companies: unknown): string[] {
  const payload = (companies && typeof companies === 'object')
    ? companies as { items?: unknown[]; coverage?: { targets?: unknown[] } }
    : {}
  const items = Array.isArray(payload.items) ? payload.items : []
  const rows = items.slice(0, 20).map((item) => {
    const row = item as Record<string, unknown>
    const name = asString(row.displayName, 80) || asString(row.legalNameCandidate, 80)
    const rationale = asString(row.rationale, 200)
    const tsCode = asString(row.tsCodeHint, 20)
    if (!name) return ''
    return `${name}${tsCode ? `（${tsCode}）` : ''}${rationale ? `：${rationale}` : ''}`
  }).filter(Boolean)
  const coverageTargets = Array.isArray(payload.coverage?.targets) ? payload.coverage.targets : []
  const gaps = coverageTargets.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const status = asString(row.status, 40)
    const name = asString(row.nodeName, 100)
    const reason = asString(row.reason, 180)
    return status === 'uncovered' && name
      ? [`覆盖缺口：${name}${reason ? `（${reason}）` : ''}`]
      : []
  }).slice(0, 8)
  return [...rows, ...gaps]
}

const REPORT_FINANCIAL_METRICS = new Set([
  'revenue', 'n_income_attr_p', 'revenue_single_quarter', 'n_income_attr_p_single_quarter',
  'grossprofit_margin', 'netprofit_margin', 'profit_dedt', 'profit_dedt_single_quarter',
  'q_sales_yoy', 'q_netprofit_yoy', 'q_gsprofit_margin',
  'accounts_receiv', 'notes_receiv', 'inventories', 'contract_assets',
  'n_cashflow_act', 'n_cashflow_act_single_quarter', 'c_pay_acq_const_fiolta',
  'type', 'p_change_min', 'p_change_max', 'net_profit_min', 'net_profit_max', 'change_reason',
])

interface FinancialReportContextRow {
  company_id: string
  legal_name: string
  short_name: string | null
  ts_code: string | null
  source_api: string
  metric_name: string
  metric_value: number | null
  text_value: string | null
  report_period: string
  fact_kind: string
  derivation_status: string
  knowledge_date: string
}

export function buildProjectFinancialReportContext(
  db: Database.Database,
  projectId: string,
  dataAsOf: string | null | undefined,
  companyHints: string[] = [],
): Array<Record<string, unknown>> {
  const cutoff = String(dataAsOf || '').replace(/-/g, '')
  if (!/^\d{8}$/.test(cutoff)) return []
  const rows = db.prepare(`
    SELECT c.id AS company_id, c.legal_name, c.short_name, s.ts_code,
           f.source_api, f.metric_name, f.metric_value, f.text_value,
           f.report_period, f.fact_kind, f.derivation_status,
           COALESCE(f.f_ann_date, f.ann_date, f.report_period) AS knowledge_date
    FROM industry_research_project_companies pc
    JOIN industry_research_companies c ON c.id = pc.company_id
    JOIN industry_research_financial_facts f ON f.company_id = c.id
    LEFT JOIN industry_research_securities s ON s.id = f.security_id
    WHERE pc.project_id = ? AND pc.status <> 'excluded'
      AND COALESCE(f.f_ann_date, f.ann_date, f.report_period) <= ?
      AND (f.metric_value IS NOT NULL OR f.text_value IS NOT NULL)
    ORDER BY COALESCE(f.f_ann_date, f.ann_date, f.report_period) DESC,
             f.fetched_at DESC, f.source_version DESC
  `).all(projectId, cutoff) as FinancialReportContextRow[]

  const hints = companyHints.map((value) => value.trim().toLocaleLowerCase('zh-CN')).filter(Boolean)
  const companyMap = new Map<string, {
    companyId: string
    legalName: string
    shortName: string | null
    tsCodes: Set<string>
    periods: Map<string, Map<string, FinancialReportContextRow>>
  }>()
  for (const row of rows) {
    if (!REPORT_FINANCIAL_METRICS.has(row.metric_name)) continue
    const searchable = `${row.legal_name} ${row.short_name || ''} ${row.ts_code || ''}`.toLocaleLowerCase('zh-CN')
    if (hints.length && !hints.some((hint) => searchable.includes(hint) || hint.includes(row.short_name?.toLocaleLowerCase('zh-CN') || row.legal_name.toLocaleLowerCase('zh-CN')))) continue
    let company = companyMap.get(row.company_id)
    if (!company) {
      if (companyMap.size >= 8) continue
      company = {
        companyId: row.company_id,
        legalName: row.legal_name,
        shortName: row.short_name,
        tsCodes: new Set<string>(),
        periods: new Map(),
      }
      companyMap.set(row.company_id, company)
    }
    if (row.ts_code) company.tsCodes.add(row.ts_code)
    let period = company.periods.get(row.report_period)
    if (!period) {
      if (company.periods.size >= 5) continue
      period = new Map()
      company.periods.set(row.report_period, period)
    }
    const metricKey = `${row.source_api}:${row.metric_name}`
    if (!period.has(metricKey) && period.size < 20) period.set(metricKey, row)
  }

  return Array.from(companyMap.values()).map((company) => ({
    companyId: company.companyId,
    legalName: company.legalName,
    shortName: company.shortName,
    tsCodes: Array.from(company.tsCodes),
    periods: Array.from(company.periods.entries())
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([reportPeriod, metrics]) => ({
        reportPeriod,
        metrics: Array.from(metrics.values()).map((row) => ({
          dataset: row.source_api,
          metric: row.metric_name,
          value: row.metric_value,
          textValue: row.text_value,
          factKind: row.fact_kind,
          derivationStatus: row.derivation_status,
          knowledgeDate: row.knowledge_date,
        })),
      })),
  }))
}

interface BusinessExposureReportRow {
  company_id: string
  legal_name: string
  short_name: string | null
  ts_code: string | null
  report_period: string
  item_name: string
  revenue: number | null
  cost: number | null
  profit: number | null
  currency: string | null
}

export function buildProjectBusinessExposureReportContext(
  db: Database.Database,
  projectId: string,
  companyHints: string[] = [],
  dataAsOf?: string | null,
): Array<Record<string, unknown>> {
  const hints = companyHints.map((value) => value.trim().toLocaleLowerCase('zh-CN')).filter(Boolean)
  const cutoff = String(dataAsOf || '').replace(/-/g, '')
  const reportPeriodCutoff = /^\d{8}$/.test(cutoff) ? cutoff : '99999999'
  const rows = db.prepare(`
    SELECT c.id AS company_id, c.legal_name, c.short_name, s.ts_code,
           mbi.report_period, mbi.item_name, mbi.revenue, mbi.cost, mbi.profit, mbi.currency
    FROM industry_research_project_companies pc
    JOIN industry_research_companies c ON c.id = pc.company_id
    JOIN industry_research_business_exposures exposure
      ON exposure.project_id = pc.project_id AND exposure.company_id = pc.company_id
    JOIN industry_research_main_business_items mbi ON mbi.id = exposure.main_business_item_id
    LEFT JOIN industry_research_securities s ON s.company_id = c.id
    WHERE pc.project_id = ? AND pc.status <> 'excluded'
      AND exposure.status <> 'excluded'
      AND mbi.report_period <= ?
    ORDER BY c.legal_name, mbi.report_period DESC,
             CASE WHEN mbi.revenue IS NULL THEN 1 ELSE 0 END, mbi.revenue DESC, mbi.item_name
  `).all(projectId, reportPeriodCutoff) as BusinessExposureReportRow[]
  const companies = new Map<string, {
    companyId: string
    legalName: string
    shortName: string | null
    tsCodes: Set<string>
    latestPeriod: string
    items: BusinessExposureReportRow[]
  }>()
  for (const row of rows) {
    const searchable = `${row.legal_name} ${row.short_name || ''} ${row.ts_code || ''}`.toLocaleLowerCase('zh-CN')
    if (hints.length && !hints.some((hint) => searchable.includes(hint) || hint.includes(row.short_name?.toLocaleLowerCase('zh-CN') || row.legal_name.toLocaleLowerCase('zh-CN')))) continue
    let company = companies.get(row.company_id)
    if (!company) {
      if (companies.size >= 8) continue
      company = {
        companyId: row.company_id,
        legalName: row.legal_name,
        shortName: row.short_name,
        tsCodes: new Set<string>(),
        latestPeriod: row.report_period,
        items: [],
      }
      companies.set(row.company_id, company)
    }
    if (row.ts_code) company.tsCodes.add(row.ts_code)
    if (row.report_period !== company.latestPeriod || company.items.length >= 12) continue
    company.items.push(row)
  }
  return Array.from(companies.values()).map((company) => ({
    companyId: company.companyId,
    legalName: company.legalName,
    shortName: company.shortName,
    tsCodes: Array.from(company.tsCodes),
    reportPeriod: company.latestPeriod,
    items: company.items.map((item) => ({
      name: item.item_name,
      revenue: item.revenue,
      cost: item.cost,
      profit: item.profit,
      currency: item.currency,
      status: 'candidate',
      source: 'tushare:fina_mainbz',
    })),
  }))
}

function financialCoverageMarkdown(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const state = value as Partial<ProjectFinancialCollectionState>
  const totalCompanies = Number(state.totalCompanies || 0)
  const totalDatasets = Number(state.totalDatasets || 0)
  const coveredDatasets = Number(state.coveredDatasets || 0)
  const failedDatasets = Number(state.failedDatasets || 0)
  const pendingDatasets = Number(state.pendingDatasets || 0)
  const companyGaps = Array.isArray(state.companies)
    ? state.companies
      .filter((company) => company.failedDatasets > 0 || company.pendingDatasets > 0)
      .slice(0, 8)
      .map((company) => `${company.companyName}（${company.tsCode}）：覆盖 ${company.coveredDatasets}/9，失败 ${company.failedDatasets}`)
    : []
  const lines = [
    '## 公司财务数据覆盖',
    '',
    totalCompanies > 0
      ? `本次对 ${totalCompanies} 家映射 A 股公司执行了结构化业务与财务采集，已覆盖 ${coveredDatasets}/${totalDatasets} 个公司数据集；失败 ${failedDatasets} 个，尚待继续收集 ${pendingDatasets} 个。`
      : (state.message || '本次没有形成可采集的唯一 A 股公司映射。'),
  ]
  if (state.errorCode) lines.push('', `采集边界：${state.message || state.errorCode}`)
  if (companyGaps.length) lines.push('', '仍有缺口的公司：', ...companyGaps.map((item) => `- ${item}`))
  lines.push('', '上述业务构成为数据源候选口径，未经过公告原文人工确认；财务数值只来自本地结构化事实，未由模型补写。')
  return lines.join('\n')
}

function compactCandidatesForWriting(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return []
  return candidates.slice(0, 12).map((item) => {
    const row = item as Record<string, unknown>
    const title = asString(row.title, 120)
    const summary = asString(row.summary, 180) || asString(row.excerpt, 180)
    const url = asString(row.url, 300)
    if (!title && !summary) return ''
    return `${title || '公开来源'}${summary ? `：${summary}` : ''}${url ? `（${url}）` : ''}`
  }).filter(Boolean)
}

function asString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function asStringArray(value: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asString(item, maxLen))
    .filter(Boolean)
    .slice(0, maxItems)
}

function beijingDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function resolveGenerationDataAsOf(explicitDataAsOf?: string | null, now = new Date()): string {
  return asString(explicitDataAsOf, 20) || beijingDate(now)
}

export function normalizeReportConflicts(value: unknown, authoritativeDataAsOf: string): string[] {
  return asStringArray(value, 20, 200).filter((conflict) => {
    const boundaryAfterLabel = conflict.match(/(?:数据)?(?:截至|截止|基准)(?:日|日期)?[^\d]{0,8}((?:19|20)\d{2}-\d{2}-\d{2})/)
    const boundaryBeforeLabel = conflict.match(/((?:19|20)\d{2}-\d{2}-\d{2})[^\d]{0,8}(?:数据)?(?:截至|截止|基准)(?:日|日期)?/)
    const mentionedBoundary = boundaryAfterLabel?.[1] || boundaryBeforeLabel?.[1]
    return !mentionedBoundary || mentionedBoundary === authoritativeDataAsOf
  })
}

function parseArtifacts(run: IndustryResearchGenerationRunRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(run.stage_artifacts_json || '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function emitProgress(
  emitter: ProgressEmitter | undefined,
  run: IndustryResearchGenerationRunRow,
): void {
  const artifacts = parseArtifacts(run)
  emitter?.({
    projectId: run.project_id,
    runId: run.id,
    status: run.status,
    stage: run.current_stage,
    progressCurrent: run.progress_current,
    progressTotal: run.progress_total,
    message: run.progress_message,
    updatedAt: run.updated_at,
    financialCollection: artifacts.financialCollection && typeof artifacts.financialCollection === 'object'
      ? artifacts.financialCollection as ProjectFinancialCollectionState
      : null,
  })
}

function ensureNotCancelled(db: Database.Database, runId: string): IndustryResearchGenerationRunRow {
  const run = getGenerationRun(db, runId)
  if (!run) throw new IndustryResearchError('NOT_FOUND', '生成运行不存在')
  if (run.cancel_requested === 1 || run.status === 'cancelled') {
    const cancelled = updateGenerationRun(db, runId, {
      status: 'cancelled',
      progressMessage: '生成已取消',
      completedAt: Date.now(),
      retryable: true,
      errorCode: 'GENERATION_CANCELLED',
      errorMessage: '用户取消了研究生成',
    })!
    throw Object.assign(new IndustryResearchError('GENERATION_CANCELLED', '生成已取消'), { run: cancelled })
  }
  return run
}

function inferExchange(tsCode: string): 'SSE' | 'SZSE' | 'BSE' {
  if (tsCode.endsWith('.SH')) return 'SSE'
  if (tsCode.endsWith('.BJ')) return 'BSE'
  return 'SZSE'
}

async function callStageJson(
  db: Database.Database,
  prompt: string,
): Promise<{ provider: string; model: string; payload: Record<string, unknown>; rawText: string }> {
  try {
    const result = await callWithFallback(db, { prompt })
    return {
      provider: result.provider,
      model: result.model,
      payload: extractJsonObject(result.text),
      rawText: result.text,
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'AI_NOT_CONFIGURED') {
      throw new IndustryResearchError('AI_NOT_CONFIGURED', '尚未配置可用的 AI 模型')
    }
    if (error instanceof Error && error.message === 'AI_CREDENTIALS_UNAVAILABLE') {
      throw new IndustryResearchError(
        'AI_CREDENTIALS_UNAVAILABLE',
        'AI 模型已配置，但保存的凭据当前无法解密。请完整重启应用后重试；无需重新填写配置',
      )
    }
    if (error instanceof IndustryResearchError) throw error
    throw new IndustryResearchError('GENERATION_PROVIDER_FAILED', 'AI 生成调用失败')
  }
}

async function callStageText(
  db: Database.Database,
  prompt: string,
): Promise<{ provider: string; model: string; text: string }> {
  try {
    const result = await callWithFallback(db, { prompt })
    return {
      provider: result.provider,
      model: result.model,
      text: result.text,
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'AI_NOT_CONFIGURED') {
      throw new IndustryResearchError('AI_NOT_CONFIGURED', '尚未配置可用的 AI 模型')
    }
    if (error instanceof Error && error.message === 'AI_CREDENTIALS_UNAVAILABLE') {
      throw new IndustryResearchError(
        'AI_CREDENTIALS_UNAVAILABLE',
        'AI 模型已配置，但保存的凭据当前无法解密。请完整重启应用后重试；无需重新填写配置',
      )
    }
    if (error instanceof IndustryResearchError) throw error
    throw new IndustryResearchError('GENERATION_PROVIDER_FAILED', 'AI 生成调用失败')
  }
}

function buildReportMarkdownPrompt(input: {
  skillContent: string
  researchQuestion: string
  scope: unknown
  map: unknown
  evidence: unknown
  hypotheses: unknown
  companies: unknown
  candidates: unknown
  retrievalMode: string
  meta: Record<string, unknown>
  nativeResearchMemo?: string | null
  localBusinessExposures?: Array<Record<string, unknown>>
  localFinancialFacts?: Array<Record<string, unknown>>
  researchFactsMarkdown?: string
  researchEvidenceContrastMarkdown?: string
  financialCollection?: unknown
}): string {
  const mapCompact = compactMapForWriting(input.map)
  const hypotheses = compactHypothesesForWriting(input.hypotheses)
  const companies = compactCompaniesForWriting(input.companies)
  const candidates = compactCandidatesForWriting(input.candidates)
  return [
    '你是资深产业研究员。用户要的是一份“结论性研究报告”，不是审核清单，不是节点管道串，不是待办列表。',
    '只输出完整中文 Markdown 正文。不要输出 JSON，不要用代码围栏包裹全文，不要解释写作过程。',
    '',
    '写作要求：',
    '1. 先给核心结论表或结论段，再展开论证；读者 30 秒内应看懂“现在怎样、为什么、风险在哪、下一步看什么”。',
    '2. 必须是叙述性文档，禁止把图谱节点用 A | B | C | D 管道串输出。',
    '3. 严格区分事实 / 估算 / 假设 / 待补来源；没有证据的数字不得写成事实。',
    '4. 禁止买卖建议、目标价、仓位、止盈止损等交易指令。',
    '5. 若 retrievalMode 为 weak/offline，开头用引用块标明“弱取证草稿”。',
    '6. 至少包含这些二级标题：',
    '   ## 一、核心结论',
    '   ## 二、研究边界',
    '   ## 三、产业链全景',
    '   ## 四、供需、价格与景气判断',
    '   ## 五、利润池与瓶颈',
    '   ## 六、代表公司映射',
    '   ## 七、跟踪指标与证伪条件',
    '   ## 八、资料口径与缺口',
    '7. 核心结论优先用表格；产业链可用简短 bullet 或一张 Mermaid flowchart，不要输出超长节点清单。',
    '8. 公司映射只写线索级判断，并提示需回年报分部验证。',
    '9. 研究数据截止日只能采用【研究边界】中的 dataAsOf。不得使用模型知识截止日，不得自行另设旧截止日；只有资料晚于该明确日期时，才可标记为后见信息。',
    '10. 【本地结构化财务事实】来自研究流程自动采集或用户显式继续收集的报表接口。可用于验证收入、利润、毛利率、现金流、应收和存货是否兑现，但不得在缺少公告或经营证据时把变化全部归因于某次涨价。',
    '11. 对产业假设使用“获得支持 / 被削弱 / 已推翻 / 待验证”语义。中报尚未披露时，必须写明预告与实际财报的区别及下一验证日期，不能把预告当成已实现收入或利润。',
    '12. 必须按【财务采集覆盖】说明本次覆盖率、失败项和待补项；【业务构成候选】未经公告原文确认，不得写成已确认暴露。',
    '13. 【统一投研事实底稿】是本次运行固定截点的共享补充；公告仅为标题索引，未读取正文，不得升级为正式公告证据或影响方向。',
    '14. 【确定性证据对照】由结构化工具结果生成；支持、反证/风险和未知项必须并列消费，不得只选择支持项。',
    '',
    '【研究问题】',
    input.researchQuestion,
    '',
    '【检索模式】',
    input.retrievalMode,
    '',
    '【研究边界】',
    JSON.stringify(input.scope || {}),
    '',
    '【报告摘要元数据】',
    JSON.stringify(input.meta || {}),
    '',
    '【GPT 原生网页搜索研究备忘录】',
    input.nativeResearchMemo?.slice(0, 30000) || '未使用或不可用',
    '',
    '【图谱要点】',
    JSON.stringify(mapCompact),
    '',
    '【证据与待补】',
    JSON.stringify(input.evidence || {}),
    '',
    '【核心假设】',
    JSON.stringify(hypotheses),
    '',
    '【公司候选】',
    JSON.stringify(companies),
    '',
    '【财务采集覆盖】',
    JSON.stringify(input.financialCollection || {}),
    '',
    '【业务构成候选】',
    JSON.stringify(input.localBusinessExposures || []),
    '',
    '【本地结构化财务事实】',
    JSON.stringify(input.localFinancialFacts || []),
    '',
    '【统一投研事实底稿】',
    input.researchFactsMarkdown || '本次没有可靠证券身份，未执行股票事实工具。',
    '',
    '【确定性证据对照】',
    input.researchEvidenceContrastMarkdown || '当前没有可靠实体，未生成方向性证据对照。',
    '',
    '【公开来源摘录】',
    JSON.stringify(candidates),
    '',
    '【Skill 规范（压缩）】',
    input.skillContent.slice(0, 18000),
  ].join('\n')
}

function buildSkillPrompt(skillContent: string, stage: ResearchGenerationStage, context: string): string {
  return [
    '你是产业研究结构化生成器。必须严格遵守以下 Skill，并只输出 JSON，不要 Markdown，不要解释。',
    '所有外部事实只能来自给定候选证据或明确标记为待补来源；不得把模型记忆写成 fact。',
    '财务数字、市占率精确值、估值和交易指令一律不要编造。',
    '',
    '【Skill 正文】',
    skillContent.slice(0, 120000),
    '',
    `【当前阶段】${stage}`,
    '【上下文】',
    context,
  ].join('\n')
}

export function normalizeScopeArtifact(payload: Record<string, unknown>, fallback: GenerationScopeInput, question: string) {
  return {
    title: asString(payload.title, 200) || fallback.title || question.slice(0, 80),
    industryName: asString(payload.industryName, 120) || fallback.industryName || '待确认产业',
    productScope: asString(payload.productScope, 500) || fallback.productScope || question.slice(0, 120),
    regionScope: asString(payload.regionScope, 200) || fallback.regionScope || '中国',
    timeScope: asString(payload.timeScope, 200) || fallback.timeScope || '近三年',
    purpose: (['learning', 'strategy', 'investment'].includes(String(payload.purpose))
      ? String(payload.purpose)
      : (fallback.purpose || 'investment')) as ResearchPurpose,
    depth: (['quick', 'standard', 'deep'].includes(String(payload.depth))
      ? String(payload.depth)
      : (fallback.depth || 'standard')) as ResearchDepth,
    dataAsOf: resolveGenerationDataAsOf(fallback.dataAsOf),
    stopCondition: asString(payload.stopCondition, 1000) || fallback.stopCondition || null,
    coreQuestions: asStringArray(payload.coreQuestions, 8, 200),
  }
}

function sanitizeCandidateIds(value: unknown, allowed: Set<string>): string[] {
  return asStringArray(value, 12, 128).filter((id) => allowed.has(id))
}

interface ResearchMapArtifact {
  idNamespace?: 'project_v1'
  nodeAliases?: Record<string, string>
  nodes: ResearchNodeInput[]
  edges: ResearchEdgeInput[]
}

function mergeUnique(values: string[], additions: string[]): string[] {
  return [...new Set([...values, ...additions])]
}

/**
 * Model IDs are prompt-local and can repeat across projects. Convert them to
 * stable project-scoped IDs before they can reach globally keyed graph tables.
 */
export function scopeResearchMapIds(
  projectId: string,
  input: ResearchMapArtifact,
): { map: ResearchMapArtifact & { idNamespace: 'project_v1' }; nodeIdMap: Map<string, string> } {
  if (input.idNamespace === 'project_v1') {
    const nodeIdMap = new Map(input.nodes.map((node) => [node.id, node.id]))
    for (const [sourceId, canonicalId] of Object.entries(input.nodeAliases ?? {})) {
      nodeIdMap.set(sourceId, canonicalId)
    }
    return {
      map: input as ResearchMapArtifact & { idNamespace: 'project_v1' },
      nodeIdMap,
    }
  }

  const nodeIdMap = new Map<string, string>()
  const nodeByKey = new Map<string, ResearchNodeInput>()
  const nodes: ResearchNodeInput[] = []
  for (const node of input.nodes) {
    const name = node.name.trim()
    if (!name) continue
    const key = `${node.type}:${name.toLocaleLowerCase()}`
    const canonicalId = stableId(projectId, 'node', key)
    nodeIdMap.set(node.id, canonicalId)
    const existing = nodeByKey.get(key)
    if (existing) {
      existing.evidenceIds = mergeUnique(existing.evidenceIds ?? [], node.evidenceIds ?? [])
      if (existing.status === 'no_evidence_support' && node.status !== 'no_evidence_support') {
        existing.status = node.status
      }
      continue
    }
    const canonical = { ...node, id: canonicalId, name }
    nodeByKey.set(key, canonical)
    nodes.push(canonical)
  }

  const edgeByKey = new Map<string, ResearchEdgeInput>()
  const edges: ResearchEdgeInput[] = []
  for (const edge of input.edges) {
    const source = nodeIdMap.get(edge.source)
    const target = nodeIdMap.get(edge.target)
    if (!source || !target) continue
    const relation = edge.relation.trim() || '传导'
    const key = `${source}:${target}:${relation.toLocaleLowerCase()}`
    const existing = edgeByKey.get(key)
    if (existing) {
      existing.evidenceIds = mergeUnique(existing.evidenceIds ?? [], edge.evidenceIds ?? [])
      existing.bottleneck = Boolean(existing.bottleneck || edge.bottleneck)
      continue
    }
    const canonical = {
      ...edge,
      id: stableId(projectId, 'edge', key),
      source,
      target,
      relation,
    }
    edgeByKey.set(key, canonical)
    edges.push(canonical)
  }

  return {
    map: {
      idNamespace: 'project_v1',
      nodeAliases: Object.fromEntries(nodeIdMap),
      nodes,
      edges,
    },
    nodeIdMap,
  }
}

function normalizeMapArtifact(
  payload: Record<string, unknown>,
  projectId: string,
  allowedCandidateIds: Set<string>,
): ResearchMapArtifact & { idNamespace: 'project_v1' } {
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes.slice(0, 80) : []
  const nodes: ResearchNodeInput[] = []
  const nodeIds = new Set<string>()
  for (const item of rawNodes) {
    const row = item as Record<string, unknown>
    const name = asString(row.name, 200)
    if (!name) continue
    const type = NODE_TYPES.has(row.type as IndustryResearchNodeType)
      ? row.type as IndustryResearchNodeType
      : 'product'
    const id = asString(row.id, 128) || `${type}:${name}`
    if (nodeIds.has(id)) continue
    nodeIds.add(id)
    const candidateIds = sanitizeCandidateIds(row.candidateIds ?? row.evidenceIds, allowedCandidateIds)
    nodes.push({
      id,
      type,
      name,
      stage: asString(row.stage, 120) || null,
      statementKind: 'estimate',
      status: candidateIds.length ? (asString(row.status, 120) || 'ai_candidate') : 'no_evidence_support',
      metrics: [],
      evidenceIds: candidateIds,
      lastUpdated: null,
    })
  }
  const rawEdges = Array.isArray(payload.edges) ? payload.edges.slice(0, 160) : []
  const edges: ResearchEdgeInput[] = []
  for (const item of rawEdges) {
    const row = item as Record<string, unknown>
    const source = asString(row.source, 128)
    const target = asString(row.target, 128)
    const relation = asString(row.relation, 120) || '传导'
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) continue
    const candidateIds = sanitizeCandidateIds(row.candidateIds ?? row.evidenceIds, allowedCandidateIds)
    edges.push({
      id: asString(row.id, 128) || stableId(projectId, 'edge', `${source}:${target}:${relation}`),
      source,
      target,
      relation,
      statementKind: 'estimate',
      strength: null,
      bottleneck: row.bottleneck === true,
      exposurePct: null,
      evidenceIds: candidateIds,
      lastUpdated: null,
    })
  }
  if (!nodes.length) throw new IndustryResearchError('GENERATION_SCHEMA_INVALID', '图谱节点为空')
  return scopeResearchMapIds(projectId, { nodes, edges }).map
}

function normalizeHypothesisArtifact(payload: Record<string, unknown>, allowedCandidateIds: Set<string>) {
  const items = Array.isArray(payload.hypotheses) ? payload.hypotheses.slice(0, 20) : []
  return items.map((item, index) => {
    const row = item as Record<string, unknown>
    const statement = asString(row.statement, 500)
    const cheapestDisproof = asString(row.cheapestDisproof, 500)
    if (!statement || !cheapestDisproof) return null
    const candidateIds = sanitizeCandidateIds(row.candidateIds, allowedCandidateIds)
    return {
      statement,
      cheapestDisproof,
      importance: Math.min(5, Math.max(1, Number(row.importance) || Math.min(5, index + 1))),
      verificationMetric: asString(row.verificationMetric, 200) || null,
      threshold: asString(row.threshold, 200) || null,
      candidateIds,
      noEvidenceSupport: candidateIds.length === 0,
    }
  }).filter(Boolean) as Array<{
    statement: string
    cheapestDisproof: string
    importance: number
    verificationMetric: string | null
    threshold: string | null
    candidateIds: string[]
    noEvidenceSupport: boolean
  }>
}

interface NormalizedCompanyArtifact {
  legalNameCandidate: string
  displayName: string
  rationale: string
  researchNodeIds: string[]
  tsCodeHint: string | null
  candidateIds: string[]
  noEvidenceSupport: boolean
}

interface CompanyCoverageTarget {
  nodeId: string
  nodeName: string
  stage: string | null
}

interface CompanyCoverageAudit {
  status: 'complete' | 'incomplete' | 'not_applicable'
  targetMinimum: number
  activeAShareCount: number
  targets: Array<CompanyCoverageTarget & {
    status: 'covered' | 'uncovered'
    companyNames: string[]
    reason: string | null
  }>
}

interface LocalSecurityCandidate {
  tsCode: string
  name: string
  industry: string | null
}

function normalizeCompanyArtifact(payload: Record<string, unknown>, allowedCandidateIds: Set<string>) {
  const items = Array.isArray(payload.companies) ? payload.companies.slice(0, 30) : []
  return items.map((item) => {
    const row = item as Record<string, unknown>
    const displayName = asString(row.displayName, 120) || asString(row.legalName, 200)
    if (!displayName) return null
    const candidateIds = sanitizeCandidateIds(row.candidateIds, allowedCandidateIds)
    return {
      legalNameCandidate: asString(row.legalName, 200) || displayName,
      displayName,
      rationale: asString(row.rationale, 500) || '模型候选公司',
      researchNodeIds: asStringArray(row.researchNodeIds, 20, 128),
      tsCodeHint: asString(row.tsCode, 20) || null,
      candidateIds,
      noEvidenceSupport: candidateIds.length === 0,
    }
  }).filter(Boolean) as NormalizedCompanyArtifact[]
}

function companyCoverageTargets(map: unknown): CompanyCoverageTarget[] {
  const payload = map && typeof map === 'object' ? map as { nodes?: unknown[] } : {}
  if (!Array.isArray(payload.nodes)) return []
  return payload.nodes.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    if (row.type !== 'company') return []
    const nodeId = asString(row.id, 128)
    const nodeName = asString(row.name, 160)
    const stage = asString(row.stage, 80) || null
    const status = asString(row.status, 300)
    const poolText = `${nodeName} ${stage || ''} ${status}`
    if (!nodeId || !nodeName || !/(A股|候选池|上市公司|资本市场)/i.test(poolText)) return []
    return [{ nodeId, nodeName, stage }]
  })
}

function uniqueArtifactSecurity(
  db: Database.Database,
  company: NormalizedCompanyArtifact,
): MatchedSecurityCandidate | null {
  const matched = matchSecurities(db, company.displayName, company.tsCodeHint)
  if (matched.length !== 1 || matched[0].matchStatus !== 'exact') return null
  return matched[0]
}

function mergeCompanyArtifacts(
  db: Database.Database,
  groups: NormalizedCompanyArtifact[][],
): NormalizedCompanyArtifact[] {
  const merged = new Map<string, NormalizedCompanyArtifact>()
  for (const company of groups.flat()) {
    const security = uniqueArtifactSecurity(db, company)
    const key = security?.tsCode.toUpperCase()
      || company.displayName.trim().toLocaleLowerCase('zh-CN')
    const current = merged.get(key)
    if (!current) {
      merged.set(key, company)
      continue
    }
    const incomingHasEvidence = company.candidateIds.length > 0
    const currentHasEvidence = current.candidateIds.length > 0
    merged.set(key, {
      ...current,
      legalNameCandidate: current.legalNameCandidate || company.legalNameCandidate,
      rationale: incomingHasEvidence && !currentHasEvidence ? company.rationale : current.rationale,
      researchNodeIds: [...new Set([...current.researchNodeIds, ...company.researchNodeIds])],
      tsCodeHint: current.tsCodeHint || company.tsCodeHint || security?.tsCode || null,
      candidateIds: [...new Set([...current.candidateIds, ...company.candidateIds])],
      noEvidenceSupport: !currentHasEvidence && !incomingHasEvidence,
    })
  }
  return [...merged.values()].slice(0, 30)
}

function retrievalQueryTexts(artifacts: Record<string, unknown>): string[] {
  const retrieve = artifacts.retrieve && typeof artifacts.retrieve === 'object'
    ? artifacts.retrieve as { plan?: { queries?: unknown[] } }
    : {}
  return Array.isArray(retrieve.plan?.queries)
    ? retrieve.plan.queries.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const text = asString((item as Record<string, unknown>).text, 600)
        return text ? [text] : []
      })
    : []
}

function discoverMentionedLocalSecurities(
  db: Database.Database,
  artifacts: Record<string, unknown>,
  selectedCandidates: Array<Record<string, unknown>>,
  allowedCandidateIds: Set<string>,
): NormalizedCompanyArtifact[] {
  const queryTexts = retrievalQueryTexts(artifacts)
  const memo = asString(
    (artifacts.retrieve as { nativeResearchMemo?: unknown } | undefined)?.nativeResearchMemo,
    30_000,
  )
  const evidenceTexts = selectedCandidates.map((item) => [item.title, item.summary, item.excerpt]
    .filter((value): value is string => typeof value === 'string')
    .join(' '))
  const rows = db.prepare(`
    SELECT ts_code, name, industry
    FROM stock_basic_cache
    WHERE list_status = 'L' AND name IS NOT NULL AND LENGTH(TRIM(name)) >= 2
    ORDER BY LENGTH(name) DESC, ts_code ASC
  `).all() as Array<{ ts_code: string; name: string; industry: string | null }>
  return rows.flatMap((row) => {
    const queryMentioned = queryTexts.some((text) => text.includes(row.name) || text.includes(row.ts_code))
    const evidenceIndexes = evidenceTexts.flatMap((text, index) => (
      text.includes(row.name) || text.includes(row.ts_code) ? [index] : []
    ))
    const bodyMentions = Number(memo.includes(row.name) || memo.includes(row.ts_code)) + evidenceIndexes.length
    if (!queryMentioned && bodyMentions < 2) return []
    const candidateIds = evidenceIndexes
      .map((index) => asString(selectedCandidates[index]?.id, 128))
      .filter((id) => Boolean(id) && allowedCandidateIds.has(id))
    return [{
      legalNameCandidate: row.name,
      displayName: row.name,
      rationale: candidateIds.length
        ? '检索正文已出现该A股公司，作为产业映射候选保留；实际业务暴露、收入与利润贡献仍需公司公告和主营构成验证。'
        : '检索计划已主动搜索该A股公司，但本轮代表性正文未形成可引用证据；作为待核验线索保留，不代表业务暴露或受益已经确认。',
      researchNodeIds: [],
      tsCodeHint: row.ts_code,
      candidateIds: [...new Set(candidateIds)],
      noEvidenceSupport: candidateIds.length === 0,
    }]
  }).slice(0, 30)
}

function localSecurityUniverse(
  db: Database.Database,
  companies: NormalizedCompanyArtifact[],
): LocalSecurityCandidate[] {
  const seedCodes = [...new Set(companies.flatMap((company) => {
    const security = uniqueArtifactSecurity(db, company)
    return security ? [security.tsCode] : []
  }))]
  if (!seedCodes.length) return []
  const placeholders = seedCodes.map(() => '?').join(', ')
  const seedRows = db.prepare(`
    SELECT ts_code, name, industry FROM stock_basic_cache
    WHERE list_status = 'L' AND ts_code IN (${placeholders})
  `).all(...seedCodes) as Array<{ ts_code: string; name: string | null; industry: string | null }>
  const industries = [...new Set(seedRows.map((row) => row.industry).filter((value): value is string => Boolean(value)))]
  const universeRows = industries.length
    ? db.prepare(`
        SELECT ts_code, name, industry FROM stock_basic_cache
        WHERE list_status = 'L' AND name IS NOT NULL
          AND industry IN (${industries.map(() => '?').join(', ')})
        ORDER BY ts_code ASC LIMIT 800
      `).all(...industries) as Array<{ ts_code: string; name: string; industry: string | null }>
    : seedRows.filter((row): row is { ts_code: string; name: string; industry: string | null } => Boolean(row.name))
  const priority = new Set(seedCodes)
  return universeRows
    .map((row) => ({ tsCode: row.ts_code, name: row.name, industry: row.industry }))
    .sort((left, right) => Number(priority.has(right.tsCode)) - Number(priority.has(left.tsCode)) || left.tsCode.localeCompare(right.tsCode))
}

function auditCompanyCoverage(
  db: Database.Database,
  map: unknown,
  companies: NormalizedCompanyArtifact[],
  requireInvestmentCoverage = false,
): CompanyCoverageAudit {
  const targets = companyCoverageTargets(map)
  if (!targets.length && !requireInvestmentCoverage) {
    return { status: 'not_applicable', targetMinimum: 0, activeAShareCount: 0, targets: [] }
  }
  const exactSecurities = new Map(companies.map((company) => [company, uniqueArtifactSecurity(db, company)]))
  const activeCodes = new Set([...exactSecurities.values()].flatMap((security) => (
    security ? [security.tsCode] : []
  )))
  const targetRows = targets.map((target) => {
    const names = companies
      .filter((company) => exactSecurities.get(company) && company.researchNodeIds.includes(target.nodeId))
      .map((company) => company.displayName)
    return {
      ...target,
      status: names.length ? 'covered' as const : 'uncovered' as const,
      companyNames: [...new Set(names)],
      reason: names.length ? null : '尚无公司候选明确关联该生态位',
    }
  })
  const targetMinimum = requireInvestmentCoverage
    ? Math.min(12, Math.max(3, targets.length))
    : targets.length
  return {
    status: activeCodes.size >= targetMinimum && targetRows.every((target) => target.status === 'covered')
      ? 'complete'
      : 'incomplete',
    targetMinimum,
    activeAShareCount: activeCodes.size,
    targets: targetRows,
  }
}

async function repairCompanyCoverage(
  db: Database.Database,
  skillContent: string,
  input: {
    researchQuestion: string
    scope: unknown
    map: unknown
    nativeResearchMemo: string
    selectedCandidates: Array<Record<string, unknown>>
    existingCompanies: NormalizedCompanyArtifact[]
    allowedCandidateIds: Set<string>
  },
): Promise<NormalizedCompanyArtifact[]> {
  const universe = localSecurityUniverse(db, input.existingCompanies)
  if (!universe.length) return []
  const coverage = auditCompanyCoverage(
    db,
    input.map,
    input.existingCompanies,
    (input.scope as { purpose?: unknown } | undefined)?.purpose === 'investment',
  )
  const result = await callStageJson(db, buildSkillPrompt(skillContent, 'companies', JSON.stringify({
    task: '公司覆盖补全',
    researchQuestion: input.researchQuestion,
    scope: input.scope,
    map: input.map,
    nativeResearchMemo: input.nativeResearchMemo,
    candidates: input.selectedCandidates,
    existingCompanies: input.existingCompanies,
    coverage,
    localActiveAShareUniverse: universe,
    requiredJson: {
      companies: [{
        legalName: 'string',
        displayName: 'string',
        rationale: 'string',
        researchNodeIds: ['string'],
        tsCode: 'string',
        candidateIds: ['string'],
      }],
    },
    rules: [
      '只补充localActiveAShareUniverse中存在且仍上市的A股证券，不输出全部证券名单',
      '从产业链关键生态位产生候选，不从概念股名单倒推产业逻辑',
      '每个关键生态位至少明确关联1家公司；竞争性生态位在合理时保留多家可比候选',
      '不得用同一家公司代替整条产业链，也不得因缺少正文证据而静默删除合理候选',
      '没有candidateIds时必须在rationale中明确“待核验”，不得声称业务暴露或受益已确认',
      'researchNodeIds只能使用map中已有节点ID',
    ],
  })))
  const allowedUniverse = new Set(universe.map((item) => item.tsCode))
  return normalizeCompanyArtifact(result.payload, input.allowedCandidateIds).flatMap((company) => {
    const security = uniqueArtifactSecurity(db, company)
    if (!security || !allowedUniverse.has(security.tsCode)) return []
    return [{ ...company, tsCodeHint: security.tsCode }]
  })
}

interface CompanyGraphProjection {
  map: ResearchMapArtifact & { idNamespace: 'project_v1' }
  companies: NormalizedCompanyArtifact[]
  roleNodeIdsByTsCode: Record<string, string[]>
  addedNodes: number
  addedEdges: number
}

function normalizedResearchName(value: string): string {
  return value.trim().replace(/股份有限公司|集团|[\s（）()]/g, '').toLocaleLowerCase('zh-CN')
}

function projectCompaniesIntoResearchMap(
  db: Database.Database,
  projectId: string,
  map: ResearchMapArtifact,
  companies: NormalizedCompanyArtifact[],
): CompanyGraphProjection {
  const { map: scoped, nodeIdMap } = scopeResearchMapIds(projectId, map)
  const nodes = scoped.nodes.map((node) => ({ ...node }))
  const edges = scoped.edges.map((edge) => ({ ...edge }))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const edgeKeys = new Set(edges.map((edge) => `${edge.source}:${edge.target}:${edge.relation}`))
  const roleNodeIdsByTsCode: Record<string, string[]> = {}
  let addedNodes = 0
  let addedEdges = 0

  const appendEdge = (
    source: string,
    target: string,
    relation: string,
    evidenceIds: string[],
  ) => {
    const key = `${source}:${target}:${relation}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({
      id: stableId(projectId, 'edge', key),
      source,
      target,
      relation,
      statementKind: 'estimate',
      strength: null,
      bottleneck: false,
      exposurePct: null,
      evidenceIds,
      lastUpdated: null,
    })
    addedEdges += 1
  }

  const projectedCompanies = companies.map((company) => {
    const security = uniqueArtifactSecurity(db, company)
    if (!security) return company
    const normalizedNames = new Set([
      normalizedResearchName(company.displayName),
      normalizedResearchName(company.legalNameCandidate),
      normalizedResearchName(security.stockName),
    ].filter(Boolean))
    const originalNodeIds = [...new Set(company.researchNodeIds
      .map((id) => nodeIdMap.get(id) ?? id)
      .filter((id) => nodeById.has(id)))]
    const candidatePoolNodeIds = originalNodeIds.filter((id) => {
      const node = nodeById.get(id)
      return node?.type === 'company' && /候选池/.test(node.name)
    })
    const fallbackRoleNodeIds = originalNodeIds.filter((id) => {
      const node = nodeById.get(id)
      if (!node || node.type === 'stock') return false
      if (node.type === 'company' && normalizedNames.has(normalizedResearchName(node.name))) return false
      return node.type !== 'company'
    })
    const roleNodeIds = (candidatePoolNodeIds.length ? candidatePoolNodeIds : fallbackRoleNodeIds).slice(0, 6)
    roleNodeIdsByTsCode[security.tsCode] = roleNodeIds

    let companyNode = nodes.find((node) => (
      node.type === 'company' && normalizedNames.has(normalizedResearchName(node.name))
    ))
    if (!companyNode) {
      const primaryRole = roleNodeIds.map((id) => nodeById.get(id)).find(Boolean)
      companyNode = {
        id: stableId(projectId, 'node', `company:${security.tsCode}`),
        type: 'company',
        name: company.legalNameCandidate || security.stockName,
        stage: primaryRole?.stage ?? '资本市场',
        statementKind: 'estimate',
        status: company.noEvidenceSupport
          ? '待核验产业候选；证券身份已确认，业务暴露、客户关系和受益程度仍需公告与主营构成验证'
          : company.rationale,
        metrics: [],
        evidenceIds: company.candidateIds,
        lastUpdated: null,
      }
      nodes.push(companyNode)
      nodeById.set(companyNode.id, companyNode)
      addedNodes += 1
    }

    const symbol = security.tsCode.split('.')[0]
    let stockNode = nodes.find((node) => node.type === 'stock' && (
      node.name.includes(security.tsCode) || node.name.includes(symbol)
    ))
    if (!stockNode) {
      stockNode = {
        id: stableId(projectId, 'node', `stock:${security.tsCode}`),
        type: 'stock',
        name: `${security.stockName}（${symbol}）`,
        stage: '资本市场',
        statementKind: 'estimate',
        status: '候选证券映射；业务暴露、财务贡献和投资结论以公司页后续核验为准',
        metrics: [],
        evidenceIds: company.candidateIds,
        lastUpdated: null,
      }
      nodes.push(stockNode)
      nodeById.set(stockNode.id, stockNode)
      addedNodes += 1
    }

    appendEdge(stockNode.id, companyNode.id, '映射到', company.candidateIds)
    for (const roleNodeId of roleNodeIds) {
      const roleNode = nodeById.get(roleNodeId)
      if (!roleNode || roleNode.id === companyNode.id) continue
      appendEdge(
        roleNode.id,
        companyNode.id,
        roleNode.type === 'company' && /候选池/.test(roleNode.name) ? '包含候选' : '关联候选',
        company.candidateIds,
      )
    }
    return {
      ...company,
      researchNodeIds: mergeUnique(originalNodeIds, [companyNode.id, stockNode.id]),
    }
  })

  return {
    map: { ...scoped, nodes, edges },
    companies: projectedCompanies,
    roleNodeIdsByTsCode,
    addedNodes,
    addedEdges,
  }
}

function storedCompanyArtifacts(
  artifacts: Record<string, unknown>,
  allowedCandidateIds: Set<string>,
): NormalizedCompanyArtifact[] {
  const items = (artifacts.companies as { items?: unknown[] } | undefined)?.items
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const displayName = asString(row.displayName, 120) || asString(row.legalNameCandidate, 200)
    if (!displayName) return []
    const candidateIds = sanitizeCandidateIds(row.candidateIds, allowedCandidateIds)
    return [{
      legalNameCandidate: asString(row.legalNameCandidate, 200) || displayName,
      displayName,
      rationale: asString(row.rationale, 500) || '既有公司候选',
      researchNodeIds: asStringArray(row.researchNodeIds, 20, 128),
      tsCodeHint: asString(row.tsCodeHint, 20) || null,
      candidateIds,
      noEvidenceSupport: candidateIds.length === 0 || row.noEvidenceSupport === true,
    }]
  })
}

export interface ResearchReportFindingArtifact {
  text: string
  candidateIds: string[]
}

export function normalizeReportFindings(
  value: unknown,
  allowedCandidateIds: Set<string>,
  fallbackCandidateIds: string[] = [],
): ResearchReportFindingArtifact[] {
  if (!Array.isArray(value)) return []
  const fallbackIds = sanitizeCandidateIds(fallbackCandidateIds, allowedCandidateIds).slice(0, 3)
  const findings: ResearchReportFindingArtifact[] = []
  for (const item of value.slice(0, 20)) {
    const row = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : null
    const text = row
      ? asString(row.text ?? row.finding ?? row.statement, 400)
      : asString(item, 400)
    if (!text) continue
    const candidateIds = row
      ? sanitizeCandidateIds(row.candidateIds ?? row.evidenceIds, allowedCandidateIds)
      : []
    findings.push({ text, candidateIds: candidateIds.length ? candidateIds : fallbackIds })
  }
  return findings
}

function buildFallbackReportMarkdown(input: {
  title: string
  dataAsOf: string | null
  summary: string
  supported: string[]
  modelOnly: string[]
  pendingSources: string[]
  scope?: Record<string, unknown> | null
  mapNodes?: string[]
  hypotheses?: string[]
  companies?: string[]
  candidates?: string[]
  retrievalMode?: string
}): string {
  const list = (items: string[], empty: string) => items.length
    ? items.map((item) => `- ${item}`).join('\n')
    : `- ${empty}`
  const scope = input.scope || {}
  const product = asString(scope.productScope, 200) || asString(scope.industryName, 120) || '研究对象待确认'
  const region = asString(scope.regionScope, 120) || '中国'
  const timeScope = asString(scope.timeScope, 120) || '近三年'
  const purpose = asString(scope.purpose, 40) || 'investment'
  const weak = input.retrievalMode === 'weak' || input.retrievalMode === 'offline'
  return [
    `# ${input.title}`,
    '',
    `> 数据截至：${input.dataAsOf || '未设置'}`,
    `> 研究范围：${product}；区域：${region}；时间：${timeScope}；目的：${purpose}`,
    weak
      ? '> **证据状态：弱取证草稿**。正文可独立阅读，但公开来源与模型推断并存，关键产业数字仍待原始资料补齐。'
      : '> 本报告由产业研究生成链路产出；事实、估算与假设应结合证据状态阅读。',
    '',
    '## 一、核心结论',
    '',
    '| 判断 | 内容 | 类型 |',
    '|---|---|---|',
    `| 当前判断 | ${input.summary || '已完成结构化研究草稿，需结合公开来源继续验证。'} | 估算 |`,
    `| 证据状态 | ${weak ? '弱取证/待补原始资料' : '已有公开候选来源，待人工确认后升格事实'} | 事实 |`,
    `| 优先验证 | ${input.pendingSources[0] || '集采量价、公司分部财务、库存交期'} | 假设 |`,
    '',
    input.summary || '当前尚未形成更细摘要。',
    '',
    '## 二、研究边界',
    '',
    `- 产品/产业：${product}`,
    `- 区域：${region}`,
    `- 时间：${timeScope}`,
    `- 目的：${purpose}`,
    '',
    '## 三、产业链全景',
    '',
    list((input.mapNodes || []).slice(0, 18), '图谱节点尚未形成，需重新生成或手工维护。'),
    '',
    '## 四、供需、价格与景气判断',
    '',
    list(input.supported.slice(0, 8), '尚无足够公开来源支撑的供需/价格结论。'),
    '',
    '## 五、利润池与瓶颈',
    '',
    list(input.modelOnly.slice(0, 8), '利润池与瓶颈仍以模型推断为主，需用开工率、ASP、毛利和现金流验证。'),
    '',
    '## 六、代表公司映射',
    '',
    list((input.companies || []).slice(0, 12), '公司候选尚未生成。'),
    '',
    '> 上表/列表仅为产业映射线索，不是已验证投资结论。',
    '',
    '## 七、跟踪指标与证伪条件',
    '',
    list((input.hypotheses || []).slice(0, 10), '核心假设尚未生成。'),
    '',
    '## 八、资料口径与缺口',
    '',
    '### 已收集公开来源摘录',
    '',
    list((input.candidates || []).slice(0, 10), '暂无。'),
    '',
    '### 待补来源',
    '',
    list(input.pendingSources, '暂无。'),
  ].join('\n')
}

function ensureWeakRetrievalBanner(markdown: string, retrievalMode: string, evidenceInsufficient: boolean): string {
  if (!(retrievalMode === 'weak' || retrievalMode === 'offline' || evidenceInsufficient)) return markdown
  if (/弱取证|弱检索|未完成强外部取证/.test(markdown.slice(0, 800))) return markdown
  const banner = [
    '> **证据状态：弱取证草稿**',
    '> 当前未完成强外部取证。正文可独立阅读，但公开媒体与模型推断并存；运营商集采成交价、库存、开工率、分规格供需等关键产业数字仍待公告/协会原始数据补齐。',
    '',
  ].join('\n')
  const headingMatch = markdown.match(/^#\s+.+$/m)
  if (!headingMatch || headingMatch.index == null) return `${banner}${markdown}`
  const insertAt = headingMatch.index + headingMatch[0].length
  return `${markdown.slice(0, insertAt)}\n\n${banner}${markdown.slice(insertAt).replace(/^\n+/, '')}`
}

function normalizeReportArtifact(
  payload: Record<string, unknown>,
  allowedCandidateIds: Set<string>,
  fallback: {
    title: string
    dataAsOf: string | null
    retrievalMode?: string
    representativeCandidateIds?: string[]
  },
) {
  const overallCandidateIds = sanitizeCandidateIds(payload.candidateIds, allowedCandidateIds)
  const supportedFindings = normalizeReportFindings(
    payload.supportedFindings ?? payload.supported,
    allowedCandidateIds,
    overallCandidateIds.length ? overallCandidateIds : fallback.representativeCandidateIds,
  )
  const supported = supportedFindings.map((item) => item.text)
  const modelOnly = asStringArray(payload.modelOnlyFindings ?? payload.modelOnly, 20, 400)
  const pendingSources = asStringArray(payload.pendingSources, 20, 300)
  const summary = asString(payload.summary, 4000)
  const title = asString(payload.title, 200) || fallback.title
  const generatedMarkdown = asString(payload.markdown, 60000)
  const candidateIds = [...new Set([
    ...overallCandidateIds,
    ...supportedFindings.flatMap((item) => item.candidateIds),
  ])]
  const evidenceInsufficient = payload.evidenceInsufficient === true
    || fallback.retrievalMode === 'weak'
    || fallback.retrievalMode === 'offline'
  const markdown = ensureWeakRetrievalBanner(
    generatedMarkdown || buildFallbackReportMarkdown({
      title,
      dataAsOf: fallback.dataAsOf,
      summary,
      supported,
      modelOnly,
      pendingSources,
    }),
    fallback.retrievalMode || 'weak',
    evidenceInsufficient,
  )
  return {
    title,
    summary,
    markdown,
    supportedFindings,
    modelOnlyFindings: modelOnly,
    pendingSources,
    candidateIds,
    noEvidenceSupport: candidateIds.length === 0 && supported.length === 0,
    evidenceInsufficient,
  }
}

function selectedCandidateViews(
  candidates: Array<{
    id: string
    title: string
    source_url: string
    summary: string | null
    excerpt: string | null
    status: string
    source_kind?: string | null
    rank_score?: number | null
  }>,
  selectedIds: string[],
) {
  const selected = new Set(selectedIds)
  const rows = candidates.filter((item) => selected.has(item.id))
  const list = rows.length ? rows : candidates.slice(0, 14)
  return list.map((item) => ({
    id: item.id,
    title: item.title,
    url: item.source_url,
    summary: item.summary,
    excerpt: item.excerpt,
    status: item.status,
    sourceKind: item.source_kind || 'web_search',
    rankScore: item.rank_score ?? null,
  }))
}

function matchSecurities(db: Database.Database, name: string, tsCodeHint?: string | null) {
  if (tsCodeHint) {
    const exact = searchByNameOrCode(db, tsCodeHint, 5)
      .filter((item) => item.tsCode.toUpperCase() === tsCodeHint.toUpperCase())
    if (exact.length === 1) {
      return exact.map((item) => ({
        tsCode: item.tsCode,
        stockName: item.name,
        exchange: inferExchange(item.tsCode),
        matchStatus: 'exact' as const,
      }))
    }
  }
  const rows = searchByNameOrCode(db, name, 5)
  if (!rows.length) return []
  if (rows.length === 1) {
    return [{
      tsCode: rows[0].tsCode,
      stockName: rows[0].name,
      exchange: inferExchange(rows[0].tsCode),
      matchStatus: 'exact' as const,
    }]
  }
  return rows.slice(0, 3).map((item) => ({
    tsCode: item.tsCode,
    stockName: item.name,
    exchange: inferExchange(item.tsCode),
    matchStatus: 'ambiguous' as const,
  }))
}

type MatchedSecurityCandidate = {
  tsCode: string
  stockName: string
  exchange: 'SSE' | 'SZSE' | 'BSE'
  matchStatus: 'exact' | 'ambiguous'
}

function parseMatchedSecurities(candidate: IndustryResearchCompanyCandidateRow): MatchedSecurityCandidate[] {
  try {
    const parsed = JSON.parse(candidate.matched_securities_json || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const value = item as Record<string, unknown>
      const tsCode = typeof value.tsCode === 'string' ? value.tsCode.trim().toUpperCase() : ''
      if (!/^\d{6}\.(SH|SZ|BJ)$/.test(tsCode)) return []
      const matchStatus = value.matchStatus === 'exact' ? 'exact' : value.matchStatus === 'ambiguous' ? 'ambiguous' : null
      if (!matchStatus) return []
      return [{
        tsCode,
        stockName: typeof value.stockName === 'string' && value.stockName.trim() ? value.stockName.trim() : tsCode,
        exchange: inferExchange(tsCode),
        matchStatus,
      }]
    })
  } catch {
    return []
  }
}

function uniqueActiveAShareMatch(
  db: Database.Database,
  candidate: IndustryResearchCompanyCandidateRow,
): MatchedSecurityCandidate | null {
  const matches = parseMatchedSecurities(candidate)
  if (matches.length !== 1 || matches[0].matchStatus !== 'exact') return null
  const match = matches[0]
  const active = searchByNameOrCode(db, match.tsCode, 5)
    .filter((item) => item.tsCode.toUpperCase() === match.tsCode)
  if (active.length !== 1) return null
  return {
    tsCode: active[0].tsCode.toUpperCase(),
    stockName: active[0].name,
    exchange: inferExchange(active[0].tsCode),
    matchStatus: 'exact',
  }
}

function companyCandidateEvidenceIds(
  db: Database.Database,
  projectId: string,
  runId: string,
  candidate: IndustryResearchCompanyCandidateRow,
  artifacts: Record<string, unknown>,
): string[] {
  const companyItems = Array.isArray((artifacts.companies as { items?: unknown[] } | undefined)?.items)
    ? (artifacts.companies as { items: Array<Record<string, unknown>> }).items
    : []
  const sourceCompany = companyItems.find((item) => (
    item.displayName === candidate.display_name
    || item.legalNameCandidate === candidate.legal_name_candidate
  ))
  const expansion = artifacts.companyExpansion && typeof artifacts.companyExpansion === 'object'
    ? artifacts.companyExpansion as { chainVersion?: unknown; sourceRunId?: unknown }
    : null
  const evidenceRunId = expansion?.chainVersion === 2 && typeof expansion.sourceRunId === 'string'
    ? expansion.sourceRunId
    : runId
  const runCandidateIds = new Set(listEvidenceCandidates(db, { projectId, runId: evidenceRunId }).map((item) => item.id))
  return sanitizeCandidateIds(sourceCompany?.candidateIds, runCandidateIds)
}

function materializeProjectCompanyCandidate(
  db: Database.Database,
  projectId: string,
  runId: string,
  candidate: IndustryResearchCompanyCandidateRow,
  security: MatchedSecurityCandidate,
  artifacts: Record<string, unknown>,
): IndustryResearchCompanyCandidateRow {
  const existingSecurity = getResearchSecurityByTsCode(db, security.tsCode)
  const normalizedNames = new Set([
    candidate.display_name.trim().toLocaleLowerCase('zh-CN'),
    candidate.legal_name_candidate.trim().toLocaleLowerCase('zh-CN'),
    security.stockName.trim().toLocaleLowerCase('zh-CN'),
  ].filter(Boolean))
  const projectNameMatches = existingSecurity ? [] : listResearchProjectCompanies(db, projectId).filter((company) => (
    normalizedNames.has(company.legal_name.trim().toLocaleLowerCase('zh-CN'))
    || (company.short_name != null && normalizedNames.has(company.short_name.trim().toLocaleLowerCase('zh-CN')))
  ))
  const companyId = existingSecurity?.company_id
    ?? (projectNameMatches.length === 1 ? projectNameMatches[0].company_id : null)
    ?? stableId('security_master', 'company', security.tsCode)
  const existingProjectCompany = getResearchProjectCompany(db, projectId, companyId)
  if (existingProjectCompany?.status === 'excluded') {
    return candidate.resolution_status === 'excluded'
      ? candidate
      : updateCompanyCandidateResolution(db, candidate.id, 'excluded', existingProjectCompany.exclusion_reason)!
  }
  if (!existingSecurity) {
    if (projectNameMatches.length !== 1) {
      saveResearchCompany(db, {
        id: companyId,
        legalName: security.stockName,
        shortName: security.stockName,
        sourceType: 'tushare',
        sourceRef: `stock_basic_cache:${security.tsCode}`,
      })
    }
    saveResearchSecurity(db, {
      id: stableId('security_master', 'security', security.tsCode),
      companyId,
      tsCode: security.tsCode,
      exchange: security.exchange,
      securityType: 'stock',
      listStatus: 'L',
      mappingSource: 'tushare',
      sourceRef: `stock_basic_cache:${security.tsCode}`,
    })
  }

  if (!existingProjectCompany) {
    saveResearchProjectCompany(db, {
      projectId,
      companyId,
      status: 'candidate',
      exclusionReason: null,
      evidenceIds: companyCandidateEvidenceIds(db, projectId, runId, candidate, artifacts),
    })
  }
  if (candidate.resolution_status === 'accepted') return candidate
  return updateCompanyCandidateResolution(db, candidate.id, 'accepted', null)!
}

function candidatesForRunOrLegacyProject(
  db: Database.Database,
  projectId: string,
  runId: string,
  artifacts: Record<string, unknown>,
): IndustryResearchCompanyCandidateRow[] {
  const current = listCompanyCandidates(db, { projectId, runId })
  if (current.length) return current
  const companyItems = Array.isArray((artifacts.companies as { items?: unknown[] } | undefined)?.items)
    ? (artifacts.companies as { items: Array<Record<string, unknown>> }).items
    : []
  const names = new Set(companyItems.flatMap((item) => [item.displayName, item.legalNameCandidate])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
  return listCompanyCandidates(db, { projectId }).filter((candidate) => (
    names.has(candidate.display_name) || names.has(candidate.legal_name_candidate)
  ))
}

function materializeExactProjectCompanies(
  db: Database.Database,
  projectId: string,
  runId: string,
  artifacts: Record<string, unknown>,
): number {
  let materialized = 0
  for (const candidate of candidatesForRunOrLegacyProject(db, projectId, runId, artifacts)) {
    if (candidate.resolution_status === 'excluded') continue
    const security = uniqueActiveAShareMatch(db, candidate)
    if (!security) continue
    const before = getResearchSecurityByTsCode(db, security.tsCode)
    const existingProjectCompany = before
      ? getResearchProjectCompany(db, projectId, before.company_id)
      : null
    materializeProjectCompanyCandidate(db, projectId, runId, candidate, security, artifacts)
    if (!existingProjectCompany) materialized += 1
  }
  return materialized
}

function applyGenerationArtifacts(
  db: Database.Database,
  projectId: string,
  artifacts: Record<string, unknown>,
  runId?: string,
): void {
  const project = getResearchProject(db, projectId)
  if (!project) throw new IndustryResearchError('NOT_FOUND', '研究项目不存在')
  const rawMap = artifacts.map as ResearchMapArtifact | undefined
  const scoped = rawMap?.nodes?.length
    ? scopeResearchMapIds(projectId, rawMap)
    : null
  if (scoped) {
    artifacts.map = scoped.map
    const companies = artifacts.companies as { items?: Array<Record<string, unknown>> } | undefined
    if (Array.isArray(companies?.items)) {
      companies.items = companies.items.map((item) => ({
        ...item,
        researchNodeIds: asStringArray(item.researchNodeIds, 20, 128)
          .map((id) => scoped.nodeIdMap.get(id) || id),
      }))
    }
  }

  const persist = db.transaction(() => {
    const scope = artifacts.scope as ReturnType<typeof normalizeScopeArtifact> | undefined
    if (scope) {
      updateResearchProject(db, projectId, {
        title: scope.title,
        industryName: scope.industryName,
        productScope: scope.productScope,
        regionScope: scope.regionScope,
        timeScope: scope.timeScope,
        purpose: scope.purpose,
        depth: scope.depth,
        dataAsOf: scope.dataAsOf,
        stopCondition: scope.stopCondition,
        status: 'active',
      })
    }
    if (scoped?.map.nodes.length) {
      const latest = getResearchProject(db, projectId)!
      replaceResearchGraph(db, projectId, scoped.map.nodes, scoped.map.edges, latest.graph_updated_at)
    }
    if (runId && scoped) {
      const updateCandidateNodes = db.prepare(`
        UPDATE industry_research_company_candidates
        SET research_node_ids_json = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND run_id = ?
      `)
      for (const candidate of listCompanyCandidates(db, { projectId, runId })) {
        let nodeIds: string[] = []
        try { nodeIds = JSON.parse(candidate.research_node_ids_json || '[]') as string[] } catch { /* repair below */ }
        const remapped = nodeIds.map((id) => scoped.nodeIdMap.get(id) || id)
        updateCandidateNodes.run(JSON.stringify([...new Set(remapped)]), Date.now(), candidate.id, projectId, runId)
      }
    }
    if (runId) {
      materializeExactProjectCompanies(db, projectId, runId, artifacts)
      const expansion = artifacts.companyExpansion && typeof artifacts.companyExpansion === 'object'
        ? artifacts.companyExpansion as { chainVersion?: unknown; roleNodeIdsByTsCode?: unknown }
        : null
      const projection = artifacts.companyProjection && typeof artifacts.companyProjection === 'object'
        ? artifacts.companyProjection as { roleNodeIdsByTsCode?: unknown }
        : null
      const researchNodeIdsByTsCode = expansion?.chainVersion === 2
        && expansion.roleNodeIdsByTsCode
        && typeof expansion.roleNodeIdsByTsCode === 'object'
        ? expansion.roleNodeIdsByTsCode as Record<string, string[]>
        : projection?.roleNodeIdsByTsCode && typeof projection.roleNodeIdsByTsCode === 'object'
          ? projection.roleNodeIdsByTsCode as Record<string, string[]>
          : {}
      reconcileIndustryResearchProjectMainBusinessExposures(
        db,
        projectId,
        researchNodeIdsByTsCode,
      )
    }
    const evidence = artifacts.evidence as { pendingSources?: string[]; notes?: string[] } | undefined
    if (evidence?.pendingSources?.length) {
      for (const source of evidence.pendingSources.slice(0, 20)) {
        saveResearchEvidence(db, projectId, {
          id: stableId(projectId, 'pending_evidence', source),
          title: `待补来源：${source.slice(0, 80)}`,
          sourceType: 'pending',
          sourceName: '待补原始来源',
          sourceUrl: null,
          sourceRef: source.slice(0, 500),
          statementKind: 'hypothesis',
          direction: 'neutral',
          reliability: 'unknown',
          createdBy: 'ai',
          primarySourceConfirmed: false,
          excerpt: source.slice(0, 1000),
        })
      }
    }
    const hypotheses = artifacts.hypothesis as ReturnType<typeof normalizeHypothesisArtifact> | undefined
    if (hypotheses?.length) {
      for (const item of hypotheses) {
        saveResearchHypothesis(db, projectId, {
          id: stableId(projectId, 'hypothesis', item.statement),
          statement: item.statement,
          importance: item.importance,
          status: 'open',
          cheapestDisproof: item.cheapestDisproof,
          verificationMetric: item.verificationMetric,
          threshold: item.threshold,
          evidenceIds: item.candidateIds,
        })
      }
    }
  })
  persist()
}

async function runGenerationPipeline(
  db: Database.Database,
  runId: string,
  skill: SkillMeta,
  emitter?: ProgressEmitter,
  resumeAfterCompanies = false,
  financialOptions?: GenerationFinancialOptions,
): Promise<void> {
  let run = updateGenerationRun(db, runId, {
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
    retryable: false,
    cancelRequested: false,
    progressMessage: resumeAfterCompanies ? '正在继续收集公司业务与财务数据' : '开始研究生成',
    progressCurrent: resumeAfterCompanies ? 6 : 0,
  })!
  emitProgress(emitter, run)

  const skillContent = loadSkillContent(skill.dirPath)
  const rawScopeFallback = run.scope_json ? JSON.parse(run.scope_json) as GenerationScopeInput : {}
  const generationCurrentDate = resolveGenerationDataAsOf(null)
  const scopeFallback: GenerationScopeInput = {
    ...rawScopeFallback,
    dataAsOf: asString(rawScopeFallback.dataAsOf, 20) || generationCurrentDate,
  }
  const artifacts = parseArtifacts(run)
  const expansionSourceRunId = artifacts.companyExpansion && typeof artifacts.companyExpansion === 'object'
    && (artifacts.companyExpansion as { chainVersion?: unknown }).chainVersion === 2
    && typeof (artifacts.companyExpansion as { sourceRunId?: unknown }).sourceRunId === 'string'
    ? (artifacts.companyExpansion as { sourceRunId: string }).sourceRunId
    : run.id
  let allEvidenceCandidates = listEvidenceCandidates(db, {
    projectId: run.project_id,
    runId: expansionSourceRunId,
  })
  let selectedTopNIds = Array.isArray((artifacts.retrieve as { selectedTopNIds?: string[] } | undefined)?.selectedTopNIds)
    ? (artifacts.retrieve as { selectedTopNIds: string[] }).selectedTopNIds
    : allEvidenceCandidates.slice(0, 14).map((item) => item.id)
  let allowedCandidateIds = new Set(selectedTopNIds)
  let selectedCandidates = selectedCandidateViews(allEvidenceCandidates, selectedTopNIds)
  let retrievalMode = String((artifacts.retrieve as { mode?: string } | undefined)?.mode || 'weak')
  let nativeResearchMemo = asString(
    (artifacts.retrieve as { nativeResearchMemo?: unknown } | undefined)?.nativeResearchMemo,
    30000,
  )

  try {
    if (!resumeAfterCompanies) {
    // retrieve
    run = ensureNotCancelled(db, runId)
    run = updateGenerationRun(db, runId, {
      currentStage: 'retrieve',
      progressCurrent: 1,
      progressMessage: '正在执行受控联网取证',
    })!
    emitProgress(emitter, run)
    let nativeSearchError: { code: string; message: string } | null = null
    let nativeSearch: Awaited<ReturnType<typeof runOpenAINativeResearchSearch>> | null = null
    if (run.enable_web_retrieval === 1) {
      try {
        nativeSearch = await runOpenAINativeResearchSearch(db, {
          projectId: run.project_id,
          runId: run.id,
          researchQuestion: run.research_question,
          industryName: scopeFallback.industryName,
          productScope: scopeFallback.productScope,
          regionScope: scopeFallback.regionScope,
          currentDate: generationCurrentDate,
          dataAsOf: scopeFallback.dataAsOf!,
        })
      } catch (error) {
        nativeSearchError = {
          code: error instanceof IndustryResearchError ? error.code : 'OPENAI_NATIVE_WEB_SEARCH_FAILED',
          message: error instanceof Error ? error.message : 'GPT 原生网页搜索失败',
        }
      }
    }
    const retrieval = nativeSearch || await retrieveResearchEvidenceCandidates(db, {
      projectId: run.project_id,
      runId: run.id,
      researchQuestion: run.research_question,
      industryName: scopeFallback.industryName,
      productScope: scopeFallback.productScope,
      regionScope: scopeFallback.regionScope,
      enableWebRetrieval: run.enable_web_retrieval === 1,
      shouldCancel: () => getGenerationRun(db, runId)?.cancel_requested === 1,
    })
    artifacts.retrieve = {
      plan: retrieval.plan,
      mode: retrieval.mode,
      candidateIds: retrieval.candidates.map((item) => item.id),
      selectedTopNIds: retrieval.selectedTopNIds,
      degradedCode: retrieval.degradedCode,
      message: retrieval.message,
      nativeResearchMemo: nativeSearch?.memo || null,
      nativeWebSearch: nativeSearch ? {
        status: 'succeeded',
        provider: nativeSearch.provider,
        model: nativeSearch.model,
        responseId: nativeSearch.trace.responseId,
        calls: nativeSearch.trace.calls,
        citations: nativeSearch.trace.citations,
        sources: nativeSearch.trace.sources,
      } : {
        status: run.enable_web_retrieval === 1 ? 'fallback' : 'disabled',
        provider: null,
        model: null,
        responseId: null,
        calls: [],
        citations: [],
        sources: [],
        errorCode: nativeSearchError?.code || null,
        errorMessage: nativeSearchError?.message || null,
      },
    }
    run = updateGenerationRun(db, runId, {
      provider: nativeSearch?.provider,
      model: nativeSearch?.model,
      lastSuccessfulStage: 'retrieve',
      stageArtifactsJson: JSON.stringify(artifacts),
      progressMessage: retrieval.message,
      errorCode: retrieval.degradedCode,
      errorMessage: retrieval.degradedCode ? retrieval.message : null,
    })!

    // scope
    run = ensureNotCancelled(db, runId)
    run = updateGenerationRun(db, runId, {
      currentStage: 'scope',
      progressCurrent: 2,
      progressMessage: '正在生成研究边界',
    })!
    emitProgress(emitter, run)
    const scopeResult = await callStageJson(db, buildSkillPrompt(skillContent, 'scope', JSON.stringify({
      researchQuestion: run.research_question,
      scopeHint: scopeFallback,
      systemContext: {
        currentDate: generationCurrentDate,
        dataAsOf: scopeFallback.dataAsOf,
        dataAsOfSource: rawScopeFallback.dataAsOf ? 'user_explicit' : 'system_current_date',
      },
      retrieval: artifacts.retrieve,
      requiredJson: {
        title: 'string',
        industryName: 'string',
        productScope: 'string',
        regionScope: 'string',
        timeScope: 'string',
        purpose: 'learning|strategy|investment',
        depth: 'quick|standard|deep',
        stopCondition: 'string|null',
        coreQuestions: ['string'],
      },
      rules: [
        'dataAsOf 由系统上下文确定，模型不得生成、覆盖或改写',
        '不得把模型知识截止日当作研究数据截止日',
      ],
    })))
    artifacts.scope = normalizeScopeArtifact(scopeResult.payload, scopeFallback, run.research_question)
    run = updateGenerationRun(db, runId, {
      provider: scopeResult.provider,
      model: scopeResult.model,
      lastSuccessfulStage: 'scope',
      stageArtifactsJson: JSON.stringify(artifacts),
      progressMessage: '研究边界候选已生成',
    })!

    allEvidenceCandidates = listEvidenceCandidates(db, { projectId: run.project_id, runId: run.id })
    selectedTopNIds = Array.isArray((artifacts.retrieve as { selectedTopNIds?: string[] })?.selectedTopNIds)
      ? ((artifacts.retrieve as { selectedTopNIds: string[] }).selectedTopNIds)
      : allEvidenceCandidates.slice(0, 14).map((item) => item.id)
    allowedCandidateIds = new Set(selectedTopNIds)
    selectedCandidates = selectedCandidateViews(allEvidenceCandidates, selectedTopNIds)
    retrievalMode = String((artifacts.retrieve as { mode?: string })?.mode || 'weak')
    nativeResearchMemo = asString(
      (artifacts.retrieve as { nativeResearchMemo?: unknown })?.nativeResearchMemo,
      30000,
    )

    // map
    run = ensureNotCancelled(db, runId)
    run = updateGenerationRun(db, runId, {
      currentStage: 'map',
      progressCurrent: 3,
      progressMessage: '正在生成结构化图谱',
    })!
    emitProgress(emitter, run)
    const mapResult = await callStageJson(db, buildSkillPrompt(skillContent, 'map', JSON.stringify({
      researchQuestion: run.research_question,
      scope: artifacts.scope,
      retrievalMode,
      nativeResearchMemo,
      candidates: selectedCandidates,
      requiredJson: {
        nodes: [{ id: 'string', type: 'product', name: 'string', stage: 'string', status: 'string', candidateIds: ['string'] }],
        edges: [{ id: 'string', source: 'string', target: 'string', relation: 'string', bottleneck: false, candidateIds: ['string'] }],
      },
      rules: [
        '关键节点尽量引用 candidateIds',
        '无引用节点 status 使用 no_evidence_support',
        '若 purpose=investment，按实际适用的设备、材料、封测、模组/渠道和终端等关键生态位建立独立的A股候选池节点；证据不足时保留待核验状态，不得因只找到一家有公告的公司而省略其他候选池',
      ],
    })))
    artifacts.map = normalizeMapArtifact(mapResult.payload, run.project_id, allowedCandidateIds)
    run = updateGenerationRun(db, runId, {
      provider: mapResult.provider,
      model: mapResult.model,
      lastSuccessfulStage: 'map',
      stageArtifactsJson: JSON.stringify(artifacts),
      progressMessage: '图谱候选已生成',
    })!

    // evidence
    run = ensureNotCancelled(db, runId)
    run = updateGenerationRun(db, runId, {
      currentStage: 'evidence',
      progressCurrent: 4,
      progressMessage: '正在整理证据与待补来源',
    })!
    emitProgress(emitter, run)
    const evidenceResult = await callStageJson(db, buildSkillPrompt(skillContent, 'evidence', JSON.stringify({
      researchQuestion: run.research_question,
      scope: artifacts.scope,
      map: artifacts.map,
      retrievalMode,
      nativeResearchMemo,
      candidates: selectedCandidates,
      requiredJson: {
        pendingSources: ['string'],
        notes: ['string'],
        supportedCandidateIds: ['string'],
      },
    })))
    artifacts.evidence = {
      pendingSources: asStringArray(evidenceResult.payload.pendingSources, 20, 300),
      notes: asStringArray(evidenceResult.payload.notes, 20, 300),
      supportedCandidateIds: sanitizeCandidateIds(evidenceResult.payload.supportedCandidateIds, allowedCandidateIds),
    }
    run = updateGenerationRun(db, runId, {
      provider: evidenceResult.provider,
      model: evidenceResult.model,
      lastSuccessfulStage: 'evidence',
      stageArtifactsJson: JSON.stringify(artifacts),
      progressMessage: '证据与待补来源已整理',
    })!

    // hypothesis
    run = ensureNotCancelled(db, runId)
    run = updateGenerationRun(db, runId, {
      currentStage: 'hypothesis',
      progressCurrent: 5,
      progressMessage: '正在生成核心假设',
    })!
    emitProgress(emitter, run)
    const hypothesisResult = await callStageJson(db, buildSkillPrompt(skillContent, 'hypothesis', JSON.stringify({
      researchQuestion: run.research_question,
      scope: artifacts.scope,
      map: artifacts.map,
      evidence: artifacts.evidence,
      nativeResearchMemo,
      candidates: selectedCandidates,
      retrievalMode,
      requiredJson: {
        hypotheses: [{
          statement: 'string',
          cheapestDisproof: 'string',
          importance: 1,
          verificationMetric: 'string',
          threshold: 'string',
          candidateIds: ['string'],
        }],
      },
      rules: ['无 candidateIds 的假设必须可识别为无证据支撑'],
    })))
    const hypotheses = normalizeHypothesisArtifact(hypothesisResult.payload, allowedCandidateIds)
    artifacts.hypothesis = hypotheses
    if (!hypotheses.length) {
      throw new IndustryResearchError('GENERATION_SCHEMA_INVALID', '假设列表为空或缺少最低成本反证')
    }
    run = updateGenerationRun(db, runId, {
      provider: hypothesisResult.provider,
      model: hypothesisResult.model,
      lastSuccessfulStage: 'hypothesis',
      stageArtifactsJson: JSON.stringify(artifacts),
      progressMessage: '核心假设已生成',
    })!

    // companies
    run = ensureNotCancelled(db, runId)
    run = updateGenerationRun(db, runId, {
      currentStage: 'companies',
      progressCurrent: 6,
      progressMessage: '正在生成公司候选',
    })!
    emitProgress(emitter, run)
    const companyResult = await callStageJson(db, buildSkillPrompt(skillContent, 'companies', JSON.stringify({
      researchQuestion: run.research_question,
      scope: artifacts.scope,
      map: artifacts.map,
      nativeResearchMemo,
      candidates: selectedCandidates,
      retrievalMode,
      requiredJson: {
        companies: [{
          legalName: 'string',
          displayName: 'string',
          rationale: 'string',
          researchNodeIds: ['string'],
          tsCode: 'string',
          candidateIds: ['string'],
        }],
      },
      rules: [
        '投资型研究必须覆盖图谱中的每个A股候选池节点，并形成至少3家可精确映射的A股横向候选；合理时同一竞争性生态位保留多家公司',
        '候选必须来自产业链生态位映射，不得从概念股名单倒推产业逻辑',
        '没有candidateIds的合理候选仍可保留为待核验线索，但不得声称业务暴露、收入贡献或受益已经确认',
      ],
    })))
    const initialCompanies = normalizeCompanyArtifact(companyResult.payload, allowedCandidateIds)
    const discoveredCompanies = discoverMentionedLocalSecurities(
      db,
      artifacts,
      selectedCandidates,
      allowedCandidateIds,
    )
    let companies = mergeCompanyArtifacts(db, [initialCompanies, discoveredCompanies])
    const investmentCoverageRequired = (artifacts.scope as { purpose?: unknown } | undefined)?.purpose === 'investment'
    let companyCoverage = auditCompanyCoverage(db, artifacts.map, companies, investmentCoverageRequired)
    if (
      investmentCoverageRequired
      && companyCoverage.status === 'incomplete'
    ) {
      run = updateGenerationRun(db, runId, {
        currentStage: 'companies',
        progressCurrent: 6,
        progressMessage: '正在补齐产业链关键生态位的公司候选',
      })!
      emitProgress(emitter, run)
      const repairedCompanies = await repairCompanyCoverage(db, skillContent, {
        researchQuestion: run.research_question,
        scope: artifacts.scope,
        map: artifacts.map,
        nativeResearchMemo,
        selectedCandidates,
        existingCompanies: companies,
        allowedCandidateIds,
      })
      companies = mergeCompanyArtifacts(db, [companies, repairedCompanies])
      companyCoverage = auditCompanyCoverage(db, artifacts.map, companies, investmentCoverageRequired)
    }
    const companyProjection = projectCompaniesIntoResearchMap(
      db,
      run.project_id,
      artifacts.map as ResearchMapArtifact,
      companies,
    )
    companies = companyProjection.companies
    artifacts.map = companyProjection.map
    artifacts.companyProjection = {
      version: 1,
      projectedNodes: companyProjection.addedNodes,
      projectedEdges: companyProjection.addedEdges,
      roleNodeIdsByTsCode: companyProjection.roleNodeIdsByTsCode,
    }
    for (const company of companies) {
      const matched = matchSecurities(db, company.displayName, company.tsCodeHint)
      upsertCompanyCandidate(db, {
        id: stableId(run.id, 'company_candidate', company.displayName),
        runId: run.id,
        projectId: run.project_id,
        legalNameCandidate: company.legalNameCandidate,
        displayName: company.displayName,
        researchNodeIds: company.researchNodeIds,
        rationale: company.noEvidenceSupport
          ? `${company.rationale}（无证据支撑）`.slice(0, 500)
          : company.rationale,
        matchedSecurities: matched,
        resolutionStatus: matched.length ? 'pending' : 'unmatched',
      })
    }
    artifacts.companies = {
      count: companies.length,
      coverage: companyCoverage,
      items: companies.map((item) => ({
        displayName: item.displayName,
        legalNameCandidate: item.legalNameCandidate,
        rationale: item.rationale,
        researchNodeIds: item.researchNodeIds,
        tsCodeHint: item.tsCodeHint,
        candidateIds: item.candidateIds,
        noEvidenceSupport: item.noEvidenceSupport,
      })),
    }
    run = updateGenerationRun(db, runId, {
      provider: companyResult.provider,
      model: companyResult.model,
      lastSuccessfulStage: 'companies',
      stageArtifactsJson: JSON.stringify(artifacts),
      progressMessage: companyCoverage.status === 'incomplete'
        ? `已生成 ${companies.length} 家候选公司，仍有 ${companyCoverage.targets.filter((item) => item.status === 'uncovered').length} 个生态位待核验`
        : `已生成 ${companies.length} 家候选公司`,
    })!
    } else {
      const companyItems = (artifacts.companies as { items?: unknown[] } | undefined)?.items
      if (!artifacts.scope || !artifacts.map || !Array.isArray(companyItems)) {
        throw new IndustryResearchError('GENERATION_STAGE_INVALID', '缺少可恢复的公司映射阶段产物')
      }
      run = updateGenerationRun(db, runId, {
        status: 'running',
        currentStage: 'companies',
        lastSuccessfulStage: 'companies',
        progressCurrent: 6,
        progressMessage: '已复用检索、图谱和公司映射，正在继续财务采集',
        stageArtifactsJson: JSON.stringify(artifacts),
      })!
      emitProgress(emitter, run)
    }

    // 唯一匹配的 A 股公司先进入可恢复的验证层，再采集本地业务与财务事实。
    // 这些中间产物即使后续报告失败也保留，避免用户再次消耗检索和映射 Token。
    db.transaction(() => materializeExactProjectCompanies(db, run.project_id, run.id, artifacts))()
    run = ensureNotCancelled(db, runId)
    const retrievalState = artifacts.retrieve as { degradedCode?: string | null; message?: string | null } | undefined
    run = updateGenerationRun(db, runId, {
      currentStage: 'companies',
      progressCurrent: 6,
      progressMessage: '公司映射已完成，正在采集业务暴露与财务时间轴',
      stageArtifactsJson: JSON.stringify(artifacts),
    })!
    emitProgress(emitter, run)
    const expansionState = artifacts.companyExpansion && typeof artifacts.companyExpansion === 'object'
      ? artifacts.companyExpansion as { chainVersion?: unknown; roleNodeIdsByTsCode?: unknown }
      : null
    const projectionState = artifacts.companyProjection && typeof artifacts.companyProjection === 'object'
      ? artifacts.companyProjection as { roleNodeIdsByTsCode?: unknown }
      : null
    const roleNodeIdsByTsCode = expansionState?.chainVersion === 2
      && expansionState.roleNodeIdsByTsCode
      && typeof expansionState.roleNodeIdsByTsCode === 'object'
      ? expansionState.roleNodeIdsByTsCode as Record<string, string[]>
      : projectionState?.roleNodeIdsByTsCode && typeof projectionState.roleNodeIdsByTsCode === 'object'
        ? projectionState.roleNodeIdsByTsCode as Record<string, string[]>
        : undefined
    const financialCollection = await collectIndustryResearchProjectFinancials(db, run.project_id, {
      token: financialOptions?.token,
      fetchers: financialOptions?.fetchers,
      researchNodeIdsByTsCode: roleNodeIdsByTsCode,
      shouldCancel: () => getGenerationRun(db, runId)?.cancel_requested === 1,
      onProgress: (state) => {
        artifacts.financialCollection = state
        if (expansionState?.chainVersion === 2) {
          artifacts.companyExpansion = {
            ...(artifacts.companyExpansion as Record<string, unknown>),
            status: 'running',
            financialCollection: state,
          }
        }
        run = updateGenerationRun(db, runId, {
          currentStage: 'companies',
          progressCurrent: 6,
          progressMessage: state.message,
          stageArtifactsJson: JSON.stringify(artifacts),
        }) || run
        emitProgress(emitter, run)
      },
    })
    artifacts.financialCollection = financialCollection
    if (expansionState?.chainVersion === 2) {
      artifacts.companyExpansion = {
        ...(artifacts.companyExpansion as Record<string, unknown>),
        status: financialCollection.status === 'succeeded' ? 'reporting' : 'partial',
        financialCollection,
      }
    }
    run = ensureNotCancelled(db, runId)

    // report：先拿小 JSON 元数据，再单独生成完整 Markdown，避免“长文塞进 JSON”导致解析失败
    run = ensureNotCancelled(db, runId)
    run = updateGenerationRun(db, runId, {
      currentStage: 'report',
      progressCurrent: 7,
      progressMessage: '正在整理报告分区与摘要',
    })!
    emitProgress(emitter, run)

    const reportScope = artifacts.scope as ReturnType<typeof normalizeScopeArtifact>
    const reportTitle = `${reportScope.title || run.research_question}研究报告`
    const reportCompanyItems = Array.isArray((artifacts.companies as { items?: unknown[] })?.items)
      ? (artifacts.companies as { items: Array<Record<string, unknown>> }).items
      : []
    const reportCompanyHints = reportCompanyItems.flatMap((item) => [
      asString(item.displayName, 120),
      asString(item.legalNameCandidate, 200),
      asString(item.tsCodeHint, 16),
    ]).filter(Boolean)
    const localFinancialFacts = buildProjectFinancialReportContext(
      db,
      run.project_id,
      reportScope.dataAsOf,
      reportCompanyHints,
    )
    const localBusinessExposures = buildProjectBusinessExposureReportContext(
      db,
      run.project_id,
      reportCompanyHints,
      reportScope.dataAsOf,
    )
    const researchFactStockCodes = listResearchProjectStockCodes(db, run.project_id, 5)
    const researchFacts = isReusableStockResearchFactBundle(
      artifacts.researchFacts,
      researchFactStockCodes,
      { asOf: reportScope.dataAsOf },
    )
      ? artifacts.researchFacts
      : buildStockResearchFactBundle(db, researchFactStockCodes, { asOf: reportScope.dataAsOf })
    artifacts.researchFacts = researchFacts
    run = updateGenerationRun(db, runId, {
      currentStage: 'report',
      progressCurrent: 7,
      progressMessage: '统一事实底稿已固定，正在整理报告分区与摘要',
      stageArtifactsJson: JSON.stringify(artifacts),
    })!
    emitProgress(emitter, run)
    let reportProvider = ''
    let reportModel = ''
    let reportMetaPayload: Record<string, unknown> = {}

    try {
      const reportMetaResult = await callStageJson(db, buildSkillPrompt(skillContent, 'report', JSON.stringify({
        researchQuestion: run.research_question,
        scope: artifacts.scope,
        mapSummary: {
          nodeCount: Array.isArray((artifacts.map as { nodes?: unknown[] })?.nodes)
            ? (artifacts.map as { nodes: unknown[] }).nodes.length
            : 0,
          edgeCount: Array.isArray((artifacts.map as { edges?: unknown[] })?.edges)
            ? (artifacts.map as { edges: unknown[] }).edges.length
            : 0,
        },
        evidence: artifacts.evidence,
        nativeResearchMemo,
        hypothesisCount: Array.isArray(artifacts.hypothesis) ? (artifacts.hypothesis as unknown[]).length : 0,
        companyCount: Number((artifacts.companies as { count?: number })?.count || 0),
        financialCollection: artifacts.financialCollection,
        localBusinessExposures,
        localFinancialFacts,
        researchFactsMarkdown: researchFacts.markdown,
        researchEvidenceContrastMarkdown: researchFacts.evidenceContrast?.markdown ?? '',
        candidates: selectedCandidates.slice(0, 12).map((item) => ({
          id: item.id,
          title: item.title,
          url: item.url,
          summary: item.summary,
        })),
        retrievalMode,
        requiredJson: {
          title: 'string',
          summary: 'string，200-600字核心结论摘要',
          supportedFindings: [{ text: 'string', candidateIds: ['candidate-id'] }],
          modelOnlyFindings: ['string'],
          pendingSources: ['string'],
          missingSections: ['string'],
          conflicts: ['string'],
          candidateIds: ['string'],
        },
        rules: [
          '本阶段只输出小 JSON，不要输出完整 Markdown 报告，不要输出 markdown 字段',
          '必须分区：有证据支撑 / 仅模型推断 / 待补来源',
          '每条 supportedFindings 必须只引用输入 candidates 中真实存在的 candidateIds',
          'weak 或 offline 模式下不得伪装为已完成外部取证',
          '本地结构化财务事实可以验证结果，但没有经营公告支撑时不得把财务变化全部归因于产业价格或需求变化',
          '必须明确说明映射公司的财务数据覆盖率、失败项和待补项，不得把部分覆盖写成全量覆盖',
          'localBusinessExposures 是 Tushare 主营构成候选口径，不得伪装为已人工确认的业务暴露',
          'researchFactsMarkdown 是本次运行已固定的共享本地事实；公告标题未读取正文，不得升级为正式公告证据',
          'researchEvidenceContrastMarkdown 是结构化工具生成的支持/反证/未知对照，三类都必须进入结论校验',
          '预告或快报与正式财报必须分开表述；尚未披露的中报不能写成已实现结果',
          `研究数据截止日固定为 ${reportScope.dataAsOf}；不得使用模型知识截止日或自行另设旧日期`,
          '只有候选资料晚于上述明确研究截止日时，才可写入时间冲突或后见信息',
        ],
      })))
      reportProvider = reportMetaResult.provider
      reportModel = reportMetaResult.model
      reportMetaPayload = reportMetaResult.payload
    } catch (metaError) {
      // 元数据失败不阻断：后续仍可生成 Markdown 或回退模板
      console.warn('[industryResearch] report meta JSON failed:', metaError instanceof Error ? metaError.message : metaError)
      reportMetaPayload = {
        title: reportTitle,
        summary: `${run.research_question} 的阶段性产业研究结论。`,
        supportedFindings: [],
        modelOnlyFindings: [],
        pendingSources: Array.isArray((artifacts.evidence as { pendingSources?: string[] })?.pendingSources)
          ? (artifacts.evidence as { pendingSources: string[] }).pendingSources
          : [],
        missingSections: [],
        conflicts: [],
        candidateIds: [],
      }
    }

    reportMetaPayload = {
      ...reportMetaPayload,
      conflicts: normalizeReportConflicts(reportMetaPayload.conflicts, reportScope.dataAsOf),
    }

    run = updateGenerationRun(db, runId, {
      currentStage: 'report',
      progressCurrent: 7,
      progressMessage: '正在生成完整 Markdown 研究报告',
      stageArtifactsJson: JSON.stringify(artifacts),
    })!
    emitProgress(emitter, run)

    let markdownDocument = ''
    try {
      const markdownResult = await callStageText(db, buildReportMarkdownPrompt({
        skillContent,
        researchQuestion: run.research_question,
        scope: artifacts.scope,
        map: artifacts.map,
        evidence: artifacts.evidence,
        hypotheses: artifacts.hypothesis,
        companies: artifacts.companies,
        candidates: selectedCandidates.slice(0, 16),
        retrievalMode,
        meta: reportMetaPayload,
        nativeResearchMemo,
        localBusinessExposures,
        localFinancialFacts,
        researchFactsMarkdown: researchFacts.markdown,
        researchEvidenceContrastMarkdown: researchFacts.evidenceContrast?.markdown ?? '',
        financialCollection: artifacts.financialCollection,
      }))
      reportProvider = markdownResult.provider || reportProvider
      reportModel = markdownResult.model || reportModel
      const rawMarkdown = stripMarkdownFences(markdownResult.text)
      if (looksLikeMarkdownDocument(rawMarkdown)) {
        markdownDocument = rawMarkdown
      } else {
        // 模型若仍返回 JSON，尝试抽出 markdown 字段；管道串/碎片一律丢弃，走结论性兜底文档
        const maybeJson = tryParseJsonObject(rawMarkdown)
        const embedded = maybeJson ? asString(maybeJson.markdown, 60000) : ''
        if (embedded && looksLikeMarkdownDocument(embedded)) markdownDocument = embedded
      }
    } catch (markdownError) {
      console.warn('[industryResearch] report markdown generation failed:', markdownError instanceof Error ? markdownError.message : markdownError)
    }

    const evidenceRepresentativeCandidateIds = sanitizeCandidateIds(
      (artifacts.evidence as { supportedCandidateIds?: unknown })?.supportedCandidateIds,
      allowedCandidateIds,
    )

    if (!markdownDocument) {
      // 最后兜底：拼出结论性文档，避免“检索成功但报告页空白/管道串”
      const mapCompact = compactMapForWriting(artifacts.map)
      markdownDocument = buildFallbackReportMarkdown({
        title: asString(reportMetaPayload.title, 200) || reportTitle,
        dataAsOf: reportScope.dataAsOf || null,
        summary: asString(reportMetaPayload.summary, 4000) || `${run.research_question} 的阶段性产业研究结论。`,
        supported: normalizeReportFindings(
          reportMetaPayload.supportedFindings,
          allowedCandidateIds,
          evidenceRepresentativeCandidateIds,
        ).map((item) => item.text),
        modelOnly: asStringArray(reportMetaPayload.modelOnlyFindings, 20, 400),
        pendingSources: asStringArray(reportMetaPayload.pendingSources, 20, 300),
        scope: reportScope as unknown as Record<string, unknown>,
        mapNodes: mapCompact.nodes,
        hypotheses: compactHypothesesForWriting(artifacts.hypothesis),
        companies: compactCompaniesForWriting(artifacts.companies),
        candidates: compactCandidatesForWriting(selectedCandidates.slice(0, 12)),
        retrievalMode,
      })
    }
    const coverageSection = financialCoverageMarkdown(artifacts.financialCollection)
    if (coverageSection && !/^## 公司财务数据覆盖\s*$/m.test(markdownDocument)) {
      markdownDocument = `${markdownDocument.trim()}\n\n${coverageSection}\n`
    }

    const reportTextAudit = auditResearchText({
      text: [asString(reportMetaPayload.summary, 4_000), markdownDocument].filter(Boolean).join('\n\n'),
      documentKind: 'industry_report',
      evidenceContrast: researchFacts.evidenceContrast,
      asOf: reportScope.dataAsOf,
      excludedUrls: allEvidenceCandidates
        .filter((candidate) => candidate.status === 'rejected')
        .map((candidate) => candidate.source_url),
      allowedFactTexts: [
        researchFacts.markdown,
        nativeResearchMemo || '',
        JSON.stringify({
          scope: artifacts.scope,
          map: compactMapForWriting(artifacts.map),
          evidence: artifacts.evidence,
          hypotheses: compactHypothesesForWriting(artifacts.hypothesis),
          companies: compactCompaniesForWriting(artifacts.companies),
          candidates: compactCandidatesForWriting(selectedCandidates.slice(0, 16)),
          financialCollection: artifacts.financialCollection,
          localBusinessExposures,
          localFinancialFacts,
        }),
      ],
    })
    if (reportTextAudit.status === 'blocked') {
      markdownDocument = buildBlockedResearchText(reportTextAudit)
      reportMetaPayload = {
        title: reportTitle,
        summary: '本次模型报告未通过确定性审计，原结论未写入项目报告。',
        supportedFindings: [],
        modelOnlyFindings: [],
        pendingSources: [],
        missingSections: [],
        conflicts: [],
        candidateIds: [],
      }
    }

    artifacts.report = {
      ...normalizeReportArtifact({
        ...reportMetaPayload,
        markdown: markdownDocument,
      }, allowedCandidateIds, {
        title: reportTitle,
        dataAsOf: reportScope.dataAsOf || null,
        retrievalMode,
        representativeCandidateIds: evidenceRepresentativeCandidateIds.length
          ? evidenceRepresentativeCandidateIds
          : selectedTopNIds.slice(0, 3),
      }),
      missingSections: asStringArray(reportMetaPayload.missingSections, 20, 200),
      conflicts: normalizeReportConflicts(reportMetaPayload.conflicts, reportScope.dataAsOf),
      textAudit: reportTextAudit,
    }
    if (
      (retrievalMode === 'weak' || retrievalMode === 'offline')
      && !(artifacts.report as { supportedFindings?: ResearchReportFindingArtifact[] }).supportedFindings?.length
    ) {
      artifacts.report = {
        ...(artifacts.report as Record<string, unknown>),
        evidenceInsufficient: true,
      }
    }

    if (expansionState?.chainVersion === 2) {
      artifacts.companyExpansion = {
        ...(artifacts.companyExpansion as Record<string, unknown>),
        status: financialCollection.status === 'succeeded' ? 'succeeded' : 'partial',
        completedAt: Date.now(),
        financialCollection,
      }
    }
    try {
      applyGenerationArtifacts(db, run.project_id, artifacts, run.id)
    } catch (persistError) {
      console.warn(
        '[industryResearch] generated artifacts could not be persisted:',
        persistError instanceof Error ? persistError.message : persistError,
      )
      throw new IndustryResearchError(
        'GENERATION_PERSIST_FAILED',
        '报告与图谱已经生成，但写入项目失败。本次产物已保留，可直接点击“写回项目”，不会再次调用模型',
      )
    }
    run = updateGenerationRun(db, runId, {
      provider: reportProvider || null,
      model: reportModel || null,
      status: 'succeeded',
      currentStage: 'report',
      lastSuccessfulStage: 'report',
      progressCurrent: 7,
      progressMessage: '研究报告已生成，可阅读结论并继续核验来源',
      stageArtifactsJson: JSON.stringify(artifacts),
      completedAt: Date.now(),
      retryable: false,
      errorCode: retrievalState?.degradedCode || null,
      errorMessage: retrievalState?.degradedCode ? retrievalState.message || null : null,
    })!
    emitProgress(emitter, run)
  } catch (error) {
    if (error instanceof IndustryResearchError && error.code === 'GENERATION_CANCELLED') {
      const cancelled = (error as IndustryResearchError & { run?: IndustryResearchGenerationRunRow }).run
        || getGenerationRun(db, runId)
      if (cancelled) emitProgress(emitter, cancelled)
      return
    }
    const stageLabel = run.current_stage || 'unknown'
    const baseMessage = error instanceof IndustryResearchError
      ? error.message
      : '研究生成失败'
    const code = error instanceof IndustryResearchError ? error.code : 'GENERATION_PROVIDER_FAILED'
    // 让用户直接看到失败阶段，避免误以为检索失败
    const message = code === 'GENERATION_PERSIST_FAILED'
      ? baseMessage
      : stageLabel === 'report'
      ? `研究报告阶段失败：${baseMessage}`
      : `阶段 ${stageLabel} 失败：${baseMessage}`
    console.warn(`[industryResearch] generation failed at ${stageLabel}:`, baseMessage)
    const failed = updateGenerationRun(db, runId, {
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      progressMessage: message,
      completedAt: Date.now(),
      retryable: true,
      stageArtifactsJson: JSON.stringify(artifacts),
    })!
    emitProgress(emitter, failed)
  }
}

export function getGenerationRunView(db: Database.Database, projectId: string, runId?: string) {
  let run = runId ? getGenerationRun(db, runId) : getLatestGenerationRun(db, projectId)
  if (runId && run && run.project_id !== projectId) {
    throw new IndustryResearchError('NOT_FOUND', '生成运行不存在')
  }
  if (run && ['queued', 'running'].includes(run.status) && !activeGenerationRunIds.has(run.id)) {
    const interruptedAtFinancials = run.current_stage === 'companies' && run.last_successful_stage === 'companies'
    run = updateGenerationRun(db, run.id, {
      status: 'failed',
      errorCode: 'GENERATION_INTERRUPTED',
      errorMessage: interruptedAtFinancials
        ? '公司业务与财务采集因应用退出或进程中断而停止；已完成数据已保留，可从当前阶段继续'
        : '研究生成因应用退出或进程中断而停止；已完成阶段产物已保留，可重新发起恢复',
      progressMessage: interruptedAtFinancials
        ? '财务采集中断，已完成数据已保留'
        : '研究生成已中断',
      retryable: true,
      completedAt: Date.now(),
    })
  }
  const artifacts = run ? parseArtifacts(run) : {}
  const expansion = artifacts.companyExpansion && typeof artifacts.companyExpansion === 'object'
    ? artifacts.companyExpansion as Record<string, unknown>
    : null
  const evidenceRunId = expansion?.chainVersion === 2 && typeof expansion.sourceRunId === 'string'
    ? expansion.sourceRunId
    : run?.id
  const retrieve = (artifacts.retrieve && typeof artifacts.retrieve === 'object')
    ? artifacts.retrieve as Record<string, unknown>
    : {}
  const report = (artifacts.report && typeof artifacts.report === 'object')
    ? artifacts.report as Record<string, unknown>
    : {}
  const researchFacts = (artifacts.researchFacts && typeof artifacts.researchFacts === 'object')
    ? artifacts.researchFacts as Record<string, unknown>
    : {}
  const project = getResearchProject(db, projectId)
  const authoritativeDataAsOf = resolveGenerationDataAsOf(project?.data_as_of)
  return {
    run,
    evidenceCandidates: evidenceRunId
      ? listProjectEvidenceCandidates(db, projectId, evidenceRunId)
      : listProjectEvidenceCandidates(db, projectId),
    companyCandidates: run ? listCompanyCandidates(db, { projectId, runId: run.id }) : listCompanyCandidates(db, { projectId }),
    retrievalMode: typeof retrieve.mode === 'string' ? retrieve.mode : null,
    retrievalPlan: retrieve.plan ?? null,
    nativeWebSearch: retrieve.nativeWebSearch && typeof retrieve.nativeWebSearch === 'object'
      ? retrieve.nativeWebSearch
      : null,
    selectedTopNIds: Array.isArray(retrieve.selectedTopNIds) ? retrieve.selectedTopNIds : [],
    reportPartitions: {
      supportedFindings: Array.isArray(report.supportedFindings) ? report.supportedFindings : [],
      modelOnlyFindings: Array.isArray(report.modelOnlyFindings) ? report.modelOnlyFindings : [],
      pendingSources: Array.isArray(report.pendingSources) ? report.pendingSources : [],
      evidenceInsufficient: report.evidenceInsufficient === true,
    },
    reportDocument: {
      title: typeof report.title === 'string' ? report.title : null,
      summary: typeof report.summary === 'string' ? report.summary : null,
      markdown: typeof report.markdown === 'string' ? report.markdown : null,
      missingSections: Array.isArray(report.missingSections) ? report.missingSections : [],
      conflicts: normalizeReportConflicts(report.conflicts, authoritativeDataAsOf),
      researchTrace: buildResearchAuditTraceView(
        report.textAudit,
        researchFacts.evidenceContrast,
        [report.summary, report.markdown].filter((value) => typeof value === 'string' && value).join('\n\n'),
      ),
    },
    financialCollection: artifacts.financialCollection && typeof artifacts.financialCollection === 'object'
      ? artifacts.financialCollection as ProjectFinancialCollectionState
      : null,
    companyExpansion: expansion,
  }
}

export function getGenerationResearchAuditComparisonContext(
  db: Database.Database,
  projectId: string,
  runId: string,
): { audit: unknown; evidenceContrast: unknown; documentText: string } | null {
  const run = getGenerationRun(db, runId)
  if (!run || run.project_id !== projectId) return null
  const artifacts = parseArtifacts(run)
  const report = artifacts.report && typeof artifacts.report === 'object'
    ? artifacts.report as Record<string, unknown>
    : {}
  const researchFacts = artifacts.researchFacts && typeof artifacts.researchFacts === 'object'
    ? artifacts.researchFacts as Record<string, unknown>
    : {}
  return {
    audit: report.textAudit,
    evidenceContrast: researchFacts.evidenceContrast,
    documentText: [report.summary, report.markdown]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n\n'),
  }
}

export async function startIndustryResearchGeneration(
  db: Database.Database,
  input: StartGenerationInput,
  resolveSkill: () => SkillMeta | null,
  options?: {
    createProject: (payload: {
      title: string
      industryName: string
      productScope: string
      regionScope: string
      timeScope: string
      purpose: ResearchPurpose
      depth: ResearchDepth
      dataAsOf?: string | null
      valuationDate?: string | null
      sourceType: ResearchSourceType
      sourceRef?: string | null
      sourceText?: string | null
    }) => { id: string }
    emitter?: ProgressEmitter
  },
) {
  const question = input.researchQuestion.trim()
  if (question.length < 10 || question.length > 4000) {
    throw new IndustryResearchError('INVALID_PARAM', '研究问题长度需在 10 至 4000 字之间')
  }
  const skill = resolveSkill()
  if (!skill || skill.skillId !== 'builtin:industry-chain-research') {
    throw new IndustryResearchError('BUILTIN_RESEARCH_SKILL_NOT_FOUND', '未发现内置产业研究 Skill')
  }
  if (skill.integrity !== 'complete') {
    throw new IndustryResearchError('BUILTIN_RESEARCH_SKILL_INVALID', '内置产业研究 Skill 不完整')
  }

  let projectId = input.projectId
  let generationScope: GenerationScopeInput = { ...(input.scope || {}) }
  if (projectId) {
    const project = getResearchProject(db, projectId)
    if (!project) throw new IndustryResearchError('NOT_FOUND', '研究项目不存在')
    if (project.status === 'archived') throw new IndustryResearchError('INVALID_PARAM', '已归档项目不能启动生成')
    if (getActiveGenerationRun(db, projectId)) {
      throw new IndustryResearchError('GENERATION_ALREADY_RUNNING', '该项目已有进行中的生成任务')
    }
    generationScope = {
      ...generationScope,
      title: asString(generationScope.title, 200) || project.title,
      industryName: asString(generationScope.industryName, 120) || project.industry_name,
      productScope: asString(generationScope.productScope, 500) || project.product_scope,
      regionScope: asString(generationScope.regionScope, 200) || project.region_scope,
      timeScope: asString(generationScope.timeScope, 200) || project.time_scope,
      purpose: generationScope.purpose || project.purpose,
      depth: generationScope.depth || project.depth,
      dataAsOf: generationScope.dataAsOf || project.data_as_of,
      stopCondition: asString(generationScope.stopCondition, 1000) || project.stop_condition,
    }
  }

  generationScope = {
    ...generationScope,
    dataAsOf: resolveGenerationDataAsOf(generationScope.dataAsOf),
  }

  if (!projectId) {
    if (!options?.createProject) throw new IndustryResearchError('INVALID_PARAM', '缺少项目创建能力')
    const created = options.createProject({
      title: generationScope.title?.trim() || question.slice(0, 80),
      industryName: generationScope.industryName?.trim() || '待确认产业',
      productScope: generationScope.productScope?.trim() || question.slice(0, 120),
      regionScope: generationScope.regionScope?.trim() || '中国',
      timeScope: generationScope.timeScope?.trim() || '近三年',
      purpose: generationScope.purpose || 'investment',
      depth: generationScope.depth || 'standard',
      dataAsOf: generationScope.dataAsOf,
      valuationDate: null,
      sourceType: input.sourceType || 'manual',
      sourceRef: input.sourceRef || null,
      sourceText: input.sourceText || question,
    })
    projectId = created.id
  }

  const runInput: GenerationRunCreateInput = {
    id: randomUUID(),
    projectId,
    researchQuestion: question,
    skillId: skill.skillId,
    skillContentHash: skill.contentHash,
    skillRuleVersion: skill.ruleVersion,
    scopeJson: JSON.stringify(generationScope),
    enableWebRetrieval: generationScope.enableWebRetrieval !== false,
  }
  const run = createGenerationRun(db, runInput)
  launchGenerationPipeline(db, run.id, skill, options?.emitter)
  return { projectId, run }
}

export interface CompanyCandidateExpansionResult {
  addedCandidates: number
  addedProjectCompanies: number
  totalCandidates: number
  totalProjectCompanies: number
  targetCompanies: number
  projectedNodes: number
  projectedEdges: number
  derivedRunId: string
  coverage: CompanyCoverageAudit
}

export interface CompanyCandidateExpansionOptions {
  emitter?: ProgressEmitter
  financial?: GenerationFinancialOptions
}

export async function expandIndustryResearchCompanyCandidates(
  db: Database.Database,
  projectId: string,
  runId: string,
  resolveSkill: () => SkillMeta | null,
  options: CompanyCandidateExpansionOptions = {},
): Promise<CompanyCandidateExpansionResult> {
  const project = getResearchProject(db, projectId)
  if (!project) throw new IndustryResearchError('NOT_FOUND', '研究项目不存在')
  if (project.status === 'archived') throw new IndustryResearchError('INVALID_PARAM', '已归档项目不能补全公司映射')
  const run = getGenerationRun(db, runId)
  if (!run || run.project_id !== projectId) throw new IndustryResearchError('NOT_FOUND', '生成运行不存在')
  if (getActiveGenerationRun(db, projectId)) {
    throw new IndustryResearchError('GENERATION_ALREADY_RUNNING', '该项目已有进行中的生成任务')
  }
  if (!['companies', 'report'].includes(run.last_successful_stage || '')) {
    throw new IndustryResearchError('GENERATION_STAGE_INVALID', '公司映射尚未形成，不能单独补全')
  }
  const skill = resolveSkill()
  if (!skill || skill.skillId !== 'builtin:industry-chain-research') {
    throw new IndustryResearchError('BUILTIN_RESEARCH_SKILL_NOT_FOUND', '未发现内置产业研究 Skill')
  }
  if (skill.contentHash !== run.skill_content_hash) {
    throw new IndustryResearchError('SKILL_CHANGED', '产业研究规则已变化，请重新发起完整研究')
  }

  const artifacts = parseArtifacts(run)
  if (!artifacts.scope || !artifacts.map) {
    throw new IndustryResearchError('GENERATION_STAGE_INVALID', '缺少可复用的研究边界或产业图谱')
  }
  const priorExpansion = artifacts.companyExpansion && typeof artifacts.companyExpansion === 'object'
    ? artifacts.companyExpansion as { chainVersion?: unknown; sourceRunId?: unknown }
    : null
  const evidenceRunId = priorExpansion?.chainVersion === 2 && typeof priorExpansion.sourceRunId === 'string'
    ? priorExpansion.sourceRunId
    : runId
  const evidenceCandidates = listEvidenceCandidates(db, { projectId, runId: evidenceRunId })
  const selectedTopNIds = Array.isArray((artifacts.retrieve as { selectedTopNIds?: unknown[] } | undefined)?.selectedTopNIds)
    ? asStringArray((artifacts.retrieve as { selectedTopNIds: unknown[] }).selectedTopNIds, 40, 128)
    : evidenceCandidates.slice(0, 16).map((item) => item.id)
  const allowedCandidateIds = new Set(selectedTopNIds)
  const selectedCandidates = selectedCandidateViews(evidenceCandidates, selectedTopNIds)
  const nativeResearchMemo = asString(
    (artifacts.retrieve as { nativeResearchMemo?: unknown } | undefined)?.nativeResearchMemo,
    30_000,
  )
  const existingArtifacts = storedCompanyArtifacts(artifacts, allowedCandidateIds)
  const discovered = discoverMentionedLocalSecurities(db, artifacts, selectedCandidates, allowedCandidateIds)
  let companies = mergeCompanyArtifacts(db, [existingArtifacts, discovered])
  const investmentCoverageRequired = (artifacts.scope as { purpose?: unknown } | undefined)?.purpose === 'investment'
  let coverage = auditCompanyCoverage(
    db,
    artifacts.map,
    companies,
    investmentCoverageRequired,
  )
  if (investmentCoverageRequired && coverage.status === 'incomplete') {
    const repaired = await repairCompanyCoverage(db, loadSkillContent(skill.dirPath), {
      researchQuestion: run.research_question,
      scope: artifacts.scope,
      map: artifacts.map,
      nativeResearchMemo,
      selectedCandidates,
      existingCompanies: companies,
      allowedCandidateIds,
    })
    companies = mergeCompanyArtifacts(db, [companies, repaired])
    coverage = auditCompanyCoverage(db, artifacts.map, companies, investmentCoverageRequired)
  }

  const existingRows = listCompanyCandidates(db, { projectId, runId })
  const existingCodes = new Set(existingRows.flatMap((candidate) => parseMatchedSecurities(candidate)
    .filter((security) => security.matchStatus === 'exact')
    .map((security) => security.tsCode)))
  const existingNames = new Set(existingRows.flatMap((candidate) => [
    candidate.display_name.trim().toLocaleLowerCase('zh-CN'),
    candidate.legal_name_candidate.trim().toLocaleLowerCase('zh-CN'),
  ]))
  const additions = companies.filter((company) => {
    const security = uniqueArtifactSecurity(db, company)
    if (security && existingCodes.has(security.tsCode)) return false
    return !existingNames.has(company.displayName.trim().toLocaleLowerCase('zh-CN'))
      && !existingNames.has(company.legalNameCandidate.trim().toLocaleLowerCase('zh-CN'))
  })
  const projection = projectCompaniesIntoResearchMap(
    db,
    projectId,
    artifacts.map as ResearchMapArtifact,
    companies,
  )
  companies = projection.companies
  artifacts.map = projection.map
  const projectCompanyCountBefore = listResearchProjectCompanies(db, projectId).length
  const now = Date.now()
  artifacts.companies = {
    count: companies.length,
    coverage,
    items: companies.map((item) => ({
      displayName: item.displayName,
      legalNameCandidate: item.legalNameCandidate,
      rationale: item.rationale,
      researchNodeIds: item.researchNodeIds,
      tsCodeHint: item.tsCodeHint,
      candidateIds: item.candidateIds,
      noEvidenceSupport: item.noEvidenceSupport,
    })),
  }
  delete artifacts.report
  delete artifacts.researchFacts
  delete artifacts.financialCollection
  const derivedRunId = randomUUID()
  artifacts.companyExpansion = {
    chainVersion: 2,
    status: 'queued',
    requestedAt: now,
    sourceRunId: evidenceRunId,
    parentRunId: run.id,
    derivedRunId,
    addedCandidates: additions.length,
    targetCompanies: companies.length,
    projectedNodes: projection.addedNodes,
    projectedEdges: projection.addedEdges,
    roleNodeIdsByTsCode: projection.roleNodeIdsByTsCode,
    coverage,
    source: 'user_explicit',
  }

  const derivedRun = db.transaction(() => {
    const created = createGenerationRun(db, {
      id: derivedRunId,
      projectId,
      researchQuestion: run.research_question,
      skillId: run.skill_id,
      skillContentHash: run.skill_content_hash,
      skillRuleVersion: run.skill_rule_version,
      scopeJson: run.scope_json,
      enableWebRetrieval: run.enable_web_retrieval === 1,
    })
    for (const company of companies) {
      const matched = matchSecurities(db, company.displayName, company.tsCodeHint)
      upsertCompanyCandidate(db, {
        id: stableId(derivedRunId, 'company_candidate', company.displayName),
        runId: derivedRunId,
        projectId,
        legalNameCandidate: company.legalNameCandidate,
        displayName: company.displayName,
        researchNodeIds: company.researchNodeIds,
        rationale: company.noEvidenceSupport
          ? `${company.rationale}（无证据支撑）`.slice(0, 500)
          : company.rationale,
        matchedSecurities: matched,
        resolutionStatus: matched.length ? 'pending' : 'unmatched',
      })
    }
    const seeded = updateGenerationRun(db, derivedRunId, {
      status: 'queued',
      currentStage: 'companies',
      lastSuccessfulStage: 'companies',
      progressCurrent: 6,
      progressMessage: `已建立 ${companies.length} 家公司链路，准备采集业务暴露与财务时间轴`,
      stageArtifactsJson: JSON.stringify(artifacts),
    }) || created
    materializeExactProjectCompanies(db, projectId, derivedRunId, artifacts)
    return seeded
  })()

  const totalCandidates = listCompanyCandidates(db, { projectId, runId: derivedRunId }).length
  const totalProjectCompanies = listResearchProjectCompanies(db, projectId).length
  launchGenerationPipeline(
    db,
    derivedRun.id,
    skill,
    options.emitter,
    true,
    options.financial,
  )
  return {
    addedCandidates: additions.length,
    addedProjectCompanies: Math.max(0, totalProjectCompanies - projectCompanyCountBefore),
    totalCandidates,
    totalProjectCompanies,
    targetCompanies: companies.length,
    projectedNodes: projection.addedNodes,
    projectedEdges: projection.addedEdges,
    derivedRunId: derivedRun.id,
    coverage,
  }
}

export function cancelIndustryResearchGeneration(db: Database.Database, projectId: string, runId: string) {
  const run = getGenerationRun(db, runId)
  if (!run || run.project_id !== projectId) throw new IndustryResearchError('NOT_FOUND', '生成运行不存在')
  if (!['queued', 'running'].includes(run.status)) {
    throw new IndustryResearchError('GENERATION_NOT_CANCELLABLE', '当前运行不可取消')
  }
  return requestCancelGenerationRun(db, runId)
}

function hasReusablePersistenceArtifacts(run: IndustryResearchGenerationRunRow): boolean {
  if (run.status !== 'failed' || run.current_stage !== 'report') return false
  const artifacts = parseArtifacts(run)
  const scope = artifacts.scope
  const map = artifacts.map as { nodes?: unknown[] } | undefined
  const report = artifacts.report as { markdown?: unknown } | undefined
  return Boolean(
    scope && typeof scope === 'object'
    && Array.isArray(map?.nodes) && map.nodes.length > 0
    && typeof report?.markdown === 'string' && report.markdown.trim().length > 0,
  )
}

function resumeGenerationPersistence(
  db: Database.Database,
  run: IndustryResearchGenerationRunRow,
  emitter?: ProgressEmitter,
): IndustryResearchGenerationRunRow {
  const artifacts = parseArtifacts(run)
  const previousRecovery = artifacts.persistenceRecovery as { attemptCount?: number } | undefined
  const attemptedAt = Date.now()
  artifacts.persistenceRecovery = {
    attemptCount: Math.max(0, Number(previousRecovery?.attemptCount) || 0) + 1,
    attemptedAt,
    reusedGeneratedArtifacts: true,
    status: 'running',
  }
  const running = updateGenerationRun(db, run.id, {
    status: 'running',
    currentStage: 'report',
    progressCurrent: 7,
    progressMessage: '报告和图谱已生成，正在重新写入项目（不会调用模型）',
    cancelRequested: false,
    errorCode: null,
    errorMessage: null,
    retryable: false,
    completedAt: null,
    stageArtifactsJson: JSON.stringify(artifacts),
  })!
  emitProgress(emitter, running)

  try {
    applyGenerationArtifacts(db, run.project_id, artifacts, run.id)
    artifacts.persistenceRecovery = {
      ...(artifacts.persistenceRecovery as Record<string, unknown>),
      completedAt: Date.now(),
      status: 'succeeded',
    }
    const retrieve = artifacts.retrieve as { degradedCode?: unknown; message?: unknown } | undefined
    const degradedCode = typeof retrieve?.degradedCode === 'string' ? retrieve.degradedCode : null
    const degradedMessage = typeof retrieve?.message === 'string' ? retrieve.message : null
    const succeeded = updateGenerationRun(db, run.id, {
      status: 'succeeded',
      currentStage: 'report',
      lastSuccessfulStage: 'report',
      progressCurrent: 7,
      progressMessage: '已复用现有报告和图谱完成项目写回，未调用模型',
      errorCode: degradedCode,
      errorMessage: degradedCode ? degradedMessage : null,
      retryable: false,
      completedAt: Date.now(),
      stageArtifactsJson: JSON.stringify(artifacts),
    })!
    emitProgress(emitter, succeeded)
    return succeeded
  } catch (error) {
    console.warn(
      '[industryResearch] persistence recovery failed:',
      error instanceof Error ? error.message : error,
    )
    artifacts.persistenceRecovery = {
      ...(artifacts.persistenceRecovery as Record<string, unknown>),
      completedAt: Date.now(),
      status: 'failed',
    }
    const failed = updateGenerationRun(db, run.id, {
      status: 'failed',
      currentStage: 'report',
      progressCurrent: 7,
      progressMessage: '报告与图谱已生成，但重新写入项目仍然失败；产物继续保留',
      errorCode: 'GENERATION_PERSIST_FAILED',
      errorMessage: '报告与图谱已生成，但重新写入项目仍然失败；产物继续保留',
      retryable: true,
      completedAt: Date.now(),
      stageArtifactsJson: JSON.stringify(artifacts),
    })!
    emitProgress(emitter, failed)
    return failed
  }
}

export async function retryIndustryResearchGeneration(
  db: Database.Database,
  projectId: string,
  runId: string,
  resolveSkill: () => SkillMeta | null,
  emitter?: ProgressEmitter,
  stage?: ResearchGenerationStage,
) {
  const old = getGenerationRun(db, runId)
  if (!old || old.project_id !== projectId) throw new IndustryResearchError('NOT_FOUND', '生成运行不存在')
  if (!['failed', 'cancelled'].includes(old.status)) {
    throw new IndustryResearchError('GENERATION_NOT_RETRYABLE', '当前运行不可重试')
  }
  if (getActiveGenerationRun(db, projectId)) {
    throw new IndustryResearchError('GENERATION_ALREADY_RUNNING', '该项目已有进行中的生成任务')
  }
  if ((!stage || stage === 'report') && hasReusablePersistenceArtifacts(old)) {
    return resumeGenerationPersistence(db, old, emitter)
  }
  const skill = resolveSkill()
  if (!skill || skill.skillId !== 'builtin:industry-chain-research') {
    throw new IndustryResearchError('BUILTIN_RESEARCH_SKILL_NOT_FOUND', '未发现内置产业研究 Skill')
  }
  if (skill.contentHash !== old.skill_content_hash) {
    throw new IndustryResearchError('SKILL_CHANGED', 'Skill 已变化，请重新从检索阶段启动')
  }
  const oldArtifacts = parseArtifacts(old)
  const resumableCompanies = (oldArtifacts.companies as { items?: unknown[] } | undefined)?.items
  if (
    old.last_successful_stage === 'companies'
    && Array.isArray(resumableCompanies)
    && (!stage || stage === 'companies' || stage === 'report')
  ) {
    launchGenerationPipeline(db, old.id, skill, emitter, true)
    return getGenerationRun(db, old.id)!
  }
  const retryStage = stage || old.current_stage
  if (stageIndex(retryStage) > stageIndex(old.current_stage)) {
    throw new IndustryResearchError('GENERATION_STAGE_INVALID', '不能从更晚阶段重试')
  }
  const nextRunArtifacts = { ...oldArtifacts }
  delete nextRunArtifacts.researchFacts
  const run = createGenerationRun(db, {
    id: randomUUID(),
    projectId,
    researchQuestion: old.research_question,
    skillId: old.skill_id,
    skillContentHash: old.skill_content_hash,
    skillRuleVersion: old.skill_rule_version,
    scopeJson: old.scope_json,
    enableWebRetrieval: old.enable_web_retrieval === 1,
    stageArtifactsJson: JSON.stringify(nextRunArtifacts),
  })
  launchGenerationPipeline(db, run.id, skill, emitter)
  return run
}

export function continueIndustryResearchFinancialCollection(
  db: Database.Database,
  projectId: string,
  runId: string,
  resolveSkill: () => SkillMeta | null,
  emitter?: ProgressEmitter,
) {
  const run = getGenerationRun(db, runId)
  if (!run || run.project_id !== projectId) throw new IndustryResearchError('NOT_FOUND', '生成运行不存在')
  if (getActiveGenerationRun(db, projectId)) {
    throw new IndustryResearchError('GENERATION_ALREADY_RUNNING', '该项目已有进行中的生成任务')
  }
  const artifacts = parseArtifacts(run)
  const companies = (artifacts.companies as { items?: unknown[] } | undefined)?.items
  if (run.last_successful_stage !== 'companies' && run.last_successful_stage !== 'report') {
    throw new IndustryResearchError('GENERATION_STAGE_INVALID', '公司映射尚未完成，不能单独继续财务采集')
  }
  if (!Array.isArray(companies)) {
    throw new IndustryResearchError('GENERATION_STAGE_INVALID', '缺少可恢复的公司映射阶段产物')
  }
  const collection = artifacts.financialCollection as Partial<ProjectFinancialCollectionState> | undefined
  if (collection?.status === 'succeeded' && Number(collection.pendingDatasets || 0) === 0) {
    throw new IndustryResearchError('FINANCIAL_COLLECTION_COMPLETE', '项目公司财务数据已完成采集')
  }
  if (collection?.errorCode === 'FINANCIAL_SOURCE_DISABLED') {
    const config = getDataSourceConfig(db)
    const token = config.tushareEnabled && config.tushareTokenEncrypted
      ? decryptApiKey(config.tushareTokenEncrypted)
      : null
    if (!token) {
      throw new IndustryResearchError(
        'FINANCIAL_SOURCE_DISABLED',
        '请先在数据源配置中启用 Tushare 并保存可用 Token；现有报告和公司映射已保留',
      )
    }
  }
  const skill = resolveSkill()
  if (!skill || skill.skillId !== 'builtin:industry-chain-research') {
    throw new IndustryResearchError('BUILTIN_RESEARCH_SKILL_NOT_FOUND', '未发现内置产业研究 Skill')
  }
  if (skill.contentHash !== run.skill_content_hash) {
    throw new IndustryResearchError('SKILL_CHANGED', 'Skill 已变化，请重新启动完整研究')
  }
  launchGenerationPipeline(db, run.id, skill, emitter, true)
  return getGenerationRun(db, run.id)!
}

export function ensureGeneratedProjectCompanies(
  db: Database.Database,
  projectId: string,
): number {
  if (!getResearchProject(db, projectId)) throw new IndustryResearchError('NOT_FOUND', '研究项目不存在')
  const run = getLatestSuccessfulGenerationRun(db, projectId)
  if (!run) return 0
  const artifacts = parseArtifacts(run)
  const persist = db.transaction(() => materializeExactProjectCompanies(db, projectId, run.id, artifacts))
  return persist()
}

export interface IndustryResearchCompanyRemapResult {
  scannedCandidates: number
  remappedCandidates: number
  exactMatches: number
  ambiguousMatches: number
  materializedProjectCompanies: number
  stillUnmatched: number
}

export function remapUnmatchedIndustryResearchCompanyCandidates(
  db: Database.Database,
): IndustryResearchCompanyRemapResult {
  const candidates = listRemappableUnmatchedCompanyCandidates(db)
  const result: IndustryResearchCompanyRemapResult = {
    scannedCandidates: candidates.length,
    remappedCandidates: 0,
    exactMatches: 0,
    ambiguousMatches: 0,
    materializedProjectCompanies: 0,
    stillUnmatched: 0,
  }
  const artifactsByRun = new Map<string, Record<string, unknown>>()

  const remap = db.transaction(() => {
    for (const candidate of candidates) {
      let matches = matchSecurities(db, candidate.display_name)
      if (matches.length === 0 && candidate.legal_name_candidate !== candidate.display_name) {
        matches = matchSecurities(db, candidate.legal_name_candidate)
      }
      if (matches.length === 0) {
        result.stillUnmatched += 1
        continue
      }

      const updated = updateUnmatchedCompanyCandidateMatches(db, candidate.id, matches)
      if (!updated || updated.resolution_status === 'excluded') continue
      result.remappedCandidates += 1
      const exact = uniqueActiveAShareMatch(db, updated)
      if (!exact) {
        result.ambiguousMatches += 1
        continue
      }

      result.exactMatches += 1
      const run = getGenerationRun(db, updated.run_id)
      if (!run) continue
      let artifacts = artifactsByRun.get(run.id)
      if (!artifacts) {
        artifacts = parseArtifacts(run)
        artifactsByRun.set(run.id, artifacts)
      }
      const existingSecurity = getResearchSecurityByTsCode(db, exact.tsCode)
      const existingProjectCompany = existingSecurity
        ? getResearchProjectCompany(db, updated.project_id, existingSecurity.company_id)
        : null
      materializeProjectCompanyCandidate(
        db,
        updated.project_id,
        updated.run_id,
        updated,
        exact,
        artifacts,
      )
      if (!existingProjectCompany) result.materializedProjectCompanies += 1
    }
    return result
  })

  return remap()
}

export function resolveIndustryResearchCompanyCandidate(
  db: Database.Database,
  input: {
    projectId: string
    runId: string
    candidateId: string
    action: 'accept' | 'exclude'
    securityTsCode?: string | null
    exclusionReason?: string | null
  },
) {
  const candidate = getCompanyCandidate(db, input.candidateId)
  if (!candidate || candidate.project_id !== input.projectId || candidate.run_id !== input.runId) {
    throw new IndustryResearchError('NOT_FOUND', '公司候选不存在')
  }
  const sourceRun = getGenerationRun(db, input.runId)
  if (!sourceRun || sourceRun.project_id !== input.projectId) {
    throw new IndustryResearchError('NOT_FOUND', '生成运行不存在')
  }
  if (input.action === 'exclude') {
    const reason = input.exclusionReason?.trim()
    if (!reason) throw new IndustryResearchError('INVALID_PARAM', '排除理由不能为空')
    const exclude = db.transaction(() => {
      const exactMatch = parseMatchedSecurities(candidate)
        .filter((item) => item.matchStatus === 'exact')
      if (exactMatch.length === 1) {
        const security = getResearchSecurityByTsCode(db, exactMatch[0].tsCode)
        const projectCompany = security
          ? getResearchProjectCompany(db, input.projectId, security.company_id)
          : null
        if (projectCompany?.status === 'candidate') {
          let evidenceIds: string[] = []
          try { evidenceIds = JSON.parse(projectCompany.evidence_ids_json || '[]') as string[] } catch { /* keep empty */ }
          saveResearchProjectCompany(db, {
            projectId: input.projectId,
            companyId: projectCompany.company_id,
            status: 'excluded',
            exclusionReason: reason,
            evidenceIds,
          })
        }
      }
      return updateCompanyCandidateResolution(db, candidate.id, 'excluded', reason)
    })
    return exclude()
  }

  const matched = parseMatchedSecurities(candidate)
  const selected = input.securityTsCode
    ? matched.filter((item) => item.tsCode === input.securityTsCode)
    : matched.filter((item) => item.matchStatus === 'exact')
  if (selected.length !== 1) {
    throw new IndustryResearchError('COMPANY_CANDIDATE_AMBIGUOUS', '请选择唯一有效的证券候选')
  }
  const security = selected[0]
  const generationArtifacts = parseArtifacts(sourceRun)
  const persist = db.transaction(() => materializeProjectCompanyCandidate(
    db,
    input.projectId,
    input.runId,
    candidate,
    security,
    generationArtifacts,
  ))
  return persist()
}

export {
  confirmProjectEvidenceCandidate,
  getWebSearchConfigView,
  listProjectEvidenceCandidates,
  saveWebSearchConfigAndView,
  validateConfiguredWebSearch,
}

export function createGenerationProgressEmitter(getWindow: () => BrowserWindow | null): ProgressEmitter {
  return (payload) => {
    const win = getWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('industryResearch:generationProgress', payload)
  }
}
