import type Database from 'better-sqlite3'
import { ipcMain } from 'electron'
import { getSession, type ConversationMessage } from '../database/aiAnalysisSessionRepository'
import { getDb } from '../database/db'
import { getResearchDiscussionContext } from '../database/researchDiscussionRepository'
import { getResearchProject } from '../database/industryResearchRepository'
import {
  compareResearchEvidenceSnapshot,
  prepareResearchEvidenceComparison,
  ResearchEvidenceDeltaError,
  type ResearchEvidenceDeltaView,
} from '../services/researchEvidenceDeltaService'
import {
  getDiscussionResearchAuditContext,
  ResearchDiscussionError,
  startResearchEvidenceDiscussion,
  type ResearchDiscussionReturnTarget,
  type ResearchEvidenceDiscussionSource,
} from '../services/researchDiscussionContextService'
import { getGenerationResearchAuditComparisonContext } from '../services/industryResearchGenerationService'
import { getResearchAgentAuditContext } from '../services/researchAgentRunManager'

const ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/

export type ResearchEvidenceCompareRequest =
  | { sourceKind: 'discussion_message'; sessionId: number; messageIndex: number }
  | { sourceKind: 'industry_report'; projectId: string; runId: string }

export type ResearchEvidenceCompareResponse =
  | { ok: true; data: ResearchEvidenceDeltaView }
  | { ok: false; code: string; message: string }

export type ResearchEvidenceStartDiscussionRequest = ResearchEvidenceDiscussionSource & {
  requestId: string
  returnTarget: ResearchDiscussionReturnTarget
}

export type ResearchEvidenceStartDiscussionResponse =
  | {
      ok: true
      data: {
        discussion: ReturnType<typeof startResearchEvidenceDiscussion>['discussion']
        contextPreview: ReturnType<typeof startResearchEvidenceDiscussion>['contextPreview']
        resumed: boolean
        initialQuestion: string | null
      }
    }
  | { ok: false; code: string; message: string }

class ResearchEvidenceRequestError extends Error {
  constructor(public readonly code: 'INVALID_PARAM' | 'NOT_FOUND' | 'TRACE_UNAVAILABLE', message: string) {
    super(message)
  }
}

export function registerResearchEvidenceHandlers(): void {
  ipcMain.handle('researchEvidence:compareSnapshot', (_event, payload: unknown): ResearchEvidenceCompareResponse => {
    try {
      return { ok: true, data: compareResearchEvidenceRequest(getDb(), payload) }
    } catch (error) {
      if (error instanceof ResearchEvidenceRequestError || error instanceof ResearchEvidenceDeltaError) {
        return { ok: false, code: error.code, message: error.message }
      }
      console.error('[researchEvidence:compareSnapshot]', error instanceof Error ? error.message : 'unknown')
      return { ok: false, code: 'DB_ERROR', message: '读取当前本地事实失败' }
    }
  })
  ipcMain.handle('researchEvidence:startDiscussion', (_event, payload: unknown): ResearchEvidenceStartDiscussionResponse => {
    try {
      return { ok: true, data: startResearchEvidenceDiscussionRequest(getDb(), payload) }
    } catch (error) {
      if (
        error instanceof ResearchEvidenceRequestError
        || error instanceof ResearchEvidenceDeltaError
        || error instanceof ResearchDiscussionError
      ) {
        return { ok: false, code: error.code, message: error.message }
      }
      console.error('[researchEvidence:startDiscussion]', error instanceof Error ? error.message : 'unknown')
      return { ok: false, code: 'DB_ERROR', message: '创建事实变化讨论失败' }
    }
  })
}

export function compareResearchEvidenceRequest(
  db: Database.Database,
  payload: unknown,
  options: { now?: number } = {},
): ResearchEvidenceDeltaView {
  const source = parseResearchEvidenceSource(payload, false)
  return compareResearchEvidenceSnapshot(db, resolveResearchEvidenceSource(db, source).comparisonInput, options)
}

export function startResearchEvidenceDiscussionRequest(
  db: Database.Database,
  payload: unknown,
  options: { now?: number } = {},
) {
  const parsed = parseResearchEvidenceSource(payload, true)
  if (!isRecord(payload)) throw new ResearchEvidenceRequestError('INVALID_PARAM', '请求必须是对象')
  const requestId = uuid(payload.requestId, 'requestId')
  const returnTarget = parseReturnTarget(payload.returnTarget)
  const resolved = resolveResearchEvidenceSource(db, parsed)
  const comparison = prepareResearchEvidenceComparison(db, resolved.comparisonInput, options)
  const result = startResearchEvidenceDiscussion(db, {
    requestId,
    source: parsed,
    origin: resolved.origin,
    comparison,
    returnTarget,
  })
  return {
    discussion: result.discussion,
    contextPreview: result.contextPreview,
    resumed: result.resumed,
    initialQuestion: result.initialQuestion,
  }
}

function parseResearchEvidenceSource(payload: unknown, forDiscussion: boolean): ResearchEvidenceDiscussionSource {
  if (!isRecord(payload)) throw new ResearchEvidenceRequestError('INVALID_PARAM', '请求必须是对象')
  const commonKeys = forDiscussion ? ['requestId', 'returnTarget'] : []
  if (payload.sourceKind === 'discussion_message') {
    requireExactKeys(payload, ['sourceKind', 'sessionId', 'messageIndex', ...commonKeys])
    return {
      sourceKind: 'discussion_message',
      sessionId: positiveInteger(payload.sessionId, 'sessionId'),
      messageIndex: nonNegativeInteger(payload.messageIndex, 'messageIndex'),
    }
  }
  if (payload.sourceKind === 'industry_report') {
    requireExactKeys(payload, ['sourceKind', 'projectId', 'runId', ...commonKeys])
    return {
      sourceKind: 'industry_report',
      projectId: boundedId(payload.projectId, 'projectId'),
      runId: boundedId(payload.runId, 'runId'),
    }
  }
  throw new ResearchEvidenceRequestError('INVALID_PARAM', 'sourceKind不受支持')
}

function resolveResearchEvidenceSource(db: Database.Database, source: ResearchEvidenceDiscussionSource) {
  if (source.sourceKind === 'discussion_message') {
    const session = getSession(db, source.sessionId)
    if (!session) throw new ResearchEvidenceRequestError('NOT_FOUND', '研究讨论不存在')
    const discussion = getResearchDiscussionContext(db, source.sessionId)
    if (!discussion) throw new ResearchEvidenceRequestError('TRACE_UNAVAILABLE', '该消息不属于研究讨论')
    const messages = parseMessages(session.messages)
    const message = messages[source.messageIndex]
    if (!message) throw new ResearchEvidenceRequestError('NOT_FOUND', '讨论消息不存在')
    if (message.role !== 'assistant' || !message.researchAudit) {
      throw new ResearchEvidenceRequestError('TRACE_UNAVAILABLE', '该消息没有可用于对比的研究审计')
    }
    const agentAudit = message.researchAgentRunId
      ? getResearchAgentAuditContext(db, message.researchAgentRunId)
      : null
    const auditContext = getDiscussionResearchAuditContext(db, source.sessionId)
    if (!agentAudit && !auditContext) throw new ResearchEvidenceRequestError('TRACE_UNAVAILABLE', '该讨论没有可用于对比的历史证据快照')
    return {
      comparisonInput: {
        audit: message.researchAudit,
        evidenceContrast: agentAudit?.evidenceContrast ?? auditContext!.evidenceContrast,
        documentText: message.content,
      },
      origin: {
        type: discussion.origin_type,
        id: discussion.origin_id,
        title: discussion.origin_title,
        occurredAt: discussion.origin_occurred_at,
        sourceUrl: null,
        projectId: discussion.project_id,
      },
    }
  }
  const context = getGenerationResearchAuditComparisonContext(db, source.projectId, source.runId)
  if (!context) throw new ResearchEvidenceRequestError('NOT_FOUND', '产业研究运行不存在')
  const project = getResearchProject(db, source.projectId)
  if (!project) throw new ResearchEvidenceRequestError('NOT_FOUND', '产业研究项目不存在')
  return {
    comparisonInput: context,
    origin: {
      type: 'industry_research' as const,
      id: project.id,
      title: project.title,
      occurredAt: project.updated_at,
      sourceUrl: null,
      projectId: project.id,
    },
  }
}

function parseMessages(value: string | null): ConversationMessage[] {
  if (!value) throw new ResearchEvidenceRequestError('TRACE_UNAVAILABLE', '该讨论没有消息记录')
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.length > 500) throw new Error('invalid messages')
    return parsed as ConversationMessage[]
  } catch {
    throw new ResearchEvidenceRequestError('TRACE_UNAVAILABLE', '讨论消息记录损坏，无法校验历史审计')
  }
}

function requireExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key))
  if (unknown.length > 0) {
    throw new ResearchEvidenceRequestError('INVALID_PARAM', `包含不支持的字段：${unknown.join('、')}`)
  }
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ResearchEvidenceRequestError('INVALID_PARAM', `${name}必须是正整数`)
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ResearchEvidenceRequestError('INVALID_PARAM', `${name}必须是非负整数`)
  }
  return Number(value)
}

function boundedId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ResearchEvidenceRequestError('INVALID_PARAM', `${name}格式无效`)
  }
  return value
}

function uuid(value: unknown, name: string): string {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new ResearchEvidenceRequestError('INVALID_PARAM', `${name}格式无效`)
  }
  return value
}

function parseReturnTarget(value: unknown): ResearchDiscussionReturnTarget {
  if (!isRecord(value)) throw new ResearchEvidenceRequestError('INVALID_PARAM', 'returnTarget格式无效')
  requireExactKeys(value, ['tab', 'subTab', 'entityId', 'stateKey', 'scrollTop'])
  if (typeof value.tab !== 'string' || !value.tab.trim() || value.tab.length > 80) {
    throw new ResearchEvidenceRequestError('INVALID_PARAM', 'returnTarget.tab格式无效')
  }
  const optionalString = (field: 'subTab' | 'entityId' | 'stateKey', max: number): string | undefined => {
    const current = value[field]
    if (current == null) return undefined
    if (typeof current !== 'string' || current.length > max) {
      throw new ResearchEvidenceRequestError('INVALID_PARAM', `returnTarget.${field}格式无效`)
    }
    return current
  }
  if (
    value.scrollTop != null
    && (typeof value.scrollTop !== 'number' || !Number.isFinite(value.scrollTop) || value.scrollTop < 0)
  ) {
    throw new ResearchEvidenceRequestError('INVALID_PARAM', 'returnTarget.scrollTop格式无效')
  }
  return {
    tab: value.tab.trim(),
    subTab: optionalString('subTab', 80),
    entityId: optionalString('entityId', 128),
    stateKey: optionalString('stateKey', 128),
    scrollTop: typeof value.scrollTop === 'number'
      ? Math.min(10_000_000, Math.trunc(value.scrollTop))
      : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
