import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import { getAIConfig } from '../database/aiConfigRepository'
import {
  createSession,
  deleteSession,
  getSession,
  type ConversationMessage,
} from '../database/aiAnalysisSessionRepository'
import { getBriefingById } from '../database/briefingRepository'
import { getDecisionJudgment } from '../database/decisionJudgmentRepository'
import { getReviewReport } from '../database/decisionReviewReportRepository'
import { getDecisionSignalById } from '../database/decisionSignalsRepository'
import { listResearchProjectStockCodes } from '../database/industryResearchFinancialRepository'
import { getResearchProject } from '../database/industryResearchRepository'
import { listEvidenceCandidates } from '../database/industryResearchGenerationRepository'
import {
  createResearchDiscussionContext,
  findResumableEvidenceDeltaDiscussion,
  findResumableResearchDiscussion,
  getResearchDiscussionContext,
  getResearchDiscussionContextByRequestId,
  listResearchDiscussionContexts,
  markResearchDiscussionOriginAvailability,
  updateResearchDiscussionContextSelection,
  updateResearchDiscussionReturnTarget,
  type ListResearchDiscussionContextsInput,
} from '../database/researchDiscussionRepository'
import {
  cancelUnresolvedDiscussionBatches,
  getLatestResearchSnapshot,
} from '../database/industryResearchChangeRepository'
import type {
  AIProvider,
  AIResearchDiscussionContextRow,
  ResearchDiscussionOriginType,
  ResearchDiscussionStatus,
} from '../database/types'
import { resolveProviderCredentials } from './aiFallbackService'
import {
  buildContextResearchFactBundle,
  buildStockResearchFactBundle,
  type ContextResearchFactBundle,
  type ContextResearchFactSubject,
  type StockResearchFactBundle,
} from './researchFactPromptService'
import {
  hashResearchEvidenceContrast,
  mergeResearchEvidenceContrasts,
  type ResearchEvidenceContrast,
} from './researchEvidenceAuditService'
import type {
  ResearchEvidenceComparison,
  ResearchEvidenceDeltaItem,
} from './researchEvidenceDeltaService'

const MAX_CONTEXT_BYTES = 128 * 1024
const RESUMABLE_STATUSES = new Set<ResearchDiscussionStatus>(['active', 'changes_ready', 'partially_applied'])

export class ResearchDiscussionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

export interface ResearchDiscussionReturnTarget {
  tab: string
  subTab?: string
  entityId?: string
  stateKey?: string
  scrollTop?: number
}

export interface ResearchDiscussionContextItem {
  key: string
  type: string
  label: string
  excerpt: string
  removable: boolean
}

interface ResolvedOrigin {
  title: string
  occurredAt: number | null
  url: string | null
  items: ResearchDiscussionContextItem[]
  stockCodes: string[]
}

interface DiscussionContextSnapshot {
  schemaVersion: 1 | 2 | 3 | 4
  contextKind?: 'source' | 'evidence_delta'
  title: string
  occurredAt: number | null
  sourceUrl: string | null
  items: ResearchDiscussionContextItem[]
  researchFacts?: StockResearchFactBundle
  contextFacts?: ContextResearchFactBundle
  evidenceDelta?: ResearchEvidenceDiscussionContext
  trustedEvidenceContrast?: ResearchEvidenceContrast
}

export type ResearchEvidenceDiscussionSource =
  | { sourceKind: 'discussion_message'; sessionId: number; messageIndex: number }
  | { sourceKind: 'industry_report'; projectId: string; runId: string }

interface ResearchEvidenceDiscussionSide {
  category: 'supporting' | 'challenging' | 'unknowns'
  label: string
  detail: string
  factDate: string | null
  toolId: string
  sourceIds: string[]
}

interface ResearchEvidenceDiscussionItem {
  referenceId: string
  change: 'changed' | 'added' | 'removed'
  historical: ResearchEvidenceDiscussionSide | null
  current: ResearchEvidenceDiscussionSide | null
}

interface ResearchEvidenceDiscussionContext {
  schemaVersion: 1
  source: ResearchEvidenceDiscussionSource
  generatedAt: number
  historicalAsOf: string | null
  currentAsOf: string
  status: 'ready' | 'partial'
  summary: { changed: number; added: number; removed: number; unchanged: number }
  warnings: string[]
  subjects: Array<{
    subjectKind: 'stock' | 'judgment' | 'industry_project'
    subjectId: string
    label: string
    items: ResearchEvidenceDiscussionItem[]
  }>
}

export interface StartResearchDiscussionInput {
  requestId: string
  origin: { type: ResearchDiscussionOriginType; id: string | null }
  projectId?: string | null
  initialQuestion?: string
  mode?: 'continue_or_create' | 'new'
  returnTarget: ResearchDiscussionReturnTarget
}

export interface StartResearchEvidenceDiscussionInput {
  requestId: string
  source: ResearchEvidenceDiscussionSource
  origin: {
    type: ResearchDiscussionOriginType
    id: string | null
    title: string
    occurredAt: number | null
    sourceUrl: string | null
    projectId: string | null
  }
  comparison: ResearchEvidenceComparison
  returnTarget: ResearchDiscussionReturnTarget
}

function jsonHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function excerpt(value: unknown, max = 1200): string {
  if (typeof value === 'string') return value.trim().slice(0, max)
  return JSON.stringify(value).slice(0, max)
}

function ensureContextSize(value: unknown): string {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > MAX_CONTEXT_BYTES) {
    throw new ResearchDiscussionError('PAYLOAD_TOO_LARGE', '讨论来源上下文超过 128 KiB 限制')
  }
  return json
}

function requireNumericId(id: string | null, label: string): number {
  const value = Number(id)
  if (!Number.isInteger(value) || value <= 0) throw new ResearchDiscussionError('INVALID_PARAM', `${label}格式无效`)
  return value
}

function resolveOrigin(db: Database.Database, origin: StartResearchDiscussionInput['origin'], initialQuestion?: string): ResolvedOrigin {
  if (origin.type === 'manual') {
    const question = initialQuestion?.trim()
    if (!question) throw new ResearchDiscussionError('INVALID_PARAM', '主动讨论必须填写研究问题')
    return {
      title: question.slice(0, 120),
      occurredAt: Date.now(),
      url: null,
      items: [{ key: 'manual-question', type: 'question', label: '研究问题', excerpt: question.slice(0, 4000), removable: false }],
      stockCodes: [],
    }
  }
  if (!origin.id) throw new ResearchDiscussionError('INVALID_PARAM', '来源实体 ID 不能为空')

  if (origin.type === 'daily_review' || origin.type === 'weekly_review') {
    const report = getReviewReport(db, origin.id)
    const expected = origin.type === 'daily_review' ? 'daily' : 'weekly'
    if (report.snapshot.kind !== expected) throw new ResearchDiscussionError('ORIGIN_MISMATCH', '复盘报告类型与讨论来源不一致')
    return {
      title: report.title,
      occurredAt: report.generatedAt,
      url: null,
      items: [
        { key: 'review-headline', type: 'summary', label: '复盘结论', excerpt: excerpt(report.headline), removable: false },
        { key: 'review-risks', type: 'risk', label: '开放风险', excerpt: excerpt(report.snapshot.openRisks), removable: true },
        { key: 'review-gaps', type: 'evidence_gap', label: '待验证项', excerpt: excerpt(report.snapshot.evidenceGaps), removable: true },
        { key: 'review-follow-ups', type: 'follow_up', label: '后续动作', excerpt: excerpt(report.snapshot.followUps), removable: true },
      ],
      stockCodes: [],
    }
  }

  if (origin.type === 'decision_signal') {
    const signal = getDecisionSignalById(db, requireNumericId(origin.id, '信号 ID'))
    if (!signal) throw new ResearchDiscussionError('ORIGIN_NOT_AVAILABLE', '来源信号不存在')
    return {
      title: signal.title,
      occurredAt: signal.signalTime,
      url: null,
      items: [
        { key: 'signal-summary', type: 'summary', label: '信号摘要', excerpt: signal.summary, removable: false },
        { key: 'signal-reason', type: 'evidence', label: '触发依据', excerpt: excerpt(signal.reasonJson), removable: true },
        { key: 'signal-source', type: 'source', label: '来源引用', excerpt: excerpt(signal.sourceRefJson), removable: true },
      ],
      stockCodes: signal.tsCode ? [signal.tsCode] : [],
    }
  }

  if (origin.type === 'judgment') {
    const judgment = getDecisionJudgment(db, origin.id)
    return {
      title: `${judgment.stockName || judgment.tsCode} · 判断 v${judgment.versionNumber}`,
      occurredAt: judgment.createdAt,
      url: null,
      items: [
        { key: 'judgment-note', type: 'judgment', label: '当前判断', excerpt: judgment.note || judgment.tag, removable: false },
        { key: 'judgment-evidence', type: 'evidence', label: '证据快照', excerpt: excerpt(judgment.evidenceSnapshot), removable: true },
        { key: 'judgment-related', type: 'signal', label: '关联信号', excerpt: excerpt(judgment.relatedSignalIds), removable: true },
      ],
      stockCodes: [judgment.tsCode],
    }
  }

  if (origin.type === 'industry_research') {
    const project = getResearchProject(db, origin.id)
    if (!project) throw new ResearchDiscussionError('ORIGIN_NOT_AVAILABLE', '产业研究项目不存在')
    return {
      title: project.title,
      occurredAt: project.updated_at,
      url: null,
      items: [
        { key: 'project-boundary', type: 'scope', label: '研究边界', excerpt: `${project.industry_name} / ${project.product_scope} / ${project.region_scope} / ${project.time_scope}`, removable: false },
        { key: 'project-purpose', type: 'scope', label: '研究目的', excerpt: `${project.purpose} / ${project.depth}`, removable: true },
        { key: 'project-review', type: 'follow_up', label: '回访与停止条件', excerpt: `${project.next_review_at ?? '未设置'} / ${project.stop_condition ?? '未设置'}`, removable: true },
      ],
      stockCodes: listResearchProjectStockCodes(db, project.id, 5),
    }
  }

  const briefing = getBriefingById(requireNumericId(origin.id, '简报 ID'))
  if (!briefing) throw new ResearchDiscussionError('ORIGIN_NOT_AVAILABLE', '来源简报不存在')
  return {
    title: briefing.title,
    occurredAt: briefing.publishedAt,
    url: briefing.originalUrl,
    items: [
      { key: 'briefing-summary', type: 'summary', label: '简报摘要', excerpt: briefing.summary, removable: false },
      { key: 'briefing-content', type: 'source', label: '有限正文摘录', excerpt: excerpt(briefing.fullContent, 3000), removable: true },
    ],
    stockCodes: [],
  }
}

function isValidProvider(value: string | null | undefined): value is AIProvider {
  return value === 'claude' || value === 'chatgpt' || value === 'qwen' || value === 'deepseek'
}

function buildContextSnapshot(
  origin: ResolvedOrigin,
  includedKeys: string[],
  researchFacts: StockResearchFactBundle,
  contextFacts: ContextResearchFactBundle,
): DiscussionContextSnapshot {
  const included = new Set(includedKeys)
  return {
    schemaVersion: 3,
    title: origin.title,
    occurredAt: origin.occurredAt,
    sourceUrl: origin.url,
    items: origin.items.filter((item) => !item.removable || included.has(item.key)),
    researchFacts,
    contextFacts,
  }
}

function buildPrompt(snapshot: DiscussionContextSnapshot): string {
  const body = snapshot.items.map((item) => `【${item.label}】\n${item.excerpt}`).join('\n\n')
  return [
    snapshot.contextKind === 'evidence_delta'
      ? '你正在参与一次基于历史证据与当前本地事实变化的研究讨论。以下变化由主进程从受信历史来源重新校验并只读重建，不是用户上传的事实文本。'
      : '你正在参与一次可持续的产业研究讨论。以下内容是系统按受信来源 ID 读取的有限上下文。',
    '请区分事实、估算与假设；主动指出证据缺口和最低成本反证；不要把媒体、AI 或二手材料自动升级为事实。',
    snapshot.contextKind === 'evidence_delta'
      ? '变化只用于重新检验原结论；removed 仅表示当前规则不再产出，不等于原事实被证伪。不得自动生成买卖、仓位、目标价或收益承诺。'
      : '',
    `【讨论来源】${snapshot.title}`,
    body,
    snapshot.contextFacts?.markdown.slice(0, 8_000) ?? '',
    snapshot.researchFacts?.markdown.slice(0, 10_000) ?? '',
  ].join('\n\n').slice(0, 24_000)
}

export function discussionSummary(db: Database.Database, row: AIResearchDiscussionContextRow) {
  const project = row.project_id ? getResearchProject(db, row.project_id) : null
  return {
    sessionId: row.session_id,
    status: row.status,
    origin: {
      type: row.origin_type,
      id: row.origin_id,
      title: row.origin_title,
      occurredAt: row.origin_occurred_at,
      available: row.origin_available === 1,
    },
    projectId: row.project_id,
    projectTitle: project?.title ?? null,
    baseSnapshotId: row.base_snapshot_id,
    baseSelectionReason: row.base_selection_reason,
    returnTarget: safeJson<ResearchDiscussionReturnTarget>(row.return_target_json, { tab: 'ai-analysis', subTab: 'records' }),
    summarizedThroughMessageIndex: row.summarized_through_message_index,
    latestBatchId: row.latest_batch_id,
    degradedReason: row.degraded_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function discussionContextPreview(row: AIResearchDiscussionContextRow): ResearchDiscussionContextItem[] {
  const all = safeJson<ResearchDiscussionContextItem[]>(row.context_keys_json, [])
  const included = new Set(safeJson<string[]>(row.included_context_keys_json, []))
  return all.filter((item) => !item.removable || included.has(item.key))
}

export function startResearchDiscussion(db: Database.Database, input: StartResearchDiscussionInput) {
  const byRequest = getResearchDiscussionContextByRequestId(db, input.requestId)
  if (byRequest) {
    return {
      session: getSession(db, byRequest.session_id)!,
      discussion: discussionSummary(db, byRequest),
      contextPreview: discussionContextPreview(byRequest),
      resumed: true,
      initialQuestion: input.initialQuestion?.trim() || null,
    }
  }

  if (input.mode !== 'new') {
    const resumable = findResumableResearchDiscussion(db, input.origin.type, input.origin.id, input.projectId ?? null)
    if (resumable && RESUMABLE_STATUSES.has(resumable.status)) {
      const refreshed = updateResearchDiscussionReturnTarget(db, resumable.session_id, JSON.stringify(input.returnTarget)) ?? resumable
      return {
        session: getSession(db, resumable.session_id)!,
        discussion: discussionSummary(db, refreshed),
        contextPreview: discussionContextPreview(refreshed),
        resumed: true,
        initialQuestion: null,
      }
    }
  }

  const origin = resolveOrigin(db, input.origin, input.initialQuestion)
  if (input.origin.type === 'industry_research' && input.projectId && input.projectId !== input.origin.id) {
    throw new ResearchDiscussionError('PROJECT_MISMATCH', '讨论来源项目与关联项目不一致')
  }
  const projectId = input.projectId ?? (input.origin.type === 'industry_research' ? input.origin.id : null)
  if (projectId && !getResearchProject(db, projectId)) throw new ResearchDiscussionError('NOT_FOUND', '关联研究项目不存在')
  const latestSnapshot = projectId ? getLatestResearchSnapshot(db, projectId) : null
  const includedKeys = origin.items.map((item) => item.key)
  const factAsOf = beijingDateFromTimestamp(origin.occurredAt)
  const researchFacts = buildStockResearchFactBundle(db, origin.stockCodes, {
    asOf: factAsOf,
  })
  const contextFacts = buildContextResearchFactBundle(db, contextFactSubject(input.origin), {
    asOf: factAsOf,
    maxCreatedAt: input.origin.type === 'judgment' ? origin.occurredAt : null,
  })
  const snapshot = buildContextSnapshot(origin, includedKeys, researchFacts, contextFacts)
  const snapshotJson = ensureContextSize(snapshot)
  const credentials = resolveProviderCredentials(db)
  const config = getAIConfig(db)
  const provider: AIProvider = credentials?.provider ?? (isValidProvider(config.provider) ? config.provider : 'qwen')
  const model = credentials?.model ?? config.model ?? 'unconfigured'
  const create = db.transaction(() => {
    const sessionId = createSession(db, {
      provider,
      model,
      articleUrls: origin.url ? [origin.url] : [],
      promptSent: buildPrompt(snapshot),
      response: null,
      scanRunId: null,
      isError: false,
      messages: [],
    })
    return createResearchDiscussionContext(db, {
      sessionId,
      requestId: input.requestId,
      originType: input.origin.type,
      originId: input.origin.id,
      originTitle: origin.title,
      originOccurredAt: origin.occurredAt,
      originContentHash: jsonHash(snapshot),
      contextSnapshotJson: snapshotJson,
      contextKeysJson: JSON.stringify(origin.items),
      includedContextKeysJson: JSON.stringify(includedKeys),
      returnTargetJson: JSON.stringify(input.returnTarget),
      projectId,
      baseSnapshotId: latestSnapshot?.id ?? null,
      baseSelectionReason: projectId ? (latestSnapshot ? 'latest_compatible' : 'empty_project') : 'unassigned',
    })
  })
  const row = create()
  return {
    session: getSession(db, row.session_id)!,
    discussion: discussionSummary(db, row),
    contextPreview: discussionContextPreview(row),
    resumed: false,
    initialQuestion: input.initialQuestion?.trim() || null,
  }
}

const EVIDENCE_DISCUSSION_MAX_ITEMS = 24
const EVIDENCE_DISCUSSION_MAX_WARNINGS = 10

export function startResearchEvidenceDiscussion(
  db: Database.Database,
  input: StartResearchEvidenceDiscussionInput,
) {
  const byRequest = getResearchDiscussionContextByRequestId(db, input.requestId)
  if (byRequest) {
    const snapshot = safeJson<DiscussionContextSnapshot | null>(byRequest.context_snapshot_json, null)
    if (
      snapshot?.contextKind !== 'evidence_delta'
      || !snapshot.evidenceDelta
      || JSON.stringify(snapshot.evidenceDelta.source) !== JSON.stringify(input.source)
    ) {
      throw new ResearchDiscussionError('INVALID_PARAM', 'requestId已用于其他研究讨论')
    }
    return evidenceDiscussionResult(db, byRequest, true)
  }

  const deltaContext = buildEvidenceDiscussionContext(input.source, input.comparison)
  const changeCount = deltaContext.summary.changed + deltaContext.summary.added + deltaContext.summary.removed
  if (changeCount === 0) {
    throw new ResearchDiscussionError('NO_CHANGES', '当前本地事实与历史证据没有可讨论的变化')
  }
  const historicalHash = hashResearchEvidenceContrast(input.comparison.historicalEvidence)
  const currentHash = hashResearchEvidenceContrast({
    ...input.comparison.currentEvidence,
    generatedAt: 0,
  })
  if (!historicalHash || !currentHash) {
    throw new ResearchDiscussionError('TRACE_UNAVAILABLE', '事实变化缺少可固化的证据快照')
  }
  const fingerprint = jsonHash({
    source: input.source,
    historicalHash,
    currentHash,
    delta: {
      historicalAsOf: deltaContext.historicalAsOf,
      currentAsOf: deltaContext.currentAsOf,
      status: deltaContext.status,
      summary: deltaContext.summary,
      warnings: deltaContext.warnings,
      subjects: deltaContext.subjects,
    },
  })
  const resumable = findResumableEvidenceDeltaDiscussion(db, fingerprint)
  if (resumable) {
    const refreshed = updateResearchDiscussionReturnTarget(
      db,
      resumable.session_id,
      JSON.stringify(input.returnTarget),
    ) ?? resumable
    return evidenceDiscussionResult(db, refreshed, true)
  }

  const title = `${input.origin.title} · 事实变化复核`.slice(0, 240)
  const item: ResearchDiscussionContextItem = {
    key: 'trusted-evidence-delta',
    type: 'evidence_delta',
    label: '历史证据与当前事实变化',
    excerpt: renderEvidenceDiscussionMarkdown(deltaContext),
    removable: false,
  }
  const snapshot: DiscussionContextSnapshot = {
    schemaVersion: 4,
    contextKind: 'evidence_delta',
    title,
    occurredAt: input.comparison.delta.generatedAt,
    sourceUrl: input.origin.sourceUrl,
    items: [item],
    evidenceDelta: deltaContext,
    trustedEvidenceContrast: input.comparison.currentEvidence,
  }
  const snapshotJson = ensureContextSize(snapshot)
  const credentials = resolveProviderCredentials(db)
  const config = getAIConfig(db)
  const provider: AIProvider = credentials?.provider ?? (isValidProvider(config.provider) ? config.provider : 'qwen')
  const model = credentials?.model ?? config.model ?? 'unconfigured'
  const latestSnapshot = input.origin.projectId ? getLatestResearchSnapshot(db, input.origin.projectId) : null
  const create = db.transaction(() => {
    const sessionId = createSession(db, {
      provider,
      model,
      articleUrls: input.origin.sourceUrl ? [input.origin.sourceUrl] : [],
      promptSent: buildPrompt(snapshot),
      response: null,
      scanRunId: null,
      isError: false,
      messages: [],
    })
    return createResearchDiscussionContext(db, {
      sessionId,
      requestId: input.requestId,
      originType: input.origin.type,
      originId: input.origin.id,
      originTitle: title,
      originOccurredAt: input.comparison.delta.generatedAt,
      originContentHash: fingerprint,
      contextSnapshotJson: snapshotJson,
      contextKeysJson: JSON.stringify([item]),
      includedContextKeysJson: JSON.stringify([item.key]),
      returnTargetJson: JSON.stringify(input.returnTarget),
      projectId: input.origin.projectId,
      baseSnapshotId: latestSnapshot?.id ?? null,
      baseSelectionReason: input.origin.projectId
        ? (latestSnapshot ? 'latest_compatible' : 'empty_project')
        : 'unassigned',
    })
  })
  return evidenceDiscussionResult(db, create(), false)
}

function evidenceDiscussionResult(
  db: Database.Database,
  row: AIResearchDiscussionContextRow,
  resumed: boolean,
) {
  const session = getSession(db, row.session_id)!
  const messages = session.messages ? safeJson<ConversationMessage[]>(session.messages, []) : []
  return {
    session,
    discussion: discussionSummary(db, row),
    contextPreview: discussionContextPreview(row),
    resumed,
    initialQuestion: messages.length > 0
      ? null
      : '请基于这次事实变化重新检验原结论：哪些判断仍成立，哪些需要降低置信度，下一步最小成本的验证动作是什么？',
  }
}

function buildEvidenceDiscussionContext(
  source: ResearchEvidenceDiscussionSource,
  comparison: ResearchEvidenceComparison,
): ResearchEvidenceDiscussionContext {
  let remaining = EVIDENCE_DISCUSSION_MAX_ITEMS
  const subjects = comparison.delta.subjects.map((subject) => {
    const items = subject.items
      .filter((item): item is ResearchEvidenceDeltaItem & { change: 'changed' | 'added' | 'removed' } => item.change !== 'unchanged')
      .slice(0, remaining)
      .map((item) => ({
        referenceId: item.referenceId,
        change: item.change,
        historical: boundedDeltaSide(item.historical),
        current: boundedDeltaSide(item.current),
      }))
    remaining -= items.length
    return {
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      label: subject.label.slice(0, 160),
      items,
    }
  }).filter((subject) => subject.items.length > 0)
  const totalChanges = comparison.delta.summary.changed
    + comparison.delta.summary.added
    + comparison.delta.summary.removed
  const warnings = [...comparison.delta.warnings]
  if (totalChanges > EVIDENCE_DISCUSSION_MAX_ITEMS) {
    warnings.unshift(`变化项超过${EVIDENCE_DISCUSSION_MAX_ITEMS}条，讨论上下文已截断`)
  }
  return {
    schemaVersion: 1,
    source,
    generatedAt: comparison.delta.generatedAt,
    historicalAsOf: comparison.delta.historicalAsOf,
    currentAsOf: comparison.delta.currentAsOf,
    status: comparison.delta.status,
    summary: comparison.delta.summary,
    warnings: [...new Set(warnings)].slice(0, EVIDENCE_DISCUSSION_MAX_WARNINGS),
    subjects,
  }
}

function boundedDeltaSide(item: ResearchEvidenceDeltaItem['historical']): ResearchEvidenceDiscussionSide | null {
  if (!item) return null
  return {
    category: item.category,
    label: item.label.slice(0, 160),
    detail: item.detail.slice(0, 800),
    factDate: item.factDate,
    toolId: item.toolId,
    sourceIds: item.sourceIds.slice(0, 6).map((sourceId) => sourceId.slice(0, 240)),
  }
}

function renderEvidenceDiscussionMarkdown(context: ResearchEvidenceDiscussionContext): string {
  const changeLabel = { changed: '发生变化', added: '当前新增', removed: '当前不再产出' } as const
  const lines = [
    `历史截点：${context.historicalAsOf ?? '未知'}；当前截点：${context.currentAsOf}；状态：${context.status}`,
    `变化汇总：${context.summary.changed}项变化、${context.summary.added}项新增、${context.summary.removed}项移除、${context.summary.unchanged}项未变。`,
    '边界：removed仅表示当前证据规则不再产出该项，不等于原事实被证伪。以下内容不能自动推出原结论失效。',
  ]
  for (const subject of context.subjects) {
    lines.push(`\n【${subject.label}】`)
    for (const item of subject.items) {
      const historical = item.historical
        ? `${item.historical.label}：${item.historical.detail}（${item.historical.factDate ?? '日期未知'}）`
        : '无对应历史项'
      const current = item.current
        ? `${item.current.label}：${item.current.detail}（${item.current.factDate ?? '日期未知'}）`
        : '当前规则未产出对应项'
      lines.push(`- ${item.referenceId} ${changeLabel[item.change]}；历史：${historical}；当前：${current}`)
    }
  }
  if (context.warnings.length > 0) {
    lines.push('\n【读取警告】', ...context.warnings.map((warning) => `- ${warning}`))
  }
  return lines.join('\n').slice(0, 20_000)
}

export function updateDiscussionContextBeforeStart(
  db: Database.Database,
  sessionId: number,
  requestId: string,
  includedContextKeys: string[],
) {
  const row = getResearchDiscussionContext(db, sessionId)
  if (!row) throw new ResearchDiscussionError('NOT_FOUND', '研究讨论不存在')
  const session = getSession(db, sessionId)
  if (!session) throw new ResearchDiscussionError('NOT_FOUND', 'AI 会话不存在')
  const messages = session.messages ? safeJson<ConversationMessage[]>(session.messages, []) : []
  if (messages.length > 0) throw new ResearchDiscussionError('DISCUSSION_ALREADY_STARTED', '讨论已开始，不能无痕修改来源上下文')
  const allItems = safeJson<ResearchDiscussionContextItem[]>(row.context_keys_json, [])
  const validKeys = new Set(allItems.map((item) => item.key))
  if (includedContextKeys.some((key) => !validKeys.has(key))) throw new ResearchDiscussionError('INVALID_PARAM', '包含了未知上下文项')
  const required = allItems.filter((item) => !item.removable).map((item) => item.key)
  const selected = [...new Set([...required, ...includedContextKeys])]
  const previous = safeJson<DiscussionContextSnapshot>(row.context_snapshot_json, {
    schemaVersion: 1, title: row.origin_title, occurredAt: row.origin_occurred_at, sourceUrl: null, items: [],
  })
  const snapshot: DiscussionContextSnapshot = {
    ...previous,
    schemaVersion: previous.schemaVersion === 4
      ? 4
      : previous.schemaVersion === 3
        ? 3
        : previous.schemaVersion === 2
          ? 2
          : 1,
    items: allItems.filter((item) => selected.includes(item.key)),
  }
  const saved = updateResearchDiscussionContextSelection(db, {
    sessionId,
    requestId,
    contextSnapshotJson: ensureContextSize(snapshot),
    includedContextKeysJson: JSON.stringify(selected),
    originContentHash: jsonHash(snapshot),
  })!
  db.prepare('UPDATE ai_analysis_sessions SET promptSent = ? WHERE id = ?').run(buildPrompt(snapshot), sessionId)
  return { discussion: discussionSummary(db, saved), contextPreview: discussionContextPreview(saved) }
}

function contextFactSubject(
  origin: StartResearchDiscussionInput['origin'],
): ContextResearchFactSubject | null {
  if (!origin.id) return null
  if (origin.type === 'judgment') return { kind: 'judgment', id: origin.id }
  if (origin.type === 'industry_research') return { kind: 'industry_project', id: origin.id }
  return null
}

function beijingDateFromTimestamp(timestamp: number | null): string | null {
  if (timestamp == null || !Number.isFinite(timestamp)) return null
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

export function listResearchDiscussions(db: Database.Database, input: ListResearchDiscussionContextsInput) {
  const result = listResearchDiscussionContexts(db, input)
  return {
    ...result,
    items: result.items.map((row) => {
      refreshDiscussionOriginAvailability(db, row.session_id)
      return discussionSummary(db, getResearchDiscussionContext(db, row.session_id) ?? row)
    }),
  }
}

export function buildDiscussionModelMessages(
  db: Database.Database,
  sessionId: number,
  messages: ConversationMessage[],
): ConversationMessage[] {
  const context = getResearchDiscussionContext(db, sessionId)
  if (!context) return messages
  const session = getSession(db, sessionId)
  const contextPrompt = session?.promptSent?.trim()
  if (!contextPrompt) return messages
  const webSearchPolicy = getDiscussionWebSearchPolicy(db, sessionId)
  const webSearchPrompt = webSearchPolicy.enabled
    ? [
        '【产业研究联网规则】每轮讨论必须使用 GPT 原生网页搜索核验最新资料，并在结论中保留可追溯引用。',
        '系统负责检索、分析和形成结论，不得要求用户逐条审核或放行来源。',
        ...(webSearchPolicy.excludedUrls.length
          ? [
              '以下 URL 已由用户明确排除，不得搜索、引用、转述或用其支持结论：',
              ...webSearchPolicy.excludedUrls.map((url) => `- ${url}`),
            ]
          : []),
      ].join('\n')
    : ''
  return [{
    role: 'user',
    content: [contextPrompt, webSearchPrompt].filter(Boolean).join('\n\n'),
  }, ...messages]
}

export interface DiscussionWebSearchPolicy {
  enabled: boolean
  projectId: string | null
  excludedUrls: string[]
}

export interface DiscussionAIRequest {
  messages: ConversationMessage[]
  webSearch?: {
    enabled: true
    searchContextSize: 'high'
    excludedUrls: string[]
  }
  nativeWebSearchOnly?: true
}

export interface DiscussionResearchAuditContext {
  evidenceContrast: ResearchEvidenceContrast
  asOf: string | null
  excludedUrls: string[]
  allowedFactTexts: string[]
}

export function getDiscussionWebSearchPolicy(
  db: Database.Database,
  sessionId: number,
): DiscussionWebSearchPolicy {
  const context = getResearchDiscussionContext(db, sessionId)
  const projectId = context?.project_id || null
  if (!projectId) return { enabled: false, projectId: null, excludedUrls: [] }
  const excludedUrls = Array.from(new Set(
    listEvidenceCandidates(db, { projectId })
      .filter((candidate) => candidate.status === 'rejected')
      .map((candidate) => candidate.source_url.trim())
      .filter(Boolean),
  )).slice(0, 40)
  return { enabled: true, projectId, excludedUrls }
}

export function buildDiscussionAIRequest(
  db: Database.Database,
  sessionId: number,
  messages: ConversationMessage[],
): DiscussionAIRequest {
  const policy = getDiscussionWebSearchPolicy(db, sessionId)
  return {
    messages: buildDiscussionModelMessages(db, sessionId, messages),
    ...(policy.enabled ? {
      webSearch: {
        enabled: true as const,
        searchContextSize: 'high' as const,
        excludedUrls: policy.excludedUrls,
      },
      nativeWebSearchOnly: true as const,
    } : {}),
  }
}

export function getDiscussionResearchAuditContext(
  db: Database.Database,
  sessionId: number,
): DiscussionResearchAuditContext | null {
  const context = getResearchDiscussionContext(db, sessionId)
  if (!context) return null
  const snapshot = safeJson<DiscussionContextSnapshot>(context.context_snapshot_json, {
    schemaVersion: 1,
    title: context.origin_title,
    occurredAt: context.origin_occurred_at,
    sourceUrl: null,
    items: [],
  })
  const session = getSession(db, sessionId)
  const policy = getDiscussionWebSearchPolicy(db, sessionId)
  const evidenceContrast = mergeResearchEvidenceContrasts([
    snapshot.trustedEvidenceContrast,
    snapshot.contextFacts?.evidenceContrast,
    snapshot.researchFacts?.evidenceContrast,
  ], {
    asOf: snapshot.trustedEvidenceContrast?.asOf
      ?? snapshot.contextFacts?.asOf
      ?? snapshot.researchFacts?.asOf
      ?? null,
  })
  return {
    evidenceContrast,
    asOf: evidenceContrast.asOf,
    excludedUrls: policy.excludedUrls,
    allowedFactTexts: [session?.promptSent ?? ''].filter(Boolean),
  }
}

export function deleteResearchDiscussion(db: Database.Database, sessionId: number): void {
  const remove = db.transaction(() => {
    const context = getResearchDiscussionContext(db, sessionId)
    if (!context) throw new ResearchDiscussionError('NOT_FOUND', '研究讨论不存在')
    cancelUnresolvedDiscussionBatches(db, sessionId)
    deleteSession(db, sessionId)
  })
  remove()
}

export function deleteAllResearchDiscussions(db: Database.Database): number {
  let deleted = 0
  while (true) {
    const contexts = listResearchDiscussionContexts(db, { offset: 0, limit: 100 }).items
    if (!contexts.length) return deleted
    for (const context of contexts) {
      deleteResearchDiscussion(db, context.session_id)
      deleted += 1
    }
  }
}

export function refreshDiscussionOriginAvailability(db: Database.Database, sessionId: number): boolean {
  const row = getResearchDiscussionContext(db, sessionId)
  if (!row) return false
  try {
    resolveOrigin(db, { type: row.origin_type, id: row.origin_id }, row.origin_type === 'manual' ? row.origin_title : undefined)
    if (row.origin_available === 0) markResearchDiscussionOriginAvailability(db, sessionId, true)
    return true
  } catch {
    if (row.origin_available === 1) markResearchDiscussionOriginAvailability(db, sessionId, false)
    return false
  }
}
