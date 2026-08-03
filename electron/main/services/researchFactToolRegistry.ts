import type Database from 'better-sqlite3'
import { queryDailyClose } from '../database/dailyCloseCacheRepository'
import {
  DecisionJudgmentRepositoryError,
  getDecisionJudgmentHistoryAt,
} from '../database/decisionJudgmentRepository'
import {
  getLatestResearchSnapshot,
  getLatestResearchSnapshotAt,
} from '../database/industryResearchChangeRepository'
import { listPortfolioStocks } from '../database/portfolioRepository'
import { getCachedPrices, getStockInfo } from '../database/stockPriceCacheRepository'
import type {
  BriefingRow,
  ImpactRating,
  PortfolioStockRow,
} from '../database/types'
import {
  getStockFundamentalSnapshot,
  type StockFundamentalAnnouncement,
  type StockFundamentalSnapshot,
} from './stockFundamentalService'
import {
  classifyTrendState,
  computeTrendScoreV2,
  computeWindowReturn,
  type TrendScoreComputation,
  type TrendState,
} from './trendScoreModel'

export type ResearchFactToolStatus = 'ready' | 'partial' | 'missing' | 'blocked'
export type ResearchFactSourceStatus = 'ready' | 'missing' | 'failed'

export const RESEARCH_FACT_TOOL_REGISTRY_VERSION = 'research-facts.v1'

export interface ResearchFactSource {
  id: string
  status: ResearchFactSourceStatus
  factDate: string | null
}

export interface ResearchFactCoverage {
  available: number
  required: number | null
  unit: string
}

export interface ResearchFactToolEnvelope<TToolId extends string, TData> {
  schemaVersion: 1
  toolId: TToolId
  status: ResearchFactToolStatus
  generatedAt: number
  asOf: string | null
  sources: ResearchFactSource[]
  coverage: ResearchFactCoverage
  warnings: string[]
  data: TData
}

export interface StockPriceHistoryInput {
  stockCode: string
  asOf?: string | null
  limit?: number
  minBars?: number
}

export interface StockTrendSnapshotInput {
  stockCode: string
  asOf?: string | null
}

export interface StockFundamentalsInput {
  stockCode: string
  asOf?: string | null
  financialLimit?: number
}

export interface StockAnnouncementsInput {
  stockCode: string
  asOf?: string | null
  limit?: number
  attentionOnly?: boolean
}

export interface PortfolioHoldingsInput {
  limit?: number
}

export interface RecentBriefingsInput {
  asOf?: string | null
  limit?: number
  impactRating?: ImpactRating | null
  query?: string | null
}

export interface DecisionJudgmentHistoryInput {
  judgmentId: string
  asOf?: string | null
  limit?: number
}

export interface IndustryProjectSnapshotInput {
  projectId: string
  asOf?: string | null
}

export interface ResearchPriceBar {
  tradeDate: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  turnoverRate: number | null
}

export interface StockPriceHistoryData {
  stockCode: string | null
  tsCode: string | null
  stockName: string | null
  bars: ResearchPriceBar[]
}

export interface StockTrendSnapshotData {
  stockCode: string | null
  tsCode: string | null
  stockName: string | null
  tradeDate: string | null
  bars: number
  requiredBars: number
  totalScore: number | null
  validWeight: number
  trendState: TrendState
  dimensions: TrendScoreComputation['dimensions'] | null
  facts: TrendScoreComputation['facts'] | null
  benchmark: {
    tsCode: '000300.SH'
    tradeDate: string | null
    bars: number
    status: ResearchFactToolStatus
  }
}

export interface StockFundamentalsData {
  stockCode: string | null
  tsCode: string | null
  profile: StockFundamentalSnapshot['profile']
  latestFinancial: StockFundamentalSnapshot['latestFinancial']
  financialHistory: StockFundamentalSnapshot['financialHistory']
  diagnostics: Pick<StockFundamentalSnapshot['sources'], 'profile' | 'financial'> | null
}

export interface StockAnnouncementsData {
  stockCode: string | null
  tsCode: string | null
  announcements: StockFundamentalAnnouncement[]
  diagnostics: StockFundamentalSnapshot['sources']['announcement'] | null
}

export interface PortfolioHoldingsData {
  snapshotKind: 'current-only'
  holdings: PortfolioStockRow[]
}

export interface RecentBriefingItem {
  id: number
  sourceId: number
  sourceName: string
  title: string
  summary: string
  originalUrl: string
  publishedAt: number
  publishedDateBJ: string
  publicationTimeStatus: BriefingRow['publicationTimeStatus']
  impactRating: ImpactRating
}

export interface RecentBriefingsData {
  items: RecentBriefingItem[]
}

export interface DecisionJudgmentHistoryEvidence {
  key: string
  label: string
  status: 'ready' | 'missing' | 'blocked'
  detail: string
}

export interface DecisionJudgmentHistoryVersionData {
  id: string
  versionNumber: number
  tag: 'watch' | 'risk_off' | 'noise' | 'insufficient' | 'done'
  note: string
  reviewDueAt: number | null
  createdAt: number
  sourceSignalId: number | null
  sourceSignalAvailable: boolean
  relatedSignalCount: number
  primaryTitle: string
  primarySummary: string
  trustHint: string
  evidenceCount: number
  evidence: DecisionJudgmentHistoryEvidence[]
}

export interface DecisionJudgmentHistoryData {
  judgmentId: string | null
  judgmentGroupId: string | null
  tsCode: string | null
  stockName: string | null
  totalVersionsAtCutoff: number
  versions: DecisionJudgmentHistoryVersionData[]
}

export interface IndustryProjectSnapshotData {
  projectId: string | null
  snapshot: {
    id: string
    previousSnapshotId: string | null
    reason: string
    title: string
    schemaVersion: number
    createdAt: number
  } | null
  project: {
    title: string
    industryName: string
    productScope: string
    regionScope: string
    timeScope: string
    purpose: string
    depth: string
    status: string
    dataAsOf: string | null
    valuationDate: string | null
    nextReviewAt: number | null
    stopCondition: string | null
  } | null
  graph: {
    nodeCount: number
    edgeCount: number
    nodes: Array<{
      id: string
      type: string
      name: string
      stage: string | null
      statementKind: string
      status: string | null
      lastUpdated: string | null
    }>
    edges: Array<{
      sourceNodeId: string
      targetNodeId: string
      relation: string
      statementKind: string
      bottleneck: boolean
    }>
  }
  evidenceRefs: Array<{
    id: string
    title: string
    statementKind: string
    sourceUrl: string | null
    primarySourceConfirmed: boolean
  }>
  evidenceRefCount: number
  hypotheses: Array<{
    id: string
    statement: string
    importance: number | null
    status: string
    cheapestDisproof: string
    verificationMetric: string | null
    threshold: string | null
    dueAt: number | null
  }>
  hypothesisCount: number
  companies: Array<{
    companyId: string
    status: string
    exclusionReason: string | null
  }>
  companyCount: number
  followUps: Array<{
    type: string
    id: string
    dueAt: number
  }>
  followUpCount: number
}

export interface ResearchFactToolInputMap {
  'stock.price_history': StockPriceHistoryInput
  'stock.trend_snapshot': StockTrendSnapshotInput
  'stock.fundamentals': StockFundamentalsInput
  'stock.announcements': StockAnnouncementsInput
  'portfolio.holdings': PortfolioHoldingsInput
  'news.recent_briefings': RecentBriefingsInput
  'decision.judgment_history': DecisionJudgmentHistoryInput
  'industry.project_snapshot': IndustryProjectSnapshotInput
}

export interface ResearchFactToolDataMap {
  'stock.price_history': StockPriceHistoryData
  'stock.trend_snapshot': StockTrendSnapshotData
  'stock.fundamentals': StockFundamentalsData
  'stock.announcements': StockAnnouncementsData
  'portfolio.holdings': PortfolioHoldingsData
  'news.recent_briefings': RecentBriefingsData
  'decision.judgment_history': DecisionJudgmentHistoryData
  'industry.project_snapshot': IndustryProjectSnapshotData
}

export type ResearchFactToolId = keyof ResearchFactToolInputMap
export type ResearchFactToolScope = 'market.read' | 'research.read' | 'portfolio.read'
export type AnyResearchFactToolEnvelope = {
  [K in ResearchFactToolId]: ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]>
}[ResearchFactToolId]

export interface ResearchFactToolDefinition<TToolId extends ResearchFactToolId = ResearchFactToolId> {
  id: TToolId
  externalName: string
  description: string
  scope: ResearchFactToolScope
  asOf: 'supported' | 'current-only'
  maxItems: number
  inputSchema: {
    type: 'object'
    additionalProperties: false
    properties: Record<string, Record<string, unknown>>
    required?: readonly string[]
  }
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required?: readonly string[],
): ResearchFactToolDefinition['inputSchema'] {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  }
}

function stockCodeSchema(): Record<string, unknown> {
  return {
    type: 'string',
    pattern: '^\\d{6}(?:\\.(?:SH|SZ|BJ))?$',
    description: '六位A股代码或规范ts_code',
  }
}

function asOfSchema(): Record<string, unknown> {
  return {
    type: ['string', 'null'],
    pattern: '^\\d{4}-?\\d{2}-?\\d{2}$',
    description: '北京时间事实日上界，YYYYMMDD或YYYY-MM-DD',
  }
}

function integerSchema(minimum: number, maximum: number): Record<string, unknown> {
  return { type: 'integer', minimum, maximum }
}

function entityIdSchema(): Record<string, unknown> {
  return { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' }
}

function uuidSchema(): Record<string, unknown> {
  return {
    type: 'string',
    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
  }
}

export const RESEARCH_FACT_TOOL_DEFINITIONS = [
  {
    id: 'stock.price_history',
    externalName: 'stock_price_history',
    description: '读取本地个股日线OHLCV；支持事实日截点，不联网刷新。',
    scope: 'market.read',
    asOf: 'supported',
    maxItems: 120,
    inputSchema: objectSchema({
      stockCode: stockCodeSchema(), asOf: asOfSchema(),
      limit: integerSchema(1, 120), minBars: integerSchema(1, 60),
    }, ['stockCode']),
  },
  {
    id: 'stock.trend_snapshot',
    externalName: 'stock_trend_snapshot',
    description: '读取本地确定性趋势评分、维度事实与沪深300基准覆盖。',
    scope: 'market.read',
    asOf: 'supported',
    maxItems: 1,
    inputSchema: objectSchema({ stockCode: stockCodeSchema(), asOf: asOfSchema() }, ['stockCode']),
  },
  {
    id: 'stock.fundamentals',
    externalName: 'stock_fundamentals',
    description: '读取本地公司概况与版本化核心财务事实；未知值保持空。',
    scope: 'market.read',
    asOf: 'supported',
    maxItems: 8,
    inputSchema: objectSchema({
      stockCode: stockCodeSchema(), asOf: asOfSchema(), financialLimit: integerSchema(1, 8),
    }, ['stockCode']),
  },
  {
    id: 'stock.announcements',
    externalName: 'stock_announcements',
    description: '读取本地公告标题索引与确定性重点事项线索，不包含公告正文。',
    scope: 'market.read',
    asOf: 'supported',
    maxItems: 20,
    inputSchema: objectSchema({
      stockCode: stockCodeSchema(), asOf: asOfSchema(), limit: integerSchema(1, 20),
      attentionOnly: { type: 'boolean' },
    }, ['stockCode']),
  },
  {
    id: 'portfolio.holdings',
    externalName: 'portfolio_holdings',
    description: '读取当前本地持仓快照；这是敏感数据，不支持历史截点。',
    scope: 'portfolio.read',
    asOf: 'current-only',
    maxItems: 100,
    inputSchema: objectSchema({ limit: integerSchema(1, 100) }),
  },
  {
    id: 'news.recent_briefings',
    externalName: 'news_recent_briefings',
    description: '读取本地资讯简报索引；支持影响等级、搜索和事实日截点。',
    scope: 'market.read',
    asOf: 'supported',
    maxItems: 20,
    inputSchema: objectSchema({
      asOf: asOfSchema(), limit: integerSchema(1, 20),
      impactRating: { type: ['string', 'null'], enum: ['CRITICAL', 'IMPORTANT', 'GENERAL', null] },
      query: { type: ['string', 'null'], maxLength: 80 },
    }),
  },
  {
    id: 'decision.judgment_history',
    externalName: 'decision_judgment_history',
    description: '读取本地决策判断不可变版本历史；主体标识属于个人研究数据。',
    scope: 'research.read',
    asOf: 'supported',
    maxItems: 20,
    inputSchema: objectSchema({
      judgmentId: entityIdSchema(), asOf: asOfSchema(), limit: integerSchema(1, 20),
    }, ['judgmentId']),
  },
  {
    id: 'industry.project_snapshot',
    externalName: 'industry_project_snapshot',
    description: '读取本地产研项目最近不可变快照的有界摘要。',
    scope: 'research.read',
    asOf: 'supported',
    maxItems: 61,
    inputSchema: objectSchema({ projectId: uuidSchema(), asOf: asOfSchema() }, ['projectId']),
  },
] as const satisfies readonly ResearchFactToolDefinition[]

interface ExecutionOptions {
  now?: number
  maxCreatedAt?: number | null
}

interface NormalizedStockCode {
  stockCode: string
  tsCode: string
}

interface RuntimeBlockedEnvelope extends ResearchFactToolEnvelope<string, null> {
  status: 'blocked'
}

const TOOL_IDS = new Set<string>(RESEARCH_FACT_TOOL_DEFINITIONS.map((definition) => definition.id))
const IMPACT_RATINGS = new Set<ImpactRating>(['CRITICAL', 'IMPORTANT', 'GENERAL'])

export function listResearchFactTools(): readonly ResearchFactToolDefinition[] {
  return RESEARCH_FACT_TOOL_DEFINITIONS
}

export function executeResearchFactTool<K extends ResearchFactToolId>(
  db: Database.Database,
  toolId: K,
  input: ResearchFactToolInputMap[K],
  options: ExecutionOptions = {},
): ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]> {
  const result = executeResearchFactToolUnsafe(db, toolId, input, options)
  return result as ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]>
}

export function executeResearchFactToolUnsafe(
  db: Database.Database,
  toolId: string,
  input: unknown,
  options: ExecutionOptions = {},
): AnyResearchFactToolEnvelope | RuntimeBlockedEnvelope {
  const now = options.now ?? Date.now()
  if (!TOOL_IDS.has(toolId)) {
    return blockedRuntime(toolId, now, 'UNKNOWN_TOOL', '未知投研事实工具')
  }
  if (!isRecord(input)) {
    return blockedRuntime(toolId, now, 'INVALID_INPUT', '工具输入必须是对象')
  }
  switch (toolId as ResearchFactToolId) {
    case 'stock.price_history':
      return executePriceHistory(db, input, now)
    case 'stock.trend_snapshot':
      return executeTrendSnapshot(db, input, now)
    case 'stock.fundamentals':
      return executeFundamentals(db, input, now)
    case 'stock.announcements':
      return executeAnnouncements(db, input, now)
    case 'portfolio.holdings':
      return executePortfolioHoldings(db, input, now)
    case 'news.recent_briefings':
      return executeRecentBriefings(db, input, now)
    case 'decision.judgment_history':
      return executeDecisionJudgmentHistory(db, input, now, options.maxCreatedAt)
    case 'industry.project_snapshot':
      return executeIndustryProjectSnapshot(db, input, now)
  }
}

function executePriceHistory(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
): ResearchFactToolEnvelope<'stock.price_history', StockPriceHistoryData> {
  const empty = emptyPriceData()
  const normalized = normalizeStockCode(input.stockCode)
  const asOf = normalizeAsOf(input.asOf)
  const limit = boundedInteger(input.limit, 30, 1, 120)
  const minBars = boundedInteger(input.minBars, 10, 1, 60)
  const inputError = validateExactKeys(input, ['stockCode', 'asOf', 'limit', 'minBars'])
    ?? (!normalized ? 'stockCode必须是六位A股代码或规范ts_code' : null)
    ?? (input.asOf != null && !asOf ? 'asOf必须是YYYYMMDD' : null)
    ?? (limit == null ? 'limit必须是1至120的整数' : null)
    ?? (minBars == null ? 'minBars必须是1至60的整数' : null)
    ?? (limit != null && minBars != null && minBars > limit ? 'minBars不得大于limit' : null)
  if (inputError || !normalized || limit == null || minBars == null) {
    return blocked('stock.price_history', now, asOf, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }

  const loaded = loadPriceBars(db, normalized, asOf)
  const bars = loaded.bars.slice(-limit)
  const status: ResearchFactToolStatus = bars.length >= minBars
    ? 'ready'
    : bars.length > 0
      ? 'partial'
      : 'missing'
  const warnings = bars.length >= minBars
    ? []
    : [`有效OHLC仅${bars.length}根，少于要求的${minBars}根`]
  return envelope('stock.price_history', status, now, asOf, loaded.sources, {
    available: bars.length,
    required: minBars,
    unit: 'bars',
  }, warnings, {
    stockCode: normalized.stockCode,
    tsCode: normalized.tsCode,
    stockName: getStockInfo(db, normalized.stockCode)?.stockName?.trim() || null,
    bars,
  })
}

function executeTrendSnapshot(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
): ResearchFactToolEnvelope<'stock.trend_snapshot', StockTrendSnapshotData> {
  const empty = emptyTrendData()
  const normalized = normalizeStockCode(input.stockCode)
  const asOf = normalizeAsOf(input.asOf)
  const inputError = validateExactKeys(input, ['stockCode', 'asOf'])
    ?? (!normalized ? 'stockCode必须是六位A股代码或规范ts_code' : null)
    ?? (input.asOf != null && !asOf ? 'asOf必须是YYYYMMDD' : null)
  if (inputError || !normalized) {
    return blocked('stock.trend_snapshot', now, asOf, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }

  const stock = loadPriceBars(db, normalized, asOf)
  const benchmarkCode = { stockCode: '000300', tsCode: '000300.SH' }
  const benchmark = loadPriceBars(db, benchmarkCode, asOf)
  const stockBars = stock.bars.slice(-120)
  const benchmarkBars = benchmark.bars.slice(-120)
  const benchmarkReturn = computeWindowReturn(benchmarkBars.map((bar) => bar.close), 20)
  const computation = computeTrendScoreV2(stockBars.map((bar) => ({
    close: bar.close,
    high: bar.high,
    low: bar.low,
    vol: bar.volume,
    turnoverRate: bar.turnoverRate,
  })), benchmarkReturn)
  const tradeDate = stockBars.at(-1)?.tradeDate ?? null
  const benchmarkTradeDate = benchmarkBars.at(-1)?.tradeDate ?? null
  const benchmarkStatus: ResearchFactToolStatus = benchmarkBars.length >= 21 ? 'ready' : 'missing'
  const enoughBars = stockBars.length >= 60
  const status: ResearchFactToolStatus = stockBars.length < 20
    ? 'missing'
    : enoughBars && benchmarkStatus === 'ready' && computation.score.totalScore != null
      ? 'ready'
      : 'partial'
  const warnings: string[] = []
  if (stockBars.length < 60) warnings.push(`个股日线仅${stockBars.length}根，完整趋势要求60根`)
  if (benchmarkStatus !== 'ready') warnings.push('沪深300少于21根，20日相对事实不可用')
  if (computation.score.totalScore == null && stockBars.length >= 20) {
    warnings.push(`有效评分权重${Math.round(computation.validWeight * 100)}%，未形成综合分`)
  }
  return envelope('stock.trend_snapshot', status, now, asOf, [
    ...stock.sources,
    {
      id: 'local.hs300_price_history',
      status: benchmarkStatus === 'ready' ? 'ready' : 'missing',
      factDate: benchmarkTradeDate,
    },
  ], {
    available: stockBars.length,
    required: 60,
    unit: 'bars',
  }, warnings, {
    stockCode: normalized.stockCode,
    tsCode: normalized.tsCode,
    stockName: getStockInfo(db, normalized.stockCode)?.stockName?.trim() || null,
    tradeDate,
    bars: stockBars.length,
    requiredBars: 60,
    totalScore: computation.score.totalScore,
    validWeight: computation.validWeight,
    trendState: classifyTrendState(
      computation.score.totalScore,
      computation.score.maAbove60 == null ? null : computation.score.maAbove60 === 1,
      null,
    ),
    dimensions: stockBars.length >= 20 ? computation.dimensions : null,
    facts: stockBars.length >= 20 ? computation.facts : null,
    benchmark: {
      tsCode: '000300.SH',
      tradeDate: benchmarkTradeDate,
      bars: benchmarkBars.length,
      status: benchmarkStatus,
    },
  })
}

function executeFundamentals(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
): ResearchFactToolEnvelope<'stock.fundamentals', StockFundamentalsData> {
  const empty = emptyFundamentalsData()
  const normalized = normalizeStockCode(input.stockCode)
  const asOf = normalizeAsOf(input.asOf)
  const limit = boundedInteger(input.financialLimit, 4, 1, 8)
  const inputError = validateExactKeys(input, ['stockCode', 'asOf', 'financialLimit'])
    ?? (!normalized ? 'stockCode必须是六位A股代码或规范ts_code' : null)
    ?? (input.asOf != null && !asOf ? 'asOf必须是YYYYMMDD' : null)
    ?? (limit == null ? 'financialLimit必须是1至8的整数' : null)
  if (inputError || !normalized || limit == null) {
    return blocked('stock.fundamentals', now, asOf, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }
  const result = getStockFundamentalSnapshot(db, normalized.tsCode)
  if (!result.ok) {
    return blocked('stock.fundamentals', now, asOf, empty, result.code, result.message)
  }
  const snapshot = result.snapshot
  const profile = asOf == null ? snapshot.profile : null
  const financialHistory = snapshot.financialHistory
    .filter((row) => asOf == null || (row.noticeDate ?? row.reportDate) <= asOf)
    .slice(0, limit)
  const latestFinancial = financialHistory[0] ?? null
  const profileSource = sourceFromFundamentalState(
    'eastmoney.company_profile',
    snapshot.sources.profile,
    profile != null,
    profile?.sourceFactDate ?? null,
  )
  const financialSource = sourceFromFundamentalState(
    'eastmoney.main_finance',
    snapshot.sources.financial,
    latestFinancial != null,
    latestFinancial?.noticeDate ?? latestFinancial?.reportDate ?? null,
  )
  const available = Number(profile != null) + Number(latestFinancial != null)
  const hasFailedSource = snapshot.sources.profile.status === 'failed'
    || snapshot.sources.financial.status === 'failed'
  const status: ResearchFactToolStatus = available === 0
    ? 'missing'
    : available === 2 && !hasFailedSource
      ? 'ready'
      : 'partial'
  const warnings: string[] = []
  if (asOf != null && snapshot.profile != null) warnings.push('公司概况未保存历史版本，本次截点查询不返回当前概况')
  appendSourceFailureWarning(warnings, '公司概况', snapshot.sources.profile)
  appendSourceFailureWarning(warnings, '主要财务', snapshot.sources.financial)
  if (!latestFinancial) warnings.push('截点内没有可用核心财务事实')
  return envelope('stock.fundamentals', status, now, asOf, [profileSource, financialSource], {
    available,
    required: 2,
    unit: 'datasets',
  }, warnings, {
    stockCode: normalized.stockCode,
    tsCode: normalized.tsCode,
    profile,
    latestFinancial,
    financialHistory,
    diagnostics: {
      profile: snapshot.sources.profile,
      financial: snapshot.sources.financial,
    },
  })
}

function executeAnnouncements(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
): ResearchFactToolEnvelope<'stock.announcements', StockAnnouncementsData> {
  const empty = emptyAnnouncementsData()
  const normalized = normalizeStockCode(input.stockCode)
  const asOf = normalizeAsOf(input.asOf)
  const limit = boundedInteger(input.limit, 5, 1, 20)
  const attentionOnly = input.attentionOnly == null ? false : input.attentionOnly
  const inputError = validateExactKeys(input, ['stockCode', 'asOf', 'limit', 'attentionOnly'])
    ?? (!normalized ? 'stockCode必须是六位A股代码或规范ts_code' : null)
    ?? (input.asOf != null && !asOf ? 'asOf必须是YYYYMMDD' : null)
    ?? (limit == null ? 'limit必须是1至20的整数' : null)
    ?? (typeof attentionOnly !== 'boolean' ? 'attentionOnly必须是布尔值' : null)
  if (inputError || !normalized || limit == null || typeof attentionOnly !== 'boolean') {
    return blocked('stock.announcements', now, asOf, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }
  const result = getStockFundamentalSnapshot(db, normalized.tsCode)
  if (!result.ok) {
    return blocked('stock.announcements', now, asOf, empty, result.code, result.message)
  }
  const snapshot = result.snapshot
  const announcements = snapshot.announcements
    .filter((row) => asOf == null || row.noticeDate <= asOf)
    .filter((row) => !attentionOnly || row.attentionTags.length > 0)
    .slice(0, limit)
  const checked = snapshot.sources.announcement.status === 'available'
  const source = sourceFromFundamentalState(
    'eastmoney.announcement_index',
    snapshot.sources.announcement,
    checked || announcements.length > 0,
    announcements[0]?.noticeDate ?? (asOf == null ? snapshot.sources.announcement.factDate : null),
  )
  const status: ResearchFactToolStatus = announcements.length > 0
    ? snapshot.sources.announcement.status === 'failed' ? 'partial' : 'ready'
    : checked ? 'ready' : 'missing'
  const warnings: string[] = []
  appendSourceFailureWarning(warnings, '公告索引', snapshot.sources.announcement)
  if (checked && announcements.length === 0) warnings.push('来源已检查，当前筛选范围内没有公告标题索引')
  if (!checked && announcements.length === 0) warnings.push('本地尚无公告索引')
  return envelope('stock.announcements', status, now, asOf, [source], {
    available: announcements.length,
    required: null,
    unit: 'announcements',
  }, warnings, {
    stockCode: normalized.stockCode,
    tsCode: normalized.tsCode,
    announcements,
    diagnostics: snapshot.sources.announcement,
  })
}

function executePortfolioHoldings(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
): ResearchFactToolEnvelope<'portfolio.holdings', PortfolioHoldingsData> {
  const limit = boundedInteger(input.limit, 100, 1, 100)
  const inputError = validateExactKeys(input, ['limit'])
    ?? (limit == null ? 'limit必须是1至100的整数' : null)
  const empty: PortfolioHoldingsData = { snapshotKind: 'current-only', holdings: [] }
  if (inputError || limit == null) {
    return blocked('portfolio.holdings', now, null, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }
  const holdings = listPortfolioStocks(db).slice(0, limit)
  return envelope('portfolio.holdings', 'ready', now, null, [{
    id: 'local.portfolio_stocks',
    status: 'ready',
    factDate: null,
  }], {
    available: holdings.length,
    required: null,
    unit: 'holdings',
  }, holdings.length === 0 ? ['当前持仓为空；该工具不支持历史持仓还原'] : ['仅代表当前持仓，不支持历史持仓还原'], {
    snapshotKind: 'current-only',
    holdings,
  })
}

function executeRecentBriefings(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
): ResearchFactToolEnvelope<'news.recent_briefings', RecentBriefingsData> {
  const asOf = normalizeAsOf(input.asOf)
  const limit = boundedInteger(input.limit, 10, 1, 20)
  const impactRating = input.impactRating == null ? null : input.impactRating
  const query = normalizeQuery(input.query)
  const inputError = validateExactKeys(input, ['asOf', 'limit', 'impactRating', 'query'])
    ?? (input.asOf != null && !asOf ? 'asOf必须是YYYYMMDD' : null)
    ?? (limit == null ? 'limit必须是1至20的整数' : null)
    ?? (impactRating != null && (typeof impactRating !== 'string' || !IMPACT_RATINGS.has(impactRating as ImpactRating))
      ? 'impactRating无效'
      : null)
    ?? (input.query != null && query == null ? 'query必须是1至80个字符的普通文本' : null)
  const empty: RecentBriefingsData = { items: [] }
  if (inputError || limit == null) {
    return blocked('news.recent_briefings', now, asOf, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }

  const conditions: string[] = []
  const params: Array<string | number> = []
  if (asOf) {
    conditions.push('publishedDateBJ <= ?')
    params.push(toDashedDate(asOf))
  }
  if (impactRating) {
    conditions.push('impactRating = ?')
    params.push(impactRating as ImpactRating)
  }
  if (query) {
    conditions.push('(title LIKE ? ESCAPE \'\\\' OR summary LIKE ? ESCAPE \'\\\')')
    const pattern = `%${escapeLike(query)}%`
    params.push(pattern, pattern)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT id, sourceId, sourceName, originalUrl, title, summary, fullContent,
      publishedAt, publishedDateBJ, publicationTimeStatus, collectedAt,
      impactRating, impactRatingScore, deduplicationHash, titleSimhash,
      isRead, readAt, scanRunId, isCatchUp
    FROM briefings
    ${where}
    ORDER BY publishedAt DESC, id DESC
    LIMIT ?
  `).all(...params, limit) as BriefingRow[]
  const items = rows.map((row): RecentBriefingItem => ({
    id: row.id,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    title: row.title.slice(0, 300),
    summary: row.summary.slice(0, 800),
    originalUrl: row.originalUrl,
    publishedAt: row.publishedAt,
    publishedDateBJ: row.publishedDateBJ,
    publicationTimeStatus: row.publicationTimeStatus,
    impactRating: row.impactRating,
  }))
  return envelope('news.recent_briefings', 'ready', now, asOf, [{
    id: 'local.briefings',
    status: 'ready',
    factDate: items[0]?.publishedDateBJ.replace(/-/g, '') ?? null,
  }], {
    available: items.length,
    required: null,
    unit: 'briefings',
  }, items.length === 0 ? ['当前筛选范围内没有本地资讯'] : [], { items })
}

function executeDecisionJudgmentHistory(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
  trustedMaxCreatedAt?: number | null,
): ResearchFactToolEnvelope<'decision.judgment_history', DecisionJudgmentHistoryData> {
  const asOf = normalizeAsOf(input.asOf)
  const limit = boundedInteger(input.limit, 10, 1, 20)
  const judgmentId = normalizeUuid(input.judgmentId)
  const empty = emptyDecisionJudgmentHistoryData(judgmentId)
  const inputError = validateExactKeys(input, ['judgmentId', 'asOf', 'limit'])
    ?? (!judgmentId ? 'judgmentId必须是UUID' : null)
    ?? (input.asOf != null && !asOf ? 'asOf必须是YYYYMMDD' : null)
    ?? (limit == null ? 'limit必须是1至20的整数' : null)
  if (inputError || !judgmentId || limit == null) {
    return blocked('decision.judgment_history', now, asOf, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }

  try {
    const asOfMaxCreatedAt = endOfBeijingDate(asOf)
    const trustedCutoff = trustedMaxCreatedAt != null && Number.isSafeInteger(trustedMaxCreatedAt)
      ? trustedMaxCreatedAt
      : null
    const maxCreatedAt = asOfMaxCreatedAt == null
      ? trustedCutoff
      : trustedCutoff == null
        ? asOfMaxCreatedAt
        : Math.min(asOfMaxCreatedAt, trustedCutoff)
    const history = getDecisionJudgmentHistoryAt(db, judgmentId, maxCreatedAt, limit)
    if (!history) {
      return envelope('decision.judgment_history', 'missing', now, asOf, [{
        id: 'local.decision_judgments',
        status: 'missing',
        factDate: null,
      }], {
        available: 0,
        required: 1,
        unit: 'versions',
      }, ['指定判断在事实截点内不存在；未读取其判断组或截点后的版本'], empty)
    }

    const evidenceTruncated = history.versions.some((version) => version.evidenceSnapshot.evidence.length > 6)
    const versionsTruncated = history.total > history.versions.length
    const versions = history.versions.map((version): DecisionJudgmentHistoryVersionData => ({
      id: version.id,
      versionNumber: version.versionNumber,
      tag: version.tag,
      note: clipText(version.note, 1_000),
      reviewDueAt: version.reviewDueAt,
      createdAt: version.createdAt,
      sourceSignalId: version.sourceSignalId,
      sourceSignalAvailable: version.sourceSignalAvailable,
      relatedSignalCount: version.relatedSignalIds.length,
      primaryTitle: clipText(version.evidenceSnapshot.primaryTitle, 200),
      primarySummary: clipText(version.evidenceSnapshot.primarySummary, 600),
      trustHint: clipText(version.evidenceSnapshot.trustHint, 300),
      evidenceCount: version.evidenceSnapshot.evidence.length,
      evidence: version.evidenceSnapshot.evidence.slice(0, 6).map((item) => ({
        key: item.key,
        label: clipText(item.label, 120),
        status: item.status,
        detail: clipText(item.detail, 400),
      })),
    }))
    const latest = history.versions[0]
    const warnings = [
      ...(versionsTruncated ? [`判断历史共${history.total}版，本次只返回最近${history.versions.length}版`] : []),
      ...(evidenceTruncated ? ['部分判断证据条目超过6项，工具仅返回每版前6项有界摘要'] : []),
    ]
    return envelope(
      'decision.judgment_history',
      versionsTruncated || evidenceTruncated ? 'partial' : 'ready',
      now,
      asOf,
      [{
        id: 'local.decision_judgments',
        status: 'ready',
        factDate: beijingDateFromTimestamp(latest.createdAt),
      }],
      { available: versions.length, required: 1, unit: 'versions' },
      warnings,
      {
        judgmentId,
        judgmentGroupId: history.judgmentGroupId,
        tsCode: latest.tsCode,
        stockName: latest.stockName,
        totalVersionsAtCutoff: history.total,
        versions,
      },
    )
  } catch (error) {
    const code = error instanceof DecisionJudgmentRepositoryError ? error.code : 'READ_FAILED'
    const message = error instanceof Error ? error.message : '判断历史读取失败'
    return blocked('decision.judgment_history', now, asOf, empty, code, message)
  }
}

function executeIndustryProjectSnapshot(
  db: Database.Database,
  input: Record<string, unknown>,
  now: number,
): ResearchFactToolEnvelope<'industry.project_snapshot', IndustryProjectSnapshotData> {
  const asOf = normalizeAsOf(input.asOf)
  const projectId = normalizeEntityId(input.projectId)
  const empty = emptyIndustryProjectSnapshotData(projectId)
  const inputError = validateExactKeys(input, ['projectId', 'asOf'])
    ?? (!projectId ? 'projectId必须是1至128位规范标识' : null)
    ?? (input.asOf != null && !asOf ? 'asOf必须是YYYYMMDD' : null)
  if (inputError || !projectId) {
    return blocked('industry.project_snapshot', now, asOf, empty, 'INVALID_INPUT', inputError ?? '输入无效')
  }

  const maxCreatedAt = endOfBeijingDate(asOf)
  const row = maxCreatedAt == null
    ? getLatestResearchSnapshot(db, projectId)
    : getLatestResearchSnapshotAt(db, projectId, maxCreatedAt)
  if (!row) {
    return envelope('industry.project_snapshot', 'missing', now, asOf, [{
      id: 'local.industry_research_snapshots',
      status: 'missing',
      factDate: null,
    }], {
      available: 0,
      required: 1,
      unit: 'snapshots',
    }, ['当前事实截点内没有不可变产业研究快照；未使用可变的项目当前表替代'], empty)
  }
  if (row.schema_version !== 1) {
    return blocked(
      'industry.project_snapshot', now, asOf, empty,
      'UNSUPPORTED_SCHEMA', `产业研究快照schema v${row.schema_version}暂不支持`,
    )
  }

  try {
    const snapshot = JSON.parse(row.snapshot_json) as unknown
    if (!isRecord(snapshot)) throw new Error('产业研究快照不是对象')
    const project = mapIndustrySnapshotProject(snapshot.project)
    const graphAvailable = isRecord(snapshot.graph)
    const graph = graphAvailable ? snapshot.graph as Record<string, unknown> : {}
    const structuralGap = snapshot.schemaVersion !== 1
      || !graphAvailable
      || !Array.isArray(graph.nodes)
      || !Array.isArray(graph.edges)
      || !Array.isArray(snapshot.evidenceRefs)
      || !Array.isArray(snapshot.hypotheses)
      || !Array.isArray(snapshot.companies)
      || !Array.isArray(snapshot.followUps)
    const rawNodes = recordItems(graph.nodes)
    const rawEdges = recordItems(graph.edges)
    const rawEvidence = recordItems(snapshot.evidenceRefs)
    const rawHypotheses = recordItems(snapshot.hypotheses)
    const rawCompanies = recordItems(snapshot.companies)
    const rawFollowUps = recordItems(snapshot.followUps)
    const nodes = rawNodes.slice(0, 12).map(mapIndustrySnapshotNode).filter(isPresent)
    const edges = rawEdges.slice(0, 12).map(mapIndustrySnapshotEdge).filter(isPresent)
    const evidenceRefs = rawEvidence.slice(0, 10).map(mapIndustrySnapshotEvidence).filter(isPresent)
    const hypotheses = rawHypotheses.slice(0, 8).map(mapIndustrySnapshotHypothesis).filter(isPresent)
    const companies = rawCompanies.slice(0, 8).map(mapIndustrySnapshotCompany).filter(isPresent)
    const followUps = rawFollowUps.slice(0, 10).map(mapIndustrySnapshotFollowUp).filter(isPresent)
    const truncated = rawNodes.length > 12
      || rawEdges.length > 12
      || rawEvidence.length > 10
      || rawHypotheses.length > 8
      || rawCompanies.length > 8
      || rawFollowUps.length > 10
    const malformed = nodes.length < Math.min(rawNodes.length, 12)
      || edges.length < Math.min(rawEdges.length, 12)
      || evidenceRefs.length < Math.min(rawEvidence.length, 10)
      || hypotheses.length < Math.min(rawHypotheses.length, 8)
      || companies.length < Math.min(rawCompanies.length, 8)
      || followUps.length < Math.min(rawFollowUps.length, 10)
    const warnings = [
      ...(!project ? ['快照缺少可识别的项目边界'] : []),
      ...(structuralGap ? ['快照缺少schema v1标准结构，已按可识别字段降级投影'] : []),
      ...(truncated ? ['快照内容超过工具上限，仅返回关键条目的有界摘要；数量字段保留原始总数'] : []),
      ...(malformed ? ['快照中部分条目结构不可识别，已保持缺口并跳过'] : []),
    ]
    const data: IndustryProjectSnapshotData = {
      projectId,
      snapshot: {
        id: row.id,
        previousSnapshotId: row.previous_snapshot_id,
        reason: row.snapshot_reason,
        title: clipText(row.title, 240),
        schemaVersion: row.schema_version,
        createdAt: row.created_at,
      },
      project,
      graph: {
        nodeCount: rawNodes.length,
        edgeCount: rawEdges.length,
        nodes,
        edges,
      },
      evidenceRefs,
      evidenceRefCount: rawEvidence.length,
      hypotheses,
      hypothesisCount: rawHypotheses.length,
      companies,
      companyCount: rawCompanies.length,
      followUps,
      followUpCount: rawFollowUps.length,
    }
    const available = 1 + nodes.length + edges.length + evidenceRefs.length
      + hypotheses.length + companies.length + followUps.length
    return envelope(
      'industry.project_snapshot',
      project && !structuralGap && !truncated && !malformed ? 'ready' : 'partial',
      now,
      asOf,
      [{
        id: 'local.industry_research_snapshots',
        status: 'ready',
        factDate: beijingDateFromTimestamp(row.created_at),
      }],
      { available, required: 1, unit: 'snapshot_items' },
      warnings,
      data,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : '产业研究快照JSON损坏'
    return blocked('industry.project_snapshot', now, asOf, empty, 'CORRUPT_DATA', message)
  }
}

function loadPriceBars(
  db: Database.Database,
  normalized: NormalizedStockCode,
  asOf: string | null,
): { bars: ResearchPriceBar[]; sources: ResearchFactSource[] } {
  const daily = (queryDailyClose(db, [normalized.tsCode], '00000000').get(normalized.tsCode) ?? [])
    .filter((row) => asOf == null || row.tradeDate <= asOf)
  const cached = getCachedPrices(db, normalized.stockCode)
    .filter((row) => asOf == null || row.tradeDate <= asOf)
  const barsByDate = new Map<string, ResearchPriceBar>()
  for (const row of daily) {
    const bar = completePriceBar({
      tradeDate: row.tradeDate,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.vol,
      turnoverRate: row.turnoverRate,
    })
    if (bar) barsByDate.set(bar.tradeDate, bar)
  }
  for (const row of cached) {
    const existing = barsByDate.get(row.tradeDate)
    const bar = completePriceBar({
      tradeDate: row.tradeDate,
      open: finiteNumber(row.open) ?? existing?.open ?? null,
      high: finiteNumber(row.high) ?? existing?.high ?? null,
      low: finiteNumber(row.low) ?? existing?.low ?? null,
      close: finiteNumber(row.close) ?? existing?.close ?? null,
      volume: finiteNumber(row.volume) ?? existing?.volume ?? null,
      turnoverRate: existing?.turnoverRate ?? null,
    })
    if (bar) barsByDate.set(bar.tradeDate, bar)
  }
  return {
    bars: [...barsByDate.values()].sort((left, right) => left.tradeDate.localeCompare(right.tradeDate)),
    sources: [
      {
        id: 'local.daily_close_cache',
        status: daily.length > 0 ? 'ready' : 'missing',
        factDate: daily.at(-1)?.tradeDate ?? null,
      },
      {
        id: 'local.stock_price_cache',
        status: cached.length > 0 ? 'ready' : 'missing',
        factDate: cached.at(-1)?.tradeDate ?? null,
      },
    ],
  }
}

function completePriceBar(input: {
  tradeDate: string
  open: number | null | undefined
  high: number | null | undefined
  low: number | null | undefined
  close: number | null | undefined
  volume: number | null | undefined
  turnoverRate: number | null | undefined
}): ResearchPriceBar | null {
  const open = finiteNumber(input.open)
  const high = finiteNumber(input.high)
  const low = finiteNumber(input.low)
  const close = finiteNumber(input.close)
  if (open == null || high == null || low == null || close == null || close <= 0) return null
  return {
    tradeDate: input.tradeDate,
    open,
    high,
    low,
    close,
    volume: finiteNumber(input.volume),
    turnoverRate: finiteNumber(input.turnoverRate),
  }
}

function sourceFromFundamentalState(
  id: string,
  state: StockFundamentalSnapshot['sources']['profile'],
  hasFacts: boolean,
  factDate: string | null,
): ResearchFactSource {
  return {
    id,
    status: state.status === 'failed' ? 'failed' : hasFacts ? 'ready' : 'missing',
    factDate,
  }
}

function appendSourceFailureWarning(
  warnings: string[],
  label: string,
  state: StockFundamentalSnapshot['sources']['profile'],
): void {
  if (state.status !== 'failed') return
  warnings.push(`${label}最近刷新失败${state.errorCode ? `（${state.errorCode}）` : ''}，已有事实未被删除`)
}

function envelope<K extends ResearchFactToolId>(
  toolId: K,
  status: ResearchFactToolStatus,
  generatedAt: number,
  asOf: string | null,
  sources: ResearchFactSource[],
  coverage: ResearchFactCoverage,
  warnings: string[],
  data: ResearchFactToolDataMap[K],
): ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]> {
  return { schemaVersion: 1, toolId, status, generatedAt, asOf, sources, coverage, warnings, data }
}

function blocked<K extends ResearchFactToolId>(
  toolId: K,
  generatedAt: number,
  asOf: string | null,
  data: ResearchFactToolDataMap[K],
  code: string,
  message: string,
): ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]> {
  return envelope(toolId, 'blocked', generatedAt, asOf, [], {
    available: 0,
    required: null,
    unit: 'items',
  }, [`${code}: ${message}`], data)
}

function blockedRuntime(toolId: string, generatedAt: number, code: string, message: string): RuntimeBlockedEnvelope {
  return {
    schemaVersion: 1,
    toolId,
    status: 'blocked',
    generatedAt,
    asOf: null,
    sources: [],
    coverage: { available: 0, required: null, unit: 'items' },
    warnings: [`${code}: ${message}`],
    data: null,
  }
}

function emptyPriceData(): StockPriceHistoryData {
  return { stockCode: null, tsCode: null, stockName: null, bars: [] }
}

function emptyTrendData(): StockTrendSnapshotData {
  return {
    stockCode: null,
    tsCode: null,
    stockName: null,
    tradeDate: null,
    bars: 0,
    requiredBars: 60,
    totalScore: null,
    validWeight: 0,
    trendState: 'insufficient',
    dimensions: null,
    facts: null,
    benchmark: { tsCode: '000300.SH', tradeDate: null, bars: 0, status: 'missing' },
  }
}

function emptyFundamentalsData(): StockFundamentalsData {
  return {
    stockCode: null,
    tsCode: null,
    profile: null,
    latestFinancial: null,
    financialHistory: [],
    diagnostics: null,
  }
}

function emptyAnnouncementsData(): StockAnnouncementsData {
  return { stockCode: null, tsCode: null, announcements: [], diagnostics: null }
}

function emptyDecisionJudgmentHistoryData(judgmentId: string | null = null): DecisionJudgmentHistoryData {
  return {
    judgmentId,
    judgmentGroupId: null,
    tsCode: null,
    stockName: null,
    totalVersionsAtCutoff: 0,
    versions: [],
  }
}

function emptyIndustryProjectSnapshotData(projectId: string | null = null): IndustryProjectSnapshotData {
  return {
    projectId,
    snapshot: null,
    project: null,
    graph: { nodeCount: 0, edgeCount: 0, nodes: [], edges: [] },
    evidenceRefs: [],
    evidenceRefCount: 0,
    hypotheses: [],
    hypothesisCount: 0,
    companies: [],
    companyCount: 0,
    followUps: [],
    followUpCount: 0,
  }
}

function mapIndustrySnapshotProject(value: unknown): IndustryProjectSnapshotData['project'] {
  if (!isRecord(value)) return null
  const title = stringField(value, 'title')
  const industryName = stringField(value, 'industry_name', 'industryName')
  const productScope = stringField(value, 'product_scope', 'productScope')
  if (!title || !industryName || !productScope) return null
  return {
    title: clipText(title, 240),
    industryName: clipText(industryName, 160),
    productScope: clipText(productScope, 300),
    regionScope: clipText(stringField(value, 'region_scope', 'regionScope') ?? '未知', 160),
    timeScope: clipText(stringField(value, 'time_scope', 'timeScope') ?? '未知', 160),
    purpose: stringField(value, 'purpose') ?? 'unknown',
    depth: stringField(value, 'depth') ?? 'unknown',
    status: stringField(value, 'status') ?? 'unknown',
    dataAsOf: stringField(value, 'data_as_of', 'dataAsOf'),
    valuationDate: stringField(value, 'valuation_date', 'valuationDate'),
    nextReviewAt: numberField(value, 'next_review_at', 'nextReviewAt'),
    stopCondition: clipNullableText(stringField(value, 'stop_condition', 'stopCondition'), 500),
  }
}

function mapIndustrySnapshotNode(
  value: Record<string, unknown>,
): IndustryProjectSnapshotData['graph']['nodes'][number] | null {
  const id = stringField(value, 'id')
  const name = stringField(value, 'name')
  if (!id || !name) return null
  return {
    id,
    type: stringField(value, 'type') ?? 'unknown',
    name: clipText(name, 200),
    stage: clipNullableText(stringField(value, 'stage'), 120),
    statementKind: stringField(value, 'statement_kind', 'statementKind') ?? 'unknown',
    status: clipNullableText(stringField(value, 'status'), 120),
    lastUpdated: stringField(value, 'last_updated', 'lastUpdated'),
  }
}

function mapIndustrySnapshotEdge(
  value: Record<string, unknown>,
): IndustryProjectSnapshotData['graph']['edges'][number] | null {
  const sourceNodeId = stringField(value, 'source_node_id', 'sourceNodeId', 'source')
  const targetNodeId = stringField(value, 'target_node_id', 'targetNodeId', 'target')
  const relation = stringField(value, 'relation')
  if (!sourceNodeId || !targetNodeId || !relation) return null
  return {
    sourceNodeId,
    targetNodeId,
    relation: clipText(relation, 200),
    statementKind: stringField(value, 'statement_kind', 'statementKind') ?? 'unknown',
    bottleneck: booleanField(value, 'bottleneck'),
  }
}

function mapIndustrySnapshotEvidence(
  value: Record<string, unknown>,
): IndustryProjectSnapshotData['evidenceRefs'][number] | null {
  const id = stringField(value, 'id')
  const title = stringField(value, 'title')
  if (!id || !title) return null
  return {
    id,
    title: clipText(title, 240),
    statementKind: stringField(value, 'statementKind', 'statement_kind') ?? 'unknown',
    sourceUrl: clipNullableText(stringField(value, 'sourceUrl', 'source_url'), 1_000),
    primarySourceConfirmed: booleanField(value, 'primarySourceConfirmed', 'primary_source_confirmed'),
  }
}

function mapIndustrySnapshotHypothesis(
  value: Record<string, unknown>,
): IndustryProjectSnapshotData['hypotheses'][number] | null {
  const id = stringField(value, 'id')
  const statement = stringField(value, 'statement')
  if (!id || !statement) return null
  return {
    id,
    statement: clipText(statement, 500),
    importance: numberField(value, 'importance'),
    status: stringField(value, 'status') ?? 'unknown',
    cheapestDisproof: clipText(stringField(value, 'cheapest_disproof', 'cheapestDisproof') ?? '未知', 500),
    verificationMetric: clipNullableText(stringField(value, 'verification_metric', 'verificationMetric'), 240),
    threshold: clipNullableText(stringField(value, 'threshold'), 240),
    dueAt: numberField(value, 'due_at', 'dueAt'),
  }
}

function mapIndustrySnapshotCompany(
  value: Record<string, unknown>,
): IndustryProjectSnapshotData['companies'][number] | null {
  const companyId = stringField(value, 'company_id', 'companyId')
  if (!companyId) return null
  return {
    companyId,
    status: stringField(value, 'status') ?? 'unknown',
    exclusionReason: clipNullableText(stringField(value, 'exclusion_reason', 'exclusionReason'), 500),
  }
}

function mapIndustrySnapshotFollowUp(
  value: Record<string, unknown>,
): IndustryProjectSnapshotData['followUps'][number] | null {
  const type = stringField(value, 'type')
  const id = stringField(value, 'id')
  const dueAt = numberField(value, 'dueAt', 'due_at')
  if (!type || !id || dueAt == null) return null
  return { type, id, dueAt }
}

function recordItems(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function numberField(value: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return null
}

function booleanField(value: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'boolean') return candidate
    if (candidate === 1) return true
    if (candidate === 0) return false
  }
  return false
}

function isPresent<T>(value: T | null): value is T {
  return value != null
}

function normalizeStockCode(value: unknown): NormalizedStockCode | null {
  if (typeof value !== 'string') return null
  const clean = value.trim().toUpperCase()
  const match = clean.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/)
  if (!match) return null
  const stockCode = match[1]
  const explicitMarket = match[2] ?? null
  const inferredMarket = inferMarket(stockCode)
  const knownIndexMarket = stockCode === '000300' ? 'SH' : null
  const expectedMarket = knownIndexMarket ?? inferredMarket
  if (explicitMarket && explicitMarket !== expectedMarket) return null
  return { stockCode, tsCode: `${stockCode}.${explicitMarket ?? expectedMarket}` }
}

function normalizeUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null
}

function normalizeEntityId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) ? normalized : null
}

function inferMarket(stockCode: string): 'SH' | 'SZ' | 'BJ' {
  if (/^(4|8|92)/.test(stockCode)) return 'BJ'
  if (/^(5|6|9|11)/.test(stockCode)) return 'SH'
  return 'SZ'
}

function normalizeAsOf(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return null
  const compact = value.trim().replace(/-/g, '')
  if (!/^\d{8}$/.test(compact)) return null
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  const day = Number(compact.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? compact
    : null
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value == null) return fallback
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

function normalizeQuery(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 0 && normalized.length <= 80 ? normalized : null
}

function validateExactKeys(input: Record<string, unknown>, allowed: readonly string[]): string | null {
  const unknownKeys = Object.keys(input).filter((key) => !allowed.includes(key))
  return unknownKeys.length > 0 ? `包含不支持的字段：${unknownKeys.join('、')}` : null
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function endOfBeijingDate(asOf: string | null): number | null {
  if (!asOf) return null
  const year = Number(asOf.slice(0, 4))
  const month = Number(asOf.slice(4, 6))
  const day = Number(asOf.slice(6, 8))
  return Date.UTC(year, month - 1, day + 1) - 8 * 60 * 60 * 1000 - 1
}

function beijingDateFromTimestamp(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}${values.month}${values.day}`
}

function clipText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function clipNullableText(value: string | null, limit: number): string | null {
  return value == null ? null : clipText(value, limit)
}

function toDashedDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}
