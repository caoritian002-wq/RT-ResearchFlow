import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getScenarioSetVersion, listScenariosForVersion } from '../database/industryResearchDecisionRepository'
import {
  getMarketSnapshotByRequestId,
  saveMarketSnapshot,
} from '../database/industryResearchMarketRepository'
import {
  getValuationSnapshotByRequestId,
  saveValuationSnapshot,
} from '../database/industryResearchValuationRepository'
import type {
  IndustryResearchMarketStatus,
  IndustryResearchValuationMethod,
} from '../database/types'
import {
  buildIndustryResearchMarketContext,
  IndustryResearchMarketError,
} from './industryResearchMarketService'

export const INDUSTRY_RESEARCH_VALUATION_FORMULA_VERSION = 'valuation-formulas-v1'

export interface ValuationInputValue {
  value: number | null
  unit: string
  sourceKind: 'fact' | 'assumption'
  factId?: string | null
  note?: string | null
}

export interface ValuationScenarioInput {
  name: 'bear' | 'base' | 'bull'
  weightPct: number | null
  inputs: Record<string, ValuationInputValue>
  factIds?: string[]
}

export interface ValuationScenarioOutput {
  name: 'bear' | 'base' | 'bull'
  weightPct: number | null
  status: IndustryResearchMarketStatus
  fairPrice: number | null
  equityValue: number | null
  impliedAssumption: number | null
  impliedAssumptionLabel: string | null
  reasons: string[]
}

export interface IndustryResearchValuationPreview {
  valuationMethod: IndustryResearchValuationMethod
  formulaVersion: string
  marketFingerprint: string
  marketDate: string | null
  currentPrice: number | null
  status: IndustryResearchMarketStatus
  scenarios: ValuationScenarioOutput[]
  fairValueLow: number | null
  fairValueHigh: number | null
  weightedFairValue: number | null
  upsidePct: number | null
  downsidePct: number | null
  rewardRiskRatio: number | null
  factIds: string[]
  reasons: string[]
}

const MONEY_MULTIPLIER: Record<string, number> = {
  yuan: 1,
  thousand_yuan: 1_000,
  ten_thousand_yuan: 10_000,
  hundred_million_yuan: 100_000_000,
}
const SHARE_MULTIPLIER: Record<string, number> = { share: 1, ten_thousand_shares: 10_000 }

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function round(value: number | null, digits = 6): number | null {
  if (!finite(value)) return null
  const multiplier = 10 ** digits
  return Math.round(value * multiplier) / multiplier
}

function normalizeMoney(input: ValuationInputValue | undefined): number | null {
  if (!input || !finite(input.value)) return null
  const multiplier = MONEY_MULTIPLIER[input.unit]
  return multiplier ? input.value * multiplier : null
}

function normalizeShares(input: ValuationInputValue | undefined): number | null {
  if (!input || !finite(input.value)) return null
  const multiplier = SHARE_MULTIPLIER[input.unit]
  return multiplier ? input.value * multiplier : null
}

function normalizeMultiple(input: ValuationInputValue | undefined): number | null {
  return input?.unit === 'multiple' && finite(input.value) ? input.value : null
}

function normalizeRate(input: ValuationInputValue | undefined): number | null {
  if (!input || !finite(input.value)) return null
  if (input.unit === 'percent') return input.value / 100
  if (input.unit === 'ratio') return input.value
  return null
}

function normalizeCount(input: ValuationInputValue | undefined): number | null {
  return input?.unit === 'count' && finite(input.value) ? input.value : null
}

function requirePositive(value: number | null, label: string, reasons: string[]): value is number {
  if (!finite(value) || value <= 0) {
    reasons.push(`${label}缺失、单位无效或不满足正值门禁`)
    return false
  }
  return true
}

function dcfEquity(inputs: Record<string, ValuationInputValue>, overrideGrowth?: number): number | null {
  const baseFcf = normalizeMoney(inputs.baseFcf)
  const discountRate = normalizeRate(inputs.discountRate)
  const terminalGrowth = normalizeRate(inputs.terminalGrowth)
  const growthRate = overrideGrowth ?? normalizeRate(inputs.growthRate)
  const years = normalizeCount(inputs.years)
  const netDebt = normalizeMoney(inputs.netDebt) ?? 0
  if (!finite(baseFcf) || baseFcf <= 0 || !finite(discountRate) || !finite(terminalGrowth)
    || !finite(growthRate) || !finite(years) || years < 1 || years > 20 || discountRate <= terminalGrowth || discountRate <= -1) return null
  let present = 0
  let lastFcf = baseFcf
  for (let year = 1; year <= Math.round(years); year += 1) {
    lastFcf = baseFcf * (1 + growthRate) ** year
    present += lastFcf / (1 + discountRate) ** year
  }
  const terminal = lastFcf * (1 + terminalGrowth) / (discountRate - terminalGrowth)
  return present + terminal / (1 + discountRate) ** Math.round(years) - netDebt
}

function impliedDcfGrowth(inputs: Record<string, ValuationInputValue>, targetEquity: number): number | null {
  const min = normalizeRate(inputs.reverseMin) ?? -0.5
  const max = normalizeRate(inputs.reverseMax) ?? 0.5
  if (!(min < max)) return null
  const lowValue = dcfEquity(inputs, min)
  const highValue = dcfEquity(inputs, max)
  if (!finite(lowValue) || !finite(highValue) || (lowValue - targetEquity) * (highValue - targetEquity) > 0) return null
  let low = min
  let high = max
  for (let index = 0; index < 80; index += 1) {
    const middle = (low + high) / 2
    const value = dcfEquity(inputs, middle)
    if (!finite(value)) return null
    if (Math.abs(value - targetEquity) < Math.max(1, targetEquity * 1e-8)) return middle
    if ((lowValue - targetEquity) * (value - targetEquity) <= 0) high = middle
    else low = middle
  }
  return (low + high) / 2
}

function calculateScenario(
  method: IndustryResearchValuationMethod,
  scenario: ValuationScenarioInput,
  currentPrice: number | null,
): ValuationScenarioOutput {
  const reasons: string[] = []
  const shares = normalizeShares(scenario.inputs.totalShares)
  if (!requirePositive(shares, '总股本', reasons)) {
    return { name: scenario.name, weightPct: scenario.weightPct, status: 'blocked', fairPrice: null, equityValue: null, impliedAssumption: null, impliedAssumptionLabel: null, reasons }
  }
  let equityValue: number | null = null
  let impliedAssumption: number | null = null
  let impliedAssumptionLabel: string | null = null
  if (method === 'pe') {
    const netProfit = normalizeMoney(scenario.inputs.netProfit)
    const multiple = normalizeMultiple(scenario.inputs.multiple)
    if (requirePositive(netProfit, '归母净利润', reasons) && requirePositive(multiple, 'PE倍数', reasons)) {
      equityValue = netProfit * multiple
      impliedAssumption = finite(currentPrice) ? currentPrice * shares / netProfit : null
      impliedAssumptionLabel = '当前价格隐含PE'
    }
  } else if (method === 'pb_roe') {
    const netAssets = normalizeMoney(scenario.inputs.netAssets)
    const multiple = normalizeMultiple(scenario.inputs.multiple)
    const roe = normalizeRate(scenario.inputs.roe)
    if (requirePositive(netAssets, '归母净资产', reasons)
      && requirePositive(multiple, 'PB倍数', reasons)
      && requirePositive(roe, 'ROE', reasons)) {
      equityValue = netAssets * multiple
      impliedAssumption = finite(currentPrice) ? currentPrice * shares / netAssets : null
      impliedAssumptionLabel = `当前价格隐含PB（情景ROE ${round(roe * 100, 2)}%）`
    }
  } else if (method === 'ev_ebitda') {
    const ebitda = normalizeMoney(scenario.inputs.ebitda)
    const multiple = normalizeMultiple(scenario.inputs.multiple)
    const netDebt = normalizeMoney(scenario.inputs.netDebt)
    if (requirePositive(ebitda, 'EBITDA', reasons) && requirePositive(multiple, 'EV/EBITDA倍数', reasons) && finite(netDebt)) {
      equityValue = ebitda * multiple - netDebt
      impliedAssumption = finite(currentPrice) ? (currentPrice * shares + netDebt) / ebitda : null
      impliedAssumptionLabel = '当前价格隐含EV/EBITDA'
    } else if (!finite(netDebt)) reasons.push('净债务缺失或单位无效')
  } else if (method === 'dcf') {
    equityValue = dcfEquity(scenario.inputs)
    if (!finite(equityValue) || equityValue <= 0) reasons.push('DCF输入不完整、折现率不高于终值增速或结果非正')
    impliedAssumption = finite(currentPrice) ? impliedDcfGrowth(scenario.inputs, currentPrice * shares) : null
    impliedAssumptionLabel = '当前价格隐含预测期增长率'
    if (finite(currentPrice) && impliedAssumption == null) reasons.push('当前价格在反推边界内无单调解')
  } else if (method === 'sotp') {
    const segmentValues = Object.entries(scenario.inputs)
      .filter(([key]) => key.startsWith('segment.'))
      .map(([, value]) => normalizeMoney(value))
    const netDebt = normalizeMoney(scenario.inputs.netDebt)
    if (!segmentValues.length || segmentValues.some((value) => !finite(value) || value <= 0)) reasons.push('分部价值缺失或单位无效')
    else if (!finite(netDebt)) reasons.push('净债务缺失或单位无效')
    else equityValue = segmentValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) - netDebt
    impliedAssumptionLabel = '当前价格隐含剩余分部价值'
    const residualKey = scenario.inputs.reverseSegmentKey?.note?.trim()
    const selected = residualKey ? normalizeMoney(scenario.inputs[`segment.${residualKey}`]) : null
    if (finite(currentPrice) && residualKey && finite(selected) && finite(netDebt)) {
      const other = segmentValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) - selected
      impliedAssumption = currentPrice * shares + netDebt - other
    }
  } else if (method === 'nav') {
    const assets = normalizeMoney(scenario.inputs.adjustedAssets)
    const liabilities = normalizeMoney(scenario.inputs.liabilities)
    if (requirePositive(assets, '调整后资产', reasons) && finite(liabilities) && liabilities >= 0) {
      equityValue = assets - liabilities
      impliedAssumption = finite(currentPrice) ? currentPrice * shares + liabilities : null
      impliedAssumptionLabel = '当前价格隐含调整后资产'
    } else if (!finite(liabilities) || liabilities < 0) reasons.push('负债缺失、单位无效或为负')
  }
  if (!finite(equityValue) || equityValue <= 0) {
    return { name: scenario.name, weightPct: scenario.weightPct, status: 'blocked', fairPrice: null, equityValue: null, impliedAssumption: round(impliedAssumption), impliedAssumptionLabel, reasons }
  }
  const assumptionBased = Object.values(scenario.inputs).some((input) => input.sourceKind === 'assumption')
  return {
    name: scenario.name,
    weightPct: scenario.weightPct,
    status: assumptionBased ? 'degraded' : 'ok',
    fairPrice: round(equityValue / shares, 4),
    equityValue: round(equityValue, 2),
    impliedAssumption: round(impliedAssumption),
    impliedAssumptionLabel,
    reasons,
  }
}

function hydrateFactInputs(
  db: Database.Database,
  projectId: string,
  companyId: string,
  scenarios: ValuationScenarioInput[],
): { scenarios: ValuationScenarioInput[]; factIds: string[] } {
  const requested = [...new Set(scenarios.flatMap((scenario) => Object.values(scenario.inputs)
    .filter((input) => input.sourceKind === 'fact' && input.factId)
    .map((input) => input.factId!)))]
  const facts = new Map<string, { metric_value: number | null; unit: string | null; currency: string | null }>()
  if (requested.length) {
    const placeholders = requested.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT fact.id, fact.metric_value, fact.unit, fact.currency
      FROM industry_research_financial_facts fact
      JOIN industry_research_project_companies scope ON scope.company_id = fact.company_id
      WHERE scope.project_id = ? AND fact.company_id = ? AND fact.id IN (${placeholders})
    `).all(projectId, companyId, ...requested) as Array<{
      id: string
      metric_value: number | null
      unit: string | null
      currency: string | null
    }>
    for (const row of rows) facts.set(row.id, row)
    if (facts.size !== requested.length) throw new IndustryResearchMarketError('NOT_FOUND', '估值事实不存在或不属于当前项目公司')
  }
  return {
    factIds: requested,
    scenarios: scenarios.map((scenario) => ({
      ...scenario,
      inputs: Object.fromEntries(Object.entries(scenario.inputs).map(([key, input]) => {
        if (input.sourceKind === 'fact' && !input.factId) {
          return [key, { ...input, value: null, note: '事实输入缺少本地财务事实引用' }]
        }
        if (input.sourceKind === 'fact' && input.factId) {
          const fact = facts.get(input.factId)!
          const currencyCompatible = !fact.currency || ['CNY', 'RMB', '人民币'].includes(fact.currency.toUpperCase())
          const unitCompatible = Boolean(fact.unit && fact.unit === input.unit)
          return [key, {
            ...input,
            value: currencyCompatible && unitCompatible ? fact.metric_value : null,
            note: currencyCompatible && unitCompatible ? input.note : '事实单位或币种与估值输入不一致',
          }]
        }
        if (input.sourceKind === 'assumption' && !input.note?.trim()) {
          return [key, { ...input, value: null }]
        }
        return [key, input]
      })),
    })),
  }
}

export function previewIndustryResearchValuation(
  db: Database.Database,
  input: {
    projectId: string
    companyId: string
    securityId: string
    valuationDate: string
    valuationMethod: IndustryResearchValuationMethod
    scenarios: ValuationScenarioInput[]
    marketFingerprint: string
  },
): IndustryResearchValuationPreview {
  if (input.scenarios.length !== 3 || new Set(input.scenarios.map((scenario) => scenario.name)).size !== 3) {
    throw new IndustryResearchMarketError('INVALID_PARAM', '估值必须完整包含悲观、基准和乐观三项')
  }
  const market = buildIndustryResearchMarketContext(db, input)
  if (market.factFingerprint !== input.marketFingerprint) {
    throw new IndustryResearchMarketError('MARKET_CONTEXT_CHANGED', '市场事实已变化，请刷新后重新预览')
  }
  const hydrated = hydrateFactInputs(db, input.projectId, input.companyId, input.scenarios)
  const scenarios = hydrated.scenarios.map((scenario) => calculateScenario(input.valuationMethod, scenario, market.rawClose))
  const valid = scenarios.filter((scenario) => finite(scenario.fairPrice))
  const weightsComplete = scenarios.every((scenario) => finite(scenario.weightPct))
    && Math.abs(scenarios.reduce((sum, scenario) => sum + (scenario.weightPct ?? 0), 0) - 100) < 1e-6
    && valid.length === 3
  const fairValueLow = valid.length ? Math.min(...valid.map((scenario) => scenario.fairPrice!)) : null
  const fairValueHigh = valid.length ? Math.max(...valid.map((scenario) => scenario.fairPrice!)) : null
  const weightedFairValue = weightsComplete
    ? scenarios.reduce((sum, scenario) => sum + scenario.fairPrice! * scenario.weightPct! / 100, 0)
    : null
  const currentPrice = market.rawClose
  const upsidePct = finite(currentPrice) && finite(fairValueHigh) ? (fairValueHigh / currentPrice - 1) * 100 : null
  const downsidePct = finite(currentPrice) && finite(fairValueLow) ? (fairValueLow / currentPrice - 1) * 100 : null
  const reward = finite(upsidePct) ? Math.max(0, upsidePct) : null
  const risk = finite(downsidePct) ? Math.max(0, -downsidePct) : null
  const rewardRiskRatio = finite(reward) && finite(risk) && risk > 0 ? reward / risk : null
  const reasons = [...market.reasons.map((reason) => reason.message), ...scenarios.flatMap((scenario) => scenario.reasons)]
  const status: IndustryResearchMarketStatus = valid.length === 0 || market.status === 'blocked'
    ? 'blocked'
    : market.status === 'degraded' || scenarios.some((scenario) => scenario.status !== 'ok') ? 'degraded' : 'ok'
  return {
    valuationMethod: input.valuationMethod,
    formulaVersion: INDUSTRY_RESEARCH_VALUATION_FORMULA_VERSION,
    marketFingerprint: market.factFingerprint,
    marketDate: market.marketDate,
    currentPrice,
    status,
    scenarios,
    fairValueLow: round(fairValueLow, 4),
    fairValueHigh: round(fairValueHigh, 4),
    weightedFairValue: round(weightedFairValue, 4),
    upsidePct: round(upsidePct, 2),
    downsidePct: round(downsidePct, 2),
    rewardRiskRatio: round(rewardRiskRatio, 3),
    factIds: hydrated.factIds,
    reasons: [...new Set(reasons)],
  }
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

export function captureIndustryResearchValuationSnapshot(
  db: Database.Database,
  input: {
    projectId: string
    companyId: string
    securityId: string
    requestId: string
    scenarioSetVersionId: string
    valuationDate: string
    marketFingerprint: string
  },
): { marketSnapshotId: string; valuationSnapshotId: string; status: IndustryResearchMarketStatus } {
  const existingValuation = getValuationSnapshotByRequestId(db, input.requestId)
  const existingMarket = getMarketSnapshotByRequestId(db, input.requestId)
  if (existingValuation && existingMarket) {
    if (existingValuation.project_id !== input.projectId || existingValuation.company_id !== input.companyId
      || existingValuation.scenario_set_version_id !== input.scenarioSetVersionId) {
      throw new IndustryResearchMarketError('NOT_FOUND', '幂等请求不属于当前估值上下文')
    }
    return { marketSnapshotId: existingMarket.id, valuationSnapshotId: existingValuation.id, status: existingValuation.status }
  }
  const version = getScenarioSetVersion(db, input.projectId, input.scenarioSetVersionId)
  if (!version || version.company_id !== input.companyId) throw new IndustryResearchMarketError('NOT_FOUND', '情景版本不存在或不属于当前公司')
  if (!version.valuation_method) throw new IndustryResearchMarketError('VALUATION_METHOD_UNSUPPORTED', '情景版本尚未配置估值方法')
  const valuationMethod = version.valuation_method
  const rows = listScenariosForVersion(db, version.id)
  const scenarioInputs: ValuationScenarioInput[] = rows.map((row) => ({
    name: row.name,
    weightPct: row.weight_pct,
    inputs: safeJson<Record<string, ValuationInputValue>>(row.valuation_inputs_json, {}),
    factIds: safeJson<string[]>(row.fact_ids_json, []),
  }))
  const preview = previewIndustryResearchValuation(db, {
    ...input,
    valuationMethod,
    scenarios: scenarioInputs,
  })
  const market = buildIndustryResearchMarketContext(db, input)
  const save = db.transaction(() => {
    const marketSnapshot = saveMarketSnapshot(db, {
      id: randomUUID(), request_id: input.requestId, project_id: input.projectId,
      company_id: input.companyId, security_id: input.securityId, ts_code: market.tsCode,
      requested_valuation_date: input.valuationDate, market_date: market.marketDate,
      benchmark_code: market.benchmarkCode, benchmark_name: market.benchmarkName,
      raw_close: market.rawClose, status: market.status, reason_json: JSON.stringify(market.reasons),
      market_data_json: JSON.stringify(market), fact_fingerprint: market.factFingerprint,
      methodology_version: market.methodologyVersion, created_at: Date.now(),
    })
    const valuationSnapshot = saveValuationSnapshot(db, {
      id: randomUUID(), request_id: input.requestId, project_id: input.projectId,
      company_id: input.companyId, scenario_set_version_id: input.scenarioSetVersionId,
      market_snapshot_id: marketSnapshot.id, valuation_method: valuationMethod,
      status: preview.status, input_json: JSON.stringify(scenarioInputs),
      output_json: JSON.stringify(preview), fact_ids_json: JSON.stringify(preview.factIds),
      formula_version: preview.formulaVersion, created_at: Date.now(),
    })
    return { marketSnapshotId: marketSnapshot.id, valuationSnapshotId: valuationSnapshot.id, status: valuationSnapshot.status }
  })
  return save()
}
