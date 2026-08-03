import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import {
  claimResearchAgentRunLease,
  deleteResearchAgentRun,
  getResearchAgentRun,
  getResearchAgentRunByRequestId,
  getResearchAgentRunLedger,
  hashResearchAgentText,
  listResearchAgentRuns,
  pauseExpiredResearchAgentRuns,
  researchAgentBudgetForRun,
  RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
  RESEARCH_AGENT_STANDARD_BUDGET,
  renewResearchAgentRunLease,
  ResearchAgentRunRepositoryError,
  requestResearchAgentRunCancellation,
  startResearchAgentRun,
  transitionResearchAgentRunStatus,
  type ResearchAgentRunLedger,
} from '../database/researchAgentRunRepository'
import {
  getSession,
  deleteSession,
  updateSessionMessages,
  type ConversationMessage,
} from '../database/aiAnalysisSessionRepository'
import {
  getResearchDiscussionContext,
  getResearchDiscussionContextByRequestId,
} from '../database/researchDiscussionRepository'
import { getResearchWebSearchConfig } from '../database/industryResearchGenerationRepository'
import { getResearchProject } from '../database/industryResearchRepository'
import { getStockBasicByTsCodes } from '../database/stockBasicCacheRepository'
import { getStockInfo } from '../database/stockPriceCacheRepository'
import type {
  ResearchAgentRunPhase,
  ResearchAgentRunRow,
  ResearchAgentRunStatus,
  AIResearchDiscussionContextRow,
} from '../database/types'
import { beijingDateKey } from './researchEvidenceDeltaService'
import {
  getDiscussionWebSearchPolicy,
  startResearchDiscussion,
} from './researchDiscussionContextService'
import {
  buildResearchAuditTraceView,
  hashResearchEvidenceContrast,
  validatedResearchEvidenceReferenceIds,
  type ResearchAuditTraceView,
  type ResearchEvidenceContrast,
  type ResearchTextAudit,
} from './researchEvidenceAuditService'
import {
  RESEARCH_AGENT_EVIDENCE_GATE_LEGACY_RULE_VERSION,
  RESEARCH_AGENT_EVIDENCE_GATE_PREVIOUS_RULE_VERSION,
  RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION,
  type ResearchAgentEvidenceGateResult,
} from './researchAgentEvidenceGate'
import { RESEARCH_AGENT_PROMPT_RULE_VERSION } from './researchAgentProtocol'
import {
  buildResearchAgentRunnerProgress,
  resolveCurrentResearchAgentModelConfig,
  runResearchAgent,
  type ResearchAgentPersistInput,
  type ResearchAgentRunnerProgress,
} from './researchAgentRunner'
import {
  parseResearchAgentTrustedSubjects,
  type ResearchAgentTrustedSubject,
} from './researchAgentToolService'
import {
  RESEARCH_FACT_TOOL_DEFINITIONS,
} from './researchFactToolRegistry'
import {
  RESEARCH_AGENT_NETWORK_TOOL_DEFINITIONS,
  RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
} from './researchAgentNetworkTools'
import {
  MULTI_PERSPECTIVE_PROTOCOL_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_TOOL_REGISTRY_VERSION,
  parseMultiPerspectiveModeratorAction,
  parseMultiPerspectiveRoleAction,
  parseMultiPerspectiveUnrestrictedModeratorAction,
  parseMultiPerspectiveUnrestrictedRoleAction,
  type MultiPerspectiveModeratorAction,
  type MultiPerspectiveQualitySummary,
  type MultiPerspectiveRoleAction,
  type MultiPerspectiveUnrestrictedModeratorAction,
  type MultiPerspectiveUnrestrictedRoleAction,
} from './researchMultiPerspectiveProtocol'

const LEASE_TTL_MS = 150_000
const LEASE_RENEW_INTERVAL_MS = 30_000
const MAX_CONTEXT_MESSAGES = 40
const MAX_CONTEXT_MESSAGE_CHARS = 4_000

export interface ResearchAgentPreflightView {
  sessionId: number | null
  ready: boolean
  unavailableReason: string | null
  asOf: string
  model: { provider: string; model: string; configured: boolean }
  suggestedSubjects: ResearchAgentSubjectView[]
  availableTools: Array<{ id: string; description: string; sensitive: boolean }>
  budget: typeof RESEARCH_AGENT_STANDARD_BUDGET
  costEstimate: { status: 'unavailable'; message: string }
  evidencePolicy: {
    ruleVersion: string
    mode: 'local_then_network'
    networkToolsAvailable: boolean
    message: string
  }
}

export type ResearchAgentSubjectView =
  | { kind: 'stock'; tsCode: string; label: string | null }
  | { kind: 'industry_project'; id: string; label: string | null }

export interface ResearchAgentResultSemanticsView {
  execution: 'queued' | 'running' | 'paused' | 'needs_attention' | 'completed' | 'failed' | 'cancelled'
  executionLabel: string
  conclusionCoverage: 'pending' | 'complete' | 'limited' | 'blocked' | 'unavailable'
  conclusionLabel: string
}

export interface ResearchAgentRunSummaryView {
  id: string
  requestId: string
  parentRunId: string | null
  runKind: ResearchAgentRunRow['run_kind']
  discussionSessionId: number | null
  question: string
  subjects: ResearchAgentSubjectView[]
  includePortfolio: boolean
  asOf: string
  status: ResearchAgentRunStatus
  phase: ResearchAgentRunPhase
  outcome: ResearchAgentRunRow['outcome']
  resultSemantics: ResearchAgentResultSemanticsView
  provider: string
  model: string
  modelCallCount: number
  toolCallCount: number
  budgetVersion: string
  maxModelCalls: number | null
  maxToolCalls: number | null
  maxDurationMs: number | null
  inputTokens: number
  outputTokens: number
  totalTokens: number
  usageStatus: ResearchAgentRunRow['usage_status']
  estimatedCost: number
  costCurrency: string | null
  costStatus: ResearchAgentRunRow['cost_status']
  cancelRequested: boolean
  retryable: boolean
  errorCode: string | null
  errorMessage: string | null
  revision: number
  createdAt: number
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
}

export interface ResearchAgentRunDetailView {
  run: ResearchAgentRunSummaryView
  plan: unknown | null
  reportMarkdown: string | null
  reportSha256: string | null
  evidenceSnapshotSha256: string | null
  outcomeExplanation: string | null
  conclusionExplanation: string | null
  evidenceGate: ResearchAgentEvidenceGateResult | null
  evidenceGateHistory: Array<{
    stepId: string
    stage: 'local' | 'network'
    decisionRound: number | null
    gate: ResearchAgentEvidenceGateResult
  }>
  reviewEligibility: {
    eligible: boolean
    reason: string | null
    budget: typeof RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET
  }
  retryEligibility: { eligible: boolean; reason: string | null }
  deleteEligibility: { eligible: boolean; reason: string | null }
  multiPerspective: {
    sourceRunId: string
    evidenceSnapshotSha256: string
    bull: Omit<MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction, 'rationale'> | null
    bear: Omit<MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction, 'rationale'> | null
    moderator: Omit<MultiPerspectiveModeratorAction | MultiPerspectiveUnrestrictedModeratorAction, 'rationale'> | null
    quality: MultiPerspectiveQualitySummary | null
  } | null
  researchTrace: ResearchAuditTraceView | null
  steps: Array<{
    id: string
    ordinal: number
    kind: ResearchAgentRunPhase
    status: string
    attemptCount: number
    outputSha256: string | null
    errorCode: string | null
    errorMessage: string | null
    startedAt: number | null
    completedAt: number | null
  }>
  toolCalls: Array<{
    id: string
    toolId: string
    attempt: number
    status: string
    envelopeSha256: string | null
    modelProjectionSha256: string | null
    stableReferences: unknown[]
    factDate: string | null
    sources: unknown[]
    coverage: Record<string, unknown>
    warnings: unknown[]
    scope: 'local' | 'network'
    kind: 'local' | 'search' | 'document' | 'refresh'
    request: {
      query: string | null
      candidateId: string | null
      stockCode: string | null
      requestedLimit: number | null
    }
    searchProvider: string | null
    candidates: Array<{
      candidateId: string
      title: string
      url: string
      domain: string
      snippet: string | null
      publishedAt: string | null
      sourceClass: 'official' | 'primary' | 'secondary'
    }>
    document: {
      candidateId: string
      title: string
      finalUrl: string
      sourceDomain: string
      sourceClass: 'official' | 'primary' | 'secondary'
      primarySourceConfirmed: boolean
      publishedAt: string | null
      fetchedAt: number
      excerpt: string
      excerptTruncated: boolean
      contentSha256: string
      rawBodySha256: string
      mimeKind: string
    } | null
    network: {
      method: string
      requestHost: string
      finalHost: string
      statusCode: number
      mimeKind: string
      fetchedAt: number
      decodedBytes: number
      redirectCount: number
      bodySha256: string
    } | null
    failure: {
      category: 'cancelled' | 'rate_limited' | 'network' | 'security' | 'configuration' | 'tool' | 'outcome_unknown'
      resultUnknown: boolean
      retryable: boolean
      code: string
      message: string
    } | null
    durationMs: number | null
    errorCode: string | null
    errorMessage: string | null
  }>
  modelCalls: Array<{
    id: string
    purpose: string
    attempt: number
    status: string
    provider: string
    model: string
    responseId: string | null
    responseSha256: string | null
    finishReason: string | null
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    usageStatus: string | null
    estimatedCost: number | null
    costCurrency: string | null
    errorCode: string | null
    errorMessage: string | null
  }>
}

export interface ResearchAgentManagerDependencies {
  now?: () => number
  run?: typeof runResearchAgent
  resolveModelConfig?: typeof resolveCurrentResearchAgentModelConfig
  getWindow?: () => BrowserWindow | null
}

export class ResearchAgentRunManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ResearchAgentRunManagerError'
  }
}

export class ResearchAgentRunManager {
  readonly bootId = `boot-${randomUUID()}`
  private readonly active = new Map<string, AbortController>()
  private readonly now: () => number
  private readonly executeRun: typeof runResearchAgent
  private readonly resolveModelConfig: typeof resolveCurrentResearchAgentModelConfig

  constructor(
    private readonly db: Database.Database,
    private readonly dependencies: ResearchAgentManagerDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now
    this.executeRun = dependencies.run ?? runResearchAgent
    this.resolveModelConfig = dependencies.resolveModelConfig ?? resolveCurrentResearchAgentModelConfig
  }

  initialize(): { count: number; runIds: string[] } {
    return pauseExpiredResearchAgentRuns(this.db, { now: this.now() })
  }

  preflight(sessionId: number): ResearchAgentPreflightView {
    const rebuilt = rebuildTrustedDiscussionContext(this.db, sessionId, this.now())
    return this.buildPreflight({
      sessionId,
      asOf: rebuilt.asOf,
      fallbackProvider: rebuilt.session.provider,
      fallbackModel: rebuilt.session.model,
      projectId: rebuilt.discussion.project_id,
      suggestedSubjects: suggestedSubjectsFromContext(rebuilt.context, rebuilt.discussion),
      includeJudgmentHistory: rebuilt.context.trustedSubjects.length > 0,
    })
  }

  preflightDirect(projectId: string | null = null): ResearchAgentPreflightView {
    if (projectId && !getResearchProject(this.db, projectId)) {
      throw new ResearchAgentRunManagerError('NOT_FOUND', '产业研究项目不存在')
    }
    return this.buildPreflight({
      sessionId: null,
      asOf: beijingDateKey(this.now()),
      fallbackProvider: '未配置',
      fallbackModel: '未配置',
      projectId,
      suggestedSubjects: [],
      includeJudgmentHistory: false,
    })
  }

  startDirect(input: {
    requestId: string
    question: string
    subjects: unknown[]
    includePortfolio: boolean
    projectId?: string | null
    confirmedBudgetVersion: string
  }): { run: ResearchAgentRunSummaryView; replayed: boolean; discussionSessionId: number } {
    if (input.confirmedBudgetVersion !== RESEARCH_AGENT_STANDARD_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前固定研究预算版本')
    }
    const parsedSubjects = parseResearchAgentTrustedSubjects(input.subjects)
    validateDirectSubjects(input.projectId ?? null, parsedSubjects)
    const replay = replayDirectResearchRun(this.db, input, parsedSubjects)
    if (replay) return replay
    const orphanedDiscussion = getResearchDiscussionContextByRequestId(this.db, input.requestId)
    if (orphanedDiscussion) {
      assertDirectDiscussionReplayMatches(orphanedDiscussion, input.question, input.projectId ?? null)
    }
    if (!this.resolveModelConfig(this.db)) {
      throw new ResearchAgentRunManagerError('AI_NOT_CONFIGURED', '请先在 AI 配置中提供可用的固定厂商、模型和凭据')
    }
    const subjects = resolveAuthoritativeSubjectLabels(this.db, parsedSubjects)
    const discussion = startResearchDiscussion(this.db, {
      requestId: input.requestId,
      origin: { type: 'manual', id: null },
      projectId: input.projectId ?? null,
      initialQuestion: input.question,
      mode: 'new',
      returnTarget: {
        tab: 'ai-analysis',
        subTab: 'deepResearch',
        stateKey: 'deep-research',
      },
    })
    let started: { run: ResearchAgentRunSummaryView; replayed: boolean }
    try {
      started = this.start({
        requestId: input.requestId,
        sessionId: discussion.discussion.sessionId,
        question: input.question,
        subjects,
        includePortfolio: input.includePortfolio,
        confirmedBudgetVersion: input.confirmedBudgetVersion,
        parentRunId: null,
      })
    } catch (error) {
      if (!discussion.resumed && !getResearchAgentRunByRequestId(this.db, input.requestId)) {
        try { deleteSession(this.db, discussion.discussion.sessionId) } catch { /* Preserve the original start error. */ }
      }
      throw error
    }
    return {
      ...started,
      discussionSessionId: discussion.discussion.sessionId,
    }
  }

  start(input: {
    requestId: string
    sessionId: number
    question: string
    subjects: unknown[]
    includePortfolio: boolean
    confirmedBudgetVersion: string
    parentRunId?: string | null
  }): { run: ResearchAgentRunSummaryView; replayed: boolean } {
    if (input.confirmedBudgetVersion !== RESEARCH_AGENT_STANDARD_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前固定研究预算版本')
    }
    const rebuilt = rebuildTrustedDiscussionContext(this.db, input.sessionId, this.now())
    const config = this.resolveModelConfig(this.db)
    if (!config) throw new ResearchAgentRunManagerError('AI_NOT_CONFIGURED', '固定模型当前不可用')
    const parsedSubjects = parseResearchAgentTrustedSubjects(input.subjects)
    validateConfirmedSubjects(rebuilt.discussion.project_id, parsedSubjects)
    const subjects = resolveAuthoritativeSubjectLabels(this.db, parsedSubjects)
    const started = startResearchAgentRun(this.db, {
      requestId: input.requestId,
      parentRunId: input.parentRunId ?? null,
      discussionSessionId: input.sessionId,
      question: input.question,
      contextSnapshot: rebuilt.context,
      subjects,
      includePortfolio: input.includePortfolio,
      asOf: rebuilt.asOf,
      provider: config.provider,
      model: config.model,
      modelConfigFingerprint: config.fingerprint,
      promptRuleVersion: RESEARCH_AGENT_PROMPT_RULE_VERSION,
      toolRegistryVersion: RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
      now: this.now(),
    })
    if (!started.replayed && started.run.status === 'queued') {
      try {
        this.launch(started.run.id)
      } catch (error) {
        if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'RUN_LEASE_CONFLICT') throw error
      }
    }
    return { run: toRunSummary(getResearchAgentRun(this.db, started.run.id)!), replayed: started.replayed }
  }

  startReview(input: {
    requestId: string
    sourceRunId: string
    confirmedBudgetVersion: string
  }): { run: ResearchAgentRunSummaryView; replayed: boolean } {
    if (input.confirmedBudgetVersion !== RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前多视角固定预算版本')
    }
    const sourceLedger = getResearchAgentRunLedger(this.db, input.sourceRunId)
    if (!sourceLedger) throw new ResearchAgentRunManagerError('NOT_FOUND', '来源研究运行不存在')
    const eligibility = reviewEligibility(sourceLedger)
    if (!eligibility.eligible) {
      throw new ResearchAgentRunManagerError('SOURCE_RUN_NOT_ELIGIBLE', eligibility.reason ?? '来源研究运行不允许多视角复核')
    }
    const source = sourceLedger.run
    const config = this.resolveModelConfig(this.db)
    if (!config) throw new ResearchAgentRunManagerError('AI_NOT_CONFIGURED', '固定模型当前不可用')
    if (
      config.provider !== source.provider
      || config.model !== source.model
      || config.fingerprint !== source.model_config_fingerprint
    ) {
      throw new ResearchAgentRunManagerError('MODEL_CONFIG_CHANGED', '来源运行的固定 provider、model 或 Base URL 语义已经变化')
    }
    const started = startResearchAgentRun(this.db, {
      requestId: input.requestId,
      runKind: 'multi_perspective',
      parentRunId: source.id,
      discussionSessionId: source.discussion_session_id,
      question: source.question,
      contextSnapshot: {
        schemaVersion: 1,
        kind: 'multi_perspective_source',
        sourceRunId: source.id,
        sourceReportSha256: source.report_sha256,
        sourceEvidenceSnapshotSha256: source.evidence_snapshot_sha256,
      },
      subjects: parseResearchAgentTrustedSubjects(safeJson(source.subjects_json)),
      includePortfolio: source.include_portfolio === 1,
      asOf: source.as_of,
      provider: source.provider,
      model: source.model,
      modelConfigFingerprint: source.model_config_fingerprint,
      promptRuleVersion: MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION,
      toolRegistryVersion: MULTI_PERSPECTIVE_UNRESTRICTED_TOOL_REGISTRY_VERSION,
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
      now: this.now(),
    })
    if (!started.replayed && started.run.status === 'queued') {
      try {
        this.launch(started.run.id)
      } catch (error) {
        if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'RUN_LEASE_CONFLICT') throw error
      }
    }
    return { run: toRunSummary(getResearchAgentRun(this.db, started.run.id)!), replayed: started.replayed }
  }

  list(sessionId?: number | null): ResearchAgentRunSummaryView[] {
    return listResearchAgentRuns(this.db, { discussionSessionId: sessionId, limit: 50 }).map(toRunSummary)
  }

  get(runId: string): ResearchAgentRunDetailView {
    const ledger = getResearchAgentRunLedger(this.db, runId)
    if (!ledger) throw new ResearchAgentRunManagerError('NOT_FOUND', '研究运行不存在')
    return toRunDetail(this.db, ledger)
  }

  resume(runId: string): ResearchAgentRunSummaryView {
    const run = requireRun(this.db, runId)
    if (run.status === 'running' && this.active.has(runId)) return toRunSummary(run)
    if (!['queued', 'paused', 'failed'].includes(run.status)) {
      throw new ResearchAgentRunManagerError(
        run.status === 'needs_attention' ? 'CALL_OUTCOME_UNKNOWN' : 'RUN_NOT_RESUMABLE',
        run.status === 'needs_attention'
          ? '该运行存在已提交但结果或费用未知的模型或联网工具调用，不能在同一运行继续'
          : `状态 ${run.status} 不允许继续`,
      )
    }
    if (run.status === 'failed' && run.retryable !== 1) {
      throw new ResearchAgentRunManagerError('RUN_NOT_RESUMABLE', '该失败已经确认不可重试，请新建研究运行')
    }
    if (run.cancel_requested === 1) throw new ResearchAgentRunManagerError('RUN_STATE_CONFLICT', '研究运行已请求取消')
    this.launch(runId)
    return toRunSummary(requireRun(this.db, runId))
  }

  retry(input: {
    requestId: string
    sourceRunId: string
    confirmedBudgetVersion: string
  }): { run: ResearchAgentRunSummaryView; replayed: boolean } {
    if (input.confirmedBudgetVersion !== RESEARCH_AGENT_STANDARD_BUDGET.id) {
      throw new ResearchAgentRunManagerError('INVALID_PARAM', '必须确认当前连续研究预算版本')
    }
    const replay = getResearchAgentRunByRequestId(this.db, input.requestId)
    if (replay) {
      if (replay.parent_run_id !== input.sourceRunId || replay.run_kind !== 'single_agent') {
        throw new ResearchAgentRunManagerError('REQUEST_ID_CONFLICT', 'requestId 已用于不同的研究重试')
      }
      return { run: toRunSummary(replay), replayed: true }
    }
    const source = requireRun(this.db, input.sourceRunId)
    const eligibility = retryEligibility(source)
    if (!eligibility.eligible) {
      throw new ResearchAgentRunManagerError('RUN_NOT_RETRYABLE', eligibility.reason ?? '当前研究不允许重新运行')
    }
    if (source.discussion_session_id == null) {
      throw new ResearchAgentRunManagerError('DISCUSSION_NOT_FOUND', '来源研究没有可复用的受信讨论')
    }
    return this.start({
      requestId: input.requestId,
      sessionId: source.discussion_session_id,
      question: source.question,
      subjects: parseResearchAgentTrustedSubjects(safeJson(source.subjects_json)),
      includePortfolio: source.include_portfolio === 1,
      confirmedBudgetVersion: input.confirmedBudgetVersion,
      parentRunId: source.id,
    })
  }

  delete(runId: string): { deletedRunIds: string[]; discussionDeleted: boolean } {
    const run = requireRun(this.db, runId)
    const eligibility = deleteEligibility(this.db, run)
    if (!eligibility.eligible) {
      throw new ResearchAgentRunManagerError('RUN_NOT_DELETABLE', eligibility.reason ?? '当前研究不允许删除')
    }
    const sessionId = run.discussion_session_id
    const transaction = this.db.transaction(() => {
      const deleted = deleteResearchAgentRun(this.db, runId)
      if (sessionId == null) return { ...deleted, discussionDeleted: false }
      const session = getSession(this.db, sessionId)
      const discussion = getResearchDiscussionContext(this.db, sessionId)
      if (!session || !discussion) return { ...deleted, discussionDeleted: false }
      const deletedIds = new Set(deleted.deletedRunIds)
      const messages = parseConversationMessages(session.messages)
        .filter((message) => !message.researchAgentRunId || !deletedIds.has(message.researchAgentRunId))
      const remainingRuns = listResearchAgentRuns(this.db, { discussionSessionId: sessionId, limit: 1 })
      const returnTarget = safeJson(discussion.return_target_json)
      const directEmptyDiscussion = discussion.origin_type === 'manual'
        && isRecord(returnTarget)
        && returnTarget.tab === 'ai-analysis'
        && returnTarget.subTab === 'deepResearch'
        && messages.length === 0
        && remainingRuns.length === 0
      if (directEmptyDiscussion) {
        deleteSession(this.db, sessionId)
        return { ...deleted, discussionDeleted: true }
      }
      updateSessionMessages(this.db, sessionId, messages)
      return { ...deleted, discussionDeleted: false }
    })
    return transaction()
  }

  cancel(runId: string): ResearchAgentRunSummaryView {
    const before = requireRun(this.db, runId)
    if (before.status === 'succeeded') {
      throw new ResearchAgentRunManagerError('RUN_NOT_CANCELLABLE', '已完成的研究运行不能取消')
    }
    let run = requestResearchAgentRunCancellation(this.db, { runId, now: this.now() })
    const controller = this.active.get(runId)
    if (controller) {
      controller.abort('user_cancelled')
    } else if (run.status !== 'running' && run.status !== 'cancelled') {
      run = transitionResearchAgentRunStatus(this.db, {
        runId,
        toStatus: 'cancelled',
        errorCode: 'USER_CANCELLED',
        errorMessage: '用户已取消研究运行',
        now: this.now(),
      })
    }
    this.emit(buildResearchAgentRunnerProgress(this.db, run, '取消请求已保存'))
    return toRunSummary(requireRun(this.db, runId))
  }

  private launch(runId: string): void {
    if (this.active.has(runId)) throw new ResearchAgentRunManagerError('RUN_ALREADY_ACTIVE', '该研究运行已在执行')
    const claimed = claimResearchAgentRunLease(this.db, {
      runId,
      leaseOwner: this.bootId,
      now: this.now(),
      ttlMs: LEASE_TTL_MS,
    })
    const controller = new AbortController()
    this.active.set(runId, controller)
    const renew = setInterval(() => {
      const current = getResearchAgentRun(this.db, runId)
      if (!current || current.status !== 'running' || current.lease_owner !== this.bootId) return
      try {
        renewResearchAgentRunLease(this.db, {
          runId,
          leaseOwner: this.bootId,
          now: this.now(),
          ttlMs: LEASE_TTL_MS,
        })
      } catch {
        controller.abort('lease_lost')
      }
    }, LEASE_RENEW_INTERVAL_MS)
    void this.executeRun(this.db, { runId, leaseOwner: this.bootId }, {
      signal: controller.signal,
      persistReport: persistResearchAgentReport,
      onProgress: (event) => this.emit(event),
    }).catch((error) => {
      console.error('[ResearchAgent] run failed:', error instanceof Error ? error.message : String(error))
    }).finally(() => {
      clearInterval(renew)
      this.active.delete(runId)
      const current = getResearchAgentRun(this.db, runId) ?? claimed
      this.emit(buildResearchAgentRunnerProgress(
        this.db,
        current,
        current.error_message ?? researchAgentStatusLabel(current.status),
      ))
    })
  }

  private emit(event: ResearchAgentRunnerProgress): void {
    const window = this.dependencies.getWindow?.()
    if (!window || window.isDestroyed()) return
    window.webContents.send('researchAgent:progress', event)
  }

  private buildPreflight(input: {
    sessionId: number | null
    asOf: string
    fallbackProvider: string
    fallbackModel: string
    projectId: string | null
    suggestedSubjects: ResearchAgentSubjectView[]
    includeJudgmentHistory: boolean
  }): ResearchAgentPreflightView {
    const config = this.resolveModelConfig(this.db)
    const searchConfig = getResearchWebSearchConfig(this.db)
    const searchConfigured = Boolean(
      searchConfig?.enabled === 1
      && searchConfig.api_key_encrypted
      && searchConfig.api_key_encrypted.length > 0,
    )
    const toolIds = new Set<string>(['news.recent_briefings'])
    if (!input.projectId) {
      for (const id of ['stock.price_history', 'stock.trend_snapshot', 'stock.fundamentals', 'stock.announcements']) toolIds.add(id)
      for (const id of [
        'company.fundamentals_refresh',
        'market.price_refresh',
        'market.quote_snapshot',
        'official.disclosure_search',
        'official.disclosure_document',
      ]) toolIds.add(id)
    } else {
      toolIds.add('industry.project_snapshot')
      toolIds.add('official.disclosure_search')
      toolIds.add('official.disclosure_document')
    }
    toolIds.add('web.search')
    toolIds.add('web.fetch_page')
    if (input.includeJudgmentHistory) toolIds.add('decision.judgment_history')
    toolIds.add('portfolio.holdings')
    return {
      sessionId: input.sessionId,
      ready: Boolean(config),
      unavailableReason: config ? null : '请先在 AI 配置中提供可用的固定厂商、模型和凭据',
      asOf: input.asOf,
      model: {
        provider: config?.provider ?? input.fallbackProvider,
        model: config?.model ?? input.fallbackModel,
        configured: Boolean(config),
      },
      suggestedSubjects: input.suggestedSubjects,
      availableTools: [...RESEARCH_FACT_TOOL_DEFINITIONS, ...RESEARCH_AGENT_NETWORK_TOOL_DEFINITIONS]
        .filter((tool) => toolIds.has(tool.id))
        .map((tool) => ({
          id: tool.id,
          description: tool.description,
          sensitive: tool.id === 'portfolio.holdings',
        })),
      budget: RESEARCH_AGENT_STANDARD_BUDGET,
      costEstimate: {
        status: 'unavailable',
        message: '当前没有与固定模型精确匹配的版本化价格快照；运行中仍会记录 Token。',
      },
      evidencePolicy: {
        ruleVersion: RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION,
        mode: 'local_then_network',
        networkToolsAvailable: true,
        message: searchConfigured
          ? '本地证据不足时可通过受控搜索、候选正文、正式披露及必要行情工具补证；补证后仍有缺口时继续生成降级报告，并明确披露未知项。'
          : '行情与财务受控补证可用；网页搜索尚未配置密钥时仍继续综合，但新闻、披露或产业正文结论会明确降级。',
      },
    }
  }
}

function rebuildTrustedDiscussionContext(db: Database.Database, sessionId: number, now: number) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    throw new ResearchAgentRunManagerError('INVALID_PARAM', 'sessionId 必须是正整数')
  }
  const session = getSession(db, sessionId)
  const discussion = getResearchDiscussionContext(db, sessionId)
  if (!session || !discussion) throw new ResearchAgentRunManagerError('NOT_FOUND', '研究讨论不存在')
  const snapshot = safeRecordJson(discussion.context_snapshot_json)
  if (!snapshot) throw new ResearchAgentRunManagerError('CONTEXT_INVALID', '研究讨论上下文损坏')
  const messages = parseConversationMessages(session.messages).slice(-MAX_CONTEXT_MESSAGES).map((message) => ({
    role: message.role,
    content: message.content.slice(0, MAX_CONTEXT_MESSAGE_CHARS),
    researchAgentRunId: message.researchAgentRunId ?? null,
  }))
  const webPolicy = getDiscussionWebSearchPolicy(db, sessionId)
  const contextFacts = isRecord(snapshot.contextFacts) ? snapshot.contextFacts : null
  const trustedSubjects = Array.isArray(contextFacts?.invocations)
    ? contextFacts.invocations.flatMap((item) => (
        isRecord(item) && item.subjectKind === 'judgment' && typeof item.subjectId === 'string'
          ? [{ kind: 'judgment' as const, id: item.subjectId }]
          : []
      ))
    : []
  return {
    session,
    discussion,
    asOf: beijingDateKey(now),
    context: {
      schemaVersion: 1,
      source: {
        kind: 'discussion',
        sessionId,
        originType: discussion.origin_type,
        originId: discussion.origin_id,
        originTitle: discussion.origin_title,
        projectId: discussion.project_id,
        contextSha256: discussion.origin_content_hash,
      },
      trustedSubjects,
      contextFacts: snapshot.contextFacts ?? null,
      researchFacts: snapshot.researchFacts ?? null,
      evidenceDelta: snapshot.evidenceDelta ?? null,
      trustedEvidenceContrast: snapshot.trustedEvidenceContrast ?? null,
      selectedItems: Array.isArray(snapshot.items) ? snapshot.items.slice(0, 50) : [],
      messages,
      excludedUrls: webPolicy.excludedUrls,
    },
  }
}

function suggestedSubjectsFromContext(
  context: ReturnType<typeof rebuildTrustedDiscussionContext>['context'],
  discussion: AIResearchDiscussionContextRow,
): ResearchAgentSubjectView[] {
  if (discussion.project_id) {
    return [{ kind: 'industry_project', id: discussion.project_id, label: discussion.origin_title }]
  }
  const researchFacts = isRecord(context.researchFacts) ? context.researchFacts : null
  const codes = Array.isArray(researchFacts?.stockCodes) ? researchFacts.stockCodes : []
  return Array.from(new Set(codes.filter((item): item is string => typeof item === 'string')))
    .slice(0, 5)
    .map((tsCode) => ({ kind: 'stock' as const, tsCode, label: null }))
}

function validateConfirmedSubjects(projectId: string | null, subjects: ResearchAgentTrustedSubject[]): void {
  const project = subjects.find((subject) => subject.kind === 'industry_project')
  if (project && project.id !== projectId) {
    throw new ResearchAgentRunManagerError('SUBJECT_DENIED', '产业项目主体与受信讨论不一致')
  }
}

function validateDirectSubjects(projectId: string | null, subjects: ResearchAgentTrustedSubject[]): void {
  const projects = subjects.filter((subject): subject is Extract<ResearchAgentTrustedSubject, { kind: 'industry_project' }> => subject.kind === 'industry_project')
  const stocks = subjects.filter((subject) => subject.kind === 'stock')
  if (projectId) {
    if (projects.length !== 1 || projects[0].id !== projectId || stocks.length > 0) {
      throw new ResearchAgentRunManagerError('SUBJECT_DENIED', '产业项目研究必须且只能确认当前关联项目')
    }
    return
  }
  if (projects.length > 0 || stocks.length < 1) {
    throw new ResearchAgentRunManagerError('SUBJECT_DENIED', 'A股研究必须确认至少一只股票且不能混入产业项目')
  }
}

function resolveAuthoritativeSubjectLabels(
  db: Database.Database,
  subjects: ResearchAgentTrustedSubject[],
): ResearchAgentTrustedSubject[] {
  const stockCodes = subjects.flatMap((subject) => subject.kind === 'stock' ? [subject.tsCode] : [])
  const stockBasics = getStockBasicByTsCodes(db, stockCodes)
  return subjects.map((subject) => {
    if (subject.kind === 'industry_project') {
      const project = getResearchProject(db, subject.id)
      if (!project) throw new ResearchAgentRunManagerError('NOT_FOUND', '产业研究项目不存在')
      return { ...subject, label: project.title.trim().slice(0, 160) || null }
    }
    const label = stockBasics.get(subject.tsCode)?.name?.trim()
      || getStockInfo(db, subject.tsCode.slice(0, 6))?.stockName?.trim()
      || null
    return { ...subject, label: label?.slice(0, 160) ?? null }
  })
}

function replayDirectResearchRun(
  db: Database.Database,
  input: {
    requestId: string
    question: string
    includePortfolio: boolean
    projectId?: string | null
  },
  requestedSubjects: ResearchAgentTrustedSubject[],
): { run: ResearchAgentRunSummaryView; replayed: true; discussionSessionId: number } | null {
  const existing = getResearchAgentRunByRequestId(db, input.requestId)
  if (!existing) return null
  const discussion = existing.discussion_session_id == null
    ? null
    : getResearchDiscussionContext(db, existing.discussion_session_id)
  const returnTarget = safeJson(discussion?.return_target_json ?? null)
  const storedSubjects = parseResearchAgentTrustedSubjects(safeJson(existing.subjects_json))
  const subjectIdentity = (subject: ResearchAgentTrustedSubject) => (
    subject.kind === 'stock' ? `stock:${subject.tsCode}` : `industry_project:${subject.id}`
  )
  const matches = existing.run_kind === 'single_agent'
    && existing.parent_run_id == null
    && discussion?.start_request_id === input.requestId
    && discussion.project_id === (input.projectId ?? null)
    && isRecord(returnTarget)
    && returnTarget.tab === 'ai-analysis'
    && returnTarget.subTab === 'deepResearch'
    && existing.question === input.question.trim()
    && existing.include_portfolio === Number(input.includePortfolio)
    && storedSubjects.map(subjectIdentity).join('\u0000') === requestedSubjects.map(subjectIdentity).join('\u0000')
  if (!matches || existing.discussion_session_id == null) {
    throw new ResearchAgentRunManagerError('REQUEST_ID_CONFLICT', 'requestId 已用于不同的深度研究输入')
  }
  return {
    run: toRunSummary(existing),
    replayed: true,
    discussionSessionId: existing.discussion_session_id,
  }
}

function assertDirectDiscussionReplayMatches(
  discussion: AIResearchDiscussionContextRow,
  question: string,
  projectId: string | null,
): void {
  const returnTarget = safeJson(discussion.return_target_json)
  const snapshot = safeJson(discussion.context_snapshot_json)
  const items = isRecord(snapshot) && Array.isArray(snapshot.items) ? snapshot.items : []
  const storedQuestion = items.find((item) => (
    isRecord(item) && item.key === 'manual-question' && typeof item.excerpt === 'string'
  ))
  const matches = discussion.origin_type === 'manual'
    && discussion.project_id === projectId
    && isRecord(returnTarget)
    && returnTarget.tab === 'ai-analysis'
    && returnTarget.subTab === 'deepResearch'
    && isRecord(storedQuestion)
    && storedQuestion.excerpt === question.trim()
  if (!matches) {
    throw new ResearchAgentRunManagerError('REQUEST_ID_CONFLICT', 'requestId 已绑定不同的深度研究讨论输入')
  }
}

export function persistResearchAgentReport(
  db: Database.Database,
  input: ResearchAgentPersistInput,
): void {
  if (input.run.discussion_session_id == null) return
  const transaction = db.transaction(() => {
    const session = getSession(db, input.run.discussion_session_id!)
    const discussion = getResearchDiscussionContext(db, input.run.discussion_session_id!)
    if (!session || !discussion) throw new ResearchAgentRunManagerError('PERSIST_FAILED', '目标研究讨论不存在')
    const messages = parseConversationMessages(session.messages)
    if (messages.some((message) => message.researchAgentRunId === input.run.id)) return
    const assistant: ConversationMessage = {
      role: 'assistant',
      content: input.reportMarkdown,
      researchAgentRunId: input.run.id,
      researchAudit: input.audit,
    }
    const next: ConversationMessage[] = input.run.run_kind === 'multi_perspective'
      ? [...messages, assistant]
      : [
          ...messages,
          { role: 'user', content: input.run.question, researchAgentRunId: input.run.id },
          assistant,
        ]
    updateSessionMessages(db, session.id, next)
  })
  transaction()
}

function toRunSummary(run: ResearchAgentRunRow): ResearchAgentRunSummaryView {
  const budget = researchAgentBudgetForRun(run)
  return {
    id: run.id,
    requestId: run.request_id,
    parentRunId: run.parent_run_id,
    runKind: run.run_kind,
    discussionSessionId: run.discussion_session_id,
    question: run.question,
    subjects: parseResearchAgentTrustedSubjects(safeJson(run.subjects_json)) as ResearchAgentSubjectView[],
    includePortfolio: run.include_portfolio === 1,
    asOf: run.as_of,
    status: run.status,
    phase: run.phase,
    outcome: run.outcome,
    resultSemantics: researchResultSemantics(run),
    provider: run.provider,
    model: run.model,
    modelCallCount: run.model_call_count,
    toolCallCount: run.tool_call_count,
    budgetVersion: budget.id,
    maxModelCalls: budget.maxModelCalls,
    maxToolCalls: budget.maxToolCalls,
    maxDurationMs: budget.maxDurationMs,
    inputTokens: run.input_tokens,
    outputTokens: run.output_tokens,
    totalTokens: run.total_tokens,
    usageStatus: run.usage_status,
    estimatedCost: run.estimated_cost,
    costCurrency: run.cost_currency,
    costStatus: run.cost_status,
    cancelRequested: run.cancel_requested === 1,
    retryable: run.retryable === 1,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    revision: run.revision,
    createdAt: run.created_at,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
  }
}

function toRunDetail(db: Database.Database, ledger: ResearchAgentRunLedger): ResearchAgentRunDetailView {
  const audit = safeJson(ledger.run.audit_json) as ResearchTextAudit | null
  const evidence = auditEvidenceFromLedger(ledger)
  const evidenceGateHistory = evidenceGateHistoryFromLedger(ledger)
  const evidenceGate = evidenceGateHistory.at(-1)?.gate ?? null
  const multiPerspective = multiPerspectiveView(db, ledger)
  const conclusionExplanation = researchConclusionExplanation(ledger.run, evidenceGate, audit, multiPerspective)
  return {
    run: toRunSummary(ledger.run),
    plan: safeJson(ledger.run.plan_json),
    reportMarkdown: ledger.run.report_markdown,
    reportSha256: ledger.run.report_sha256,
    evidenceSnapshotSha256: ledger.run.evidence_snapshot_sha256,
    outcomeExplanation: conclusionExplanation,
    conclusionExplanation,
    evidenceGate,
    evidenceGateHistory,
    reviewEligibility: {
      ...reviewEligibility(ledger),
      budget: RESEARCH_AGENT_MULTI_PERSPECTIVE_BUDGET,
    },
    retryEligibility: retryEligibility(ledger.run),
    deleteEligibility: deleteEligibility(db, ledger.run),
    multiPerspective,
    researchTrace: buildResearchAuditTraceView(audit, evidence, ledger.run.report_markdown),
    steps: ledger.steps.map((step) => ({
      id: step.id,
      ordinal: step.ordinal,
      kind: step.kind,
      status: step.status,
      attemptCount: step.attempt_count,
      outputSha256: step.output_sha256,
      errorCode: step.error_code,
      errorMessage: step.error_message,
      startedAt: step.started_at,
      completedAt: step.completed_at,
    })),
    toolCalls: ledger.toolCalls.map(projectResearchAgentToolCall),
    modelCalls: ledger.modelCalls.map((call) => ({
      id: call.id,
      purpose: call.purpose,
      attempt: call.attempt,
      status: call.status,
      provider: call.provider,
      model: call.model,
      responseId: call.response_id,
      responseSha256: call.response_sha256,
      finishReason: call.finish_reason,
      inputTokens: call.input_tokens,
      outputTokens: call.output_tokens,
      totalTokens: call.total_tokens,
      usageStatus: call.usage_status,
      estimatedCost: call.estimated_cost,
      costCurrency: call.cost_currency,
      errorCode: call.error_code,
      errorMessage: call.error_message,
    })),
  }
}

function reviewEligibility(ledger: ResearchAgentRunLedger): { eligible: boolean; reason: string | null } {
  const run = ledger.run
  if (run.run_kind !== 'single_agent') return { eligible: false, reason: '多视角复核不能再次作为来源运行' }
  if (run.status !== 'succeeded') return { eligible: false, reason: '只有已完成的单 Agent 研究可以启动多视角复核' }
  if (run.outcome === 'blocked') return { eligible: false, reason: '来源研究证据不足或审计受阻，不能启动多视角复核' }
  if (run.discussion_session_id == null) return { eligible: false, reason: '来源研究未绑定可写回的研究讨论' }
  if (!run.report_markdown || !run.report_sha256 || !run.evidence_snapshot_sha256) {
    return { eligible: false, reason: '来源研究缺少正式报告或不可变证据哈希' }
  }
  if (hashResearchAgentText(run.report_markdown.trim()) !== run.report_sha256) {
    return { eligible: false, reason: '来源研究正式报告正文与固化哈希不一致' }
  }
  const evidence = auditEvidenceFromLedger(ledger)
  if (!evidence || hashResearchEvidenceContrast(evidence) !== run.evidence_snapshot_sha256) {
    return { eligible: false, reason: '来源研究证据产物与正式哈希不一致' }
  }
  const referenceIds = validatedResearchEvidenceReferenceIds(evidence)
  if (!referenceIds) return { eligible: false, reason: '来源研究包含无法验证的稳定证据编号' }
  if (referenceIds.length < 1) return { eligible: false, reason: '来源研究没有可供角色引用的稳定证据' }
  return { eligible: true, reason: null }
}

function retryEligibility(run: ResearchAgentRunRow): { eligible: boolean; reason: string | null } {
  if (run.run_kind !== 'single_agent') {
    return { eligible: false, reason: '多视角复核不支持作为深度研究重试来源' }
  }
  if (['queued', 'running', 'paused'].includes(run.status)) {
    return { eligible: false, reason: '当前研究仍可继续或取消，无需创建新的重试账本' }
  }
  if (run.status === 'failed' && run.retryable === 1) {
    return { eligible: false, reason: '该失败可以从原账本继续，无需创建新的重试账本' }
  }
  if (run.status === 'succeeded' && run.outcome === 'complete') {
    return { eligible: false, reason: '研究已经完整完成' }
  }
  if (run.discussion_session_id == null) {
    return { eligible: false, reason: '来源研究没有可复用的受信讨论' }
  }
  return { eligible: true, reason: null }
}

function deleteEligibility(
  db: Database.Database,
  run: ResearchAgentRunRow,
): { eligible: boolean; reason: string | null } {
  if (['queued', 'running', 'paused'].includes(run.status)) {
    return { eligible: false, reason: '活动中的研究必须先取消' }
  }
  const dependentReview = db.prepare(`
    SELECT id FROM research_agent_runs
    WHERE parent_run_id = ? AND run_kind = 'multi_perspective'
    LIMIT 1
  `).get(run.id) as { id: string } | undefined
  if (dependentReview) {
    return { eligible: false, reason: '该研究仍有直接依赖的多视角复核，请先删除复核记录' }
  }
  return { eligible: true, reason: null }
}

function researchResultSemantics(run: ResearchAgentRunRow): ResearchAgentResultSemanticsView {
  const execution = run.status === 'succeeded' ? 'completed' : run.status
  const executionLabel: Record<ResearchAgentResultSemanticsView['execution'], string> = {
    queued: '等待启动',
    running: '运行中',
    paused: '已暂停',
    needs_attention: '需处理',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  if (run.status === 'succeeded') {
    if (run.outcome === 'complete') {
      return { execution, executionLabel: executionLabel[execution], conclusionCoverage: 'complete', conclusionLabel: '结论覆盖完整' }
    }
    if (run.outcome === 'partial') {
      return { execution, executionLabel: executionLabel[execution], conclusionCoverage: 'limited', conclusionLabel: '结论覆盖受限' }
    }
    return { execution, executionLabel: executionLabel[execution], conclusionCoverage: 'blocked', conclusionLabel: '结论形成受阻' }
  }
  if (['queued', 'running', 'paused'].includes(run.status)) {
    return { execution, executionLabel: executionLabel[execution], conclusionCoverage: 'pending', conclusionLabel: '结论待形成' }
  }
  return { execution, executionLabel: executionLabel[execution], conclusionCoverage: 'unavailable', conclusionLabel: '未形成结论' }
}

function researchConclusionExplanation(
  run: ResearchAgentRunRow,
  evidenceGate: ResearchAgentEvidenceGateResult | null,
  audit: ResearchTextAudit | null,
  multiPerspective: ResearchAgentRunDetailView['multiPerspective'],
): string | null {
  if (run.status !== 'succeeded' || run.outcome !== 'partial') return null
  if (run.run_kind === 'multi_perspective') {
    const unknownCount = multiPerspective?.moderator?.unknowns.length ?? 0
    const unknownSummary = unknownCount > 0 ? `仍有${unknownCount}项关键事实需要补证。` : '当前父证据仍不足以覆盖全部核心问题。'
    return `多视角复核已完整执行，双方在当前证据范围内已完成交锋与主持汇总；${unknownSummary}多视角只复用来源运行的不可变证据，增加争论轮次不会补造缺失事实。`
  }
  const failedChecks = evidenceGate?.checks.filter((check) => check.status === 'failed') ?? []
  const auditBlocked = audit?.status === 'blocked'
  if (failedChecks.length > 0) {
    const auditNote = auditBlocked ? '，且确定性审计发现结论边界或证据引用未完全通过' : ''
    return `研究流程已完整执行。最终证据核验仍有${failedChecks.length}项硬缺口${auditNote}，因此报告的结论覆盖受限；这不代表运行失败或模型、工具调用次数截断。具体缺口和规则可在“证据”中查看。`
  }
  if (auditBlocked) {
    return '研究流程已完整执行并生成报告，但确定性审计发现结论边界或证据引用未完全通过，因此结论覆盖受限；这不代表运行失败或模型调用次数截断。具体规则可在“证据”中查看。'
  }
  return '研究流程已完整执行，证据评估与确定性审计均已通过。当前报告已经形成可追溯结论，但部分核心问题仍需“未知项/继续验证清单”中的资料，因此结论覆盖受限；这不代表运行失败或模型、工具调用次数截断。'
}

function multiPerspectiveView(
  db: Database.Database,
  ledger: ResearchAgentRunLedger,
): ResearchAgentRunDetailView['multiPerspective'] {
  if (ledger.run.run_kind !== 'multi_perspective' || !ledger.run.parent_run_id) return null
  const sourceLedger = getResearchAgentRunLedger(db, ledger.run.parent_run_id)
  const evidence = sourceLedger ? auditEvidenceFromLedger(sourceLedger) : null
  const sourceHash = sourceLedger?.run.evidence_snapshot_sha256 ?? null
  const sourceReport = sourceLedger?.run.report_markdown ?? null
  const sourceReportHash = sourceLedger?.run.report_sha256 ?? null
  const referenceIds = validatedResearchEvidenceReferenceIds(evidence)
  if (
    !evidence
    || !sourceHash
    || hashResearchEvidenceContrast(evidence) !== sourceHash
    || !sourceReport
    || !sourceReportHash
    || hashResearchAgentText(sourceReport.trim()) !== sourceReportHash
    || !referenceIds
  ) return null
  const allowed = new Set(referenceIds)
  const parseRole = (value: unknown, role: 'bull' | 'bear') => {
    if (!isRecord(value)) return null
    try {
      const parsed = value.protocolVersion === MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION
        ? parseMultiPerspectiveUnrestrictedRoleAction(JSON.stringify(value), role, allowed)
        : value.protocolVersion === MULTI_PERSPECTIVE_PROTOCOL_VERSION
          ? parseMultiPerspectiveRoleAction(JSON.stringify(value), role, allowed)
          : null
      if (!parsed) return null
      const { rationale: _rationale, ...projected } = parsed
      return projected
    } catch {
      return null
    }
  }
  const roleStep = ledger.steps.find((item) => item.kind === 'tooling' && item.status === 'succeeded')
  const roleArtifact = safeJson(roleStep?.artifact_json ?? null)
  const legacyRoleCall = (purpose: 'bull_case' | 'bear_case') => {
    const response = ledger.modelCalls.find((item) => item.purpose === purpose && item.status === 'succeeded')?.response_text
    return safeJson(response ?? null)
  }
  const bull = parseRole(isRecord(roleArtifact) ? roleArtifact.bull : legacyRoleCall('bull_case'), 'bull')
  const bear = parseRole(isRecord(roleArtifact) ? roleArtifact.bear : legacyRoleCall('bear_case'), 'bear')
  const synthesisStep = ledger.steps.find((item) => item.kind === 'synthesis' && item.status === 'succeeded')
  const synthesisArtifact = safeJson(synthesisStep?.artifact_json ?? null)
  const moderatorCall = ledger.modelCalls.find((item) => item.purpose === 'moderator' && item.status === 'succeeded')?.response_text
  const moderatorValue = isRecord(synthesisArtifact) ? synthesisArtifact.moderator : safeJson(moderatorCall ?? null)
  let moderator: Omit<MultiPerspectiveModeratorAction | MultiPerspectiveUnrestrictedModeratorAction, 'rationale'> | null = null
  if (isRecord(moderatorValue)) {
    try {
      const parsed = moderatorValue.protocolVersion === MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION
        ? parseMultiPerspectiveUnrestrictedModeratorAction(JSON.stringify(moderatorValue), allowed)
        : moderatorValue.protocolVersion === MULTI_PERSPECTIVE_PROTOCOL_VERSION
          ? parseMultiPerspectiveModeratorAction(JSON.stringify(moderatorValue), allowed)
          : null
      if (parsed) {
        const { rationale: _rationale, ...projected } = parsed
        moderator = projected
      }
    } catch {
      moderator = null
    }
  }
  const auditStep = ledger.steps.find((item) => item.kind === 'audit' && item.status === 'succeeded')
  const auditArtifact = safeJson(auditStep?.artifact_json ?? null)
  const qualityValue = isRecord(auditArtifact) && isRecord(auditArtifact.quality) && auditArtifact.quality.schemaVersion === 1
    ? auditArtifact.quality as unknown as MultiPerspectiveQualitySummary
    : null
  return {
    sourceRunId: ledger.run.parent_run_id,
    evidenceSnapshotSha256: sourceHash,
    bull,
    bear,
    moderator,
    quality: qualityValue,
  }
}

export function getResearchAgentAuditContext(
  db: Database.Database,
  runId: string,
): { audit: ResearchTextAudit; evidenceContrast: ResearchEvidenceContrast; reportMarkdown: string } | null {
  const ledger = getResearchAgentRunLedger(db, runId)
  if (!ledger?.run.report_markdown) return null
  const audit = safeJson(ledger.run.audit_json)
  const evidenceContrast = auditEvidenceFromLedger(ledger)
  if (!isRecord(audit) || !evidenceContrast) return null
  return { audit: audit as unknown as ResearchTextAudit, evidenceContrast, reportMarkdown: ledger.run.report_markdown }
}

function auditEvidenceFromLedger(ledger: ResearchAgentRunLedger): ResearchEvidenceContrast | null {
  const step = ledger.steps.find((item) => item.kind === 'audit' && item.status === 'succeeded')
  const artifact = safeJson(step?.artifact_json ?? null)
  return isRecord(artifact) && isRecord(artifact.evidenceContrast)
    ? artifact.evidenceContrast as unknown as ResearchEvidenceContrast
    : null
}

function evidenceGateHistoryFromLedger(
  ledger: ResearchAgentRunLedger,
): ResearchAgentRunDetailView['evidenceGateHistory'] {
  const networkStepIds = new Set(
    ledger.toolCalls.filter((call) => isNetworkToolId(call.tool_id)).map((call) => call.step_id),
  )
  const history: ResearchAgentRunDetailView['evidenceGateHistory'] = []
  let networkStarted = false
  for (const step of ledger.steps.filter((item) => item.kind === 'tooling' || item.kind === 'synthesis')) {
    if (networkStepIds.has(step.id)) networkStarted = true
    for (const payload of [safeJson(step.artifact_json), safeJson(step.input_json)]) {
      if (!isRecord(payload) || !isResearchAgentEvidenceGate(payload.evidenceGate)) continue
      const gate = payload.evidenceGate as unknown as ResearchAgentEvidenceGateResult
      const previous = history.at(-1)
      if (previous && JSON.stringify(previous.gate) === JSON.stringify(gate)) continue
      history.push({
        stepId: step.id,
        stage: networkStarted ? 'network' : 'local',
        decisionRound: step.kind === 'tooling' && typeof payload.decisionRound === 'number'
          ? payload.decisionRound
          : null,
        gate,
      })
      break
    }
  }
  return history.slice(-6)
}

function isResearchAgentEvidenceGate(value: unknown): boolean {
  return isRecord(value)
    && value.schemaVersion === 1
    && (
      value.ruleVersion === RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION
      || value.ruleVersion === RESEARCH_AGENT_EVIDENCE_GATE_PREVIOUS_RULE_VERSION
      || value.ruleVersion === RESEARCH_AGENT_EVIDENCE_GATE_LEGACY_RULE_VERSION
    )
    && (value.decision === 'local_sufficient' || value.decision === 'network_required')
    && Array.isArray(value.checks)
}

function projectResearchAgentToolCall(
  call: ResearchAgentRunLedger['toolCalls'][number],
): ResearchAgentRunDetailView['toolCalls'][number] {
  const input = recordValue(safeJson(call.input_json))
  const envelope = recordValue(safeJson(call.envelope_json))
  const data = recordValue(envelope?.data)
  const candidates = Array.isArray(data?.candidates)
    ? data.candidates.flatMap((candidate) => projectCandidate(candidate)).slice(0, 8)
    : []
  const document = projectDocument(data?.document)
  const network = projectNetworkEnvelope(data?.networkEnvelope)
  const failure = projectToolFailure(call.status, call.error_code, call.error_message)
  return {
    id: call.id,
    toolId: call.tool_id,
    attempt: call.attempt,
    status: call.status,
    envelopeSha256: call.envelope_sha256,
    modelProjectionSha256: call.model_projection_sha256,
    stableReferences: arrayJson(call.stable_references_json),
    factDate: call.fact_date,
    sources: arrayJson(call.sources_json),
    coverage: recordJson(call.coverage_json),
    warnings: arrayJson(call.warnings_json),
    scope: isNetworkToolId(call.tool_id) ? 'network' : 'local',
    kind: toolCallKind(call.tool_id),
    request: {
      query: boundedText(input?.query, 300),
      candidateId: boundedText(input?.candidateId, 40),
      stockCode: boundedText(input?.stockCode, 16),
      requestedLimit: boundedIntegerView(input?.maxResults ?? input?.limit),
    },
    searchProvider: boundedText(data?.providerId, 40),
    candidates,
    document,
    network,
    failure,
    durationMs: call.duration_ms,
    errorCode: call.error_code,
    errorMessage: call.error_message,
  }
}

function projectCandidate(value: unknown): ResearchAgentRunDetailView['toolCalls'][number]['candidates'] {
  const candidate = recordValue(value)
  const sourceClass = sourceClassValue(candidate?.sourceClass)
  const url = safeDisplayUrl(candidate?.url)
  const candidateId = boundedText(candidate?.candidateId, 40)
  const title = boundedText(candidate?.title, 300)
  const domain = boundedText(candidate?.domain, 255)
  if (!candidateId || !title || !domain || !url || !sourceClass) return []
  return [{
    candidateId,
    title,
    url,
    domain,
    snippet: boundedText(candidate?.snippet, 800),
    publishedAt: boundedText(candidate?.publishedAt, 40),
    sourceClass,
  }]
}

function projectDocument(value: unknown): ResearchAgentRunDetailView['toolCalls'][number]['document'] {
  const document = recordValue(value)
  const sourceClass = sourceClassValue(document?.sourceClass)
  const finalUrl = safeDisplayUrl(document?.finalUrl)
  const candidateId = boundedText(document?.candidateId, 40)
  const title = boundedText(document?.title, 300)
  const sourceDomain = boundedText(document?.sourceDomain, 255)
  const fetchedAt = finiteNumberView(document?.fetchedAt)
  const excerpt = boundedText(document?.excerpt, 4_000)
  const contentSha256 = hashValue(document?.contentSha256)
  const rawBodySha256 = hashValue(document?.rawBodySha256)
  const mimeKind = boundedText(document?.mimeKind, 40)
  if (!sourceClass || !finalUrl || !candidateId || !title || !sourceDomain || fetchedAt == null || !excerpt || !contentSha256 || !rawBodySha256 || !mimeKind) return null
  return {
    candidateId,
    title,
    finalUrl,
    sourceDomain,
    sourceClass,
    primarySourceConfirmed: document?.primarySourceConfirmed === true,
    publishedAt: boundedText(document?.publishedAt, 40),
    fetchedAt,
    excerpt,
    excerptTruncated: document?.excerptTruncated === true,
    contentSha256,
    rawBodySha256,
    mimeKind,
  }
}

function projectNetworkEnvelope(value: unknown): ResearchAgentRunDetailView['toolCalls'][number]['network'] {
  const envelope = recordValue(value)
  const request = recordValue(envelope?.request)
  const response = recordValue(envelope?.response)
  const requestHost = safeUrlHost(request?.url)
  const finalHost = safeUrlHost(response?.finalUrl)
  const method = boundedText(request?.method, 12)
  const statusCode = boundedIntegerView(response?.statusCode)
  const mimeKind = boundedText(response?.mimeKind, 40)
  const fetchedAt = finiteNumberView(response?.fetchedAt)
  const decodedBytes = boundedIntegerView(response?.decodedBytes)
  const bodySha256 = hashValue(response?.bodySha256)
  if (!requestHost || !finalHost || !method || statusCode == null || !mimeKind || fetchedAt == null || decodedBytes == null || !bodySha256) return null
  return {
    method,
    requestHost,
    finalHost,
    statusCode,
    mimeKind,
    fetchedAt,
    decodedBytes,
    redirectCount: Array.isArray(envelope?.hops) ? Math.max(0, envelope.hops.length - 1) : 0,
    bodySha256,
  }
}

function projectToolFailure(
  status: string,
  errorCode: string | null,
  errorMessage: string | null,
): ResearchAgentRunDetailView['toolCalls'][number]['failure'] {
  if (!errorCode && !errorMessage && !['cancelled', 'outcome_unknown'].includes(status)) return null
  const code = (errorCode || (status === 'cancelled' ? 'CANCELLED' : 'TOOL_FAILED')).slice(0, 120)
  const message = (errorMessage || (status === 'outcome_unknown' ? '请求已提交，但结果无法确认。' : '工具调用未完成。')).slice(0, 500)
  const resultUnknown = status === 'outcome_unknown'
  let category: NonNullable<ResearchAgentRunDetailView['toolCalls'][number]['failure']>['category'] = 'tool'
  if (resultUnknown) category = 'outcome_unknown'
  else if (status === 'cancelled' || /CANCEL/i.test(code)) category = 'cancelled'
  else if (code === 'NETWORK_RATE_LIMITED') category = 'rate_limited'
  else if (/NOT_CONFIGURED|CONFIG_INVALID/.test(code)) category = 'configuration'
  else if (/SUBJECT_DENIED|CANDIDATE_NOT_AUTHORIZED|URL_INVALID|PROTOCOL_NOT_ALLOWED|HOST_BLOCKED|REDIRECT_(?:INVALID|UNSAFE)|DNS_REBIND/.test(code)) category = 'security'
  else if (code.startsWith('NETWORK_') || /_FETCH_FAILED|_REFRESH_FAILED|_PROVIDER_FAILED/.test(code)) category = 'network'
  return {
    category,
    resultUnknown,
    retryable: !resultUnknown && category !== 'cancelled' && category !== 'security' && category !== 'configuration',
    code,
    message,
  }
}

function isNetworkToolId(toolId: string): boolean {
  return RESEARCH_AGENT_NETWORK_TOOL_DEFINITIONS.some((tool) => tool.id === toolId)
}

function toolCallKind(toolId: string): ResearchAgentRunDetailView['toolCalls'][number]['kind'] {
  if (toolId === 'web.search' || toolId === 'official.disclosure_search') return 'search'
  if (toolId === 'web.fetch_page' || toolId === 'official.disclosure_document') return 'document'
  return isNetworkToolId(toolId) ? 'refresh' : 'local'
}

function sourceClassValue(value: unknown): 'official' | 'primary' | 'secondary' | null {
  return value === 'official' || value === 'primary' || value === 'secondary' ? value : null
}

function safeDisplayUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth|authorization|credential|password|secret|signature|token)(?:$|[_-])/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]')
      }
    }
    url.hash = ''
    return url.toString().slice(0, 1_000)
  } catch {
    return null
  }
}

function safeUrlHost(value: unknown): string | null {
  const url = safeDisplayUrl(value)
  if (!url) return null
  try { return new URL(url).host.slice(0, 255) } catch { return null }
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function boundedIntegerView(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function finiteNumberView(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function hashValue(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function parseConversationMessages(value: string | null): ConversationMessage[] {
  const parsed = safeJson(value)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((message): message is ConversationMessage => (
    isRecord(message)
    && (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
  )).slice(0, 500)
}

function requireRun(db: Database.Database, runId: string): ResearchAgentRunRow {
  const run = getResearchAgentRun(db, runId)
  if (!run) throw new ResearchAgentRunManagerError('NOT_FOUND', '研究运行不存在')
  return run
}

function researchAgentStatusLabel(status: ResearchAgentRunStatus): string {
  return {
    queued: '等待显式启动',
    running: '正在执行',
    paused: '已暂停，等待显式继续',
    needs_attention: '模型调用结果不确定，需要处理',
    succeeded: '研究运行已完成',
    failed: '研究运行失败',
    cancelled: '研究运行已取消',
  }[status]
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return null }
}

function safeRecordJson(value: string): Record<string, unknown> | null {
  const parsed = safeJson(value)
  return isRecord(parsed) ? parsed : null
}

function arrayJson(value: string): unknown[] {
  const parsed = safeJson(value)
  return Array.isArray(parsed) ? parsed : []
}

function recordJson(value: string): Record<string, unknown> {
  const parsed = safeJson(value)
  return isRecord(parsed) ? parsed : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
