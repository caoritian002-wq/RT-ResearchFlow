import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import {
  appendResearchAccessAudit,
  authenticateResearchAccessProfile,
  countResearchAccessAuditsSince,
  hasResearchAccessAuditRequest,
  markResearchAccessProfileUsed,
  type ResearchAccessProfile,
  type ResearchAccessScope,
  type ResearchAccessSurface,
} from '../database/researchAccessRepository'
import {
  executeResearchFactToolUnsafe,
  RESEARCH_FACT_TOOL_DEFINITIONS,
  type ResearchFactToolDefinition,
  type ResearchFactToolId,
} from './researchFactToolRegistry'

export const RESEARCH_ACCESS_MAX_INPUT_BYTES = 16 * 1024
export const RESEARCH_ACCESS_MAX_RESULT_BYTES = 256 * 1024
export const RESEARCH_ACCESS_MAX_CONCURRENT = 2
export const RESEARCH_ACCESS_RATE_PER_MINUTE = 30
export const RESEARCH_ACCESS_RATE_PER_HOUR = 300

const EXTERNAL_TOOL_DEFINITIONS: ReadonlyMap<string, ResearchFactToolDefinition> = new Map(
  RESEARCH_FACT_TOOL_DEFINITIONS.map((definition) => (
    [definition.externalName, definition] as [string, ResearchFactToolDefinition]
  )),
)
const activeCalls = new Map<string, number>()
type ResearchAccessToolEnvelope = ReturnType<typeof executeResearchFactToolUnsafe>

export interface ResearchAccessExposedTool {
  name: string
  title: string
  description: string
  inputSchema: ResearchFactToolDefinition['inputSchema']
  toolId: ResearchFactToolId
  scope: ResearchAccessScope
}

export interface ResearchAccessGatewayError {
  code:
    | 'UNAUTHORIZED'
    | 'SCOPE_DENIED'
    | 'UNKNOWN_TOOL'
    | 'INVALID_INPUT'
    | 'FUTURE_AS_OF'
    | 'RATE_LIMITED'
    | 'TOO_MANY_CONCURRENT_CALLS'
    | 'INPUT_TOO_LARGE'
    | 'RESULT_TOO_LARGE'
    | 'DUPLICATE_REQUEST'
    | 'INTERNAL_ERROR'
  message: string
}

export type ResearchAccessGatewayResult =
  | {
      ok: true
      requestId: string
      externalToolName: string
      toolId: ResearchFactToolId
      envelope: ResearchAccessToolEnvelope
    }
  | {
      ok: false
      requestId: string
      externalToolName: string | null
      toolId: ResearchFactToolId | null
      error: ResearchAccessGatewayError
      envelope?: ResearchAccessToolEnvelope
    }

export interface ResearchAccessCaller {
  profileId: string
  credential: string
  surface: ResearchAccessSurface
  sessionId?: string | null
}

export function listAuthorizedResearchAccessTools(
  db: Database.Database,
  caller: ResearchAccessCaller,
): { ok: true; profile: ResearchAccessProfile; tools: ResearchAccessExposedTool[] }
  | { ok: false; error: ResearchAccessGatewayError } {
  const profile = authenticateResearchAccessProfile(db, caller.profileId, caller.credential)
  if (!profile) return { ok: false, error: gatewayError('UNAUTHORIZED') }
  markResearchAccessProfileUsed(db, profile.id, Date.now())
  return { ok: true, profile, tools: toolsForScopes(profile.scopes) }
}

export function executeResearchAccessTool(
  db: Database.Database,
  caller: ResearchAccessCaller,
  request: {
    requestId?: string
    externalToolName: string
    input: unknown
  },
  options: { now?: number } = {},
): ResearchAccessGatewayResult {
  const startedAt = options.now ?? Date.now()
  const durationStartedAt = Date.now()
  const requestId = request.requestId ?? randomUUID()
  const profile = authenticateResearchAccessProfile(db, caller.profileId, caller.credential)
  if (!profile) {
    const result = failure(requestId, request.externalToolName, null, 'UNAUTHORIZED')
    if (!hasResearchAccessAuditRequest(db, requestId)) {
      writeAudit(db, {
        requestId, caller, request, result, profile: null, startedAt, durationStartedAt,
        decision: 'blocked', input: request.input,
      })
    }
    return result
  }
  if (hasResearchAccessAuditRequest(db, requestId)) {
    return failure(requestId, request.externalToolName, null, 'DUPLICATE_REQUEST')
  }

  const definition = EXTERNAL_TOOL_DEFINITIONS.get(request.externalToolName)
  if (!definition) {
    const result = failure(requestId, request.externalToolName, null, 'UNKNOWN_TOOL')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  }
  if (!profile.scopes.includes(definition.scope)) {
    const result = failure(requestId, request.externalToolName, definition.id, 'SCOPE_DENIED')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  }

  const encodedInput = safeJson(request.input)
  if (encodedInput == null || !isRecord(request.input)) {
    const result = failure(requestId, request.externalToolName, definition.id, 'INVALID_INPUT')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  }
  if (Buffer.byteLength(encodedInput, 'utf8') > RESEARCH_ACCESS_MAX_INPUT_BYTES) {
    const result = failure(requestId, request.externalToolName, definition.id, 'INPUT_TOO_LARGE')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  }
  if (isFutureAsOf(request.input.asOf, startedAt)) {
    const result = failure(requestId, request.externalToolName, definition.id, 'FUTURE_AS_OF')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  }

  const minuteCount = countResearchAccessAuditsSince(db, profile.id, startedAt - 60_000)
  const hourCount = countResearchAccessAuditsSince(db, profile.id, startedAt - 60 * 60_000)
  if (minuteCount >= RESEARCH_ACCESS_RATE_PER_MINUTE || hourCount >= RESEARCH_ACCESS_RATE_PER_HOUR) {
    const result = failure(requestId, request.externalToolName, definition.id, 'RATE_LIMITED')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  }

  const active = activeCalls.get(profile.id) ?? 0
  if (active >= RESEARCH_ACCESS_MAX_CONCURRENT) {
    const result = failure(requestId, request.externalToolName, definition.id, 'TOO_MANY_CONCURRENT_CALLS')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  }

  activeCalls.set(profile.id, active + 1)
  try {
    const envelope = executeResearchFactToolUnsafe(db, definition.id, request.input, { now: startedAt })
    const encodedResult = safeJson(envelope)
    if (encodedResult == null || Buffer.byteLength(encodedResult, 'utf8') > RESEARCH_ACCESS_MAX_RESULT_BYTES) {
      const result = failure(requestId, request.externalToolName, definition.id, 'RESULT_TOO_LARGE')
      writeAudit(db, {
        requestId, caller, request, result, profile, startedAt, durationStartedAt,
        decision: 'blocked', input: request.input,
      })
      return result
    }
    const blocked = envelope.status === 'blocked'
    const result: ResearchAccessGatewayResult = blocked
      ? {
          ok: false,
          requestId,
          externalToolName: request.externalToolName,
          toolId: definition.id,
          error: {
            code: 'INVALID_INPUT',
            message: envelope.warnings[0] ?? '工具输入未通过校验',
          },
          envelope,
        }
      : {
          ok: true,
          requestId,
          externalToolName: request.externalToolName,
          toolId: definition.id,
          envelope,
        }
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: blocked ? 'blocked' : 'allowed', input: request.input,
      encodedResult,
    })
    markResearchAccessProfileUsed(db, profile.id, startedAt)
    return result
  } catch {
    const result = failure(requestId, request.externalToolName, definition.id, 'INTERNAL_ERROR')
    writeAudit(db, {
      requestId, caller, request, result, profile, startedAt, durationStartedAt,
      decision: 'blocked', input: request.input,
    })
    return result
  } finally {
    const remaining = (activeCalls.get(profile.id) ?? 1) - 1
    if (remaining <= 0) activeCalls.delete(profile.id)
    else activeCalls.set(profile.id, remaining)
  }
}

export function toolsForScopes(scopes: ResearchAccessScope[]): ResearchAccessExposedTool[] {
  return RESEARCH_FACT_TOOL_DEFINITIONS
    .filter((definition) => scopes.includes(definition.scope))
    .map((definition) => ({
      name: definition.externalName,
      title: definition.description,
      description: definition.description,
      inputSchema: definition.inputSchema,
      toolId: definition.id,
      scope: definition.scope,
    }))
}

function failure(
  requestId: string,
  externalToolName: string | null,
  toolId: ResearchFactToolId | null,
  code: ResearchAccessGatewayError['code'],
): ResearchAccessGatewayResult {
  return { ok: false, requestId, externalToolName, toolId, error: gatewayError(code) }
}

function gatewayError(code: ResearchAccessGatewayError['code']): ResearchAccessGatewayError {
  const messages: Record<ResearchAccessGatewayError['code'], string> = {
    UNAUTHORIZED: '访问凭据无效或配置不可用',
    SCOPE_DENIED: '当前访问配置未授权该工具',
    UNKNOWN_TOOL: '未知本机研究工具',
    INVALID_INPUT: '工具输入未通过白名单校验',
    FUTURE_AS_OF: '事实截点不能晚于北京时间当天',
    RATE_LIMITED: '调用频率超过当前访问配置上限',
    TOO_MANY_CONCURRENT_CALLS: '当前访问配置的并发调用已达上限',
    INPUT_TOO_LARGE: '工具输入超过16 KiB上限',
    RESULT_TOO_LARGE: '工具结果超过256 KiB上限',
    DUPLICATE_REQUEST: 'requestId已经使用',
    INTERNAL_ERROR: '本机研究工具执行失败',
  }
  return { code, message: messages[code] }
}

function writeAudit(
  db: Database.Database,
  context: {
    requestId: string
    caller: ResearchAccessCaller
    request: { externalToolName: string }
    result: ResearchAccessGatewayResult
    profile: ResearchAccessProfile | null
    startedAt: number
    durationStartedAt: number
    decision: 'allowed' | 'blocked'
    input: unknown
    encodedResult?: string
  },
): void {
  const definition = EXTERNAL_TOOL_DEFINITIONS.get(context.request.externalToolName)
  const inputText = safeJson(context.input)
  const encodedResult = context.encodedResult ?? null
  appendResearchAccessAudit(db, {
    requestId: context.requestId,
    sessionId: context.caller.sessionId ?? null,
    profileId: context.profile?.id ?? null,
    profileNameSnapshot: context.profile?.name ?? null,
    surface: context.caller.surface,
    externalToolName: context.request.externalToolName || null,
    toolId: context.result.toolId,
    inputSha256: inputText == null ? null : sha256(inputText),
    inputSummaryJson: safeInputSummary(definition?.id ?? null, context.input),
    asOf: normalizedAsOf(isRecord(context.input) ? context.input.asOf : null),
    decision: context.decision,
    scopeVersion: context.profile?.scopeVersion ?? null,
    toolStatus: context.result.ok ? context.result.envelope.status : context.result.envelope?.status ?? 'blocked',
    errorCode: context.result.ok ? null : context.result.error.code,
    durationMs: Math.max(0, Date.now() - context.durationStartedAt),
    resultBytes: encodedResult == null ? 0 : Buffer.byteLength(encodedResult, 'utf8'),
    resultSha256: encodedResult == null ? null : sha256(encodedResult),
    createdAt: context.startedAt,
  })
}

function safeInputSummary(toolId: ResearchFactToolId | null, input: unknown): string | null {
  if (!toolId || !isRecord(input)) return null
  const summary: Record<string, unknown> = {}
  for (const key of ['stockCode', 'asOf', 'limit', 'minBars', 'financialLimit', 'attentionOnly', 'impactRating']) {
    if (input[key] != null) summary[key] = input[key]
  }
  if (typeof input.query === 'string') {
    summary.query = { length: input.query.length, sha256: sha256(input.query) }
  }
  if (typeof input.judgmentId === 'string') summary.judgmentIdSha256 = sha256(input.judgmentId)
  if (typeof input.projectId === 'string') summary.projectIdSha256 = sha256(input.projectId)
  return JSON.stringify(summary)
}

function isFutureAsOf(value: unknown, now: number): boolean {
  const asOf = normalizedAsOf(value)
  return asOf != null && asOf > beijingDate(now)
}

function normalizedAsOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.trim().replace(/-/g, '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function beijingDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

function safeJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
