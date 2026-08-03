import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getStockFundamentalProfile,
  getStockFundamentalSourceState,
  listLatestStockFundamentalAnnouncements,
  listLatestStockFundamentalFinancials,
  recordStockFundamentalSyncFailure,
  recordStockFundamentalSyncSuccess,
  replaceStockFundamentalAnnouncements,
  saveStockFundamentalFinancials,
  upsertStockFundamentalProfile,
  type StockFundamentalAnnouncementRecord,
  type StockFundamentalFinancial,
  type StockFundamentalProfile,
  type StockFundamentalSourceState,
} from '../database/stockFundamentalRepository'
import { upsertStockInfo } from '../database/stockPriceCacheRepository'

const COMPANY_SURVEY_URL = 'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax'
const MAIN_FINANCE_URL = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
const ANNOUNCEMENT_INDEX_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
const REQUEST_TIMEOUT_MS = 15_000

export type StockFundamentalAttentionTag =
  | 'major'
  | 'performance'
  | 'capital'
  | 'ownership'
  | 'dividend'
  | 'governance'
  | 'risk'
  | 'business'

const ANNOUNCEMENT_ATTENTION_RULES: ReadonlyArray<{
  tag: StockFundamentalAttentionTag
  pattern: RegExp
}> = [
  { tag: 'major', pattern: /重大事项|重大事件/ },
  { tag: 'performance', pattern: /业绩预告|业绩快报|预增|预减|预亏|扭亏/ },
  { tag: 'capital', pattern: /重大资产|资产重组|重组|收购|出售资产|对外投资|定向增发|非公开发行|发行股份|可转债/ },
  { tag: 'ownership', pattern: /实际控制人|控制权|股东增持|股东减持|股份回购|股份质押|持股变动|权益变动/ },
  { tag: 'dividend', pattern: /利润分配|权益分派|现金分红|分红/ },
  { tag: 'governance', pattern: /董事|监事|高级管理人员|总经理|董事会秘书|审计机构|会计师事务所/ },
  { tag: 'risk', pattern: /立案|调查|处罚|诉讼|仲裁|担保|风险提示|退市|停牌|复牌|异常波动|违约/ },
  { tag: 'business', pattern: /重大合同|合同|中标|项目|产能|产品|合作|许可|专利/ },
]

export type StockFundamentalSnapshotStatus = 'complete' | 'partial' | 'missing'
export type StockFundamentalErrorCode =
  | 'INVALID_STOCK_CODE'
  | 'PROFILE_HTTP_ERROR'
  | 'PROFILE_UPSTREAM_ERROR'
  | 'PROFILE_EMPTY'
  | 'FINANCIAL_HTTP_ERROR'
  | 'FINANCIAL_UPSTREAM_ERROR'
  | 'FINANCIAL_EMPTY'
  | 'ANNOUNCEMENT_HTTP_ERROR'
  | 'ANNOUNCEMENT_UPSTREAM_ERROR'
  | 'ANNOUNCEMENT_EMPTY'
  | 'FUNDAMENTAL_FETCH_FAILED'

export interface StockFundamentalAnnouncement extends StockFundamentalAnnouncementRecord {
  attentionTags: StockFundamentalAttentionTag[]
}

export type StockAnnouncementRefreshResult =
  | { ok: true; rowsWritten: number }
  | { ok: false; code: StockFundamentalErrorCode; message: string }

export interface StockFundamentalSnapshot {
  stockCode: string
  tsCode: string
  status: StockFundamentalSnapshotStatus
  profile: StockFundamentalProfile | null
  latestFinancial: StockFundamentalFinancial | null
  financialHistory: StockFundamentalFinancial[]
  announcements: StockFundamentalAnnouncement[]
  announcementSummary: {
    total: number
    attentionCount: number
    latestNoticeDate: string | null
  }
  sources: {
    profile: StockFundamentalSourceState
    financial: StockFundamentalSourceState
    announcement: StockFundamentalSourceState
  }
}

export type StockFundamentalReadResult =
  | { ok: true; snapshot: StockFundamentalSnapshot }
  | { ok: false; code: 'INVALID_STOCK_CODE'; message: string }

export type StockFundamentalRefreshResult =
  | {
      ok: true
      refreshStatus: 'complete' | 'partial'
      snapshot: StockFundamentalSnapshot
      message: string
    }
  | {
      ok: false
      code: StockFundamentalErrorCode
      message: string
      snapshot: StockFundamentalSnapshot | null
    }

interface NormalizedStockCode {
  stockCode: string
  tsCode: string
  eastmoneyCode: string
}

interface SourceFailure {
  code: StockFundamentalErrorCode
  message: string
}

type FetchLike = typeof fetch

const inflightByDb = new WeakMap<Database.Database, Map<string, Promise<StockFundamentalRefreshResult>>>()
const announcementInflightByDb = new WeakMap<Database.Database, Map<string, Promise<StockAnnouncementRefreshResult>>>()

function normalizeStockCode(value: string): NormalizedStockCode | null {
  const clean = value.trim().toUpperCase()
  const explicitMarket = clean.match(/\.(SH|SZ|BJ)$/)?.[1] ?? null
  const stockCode = clean.replace(/\.(SH|SZ|BJ)$/i, '')
  if (!/^\d{6}$/.test(stockCode)) return null
  const isShanghai = /^(600|601|603|605|688|900|110|113|118|127|128|129|131|132)/.test(stockCode)
  const isBeijing = /^(430|830|87|88|89|92)/.test(stockCode)
  const market = isShanghai ? 'SH' : isBeijing ? 'BJ' : 'SZ'
  if (explicitMarket != null && explicitMarket !== market) return null
  return {
    stockCode,
    tsCode: `${stockCode}.${market}`,
    eastmoneyCode: `${market}${stockCode}`,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function textOrNull(value: unknown, maxLength = 10_000): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value)
  return parsed == null ? null : Math.trunc(parsed)
}

function dateOrNull(value: unknown): string | null {
  const text = textOrNull(value, 32)
  if (!text) return null
  const compact = text.slice(0, 10).replace(/-/g, '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function beijingDisplayTimeOrNull(value: unknown): number | null {
  const text = textOrNull(value, 40)
  const match = text?.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?::(\d{1,3}))?/,
  )
  if (!match) return null
  const milliseconds = (match[7] ?? '0').padEnd(3, '0')
  const parsed = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${milliseconds}+08:00`,
  )
  return Number.isFinite(parsed) ? parsed : null
}

function beijingDate(now: number): string {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

function stableVersion(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function getStockFundamentalAnnouncementAttention(
  title: string,
  categoryNames: string[],
): StockFundamentalAttentionTag[] {
  const searchable = `${title} ${categoryNames.join(' ')}`
  return ANNOUNCEMENT_ATTENTION_RULES
    .filter((rule) => rule.pattern.test(searchable))
    .map((rule) => rule.tag)
}

async function fetchJson(url: URL, fetcher: FetchLike): Promise<{ response: Response; json: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: url.hostname === 'np-anotice-stock.eastmoney.com'
          ? 'https://data.eastmoney.com/'
          : 'https://emweb.securities.eastmoney.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: controller.signal,
    })
    const json = await response.json() as unknown
    return { response, json }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchCompanyProfile(
  normalized: NormalizedStockCode,
  fetcher: FetchLike,
  fetchedAt: number,
): Promise<StockFundamentalProfile> {
  const url = new URL(COMPANY_SURVEY_URL)
  url.searchParams.set('code', normalized.eastmoneyCode)
  let response: Response
  let json: unknown
  try {
    ({ response, json } = await fetchJson(url, fetcher))
  } catch {
    throw { code: 'PROFILE_HTTP_ERROR', message: '公司概况请求失败，请稍后重试' } satisfies SourceFailure
  }
  if (!response.ok) {
    throw { code: 'PROFILE_HTTP_ERROR', message: '公司概况请求失败，请稍后重试' } satisfies SourceFailure
  }
  const root = asRecord(json)
  const rows = Array.isArray(root?.jbzl) ? root.jbzl : []
  const row = asRecord(rows[0])
  if (!row) throw { code: 'PROFILE_EMPTY', message: '公开来源没有返回公司概况' } satisfies SourceFailure
  if (textOrNull(row.SECUCODE, 16) !== normalized.tsCode || textOrNull(row.SECURITY_CODE, 6) !== normalized.stockCode) {
    throw { code: 'PROFILE_UPSTREAM_ERROR', message: '公司概况证券代码与请求不一致' } satisfies SourceFailure
  }
  const shortName = textOrNull(row.SECURITY_NAME_ABBR, 80)
  const legalName = textOrNull(row.ORG_NAME, 200)
  if (!shortName && !legalName) {
    throw { code: 'PROFILE_EMPTY', message: '公开来源没有返回有效公司名称' } satisfies SourceFailure
  }
  return {
    tsCode: normalized.tsCode,
    stockCode: normalized.stockCode,
    shortName,
    legalName,
    securityType: textOrNull(row.SECURITY_TYPE, 80),
    tradeMarket: textOrNull(row.TRADE_MARKET, 120),
    industry: textOrNull(row.EM2016, 200),
    chairman: textOrNull(row.CHAIRMAN, 80),
    legalRepresentative: textOrNull(row.LEGAL_PERSON, 80),
    website: textOrNull(row.ORG_WEB, 300),
    officeAddress: textOrNull(row.ADDRESS, 300),
    registeredCapitalWan: numberOrNull(row.REG_CAPITAL),
    employeeCount: integerOrNull(row.EMP_NUM),
    businessScope: textOrNull(row.BUSINESS_SCOPE),
    companyProfile: textOrNull(row.ORG_PROFILE),
    source: 'eastmoney-company-survey',
    sourceFactDate: null,
    fetchedAt,
  }
}

async function fetchFinancials(
  normalized: NormalizedStockCode,
  fetcher: FetchLike,
  fetchedAt: number,
): Promise<StockFundamentalFinancial[]> {
  const url = new URL(MAIN_FINANCE_URL)
  url.searchParams.set('reportName', 'RPT_F10_FINANCE_MAINFINADATA')
  url.searchParams.set('columns', 'ALL')
  url.searchParams.set('quoteColumns', '')
  url.searchParams.set('filter', `(SECUCODE="${normalized.tsCode}")`)
  url.searchParams.set('pageNumber', '1')
  url.searchParams.set('pageSize', '8')
  url.searchParams.set('sortTypes', '-1')
  url.searchParams.set('sortColumns', 'REPORT_DATE')
  url.searchParams.set('source', 'HSF10')
  url.searchParams.set('client', 'PC')
  let response: Response
  let json: unknown
  try {
    ({ response, json } = await fetchJson(url, fetcher))
  } catch {
    throw { code: 'FINANCIAL_HTTP_ERROR', message: '主要财务指标请求失败，请稍后重试' } satisfies SourceFailure
  }
  if (!response.ok) {
    throw { code: 'FINANCIAL_HTTP_ERROR', message: '主要财务指标请求失败，请稍后重试' } satisfies SourceFailure
  }
  const root = asRecord(json)
  if (root?.success !== true || numberOrNull(root.code) !== 0) {
    throw { code: 'FINANCIAL_UPSTREAM_ERROR', message: '主要财务指标上游返回异常' } satisfies SourceFailure
  }
  const result = asRecord(root.result)
  const inputRows = Array.isArray(result?.data) ? result.data : []
  const today = beijingDate(fetchedAt)
  const rows = inputRows.flatMap((value): StockFundamentalFinancial[] => {
    const row = asRecord(value)
    if (!row || textOrNull(row.SECUCODE, 16) !== normalized.tsCode) return []
    const reportDate = dateOrNull(row.REPORT_DATE)
    const noticeDate = dateOrNull(row.NOTICE_DATE)
    if (!reportDate || (noticeDate != null && noticeDate > today)) return []
    const versionedFacts = {
      tsCode: normalized.tsCode,
      stockCode: normalized.stockCode,
      shortName: textOrNull(row.SECURITY_NAME_ABBR, 80),
      reportDate,
      reportType: textOrNull(row.REPORT_TYPE, 80),
      noticeDate,
      updateDate: dateOrNull(row.UPDATE_DATE),
      currency: textOrNull(row.CURRENCY, 16),
      totalRevenue: numberOrNull(row.TOTALOPERATEREVE),
      parentNetProfit: numberOrNull(row.PARENTNETPROFIT),
      deductedNetProfit: numberOrNull(row.KCFJCXSYJLR),
      revenueYoy: numberOrNull(row.TOTALOPERATEREVETZ),
      parentNetProfitYoy: numberOrNull(row.PARENTNETPROFITTZ),
      deductedNetProfitYoy: numberOrNull(row.KCFJCXSYJLRTZ),
      weightedRoe: numberOrNull(row.ROEJQ),
      grossMargin: numberOrNull(row.XSMLL),
      netMargin: numberOrNull(row.XSJLL),
      debtRatio: numberOrNull(row.ZCFZL),
      operatingCashFlow: numberOrNull(row.NETCASH_OPERATE_PK),
      basicEps: numberOrNull(row.EPSJB),
      bookValuePerShare: numberOrNull(row.BPS),
      source: 'eastmoney-main-finance' as const,
    }
    return [{
      ...versionedFacts,
      sourceVersion: stableVersion(versionedFacts),
      fetchedAt,
    }]
  })
  const unique = [...new Map(rows.map((row) => [`${row.reportDate}:${row.sourceVersion}`, row])).values()]
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
    .slice(0, 8)
  if (unique.length === 0) {
    throw { code: 'FINANCIAL_EMPTY', message: '公开来源没有返回已公告的主要财务指标' } satisfies SourceFailure
  }
  return unique
}

async function fetchAnnouncements(
  normalized: NormalizedStockCode,
  fetcher: FetchLike,
  fetchedAt: number,
): Promise<StockFundamentalAnnouncementRecord[]> {
  const url = new URL(ANNOUNCEMENT_INDEX_URL)
  url.searchParams.set('sr', '-1')
  url.searchParams.set('page_size', '30')
  url.searchParams.set('page_index', '1')
  url.searchParams.set('ann_type', 'A')
  url.searchParams.set('client_source', 'web')
  url.searchParams.set('stock_list', normalized.stockCode)
  let response: Response
  let json: unknown
  try {
    ({ response, json } = await fetchJson(url, fetcher))
  } catch {
    throw { code: 'ANNOUNCEMENT_HTTP_ERROR', message: '公告索引请求失败，请稍后重试' } satisfies SourceFailure
  }
  if (!response.ok) {
    throw { code: 'ANNOUNCEMENT_HTTP_ERROR', message: '公告索引请求失败，请稍后重试' } satisfies SourceFailure
  }
  const root = asRecord(json)
  if (numberOrNull(root?.success) !== 1) {
    throw { code: 'ANNOUNCEMENT_UPSTREAM_ERROR', message: '公告索引上游返回异常' } satisfies SourceFailure
  }
  const data = asRecord(root?.data)
  const inputRows = Array.isArray(data?.list) ? data.list : []
  if (inputRows.length === 0) return []

  const today = beijingDate(fetchedAt)
  const rows: StockFundamentalAnnouncementRecord[] = []
  let matchingRows = 0
  let futureRows = 0
  let malformedRows = 0
  for (const value of inputRows) {
    const row = asRecord(value)
    if (!row) continue
    const codes = Array.isArray(row.codes) ? row.codes.map(asRecord).filter(Boolean) : []
    const matchedCode = codes.find((code) => textOrNull(code?.stock_code, 6) === normalized.stockCode)
    if (!matchedCode) continue
    matchingRows += 1

    const articleCode = textOrNull(row.art_code, 40)
    const title = textOrNull(row.title_ch, 500) ?? textOrNull(row.title, 500)
    const noticeDate = dateOrNull(row.notice_date)
    const displayAt = beijingDisplayTimeOrNull(row.display_time)
    if (!articleCode || !/^AN\d+$/.test(articleCode) || !title || !noticeDate) {
      malformedRows += 1
      continue
    }
    if (noticeDate > today || (displayAt != null && displayAt > fetchedAt)) {
      futureRows += 1
      continue
    }
    const columns = Array.isArray(row.columns) ? row.columns.map(asRecord).filter(Boolean) : []
    const categoryCodes = [...new Set(columns
      .map((column) => textOrNull(column?.column_code, 40))
      .filter((item): item is string => item != null))]
    const categoryNames = [...new Set(columns
      .map((column) => textOrNull(column?.column_name, 120))
      .filter((item): item is string => item != null))]
    rows.push({
      tsCode: normalized.tsCode,
      stockCode: normalized.stockCode,
      shortName: textOrNull(matchedCode.short_name, 80),
      articleCode,
      title,
      noticeDate,
      displayAt,
      categoryCodes,
      categoryNames,
      source: 'eastmoney-announcement-index',
      sourceUrl: `https://data.eastmoney.com/notices/detail/${normalized.stockCode}/${articleCode}.html`,
      fetchedAt,
    })
  }
  if (matchingRows === 0) {
    throw { code: 'ANNOUNCEMENT_UPSTREAM_ERROR', message: '公告索引证券代码与请求不一致' } satisfies SourceFailure
  }
  if (rows.length === 0 && malformedRows > 0 && futureRows < matchingRows) {
    throw { code: 'ANNOUNCEMENT_EMPTY', message: '公开来源没有返回有效公告索引' } satisfies SourceFailure
  }
  return [...new Map(rows.map((row) => [row.articleCode, row])).values()]
    .sort((left, right) => (
      right.noticeDate.localeCompare(left.noticeDate)
      || (right.displayAt ?? 0) - (left.displayAt ?? 0)
      || right.articleCode.localeCompare(left.articleCode)
    ))
    .slice(0, 30)
}

function sourceFailure(error: unknown, fallbackCode: StockFundamentalErrorCode): SourceFailure {
  const record = asRecord(error)
  const code = textOrNull(record?.code, 80) as StockFundamentalErrorCode | null
  const message = textOrNull(record?.message, 500)
  return { code: code ?? fallbackCode, message: message ?? '公开基本面资料获取失败' }
}

export function getStockFundamentalSnapshot(
  db: Database.Database,
  inputCode: string,
): StockFundamentalReadResult {
  const normalized = normalizeStockCode(inputCode)
  if (!normalized) return { ok: false, code: 'INVALID_STOCK_CODE', message: '请输入六位股票代码' }
  const profile = getStockFundamentalProfile(db, normalized.tsCode)
  const financialHistory = listLatestStockFundamentalFinancials(db, normalized.tsCode, 8)
  const latestFinancial = financialHistory[0] ?? null
  const rawAnnouncements = listLatestStockFundamentalAnnouncements(db, normalized.tsCode, 30)
  const announcements = rawAnnouncements.map((announcement): StockFundamentalAnnouncement => ({
    ...announcement,
    attentionTags: getStockFundamentalAnnouncementAttention(
      announcement.title,
      announcement.categoryNames,
    ),
  }))
  const announcementSource = getStockFundamentalSourceState(
    db,
    normalized.tsCode,
    'announcement',
    announcements.length > 0,
    announcements[0]?.noticeDate ?? null,
  )
  const sourceCount = Number(profile != null)
    + Number(latestFinancial != null)
    + Number(announcements.length > 0 || announcementSource.status === 'available')
  const status: StockFundamentalSnapshotStatus = sourceCount === 3
    ? 'complete'
    : sourceCount > 0
      ? 'partial'
      : 'missing'
  return {
    ok: true,
    snapshot: {
      stockCode: normalized.stockCode,
      tsCode: normalized.tsCode,
      status,
      profile,
      latestFinancial,
      financialHistory,
      announcements,
      announcementSummary: {
        total: announcements.length,
        attentionCount: announcements.filter((announcement) => announcement.attentionTags.length > 0).length,
        latestNoticeDate: announcements[0]?.noticeDate ?? null,
      },
      sources: {
        profile: getStockFundamentalSourceState(db, normalized.tsCode, 'profile', profile != null, null),
        financial: getStockFundamentalSourceState(
          db,
          normalized.tsCode,
          'financial',
          latestFinancial != null,
          latestFinancial?.noticeDate ?? null,
        ),
        announcement: announcementSource,
      },
    },
  }
}

async function refreshStockFundamentalsInternal(
  db: Database.Database,
  normalized: NormalizedStockCode,
  fetcher: FetchLike,
  now: number,
): Promise<StockFundamentalRefreshResult> {
  const [profileResult, financialResult, announcementResult] = await Promise.allSettled([
    fetchCompanyProfile(normalized, fetcher, now),
    fetchFinancials(normalized, fetcher, now),
    fetchAnnouncements(normalized, fetcher, now),
  ])
  const failures: SourceFailure[] = []
  if (profileResult.status === 'fulfilled') {
    db.transaction(() => {
      upsertStockFundamentalProfile(db, profileResult.value)
      if (profileResult.value.shortName) {
        upsertStockInfo(db, normalized.stockCode, profileResult.value.shortName)
      }
      recordStockFundamentalSyncSuccess(db, normalized.tsCode, 'profile', now, null, 1)
    })()
  } else {
    const failure = sourceFailure(profileResult.reason, 'PROFILE_UPSTREAM_ERROR')
    failures.push(failure)
    recordStockFundamentalSyncFailure(db, normalized.tsCode, 'profile', now, failure.code)
  }
  if (financialResult.status === 'fulfilled') {
    db.transaction(() => {
      const written = saveStockFundamentalFinancials(db, financialResult.value)
      recordStockFundamentalSyncSuccess(
        db,
        normalized.tsCode,
        'financial',
        now,
        financialResult.value[0]?.noticeDate ?? null,
        written,
      )
    })()
  } else {
    const failure = sourceFailure(financialResult.reason, 'FINANCIAL_UPSTREAM_ERROR')
    failures.push(failure)
    recordStockFundamentalSyncFailure(db, normalized.tsCode, 'financial', now, failure.code)
  }
  if (announcementResult.status === 'fulfilled') {
    db.transaction(() => {
      const written = replaceStockFundamentalAnnouncements(
        db,
        normalized.tsCode,
        announcementResult.value,
      )
      recordStockFundamentalSyncSuccess(
        db,
        normalized.tsCode,
        'announcement',
        now,
        announcementResult.value[0]?.noticeDate ?? null,
        written,
      )
    })()
  } else {
    const failure = sourceFailure(announcementResult.reason, 'ANNOUNCEMENT_UPSTREAM_ERROR')
    failures.push(failure)
    recordStockFundamentalSyncFailure(db, normalized.tsCode, 'announcement', now, failure.code)
  }
  const readResult = getStockFundamentalSnapshot(db, normalized.tsCode)
  const snapshot = readResult.ok ? readResult.snapshot : null
  if (
    profileResult.status === 'rejected'
    && financialResult.status === 'rejected'
    && announcementResult.status === 'rejected'
  ) {
    return {
      ok: false,
      code: failures[0]?.code ?? 'FUNDAMENTAL_FETCH_FAILED',
      message: failures.map((failure) => failure.message).join('；') || '公开基本面资料获取失败',
      snapshot,
    }
  }
  return {
    ok: true,
    refreshStatus: failures.length === 0 ? 'complete' : 'partial',
    snapshot: snapshot!,
    message: failures.length === 0
      ? '公司概况、主要财务与公告索引已更新'
      : `部分资料已更新；${failures.map((failure) => failure.message).join('；')}`,
  }
}

export function refreshStockFundamentals(
  db: Database.Database,
  inputCode: string,
  options: { fetcher?: FetchLike; now?: number } = {},
): Promise<StockFundamentalRefreshResult> {
  const normalized = normalizeStockCode(inputCode)
  if (!normalized) {
    return Promise.resolve({
      ok: false,
      code: 'INVALID_STOCK_CODE',
      message: '请输入六位股票代码',
      snapshot: null,
    })
  }
  let inflight = inflightByDb.get(db)
  if (!inflight) {
    inflight = new Map()
    inflightByDb.set(db, inflight)
  }
  const existing = inflight.get(normalized.tsCode)
  if (existing) return existing
  const promise = refreshStockFundamentalsInternal(
    db,
    normalized,
    options.fetcher ?? fetch,
    options.now ?? Date.now(),
  ).finally(() => inflight!.delete(normalized.tsCode))
  inflight.set(normalized.tsCode, promise)
  return promise
}

export function refreshStockAnnouncements(
  db: Database.Database,
  inputCode: string,
  options: { fetcher?: FetchLike; now?: number } = {},
): Promise<StockAnnouncementRefreshResult> {
  const normalized = normalizeStockCode(inputCode)
  if (!normalized) {
    return Promise.resolve({ ok: false, code: 'INVALID_STOCK_CODE', message: '股票代码无效' })
  }
  let inflight = announcementInflightByDb.get(db)
  if (!inflight) {
    inflight = new Map()
    announcementInflightByDb.set(db, inflight)
  }
  const existing = inflight.get(normalized.tsCode)
  if (existing) return existing
  const now = options.now ?? Date.now()
  const promise = fetchAnnouncements(normalized, options.fetcher ?? fetch, now)
    .then((rows): StockAnnouncementRefreshResult => {
      const rowsWritten = db.transaction(() => {
        const written = replaceStockFundamentalAnnouncements(db, normalized.tsCode, rows)
        recordStockFundamentalSyncSuccess(
          db,
          normalized.tsCode,
          'announcement',
          now,
          rows[0]?.noticeDate ?? null,
          written,
        )
        return written
      })()
      return { ok: true, rowsWritten }
    })
    .catch((error): StockAnnouncementRefreshResult => {
      const failure = sourceFailure(error, 'ANNOUNCEMENT_UPSTREAM_ERROR')
      recordStockFundamentalSyncFailure(db, normalized.tsCode, 'announcement', now, failure.code)
      return { ok: false, code: failure.code, message: failure.message }
    })
    .finally(() => inflight!.delete(normalized.tsCode))
  inflight.set(normalized.tsCode, promise)
  return promise
}
