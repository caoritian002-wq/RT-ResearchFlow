import type { ResearchAgentTrustedSubject } from './researchAgentToolService'

export const RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION = 'research-evidence-gate.v3'
export const RESEARCH_AGENT_EVIDENCE_GATE_PREVIOUS_RULE_VERSION = 'research-evidence-gate.v2'
export const RESEARCH_AGENT_EVIDENCE_GATE_LEGACY_RULE_VERSION = 'research-evidence-gate.v1'

export type ResearchAgentEvidenceGateRuleVersion =
  | typeof RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION
  | typeof RESEARCH_AGENT_EVIDENCE_GATE_PREVIOUS_RULE_VERSION
  | typeof RESEARCH_AGENT_EVIDENCE_GATE_LEGACY_RULE_VERSION
export type ResearchAgentEvidenceGateDecision = 'local_sufficient' | 'network_required'
export type ResearchAgentEvidenceCategory =
  | 'market_history'
  | 'company_fundamentals'
  | 'company_disclosures'
  | 'current_events'
  | 'industry_evidence'

export interface ResearchAgentEvidenceObservation {
  callId?: string
  toolId: string
  callStatus: string
  envelope: unknown
}

export interface ResearchAgentQualifiedEvidenceDocument {
  callId: string | null
  toolId: string
  title: string
  excerpt: string
  contentSha256: string
  sourceClass: 'official' | 'primary' | 'secondary'
  sourceDomain: string
  sourceIdentity: string
  primary: boolean
  publishedDate: string
  ageDays: number
}

export interface ResearchAgentEvidenceGateCheck {
  category: ResearchAgentEvidenceCategory
  status: 'passed' | 'failed'
  code: string
  message: string
  observedToolIds: string[]
}

export interface ResearchAgentEvidenceGateResult {
  schemaVersion: 1
  ruleVersion: ResearchAgentEvidenceGateRuleVersion
  decision: ResearchAgentEvidenceGateDecision
  maximumOutcome: 'complete' | 'blocked'
  questionProfile: {
    marketOnly: boolean
    timeSensitive: boolean
    intraday: boolean
    asksNews: boolean
    asksFundamentals: boolean
    asksDisclosures: boolean
    asksIndustry: boolean
    offlineRequested: boolean
  }
  checks: ResearchAgentEvidenceGateCheck[]
  requiredNetworkTools: string[]
  summary: string
}

interface EvidenceDocument {
  observation: ResearchAgentEvidenceObservation
  title: string
  excerpt: string
  contentSha256: string
  sourceClass: 'official' | 'primary' | 'secondary'
  sourceDomain: string
  sourceIdentity: string
  primary: boolean
  publishedDate: string
  ageDays: number
}

interface EvidenceAssessmentInput {
  question: string
  asOf: string
  subjects: ResearchAgentTrustedSubject[]
  observations: ResearchAgentEvidenceObservation[]
}

const MARKET_PATTERN = /行情|股价|走势|趋势|均线|涨跌|收益|回撤|波动|成交量|技术面|oh?lcv|price|trend|return|drawdown|volatility|moving\s+average/i
const TIME_SENSITIVE_PATTERN = /最新|近期|当前|今天|今日|刚刚|本周|本月|截至现在|latest|recent|today|current/i
const INTRADAY_PATTERN = /盘中|实时|现在价格|当前价格|此刻|分时|intraday|real[-\s]?time/i
const NEWS_PATTERN = /新闻|消息|事件|舆情|媒体|报道|传闻|突发|news|event|headline/i
const FUNDAMENTAL_PATTERN = /基本面|财务|营收|利润|现金流|负债|估值|市盈率|市净率|roe|毛利率|fundamental|financial|valuation|revenue|profit|cash\s+flow/i
const DISCLOSURE_PATTERN = /公告|披露|年报|季报|半年报|业绩预告|业绩快报|问询函|监管函|公告正文|filing|disclosure|annual\s+report|quarterly/i
const INDUSTRY_PATTERN = /产业|行业|供需|产能|价格传导|政策|监管|市场空间|竞争格局|渗透率|supply|demand|policy|industry/i
const OFFLINE_PATTERN = /仅基于本地|只看本地|仅限本地|离线|不联网|offline|local\s+only/i
const CURRENT_EVENT_STRICT_PATTERN = /今天|今日|刚刚|盘中|实时|本周|today|real[-\s]?time/i
const FORMAL_ISSUER_DOCUMENT_PATTERN = /公告|披露|(?:年度|半年度|季度|审计|专项|工作|可行性分析)报告|预案|募集说明书|招股说明书|上市公告书|问询函|监管函|声明|决议|批复/i
const ISSUER_IDENTITY_PATTERN = /(?:证券|股票|公司)代码\s*[:：]?\s*[0-9a-z]{6,12}|(?:证券|公司)简称\s*[:：]?\s*[\p{Script=Han}a-z0-9*]{2,}/iu
const FORMAL_GOVERNMENT_DOCUMENT_PATTERN = /公告|公示|通知|政策|规划|意见|办法|条例|规定|标准|统计公报|批复|白皮书/i

const NETWORK_DOCUMENT_TOOL_IDS = new Set([
  'web.fetch_page',
  'official.disclosure_document',
  'official.policy_document',
  'official.company_filing',
])
const NETWORK_TOOL_IDS = new Set([
  'web.search',
  'web.fetch_page',
  'official.disclosure_search',
  'official.disclosure_document',
  'company.fundamentals_refresh',
  'market.price_refresh',
  'market.quote_snapshot',
])
const ISSUER_DISCLOSURE_DOMAIN_ROOTS = new Set([
  'bse.cn',
  'cninfo.com.cn',
  'sse.com.cn',
  'szse.cn',
])
const GOVERNMENT_DOMAIN_SUFFIXES = ['.gov.cn']
const MULTIPART_PUBLIC_SUFFIXES = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn'])
const KEYWORD_STOP_WORDS = new Set([
  '分析', '研究', '这个', '这只', '公司', '行业', '产业', '最近', '最新', '近期', '当前', '截至', '情况',
  '什么', '如何', '是否', '以及', '相关', '重要', '发生', '资料', '结论', '事件', '新闻', '消息',
])

export function assessResearchAgentEvidence(input: EvidenceAssessmentInput): ResearchAgentEvidenceGateResult {
  const question = input.question.trim()
  const hasIndustrySubject = input.subjects.some((subject) => subject.kind === 'industry_project')
  const hasStockSubject = input.subjects.some((subject) => subject.kind === 'stock')
  const asksMarket = MARKET_PATTERN.test(question)
  const timeSensitive = TIME_SENSITIVE_PATTERN.test(question)
  const intraday = INTRADAY_PATTERN.test(question)
  const asksNews = NEWS_PATTERN.test(question)
  const asksFundamentals = FUNDAMENTAL_PATTERN.test(question)
  const asksDisclosures = DISCLOSURE_PATTERN.test(question)
  const asksIndustry = hasIndustrySubject || INDUSTRY_PATTERN.test(question)
  const offlineRequested = OFFLINE_PATTERN.test(question)
  const marketOnly = asksMarket && !asksNews && !asksFundamentals && !asksDisclosures && !asksIndustry

  const categories = new Set<ResearchAgentEvidenceCategory>()
  if (marketOnly) {
    categories.add('market_history')
  } else if (asksIndustry) {
    categories.add('industry_evidence')
  } else {
    if (asksMarket) categories.add('market_history')
    if (asksFundamentals) {
      categories.add('company_fundamentals')
      categories.add('company_disclosures')
    }
    if (asksDisclosures) categories.add('company_disclosures')
    if (asksNews || (timeSensitive && !asksMarket && !asksFundamentals && !asksDisclosures)) {
      categories.add('current_events')
    }
    if (hasStockSubject && categories.size === 0) {
      categories.add('company_fundamentals')
      categories.add('company_disclosures')
      categories.add('current_events')
    }
  }

  const checks = [...categories].map((category) => assessCategory(category, input, intraday))
  const failed = checks.filter((item) => item.status === 'failed')
  const decision: ResearchAgentEvidenceGateDecision = failed.length > 0 ? 'network_required' : 'local_sufficient'
  const requiredNetworkTools = [...new Set(failed.flatMap((item) => networkToolsFor(item.category, intraday)))]
  const networkAttempted = input.observations.some((item) => NETWORK_TOOL_IDS.has(item.toolId))
  const summary = decision === 'local_sufficient'
    ? '当前账本满足本问题的最低取证条件。'
    : offlineRequested
      ? `本地证据存在${failed.length}项硬缺口；用户要求离线，当前运行不得生成深度研究综合结论。`
      : networkAttempted
        ? `受控联网取证后仍有${failed.length}项硬缺口，当前运行不得进入模型综合。`
        : `本地证据存在${failed.length}项硬缺口，需要受控工具补齐对应事实、正文、日期、相关性或独立来源。`

  return {
    schemaVersion: 1,
    ruleVersion: RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION,
    decision,
    maximumOutcome: decision === 'local_sufficient' ? 'complete' : 'blocked',
    questionProfile: {
      marketOnly,
      timeSensitive,
      intraday,
      asksNews,
      asksFundamentals,
      asksDisclosures,
      asksIndustry,
      offlineRequested,
    },
    checks,
    requiredNetworkTools,
    summary,
  }
}

export function selectResearchAgentEvidenceDocuments(
  input: EvidenceAssessmentInput,
  categories: readonly ResearchAgentEvidenceCategory[],
): ResearchAgentQualifiedEvidenceDocument[] {
  const documents = evidenceDocuments(input)
  const selected = new Map<string, EvidenceDocument>()
  for (const category of categories) {
    for (const document of minimumEvidenceSet(category, documents, input.question)) {
      selected.set(document.contentSha256, document)
    }
  }
  return [...selected.values()].map((document) => ({
    callId: document.observation.callId ?? null,
    toolId: document.observation.toolId,
    title: document.title,
    excerpt: document.excerpt,
    contentSha256: document.contentSha256,
    sourceClass: document.sourceClass,
    sourceDomain: document.sourceDomain,
    sourceIdentity: document.sourceIdentity,
    primary: document.primary,
    publishedDate: document.publishedDate,
    ageDays: document.ageDays,
  }))
}

export function selectResearchAgentAvailableEvidenceDocuments(
  input: EvidenceAssessmentInput,
): ResearchAgentQualifiedEvidenceDocument[] {
  return evidenceDocuments(input).slice(0, 8).map((document) => ({
    callId: document.observation.callId ?? null,
    toolId: document.observation.toolId,
    title: document.title,
    excerpt: document.excerpt,
    contentSha256: document.contentSha256,
    sourceClass: document.sourceClass,
    sourceDomain: document.sourceDomain,
    sourceIdentity: document.sourceIdentity,
    primary: document.primary,
    publishedDate: document.publishedDate,
    ageDays: document.ageDays,
  }))
}

function assessCategory(
  category: ResearchAgentEvidenceCategory,
  input: EvidenceAssessmentInput,
  intraday: boolean,
): ResearchAgentEvidenceGateCheck {
  const { observations, asOf } = input
  if (category === 'market_history') {
    const observed = observations.filter((item) => [
      'stock.price_history',
      'stock.trend_snapshot',
      'market.price_refresh',
      'market.quote_snapshot',
    ].includes(item.toolId))
    const passed = intraday
      ? observed.some((item) => item.toolId === 'market.quote_snapshot' && usableEnvelope(item))
      : observed.some((item) => usableEnvelope(item) && isMarketFresh(item.envelope, asOf))
    return check(
      category,
      passed,
      passed ? 'MARKET_HISTORY_READY' : intraday ? 'INTRADAY_MARKET_EVIDENCE_REQUIRED' : 'MARKET_HISTORY_MISSING_OR_STALE',
      passed
        ? intraday ? '盘中行情快照可用。' : '本地行情或趋势证据可用，且事实日未超过当前研究截点。'
        : intraday ? '盘中或实时问题需要带时间戳的行情快照；日线收盘数据不能替代。' : '缺少可用且新鲜的本地行情或趋势证据。',
      observed,
    )
  }

  if (category === 'company_fundamentals') {
    const observed = observations.filter((item) => (
      item.toolId === 'stock.fundamentals' || item.toolId === 'company.fundamentals_refresh'
    ))
    const passed = observed.some((item) => usableEnvelope(item))
    return check(
      category,
      passed,
      passed ? 'LOCAL_FUNDAMENTALS_READY' : 'LOCAL_FUNDAMENTALS_MISSING',
      passed
        ? '本地结构化基本面事实可用；重要财务结论仍受正式披露正文约束。'
        : '本地结构化基本面事实缺失或不可用。',
      observed,
    )
  }

  const rawDocuments = observations.filter((item) => (
    NETWORK_DOCUMENT_TOOL_IDS.has(item.toolId)
    && item.callStatus === 'succeeded'
    && hasReadableBody(item.envelope)
  ))
  const documents = evidenceDocuments(input)
  const primaryDocuments = documents.filter((item) => item.primary)

  if (category === 'company_disclosures') {
    const evidenceSet = minimumEvidenceSet(category, documents, input.question)
    const passed = evidenceSet.length === 1
    return check(
      category,
      passed,
      passed ? 'OFFICIAL_DISCLOSURE_READY' : 'OFFICIAL_DISCLOSURE_BODY_REQUIRED',
      passed
        ? '至少一份与研究主体相关、带可验证日期的公司或监管正式披露正文已经固化。'
        : documentGapMessage('公告标题索引不能替代公告正文；需要一份由公司、交易所或监管机构发布且与主体相关的带日期正文。', rawDocuments.length, documents.length, primaryDocuments.length),
      observations.filter((item) => item.toolId === 'stock.announcements' || NETWORK_DOCUMENT_TOOL_IDS.has(item.toolId)),
    )
  }

  if (category === 'current_events') {
    const maximumAge = CURRENT_EVENT_STRICT_PATTERN.test(input.question) ? 7 : 30
    const freshDocuments = documents.filter((item) => item.ageDays <= maximumAge)
    const freshPrimary = freshDocuments.filter((item) => item.primary)
    const evidenceSet = minimumEvidenceSet(category, documents, input.question)
    const passed = evidenceSet.length === 2
    return check(
      category,
      passed,
      passed ? 'CURRENT_EVENT_EVIDENCE_READY' : 'CURRENT_EVENT_BODY_AND_CORROBORATION_REQUIRED',
      passed
        ? `当前事件已有至少两份${maximumAge}日内的独立相关正文，且包含一份可确认发行主体的一级来源。`
        : documentGapMessage(`当前事件需要至少两份${maximumAge}日内、主题相关且非转载重复的独立正文，并包含一份可确认发行主体的一级来源。`, rawDocuments.length, freshDocuments.length, freshPrimary.length),
      observations.filter((item) => item.toolId === 'news.recent_briefings' || NETWORK_DOCUMENT_TOOL_IDS.has(item.toolId)),
    )
  }

  const recentDocuments = documents.filter((item) => item.ageDays <= 1_096)
  const evidenceSet = minimumEvidenceSet(category, documents, input.question)
  const passed = evidenceSet.length === 3
  return check(
    category,
    passed,
    passed ? 'INDUSTRY_EVIDENCE_READY' : 'INDUSTRY_PRIMARY_SAMPLE_REQUIRED',
    passed
      ? '产业结论已有至少三份独立相关正文，其中至少两份为近三年资料，并包含一份可确认发行主体的一级来源。'
      : documentGapMessage(`产业研究需要至少三份独立相关正文、至少两份近三年资料，并包含一份可确认发行主体的一级来源；当前近三年样本${recentDocuments.length}份。`, rawDocuments.length, documents.length, primaryDocuments.length),
    observations.filter((item) => item.toolId === 'industry.project_snapshot' || NETWORK_DOCUMENT_TOOL_IDS.has(item.toolId)),
  )
}

function evidenceDocuments(input: EvidenceAssessmentInput): EvidenceDocument[] {
  const rawDocuments = input.observations.filter((item) => (
    NETWORK_DOCUMENT_TOOL_IDS.has(item.toolId)
    && item.callStatus === 'succeeded'
    && hasReadableBody(item.envelope)
  ))
  return deduplicateDocuments(rawDocuments.flatMap((observation) => {
    const document = readEvidenceDocument(observation, input)
    return document ? [document] : []
  }))
}

function minimumEvidenceSet(
  category: ResearchAgentEvidenceCategory,
  documents: EvidenceDocument[],
  question: string,
): EvidenceDocument[] {
  if (category === 'company_disclosures') {
    const primary = documents.find((document) => document.primary)
    return primary ? [primary] : []
  }
  if (category === 'current_events') {
    const maximumAge = CURRENT_EVENT_STRICT_PATTERN.test(question) ? 7 : 30
    const fresh = documents.filter((document) => document.ageDays <= maximumAge)
    for (let left = 0; left < fresh.length; left += 1) {
      for (let right = left + 1; right < fresh.length; right += 1) {
        const pair = [fresh[left], fresh[right]]
        if (
          pair[0].sourceIdentity !== pair[1].sourceIdentity
          && pair.some((document) => document.primary)
        ) return pair
      }
    }
    return []
  }
  if (category === 'industry_evidence') {
    for (let first = 0; first < documents.length; first += 1) {
      for (let second = first + 1; second < documents.length; second += 1) {
        for (let third = second + 1; third < documents.length; third += 1) {
          const sample = [documents[first], documents[second], documents[third]]
          if (
            new Set(sample.map((document) => document.sourceIdentity)).size === 3
            && sample.filter((document) => document.ageDays <= 1_096).length >= 2
            && sample.some((document) => document.primary)
          ) return sample
        }
      }
    }
  }
  return []
}

function readEvidenceDocument(
  observation: ResearchAgentEvidenceObservation,
  input: { question: string; asOf: string; subjects: ResearchAgentTrustedSubject[] },
): EvidenceDocument | null {
  if (!isRecord(observation.envelope)) return null
  const data = isRecord(observation.envelope.data) ? observation.envelope.data : null
  const document = isRecord(data?.document) ? data.document : null
  if (!document) return null
  const title = typeof document.title === 'string' ? document.title.trim().slice(0, 300) : ''
  const excerpt = typeof document.excerpt === 'string' ? document.excerpt.trim().slice(0, 48_000) : ''
  const contentSha256 = typeof document.contentSha256 === 'string' ? document.contentSha256.toLowerCase() : ''
  const sourceDomain = typeof document.sourceDomain === 'string' ? document.sourceDomain.trim().toLowerCase() : ''
  const sourceClass = document.sourceClass
  const publishedDate = compactPublicationDate(document.publishedAt)
  if (
    excerpt.length < 80
    || !/^[a-f0-9]{64}$/.test(contentSha256)
    || !sourceDomain
    || !['official', 'primary', 'secondary'].includes(String(sourceClass))
    || !publishedDate
    || publishedDate > input.asOf
  ) return null
  const ageDays = dateGapDays(publishedDate, input.asOf)
  if (ageDays == null || ageDays < 0) return null
  if (!documentRelevant(title, excerpt, input.question, input.subjects)) return null
  const typedSourceClass = sourceClass as EvidenceDocument['sourceClass']
  return {
    observation,
    title,
    excerpt,
    contentSha256,
    sourceClass: typedSourceClass,
    sourceDomain,
    sourceIdentity: canonicalSourceIdentity(sourceDomain),
    primary: isConfirmedPrimaryDocument(document, typedSourceClass, sourceDomain, title, excerpt),
    publishedDate,
    ageDays,
  }
}

function isConfirmedPrimaryDocument(
  document: Record<string, unknown>,
  sourceClass: EvidenceDocument['sourceClass'],
  domain: string,
  title: string,
  excerpt: string,
): boolean {
  if (document.primarySourceConfirmed !== true || sourceClass === 'secondary') return false
  const root = canonicalSourceIdentity(domain)
  if (ISSUER_DISCLOSURE_DOMAIN_ROOTS.has(root)) {
    const disclosureHeader = `${title}\n${excerpt.slice(0, 2_000)}`
    return FORMAL_ISSUER_DOCUMENT_PATTERN.test(disclosureHeader)
      && ISSUER_IDENTITY_PATTERN.test(disclosureHeader)
  }
  if (sourceClass === 'primary') return FORMAL_ISSUER_DOCUMENT_PATTERN.test(title)
  if (root === 'gov.cn' || GOVERNMENT_DOMAIN_SUFFIXES.some((suffix) => root.endsWith(suffix))) {
    return FORMAL_GOVERNMENT_DOCUMENT_PATTERN.test(title)
  }
  return false
}

function documentRelevant(
  title: string,
  excerpt: string,
  question: string,
  subjects: ResearchAgentTrustedSubject[],
): boolean {
  const haystack = normalizeComparableText(`${title}\n${excerpt}`)
  for (const subject of subjects) {
    const identities = subject.kind === 'stock'
      ? [subject.tsCode, subject.tsCode.slice(0, 6), subject.label]
      : [subject.label]
    if (identities.some((identity) => typeof identity === 'string'
      && normalizeComparableText(identity).length >= 2
      && haystack.includes(normalizeComparableText(identity)))) return true
  }
  const keywords = extractQuestionKeywords(question)
  return keywords.filter((keyword) => haystack.includes(keyword)).length >= 2
}

function extractQuestionKeywords(question: string): string[] {
  const values: string[] = []
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  for (const part of segmenter.segment(question)) {
    if (!part.isWordLike) continue
    const word = normalizeComparableText(part.segment)
    if (word.length >= 2 && !KEYWORD_STOP_WORDS.has(word)) values.push(word)
  }
  return [...new Set(values)].slice(0, 20)
}

function deduplicateDocuments(documents: EvidenceDocument[]): EvidenceDocument[] {
  const sorted = [...documents].sort((left, right) => Number(right.primary) - Number(left.primary)
    || left.ageDays - right.ageDays
    || left.sourceIdentity.localeCompare(right.sourceIdentity))
  const unique: EvidenceDocument[] = []
  for (const document of sorted) {
    const duplicate = unique.some((existing) => (
      existing.contentSha256 === document.contentSha256
      || sameNormalizedTitle(existing.title, document.title)
      || nearDuplicateText(existing.excerpt, document.excerpt)
    ))
    if (!duplicate) unique.push(document)
  }
  return unique
}

function sameNormalizedTitle(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableText(left)
  const normalizedRight = normalizeComparableText(right)
  return normalizedLeft.length >= 8 && normalizedLeft === normalizedRight
}

function nearDuplicateText(left: string, right: string): boolean {
  const leftShingles = textShingles(left)
  const rightShingles = textShingles(right)
  if (leftShingles.size < 10 || rightShingles.size < 10) return false
  let intersection = 0
  for (const value of leftShingles) if (rightShingles.has(value)) intersection += 1
  const union = leftShingles.size + rightShingles.size - intersection
  return union > 0 && intersection / union >= 0.82
}

function textShingles(value: string): Set<string> {
  const normalized = normalizeComparableText(value).slice(0, 8_000)
  const shingles = new Set<string>()
  for (let index = 0; index <= normalized.length - 8; index += 1) {
    shingles.add(normalized.slice(index, index + 8))
  }
  return shingles
}

function canonicalSourceIdentity(value: string): string {
  const domain = value.toLowerCase().replace(/^www\d*\./, '').replace(/\.$/, '')
  const labels = domain.split('.').filter(Boolean)
  if (labels.length <= 2) return domain
  const suffix = labels.slice(-2).join('.')
  return MULTIPART_PUBLIC_SUFFIXES.has(suffix) ? labels.slice(-3).join('.') : labels.slice(-2).join('.')
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
}

function compactPublicationDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  if (!match) return null
  const compact = `${match[1]}${match[2]}${match[3]}`
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const date = new Date(timestamp)
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3])
    ? compact
    : null
}

function documentGapMessage(base: string, readable: number, qualified: number, primary: number): string {
  return `${base} 当前抓取正文${readable}份，日期、主题和去重后有效${qualified}份，可确认一级来源${primary}份。`
}

function check(
  category: ResearchAgentEvidenceCategory,
  passed: boolean,
  code: string,
  message: string,
  observations: ResearchAgentEvidenceObservation[],
): ResearchAgentEvidenceGateCheck {
  return {
    category,
    status: passed ? 'passed' : 'failed',
    code,
    message,
    observedToolIds: [...new Set(observations.map((item) => item.toolId))].slice(0, 12),
  }
}

function usableEnvelope(observation: ResearchAgentEvidenceObservation): boolean {
  if (observation.callStatus !== 'succeeded' || !isRecord(observation.envelope)) return false
  if (observation.envelope.status !== 'ready' && observation.envelope.status !== 'partial') return false
  const coverage = observation.envelope.coverage
  return isRecord(coverage)
    && typeof coverage.available === 'number'
    && Number.isFinite(coverage.available)
    && coverage.available > 0
}

function isMarketFresh(envelope: unknown, asOf: string): boolean {
  if (!isRecord(envelope) || !Array.isArray(envelope.sources)) return false
  const factDates = envelope.sources.flatMap((source) => (
    isRecord(source) && typeof source.factDate === 'string' ? [source.factDate.replace(/-/g, '')] : []
  )).filter((value) => /^\d{8}$/.test(value))
  if (factDates.length === 0) return false
  const latest = factDates.sort().at(-1)!
  const gap = dateGapDays(latest, asOf)
  return gap != null && gap >= 0 && gap <= 10
}

function hasReadableBody(envelope: unknown): boolean {
  if (!isRecord(envelope)) return false
  const data = isRecord(envelope.data) ? envelope.data : null
  const document = isRecord(data?.document) ? data.document : null
  return typeof document?.excerpt === 'string'
    && document.excerpt.trim().length >= 80
    && typeof document.contentSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(document.contentSha256)
    && typeof document.finalUrl === 'string'
    && /^https?:\/\//i.test(document.finalUrl)
    && typeof document.fetchedAt === 'number'
    && Number.isFinite(document.fetchedAt)
}

function networkToolsFor(category: ResearchAgentEvidenceCategory, intraday: boolean): string[] {
  if (category === 'market_history') return intraday ? ['market.quote_snapshot'] : ['market.price_refresh']
  if (category === 'company_fundamentals') return ['company.fundamentals_refresh', 'official.disclosure_document']
  if (category === 'company_disclosures') return ['official.disclosure_search', 'official.disclosure_document']
  return ['web.search', 'web.fetch_page']
}

function dateGapDays(factDate: string, asOf: string): number | null {
  if (!/^\d{8}$/.test(factDate) || !/^\d{8}$/.test(asOf)) return null
  const date = Date.UTC(Number(factDate.slice(0, 4)), Number(factDate.slice(4, 6)) - 1, Number(factDate.slice(6, 8)))
  const cutoff = Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(4, 6)) - 1, Number(asOf.slice(6, 8)))
  if (!Number.isFinite(date) || !Number.isFinite(cutoff)) return null
  return Math.floor((cutoff - date) / 86_400_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
