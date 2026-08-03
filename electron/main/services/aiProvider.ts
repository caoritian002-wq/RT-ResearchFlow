import type { AIProvider } from '../database/types'

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface AIProviderRequest {
  provider: AIProvider
  model: string
  apiKey: string
  baseUrl?: string | null
  maxTokens?: number | null
  /** Omit the provider request's output-token parameter and let the model endpoint decide. */
  omitOutputTokenLimit?: boolean
  signal?: AbortSignal
  disableNativeSearch?: boolean
  /** Single-turn: converted to [{role:'user', content:prompt}] */
  prompt?: string
  /** Multi-turn: pass full conversation history directly */
  messages?: ConversationTurn[]
  webSearch?: {
    enabled: boolean
    searchContextSize?: 'low' | 'medium' | 'high'
    excludedUrls?: string[]
  }
}

export interface AIProviderResponse {
  text: string
  responseId?: string | null
  usage?: AIProviderUsage
  finishReason?: string | null
  webSearchTrace?: AIWebSearchTrace
}

export interface AIWebSearchTrace {
  responseId: string
  calls: Array<{
    id: string
    status: string
    action: {
      type: 'search' | 'open_page' | 'find_in_page'
      queries: string[]
      url: string | null
      pattern: string | null
      sources: string[]
    }
  }>
  citations: Array<{
    url: string
    title: string
    startIndex: number
    endIndex: number
  }>
  sources: Array<{ url: string; title: string | null; cited: boolean }>
}

export interface AIProviderUsage {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
}

/**
 * Calls the appropriate AI provider and returns the response text.
 * Throws on API errors.
 */
export async function callAIProvider(req: AIProviderRequest): Promise<AIProviderResponse> {
  if (req.provider === 'claude') {
    return callClaude(req)
  }
  if (req.provider === 'deepseek') {
    return callDeepSeek(req)
  }
  if (req.provider === 'chatgpt' && req.webSearch?.enabled) {
    return callOpenAIResponsesWithWebSearch(req)
  }
  // chatgpt, qwen are OpenAI Chat Completions compatible
  return callOpenAICompatible(req)
}

function buildMessages(req: AIProviderRequest): ConversationTurn[] {
  if (req.messages && req.messages.length > 0) {
    return req.messages.map((message) => ({ role: message.role, content: message.content }))
  }
  return [{ role: 'user', content: req.prompt! }]
}

async function callClaude(req: AIProviderRequest): Promise<AIProviderResponse> {
  // Dynamic import to avoid loading SDK at module load time
  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  const clientOpts: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: req.apiKey
  }
  if (req.baseUrl) {
    clientOpts.baseURL = req.baseUrl
  }

  const client = new Anthropic(clientOpts)

  const message = await client.messages.create({
    model: req.model,
    max_tokens: resolveMaxTokens(req.maxTokens),
    messages: buildMessages(req)
  }, { signal: req.signal })

  const block = message.content[0]
  if (!block || block.type !== 'text') {
    throw new Error('AI_RESPONSE_EMPTY')
  }

  return {
    text: block.text,
    responseId: message.id ?? null,
    usage: {
      inputTokens: message.usage?.input_tokens ?? null,
      outputTokens: message.usage?.output_tokens ?? null,
      totalTokens: typeof message.usage?.input_tokens === 'number' && typeof message.usage?.output_tokens === 'number'
        ? message.usage.input_tokens + message.usage.output_tokens
        : null
    },
    finishReason: message.stop_reason ?? null
  }
}

async function callDeepSeek(req: AIProviderRequest): Promise<AIProviderResponse> {
  // DeepSeek 官方文档：https://api-docs.deepseek.com/zh-cn/
  // 官方 Base URL 为 https://api.deepseek.com，兼容 OpenAI Chat Completions 协议
  const { default: OpenAI } = await import('openai')

  const client = new OpenAI({
    apiKey: req.apiKey,
    baseURL: req.baseUrl || 'https://api.deepseek.com'
  })

  const completion = await client.chat.completions.create({
    model: req.model,
    messages: buildMessages(req),
    ...(req.omitOutputTokenLimit ? {} : { max_tokens: resolveMaxTokens(req.maxTokens) }),
  }, { signal: req.signal })

  const text = completion.choices[0]?.message?.content
  if (!text) {
    throw new Error('AI_RESPONSE_EMPTY')
  }

  return {
    text,
    responseId: completion.id ?? null,
    usage: normalizeOpenAIUsage(completion.usage),
    finishReason: completion.choices[0]?.finish_reason ?? null
  }
}

async function callOpenAICompatible(req: AIProviderRequest): Promise<AIProviderResponse> {
  const { default: OpenAI } = await import('openai')

  const baseURLMap: Record<string, string> = {
    chatgpt: 'https://api.openai.com/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  }

  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: req.apiKey,
    baseURL: req.baseUrl || baseURLMap[req.provider]
  }

  const client = new OpenAI(clientOpts)

  // 未配置时统一默认 4096; 用户可在厂商配置中按模型能力上调。
  const outputLimit = req.omitOutputTokenLimit ? {} : { max_tokens: resolveMaxTokens(req.maxTokens) }

  // 千问额外参数：开启联网搜索（DashScope 兼容模式通过 extra_body 透传），
  // 让模型能像 DeepSeek 一样获取最新基本面/资讯
  const extra = buildOpenAICompatibleExtra(req.provider, req.model, !req.disableNativeSearch)

  const completion = await client.chat.completions.create({
    model: req.model,
    messages: buildMessages(req),
    ...outputLimit,
    ...extra
  } as any, { signal: req.signal })

  const text = completion.choices[0]?.message?.content
  if (!text) {
    throw new Error('AI_RESPONSE_EMPTY')
  }

  return {
    text,
    responseId: completion.id ?? null,
    usage: normalizeOpenAIUsage(completion.usage),
    finishReason: completion.choices[0]?.finish_reason ?? null
  }
}

function webSearchInput(req: AIProviderRequest): ConversationTurn[] {
  const messages = buildMessages(req)
  const excluded = (req.webSearch?.excludedUrls || []).filter(Boolean).slice(0, 40)
  if (!excluded.length) return messages
  return [{
    role: 'user',
    content: [
      '【来源排除约束】以下 URL 已由用户明确排除。不得搜索、引用、转述或用其支持结论；如其他网页转载同一主张，必须另找独立来源。',
      ...excluded.map((url) => `- ${url}`),
    ].join('\n'),
  }, ...messages]
}

function normalizeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function normalizeOpenAIWebSearchTrace(response: {
  id?: string
  output?: unknown[]
}): AIWebSearchTrace {
  const calls: AIWebSearchTrace['calls'] = []
  const citations: AIWebSearchTrace['citations'] = []
  const sourceUrls = new Set<string>()
  for (const rawItem of response.output || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'web_search_call') {
      const rawAction = item.action && typeof item.action === 'object'
        ? item.action as Record<string, unknown>
        : {}
      const type = ['search', 'open_page', 'find_in_page'].includes(String(rawAction.type))
        ? String(rawAction.type) as 'search' | 'open_page' | 'find_in_page'
        : 'search'
      const actionSources = Array.isArray(rawAction.sources)
        ? rawAction.sources
            .map((source) => source && typeof source === 'object'
              ? normalizeWebUrl((source as Record<string, unknown>).url)
              : null)
            .filter((url): url is string => Boolean(url))
        : []
      actionSources.forEach((url) => sourceUrls.add(url))
      const url = normalizeWebUrl(rawAction.url)
      if (url) sourceUrls.add(url)
      calls.push({
        id: String(item.id || ''),
        status: String(item.status || 'completed'),
        action: {
          type,
          queries: Array.isArray(rawAction.queries)
            ? rawAction.queries.map(String).filter(Boolean)
            : typeof rawAction.query === 'string' ? [rawAction.query] : [],
          url,
          pattern: typeof rawAction.pattern === 'string' ? rawAction.pattern : null,
          sources: actionSources,
        },
      })
    }
    if (item.type !== 'message' || !Array.isArray(item.content)) continue
    for (const rawContent of item.content) {
      if (!rawContent || typeof rawContent !== 'object') continue
      const content = rawContent as Record<string, unknown>
      if (content.type !== 'output_text' || !Array.isArray(content.annotations)) continue
      for (const rawAnnotation of content.annotations) {
        if (!rawAnnotation || typeof rawAnnotation !== 'object') continue
        const annotation = rawAnnotation as Record<string, unknown>
        if (annotation.type !== 'url_citation') continue
        const url = normalizeWebUrl(annotation.url)
        if (!url) continue
        sourceUrls.add(url)
        citations.push({
          url,
          title: typeof annotation.title === 'string' ? annotation.title : url,
          startIndex: Number.isInteger(annotation.start_index) ? Number(annotation.start_index) : 0,
          endIndex: Number.isInteger(annotation.end_index) ? Number(annotation.end_index) : 0,
        })
      }
    }
  }
  const titleByUrl = new Map(citations.map((citation) => [citation.url, citation.title]))
  const citedUrls = new Set(citations.map((citation) => citation.url))
  return {
    responseId: String(response.id || ''),
    calls,
    citations,
    sources: [...sourceUrls].map((url) => ({
      url,
      title: titleByUrl.get(url) || null,
      cited: citedUrls.has(url),
    })),
  }
}

export function findExcludedWebSearchCitations(
  trace: AIWebSearchTrace,
  excludedUrls: string[],
): string[] {
  const excluded = new Set(excludedUrls.map(normalizeWebUrl).filter((url): url is string => Boolean(url)))
  return Array.from(new Set(trace.citations.flatMap((citation) => {
    const url = normalizeWebUrl(citation.url)
    return url && excluded.has(url) ? [url] : []
  })))
}

async function callOpenAIResponsesWithWebSearch(req: AIProviderRequest): Promise<AIProviderResponse> {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({
    apiKey: req.apiKey,
    baseURL: req.baseUrl || 'https://api.openai.com/v1',
  })
  const response = await client.responses.create({
    model: req.model,
    input: webSearchInput(req),
    tools: [{
      type: 'web_search',
      search_context_size: req.webSearch?.searchContextSize || 'high',
      user_location: { type: 'approximate', country: 'CN', timezone: 'Asia/Shanghai' },
    }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    ...(req.omitOutputTokenLimit ? {} : { max_output_tokens: resolveMaxTokens(req.maxTokens) }),
    store: false,
  }, { signal: req.signal })
  const text = response.output_text?.trim()
  if (!text) throw new Error('AI_RESPONSE_EMPTY')
  const usage = response.usage
  const webSearchTrace = normalizeOpenAIWebSearchTrace(response)
  if (findExcludedWebSearchCitations(webSearchTrace, req.webSearch?.excludedUrls || []).length) {
    throw new Error('AI_WEB_SEARCH_EXCLUDED_SOURCE_USED')
  }
  return {
    text,
    responseId: response.id ?? null,
    usage: usage ? {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    } : undefined,
    finishReason: response.status ?? null,
    webSearchTrace,
  }
}

export function buildOpenAICompatibleExtra(
  provider: AIProvider,
  model: string,
  enableSearch = true,
): Record<string, unknown> {
  if (provider === 'qwen' && enableSearch) return { enable_search: true }
  if (provider === 'chatgpt' && model === 'gpt-5.5') return { reasoning_effort: 'high' }
  return {}
}

function normalizeOpenAIUsage(usage: unknown): AIProviderUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
  return {
    inputTokens: typeof record.prompt_tokens === 'number' ? record.prompt_tokens : null,
    outputTokens: typeof record.completion_tokens === 'number' ? record.completion_tokens : null,
    totalTokens: typeof record.total_tokens === 'number' ? record.total_tokens : null
  }
}

function resolveMaxTokens(value?: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 4096
  return Math.max(1, Math.floor(value))
}

/** Default models per provider shown in UI dropdown */
export const PROVIDER_MODELS: Record<AIProvider, string[]> = {
  claude: [
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001'
  ],
  chatgpt: [
    'gpt-5.6-sol',
    'gpt-5.5',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-3.5-turbo'
  ],
  qwen: [
    'qwen-max-latest',
    'qwen-plus-latest',
    'qwen-turbo-latest',
    'qwen3-max',
    'qwq-plus',
    'qwen-long',
    'qwen-max',
    'qwen-plus',
    'qwen-turbo'
  ],
  deepseek: [
    'deepseek-chat',
    'deepseek-reasoner'
  ]
}

export const PROVIDER_LABELS: Record<AIProvider, string> = {
  claude: 'Claude (Anthropic)',
  chatgpt: 'ChatGPT (OpenAI)',
  qwen: '通义千问 (阿里云)',
  deepseek: 'DeepSeek'
}

export const PROVIDER_DEFAULT_BASE_URLS: Record<AIProvider, string> = {
  claude: 'https://api.anthropic.com',
  chatgpt: 'https://api.openai.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com'
}
