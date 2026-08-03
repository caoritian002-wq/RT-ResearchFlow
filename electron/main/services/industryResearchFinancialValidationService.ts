import type Database from 'better-sqlite3'
import { listResearchFinancialFacts } from '../database/industryResearchFinancialRepository'
import type { IndustryResearchFinancialFactRow } from '../database/types'
import { IndustryResearchError } from './industryResearchService'

const QUALITY_METRICS = {
  receivables: ['accounts_receiv', 'notes_receiv'],
  inventory: ['inventories'],
  contractAssets: ['contract_assets'],
  operatingCashflow: ['n_cashflow_act', 'n_cashflow_act_single_quarter'],
  nonRecurringProfit: ['non_recurring_gain_loss'],
} as const

const REPORTED_STATEMENT_DATASETS = new Set(['income', 'balancesheet', 'cashflow', 'fina_indicator'])

function requireScope(db: Database.Database, projectId: string, companyId: string): void {
  const scope = db.prepare(`
    SELECT 1 FROM industry_research_project_companies
    WHERE project_id = ? AND company_id = ?
  `).get(projectId, companyId)
  if (!scope) throw new IndustryResearchError('NOT_FOUND', '项目公司不存在')
}

function latestMetric(
  facts: IndustryResearchFinancialFactRow[],
  metricNames: readonly string[],
): { value: number | null; reason: string | null; factId: string | null } {
  const fact = facts.find((item) => metricNames.includes(item.metric_name) && item.metric_value != null)
  return fact
    ? { value: fact.metric_value, reason: null, factId: fact.id }
    : { value: null, reason: '本地事实中缺少该指标', factId: null }
}

function uniquePeriods(facts: IndustryResearchFinancialFactRow[], suffixes: string[], limit: number): string[] {
  return Array.from(new Set(
    facts.map((fact) => fact.report_period).filter((period) => suffixes.some((suffix) => period.endsWith(suffix))),
  )).sort((left, right) => right.localeCompare(left)).slice(0, limit)
}

function latestNonRecurringProfit(
  facts: IndustryResearchFinancialFactRow[],
): { value: number | null; reason: string | null; factId: string | null } {
  const legacy = latestMetric(facts, QUALITY_METRICS.nonRecurringProfit)
  if (legacy.value != null) return legacy

  for (const deducted of facts.filter((fact) => fact.metric_name === 'profit_dedt' && fact.metric_value != null)) {
    const attributable = facts.find((fact) => (
      fact.metric_name === 'n_income_attr_p'
      && fact.metric_value != null
      && fact.report_period === deducted.report_period
      && (deducted.security_id == null || fact.security_id === deducted.security_id)
    ))
    if (!attributable || attributable.metric_value == null || deducted.metric_value == null) continue
    return {
      value: attributable.metric_value - deducted.metric_value,
      reason: `归母净利润减扣非归母净利润，报告期 ${deducted.report_period}`,
      factId: null,
    }
  }
  return { value: null, reason: '本地事实中缺少归母或扣非归母净利润', factId: null }
}

export function getIndustryResearchFinancialValidation(
  db: Database.Database,
  projectId: string,
  companyId: string,
) {
  requireScope(db, projectId, companyId)
  const facts = listResearchFinancialFacts(db, companyId)
  const reportedStatementFacts = facts.filter((fact) => (
    REPORTED_STATEMENT_DATASETS.has(fact.source_api)
    && fact.fact_kind === 'reported'
    && fact.metric_value != null
  ))
  const singleQuarterFacts = facts.filter((fact) => (
    fact.fact_kind === 'derived'
    && fact.derivation_status === 'derived'
    && fact.metric_value != null
  ))
  const latestForecastOrExpress = facts.find((fact) => fact.source_api === 'forecast' || fact.source_api === 'express')
  return {
    companyId,
    coverage: {
      recentSingleQuarters: uniquePeriods(singleQuarterFacts, ['0331', '0630', '0930', '1231'], 4),
      latestInterimPeriods: uniquePeriods(reportedStatementFacts, ['0630'], 1),
      recentAnnualPeriods: uniquePeriods(reportedStatementFacts, ['1231'], 3),
      latestForecastOrExpress: latestForecastOrExpress ? {
        dataset: latestForecastOrExpress.source_api,
        periodEnd: latestForecastOrExpress.report_period,
        announcementDate: latestForecastOrExpress.f_ann_date ?? latestForecastOrExpress.ann_date,
      } : null,
      latestForecastOrExpressReason: latestForecastOrExpress ? null : '本地事实中缺少预告或快报',
    },
    quality: {
      receivables: latestMetric(facts, QUALITY_METRICS.receivables),
      inventory: latestMetric(facts, QUALITY_METRICS.inventory),
      contractAssets: latestMetric(facts, QUALITY_METRICS.contractAssets),
      operatingCashflow: latestMetric(facts, QUALITY_METRICS.operatingCashflow),
      nonRecurringProfit: latestNonRecurringProfit(facts),
    },
  }
}
