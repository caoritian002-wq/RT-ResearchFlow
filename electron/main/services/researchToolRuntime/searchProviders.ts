import type { ResearchSearchHit, ResearchSearchProviderId } from './types'

export interface SearchProviderRequest {
  providerId: ResearchSearchProviderId
  apiKey: string
  baseUrl?: string | null
  query: string
  maxResults?: number
  depth?: 'basic' | 'advanced'
}

function normalizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

function collectSearchHits<T>(
  items: readonly T[],
  mapper: (item: T) => ResearchSearchHit | null,
): ResearchSearchHit[] {
  const hits: ResearchSearchHit[] = []
  for (const item of items) {
    const hit = mapper(item)
    if (hit) hits.push(hit)
  }
  return hits
}

function decodeDuckDuckGoRedirect(rawHref: string): string | null {
  try {
    const href = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref
    const parsed = new URL(href, 'https://duckduckgo.com')
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) return normalizeUrl(decodeURIComponent(uddg))
    if (parsed.hostname.includes('duckduckgo.com')) return null
    return normalizeUrl(parsed.toString())
  } catch {
    return null
  }
}

/** 内置弱检索：仅作降级，不得单独把模式抬到 strong。 */
export async function searchWithBuiltinWebTool(query: string, maxResults = 5): Promise<ResearchSearchHit[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  if (!response.ok) throw new Error(`WEB_SEARCH_PROVIDER_FAILED:${response.status}`)
  const html = await response.text()
  const hits: ResearchSearchHit[] = []
  const anchorRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchorRegex.exec(html)) !== null) {
    const url = decodeDuckDuckGoRedirect(match[1])
    if (!url) continue
    const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!title) continue
    hits.push({
      title, url, snippet: null, publishedAt: null, providerId: 'builtin_web', query,
      sourceKind: 'web_search', isDetailPage: false,
    })
    if (hits.length >= maxResults) break
  }
  if (!hits.length) {
    const fallbackRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    while ((match = fallbackRegex.exec(html)) !== null) {
      const url = normalizeUrl(match[1])
      if (!url || url.includes('duckduckgo.com')) continue
      const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
      if (!title || title.length < 4) continue
      hits.push({
        title, url, snippet: null, publishedAt: null, providerId: 'builtin_web', query,
        sourceKind: 'web_search', isDetailPage: false,
      })
      if (hits.length >= maxResults) break
    }
  }
  return hits
}

async function searchTavily(req: SearchProviderRequest): Promise<ResearchSearchHit[]> {
  const endpoint = (req.baseUrl?.trim() || 'https://api.tavily.com/search').replace(/\/$/, '')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      query: req.query,
      max_results: req.maxResults ?? 5,
      include_answer: false,
      search_depth: req.depth || 'advanced',
    }),
  })
  if (!response.ok) throw new Error(`WEB_SEARCH_PROVIDER_FAILED:${response.status}`)
  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>
  }
  return collectSearchHits(payload.results ?? [], (item) => {
      const url = typeof item.url === 'string' ? normalizeUrl(item.url) : null
      if (!url) return null
      return {
        title: (item.title || url).trim().slice(0, 300),
        url,
        snippet: item.content?.trim().slice(0, 800) || null,
        publishedAt: item.published_date ?? null,
        providerId: 'tavily',
        query: req.query,
        sourceKind: 'web_search' as const,
        isDetailPage: false,
      } satisfies ResearchSearchHit
    })
}

async function searchBing(req: SearchProviderRequest): Promise<ResearchSearchHit[]> {
  const endpointBase = (req.baseUrl?.trim() || 'https://api.bing.microsoft.com/v7.0/search').replace(/\/$/, '')
  const url = new URL(endpointBase)
  url.searchParams.set('q', req.query)
  url.searchParams.set('count', String(req.maxResults ?? 5))
  url.searchParams.set('mkt', 'zh-CN')
  const response = await fetch(url.toString(), {
    headers: { 'Ocp-Apim-Subscription-Key': req.apiKey },
  })
  if (!response.ok) throw new Error(`WEB_SEARCH_PROVIDER_FAILED:${response.status}`)
  const payload = await response.json() as {
    webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; dateLastCrawled?: string }> }
  }
  return collectSearchHits(payload.webPages?.value ?? [], (item) => {
      const pageUrl = typeof item.url === 'string' ? normalizeUrl(item.url) : null
      if (!pageUrl) return null
      return {
        title: (item.name || pageUrl).trim().slice(0, 300),
        url: pageUrl,
        snippet: item.snippet?.trim().slice(0, 800) || null,
        publishedAt: item.dateLastCrawled ?? null,
        providerId: 'bing',
        query: req.query,
        sourceKind: 'web_search' as const,
        isDetailPage: false,
      } satisfies ResearchSearchHit
    })
}

async function searchCustomOpenAICompatible(req: SearchProviderRequest): Promise<ResearchSearchHit[]> {
  const endpoint = (req.baseUrl?.trim() || '').replace(/\/$/, '')
  if (!endpoint) throw new Error('WEB_SEARCH_NOT_CONFIGURED')
  const response = await fetch(`${endpoint}/search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({ query: req.query, max_results: req.maxResults ?? 5 }),
  })
  if (!response.ok) throw new Error(`WEB_SEARCH_PROVIDER_FAILED:${response.status}`)
  const payload = await response.json() as {
    results?: Array<{ title?: string; url?: string; snippet?: string; content?: string; published_at?: string }>
  }
  return collectSearchHits(payload.results ?? [], (item) => {
      const pageUrl = typeof item.url === 'string' ? normalizeUrl(item.url) : null
      if (!pageUrl) return null
      return {
        title: (item.title || pageUrl).trim().slice(0, 300),
        url: pageUrl,
        snippet: (item.snippet || item.content || '').trim().slice(0, 800) || null,
        publishedAt: item.published_at ?? null,
        providerId: 'custom_openai_compatible_search',
        query: req.query,
        sourceKind: 'web_search' as const,
        isDetailPage: false,
      } satisfies ResearchSearchHit
    })
}

export async function runWebSearch(req: SearchProviderRequest): Promise<ResearchSearchHit[]> {
  if (!req.apiKey.trim()) throw new Error('WEB_SEARCH_NOT_CONFIGURED')
  if (req.providerId === 'tavily') return searchTavily(req)
  if (req.providerId === 'bing') return searchBing(req)
  return searchCustomOpenAICompatible(req)
}

export async function validateWebSearchProvider(
  req: Omit<SearchProviderRequest, 'query' | 'maxResults' | 'depth'>,
): Promise<void> {
  await runWebSearch({
    ...req,
    query: 'A股 产业研究 官方披露',
    maxResults: 1,
    depth: 'basic',
  })
}
