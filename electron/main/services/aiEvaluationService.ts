import type Database from 'better-sqlite3'
import { getAIConfig, getConfiguredProviders, getProviderConfig } from '../database/aiConfigRepository'
import {
  completeAiEvaluationRun,
  createAiEvaluationRun,
  failAiEvaluationRun,
  findPreviousComparableAiEvaluationRun,
  getActiveAiEvaluationRun,
  getAiEvaluationRun,
  listAiEvaluationCaseResults,
  listAiEvaluationRuns,
  saveAiEvaluationCaseResult,
  updateAiEvaluationProgress,
  type AiEvaluationRunRecord,
} from '../database/aiEvaluationRepository'
import type { AIProvider } from '../database/types'
import { resolveArticleAnalysisPrompt } from '../aiPromptDefaults'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { sha256 } from '../utils/hashUtils'
import { callAIProvider, PROVIDER_LABELS, PROVIDER_MODELS, type AIProviderResponse } from './aiProvider'
import { buildSkillsBlock } from './aiSkillsPromptService'
import {
  AI_EVALUATION_CASES,
  AI_EVALUATION_DIMENSION_WEIGHTS,
  AI_EVALUATION_SUITE_FINGERPRINT,
  AI_EVALUATION_SUITE_ID,
  AI_EVALUATION_SUITE_VERSION,
  aggregateAiEvaluationScores,
  buildAiEvaluationPrompt,
  evaluateAiEvaluationCase,
  type AiEvaluationCaseScore,
} from './aiEvaluationSuite'

const SUPPORTED_PROVIDERS = new Set<AIProvider>(['chatgpt', 'claude', 'qwen', 'deepseek'])

export class AiEvaluationError extends Error {
  constructor(public readonly code: 'INVALID_PARAM' | 'AI_NOT_CONFIGURED' | 'RUN_ALREADY_ACTIVE' | 'NOT_FOUND', message: string) {
    super(message)
    this.name = 'AiEvaluationError'
  }
}

interface EvaluationExecutionContext {
  provider: AIProvider
  model: string
  apiKey: string
  baseUrl: string | null
  maxTokens: number
  articlePrompt: string
  skillsBlock: string
  businessPromptFingerprint: string
  evaluationPromptFingerprint: string
}

export interface AiEvaluationConfiguredTarget {
  provider: AIProvider
  providerLabel: string
  model: string
}

export interface AiEvaluationRunDetail {
  run: AiEvaluationRunRecord
  cases: ReturnType<typeof listAiEvaluationCaseResults>
  comparison: null | {
    runId: number
    score: number
    delta: number
  }
  baselineChanged: boolean
}

export type AiEvaluationRequester = (prompt: string) => Promise<AIProviderResponse>

function modelForProvider(provider: AIProvider, configured: string | null): string {
  return configured || PROVIDER_MODELS[provider]?.[0] || ''
}

function publicTarget(db: Database.Database, provider: string): AiEvaluationConfiguredTarget | null {
  if (!SUPPORTED_PROVIDERS.has(provider as AIProvider)) return null
  const typed = provider as AIProvider
  const config = getProviderConfig(db, typed)
  const model = modelForProvider(typed, config?.model ?? null)
  if (!config?.apiKeyEncrypted || !model) return null
  return { provider: typed, providerLabel: PROVIDER_LABELS[typed] ?? typed, model }
}

function resolveExecutionContext(db: Database.Database, provider: string): EvaluationExecutionContext {
  const target = publicTarget(db, provider)
  if (!target) throw new AiEvaluationError('AI_NOT_CONFIGURED', '所选AI厂商尚未完整配置API Key和模型')
  const providerConfig = getProviderConfig(db, target.provider)
  const apiKey = providerConfig?.apiKeyEncrypted ? decryptApiKey(providerConfig.apiKeyEncrypted) : null
  if (!apiKey) throw new AiEvaluationError('AI_NOT_CONFIGURED', '所选AI厂商的API Key无法读取')
  const globalConfig = getAIConfig(db)
  const articlePrompt = resolveArticleAnalysisPrompt(providerConfig?.presetPrompt, globalConfig.presetPrompt)
  const skillsBlock = buildSkillsBlock(db)
  const prompts = AI_EVALUATION_CASES.map((definition) => buildAiEvaluationPrompt(definition, articlePrompt, skillsBlock))
  return {
    provider: target.provider,
    model: target.model,
    apiKey,
    baseUrl: providerConfig?.baseUrl ?? null,
    maxTokens: Math.min(4096, Math.max(512, providerConfig?.maxTokens ?? 4096)),
    articlePrompt,
    skillsBlock,
    businessPromptFingerprint: sha256(JSON.stringify({ articlePrompt, skillsBlock })),
    evaluationPromptFingerprint: sha256(JSON.stringify(prompts)),
  }
}

export function getAiEvaluationWorkbench(db: Database.Database) {
  const targets = getConfiguredProviders(db)
    .map((provider) => publicTarget(db, provider))
    .filter((target): target is AiEvaluationConfiguredTarget => target != null)
  return {
    suite: {
      id: AI_EVALUATION_SUITE_ID,
      version: AI_EVALUATION_SUITE_VERSION,
      fingerprint: AI_EVALUATION_SUITE_FINGERPRINT,
      callCount: AI_EVALUATION_CASES.length,
      cases: AI_EVALUATION_CASES.map(({ id, title, kind, purpose }) => ({ id, title, kind, purpose })),
      dimensionWeights: AI_EVALUATION_DIMENSION_WEIGHTS,
    },
    targets,
    activeRun: getActiveAiEvaluationRun(db),
    runs: listAiEvaluationRuns(db, 20),
  }
}

function previousProviderRun(db: Database.Database, run: AiEvaluationRunRecord): AiEvaluationRunRecord | null {
  return listAiEvaluationRuns(db, 100).find((item) => (
    item.id !== run.id
    && item.status === 'completed'
    && item.provider === run.provider
    && item.model === run.model
    && item.createdAt <= run.createdAt
  )) ?? null
}

export function getAiEvaluationRunDetail(db: Database.Database, runId: number): AiEvaluationRunDetail {
  const run = getAiEvaluationRun(db, runId)
  if (!run) throw new AiEvaluationError('NOT_FOUND', 'AI评测运行不存在')
  const comparable = findPreviousComparableAiEvaluationRun(db, run)
  const previous = previousProviderRun(db, run)
  return {
    run,
    cases: listAiEvaluationCaseResults(db, run.id),
    comparison: comparable?.totalScore != null && run.totalScore != null
      ? {
          runId: comparable.id,
          score: comparable.totalScore,
          delta: Math.round((run.totalScore - comparable.totalScore) * 100) / 100,
        }
      : null,
    baselineChanged: Boolean(previous && !comparable),
  }
}

export async function executeAiEvaluationRun(
  db: Database.Database,
  runId: number,
  context: Pick<EvaluationExecutionContext, 'articlePrompt' | 'skillsBlock'>,
  request: AiEvaluationRequester,
): Promise<void> {
  const results: AiEvaluationCaseScore[] = []
  try {
    for (let index = 0; index < AI_EVALUATION_CASES.length; index += 1) {
      const definition = AI_EVALUATION_CASES[index]
      updateAiEvaluationProgress(db, runId, index, definition.id)
      const prompt = buildAiEvaluationPrompt(definition, context.articlePrompt, context.skillsBlock)
      const response = await request(prompt)
      if (!response.text?.trim()) throw new Error(`样本“${definition.title}”没有返回有效内容`)
      const score = evaluateAiEvaluationCase(definition.id, response.text)
      saveAiEvaluationCaseResult(db, {
        runId,
        result: score,
        responseText: response.text,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        totalTokens: response.usage?.totalTokens,
      })
      results.push(score)
      updateAiEvaluationProgress(db, runId, index + 1, null)
    }
    completeAiEvaluationRun(db, runId, aggregateAiEvaluationScores(results))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    failAiEvaluationRun(db, runId, message)
    throw error
  }
}

export function startAiEvaluationRun(db: Database.Database, provider: string): { runId: number; status: 'running'; totalCases: number } {
  if (!SUPPORTED_PROVIDERS.has(provider as AIProvider)) throw new AiEvaluationError('INVALID_PARAM', 'AI厂商参数无效')
  if (getActiveAiEvaluationRun(db)) throw new AiEvaluationError('RUN_ALREADY_ACTIVE', '已有AI评测正在运行')
  const context = resolveExecutionContext(db, provider)
  const runId = createAiEvaluationRun(db, {
    suiteId: AI_EVALUATION_SUITE_ID,
    suiteVersion: AI_EVALUATION_SUITE_VERSION,
    suiteFingerprint: AI_EVALUATION_SUITE_FINGERPRINT,
    provider: context.provider,
    model: context.model,
    businessPromptFingerprint: context.businessPromptFingerprint,
    evaluationPromptFingerprint: context.evaluationPromptFingerprint,
    progressTotal: AI_EVALUATION_CASES.length,
  })
  const requester: AiEvaluationRequester = (prompt) => callAIProvider({
    provider: context.provider,
    model: context.model,
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
    maxTokens: context.maxTokens,
    prompt,
  })
  void executeAiEvaluationRun(db, runId, context, requester).catch((error) => {
    console.error(`[aiEvaluation] run=${runId} failed:`, error)
  })
  return { runId, status: 'running', totalCases: AI_EVALUATION_CASES.length }
}
