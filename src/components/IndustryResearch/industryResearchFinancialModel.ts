import {
  FINANCIAL_DATASETS,
  type BusinessExposure,
  type BusinessExposureDraft,
  type DisclosureEvidence,
  type FinancialDataset,
  type FinancialDerivationStatus,
  type FinancialFactKind,
  type FinancialMetric,
  type FinancialQualityMetric,
  type FinancialSyncState,
  type FinancialSyncStatus,
  type FinancialTimelineRevision,
  type FinancialValidation,
  type ProfitBridge,
  type ProfitBridgeDraft,
  type ProfitBridgeItemKey,
  type ResearchCompany,
  type ResearchCompanyStatus,
  type ResearchSecurity,
} from './industryResearchTypes'

export const FINANCIAL_DATASET_LABELS: Record<FinancialDataset, string> = {
  income: '利润表',
  balancesheet: '资产负债表',
  cashflow: '现金流量表',
  fina_indicator: '财务指标',
  fina_audit: '审计意见',
  forecast: '业绩预告',
  express: '业绩快报',
  disclosure_date: '披露计划',
  fina_mainbz: '主营构成',
}

type FinancialMetricValueKind = 'yuan' | 'ten_thousand_yuan' | 'percent' | 'ratio_percent' | 'per_share' | 'date' | 'text' | 'number'

interface FinancialMetricMetadata {
  label: string
  valueKind: FinancialMetricValueKind
}

const FINANCIAL_METRIC_METADATA: Record<string, FinancialMetricMetadata> = {
  'income:total_revenue': { label: '营业总收入', valueKind: 'yuan' },
  'income:revenue': { label: '营业收入', valueKind: 'yuan' },
  'income:operate_profit': { label: '营业利润', valueKind: 'yuan' },
  'income:total_profit': { label: '利润总额', valueKind: 'yuan' },
  'income:n_income_attr_p': { label: '归母净利润', valueKind: 'yuan' },
  'income:ebit': { label: '息税前利润', valueKind: 'yuan' },
  'income:ebitda': { label: '息税折旧摊销前利润', valueKind: 'yuan' },
  'income:revenue_single_quarter': { label: '单季营业收入', valueKind: 'yuan' },
  'income:n_income_attr_p_single_quarter': { label: '单季归母净利润', valueKind: 'yuan' },
  'balancesheet:accounts_receiv': { label: '应收账款', valueKind: 'yuan' },
  'balancesheet:notes_receiv': { label: '应收票据', valueKind: 'yuan' },
  'balancesheet:inventories': { label: '存货', valueKind: 'yuan' },
  'balancesheet:contract_assets': { label: '合同资产', valueKind: 'yuan' },
  'balancesheet:total_assets': { label: '总资产', valueKind: 'yuan' },
  'balancesheet:total_liab': { label: '总负债', valueKind: 'yuan' },
  'balancesheet:total_hldr_eqy_exc_min_int': { label: '归母净资产', valueKind: 'yuan' },
  'cashflow:n_cashflow_act': { label: '经营活动现金流净额', valueKind: 'yuan' },
  'cashflow:n_cashflow_inv_act': { label: '投资活动现金流净额', valueKind: 'yuan' },
  'cashflow:n_cash_flows_fnc_act': { label: '筹资活动现金流净额', valueKind: 'yuan' },
  'cashflow:c_pay_acq_const_fiolta': { label: '购建长期资产支付现金', valueKind: 'yuan' },
  'cashflow:n_cashflow_act_single_quarter': { label: '单季经营活动现金流净额', valueKind: 'yuan' },
  'fina_indicator:roe': { label: '净资产收益率（ROE）', valueKind: 'percent' },
  'fina_indicator:grossprofit_margin': { label: '毛利率', valueKind: 'percent' },
  'fina_indicator:netprofit_margin': { label: '净利率', valueKind: 'percent' },
  'fina_indicator:ocf_to_or': { label: '经营现金流 / 营业收入', valueKind: 'ratio_percent' },
  'fina_indicator:profit_dedt': { label: '扣非归母净利润', valueKind: 'yuan' },
  'fina_indicator:profit_dedt_single_quarter': { label: '单季扣非归母净利润', valueKind: 'yuan' },
  'fina_indicator:q_sales_yoy': { label: '单季营业收入同比', valueKind: 'percent' },
  'fina_indicator:q_netprofit_yoy': { label: '单季归母净利润同比', valueKind: 'percent' },
  'fina_indicator:q_gsprofit_margin': { label: '单季毛利率', valueKind: 'percent' },
  'fina_audit:audit_result': { label: '审计意见', valueKind: 'text' },
  'fina_audit:audit_fees': { label: '审计费用', valueKind: 'yuan' },
  'fina_audit:audit_agency': { label: '审计机构', valueKind: 'text' },
  'fina_audit:audit_sign': { label: '签字会计师', valueKind: 'text' },
  'forecast:type': { label: '预告类型', valueKind: 'text' },
  'forecast:p_change_min': { label: '预计净利润同比下限', valueKind: 'percent' },
  'forecast:p_change_max': { label: '预计净利润同比上限', valueKind: 'percent' },
  'forecast:net_profit_min': { label: '预计净利润下限', valueKind: 'ten_thousand_yuan' },
  'forecast:net_profit_max': { label: '预计净利润上限', valueKind: 'ten_thousand_yuan' },
  'forecast:change_reason': { label: '业绩变动原因', valueKind: 'text' },
  'express:revenue': { label: '营业收入', valueKind: 'yuan' },
  'express:n_income': { label: '净利润', valueKind: 'yuan' },
  'express:total_assets': { label: '总资产', valueKind: 'yuan' },
  'express:diluted_eps': { label: '摊薄每股收益', valueKind: 'per_share' },
  'express:diluted_roe': { label: '摊薄净资产收益率', valueKind: 'percent' },
  'express:audit_result': { label: '审计意见', valueKind: 'text' },
  'disclosure_date:pre_date': { label: '预计披露日期', valueKind: 'date' },
  'disclosure_date:actual_date': { label: '实际披露日期', valueKind: 'date' },
  'disclosure_date:modify_date': { label: '调整后披露日期', valueKind: 'date' },
  'fina_mainbz:bz_item': { label: '业务名称', valueKind: 'text' },
  'fina_mainbz:bz_sales': { label: '主营收入', valueKind: 'yuan' },
  'fina_mainbz:bz_profit': { label: '主营毛利', valueKind: 'yuan' },
  'fina_mainbz:bz_cost': { label: '主营成本', valueKind: 'yuan' },
  'fina_mainbz:curr_type': { label: '币种', valueKind: 'text' },
}

const COMPANY_STATUSES = new Set<ResearchCompanyStatus>(['candidate', 'watching', 'core', 'excluded'])
const FACT_KINDS = new Set<FinancialFactKind>(['reported', 'derived'])
const DERIVATION_STATUSES = new Set<FinancialDerivationStatus>(['not_applicable', 'derived', 'not_separable', 'blocked'])
const SYNC_STATUSES = new Set<FinancialSyncStatus>(['idle', 'running', 'success', 'failed'])
const PROFIT_BRIDGE_ITEM_KEYS = new Set<ProfitBridgeItemKey>([
  'volume', 'price', 'product_mix', 'raw_material', 'depreciation_expense', 'other_business_drag', 'other',
])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1
}

export function safeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function adaptSecurity(value: unknown): ResearchSecurity {
  const source = record(value)
  return {
    id: stringValue(source.id),
    companyId: stringValue(source.company_id ?? source.companyId),
    tsCode: stringValue(source.ts_code ?? source.tsCode),
    symbol: nullableString(source.symbol),
    exchange: stringValue(source.exchange),
    securityType: stringValue(source.security_type ?? source.securityType),
    listStatus: nullableString(source.list_status ?? source.listStatus),
    listDate: nullableString(source.list_date ?? source.listDate),
    delistDate: nullableString(source.delist_date ?? source.delistDate),
    mappingSource: stringValue(source.mapping_source ?? source.mappingSource),
    sourceRef: nullableString(source.source_ref ?? source.sourceRef),
    updatedAt: nullableNumber(source.updated_at ?? source.updatedAt),
  }
}

export function adaptResearchCompanies(values: unknown): ResearchCompany[] {
  if (!Array.isArray(values)) return []
  return values.map((value) => {
    const source = record(value)
    const statusValue = stringValue(source.status)
    const legalName = stringValue(source.legal_name ?? source.legalName)
    const shortName = nullableString(source.short_name ?? source.shortName)
    return {
      companyId: stringValue(source.company_id ?? source.companyId ?? source.id),
      projectId: stringValue(source.project_id ?? source.projectId),
      legalName,
      shortName,
      displayName: shortName ?? legalName,
      unifiedCreditCode: nullableString(source.unified_credit_code ?? source.unifiedCreditCode),
      registrationRegion: nullableString(source.registration_region ?? source.registrationRegion),
      sourceType: stringValue(source.source_type ?? source.sourceType),
      sourceRef: nullableString(source.source_ref ?? source.sourceRef),
      status: COMPANY_STATUSES.has(statusValue as ResearchCompanyStatus) ? statusValue as ResearchCompanyStatus : 'candidate',
      exclusionReason: nullableString(source.exclusion_reason ?? source.exclusionReason),
      evidenceIds: safeStringArray(source.evidence_ids_json ?? source.evidenceIds),
      updatedAt: nullableNumber(source.updated_at ?? source.updatedAt),
      securities: Array.isArray(source.securities) ? source.securities.map(adaptSecurity) : [],
      trendScore: nullableNumber(source.trend_score ?? source.trendScore),
      trendScoreDate: nullableString(source.trend_score_date ?? source.trendScoreDate),
      trendScoreSource: source.trend_score_source === 'realtime' || source.trendScoreSource === 'realtime'
        ? 'realtime'
        : source.trend_score_source === 'eod' || source.trendScoreSource === 'eod'
          ? 'eod'
          : null,
      trendScoreTsCode: nullableString(source.trend_score_ts_code ?? source.trendScoreTsCode),
    }
  })
}

export function adaptDisclosureEvidence(values: unknown): DisclosureEvidence[] {
  if (!Array.isArray(values)) return []
  return values.map((value) => {
    const source = record(value)
    return {
      id: stringValue(source.id),
      companyId: stringValue(source.companyId ?? source.company_id),
      projectId: nullableString(source.projectId ?? source.project_id),
      title: stringValue(source.title),
      sourceUrl: stringValue(source.sourceUrl ?? source.source_url),
      publishedDate: nullableString(source.publishedDate ?? source.published_date),
      actualPublishedDate: nullableString(source.actualPublishedDate ?? source.actual_published_date),
      excerpt: nullableString(source.excerpt),
      createdBy: source.createdBy === 'import' || source.created_by === 'import' ? 'import' : 'human',
      primarySourceConfirmed: booleanValue(source.primarySourceConfirmed ?? source.primary_source_confirmed),
      createdAt: nullableNumber(source.createdAt ?? source.created_at) ?? 0,
      updatedAt: nullableNumber(source.updatedAt ?? source.updated_at) ?? 0,
    }
  })
}

export function adaptBusinessExposures(values: unknown): BusinessExposure[] {
  if (!Array.isArray(values)) return []
  return values.map((value) => {
    const source = record(value)
    const evidenceIds = safeStringArray(source.evidence_ids_json ?? source.evidenceIds)
    const evidenceId = nullableString(source.evidence_id ?? source.evidenceId)
    if (evidenceId && !evidenceIds.includes(evidenceId)) evidenceIds.unshift(evidenceId)
    return {
      id: stringValue(source.id),
      projectId: stringValue(source.project_id ?? source.projectId),
      companyId: stringValue(source.company_id ?? source.companyId),
      researchNodeId: nullableString(source.research_node_id ?? source.researchNodeId),
      mainBusinessItemId: nullableString(source.main_business_item_id ?? source.mainBusinessItemId),
      evidenceId,
      sourceKey: stringValue(source.source_key ?? source.sourceKey),
      sourceType: source.source_type === 'fina_mainbz' || source.sourceType === 'fina_mainbz' ? 'fina_mainbz' : 'manual',
      status: ['confirmed', 'not_separable', 'excluded'].includes(stringValue(source.status))
        ? stringValue(source.status) as BusinessExposure['status'] : 'candidate',
      exposurePct: nullableNumber(source.exposure_pct ?? source.exposurePct),
      basis: stringValue(source.basis),
      createdBy: source.created_by === 'import' || source.createdBy === 'import' ? 'import' : 'human',
      factDate: nullableString(source.fact_date ?? source.factDate),
      evidenceIds,
      methodology: nullableString(source.methodology),
      mainBusinessItemName: nullableString(source.main_business_item_name ?? source.mainBusinessItemName),
      mainBusinessReportPeriod: nullableString(source.main_business_report_period ?? source.mainBusinessReportPeriod),
      mainBusinessRevenue: nullableNumber(source.main_business_revenue ?? source.mainBusinessRevenue),
      mainBusinessCost: nullableNumber(source.main_business_cost ?? source.mainBusinessCost),
      mainBusinessProfit: nullableNumber(source.main_business_profit ?? source.mainBusinessProfit),
      mainBusinessCurrency: nullableString(source.main_business_currency ?? source.mainBusinessCurrency),
      mainBusinessSourceApi: nullableString(source.main_business_source_api ?? source.mainBusinessSourceApi),
      updatedAt: nullableNumber(source.updated_at ?? source.updatedAt),
    }
  })
}

export interface BusinessExposureSummaryItem {
  key: string
  name: string
  exposures: BusinessExposure[]
  revenue: number | null
  cost: number | null
  profit: number | null
  currency: string | null
  grossMarginPct: number | null
  revenueSharePct: number | null
  exposurePct: number | null
  status: BusinessExposure['status']
}

export interface BusinessExposureOverview {
  periods: string[]
  selectedPeriod: string | null
  items: BusinessExposureSummaryItem[]
  totalRevenue: number | null
  totalCost: number | null
  totalProfit: number | null
  grossMarginPct: number | null
  topItem: BusinessExposureSummaryItem | null
  topThreeSharePct: number | null
  highestMarginItem: BusinessExposureSummaryItem | null
  confirmedCount: number
  pendingCount: number
  sourceCount: number
  structuredCount: number
  unstructuredCount: number
  uniqueItemCount: number
  duplicateMergedCount: number
  previousComparablePeriod: string | null
  newItemNames: string[]
  exitedItemNames: string[]
  topItemChangePct: number | null
  manualExposures: BusinessExposure[]
}

export type BusinessExposureTrendScope = 'annual' | 'interim'

export interface BusinessExposureTrendSeries {
  name: string
  values: Array<number | null>
  latestValue: number | null
  previousValue: number | null
  changePct: number | null
  activePeriodCount: number
}

export interface BusinessExposureTrend {
  scope: BusinessExposureTrendScope
  periods: string[]
  series: BusinessExposureTrendSeries[]
  sourceRecordCount: number
  uniqueItemCount: number
}

export interface BusinessExposureMatrixPoint {
  periodIndex: number
  itemIndex: number
  relativeScale: number
  revenue: number
  profit: number | null
  grossMarginPct: number | null
  sourceCount: number
}

export interface BusinessExposureMatrix {
  periods: string[]
  itemNames: string[]
  points: BusinessExposureMatrixPoint[]
  sourceRecordCount: number
  comparableCellCount: number
  duplicateMergedCount: number
}

interface BusinessExposurePeriodSummary {
  period: string
  items: BusinessExposureSummaryItem[]
  sourceCount: number
  duplicateMergedCount: number
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value != null && Number.isFinite(value))
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null
}

function strongestExposureStatus(exposures: BusinessExposure[]): BusinessExposure['status'] {
  if (exposures.some((item) => item.status === 'confirmed')) return 'confirmed'
  if (exposures.some((item) => item.status === 'not_separable')) return 'not_separable'
  if (exposures.every((item) => item.status === 'excluded')) return 'excluded'
  return 'candidate'
}

function financialSignature(item: BusinessExposureSummaryItem): string | null {
  if (item.revenue == null) return null
  const numeric = (value: number | null) => value == null ? 'null' : value.toFixed(2)
  return [item.currency ?? '', numeric(item.revenue), numeric(item.cost), numeric(item.profit)].join(':')
}

function businessNameSpecificity(name: string): number {
  const compact = name.replace(/[\s·,，、()（）]/g, '')
  const generic = /^(销售收入|营业收入|主营业务收入|主营收入|业务收入|产品收入|服务收入|合计|总计)$/u.test(compact)
  const semanticCore = compact.replace(/(业务|产品|服务|收入)$/u, '')
  return (generic ? -100 : 0) + semanticCore.length * 10 - compact.length
}

function summarizeBusinessExposurePeriod(
  period: string,
  exposures: BusinessExposure[],
): BusinessExposurePeriodSummary {
  const grouped = new Map<string, BusinessExposure[]>()
  for (const exposure of exposures) {
    const name = exposure.mainBusinessItemName
    if (!name) continue
    grouped.set(name, [...(grouped.get(name) ?? []), exposure])
  }

  const rawItems = [...grouped.entries()].map(([name, items]) => {
    const latest = [...items].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
    const revenue = latest?.mainBusinessRevenue ?? null
    const cost = latest?.mainBusinessCost ?? null
    const profit = latest?.mainBusinessProfit ?? null
    return {
      key: `${period}:${name}`,
      name,
      exposures: items,
      revenue,
      cost,
      profit,
      currency: latest?.mainBusinessCurrency ?? null,
      grossMarginPct: revenue && profit != null ? profit / revenue * 100 : null,
      revenueSharePct: null,
      exposurePct: items.find((item) => item.exposurePct != null)?.exposurePct ?? null,
      status: strongestExposureStatus(items),
    } satisfies BusinessExposureSummaryItem
  })

  const bySignature = new Map<string, BusinessExposureSummaryItem>()
  const withoutSignature: BusinessExposureSummaryItem[] = []
  let duplicateMergedCount = 0
  for (const item of [...rawItems].sort((left, right) => businessNameSpecificity(right.name) - businessNameSpecificity(left.name))) {
    const signature = financialSignature(item)
    if (!signature) {
      withoutSignature.push(item)
      continue
    }
    const existing = bySignature.get(signature)
    if (!existing) {
      bySignature.set(signature, item)
      continue
    }
    duplicateMergedCount += item.exposures.length
    existing.exposures = [...existing.exposures, ...item.exposures]
    existing.status = strongestExposureStatus(existing.exposures)
    existing.exposurePct ??= item.exposurePct
  }

  const items = [...bySignature.values(), ...withoutSignature]
    .sort((left, right) => (right.revenue ?? Number.NEGATIVE_INFINITY) - (left.revenue ?? Number.NEGATIVE_INFINITY)
      || left.name.localeCompare(right.name, 'zh-CN'))

  return { period, items, sourceCount: exposures.length, duplicateMergedCount }
}

function buildBusinessExposurePeriods(exposures: BusinessExposure[]): BusinessExposurePeriodSummary[] {
  const byPeriod = new Map<string, BusinessExposure[]>()
  for (const exposure of exposures) {
    const period = exposure.mainBusinessReportPeriod
    if (!period || !exposure.mainBusinessItemName) continue
    byPeriod.set(period, [...(byPeriod.get(period) ?? []), exposure])
  }
  return [...byPeriod.entries()]
    .map(([period, items]) => summarizeBusinessExposurePeriod(period, items))
    .sort((left, right) => right.period.localeCompare(left.period))
}

function reportPeriodScope(period: string): BusinessExposureTrendScope | null {
  if (period.endsWith('1231')) return 'annual'
  if (period.endsWith('0630')) return 'interim'
  return null
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null
  return (current / previous - 1) * 100
}

export function buildBusinessExposureOverview(
  exposures: BusinessExposure[],
  requestedPeriod?: string | null,
): BusinessExposureOverview {
  const structured = exposures.filter((item) => item.mainBusinessReportPeriod && item.mainBusinessItemName)
  const periodSummaries = buildBusinessExposurePeriods(structured)
  const periods = periodSummaries.map((item) => item.period)
  const selectedPeriod = requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : periods[0] ?? null
  const selectedSummary = periodSummaries.find((item) => item.period === selectedPeriod) ?? null
  const selected = selectedPeriod ? structured.filter((item) => item.mainBusinessReportPeriod === selectedPeriod) : []
  const totalRevenue = sumKnown(selectedSummary?.items.map((item) => item.revenue) ?? [])
  const totalCost = sumKnown(selectedSummary?.items.map((item) => item.cost) ?? [])
  const totalProfit = sumKnown(selectedSummary?.items.map((item) => item.profit) ?? [])
  const items = (selectedSummary?.items ?? []).map((item) => ({
    ...item,
    revenueSharePct: totalRevenue && item.revenue != null ? item.revenue / totalRevenue * 100 : null,
  }))
  const marginItems = items.filter((item) => item.grossMarginPct != null)
    .sort((left, right) => (right.grossMarginPct ?? Number.NEGATIVE_INFINITY) - (left.grossMarginPct ?? Number.NEGATIVE_INFINITY))
  const topThreeRevenue = sumKnown(items.slice(0, 3).map((item) => item.revenue))
  const previousComparable = selectedPeriod
    ? periodSummaries.find((item) => item.period !== selectedPeriod && reportPeriodScope(item.period) === reportPeriodScope(selectedPeriod)) ?? null
    : null
  const currentNames = new Set(items.map((item) => item.name))
  const previousNames = new Set(previousComparable?.items.map((item) => item.name) ?? [])
  const topItem = items[0] ?? null
  const previousTopItem = topItem ? previousComparable?.items.find((item) => item.name === topItem.name) ?? null : null
  const uniqueItemCount = new Set(periodSummaries.flatMap((item) => item.items.map((entry) => entry.name))).size
  return {
    periods,
    selectedPeriod,
    items,
    totalRevenue,
    totalCost,
    totalProfit,
    grossMarginPct: totalRevenue && totalProfit != null ? totalProfit / totalRevenue * 100 : null,
    topItem,
    topThreeSharePct: totalRevenue && topThreeRevenue != null ? topThreeRevenue / totalRevenue * 100 : null,
    highestMarginItem: marginItems[0] ?? null,
    confirmedCount: selected.filter((item) => item.status === 'confirmed').length,
    pendingCount: selected.filter((item) => item.status === 'candidate').length,
    sourceCount: exposures.length,
    structuredCount: structured.length,
    unstructuredCount: exposures.length - structured.length,
    uniqueItemCount,
    duplicateMergedCount: periodSummaries.reduce((sum, item) => sum + item.duplicateMergedCount, 0),
    previousComparablePeriod: previousComparable?.period ?? null,
    newItemNames: items.map((item) => item.name).filter((name) => !previousNames.has(name)),
    exitedItemNames: [...previousNames].filter((name) => !currentNames.has(name)),
    topItemChangePct: percentChange(topItem?.revenue ?? null, previousTopItem?.revenue ?? null),
    manualExposures: exposures.filter((item) => !item.mainBusinessReportPeriod || !item.mainBusinessItemName),
  }
}

export function buildBusinessExposureTrend(
  exposures: BusinessExposure[],
  scope: BusinessExposureTrendScope,
  limit = 6,
): BusinessExposureTrend {
  const summaries = buildBusinessExposurePeriods(exposures)
    .filter((item) => reportPeriodScope(item.period) === scope)
    .sort((left, right) => left.period.localeCompare(right.period))
  const periods = summaries.map((item) => item.period)
  const names = new Set(summaries.flatMap((item) => item.items.map((entry) => entry.name)))
  const ranked = [...names].map((name) => {
    const values = summaries.map((summary) => summary.items.find((item) => item.name === name)?.revenue ?? null)
    const known = values.filter((value): value is number => value != null && Number.isFinite(value))
    return {
      name,
      values,
      maxValue: known.length ? Math.max(...known.map(Math.abs)) : 0,
      activePeriodCount: known.length,
    }
  }).sort((left, right) => right.maxValue - left.maxValue
    || right.activePeriodCount - left.activePeriodCount
    || left.name.localeCompare(right.name, 'zh-CN'))
    .slice(0, Math.max(1, Math.floor(limit)))

  return {
    scope,
    periods,
    series: ranked.map((item) => {
      const known = item.values.filter((value): value is number => value != null)
      const latestValue = known.at(-1) ?? null
      const previousValue = known.at(-2) ?? null
      return {
        name: item.name,
        values: item.values,
        latestValue,
        previousValue,
        changePct: percentChange(latestValue, previousValue),
        activePeriodCount: item.activePeriodCount,
      }
    }),
    sourceRecordCount: summaries.reduce((sum, item) => sum + item.sourceCount, 0),
    uniqueItemCount: names.size,
  }
}

export function buildBusinessExposureMatrix(exposures: BusinessExposure[]): BusinessExposureMatrix {
  const summaries = buildBusinessExposurePeriods(exposures).sort((left, right) => left.period.localeCompare(right.period))
  const periods = summaries.map((item) => item.period)
  const itemNames = [...new Set(summaries.flatMap((summary) => summary.items.map((item) => item.name)))]
    .map((name) => ({
      name,
      maxRevenue: Math.max(0, ...summaries.flatMap((summary) => summary.items
        .filter((item) => item.name === name && item.revenue != null)
        .map((item) => Math.abs(item.revenue!)))),
    }))
    .sort((left, right) => right.maxRevenue - left.maxRevenue || left.name.localeCompare(right.name, 'zh-CN'))
    .map((item) => item.name)
  const itemIndex = new Map(itemNames.map((name, index) => [name, index]))
  const points: BusinessExposureMatrixPoint[] = []
  summaries.forEach((summary, periodIndex) => {
    const maxRevenue = Math.max(1, ...summary.items.map((item) => Math.abs(item.revenue ?? 0)))
    for (const item of summary.items) {
      if (item.revenue == null) continue
      points.push({
        periodIndex,
        itemIndex: itemIndex.get(item.name) ?? 0,
        relativeScale: Math.abs(item.revenue) / maxRevenue * 100,
        revenue: item.revenue,
        profit: item.profit,
        grossMarginPct: item.grossMarginPct,
        sourceCount: item.exposures.length,
      })
    }
  })
  return {
    periods,
    itemNames,
    points,
    sourceRecordCount: summaries.reduce((sum, item) => sum + item.sourceCount, 0),
    comparableCellCount: points.length,
    duplicateMergedCount: summaries.reduce((sum, item) => sum + item.duplicateMergedCount, 0),
  }
}

export function adaptFinancialTimeline(values: unknown): FinancialTimelineRevision[] {
  if (!Array.isArray(values)) return []
  const revisions = new Map<string, FinancialTimelineRevision>()
  for (const value of values) {
    const source = record(value)
    const datasetValue = stringValue(source.source_api ?? source.dataset)
    if (!FINANCIAL_DATASETS.includes(datasetValue as FinancialDataset)) continue
    const sourceFactKey = stringValue(source.source_fact_key ?? source.sourceFactKey)
    const sourceVersion = stringValue(source.source_version ?? source.sourceVersion)
    const securityId = nullableString(source.security_id ?? source.securityId)
    const revisionKey = [datasetValue, sourceFactKey, sourceVersion, securityId ?? ''].join(':')
    let revision = revisions.get(revisionKey)
    if (!revision) {
      const factKindValue = stringValue(source.fact_kind ?? source.factKind)
      const derivationValue = stringValue(source.derivation_status ?? source.derivationStatus)
      const actualAnnouncementDate = nullableString(source.f_ann_date ?? source.actualAnnouncementDate)
      const announcementDate = nullableString(source.ann_date ?? source.announcementDate)
      revision = {
        key: revisionKey,
        companyId: stringValue(source.company_id ?? source.companyId),
        securityId,
        tsCode: nullableString(source.ts_code ?? source.tsCode),
        dataset: datasetValue as FinancialDataset,
        factKind: FACT_KINDS.has(factKindValue as FinancialFactKind) ? factKindValue as FinancialFactKind : 'reported',
        derivationStatus: DERIVATION_STATUSES.has(derivationValue as FinancialDerivationStatus)
          ? derivationValue as FinancialDerivationStatus : 'not_applicable',
        announcementDate,
        actualAnnouncementDate,
        knowledgeDate: actualAnnouncementDate ?? announcementDate,
        reportPeriod: stringValue(source.report_period ?? source.reportPeriod),
        statementType: nullableString(source.statement_type ?? source.statementType),
        companyType: nullableString(source.company_type ?? source.companyType),
        updateFlag: nullableString(source.update_flag ?? source.updateFlag),
        sourceFactKey,
        sourceVersion,
        metrics: [],
        formula: nullableString(source.derivation_formula ?? source.formula),
        inputFactIds: safeStringArray(source.input_versions_json ?? source.inputFactIds),
        fetchedAt: nullableNumber(source.fetched_at ?? source.fetchedAt),
      }
      revisions.set(revisionKey, revision)
    }
    revision.metrics.push({
      factId: stringValue(source.id),
      name: stringValue(source.metric_name ?? source.metricName),
      value: nullableNumber(source.metric_value ?? source.metricValue),
      textValue: nullableString(source.text_value ?? source.textValue),
      unit: nullableString(source.unit),
      currency: nullableString(source.currency),
    })
  }
  return [...revisions.values()].sort((left, right) => {
    const dateOrder = (right.knowledgeDate ?? right.reportPeriod).localeCompare(left.knowledgeDate ?? left.reportPeriod)
    if (dateOrder !== 0) return dateOrder
    return right.sourceVersion.localeCompare(left.sourceVersion)
  })
}

export function adaptFinancialSyncStates(values: unknown, companyId: string): FinancialSyncState[] {
  const rows = Array.isArray(values) ? values.map(record) : []
  const byDataset = new Map(rows.map((row) => [stringValue(row.dataset), row]))
  return FINANCIAL_DATASETS.map((dataset) => {
    const source = byDataset.get(dataset) ?? {}
    const statusValue = stringValue(source.status)
    return {
      companyId: stringValue(source.company_id ?? source.companyId, companyId),
      dataset,
      status: SYNC_STATUSES.has(statusValue as FinancialSyncStatus) ? statusValue as FinancialSyncStatus : 'idle',
      lastAttemptAt: nullableNumber(source.last_attempt_at ?? source.lastAttemptAt),
      lastSuccessAt: nullableNumber(source.last_success_at ?? source.lastSuccessAt),
      lastSuccessFactDate: nullableString(source.last_success_fact_date ?? source.lastSuccessFactDate),
      lastSuccessRowCount: nullableNumber(source.last_success_row_count ?? source.lastSuccessRowCount),
      lastErrorCode: nullableString(source.last_error_code ?? source.lastErrorCode),
      updatedAt: nullableNumber(source.updated_at ?? source.updatedAt),
    }
  })
}

function adaptQualityMetric(value: unknown): FinancialQualityMetric {
  const source = record(value)
  return {
    value: nullableNumber(source.value),
    reason: nullableString(source.reason),
    factId: nullableString(source.factId ?? source.fact_id),
  }
}

export function adaptFinancialValidation(value: unknown, companyId: string): FinancialValidation {
  const source = record(value)
  const coverage = record(source.coverage)
  const quality = record(source.quality)
  const latestSource = record(coverage.latestForecastOrExpress)
  const latestForecastOrExpress = Object.keys(latestSource).length > 0 ? {
    dataset: stringValue(latestSource.dataset),
    periodEnd: stringValue(latestSource.periodEnd ?? latestSource.period_end),
    announcementDate: nullableString(latestSource.announcementDate ?? latestSource.announcement_date),
  } : null
  return {
    companyId: stringValue(source.companyId ?? source.company_id, companyId),
    coverage: {
      recentSingleQuarters: safeStringArray(coverage.recentSingleQuarters),
      latestInterimPeriods: safeStringArray(coverage.latestInterimPeriods),
      recentAnnualPeriods: safeStringArray(coverage.recentAnnualPeriods),
      latestForecastOrExpress,
      latestForecastOrExpressReason: nullableString(coverage.latestForecastOrExpressReason),
    },
    quality: {
      receivables: adaptQualityMetric(quality.receivables),
      inventory: adaptQualityMetric(quality.inventory),
      contractAssets: adaptQualityMetric(quality.contractAssets),
      operatingCashflow: adaptQualityMetric(quality.operatingCashflow),
      nonRecurringProfit: adaptQualityMetric(quality.nonRecurringProfit),
    },
  }
}

export function adaptProfitBridge(value: unknown): ProfitBridge | null {
  if (value == null) return null
  const source = record(value)
  if (!stringValue(source.id)) return null
  return {
    id: stringValue(source.id),
    bridgeKey: stringValue(source.bridgeKey ?? source.bridge_key),
    projectId: stringValue(source.projectId ?? source.project_id),
    companyId: stringValue(source.companyId ?? source.company_id),
    basePeriod: stringValue(source.basePeriod ?? source.base_period),
    targetPeriod: stringValue(source.targetPeriod ?? source.target_period),
    status: source.status === 'estimate' ? 'estimate' : 'hypothesis',
    items: Array.isArray(source.items) ? source.items.map((value) => {
      const item = record(value)
      const keyValue = stringValue(item.key ?? item.item_key)
      return {
        key: PROFIT_BRIDGE_ITEM_KEYS.has(keyValue as ProfitBridgeItemKey) ? keyValue as ProfitBridgeItemKey : 'other',
        label: stringValue(item.label),
        amount: nullableNumber(item.amount),
        unit: nullableString(item.unit),
        methodology: nullableString(item.methodology),
      }
    }) : [],
    formula: nullableString(source.formula),
    inputFactIds: safeStringArray(source.inputFactIds ?? source.input_fact_ids_json),
    evidenceIds: safeStringArray(source.evidenceIds ?? source.evidence_ids_json),
    createdBy: source.createdBy === 'import' || source.created_by === 'import' ? 'import' : 'human',
    version: nullableNumber(source.version) ?? 1,
    previousVersionId: nullableString(source.previousVersionId ?? source.previous_version_id),
    updatedAt: nullableNumber(source.updatedAt ?? source.updated_at) ?? 0,
  }
}

export function shouldPreserveProfitBridgeDraft(errorCode: string | null | undefined): boolean {
  return errorCode === 'VERSION_CONFLICT'
}

export function formatFinancialValue(value: number | string | null, unit?: string | null): string {
  if (value == null || value === '') return '未知'
  if (typeof value === 'number' && !Number.isFinite(value)) return '未知'
  return `${typeof value === 'number' ? value.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : value}${unit ? ` ${unit}` : ''}`
}

function localeNumber(value: number, maximumFractionDigits = 2): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits })
}

function isYuanCurrency(currency?: string | null): boolean {
  if (!currency) return true
  return ['CNY', 'RMB', '人民币', '元'].includes(currency.trim().toUpperCase())
}

export function formatFinancialAmount(
  value: number | null,
  sourceUnit: 'yuan' | 'ten_thousand_yuan' = 'yuan',
  currency?: string | null,
): string {
  if (value == null || !Number.isFinite(value)) return '未披露'
  if (!isYuanCurrency(currency)) return `${localeNumber(value)} ${currency}`
  const yuanValue = sourceUnit === 'ten_thousand_yuan' ? value * 10_000 : value
  const absolute = Math.abs(yuanValue)
  if (absolute >= 100_000_000) return `${localeNumber(yuanValue / 100_000_000)}亿元`
  if (absolute >= 10_000) return `${localeNumber(yuanValue / 10_000)}万元`
  return `${localeNumber(yuanValue)}元`
}

export function formatFinancialReportPeriod(value: string | null): string {
  if (!value) return '报告期未披露'
  if (!/^\d{8}$/.test(value)) return value
  const year = value.slice(0, 4)
  const suffix = value.slice(4)
  if (suffix === '0331') return `${year}一季报`
  if (suffix === '0630') return `${year}中报`
  if (suffix === '0930') return `${year}三季报`
  if (suffix === '1231') return `${year}年报`
  return `${year}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

export function getFinancialMetricLabel(dataset: FinancialDataset, metricName: string): string {
  return FINANCIAL_METRIC_METADATA[`${dataset}:${metricName}`]?.label ?? '其他财务指标'
}

export function formatFinancialMetricValue(dataset: FinancialDataset, metric: FinancialMetric): string {
  const metadata = FINANCIAL_METRIC_METADATA[`${dataset}:${metric.name}`]
  const value = metric.value ?? metric.textValue
  if (value == null || value === '') return '未披露'
  if (typeof value === 'number' && !Number.isFinite(value)) return '未披露'

  const kind = metadata?.valueKind
  if (typeof value === 'number') {
    if (kind === 'yuan' || metric.unit === 'yuan') return formatFinancialAmount(value, 'yuan', metric.currency)
    if (kind === 'ten_thousand_yuan' || metric.unit === 'ten_thousand_yuan') {
      return formatFinancialAmount(value, 'ten_thousand_yuan', metric.currency)
    }
    if (kind === 'percent' || metric.unit === 'percent') return `${localeNumber(value)}%`
    if (kind === 'ratio_percent' || metric.unit === 'ratio') return `${localeNumber(value * 100)}%`
    if (kind === 'per_share') return `${localeNumber(value, 4)}元/股`
    return formatFinancialValue(value, metric.unit ?? metric.currency)
  }
  if (kind === 'date' && /^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  }
  return value
}

export function validateConfirmedExposureDraft(draft: BusinessExposureDraft, evidence: DisclosureEvidence[]): string | null {
  if (!draft.sourceKey.trim()) return '需要填写暴露来源键'
  if (!draft.basis.trim()) return '需要填写判断依据'
  if (draft.sourceType === 'fina_mainbz' && draft.status !== 'candidate') return '主营构成自动候选不能直接升级为人工状态'
  if (draft.status !== 'confirmed') return null
  if (!draft.researchNodeId.trim()) return '已确认暴露必须绑定研究节点'
  if (!draft.factDate.trim()) return '已确认暴露必须填写事实日期'
  const selectedEvidence = evidence.find((item) => item.id === draft.evidenceId)
  if (!selectedEvidence || selectedEvidence.createdBy !== 'human' || !selectedEvidence.primarySourceConfirmed) {
    return '已确认暴露必须绑定人工确认的官方公告证据'
  }
  return null
}

export function validateProfitBridgeDraft(draft: ProfitBridgeDraft): string | null {
  if (!draft.bridgeKey.trim() || !draft.basePeriod.trim() || !draft.targetPeriod.trim()) return '需要填写桥键、基准期和目标期'
  if (draft.status !== 'estimate') return null
  if (!draft.formula.trim()) return '估算利润桥必须填写透明公式'
  if (!draft.items.some((item) => item.amount != null && Number.isFinite(item.amount))) return '估算利润桥至少需要一个有限桥接项'
  if (!draft.inputFactIds.length) return '估算利润桥必须引用同公司的输入财务事实'
  return null
}
