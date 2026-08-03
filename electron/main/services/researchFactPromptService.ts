import type Database from 'better-sqlite3'
import {
  executeResearchFactTool,
  type AnyResearchFactToolEnvelope,
  type DecisionJudgmentHistoryData,
  type IndustryProjectSnapshotData,
  type ResearchFactCoverage,
  type ResearchFactSource,
  type ResearchFactToolId,
  type StockAnnouncementsData,
  type StockFundamentalsData,
  type StockPriceHistoryData,
  type StockTrendSnapshotData,
} from './researchFactToolRegistry'
import {
  buildContextResearchEvidenceContrast,
  buildStockResearchEvidenceContrast,
  emptyResearchEvidenceContrast,
  isResearchEvidenceContrast,
  type ResearchEvidenceContrast,
  type StockResearchEvidenceInput,
} from './researchEvidenceAuditService'

const MAX_CANDIDATES = 5
const MAX_CONTEXT_CHARS = 14_000
const MAX_ENTITY_CONTEXT_CHARS = 10_000
const STOCK_FACT_TOOL_IDS = [
  'stock.trend_snapshot',
  'stock.fundamentals',
  'stock.announcements',
] as const satisfies readonly ResearchFactToolId[]

export interface ResearchFactInvocationSnapshot {
  toolId: ResearchFactToolId
  stockCode: string
  status: AnyResearchFactToolEnvelope['status']
  asOf: string | null
  sources: ResearchFactSource[]
  coverage: ResearchFactCoverage
  warnings: string[]
}

export interface StockResearchFactBundle {
  schemaVersion: 1
  generatedAt: number
  asOf: string | null
  markdown: string
  toolIds: ResearchFactToolId[]
  stockCodes: string[]
  invocations: ResearchFactInvocationSnapshot[]
  evidenceContrast?: ResearchEvidenceContrast
}

export type ContextResearchFactSubject =
  | { kind: 'judgment'; id: string }
  | { kind: 'industry_project'; id: string }

export interface ContextResearchFactInvocationSnapshot {
  toolId: ResearchFactToolId
  subjectKind: ContextResearchFactSubject['kind']
  subjectId: string
  status: AnyResearchFactToolEnvelope['status']
  asOf: string | null
  sources: ResearchFactSource[]
  coverage: ResearchFactCoverage
  warnings: string[]
}

export interface ContextResearchFactBundle {
  schemaVersion: 1
  generatedAt: number
  asOf: string | null
  markdown: string
  toolIds: ResearchFactToolId[]
  invocations: ContextResearchFactInvocationSnapshot[]
  evidenceContrast?: ResearchEvidenceContrast
}

export interface BuildStockResearchFactBundleOptions {
  now?: number
  asOf?: string | null
  includePriceHistory?: boolean
}

export interface BuildContextResearchFactBundleOptions {
  now?: number
  asOf?: string | null
  maxCreatedAt?: number | null
}

export type ArticleRound2ResearchFactContext = StockResearchFactBundle

export function buildStockResearchFactBundle(
  db: Database.Database,
  stockCodes: string[],
  options: BuildStockResearchFactBundleOptions = {},
): StockResearchFactBundle {
  const now = options.now ?? Date.now()
  const asOf = normalizeBundleAsOf(options.asOf)
  const codes = normalizeResearchFactStockCodes(stockCodes)
  const invocations: ResearchFactInvocationSnapshot[] = []
  const evidenceInputs: StockResearchEvidenceInput[] = []
  const sections = codes.map((stockCode) => {
    const priceHistory = options.includePriceHistory
      ? executeResearchFactTool(db, 'stock.price_history', {
          stockCode,
          asOf,
          limit: 30,
          minBars: 10,
        }, { now })
      : null
    const trend = executeResearchFactTool(db, 'stock.trend_snapshot', { stockCode, asOf }, { now })
    const fundamentals = executeResearchFactTool(db, 'stock.fundamentals', {
      stockCode,
      asOf,
      financialLimit: 4,
    }, { now })
    const announcements = executeResearchFactTool(db, 'stock.announcements', {
      stockCode,
      asOf,
      limit: 5,
    }, { now })
    const envelopes: AnyResearchFactToolEnvelope[] = [trend, fundamentals, announcements]
    if (priceHistory) envelopes.unshift(priceHistory)
    invocations.push(...envelopes.map((envelope) => invocationSnapshot(stockCode, envelope)))
    evidenceInputs.push({ stockCode, priceHistory, trend, fundamentals, announcements })
    return formatStockFacts(stockCode, trend, fundamentals, announcements, priceHistory)
  })
  const toolIds = codes.length > 0
    ? [
        ...(options.includePriceHistory ? ['stock.price_history' as const] : []),
        ...STOCK_FACT_TOOL_IDS,
      ]
    : []
  const evidenceContrast = buildStockResearchEvidenceContrast(evidenceInputs, {
    generatedAt: now,
    asOf,
  })
  const markdown = `## 统一投研事实底稿
- 工具层：本地只读 research fact tools schema v1
- 已调用：${toolIds.length > 0 ? toolIds.join('、') : '无；当前来源没有可靠证券身份，未猜测股票代码'}
- 时间口径：${asOf ? `统一事实截点=${formatDate(asOf)}` : '本轮读取当前SQLite快照'}；生成时间不是事实日期，事实日期以各工具来源为准。
- 使用约束：工具的ready/partial/missing/blocked与来源的ready/missing/failed必须区别表达；空值保持未知。公告仅为标题索引及本地规则线索，未读取正文；不得据此生成买卖、仓位或目标价。

${evidenceContrast.markdown}

${sections.length > 0 ? sections.join('\n\n') : '- 本轮未执行股票事实工具。'}`
  return {
    schemaVersion: 1,
    generatedAt: now,
    asOf,
    markdown: markdown.slice(0, MAX_CONTEXT_CHARS),
    toolIds,
    stockCodes: codes,
    invocations,
    evidenceContrast,
  }
}

export function buildArticleRound2ResearchFactContext(
  db: Database.Database,
  stockCodes: string[],
  now = Date.now(),
): ArticleRound2ResearchFactContext {
  return buildStockResearchFactBundle(db, stockCodes, { now })
}

export function buildContextResearchFactBundle(
  db: Database.Database,
  subject: ContextResearchFactSubject | null,
  options: BuildContextResearchFactBundleOptions = {},
): ContextResearchFactBundle {
  const now = options.now ?? Date.now()
  const asOf = normalizeBundleAsOf(options.asOf)
  if (!subject) {
    const evidenceContrast = emptyResearchEvidenceContrast(
      now,
      asOf,
      '当前讨论来源没有适用的受信实体，未生成方向性证据对照',
    )
    return {
      schemaVersion: 1,
      generatedAt: now,
      asOf,
      toolIds: [],
      invocations: [],
      evidenceContrast,
      markdown: `## 统一来源实体事实底稿
- 工具层：本地只读 research fact tools schema v1
- 已调用：无；当前讨论来源没有适用的判断历史或产业项目身份。
- 时间口径：${asOf ? `统一事实截点=${formatDate(asOf)}` : '本轮读取当前SQLite快照'}。

${evidenceContrast.markdown}`,
    }
  }

  const result = subject.kind === 'judgment'
    ? executeResearchFactTool(db, 'decision.judgment_history', {
      judgmentId: subject.id,
      asOf,
      limit: 10,
      }, { now, maxCreatedAt: options.maxCreatedAt })
    : executeResearchFactTool(db, 'industry.project_snapshot', {
        projectId: subject.id,
        asOf,
      }, { now })
  const invocation: ContextResearchFactInvocationSnapshot = {
    toolId: result.toolId,
    subjectKind: subject.kind,
    subjectId: subject.id,
    status: result.status,
    asOf: result.asOf,
    sources: result.sources.map((source) => ({ ...source })),
    coverage: { ...result.coverage },
    warnings: [...result.warnings],
  }
  const detail = result.toolId === 'decision.judgment_history'
    ? formatDecisionJudgmentHistory(result as typeof result & { data: DecisionJudgmentHistoryData })
    : formatIndustryProjectSnapshot(result as typeof result & { data: IndustryProjectSnapshotData })
  const evidenceContrast = buildContextResearchEvidenceContrast(
    subject.kind,
    subject.id,
    result,
    { generatedAt: now, asOf },
  )
  const markdown = `## 统一来源实体事实底稿
- 工具层：本地只读 research fact tools schema v1
- 已调用：${result.toolId}
- 时间口径：${asOf ? `统一事实截点=${formatDate(asOf)}` : '本轮读取当前SQLite快照'}；生成时间不是事实时间。
- 使用约束：只消费不可变版本或快照；ready/partial/missing/blocked必须区别表达。截断项、空值和缺失不得由模型记忆补齐。

${evidenceContrast.markdown}

${detail}`
  return {
    schemaVersion: 1,
    generatedAt: now,
    asOf,
    toolIds: [result.toolId],
    invocations: [invocation],
    evidenceContrast,
    markdown: markdown.slice(0, MAX_ENTITY_CONTEXT_CHARS),
  }
}

export function isReusableStockResearchFactBundle(
  value: unknown,
  stockCodes: string[],
  options: Pick<BuildStockResearchFactBundleOptions, 'asOf' | 'includePriceHistory'> = {},
): value is StockResearchFactBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const bundle = value as Partial<StockResearchFactBundle>
  const expectedCodes = normalizeResearchFactStockCodes(stockCodes)
  const expectedAsOf = normalizeBundleAsOf(options.asOf)
  const expectedToolIds: ResearchFactToolId[] = expectedCodes.length > 0
    ? [
        ...(options.includePriceHistory ? ['stock.price_history' as const] : []),
        ...STOCK_FACT_TOOL_IDS,
      ]
    : []
  const invocationsValid = Array.isArray(bundle.invocations)
    && bundle.invocations.length === expectedCodes.length * expectedToolIds.length
    && expectedCodes.every((stockCode, stockIndex) => expectedToolIds.every((toolId, toolIndex) => {
      const invocation = bundle.invocations?.[stockIndex * expectedToolIds.length + toolIndex]
      return invocation?.stockCode === stockCode
        && invocation.toolId === toolId
        && invocation.asOf === expectedAsOf
        && ['ready', 'partial', 'missing', 'blocked'].includes(invocation.status)
        && Array.isArray(invocation.sources)
        && Array.isArray(invocation.warnings)
        && invocation.coverage != null
        && typeof invocation.coverage === 'object'
    }))
  return bundle.schemaVersion === 1
    && typeof bundle.generatedAt === 'number'
    && Number.isFinite(bundle.generatedAt)
    && bundle.asOf === expectedAsOf
    && typeof bundle.markdown === 'string'
    && bundle.markdown.length <= MAX_CONTEXT_CHARS
    && arraysEqual(bundle.stockCodes, expectedCodes)
    && arraysEqual(bundle.toolIds, expectedToolIds)
    && (bundle.evidenceContrast == null || isResearchEvidenceContrast(bundle.evidenceContrast))
    && invocationsValid
}

export function normalizeResearchFactStockCodes(stockCodes: string[]): string[] {
  const normalized = stockCodes.map((rawCode) => {
    const value = rawCode.trim().toUpperCase()
    const match = value.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/)
    if (!match) return null
    const stockCode = match[1]
    const expectedMarket = /^(4|8|92)/.test(stockCode)
      ? 'BJ'
      : /^(5|6|9|11)/.test(stockCode)
        ? 'SH'
        : 'SZ'
    return match[2] && match[2] !== expectedMarket ? null : stockCode
  }).filter((code): code is string => code != null)
  return [...new Set(normalized)].slice(0, MAX_CANDIDATES)
}

function invocationSnapshot(
  stockCode: string,
  envelope: AnyResearchFactToolEnvelope,
): ResearchFactInvocationSnapshot {
  return {
    toolId: envelope.toolId,
    stockCode,
    status: envelope.status,
    asOf: envelope.asOf,
    sources: envelope.sources.map((source) => ({ ...source })),
    coverage: { ...envelope.coverage },
    warnings: [...envelope.warnings],
  }
}

function formatDecisionJudgmentHistory(
  envelope: AnyResearchFactToolEnvelope & { data: DecisionJudgmentHistoryData },
): string {
  const data = envelope.data
  const versionLines = data.versions.length > 0
    ? data.versions.map((version) => {
        const evidence = version.evidence.length > 0
          ? version.evidence.map((item) => `${item.label}=${item.status}（${clip(item.detail, 180)}）`).join('；')
          : '无有界证据条目'
        return `- v${version.versionNumber}@${formatTimestamp(version.createdAt)}：标签=${version.tag}；备注=${clip(version.note || '无', 300)}；来源信号=${version.sourceSignalId ?? '无'}/${version.sourceSignalAvailable ? '当前可追溯' : '当前不可用'}；证据=${evidence}`
      }).join('\n')
    : '- 截点内没有可用判断版本。'
  return `### 判断历史｜${data.stockName ?? data.tsCode ?? data.judgmentId ?? '未知判断'}
- 工具状态：${envelope.status}；来源=${formatSources(envelope)}；截点内版本=${data.totalVersionsAtCutoff}；本次返回=${data.versions.length}
${versionLines}
- 缺口与警告：${envelope.warnings.length > 0 ? envelope.warnings.map((warning) => clip(warning, 200)).join('；') : '无工具级警告'}`
}

function formatIndustryProjectSnapshot(
  envelope: AnyResearchFactToolEnvelope & { data: IndustryProjectSnapshotData },
): string {
  const data = envelope.data
  const project = data.project
  const nodes = data.graph.nodes.length > 0
    ? data.graph.nodes.map((node) => `${node.name}（${node.type}/${node.statementKind}）`).join('；')
    : '无可用节点摘要'
  const hypotheses = data.hypotheses.length > 0
    ? data.hypotheses.map((item) => `${clip(item.statement, 180)}[${item.status}]；最低成本反证=${clip(item.cheapestDisproof, 140)}`).join('；')
    : '无可用假设摘要'
  const evidence = data.evidenceRefs.length > 0
    ? data.evidenceRefs.map((item) => `${clip(item.title, 160)}[${item.statementKind}/${item.primarySourceConfirmed ? '一手已确认' : '一手未确认'}]`).join('；')
    : '无可用证据引用摘要'
  const companies = data.companies.length > 0
    ? data.companies.map((item) => `${item.companyId}[${item.status}]`).join('；')
    : '无可用公司摘要'
  return `### 产业项目快照｜${project?.title ?? data.projectId ?? '未知项目'}
- 工具状态：${envelope.status}；来源=${formatSources(envelope)}；快照=${data.snapshot ? `${data.snapshot.id}@${formatTimestamp(data.snapshot.createdAt)}，原因=${data.snapshot.reason}` : '缺失'}
- 项目边界：${project ? `${project.industryName} / ${project.productScope} / ${project.regionScope} / ${project.timeScope}` : '未知'}
- 图谱：节点${data.graph.nodeCount}、边${data.graph.edgeCount}；有界关键节点=${nodes}
- 证据引用：总数${data.evidenceRefCount}；${evidence}
- 假设：总数${data.hypothesisCount}；${hypotheses}
- 公司：总数${data.companyCount}；${companies}
- 后续事项：总数${data.followUpCount}；本次返回${data.followUps.length}
- 缺口与警告：${envelope.warnings.length > 0 ? envelope.warnings.map((warning) => clip(warning, 200)).join('；') : '无工具级警告'}`
}

function formatStockFacts(
  stockCode: string,
  trend: AnyResearchFactToolEnvelope & { data: StockTrendSnapshotData },
  fundamentals: AnyResearchFactToolEnvelope & { data: StockFundamentalsData },
  announcements: AnyResearchFactToolEnvelope & { data: StockAnnouncementsData },
  priceHistory: (AnyResearchFactToolEnvelope & { data: StockPriceHistoryData }) | null = null,
): string {
  const name = fundamentals.data.profile?.shortName
    ?? fundamentals.data.latestFinancial?.shortName
    ?? trend.data.stockName
    ?? '名称待核验'
  const profile = fundamentals.data.profile
  const financial = fundamentals.data.latestFinancial
  const announcementLines = announcements.data.announcements.length > 0
    ? announcements.data.announcements.map((item) => {
        const tags = item.attentionTags.length > 0 ? `；标题线索=${item.attentionTags.join('/')}` : ''
        return `  - ${formatDate(item.noticeDate)}｜${clip(item.title, 120)}${tags}`
      }).join('\n')
    : '  - 无可用本地公告标题索引'
  const warnings = [
    ...(priceHistory?.warnings ?? []),
    ...trend.warnings,
    ...fundamentals.warnings,
    ...announcements.warnings,
  ]
  const priceLine = priceHistory
    ? `- 日线工具：${priceHistory.status}；事实日=${formatDate(priceHistory.data.bars.at(-1)?.tradeDate)}；覆盖=${priceHistory.coverage.available}/${priceHistory.coverage.required ?? '--'}根；最新收盘=${formatNumber(priceHistory.data.bars.at(-1)?.close)}\n`
    : ''
  return `### ${stockCode}｜${name}
${priceLine}- 趋势工具：${trend.status}；事实日=${formatDate(trend.data.tradeDate)}；覆盖=${trend.coverage.available}/${trend.coverage.required ?? '--'}根；综合分=${formatNumber(trend.data.totalScore)}；有效权重=${formatPercentRatio(trend.data.validWeight)}；状态=${trend.data.trendState}
- 趋势事实：个股20日收益=${formatPercent(trend.data.facts?.stockReturn20d)}；沪深300同期=${formatPercent(trend.data.facts?.benchmarkReturn20d)}；超额=${formatPercent(trend.data.facts?.excessReturn20d)}；20日最大回撤=${formatPercent(trend.data.facts?.maxDrawdown20d)}
- 基本面工具：${fundamentals.status}；来源=${formatSources(fundamentals)}
- 公司身份：${profile
    ? `法定名称=${profile.legalName ?? '未知'}；行业=${profile.industry ?? '未知'}；经营范围=${clip(profile.businessScope ?? '未知', 180)}`
    : '未知或当前截点不可还原'}
- 最新财务：${financial
    ? `报告期=${formatDate(financial.reportDate)}；公告日=${formatDate(financial.noticeDate)}；营收=${formatMoney(financial.totalRevenue)}；归母净利=${formatMoney(financial.parentNetProfit)}；营收同比=${formatPercent(financial.revenueYoy)}；归母净利同比=${formatPercent(financial.parentNetProfitYoy)}；ROE=${formatPercent(financial.weightedRoe)}；资产负债率=${formatPercent(financial.debtRatio)}`
    : '未知'}
- 公告工具：${announcements.status}；来源=${formatSources(announcements)}；以下标签仅由标题规则派生，不代表正文事实或影响方向
${announcementLines}
- 缺口与警告：${warnings.length > 0 ? warnings.map((warning) => clip(warning, 160)).join('；') : '无工具级警告'}`
}

function formatSources(envelope: AnyResearchFactToolEnvelope): string {
  return envelope.sources.length > 0
    ? envelope.sources.map((source) => `${source.id}=${source.status}@${formatDate(source.factDate)}`).join('，')
    : '无'
}

function formatTimestamp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '未知'
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value
}

function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '未知' : Number(value.toFixed(2)).toString()
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function formatPercentRatio(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '未知' : `${Math.round(value * 100)}%`
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知'
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿元`
  if (absolute >= 10_000) return `${(value / 10_000).toFixed(2)}万元`
  return `${Number(value.toFixed(2))}元`
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function normalizeBundleAsOf(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null
  const compact = value.trim().replace(/-/g, '')
  if (!/^\d{8}$/.test(compact)) throw new Error('research fact bundle asOf必须是YYYYMMDD或YYYY-MM-DD')
  const year = Number(compact.slice(0, 4))
  const month = Number(compact.slice(4, 6))
  const day = Number(compact.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('research fact bundle asOf不是有效日期')
  }
  return compact
}

function arraysEqual<T>(actual: T[] | undefined, expected: readonly T[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((item, index) => item === expected[index])
}
