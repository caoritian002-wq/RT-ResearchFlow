import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  getResearchFinancialSyncState,
  listResearchFinancialFacts,
  saveResearchCompany,
  saveResearchFinancialFacts,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import {
  syncIndustryResearchCompanyFinancials,
  type IndustryResearchFinancialFetchers,
} from '../../electron/main/services/industryResearchFinancialSyncService'
import type { TushareFinancialRow } from '../../electron/main/services/tushareService'

function financialRow(
  endDate: string,
  values: Record<string, string | number | null>,
  overrides: Partial<TushareFinancialRow> = {},
): TushareFinancialRow {
  return {
    tsCode: '600001.SH',
    annDate: '20241030',
    fAnnDate: '20241030',
    endDate,
    reportType: '1',
    compType: '1',
    updateFlag: '0',
    values,
    ...overrides,
  }
}

function fetchersWith(
  overrides: Partial<IndustryResearchFinancialFetchers>,
): IndustryResearchFinancialFetchers {
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

describe('产业研究单公司财务同步服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1',
      title: '公司财务研究',
      industryName: '半导体',
      productScope: '设备',
      regionScope: '中国',
      timeScope: '2024-2026',
      purpose: 'investment',
      depth: 'standard',
      sourceType: 'manual',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    saveResearchCompany(db, {
      id: 'company-1', legalName: '示例科技股份有限公司', sourceType: 'manual',
    }, 100)
    saveResearchSecurity(db, {
      id: 'security-1', companyId: 'company-1', tsCode: '600001.SH', exchange: 'SSE',
      securityType: 'A_SHARE', mappingSource: 'tushare',
    }, 100)
  })

  it('保存累计事实并按同口径推导Q2单季值', async () => {
    const result = await syncIndustryResearchCompanyFinancials(db, 'token', {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      tsCode: '600001.SH', datasets: ['income'],
    }, 200, fetchersWith({
      income: vi.fn().mockResolvedValue([
        financialRow('20240331', { revenue: 100, n_income_attr_p: 10 }),
        financialRow('20240630', { revenue: 260, n_income_attr_p: 28 }),
      ]),
    }))

    expect(result).toMatchObject({ status: 'success' })
    const facts = listResearchFinancialFacts(db, 'company-1')
    expect(facts.find((fact) => fact.metric_name === 'revenue_single_quarter'
      && fact.report_period === '20240630')).toMatchObject({
      metric_value: 160,
      fact_kind: 'derived',
      derivation_status: 'derived',
    })
    expect(getResearchFinancialSyncState(db, 'company-1', 'income')).toMatchObject({
      status: 'success', last_success_fact_date: '20240630', last_success_row_count: 2,
    })
  })

  it('缺前一累计期时保存阻断派生事实而不伪造数值', async () => {
    await syncIndustryResearchCompanyFinancials(db, 'token', {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      tsCode: '600001.SH', datasets: ['cashflow'],
    }, 200, fetchersWith({
      cashflow: vi.fn().mockResolvedValue([
        financialRow('20240930', { n_cashflow_act: 90 }),
      ]),
    }))

    expect(listResearchFinancialFacts(db, 'company-1').find((fact) => (
      fact.metric_name === 'n_cashflow_act_single_quarter'
    ))).toMatchObject({ metric_value: null, derivation_status: 'blocked' })
  })

  it('当前累计值为空时保留阻断事实且修订标识不同不阻断合法差分', async () => {
    await syncIndustryResearchCompanyFinancials(db, 'token', {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      tsCode: '600001.SH', datasets: ['income'],
    }, 200, fetchersWith({
      income: vi.fn().mockResolvedValue([
        financialRow('20240331', { revenue: 100, n_income_attr_p: 10 }),
        financialRow('20240630', { revenue: 260, n_income_attr_p: null }, { updateFlag: '1' }),
      ]),
    }))

    const derivedFacts = listResearchFinancialFacts(db, 'company-1')
      .filter((fact) => fact.source_api === 'derived_quarter_income' && fact.report_period === '20240630')
    expect(derivedFacts.find((fact) => fact.metric_name === 'revenue_single_quarter'))
      .toMatchObject({ metric_value: 160, derivation_status: 'derived' })
    expect(derivedFacts.find((fact) => fact.metric_name === 'n_income_attr_p_single_quarter'))
      .toMatchObject({ metric_value: null, derivation_status: 'blocked' })
  })

  it('扣非归母净利润按累计口径推导单季值', async () => {
    await syncIndustryResearchCompanyFinancials(db, 'token', {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      tsCode: '600001.SH', datasets: ['fina_indicator'],
    }, 200, fetchersWith({
      fina_indicator: vi.fn().mockResolvedValue([
        financialRow('20240331', { profit_dedt: 8 }),
        financialRow('20240630', { profit_dedt: 21 }),
      ]),
    }))

    expect(listResearchFinancialFacts(db, 'company-1').find((fact) => (
      fact.metric_name === 'profit_dedt_single_quarter' && fact.report_period === '20240630'
    ))).toMatchObject({ metric_value: 13, derivation_status: 'derived' })
  })

  it('新修订版本与旧版本并存', async () => {
    const input = {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      tsCode: '600001.SH', datasets: ['income'] as const,
    }
    await syncIndustryResearchCompanyFinancials(db, 'token', input, 200, fetchersWith({
      income: vi.fn().mockResolvedValue([financialRow('20241231', { revenue: 500 })]),
    }))
    await syncIndustryResearchCompanyFinancials(db, 'token', input, 300, fetchersWith({
      income: vi.fn().mockResolvedValue([
        financialRow('20241231', { revenue: 520 }, { updateFlag: '1', annDate: '20250301' }),
      ]),
    }))

    expect(listResearchFinancialFacts(db, 'company-1').filter((fact) => (
      fact.source_api === 'income' && fact.metric_name === 'revenue'
    )).map((fact) => fact.metric_value).sort()).toEqual([500, 520])
  })

  it('单数据集失败保留旧事实和最后成功字段且其他数据集仍可成功', async () => {
    saveResearchFinancialFacts(db, [{
      id: 'old-income', companyId: 'company-1', securityId: 'security-1', sourceApi: 'income',
      sourceFactKey: 'old-key', sourceVersion: 'old-version', metricName: 'revenue',
      metricValue: 400, reportPeriod: '20231231', fetchedAt: 100,
    }])
    const result = await syncIndustryResearchCompanyFinancials(db, 'token', {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      tsCode: '600001.SH', datasets: ['income', 'balancesheet'],
    }, 200, fetchersWith({
      income: vi.fn().mockRejectedValue(new Error('TUSHARE_QUOTA_INSUFFICIENT')),
      balancesheet: vi.fn().mockResolvedValue([
        financialRow('20241231', { total_assets: 1000, total_liab: 300 }),
      ]),
    }))

    expect(result.status).toBe('partial')
    expect(result.datasets).toMatchObject([
      { dataset: 'income', status: 'failed', errorCode: 'PERMISSION_REQUIRED' },
      { dataset: 'balancesheet', status: 'success', errorCode: null },
    ])
    expect(listResearchFinancialFacts(db, 'company-1').find((fact) => fact.id === 'old-income'))
      .toMatchObject({ metric_value: 400 })
  })

  it('主营构成只生成产品候选暴露', async () => {
    await syncIndustryResearchCompanyFinancials(db, 'token', {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      tsCode: '600001.SH', datasets: ['fina_mainbz'],
    }, 200, fetchersWith({
      fina_mainbz: vi.fn().mockResolvedValue([
        financialRow('20241231', {
          bz_item: '刻蚀设备', bz_sales: 100, bz_profit: 30, bz_cost: 70, curr_type: 'CNY',
        }),
      ]),
    }))

    expect(db.prepare('SELECT item_name, revenue FROM industry_research_main_business_items').get())
      .toEqual({ item_name: '刻蚀设备', revenue: 100 })
    expect(db.prepare(`
      SELECT status, source_type, created_by FROM industry_research_business_exposures
    `).get()).toEqual({ status: 'candidate', source_type: 'fina_mainbz', created_by: 'import' })
  })
})
