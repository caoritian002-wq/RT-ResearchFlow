import type Database from 'better-sqlite3'
import type { ResearchAgentRunRow, ResearchAgentToolCallRow } from '../database/types'
import {
  createResearchAgentToolCall,
  getResearchAgentRun,
  getResearchAgentRunLedger,
  researchAgentBudgetForRun,
  RESEARCH_AGENT_STANDARD_BUDGET,
  ResearchAgentRunRepositoryError,
  serializeResearchAgentJson,
  transitionResearchAgentToolCallStatus,
} from '../database/researchAgentRunRepository'
import {
  executeResearchFactToolUnsafe,
  RESEARCH_FACT_TOOL_DEFINITIONS,
  type ResearchFactToolEnvelope,
} from './researchFactToolRegistry'
import {
  executeResearchAgentNetworkTool,
  isResearchAgentDocumentToolId,
  isResearchAgentNetworkToolId,
  isResearchAgentSearchToolId,
  RESEARCH_AGENT_NETWORK_TOOL_DEFINITIONS,
  RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
  ResearchAgentNetworkToolError,
  type ResearchAgentNetworkToolDependencies,
  type ResearchAgentToolDefinition,
} from './researchAgentNetworkTools'
import {
  getResearchEvidenceReferenceId,
  type ResearchEvidenceSubjectKind,
} from './researchEvidenceAuditService'

export const RESEARCH_AGENT_INTERNAL_TOOL_IDENTITY = 'internal.single_agent'

const TOOL_DEFINITIONS = new Map<string, ResearchAgentToolDefinition>(
  [...RESEARCH_FACT_TOOL_DEFINITIONS, ...RESEARCH_AGENT_NETWORK_TOOL_DEFINITIONS]
    .map((definition) => [definition.id, definition]),
)
const STOCK_TOOL_IDS = new Set<string>([
  'stock.price_history',
  'stock.trend_snapshot',
  'stock.fundamentals',
  'stock.announcements',
  'company.fundamentals_refresh',
  'market.price_refresh',
  'market.quote_snapshot',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type ResearchAgentTrustedSubject =
  | { kind: 'stock'; tsCode: string; label: string | null }
  | { kind: 'industry_project'; id: string; label: string | null }

export interface ResearchAgentStableToolReference {
  referenceId: string
  subjectKind: ResearchEvidenceSubjectKind
  subjectId: string
  toolId: string
  code: string
  label: string
  status: ResearchAgentToolEnvelope['status']
  factDate: string | null
  sourceIds: string[]
}

export interface ResearchAgentToolModelProjection {
  schemaVersion: 1
  identity: typeof RESEARCH_AGENT_INTERNAL_TOOL_IDENTITY
  toolId: string
  status: ResearchAgentToolEnvelope['status']
  asOf: string | null
  sources: ResearchAgentToolEnvelope['sources']
  coverage: ResearchAgentToolEnvelope['coverage']
  warnings: string[]
  evidenceReferences: ResearchAgentStableToolReference[]
  data: unknown
  truncated: boolean
}

export interface ExecuteResearchAgentToolInput {
  runId: string
  stepId: string
  leaseOwner: string
  toolId: string
  toolInput: unknown
  callId?: string
  attempt?: number
  reuseSucceeded?: boolean
  executionOrigin?: 'model' | 'recovery'
  now?: number
}

export interface ExecuteResearchAgentToolResult {
  call: ResearchAgentToolCallRow
  reused: boolean
  envelope: ResearchAgentToolEnvelope | null
}

export interface ResearchAgentToolServiceOptions {
  timeoutMs?: number
  networkTimeoutMs?: number
  signal?: AbortSignal
  executeTool?: (
    db: Database.Database,
    toolId: string,
    input: unknown,
    options: { now: number },
  ) => ReturnType<typeof executeResearchFactToolUnsafe> | Promise<ReturnType<typeof executeResearchFactToolUnsafe>>
  executeNetworkTool?: typeof executeResearchAgentNetworkTool
  networkToolDependencies?: ResearchAgentNetworkToolDependencies
}

interface PolicyDecision {
  ok: boolean
  code?: string
  message?: string
  definition?: ResearchAgentToolDefinition
  subjects?: ResearchAgentTrustedSubject[]
}

type ResearchAgentToolEnvelope = ResearchFactToolEnvelope<string, unknown>

export class ResearchAgentToolServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ResearchAgentToolServiceError'
  }
}

export function parseResearchAgentTrustedSubjects(value: unknown): ResearchAgentTrustedSubject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new ResearchAgentToolServiceError('INVALID_SUBJECTS', '研究主体必须包含1至5项')
  }
  const subjects = value.map((item): ResearchAgentTrustedSubject => {
    if (!isRecord(item)) {
      throw new ResearchAgentToolServiceError('INVALID_SUBJECTS', '研究主体必须是对象')
    }
    const label = typeof item.label === 'string' && item.label.trim()
      ? item.label.trim().slice(0, 160)
      : null
    if (item.kind === 'stock') {
      const tsCode = normalizeStockCode(item.tsCode)
      if (!tsCode) throw new ResearchAgentToolServiceError('INVALID_SUBJECTS', '股票主体必须使用规范A股ts_code')
      return { kind: 'stock', tsCode, label }
    }
    if (item.kind === 'industry_project' && typeof item.id === 'string' && UUID_PATTERN.test(item.id)) {
      return { kind: 'industry_project', id: item.id.toLowerCase(), label }
    }
    throw new ResearchAgentToolServiceError('INVALID_SUBJECTS', '只允许已确认的股票或产业项目主体')
  })
  const kinds = new Set(subjects.map((subject) => subject.kind))
  if (kinds.size !== 1) {
    throw new ResearchAgentToolServiceError('MIXED_SUBJECTS', '同一运行不得混合股票与产业项目主体')
  }
  if (subjects[0]?.kind === 'industry_project' && subjects.length !== 1) {
    throw new ResearchAgentToolServiceError('INVALID_SUBJECTS', '产业研究运行只能绑定一个项目')
  }
  const identities = subjects.map((subject) => subject.kind === 'stock' ? subject.tsCode : subject.id)
  if (new Set(identities).size !== identities.length) {
    throw new ResearchAgentToolServiceError('INVALID_SUBJECTS', '研究主体不得重复')
  }
  return subjects
}

export function listAvailableResearchAgentTools(
  run: ResearchAgentRunRow,
  options: { includeNetwork?: boolean } = {},
): readonly ResearchAgentToolDefinition[] {
  const subjects = parseRunSubjects(run)
  const hasStocks = subjects.some((subject) => subject.kind === 'stock')
  const hasProject = subjects.some((subject) => subject.kind === 'industry_project')
  const judgmentIds = trustedJudgmentIds(run.context_snapshot_json)
  const local = RESEARCH_FACT_TOOL_DEFINITIONS.filter((definition) => {
    if (STOCK_TOOL_IDS.has(definition.id)) return hasStocks
    if (definition.id === 'industry.project_snapshot') return hasProject
    if (definition.id === 'decision.judgment_history') return judgmentIds.size > 0
    if (definition.id === 'portfolio.holdings') return run.include_portfolio === 1
    return definition.id === 'news.recent_briefings'
  })
  if (options.includeNetwork === false) return local
  const network = RESEARCH_AGENT_NETWORK_TOOL_DEFINITIONS.filter((definition) => {
    if (STOCK_TOOL_IDS.has(definition.id)) return hasStocks
    if (definition.id === 'official.disclosure_search' || definition.id === 'official.disclosure_document') {
      return hasStocks || hasProject
    }
    return definition.id === 'web.search' || definition.id === 'web.fetch_page'
  }).map((definition): ResearchAgentToolDefinition => {
    if (definition.id !== 'official.disclosure_search' || hasStocks || !hasProject) return definition
    return {
      ...definition,
      description: `${definition.description} 产业项目运行只能使用项目名称查询，不得提交或猜测股票代码。`,
      inputSchema: {
        ...definition.inputSchema,
        properties: Object.fromEntries(
          Object.entries(definition.inputSchema.properties).filter(([name]) => name !== 'stockCode'),
        ),
      },
    }
  })
  return [...local, ...network]
}

export async function executeResearchAgentTool(
  db: Database.Database,
  input: ExecuteResearchAgentToolInput,
  options: ResearchAgentToolServiceOptions = {},
): Promise<ExecuteResearchAgentToolResult> {
  const startedAt = input.now ?? Date.now()
  const run = getResearchAgentRun(db, input.runId)
  if (!run) throw new ResearchAgentToolServiceError('RUN_NOT_FOUND', '研究运行不存在')
  const executionOrigin = input.executionOrigin ?? 'model'
  const publicToolInput = authoritativeToolInput(run, input.toolId, input.toolInput)
  const preparedInput = executionOrigin === 'recovery' && isRecord(publicToolInput)
    ? { ...publicToolInput, __executionOrigin: 'recovery' }
    : publicToolInput
  const preparedInputHash = serializeResearchAgentJson(
    preparedInput,
    64 * 1024,
  ).sha256
  const publicInputHash = serializeResearchAgentJson(
    publicToolInput,
    64 * 1024,
  ).sha256
  const existingCalls = getResearchAgentRunLedger(db, run.id)?.toolCalls ?? []
  const previousAttempts = existingCalls
    .filter((call) => (
      call.step_id === input.stepId
      && call.tool_id === input.toolId
      && call.input_sha256 === preparedInputHash
      && call.as_of === run.as_of
    ))
    .sort((left, right) => right.attempt - left.attempt)
  const previous = previousAttempts[0]
  if (previous?.status === 'succeeded') {
    return { call: previous, reused: true, envelope: parseStoredEnvelope(previous) }
  }
  if (previous?.status === 'submitted') {
    transitionResearchAgentToolCallStatus(db, {
      callId: previous.id,
      leaseOwner: input.leaseOwner,
      toStatus: 'outcome_unknown',
      errorCode: 'PROCESS_INTERRUPTED_AFTER_SUBMIT',
      errorMessage: '联网请求已提交但没有可验证完整响应，禁止在同一运行自动重放',
      now: startedAt,
    })
    throw new ResearchAgentToolServiceError('TOOL_OUTCOME_UNKNOWN', '联网工具结果不确定，运行需要人工处理')
  }
  if (previous?.status === 'outcome_unknown') {
    throw new ResearchAgentToolServiceError('TOOL_OUTCOME_UNKNOWN', '联网工具结果不确定，运行需要人工处理')
  }
  const previousEquivalentSuccess = existingCalls.find((call) => (
    call.tool_id === input.toolId
    && call.as_of === run.as_of
    && call.status === 'succeeded'
    && publicToolCallInputSha256(call) === publicInputHash
  ))
  if (previousEquivalentSuccess) {
    return { call: previousEquivalentSuccess, reused: true, envelope: parseStoredEnvelope(previousEquivalentSuccess) }
  }
  if (previous?.status === 'blocked' || previous?.status === 'cancelled') {
    return { call: previous, reused: false, envelope: parseStoredEnvelope(previous) }
  }
  const previousTerminalFailure = existingCalls.find((call) => (
    call.tool_id === input.toolId
    && call.as_of === run.as_of
    && call.status === 'failed'
    && isTerminalToolFailure(call.error_code)
    && publicToolCallInputSha256(call) === publicInputHash
  ))
  if (previousTerminalFailure) {
    return { call: previousTerminalFailure, reused: true, envelope: null }
  }
  let callId = input.callId
  let attempt = input.attempt
  if (previous?.status === 'prepared') {
    callId = previous.id
    attempt = previous.attempt
  } else if (previous?.status === 'running') {
    transitionResearchAgentToolCallStatus(db, {
      callId: previous.id,
      leaseOwner: input.leaseOwner,
      toStatus: 'failed',
      errorCode: 'PROCESS_INTERRUPTED',
      errorMessage: '上次本地工具读取在进程退出前未形成完整结果，显式继续后重新读取',
      now: startedAt,
    })
    attempt = previous.attempt + 1
  } else if (previous?.status === 'failed') {
    attempt = previous.attempt + 1
  }
  const prepared = createResearchAgentToolCall(db, {
    runId: input.runId,
    stepId: input.stepId,
    leaseOwner: input.leaseOwner,
    toolId: input.toolId,
    attempt,
    toolInput: preparedInput,
    asOf: run.as_of,
    reuseSucceeded: input.reuseSucceeded,
    id: callId,
    now: startedAt,
  })
  if (prepared.status === 'succeeded') {
    return { call: prepared, reused: true, envelope: parseStoredEnvelope(prepared) }
  }
  if (prepared.status !== 'prepared') {
    return { call: prepared, reused: false, envelope: parseStoredEnvelope(prepared) }
  }

  const policy = validateToolPolicy(db, run, prepared, publicToolInput, startedAt, executionOrigin)
  if (!policy.ok || !policy.definition || !policy.subjects) {
    const envelope = blockedEnvelope(input.toolId, startedAt, run.as_of, policy.code ?? 'POLICY_BLOCKED', policy.message ?? '工具调用被策略阻断')
    const projection = blockedProjection(input.toolId, envelope)
    const call = transitionResearchAgentToolCallStatus(db, {
      callId: prepared.id,
      leaseOwner: input.leaseOwner,
      toStatus: 'blocked',
      envelope,
      modelProjection: projection,
      stableReferences: [],
      sources: [],
      coverage: envelope.coverage,
      warnings: envelope.warnings,
      durationMs: 0,
      errorCode: policy.code ?? 'POLICY_BLOCKED',
      errorMessage: policy.message ?? '工具调用被策略阻断',
      now: startedAt,
    })
    return { call, reused: false, envelope }
  }

  if (run.cancel_requested === 1 || options.signal?.aborted) {
    const call = transitionResearchAgentToolCallStatus(db, {
      callId: prepared.id,
      leaseOwner: input.leaseOwner,
      toStatus: 'cancelled',
      errorCode: 'CANCELLED_BEFORE_DISPATCH',
      errorMessage: '工具请求在派发前已取消',
      now: startedAt,
    })
    return { call, reused: false, envelope: null }
  }

  const networkTool = isResearchAgentNetworkToolId(policy.definition.id)
  const activeCall = transitionResearchAgentToolCallStatus(db, {
    callId: prepared.id,
    leaseOwner: input.leaseOwner,
    toStatus: networkTool ? 'submitted' : 'running',
    now: startedAt,
  })
  const wallStartedAt = Date.now()
  const budget = researchAgentBudgetForRun(run)
  const timeoutMs = Math.min(
    networkTool
      ? options.networkTimeoutMs ?? options.timeoutMs ?? budget.maxNetworkToolCallDurationMs
      : options.timeoutMs ?? budget.maxToolCallDurationMs,
    networkTool
      ? budget.maxNetworkToolCallDurationMs
      : budget.maxToolCallDurationMs,
  )
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    const envelopePromise: Promise<ResearchAgentToolEnvelope> = networkTool
      ? Promise.resolve().then(() => (options.executeNetworkTool ?? executeResearchAgentNetworkTool)({
          db,
          run,
          call: activeCall,
          subjects: policy.subjects!,
          toolInput: publicToolInput as Record<string, unknown>,
          priorToolCalls: getResearchAgentRunLedger(db, run.id)?.toolCalls ?? [],
          signal: controller.signal,
          now: startedAt,
          dependencies: options.networkToolDependencies,
        }))
      : Promise.resolve().then(() => (options.executeTool ?? executeResearchFactToolUnsafe)(
          db,
          policy.definition!.id,
          publicToolInput,
          { now: startedAt },
        )) as Promise<ResearchAgentToolEnvelope>
    const envelope = await withTimeout(
      envelopePromise,
      timeoutMs,
      () => controller.abort('tool_timeout'),
      networkTool
        ? `联网工具执行超过${Math.round(timeoutMs / 1_000)}秒`
        : `本地事实工具执行超过${Math.round(timeoutMs / 1_000)}秒`,
    )
    const durationMs = Math.max(0, Date.now() - wallStartedAt)
    const completedAt = input.now == null ? Date.now() : startedAt + durationMs
    const latestRun = getResearchAgentRun(db, run.id)
    if (latestRun?.cancel_requested === 1 || options.signal?.aborted) {
      throw networkTool
        ? new ResearchAgentNetworkToolError('CANCELLED_AFTER_SUBMIT', '取消后到达的联网响应已忽略', true)
        : new ResearchAgentToolServiceError('CANCELLED', '取消后到达的本地工具结果已忽略')
    }
    if (!isResearchAgentToolEnvelope(envelope, policy.definition.id)) {
      throw new ResearchAgentToolServiceError('INVALID_TOOL_RESULT', '工具返回了无效统一信封')
    }
    const expectedAsOf = policy.definition.asOf === 'current-only' ? null : run.as_of
    if (envelope.asOf !== expectedAsOf) {
      throw new ResearchAgentToolServiceError('AS_OF_MISMATCH', '工具结果截点与运行固定截点不一致')
    }
    const references = buildStableReferences(policy.subjects, run, prepared, policy.definition.id, envelope)
    const projection = buildModelProjection(envelope, references)
    const toStatus = envelope.status === 'blocked' ? 'blocked' : 'succeeded'
    const call = transitionResearchAgentToolCallStatus(db, {
      callId: prepared.id,
      leaseOwner: input.leaseOwner,
      toStatus,
      envelope,
      modelProjection: projection,
      stableReferences: references,
      factDate: latestFactDate(envelope),
      sources: envelope.sources,
      coverage: { ...envelope.coverage },
      warnings: envelope.warnings,
      durationMs,
      errorCode: envelope.status === 'blocked' ? 'TOOL_BLOCKED' : null,
      errorMessage: envelope.status === 'blocked' ? envelope.warnings[0] ?? '工具返回阻断状态' : null,
      now: completedAt,
    })
    return { call, reused: false, envelope }
  } catch (error) {
    return failActiveToolCall(db, input, prepared.id, startedAt, wallStartedAt, error)
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

function validateToolPolicy(
  db: Database.Database,
  run: ResearchAgentRunRow,
  call: ResearchAgentToolCallRow,
  toolInput: unknown,
  now: number,
  executionOrigin: 'model' | 'recovery',
): PolicyDecision {
  const budget = researchAgentBudgetForRun(run)
  if (run.tool_registry_version !== RESEARCH_AGENT_TOOL_REGISTRY_VERSION) {
    return blocked('TOOL_REGISTRY_VERSION_MISMATCH', '运行固定工具版本与当前注册表不一致')
  }
  if (run.as_of > beijingDate(now)) return blocked('FUTURE_AS_OF', '运行事实截点不能晚于北京时间当天')
  const definition = TOOL_DEFINITIONS.get(call.tool_id)
  if (!definition) return blocked('UNKNOWN_TOOL', '未知投研事实工具')
  let subjects: ResearchAgentTrustedSubject[]
  try {
    subjects = parseRunSubjects(run)
  } catch (error) {
    return blocked(errorCode(error, 'INVALID_SUBJECTS'), errorMessage(error, '研究主体快照无效'))
  }
  const ledger = getResearchAgentRunLedger(db, run.id)
  const duplicate = ledger?.toolCalls.find((item) => (
    item.id !== call.id
    && item.status === 'succeeded'
    && item.tool_id === call.tool_id
    && item.input_sha256 === call.input_sha256
    && item.as_of === call.as_of
  ))
  if (duplicate) return blocked('DUPLICATE_SUCCESS', '同一运行中相同工具、输入与截点已有成功结果')
  const allCalls = ledger?.toolCalls ?? []
  const stepCalls = allCalls.filter((item) => item.step_id === call.step_id)
  const modelStepCalls = stepCalls.filter((item) => toolCallExecutionOrigin(item) !== 'recovery')
  const recoveryCalls = allCalls.filter((item) => toolCallExecutionOrigin(item) === 'recovery')
  if (executionOrigin === 'recovery') {
    if (!isResearchAgentDocumentToolId(call.tool_id)) {
      return blocked('RECOVERY_TOOL_DENIED', '确定性恢复只允许替换同运行已落账候选的正文抓取')
    }
    const recoveryCallsInStep = stepCalls.filter((item) => toolCallExecutionOrigin(item) === 'recovery')
    if (
      (budget.id === 'single-agent-standard-v1' && recoveryCalls.length > 2)
      || (budget.id !== 'single-agent-standard-v1' && recoveryCallsInStep.length > 2)
    ) {
      return blocked('RECOVERY_BUDGET_EXCEEDED', budget.id === 'single-agent-standard-v1'
        ? '旧版单次运行最多执行2次确定性正文恢复'
        : '单轮最多执行2次确定性正文恢复')
    }
  }
  if (modelStepCalls.length > budget.maxToolsPerDecision) {
    return blocked('TOOL_ROUND_BUDGET_EXCEEDED', '单轮最多执行2个工具')
  }
  const decisionSteps = new Set(allCalls
    .filter((item) => toolCallExecutionOrigin(item) !== 'recovery')
    .map((item) => item.step_id))
  if (budget.maxToolDecisionRounds != null && decisionSteps.size > budget.maxToolDecisionRounds) {
    return blocked('TOOL_DECISION_BUDGET_EXCEEDED', '工具决策最多4轮')
  }
  const schemaError = validateInputSchema(toolInput, definition.inputSchema)
  if (schemaError) return blocked('INVALID_INPUT', schemaError)
  if (!isRecord(toolInput)) return blocked('INVALID_INPUT', '工具输入必须是对象')
  if (definition.asOf === 'supported' && toolInput.asOf !== run.as_of) {
    return blocked('AS_OF_MISMATCH', '工具输入必须使用运行固定事实截点')
  }
  if (definition.asOf === 'current-only' && 'asOf' in toolInput) {
    return blocked('INVALID_INPUT', '当前快照工具不得伪装为历史截点')
  }
  if (definition.id === 'stock.price_history') {
    const limit = typeof toolInput.limit === 'number' ? toolInput.limit : 30
    const minBars = typeof toolInput.minBars === 'number' ? toolInput.minBars : 10
    if (minBars > limit) return blocked('INVALID_INPUT', 'minBars不得大于limit')
  }
  if (STOCK_TOOL_IDS.has(definition.id)) {
    const requested = normalizeStockCode(toolInput.stockCode)
    const allowed = new Set(subjects.filter(isStockSubject).map((subject) => subject.tsCode))
    if (!requested || !allowed.has(requested)) return blocked('SUBJECT_DENIED', '股票工具只能访问已确认股票主体')
  }
  if (definition.id === 'official.disclosure_search' && toolInput.stockCode != null) {
    const requested = normalizeStockCode(toolInput.stockCode)
    const allowed = new Set(subjects.filter(isStockSubject).map((subject) => subject.tsCode))
    if (!requested || !allowed.has(requested)) return blocked('SUBJECT_DENIED', '正式披露搜索只能访问已确认股票主体')
  }
  if (definition.id === 'industry.project_snapshot') {
    const project = subjects.find(isIndustrySubject)
    if (!project || toolInput.projectId !== project.id) {
      return blocked('SUBJECT_DENIED', '产业项目工具只能访问已确认的唯一项目')
    }
  }
  if (definition.id === 'decision.judgment_history') {
    const allowed = trustedJudgmentIds(run.context_snapshot_json)
    if (typeof toolInput.judgmentId !== 'string' || !allowed.has(toolInput.judgmentId)) {
      return blocked('SUBJECT_DENIED', '判断工具只能访问受信讨论上下文明确绑定的判断')
    }
  }
  if (definition.id === 'portfolio.holdings' && run.include_portfolio !== 1) {
    return blocked('SCOPE_DENIED', '本次运行未确认包含持仓事实')
  }
  return { ok: true, definition, subjects }
}

function authoritativeToolInput(run: ResearchAgentRunRow, toolId: string, value: unknown): unknown {
  const definition = TOOL_DEFINITIONS.get(toolId)
  if (!definition || !isRecord(value)) return value
  const subjects = parseRunSubjects(run)
  const projectScopedDisclosureSearch = toolId === 'official.disclosure_search'
    && subjects.every((subject) => subject.kind === 'industry_project')
  const boundedValue = projectScopedDisclosureSearch
    ? Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'stockCode'))
    : value
  if (definition.asOf !== 'supported') return boundedValue
  const suppliedAsOf = normalizeAsOf(boundedValue.asOf)
  if (boundedValue.asOf == null || suppliedAsOf === run.as_of) return { ...boundedValue, asOf: run.as_of }
  return boundedValue
}

function buildStableReferences(
  subjects: ResearchAgentTrustedSubject[],
  run: ResearchAgentRunRow,
  call: ResearchAgentToolCallRow,
  toolId: string,
  envelope: ResearchAgentToolEnvelope,
): ResearchAgentStableToolReference[] {
  if (isResearchAgentSearchToolId(toolId)) return []
  if (!Number.isFinite(envelope.coverage.available) || envelope.coverage.available <= 0) return []
  if (!envelope.sources.some((source) => source.status === 'ready')) return []
  const targets = referenceTargets(subjects, run, toolId, call.input_json)
  const factDate = latestFactDate(envelope)
  const code = `agent_tool_${run.as_of}_${call.input_sha256.slice(0, 12)}`
  const label = TOOL_DEFINITIONS.get(toolId)?.description ?? toolId
  const sourceIds = envelope.sources.filter((source) => source.status === 'ready').map((source) => source.id).slice(0, 6)
  return targets.map((target) => ({
    referenceId: getResearchEvidenceReferenceId(target, { toolId, code }),
    subjectKind: target.subjectKind,
    subjectId: target.subjectId,
    toolId,
    code,
    label: label.slice(0, 160),
    status: envelope.status,
    factDate,
    sourceIds,
  }))
}

function toolCallExecutionOrigin(call: ResearchAgentToolCallRow): 'model' | 'recovery' {
  const input = safeJson(call.input_json)
  return isRecord(input) && input.__executionOrigin === 'recovery' ? 'recovery' : 'model'
}

function isTerminalToolFailure(code: string | null): boolean {
  return code === 'NETWORK_RESPONSE_TOO_LARGE'
}

function referenceTargets(
  subjects: ResearchAgentTrustedSubject[],
  run: ResearchAgentRunRow,
  toolId: string,
  inputJson: string,
): Array<{ subjectKind: ResearchEvidenceSubjectKind; subjectId: string }> {
  const input = safeJson(inputJson)
  if (STOCK_TOOL_IDS.has(toolId) && isRecord(input)) {
    const requested = normalizeStockCode(input.stockCode)
    return subjects.filter(isStockSubject).filter((subject) => subject.tsCode === requested)
      .map((subject) => ({ subjectKind: 'stock', subjectId: subject.tsCode.replace(/\.(SH|SZ|BJ)$/, '') }))
  }
  if (toolId === 'industry.project_snapshot') {
    return subjects.filter(isIndustrySubject).map((subject) => ({ subjectKind: 'industry_project', subjectId: subject.id }))
  }
  if (toolId === 'decision.judgment_history' && isRecord(input) && typeof input.judgmentId === 'string') {
    return [{ subjectKind: 'judgment', subjectId: input.judgmentId }]
  }
  const primary = subjects.map((subject) => subject.kind === 'stock'
    ? { subjectKind: 'stock' as const, subjectId: subject.tsCode.replace(/\.(SH|SZ|BJ)$/, '') }
    : { subjectKind: 'industry_project' as const, subjectId: subject.id })
  if (primary.length > 0) return primary
  const judgmentId = [...trustedJudgmentIds(run.context_snapshot_json)][0]
  return judgmentId ? [{ subjectKind: 'judgment', subjectId: judgmentId }] : []
}

function buildModelProjection(
  envelope: ResearchAgentToolEnvelope,
  references: ResearchAgentStableToolReference[],
): ResearchAgentToolModelProjection {
  const base = {
    schemaVersion: 1 as const,
    identity: RESEARCH_AGENT_INTERNAL_TOOL_IDENTITY as typeof RESEARCH_AGENT_INTERNAL_TOOL_IDENTITY,
    toolId: envelope.toolId,
    status: envelope.status,
    asOf: envelope.asOf,
    sources: envelope.sources,
    coverage: envelope.coverage,
    warnings: envelope.warnings,
    evidenceReferences: references,
  }
  for (const bounds of [
    { arrays: 24, text: 1_200 },
    { arrays: 12, text: 600 },
    { arrays: 6, text: 300 },
  ]) {
    const data = boundProjectionValue(envelope.data, bounds.arrays, bounds.text, 0)
    const projection: ResearchAgentToolModelProjection = {
      ...base,
      data,
      truncated: !deepEqualJson(data, envelope.data),
    }
    try {
      serializeResearchAgentJson(projection, RESEARCH_AGENT_STANDARD_BUDGET.maxToolProjectionBytes)
      return projection
    } catch (error) {
      if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'JSON_TOO_LARGE') throw error
    }
  }
  const data = isRecord(envelope.data)
    ? { omitted: true, keys: Object.keys(envelope.data).slice(0, 32) }
    : { omitted: true }
  return { ...base, data, truncated: true }
}

function blockedProjection(toolId: string, envelope: ReturnType<typeof blockedEnvelope>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    identity: RESEARCH_AGENT_INTERNAL_TOOL_IDENTITY,
    toolId,
    status: 'blocked',
    asOf: envelope.asOf,
    sources: [],
    coverage: envelope.coverage,
    warnings: envelope.warnings,
    evidenceReferences: [],
    data: null,
    truncated: false,
  }
}

function blockedEnvelope(toolId: string, now: number, asOf: string, code: string, message: string) {
  return {
    schemaVersion: 1 as const,
    toolId,
    status: 'blocked' as const,
    generatedAt: now,
    asOf,
    sources: [],
    coverage: { available: 0, required: null, unit: 'items' },
    warnings: [`${code}: ${message}`],
    data: null,
  }
}

function parseRunSubjects(run: ResearchAgentRunRow): ResearchAgentTrustedSubject[] {
  return parseResearchAgentTrustedSubjects(safeJson(run.subjects_json))
}

function trustedJudgmentIds(contextJson: string): Set<string> {
  const context = safeJson(contextJson)
  if (!isRecord(context)) return new Set()
  const ids = new Set<string>()
  const trustedSubjects = Array.isArray(context.trustedSubjects) ? context.trustedSubjects : []
  for (const subject of trustedSubjects) {
    if (isRecord(subject) && subject.kind === 'judgment' && typeof subject.id === 'string' && subject.id.trim()) {
      ids.add(subject.id.trim())
    }
  }
  const contextFacts = isRecord(context.contextFacts) ? context.contextFacts : null
  const invocations = contextFacts && Array.isArray(contextFacts.invocations) ? contextFacts.invocations : []
  for (const invocation of invocations) {
    if (
      isRecord(invocation)
      && invocation.subjectKind === 'judgment'
      && typeof invocation.subjectId === 'string'
      && invocation.subjectId.trim()
    ) ids.add(invocation.subjectId.trim())
  }
  return ids
}

function validateInputSchema(input: unknown, schema: ResearchAgentToolDefinition['inputSchema']): string | null {
  if (!isRecord(input)) return '工具输入必须是对象'
  const allowedKeys = new Set(Object.keys(schema.properties))
  const extra = Object.keys(input).find((key) => !allowedKeys.has(key))
  if (extra) return `工具输入包含额外字段：${extra}`
  const missing = (schema.required ?? []).find((key) => input[key] == null)
  if (missing) return `工具输入缺少必填字段：${missing}`
  for (const [key, value] of Object.entries(input)) {
    const property = schema.properties[key]
    if (!property || !matchesSchemaType(value, property.type)) return `工具字段${key}类型无效`
    if (Array.isArray(property.enum) && !property.enum.includes(value)) return `工具字段${key}不在允许枚举中`
    if (typeof value === 'string') {
      if (typeof property.maxLength === 'number' && value.length > property.maxLength) return `工具字段${key}过长`
      if (typeof property.pattern === 'string' && !(new RegExp(property.pattern).test(value))) return `工具字段${key}格式无效`
    }
    if (typeof value === 'number') {
      if (typeof property.minimum === 'number' && value < property.minimum) return `工具字段${key}低于下限`
      if (typeof property.maximum === 'number' && value > property.maximum) return `工具字段${key}超过上限`
    }
  }
  return null
}

function matchesSchemaType(value: unknown, expected: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected]
  return types.some((type) => {
    if (type === 'null') return value === null
    if (type === 'string') return typeof value === 'string'
    if (type === 'boolean') return typeof value === 'boolean'
    if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
    if (type === 'object') return isRecord(value)
    return false
  })
}

function publicToolCallInputSha256(call: ResearchAgentToolCallRow): string {
  const input = safeJson(call.input_json)
  if (!isRecord(input) || !('__executionOrigin' in input)) return call.input_sha256
  const publicInput = Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== '__executionOrigin'),
  )
  return serializeResearchAgentJson(publicInput, 64 * 1024).sha256
}

function isResearchAgentToolEnvelope(value: unknown, toolId: string): value is ResearchAgentToolEnvelope {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.toolId !== toolId) return false
  if (!['ready', 'partial', 'missing', 'blocked'].includes(String(value.status))) return false
  if (typeof value.generatedAt !== 'number' || !Number.isFinite(value.generatedAt)) return false
  if (value.asOf != null && (typeof value.asOf !== 'string' || !/^\d{8}$/.test(value.asOf))) return false
  if (!Array.isArray(value.sources) || !Array.isArray(value.warnings) || !isRecord(value.coverage)) return false
  return value.warnings.every((warning) => typeof warning === 'string')
}

function failActiveToolCall(
  db: Database.Database,
  input: ExecuteResearchAgentToolInput,
  callId: string,
  startedAt: number,
  wallStartedAt: number,
  error: unknown,
): ExecuteResearchAgentToolResult {
  const durationMs = Math.max(0, Date.now() - wallStartedAt)
  const now = input.now == null ? Date.now() : startedAt + durationMs
  const run = getResearchAgentRun(db, input.runId)
  const current = getResearchAgentRunLedger(db, input.runId)?.toolCalls.find((call) => call.id === callId)
  if (!run || !current) throw error
  const submitted = current.status === 'submitted'
  if (run.cancel_requested === 1 && (current.status === 'prepared' || current.status === 'running' || submitted)) {
    const toStatus = submitted ? 'outcome_unknown' : 'cancelled'
    const call = transitionResearchAgentToolCallStatus(db, {
      callId,
      leaseOwner: input.leaseOwner,
      toStatus,
      durationMs,
      errorCode: submitted ? 'CANCELLED_AFTER_SUBMIT' : 'CANCELLED',
      errorMessage: submitted
        ? '取消发生在联网请求提交后，结果与可能费用未知，迟到响应不会推进运行'
        : '工具调用在派发前检测到取消请求',
      now,
    })
    return { call, reused: false, envelope: null }
  }
  if (current.status !== 'running' && !submitted) throw error
  const code = error instanceof ResearchAgentToolServiceError
    ? error.code
    : error instanceof ResearchAgentNetworkToolError
      ? error.code
    : error instanceof ResearchAgentRunRepositoryError
      ? error.code
      : 'TOOL_EXECUTION_FAILED'
  if (submitted && error instanceof ResearchAgentNetworkToolError && error.outcomeUnknown) {
    transitionResearchAgentToolCallStatus(db, {
      callId,
      leaseOwner: input.leaseOwner,
      toStatus: 'outcome_unknown',
      durationMs,
      errorCode: code,
      errorMessage: errorMessage(error, '联网工具结果不确定，禁止自动重放'),
      now,
    })
    throw new ResearchAgentToolServiceError('TOOL_OUTCOME_UNKNOWN', '联网工具结果不确定，运行需要人工处理')
  }
  const call = transitionResearchAgentToolCallStatus(db, {
    callId,
    leaseOwner: input.leaseOwner,
    toStatus: 'failed',
    durationMs,
    errorCode: code,
    errorMessage: errorMessage(error, '本地事实工具执行失败'),
    now,
  })
  return { call, reused: false, envelope: null }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new ResearchAgentNetworkToolError('TOOL_TIMEOUT', message, message.includes('联网')))
    }, timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

function boundProjectionValue(value: unknown, arrayLimit: number, textLimit: number, depth: number): unknown {
  if (typeof value === 'string') return value.slice(0, textLimit)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (depth >= 8) return '[depth-limited]'
  if (Array.isArray(value)) {
    return value.slice(0, arrayLimit).map((item) => boundProjectionValue(item, arrayLimit, textLimit, depth + 1))
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => (
      [key, boundProjectionValue(item, arrayLimit, textLimit, depth + 1)]
    )))
  }
  return String(value).slice(0, textLimit)
}

function normalizeStockCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().toUpperCase().match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/)
  if (!match) return null
  const market = /^(4|8|92)/.test(match[1]) ? 'BJ' : /^(5|6|9|11)/.test(match[1]) ? 'SH' : 'SZ'
  if (match[2] && match[2] !== market) return null
  return `${match[1]}.${market}`
}

function normalizeAsOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const compact = value.trim().replace(/-/g, '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function latestFactDate(envelope: ResearchAgentToolEnvelope): string | null {
  return envelope.sources.map((source) => source.factDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
}

function beijingDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

function safeJson(value: string): unknown
function safeJson(value: unknown): unknown
function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function parseStoredEnvelope(call: ResearchAgentToolCallRow): ResearchAgentToolEnvelope | null {
  if (!call.envelope_json) return null
  const value = safeJson(call.envelope_json)
  return isResearchAgentToolEnvelope(value, call.tool_id) ? value : null
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isStockSubject(subject: ResearchAgentTrustedSubject): subject is Extract<ResearchAgentTrustedSubject, { kind: 'stock' }> {
  return subject.kind === 'stock'
}

function isIndustrySubject(subject: ResearchAgentTrustedSubject): subject is Extract<ResearchAgentTrustedSubject, { kind: 'industry_project' }> {
  return subject.kind === 'industry_project'
}

function blocked(code: string, message: string): PolicyDecision {
  return { ok: false, code, message }
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof ResearchAgentToolServiceError || error instanceof ResearchAgentRunRepositoryError
    ? error.code
    : fallback
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : fallback
}
