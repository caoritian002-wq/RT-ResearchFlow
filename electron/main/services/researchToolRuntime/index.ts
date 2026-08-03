import { createHash, randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { listBriefings } from '../../database/briefingRepository'
import {
  getResearchWebSearchConfig,
  getGenerationRun,
  getProjectEvidenceCandidate,
  listEvidenceCandidates,
  saveResearchWebSearchConfig,
  updateEvidenceCandidateStatus,
  upsertEvidenceCandidate,
  type EvidenceCandidateInput,
} from '../../database/industryResearchGenerationRepository'
import { listResearchEvidence, saveResearchEvidence } from '../../database/industryResearchRepository'
import type {
  ResearchEvidenceCandidateRow,
  ResearchEvidenceSourceKind,
  ResearchRetrievalMode,
  ResearchWebSearchProviderId,
} from '../../database/types'
import { decryptApiKey, encryptApiKey } from '../../utils/apiKeyEncryption'
import { fetchResearchPage, isLikelySearchResultPage } from './pageFetch'
import { runWebSearch, searchWithBuiltinWebTool, validateWebSearchProvider } from './searchProviders'
import type {
  ResearchQueryIntent,
  ResearchRetrievalPlan,
  ResearchRetrievalPlanView,
  ResearchRetrievalQuery,
  ResearchSearchHit,
} from './types'

export class ResearchToolRuntimeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}

const OFFICIAL_DOMAINS = [
  'cninfo.com.cn',
  'sse.com.cn',
  'szse.cn',
  'bse.cn',
  'stats.gov.cn',
  'miit.gov.cn',
  'gov.cn',
  'pbc.gov.cn',
  'ndrc.gov.cn',
]

const POOL_LIMIT = 48
const TOP_N = 14

function uniqueStrings(values: string[], max: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= max) break
  }
  return result
}

function queryId(text: string, intent: string): string {
  return createHash('sha256').update(`${intent}:${text}`).digest('hex').slice(0, 12)
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

function urlKey(url: string): string {
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : url.trim()
  } catch {
    return url.trim()
  }
}

function authorityScore(url: string, sourceKind: string): number {
  const host = hostOf(url)
  if (sourceKind === 'local_research') return 0.72
  if (sourceKind === 'local_briefing') return 0.68
  if (OFFICIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return 0.95
  if (host.includes('gov.cn') || host.includes('edu.cn')) return 0.9
  if (host.includes('xinhua') || host.includes('people.com') || host.includes('cctv')) return 0.75
  if (host.includes('eastmoney') || host.includes('sina') || host.includes('10jqka')) return 0.55
  return 0.4
}

function relevanceScore(text: string, query: string, topicTokens: string[]): number {
  const hay = text.toLowerCase()
  const tokens = uniqueStrings(
    [...query.split(/[\s,，、/|]+/), ...topicTokens].map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2),
    24,
  )
  if (!tokens.length) return 0.3
  let hit = 0
  for (const token of tokens) if (hay.includes(token)) hit += 1
  return Math.min(1, hit / Math.max(3, Math.min(tokens.length, 8)))
}

function freshnessScore(publishedAt: string | null | undefined): number {
  if (!publishedAt) return 0.45
  const ts = Date.parse(publishedAt)
  if (Number.isNaN(ts)) return 0.45
  const ageDays = Math.max(0, (Date.now() - ts) / 86400000)
  if (ageDays <= 30) return 1
  if (ageDays <= 180) return 0.8
  if (ageDays <= 365) return 0.6
  if (ageDays <= 365 * 3) return 0.4
  return 0.25
}

function rankScore(parts: {
  relevance: number
  authority: number
  freshness: number
  isDetail: boolean
  hasExcerpt: boolean
}): number {
  let score = parts.relevance * 0.45 + parts.authority * 0.35 + parts.freshness * 0.2
  if (parts.isDetail) score += 0.08
  if (!parts.hasExcerpt) score -= 0.25
  return Math.max(0, Math.min(1.2, score))
}

function makeQuery(
  text: string,
  intent: ResearchQueryIntent,
  targetDomains: string[],
  rationale: string,
  rewriteOfQueryId?: string | null,
): ResearchRetrievalQuery {
  return {
    id: queryId(text, intent),
    text,
    intent,
    targetDomains,
    rationale,
    rewriteOfQueryId: rewriteOfQueryId || null,
    hitCount: 0,
    detailUrlCount: 0,
    status: 'planned',
  }
}

export function buildResearchRetrievalPlan(input: {
  researchQuestion: string
  industryName?: string | null
  productScope?: string | null
  regionScope?: string | null
  officialUrls?: string[]
}): ResearchRetrievalPlan {
  const question = input.researchQuestion.trim()
  const industry = input.industryName?.trim() || ''
  const product = input.productScope?.trim() || ''
  const region = input.regionScope?.trim() || '中国'
  const topic = industry || product || question.slice(0, 40)
  const queries: ResearchRetrievalQuery[] = [
    makeQuery(question, 'general', [], '原始研究问题', null),
    makeQuery(`${topic} ${region} 政策 监管 规划 site:gov.cn`, 'policy', ['gov.cn', 'miit.gov.cn', 'ndrc.gov.cn'], '政策监管定向'),
    makeQuery(`${topic} 供需 价格 库存 开工率 ${region}`, 'supply_demand_price', [], '供需价格意图'),
    makeQuery(`${topic} 产能 产量 有效产能 扩产 ${region}`, 'capacity_inventory', [], '产能库存意图'),
    makeQuery(`${topic} 业务收入 主营构成 暴露 财报 site:cninfo.com.cn`, 'company_exposure', ['cninfo.com.cn'], '公司暴露与公告定向'),
    makeQuery(`${topic} 技术路线 替代 瓶颈 冲击`, 'tech_substitution_or_shock', [], '技术替代与冲击'),
    makeQuery(`${topic} 行业协会 白皮书 统计 ${region}`, 'supply_demand_price', [], '协会与统计口径'),
    makeQuery(`${topic} site:stats.gov.cn`, 'policy', ['stats.gov.cn'], '统计局定向'),
    makeQuery(`${topic} site:miit.gov.cn`, 'policy', ['miit.gov.cn'], '工信部定向'),
    makeQuery(`${industry || topic} ${product || ''} 龙头 市占率 竞争格局`.replace(/\s+/g, ' ').trim(), 'company_exposure', [], '竞争格局线索'),
  ]

  const encodedTopic = encodeURIComponent(topic.slice(0, 80))
  const officialSeeds = uniqueStrings([
    `https://www.cninfo.com.cn/new/fulltextSearch?notautosubmit=&keyWord=${encodedTopic}`,
    `https://www.stats.gov.cn/search/s?qt=${encodedTopic}`,
    `https://www.miit.gov.cn/search/index.html?keywords=${encodedTopic}`,
    `https://www.gov.cn/search/zhengce.htm?q=${encodedTopic}`,
    ...(input.officialUrls ?? []),
  ], 8)

  return { queries: queries.slice(0, 15), officialSeeds }
}

function rewriteQuery(query: ResearchRetrievalQuery, topic: string): ResearchRetrievalQuery | null {
  if (query.rewriteOfQueryId) return null
  const map: Partial<Record<ResearchQueryIntent, string>> = {
    policy: `${topic} 产业政策 补贴 准入 目录`,
    supply_demand_price: `${topic} 价格走势 供需缺口 库存周期`,
    capacity_inventory: `${topic} 新建产能 投产 利用率`,
    company_exposure: `${topic} 上市公司 业务占比 分部收入`,
    tech_substitution_or_shock: `${topic} 技术迭代 替代材料 供应链冲击`,
    general: `${topic} 产业链 研究 综述`,
  }
  const text = map[query.intent]
  if (!text || text === query.text) return null
  return makeQuery(text, query.intent, query.targetDomains, `空召回后改写：${query.rationale}`, query.id)
}

export function getWebSearchConfigView(db: Database.Database) {
  const row = getResearchWebSearchConfig(db)
  if (!row) {
    return {
      providerId: 'tavily' as ResearchWebSearchProviderId,
      enabled: false,
      hasApiKey: false,
      baseUrl: null,
      lastValidatedAt: null,
      lastErrorCode: null,
    }
  }
  return {
    providerId: row.provider_id,
    enabled: row.enabled === 1,
    hasApiKey: Boolean(row.api_key_encrypted && row.api_key_encrypted.length > 0),
    baseUrl: row.base_url,
    lastValidatedAt: row.last_validated_at,
    lastErrorCode: row.last_error_code,
  }
}

export function saveWebSearchConfigAndView(
  db: Database.Database,
  input: {
    providerId: ResearchWebSearchProviderId
    enabled: boolean
    apiKey?: string | null
    baseUrl?: string | null
  },
) {
  let apiKeyEncrypted: Buffer | null | undefined
  let clearApiKey = false
  if (input.apiKey === null) {
    clearApiKey = true
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    apiKeyEncrypted = encryptApiKey(input.apiKey.trim())
    if (!apiKeyEncrypted) throw new ResearchToolRuntimeError('WEB_SEARCH_PROVIDER_FAILED', '当前环境无法安全保存搜索密钥')
  }
  saveResearchWebSearchConfig(db, {
    providerId: input.providerId,
    enabled: input.enabled,
    apiKeyEncrypted,
    clearApiKey,
    baseUrl: input.baseUrl ?? null,
  })
  return getWebSearchConfigView(db)
}

export async function validateConfiguredWebSearch(db: Database.Database): Promise<{ ok: true; validatedAt: number }> {
  const config = getResearchWebSearchConfig(db)
  if (!config || config.enabled !== 1 || !config.api_key_encrypted) {
    throw new ResearchToolRuntimeError('WEB_SEARCH_NOT_CONFIGURED', '尚未配置可用的联网搜索服务')
  }
  const apiKey = decryptApiKey(config.api_key_encrypted)
  if (!apiKey) throw new ResearchToolRuntimeError('WEB_SEARCH_NOT_CONFIGURED', '搜索密钥不可用')
  try {
    await validateWebSearchProvider({
      providerId: config.provider_id,
      apiKey,
      baseUrl: config.base_url,
    })
    const validatedAt = Date.now()
    saveResearchWebSearchConfig(db, {
      providerId: config.provider_id,
      enabled: true,
      baseUrl: config.base_url,
      lastValidatedAt: validatedAt,
      lastErrorCode: null,
    })
    return { ok: true, validatedAt }
  } catch {
    saveResearchWebSearchConfig(db, {
      providerId: config.provider_id,
      enabled: config.enabled === 1,
      baseUrl: config.base_url,
      lastErrorCode: 'WEB_SEARCH_PROVIDER_FAILED',
    })
    throw new ResearchToolRuntimeError('WEB_SEARCH_PROVIDER_FAILED', '搜索服务校验失败')
  }
}

const NON_DOCUMENT_LINK = /\.(?:css|js|mjs|map|woff2?|ttf|eot|ico|png|jpe?g|gif|webp|svg|zip)(?:$|[?#])/i
const DETAIL_LINK_HINT = /(?:\.html?(?:$|[?#])|\/20\d{2}(?:\/|$)|detail|content|article|notice|announcement|disclosure|bulletin)/i

function officialDomainFamily(host: string): string | null {
  return OFFICIAL_DOMAINS.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null
}

export function extractOfficialDetailUrls(html: string, baseUrl: string, limit = 6): string[] {
  const urls: string[] = []
  const baseHost = hostOf(baseUrl)
  const baseFamily = officialDomainFamily(baseHost)
  const re = /href=["']([^"']+)["']/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = new URL(match[1], baseUrl)
      parsed.hash = ''
      const abs = parsed.toString()
      if (!/^https?:/i.test(abs)) continue
      if (isLikelySearchResultPage(abs)) continue
      if (NON_DOCUMENT_LINK.test(abs)) continue
      if (!DETAIL_LINK_HINT.test(`${parsed.pathname}${parsed.search}`)) continue
      const targetFamily = officialDomainFamily(parsed.hostname.toLowerCase())
      if (baseFamily && targetFamily !== baseFamily) continue
      if (!baseFamily && parsed.hostname.toLowerCase() !== baseHost) continue
      if (urls.includes(abs)) continue
      urls.push(abs)
      if (urls.length >= limit) break
    } catch {
      // ignore
    }
  }
  return urls
}

async function resolveOfficialDetailHits(seedUrl: string, query: string): Promise<ResearchSearchHit[]> {
  if (!isLikelySearchResultPage(seedUrl)) {
    return [{
      title: seedUrl,
      url: seedUrl,
      snippet: null,
      providerId: 'official_url',
      query,
      sourceKind: 'official_detail',
      isDetailPage: true,
    }]
  }
  try {
    // 搜索壳不能当正文；只解析其中的详情链接
    const { fetchHtml } = await import('../../ipc/detailHandlers')
    const html = await fetchHtml(seedUrl)
    const details = extractOfficialDetailUrls(html, seedUrl, 5)
    if (details.length) {
      return details.map((url) => ({
        title: url,
        url,
        snippet: null,
        providerId: 'official_url',
        query,
        sourceKind: 'official_detail' as const,
        isDetailPage: true,
      }))
    }
  } catch {
    // fallthrough
  }
  // 无法解析详情时保留入口线索，后续抓取会标记为搜索页失败
  return [{
    title: seedUrl,
    url: seedUrl,
    snippet: null,
    providerId: 'official_url',
    query,
    sourceKind: 'web_search',
    isDetailPage: false,
  }]
}

function recallLocalCorpus(
  db: Database.Database,
  input: { researchQuestion: string; industryName?: string | null; productScope?: string | null; projectId: string },
): ResearchSearchHit[] {
  const topic = (input.industryName || input.productScope || input.researchQuestion).slice(0, 40)
  const hits: ResearchSearchHit[] = []
  try {
    const briefings = listBriefings({ search: topic, limit: 8, offset: 0 })
    for (const item of briefings.items.slice(0, 8)) {
      if (!item.originalUrl) continue
      hits.push({
        title: item.title || item.originalUrl,
        url: item.originalUrl,
        snippet: (item.summary || '').slice(0, 800) || null,
        publishedAt: item.publishedDateBJ || null,
        providerId: 'local_briefing',
        query: topic,
        sourceKind: 'local_briefing',
        isDetailPage: true,
      })
    }
  } catch {
    // 本地资讯不可用时静默跳过
  }
  try {
    const evidence = listResearchEvidence(db, input.projectId)
    for (const item of evidence.slice(0, 8)) {
      if (!item.source_url) continue
      hits.push({
        title: item.title,
        url: item.source_url,
        snippet: item.excerpt || item.source_ref || null,
        publishedAt: item.published_date || item.fact_date || null,
        providerId: 'local_research',
        query: topic,
        sourceKind: 'local_research',
        isDetailPage: true,
      })
    }
  } catch {
    // ignore
  }
  return hits
}

function toCandidateInput(
  hit: ResearchSearchHit,
  page: Awaited<ReturnType<typeof fetchResearchPage>>,
  context: { projectId: string; runId: string; topicTokens: string[] },
): EvidenceCandidateInput {
  const sourceKind = (hit.sourceKind || 'web_search') as ResearchEvidenceSourceKind
  const title = page.title || hit.title
  const summary = page.summary || hit.snippet
  const excerpt = page.excerpt || hit.snippet
  const text = `${title} ${summary || ''} ${excerpt || ''}`
  const isDetail = Boolean(page.isDetailPage ?? hit.isDetailPage)
  const relevance = relevanceScore(text, hit.query, context.topicTokens)
  const authority = authorityScore(page.url || hit.url, sourceKind)
  const freshness = freshnessScore(page.publishedAt || hit.publishedAt)
  const hasExcerpt = Boolean(excerpt && excerpt.trim().length >= 40)
  return {
    id: randomUUID(),
    projectId: context.projectId,
    runId: context.runId,
    query: hit.query,
    sourceUrl: page.url || hit.url,
    title: title.slice(0, 300),
    summary: summary?.slice(0, 500) || null,
    excerpt: excerpt?.slice(0, 1200) || null,
    providerId: hit.providerId,
    publishedAt: page.publishedAt || hit.publishedAt || null,
    status: page.status,
    failureReason: page.failureReason || null,
    sourceKind,
    isDetailPage: isDetail,
    relevanceScore: Number(relevance.toFixed(4)),
    authorityScore: Number(authority.toFixed(4)),
    freshnessScore: Number(freshness.toFixed(4)),
    rankScore: Number(rankScore({
      relevance,
      authority,
      freshness,
      isDetail,
      hasExcerpt,
    }).toFixed(4)),
  }
}

function decideMode(input: {
  enableWeb: boolean
  enhancedHits: number
  builtinHits: number
  localHits: number
  detailPages: number
  searchFailed: boolean
}): { mode: ResearchRetrievalMode; degradedCode: string | null } {
  if (!input.enableWeb) {
    return {
      mode: input.localHits > 0 ? 'weak' : 'offline',
      degradedCode: input.localHits > 0 ? 'WEB_RETRIEVAL_WEAK' : 'WEB_RETRIEVAL_OFFLINE',
    }
  }
  if (input.enhancedHits > 0 && input.detailPages >= 3) {
    return { mode: 'strong', degradedCode: null }
  }
  if ((input.enhancedHits > 0 || input.builtinHits > 0) && (input.localHits > 0 || input.detailPages > 0)) {
    return {
      mode: 'mixed',
      degradedCode: input.enhancedHits > 0 ? null : 'WEB_RETRIEVAL_WEAK',
    }
  }
  if (input.localHits > 0 || input.builtinHits > 0 || input.detailPages > 0) {
    return { mode: 'weak', degradedCode: 'WEB_RETRIEVAL_WEAK' }
  }
  return {
    mode: 'offline',
    degradedCode: input.searchFailed ? 'WEB_SEARCH_PROVIDER_FAILED' : 'WEB_RETRIEVAL_OFFLINE',
  }
}

export async function retrieveResearchEvidenceCandidates(
  db: Database.Database,
  input: {
    projectId: string
    runId: string
    researchQuestion: string
    industryName?: string | null
    productScope?: string | null
    regionScope?: string | null
    officialUrls?: string[]
    enableWebRetrieval?: boolean
    shouldCancel?: () => boolean
  },
): Promise<{
  plan: ResearchRetrievalPlanView
  candidates: ResearchEvidenceCandidateRow[]
  selectedTopNIds: string[]
  mode: ResearchRetrievalMode
  degradedCode: string | null
  message: string
}> {
  const basePlan = buildResearchRetrievalPlan(input)
  const excludedUrls = new Set(listEvidenceCandidates(db, { projectId: input.projectId })
    .filter((candidate) => candidate.status === 'rejected')
    .map((candidate) => urlKey(candidate.source_url)))
  const isAllowedSource = (url: string): boolean => !excludedUrls.has(urlKey(url))
  const config = getResearchWebSearchConfig(db)
  const enhancedSearchConfigured = Boolean(
    config && config.enabled === 1 && config.api_key_encrypted && config.api_key_encrypted.length > 0,
  )
  const topicTokens = uniqueStrings([
    input.industryName || '',
    input.productScope || '',
    ...input.researchQuestion.split(/[\s,，、]+/),
  ], 16)

  if (input.enableWebRetrieval === false) {
    const localHits = recallLocalCorpus(db, input).filter((hit) => isAllowedSource(hit.url))
    const candidates: ResearchEvidenceCandidateRow[] = []
    for (const hit of localHits.slice(0, 12)) {
      const page = {
        url: hit.url,
        title: hit.title,
        summary: hit.snippet,
        excerpt: hit.snippet,
        publishedAt: hit.publishedAt || null,
        status: (hit.snippet && hit.snippet.length >= 40 ? 'fetched' : 'partial') as 'fetched' | 'partial',
        failureReason: null,
        isDetailPage: true,
      }
      candidates.push(upsertEvidenceCandidate(db, toCandidateInput(hit, page, {
        projectId: input.projectId,
        runId: input.runId,
        topicTokens,
      })))
    }
    const modeInfo = decideMode({
      enableWeb: false,
      enhancedHits: 0,
      builtinHits: 0,
      localHits: candidates.length,
      detailPages: candidates.length,
      searchFailed: false,
    })
    const plan: ResearchRetrievalPlanView = {
      ...basePlan,
      mode: modeInfo.mode,
      localHitCount: candidates.length,
      webHitCount: 0,
      detailPageCount: candidates.length,
      selectedTopN: Math.min(TOP_N, candidates.length),
      candidatePoolSize: candidates.length,
      degradedCode: modeInfo.degradedCode,
      message: '已按用户选择跳过联网取证，仅使用本地语料',
      enhancedSearch: {
        providerId: config?.provider_id ?? null,
        configured: enhancedSearchConfigured,
        status: 'disabled',
        errorCode: null,
      },
    }
    return {
      plan,
      candidates,
      selectedTopNIds: candidates.slice(0, TOP_N).map((c) => c.id),
      mode: modeInfo.mode,
      degradedCode: modeInfo.degradedCode,
      message: plan.message,
    }
  }

  const enhancedApiKey = config && config.enabled === 1 && config.api_key_encrypted
    ? decryptApiKey(config.api_key_encrypted)
    : null

  const hits: ResearchSearchHit[] = []
  let searchFailed = false
  let enhancedSearchFailed = false
  let builtinHits = 0
  let enhancedHits = 0
  let localHits = 0

  // 1) 本地语料优先
  const local = recallLocalCorpus(db, input).filter((hit) => isAllowedSource(hit.url))
  hits.push(...local)
  localHits = local.length

  // 2) 外网检索
  const queries = [...basePlan.queries]
  for (let i = 0; i < queries.length; i += 1) {
    if (input.shouldCancel?.()) break
    const query = queries[i]
    let batch: ResearchSearchHit[] = []
    const useEnhancedSearch = Boolean(enhancedApiKey && config)
    try {
      if (enhancedApiKey && config) {
        batch = await runWebSearch({
          providerId: config.provider_id,
          apiKey: enhancedApiKey,
          baseUrl: config.base_url,
          query: query.text,
          maxResults: 5,
          depth: 'advanced',
        })
      } else {
        batch = await searchWithBuiltinWebTool(query.text, 4)
      }
      batch = batch.filter((hit) => isAllowedSource(hit.url))
      if (useEnhancedSearch) enhancedHits += batch.length
      else builtinHits += batch.length
      query.hitCount = batch.length
      query.status = batch.length > 0 ? 'executed' : 'failed'
      hits.push(...batch)
    } catch {
      searchFailed = true
      if (useEnhancedSearch) enhancedSearchFailed = true
      query.status = 'failed'
    }

    // 空召回改写一次
    if (query.hitCount === 0) {
      const rewritten = rewriteQuery(query, input.industryName || input.productScope || input.researchQuestion.slice(0, 30))
      if (rewritten && !input.shouldCancel?.()) {
        queries.push(rewritten)
        query.status = 'rewritten'
      }
    }
  }
  basePlan.queries = queries.slice(0, 15)

  // 3) 官方源两段式
  for (const seed of basePlan.officialSeeds) {
    if (input.shouldCancel?.()) break
    try {
      const officialHits = await resolveOfficialDetailHits(seed, input.researchQuestion)
      hits.push(...officialHits)
    } catch {
      hits.push({
        title: seed,
        url: seed,
        snippet: null,
        providerId: 'official_url',
        query: input.researchQuestion,
        sourceKind: 'web_search',
        isDetailPage: false,
      })
    }
  }

  const dedup = new Map<string, ResearchSearchHit>()
  for (const hit of hits) {
    if (!isAllowedSource(hit.url)) continue
    if (!dedup.has(hit.url)) dedup.set(hit.url, hit)
  }

  const candidates: ResearchEvidenceCandidateRow[] = []
  for (const hit of [...dedup.values()].slice(0, POOL_LIMIT)) {
    if (input.shouldCancel?.()) break
    // 本地已有摘要时可少抓一次
    if ((hit.sourceKind === 'local_briefing' || hit.sourceKind === 'local_research') && hit.snippet) {
      const page = {
        url: hit.url,
        title: hit.title,
        summary: hit.snippet,
        excerpt: hit.snippet,
        publishedAt: hit.publishedAt || null,
        status: (hit.snippet.length >= 40 ? 'fetched' : 'partial') as 'fetched' | 'partial',
        failureReason: null,
        isDetailPage: true,
      }
      candidates.push(upsertEvidenceCandidate(db, toCandidateInput(hit, page, {
        projectId: input.projectId,
        runId: input.runId,
        topicTokens,
      })))
      continue
    }
    const page = await fetchResearchPage(hit.url)
    if (page.isDetailPage) {
      const q = basePlan.queries.find((item) => item.text === hit.query)
      if (q) q.detailUrlCount += 1
    }
    candidates.push(upsertEvidenceCandidate(db, toCandidateInput(hit, page, {
      projectId: input.projectId,
      runId: input.runId,
      topicTokens,
    })))
  }

  // 重新按 rank 读取，保证排序一致
  const ranked = listEvidenceCandidates(db, { projectId: input.projectId, runId: input.runId })
  const effective = ranked.filter((item) => {
    const excerpt = (item.excerpt || item.summary || '').trim()
    return item.status !== 'failed' && excerpt.length >= 40
  })
  const detailPageCount = ranked.filter((item) => item.is_detail_page === 1 && item.status !== 'failed').length
  const modeInfo = decideMode({
    enableWeb: true,
    enhancedHits,
    builtinHits,
    localHits,
    detailPages: detailPageCount,
    searchFailed,
  })

  const selected = (effective.length ? effective : ranked).slice(0, TOP_N)
  const enhancedSearch: ResearchRetrievalPlanView['enhancedSearch'] = !enhancedSearchConfigured
    ? {
        providerId: config?.provider_id ?? null,
        configured: false,
        status: 'not_configured',
        errorCode: null,
      }
    : !enhancedApiKey
      ? {
          providerId: config!.provider_id,
          configured: true,
          status: 'key_unavailable',
          errorCode: 'WEB_SEARCH_KEY_UNAVAILABLE',
        }
      : enhancedHits > 0
        ? {
            providerId: config!.provider_id,
            configured: true,
            status: 'succeeded',
            errorCode: null,
          }
        : enhancedSearchFailed
          ? {
              providerId: config!.provider_id,
              configured: true,
              status: 'failed',
              errorCode: 'WEB_SEARCH_PROVIDER_FAILED',
            }
          : {
              providerId: config!.provider_id,
              configured: true,
              status: 'empty',
              errorCode: 'WEB_SEARCH_EMPTY_RESULT',
            }
  if (config && enhancedSearchConfigured) {
    saveResearchWebSearchConfig(db, {
      providerId: config.provider_id,
      enabled: true,
      baseUrl: config.base_url,
      lastErrorCode: enhancedSearch.status === 'succeeded' || enhancedSearch.status === 'empty'
        ? null
        : enhancedSearch.errorCode,
    })
  }
  const parts = [`已收集 ${ranked.length} 条候选（精选 ${selected.length}）`, `模式 ${modeInfo.mode}`]
  if (localHits > 0) parts.push('本地语料')
  if (enhancedHits > 0) parts.push('增强搜索')
  if (builtinHits > 0) parts.push('内置弱检索')
  if (detailPageCount > 0) parts.push(`详情页 ${detailPageCount}`)
  if (enhancedSearch.status === 'key_unavailable') parts.push('增强搜索密钥暂不可用，已自动回退')
  if (enhancedSearch.status === 'failed') parts.push('增强搜索调用失败，已自动回退')
  if (enhancedSearch.status === 'empty') parts.push('增强搜索本轮无结果，已自动回退')
  const degradedCode = enhancedSearch.errorCode || modeInfo.degradedCode

  const plan: ResearchRetrievalPlanView = {
    ...basePlan,
    mode: modeInfo.mode,
    localHitCount: localHits,
    webHitCount: enhancedHits + builtinHits,
    detailPageCount,
    selectedTopN: selected.length,
    candidatePoolSize: ranked.length,
    degradedCode,
    message: parts.join(' · '),
    enhancedSearch,
  }

  return {
    plan,
    candidates: ranked,
    selectedTopNIds: selected.map((item) => item.id),
    mode: modeInfo.mode,
    degradedCode,
    message: plan.message,
  }
}

export function listProjectEvidenceCandidates(
  db: Database.Database,
  projectId: string,
  runId?: string,
): ResearchEvidenceCandidateRow[] {
  return listEvidenceCandidates(db, { projectId, runId })
}

export function confirmProjectEvidenceCandidate(
  db: Database.Database,
  projectId: string,
  candidateId: string,
  action: 'confirm' | 'reject',
): ResearchEvidenceCandidateRow {
  const candidate = getProjectEvidenceCandidate(db, projectId, candidateId)
  const run = candidate?.run_id ? getGenerationRun(db, candidate.run_id) : null
  if (!candidate || !run || run.project_id !== projectId) {
    throw new ResearchToolRuntimeError('NOT_FOUND', '候选证据不存在')
  }
  if (run.status !== 'succeeded') {
    throw new ResearchToolRuntimeError('INVALID_PARAM', '研究报告生成完成后才能调整正式证据库')
  }

  const formalEvidenceId = `evidence_${createHash('sha256')
    .update(`${projectId}:candidate:${candidate.id}`)
    .digest('hex')
    .slice(0, 20)}`

  return db.transaction(() => {
    if (action === 'confirm') {
      saveResearchEvidence(db, projectId, {
        id: formalEvidenceId,
        title: candidate.title,
        sourceType: 'web',
        sourceName: candidate.provider_id,
        sourceUrl: candidate.source_url,
        sourceRef: `generation:${run.id}:candidate:${candidate.id}`,
        publishedDate: candidate.published_at,
        statementKind: 'estimate',
        direction: 'support',
        reliability: candidate.source_kind === 'official_detail' ? 'secondary' : 'unknown',
        createdBy: 'human',
        primarySourceConfirmed: false,
        methodology: '用户选择纳入项目正式证据库；该动作不构成来源全局可信背书。',
        excerpt: candidate.excerpt || candidate.summary,
      })
    } else {
      db.prepare('DELETE FROM industry_research_evidence WHERE id = ? AND project_id = ?')
        .run(formalEvidenceId, projectId)
    }
    const updated = updateEvidenceCandidateStatus(db, candidateId, action === 'confirm' ? 'confirmed' : 'rejected')
    if (!updated) throw new ResearchToolRuntimeError('NOT_FOUND', '候选证据不存在')
    return updated
  })()
}
