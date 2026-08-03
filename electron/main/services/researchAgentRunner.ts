import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { getAIConfig, getProviderConfig } from '../database/aiConfigRepository'
import {
  advanceResearchAgentRunPhase,
  createResearchAgentModelCall,
  createResearchAgentStep,
  getResearchAgentRun,
  getResearchAgentRunLedger,
  hashResearchAgentText,
  researchAgentBudgetForRun,
  RESEARCH_AGENT_JSON_LIMITS,
  RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET,
  ResearchAgentRunRepositoryError,
  saveResearchAgentRunAuditedReport,
  saveResearchAgentRunPlan,
  serializeResearchAgentJson,
  transitionResearchAgentModelCallStatus,
  transitionResearchAgentRunStatus,
  transitionResearchAgentStepStatus,
  transitionResearchAgentToolCallStatus,
  type ResearchAgentRunLedger,
} from '../database/researchAgentRunRepository'
import type {
  AIProvider,
  ResearchAgentModelCallRow,
  ResearchAgentRunOutcome,
  ResearchAgentRunPhase,
  ResearchAgentRunRow,
  ResearchAgentStepRow,
  ResearchAgentToolCallRow,
} from '../database/types'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import {
  callAIProvider,
  PROVIDER_DEFAULT_BASE_URLS,
  type AIProviderRequest,
  type AIProviderResponse,
  type ConversationTurn,
} from './aiProvider'
import { resolveProviderCredentials } from './aiFallbackService'
import {
  auditResearchText,
  buildBlockedResearchText,
  getResearchEvidenceReferenceId,
  hashResearchEvidenceContrast,
  validatedResearchEvidenceReferenceIds,
  type ResearchEvidenceContrast,
  type ResearchEvidenceItem,
  type ResearchEvidenceSubject,
  type ResearchTextAudit,
} from './researchEvidenceAuditService'
import {
  assessResearchAgentEvidence,
  selectResearchAgentAvailableEvidenceDocuments,
  selectResearchAgentEvidenceDocuments,
  type ResearchAgentEvidenceCategory,
  type ResearchAgentEvidenceGateResult,
} from './researchAgentEvidenceGate'
import {
  isResearchAgentDocumentToolId,
  isResearchAgentNetworkToolId,
  isResearchAgentSearchToolId,
  RESEARCH_AGENT_TOOL_REGISTRY_VERSION,
  type ResearchAgentToolDefinition,
} from './researchAgentNetworkTools'
import {
  buildResearchAgentPlanningMessages,
  buildResearchAgentSynthesisMessages,
  buildResearchAgentToolDecisionMessages,
  parseResearchAgentFinalAction,
  parseResearchAgentPlanAction,
  parseResearchAgentToolDecisionAction,
  RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION,
  RESEARCH_AGENT_PROTOCOL_VERSION,
  RESEARCH_AGENT_PROMPT_RULE_VERSION,
  type ResearchAgentFinalAction,
  type ResearchAgentPlanAction,
} from './researchAgentProtocol'
import {
  executeResearchAgentTool,
  listAvailableResearchAgentTools,
  parseResearchAgentTrustedSubjects,
  type ResearchAgentStableToolReference,
  type ResearchAgentToolServiceOptions,
} from './researchAgentToolService'
import {
  buildMultiPerspectiveConvergenceMessages,
  buildMultiPerspectiveModeratorMessages,
  buildMultiPerspectiveQualitySummary,
  buildMultiPerspectiveRoleMessages,
  buildMultiPerspectiveUnrestrictedModeratorMessages,
  buildMultiPerspectiveUnrestrictedRoleMessages,
  MULTI_PERSPECTIVE_PREVIOUS_UNRESTRICTED_PROMPT_RULE_VERSION,
  MULTI_PERSPECTIVE_PROMPT_RULE_VERSION,
  MULTI_PERSPECTIVE_PROTOCOL_VERSION,
  MULTI_PERSPECTIVE_TOOL_REGISTRY_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION,
  MULTI_PERSPECTIVE_UNRESTRICTED_TOOL_REGISTRY_VERSION,
  parseMultiPerspectiveConvergenceAction,
  parseMultiPerspectiveModeratorAction,
  parseMultiPerspectiveRoleAction,
  parseMultiPerspectiveUnrestrictedModeratorAction,
  parseMultiPerspectiveUnrestrictedRoleAction,
  renderMultiPerspectiveReport,
  type MultiPerspectiveConvergenceAction,
  type MultiPerspectiveModeratorAction,
  type MultiPerspectiveRole,
  type MultiPerspectiveRoleAction,
  type MultiPerspectiveUnrestrictedModeratorAction,
  type MultiPerspectiveUnrestrictedRoleAction,
} from './researchMultiPerspectiveProtocol'

const VALID_PROVIDERS = new Set<AIProvider>(['claude', 'chatgpt', 'qwen', 'deepseek'])
const EVIDENCE_REFERENCE_PATTERN = /^E-[A-F0-9]{10}$/
const MAX_MODEL_FACT_CONTEXT_BYTES = 72 * 1024
const MAX_MULTI_PERSPECTIVE_INITIAL_FACT_CONTEXT_BYTES = 64 * 1024
const MAX_MULTI_PERSPECTIVE_FOLLOW_UP_FACT_CONTEXT_BYTES = 16 * 1024
const MAX_TRUSTED_CONTEXT_BYTES = 24 * 1024

export interface ResearchAgentPinnedModelConfig {
  provider: AIProvider
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number | null
  fingerprint: string
}

export interface ResearchAgentPriceSnapshot {
  version: string
  provider: AIProvider
  model: string
  currency: string
  inputPerMillionTokens: number
  outputPerMillionTokens: number
}

export interface ResearchAgentRunnerProgress {
  runId: string
  status: ResearchAgentRunRow['status']
  phase: ResearchAgentRunPhase
  stepOrdinal: number | null
  message: string
  revision: number
  executionStartedAt: number | null
  modelCalls: { completed: number; maximum: number | null }
  toolCalls: { completed: number; maximum: number | null }
  usage: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    completeness: 'complete' | 'partial' | 'unknown'
  }
  updatedAt: number
}

export interface ResearchAgentPersistInput {
  run: ResearchAgentRunRow
  reportMarkdown: string
  evidenceContrast: ResearchEvidenceContrast
  audit: ResearchTextAudit
  outcome: ResearchAgentRunOutcome
}

export interface ResearchAgentRunnerOptions {
  modelConfig?: ResearchAgentPinnedModelConfig
  callModel?: (request: AIProviderRequest) => Promise<AIProviderResponse>
  toolService?: ResearchAgentToolServiceOptions
  signal?: AbortSignal
  now?: () => number
  modelTimeoutMs?: number
  priceSnapshot?: ResearchAgentPriceSnapshot | null
  persistReport?: (db: Database.Database, input: ResearchAgentPersistInput) => Promise<unknown> | unknown
  onProgress?: (event: ResearchAgentRunnerProgress) => void
  executionStartedAt?: number
}

export class ResearchAgentRunnerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'ResearchAgentRunnerError'
  }
}

export function researchAgentModelConfigFingerprint(input: {
  provider: AIProvider
  model: string
  baseUrl?: string | null
  maxTokens?: number | null
}): string {
  const payload = JSON.stringify({
    provider: input.provider,
    model: input.model.trim(),
    baseUrl: normalizedBaseUrl(input.provider, input.baseUrl),
    maxTokens: normalizeMaxTokens(input.maxTokens),
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function resolveCurrentResearchAgentModelConfig(
  db: Database.Database,
): ResearchAgentPinnedModelConfig | null {
  const credentials = resolveProviderCredentials(db)
  if (!credentials) return null
  const baseUrl = normalizedBaseUrl(credentials.provider, credentials.baseUrl)
  const maxTokens = normalizeMaxTokens(credentials.maxTokens)
  return {
    provider: credentials.provider,
    model: credentials.model,
    apiKey: credentials.apiKey,
    baseUrl,
    maxTokens,
    fingerprint: researchAgentModelConfigFingerprint({
      provider: credentials.provider,
      model: credentials.model,
      baseUrl,
      maxTokens,
    }),
  }
}

export function resolvePinnedResearchAgentModelConfig(
  db: Database.Database,
  run: Pick<ResearchAgentRunRow, 'provider' | 'model'>,
): ResearchAgentPinnedModelConfig | null {
  if (!VALID_PROVIDERS.has(run.provider as AIProvider)) return null
  const provider = run.provider as AIProvider
  const providerConfig = getProviderConfig(db, provider)
  const aiConfig = getAIConfig(db)
  const encrypted = providerConfig?.apiKeyEncrypted
    ?? (aiConfig.provider === provider ? aiConfig.apiKeyEncrypted : null)
  const apiKey = decryptApiKey(encrypted)
  if (!apiKey) return null
  const model = providerConfig?.model
    ?? (aiConfig.provider === provider ? aiConfig.model : null)
  if (!model || model !== run.model) return null
  const baseUrl = normalizedBaseUrl(
    provider,
    providerConfig?.baseUrl ?? (aiConfig.provider === provider ? aiConfig.baseUrl : null),
  )
  const maxTokens = normalizeMaxTokens(providerConfig?.maxTokens)
  return {
    provider,
    model,
    apiKey,
    baseUrl,
    maxTokens,
    fingerprint: researchAgentModelConfigFingerprint({ provider, model, baseUrl, maxTokens }),
  }
}

export async function runResearchAgent(
  db: Database.Database,
  input: { runId: string; leaseOwner: string },
  options: ResearchAgentRunnerOptions = {},
): Promise<ResearchAgentRunRow> {
  const now = options.now ?? Date.now
  const executionStartedAt = now()
  const executionOptions: ResearchAgentRunnerOptions = { ...options, executionStartedAt }
  try {
    let run = requireRun(db, input.runId)
    if (run.status !== 'running' || run.lease_owner !== input.leaseOwner) {
      throw new ResearchAgentRunnerError('RUN_LEASE_CONFLICT', '研究运行没有由当前进程持有有效租约', true)
    }
    const config = executionOptions.modelConfig ?? resolvePinnedResearchAgentModelConfig(db, run)
    if (!config) throw new ResearchAgentRunnerError('AI_NOT_CONFIGURED', '固定模型凭据当前不可用', true)
    const drift = modelOrRuleDrift(run, config)
    if (drift) {
      return transitionResearchAgentRunStatus(db, {
        runId: run.id,
        leaseOwner: input.leaseOwner,
        toStatus: 'needs_attention',
        errorCode: drift.code,
        errorMessage: drift.message,
        retryable: false,
        now: now(),
      })
    }

    while (true) {
      run = requireRun(db, input.runId)
      if (run.status !== 'running') return run
      throwIfCancelled(run, executionOptions.signal)
      const budget = researchAgentBudgetForRun(run)
      if (budget.maxDurationMs != null && now() - executionStartedAt > budget.maxDurationMs) {
        throw new ResearchAgentRunnerError('BUDGET_EXCEEDED', '研究运行超过本次连续执行时长预算')
      }
      emitProgress(executionOptions, db, run, `${phaseLabel(run.phase, run.run_kind)}处理中`)
      if (run.run_kind === 'multi_perspective') {
        if (run.phase === 'planning') {
          executeMultiPerspectivePlanningPhase(db, run, input.leaseOwner, now)
        } else if (run.phase === 'tooling') {
          await executeMultiPerspectiveRolePhase(db, run, input.leaseOwner, config, executionOptions, now)
        } else if (run.phase === 'synthesis') {
          await executeMultiPerspectiveModeratorPhase(db, run, input.leaseOwner, config, executionOptions, now)
        } else if (run.phase === 'audit') {
          executeMultiPerspectiveAuditPhase(db, run, input.leaseOwner, now)
        } else {
          await executePersistPhase(db, run, input.leaseOwner, executionOptions, now)
        }
      } else if (run.phase === 'planning') {
        await executePlanningPhase(db, run, input.leaseOwner, config, executionOptions, now)
      } else if (run.phase === 'tooling') {
        await executeToolingPhase(db, run, input.leaseOwner, config, executionOptions, now)
      } else if (run.phase === 'synthesis') {
        await executeSynthesisPhase(db, run, input.leaseOwner, config, executionOptions, now)
      } else if (run.phase === 'audit') {
        executeAuditPhase(db, run, input.leaseOwner, executionOptions, now)
      } else {
        await executePersistPhase(db, run, input.leaseOwner, executionOptions, now)
      }
    }
  } catch (error) {
    return settleRunnerFailure(db, input, executionOptions, error)
  }
}

function executeMultiPerspectivePlanningPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  now: () => number,
): void {
  const existing = singletonStep(db, run.id, 'planning')
  if (existing?.status === 'succeeded') {
    validateMultiPerspectiveSource(db, run)
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'tooling', now: now() })
    return
  }
  const source = validateMultiPerspectiveSource(db, run)
  const unrestricted = researchAgentBudgetForRun(run).id !== RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET.id
  const plan = {
    protocolVersion: unrestricted
      ? MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION
      : MULTI_PERSPECTIVE_PROTOCOL_VERSION,
    action: 'review_plan',
    sourceRunId: source.run.id,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
    roles: ['bull', 'bear', 'moderator'],
    modelCallLimit: unrestricted ? null : 3,
    toolCallLimit: 0,
    minimumDebateRounds: unrestricted ? 2 : 1,
    terminationPolicy: unrestricted ? 'semantic_convergence_or_user_cancel' : 'fixed_single_round',
    asOf: run.as_of,
  }
  const step = ensureRunningStep(db, run, leaseOwner, 'planning', {
    protocolVersion: unrestricted
      ? run.prompt_rule_version
      : MULTI_PERSPECTIVE_PROMPT_RULE_VERSION,
    objective: '校验父运行并锁定不可变证据快照',
    sourceRunId: source.run.id,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
  }, existing, now())
  saveResearchAgentRunPlan(db, { runId: run.id, leaseOwner, plan, now: now() })
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: plan,
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'tooling', now: now() })
}

async function executeMultiPerspectiveRolePhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  if (researchAgentBudgetForRun(run).id === RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET.id) {
    return executeLegacyMultiPerspectiveRolePhase(db, run, leaseOwner, config, options, now)
  }
  return executeUnrestrictedMultiPerspectiveRolePhase(db, run, leaseOwner, config, options, now)
}

async function executeLegacyMultiPerspectiveRolePhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const existing = singletonStep(db, run.id, 'tooling')
  if (existing?.status === 'succeeded') {
    validateMultiPerspectiveSource(db, run)
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'synthesis', now: now() })
    return
  }
  const source = validateMultiPerspectiveSource(db, run)
  const step = ensureRunningStep(db, run, leaseOwner, 'tooling', {
    protocolVersion: MULTI_PERSPECTIVE_PROMPT_RULE_VERSION,
    objective: '多方与空方基于同一证据快照独立研判',
    sourceRunId: source.run.id,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
    toolCallsAllowed: false,
  }, existing, now())
  const roles: Partial<Record<MultiPerspectiveRole, MultiPerspectiveRoleAction>> = {}
  for (const role of ['bull', 'bear'] as const) {
    throwIfCancelled(requireRun(db, run.id), options.signal)
    const response = await executePinnedModelCall(
      db,
      requireRun(db, run.id),
      step,
      leaseOwner,
      `${role}_case`,
      buildMultiPerspectiveRoleMessages({
        role,
        question: run.question,
        asOf: run.as_of,
        evidenceSnapshotSha256: source.evidenceSnapshotSha256,
        persistedFacts: source.persistedFacts,
        allowedEvidenceReferences: [...source.allowedReferences],
      }),
      config,
      options,
      now,
    )
    roles[role] = parseMultiPerspectiveRoleAction(response.text, role, source.allowedReferences)
  }
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      schemaVersion: 1,
      sourceRunId: source.run.id,
      evidenceSnapshotSha256: source.evidenceSnapshotSha256,
      bull: roles.bull,
      bear: roles.bear,
    },
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'synthesis', now: now() })
}

async function executeUnrestrictedMultiPerspectiveRolePhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const existing = singletonStep(db, run.id, 'tooling')
  if (existing?.status === 'succeeded') {
    validateMultiPerspectiveSource(db, run)
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'synthesis', now: now() })
    return
  }
  const source = validateMultiPerspectiveSource(db, run)
  const step = ensureRunningStep(db, run, leaseOwner, 'tooling', {
    protocolVersion: run.prompt_rule_version,
    objective: '多方与空方围绕同一证据快照持续交锋，直至实质分歧收敛',
    sourceRunId: source.run.id,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
    minimumDebateRounds: 2,
    modelCallLimit: null,
    terminationPolicy: 'semantic_convergence_or_user_cancel',
    toolCallsAllowed: false,
  }, existing, now())
  const initialFacts = compactMultiPerspectiveFactContext(
    source.persistedFacts,
    MAX_MULTI_PERSPECTIVE_INITIAL_FACT_CONTEXT_BYTES,
  )
  const followUpFacts = compactMultiPerspectiveFactContext(
    source.persistedFacts,
    MAX_MULTI_PERSPECTIVE_FOLLOW_UP_FACT_CONTEXT_BYTES,
  )

  let round = 1
  let bull: MultiPerspectiveUnrestrictedRoleAction | null = null
  let bear: MultiPerspectiveUnrestrictedRoleAction | null = null
  let convergence: MultiPerspectiveConvergenceAction | null = null
  let terminationReason: 'model_converged' | 'no_substantive_change' = 'model_converged'
  while (true) {
    throwIfCancelled(requireRun(db, run.id), options.signal)
    const previousBull = bull
    const previousBear = bear
    emitProgress(options, db, requireRun(db, run.id), `正在进行多空第 ${round} 轮交锋`)
    const bullResponse = await executePinnedModelCall(
      db,
      requireRun(db, run.id),
      step,
      leaseOwner,
      `bull_round_${round}`,
      buildMultiPerspectiveUnrestrictedRoleMessages({
        role: 'bull',
        round,
        question: run.question,
        asOf: run.as_of,
        evidenceSnapshotSha256: source.evidenceSnapshotSha256,
        persistedFacts: round === 1 ? initialFacts : followUpFacts,
        allowedEvidenceReferences: [...source.allowedReferences],
        previousOwn: previousBull,
        previousOpponent: previousBear,
        convergence,
      }),
      config,
      options,
      now,
    )
    bull = parseMultiPerspectiveUnrestrictedRoleAction(bullResponse.text, 'bull', source.allowedReferences)
    throwIfCancelled(requireRun(db, run.id), options.signal)
    const bearResponse = await executePinnedModelCall(
      db,
      requireRun(db, run.id),
      step,
      leaseOwner,
      `bear_round_${round}`,
      buildMultiPerspectiveUnrestrictedRoleMessages({
        role: 'bear',
        round,
        question: run.question,
        asOf: run.as_of,
        evidenceSnapshotSha256: source.evidenceSnapshotSha256,
        persistedFacts: round === 1 ? initialFacts : followUpFacts,
        allowedEvidenceReferences: [...source.allowedReferences],
        previousOwn: previousBear,
        previousOpponent: previousBull,
        convergence,
      }),
      config,
      options,
      now,
    )
    bear = parseMultiPerspectiveUnrestrictedRoleAction(bearResponse.text, 'bear', source.allowedReferences)

    if (round < 2) {
      round += 1
      continue
    }
    emitProgress(options, db, requireRun(db, run.id), `正在评估第 ${round} 轮是否仍有实质分歧`)
    const convergenceResponse = await executePinnedModelCall(
      db,
      requireRun(db, run.id),
      step,
      leaseOwner,
      `convergence_round_${round}`,
      buildMultiPerspectiveConvergenceMessages({
        round,
        question: run.question,
        allowedEvidenceReferences: [...source.allowedReferences],
        bull,
        bear,
        previous: convergence,
      }),
      config,
      options,
      now,
    )
    const assessed = parseMultiPerspectiveConvergenceAction(convergenceResponse.text)
    const unchanged = previousBull != null
      && previousBear != null
      && multiPerspectivePositionSignature(previousBull, previousBear) === multiPerspectivePositionSignature(bull, bear)
    convergence = unchanged && assessed.decision === 'continue'
      ? {
          ...assessed,
          decision: 'finish',
          focusAreas: [],
          rationale: `${assessed.rationale} 主进程检测到双方结构化观点无实质变化，结束重复交锋。`,
        }
      : assessed
    terminationReason = unchanged ? 'no_substantive_change' : 'model_converged'
    if (convergence.decision === 'finish') break
    round += 1
  }

  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      schemaVersion: 2,
      protocolVersion: MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION,
      sourceRunId: source.run.id,
      evidenceSnapshotSha256: source.evidenceSnapshotSha256,
      roundCount: round,
      terminationReason,
      convergence,
      bull,
      bear,
    },
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'synthesis', now: now() })
}

async function executeMultiPerspectiveModeratorPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  if (researchAgentBudgetForRun(run).id === RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET.id) {
    return executeLegacyMultiPerspectiveModeratorPhase(db, run, leaseOwner, config, options, now)
  }
  return executeUnrestrictedMultiPerspectiveModeratorPhase(db, run, leaseOwner, config, options, now)
}

async function executeLegacyMultiPerspectiveModeratorPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const existing = singletonStep(db, run.id, 'synthesis')
  if (existing?.status === 'succeeded') {
    validateMultiPerspectiveSource(db, run)
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'audit', now: now() })
    return
  }
  const source = validateMultiPerspectiveSource(db, run)
  const roles = storedMultiPerspectiveRoles(requireLedger(db, run.id), source.allowedReferences)
  if (
    roles.bull.protocolVersion !== MULTI_PERSPECTIVE_PROTOCOL_VERSION
    || roles.bear.protocolVersion !== MULTI_PERSPECTIVE_PROTOCOL_VERSION
  ) {
    throw new ResearchAgentRunnerError('ROLE_OUTPUT_MISSING', '历史多视角角色产物协议不匹配')
  }
  const step = ensureRunningStep(db, run, leaseOwner, 'synthesis', {
    protocolVersion: MULTI_PERSPECTIVE_PROMPT_RULE_VERSION,
    objective: '中立主持形成共识、分歧与验证清单',
    sourceRunId: source.run.id,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
  }, existing, now())
  const response = await executePinnedModelCall(
    db,
    requireRun(db, run.id),
    step,
    leaseOwner,
    'moderator',
    buildMultiPerspectiveModeratorMessages({
      question: run.question,
      asOf: run.as_of,
      evidenceSnapshotSha256: source.evidenceSnapshotSha256,
      persistedFacts: source.persistedFacts,
      allowedEvidenceReferences: [...source.allowedReferences],
      bull: roles.bull,
      bear: roles.bear,
    }),
    config,
    options,
    now,
  )
  const moderator = parseMultiPerspectiveModeratorAction(response.text, source.allowedReferences)
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      schemaVersion: 1,
      sourceRunId: source.run.id,
      evidenceSnapshotSha256: source.evidenceSnapshotSha256,
      moderator,
    },
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'audit', now: now() })
}

async function executeUnrestrictedMultiPerspectiveModeratorPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const existing = singletonStep(db, run.id, 'synthesis')
  if (existing?.status === 'succeeded') {
    validateMultiPerspectiveSource(db, run)
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'audit', now: now() })
    return
  }
  const source = validateMultiPerspectiveSource(db, run)
  const review = storedUnrestrictedMultiPerspectiveReview(requireLedger(db, run.id), source.allowedReferences)
  const persistedFacts = compactMultiPerspectiveFactContext(
    source.persistedFacts,
    MAX_MULTI_PERSPECTIVE_FOLLOW_UP_FACT_CONTEXT_BYTES,
  )
  const step = ensureRunningStep(db, run, leaseOwner, 'synthesis', {
    protocolVersion: run.prompt_rule_version,
    objective: '中立主持汇总多轮交锋后的共识、分歧与验证清单',
    sourceRunId: source.run.id,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
    roundCount: review.roundCount,
  }, existing, now())
  emitProgress(options, db, requireRun(db, run.id), `正在汇总 ${review.roundCount} 轮多空交锋`)
  const response = await executePinnedModelCall(
    db,
    requireRun(db, run.id),
    step,
    leaseOwner,
    'moderator',
    buildMultiPerspectiveUnrestrictedModeratorMessages({
      question: run.question,
      asOf: run.as_of,
      evidenceSnapshotSha256: source.evidenceSnapshotSha256,
      persistedFacts,
      allowedEvidenceReferences: [...source.allowedReferences],
      roundCount: review.roundCount,
      convergence: review.convergence,
      bull: review.bull,
      bear: review.bear,
      promptRuleVersion: run.prompt_rule_version,
    }),
    config,
    options,
    now,
  )
  const moderator = parseMultiPerspectiveUnrestrictedModeratorAction(response.text, source.allowedReferences)
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      schemaVersion: 2,
      protocolVersion: MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION,
      sourceRunId: source.run.id,
      evidenceSnapshotSha256: source.evidenceSnapshotSha256,
      roundCount: review.roundCount,
      moderator,
    },
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'audit', now: now() })
}

function executeMultiPerspectiveAuditPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  now: () => number,
): void {
  const existing = singletonStep(db, run.id, 'audit')
  if (existing?.status === 'succeeded') {
    validateMultiPerspectiveSource(db, run)
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'persist', now: now() })
    return
  }
  const source = validateMultiPerspectiveSource(db, run)
  const ledger = requireLedger(db, run.id)
  ensureNoUnknownToolCalls(db, ledger, leaseOwner, now())
  if (ledger.toolCalls.length > 0 || run.tool_call_count !== 0) {
    throw new ResearchAgentRunnerError('TOOL_SCOPE_VIOLATION', '多视角复核运行禁止创建工具调用')
  }
  const roles = storedMultiPerspectiveRoles(ledger, source.allowedReferences)
  const moderator = storedMultiPerspectiveModerator(ledger, source.allowedReferences)
  const roundCount = storedMultiPerspectiveRoundCount(ledger)
  const step = ensureRunningStep(db, run, leaseOwner, 'audit', {
    protocolVersion: roundCount == null
      ? MULTI_PERSPECTIVE_PROMPT_RULE_VERSION
      : run.prompt_rule_version,
    objective: '校验证据快照、角色引用和最终文本',
    sourceRunId: source.run.id,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
  }, existing, now())
  const originalReport = renderMultiPerspectiveReport({
    sourceRunId: source.run.id,
    asOf: run.as_of,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
    bull: roles.bull,
    bear: roles.bear,
    moderator,
    roundCount,
  })
  const audit = auditResearchText({
    documentKind: 'discussion',
    text: originalReport,
    evidenceContrast: source.evidenceContrast,
    allowedFactTexts: source.ledger.toolCalls
      .filter((call) => call.status === 'succeeded' && call.model_projection_json)
      .map((call) => call.model_projection_json!),
    excludedUrls: excludedUrls(source.run.context_snapshot_json),
    asOf: run.as_of,
    now: now(),
  })
  const reportMarkdown = audit.status === 'blocked' ? buildBlockedResearchText(audit) : originalReport
  const outcome: ResearchAgentRunOutcome = audit.status === 'blocked' ? 'blocked' : moderator.outcome
  const quality = buildMultiPerspectiveQualitySummary({
    sourceReportMarkdown: source.run.report_markdown!,
    allowedEvidenceReferences: source.allowedReferences,
    bull: roles.bull,
    bear: roles.bear,
    moderator,
  })
  saveResearchAgentRunAuditedReport(db, {
    runId: run.id,
    leaseOwner,
    evidenceSnapshotSha256: source.evidenceSnapshotSha256,
    reportMarkdown,
    audit,
    now: now(),
  })
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      schemaVersion: 1,
      outcome,
      evidenceContrast: source.evidenceContrast,
      audit,
      sourceRunId: source.run.id,
      sourceReportSha256: source.run.report_sha256,
      evidenceSnapshotSha256: source.evidenceSnapshotSha256,
      bull: roles.bull,
      bear: roles.bear,
      moderator,
      ...(roundCount == null ? {} : { roundCount }),
      quality,
      reportSha256: createHash('sha256').update(reportMarkdown.trim(), 'utf8').digest('hex'),
      originalReportSha256: createHash('sha256').update(originalReport.trim(), 'utf8').digest('hex'),
    },
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'persist', now: now() })
}

async function executePlanningPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const existing = singletonStep(db, run.id, 'planning')
  if (existing?.status === 'succeeded') {
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'tooling', now: now() })
    return
  }
  const step = ensureRunningStep(db, run, leaseOwner, 'planning', {
    protocolVersion: run.prompt_rule_version,
    objective: '生成受控研究计划',
  }, existing, now())
  const initialGate = assessResearchAgentEvidence({
    question: run.question,
    asOf: run.as_of,
    subjects: parseResearchAgentTrustedSubjects(safeJson(run.subjects_json)),
    observations: [],
  })
  const tools = listAvailableResearchAgentTools(run, {
    includeNetwork: !initialGate.questionProfile.offlineRequested,
  })
  const messages = buildResearchAgentPlanningMessages({
    question: run.question,
    subjects: safeJson(run.subjects_json),
    asOf: run.as_of,
    includePortfolio: run.include_portfolio === 1,
    trustedContext: boundedTrustedContext(run.context_snapshot_json),
    tools,
  })
  emitProgress(options, db, requireRun(db, run.id), '正在调用固定模型制定研究计划')
  const response = await executePinnedModelCall(db, run, step, leaseOwner, 'planning', messages, config, options, now)
  const plan = parseResearchAgentPlanAction(response.text)
  const availableIds = new Set(tools.map((tool) => tool.id))
  const unavailable = plan.candidateTools.find((toolId) => !availableIds.has(toolId))
  if (unavailable) throw new ResearchAgentRunnerError('ACTION_SCHEMA_INVALID', `研究计划包含未授权工具：${unavailable}`)
  saveResearchAgentRunPlan(db, { runId: run.id, leaseOwner, plan, now: now() })
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: plan,
    now: now(),
  })
  emitProgress(options, db, requireRun(db, run.id), '研究计划已固化，准备核验事实')
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'tooling', now: now() })
}

async function executeToolingPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const ledger = requireLedger(db, run.id)
  const budget = researchAgentBudgetForRun(run)
  ensureNoUnknownToolCalls(db, ledger, leaseOwner, now())
  const completed = ledger.steps.filter((step) => step.kind === 'tooling' && step.status === 'succeeded')
  const unfinished = ledger.steps.filter((step) => step.kind === 'tooling' && step.status !== 'succeeded').at(-1) ?? null
  const decisionInputCalls = unfinished
    ? ledger.toolCalls.filter((call) => call.step_id !== unfinished.id)
    : ledger.toolCalls
  const evidenceGate = evidenceGateForLedger(run, decisionInputCalls)
  if (
    (budget.maxToolDecisionRounds != null && completed.length >= budget.maxToolDecisionRounds)
    || consecutiveUnproductiveToolingRounds(ledger) >= 2
  ) {
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'synthesis', now: now() })
    return
  }
  const round = completed.length + 1
  const includeNetwork = completed.length > 0
    && evidenceGate.decision === 'network_required'
    && !evidenceGate.questionProfile.offlineRequested
  const tools = listAvailableResearchAgentTools(run, { includeNetwork })
  const step = ensureRunningStep(db, run, leaseOwner, 'tooling', {
    protocolVersion: run.prompt_rule_version,
    action: 'tool_batch',
    decisionRound: round,
  }, unfinished, now())
  const plan = storedPlan(run)
  const decisionUsedToolCalls = decisionInputCalls.length
  const decisionRemainingToolCalls = budget.maxToolCalls == null
    ? null
    : Math.max(0, budget.maxToolCalls - decisionUsedToolCalls)
  const messages = buildResearchAgentToolDecisionMessages({
    question: run.question,
    subjects: safeJson(run.subjects_json),
    trustedContext: boundedTrustedContext(run.context_snapshot_json),
    plan,
    asOf: run.as_of,
    round,
    maximumRounds: budget.maxToolDecisionRounds,
    budget: {
      maximumToolCalls: budget.maxToolCalls,
      usedToolCalls: decisionUsedToolCalls,
      remainingToolCalls: decisionRemainingToolCalls,
      reservedRecoveryCalls: decisionRemainingToolCalls == null ? null : Math.min(2, decisionRemainingToolCalls),
    },
    tools,
    persistedFacts: buildPersistedFactContext(decisionInputCalls),
    evidenceGate,
  })
  emitProgress(
    options,
    db,
    requireRun(db, run.id),
    `第 ${round} 轮：正在判断${includeNetwork ? '联网补证' : '本地取证'}动作`,
  )
  const response = await executePinnedModelCall(
    db,
    requireRun(db, run.id),
    step,
    leaseOwner,
    `tool_decision_${round}`,
    messages,
    config,
    options,
    now,
  )
  const action = parseResearchAgentToolDecisionAction(response.text)
  if (action.action === 'finish') {
    transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner,
      toStatus: 'succeeded',
      artifact: { ...action, evidenceGate },
      now: now(),
    })
    if (
      evidenceGate.decision === 'local_sufficient'
      || evidenceGate.questionProfile.offlineRequested
      || includeNetwork
      || (budget.maxToolDecisionRounds != null && round >= budget.maxToolDecisionRounds)
    ) {
      advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'synthesis', now: now() })
    }
    return
  }
  const availableIds = new Set(tools.map((tool) => tool.id))
  const unavailable = action.calls.find((requested) => !availableIds.has(requested.toolId))
  if (unavailable) {
    throw new ResearchAgentRunnerError('ACTION_SCHEMA_INVALID', `工具决策包含当前轮次未授权工具：${unavailable.toolId}`)
  }
  const currentLedger = requireLedger(db, run.id)
  const requiredNewToolCalls = countNewToolCallsForBatch(run, action.calls, tools, currentLedger.toolCalls)
  const remainingToolCalls = budget.maxToolCalls == null
    ? null
    : Math.max(0, budget.maxToolCalls - currentLedger.run.tool_call_count)
  if (remainingToolCalls != null && requiredNewToolCalls > remainingToolCalls) {
    throw new ResearchAgentRunnerError(
      'ACTION_SCHEMA_INVALID',
      `当前仅剩${Math.max(0, remainingToolCalls)}次工具预算，模型批次需要新增${requiredNewToolCalls}次调用`,
    )
  }
  const toolCallIds: string[] = []
  for (const [index, requested] of action.calls.entries()) {
    throwIfCancelled(requireRun(db, run.id), options.signal)
    emitProgress(
      options,
      db,
      requireRun(db, run.id),
      `第 ${round} 轮：正在执行 ${requested.toolId}（${index + 1}/${action.calls.length}）`,
    )
    const result = await executeResearchAgentTool(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner,
      toolId: requested.toolId,
      toolInput: requested.input,
      callId: randomUUID(),
      now: now(),
    }, { ...options.toolService, signal: options.signal })
    toolCallIds.push(result.call.id)
    emitProgress(
      options,
      db,
      requireRun(db, run.id),
      `第 ${round} 轮：${requested.toolId} 已完成，正在更新证据账本`,
    )
    throwIfCancelled(requireRun(db, run.id), options.signal)
  }
  emitProgress(options, db, requireRun(db, run.id), `第 ${round} 轮：正在检查候选正文与证据缺口`)
  const recoveryToolCallIds = await executeDeterministicDocumentRecovery(
    db,
    run,
    step,
    leaseOwner,
    toolCallIds,
    options,
    now,
  )
  const updatedLedger = requireLedger(db, run.id)
  const updatedGate = evidenceGateForLedger(run, updatedLedger.toolCalls)
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      ...action,
      toolCallIds,
      recoveryToolCallIds,
      recoveryCount: recoveryToolCallIds.length,
      evidenceGate: updatedGate,
    },
    now: now(),
  })
  emitProgress(options, db, requireRun(db, run.id), `第 ${round} 轮取证已完成，正在重新校验证据门禁`)
  if (budget.maxToolDecisionRounds != null && round >= budget.maxToolDecisionRounds) {
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'synthesis', now: now() })
  }
}

function consecutiveUnproductiveToolingRounds(ledger: ResearchAgentRunLedger): number {
  const completed = ledger.steps
    .filter((step) => step.kind === 'tooling' && step.status === 'succeeded')
    .sort((left, right) => right.ordinal - left.ordinal)
  let count = 0
  for (const step of completed) {
    const addedEvidence = ledger.toolCalls.some((call) => (
      call.step_id === step.id
      && call.status === 'succeeded'
      && call.model_projection_json != null
    ))
    if (addedEvidence) break
    count += 1
  }
  return count
}

function countNewToolCallsForBatch(
  run: ResearchAgentRunRow,
  calls: Array<{ toolId: string; input: Record<string, unknown> }>,
  definitions: readonly ResearchAgentToolDefinition[],
  existingCalls: ResearchAgentToolCallRow[],
): number {
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]))
  const reusable = new Set(existingCalls
    .filter((call) => call.status === 'succeeded')
    .map((call) => `${call.tool_id}:${publicToolCallInputSha256(call)}:${call.as_of}`))
  const planned = new Set<string>()
  let count = 0
  for (const call of calls) {
    const definition = definitionById.get(call.toolId)
    if (!definition) continue
    const preparedInput = toolInputForBudget(run, definition, call.input)
    const inputSha256 = serializeResearchAgentJson(preparedInput, 64 * 1024).sha256
    const key = `${call.toolId}:${inputSha256}:${run.as_of}`
    if (planned.has(key)) {
      throw new ResearchAgentRunnerError('ACTION_SCHEMA_INVALID', `同一工具批次不得重复声明相同工具与输入：${call.toolId}`)
    }
    planned.add(key)
    if (reusable.has(key)) continue
    count += 1
  }
  return count
}

function toolInputForBudget(
  run: ResearchAgentRunRow,
  definition: ResearchAgentToolDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (definition.asOf !== 'supported') return input
  const suppliedAsOf = typeof input.asOf === 'string' ? input.asOf.trim().replace(/-/g, '') : null
  return input.asOf == null || suppliedAsOf === run.as_of
    ? { ...input, asOf: run.as_of }
    : input
}

function publicToolCallInputSha256(call: ResearchAgentToolCallRow): string {
  const input = safeJson(call.input_json)
  if (!isRecord(input) || !('__executionOrigin' in input)) return call.input_sha256
  const publicInput = Object.fromEntries(
    Object.entries(input).filter(([name]) => name !== '__executionOrigin'),
  )
  return serializeResearchAgentJson(publicInput, 64 * 1024).sha256
}

function ensureNoUnknownToolCalls(
  db: Database.Database,
  ledger: ReturnType<typeof requireLedger>,
  leaseOwner: string,
  now: number,
): void {
  const submittedCall = ledger.toolCalls.find((call) => call.status === 'submitted')
  if (submittedCall) {
    transitionResearchAgentToolCallStatus(db, {
      callId: submittedCall.id,
      leaseOwner,
      toStatus: 'outcome_unknown',
      errorCode: 'PROCESS_INTERRUPTED_AFTER_SUBMIT',
      errorMessage: '联网请求已提交但没有可验证完整响应，禁止在同一运行尝试其他候选',
      now,
    })
    throw new ResearchAgentRunnerError('TOOL_OUTCOME_UNKNOWN', '联网工具结果不确定，运行需要人工处理')
  }
  if (ledger.toolCalls.some((call) => call.status === 'outcome_unknown')) {
    throw new ResearchAgentRunnerError('TOOL_OUTCOME_UNKNOWN', '联网工具结果不确定，运行需要人工处理')
  }
}

async function executeDeterministicDocumentRecovery(
  db: Database.Database,
  run: ResearchAgentRunRow,
  step: ResearchAgentStepRow,
  leaseOwner: string,
  currentCallIds: string[],
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<string[]> {
  const ledger = requireLedger(db, run.id)
  const currentCalls = ledger.toolCalls.filter((call) => currentCallIds.includes(call.id))
  const needsRecovery = currentCalls.some((call) => (
    isResearchAgentDocumentToolId(call.tool_id) && !hasUsableToolCoverage(call)
  ))
  if (!needsRecovery) return []

  const budget = researchAgentBudgetForRun(run)
  const previousRecoveryCount = ledger.toolCalls.filter((call) => toolCallOrigin(call) === 'recovery').length
  const availableBudget = budget.maxToolCalls == null
    ? 2
    : Math.max(0, budget.maxToolCalls - ledger.run.tool_call_count)
  const recoveryAllowance = budget.id === 'single-agent-standard-v1'
    ? Math.max(0, 2 - previousRecoveryCount)
    : 2
  const maximum = Math.min(recoveryAllowance, availableBudget)
  if (maximum <= 0) return []

  const attemptedCandidates = new Set(ledger.toolCalls.flatMap((call) => {
    if (!isResearchAgentDocumentToolId(call.tool_id)) return []
    const input = safeJson(call.input_json)
    return isRecord(input) && typeof input.candidateId === 'string' ? [input.candidateId] : []
  }))
  const candidates = deterministicRecoveryCandidates(ledger.toolCalls)
    .filter((candidate) => !attemptedCandidates.has(candidate.candidateId))
  const recovered: string[] = []
  for (const candidate of candidates) {
    if (recovered.length >= maximum) break
    throwIfCancelled(requireRun(db, run.id), options.signal)
    const result = await executeResearchAgentTool(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner,
      toolId: candidate.documentToolId,
      toolInput: { candidateId: candidate.candidateId },
      executionOrigin: 'recovery',
      callId: randomUUID(),
      now: now(),
    }, { ...options.toolService, signal: options.signal })
    recovered.push(result.call.id)
    attemptedCandidates.add(candidate.candidateId)
    const refreshed = requireLedger(db, run.id)
    if (evidenceGateForLedger(run, refreshed.toolCalls).decision === 'local_sufficient') break
  }
  return recovered
}

function deterministicRecoveryCandidates(toolCalls: ResearchAgentToolCallRow[]): Array<{
  candidateId: string
  documentToolId: 'web.fetch_page' | 'official.disclosure_document'
  sourceRank: number
  order: number
}> {
  const candidates: Array<{
    candidateId: string
    documentToolId: 'web.fetch_page' | 'official.disclosure_document'
    sourceRank: number
    order: number
  }> = []
  for (const [callOrder, call] of toolCalls.entries()) {
    if (call.status !== 'succeeded' || !isResearchAgentSearchToolId(call.tool_id)) continue
    const envelope = safeJson(call.envelope_json ?? null)
    const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : null
    const values = Array.isArray(data?.candidates) ? data.candidates : []
    for (const [candidateOrder, value] of values.entries()) {
      if (!isRecord(value) || typeof value.candidateId !== 'string') continue
      const sourceRank = value.sourceClass === 'official' ? 3 : value.sourceClass === 'primary' ? 2 : 1
      candidates.push({
        candidateId: value.candidateId,
        documentToolId: call.tool_id === 'official.disclosure_search'
          ? 'official.disclosure_document'
          : 'web.fetch_page',
        sourceRank,
        order: callOrder * 100 + candidateOrder,
      })
    }
  }
  return candidates.sort((left, right) => right.sourceRank - left.sourceRank || left.order - right.order)
}

function hasUsableToolCoverage(call: ResearchAgentToolCallRow): boolean {
  if (call.status !== 'succeeded') return false
  const coverage = safeJson(call.coverage_json)
  return isRecord(coverage)
    && typeof coverage.available === 'number'
    && Number.isFinite(coverage.available)
    && coverage.available > 0
}

function toolCallOrigin(call: ResearchAgentToolCallRow): 'model' | 'recovery' {
  const input = safeJson(call.input_json)
  return isRecord(input) && input.__executionOrigin === 'recovery' ? 'recovery' : 'model'
}

async function executeSynthesisPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const existing = singletonStep(db, run.id, 'synthesis')
  if (existing?.status === 'succeeded') {
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'audit', now: now() })
    return
  }
  const ledger = requireLedger(db, run.id)
  const unrestricted = isUnrestrictedSingleAgentRun(run)
  const evidenceGate = evidenceGateForLedger(run, ledger.toolCalls)
  const step = ensureRunningStep(db, run, leaseOwner, 'synthesis', {
    protocolVersion: run.prompt_rule_version,
    objective: evidenceGate.decision === 'network_required'
      ? unrestricted
        ? '保留证据缺口并生成降级研究报告'
        : '证据门禁阻止无联网正文的模型综合'
      : '只使用已持久化事实形成最终报告',
    evidenceGate,
  }, existing, now())
  if (evidenceGate.decision === 'network_required' && !unrestricted) {
    emitProgress(options, db, requireRun(db, run.id), '证据门禁仍未满足，正在生成可追溯的受阻报告')
    const action = buildEvidenceGateBlockedAction(run, evidenceGate, ledger.toolCalls)
    transitionResearchAgentStepStatus(db, {
      stepId: step.id,
      leaseOwner,
      toStatus: 'succeeded',
      artifact: {
        protocolVersion: action.protocolVersion,
        action: action.action,
        outcome: action.outcome,
        rationale: action.rationale,
        reportSha256: createHash('sha256').update(action.reportMarkdown, 'utf8').digest('hex'),
        evidenceGate,
        deterministic: true,
        finalAction: action,
      },
      now: now(),
    })
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'audit', now: now() })
    return
  }
  const persistedFacts = buildResearchAgentSynthesisFactContext(
    run,
    ledger.toolCalls,
    evidenceGate,
    storedPlan(run),
    unrestricted,
  )
  const messages = buildResearchAgentSynthesisMessages({
    question: run.question,
    plan: storedPlan(run),
    asOf: run.as_of,
    persistedFacts,
    evidenceGate,
    promptRuleVersion: run.prompt_rule_version,
  })
  emitProgress(
    options,
    db,
    requireRun(db, run.id),
    evidenceGate.decision === 'local_sufficient'
      ? '证据已达到综合门槛，正在生成研究报告'
      : '证据仍有缺口，正在生成明确降级边界的研究报告',
  )
  const response = await executePinnedModelCall(db, run, step, leaseOwner, 'synthesis', messages, config, options, now)
  const modelAction = parseResearchAgentFinalAction(response.text)
  const action = (unrestricted || evidenceGate.maximumOutcome === 'complete') && modelAction.outcome === 'blocked'
    ? { ...modelAction, outcome: 'partial' as const }
    : modelAction
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      protocolVersion: action.protocolVersion,
      action: action.action,
      outcome: action.outcome,
      rationale: action.rationale,
      reportSha256: createHash('sha256').update(action.reportMarkdown, 'utf8').digest('hex'),
      evidenceGate,
      modelOutcome: modelAction.outcome,
      finalAction: action,
    },
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'audit', now: now() })
}

function executeAuditPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): void {
  const existing = singletonStep(db, run.id, 'audit')
  if (existing?.status === 'succeeded') {
    advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'persist', now: now() })
    return
  }
  const step = ensureRunningStep(db, run, leaseOwner, 'audit', {
    protocolVersion: run.prompt_rule_version,
    objective: '执行确定性文本与引用审计',
  }, existing, now())
  emitProgress(options, db, requireRun(db, run.id), '正在校验证据引用、结论边界与风险披露')
  const ledger = requireLedger(db, run.id)
  const unrestricted = isUnrestrictedSingleAgentRun(run)
  const finalAction = storedFinalAction(ledger)
  const evidenceContrast = buildLedgerEvidenceContrast(run, ledger.toolCalls, now())
  const evidenceHash = hashResearchEvidenceContrast(evidenceContrast)
  if (!evidenceHash) throw new ResearchAgentRunnerError('EVIDENCE_MISMATCH', '无法生成可验证的证据快照')
  const allowedFactTexts = ledger.toolCalls
    .filter((call) => call.status === 'succeeded' && call.model_projection_json)
    .map((call) => call.model_projection_json!)
  const audit = auditResearchText({
    documentKind: 'discussion',
    text: finalAction.reportMarkdown,
    evidenceContrast,
    allowedFactTexts,
    excludedUrls: excludedUrls(run.context_snapshot_json),
    asOf: run.as_of,
    now: now(),
  })
  const reportMarkdown = audit.status === 'blocked' && !unrestricted
    ? buildBlockedResearchText(audit)
    : finalAction.reportMarkdown
  const outcome = audit.status === 'blocked' && !unrestricted
    ? 'blocked'
    : audit.status === 'blocked'
      ? 'partial'
      : downgradeOutcome(finalAction.outcome, evidenceGateForLedger(run, ledger.toolCalls))
  saveResearchAgentRunAuditedReport(db, {
    runId: run.id,
    leaseOwner,
    evidenceSnapshotSha256: evidenceHash,
    reportMarkdown,
    audit,
    now: now(),
  })
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: {
      schemaVersion: 1,
      outcome,
      evidenceContrast,
      audit,
      reportSha256: createHash('sha256').update(reportMarkdown.trim(), 'utf8').digest('hex'),
      originalReportSha256: createHash('sha256').update(finalAction.reportMarkdown.trim(), 'utf8').digest('hex'),
    },
    now: now(),
  })
  advanceResearchAgentRunPhase(db, { runId: run.id, leaseOwner, toPhase: 'persist', now: now() })
}

async function executePersistPhase(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<void> {
  const existing = singletonStep(db, run.id, 'persist')
  if (existing?.status === 'succeeded') {
    const auditArtifact = storedAuditArtifact(requireLedger(db, run.id))
    transitionResearchAgentRunStatus(db, {
      runId: run.id,
      leaseOwner,
      toStatus: 'succeeded',
      outcome: auditArtifact.outcome,
      now: now(),
    })
    return
  }
  const step = ensureRunningStep(db, run, leaseOwner, 'persist', {
    protocolVersion: run.prompt_rule_version,
    objective: run.discussion_session_id == null ? '完成本地运行固化' : '幂等附加到研究讨论',
  }, existing, now())
  emitProgress(
    options,
    db,
    requireRun(db, run.id),
    run.discussion_session_id == null ? '正在固化最终研究账本' : '正在把最终报告写回研究讨论',
  )
  const ledger = requireLedger(db, run.id)
  const artifact = storedAuditArtifact(ledger)
  const current = requireRun(db, run.id)
  if (!current.report_markdown || !current.audit_json) {
    throw new ResearchAgentRunnerError('PERSIST_FAILED', '正式报告或审计结果缺失', true)
  }
  let persisted = false
  if (current.discussion_session_id != null) {
    if (!options.persistReport) {
      throw new ResearchAgentRunnerError('PERSIST_FAILED', '讨论报告写回器未配置', true)
    }
    try {
      await options.persistReport(db, {
        run: current,
        reportMarkdown: current.report_markdown,
        evidenceContrast: artifact.evidenceContrast,
        audit: artifact.audit,
        outcome: artifact.outcome,
      })
    } catch {
      throw new ResearchAgentRunnerError('PERSIST_FAILED', '正式报告附加到研究讨论失败', true)
    }
    persisted = true
  }
  throwIfCancelled(requireRun(db, run.id), options.signal)
  transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'succeeded',
    artifact: { schemaVersion: 1, persistedToDiscussion: persisted },
    now: now(),
  })
  transitionResearchAgentRunStatus(db, {
    runId: run.id,
    leaseOwner,
    toStatus: 'succeeded',
    outcome: artifact.outcome,
    now: now(),
  })
}

async function executePinnedModelCall(
  db: Database.Database,
  run: ResearchAgentRunRow,
  step: ResearchAgentStepRow,
  leaseOwner: string,
  purpose: string,
  messages: ConversationTurn[],
  config: ResearchAgentPinnedModelConfig,
  options: ResearchAgentRunnerOptions,
  now: () => number,
): Promise<AIProviderResponse> {
  const serialized = serializeResearchAgentJson(messages, RESEARCH_AGENT_JSON_LIMITS.modelInput)
  const ledger = requireLedger(db, run.id)
  const calls = ledger.modelCalls.filter((call) => call.step_id === step.id && call.purpose === purpose)
  let call = calls.at(-1) ?? null
  if (call && call.input_sha256 !== serialized.sha256) {
    throw new ResearchAgentRunnerError('MODEL_INPUT_CHANGED', '恢复时模型输入与已固化调用不一致')
  }
  if (call?.status === 'succeeded') return storedModelResponse(call)
  if (call?.status === 'submitted') {
    transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner,
      toStatus: 'outcome_unknown',
      errorCode: 'PROCESS_INTERRUPTED_AFTER_SUBMIT',
      errorMessage: '模型请求已提交但没有可验证响应，禁止自动重放',
      now: now(),
    })
    throw new ResearchAgentRunnerError('CALL_OUTCOME_UNKNOWN', '模型调用结果不确定，运行需要人工处理')
  }
  if (call?.status === 'outcome_unknown') {
    throw new ResearchAgentRunnerError('CALL_OUTCOME_UNKNOWN', '模型调用结果不确定，运行需要人工处理')
  }
  if (call?.status === 'cancelled') throw new ResearchAgentRunnerError('GENERATION_CANCELLED', '模型调用已取消')
  if (call?.status === 'safe_failed') call = null
  if (!call) {
    call = createResearchAgentModelCall(db, {
      runId: run.id,
      stepId: step.id,
      leaseOwner,
      purpose,
      attempt: calls.length + 1,
      inputMessages: messages,
      id: randomUUID(),
      now: now(),
    })
  }
  try {
    throwIfCancelled(requireRun(db, run.id), options.signal)
  } catch (error) {
    const cancelled = requireRun(db, run.id).cancel_requested === 1
    transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner,
      toStatus: cancelled ? 'cancelled' : 'safe_failed',
      errorCode: cancelled ? 'GENERATION_CANCELLED' : 'GENERATION_PROVIDER_FAILED',
      errorMessage: cancelled ? '模型请求在提交前已取消' : '模型请求在提交前安全失败',
      now: now(),
    })
    throw error
  }
  call = transitionResearchAgentModelCallStatus(db, {
    callId: call.id,
    leaseOwner,
    toStatus: 'submitted',
    now: now(),
  })
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const budgetTimeoutMs = researchAgentBudgetForRun(run).maxModelCallDurationMs
  const timeoutMs = options.modelTimeoutMs == null
    ? budgetTimeoutMs
    : budgetTimeoutMs == null
      ? options.modelTimeoutMs
      : Math.min(options.modelTimeoutMs, budgetTimeoutMs)
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    const budget = researchAgentBudgetForRun(run)
    const budgetMaxTokens = purpose === 'synthesis' || purpose === 'moderator'
      ? budget.maxFinalOutputTokens
      : budget.maxIntermediateOutputTokens
    const maxTokens = budgetMaxTokens == null
      ? null
      : config.maxTokens == null ? budgetMaxTokens : Math.min(config.maxTokens, budgetMaxTokens)
    const request: AIProviderRequest = {
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      maxTokens,
      omitOutputTokenLimit: budgetMaxTokens == null,
      messages,
      signal: controller.signal,
      disableNativeSearch: true,
    }
    const modelCall = (options.callModel ?? callAIProvider)(request)
    const response = timeoutMs == null
      ? await modelCall
      : await Promise.race([
          modelCall,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort(new Error('MODEL_TIMEOUT'))
              reject(new ResearchAgentRunnerError('MODEL_TIMEOUT', `固定模型调用超过${Math.round(timeoutMs / 1_000)}秒`))
            }, timeoutMs)
          }),
        ])
    const latestRun = requireRun(db, run.id)
    if (latestRun.cancel_requested === 1) {
      transitionResearchAgentModelCallStatus(db, {
        callId: call.id,
        leaseOwner,
        toStatus: 'cancelled',
        errorCode: 'GENERATION_CANCELLED',
        errorMessage: '取消后到达的模型响应已忽略',
        now: now(),
      })
      throw new ResearchAgentRunnerError('GENERATION_CANCELLED', '模型响应在取消后到达')
    }
    const cost = calculateModelCost(response, options.priceSnapshot ?? null, config)
    const saved = transitionResearchAgentModelCallStatus(db, {
      callId: call.id,
      leaseOwner,
      toStatus: 'succeeded',
      responseId: response.responseId ?? response.webSearchTrace?.responseId ?? null,
      responseText: response.text,
      finishReason: response.finishReason ?? null,
      inputTokens: response.usage?.inputTokens ?? null,
      outputTokens: response.usage?.outputTokens ?? null,
      totalTokens: response.usage?.totalTokens ?? null,
      priceSnapshot: cost ? { ...cost.snapshot } : null,
      estimatedCost: cost?.amount ?? null,
      costCurrency: cost?.snapshot.currency ?? null,
      now: now(),
    })
    return storedModelResponse(saved)
  } catch (error) {
    const latestRun = requireRun(db, run.id)
    const latestCall = requireLedger(db, run.id).modelCalls.find((item) => item.id === call.id)
    if (latestCall?.status === 'succeeded' || latestCall?.status === 'cancelled') throw error
    if (latestRun.cancel_requested === 1 && latestCall?.status === 'submitted') {
      transitionResearchAgentModelCallStatus(db, {
        callId: call.id,
        leaseOwner,
        toStatus: 'cancelled',
        errorCode: 'GENERATION_CANCELLED',
        errorMessage: '模型请求已按持久化取消标记中止',
        now: now(),
      })
      throw new ResearchAgentRunnerError('GENERATION_CANCELLED', '模型调用已取消')
    }
    if (latestCall?.status === 'submitted') {
      transitionResearchAgentModelCallStatus(db, {
        callId: call.id,
        leaseOwner,
        toStatus: 'outcome_unknown',
        errorCode: runnerErrorCode(error, 'GENERATION_PROVIDER_FAILED'),
        errorMessage: '模型请求已提交但未获得可验证完整响应，禁止自动重放',
        now: now(),
      })
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

function ensureRunningStep(
  db: Database.Database,
  run: ResearchAgentRunRow,
  leaseOwner: string,
  kind: ResearchAgentRunPhase,
  stepInput: unknown,
  existing: ResearchAgentStepRow | null,
  now: number,
): ResearchAgentStepRow {
  if (existing?.status === 'running') return existing
  if (existing?.status === 'queued' || existing?.status === 'failed') {
    return transitionResearchAgentStepStatus(db, {
      stepId: existing.id,
      leaseOwner,
      toStatus: 'running',
      now,
    })
  }
  if (existing?.status === 'cancelled') {
    throw new ResearchAgentRunnerError('GENERATION_CANCELLED', '当前研究步骤已经取消')
  }
  const ledger = requireLedger(db, run.id)
  const step = createResearchAgentStep(db, {
    runId: run.id,
    leaseOwner,
    ordinal: Math.max(0, ...ledger.steps.map((item) => item.ordinal)) + 1,
    kind,
    stepInput,
    predecessorStepId: ledger.steps.filter((item) => item.status === 'succeeded').at(-1)?.id ?? null,
    id: randomUUID(),
    now,
  })
  return transitionResearchAgentStepStatus(db, {
    stepId: step.id,
    leaseOwner,
    toStatus: 'running',
    now,
  })
}

function singletonStep(db: Database.Database, runId: string, kind: ResearchAgentRunPhase): ResearchAgentStepRow | null {
  return requireLedger(db, runId).steps.filter((step) => step.kind === kind).at(-1) ?? null
}

function storedPlan(run: ResearchAgentRunRow): ResearchAgentPlanAction {
  if (!run.plan_json) throw new ResearchAgentRunnerError('PLAN_MISSING', '研究计划尚未固化')
  return parseResearchAgentPlanAction(run.plan_json)
}

function buildEvidenceGateBlockedAction(
  run: ResearchAgentRunRow,
  gate: ResearchAgentEvidenceGateResult,
  toolCalls: ResearchAgentToolCallRow[],
): ResearchAgentFinalAction {
  const passed = gate.checks.filter((check) => check.status === 'passed')
  const failed = gate.checks.filter((check) => check.status === 'failed')
  const networkTools = gate.requiredNetworkTools.length > 0
    ? gate.requiredNetworkTools.map((toolId) => `\`${toolId}\``).join('、')
    : '受控网页正文取证工具'
  const networkCalls = toolCalls.filter((call) => isResearchAgentNetworkToolId(call.tool_id))
  const submittedNetworkCalls = networkCalls.filter((call) => call.submitted_at != null)
  const networkAttempted = submittedNetworkCalls.length > 0
  const opening = gate.questionProfile.offlineRequested
    ? '本次运行未进入模型综合。用户要求仅使用本地资料，而当前账本没有达到最低取证条件。'
    : networkAttempted
      ? `本次运行已提交并完成或收敛${submittedNetworkCalls.length}次受控联网工具，但可验证正文、独立来源、时效或一级来源仍未达到门禁要求。`
      : '本次运行未进入模型综合。当前账本没有达到最低取证条件，且尚未取得可用的受控联网正文。'
  const reportMarkdown = [
    '# 结论摘要',
    opening,
    '',
    '## 支持证据',
    ...(passed.length > 0
      ? passed.map((check) => `- ${check.message}`)
      : ['- 当前账本没有满足最低综合条件的证据类别。']),
    '',
    '## 反证与风险',
    '- 仅凭行情、标题索引或项目摘要继续推断，会把线索误当成可核验事实。',
    '- 联网本身不等于达到取证门槛；后续仍需正文、来源等级、发布时间和交叉验证。',
    '',
    '## 未知项',
    ...failed.map((check) => `- ${check.code}：${check.message}`),
    '',
    '## 资料截点',
    `- 本地资料截点：${run.as_of}。`,
    `- 门禁规则：${gate.ruleVersion}。`,
    '',
    '## 继续验证清单',
    `- ${networkAttempted ? '继续从同一主体的已授权候选中' : `需要通过${networkTools}`}补齐并固化正文证据。`,
    '- 联网取证仍不足或失败时，结果必须保持 blocked，不得用模型记忆补齐。',
  ].join('\n')
  return {
    protocolVersion: RESEARCH_AGENT_PROTOCOL_VERSION,
    action: 'finish',
    outcome: 'blocked',
    reportMarkdown,
    rationale: gate.summary,
  }
}

interface MultiPerspectiveSource {
  run: ResearchAgentRunRow
  ledger: NonNullable<ReturnType<typeof getResearchAgentRunLedger>>
  evidenceContrast: ResearchEvidenceContrast
  evidenceSnapshotSha256: string
  allowedReferences: ReadonlySet<string>
  persistedFacts: unknown
}

function validateMultiPerspectiveSource(
  db: Database.Database,
  run: ResearchAgentRunRow,
): MultiPerspectiveSource {
  if (run.run_kind !== 'multi_perspective' || !run.parent_run_id) {
    throw new ResearchAgentRunnerError('SOURCE_RUN_INVALID', '多视角复核缺少有效父运行')
  }
  const sourceLedger = getResearchAgentRunLedger(db, run.parent_run_id)
  if (!sourceLedger || sourceLedger.run.run_kind !== 'single_agent') {
    throw new ResearchAgentRunnerError('SOURCE_RUN_INVALID', '多视角复核只能读取单 Agent 父运行')
  }
  const source = sourceLedger.run
  if (source.status !== 'succeeded' || source.outcome === 'blocked' || !source.report_markdown || !source.report_sha256) {
    throw new ResearchAgentRunnerError('SOURCE_RUN_NOT_ELIGIBLE', '父运行尚未形成可复核的正式研究结果')
  }
  if (
    source.discussion_session_id !== run.discussion_session_id
    || source.question !== run.question
    || source.subjects_json !== run.subjects_json
    || source.as_of !== run.as_of
    || source.provider !== run.provider
    || source.model !== run.model
    || source.model_config_fingerprint !== run.model_config_fingerprint
  ) {
    throw new ResearchAgentRunnerError('SOURCE_RUN_MISMATCH', '子运行与父运行的讨论、主体、截点或固定模型不一致')
  }
  const context = safeJson(run.context_snapshot_json)
  if (
    !isRecord(context)
    || context.schemaVersion !== 1
    || context.kind !== 'multi_perspective_source'
    || context.sourceRunId !== source.id
    || context.sourceReportSha256 !== source.report_sha256
    || context.sourceEvidenceSnapshotSha256 !== source.evidence_snapshot_sha256
  ) {
    throw new ResearchAgentRunnerError('EVIDENCE_MISMATCH', '子运行固化的父证据身份无效')
  }
  const sourceArtifact = storedAuditArtifact(sourceLedger)
  const evidenceSnapshotSha256 = hashResearchEvidenceContrast(sourceArtifact.evidenceContrast)
  const validatedReferenceIds = validatedResearchEvidenceReferenceIds(sourceArtifact.evidenceContrast)
  if (
    hashResearchAgentText(source.report_markdown.trim()) !== source.report_sha256
    || !evidenceSnapshotSha256
    || evidenceSnapshotSha256 !== source.evidence_snapshot_sha256
    || !validatedReferenceIds
  ) {
    throw new ResearchAgentRunnerError('EVIDENCE_MISMATCH', '父运行报告或证据完整性校验失败')
  }
  const allowedReferences = new Set(validatedReferenceIds)
  if (allowedReferences.size < 1) {
    throw new ResearchAgentRunnerError('EVIDENCE_MISMATCH', '父运行没有可供多视角引用的稳定证据')
  }
  return {
    run: source,
    ledger: sourceLedger,
    evidenceContrast: sourceArtifact.evidenceContrast,
    evidenceSnapshotSha256,
    allowedReferences,
    persistedFacts: buildPersistedFactContext(sourceLedger.toolCalls),
  }
}

function storedMultiPerspectiveRoles(
  ledger: ReturnType<typeof requireLedger>,
  allowedReferences: ReadonlySet<string>,
): {
  bull: MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction
  bear: MultiPerspectiveRoleAction | MultiPerspectiveUnrestrictedRoleAction
} {
  const step = ledger.steps.find((item) => item.kind === 'tooling' && item.status === 'succeeded')
  const artifact = safeJson(step?.artifact_json ?? null)
  if (!isRecord(artifact) || !isRecord(artifact.bull) || !isRecord(artifact.bear)) {
    throw new ResearchAgentRunnerError('ROLE_OUTPUT_MISSING', '多方或空方结构化产物尚未固化')
  }
  if (artifact.protocolVersion === MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION) {
    return {
      bull: parseMultiPerspectiveUnrestrictedRoleAction(JSON.stringify(artifact.bull), 'bull', allowedReferences),
      bear: parseMultiPerspectiveUnrestrictedRoleAction(JSON.stringify(artifact.bear), 'bear', allowedReferences),
    }
  }
  return {
    bull: parseMultiPerspectiveRoleAction(JSON.stringify(artifact.bull), 'bull', allowedReferences),
    bear: parseMultiPerspectiveRoleAction(JSON.stringify(artifact.bear), 'bear', allowedReferences),
  }
}

function storedMultiPerspectiveModerator(
  ledger: ReturnType<typeof requireLedger>,
  allowedReferences: ReadonlySet<string>,
): MultiPerspectiveModeratorAction | MultiPerspectiveUnrestrictedModeratorAction {
  const step = ledger.steps.find((item) => item.kind === 'synthesis' && item.status === 'succeeded')
  const artifact = safeJson(step?.artifact_json ?? null)
  if (!isRecord(artifact) || !isRecord(artifact.moderator)) {
    throw new ResearchAgentRunnerError('MODERATOR_OUTPUT_MISSING', '中立主持结构化产物尚未固化')
  }
  if (artifact.protocolVersion === MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION) {
    return parseMultiPerspectiveUnrestrictedModeratorAction(JSON.stringify(artifact.moderator), allowedReferences)
  }
  return parseMultiPerspectiveModeratorAction(JSON.stringify(artifact.moderator), allowedReferences)
}

function storedUnrestrictedMultiPerspectiveReview(
  ledger: ReturnType<typeof requireLedger>,
  allowedReferences: ReadonlySet<string>,
): {
  roundCount: number
  convergence: MultiPerspectiveConvergenceAction
  bull: MultiPerspectiveUnrestrictedRoleAction
  bear: MultiPerspectiveUnrestrictedRoleAction
} {
  const step = ledger.steps.find((item) => item.kind === 'tooling' && item.status === 'succeeded')
  const artifact = safeJson(step?.artifact_json ?? null)
  if (
    !isRecord(artifact)
    || artifact.protocolVersion !== MULTI_PERSPECTIVE_UNRESTRICTED_PROTOCOL_VERSION
    || !Number.isSafeInteger(artifact.roundCount)
    || Number(artifact.roundCount) < 2
    || !isRecord(artifact.convergence)
    || !isRecord(artifact.bull)
    || !isRecord(artifact.bear)
  ) {
    throw new ResearchAgentRunnerError('ROLE_OUTPUT_MISSING', '多轮交锋结构化产物尚未完整固化')
  }
  return {
    roundCount: Number(artifact.roundCount),
    convergence: parseMultiPerspectiveConvergenceAction(JSON.stringify(artifact.convergence)),
    bull: parseMultiPerspectiveUnrestrictedRoleAction(JSON.stringify(artifact.bull), 'bull', allowedReferences),
    bear: parseMultiPerspectiveUnrestrictedRoleAction(JSON.stringify(artifact.bear), 'bear', allowedReferences),
  }
}

function storedMultiPerspectiveRoundCount(ledger: ReturnType<typeof requireLedger>): number | undefined {
  const step = ledger.steps.find((item) => item.kind === 'tooling' && item.status === 'succeeded')
  const artifact = safeJson(step?.artifact_json ?? null)
  return isRecord(artifact) && Number.isSafeInteger(artifact.roundCount) && Number(artifact.roundCount) >= 2
    ? Number(artifact.roundCount)
    : undefined
}

function multiPerspectivePositionSignature(
  bull: MultiPerspectiveUnrestrictedRoleAction,
  bear: MultiPerspectiveUnrestrictedRoleAction,
): string {
  const project = (role: MultiPerspectiveUnrestrictedRoleAction) => ({
    role: role.role,
    thesis: role.thesis,
    claims: role.claims,
    counterpoints: role.counterpoints,
    unknowns: role.unknowns,
    verificationItems: role.verificationItems,
  })
  return createHash('sha256').update(JSON.stringify({ bull: project(bull), bear: project(bear) }), 'utf8').digest('hex')
}

function storedFinalAction(ledger: ReturnType<typeof requireLedger>): ResearchAgentFinalAction {
  const step = ledger.steps.find((item) => item.kind === 'synthesis' && item.status === 'succeeded')
  const artifact = safeJson(step?.artifact_json ?? null)
  if (isRecord(artifact) && isRecord(artifact.finalAction)) {
    return parseResearchAgentFinalAction(JSON.stringify(artifact.finalAction))
  }
  const call = step
    ? ledger.modelCalls.find((item) => item.step_id === step.id && item.purpose === 'synthesis' && item.status === 'succeeded')
    : null
  if (call?.response_text) return parseResearchAgentFinalAction(call.response_text)
  throw new ResearchAgentRunnerError('REPORT_MISSING', '最终模型报告或确定性门禁结果尚未固化')
}

function storedAuditArtifact(ledger: ReturnType<typeof requireLedger>): {
  outcome: ResearchAgentRunOutcome
  evidenceContrast: ResearchEvidenceContrast
  audit: ResearchTextAudit
} {
  const step = ledger.steps.find((item) => item.kind === 'audit' && item.status === 'succeeded')
  const value = safeJson(step?.artifact_json ?? null)
  if (!isRecord(value) || !['complete', 'partial', 'blocked'].includes(String(value.outcome))) {
    throw new ResearchAgentRunnerError('PERSIST_FAILED', '审计步骤产物缺失', true)
  }
  const evidenceContrast = value.evidenceContrast as ResearchEvidenceContrast
  const audit = value.audit as ResearchTextAudit
  if (!hashResearchEvidenceContrast(evidenceContrast) || !isRecord(audit)) {
    throw new ResearchAgentRunnerError('PERSIST_FAILED', '审计证据产物无效', true)
  }
  return { outcome: value.outcome as ResearchAgentRunOutcome, evidenceContrast, audit }
}

function buildPersistedFactContext(toolCalls: ResearchAgentToolCallRow[]): unknown {
  const facts = toolCalls
    .filter((call) => call.status === 'succeeded' && call.model_projection_json)
    .map((call) => ({
      callId: call.id,
      toolId: call.tool_id,
      inputSha256: call.input_sha256,
      projectionSha256: call.model_projection_sha256,
      projection: boundValue(safeJson(call.model_projection_json!), 8, 500, 0),
    }))
  const failureKeys = new Set<string>()
  const failures = toolCalls.flatMap((call) => {
    if (call.status !== 'failed' || !call.error_code) return []
    const key = `${call.tool_id}:${call.input_sha256}:${call.error_code}`
    if (failureKeys.has(key)) return []
    failureKeys.add(key)
    const input = safeJson(call.input_json)
    const publicInput = isRecord(input)
      ? Object.fromEntries(Object.entries(input).filter(([name]) => name !== '__executionOrigin'))
      : null
    return [{
      toolId: call.tool_id,
      inputSha256: call.input_sha256,
      input: boundValue(publicInput, 4, 300, 0),
      errorCode: call.error_code,
      errorMessage: call.error_message?.slice(0, 240) ?? null,
      terminal: call.error_code === 'NETWORK_RESPONSE_TOO_LARGE',
    }]
  }).slice(0, 24)
  const payload = { schemaVersion: 2, facts, failures, omittedData: false }
  try {
    serializeResearchAgentJson(payload, MAX_MODEL_FACT_CONTEXT_BYTES)
    return payload
  } catch (error) {
    if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'JSON_TOO_LARGE') throw error
  }
  const importantFacts = facts.filter((fact) => (
    isRecord(fact.projection)
    && Array.isArray(fact.projection.evidenceReferences)
    && fact.projection.evidenceReferences.length > 0
  ))
  for (const bounds of [
    { important: 8, recent: 8, arrays: 8, text: 500 },
    { important: 6, recent: 6, arrays: 6, text: 350 },
    { important: 4, recent: 4, arrays: 4, text: 240 },
  ]) {
    const selectedIds = new Set([
      ...importantFacts.slice(-bounds.important),
      ...facts.slice(-bounds.recent),
    ].map((fact) => fact.callId))
    const selectedFacts = facts
      .filter((fact) => selectedIds.has(fact.callId))
      .map((fact) => ({
        ...fact,
        projection: boundValue(fact.projection, bounds.arrays, bounds.text, 0),
      }))
    const compactPayload = {
      schemaVersion: 2,
      omittedData: true,
      omittedFactCount: Math.max(0, facts.length - selectedFacts.length),
      failures,
      facts: selectedFacts,
    }
    try {
      serializeResearchAgentJson(compactPayload, MAX_MODEL_FACT_CONTEXT_BYTES)
      return compactPayload
    } catch (error) {
      if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'JSON_TOO_LARGE') throw error
    }
  }
  return {
    schemaVersion: 2,
    omittedData: true,
    failures,
    facts: facts.map((fact) => ({
      ...fact,
      projection: isRecord(fact.projection)
        ? { ...fact.projection, data: { omitted: true, reason: 'cumulative_model_input_budget' } }
        : fact.projection,
    })),
  }
}

function compactMultiPerspectiveFactContext(value: unknown, maxBytes: number): unknown {
  try {
    serializeResearchAgentJson(value, maxBytes)
    return value
  } catch (error) {
    if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'JSON_TOO_LARGE') throw error
  }
  for (const bounds of [
    { arrays: 8, text: 400 },
    { arrays: 6, text: 280 },
    { arrays: 4, text: 180 },
  ]) {
    const compact = {
      schemaVersion: 2,
      omittedData: true,
      reason: 'multi_perspective_input_budget',
      facts: boundValue(value, bounds.arrays, bounds.text, 0),
    }
    try {
      serializeResearchAgentJson(compact, maxBytes)
      return compact
    } catch (error) {
      if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'JSON_TOO_LARGE') throw error
    }
  }
  return {
    schemaVersion: 2,
    omittedData: true,
    reason: 'multi_perspective_input_budget',
    facts: [],
  }
}

export function buildResearchAgentSynthesisFactContext(
  run: ResearchAgentRunRow,
  toolCalls: ResearchAgentToolCallRow[],
  evidenceGate: ResearchAgentEvidenceGateResult,
  plan: ResearchAgentPlanAction,
  allowIncompleteEvidence = false,
): unknown {
  const subjects = parseResearchAgentTrustedSubjects(safeJson(run.subjects_json))
  const observations = evidenceObservations(toolCalls)
  const documentCategories = evidenceGate.checks
    .filter((check) => check.status === 'passed')
    .map((check) => check.category)
    .filter((category): category is ResearchAgentEvidenceCategory => [
      'company_disclosures',
      'current_events',
      'industry_evidence',
    ].includes(category))
  const evidenceInput = {
    question: run.question,
    asOf: run.as_of,
    subjects,
    observations,
  }
  const qualifiedDocuments = allowIncompleteEvidence && evidenceGate.decision === 'network_required'
    ? selectResearchAgentAvailableEvidenceDocuments(evidenceInput)
    : selectResearchAgentEvidenceDocuments(evidenceInput, documentCategories)
  assertSynthesisEvidenceDocuments(evidenceGate, qualifiedDocuments)

  const callsById = new Map(toolCalls.map((call) => [call.id, call]))
  const localFacts = toolCalls.flatMap((call) => {
    if (
      call.status !== 'succeeded'
      || !call.model_projection_json
      || isResearchAgentSearchToolId(call.tool_id)
      || isResearchAgentDocumentToolId(call.tool_id)
      || !hasUsableToolCoverage(call)
    ) return []
    const projection = safeJson(call.model_projection_json)
    if (!isRecord(projection)) return []
    return [{
      callId: call.id,
      toolId: call.tool_id,
      inputSha256: call.input_sha256,
      projectionSha256: call.model_projection_sha256,
      asOf: projection.asOf ?? null,
      status: projection.status ?? null,
      sources: boundValue(projection.sources ?? [], 8, 300, 0),
      coverage: boundValue(projection.coverage ?? {}, 8, 300, 0),
      warnings: boundValue(projection.warnings ?? [], 8, 300, 0),
      evidenceReferences: boundValue(
        projection.evidenceReferences ?? projection.stableReferences ?? [],
        8,
        300,
        0,
      ),
      data: boundValue(projection.data ?? null, 12, 1_200, 0),
    }]
  }).slice(0, 24)
  const failures = synthesisFailureContext(toolCalls)
  const queryContext = [run.question, ...plan.questions].join('\n')

  for (const excerptLimit of [8_000, 6_000, 4_000, 2_500, 1_200]) {
    const evidenceDocuments = qualifiedDocuments.map((document) => {
      const call = document.callId ? callsById.get(document.callId) : null
      if (!call) {
        throw new ResearchAgentRunnerError(
          'SYNTHESIS_EVIDENCE_MISMATCH',
          '证据门禁采用的正文无法关联到同一运行工具账本',
        )
      }
      const references = safeJson(call.stable_references_json)
      const stableReferences = Array.isArray(references)
        ? references.filter(isStableReference)
        : []
      if (stableReferences.length < 1) {
        throw new ResearchAgentRunnerError(
          'SYNTHESIS_EVIDENCE_MISMATCH',
          '证据门禁采用的正文缺少可供综合引用的稳定编号',
        )
      }
      const excerpt = relevantEvidenceExcerpt(document.excerpt, queryContext, excerptLimit)
      return {
        callId: call.id,
        toolId: call.tool_id,
        inputSha256: call.input_sha256,
        envelopeSha256: call.envelope_sha256,
        projectionSha256: call.model_projection_sha256,
        referenceIds: stableReferences.map((reference) => reference.referenceId),
        title: document.title,
        publishedDate: document.publishedDate,
        sourceClass: document.sourceClass,
        sourceDomain: document.sourceDomain,
        primarySourceConfirmed: document.primary,
        contentSha256: document.contentSha256,
        excerpt,
        excerptTruncated: excerpt.length < document.excerpt.length,
      }
    })
    const payload = {
      schemaVersion: 3,
      contextCompleteness: evidenceGate.decision === 'local_sufficient' ? 'complete' : 'partial',
      omittedData: false,
      evidenceGate: {
        ruleVersion: evidenceGate.ruleVersion,
        decision: evidenceGate.decision,
        maximumOutcome: evidenceGate.maximumOutcome,
        passedChecks: evidenceGate.checks
          .filter((check) => check.status === 'passed')
          .map((check) => ({ category: check.category, code: check.code })),
      },
      localFacts,
      evidenceDocuments,
      failures,
    }
    try {
      serializeResearchAgentJson(payload, MAX_MODEL_FACT_CONTEXT_BYTES)
      return payload
    } catch (error) {
      if (!(error instanceof ResearchAgentRunRepositoryError) || error.code !== 'JSON_TOO_LARGE') throw error
    }
  }
  throw new ResearchAgentRunnerError(
    'SYNTHESIS_EVIDENCE_CONTEXT_TOO_LARGE',
    '门禁证据无法在固定综合输入预算内完整投影，已在模型调用前停止',
  )
}

function evidenceObservations(toolCalls: ResearchAgentToolCallRow[]) {
  return toolCalls.map((call) => ({
    callId: call.id,
    toolId: call.tool_id,
    callStatus: call.status,
    envelope: safeJson(call.envelope_json ?? null),
  }))
}

function assertSynthesisEvidenceDocuments(
  evidenceGate: ResearchAgentEvidenceGateResult,
  documents: ReturnType<typeof selectResearchAgentEvidenceDocuments>,
): void {
  for (const check of evidenceGate.checks.filter((item) => item.status === 'passed')) {
    if (check.category === 'company_disclosures' && !documents.some((document) => document.primary)) {
      throw new ResearchAgentRunnerError('SYNTHESIS_EVIDENCE_MISMATCH', '正式披露门禁通过但综合输入缺少一级正文')
    }
    if (check.category === 'current_events' && documents.length < 2) {
      throw new ResearchAgentRunnerError('SYNTHESIS_EVIDENCE_MISMATCH', '当前事件门禁通过但综合输入缺少两份独立正文')
    }
    if (check.category === 'industry_evidence' && documents.length < 3) {
      throw new ResearchAgentRunnerError('SYNTHESIS_EVIDENCE_MISMATCH', '产业证据门禁通过但综合输入缺少三份独立正文')
    }
  }
}

function synthesisFailureContext(toolCalls: ResearchAgentToolCallRow[]) {
  const seen = new Set<string>()
  return toolCalls.flatMap((call) => {
    if (call.status !== 'failed' || !call.error_code) return []
    const key = `${call.tool_id}:${call.input_sha256}:${call.error_code}`
    if (seen.has(key)) return []
    seen.add(key)
    const input = safeJson(call.input_json)
    return [{
      toolId: call.tool_id,
      inputSha256: call.input_sha256,
      input: isRecord(input)
        ? boundValue(Object.fromEntries(Object.entries(input).filter(([name]) => name !== '__executionOrigin')), 4, 300, 0)
        : null,
      errorCode: call.error_code,
      errorMessage: call.error_message?.slice(0, 240) ?? null,
      terminal: call.error_code === 'NETWORK_RESPONSE_TOO_LARGE',
    }]
  }).slice(0, 16)
}

function relevantEvidenceExcerpt(value: string, queryContext: string, limit: number): string {
  const text = value.trim()
  if (text.length <= limit) return text
  const terms = evidenceExcerptTerms(queryContext)
  const windows: Array<{ start: number; end: number }> = [{ start: 0, end: Math.min(700, text.length) }]
  const normalizedText = text.toLowerCase()
  for (const term of terms) {
    const position = normalizedText.indexOf(term.toLowerCase())
    if (position < 0) continue
    windows.push({
      start: Math.max(0, position - 350),
      end: Math.min(text.length, position + term.length + 850),
    })
    if (windows.length >= 10) break
  }
  windows.sort((left, right) => left.start - right.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const window of windows) {
    const previous = merged.at(-1)
    if (previous && window.start <= previous.end + 80) previous.end = Math.max(previous.end, window.end)
    else merged.push({ ...window })
  }
  const excerpt = merged.map((window) => text.slice(window.start, window.end)).join('\n…\n')
  return excerpt.slice(0, limit)
}

function evidenceExcerptTerms(value: string): string[] {
  const stopWords = new Set(['研究', '分析', '如何', '是否', '以及', '什么', '当前', '现在', '进行', '影响', '到底'])
  const terms: string[] = []
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  for (const part of segmenter.segment(value)) {
    const term = part.segment.trim().toLowerCase()
    if (!part.isWordLike || term.length < 2 || stopWords.has(term) || terms.includes(term)) continue
    terms.push(term)
    if (terms.length >= 24) break
  }
  return terms
}

function evidenceGateForLedger(
  run: ResearchAgentRunRow,
  toolCalls: ResearchAgentToolCallRow[],
): ResearchAgentEvidenceGateResult {
  return assessResearchAgentEvidence({
    question: run.question,
    asOf: run.as_of,
    subjects: parseResearchAgentTrustedSubjects(safeJson(run.subjects_json)),
    observations: evidenceObservations(toolCalls),
  })
}

function buildLedgerEvidenceContrast(
  run: ResearchAgentRunRow,
  toolCalls: ResearchAgentToolCallRow[],
  generatedAt: number,
): ResearchEvidenceContrast {
  const trustedSubjects = parseResearchAgentTrustedSubjects(safeJson(run.subjects_json))
  const labels = new Map(trustedSubjects.map((subject) => [
    subject.kind === 'stock' ? subject.tsCode.replace(/\.(SH|SZ|BJ)$/, '') : subject.id,
    subject.label ?? (subject.kind === 'stock' ? subject.tsCode : subject.id),
  ]))
  const subjects = new Map<string, ResearchEvidenceSubject>()
  const warnings: string[] = []
  for (const call of toolCalls.filter((item) => item.status === 'succeeded')) {
    const references = safeJson(call.stable_references_json)
    if (!Array.isArray(references)) continue
    const projection = safeJson(call.model_projection_json ?? null)
    const detail = projectionDetail(projection, call)
    const callWarnings = safeJson(call.warnings_json)
    if (Array.isArray(callWarnings)) {
      warnings.push(...callWarnings.filter((item): item is string => typeof item === 'string'))
    }
    for (const rawReference of references) {
      if (!isStableReference(rawReference)) continue
      const expectedId = getResearchEvidenceReferenceId(
        { subjectKind: rawReference.subjectKind, subjectId: rawReference.subjectId },
        { toolId: rawReference.toolId, code: rawReference.code },
      )
      if (expectedId !== rawReference.referenceId) {
        warnings.push(`${call.tool_id}: 稳定引用哈希错配，已排除${rawReference.referenceId}`)
        continue
      }
      const key = `${rawReference.subjectKind}\u0000${rawReference.subjectId}`
      const subject = subjects.get(key) ?? {
        subjectKind: rawReference.subjectKind,
        subjectId: rawReference.subjectId,
        label: labels.get(rawReference.subjectId) ?? rawReference.subjectId,
        supporting: [],
        challenging: [],
        unknowns: [],
      }
      const item: ResearchEvidenceItem = {
        referenceId: rawReference.referenceId,
        code: rawReference.code,
        toolId: rawReference.toolId,
        label: rawReference.label.slice(0, 80),
        detail,
        factDate: rawReference.factDate,
        sourceIds: rawReference.sourceIds.slice(0, 4),
      }
      const category = rawReference.status === 'ready' ? subject.supporting : subject.unknowns
      if (category.length < 8 && !category.some((existing) => existing.code === item.code)) category.push(item)
      subjects.set(key, subject)
    }
  }
  const boundedSubjects = [...subjects.values()].slice(0, 8)
  const uniqueWarnings = [...new Set(warnings.map((warning) => warning.slice(0, 200)))].slice(0, 20)
  const markdown = [
    '## 确定性证据对照',
    `- 事实截点：${run.as_of}；只包含当前运行已经持久化的本地与受控联网工具结果。`,
    '- 支持项不等于买入结论，未知项不得由模型记忆补齐。',
    ...boundedSubjects.flatMap((subject) => [
      `### ${subject.label}｜${subject.subjectKind}:${subject.subjectId}`,
      ...[...subject.supporting, ...subject.challenging, ...subject.unknowns]
        .map((item) => `- [${item.referenceId}] ${item.label}：${item.detail}`),
    ]),
  ].join('\n').slice(0, 8_000)
  return {
    schemaVersion: 1,
    generatedAt,
    asOf: run.as_of,
    subjects: boundedSubjects,
    warnings: uniqueWarnings,
    markdown,
  }
}

function downgradeOutcome(
  outcome: ResearchAgentRunOutcome,
  evidenceGate: ResearchAgentEvidenceGateResult,
): ResearchAgentRunOutcome {
  if (outcome === 'blocked') return outcome
  if (evidenceGate.decision === 'local_sufficient') return outcome
  return outcome === 'complete' ? 'partial' : outcome
}

function isUnrestrictedSingleAgentRun(run: ResearchAgentRunRow): boolean {
  return run.run_kind === 'single_agent'
    && researchAgentBudgetForRun(run).id === 'single-agent-unrestricted-v3'
}

function settleRunnerFailure(
  db: Database.Database,
  input: { runId: string; leaseOwner: string },
  options: ResearchAgentRunnerOptions,
  error: unknown,
): ResearchAgentRunRow {
  const now = (options.now ?? Date.now)()
  let run = requireRun(db, input.runId)
  if (run.status !== 'running') return run
  const code = runnerErrorCode(error, 'INTERNAL_ERROR')
  const message = runnerErrorMessage(error, '单Agent研究运行失败')
  const cancelled = run.cancel_requested === 1 || code === 'GENERATION_CANCELLED'
  const ledger = requireLedger(db, run.id)
  const modelOutcomeUnknown = ledger.modelCalls.some((call) => call.status === 'outcome_unknown')
  const toolOutcomeUnknown = ledger.toolCalls.some((call) => call.status === 'outcome_unknown')
  const outcomeUnknown = !cancelled && (modelOutcomeUnknown || toolOutcomeUnknown)
  const settledCode = outcomeUnknown
    ? toolOutcomeUnknown ? 'TOOL_OUTCOME_UNKNOWN' : 'MODEL_OUTCOME_UNKNOWN'
    : code
  const settledMessage = outcomeUnknown
    ? toolOutcomeUnknown
      ? '联网工具请求已提交但结果或费用无法确认，同一运行禁止继续或自动重放'
      : '模型请求已提交但结果或费用无法确认，同一运行禁止继续或自动重放'
    : message
  const runningStep = ledger.steps.find((step) => step.status === 'running')
  if (runningStep) {
    try {
      transitionResearchAgentStepStatus(db, {
        stepId: runningStep.id,
        leaseOwner: input.leaseOwner,
        toStatus: cancelled ? 'cancelled' : 'failed',
        errorCode: settledCode,
        errorMessage: settledMessage,
        now,
      })
    } catch {
      // The call ledger remains authoritative if the lease or cancellation won the race.
    }
  }
  run = requireRun(db, run.id)
  if (run.status !== 'running') return run
  return transitionResearchAgentRunStatus(db, {
    runId: run.id,
    leaseOwner: input.leaseOwner,
    toStatus: cancelled ? 'cancelled' : outcomeUnknown ? 'needs_attention' : 'failed',
    errorCode: settledCode,
    errorMessage: settledMessage,
    retryable: outcomeUnknown ? false : error instanceof ResearchAgentRunnerError ? error.retryable : false,
    now,
  })
}

function calculateModelCost(
  response: AIProviderResponse,
  snapshot: ResearchAgentPriceSnapshot | null,
  config: ResearchAgentPinnedModelConfig,
): { snapshot: ResearchAgentPriceSnapshot; amount: number } | null {
  if (
    !snapshot
    || snapshot.provider !== config.provider
    || snapshot.model !== config.model
    || !response.usage
    || typeof response.usage.inputTokens !== 'number'
    || typeof response.usage.outputTokens !== 'number'
  ) return null
  const amount = response.usage.inputTokens * snapshot.inputPerMillionTokens / 1_000_000
    + response.usage.outputTokens * snapshot.outputPerMillionTokens / 1_000_000
  return { snapshot, amount }
}

function modelOrRuleDrift(
  run: ResearchAgentRunRow,
  config: ResearchAgentPinnedModelConfig,
): { code: string; message: string } | null {
  if (run.provider !== config.provider || run.model !== config.model || run.model_config_fingerprint !== config.fingerprint) {
    return { code: 'MODEL_CONFIG_CHANGED', message: '固定provider/model或Base URL语义已经变化' }
  }
  const legacyMultiPerspective = run.run_kind === 'multi_perspective'
    && researchAgentBudgetForRun(run).id === RESEARCH_AGENT_MULTI_PERSPECTIVE_LEGACY_BUDGET.id
  const supportedPromptRules = run.run_kind === 'multi_perspective'
    ? legacyMultiPerspective
      ? new Set([MULTI_PERSPECTIVE_PROMPT_RULE_VERSION])
      : new Set([
          MULTI_PERSPECTIVE_PREVIOUS_UNRESTRICTED_PROMPT_RULE_VERSION,
          MULTI_PERSPECTIVE_UNRESTRICTED_PROMPT_RULE_VERSION,
        ])
    : new Set([RESEARCH_AGENT_PREVIOUS_PROMPT_RULE_VERSION, RESEARCH_AGENT_PROMPT_RULE_VERSION])
  const expectedToolRegistry = run.run_kind === 'multi_perspective'
    ? legacyMultiPerspective
      ? MULTI_PERSPECTIVE_TOOL_REGISTRY_VERSION
      : MULTI_PERSPECTIVE_UNRESTRICTED_TOOL_REGISTRY_VERSION
    : RESEARCH_AGENT_TOOL_REGISTRY_VERSION
  if (!supportedPromptRules.has(run.prompt_rule_version)) {
    return { code: 'RULE_VERSION_CHANGED', message: '研究提示词规则版本已经变化' }
  }
  if (run.tool_registry_version !== expectedToolRegistry) {
    return { code: 'TOOL_REGISTRY_CHANGED', message: 'Agent受控工具注册表版本已经变化' }
  }
  return null
}

function storedModelResponse(call: ResearchAgentModelCallRow): AIProviderResponse {
  if (!call.response_text) throw new ResearchAgentRunnerError('MODEL_RESPONSE_MISSING', '成功模型调用缺少响应正文')
  return {
    text: call.response_text,
    responseId: call.response_id,
    finishReason: call.finish_reason,
    usage: {
      inputTokens: call.input_tokens,
      outputTokens: call.output_tokens,
      totalTokens: call.total_tokens,
    },
  }
}

function boundedTrustedContext(contextJson: string): unknown {
  const value = safeJson(contextJson)
  const bounded = boundValue(value, 12, 800, 0)
  try {
    serializeResearchAgentJson(bounded, MAX_TRUSTED_CONTEXT_BYTES)
    return bounded
  } catch {
    return { omitted: true, reason: 'trusted_context_model_budget', contextSha256: createHash('sha256').update(contextJson).digest('hex') }
  }
}

function boundValue(value: unknown, arrayLimit: number, textLimit: number, depth: number): unknown {
  if (typeof value === 'string') return value.slice(0, textLimit)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (depth >= 8) return '[depth-limited]'
  if (Array.isArray(value)) return value.slice(0, arrayLimit).map((item) => boundValue(item, arrayLimit, textLimit, depth + 1))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [
      key,
      boundValue(item, arrayLimit, textLimit, depth + 1),
    ]))
  }
  return String(value).slice(0, textLimit)
}

function projectionDetail(projection: unknown, call: ResearchAgentToolCallRow): string {
  if (isRecord(projection)) {
    const data = projection.data
    const text = safeStringify(data)
    if (text) return `${call.tool_id}=${String(projection.status)}；${text}`.slice(0, 240)
  }
  return `${call.tool_id}已保存；结果哈希=${call.envelope_sha256 ?? 'unknown'}`.slice(0, 240)
}

function isStableReference(value: unknown): value is ResearchAgentStableToolReference {
  if (!isRecord(value)) return false
  return EVIDENCE_REFERENCE_PATTERN.test(String(value.referenceId))
    && ['stock', 'judgment', 'industry_project'].includes(String(value.subjectKind))
    && typeof value.subjectId === 'string'
    && typeof value.toolId === 'string'
    && typeof value.code === 'string'
    && typeof value.label === 'string'
    && ['ready', 'partial', 'missing', 'blocked'].includes(String(value.status))
    && (value.factDate == null || typeof value.factDate === 'string')
    && Array.isArray(value.sourceIds)
    && value.sourceIds.every((item) => typeof item === 'string')
}

function excludedUrls(contextJson: string): string[] {
  const context = safeJson(contextJson)
  if (!isRecord(context) || !Array.isArray(context.excludedUrls)) return []
  return context.excludedUrls.filter((item): item is string => typeof item === 'string').slice(0, 40)
}

function requireRun(db: Database.Database, runId: string): ResearchAgentRunRow {
  const run = getResearchAgentRun(db, runId)
  if (!run) throw new ResearchAgentRunnerError('NOT_FOUND', '研究运行不存在')
  return run
}

function requireLedger(db: Database.Database, runId: string) {
  const ledger = getResearchAgentRunLedger(db, runId)
  if (!ledger) throw new ResearchAgentRunnerError('NOT_FOUND', '研究运行账本不存在')
  return ledger
}

function throwIfCancelled(run: ResearchAgentRunRow, signal?: AbortSignal): void {
  if (run.cancel_requested === 1 || signal?.aborted) {
    throw new ResearchAgentRunnerError('GENERATION_CANCELLED', '研究运行已取消')
  }
}

function normalizedBaseUrl(provider: AIProvider, value?: string | null): string {
  const raw = value?.trim() || PROVIDER_DEFAULT_BASE_URLS[provider]
  return raw.replace(/\/+$/, '')
}

function normalizeMaxTokens(value?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function safeStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : null
  } catch { return null }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function phaseLabel(phase: ResearchAgentRunPhase, runKind: ResearchAgentRunRow['run_kind']): string {
  return (runKind === 'multi_perspective' ? {
    planning: '锁定共享证据',
    tooling: '多方与空方研判',
    synthesis: '中立主持',
    audit: '引用与文本审计',
    persist: '讨论写回',
  } : {
    planning: '研究计划',
    tooling: '事实读取与受控补证',
    synthesis: '证据门禁与综合',
    audit: '确定性审计',
    persist: '本地写回',
  })[phase]
}

export function buildResearchAgentRunnerProgress(
  db: Database.Database,
  run: ResearchAgentRunRow,
  message: string,
  executionStartedAt?: number | null,
): ResearchAgentRunnerProgress {
  const activeStep = getResearchAgentRunLedger(db, run.id)?.steps
    .filter((step) => step.status === 'running')
    .at(-1)
  const usageKnown = run.usage_status !== 'not_started'
  const budget = researchAgentBudgetForRun(run)
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    stepOrdinal: activeStep?.ordinal ?? null,
    message,
    revision: run.revision,
    executionStartedAt: executionStartedAt ?? run.started_at,
    modelCalls: {
      completed: run.model_call_count,
      maximum: budget.maxModelCalls,
    },
    toolCalls: {
      completed: run.tool_call_count,
      maximum: budget.maxToolCalls,
    },
    usage: {
      inputTokens: usageKnown ? run.input_tokens : null,
      outputTokens: usageKnown ? run.output_tokens : null,
      totalTokens: usageKnown ? run.total_tokens : null,
      completeness: run.usage_status === 'complete'
        ? 'complete'
        : run.usage_status === 'partial'
          ? 'partial'
          : 'unknown',
    },
    updatedAt: run.updated_at,
  }
}

function emitProgress(
  options: ResearchAgentRunnerOptions,
  db: Database.Database,
  run: ResearchAgentRunRow,
  message: string,
): void {
  try {
    options.onProgress?.(buildResearchAgentRunnerProgress(db, run, message, options.executionStartedAt))
  } catch { /* UI acceleration only */ }
}

function runnerErrorCode(error: unknown, fallback: string): string {
  if (error instanceof ResearchAgentRunnerError || error instanceof ResearchAgentRunRepositoryError) return error.code
  if (isRecord(error) && typeof error.code === 'string') return error.code.slice(0, 120)
  return fallback
}

function runnerErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message.slice(0, 1_000) : fallback
}
