import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  saveResearchCompany,
  saveResearchFinancialFacts,
  saveResearchProjectCompany,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import { getIndustryResearchFinancialValidation } from '../../electron/main/services/industryResearchFinancialValidationService'

describe('产业研究财务验证服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-1', title: '财务验证研究', industryName: '半导体', productScope: '设备',
      regionScope: '中国', timeScope: '2022-2025', purpose: 'investment', depth: 'standard',
      sourceType: 'manual', skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })
    saveResearchCompany(db, { id: 'company-1', legalName: '示例科技股份有限公司', sourceType: 'manual' }, 100)
    saveResearchProjectCompany(db, { projectId: 'project-1', companyId: 'company-1', status: 'core' }, 110)
  })

  it('按本地事实返回期间覆盖和质量指标', () => {
    saveResearchFinancialFacts(db, [
      {
        id: 'quarter-1', companyId: 'company-1', sourceApi: 'derived_quarter', sourceFactKey: 'q1', sourceVersion: 'v1',
        metricName: 'revenue_single_quarter', metricValue: 30, reportPeriod: '20240930', factKind: 'derived',
        derivationFormula: '累计三季度减半年度', inputVersions: ['input-v1'], derivationStatus: 'derived', fetchedAt: 200,
      },
      {
        id: 'annual-1', companyId: 'company-1', sourceApi: 'balancesheet', sourceFactKey: 'a1', sourceVersion: 'v1',
        metricName: 'accounts_receiv', metricValue: 20, reportPeriod: '20241231', fetchedAt: 210,
      },
      {
        id: 'interim-1', companyId: 'company-1', sourceApi: 'balancesheet', sourceFactKey: 'i1', sourceVersion: 'v1',
        metricName: 'inventories', metricValue: 10, reportPeriod: '20240630', fetchedAt: 220,
      },
      {
        id: 'income-profit', companyId: 'company-1', sourceApi: 'income', sourceFactKey: 'income-profit', sourceVersion: 'v1',
        metricName: 'n_income_attr_p', metricValue: 18, reportPeriod: '20240930', fetchedAt: 225,
      },
      {
        id: 'deducted-profit', companyId: 'company-1', sourceApi: 'fina_indicator', sourceFactKey: 'deducted-profit', sourceVersion: 'v1',
        metricName: 'profit_dedt', metricValue: 15, reportPeriod: '20240930', fetchedAt: 226,
      },
      {
        id: 'forecast-1', companyId: 'company-1', sourceApi: 'forecast', sourceFactKey: 'f1', sourceVersion: 'v1',
        metricName: 'forecast_type', metricText: '预增', reportPeriod: '20241231', annDate: '20250120', fetchedAt: 230,
      },
    ])

    const result = getIndustryResearchFinancialValidation(db, 'project-1', 'company-1')
    expect(result.coverage).toMatchObject({
      recentSingleQuarters: ['20240930'], latestInterimPeriods: ['20240630'], recentAnnualPeriods: ['20241231'],
      latestForecastOrExpress: { dataset: 'forecast', periodEnd: '20241231', announcementDate: '20250120' },
    })
    expect(result.quality.receivables).toMatchObject({ value: 20, reason: null, factId: 'annual-1' })
    expect(result.quality.inventory).toMatchObject({ value: 10, reason: null, factId: 'interim-1' })
    expect(result.quality.contractAssets).toEqual({ value: null, reason: '本地事实中缺少该指标', factId: null })
    expect(result.quality.nonRecurringProfit).toEqual({
      value: 3,
      reason: '归母净利润减扣非归母净利润，报告期 20240930',
      factId: null,
    })
  })

  it('阻断或空值的单季派生不冒充已覆盖报告期', () => {
    saveResearchFinancialFacts(db, [{
      id: 'blocked-quarter', companyId: 'company-1', sourceApi: 'derived_quarter_income',
      sourceFactKey: 'blocked-quarter', sourceVersion: 'v1', metricName: 'revenue_single_quarter',
      metricValue: null, reportPeriod: '20240930', factKind: 'derived', derivationFormula: '缺少前期',
      inputVersions: ['missing'], derivationStatus: 'blocked', fetchedAt: 240,
    }])

    const result = getIndustryResearchFinancialValidation(db, 'project-1', 'company-1')
    expect(result.coverage.recentSingleQuarters).toEqual([])
  })

  it('预告和披露计划不冒充正式中报覆盖', () => {
    saveResearchFinancialFacts(db, [
      {
        id: 'actual-interim', companyId: 'company-1', sourceApi: 'income', sourceFactKey: 'actual-interim', sourceVersion: 'v1',
        metricName: 'revenue', metricValue: 100, reportPeriod: '20250630', annDate: '20250820', fetchedAt: 250,
      },
      {
        id: 'future-forecast', companyId: 'company-1', sourceApi: 'forecast', sourceFactKey: 'future-forecast', sourceVersion: 'v1',
        metricName: 'net_profit_min', metricValue: 200, reportPeriod: '20260630', annDate: '20260710', fetchedAt: 260,
      },
      {
        id: 'future-disclosure', companyId: 'company-1', sourceApi: 'disclosure_date', sourceFactKey: 'future-disclosure', sourceVersion: 'v1',
        metricName: 'pre_date', textValue: '20260820', reportPeriod: '20260630', annDate: '20260625', fetchedAt: 270,
      },
    ])

    const result = getIndustryResearchFinancialValidation(db, 'project-1', 'company-1')
    expect(result.coverage.latestInterimPeriods).toEqual(['20250630'])
    expect(result.coverage.latestForecastOrExpress).toMatchObject({
      dataset: 'forecast', periodEnd: '20260630', announcementDate: '20260710',
    })
  })

  it('缺少预告快报和质量事实时返回null及稳定原因', () => {
    const result = getIndustryResearchFinancialValidation(db, 'project-1', 'company-1')

    expect(result.coverage.latestForecastOrExpress).toBeNull()
    expect(result.coverage.latestForecastOrExpressReason).toBe('本地事实中缺少预告或快报')
    expect(result.quality.operatingCashflow).toEqual({ value: null, reason: '本地事实中缺少该指标', factId: null })
  })
})
