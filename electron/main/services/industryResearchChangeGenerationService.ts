import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getSession } from '../database/aiAnalysisSessionRepository'
import {
  getCandidateBatch,
  getCandidateBatchByIdempotencyKey,
  listChangeSets,
  savePreparedCandidateBatch,
  type PreparedChangeCandidateInput,
  type PreparedChangeSetInput,
} from '../database/industryResearchChangeRepository'
import { getResearchProject } from '../database/industryResearchRepository'
import {
  getResearchDiscussionContext,
  updateResearchDiscussionProgress,
} from '../database/researchDiscussionRepository'
import type {
  IndustryResearchCandidateBatchRow,
  IndustryResearchChangeCandidateRow,
  IndustryResearchChangeSetRow,
  ResearchChangeCandidateKind,
  ResearchChangeSetAction,
} from '../database/types'
import { callWithFallback, type AIFallbackResult } from './aiFallbackService'
import { ResearchDiscussionError } from './researchDiscussionContextService'

const RULE_VERSION = 'fr239-change-sets-v1'
const KINDS = new Set<ResearchChangeCandidateKind>([
  'project', 'node', 'edge', 'evidence', 'hypothesis', 'hypothesis_event',
  'company', 'company_exposure', 'follow_up',
])
const ACTIONS = new Set<ResearchChangeSetAction>([
  'add', 'revise', 'strengthen', 'weaken', 'refute', 'reopen', 'follow_up', 'no_change',
])

interface ModelCandidate {
  kind?: unknown
  action?: unknown
  externalRef?: unknown
  sourceLocator?: unknown
  targetEntityId?: unknown
  statementType?: unknown
  primarySource?: unknown
  payload?: unknown
  conflicts?: unknown
  warnings?: unknown
}

interface ModelChangeSet {
  title?: unknown
  summary?: unknown
  impact?: unknown
  action?: unknown
  risk?: unknown
  affectedObjects?: unknown
  evidenceSummary?: unknown
  confidenceBoundary?: unknown
  requiresExpandedReview?: unknown
  candidates?: unknown
}

interface ModelOutput {
  noMaterialChange?: unknown
  summary?: unknown
  changeSets?: unknown
}

export interface PrepareDiscussionChangesInput {
  requestId: string
  sessionId: number
  throughMessageIndex: number
  projectId?: string | null
  baseSnapshotId?: string | null
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback
}

function strings(value: unknown, maxItems = 20, maxText = 500): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, maxItems).map((item) => text(item, '', maxText)).filter(Boolean)
}

function extractJson(textValue: string): ModelOutput {
  const fenced = textValue.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const source = fenced ?? textValue.slice(textValue.indexOf('{'), textValue.lastIndexOf('}') + 1)
  try {
    return JSON.parse(source) as ModelOutput
  } catch {
    throw new ResearchDiscussionError('GENERATION_FAILED', 'AI 未返回可解析的研究变更结构')
  }
}

function normalizeCandidate(raw: ModelCandidate, locatorFallback: string): PreparedChangeCandidateInput | null {
  if (typeof raw !== 'object' || raw == null) return null
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind as ResearchChangeCandidateKind)
    ? raw.kind as ResearchChangeCandidateKind
    : null
  if (!kind) return null
  const statementType = raw.statementType === 'fact' || raw.statementType === 'estimate'
    || raw.statementType === 'hypothesis' || raw.statementType === 'candidate'
    ? raw.statementType
    : kind === 'hypothesis' || kind === 'hypothesis_event' || kind === 'follow_up' ? 'hypothesis' : 'estimate'
  return {
    id: randomUUID(),
    kind,
    action: text(raw.action, 'add', 40),
    externalRef: typeof raw.externalRef === 'string' ? raw.externalRef.trim().slice(0, 300) || null : null,
    sourceLocator: text(raw.sourceLocator, locatorFallback, 1000),
    targetEntityId: typeof raw.targetEntityId === 'string' ? raw.targetEntityId.trim().slice(0, 200) || null : null,
    statementType,
    primarySource: raw.primarySource === true,
    payload: typeof raw.payload === 'object' && raw.payload != null ? raw.payload : {},
    conflicts: strings(raw.conflicts, 20, 500),
    warnings: strings(raw.warnings, 20, 500),
  }
}

function normalizeChangeSet(raw: ModelChangeSet, index: number): PreparedChangeSetInput | null {
  if (typeof raw !== 'object' || raw == null) return null
  const action = typeof raw.action === 'string' && ACTIONS.has(raw.action as ResearchChangeSetAction)
    ? raw.action as ResearchChangeSetAction
    : 'add'
  if (action === 'no_change') return null
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates.slice(0, 300).map((candidate) => normalizeCandidate(candidate as ModelCandidate, `change-set:${index + 1}`)).filter((item): item is PreparedChangeCandidateInput => Boolean(item))
    : []
  if (!candidates.length) return null
  const affectedObjects = Array.isArray(raw.affectedObjects)
    ? raw.affectedObjects.slice(0, 30).map((item) => {
        const value = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        return {
          type: text(value.type, 'research', 50),
          id: typeof value.id === 'string' ? value.id.slice(0, 200) : null,
          label: text(value.label, '研究对象', 200),
        }
      })
    : []
  return {
    id: randomUUID(),
    title: text(raw.title, `研究增量 ${index + 1}`, 160),
    summary: text(raw.summary, '讨论形成了新的研究增量。', 2000),
    impact: text(raw.impact, '需要更新对应研究对象。', 2000),
    action,
    risk: raw.risk === 'high' || raw.risk === 'medium' ? raw.risk : 'low',
    affectedObjects,
    evidenceSummary: strings(raw.evidenceSummary, 20, 500),
    confidenceBoundary: text(raw.confidenceBoundary, '来自 AI 讨论整理，默认不视为已验证事实。', 1000),
    requiresExpandedReview: raw.requiresExpandedReview === true
      || raw.risk === 'high'
      || candidates.some((candidate) => candidate.statementType === 'fact' || candidate.conflicts!.length > 0),
    candidates,
  }
}

function capChangeSets(items: PreparedChangeSetInput[]): PreparedChangeSetInput[] {
  if (items.length <= 7) return items
  const head = items.slice(0, 6)
  const tail = items.slice(6)
  return [...head, {
    id: randomUUID(),
    title: '其他相关研究增量',
    summary: tail.map((item) => item.title).join('；').slice(0, 2000),
    impact: '这些变化属于同一轮讨论的次要增量，合并展示以避免形成长审核列表。',
    action: 'revise',
    risk: tail.some((item) => item.risk === 'high') ? 'high' : tail.some((item) => item.risk === 'medium') ? 'medium' : 'low',
    affectedObjects: tail.flatMap((item) => item.affectedObjects).slice(0, 30),
    evidenceSummary: tail.flatMap((item) => item.evidenceSummary).slice(0, 20),
    confidenceBoundary: '聚合包仍保留全部底层候选；接受前按最高风险级别处理。',
    requiresExpandedReview: tail.some((item) => item.requiresExpandedReview),
    candidates: tail.flatMap((item) => item.candidates).slice(0, 1000),
  }]
}

function buildPrompt(input: {
  context: unknown
  messages: Array<{ role: string; content: string }>
  project: unknown
}): string {
  return `你是产业研究增量整理器。请比较来源上下文、讨论消息和可选研究项目，只提取真正改变研究结论、假设、证据、公司或回访点的内容。

必须遵守：
1. 输出 JSON，不输出 Markdown。
2. 默认生成 3 至 7 个面向用户的语义变更包；没有实质变化时 noMaterialChange=true 且 changeSets=[]。
3. AI、媒体和二手材料不得标为已确认事实。普通内容使用 estimate、hypothesis 或 candidate。
4. 每个变更包可包含多个底层候选，候选 kind 仅限 project/node/edge/evidence/hypothesis/hypothesis_event/company/company_exposure/follow_up。
5. 事实升级、重大冲突或覆盖人工内容时 risk=high 且 requiresExpandedReview=true。

输出结构：
{"noMaterialChange":false,"summary":"...","changeSets":[{"title":"...","summary":"...","impact":"...","action":"add|revise|strengthen|weaken|refute|reopen|follow_up|no_change","risk":"low|medium|high","affectedObjects":[{"type":"...","id":null,"label":"..."}],"evidenceSummary":["..."],"confidenceBoundary":"...","requiresExpandedReview":false,"candidates":[{"kind":"hypothesis","action":"add","externalRef":"stable-key","sourceLocator":"discussion:message:1","targetEntityId":null,"statementType":"hypothesis","primarySource":false,"payload":{},"conflicts":[],"warnings":[]}]}]}

来源上下文：${JSON.stringify(input.context).slice(0, 24_000)}

目标研究：${JSON.stringify(input.project).slice(0, 12_000)}

讨论消息：${JSON.stringify(input.messages).slice(0, 48_000)}`
}

export function candidateBatchSummary(row: IndustryResearchCandidateBatchRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    sourceType: row.source_type,
    sourceSessionId: row.source_session_id,
    projectId: row.project_id,
    baseSnapshotId: row.base_snapshot_id,
    messageStartIndex: row.message_start_index,
    messageEndIndex: row.message_end_index,
    status: row.status,
    changeSetCount: row.change_set_count,
    candidateCount: row.candidate_count,
    conflictCount: row.conflict_count,
    createdAt: row.created_at,
  }
}

export function changeSetSummary(row: IndustryResearchChangeSetRow) {
  const userEdits = safeJson<{ title?: string; summary?: string } | null>(row.user_edits_json ?? 'null', null)
  return {
    id: row.id,
    batchId: row.batch_id,
    title: userEdits?.title?.trim() || row.title,
    summary: userEdits?.summary?.trim() || row.summary,
    generatedTitle: row.title,
    generatedSummary: row.summary,
    userEdited: Boolean(userEdits?.title?.trim() || userEdits?.summary?.trim()),
    impact: row.impact,
    action: row.action,
    status: row.status,
    risk: row.risk,
    affectedObjects: safeJson(row.affected_objects_json, []),
    evidenceSummary: safeJson(row.evidence_summary_json, []),
    confidenceBoundary: row.confidence_boundary,
    requiresExpandedReview: row.requires_expanded_review === 1,
    candidateCount: row.candidate_count,
    sourceSessionId: row.source_session_id,
    messageStartIndex: row.message_start_index,
    messageEndIndex: row.message_end_index,
  }
}

export function changeCandidateView(row: IndustryResearchChangeCandidateRow) {
  return {
    id: row.id,
    changeSetId: row.change_set_id,
    batchId: row.batch_id,
    projectId: row.project_id,
    kind: row.kind,
    action: row.action,
    status: row.status,
    statementType: row.statement_type,
    primarySource: row.primary_source === 1,
    sourceLocator: row.source_locator,
    targetEntityId: row.target_entity_id,
    payload: safeJson(row.payload_json, {}),
    conflicts: safeJson(row.conflicts_json, []),
    warnings: safeJson(row.warnings_json, []),
  }
}

export async function prepareDiscussionChanges(
  db: Database.Database,
  input: PrepareDiscussionChangesInput,
  callAI: (db: Database.Database, params: { prompt: string }) => Promise<AIFallbackResult> = callWithFallback,
) {
  const context = getResearchDiscussionContext(db, input.sessionId)
  if (!context) throw new ResearchDiscussionError('NOT_FOUND', '研究讨论不存在')
  const session = getSession(db, input.sessionId)
  if (!session) throw new ResearchDiscussionError('NOT_FOUND', 'AI 会话不存在')
  const messages = session.messages ? safeJson<Array<{ role: string; content: string }>>(session.messages, []) : []
  if (!Number.isInteger(input.throughMessageIndex) || input.throughMessageIndex < 0 || input.throughMessageIndex >= messages.length) {
    throw new ResearchDiscussionError('MESSAGE_RANGE_INVALID', '整理消息范围无效')
  }
  if (context.summarized_through_message_index != null && input.throughMessageIndex <= context.summarized_through_message_index) {
    const existing = context.latest_batch_id ? getCandidateBatch(db, context.latest_batch_id) : null
    if (!existing) {
      return {
        batch: null,
        changeSets: [],
        noMaterialChange: true,
        summary: '该消息范围已经整理，未产生需要写入研究的变化。',
        degradedReasons: [],
      }
    }
    return {
      batch: candidateBatchSummary(existing),
      changeSets: listChangeSets(db, { batchId: existing.id, limit: 100 }).items.map(changeSetSummary),
      noMaterialChange: false,
      summary: '已返回该消息范围最近一次整理结果。',
      degradedReasons: safeJson(existing.degraded_reasons_json, []),
    }
  }
  const projectId = input.projectId === undefined ? context.project_id : input.projectId
  if (context.project_id && projectId && context.project_id !== projectId) {
    throw new ResearchDiscussionError('PROJECT_MISMATCH', '讨论关联项目与整理目标不一致')
  }
  const project = projectId ? getResearchProject(db, projectId) : null
  if (projectId && !project) throw new ResearchDiscussionError('NOT_FOUND', '目标研究项目不存在')
  const messageStartIndex = context.summarized_through_message_index == null
    ? 0
    : Math.min(context.summarized_through_message_index + 1, input.throughMessageIndex)
  const selectedMessages = messages.slice(messageStartIndex, input.throughMessageIndex + 1)
  const baseSnapshotId = input.baseSnapshotId === undefined ? context.base_snapshot_id : input.baseSnapshotId
  const key = createHash('sha256').update(JSON.stringify({
    sessionId: input.sessionId,
    messageStartIndex,
    messageEndIndex: input.throughMessageIndex,
    contextHash: context.origin_content_hash,
    projectId,
    baseSnapshotId,
    provider: session.provider,
    model: session.model,
    ruleVersion: RULE_VERSION,
  })).digest('hex')
  const existing = getCandidateBatchByIdempotencyKey(db, key)
  if (existing) {
    const existingSets = listChangeSets(db, { batchId: existing.id, limit: 100 }).items
    return {
      batch: candidateBatchSummary(existing),
      changeSets: existingSets.map(changeSetSummary),
      noMaterialChange: false,
      summary: '已返回相同消息范围的整理结果。',
      degradedReasons: safeJson(existing.degraded_reasons_json, []),
    }
  }
  let result: AIFallbackResult
  try {
    result = await callAI(db, {
      prompt: buildPrompt({
        context: safeJson(context.context_snapshot_json, {}),
        messages: selectedMessages,
        project,
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'AI_NOT_CONFIGURED') {
      throw new ResearchDiscussionError('AI_NOT_CONFIGURED', '尚未配置可用 AI 模型')
    }
    throw new ResearchDiscussionError('GENERATION_FAILED', error instanceof Error ? error.message : '整理讨论失败')
  }
  const parsed = extractJson(result.text)
  const normalized = Array.isArray(parsed.changeSets)
    ? capChangeSets(parsed.changeSets.map((item, index) => normalizeChangeSet(item as ModelChangeSet, index)).filter((item): item is PreparedChangeSetInput => Boolean(item)))
    : []
  if (parsed.noMaterialChange === true || normalized.length === 0) {
    updateResearchDiscussionProgress(db, input.sessionId, {
      summarizedThroughMessageIndex: input.throughMessageIndex,
      degradedReason: null,
    })
    return {
      batch: null,
      changeSets: [],
      noMaterialChange: true,
      summary: text(parsed.summary, '本次讨论没有需要写入产业研究的实质变化。', 1000),
      degradedReasons: [],
    }
  }
  const batch = savePreparedCandidateBatch(db, {
    id: randomUUID(),
    requestId: input.requestId,
    idempotencyKey: key,
    sourceType: 'discussion',
    sourceSessionId: input.sessionId,
    projectId: projectId ?? null,
    baseSnapshotId: baseSnapshotId ?? null,
    messageStartIndex,
    messageEndIndex: input.throughMessageIndex,
    contextHash: context.origin_content_hash,
    provider: result.provider,
    model: result.model,
    ruleVersion: RULE_VERSION,
    changeSets: normalized,
  })
  updateResearchDiscussionProgress(db, input.sessionId, {
    status: 'changes_ready',
    projectId: projectId ?? null,
    baseSnapshotId: baseSnapshotId ?? null,
    summarizedThroughMessageIndex: input.throughMessageIndex,
    latestBatchId: batch.id,
    degradedReason: null,
  })
  return {
    batch: candidateBatchSummary(batch),
    changeSets: listChangeSets(db, { batchId: batch.id, limit: 100 }).items.map(changeSetSummary),
    noMaterialChange: false,
    summary: text(parsed.summary, `已整理为 ${normalized.length} 个研究变更包。`, 1000),
    degradedReasons: [],
  }
}
