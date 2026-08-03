import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import * as cheerio from 'cheerio'
import { PDFParse } from 'pdf-parse'
import { getResearchWebSearchConfig } from '../database/industryResearchGenerationRepository'
import type {
  ResearchAgentRunRow,
  ResearchAgentToolCallRow,
  ResearchWebSearchProviderId,
} from '../database/types'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import type {
  ResearchFactSource,
  ResearchFactToolEnvelope,
  ResearchFactToolStatus,
} from './researchFactToolRegistry'
import {
  requestResearchAgentNetwork,
  ResearchAgentNetworkError,
  type ResearchAgentNetworkEnvelope,
  type ResearchAgentNetworkRequest,
  type ResearchAgentNetworkResponse,
} from './researchAgentNetworkPolicy'

export const RESEARCH_AGENT_TOOL_REGISTRY_VERSION = 'research-agent-tools.v5'

export type ResearchAgentNetworkToolId =
  | 'web.search'
  | 'web.fetch_page'
  | 'official.disclosure_search'
  | 'official.disclosure_document'
  | 'company.fundamentals_refresh'
  | 'market.price_refresh'
  | 'market.quote_snapshot'

export interface ResearchAgentToolDefinition {
  id: string
  externalName: string
  description: string
  scope: 'market.read' | 'research.read' | 'portfolio.read'
  asOf: 'supported' | 'current-only'
  maxItems: number
  inputSchema: {
    type: 'object'
    additionalProperties: false
    properties: Record<string, Record<string, unknown>>
    required?: readonly string[]
  }
}

export type ResearchAgentNetworkToolEnvelope = ResearchFactToolEnvelope<ResearchAgentNetworkToolId, unknown>

export type ResearchAgentNetworkSubject =
  | { kind: 'stock'; tsCode: string; label: string | null }
  | { kind: 'industry_project'; id: string; label: string | null }

export interface ResearchAgentSearchCredentials {
  providerId: ResearchWebSearchProviderId
  apiKey: string
  baseUrl: string | null
}

export interface ResearchAgentNetworkToolDependencies {
  requestNetwork?: (request: ResearchAgentNetworkRequest) => Promise<ResearchAgentNetworkResponse>
  resolveSearchCredentials?: (db: Database.Database) => ResearchAgentSearchCredentials | null
}

export interface ExecuteResearchAgentNetworkToolInput {
  db: Database.Database
  run: ResearchAgentRunRow
  call: ResearchAgentToolCallRow
  subjects: readonly ResearchAgentNetworkSubject[]
  toolInput: Record<string, unknown>
  priorToolCalls: readonly ResearchAgentToolCallRow[]
  signal: AbortSignal
  now: number
  dependencies?: ResearchAgentNetworkToolDependencies
}

export class ResearchAgentNetworkToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcomeUnknown = false,
  ) {
    super(message)
    this.name = 'ResearchAgentNetworkToolError'
  }
}

interface SearchCandidate {
  candidateId: string
  searchCallId: string
  title: string
  url: string
  domain: string
  snippet: string | null
  publishedAt: string | null
  sourceClass: 'official' | 'primary' | 'secondary'
}

interface SearchHit {
  title: string
  url: string
  snippet: string | null
  publishedAt: string | null
}

const OFFICIAL_DOMAIN_ROOTS = [
  'bse.cn',
  'cninfo.com.cn',
  'csrc.gov.cn',
  'gov.cn',
  'miit.gov.cn',
  'ndrc.gov.cn',
  'pbc.gov.cn',
  'sse.com.cn',
  'stats.gov.cn',
  'szse.cn',
] as const

const SEARCH_TOOL_IDS = new Set<ResearchAgentNetworkToolId>([
  'web.search',
  'official.disclosure_search',
])
const DOCUMENT_TOOL_IDS = new Set<ResearchAgentNetworkToolId>([
  'web.fetch_page',
  'official.disclosure_document',
])
const NETWORK_TOOL_IDS = new Set<ResearchAgentNetworkToolId>([
  ...SEARCH_TOOL_IDS,
  ...DOCUMENT_TOOL_IDS,
  'company.fundamentals_refresh',
  'market.price_refresh',
  'market.quote_snapshot',
])

const asOfSchema = { type: ['string', 'null'], pattern: '^\\d{8}$' }
const stockCodeSchema = { type: 'string', pattern: '^\\d{6}(?:\\.(?:SH|SZ|BJ))?$' }
const candidateIdSchema = { type: 'string', pattern: '^SRC-[A-F0-9]{16}$' }
const querySchema = { type: 'string', maxLength: 300, pattern: '\\S{2}' }
const integerSchema = (minimum: number, maximum: number) => ({ type: 'integer', minimum, maximum })
const objectSchema = (
  properties: Record<string, Record<string, unknown>>,
  required?: readonly string[],
): ResearchAgentToolDefinition['inputSchema'] => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required?.length ? { required } : {}),
})

export const RESEARCH_AGENT_NETWORK_TOOL_DEFINITIONS = [
  {
    id: 'web.search',
    externalName: 'web_search',
    description: '使用已配置搜索服务发现网页候选；结果仅是线索，不能作为正文证据。查询必须绑定已确认研究主体。',
    scope: 'research.read',
    asOf: 'supported',
    maxItems: 8,
    inputSchema: objectSchema({ query: querySchema, maxResults: integerSchema(1, 8), asOf: asOfSchema }, ['query']),
  },
  {
    id: 'web.fetch_page',
    externalName: 'web_fetch_page',
    description: '抓取同一运行web.search已落账候选的正文；只接受候选ID，不接受URL。',
    scope: 'research.read',
    asOf: 'supported',
    maxItems: 1,
    inputSchema: objectSchema({ candidateId: candidateIdSchema, asOf: asOfSchema }, ['candidateId']),
  },
  {
    id: 'official.disclosure_search',
    externalName: 'official_disclosure_search',
    description: '在交易所、监管、政府或已知公司官网中发现正式披露候选；候选页本身不是正文证据。',
    scope: 'research.read',
    asOf: 'supported',
    maxItems: 8,
    inputSchema: objectSchema({
      query: querySchema,
      stockCode: stockCodeSchema,
      maxResults: integerSchema(1, 8),
      asOf: asOfSchema,
    }, ['query']),
  },
  {
    id: 'official.disclosure_document',
    externalName: 'official_disclosure_document',
    description: '抓取同一运行正式披露搜索已落账候选的正文；只接受候选ID，不接受URL。',
    scope: 'research.read',
    asOf: 'supported',
    maxItems: 1,
    inputSchema: objectSchema({ candidateId: candidateIdSchema, asOf: asOfSchema }, ['candidateId']),
  },
  {
    id: 'company.fundamentals_refresh',
    externalName: 'company_fundamentals_refresh',
    description: '通过固定东方财富公开接口按需取得已确认A股主体的结构化主要财务事实，不遍历其他证券。',
    scope: 'market.read',
    asOf: 'supported',
    maxItems: 8,
    inputSchema: objectSchema({ stockCode: stockCodeSchema, asOf: asOfSchema }, ['stockCode']),
  },
  {
    id: 'market.price_refresh',
    externalName: 'market_price_refresh',
    description: '通过固定东方财富公开接口按需取得已确认A股主体的日线行情，不写入或遍历其他证券。',
    scope: 'market.read',
    asOf: 'supported',
    maxItems: 120,
    inputSchema: objectSchema({
      stockCode: stockCodeSchema,
      limit: integerSchema(10, 120),
      asOf: asOfSchema,
    }, ['stockCode']),
  },
  {
    id: 'market.quote_snapshot',
    externalName: 'market_quote_snapshot',
    description: '通过固定东方财富公开接口按需取得已确认A股主体的当前行情快照及精确抓取时间。',
    scope: 'market.read',
    asOf: 'current-only',
    maxItems: 1,
    inputSchema: objectSchema({ stockCode: stockCodeSchema }, ['stockCode']),
  },
] as const satisfies readonly ResearchAgentToolDefinition[]

export function isResearchAgentNetworkToolId(value: string): value is ResearchAgentNetworkToolId {
  return NETWORK_TOOL_IDS.has(value as ResearchAgentNetworkToolId)
}

export function isResearchAgentSearchToolId(value: string): value is Extract<ResearchAgentNetworkToolId, 'web.search' | 'official.disclosure_search'> {
  return SEARCH_TOOL_IDS.has(value as ResearchAgentNetworkToolId)
}

export function isResearchAgentDocumentToolId(value: string): value is Extract<ResearchAgentNetworkToolId, 'web.fetch_page' | 'official.disclosure_document'> {
  return DOCUMENT_TOOL_IDS.has(value as ResearchAgentNetworkToolId)
}

export async function executeResearchAgentNetworkTool(
  input: ExecuteResearchAgentNetworkToolInput,
): Promise<ResearchAgentNetworkToolEnvelope> {
  switch (input.call.tool_id as ResearchAgentNetworkToolId) {
    case 'web.search':
      return executeSearch(input, false)
    case 'official.disclosure_search':
      return executeSearch(input, true)
    case 'web.fetch_page':
      return executeDocumentFetch(input, false)
    case 'official.disclosure_document':
      return executeDocumentFetch(input, true)
    case 'company.fundamentals_refresh':
      return executeFundamentalsRefresh(input)
    case 'market.price_refresh':
      return executePriceRefresh(input)
    case 'market.quote_snapshot':
      return executeQuoteSnapshot(input)
    default:
      throw new ResearchAgentNetworkToolError('UNKNOWN_TOOL', '未知Agent联网工具')
  }
}

export function resolveConfiguredResearchAgentSearch(
  db: Database.Database,
): ResearchAgentSearchCredentials | null {
  const row = getResearchWebSearchConfig(db)
  if (!row || row.enabled !== 1 || !row.api_key_encrypted) return null
  const apiKey = decryptApiKey(row.api_key_encrypted)
  if (!apiKey) return null
  return { providerId: row.provider_id, apiKey, baseUrl: row.base_url }
}

async function executeSearch(
  input: ExecuteResearchAgentNetworkToolInput,
  officialOnly: boolean,
): Promise<ResearchAgentNetworkToolEnvelope> {
  const query = text(input.toolInput.query, 300)
  if (!query || query.length < 2 || !queryReferencesSubject(query, input.subjects)) {
    throw new ResearchAgentNetworkToolError('SUBJECT_DENIED', '联网查询必须明确包含已确认研究主体的代码或名称')
  }
  const stockCode = input.toolInput.stockCode == null ? null : normalizeStockCode(input.toolInput.stockCode)
  if (stockCode && !input.subjects.some((subject) => subject.kind === 'stock' && subject.tsCode === stockCode)) {
    throw new ResearchAgentNetworkToolError('SUBJECT_DENIED', '正式披露搜索只能使用已确认股票主体')
  }
  const credentials = (input.dependencies?.resolveSearchCredentials ?? resolveConfiguredResearchAgentSearch)(input.db)
  if (!credentials) {
    throw new ResearchAgentNetworkToolError('WEB_SEARCH_NOT_CONFIGURED', '尚未配置可用的联网搜索服务')
  }
  const maxResults = boundedInteger(input.toolInput.maxResults, 6, 1, 8)
  const companyDomains = knownCompanyDomains(input.db, input.subjects)
  const officialSearchDomains = [...new Set([...OFFICIAL_DOMAIN_ROOTS, ...companyDomains])].sort()
  const effectiveQuery = officialOnly
    ? `${query} (${officialSearchDomains.map((domain) => `site:${domain}`).join(' OR ')})`
    : query
  const request = buildSearchRequest(credentials, effectiveQuery, maxResults)
  const response = await network(input, request)
  assertSuccessfulResponse(response, 'WEB_SEARCH_PROVIDER_FAILED')
  const hits = parseSearchResponse(credentials.providerId, response.body)
  const excluded = excludedUrlKeys(input.run.context_snapshot_json)
  const candidates = rankSearchCandidates(uniqueByUrl(hits).flatMap((hit): SearchCandidate[] => {
    const normalizedUrl = normalizePublicUrl(hit.url)
    if (!normalizedUrl || excluded.has(urlKey(normalizedUrl))) return []
    const domain = new URL(normalizedUrl).hostname.toLowerCase()
    const sourceClass = classifySource(domain, companyDomains)
    if (officialOnly && sourceClass === 'secondary') return []
    const publishedAt = normalizePublishedAt(hit.publishedAt, input.run.as_of)
    if (publishedAt === 'future') return []
    return [{
      candidateId: candidateId(input.run.id, normalizedUrl),
      searchCallId: input.call.id,
      title: (hit.title || domain).trim().slice(0, 300),
      url: normalizedUrl,
      domain,
      snippet: hit.snippet?.trim().slice(0, 800) || null,
      publishedAt,
      sourceClass,
    }]
  }), query, input.subjects).slice(0, maxResults)
  const toolId = officialOnly ? 'official.disclosure_search' : 'web.search'
  const warnings = [
    '搜索标题、摘要与URL仅用于发现候选，不计为正文证据。',
    ...(hits.length > candidates.length ? ['部分候选因来源、截点、URL或排除策略被过滤。'] : []),
    ...(candidates.length === 0 ? ['搜索没有返回符合当前运行边界的候选。'] : []),
  ]
  return envelope(toolId, candidates.length > 0 ? 'ready' : 'missing', input, [
    { id: `search.${credentials.providerId}`, status: candidates.length > 0 ? 'ready' : 'missing', factDate: input.run.as_of },
  ], {
    available: candidates.length,
    required: 1,
    unit: 'candidates',
  }, warnings, {
    query,
    providerId: credentials.providerId,
    candidates,
    networkEnvelope: response.envelope,
  })
}

async function executeDocumentFetch(
  input: ExecuteResearchAgentNetworkToolInput,
  officialOnly: boolean,
): Promise<ResearchAgentNetworkToolEnvelope> {
  const candidateIdValue = text(input.toolInput.candidateId, 32)
  if (!candidateIdValue) throw new ResearchAgentNetworkToolError('INVALID_INPUT', 'candidateId无效')
  const candidate = resolveCandidate(input, candidateIdValue, officialOnly)
  if (!candidate) {
    throw new ResearchAgentNetworkToolError(
      'CANDIDATE_NOT_AUTHORIZED',
      '正文抓取只能使用同一运行中已成功落账且未被排除的搜索候选',
    )
  }
  const response = await network(input, {
    url: candidate.url,
    method: 'GET',
    headers: { accept: 'text/html,application/xhtml+xml,text/plain,application/pdf;q=0.9' },
    acceptedMimeKinds: ['html', 'text', 'pdf'],
    signal: input.signal,
  })
  assertSuccessfulResponse(response, 'PAGE_FETCH_FAILED')
  const toolId = officialOnly ? 'official.disclosure_document' : 'web.fetch_page'
  const finalUrl = response.envelope.response.finalUrl
  const finalDomain = new URL(finalUrl).hostname.toLowerCase()
  const sourceClass = classifySource(finalDomain, knownCompanyDomains(input.db, input.subjects))
  const officialUrlPublishedAt = sourceClass === 'official'
    ? publicationDateFromOfficialUrl(finalUrl, input.run.as_of)
    : null
  const parsed = await extractDocument(response, {
    ...candidate,
    publishedAt: candidate.publishedAt ?? officialUrlPublishedAt,
  }, input.run.as_of)
  const readable = parsed.excerpt.length >= 80
  const usable = readable && parsed.publishedAt != null
  const status: ResearchFactToolStatus = usable ? 'ready' : 'partial'
  const sourceId = `${sourceClass === 'secondary' ? 'web' : 'official'}.${finalDomain}`
  return envelope(toolId, status, input, [{
    id: sourceId,
    status: usable ? 'ready' : 'missing',
    factDate: compactDate(parsed.publishedAt),
  }], {
    available: usable ? 1 : 0,
    required: 1,
    unit: 'documents',
  }, [
    ...(readable ? [] : ['页面已抓取，但没有提取到至少80字的可引用正文。']),
    ...parsed.warnings,
    ...(candidate.publishedAt == null && officialUrlPublishedAt != null
      ? ['发布日期取自正式披露URL中的日期标记，并已按研究截点校验。']
      : []),
    ...(parsed.publishedAt ? [] : ['页面没有可验证的发布时间；抓取时间不得冒充发布时间。']),
    ...(finalDomain === candidate.domain ? [] : ['最终响应域名与搜索候选不同；来源等级已按最终响应域名重新判定。']),
  ], {
    document: {
      candidateId: candidate.candidateId,
      title: parsed.title,
      finalUrl,
      sourceDomain: finalDomain,
      sourceClass,
      primarySourceConfirmed: sourceClass === 'official' || sourceClass === 'primary',
      publishedAt: parsed.publishedAt,
      fetchedAt: response.envelope.response.fetchedAt,
      excerpt: parsed.excerpt,
      excerptTruncated: parsed.excerptTruncated,
      contentSha256: parsed.contentSha256,
      rawBodySha256: response.envelope.response.bodySha256,
      mimeKind: response.envelope.response.mimeKind,
    },
    networkEnvelope: response.envelope,
  })
}

async function executePriceRefresh(
  input: ExecuteResearchAgentNetworkToolInput,
): Promise<ResearchAgentNetworkToolEnvelope> {
  const normalized = requireAllowedStock(input)
  const limit = boundedInteger(input.toolInput.limit, 60, 10, 120)
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get')
  url.searchParams.set('secid', eastmoneySecId(normalized))
  url.searchParams.set('klt', '101')
  url.searchParams.set('fqt', '0')
  url.searchParams.set('beg', `${input.run.as_of.slice(0, 4)}0101`)
  url.searchParams.set('end', input.run.as_of)
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57')
  url.searchParams.set('lmt', String(limit))
  const response = await network(input, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    acceptedMimeKinds: ['json'],
    signal: input.signal,
  })
  assertSuccessfulResponse(response, 'MARKET_REFRESH_FAILED')
  const root = parseJsonBody(response.body, 'MARKET_RESPONSE_INVALID')
  const data = record(root.data)
  const bars = (Array.isArray(data?.klines) ? data.klines : []).flatMap((value) => {
    if (typeof value !== 'string') return []
    const fields = value.split(',')
    const tradeDate = compactDate(fields[0])
    const open = finiteNumber(fields[1])
    const close = finiteNumber(fields[2])
    const high = finiteNumber(fields[3])
    const low = finiteNumber(fields[4])
    if (!tradeDate || tradeDate > input.run.as_of || [open, close, high, low].some((item) => item == null)) return []
    return [{
      tradeDate,
      open,
      close,
      high,
      low,
      volume: finiteNumber(fields[5]),
      amount: finiteNumber(fields[6]),
    }]
  }).slice(-limit)
  const factDate = bars.at(-1)?.tradeDate ?? null
  return envelope('market.price_refresh', bars.length >= 10 ? 'ready' : bars.length > 0 ? 'partial' : 'missing', input, [{
    id: 'eastmoney.public_daily',
    status: bars.length > 0 ? 'ready' : 'missing',
    factDate,
  }], {
    available: bars.length,
    required: 10,
    unit: 'bars',
  }, bars.length >= 10 ? [] : [`公开日线仅取得${bars.length}根，少于最低10根。`], {
    stockCode: normalized.slice(0, 6),
    tsCode: normalized,
    stockName: text(data?.name, 100),
    bars,
    fetchedAt: response.envelope.response.fetchedAt,
    bodySha256: response.envelope.response.bodySha256,
    networkEnvelope: response.envelope,
  })
}

async function executeQuoteSnapshot(
  input: ExecuteResearchAgentNetworkToolInput,
): Promise<ResearchAgentNetworkToolEnvelope> {
  const normalized = requireAllowedStock(input)
  const currentAsOf = beijingDate(input.now)
  if (input.run.as_of !== currentAsOf) {
    throw new ResearchAgentNetworkToolError('AS_OF_MISMATCH', '实时行情只能用于事实截点为北京时间当天的运行')
  }
  const url = new URL('https://push2.eastmoney.com/api/qt/stock/get')
  url.searchParams.set('secid', eastmoneySecId(normalized))
  url.searchParams.set('fields', 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f170')
  const response = await network(input, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    acceptedMimeKinds: ['json'],
    signal: input.signal,
  })
  assertSuccessfulResponse(response, 'QUOTE_REFRESH_FAILED')
  const root = parseJsonBody(response.body, 'MARKET_RESPONSE_INVALID')
  const data = record(root.data)
  const price = scaledNumber(data?.f43, 100)
  const preClose = scaledNumber(data?.f60, 100)
  const quote = price == null ? null : {
    stockCode: normalized.slice(0, 6),
    tsCode: normalized,
    stockName: text(data?.f58, 100),
    price,
    preClose,
    changePct: scaledNumber(data?.f170, 100),
    open: scaledNumber(data?.f46, 100),
    high: scaledNumber(data?.f44, 100),
    low: scaledNumber(data?.f45, 100),
    volume: finiteNumber(data?.f47),
    amount: finiteNumber(data?.f48),
    quoteAt: response.envelope.response.fetchedAt,
  }
  return envelope('market.quote_snapshot', quote ? 'ready' : 'missing', input, [{
    id: 'eastmoney.public_quote',
    status: quote ? 'ready' : 'missing',
    factDate: currentAsOf,
  }], {
    available: quote ? 1 : 0,
    required: 1,
    unit: 'quotes',
  }, quote ? [] : ['公开行情接口没有返回有效最新价。'], {
    quote,
    fetchedAt: response.envelope.response.fetchedAt,
    bodySha256: response.envelope.response.bodySha256,
    networkEnvelope: response.envelope,
  })
}

async function executeFundamentalsRefresh(
  input: ExecuteResearchAgentNetworkToolInput,
): Promise<ResearchAgentNetworkToolEnvelope> {
  const normalized = requireAllowedStock(input)
  const url = new URL('https://datacenter.eastmoney.com/securities/api/data/v1/get')
  url.searchParams.set('reportName', 'RPT_F10_FINANCE_MAINFINADATA')
  url.searchParams.set('columns', 'SECUCODE,SECURITY_NAME_ABBR,REPORT_DATE,REPORT_TYPE,NOTICE_DATE,CURRENCY,TOTALOPERATEREVE,PARENTNETPROFIT,KCFJCXSYJLR,TOTALOPERATEREVETZ,PARENTNETPROFITTZ,KCFJCXSYJLRTZ,ROEJQ,XSMLL,XSJLL,ZCFZL,NETCASH_OPERATE_PK,EPSJB,BPS')
  url.searchParams.set('quoteColumns', '')
  url.searchParams.set('filter', `(SECUCODE="${normalized}")`)
  url.searchParams.set('pageNumber', '1')
  url.searchParams.set('pageSize', '8')
  url.searchParams.set('sortTypes', '-1')
  url.searchParams.set('sortColumns', 'REPORT_DATE')
  url.searchParams.set('source', 'HSF10')
  url.searchParams.set('client', 'PC')
  const response = await network(input, {
    url: url.toString(),
    method: 'GET',
    headers: { accept: 'application/json' },
    acceptedMimeKinds: ['json'],
    signal: input.signal,
  })
  assertSuccessfulResponse(response, 'FUNDAMENTALS_REFRESH_FAILED')
  const root = parseJsonBody(response.body, 'FUNDAMENTALS_RESPONSE_INVALID')
  const result = record(root.result)
  const rows = (Array.isArray(result?.data) ? result.data : []).flatMap((value) => {
    const row = record(value)
    if (!row || text(row.SECUCODE, 16) !== normalized) return []
    const reportDate = compactDate(text(row.REPORT_DATE, 40))
    const noticeDate = compactDate(text(row.NOTICE_DATE, 40))
    if (!reportDate || reportDate > input.run.as_of || (noticeDate && noticeDate > input.run.as_of)) return []
    return [{
      reportDate,
      reportType: text(row.REPORT_TYPE, 80),
      noticeDate,
      currency: text(row.CURRENCY, 16),
      totalRevenue: finiteNumber(row.TOTALOPERATEREVE),
      parentNetProfit: finiteNumber(row.PARENTNETPROFIT),
      deductedNetProfit: finiteNumber(row.KCFJCXSYJLR),
      revenueYoy: finiteNumber(row.TOTALOPERATEREVETZ),
      parentNetProfitYoy: finiteNumber(row.PARENTNETPROFITTZ),
      deductedNetProfitYoy: finiteNumber(row.KCFJCXSYJLRTZ),
      weightedRoe: finiteNumber(row.ROEJQ),
      grossMargin: finiteNumber(row.XSMLL),
      netMargin: finiteNumber(row.XSJLL),
      debtRatio: finiteNumber(row.ZCFZL),
      operatingCashFlow: finiteNumber(row.NETCASH_OPERATE_PK),
      basicEps: finiteNumber(row.EPSJB),
      bookValuePerShare: finiteNumber(row.BPS),
    }]
  }).slice(0, 8)
  const factDate = rows.map((row) => row.noticeDate ?? row.reportDate).sort().at(-1) ?? null
  return envelope('company.fundamentals_refresh', rows.length > 0 ? 'ready' : 'missing', input, [{
    id: 'eastmoney.main_finance',
    status: rows.length > 0 ? 'ready' : 'missing',
    factDate,
  }], {
    available: rows.length,
    required: 1,
    unit: 'reports',
  }, rows.length > 0 ? [
    '结构化公开财务事实不替代公司、交易所或监管正式披露正文。',
  ] : ['公开财务接口没有返回截点内的有效报告。'], {
    stockCode: normalized.slice(0, 6),
    tsCode: normalized,
    stockName: text(record((Array.isArray(result?.data) ? result.data : [])[0])?.SECURITY_NAME_ABBR, 100),
    reports: rows,
    fetchedAt: response.envelope.response.fetchedAt,
    bodySha256: response.envelope.response.bodySha256,
    networkEnvelope: response.envelope,
  })
}

function buildSearchRequest(
  credentials: ResearchAgentSearchCredentials,
  query: string,
  maxResults: number,
): ResearchAgentNetworkRequest {
  if (credentials.providerId === 'tavily') {
    const endpoint = safeSearchEndpoint(credentials.baseUrl, 'https://api.tavily.com/search')
    return {
      url: endpoint,
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credentials.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        include_answer: false,
        search_depth: 'advanced',
      }),
      acceptedMimeKinds: ['json'],
    }
  }
  if (credentials.providerId === 'bing') {
    const endpoint = new URL(safeSearchEndpoint(credentials.baseUrl, 'https://api.bing.microsoft.com/v7.0/search'))
    endpoint.searchParams.set('q', query)
    endpoint.searchParams.set('count', String(maxResults))
    endpoint.searchParams.set('mkt', 'zh-CN')
    return {
      url: endpoint.toString(),
      method: 'GET',
      headers: {
        accept: 'application/json',
        'ocp-apim-subscription-key': credentials.apiKey,
      },
      acceptedMimeKinds: ['json'],
    }
  }
  const base = safeSearchEndpoint(credentials.baseUrl, null)
  const endpoint = new URL(base.endsWith('/search') ? base : `${base.replace(/\/$/, '')}/search`)
  return {
    url: endpoint.toString(),
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${credentials.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, max_results: maxResults }),
    acceptedMimeKinds: ['json'],
  }
}

function parseSearchResponse(providerId: ResearchWebSearchProviderId, body: Buffer): SearchHit[] {
  const root = parseJsonBody(body, 'WEB_SEARCH_RESPONSE_INVALID')
  if (providerId === 'bing') {
    const webPages = record(root.webPages)
    return (Array.isArray(webPages?.value) ? webPages.value : []).flatMap((value): SearchHit[] => {
      const item = record(value)
      const url = text(item?.url, 4_000)
      if (!url) return []
      return [{
        title: text(item?.name, 300) ?? url,
        url,
        snippet: text(item?.snippet, 800),
        publishedAt: text(item?.datePublished, 80),
      }]
    })
  }
  return (Array.isArray(root.results) ? root.results : []).flatMap((value): SearchHit[] => {
    const item = record(value)
    const url = text(item?.url, 4_000)
    if (!url) return []
    return [{
      title: text(item?.title, 300) ?? url,
      url,
      snippet: text(item?.snippet, 800) ?? text(item?.content, 800),
      publishedAt: text(item?.published_date, 80) ?? text(item?.published_at, 80),
    }]
  })
}

async function extractDocument(
  response: ResearchAgentNetworkResponse,
  candidate: SearchCandidate,
  asOf: string,
): Promise<{
  title: string
  publishedAt: string | null
  excerpt: string
  excerptTruncated: boolean
  contentSha256: string
  warnings: string[]
}> {
  if (response.envelope.response.mimeKind === 'pdf') {
    const parser = new PDFParse({ data: response.body })
    try {
      const result = await parser.getText({ first: 24 })
      const document = boundedDocument(candidate.title, candidate.publishedAt, normalizeWhitespace(result.text), asOf)
      return {
        ...document,
        warnings: document.excerpt.length >= 80
          ? ['PDF已提取前24页内的有界正文；原始响应与提取正文分别固化哈希。']
          : ['PDF已解析，但前24页没有提取到至少80字的可引用正文。'],
      }
    } catch {
      return {
        title: candidate.title,
        publishedAt: normalizedPublicationDate(candidate.publishedAt, asOf),
        excerpt: '',
        excerptTruncated: false,
        contentSha256: response.envelope.response.bodySha256,
        warnings: ['PDF原始响应已固化哈希，但文本解析失败；该文件不计入可用正文。'],
      }
    } finally {
      await parser.destroy().catch(() => undefined)
    }
  }
  const raw = response.body.toString('utf8')
  if (response.envelope.response.mimeKind === 'text') {
    const fullText = normalizeWhitespace(raw)
    return { ...boundedDocument(candidate.title, candidate.publishedAt, fullText, asOf), warnings: [] }
  }
  const $ = cheerio.load(raw)
  const publishedAt = extractPublishedAt($) ?? candidate.publishedAt
  $('script,style,noscript,svg,canvas,nav,header,footer,form,aside').remove()
  const title = normalizeWhitespace(
    $('meta[property="og:title"]').attr('content')
      ?? $('meta[name="twitter:title"]').attr('content')
      ?? $('title').first().text()
      ?? candidate.title,
  ).slice(0, 300) || candidate.title
  const selectors = [
    'article',
    'main',
    '[role="main"]',
    '.article-content',
    '.article_content',
    '.content-detail',
    '.detail-content',
    '.news-content',
    '.post-content',
    '#content',
    'body',
  ]
  let fullText = ''
  for (const selector of selectors) {
    const candidateText = normalizeWhitespace($(selector).first().text())
    if (candidateText.length > fullText.length) fullText = candidateText
    if (fullText.length >= 1_000 && selector !== 'body') break
  }
  return { ...boundedDocument(title, publishedAt, fullText, asOf), warnings: [] }
}

function boundedDocument(
  title: string,
  publishedAtValue: string | null,
  fullText: string,
  asOf: string,
) {
  const normalizedPublished = normalizePublishedAt(publishedAtValue, asOf)
  const excerpt = fullText.slice(0, 48_000)
  return {
    title: title.slice(0, 300),
    publishedAt: normalizedPublished === 'future' ? null : normalizedPublished,
    excerpt,
    excerptTruncated: excerpt.length < fullText.length,
    contentSha256: sha256(fullText),
  }
}

function normalizedPublicationDate(value: string | null, asOf: string): string | null {
  const normalized = normalizePublishedAt(value, asOf)
  return normalized === 'future' ? null : normalized
}

function publicationDateFromOfficialUrl(value: string, asOf: string): string | null {
  let url: URL
  try { url = new URL(value) } catch { return null }
  const domain = url.hostname.toLowerCase()
  if (!OFFICIAL_DOMAIN_ROOTS.some((root) => domain === root || domain.endsWith(`.${root}`))) return null
  const matches = `${url.pathname} ${url.search}`.match(/(?<!\d)20\d{6}(?!\d)/g) ?? []
  const dates = matches.flatMap((candidate) => {
    const normalized = normalizePublishedAt(candidate, asOf)
    return normalized && normalized !== 'future' ? [normalized] : []
  })
  return dates.sort().at(-1) ?? null
}

function rankSearchCandidates(
  candidates: SearchCandidate[],
  query: string,
  subjects: readonly ResearchAgentNetworkSubject[],
): SearchCandidate[] {
  const keywords = searchKeywords([query, ...subjects.map((subject) => (
    subject.kind === 'stock' ? `${subject.tsCode} ${subject.label ?? ''}` : `${subject.id} ${subject.label ?? ''}`
  ))].join(' '))
  return candidates
    .map((candidate, index) => ({ candidate, index, score: candidateRank(candidate, keywords) }))
    .sort((left, right) => right.score - left.score
      || publicationSortValue(right.candidate.publishedAt) - publicationSortValue(left.candidate.publishedAt)
      || left.index - right.index
      || left.candidate.url.localeCompare(right.candidate.url))
    .map((item) => item.candidate)
}

function candidateRank(candidate: SearchCandidate, keywords: string[]): number {
  const sourceScore = candidate.sourceClass === 'official' ? 300 : candidate.sourceClass === 'primary' ? 240 : 100
  const url = candidate.url.toLowerCase()
  const capabilityScore = /\.pdf(?:$|[?#])/.test(url)
    ? 35
    : /\.(?:html?|shtml)(?:$|[?#])/.test(url) || /(?:article|detail|disclosure|notice|report|公告|披露)/i.test(url)
      ? 25
      : 10
  const haystack = normalizeSearchText(`${candidate.title} ${candidate.snippet ?? ''} ${candidate.domain}`)
  const relevanceScore = keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 45 : 0), 0)
  const dateScore = candidate.publishedAt ? 20 : 0
  const repostPenalty = /转载|转自|来源[:：]|综合(?:自|整理)|repost|syndicat/i.test(`${candidate.title} ${candidate.snippet ?? ''}`) ? 60 : 0
  return sourceScore + capabilityScore + relevanceScore + dateScore - repostPenalty
}

function searchKeywords(value: string): string[] {
  const stopWords = new Set(['研究', '分析', '最新', '近期', '当前', '相关', '情况', '什么', '如何', '以及', '截至', '资料'])
  const words = value.match(/[\p{Script=Han}]{2,8}|[A-Za-z0-9.]{2,}/gu) ?? []
  return [...new Set(words.map(normalizeSearchText).filter((word) => word.length >= 2 && !stopWords.has(word)))].slice(0, 20)
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{Script=Han}a-z0-9.]+/gu, '')
}

function publicationSortValue(value: string | null): number {
  const compact = compactDate(value)
  return compact ? Number(compact) : 0
}

function extractPublishedAt($: ReturnType<typeof cheerio.load>): string | null {
  const metaSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="publishdate"]',
    'meta[name="publish-date"]',
    'meta[name="date"]',
    'meta[itemprop="datePublished"]',
  ]
  for (const selector of metaSelectors) {
    const value = $(selector).attr('content')
    if (value?.trim()) return value.trim().slice(0, 80)
  }
  const time = $('time[datetime]').first().attr('datetime')
  if (time?.trim()) return time.trim().slice(0, 80)
  const jsonLd = $('script[type="application/ld+json"]').toArray()
  for (const node of jsonLd) {
    try {
      const value = JSON.parse($(node).text()) as unknown
      const found = findJsonDate(value, 0)
      if (found) return found
    } catch {
      // Invalid JSON-LD is ignored; it cannot become evidence metadata.
    }
  }
  return null
}

function findJsonDate(value: unknown, depth: number): string | null {
  if (depth > 5 || value == null) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonDate(item, depth + 1)
      if (found) return found
    }
    return null
  }
  const object = record(value)
  if (!object) return null
  for (const key of ['datePublished', 'dateCreated', 'uploadDate']) {
    const found = text(object[key], 80)
    if (found) return found
  }
  for (const child of Object.values(object)) {
    const found = findJsonDate(child, depth + 1)
    if (found) return found
  }
  return null
}

function resolveCandidate(
  input: ExecuteResearchAgentNetworkToolInput,
  wantedId: string,
  officialOnly: boolean,
): SearchCandidate | null {
  const allowedSearchTool = officialOnly ? 'official.disclosure_search' : 'web.search'
  const excluded = excludedUrlKeys(input.run.context_snapshot_json)
  for (const call of input.priorToolCalls) {
    if (call.run_id !== input.run.id || call.status !== 'succeeded' || call.tool_id !== allowedSearchTool || !call.envelope_json) continue
    const envelopeValue = parseStoredObject(call.envelope_json)
    const data = record(envelopeValue?.data)
    const candidates = Array.isArray(data?.candidates) ? data.candidates : []
    for (const raw of candidates) {
      const candidate = parseCandidate(raw)
      if (!candidate || candidate.candidateId !== wantedId || candidate.searchCallId !== call.id) continue
      if (candidate.candidateId !== candidateId(input.run.id, candidate.url)) continue
      if (excluded.has(urlKey(candidate.url))) continue
      if (officialOnly && candidate.sourceClass === 'secondary') continue
      return candidate
    }
  }
  return null
}

function parseCandidate(value: unknown): SearchCandidate | null {
  const item = record(value)
  if (!item) return null
  const candidateIdValue = text(item.candidateId, 32)
  const searchCallId = text(item.searchCallId, 40)
  const title = text(item.title, 300)
  const url = text(item.url, 4_000)
  const domain = text(item.domain, 253)
  const sourceClass = item.sourceClass
  if (
    !candidateIdValue
    || !searchCallId
    || !title
    || !url
    || !domain
    || !['official', 'primary', 'secondary'].includes(String(sourceClass))
    || normalizePublicUrl(url) !== url
    || new URL(url).hostname.toLowerCase() !== domain
  ) return null
  return {
    candidateId: candidateIdValue,
    searchCallId,
    title,
    url,
    domain,
    snippet: text(item.snippet, 800),
    publishedAt: text(item.publishedAt, 80),
    sourceClass: sourceClass as SearchCandidate['sourceClass'],
  }
}

async function network(
  input: ExecuteResearchAgentNetworkToolInput,
  request: ResearchAgentNetworkRequest,
): Promise<ResearchAgentNetworkResponse> {
  try {
    return await (input.dependencies?.requestNetwork ?? requestResearchAgentNetwork)({
      ...request,
      signal: input.signal,
    })
  } catch (error) {
    if (error instanceof ResearchAgentNetworkError) {
      const uncertain = [
        'NETWORK_ABORTED',
        'NETWORK_CONNECT_TIMEOUT',
        'NETWORK_REQUEST_FAILED',
        'NETWORK_TOTAL_TIMEOUT',
      ].includes(error.code)
      throw new ResearchAgentNetworkToolError(error.code, error.message, uncertain)
    }
    throw new ResearchAgentNetworkToolError('NETWORK_REQUEST_FAILED', '研究联网请求失败且无法确认发送结果', true)
  }
}

function assertSuccessfulResponse(response: ResearchAgentNetworkResponse, code: string): void {
  const status = response.envelope.response.statusCode
  if (status >= 200 && status < 300) return
  const suffix = status === 429 ? '：上游限流' : ''
  throw new ResearchAgentNetworkToolError(status === 429 ? 'NETWORK_RATE_LIMITED' : code, `联网响应状态为${status}${suffix}`)
}

function requireAllowedStock(input: ExecuteResearchAgentNetworkToolInput): string {
  const normalized = normalizeStockCode(input.toolInput.stockCode)
  if (!normalized || !input.subjects.some((subject) => subject.kind === 'stock' && subject.tsCode === normalized)) {
    throw new ResearchAgentNetworkToolError('SUBJECT_DENIED', '行情与财务刷新只能访问已确认股票主体')
  }
  return normalized
}

function knownCompanyDomains(
  db: Database.Database,
  subjects: readonly ResearchAgentNetworkSubject[],
): Set<string> {
  const domains = new Set<string>()
  const statement = db.prepare('SELECT website FROM stock_fundamental_profiles WHERE ts_code = ? LIMIT 1')
  for (const subject of subjects) {
    if (subject.kind !== 'stock') continue
    const row = statement.get(subject.tsCode) as { website: string | null } | undefined
    if (!row?.website) continue
    try {
      const url = new URL(row.website.includes('://') ? row.website : `https://${row.website}`)
      if (url.hostname) domains.add(url.hostname.toLowerCase())
    } catch {
      // Invalid locally cached websites cannot become trusted source domains.
    }
  }
  return domains
}

function classifySource(domain: string, companyDomains: Set<string>): SearchCandidate['sourceClass'] {
  if (OFFICIAL_DOMAIN_ROOTS.some((root) => domain === root || domain.endsWith(`.${root}`))) return 'official'
  if ([...companyDomains].some((root) => domain === root || domain.endsWith(`.${root}`))) return 'primary'
  return 'secondary'
}

function queryReferencesSubject(query: string, subjects: readonly ResearchAgentNetworkSubject[]): boolean {
  const normalizedQuery = query.toLowerCase().replace(/\s+/g, '')
  return subjects.some((subject) => {
    if (subject.kind === 'stock' && normalizedQuery.includes(subject.tsCode.slice(0, 6))) return true
    const label = subject.label?.trim().toLowerCase().replace(/\s+/g, '')
    if (!label) return false
    if (normalizedQuery.includes(label)) return true
    for (let index = 0; index + 2 <= label.length; index += 1) {
      if (normalizedQuery.includes(label.slice(index, index + 2))) return true
    }
    return false
  })
}

function safeSearchEndpoint(value: string | null | undefined, fallback: string | null): string {
  const raw = value?.trim() || fallback
  if (!raw) throw new ResearchAgentNetworkToolError('WEB_SEARCH_NOT_CONFIGURED', '自定义搜索服务缺少Base URL')
  let url: URL
  try { url = new URL(raw) } catch { throw new ResearchAgentNetworkToolError('WEB_SEARCH_CONFIG_INVALID', '搜索服务URL无效') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new ResearchAgentNetworkToolError('WEB_SEARCH_CONFIG_INVALID', '搜索服务必须使用不含凭据或片段的HTTPS URL')
  }
  for (const key of url.searchParams.keys()) {
    if (/key|token|secret|password|auth|signature/i.test(key)) {
      throw new ResearchAgentNetworkToolError('WEB_SEARCH_CONFIG_INVALID', '搜索服务URL不得在查询参数中保存凭据')
    }
  }
  return url.toString()
}

function envelope(
  toolId: ResearchAgentNetworkToolId,
  status: ResearchFactToolStatus,
  input: ExecuteResearchAgentNetworkToolInput,
  sources: ResearchFactSource[],
  coverage: { available: number; required: number | null; unit: string },
  warnings: string[],
  data: unknown,
): ResearchAgentNetworkToolEnvelope {
  return {
    schemaVersion: 1,
    toolId,
    status,
    generatedAt: input.now,
    asOf: toolId === 'market.quote_snapshot' ? null : input.run.as_of,
    sources,
    coverage,
    warnings: warnings.slice(0, 20).map((warning) => warning.slice(0, 500)),
    data,
  }
}

function normalizeStockCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().toUpperCase().match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/)
  if (!match) return null
  const market = /^(4|8|92)/.test(match[1]) ? 'BJ' : /^(5|6|9|11)/.test(match[1]) ? 'SH' : 'SZ'
  if (match[2] && match[2] !== market) return null
  return `${match[1]}.${market}`
}

function eastmoneySecId(tsCode: string): string {
  const exchange = tsCode.endsWith('.SH') ? '1' : '0'
  return `${exchange}.${tsCode.slice(0, 6)}`
}

function normalizePublicUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function uniqueByUrl(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const result: SearchHit[] = []
  for (const hit of hits) {
    const normalized = normalizePublicUrl(hit.url)
    if (!normalized) continue
    const key = urlKey(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...hit, url: normalized })
  }
  return result
}

function excludedUrlKeys(contextJson: string): Set<string> {
  const context = parseStoredObject(contextJson)
  const values = Array.isArray(context?.excludedUrls) ? context.excludedUrls : []
  return new Set(values.flatMap((value): string[] => {
    if (typeof value !== 'string') return []
    const normalized = normalizePublicUrl(value)
    return normalized ? [urlKey(normalized)] : []
  }).slice(0, 40))
}

function urlKey(value: string): string {
  const url = new URL(value)
  url.hash = ''
  return url.toString().replace(/\/$/, '').toLowerCase()
}

function candidateId(runId: string, url: string): string {
  return `SRC-${sha256(`${runId}\u0000${urlKey(url)}`).slice(0, 16).toUpperCase()}`
}

function normalizePublishedAt(value: string | null | undefined, asOf: string): string | null | 'future' {
  if (!value) return null
  const parsed = Date.parse(value)
  let compact: string | null = null
  if (Number.isFinite(parsed)) compact = beijingDate(parsed)
  if (!compact) compact = compactDate(value)
  if (!compact) return null
  if (compact > asOf) return 'future'
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`
}

function compactDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  if (!match) return null
  const compact = `${match[1]}${match[2]}${match[3]}`
  const date = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const parsed = new Date(date)
  if (
    parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) return null
  return compact
}

function beijingDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

function parseJsonBody(body: Buffer, code: string): Record<string, unknown> {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown
    const object = record(value)
    if (object) return object
  } catch {
    // Mapped below to a stable parsing error.
  }
  throw new ResearchAgentNetworkToolError(code, '联网响应不是有效JSON对象')
}

function parseStoredObject(value: string): Record<string, unknown> | null {
  try { return record(JSON.parse(value) as unknown) } catch { return null }
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maximum) : null
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

function scaledNumber(value: unknown, scale: number): number | null {
  const parsed = finiteNumber(value)
  return parsed == null ? null : parsed / scale
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[\t\r\f\v ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function networkEnvelopeContainsSecret(
  envelopeValue: ResearchAgentNetworkEnvelope,
  secret: string,
): boolean {
  return secret.length > 0 && JSON.stringify(envelopeValue).includes(secret)
}
