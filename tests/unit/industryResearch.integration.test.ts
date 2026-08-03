import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deterministicState = vi.hoisted(() => ({
  candidateIds: [] as string[],
  failStage: null as string | null,
  markdownPrompt: '',
  reportMetaPrompt: '',
  callCount: 0,
  companyMode: 'exact' as 'exact' | 'ambiguous' | 'unmatched',
}))

vi.mock('../../electron/main/services/aiFallbackService', () => ({
  callWithFallback: vi.fn(async (_db: unknown, input: { prompt: string }) => {
    deterministicState.callCount += 1
    const { prompt } = input
    if (prompt.includes('只输出完整中文 Markdown 正文')) {
      deterministicState.markdownPrompt = prompt
      return {
        provider: 'deterministic-provider',
        model: 'deterministic-report-model',
        text: [
          '# 光纤光缆产业研究报告',
          '',
          '## 一、核心结论',
          '光纤光缆景气需要同时验证供需、价格和公司业务暴露，公开来源只形成估算约束。',
          '',
          '## 二、研究边界',
          '本报告覆盖中国市场近三年，财务数字只读取本地事实。',
          '',
          '## 三、产业链全景',
          '上游预制棒、光纤和光缆依次传导，运营商集采决定需求兑现节奏。',
          '',
          '## 四、供需、价格与景气判断',
          '供给收缩是否转化为价格弹性仍需持续验证。',
          '',
          '## 五、利润池与瓶颈',
          '预制棒良率和有效产能是主要瓶颈。',
          '',
          '## 六、代表公司映射',
          '公司映射只是线索，必须回到公告和本地财务事实。',
          '',
          '## 七、跟踪指标与证伪条件',
          '跟踪集采价格、库存和资本开支，若价格与库存同时转弱则假设失效。',
          '',
          '## 八、资料口径与缺口',
          '当前没有把模型记忆或网页摘要升级为正式财务事实。',
        ].join('\n'),
      }
    }

    const stage = prompt.match(/【当前阶段】(\w+)/)?.[1] || ''
    if (stage === 'report') deterministicState.reportMetaPrompt = prompt
    if (deterministicState.failStage === stage) throw new Error(`deterministic ${stage} failure`)
    const [candidate0, candidate1, candidate2] = deterministicState.candidateIds
    const payloads: Record<string, Record<string, unknown>> = {
      scope: {
        title: '光纤光缆联合研究',
        industryName: '光通信',
        productScope: '光纤光缆',
        regionScope: '中国',
        timeScope: '近三年',
        purpose: 'investment',
        depth: 'standard',
        dataAsOf: '2024-12-31',
        coreQuestions: ['供需与价格如何传导', '公司暴露如何验证'],
      },
      map: {
        nodes: [
          { id: 'node-preform', type: 'material', name: '光纤预制棒', stage: '上游', candidateIds: [candidate0] },
          { id: 'node-fiber', type: 'product', name: '光纤光缆', stage: '中游', candidateIds: [candidate1] },
        ],
        edges: [
          { id: 'edge-preform-fiber', source: 'node-preform', target: 'node-fiber', relation: '成本传导', bottleneck: true, candidateIds: [candidate0, candidate1] },
        ],
      },
      evidence: {
        pendingSources: ['运营商集采成交价原始公告'],
        notes: ['公开来源只约束估算和假设'],
        supportedCandidateIds: [candidate0, candidate1],
      },
      hypothesis: {
        hypotheses: [{
          statement: '有效预制棒供给偏紧可能增强价格弹性',
          cheapestDisproof: '连续两期库存上升且集采价格下行',
          importance: 5,
          verificationMetric: '集采价格与库存',
          threshold: '价格下行且库存上升',
          candidateIds: [candidate0],
        }],
      },
      companies: {
        companies: [deterministicState.companyMode === 'exact' ? {
          legalName: '江苏中天科技股份有限公司',
          displayName: '中天科技',
          rationale: '具备光纤光缆业务暴露，仍需公告与财务事实验证',
          researchNodeIds: ['node-fiber'],
          tsCode: '600522.SH',
          candidateIds: [candidate2],
        } : deterministicState.companyMode === 'ambiguous' ? {
          legalName: '中天相关公司',
          displayName: '中天',
          rationale: '名称存在多个上市证券匹配，必须由用户选择',
          researchNodeIds: ['node-fiber'],
          tsCode: '',
          candidateIds: [candidate2],
        } : {
          legalName: '境外光纤公司',
          displayName: '境外光纤公司',
          rationale: '本地 A 股基础缓存无匹配',
          researchNodeIds: ['node-fiber'],
          tsCode: '',
          candidateIds: [candidate2],
        }],
      },
      report: {
        title: '光纤光缆产业研究报告',
        summary: '供需、价格和公司暴露需要三角验证。',
        supportedFindings: [{ text: '预制棒供给约束可能影响光纤价格弹性', candidateIds: [candidate0, candidate1] }],
        modelOnlyFindings: ['价格传导速度仍属于模型推断'],
        pendingSources: ['运营商集采成交价原始公告'],
        missingSections: [],
        conflicts: [
          '多项候选资料发布于2026年，晚于2024-12-31数据截止日。',
          '媒体口径对需求增速存在差异',
        ],
        candidateIds: deterministicState.candidateIds.slice(0, 14),
      },
    }
    return {
      provider: 'deterministic-provider',
      model: `deterministic-${stage}-model`,
      text: JSON.stringify(payloads[stage] || {}),
    }
  }),
}))

vi.mock('../../electron/main/services/researchToolRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/services/researchToolRuntime')>()
  const repository = await import('../../electron/main/database/industryResearchGenerationRepository')
  return {
    ...actual,
    retrieveResearchEvidenceCandidates: vi.fn(async (
      db: Parameters<typeof actual.retrieveResearchEvidenceCandidates>[0],
      input: Parameters<typeof actual.retrieveResearchEvidenceCandidates>[1],
    ) => {
      const candidates = Array.from({ length: 45 }, (_, index) => repository.upsertEvidenceCandidate(db, {
        id: `${input.runId}-candidate-${index}`,
        projectId: input.projectId,
        runId: input.runId,
        query: `光纤光缆联合检索 ${index}`,
        sourceUrl: `https://example.com/research/${index}`,
        title: `确定性公开来源 ${index}`,
        summary: `用于验证光纤光缆供需、价格和公司暴露的公开来源摘要 ${index}`.padEnd(70, '。'),
        excerpt: `只保存有限摘录，不保存外部网页全文 ${index}`.padEnd(90, '。'),
        providerId: 'deterministic-search',
        status: 'fetched',
        sourceKind: index < 4 ? 'official_detail' : 'web_search',
        isDetailPage: true,
        relevanceScore: 1 - index / 100,
        authorityScore: index < 4 ? 0.95 : 0.65,
        freshnessScore: 0.9,
        rankScore: 1 - index / 120,
      }))
      deterministicState.candidateIds = candidates.map((item) => item.id)
      const selectedTopNIds = deterministicState.candidateIds.slice(0, 14)
      return {
        plan: {
          queries: Array.from({ length: 8 }, (_, index) => ({
            id: `query-${index}`,
            text: `光纤光缆 query ${index}`,
            intent: index % 2 ? 'company_exposure' as const : 'supply_demand_price' as const,
            targetDomains: [],
            rationale: '确定性联合回归',
            hitCount: 5,
            detailUrlCount: 4,
            status: 'executed' as const,
          })),
          officialSeeds: [],
          mode: 'strong' as const,
          localHitCount: 5,
          webHitCount: 40,
          detailPageCount: 45,
          selectedTopN: 14,
          candidatePoolSize: 45,
          degradedCode: null,
          message: '确定性取证已完成 45 条候选评级与精选',
        },
        candidates,
        selectedTopNIds,
        mode: 'strong' as const,
        degradedCode: null,
        message: '确定性取证已完成 45 条候选评级与精选',
      }
    }),
  }
})

import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import { listCompanyCandidates } from '../../electron/main/database/industryResearchGenerationRepository'
import {
  getResearchFinancialSyncState,
  getLatestResearchProfitBridge,
  getResearchSecurityByTsCode,
  listResearchBusinessExposures,
  listResearchFinancialFacts,
  listResearchProjectCompanies,
  listResearchSecurities,
  saveResearchBusinessExposure,
  saveResearchDisclosureEvidence,
  saveResearchFinancialFacts,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject, getResearchGraph, getResearchProject, listResearchEvidence, updateResearchProject } from '../../electron/main/database/industryResearchRepository'
import { upsertAll as upsertStockBasics } from '../../electron/main/database/stockBasicCacheRepository'
import {
  continueIndustryResearchFinancialCollection,
  ensureGeneratedProjectCompanies,
  getGenerationRunView,
  retryIndustryResearchGeneration,
  resolveGenerationDataAsOf,
  resolveIndustryResearchCompanyCandidate,
  startIndustryResearchGeneration,
} from '../../electron/main/services/industryResearchGenerationService'
import { getIndustryResearchFinancialValidation } from '../../electron/main/services/industryResearchFinancialValidationService'
import { buildIndustryResearchMarketContext } from '../../electron/main/services/industryResearchMarketService'
import {
  syncIndustryResearchCompanyFinancials,
  type IndustryResearchFinancialFetchers,
} from '../../electron/main/services/industryResearchFinancialSyncService'
import { saveIndustryResearchProfitBridge } from '../../electron/main/services/industryResearchProfitBridgeService'
import { confirmProjectEvidenceCandidate } from '../../electron/main/services/researchToolRuntime'
import type { SkillMeta } from '../../electron/main/services/skillService'
import type { TushareFinancialRow } from '../../electron/main/services/tushareService'

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

function createProject(db: Database.Database, id: string, title: string): void {
  createResearchProject(db, {
    id,
    title,
    industryName: '光通信',
    productScope: '光纤光缆',
    regionScope: '中国',
    timeScope: '近三年',
    purpose: 'investment',
    depth: 'standard',
    sourceType: 'manual',
    skillId: 'builtin:industry-chain-research',
    skillContentHash: 'a'.repeat(64),
  })
}

function financialRow(
  endDate: string,
  values: Record<string, string | number | null>,
  overrides: Partial<TushareFinancialRow> = {},
): TushareFinancialRow {
  return {
    tsCode: '600522.SH',
    annDate: '20250430',
    fAnnDate: '20250430',
    endDate,
    reportType: '1',
    compType: '1',
    updateFlag: '0',
    values,
    ...overrides,
  }
}

function fetchersWith(overrides: Partial<IndustryResearchFinancialFetchers>): IndustryResearchFinancialFetchers {
  const empty = vi.fn().mockResolvedValue([])
  return {
    income: empty,
    balancesheet: empty,
    cashflow: empty,
    fina_indicator: empty,
    fina_audit: empty,
    forecast: empty,
    express: empty,
    disclosure_date: empty,
    fina_mainbz: empty,
    ...overrides,
  }
}

async function waitForTerminalRun(db: Database.Database, projectId: string, runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const view = getGenerationRunView(db, projectId, runId)
    if (view.run && TERMINAL_RUN_STATUSES.has(view.run.status)) return view
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error(`生成运行 ${runId} 未在预期时间内结束`)
}

describe('产业研究第180阶段联合回归', { timeout: 30_000 }, () => {
  let db: Database.Database
  let tempDir: string
  let dbPath: string
  const skill: SkillMeta = {
    skillId: 'builtin:industry-chain-research',
    name: 'industry-chain-research',
    description: 'deterministic integration skill',
    version: 'test',
    source: 'builtin',
    dirPath: resolve(__dirname, '../../skills/industry-chain-research'),
    contentLength: 1,
    contentHash: 'a'.repeat(64),
    ruleVersion: 'test-rule',
    integrity: 'complete',
  }

  beforeEach(() => {
    deterministicState.candidateIds = []
    deterministicState.failStage = null
    deterministicState.markdownPrompt = ''
    deterministicState.reportMetaPrompt = ''
    deterministicState.callCount = 0
    deterministicState.companyMode = 'exact'
    tempDir = mkdtempSync(join(tmpdir(), 'trade-watch-fr230-integration-'))
    dbPath = join(tempDir, 'research.db')
    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    createProject(db, 'project-main', '光纤光缆联合研究')
    createProject(db, 'project-other', '跨项目归属校验')
    upsertStockBasics(db, [{
      tsCode: '600522.SH',
      name: '中天科技',
      industry: '通信设备',
      market: '主板',
      listStatus: 'L',
      circFloat: null,
      updatedAt: Date.now(),
    }, {
      tsCode: '002989.SZ',
      name: '中天精装',
      industry: '装修装饰',
      market: '主板',
      listStatus: 'L',
      circFloat: null,
      updatedAt: Date.now(),
    }])
  })

  afterEach(() => {
    try { db.close() } catch { /* already closed */ }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('从确定性取证生成报告后完成证据、公司、财务验证并跨重启恢复', async () => {
    const progressStages: string[] = []
    const started = await startIndustryResearchGeneration(db, {
      projectId: 'project-main',
      researchQuestion: '光纤光缆产业链的供需、价格和公司暴露应该如何验证？',
      scope: { enableWebRetrieval: true },
    }, () => skill, {
      createProject: () => ({ id: 'unused' }),
      emitter: (payload) => progressStages.push(payload.stage),
    })
    const completed = await waitForTerminalRun(db, 'project-main', started.run.id)

    expect(completed.run).toMatchObject({ status: 'succeeded', last_successful_stage: 'report' })
    expect(completed.evidenceCandidates).toHaveLength(45)
    expect(completed.evidenceCandidates.every((item) => item.status === 'fetched')).toBe(true)
    expect(completed.reportDocument.markdown).toContain('## 八、资料口径与缺口')
    expect(completed.reportDocument.conflicts).toEqual(['媒体口径对需求增速存在差异'])
    expect(deterministicState.markdownPrompt).not.toContain('2024-12-31')
    expect(deterministicState.markdownPrompt).toContain('统一投研事实底稿')
    expect(deterministicState.markdownPrompt).toContain('确定性证据对照')
    expect(deterministicState.markdownPrompt).toContain('600522')
    expect(deterministicState.reportMetaPrompt).toContain('researchFactsMarkdown')
    expect(deterministicState.reportMetaPrompt).toContain('researchEvidenceContrastMarkdown')
    expect(getResearchProject(db, 'project-main')?.data_as_of).toBe(resolveGenerationDataAsOf(null))
    const completedArtifacts = JSON.parse(completed.run?.stage_artifacts_json || '{}') as {
      researchFacts?: {
        asOf?: string
        stockCodes?: string[]
        toolIds?: string[]
        invocations?: unknown[]
        evidenceContrast?: { subjects?: unknown[] }
      }
      report?: { textAudit?: { documentKind?: string; status?: string; checks?: unknown[] } }
    }
    expect(completedArtifacts.researchFacts).toMatchObject({
      asOf: resolveGenerationDataAsOf(null).replace(/-/g, ''),
      stockCodes: ['600522'],
      toolIds: ['stock.trend_snapshot', 'stock.fundamentals', 'stock.announcements'],
    })
    expect(completedArtifacts.researchFacts?.invocations).toHaveLength(3)
    expect(completedArtifacts.researchFacts?.evidenceContrast?.subjects).toHaveLength(1)
    expect(completedArtifacts.report?.textAudit).toMatchObject({
      documentKind: 'industry_report',
      checks: expect.any(Array),
    })
    expect(completedArtifacts.report?.textAudit?.status).not.toBe('blocked')
    expect(completed.reportPartitions.supportedFindings[0]).toMatchObject({
      text: '预制棒供给约束可能影响光纤价格弹性',
      candidateIds: deterministicState.candidateIds.slice(0, 2),
    })
    expect(Array.from(new Set(progressStages))).toEqual([
      'retrieve', 'scope', 'map', 'evidence', 'hypothesis', 'companies', 'report',
    ])

    const formalCandidateId = deterministicState.candidateIds[0]
    confirmProjectEvidenceCandidate(db, 'project-main', formalCandidateId, 'confirm')
    confirmProjectEvidenceCandidate(db, 'project-main', formalCandidateId, 'confirm')
    expect(listResearchEvidence(db, 'project-main').find((item) => item.source_url === 'https://example.com/research/0'))
      .toMatchObject({ statement_kind: 'estimate', primary_source_confirmed: 0, created_by: 'human' })
    expect(() => confirmProjectEvidenceCandidate(db, 'project-other', formalCandidateId, 'confirm'))
      .toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))

    const companyCandidate = completed.companyCandidates[0]
    expect(companyCandidate).toMatchObject({ display_name: '中天科技', resolution_status: 'accepted' })
    expect(listResearchProjectCompanies(db, 'project-main')).toHaveLength(1)
    resolveIndustryResearchCompanyCandidate(db, {
      projectId: 'project-main',
      runId: started.run.id,
      candidateId: companyCandidate.id,
      action: 'accept',
      securityTsCode: '600522.SH',
    })
    const projectCompany = listResearchProjectCompanies(db, 'project-main')[0]
    const primarySecurity = listResearchSecurities(db, projectCompany.company_id)[0]
    expect(primarySecurity).toMatchObject({ ts_code: '600522.SH', mapping_source: 'tushare', list_status: 'L' })
    upsertDailyClose(db, [
      { tsCode: '600522.SH', tradeDate: '20260716', open: 12, high: 12.5, low: 11.8, close: 12.2, pctChg: 1, vol: 100, turnoverRate: 1 },
      { tsCode: '600522.SH', tradeDate: '20260717', open: 12.2, high: 12.8, low: 12.1, close: 12.6, pctChg: 3.28, vol: 120, turnoverRate: 1.2 },
      { tsCode: '000001.SH', tradeDate: '20260716', open: 3500, high: 3520, low: 3490, close: 3510, pctChg: 0.2, vol: 1000, turnoverRate: null },
      { tsCode: '000001.SH', tradeDate: '20260717', open: 3510, high: 3540, low: 3505, close: 3530, pctChg: 0.57, vol: 1100, turnoverRate: null },
    ])
    const localMarket = buildIndustryResearchMarketContext(db, {
      projectId: 'project-main', companyId: projectCompany.company_id,
      securityId: primarySecurity.id, valuationDate: '2026-07-20',
    })
    expect(localMarket).toMatchObject({
      tsCode: '600522.SH', marketDate: '20260717', rawClose: 12.6, status: 'degraded',
    })
    expect(localMarket.reasons).toContainEqual(expect.objectContaining({ code: 'ADJUSTMENT_FACTOR_MISSING' }))
    saveResearchSecurity(db, {
      id: 'security-h-share',
      companyId: projectCompany.company_id,
      tsCode: '0763.HK',
      exchange: 'HKEX',
      securityType: 'H_SHARE',
      mappingSource: 'manual',
    })
    expect(listResearchSecurities(db, projectCompany.company_id).map((item) => item.ts_code).sort())
      .toEqual(['0763.HK', '600522.SH'])

    const graph = getResearchGraph(db, 'project-main')
    saveResearchDisclosureEvidence(db, {
      id: 'official-annual-report',
      projectId: 'project-main',
      companyId: projectCompany.company_id,
      title: '中天科技2024年年度报告',
      sourceUrl: 'https://example.com/official/annual-report.pdf',
      publishedDate: '2025-04-30',
      actualPublishedDate: '2025-04-30',
      excerpt: '光通信网络产品收入与产能信息',
      createdBy: 'human',
      primarySourceConfirmed: true,
    })
    saveResearchBusinessExposure(db, {
      id: 'exposure-optical-fiber',
      projectId: 'project-main',
      companyId: projectCompany.company_id,
      researchNodeId: graph.nodes.find((item) => item.name === '光纤光缆')?.id,
      evidenceId: 'official-annual-report',
      evidenceIds: ['official-annual-report'],
      sourceKey: 'annual-report-optical-fiber',
      sourceType: 'manual',
      status: 'confirmed',
      exposurePct: 36.5,
      basis: '依据年报分部口径确认光纤光缆业务暴露',
      createdBy: 'human',
      factDate: '20241231',
      methodology: '按年报分部收入占比映射',
    })

    saveResearchFinancialFacts(db, [{
      id: 'old-income-fact',
      companyId: projectCompany.company_id,
      securityId: primarySecurity.id,
      sourceApi: 'income',
      sourceFactKey: 'old-income',
      sourceVersion: 'v1',
      metricName: 'revenue',
      metricValue: 400,
      reportPeriod: '20231231',
      fetchedAt: 100,
    }])
    const syncResult = await syncIndustryResearchCompanyFinancials(db, 'deterministic-token', {
      projectId: 'project-main',
      companyId: projectCompany.company_id,
      securityId: primarySecurity.id,
      tsCode: '600522.SH',
      datasets: ['income', 'balancesheet', 'cashflow'],
    }, 200, fetchersWith({
      income: vi.fn().mockRejectedValue(new Error('TUSHARE_QUOTA_INSUFFICIENT')),
      balancesheet: vi.fn().mockResolvedValue([
        financialRow('20241231', {
          total_assets: 1000,
          total_liab: 300,
          accounts_receiv: 120,
          inventories: 80,
          contract_assets: 30,
        }),
      ]),
      cashflow: vi.fn().mockResolvedValue([
        financialRow('20240930', { n_cashflow_act: 90 }),
      ]),
    }))
    expect(syncResult.status).toBe('partial')
    expect(syncResult.datasets).toMatchObject([
      { dataset: 'income', status: 'failed', errorCode: 'PERMISSION_REQUIRED' },
      { dataset: 'balancesheet', status: 'success', errorCode: null },
      { dataset: 'cashflow', status: 'success', errorCode: null },
    ])
    const financialFacts = listResearchFinancialFacts(db, projectCompany.company_id)
    expect(financialFacts.find((item) => item.id === 'old-income-fact')).toMatchObject({ metric_value: 400 })
    expect(financialFacts.find((item) => item.metric_name === 'n_cashflow_act_single_quarter'))
      .toMatchObject({ metric_value: null, derivation_status: 'blocked' })
    expect(getResearchFinancialSyncState(db, projectCompany.company_id, 'income')).toMatchObject({
      status: 'failed', last_error_code: 'PERMISSION_REQUIRED',
    })

    const validation = getIndustryResearchFinancialValidation(db, 'project-main', projectCompany.company_id)
    expect(validation.coverage.recentAnnualPeriods).toContain('20241231')
    expect(validation.quality.inventory.value).toBe(80)
    expect(validation.coverage.latestForecastOrExpressReason).toBe('本地事实中缺少预告或快报')
    expect(listResearchBusinessExposures(db, 'project-main', projectCompany.company_id)).toMatchObject([
      { id: 'exposure-optical-fiber', status: 'confirmed', fact_date: '20241231' },
    ])

    const inputFact = financialFacts.find((item) => item.metric_name === 'total_assets')!
    const firstBridge = saveIndustryResearchProfitBridge(db, 'project-main', projectCompany.company_id, {
      bridgeKey: 'annual:optical-fiber',
      basePeriod: '20231231',
      targetPeriod: '20241231',
      status: 'estimate',
      formula: '目标利润 = 基期利润 + 价格影响 + 销量影响',
      inputFactIds: [inputFact.id],
      evidenceIds: ['official-annual-report'],
      items: [{ key: 'price', label: '价格影响', amount: 12, unit: 'CNY', methodology: '按年报与集采口径估算' }],
      createdBy: 'human',
    }, null, 300)
    expect(() => saveIndustryResearchProfitBridge(db, 'project-main', projectCompany.company_id, {
      bridgeKey: 'annual:optical-fiber',
      basePeriod: '20231231',
      targetPeriod: '20241231',
      status: 'estimate',
      formula: '目标利润 = 基期利润 + 价格影响',
      inputFactIds: [inputFact.id],
      items: [{ key: 'price', label: '价格影响', amount: 15 }],
      createdBy: 'human',
    }, firstBridge.updatedAt - 1, 310)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }))

    db.close()
    db = new Database(dbPath)
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({
      version: DATABASE_MIGRATIONS.at(-1)?.version,
    })
    expect(getGenerationRunView(db, 'project-main', started.run.id).run?.status).toBe('succeeded')
    expect(listResearchProjectCompanies(db, 'project-main')).toHaveLength(1)
    expect(listResearchFinancialFacts(db, projectCompany.company_id).find((item) => item.id === 'old-income-fact'))
      .toMatchObject({ metric_value: 400 })
    expect(getLatestResearchProfitBridge(db, 'project-main', projectCompany.company_id, 'annual:optical-fiber'))
      .toMatchObject({ version: 1, status: 'estimate' })
  })

  it('相同模型节点 ID 在不同项目中会映射为不同的稳定项目级 ID', async () => {
    const first = await startIndustryResearchGeneration(db, {
      projectId: 'project-main',
      researchQuestion: '验证同一图谱模板在主项目中的项目级节点标识。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    const firstCompleted = await waitForTerminalRun(db, 'project-main', first.run.id)

    const second = await startIndustryResearchGeneration(db, {
      projectId: 'project-other',
      researchQuestion: '验证同一图谱模板在另一个项目中的项目级节点标识。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    const secondCompleted = await waitForTerminalRun(db, 'project-other', second.run.id)

    expect(firstCompleted.run?.status).toBe('succeeded')
    expect(secondCompleted.run?.status).toBe('succeeded')
    const firstGraph = getResearchGraph(db, 'project-main')
    const secondGraph = getResearchGraph(db, 'project-other')
    expect(firstGraph.nodes).toHaveLength(2)
    expect(secondGraph.nodes).toHaveLength(2)
    expect(firstGraph.nodes.map((node) => node.id)).not.toEqual(secondGraph.nodes.map((node) => node.id))
    expect(firstGraph.nodes.every((node) => /^node_[0-9a-f]{20}$/.test(node.id))).toBe(true)
    expect(secondGraph.nodes.every((node) => /^node_[0-9a-f]{20}$/.test(node.id))).toBe(true)
    const firstCompany = listResearchProjectCompanies(db, 'project-main')[0]
    const secondCompany = listResearchProjectCompanies(db, 'project-other')[0]
    expect(firstCompany.company_id).toBe(secondCompany.company_id)
    expect(getResearchSecurityByTsCode(db, '600522.SH')?.company_id).toBe(firstCompany.company_id)
  })

  it('歧义或无匹配证券的公司线索不会自动登记为项目公司', async () => {
    deterministicState.companyMode = 'ambiguous'
    const ambiguous = await startIndustryResearchGeneration(db, {
      projectId: 'project-main',
      researchQuestion: '验证名称歧义的公司候选不会被系统猜测证券代码。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    const ambiguousCompleted = await waitForTerminalRun(db, 'project-main', ambiguous.run.id)

    expect(ambiguousCompleted.run?.status).toBe('succeeded')
    expect(ambiguousCompleted.companyCandidates[0]).toMatchObject({ resolution_status: 'pending' })
    expect(JSON.parse(ambiguousCompleted.companyCandidates[0].matched_securities_json)).toHaveLength(2)
    expect(listResearchProjectCompanies(db, 'project-main')).toHaveLength(0)

    deterministicState.companyMode = 'unmatched'
    const unmatched = await startIndustryResearchGeneration(db, {
      projectId: 'project-other',
      researchQuestion: '验证本地无匹配的境外公司不会被自动登记为 A 股公司。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    const unmatchedCompleted = await waitForTerminalRun(db, 'project-other', unmatched.run.id)

    expect(unmatchedCompleted.companyCandidates[0]).toMatchObject({ resolution_status: 'unmatched' })
    expect(listResearchProjectCompanies(db, 'project-other')).toHaveLength(0)
  })

  it('历史成功运行缺少项目公司时可幂等补登记且不调用模型', async () => {
    const started = await startIndustryResearchGeneration(db, {
      projectId: 'project-main',
      researchQuestion: '验证历史成功报告的公司候选可以用本地证券缓存补登记。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    await waitForTerminalRun(db, 'project-main', started.run.id)
    const candidate = listCompanyCandidates(db, { projectId: 'project-main', runId: started.run.id })[0]
    const companyId = listResearchProjectCompanies(db, 'project-main')[0].company_id
    db.prepare('DELETE FROM industry_research_project_companies WHERE project_id = ? AND company_id = ?')
      .run('project-main', companyId)
    db.prepare("UPDATE industry_research_company_candidates SET resolution_status = 'pending' WHERE id = ?")
      .run(candidate.id)
    const callCountBeforeRepair = deterministicState.callCount

    expect(ensureGeneratedProjectCompanies(db, 'project-main')).toBe(1)
    expect(ensureGeneratedProjectCompanies(db, 'project-main')).toBe(0)
    expect(deterministicState.callCount).toBe(callCountBeforeRepair)
    expect(listResearchProjectCompanies(db, 'project-main')).toHaveLength(1)
    expect(listCompanyCandidates(db, { projectId: 'project-main', runId: started.run.id })[0])
      .toMatchObject({ resolution_status: 'accepted' })

    resolveIndustryResearchCompanyCandidate(db, {
      projectId: 'project-main', runId: started.run.id, candidateId: candidate.id,
      action: 'exclude', exclusionReason: '用户确认不纳入当前项目',
    })
    expect(listResearchProjectCompanies(db, 'project-main')[0]).toMatchObject({
      status: 'excluded', exclusion_reason: '用户确认不纳入当前项目',
    })
    expect(ensureGeneratedProjectCompanies(db, 'project-main')).toBe(0)
    expect(listCompanyCandidates(db, { projectId: 'project-main', runId: started.run.id })[0])
      .toMatchObject({ resolution_status: 'excluded' })
  })

  it('报告已生成但项目写回失败时复用原运行恢复且不再次调用模型', async () => {
    updateResearchProject(db, 'project-main', { title: '写回前保留标题' })
    db.exec(`
      CREATE TRIGGER force_graph_persist_failure
      BEFORE INSERT ON industry_research_nodes
      WHEN NEW.project_id = 'project-main'
      BEGIN
        SELECT RAISE(ABORT, 'forced graph persistence failure');
      END
    `)
    const started = await startIndustryResearchGeneration(db, {
      projectId: 'project-main',
      researchQuestion: '验证完整报告生成后项目写回失败时能够零 Token 恢复。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    const failed = await waitForTerminalRun(db, 'project-main', started.run.id)

    expect(failed.run).toMatchObject({
      status: 'failed',
      current_stage: 'report',
      last_successful_stage: 'companies',
      error_code: 'GENERATION_PERSIST_FAILED',
      retryable: 1,
    })
    expect(failed.reportDocument.markdown).toContain('## 八、资料口径与缺口')
    expect(getResearchGraph(db, 'project-main')).toMatchObject({ nodes: [], edges: [] })
    expect(listResearchProjectCompanies(db, 'project-main')).toMatchObject([{
      status: 'candidate',
      short_name: '中天科技',
    }])
    expect(getResearchProject(db, 'project-main')?.title).toBe('写回前保留标题')
    const failedArtifacts = JSON.parse(failed.run?.stage_artifacts_json || '{}') as {
      map?: { idNamespace?: string; nodeAliases?: Record<string, string>; nodes?: unknown[] }
    }
    expect(failedArtifacts.map).toMatchObject({
      idNamespace: 'project_v1',
      nodeAliases: expect.objectContaining({ 'node-fiber': expect.stringMatching(/^node_/) }),
      nodes: expect.any(Array),
    })
    const callCountBeforeRecovery = deterministicState.callCount

    db.exec('DROP TRIGGER force_graph_persist_failure')
    const recovered = await retryIndustryResearchGeneration(
      db,
      'project-main',
      started.run.id,
      () => null,
    )

    expect(recovered).toMatchObject({
      id: started.run.id,
      status: 'succeeded',
      last_successful_stage: 'report',
      retryable: 0,
    })
    expect(deterministicState.callCount).toBe(callCountBeforeRecovery)
    expect(getResearchProject(db, 'project-main')?.title).toBe('光纤光缆联合研究')
    const recoveredGraph = getResearchGraph(db, 'project-main')
    expect(recoveredGraph.nodes).toHaveLength(2)
    expect(recoveredGraph.edges).toHaveLength(1)
    expect(listResearchProjectCompanies(db, 'project-main')).toHaveLength(1)
    const companyCandidate = listCompanyCandidates(db, { projectId: 'project-main', runId: started.run.id })[0]
    const companyNodeIds = JSON.parse(companyCandidate.research_node_ids_json) as string[]
    expect(companyNodeIds).toEqual([recoveredGraph.nodes.find((node) => node.name === '光纤光缆')?.id])
    const recoveredArtifacts = JSON.parse(recovered.stage_artifacts_json) as {
      persistenceRecovery?: { reusedGeneratedArtifacts?: boolean; status?: string }
    }
    expect(recoveredArtifacts.persistenceRecovery).toMatchObject({
      reusedGeneratedArtifacts: true,
      status: 'succeeded',
    })
  })

  it('财务采集进程中断后从公司阶段继续且不重复前置模型阶段', async () => {
    const started = await startIndustryResearchGeneration(db, {
      projectId: 'project-main',
      researchQuestion: '验证公司映射后的财务采集可以在中断后继续并更新报告。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    const completed = await waitForTerminalRun(db, 'project-main', started.run.id)
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0))
    const artifacts = JSON.parse(completed.run?.stage_artifacts_json || '{}') as Record<string, unknown>
    const originalResearchFacts = artifacts.researchFacts
    expect(originalResearchFacts).toEqual(expect.objectContaining({ stockCodes: ['600522'] }))
    upsertDailyClose(db, [{
      tsCode: '600522.SH', tradeDate: '20260720', open: 13, high: 13.5, low: 12.8,
      close: 13.2, pctChg: 1.5, vol: 150, turnoverRate: 1.4,
    }])
    artifacts.financialCollection = {
      status: 'running',
      source: 'tushare',
      totalCompanies: 1,
      completedCompanies: 0,
      totalDatasets: 9,
      coveredDatasets: 0,
      failedDatasets: 0,
      pendingDatasets: 9,
      attemptedDatasets: 1,
      skippedDatasets: 0,
      currentCompanyId: listResearchProjectCompanies(db, 'project-main')[0].company_id,
      currentCompanyName: '亨通光电',
      currentTsCode: '600487.SH',
      currentDataset: 'income',
      errorCode: null,
      message: '正在采集 income',
      startedAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
      completedAt: null,
      companies: [],
    }
    delete artifacts.report
    db.prepare(`
      UPDATE industry_research_generation_runs
      SET status = 'running', current_stage = 'companies', last_successful_stage = 'companies',
          progress_current = 6, progress_message = '正在采集 income', completed_at = NULL,
          stage_artifacts_json = ?
      WHERE id = ?
    `).run(JSON.stringify(artifacts), started.run.id)

    const interrupted = getGenerationRunView(db, 'project-main', started.run.id)
    expect(interrupted.run).toMatchObject({
      status: 'failed',
      error_code: 'GENERATION_INTERRUPTED',
      retryable: 1,
    })
    const callsBeforeResume = deterministicState.callCount
    continueIndustryResearchFinancialCollection(db, 'project-main', started.run.id, () => skill)
    const resumed = await waitForTerminalRun(db, 'project-main', started.run.id)

    expect(resumed.run).toMatchObject({ status: 'succeeded', last_successful_stage: 'report' })
    expect(deterministicState.callCount - callsBeforeResume).toBe(2)
    expect(resumed.reportDocument.markdown).toContain('## 公司财务数据覆盖')
    expect((JSON.parse(resumed.run?.stage_artifacts_json || '{}') as {
      financialCollection?: { status?: string; errorCode?: string }
    }).financialCollection).toMatchObject({
      status: 'blocked',
      errorCode: 'FINANCIAL_SOURCE_DISABLED',
    })
    expect((JSON.parse(resumed.run?.stage_artifacts_json || '{}') as {
      researchFacts?: unknown
    }).researchFacts).toEqual(originalResearchFacts)
  })

  it('生成中途失败时保留最后成功阶段且不提前覆盖项目图谱', async () => {
    deterministicState.failStage = 'hypothesis'
    updateResearchProject(db, 'project-main', { dataAsOf: '2025-12-31' })
    const started = await startIndustryResearchGeneration(db, {
      projectId: 'project-main',
      researchQuestion: '验证生成中途失败时是否保留可恢复阶段产物和最后成功项目事实。',
      scope: { enableWebRetrieval: true },
    }, () => skill, { createProject: () => ({ id: 'unused' }) })
    const failed = await waitForTerminalRun(db, 'project-main', started.run.id)

    expect(JSON.parse(failed.run?.scope_json || '{}').dataAsOf).toBe('2025-12-31')
    expect((JSON.parse(failed.run?.stage_artifacts_json || '{}').scope as { dataAsOf?: string }).dataAsOf).toBe('2025-12-31')

    expect(failed.run).toMatchObject({
      status: 'failed',
      current_stage: 'hypothesis',
      last_successful_stage: 'evidence',
      error_code: 'GENERATION_PROVIDER_FAILED',
      retryable: 1,
    })
    expect(failed.evidenceCandidates).toHaveLength(45)
    const failedArtifacts = JSON.parse(failed.run?.stage_artifacts_json || '{}') as Record<string, unknown>
    expect(failedArtifacts).toEqual(expect.objectContaining({
      retrieve: expect.any(Object),
      scope: expect.any(Object),
      map: expect.any(Object),
      evidence: expect.any(Object),
    }))
    expect(failedArtifacts).not.toHaveProperty('hypothesis')
    expect(getResearchGraph(db, 'project-main')).toMatchObject({ nodes: [], edges: [] })
  })
})
