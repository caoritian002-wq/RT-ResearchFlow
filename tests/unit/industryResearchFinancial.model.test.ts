import { describe, expect, it } from 'vitest'
import {
  adaptBusinessExposures,
  adaptFinancialSyncStates,
  adaptFinancialTimeline,
  adaptFinancialValidation,
  adaptProfitBridge,
  adaptResearchCompanies,
  buildBusinessExposureMatrix,
  buildBusinessExposureOverview,
  buildBusinessExposureTrend,
  formatFinancialAmount,
  formatFinancialMetricValue,
  formatFinancialReportPeriod,
  formatFinancialValue,
  getFinancialMetricLabel,
  safeStringArray,
  shouldPreserveProfitBridgeDraft,
  validateConfirmedExposureDraft,
  validateProfitBridgeDraft,
} from '../../src/components/IndustryResearch/industryResearchFinancialModel'
import type { BusinessExposureDraft, DisclosureEvidence, ProfitBridgeDraft } from '../../src/components/IndustryResearch/industryResearchTypes'

describe('产业研究公司财务前端模型', () => {
  it('适配公司和证券的数据库字段且保留项目状态', () => {
    const companies = adaptResearchCompanies([{
      project_id: 'project-1', company_id: 'company-1', legal_name: '示例股份有限公司', short_name: '示例股份',
      status: 'core', evidence_ids_json: '["evidence-1"]', updated_at: 100,
      trend_score: 82, trend_score_date: '20260720', trend_score_source: 'eod', trend_score_ts_code: '600001.SH',
      securities: [{ id: 'security-1', company_id: 'company-1', ts_code: '600001.SH', exchange: 'SSE', security_type: 'A_SHARE' }],
    }])

    expect(companies).toMatchObject([{
      companyId: 'company-1', projectId: 'project-1', displayName: '示例股份', status: 'core',
      evidenceIds: ['evidence-1'], trendScore: 82, trendScoreDate: '20260720', trendScoreSource: 'eod',
      trendScoreTsCode: '600001.SH', securities: [{ id: 'security-1', tsCode: '600001.SH' }],
    }])
  })

  it('安全解析JSON并让非法值降级为空数组', () => {
    expect(safeStringArray('["fact-1","fact-2"]')).toEqual(['fact-1', 'fact-2'])
    expect(safeStringArray('{bad')).toEqual([])
    expect(safeStringArray([1, 'fact-1', null])).toEqual(['fact-1'])
  })

  it('九数据集固定补全且不借其他状态填充空值', () => {
    const states = adaptFinancialSyncStates([{
      company_id: 'company-1', dataset: 'income', status: 'success', last_success_row_count: 0,
    }], 'company-1')

    expect(states).toHaveLength(9)
    expect(states.map((item) => item.dataset)).toEqual([
      'income', 'balancesheet', 'cashflow', 'fina_indicator', 'fina_audit',
      'forecast', 'express', 'disclosure_date', 'fina_mainbz',
    ])
    expect(states[0]).toMatchObject({ status: 'success', lastSuccessRowCount: 0 })
    expect(states[1]).toMatchObject({ status: 'idle', lastSuccessRowCount: null })
  })

  it('时间轴按来源版本分组并优先实际公告日期排序', () => {
    const timeline = adaptFinancialTimeline([
      {
        id: 'fact-v1-revenue', company_id: 'company-1', security_id: 'security-1', ts_code: '600001.SH',
        source_api: 'income', source_fact_key: 'record-a', source_version: 'v1', metric_name: 'revenue', metric_value: 100,
        ann_date: '20250110', report_period: '20241231', fact_kind: 'reported', derivation_status: 'not_applicable',
      },
      {
        id: 'fact-v1-profit', company_id: 'company-1', security_id: 'security-1', ts_code: '600001.SH',
        source_api: 'income', source_fact_key: 'record-a', source_version: 'v1', metric_name: 'n_income_attr_p', metric_value: null,
        ann_date: '20250110', report_period: '20241231', fact_kind: 'reported', derivation_status: 'not_applicable',
      },
      {
        id: 'fact-v2-revenue', company_id: 'company-1', security_id: 'security-1', ts_code: '600001.SH',
        source_api: 'income', source_fact_key: 'record-a', source_version: 'v2', metric_name: 'revenue', metric_value: 120,
        ann_date: '20250109', f_ann_date: '20250112', report_period: '20241231', fact_kind: 'reported', derivation_status: 'not_applicable',
      },
    ])

    expect(timeline).toHaveLength(2)
    expect(timeline[0]).toMatchObject({ sourceVersion: 'v2', knowledgeDate: '20250112' })
    expect(timeline[1]).toMatchObject({ sourceVersion: 'v1', metrics: [{ value: 100 }, { value: null }] })
    expect(formatFinancialValue(timeline[1].metrics[1].value)).toBe('未知')
  })

  it('暴露适配合并主证据且不把缺失比例补成零', () => {
    expect(adaptBusinessExposures([{
      id: 'exposure-1', project_id: 'project-1', company_id: 'company-1', evidence_id: 'evidence-1',
      evidence_ids_json: '[]', source_key: 'manual-1', source_type: 'manual', status: 'candidate', basis: '产品映射', exposure_pct: null,
      main_business_item_name: '高端覆铜板', main_business_report_period: '20241231',
      main_business_revenue: 1_200_000_000, main_business_profit: 300_000_000, main_business_currency: 'CNY',
    }])).toMatchObject([{
      evidenceIds: ['evidence-1'], exposurePct: null, mainBusinessItemName: '高端覆铜板',
      mainBusinessReportPeriod: '20241231', mainBusinessRevenue: 1_200_000_000,
      mainBusinessProfit: 300_000_000, mainBusinessCurrency: 'CNY',
    }])
  })

  it('财务字段使用中文业务名并按真实口径格式化金额和比例', () => {
    expect(getFinancialMetricLabel('balancesheet', 'accounts_receiv')).toBe('应收账款')
    expect(getFinancialMetricLabel('fina_indicator', 'profit_dedt')).toBe('扣非归母净利润')
    expect(formatFinancialReportPeriod('20241231')).toBe('2024年报')
    expect(formatFinancialAmount(1_595_000_000)).toBe('15.95亿元')
    expect(formatFinancialMetricValue('forecast', {
      factId: 'forecast-min', name: 'net_profit_min', value: 6_236.16, textValue: null, unit: null, currency: null,
    })).toBe('6,236.16万元')
    expect(formatFinancialMetricValue('fina_indicator', {
      factId: 'ocf-ratio', name: 'ocf_to_or', value: 0.126, textValue: null, unit: null, currency: null,
    })).toBe('12.6%')
    expect(formatFinancialMetricValue('income', {
      factId: 'missing-profit', name: 'n_income_attr_p', value: null, textValue: null, unit: null, currency: null,
    })).toBe('未披露')
  })

  it('业务暴露默认汇总最新报告期并保留历史切换口径', () => {
    const exposures = adaptBusinessExposures([
      {
        id: 'exposure-2025-a', project_id: 'project-1', company_id: 'company-1', source_key: '2025-a',
        source_type: 'fina_mainbz', status: 'candidate', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: '印刷电路板', main_business_report_period: '20251231',
        main_business_revenue: 800, main_business_cost: 600, main_business_profit: 200, main_business_currency: 'CNY',
      },
      {
        id: 'exposure-2025-b', project_id: 'project-1', company_id: 'company-1', source_key: '2025-b',
        source_type: 'fina_mainbz', status: 'confirmed', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: '其他业务', main_business_report_period: '20251231',
        main_business_revenue: 200, main_business_cost: 150, main_business_profit: 50, main_business_currency: 'CNY',
      },
      {
        id: 'exposure-2024', project_id: 'project-1', company_id: 'company-1', source_key: '2024-a',
        source_type: 'fina_mainbz', status: 'candidate', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: '印刷电路板', main_business_report_period: '20241231',
        main_business_revenue: 600, main_business_cost: 480, main_business_profit: 120, main_business_currency: 'CNY',
      },
    ])

    const latest = buildBusinessExposureOverview(exposures)
    expect(latest).toMatchObject({
      periods: ['20251231', '20241231'], selectedPeriod: '20251231', sourceCount: 3,
      totalRevenue: 1000, totalCost: 750, totalProfit: 250, grossMarginPct: 25,
      confirmedCount: 1, pendingCount: 1,
    })
    expect(latest.items).toMatchObject([
      { name: '印刷电路板', revenueSharePct: 80, grossMarginPct: 25 },
      { name: '其他业务', revenueSharePct: 20, grossMarginPct: 25 },
    ])
    expect(buildBusinessExposureOverview(exposures, '20241231')).toMatchObject({
      selectedPeriod: '20241231', totalRevenue: 600, totalProfit: 120, grossMarginPct: 20,
    })
  })

  it('把跨期主营记录聚合为趋势和全量业务矩阵而不是原始长列表', () => {
    const exposures = adaptBusinessExposures([
      {
        id: 'exposure-2025-pcb', project_id: 'project-1', company_id: 'company-1', source_key: '2025-pcb',
        source_type: 'fina_mainbz', status: 'candidate', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: '印刷电路板', main_business_report_period: '20251231',
        main_business_revenue: 800, main_business_cost: 600, main_business_profit: 200, main_business_currency: 'CNY',
      },
      {
        id: 'exposure-2025-generic', project_id: 'project-1', company_id: 'company-1', source_key: '2025-generic',
        source_type: 'fina_mainbz', status: 'candidate', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: '销售收入', main_business_report_period: '20251231',
        main_business_revenue: 800, main_business_cost: 600, main_business_profit: 200, main_business_currency: 'CNY',
      },
      {
        id: 'exposure-2025-other', project_id: 'project-1', company_id: 'company-1', source_key: '2025-other',
        source_type: 'fina_mainbz', status: 'candidate', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: '其他业务', main_business_report_period: '20251231',
        main_business_revenue: 200, main_business_cost: 150, main_business_profit: 50, main_business_currency: 'CNY',
      },
      {
        id: 'exposure-2024-pcb', project_id: 'project-1', company_id: 'company-1', source_key: '2024-pcb',
        source_type: 'fina_mainbz', status: 'candidate', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: '印刷电路板', main_business_report_period: '20241231',
        main_business_revenue: 600, main_business_cost: 480, main_business_profit: 120, main_business_currency: 'CNY',
      },
      {
        id: 'exposure-2025-h1', project_id: 'project-1', company_id: 'company-1', source_key: '2025-h1',
        source_type: 'fina_mainbz', status: 'candidate', basis: '主营构成', evidence_ids_json: '[]',
        main_business_item_name: 'PC及PCB业务', main_business_report_period: '20250630',
        main_business_revenue: 350, main_business_cost: 260, main_business_profit: 90, main_business_currency: 'CNY',
      },
    ])

    const overview = buildBusinessExposureOverview(exposures)
    const annualTrend = buildBusinessExposureTrend(exposures, 'annual')
    const interimTrend = buildBusinessExposureTrend(exposures, 'interim')
    const matrix = buildBusinessExposureMatrix(exposures)

    expect(overview).toMatchObject({
      structuredCount: 5,
      duplicateMergedCount: 1,
      totalRevenue: 1000,
      previousComparablePeriod: '20241231',
    })
    expect(overview.topItemChangePct).toBeCloseTo(800 / 600 * 100 - 100)
    expect(overview.items.map((item) => item.name)).toEqual(['印刷电路板', '其他业务'])
    expect(annualTrend).toMatchObject({ periods: ['20241231', '20251231'], sourceRecordCount: 4 })
    expect(annualTrend.series.find((item) => item.name === '印刷电路板')).toMatchObject({ values: [600, 800] })
    expect(interimTrend).toMatchObject({ periods: ['20250630'], sourceRecordCount: 1 })
    expect(matrix).toMatchObject({ sourceRecordCount: 5, comparableCellCount: 4, duplicateMergedCount: 1 })
  })

  it('把150条跨期记录完整纳入矩阵统计并保持年报中报可比分离', () => {
    const periods = Array.from({ length: 9 }, (_, index) => String(2017 + index))
      .flatMap((year) => [`${year}0630`, `${year}1231`])
    const exposures = adaptBusinessExposures(Array.from({ length: 150 }, (_, index) => ({
      id: `exposure-${index}`,
      project_id: 'project-1',
      company_id: 'company-1',
      source_key: `source-${index}`,
      source_type: 'fina_mainbz',
      status: 'candidate',
      basis: `主营构成 ${index}`,
      evidence_ids_json: '[]',
      main_business_item_name: `业务${index % 23}`,
      main_business_report_period: periods[index % periods.length],
      main_business_revenue: 10_000 + index * 137,
      main_business_cost: 7_000 + index * 91,
      main_business_profit: 3_000 + index * 46,
      main_business_currency: 'CNY',
      updated_at: index,
    })))

    const matrix = buildBusinessExposureMatrix(exposures)
    const annualTrend = buildBusinessExposureTrend(exposures, 'annual')
    const interimTrend = buildBusinessExposureTrend(exposures, 'interim')

    expect(matrix).toMatchObject({
      periods,
      sourceRecordCount: 150,
      comparableCellCount: 150,
      duplicateMergedCount: 0,
    })
    expect(matrix.itemNames).toHaveLength(23)
    expect(annualTrend).toMatchObject({ sourceRecordCount: 75 })
    expect(interimTrend).toMatchObject({ sourceRecordCount: 75 })
  })

  it('确认暴露要求研究节点、事实日期和人工确认官方证据', () => {
    const draft: BusinessExposureDraft = {
      id: 'exposure-1', researchNodeId: '', mainBusinessItemId: '', evidenceId: 'evidence-1', sourceKey: 'manual-1',
      sourceType: 'manual', status: 'confirmed', exposurePct: null, basis: '公告确认', factDate: '', methodology: '',
    }
    const evidence: DisclosureEvidence[] = [{
      id: 'evidence-1', companyId: 'company-1', projectId: 'project-1', title: '年度报告', sourceUrl: 'https://example.com/report.pdf',
      publishedDate: null, actualPublishedDate: null, excerpt: null, createdBy: 'human', primarySourceConfirmed: true,
      createdAt: 1, updatedAt: 1,
    }]

    expect(validateConfirmedExposureDraft(draft, evidence)).toBe('已确认暴露必须绑定研究节点')
    draft.researchNodeId = 'node-1'
    expect(validateConfirmedExposureDraft(draft, evidence)).toBe('已确认暴露必须填写事实日期')
    draft.factDate = '20241231'
    expect(validateConfirmedExposureDraft(draft, evidence)).toBeNull()
    evidence[0].primarySourceConfirmed = false
    expect(validateConfirmedExposureDraft(draft, evidence)).toBe('已确认暴露必须绑定人工确认的官方公告证据')
  })

  it('利润桥估算门禁不允许空公式、空桥接项或空输入事实', () => {
    const draft: ProfitBridgeDraft = {
      bridgeKey: 'annual-profit', basePeriod: '20231231', targetPeriod: '20241231', status: 'estimate',
      items: [], formula: '', inputFactIds: [], evidenceIds: [],
    }

    expect(validateProfitBridgeDraft(draft)).toBe('估算利润桥必须填写透明公式')
    draft.formula = '目标利润 = 基准利润 + 各桥接项'
    expect(validateProfitBridgeDraft(draft)).toBe('估算利润桥至少需要一个有限桥接项')
    draft.items = [{ key: 'volume', label: '销量', amount: 10, unit: '万元', methodology: null }]
    expect(validateProfitBridgeDraft(draft)).toBe('估算利润桥必须引用同公司的输入财务事实')
    draft.inputFactIds = ['fact-1']
    expect(validateProfitBridgeDraft(draft)).toBeNull()
    draft.status = 'hypothesis'
    draft.formula = ''
    draft.items = []
    draft.inputFactIds = []
    expect(validateProfitBridgeDraft(draft)).toBeNull()
  })

  it('适配财务验证和利润桥并明确保留版本冲突草稿', () => {
    const validation = adaptFinancialValidation({
      companyId: 'company-1',
      coverage: { recentSingleQuarters: ['20240930'], latestInterimPeriods: [], recentAnnualPeriods: [] },
      quality: { receivables: { value: null, reason: '本地事实中缺少该指标', factId: null } },
    }, 'company-1')
    const bridge = adaptProfitBridge({
      id: 'bridge-1', bridgeKey: 'annual-profit', projectId: 'project-1', companyId: 'company-1',
      basePeriod: '20231231', targetPeriod: '20241231', status: 'estimate', version: 2, updatedAt: 200,
      items: [{ key: 'volume', label: '销量', amount: 12 }], inputFactIds: ['fact-1'], evidenceIds: [],
    })

    expect(validation.quality.receivables).toEqual({ value: null, reason: '本地事实中缺少该指标', factId: null })
    expect(validation.quality.inventory).toEqual({ value: null, reason: null, factId: null })
    expect(bridge).toMatchObject({ id: 'bridge-1', version: 2, items: [{ key: 'volume', amount: 12 }] })
    expect(shouldPreserveProfitBridgeDraft('VERSION_CONFLICT')).toBe(true)
    expect(shouldPreserveProfitBridgeDraft('INVALID_PARAM')).toBe(false)
  })
})
