import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import type {
  ResearchAgentModelCallRow,
  ResearchAgentModelCallStatus,
  ResearchAgentRunOutcome,
  ResearchAgentRunPhase,
  ResearchAgentRunKind,
  ResearchAgentRunRow,
  ResearchAgentRunStatus,
  ResearchAgentStepRow,
  ResearchAgentStepStatus,
  ResearchAgentToolCallRow,
  ResearchAgentToolCallStatus,
  ResearchAgentUsageStatus,
} from './types'

export interface ResearchAgentBudget {
  id: 'single-agent-standard-v1' | 'single-agent-continuous-v2' | 'single-agent-unrestricted-v3' | 'multi-perspective-standard-v1' | 'multi-perspective-unrestricted-v2'
  maxModelCalls: number | null
  maxToolCalls: number | null
  maxToolDecisionRounds: number | null
  maxToolsPerDecision: number
  maxModelInputBytes: number
  maxIntermediateOutputTokens: number | null
  maxFinalOutputTokens: number | null
  maxToolResultBytes: number
  maxToolProjectionBytes: number
  maxRunToolResultBytes: number
  maxReportCharacters: number | null
  maxModelCallDurationMs: number | null
  maxToolCallDurationMs: number
  maxNetworkToolCallDurationMs: number
  maxDurationMs: number | null
}

export const RESEARCH_AGENT_JSON_LIMITS = Object.freeze({
  contextSnapshot: 512 * 1024,
  subjects: 32 * 1024,
  budget: 32 * 1024,
  stepInput: 128 * 1024,
  stepArtifact: 256 * 1024,
  toolInput: 64 * 1024,
  toolEnvelope: 256 * 1024,
  toolProjection: 24 * 1024,
  toolMetadata: 64 * 1024,
  modelInput: 96 * 1024,
  priceSnapshot: 32 * 1024,
})

export const RESEARCH_AGENT_LEGACY_BUDGET = Object.freeze({
  id: 'single-agent-standard-v1',
  maxModelCalls: 6,
  maxToolCalls: 8,
  maxToolDecisionRounds: 4,
  maxToolsPerDecision: 2,
  maxModelInputBytes: RESEARCH_AGENT_JSON_LIMITS.modelInput,
  maxIntermediateOutputTokens: 2_048,
  maxFinalOutputTokens: 8_192,
  maxToolResultBytes: RESEARCH_AGENT_JSON_LIMITS.toolEnvelope,
  maxToolProjectionBytes: RESEARCH_AGENT_JSON_LIMITS.toolProjection,
  maxRunToolResultBytes: 2 * 1024 * 1024,
  maxReportCharacters: 60_000,
  maxModelCallDurationMs: 120_000,
  maxToolCallDurationMs: 10_000,
  maxNetworkToolCallDurationMs: 30_000,
  maxDurationMs: 20 * 60 * 1000,
} as const satisfies ResearchAgentBudget)

export const RESEARCH_AGENT_CONTINUOUS_BUDGET_V2 = Object.freeze({
  id: 'single-agent-continuous-v2',
  maxModelCalls: null,
  maxToolCalls: null,
  maxToolDecisionRounds: null,
  maxToolsPerDecision: 2,
  maxModelInputBytes: RESEARCH_AGENT_JSON_LIMITS.modelInput,
  maxIntermediateOutputTokens: 2_048,
  maxFinalOutputTokens: 8_192,
  maxToolResultBytes: RESEARCH_AGENT_JSON_LIMITS.toolEnvelope,
  maxToolProjectionBytes: RESEARCH_AGENT_JSON_LIMITS.toolProjection,
  maxRunToolResultBytes: 16 * 1024 * 1024,
  maxReportCharacters: 60_000,
  maxModelCallDurationMs: 120_000,
  maxToolCallDurationMs: 10_000,
  maxNetworkToolCallDurationMs: 120_000,
  maxDurationMs: 60 * 60 * 1000,
} as const satisfies ResearchAgentBudget)

export const RESEARCH_AGENT_STANDARD_BUDGET = Object.freeze({
  id: 'single-agent-unrestricted-v3',
  maxModelCalls: null,
  maxToolCalls: null,
  maxToolDecisionRounds: null,
  maxToolsPerDecision: 2,
  maxModelInputBytes: RESEARCH_AGENT_JSON_LIMITS.modelInput,
  maxIntermediateOutputTokens: null,
  maxFinalOutputTokens: null,
  maxToolResultBytes: RESEARCH_AGENT_JSON_LIMITS.toolEnvelope,
  maxToolProjectionBytes: RESEARCH_AGENT_JSON_LIMITS.toolProjection,
  maxRunToolResultBytes: 16 * 1024 * 1024,
  maxReportCharacters: null,
  maxModelCallDurationMs: null,
  maxToolCallDurationMs: 10_000,
  maxNetworkToolCallDurationMs: 120_000,
  maxDurationMs: null,
} as const satisfies ResearchAgentBudget)

// Runs created before the large-response fix keep their original 30-second network timeout.
export const RESEARCH_AGENT_CONTINUOUS_BUDGET_V2_INITIAL = Object.freeze({
  id: 'single-agent-continuous-v2',
  maxModelCalls: null,
  maxToolCalls: null,
  maxToolDecisionRounds: null,
  maxToolsPerDecision: 2,
  maxModelInputBytes: 96 * 1024,
  maxIntermediateOutputTokens: 2_048,
  maxFinalOutputTokens: 8_192,
  maxToolResultBytes: 256 * 1024,
  maxToolProjectionBytes: 24 * 1024,
  maxRunToolResultBytes: 16 * 1024 * 1024,
  maxReportCharacters: 60_000,
  maxModelCallDurationMs: 120_000,
  maxToolCallDurationMs: 10_000,
  maxNetworkToolCallDurationMs: 30_000,
  maxDurationMs: 60 * 60 * 1000,
} as const satisfies ResearchAgentBudget)

export const RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET = Object.freeze({
  id: 'multi-perspective-standard-v1',
  maxModelCalls: 3,
  maxToolCalls: 0,
  maxToolDecisionRounds: 0,
  maxToolsPerDecision: 0,
  maxModelInputBytes: RESEARCH_AGENT_JSON_LIMITS.modelInput,
  maxIntermediateOutputTokens: 4_096,
  maxFinalOutputTokens: 6_144,
  maxToolResultBytes: RESEARCH_AGENT_JSON_LIMITS.toolEnvelope,
  maxToolProjectionBytes: RESEARCH_AGENT_JSON_LIMITS.toolProjection,
  maxRunToolResultBytes: 0,
  maxReportCharacters: 60_000,
  maxModelCallDurationMs: 120_000,
  maxToolCallDurationMs: 0,
  maxNetworkToolCallDurationMs: 0,
  maxDurationMs: 15 * 60 * 1000,
} as const satisfies ResearchAgentBudget)

export const RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET = Object.freeze({
  id: 'multi-perspective-unrestricted-v2',
  maxModelCalls: null,
  maxToolCalls: 0,
  maxToolDecisionRounds: 0,
  maxToolsPerDecision: 0,
  maxModelInputBytes: RESEARCH_AGENT_JSON_LIMITS.modelInput,
  maxIntermediateOutputTokens: null,
  maxFinalOutputTokens: null,
  maxToolResultBytes: RESEARCH_AGENT_JSON_LIMITS.toolEnvelope,
  maxToolProjectionBytes: RESEARCH_AGENT_JSON_LIMITS.toolProjection,
  maxRunToolResultBytes: 0,
  maxReportCharacters: null,
  maxModelCallDurationMs: null,
  maxToolCallDurationMs: 0,
  maxNetworkToolCallDurationMs: 0,
  maxDurationMs: null,
} as const satisfies ResearchAgentBudget)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const AS_OF_PATTERN = /^\d{8}$/
const PHASES: readonly ResearchAgentRunPhase[] = ['planning', 'tooling', 'synthesis', 'audit', 'persist']

const RUN_TRANSITIONS: Readonly<Record<ResearchAgentRunStatus, readonly ResearchAgentRunStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'needs_attention', 'succeeded', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  needs_attention: ['cancelled'],
  succeeded: [],
  failed: ['running', 'cancelled'],
  cancelled: [],
}

const STEP_TRANSITIONS: Readonly<Record<ResearchAgentStepStatus, readonly ResearchAgentStepStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: ['running', 'cancelled'],
  cancelled: [],
}

const TOOL_CALL_TRANSITIONS: Readonly<Record<ResearchAgentToolCallStatus, readonly ResearchAgentToolCallStatus[]>> = {
  prepared: ['running', 'submitted', 'blocked', 'cancelled'],
  running: ['succeeded', 'failed', 'blocked', 'cancelled'],
  submitted: ['succeeded', 'failed', 'blocked', 'outcome_unknown', 'cancelled'],
  succeeded: [],
  failed: [],
  blocked: [],
  outcome_unknown: [],
  cancelled: [],
}

const MODEL_CALL_TRANSITIONS: Readonly<Record<ResearchAgentModelCallStatus, readonly ResearchAgentModelCallStatus[]>> = {
  prepared: ['submitted', 'safe_failed', 'cancelled'],
  submitted: ['succeeded', 'outcome_unknown', 'cancelled'],
  succeeded: [],
  safe_failed: [],
  outcome_unknown: [],
  cancelled: [],
}

export class ResearchAgentRunRepositoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ResearchAgentRunRepositoryError'
  }
}

export interface StartResearchAgentRunInput {
  requestId: string
  id?: string
  runKind?: ResearchAgentRunKind
  parentRunId?: string | null
  discussionSessionId?: number | null
  question: string
  contextSnapshot: unknown
  contextSnapshotSha256?: string
  subjects: readonly unknown[]
  includePortfolio: boolean
  asOf: string
  provider: string
  model: string
  modelConfigFingerprint: string
  promptRuleVersion: string
  toolRegistryVersion: string
  budget?: Readonly<ResearchAgentBudget>
  now?: number
}

export interface StartResearchAgentRunResult {
  run: ResearchAgentRunRow
  replayed: boolean
}

export interface ResearchAgentRunLedger {
  run: ResearchAgentRunRow
  steps: ResearchAgentStepRow[]
  toolCalls: ResearchAgentToolCallRow[]
  modelCalls: ResearchAgentModelCallRow[]
}

export function canTransitionResearchAgentRunStatus(
  from: ResearchAgentRunStatus,
  to: ResearchAgentRunStatus,
): boolean {
  return RUN_TRANSITIONS[from].includes(to)
}

export function canTransitionResearchAgentStepStatus(
  from: ResearchAgentStepStatus,
  to: ResearchAgentStepStatus,
): boolean {
  return STEP_TRANSITIONS[from].includes(to)
}

export function canTransitionResearchAgentToolCallStatus(
  from: ResearchAgentToolCallStatus,
  to: ResearchAgentToolCallStatus,
): boolean {
  return TOOL_CALL_TRANSITIONS[from].includes(to)
}

export function canTransitionResearchAgentModelCallStatus(
  from: ResearchAgentModelCallStatus,
  to: ResearchAgentModelCallStatus,
): boolean {
  return MODEL_CALL_TRANSITIONS[from].includes(to)
}

export function hashResearchAgentText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function serializeResearchAgentJson(
  value: unknown,
  maxBytes: number,
  expectedSha256?: string,
): { json: string; sha256: string; bytes: number } {
  if (value == null || typeof value !== 'object') {
    throw new ResearchAgentRunRepositoryError('INVALID_JSON', '研究运行 JSON 必须是对象或数组')
  }
  const json = JSON.stringify(toCanonicalJson(value, new Set<object>()))
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > maxBytes) {
    throw new ResearchAgentRunRepositoryError('JSON_TOO_LARGE', `研究运行 JSON 超过 ${maxBytes} 字节上限`)
  }
  const sha256 = hashResearchAgentText(json)
  if (expectedSha256 != null && expectedSha256 !== sha256) {
    throw new ResearchAgentRunRepositoryError('HASH_MISMATCH', '研究运行 JSON 哈希与内容不一致')
  }
  return { json, sha256, bytes }
}

export function startResearchAgentRun(
  db: Database.Database,
  input: StartResearchAgentRunInput,
): StartResearchAgentRunResult {
  assertUuid(input.requestId, 'requestId')
  const id = input.id ?? randomUUID()
  assertUuid(id, 'runId')
  const runKind = input.runKind ?? 'single_agent'
  const defaultBudget = runKind === 'multi_perspective'
    ? RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET
    : RESEARCH_AGENT_STANDARD_BUDGET
  const budgetInput = input.budget ?? defaultBudget
  const budgetMatchesRunKind = runKind === 'multi_perspective'
    ? budgetInput.id === RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET.id
      || budgetInput.id === RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET.id
    : budgetInput.id === RESEARCH_AGENT_STANDARD_BUDGET.id
      || budgetInput.id === RESEARCH_AGENT_CONTINUOUS_BUDGET_V2.id
      || budgetInput.id === RESEARCH_AGENT_LEGACY_BUDGET.id
  if (!budgetMatchesRunKind) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '运行类型与固定预算版本不匹配')
  }
  if (input.parentRunId != null) assertUuid(input.parentRunId, 'parentRunId')
  const question = input.question.trim()
  if (question.length < 10 || question.length > 4000) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '研究问题必须为 10 至 4000 个字符')
  }
  if (!Array.isArray(input.subjects) || input.subjects.length < 1 || input.subjects.length > 5) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '研究主体必须包含 1 至 5 项')
  }
  assertAsOf(input.asOf)
  assertBoundedText(input.provider, 80, 'provider')
  assertBoundedText(input.model, 160, 'model')
  assertBoundedText(input.promptRuleVersion, 80, 'promptRuleVersion')
  assertBoundedText(input.toolRegistryVersion, 80, 'toolRegistryVersion')
  assertSha256(input.modelConfigFingerprint, 'modelConfigFingerprint')
  const context = serializeResearchAgentJson(
    input.contextSnapshot,
    RESEARCH_AGENT_JSON_LIMITS.contextSnapshot,
    input.contextSnapshotSha256,
  )
  const subjects = serializeResearchAgentJson(input.subjects, RESEARCH_AGENT_JSON_LIMITS.subjects)
  const budget = serializeResearchAgentJson(budgetInput, RESEARCH_AGENT_JSON_LIMITS.budget)
  const fingerprintPayload = serializeResearchAgentJson({
    runKind,
    parentRunId: input.parentRunId ?? null,
    discussionSessionId: input.discussionSessionId ?? null,
    question,
    contextSnapshotSha256: context.sha256,
    subjectsSha256: subjects.sha256,
    includePortfolio: input.includePortfolio,
    asOf: input.asOf,
    provider: input.provider,
    model: input.model,
    modelConfigFingerprint: input.modelConfigFingerprint,
    promptRuleVersion: input.promptRuleVersion,
    toolRegistryVersion: input.toolRegistryVersion,
    budgetSha256: budget.sha256,
  }, RESEARCH_AGENT_JSON_LIMITS.stepInput)

  const existing = getResearchAgentRunByRequestId(db, input.requestId)
  if (existing) {
    if (existing.request_fingerprint !== fingerprintPayload.sha256) {
      throw new ResearchAgentRunRepositoryError('REQUEST_ID_CONFLICT', 'requestId 已用于不同的研究运行输入')
    }
    return { run: existing, replayed: true }
  }
  if (input.parentRunId != null && !getResearchAgentRun(db, input.parentRunId)) {
    throw new ResearchAgentRunRepositoryError('RUN_NOT_FOUND', '父研究运行不存在')
  }

  const now = input.now ?? Date.now()
  db.prepare(`
    INSERT INTO research_agent_runs (
      id, request_id, request_fingerprint, run_kind, parent_run_id, discussion_session_id,
      question, context_snapshot_json, context_snapshot_sha256, subjects_json,
      include_portfolio, as_of, status, phase, provider, model,
      model_config_fingerprint, prompt_rule_version, tool_registry_version,
      budget_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'planning', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.requestId,
    fingerprintPayload.sha256,
    runKind,
    input.parentRunId ?? null,
    input.discussionSessionId ?? null,
    question,
    context.json,
    context.sha256,
    subjects.json,
    Number(input.includePortfolio),
    input.asOf,
    input.provider,
    input.model,
    input.modelConfigFingerprint,
    input.promptRuleVersion,
    input.toolRegistryVersion,
    budget.json,
    now,
    now,
  )
  return { run: requireResearchAgentRun(db, id), replayed: false }
}

export function getResearchAgentRun(
  db: Database.Database,
  runId: string,
): ResearchAgentRunRow | null {
  return (db.prepare('SELECT * FROM research_agent_runs WHERE id = ?').get(runId) as ResearchAgentRunRow | undefined) ?? null
}

export function researchAgentBudgetForRun(run: ResearchAgentRunRow): Readonly<ResearchAgentBudget> {
  let parsed: unknown
  try {
    parsed = JSON.parse(run.budget_json) as unknown
  } catch {
    throw new ResearchAgentRunRepositoryError('INVALID_JSON', '研究运行固定预算损坏')
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { id?: unknown }).id !== 'string') {
    throw new ResearchAgentRunRepositoryError('INVALID_JSON', '研究运行固定预算缺少版本标识')
  }
  const parsedBudget = parsed as { id: string }
  const allowedBudgets: readonly Readonly<ResearchAgentBudget>[] = run.run_kind === 'multi_perspective'
    ? parsedBudget.id === RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET.id
      ? [RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET]
      : parsedBudget.id === RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET.id
        ? [RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET]
        : []
    : parsedBudget.id === RESEARCH_AGENT_LEGACY_BUDGET.id
      ? [RESEARCH_AGENT_LEGACY_BUDGET]
      : parsedBudget.id === RESEARCH_AGENT_CONTINUOUS_BUDGET_V2.id
        ? [RESEARCH_AGENT_CONTINUOUS_BUDGET_V2_INITIAL, RESEARCH_AGENT_CONTINUOUS_BUDGET_V2]
        : parsedBudget.id === RESEARCH_AGENT_STANDARD_BUDGET.id
          ? [RESEARCH_AGENT_STANDARD_BUDGET]
          : []
  if (allowedBudgets.length === 0) {
    throw new ResearchAgentRunRepositoryError('BUDGET_MISMATCH', '研究运行固定预算版本不受支持')
  }
  const actual = serializeResearchAgentJson(parsed, RESEARCH_AGENT_JSON_LIMITS.budget)
  const matched = allowedBudgets.find((budget) => (
    actual.sha256 === serializeResearchAgentJson(budget, RESEARCH_AGENT_JSON_LIMITS.budget).sha256
  ))
  if (!matched) {
    throw new ResearchAgentRunRepositoryError('BUDGET_MISMATCH', '研究运行固定预算与运行类型不匹配')
  }
  return matched
}

export function listResearchAgentRuns(
  db: Database.Database,
  input: { discussionSessionId?: number | null; limit?: number } = {},
): ResearchAgentRunRow[] {
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 30)))
  if (input.discussionSessionId != null) {
    if (!Number.isSafeInteger(input.discussionSessionId) || input.discussionSessionId <= 0) {
      throw new ResearchAgentRunRepositoryError('INVALID_INPUT', 'discussionSessionId 必须是正整数')
    }
    return db.prepare(`
      SELECT * FROM research_agent_runs
      WHERE discussion_session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(input.discussionSessionId, limit) as ResearchAgentRunRow[]
  }
  return db.prepare(`
    SELECT * FROM research_agent_runs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit) as ResearchAgentRunRow[]
}

export function deleteResearchAgentRun(
  db: Database.Database,
  runId: string,
): { deletedRunIds: string[] } {
  assertUuid(runId, 'runId')
  const run = requireResearchAgentRun(db, runId)
  if (['queued', 'running', 'paused'].includes(run.status)) {
    throw new ResearchAgentRunRepositoryError('RUN_ACTIVE', '活动中的研究必须先取消，再执行删除')
  }
  const dependentReview = db.prepare(`
    SELECT id FROM research_agent_runs
    WHERE parent_run_id = ? AND run_kind = 'multi_perspective'
    LIMIT 1
  `).get(runId) as { id: string } | undefined
  if (dependentReview) {
    throw new ResearchAgentRunRepositoryError(
      'DEPENDENT_REVIEW_EXISTS',
      '该研究仍有直接依赖的多视角复核，请先删除复核记录',
    )
  }
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE research_agent_runs
      SET parent_run_id = ?
      WHERE parent_run_id = ? AND run_kind = 'single_agent'
    `).run(run.parent_run_id, runId)
    const result = db.prepare('DELETE FROM research_agent_runs WHERE id = ?').run(runId)
    if (result.changes !== 1) {
      throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', '研究运行删除失败')
    }
  })
  transaction()
  return { deletedRunIds: [runId] }
}

export function getResearchAgentRunLedger(
  db: Database.Database,
  runId: string,
): ResearchAgentRunLedger | null {
  const run = getResearchAgentRun(db, runId)
  if (!run) return null
  const steps = db.prepare(`
    SELECT * FROM research_agent_steps WHERE run_id = ? ORDER BY ordinal, id
  `).all(runId) as ResearchAgentStepRow[]
  const toolCalls = db.prepare(`
    SELECT * FROM research_agent_tool_calls WHERE run_id = ? ORDER BY prepared_at, id
  `).all(runId) as ResearchAgentToolCallRow[]
  const modelCalls = db.prepare(`
    SELECT * FROM research_agent_model_calls WHERE run_id = ? ORDER BY prepared_at, id
  `).all(runId) as ResearchAgentModelCallRow[]
  return { run, steps, toolCalls, modelCalls }
}

export function claimResearchAgentRunLease(
  db: Database.Database,
  input: { runId: string; leaseOwner: string; now: number; ttlMs: number; expectedRevision?: number },
): ResearchAgentRunRow {
  assertUuid(input.runId, 'runId')
  assertBoundedText(input.leaseOwner, 120, 'leaseOwner')
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '租约时长必须为正整数')
  }
  const transaction = db.transaction(() => {
    const current = requireResearchAgentRun(db, input.runId)
    assertRevision(current.revision, input.expectedRevision)
    if (!canTransitionResearchAgentRunStatus(current.status, 'running') || current.cancel_requested === 1) {
      throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `状态 ${current.status} 不允许领取租约`)
    }
    if (current.lease_expires_at != null && current.lease_expires_at > input.now) {
      throw new ResearchAgentRunRepositoryError('RUN_LEASE_CONFLICT', '研究运行租约尚未过期')
    }
    try {
      db.prepare(`
        UPDATE research_agent_runs
        SET status = 'running', lease_owner = ?, lease_expires_at = ?,
            started_at = COALESCE(started_at, ?), completed_at = NULL,
            error_code = NULL, error_message = NULL, retryable = 0,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `).run(input.leaseOwner, input.now + input.ttlMs, input.now, input.now, input.runId, current.revision)
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw new ResearchAgentRunRepositoryError('RUN_LEASE_CONFLICT', '已有其他单 Agent 研究运行正在执行')
      }
      throw error
    }
    return requireResearchAgentRun(db, input.runId)
  })
  return transaction()
}

export function renewResearchAgentRunLease(
  db: Database.Database,
  input: { runId: string; leaseOwner: string; now: number; ttlMs: number; expectedRevision?: number },
): ResearchAgentRunRow {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '租约时长必须为正整数')
  }
  const current = requireResearchAgentRun(db, input.runId)
  assertRevision(current.revision, input.expectedRevision)
  if (
    current.status !== 'running'
    || current.lease_owner !== input.leaseOwner
    || current.lease_expires_at == null
    || current.lease_expires_at <= input.now
  ) {
    throw new ResearchAgentRunRepositoryError('RUN_LEASE_CONFLICT', '研究运行租约无效或不属于当前进程')
  }
  db.prepare(`
    UPDATE research_agent_runs
    SET lease_expires_at = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(input.now + input.ttlMs, input.now, input.runId, current.revision)
  return requireResearchAgentRun(db, input.runId)
}

export function pauseExpiredResearchAgentRuns(
  db: Database.Database,
  input: { now: number },
): { count: number; runIds: string[] } {
  const transaction = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id FROM research_agent_runs
      WHERE status = 'running' AND lease_expires_at <= ?
      ORDER BY id
    `).all(input.now) as Array<{ id: string }>
    if (rows.length > 0) {
      db.prepare(`
        UPDATE research_agent_runs
        SET status = 'paused', lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'LEASE_EXPIRED', error_message = '进程租约已过期，等待用户显式继续',
            retryable = 1, revision = revision + 1, updated_at = ?
        WHERE status = 'running' AND lease_expires_at <= ?
      `).run(input.now, input.now)
    }
    return { count: rows.length, runIds: rows.map((row) => row.id) }
  })
  return transaction()
}

export function requestResearchAgentRunCancellation(
  db: Database.Database,
  input: { runId: string; now?: number; expectedRevision?: number },
): ResearchAgentRunRow {
  const current = requireResearchAgentRun(db, input.runId)
  assertRevision(current.revision, input.expectedRevision)
  if (current.cancel_requested === 1) return current
  if (current.status === 'succeeded') {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', '已完成的研究运行不能取消')
  }
  const now = input.now ?? Date.now()
  db.prepare(`
    UPDATE research_agent_runs
    SET cancel_requested = 1, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(now, input.runId, current.revision)
  return requireResearchAgentRun(db, input.runId)
}

export function transitionResearchAgentRunStatus(
  db: Database.Database,
  input: {
    runId: string
    toStatus: Exclude<ResearchAgentRunStatus, 'running'>
    leaseOwner?: string
    outcome?: ResearchAgentRunOutcome
    errorCode?: string | null
    errorMessage?: string | null
    retryable?: boolean
    now?: number
    expectedRevision?: number
  },
): ResearchAgentRunRow {
  const current = requireResearchAgentRun(db, input.runId)
  assertRevision(current.revision, input.expectedRevision)
  if (!canTransitionResearchAgentRunStatus(current.status, input.toStatus)) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `不允许从 ${current.status} 转为 ${input.toStatus}`)
  }
  if (current.cancel_requested === 1 && input.toStatus !== 'cancelled') {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', '研究运行已请求取消，只允许收敛为 cancelled')
  }
  if (current.status === 'running') assertLease(current, input.leaseOwner, input.now ?? Date.now())
  if (input.toStatus === 'succeeded' && input.outcome == null) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '成功运行必须声明 complete、partial 或 blocked 结果')
  }
  const now = input.now ?? Date.now()
  const completedAt = ['succeeded', 'cancelled'].includes(input.toStatus) ? now : null
  db.prepare(`
    UPDATE research_agent_runs
    SET status = ?, outcome = ?, cancel_requested = CASE WHEN ? = 'cancelled' THEN 1 ELSE cancel_requested END,
        lease_owner = NULL, lease_expires_at = NULL, completed_at = ?,
        error_code = ?, error_message = ?, retryable = ?,
        revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(
    input.toStatus,
    input.toStatus === 'succeeded' ? input.outcome : null,
    input.toStatus,
    completedAt,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    Number(input.retryable ?? false),
    now,
    input.runId,
    current.revision,
  )
  return requireResearchAgentRun(db, input.runId)
}

export function advanceResearchAgentRunPhase(
  db: Database.Database,
  input: { runId: string; toPhase: ResearchAgentRunPhase; leaseOwner: string; now?: number; expectedRevision?: number },
): ResearchAgentRunRow {
  const now = input.now ?? Date.now()
  const current = requireResearchAgentRun(db, input.runId)
  assertRevision(current.revision, input.expectedRevision)
  assertRunWritable(current, input.leaseOwner, now)
  const currentIndex = PHASES.indexOf(current.phase)
  if (PHASES[currentIndex + 1] !== input.toPhase) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `不允许从 ${current.phase} 跳转到 ${input.toPhase}`)
  }
  db.prepare(`
    UPDATE research_agent_runs
    SET phase = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ?
  `).run(input.toPhase, now, input.runId, current.revision)
  return requireResearchAgentRun(db, input.runId)
}

export function saveResearchAgentRunPlan(
  db: Database.Database,
  input: {
    runId: string
    leaseOwner: string
    plan: unknown
    planSha256?: string
    now?: number
  },
): ResearchAgentRunRow {
  const now = input.now ?? Date.now()
  const run = requireResearchAgentRun(db, input.runId)
  assertRunWritable(run, input.leaseOwner, now)
  if (run.phase !== 'planning') {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', '只有计划阶段可以保存研究计划')
  }
  const plan = serializeResearchAgentJson(input.plan, RESEARCH_AGENT_JSON_LIMITS.stepArtifact, input.planSha256)
  if (run.plan_json != null) {
    if (run.plan_sha256 !== plan.sha256) {
      throw new ResearchAgentRunRepositoryError('HASH_MISMATCH', '研究计划已经固化且内容不一致')
    }
    return run
  }
  db.prepare(`
    UPDATE research_agent_runs
    SET plan_json = ?, plan_sha256 = ?, revision = revision + 1, updated_at = ?
    WHERE id = ? AND plan_json IS NULL
  `).run(plan.json, plan.sha256, now, run.id)
  return requireResearchAgentRun(db, run.id)
}

export function saveResearchAgentRunAuditedReport(
  db: Database.Database,
  input: {
    runId: string
    leaseOwner: string
    evidenceSnapshotSha256: string
    reportMarkdown: string
    reportSha256?: string
    audit: unknown
    now?: number
  },
): ResearchAgentRunRow {
  const now = input.now ?? Date.now()
  const run = requireResearchAgentRun(db, input.runId)
  assertRunWritable(run, input.leaseOwner, now)
  if (run.phase !== 'audit') {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', '只有审计阶段可以保存正式研究报告')
  }
  assertSha256(input.evidenceSnapshotSha256, 'evidenceSnapshotSha256')
  const report = input.reportMarkdown.trim()
  const maxReportCharacters = researchAgentBudgetForRun(run).maxReportCharacters
  if (!report || (maxReportCharacters != null && report.length > maxReportCharacters)) {
    throw new ResearchAgentRunRepositoryError(
      'INVALID_INPUT',
      maxReportCharacters == null ? '正式研究报告不能为空' : `正式研究报告不能为空且不能超过${maxReportCharacters}字符`,
    )
  }
  const reportSha256 = hashResearchAgentText(report)
  if (input.reportSha256 != null && input.reportSha256 !== reportSha256) {
    throw new ResearchAgentRunRepositoryError('HASH_MISMATCH', '正式研究报告哈希与正文不一致')
  }
  const audit = serializeResearchAgentJson(input.audit, RESEARCH_AGENT_JSON_LIMITS.stepArtifact)
  if (run.report_markdown != null) {
    if (
      run.report_sha256 !== reportSha256
      || run.evidence_snapshot_sha256 !== input.evidenceSnapshotSha256
      || run.audit_json !== audit.json
    ) {
      throw new ResearchAgentRunRepositoryError('HASH_MISMATCH', '正式研究报告已经固化且内容不一致')
    }
    return run
  }
  db.prepare(`
    UPDATE research_agent_runs
    SET evidence_snapshot_sha256 = ?, report_markdown = ?, report_sha256 = ?, audit_json = ?,
        revision = revision + 1, updated_at = ?
    WHERE id = ? AND report_markdown IS NULL
  `).run(input.evidenceSnapshotSha256, report, reportSha256, audit.json, now, run.id)
  return requireResearchAgentRun(db, run.id)
}

export function createResearchAgentStep(
  db: Database.Database,
  input: {
    runId: string
    leaseOwner: string
    ordinal: number
    kind: ResearchAgentRunPhase
    stepInput: unknown
    inputSha256?: string
    predecessorStepId?: string | null
    id?: string
    now?: number
  },
): ResearchAgentStepRow {
  const now = input.now ?? Date.now()
  const run = requireResearchAgentRun(db, input.runId)
  assertRunWritable(run, input.leaseOwner, now)
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || input.kind !== run.phase) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '步骤序号无效或步骤类型与当前阶段不一致')
  }
  const id = input.id ?? randomUUID()
  assertUuid(id, 'stepId')
  const serialized = serializeResearchAgentJson(
    input.stepInput,
    RESEARCH_AGENT_JSON_LIMITS.stepInput,
    input.inputSha256,
  )
  if (input.predecessorStepId != null) {
    const predecessor = requireResearchAgentStep(db, input.predecessorStepId)
    if (predecessor.run_id !== input.runId || predecessor.status !== 'succeeded') {
      throw new ResearchAgentRunRepositoryError('STEP_STATE_CONFLICT', '前置步骤不属于当前运行或尚未成功')
    }
  }
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO research_agent_steps (
        id, run_id, ordinal, kind, status, predecessor_step_id,
        input_json, input_sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.ordinal,
      input.kind,
      input.predecessorStepId ?? null,
      serialized.json,
      serialized.sha256,
      now,
      now,
    )
    bumpRunRevision(db, input.runId, now)
    return requireResearchAgentStep(db, id)
  })
  return transaction()
}

export function transitionResearchAgentStepStatus(
  db: Database.Database,
  input: {
    stepId: string
    leaseOwner: string
    toStatus: ResearchAgentStepStatus
    artifact?: unknown
    outputSha256?: string
    errorCode?: string | null
    errorMessage?: string | null
    now?: number
    expectedRevision?: number
  },
): ResearchAgentStepRow {
  const now = input.now ?? Date.now()
  const step = requireResearchAgentStep(db, input.stepId)
  const run = requireResearchAgentRun(db, step.run_id)
  assertLease(run, input.leaseOwner, now)
  assertCancellationAllows(run, input.toStatus === 'cancelled')
  assertRevision(step.revision, input.expectedRevision)
  if (!canTransitionResearchAgentStepStatus(step.status, input.toStatus)) {
    throw new ResearchAgentRunRepositoryError('STEP_STATE_CONFLICT', `不允许从 ${step.status} 转为 ${input.toStatus}`)
  }
  let artifact: { json: string; sha256: string } | null = null
  if (input.toStatus === 'succeeded') {
    if (input.artifact == null) {
      throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '成功步骤必须保存有界产物')
    }
    artifact = serializeResearchAgentJson(
      input.artifact,
      RESEARCH_AGENT_JSON_LIMITS.stepArtifact,
      input.outputSha256,
    )
  }
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE research_agent_steps
      SET status = ?, artifact_json = ?, output_sha256 = ?,
          attempt_count = attempt_count + CASE WHEN ? = 'running' THEN 1 ELSE 0 END,
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          completed_at = CASE WHEN ? IN ('succeeded', 'failed', 'cancelled') THEN ? ELSE NULL END,
          error_code = ?, error_message = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?
    `).run(
      input.toStatus,
      artifact?.json ?? null,
      artifact?.sha256 ?? null,
      input.toStatus,
      input.toStatus,
      now,
      input.toStatus,
      now,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      now,
      input.stepId,
      step.revision,
    )
    bumpRunRevision(db, step.run_id, now)
    return requireResearchAgentStep(db, input.stepId)
  })
  return transaction()
}

export function createResearchAgentToolCall(
  db: Database.Database,
  input: {
    runId: string
    stepId: string
    leaseOwner: string
    toolId: string
    attempt?: number
    toolInput: unknown
    inputSha256?: string
    asOf: string
    reuseSucceeded?: boolean
    id?: string
    now?: number
  },
): ResearchAgentToolCallRow {
  const now = input.now ?? Date.now()
  const run = requireResearchAgentRun(db, input.runId)
  assertRunWritable(run, input.leaseOwner, now)
  const step = requireResearchAgentStep(db, input.stepId)
  if (step.run_id !== input.runId || step.kind !== 'tooling' || step.status !== 'running') {
    throw new ResearchAgentRunRepositoryError('STEP_STATE_CONFLICT', '工具调用必须属于正在执行的 tooling 步骤')
  }
  assertBoundedText(input.toolId, 120, 'toolId')
  assertAsOf(input.asOf)
  const attempt = input.attempt ?? 1
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '工具调用 attempt 必须为正整数')
  }
  const id = input.id ?? randomUUID()
  assertUuid(id, 'toolCallId')
  const serialized = serializeResearchAgentJson(
    input.toolInput,
    RESEARCH_AGENT_JSON_LIMITS.toolInput,
    input.inputSha256,
  )
  const existingById = db.prepare('SELECT * FROM research_agent_tool_calls WHERE id = ?')
    .get(id) as ResearchAgentToolCallRow | undefined
  if (existingById) {
    if (
      existingById.run_id !== input.runId
      || existingById.step_id !== input.stepId
      || existingById.tool_id !== input.toolId
      || existingById.attempt !== attempt
      || existingById.input_sha256 !== serialized.sha256
      || existingById.as_of !== input.asOf
    ) {
      throw new ResearchAgentRunRepositoryError('CALL_ID_CONFLICT', '工具调用 UUID 已用于不同输入')
    }
    return existingById
  }
  if (input.reuseSucceeded !== false) {
    const reusable = db.prepare(`
      SELECT * FROM research_agent_tool_calls
      WHERE run_id = ? AND tool_id = ? AND input_sha256 = ? AND as_of = ?
        AND status = 'succeeded'
      LIMIT 1
    `).get(input.runId, input.toolId, serialized.sha256, input.asOf) as ResearchAgentToolCallRow | undefined
    if (reusable) return reusable
  }
  const budget = researchAgentBudgetForRun(run)
  if (budget.maxToolCalls != null && run.tool_call_count >= budget.maxToolCalls) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `研究运行已达到 ${budget.maxToolCalls} 次工具调用预算`)
  }
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO research_agent_tool_calls (
        id, run_id, step_id, tool_id, attempt, input_json, input_sha256,
        as_of, status, prepared_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `).run(
      id,
      input.runId,
      input.stepId,
      input.toolId,
      attempt,
      serialized.json,
      serialized.sha256,
      input.asOf,
      now,
      now,
    )
    db.prepare(`
      UPDATE research_agent_runs
      SET tool_call_count = tool_call_count + 1, revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(now, input.runId)
    return requireResearchAgentToolCall(db, id)
  })
  return transaction()
}

export function transitionResearchAgentToolCallStatus(
  db: Database.Database,
  input: {
    callId: string
    leaseOwner: string
    toStatus: ResearchAgentToolCallStatus
    envelope?: unknown
    envelopeSha256?: string
    modelProjection?: unknown
    modelProjectionSha256?: string
    stableReferences?: unknown[]
    factDate?: string | null
    sources?: unknown[]
    coverage?: Record<string, unknown>
    warnings?: unknown[]
    durationMs?: number
    errorCode?: string | null
    errorMessage?: string | null
    now?: number
  },
): ResearchAgentToolCallRow {
  const now = input.now ?? Date.now()
  const call = requireResearchAgentToolCall(db, input.callId)
  const run = requireResearchAgentRun(db, call.run_id)
  const budget = researchAgentBudgetForRun(run)
  assertLease(run, input.leaseOwner, now)
  assertCancellationAllows(run, input.toStatus === 'cancelled' || input.toStatus === 'outcome_unknown')
  if (!canTransitionResearchAgentToolCallStatus(call.status, input.toStatus)) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `不允许工具调用从 ${call.status} 转为 ${input.toStatus}`)
  }
  if (input.toStatus === 'succeeded') {
    const reused = db.prepare(`
      SELECT id FROM research_agent_tool_calls
      WHERE run_id = ? AND tool_id = ? AND input_sha256 = ? AND as_of = ?
        AND status = 'succeeded' AND id <> ?
      LIMIT 1
    `).get(call.run_id, call.tool_id, call.input_sha256, call.as_of, call.id) as { id: string } | undefined
    if (reused) {
      throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', '同一运行中已有相同工具输入与截点的成功结果')
    }
  }
  if (input.durationMs != null && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0)) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '工具调用耗时必须为非负整数')
  }
  let envelope: ReturnType<typeof serializeResearchAgentJson> | null = null
  let projection: ReturnType<typeof serializeResearchAgentJson> | null = null
  const persistsResult = input.toStatus === 'succeeded'
    || (input.toStatus === 'blocked' && input.envelope != null && input.modelProjection != null)
  if (persistsResult) {
    if (input.envelope == null || input.modelProjection == null) {
      throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '工具结果必须同时保存完整信封与模型投影')
    }
    envelope = serializeResearchAgentJson(
      input.envelope,
      RESEARCH_AGENT_JSON_LIMITS.toolEnvelope,
      input.envelopeSha256,
    )
    projection = serializeResearchAgentJson(
      input.modelProjection,
      RESEARCH_AGENT_JSON_LIMITS.toolProjection,
      input.modelProjectionSha256,
    )
    if (run.tool_result_bytes + envelope.bytes > budget.maxRunToolResultBytes) {
      throw new ResearchAgentRunRepositoryError('JSON_TOO_LARGE', `单运行完整工具结果累计超过 ${Math.round(budget.maxRunToolResultBytes / 1024 / 1024)} MiB 上限`)
    }
  }
  const references = serializeResearchAgentJson(input.stableReferences ?? [], RESEARCH_AGENT_JSON_LIMITS.toolMetadata)
  const sources = serializeResearchAgentJson(input.sources ?? [], RESEARCH_AGENT_JSON_LIMITS.toolMetadata)
  const coverage = serializeResearchAgentJson(input.coverage ?? {}, RESEARCH_AGENT_JSON_LIMITS.toolMetadata)
  const warnings = serializeResearchAgentJson(input.warnings ?? [], RESEARCH_AGENT_JSON_LIMITS.toolMetadata)
  if (input.factDate != null) assertAsOf(input.factDate)
  const terminal = ['succeeded', 'failed', 'blocked', 'outcome_unknown', 'cancelled'].includes(input.toStatus)
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE research_agent_tool_calls
      SET status = ?, envelope_json = ?, envelope_sha256 = ?,
          model_projection_json = ?, model_projection_sha256 = ?,
          stable_references_json = ?, fact_date = ?, sources_json = ?,
          coverage_json = ?, warnings_json = ?, duration_ms = ?,
          error_code = ?, error_message = ?,
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          submitted_at = CASE WHEN ? = 'submitted' THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END, updated_at = ?
      WHERE id = ?
    `).run(
      input.toStatus,
      envelope?.json ?? null,
      envelope?.sha256 ?? null,
      projection?.json ?? null,
      projection?.sha256 ?? null,
      references.json,
      input.factDate ?? null,
      sources.json,
      coverage.json,
      warnings.json,
      input.durationMs ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.toStatus,
      now,
      input.toStatus,
      now,
      Number(terminal),
      now,
      now,
      input.callId,
    )
    if (envelope != null) {
      db.prepare(`
        UPDATE research_agent_runs
        SET tool_result_bytes = tool_result_bytes + ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(envelope?.bytes ?? 0, now, call.run_id)
    } else {
      bumpRunRevision(db, call.run_id, now)
    }
    return requireResearchAgentToolCall(db, input.callId)
  })
  return transaction()
}

export function createResearchAgentModelCall(
  db: Database.Database,
  input: {
    runId: string
    stepId: string
    leaseOwner: string
    purpose: string
    attempt: number
    inputMessages: unknown[]
    inputSha256?: string
    id?: string
    now?: number
  },
): ResearchAgentModelCallRow {
  const now = input.now ?? Date.now()
  const run = requireResearchAgentRun(db, input.runId)
  assertRunWritable(run, input.leaseOwner, now)
  const step = requireResearchAgentStep(db, input.stepId)
  if (step.run_id !== input.runId || step.status !== 'running') {
    throw new ResearchAgentRunRepositoryError('STEP_STATE_CONFLICT', '模型调用必须属于当前运行中的步骤')
  }
  assertBoundedText(input.purpose, 80, 'purpose')
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '模型调用 attempt 必须为正整数')
  }
  const id = input.id ?? randomUUID()
  assertUuid(id, 'modelCallId')
  const messages = serializeResearchAgentJson(
    input.inputMessages,
    RESEARCH_AGENT_JSON_LIMITS.modelInput,
    input.inputSha256,
  )
  const existingById = db.prepare('SELECT * FROM research_agent_model_calls WHERE id = ?')
    .get(id) as ResearchAgentModelCallRow | undefined
  if (existingById) {
    if (
      existingById.run_id !== input.runId
      || existingById.step_id !== input.stepId
      || existingById.purpose !== input.purpose
      || existingById.attempt !== input.attempt
      || existingById.input_sha256 !== messages.sha256
    ) {
      throw new ResearchAgentRunRepositoryError('CALL_ID_CONFLICT', '模型调用 UUID 已用于不同输入')
    }
    return existingById
  }
  const budget = researchAgentBudgetForRun(run)
  if (budget.maxModelCalls != null && run.model_call_count >= budget.maxModelCalls) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `研究运行已达到 ${budget.maxModelCalls} 次模型调用预算`)
  }
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO research_agent_model_calls (
        id, run_id, step_id, purpose, attempt, status, provider, model,
        prompt_rule_version, input_messages_json, input_sha256, prepared_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.runId,
      input.stepId,
      input.purpose,
      input.attempt,
      run.provider,
      run.model,
      run.prompt_rule_version,
      messages.json,
      messages.sha256,
      now,
      now,
    )
    db.prepare(`
      UPDATE research_agent_runs
      SET model_call_count = model_call_count + 1, revision = revision + 1, updated_at = ?
      WHERE id = ?
    `).run(now, input.runId)
    return requireResearchAgentModelCall(db, id)
  })
  return transaction()
}

export function transitionResearchAgentModelCallStatus(
  db: Database.Database,
  input: {
    callId: string
    leaseOwner: string
    toStatus: ResearchAgentModelCallStatus
    responseId?: string | null
    responseText?: string
    responseSha256?: string
    finishReason?: string | null
    inputTokens?: number | null
    outputTokens?: number | null
    totalTokens?: number | null
    usageStatus?: Exclude<ResearchAgentUsageStatus, 'not_started'>
    priceSnapshot?: Record<string, unknown> | null
    estimatedCost?: number | null
    costCurrency?: string | null
    errorCode?: string | null
    errorMessage?: string | null
    now?: number
  },
): ResearchAgentModelCallRow {
  const now = input.now ?? Date.now()
  const call = requireResearchAgentModelCall(db, input.callId)
  const run = requireResearchAgentRun(db, call.run_id)
  assertLease(run, input.leaseOwner, now)
  assertCancellationAllows(run, input.toStatus === 'cancelled' || input.toStatus === 'outcome_unknown')
  if (!canTransitionResearchAgentModelCallStatus(call.status, input.toStatus)) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `不允许模型调用从 ${call.status} 转为 ${input.toStatus}`)
  }
  let responseSha256: string | null = null
  if (input.toStatus === 'succeeded') {
    if (input.responseText == null) {
      throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '成功模型调用必须保存响应正文')
    }
    if (Buffer.byteLength(input.responseText, 'utf8') > 128 * 1024) {
      throw new ResearchAgentRunRepositoryError('JSON_TOO_LARGE', '模型响应正文超过 128 KiB 上限')
    }
    responseSha256 = hashResearchAgentText(input.responseText)
    if (input.responseSha256 != null && input.responseSha256 !== responseSha256) {
      throw new ResearchAgentRunRepositoryError('HASH_MISMATCH', '模型响应哈希与正文不一致')
    }
  }
  assertOptionalNonNegativeInteger(input.inputTokens, 'inputTokens')
  assertOptionalNonNegativeInteger(input.outputTokens, 'outputTokens')
  assertOptionalNonNegativeInteger(input.totalTokens, 'totalTokens')
  if (input.estimatedCost != null && (!Number.isFinite(input.estimatedCost) || input.estimatedCost < 0)) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '模型调用成本必须为非负有限数值')
  }
  if (input.estimatedCost != null && !input.costCurrency?.trim()) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', '可估算成本必须同时保存币种')
  }
  const usageStatus = input.toStatus === 'succeeded'
    ? input.usageStatus ?? inferUsageStatus(input)
    : null
  const priceSnapshot = input.priceSnapshot == null
    ? null
    : serializeResearchAgentJson(input.priceSnapshot, RESEARCH_AGENT_JSON_LIMITS.priceSnapshot)
  const terminal = ['succeeded', 'safe_failed', 'outcome_unknown', 'cancelled'].includes(input.toStatus)
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE research_agent_model_calls
      SET status = ?, response_id = ?, response_text = ?, response_sha256 = ?,
          finish_reason = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?,
          usage_status = ?, price_snapshot_json = ?, estimated_cost = ?, cost_currency = ?,
          error_code = ?, error_message = ?,
          submitted_at = CASE WHEN ? = 'submitted' THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
          completed_at = CASE WHEN ? THEN ? ELSE NULL END, updated_at = ?
      WHERE id = ?
    `).run(
      input.toStatus,
      input.responseId ?? null,
      input.responseText ?? null,
      responseSha256,
      input.finishReason ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
      usageStatus,
      priceSnapshot?.json ?? null,
      input.estimatedCost ?? null,
      input.costCurrency ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.toStatus,
      now,
      Number(terminal),
      now,
      now,
      input.callId,
    )

    if (input.toStatus === 'outcome_unknown') {
      db.prepare(`
        UPDATE research_agent_runs
        SET status = 'needs_attention', lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'MODEL_OUTCOME_UNKNOWN',
            error_message = '模型请求可能已经送达，禁止自动重放以避免重复计费',
            retryable = 0, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(now, call.run_id)
    } else if (input.toStatus === 'succeeded') {
      const nextUsageStatus = mergeUsageStatus(run.usage_status, usageStatus ?? 'unknown')
      const callCostStatus: ResearchAgentUsageStatus = input.estimatedCost == null ? 'unknown' : 'complete'
      const nextCostStatus = mergeUsageStatus(run.cost_status, callCostStatus)
      const currency = input.estimatedCost == null
        ? run.cost_currency
        : run.cost_currency == null
          ? input.costCurrency ?? null
          : run.cost_currency === input.costCurrency ? run.cost_currency : null
      db.prepare(`
        UPDATE research_agent_runs
        SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
            total_tokens = total_tokens + ?, usage_status = ?,
            estimated_cost = estimated_cost + ?, cost_currency = ?, cost_status = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.totalTokens ?? 0,
        nextUsageStatus,
        input.estimatedCost ?? 0,
        currency,
        currency == null && input.estimatedCost != null ? 'unknown' : nextCostStatus,
        now,
        call.run_id,
      )
    } else {
      bumpRunRevision(db, call.run_id, now)
    }
    return requireResearchAgentModelCall(db, input.callId)
  })
  return transaction()
}

export function getResearchAgentRunByRequestId(
  db: Database.Database,
  requestId: string,
): ResearchAgentRunRow | null {
  return (db.prepare('SELECT * FROM research_agent_runs WHERE request_id = ?').get(requestId) as ResearchAgentRunRow | undefined) ?? null
}

function requireResearchAgentRun(db: Database.Database, runId: string): ResearchAgentRunRow {
  const run = getResearchAgentRun(db, runId)
  if (!run) throw new ResearchAgentRunRepositoryError('RUN_NOT_FOUND', '研究运行不存在')
  return run
}

function requireResearchAgentStep(db: Database.Database, stepId: string): ResearchAgentStepRow {
  const row = db.prepare('SELECT * FROM research_agent_steps WHERE id = ?').get(stepId) as ResearchAgentStepRow | undefined
  if (!row) throw new ResearchAgentRunRepositoryError('STEP_NOT_FOUND', '研究步骤不存在')
  return row
}

function requireResearchAgentToolCall(db: Database.Database, callId: string): ResearchAgentToolCallRow {
  const row = db.prepare('SELECT * FROM research_agent_tool_calls WHERE id = ?').get(callId) as ResearchAgentToolCallRow | undefined
  if (!row) throw new ResearchAgentRunRepositoryError('CALL_NOT_FOUND', '研究工具调用不存在')
  return row
}

function requireResearchAgentModelCall(db: Database.Database, callId: string): ResearchAgentModelCallRow {
  const row = db.prepare('SELECT * FROM research_agent_model_calls WHERE id = ?').get(callId) as ResearchAgentModelCallRow | undefined
  if (!row) throw new ResearchAgentRunRepositoryError('CALL_NOT_FOUND', '研究模型调用不存在')
  return row
}

function assertRunWritable(run: ResearchAgentRunRow, leaseOwner: string, now: number): void {
  assertLease(run, leaseOwner, now)
  assertCancellationAllows(run, false)
}

function assertCancellationAllows(run: ResearchAgentRunRow, terminalOnly: boolean): void {
  if (run.cancel_requested === 1 && !terminalOnly) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', '研究运行已请求取消，只允许终止未完成调用')
  }
}

function assertLease(run: ResearchAgentRunRow, leaseOwner: string | undefined, now: number): void {
  if (
    run.status !== 'running'
    || !leaseOwner
    || run.lease_owner !== leaseOwner
    || run.lease_expires_at == null
    || run.lease_expires_at <= now
  ) {
    throw new ResearchAgentRunRepositoryError('RUN_LEASE_CONFLICT', '研究运行租约无效或不属于当前进程')
  }
}

function assertRevision(current: number, expected: number | undefined): void {
  if (expected != null && current !== expected) {
    throw new ResearchAgentRunRepositoryError('RUN_STATE_CONFLICT', `运行版本已变化：期望 ${expected}，实际 ${current}`)
  }
}

function bumpRunRevision(db: Database.Database, runId: string, now: number): void {
  db.prepare(`
    UPDATE research_agent_runs
    SET revision = revision + 1, updated_at = ?
    WHERE id = ?
  `).run(now, runId)
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', `${field} 必须是 UUID`)
  }
}

function assertSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new ResearchAgentRunRepositoryError('HASH_MISMATCH', `${field} 必须是小写 SHA-256`)
  }
}

function assertAsOf(value: string): void {
  if (!AS_OF_PATTERN.test(value)) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', 'asOf/factDate 必须是 YYYYMMDD')
  }
}

function assertBoundedText(value: string, maxLength: number, field: string): void {
  if (!value.trim() || value.length > maxLength) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', `${field} 不能为空且不能超过 ${maxLength} 个字符`)
  }
}

function assertOptionalNonNegativeInteger(value: number | null | undefined, field: string): void {
  if (value != null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ResearchAgentRunRepositoryError('INVALID_INPUT', `${field} 必须为非负整数或未知`)
  }
}

function inferUsageStatus(input: {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
}): Exclude<ResearchAgentUsageStatus, 'not_started'> {
  const values = [input.inputTokens, input.outputTokens, input.totalTokens]
  if (values.every((value) => value != null)) return 'complete'
  if (values.some((value) => value != null)) return 'partial'
  return 'unknown'
}

function mergeUsageStatus(
  current: ResearchAgentUsageStatus,
  next: Exclude<ResearchAgentUsageStatus, 'not_started'>,
): ResearchAgentUsageStatus {
  if (current === 'not_started') return next
  if (current === 'unknown' || next === 'unknown') return 'unknown'
  if (current === 'complete' && next === 'complete') return 'complete'
  return 'partial'
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && 'code' in error && String((error as { code?: unknown }).code).startsWith('SQLITE_CONSTRAINT')
}

function toCanonicalJson(value: unknown, active: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ResearchAgentRunRepositoryError('INVALID_JSON', '研究运行 JSON 不能包含非有限数值')
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new ResearchAgentRunRepositoryError('INVALID_JSON', '研究运行 JSON 包含不可序列化值')
  }
  if (active.has(value)) {
    throw new ResearchAgentRunRepositoryError('INVALID_JSON', '研究运行 JSON 不能包含循环引用')
  }
  active.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => toCanonicalJson(item, active))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ResearchAgentRunRepositoryError('INVALID_JSON', '研究运行 JSON 只能包含普通对象')
    }
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, toCanonicalJson(record[key], active)]),
    )
  } finally {
    active.delete(value)
  }
}
