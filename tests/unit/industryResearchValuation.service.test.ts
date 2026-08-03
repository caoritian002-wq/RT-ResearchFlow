import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import { runMigrations } from '../../electron/main/database/db'
import {
  upsertSecurityAdjustmentFactors,
  upsertSecurityValuationDaily,
} from '../../electron/main/database/industryResearchMarketRepository'
import {
  saveResearchCompany,
  saveResearchFinancialFacts,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import { saveIndustryResearchScenarioSet } from '../../electron/main/services/industryResearchDecisionService'
import { buildIndustryResearchMarketContext } from '../../electron/main/services/industryResearchMarketService'
import {
  captureIndustryResearchValuationSnapshot,
  previewIndustryResearchValuation,
  type ValuationInputValue,
  type ValuationScenarioInput,
} from '../../electron/main/services/industryResearchValuationService'
import type { IndustryResearchValuationMethod } from '../../electron/main/database/types'

function dateRows(count: number): string[] {
  const result: string[] = []
  const date = new Date('2025-07-01T00:00:00Z')
  while (result.length < count) {
    if (![0, 6].includes(date.getUTCDay())) result.push(date.toISOString().slice(0, 10).replaceAll('-', ''))
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return result
}

function dashed(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function assumption(value: number | null, unit: string, note = '用户透明假设'): ValuationInputValue {
  return { value, unit, sourceKind: 'assumption', note }
}

function scenarios(inputs: Record<string, ValuationInputValue>, weights: Array<number | null> = [20, 50, 30]): ValuationScenarioInput[] {
  return (['bear', 'base', 'bull'] as const).map((name, index) => ({
    name, weightPct: weights[index], inputs: structuredClone(inputs), factIds: [],
  }))
}

function seed(db: Database.Database): { dates: string[]; fingerprint: string } {
  createResearchProject(db, {
    id: 'project-valuation', title: '估值研究', industryName: '光通信', productScope: '光模块',
    regionScope: '中国', timeScope: '2026', purpose: 'investment', depth: 'standard', sourceType: 'manual',
    skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64), skillRuleVersion: 'v1',
  })
  saveResearchCompany(db, { id: 'company-valuation', legalName: '示例估值股份有限公司', sourceType: 'manual' }, 1)
  saveResearchSecurity(db, {
    id: 'security-valuation', companyId: 'company-valuation', tsCode: '600001.SH', exchange: 'SSE',
    securityType: 'A_SHARE', mappingSource: 'manual',
  }, 2)
  saveResearchProjectCompany(db, { projectId: 'project-valuation', companyId: 'company-valuation', status: 'core' }, 3)
  const dates = dateRows(260)
  upsertDailyClose(db, dates.flatMap((tradeDate) => [
    { tsCode: '600001.SH', tradeDate, open: 10, high: 10, low: 10, close: 10, pctChg: 0, vol: 1, turnoverRate: null },
    { tsCode: '000001.SH', tradeDate, open: 100, high: 100, low: 100, close: 100, pctChg: 0, vol: 1, turnoverRate: null },
  ]))
  upsertSecurityAdjustmentFactors(db, dates.map((tradeDate) => ({
    ts_code: '600001.SH', trade_date: tradeDate, adj_factor: 1, source: 'seed', fetched_at: 1,
  })))
  upsertSecurityValuationDaily(db, dates.map((tradeDate) => ({
    ts_code: '600001.SH', trade_date: tradeDate, total_share: 10000, float_share: 8000,
    total_mv: 100000, circ_mv: 80000, pe_ttm: 10, pb: 1, ps_ttm: 2, dv_ttm: 1,
    source: 'seed', fetched_at: 1,
  })))
  const context = buildIndustryResearchMarketContext(db, {
    projectId: 'project-valuation', companyId: 'company-valuation', securityId: 'security-valuation',
    valuationDate: dates.at(-1),
  })
  return { dates, fingerprint: context.factFingerprint }
}

function preview(
  db: Database.Database,
  method: IndustryResearchValuationMethod,
  rows: ValuationScenarioInput[],
  valuationDate: string,
  marketFingerprint: string,
) {
  return previewIndustryResearchValuation(db, {
    projectId: 'project-valuation', companyId: 'company-valuation', securityId: 'security-valuation',
    valuationDate, valuationMethod: method, scenarios: rows, marketFingerprint,
  })
}

describe('产业研究透明估值服务', () => {
  let db: Database.Database
  let dates: string[]
  let fingerprint: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const seeded = seed(db)
    dates = seeded.dates
    fingerprint = seeded.fingerprint
  })

  it('PE执行单位归一化、三情景区间、加权价值和收益风险比', () => {
    const rows = scenarios({
      netProfit: assumption(10000, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'ten_thousand_shares'),
      multiple: assumption(20, 'multiple'),
    })
    rows[0].inputs.netProfit.value = 5000
    rows[0].inputs.multiple.value = 10
    rows[2].inputs.netProfit.value = 12000
    rows[2].inputs.multiple.value = 25

    const result = preview(db, 'pe', rows, dates[259], fingerprint)

    expect(result.scenarios.map((row) => row.fairPrice)).toEqual([5, 20, 30])
    expect(result.fairValueLow).toBe(5)
    expect(result.fairValueHigh).toBe(30)
    expect(result.weightedFairValue).toBe(20)
    expect(result.upsidePct).toBe(200)
    expect(result.downsidePct).toBe(-50)
    expect(result.rewardRiskRatio).toBe(4)
    expect(result.status).toBe('degraded')
    expect(result.scenarios.every((row) => row.status === 'degraded')).toBe(true)
    db.close()
  })

  it.each([
    ['pb_roe', {
      netAssets: assumption(50000, 'ten_thousand_yuan'), totalShares: assumption(10000, 'ten_thousand_shares'),
      multiple: assumption(2, 'multiple'), roe: assumption(15, 'percent'),
    }, 10],
    ['ev_ebitda', {
      ebitda: assumption(20000, 'ten_thousand_yuan'), netDebt: assumption(10000, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'ten_thousand_shares'), multiple: assumption(8, 'multiple'),
    }, 15],
    ['dcf', {
      baseFcf: assumption(10000, 'ten_thousand_yuan'), growthRate: assumption(5, 'percent'),
      discountRate: assumption(10, 'percent'), terminalGrowth: assumption(2, 'percent'),
      years: assumption(5, 'count'), netDebt: assumption(1000, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'ten_thousand_shares'), reverseMin: assumption(-20, 'percent'),
      reverseMax: assumption(30, 'percent'),
    }, null],
    ['sotp', {
      'segment.core': assumption(200000, 'ten_thousand_yuan'), netDebt: assumption(20000, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'ten_thousand_shares'),
    }, 18],
    ['nav', {
      adjustedAssets: assumption(300000, 'ten_thousand_yuan'), liabilities: assumption(100000, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'ten_thousand_shares'),
    }, 20],
  ] as Array<[IndustryResearchValuationMethod, Record<string, ValuationInputValue>, number | null]>)('%s使用固定公式并输出有限结果', (method, inputs, expected) => {
    const result = preview(db, method, scenarios(inputs), dates[259], fingerprint)
    expect(result.scenarios.every((row) => row.fairPrice != null && Number.isFinite(row.fairPrice))).toBe(true)
    if (expected != null) expect(result.scenarios[1].fairPrice).toBe(expected)
    expect(result.formulaVersion).toBe('valuation-formulas-v1')
    db.close()
  })

  it('事实输入重新读取同公司本地值，未知单位、负利润和无说明假设保持blocked/null', () => {
    saveResearchFinancialFacts(db, [{
      id: 'fact-profit', companyId: 'company-valuation', securityId: 'security-valuation', sourceApi: 'income',
      sourceFactKey: 'profit', sourceVersion: 'v1', metricName: 'n_income_attr_p', metricValue: 5000,
      unit: 'ten_thousand_yuan', reportPeriod: '20251231', annDate: dates[200], fetchedAt: 1,
    }])
    const factRows = scenarios({
      netProfit: { value: 999999, unit: 'ten_thousand_yuan', sourceKind: 'fact', factId: 'fact-profit' },
      totalShares: assumption(10000, 'ten_thousand_shares'), multiple: assumption(10, 'multiple'),
    }, [null, null, null])
    const factResult = preview(db, 'pe', factRows, dates[259], fingerprint)
    expect(factResult.scenarios[1].fairPrice).toBe(5)
    expect(factResult.weightedFairValue).toBeNull()
    expect(factResult.factIds).toEqual(['fact-profit'])

    const unitConflictRows = scenarios({
      netProfit: { value: 5000, unit: 'hundred_million_yuan', sourceKind: 'fact', factId: 'fact-profit' },
      totalShares: assumption(10000, 'ten_thousand_shares'), multiple: assumption(10, 'multiple'),
    })
    const unitConflict = preview(db, 'pe', unitConflictRows, dates[259], fingerprint)
    expect(unitConflict.status).toBe('blocked')
    expect(unitConflict.scenarios.every((row) => row.fairPrice === null)).toBe(true)

    const blockedRows = scenarios({
      netProfit: assumption(-1, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'unknown_unit'),
      multiple: assumption(10, 'multiple', ''),
    })
    const blocked = preview(db, 'pe', blockedRows, dates[259], fingerprint)
    expect(blocked.status).toBe('blocked')
    expect(blocked.fairValueLow).toBeNull()
    expect(blocked.scenarios.every((row) => row.fairPrice === null && row.status === 'blocked')).toBe(true)
    expect(blocked.scenarios.flatMap((row) => row.reasons).join(' ')).toContain('总股本')
    db.close()
  })

  it('DCF反推仅在有限边界求解，市场事实变化后拒绝旧指纹', () => {
    const inputs = {
      baseFcf: assumption(10000, 'ten_thousand_yuan'), growthRate: assumption(5, 'percent'),
      discountRate: assumption(10, 'percent'), terminalGrowth: assumption(2, 'percent'),
      years: assumption(5, 'count'), netDebt: assumption(0, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'ten_thousand_shares'), reverseMin: assumption(0, 'percent'),
      reverseMax: assumption(0, 'percent'),
    }
    const result = preview(db, 'dcf', scenarios(inputs), dates[259], fingerprint)
    expect(result.scenarios[0].impliedAssumption).toBeNull()
    expect(result.scenarios[0].reasons).toContain('当前价格在反推边界内无单调解')

    upsertDailyClose(db, [{
      tsCode: '600001.SH', tradeDate: dates[259], open: 11, high: 11, low: 11, close: 11,
      pctChg: 10, vol: 1, turnoverRate: null,
    }])
    expect(() => preview(db, 'dcf', scenarios(inputs), dates[259], fingerprint))
      .toThrowError(expect.objectContaining({ code: 'MARKET_CONTEXT_CHANGED' }))
    db.close()
  })

  it('冻结市场与估值快照原子幂等且后续缓存变化不改历史输出', () => {
    const valuationInputs = {
      netProfit: assumption(10000, 'ten_thousand_yuan'),
      totalShares: assumption(10000, 'ten_thousand_shares'), multiple: assumption(20, 'multiple'),
    }
    const scenario = saveIndustryResearchScenarioSet(db, {
      projectId: 'project-valuation', companyId: 'company-valuation', requestId: randomUUID(),
      scenarioSetId: randomUUID(), expectedVersion: 0, dataAsOf: dashed(dates[259]), valuationDate: dashed(dates[259]),
      valuationMethod: 'pe', methodologyVersion: 'valuation-formulas-v1',
      scenarios: scenarios(valuationInputs).map((row) => ({
        name: row.name, weightPct: row.weightPct, assumptions: {}, valuationInputs: row.inputs, factIds: [],
      })),
    })
    const requestId = randomUUID()
    const first = captureIndustryResearchValuationSnapshot(db, {
      projectId: 'project-valuation', companyId: 'company-valuation', securityId: 'security-valuation',
      requestId, scenarioSetVersionId: scenario.versionId, valuationDate: dashed(dates[259]), marketFingerprint: fingerprint,
    })
    const retry = captureIndustryResearchValuationSnapshot(db, {
      projectId: 'project-valuation', companyId: 'company-valuation', securityId: 'security-valuation',
      requestId, scenarioSetVersionId: scenario.versionId, valuationDate: dashed(dates[259]), marketFingerprint: fingerprint,
    })
    expect(retry).toEqual(first)
    expect(first.status).toBe('degraded')
    const before = db.prepare('SELECT output_json FROM industry_research_valuation_snapshots WHERE id = ?').get(first.valuationSnapshotId) as { output_json: string }
    upsertDailyClose(db, [{
      tsCode: '600001.SH', tradeDate: dates[259], open: 20, high: 20, low: 20, close: 20,
      pctChg: 100, vol: 1, turnoverRate: null,
    }])
    expect((db.prepare('SELECT output_json FROM industry_research_valuation_snapshots WHERE id = ?').get(first.valuationSnapshotId) as { output_json: string }).output_json)
      .toBe(before.output_json)
    expect(() => db.prepare('UPDATE industry_research_valuation_snapshots SET output_json = ? WHERE id = ?').run('{}', first.valuationSnapshotId))
      .toThrow('INDUSTRY_RESEARCH_FACT_IMMUTABLE')
    db.close()
  })
})
