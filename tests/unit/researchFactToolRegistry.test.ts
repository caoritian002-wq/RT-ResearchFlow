import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { saveDecisionJudgmentVersion } from '../../electron/main/database/decisionJudgmentRepository'
import { saveResearchSnapshot } from '../../electron/main/database/industryResearchChangeRepository'
import { createResearchProject, getResearchProject } from '../../electron/main/database/industryResearchRepository'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import { addPortfolioStock, updatePortfolioCostPrice } from '../../electron/main/database/portfolioRepository'
import {
  recordStockFundamentalSyncSuccess,
  recordStockFundamentalSyncFailure,
  replaceStockFundamentalAnnouncements,
  saveStockFundamentalFinancials,
  upsertStockFundamentalProfile,
} from '../../electron/main/database/stockFundamentalRepository'
import { upsertStockInfo } from '../../electron/main/database/stockPriceCacheRepository'
import {
  buildArticleRound2ResearchFactContext,
  buildContextResearchFactBundle,
  buildStockResearchFactBundle,
  isReusableStockResearchFactBundle,
} from '../../electron/main/services/researchFactPromptService'
import {
  executeResearchFactTool,
  executeResearchFactToolUnsafe,
  listResearchFactTools,
} from '../../electron/main/services/researchFactToolRegistry'

const NOW = Date.parse('2026-07-29T02:00:00.000Z')

describe('FR-254 unified research fact tools', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
  })

  it('registers eight fixed read-only tools and blocks unknown tools and fields', () => {
    expect(listResearchFactTools().map((tool) => tool.id)).toEqual([
      'stock.price_history',
      'stock.trend_snapshot',
      'stock.fundamentals',
      'stock.announcements',
      'portfolio.holdings',
      'news.recent_briefings',
      'decision.judgment_history',
      'industry.project_snapshot',
    ])

    expect(executeResearchFactToolUnsafe(db, 'database.query', {}, { now: NOW })).toMatchObject({
      schemaVersion: 1,
      toolId: 'database.query',
      status: 'blocked',
      warnings: ['UNKNOWN_TOOL: 未知投研事实工具'],
      data: null,
    })
    expect(executeResearchFactToolUnsafe(db, 'stock.price_history', {
      stockCode: '600519',
      url: 'https://example.com',
    }, { now: NOW })).toMatchObject({
      status: 'blocked',
      warnings: ['INVALID_INPUT: 包含不支持的字段：url'],
    })
    expect(executeResearchFactToolUnsafe(db, 'industry.project_snapshot', {
      projectId: 'project-1',
      table: 'industry_research_projects',
    }, { now: NOW })).toMatchObject({
      status: 'blocked',
      warnings: ['INVALID_INPUT: 包含不支持的字段：table'],
    })
  })

  it('merges bounded local price facts, applies asOf to stock and benchmark, and never writes', () => {
    upsertStockInfo(db, '600519', '贵州茅台')
    seedDaily(db, '600519.SH', 80, 100)
    seedDaily(db, '000300.SH', 80, 4000)
    const cutoff = ymdAt(50)
    const totalChangesBefore = totalChanges(db)

    const prices = executeResearchFactTool(db, 'stock.price_history', {
      stockCode: '600519',
      asOf: cutoff,
      limit: 30,
      minBars: 10,
    }, { now: NOW })
    expect(prices).toMatchObject({
      schemaVersion: 1,
      toolId: 'stock.price_history',
      status: 'ready',
      asOf: cutoff,
      coverage: { available: 30, required: 10, unit: 'bars' },
      data: { stockCode: '600519', tsCode: '600519.SH', stockName: '贵州茅台' },
    })
    expect(prices.data.bars.at(-1)?.tradeDate).toBe(cutoff)
    expect(prices.data.bars.every((bar) => bar.tradeDate <= cutoff)).toBe(true)

    const trend = executeResearchFactTool(db, 'stock.trend_snapshot', {
      stockCode: '600519.SH',
      asOf: cutoff,
    }, { now: NOW })
    expect(trend).toMatchObject({
      toolId: 'stock.trend_snapshot',
      status: 'partial',
      asOf: cutoff,
      coverage: { available: 51, required: 60, unit: 'bars' },
      data: {
        tradeDate: cutoff,
        bars: 51,
        requiredBars: 60,
        benchmark: { tsCode: '000300.SH', tradeDate: cutoff, bars: 51, status: 'ready' },
      },
    })
    expect(trend.data.totalScore).not.toBeNull()
    expect(trend.data.facts?.benchmarkReturn20d).not.toBeNull()
    expect(totalChanges(db)).toBe(totalChangesBefore)
  })

  it('cuts financials and announcements at asOf and refuses to project the current profile backwards', () => {
    seedFundamentals(db)
    const totalChangesBefore = totalChanges(db)

    const current = executeResearchFactTool(db, 'stock.fundamentals', {
      stockCode: '600519',
      financialLimit: 4,
    }, { now: NOW })
    expect(current).toMatchObject({
      status: 'ready',
      data: {
        profile: { legalName: '贵州茅台酒股份有限公司' },
        latestFinancial: { reportDate: '20260630', noticeDate: '20260720' },
      },
    })

    const historical = executeResearchFactTool(db, 'stock.fundamentals', {
      stockCode: '600519',
      asOf: '20260430',
      financialLimit: 4,
    }, { now: NOW })
    expect(historical).toMatchObject({
      status: 'partial',
      asOf: '20260430',
      coverage: { available: 1, required: 2, unit: 'datasets' },
      data: {
        profile: null,
        latestFinancial: { reportDate: '20260331', noticeDate: '20260420' },
      },
    })
    expect(historical.data.financialHistory).toHaveLength(1)
    expect(historical.warnings).toContain('公司概况未保存历史版本，本次截点查询不返回当前概况')

    const announcements = executeResearchFactTool(db, 'stock.announcements', {
      stockCode: '600519',
      asOf: '20260430',
      limit: 10,
    }, { now: NOW })
    expect(announcements.status).toBe('ready')
    expect(announcements.data.announcements.map((item) => item.articleCode)).toEqual(['AN-OLD'])
    expect(announcements.data.announcements[0].attentionTags).toContain('major')
    expect(totalChanges(db)).toBe(totalChangesBefore)

    recordStockFundamentalSyncFailure(db, '600519.SH', 'announcement', NOW + 1, 'ANNOUNCEMENT_HTTP_ERROR')
    const changesAfterFailureRecorded = totalChanges(db)
    const staleAfterFailure = executeResearchFactTool(db, 'stock.announcements', {
      stockCode: '600519',
      limit: 10,
    }, { now: NOW + 2 })
    expect(staleAfterFailure).toMatchObject({
      status: 'partial',
      sources: [{ status: 'failed' }],
      data: { announcements: [{ articleCode: 'AN-NEW' }, { articleCode: 'AN-OLD' }] },
    })
    expect(staleAfterFailure.warnings[0]).toContain('已有事实未被删除')
    expect(totalChanges(db)).toBe(changesAfterFailureRecorded)
  })

  it('labels holdings as current-only and applies date, rating and text filters to local briefings', () => {
    addPortfolioStock(db, '600519.SH', '贵州茅台')
    updatePortfolioCostPrice(db, '600519.SH', 1500)
    seedBriefing(db, {
      id: 1,
      title: '白酒行业政策跟踪',
      summary: '贵州茅台相关行业事实',
      date: '2026-04-20',
      impactRating: 'IMPORTANT',
    })
    seedBriefing(db, {
      id: 2,
      title: '未来政策资料',
      summary: '截点之后不得出现',
      date: '2026-07-20',
      impactRating: 'IMPORTANT',
    })
    seedBriefing(db, {
      id: 3,
      title: '一般市场资料',
      summary: '不匹配关键词',
      date: '2026-04-19',
      impactRating: 'GENERAL',
    })
    const totalChangesBefore = totalChanges(db)

    const holdings = executeResearchFactTool(db, 'portfolio.holdings', {}, { now: NOW })
    expect(holdings).toMatchObject({
      status: 'ready',
      asOf: null,
      data: {
        snapshotKind: 'current-only',
        holdings: [{ tsCode: '600519.SH', stockName: '贵州茅台', costPrice: 1500 }],
      },
    })
    expect(holdings.warnings).toContain('仅代表当前持仓，不支持历史持仓还原')

    const news = executeResearchFactTool(db, 'news.recent_briefings', {
      asOf: '20260430',
      impactRating: 'IMPORTANT',
      query: '贵州茅台',
      limit: 20,
    }, { now: NOW })
    expect(news).toMatchObject({
      status: 'ready',
      asOf: '20260430',
      coverage: { available: 1, unit: 'briefings' },
      data: { items: [{ id: 1, publishedDateBJ: '2026-04-20' }] },
    })
    expect(news.data.items.some((item) => item.id === 2)).toBe(false)
    expect(totalChanges(db)).toBe(totalChangesBefore)
  })

  it('reads bounded judgment versions at asOf without leaking a future judgment group', () => {
    const firstAt = Date.parse('2026-04-20T01:00:00.000Z')
    const secondAt = Date.parse('2026-07-20T01:00:00.000Z')
    const first = saveDecisionJudgmentVersion(db, judgmentInput({ note: '等待量能确认' }), firstAt)
    const second = saveDecisionJudgmentVersion(db, judgmentInput({
      judgmentGroupId: first.judgmentGroupId,
      tag: 'risk_off',
      note: '七月风险上升',
    }), secondAt)
    const totalChangesBefore = totalChanges(db)

    const historical = executeResearchFactTool(db, 'decision.judgment_history', {
      judgmentId: first.id,
      asOf: '20260430',
      limit: 10,
    }, { now: NOW })
    expect(historical).toMatchObject({
      status: 'ready',
      asOf: '20260430',
      sources: [{ id: 'local.decision_judgments', status: 'ready', factDate: '20260420' }],
      coverage: { available: 1, required: 1, unit: 'versions' },
      data: {
        judgmentId: first.id,
        judgmentGroupId: first.judgmentGroupId,
        totalVersionsAtCutoff: 1,
        versions: [{ id: first.id, versionNumber: 1, note: '等待量能确认' }],
      },
    })

    const hiddenAnchor = executeResearchFactTool(db, 'decision.judgment_history', {
      judgmentId: second.id,
      asOf: '20260430',
    }, { now: NOW })
    expect(hiddenAnchor).toMatchObject({
      status: 'missing',
      coverage: { available: 0, required: 1 },
      data: { judgmentId: second.id, judgmentGroupId: null, versions: [] },
    })
    expect(hiddenAnchor.warnings[0]).toContain('未读取其判断组或截点后的版本')

    const currentBounded = executeResearchFactTool(db, 'decision.judgment_history', {
      judgmentId: first.id,
      limit: 1,
    }, { now: NOW })
    expect(currentBounded).toMatchObject({
      status: 'partial',
      data: {
        totalVersionsAtCutoff: 2,
        versions: [{ id: second.id, versionNumber: 2, note: '七月风险上升' }],
      },
    })
    expect(totalChanges(db)).toBe(totalChangesBefore)
  })

  it('selects an immutable industry snapshot at asOf and projects only bounded snapshot facts', () => {
    createResearchProject(db, {
      id: 'project-fr254',
      title: '光纤产业研究',
      industryName: '光通信',
      productScope: '预制棒与光纤',
      regionScope: '中国',
      timeScope: '2026-2028',
      purpose: 'investment',
      depth: 'deep',
      sourceType: 'manual',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    const project = getResearchProject(db, 'project-fr254')!
    const firstAt = Date.parse('2026-04-20T01:00:00.000Z')
    const secondAt = Date.parse('2026-07-20T01:00:00.000Z')
    saveResearchSnapshot(db, researchSnapshotRow({
      id: 'snapshot-april',
      project,
      createdAt: firstAt,
      nodeName: '预制棒供给',
    }))
    saveResearchSnapshot(db, researchSnapshotRow({
      id: 'snapshot-july',
      previousSnapshotId: 'snapshot-april',
      project,
      createdAt: secondAt,
      nodeName: '七月未来扩产',
    }))
    const totalChangesBefore = totalChanges(db)

    const historical = executeResearchFactTool(db, 'industry.project_snapshot', {
      projectId: 'project-fr254',
      asOf: '20260430',
    }, { now: NOW })
    expect(historical).toMatchObject({
      status: 'ready',
      asOf: '20260430',
      sources: [{ id: 'local.industry_research_snapshots', status: 'ready', factDate: '20260420' }],
      data: {
        projectId: 'project-fr254',
        snapshot: { id: 'snapshot-april', previousSnapshotId: null },
        project: { title: '光纤产业研究', industryName: '光通信' },
        graph: { nodeCount: 1, nodes: [{ name: '预制棒供给' }] },
      },
    })
    expect(JSON.stringify(historical.data)).not.toContain('七月未来扩产')

    const beforeFirst = executeResearchFactTool(db, 'industry.project_snapshot', {
      projectId: 'project-fr254',
      asOf: '20260401',
    }, { now: NOW })
    expect(beforeFirst).toMatchObject({
      status: 'missing',
      data: { projectId: 'project-fr254', snapshot: null, project: null },
    })
    expect(beforeFirst.warnings[0]).toContain('未使用可变的项目当前表替代')
    expect(totalChanges(db)).toBe(totalChangesBefore)

    const bundle = buildContextResearchFactBundle(db, {
      kind: 'industry_project',
      id: 'project-fr254',
    }, { now: NOW, asOf: '20260430' })
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      asOf: '20260430',
      toolIds: ['industry.project_snapshot'],
      invocations: [{
        subjectKind: 'industry_project',
        subjectId: 'project-fr254',
        status: 'ready',
      }],
    })
    expect(bundle.markdown).toContain('预制棒供给')
    expect(bundle.markdown).not.toContain('七月未来扩产')

    const corruptRow = researchSnapshotRow({
      id: 'snapshot-corrupt',
      previousSnapshotId: 'snapshot-july',
      project,
      createdAt: Date.parse('2026-08-20T01:00:00.000Z'),
      nodeName: '不会被解析',
    })
    saveResearchSnapshot(db, { ...corruptRow, snapshot_json: '{broken' })
    expect(executeResearchFactTool(db, 'industry.project_snapshot', {
      projectId: 'project-fr254',
    }, { now: NOW })).toMatchObject({
      status: 'blocked',
      warnings: [expect.stringContaining('CORRUPT_DATA')],
    })
  })

  it('builds a bounded AI fact brief with source states and title-only announcement limits', () => {
    upsertStockInfo(db, '600519', '贵州茅台')
    seedDaily(db, '600519.SH', 70, 100)
    seedDaily(db, '000300.SH', 70, 4000)
    seedFundamentals(db)

    const context = buildArticleRound2ResearchFactContext(db, ['600519', '600519', 'invalid'], NOW)

    expect(context.toolIds).toEqual([
      'stock.trend_snapshot',
      'stock.fundamentals',
      'stock.announcements',
    ])
    expect(context.stockCodes).toEqual(['600519'])
    expect(context.markdown).toContain('统一投研事实底稿')
    expect(context.markdown).toContain('本地只读 research fact tools schema v1')
    expect(context.markdown).toContain('eastmoney.main_finance=ready@2026-07-20')
    expect(context.markdown).toContain('标题线索=major')
    expect(context.markdown).toContain('未读取正文')
    expect(context.markdown).not.toContain('公告正文内容')
    expect(context.markdown.length).toBeLessThanOrEqual(14_000)
  })

  it('records actual stock tool invocations and only reuses an identical bounded snapshot', () => {
    upsertStockInfo(db, '600519', '贵州茅台')
    seedDaily(db, '600519.SH', 70, 100)
    seedDaily(db, '000300.SH', 70, 4000)
    seedFundamentals(db)

    const bundle = buildStockResearchFactBundle(
      db,
      ['600519.SH', '600519', '600519.SZ', '标题中的000001不应被解析'],
      { now: NOW, asOf: '2026-04-15', includePriceHistory: true },
    )

    expect(bundle).toMatchObject({
      schemaVersion: 1,
      generatedAt: NOW,
      asOf: '20260415',
      stockCodes: ['600519'],
      toolIds: [
        'stock.price_history',
        'stock.trend_snapshot',
        'stock.fundamentals',
        'stock.announcements',
      ],
    })
    expect(bundle.invocations).toHaveLength(4)
    expect(bundle.invocations.map((item) => item.toolId)).toEqual(bundle.toolIds)
    expect(bundle.invocations.every((item) => item.stockCode === '600519' && item.asOf === '20260415')).toBe(true)
    expect(bundle.markdown).toContain('统一事实截点=2026-04-15')
    expect(bundle.markdown).toContain('确定性证据对照')
    expect(bundle.evidenceContrast).toMatchObject({
      schemaVersion: 1,
      asOf: '20260415',
      subjects: [{ subjectKind: 'stock', subjectId: '600519' }],
    })
    expect(isReusableStockResearchFactBundle(
      bundle,
      ['600519.SH'],
      { asOf: '20260415', includePriceHistory: true },
    )).toBe(true)
    expect(isReusableStockResearchFactBundle(
      bundle,
      ['600519.SH'],
      { asOf: '20260416', includePriceHistory: true },
    )).toBe(false)
    expect(isReusableStockResearchFactBundle(
      bundle,
      ['600519.SH'],
      { asOf: '20260415' },
    )).toBe(false)
  })
})

function seedDaily(db: Database.Database, tsCode: string, count: number, startPrice: number): void {
  upsertDailyClose(db, Array.from({ length: count }, (_, index) => {
    const close = startPrice + index * 0.2
    return {
      tsCode,
      tradeDate: ymdAt(index),
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.6,
      close,
      pctChg: index === 0 ? 0 : 0.2,
      vol: 1000 + index,
      turnoverRate: 1 + index / 100,
    }
  }))
}

function judgmentInput(overrides: Partial<Parameters<typeof saveDecisionJudgmentVersion>[1]> = {}) {
  return {
    requestId: randomUUID(),
    tsCode: '600000.SH',
    stockName: '浦发银行',
    tag: 'watch' as const,
    note: '等待确认',
    evidenceSnapshot: {
      primaryTitle: '趋势判断',
      primarySummary: '本地事实仍需确认',
      sourceCount: 1,
      maxPriority: 3,
      trustHint: '只读本地快照',
      evidence: [{ key: 'trend', label: '趋势', status: 'ready' as const, detail: '20日趋势可用' }],
    },
    ...overrides,
  }
}

function researchSnapshotRow(input: {
  id: string
  previousSnapshotId?: string | null
  project: ReturnType<typeof getResearchProject> extends infer T ? Exclude<T, null> : never
  createdAt: number
  nodeName: string
}) {
  return {
    id: input.id,
    project_id: input.project.id,
    previous_snapshot_id: input.previousSnapshotId ?? null,
    snapshot_reason: 'project_baseline' as const,
    request_id: null,
    trigger_batch_id: null,
    skill_snapshot_id: null,
    source_session_id: null,
    source_origin_type: 'test',
    source_origin_id: input.project.id,
    source_return_target_json: null,
    schema_version: 1,
    graph_updated_at: input.project.graph_updated_at,
    title: `${input.project.title} · 测试快照`,
    accepted_change_set_count: 0,
    snapshot_json: JSON.stringify({
      schemaVersion: 1,
      project: input.project,
      graph: {
        nodes: [{
          id: `${input.id}-node`,
          type: 'material',
          name: input.nodeName,
          stage: 'upstream',
          statement_kind: 'fact',
          status: 'active',
          last_updated: '20260420',
        }],
        edges: [],
      },
      evidenceRefs: [],
      hypotheses: [],
      companies: [],
      followUps: [],
    }),
    created_at: input.createdAt,
  }
}

function ymdAt(index: number): string {
  return new Date(Date.UTC(2026, 2, 1 + index)).toISOString().slice(0, 10).replace(/-/g, '')
}

function seedFundamentals(db: Database.Database): void {
  upsertStockFundamentalProfile(db, {
    tsCode: '600519.SH',
    stockCode: '600519',
    shortName: '贵州茅台',
    legalName: '贵州茅台酒股份有限公司',
    securityType: 'A股',
    tradeMarket: '上海证券交易所',
    industry: '白酒',
    chairman: null,
    legalRepresentative: null,
    website: null,
    officeAddress: null,
    registeredCapitalWan: null,
    employeeCount: null,
    businessScope: '茅台酒系列产品的生产与销售。',
    companyProfile: '公司专注于酒类产品。',
    source: 'eastmoney-company-survey',
    sourceFactDate: null,
    fetchedAt: NOW,
  })
  saveStockFundamentalFinancials(db, [
    financial('20260331', '20260420', 40_000_000_000),
    financial('20260630', '20260720', 91_000_000_000),
  ])
  replaceStockFundamentalAnnouncements(db, '600519.SH', [
    announcement('AN-OLD', '20260415', '贵州茅台重大事项公告'),
    announcement('AN-NEW', '20260722', '贵州茅台利润分配公告'),
  ])
  recordStockFundamentalSyncSuccess(db, '600519.SH', 'profile', NOW, null, 1)
  recordStockFundamentalSyncSuccess(db, '600519.SH', 'financial', NOW, '20260720', 2)
  recordStockFundamentalSyncSuccess(db, '600519.SH', 'announcement', NOW, '20260722', 2)
}

function financial(reportDate: string, noticeDate: string, revenue: number) {
  return {
    tsCode: '600519.SH',
    stockCode: '600519',
    shortName: '贵州茅台',
    reportDate,
    reportType: '定期报告',
    noticeDate,
    updateDate: noticeDate,
    currency: 'CNY',
    totalRevenue: revenue,
    parentNetProfit: revenue / 2,
    deductedNetProfit: revenue / 2.1,
    revenueYoy: 10,
    parentNetProfitYoy: 12,
    deductedNetProfitYoy: 11,
    weightedRoe: 18,
    grossMargin: 90,
    netMargin: 50,
    debtRatio: 17,
    operatingCashFlow: revenue / 1.8,
    basicEps: 10,
    bookValuePerShare: 100,
    source: 'eastmoney-main-finance' as const,
    sourceVersion: `${reportDate}-v1`,
    fetchedAt: NOW,
  }
}

function announcement(articleCode: string, noticeDate: string, title: string) {
  return {
    tsCode: '600519.SH',
    stockCode: '600519',
    shortName: '贵州茅台',
    articleCode,
    title,
    noticeDate,
    displayAt: NOW,
    categoryCodes: ['001'],
    categoryNames: ['其他'],
    source: 'eastmoney-announcement-index' as const,
    sourceUrl: `https://data.eastmoney.com/notices/detail/600519/${articleCode}.html`,
    fetchedAt: NOW,
  }
}

function seedBriefing(db: Database.Database, input: {
  id: number
  title: string
  summary: string
  date: string
  impactRating: 'CRITICAL' | 'IMPORTANT' | 'GENERAL'
}): void {
  const publishedAt = Date.parse(`${input.date}T01:00:00.000Z`)
  db.prepare(`
    INSERT OR IGNORE INTO sources (
      id, nameCN, nameEN, url, feedUrl, category, authorityWeight,
      isBuiltIn, isEnabled, status, lastScannedAt, successRate,
      parseStrategy, contentSelector, financeSectionFilter
    ) VALUES (1, '测试来源', 'Test Source', 'https://example.com', NULL,
      'CUSTOM', 5, 0, 1, 'ACTIVE', NULL, 1, 'RSS', NULL, NULL)
  `).run()
  db.prepare(`
    INSERT INTO briefings (
      id, sourceId, sourceName, originalUrl, title, summary, fullContent,
      publishedAt, publishedDateBJ, publicationTimeStatus, collectedAt,
      impactRating, impactRatingScore, deduplicationHash, titleSimhash,
      isRead, readAt, scanRunId, isCatchUp
    ) VALUES (?, 1, '测试来源', ?, ?, ?, NULL, ?, ?, 'exact', ?, ?, 80, ?, ?, 0, NULL, NULL, 0)
  `).run(
    input.id,
    `https://example.com/${input.id}`,
    input.title,
    input.summary,
    publishedAt,
    input.date,
    publishedAt + 1000,
    input.impactRating,
    `hash-${input.id}`,
    `simhash-${input.id}`,
  )
}

function totalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value
}
