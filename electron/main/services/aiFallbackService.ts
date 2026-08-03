import type Database from 'better-sqlite3'
import { getAIConfig, getProviderApiKey, getProviderConfig } from '../database/aiConfigRepository'
import type { AIProvider } from '../database/types'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { callAIProvider, PROVIDER_MODELS, type AIProviderUsage, type AIWebSearchTrace, type ConversationTurn } from './aiProvider'

export interface ResolvedProviderCredentials {
  provider: AIProvider
  model: string
  apiKey: string
  baseUrl?: string
  maxTokens?: number | null
  presetPrompt?: string
  trendForecastPrompt?: string
  trendForecastMorrowPrompt?: string
}

export interface AIFallbackResult {
  provider: AIProvider
  model: string
  text: string
  usage?: AIProviderUsage
  finishReason?: string | null
  maxTokens?: number | null
  webSearchTrace?: AIWebSearchTrace
}

export function resolveProviderCredentials(db: Database.Database): ResolvedProviderCredentials | null {
  const aiConfig = getAIConfig(db)
  const priority: string[] = aiConfig.providerPriority
    ? JSON.parse(aiConfig.providerPriority)
    : (aiConfig.provider ? [aiConfig.provider] : [])
  for (const provider of priority) {
    const providerConfig = getProviderConfig(db, provider)
    if (!providerConfig?.apiKeyEncrypted) continue
    const apiKey = decryptApiKey(providerConfig.apiKeyEncrypted)
    if (!apiKey) continue
    const model = providerConfig.model || (PROVIDER_MODELS as Record<string, string[]>)[provider]?.[0] || ''
    if (!model) continue
    return {
      provider: provider as AIProvider,
      model,
      apiKey,
      baseUrl: providerConfig.baseUrl ?? undefined,
      maxTokens: providerConfig.maxTokens ?? undefined,
      presetPrompt: providerConfig.presetPrompt ?? undefined,
      trendForecastPrompt: providerConfig.trendForecastPrompt ?? undefined,
      trendForecastMorrowPrompt: providerConfig.trendForecastMorrowPrompt ?? undefined,
    }
  }

  if (aiConfig.provider && aiConfig.model) {
    const apiKey = decryptApiKey(getProviderApiKey(db, aiConfig.provider))
    if (apiKey) {
      return {
        provider: aiConfig.provider as AIProvider,
        model: aiConfig.model,
        apiKey,
        baseUrl: aiConfig.baseUrl ?? undefined,
      }
    }
  }
  return null
}

export async function callWithFallback(
  db: Database.Database,
  params: {
    prompt?: string
    messages?: ConversationTurn[]
    webSearch?: { enabled: boolean; searchContextSize?: 'low' | 'medium' | 'high'; excludedUrls?: string[] }
    nativeWebSearchOnly?: boolean
  },
): Promise<AIFallbackResult> {
  const aiConfig = getAIConfig(db)
  const priority: string[] = aiConfig.providerPriority
    ? JSON.parse(aiConfig.providerPriority)
    : (aiConfig.provider ? [aiConfig.provider] : [])

  let lastError: Error | null = null
  let encryptedCredentialCount = 0
  let unavailableCredentialCount = 0
  for (const provider of priority) {
    if (params.nativeWebSearchOnly && provider !== 'chatgpt') continue
    const providerConfig = getProviderConfig(db, provider)
    if (!providerConfig?.apiKeyEncrypted) continue
    encryptedCredentialCount += 1
    const apiKey = decryptApiKey(providerConfig.apiKeyEncrypted)
    if (!apiKey) {
      unavailableCredentialCount += 1
      continue
    }
    const model = providerConfig.model || (PROVIDER_MODELS as Record<string, string[]>)[provider]?.[0] || ''
    if (!model) continue
    try {
      const result = await callAIProvider({
        provider: provider as AIProvider,
        model,
        apiKey,
        baseUrl: providerConfig.baseUrl ?? undefined,
        maxTokens: providerConfig.maxTokens ?? undefined,
        ...params,
      })
      return {
        provider: provider as AIProvider,
        model,
        text: result.text,
        usage: result.usage,
        finishReason: result.finishReason,
        maxTokens: providerConfig.maxTokens ?? undefined,
        webSearchTrace: result.webSearchTrace,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.warn(`[callWithFallback] ${provider}/${model} failed:`, lastError.message, '— trying next provider')
    }
  }
  if (!lastError && encryptedCredentialCount > 0 && encryptedCredentialCount === unavailableCredentialCount) {
    throw new Error('AI_CREDENTIALS_UNAVAILABLE')
  }
  if (params.nativeWebSearchOnly) {
    if (lastError?.message === 'AI_WEB_SEARCH_EXCLUDED_SOURCE_USED') {
      throw new Error('GPT 最终引用了已排除来源，本轮结果未保存')
    }
    if (lastError) {
      throw new Error('GPT 原生网页搜索调用失败，请检查当前模型是否支持 Responses API 和 web_search')
    }
    throw new Error('产业研究联网需要配置可用的 ChatGPT 模型和 API Key')
  }
  throw lastError ?? new Error('AI_NOT_CONFIGURED')
}
