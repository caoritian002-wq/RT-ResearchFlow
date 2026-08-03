import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getAIConfig, getProviderConfig } from '../database/aiConfigRepository'
import {
  getMatchingPremarketAIExplanation,
  savePremarketAIExplanation,
} from '../database/premarketAIExplanationRepository'
import { getPremarketScenarioVersionById } from '../database/premarketScenarioVersionRepository'
import type { AIProvider } from '../database/types'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { sha256 } from '../utils/hashUtils'
import {
  callAIProvider,
  PROVIDER_MODELS,
  type AIProviderRequest,
  type AIProviderResponse,
} from './aiProvider'
import {
  buildPremarketCalibration,
  getLatestOutcomeValidationForScenario,
} from './premarketOutcomeService'
import type {
  PremarketAIExplanationV1,
  PremarketExplainResponse,
  PremarketScenarioVersion,
} from './premarketRehearsalTypes'
import { selectDisplayedPremarketScenario } from './premarketRehearsalService'

interface PremarketAIModelConfig {
  provider: AIProvider
  model: string
  apiKey: string
  baseUrl: string | null
  maxTokens: number
  fingerprint: string
}

interface ExplainOptions {
  now?: number
  versionId?: string
  resolveModelConfig?: (db: Database.Database) => PremarketAIModelConfig | null
  callModel?: (request: AIProviderRequest) => Promise<AIProviderResponse>
}

const PROVIDERS = new Set<AIProvider>(['claude', 'chatgpt', 'qwen', 'deepseek'])
const flights = new WeakMap<Database.Database, Map<string, Promise<PremarketExplainResponse>>>()
const FORBIDDEN = [
  /买入|卖出|加仓|减仓|清仓|建仓/,
  /目标价|止盈|止损|仓位/,
  /收益承诺|保证收益|稳赚|必涨|必跌/,
  /(?:上涨|下跌|成功|发生)?概率\s*(?:为|是|[:：])?\s*\d+(?:\.\d+)?\s*%/i,
  /(?:胜率|命中率|置信度)\s*(?:为|是|[:：])?\s*\d+(?:\.\d+)?\s*%/i,
]

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 && normalized.length <= max ? normalized : null
}

function resolveDefaultModelConfig(db: Database.Database): PremarketAIModelConfig | null {
  const config = getAIConfig(db)
  let priority: string[] = []
  try {
    const parsed = config.providerPriority ? JSON.parse(config.providerPriority) : null
    if (Array.isArray(parsed)) priority = parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    priority = []
  }
  if (config.provider && !priority.includes(config.provider)) priority.push(config.provider)
  for (const rawProvider of priority) {
    if (!PROVIDERS.has(rawProvider as AIProvider)) continue
    const provider = rawProvider as AIProvider
    const providerConfig = getProviderConfig(db, provider)
    const encrypted = providerConfig?.apiKeyEncrypted
      ?? (config.provider === provider ? config.apiKeyEncrypted : null)
    const apiKey = decryptApiKey(encrypted)
    if (!apiKey) continue
    const model = providerConfig?.model
      ?? (config.provider === provider ? config.model : null)
      ?? PROVIDER_MODELS[provider][0]
    if (!model) continue
    const baseUrl = providerConfig?.baseUrl ?? (config.provider === provider ? config.baseUrl : null)
    const maxTokens = Math.min(1200, Math.max(256, providerConfig?.maxTokens ?? 1200))
    const fingerprint = sha256(JSON.stringify({ provider, model, baseUrl: baseUrl?.trim() || null, maxTokens }))
    return { provider, model, apiKey, baseUrl, maxTokens, fingerprint }
  }
  return null
}

function buildProjection(db: Database.Database, version: PremarketScenarioVersion, now: number) {
  const outcome = getLatestOutcomeValidationForScenario(db, version.id)
  const calibration = buildPremarketCalibration(db, now)
  const allowedReferences = [...new Set([
    ...version.evidence.references.map((reference) => reference.id),
    ...version.scenario.branches.flatMap((branch) => [
      ...branch.supportingReferenceIds,
      ...branch.counterReferenceIds,
    ]),
    ...version.scenario.holdings.flatMap((holding) => holding.referenceIds),
  ])].slice(0, 160)
  const projection = {
    version: {
      id: version.id,
      tradeDate: version.tradeDate,
      stage: version.stage,
      status: version.status,
      marketState: version.scenario.marketState,
      confidence: version.scenario.confidence,
      headline: version.scenario.headline,
      branches: version.scenario.branches.map((branch) => ({
        key: branch.key,
        support: branch.support,
        confidence: branch.confidence,
        summary: branch.summary,
        supportingReferenceIds: branch.supportingReferenceIds,
        counterReferenceIds: branch.counterReferenceIds,
        confirmConditions: branch.confirmConditions,
        invalidationConditions: branch.invalidationConditions,
        unknowns: branch.unknowns,
      })),
      holdings: version.scenario.holdings,
      references: version.evidence.references.map((reference) => ({
        id: reference.id,
        layer: reference.layer,
        kind: reference.kind,
        label: reference.label,
        factDate: reference.factDate,
      })),
      warnings: version.warnings,
    },
    outcome: outcome ? {
      id: outcome.id,
      status: outcome.status,
      counts: outcome.validation.counts,
      coverageRate: outcome.validation.coverageRate,
      items: outcome.validation.items.map((item) => ({
        tsCode: item.tsCode,
        stockName: item.stockName,
        premarketState: item.premarketState,
        status: item.status,
        outcome: item.outcome,
      })),
    } : null,
    calibration: {
      versionCount: calibration.versionCount,
      totalSamples: calibration.totalSamples,
      maturedSamples: calibration.maturedSamples,
      missingSamples: calibration.missingSamples,
      coverageRate: calibration.coverageRate,
      confusion: calibration.confusion.slice(0, 24),
      marketGroups: calibration.marketGroups.slice(0, 24),
      probabilityGate: calibration.probabilityGate,
    },
    allowedReferences,
  }
  return { outcome, projection, allowedReferences }
}

function buildPrompt(projection: unknown): string {
  return [
    '你是A股本地投研平台的证据解释器。只能解释下方冻结的结构化投影，不得使用模型记忆、联网内容或投影外事实。',
    '不得给出买卖、目标价、止盈止损、仓位、收益承诺或精确概率。不得把证据覆盖置信解释为收益概率。',
    '只返回一个JSON对象，不要Markdown或代码围栏。格式：',
    '{"schemaVersion":1,"summary":"不超过300字","observations":[{"text":"不超过180字","referenceIds":["仅限allowedReferences"]}],"uncertainties":["不超过120字"],"watchItems":["不超过120字"]}',
    'observations最多6项，每项必须至少引用一个allowedReferences；uncertainties与watchItems各最多6项。',
    JSON.stringify(projection),
  ].join('\n\n')
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const raw = trimmed.startsWith('{') ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0]
  if (!raw) throw new Error('AI_EXPLANATION_JSON_MISSING')
  return JSON.parse(raw)
}

export function validatePremarketAIExplanation(
  value: unknown,
  allowedReferences: string[],
): PremarketAIExplanationV1 {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!record || record.schemaVersion !== 1) throw new Error('AI_EXPLANATION_SCHEMA_INVALID')
  const summary = boundedText(record.summary, 600)
  if (!summary) throw new Error('AI_EXPLANATION_SUMMARY_INVALID')
  const allowed = new Set(allowedReferences)
  if (!Array.isArray(record.observations) || record.observations.length > 6) {
    throw new Error('AI_EXPLANATION_OBSERVATIONS_INVALID')
  }
  const observations = record.observations.map((raw) => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
    const text = boundedText(item?.text, 300)
    const refs = Array.isArray(item?.referenceIds)
      ? [...new Set(item.referenceIds.filter((ref): ref is string => typeof ref === 'string'))].slice(0, 8)
      : []
    if (!text || refs.length === 0 || refs.some((ref) => !allowed.has(ref))) {
      throw new Error('AI_EXPLANATION_REFERENCE_INVALID')
    }
    return { text, referenceIds: refs }
  })
  const list = (raw: unknown, code: string): string[] => {
    if (!Array.isArray(raw) || raw.length > 6) throw new Error(code)
    return raw.map((item) => {
      const text = boundedText(item, 200)
      if (!text) throw new Error(code)
      return text
    })
  }
  const result: PremarketAIExplanationV1 = {
    schemaVersion: 1,
    summary,
    observations,
    uncertainties: list(record.uncertainties, 'AI_EXPLANATION_UNCERTAINTIES_INVALID'),
    watchItems: list(record.watchItems, 'AI_EXPLANATION_WATCH_ITEMS_INVALID'),
  }
  const combined = JSON.stringify(result)
  if (FORBIDDEN.some((pattern) => pattern.test(combined))) {
    throw new Error('AI_EXPLANATION_POLICY_VIOLATION')
  }
  return result
}

async function executeExplanation(
  db: Database.Database,
  version: PremarketScenarioVersion,
  config: PremarketAIModelConfig,
  now: number,
  callModel: (request: AIProviderRequest) => Promise<AIProviderResponse>,
): Promise<PremarketExplainResponse> {
  const { outcome, projection, allowedReferences } = buildProjection(db, version, now)
  if (allowedReferences.length === 0) {
    return { ok: false, code: 'AI_EXPLANATION_INVALID', message: '当前版本没有可供AI解释的稳定证据引用' }
  }
  const sourceFingerprint = sha256(JSON.stringify(projection))
  const matching = getMatchingPremarketAIExplanation(db, {
    scenarioVersionId: version.id,
    outcomeValidationId: outcome?.id ?? null,
    provider: config.provider,
    model: config.model,
    modelConfigFingerprint: config.fingerprint,
    sourceFingerprint,
  })
  if (matching) return { ok: true, explanation: matching, reused: true }
  const prompt = buildPrompt(projection)
  try {
    const response = await callModel({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      maxTokens: config.maxTokens,
      prompt,
      disableNativeSearch: true,
    })
    const explanation = validatePremarketAIExplanation(extractJson(response.text), allowedReferences)
    const saved = savePremarketAIExplanation(db, {
      id: randomUUID(),
      scenarioVersionId: version.id,
      outcomeValidationId: outcome?.id ?? null,
      provider: config.provider,
      model: config.model,
      modelConfigFingerprint: config.fingerprint,
      sourceFingerprint,
      promptSha256: sha256(prompt),
      explanation,
      usage: {
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        totalTokens: response.usage?.totalTokens,
      },
      createdAt: now,
    })
    return { ok: true, explanation: saved.explanation, reused: saved.reused }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI解释生成失败'
    if (message === 'AI_EXPLANATION_POLICY_VIOLATION') {
      return { ok: false, code: 'AI_EXPLANATION_POLICY_VIOLATION', message: 'AI解释包含被禁止的交易或概率表达，结果未保存' }
    }
    if (message.startsWith('AI_EXPLANATION_')) {
      return { ok: false, code: 'AI_EXPLANATION_INVALID', message }
    }
    return { ok: false, code: 'AI_EXPLANATION_FAILED', message }
  }
}

export async function explainCurrentPremarketScenario(
  db: Database.Database,
  options: ExplainOptions = {},
): Promise<PremarketExplainResponse> {
  const now = options.now ?? Date.now()
  const version = options.versionId
    ? getPremarketScenarioVersionById(db, options.versionId)
    : selectDisplayedPremarketScenario(db, now)?.version ?? null
  if (!version) return { ok: false, code: 'SCENARIO_NOT_AVAILABLE', message: '当前交易日尚无可解释的盘前版本' }
  const config = (options.resolveModelConfig ?? resolveDefaultModelConfig)(db)
  if (!config) return { ok: false, code: 'AI_NOT_CONFIGURED', message: '请先在AI配置中设置可用厂商、模型和API Key' }
  const outcomeId = getLatestOutcomeValidationForScenario(db, version.id)?.id ?? 'none'
  const key = `${version.id}|${outcomeId}|${config.fingerprint}`
  let map = flights.get(db)
  if (!map) {
    map = new Map()
    flights.set(db, map)
  }
  const current = map.get(key)
  if (current) return current
  let promise: Promise<PremarketExplainResponse>
  promise = executeExplanation(db, version, config, now, options.callModel ?? callAIProvider)
    .finally(() => {
      if (map?.get(key) === promise) map.delete(key)
    })
  map.set(key, promise)
  return promise
}
