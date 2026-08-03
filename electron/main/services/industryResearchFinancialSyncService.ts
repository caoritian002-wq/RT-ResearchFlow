import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import {
  recordResearchFinancialSyncFailure,
  recordResearchFinancialSyncSuccess,
  saveResearchBusinessExposure,
  saveResearchFinancialFacts,
  saveResearchMainBusinessItem,
  type ResearchFinancialFactInput,
} from '../database/industryResearchFinancialRepository'
import type { IndustryResearchFinancialDataset } from '../database/types'
import {
  fetchBalanceSheetFinancialRows,
  fetchCashflowFinancialRows,
  fetchFinancialAuditRows,
  fetchFinancialDisclosureDateRows,
  fetchFinancialExpressRows,
  fetchFinancialForecastRows,
  fetchFinancialIndicatorRows,
  fetchFinancialMainBusinessRows,
  fetchIncomeFinancialRows,
  type TushareFinancialRow,
} from './tushareService'

const FINANCIAL_DATASETS: IndustryResearchFinancialDataset[] = [
  'income',
  'balancesheet',
  'cashflow',
  'fina_indicator',
  'fina_audit',
  'forecast',
  'express',
  'disclosure_date',
  'fina_mainbz',
]

const QUARTERLY_METRICS: Partial<Record<IndustryResearchFinancialDataset, string[]>> = {
  income: ['revenue', 'n_income_attr_p'],
  cashflow: ['n_cashflow_act'],
  fina_indicator: ['profit_dedt'],
}

export interface IndustryResearchFinancialSyncInput {
  projectId: string
  companyId: string
  securityId: string
  tsCode: string
  datasets?: IndustryResearchFinancialDataset[]
}

export interface IndustryResearchFinancialDatasetResult {
  dataset: IndustryResearchFinancialDataset
  status: 'success' | 'failed'
  rowCount: number
  derivedFactCount: number
  errorCode: string | null
}

export interface IndustryResearchFinancialSyncResult {
  companyId: string
  securityId: string
  tsCode: string
  status: 'success' | 'partial' | 'failed'
  datasets: IndustryResearchFinancialDatasetResult[]
}

interface VersionedFinancialRow {
  row: TushareFinancialRow
  sourceFactKey: string
  sourceVersion: string
}

type FinancialFetcher = (token: string, tsCode: string) => Promise<TushareFinancialRow[]>
export type IndustryResearchFinancialFetchers = Record<IndustryResearchFinancialDataset, FinancialFetcher>

const FETCHERS: IndustryResearchFinancialFetchers = {
  income: fetchIncomeFinancialRows,
  balancesheet: fetchBalanceSheetFinancialRows,
  cashflow: fetchCashflowFinancialRows,
  fina_indicator: fetchFinancialIndicatorRows,
  fina_audit: fetchFinancialAuditRows,
  forecast: fetchFinancialForecastRows,
  express: fetchFinancialExpressRows,
  disclosure_date: fetchFinancialDisclosureDateRows,
  fina_mainbz: (token, tsCode) => fetchFinancialMainBusinessRows(token, tsCode, 'P'),
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(value).slice(0, 24)}`
}

function normalizeTsCode(tsCode: string): string {
  const normalized = tsCode.trim().toUpperCase()
  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) throw new Error('INVALID_TS_CODE')
  return normalized
}

function assertSyncScope(
  db: Database.Database,
  input: IndustryResearchFinancialSyncInput,
  tsCode: string,
): void {
  const project = db.prepare('SELECT id FROM industry_research_projects WHERE id = ?')
    .get(input.projectId) as { id: string } | undefined
  if (!project) throw new Error('RESEARCH_PROJECT_NOT_FOUND')
  const security = db.prepare(`
    SELECT id FROM industry_research_securities
    WHERE id = ? AND company_id = ? AND ts_code = ?
  `).get(input.securityId, input.companyId, tsCode) as { id: string } | undefined
  if (!security) throw new Error('RESEARCH_SECURITY_SCOPE_MISMATCH')
}

function buildSourceFactKey(
  dataset: IndustryResearchFinancialDataset,
  row: TushareFinancialRow,
): string {
  const discriminator = dataset === 'fina_mainbz' ? row.values.bz_item ?? null : null
  return stableHash({
    dataset,
    tsCode: row.tsCode,
    endDate: row.endDate,
    reportType: row.reportType,
    compType: row.compType,
    discriminator,
  })
}

function versionRows(
  dataset: IndustryResearchFinancialDataset,
  rows: TushareFinancialRow[],
): VersionedFinancialRow[] {
  return rows.map((row) => ({
    row,
    sourceFactKey: buildSourceFactKey(dataset, row),
    sourceVersion: stableHash({
      annDate: row.annDate,
      fAnnDate: row.fAnnDate,
      updateFlag: row.updateFlag,
      values: row.values,
    }),
  }))
}

function toReportedFacts(
  dataset: IndustryResearchFinancialDataset,
  companyId: string,
  securityId: string,
  rows: VersionedFinancialRow[],
  fetchedAt: number,
): ResearchFinancialFactInput[] {
  return rows.flatMap(({ row, sourceFactKey, sourceVersion }) => (
    Object.entries(row.values).map(([metricName, value]) => ({
      id: stableId('financial_fact', { dataset, sourceFactKey, sourceVersion, metricName }),
      companyId,
      securityId,
      sourceApi: dataset,
      sourceFactKey,
      sourceVersion,
      metricName,
      metricValue: typeof value === 'number' ? value : null,
      textValue: typeof value === 'string' ? value : null,
      annDate: row.annDate,
      fAnnDate: row.fAnnDate,
      reportPeriod: row.endDate,
      statementType: row.reportType,
      companyType: row.compType,
      updateFlag: row.updateFlag,
      fetchedAt,
    }))
  ))
}

function quarterEndSequence(endDate: string): { quarter: number; previousEndDate: string | null } | null {
  const year = endDate.slice(0, 4)
  const suffix = endDate.slice(4)
  if (suffix === '0331') return { quarter: 1, previousEndDate: null }
  if (suffix === '0630') return { quarter: 2, previousEndDate: `${year}0331` }
  if (suffix === '0930') return { quarter: 3, previousEndDate: `${year}0630` }
  if (suffix === '1231') return { quarter: 4, previousEndDate: `${year}0930` }
  return null
}

function sameAccountingBasis(left: TushareFinancialRow, right: TushareFinancialRow): boolean {
  return left.reportType === right.reportType
    && left.compType === right.compType
}

function selectPreviousQuarterRow(
  current: VersionedFinancialRow,
  rows: VersionedFinancialRow[],
  previousEndDate: string,
): VersionedFinancialRow | null {
  const candidates = rows
    .filter((candidate) => candidate.row.endDate === previousEndDate
      && sameAccountingBasis(current.row, candidate.row))
    .sort((left, right) => {
      const leftSameUpdateFlag = left.row.updateFlag === current.row.updateFlag ? 1 : 0
      const rightSameUpdateFlag = right.row.updateFlag === current.row.updateFlag ? 1 : 0
      if (leftSameUpdateFlag !== rightSameUpdateFlag) return rightSameUpdateFlag - leftSameUpdateFlag
      const leftDate = left.row.fAnnDate ?? left.row.annDate ?? ''
      const rightDate = right.row.fAnnDate ?? right.row.annDate ?? ''
      return rightDate.localeCompare(leftDate) || right.sourceVersion.localeCompare(left.sourceVersion)
    })
  return candidates[0] ?? null
}

export function deriveSingleQuarterFacts(
  dataset: IndustryResearchFinancialDataset,
  companyId: string,
  securityId: string,
  rows: VersionedFinancialRow[],
  fetchedAt: number,
): ResearchFinancialFactInput[] {
  const metrics = QUARTERLY_METRICS[dataset]
  if (!metrics) return []
  const facts: ResearchFinancialFactInput[] = []
  for (const current of rows) {
    const quarter = quarterEndSequence(current.row.endDate)
    if (!quarter) continue
    const previous = quarter.previousEndDate === null
      ? null
      : selectPreviousQuarterRow(current, rows, quarter.previousEndDate)
    for (const metricName of metrics) {
      const currentValue = current.row.values[metricName]
      const previousValue = previous?.row.values[metricName]
      const canDerive = typeof currentValue === 'number'
        && (quarter.quarter === 1 || typeof previousValue === 'number')
      const inputVersions = [
        `${dataset}:${current.sourceFactKey}:${current.sourceVersion}:${metricName}`,
        ...(previous ? [`${dataset}:${previous.sourceFactKey}:${previous.sourceVersion}:${metricName}`] : []),
      ]
      const formula = quarter.quarter === 1
        ? `${metricName}_Q1 = ${metricName}_YTD_Q1`
        : `${metricName}_Q${quarter.quarter} = ${metricName}_YTD_Q${quarter.quarter} - ${metricName}_YTD_Q${quarter.quarter - 1}`
      const sourceFactKey = stableHash({
        dataset: `derived_quarter_${dataset}`,
        endDate: current.row.endDate,
        reportType: current.row.reportType,
        compType: current.row.compType,
        metricName,
      })
      const sourceVersion = stableHash({ formula, inputVersions })
      facts.push({
        id: stableId('financial_fact', { sourceFactKey, sourceVersion, metricName }),
        companyId,
        securityId,
        sourceApi: `derived_quarter_${dataset}`,
        sourceFactKey,
        sourceVersion,
        metricName: `${metricName}_single_quarter`,
        metricValue: canDerive
          ? quarter.quarter === 1
            ? currentValue as number
            : (currentValue as number) - (previousValue as number)
          : null,
        annDate: current.row.annDate,
        fAnnDate: current.row.fAnnDate,
        reportPeriod: current.row.endDate,
        statementType: current.row.reportType,
        companyType: current.row.compType,
        updateFlag: current.row.updateFlag,
        factKind: 'derived',
        derivationFormula: formula,
        inputVersions,
        derivationStatus: canDerive ? 'derived' : 'blocked',
        fetchedAt,
      })
    }
  }
  return facts
}

function saveMainBusinessDataset(
  db: Database.Database,
  input: IndustryResearchFinancialSyncInput,
  rows: VersionedFinancialRow[],
  fetchedAt: number,
): void {
  for (const { row, sourceFactKey, sourceVersion } of rows) {
    const itemName = typeof row.values.bz_item === 'string' ? row.values.bz_item : null
    if (!itemName) continue
    const itemId = stableId('main_business', { sourceFactKey, sourceVersion })
    saveResearchMainBusinessItem(db, {
      id: itemId,
      companyId: input.companyId,
      sourceApi: 'fina_mainbz',
      sourceFactKey,
      sourceVersion,
      reportPeriod: row.endDate,
      dimension: 'product',
      itemName,
      revenue: typeof row.values.bz_sales === 'number' ? row.values.bz_sales : null,
      profit: typeof row.values.bz_profit === 'number' ? row.values.bz_profit : null,
      cost: typeof row.values.bz_cost === 'number' ? row.values.bz_cost : null,
      currency: typeof row.values.curr_type === 'string' ? row.values.curr_type : null,
      fetchedAt,
    }, fetchedAt)
    saveResearchBusinessExposure(db, {
      id: stableId('business_exposure', { projectId: input.projectId, sourceFactKey }),
      projectId: input.projectId,
      companyId: input.companyId,
      mainBusinessItemId: itemId,
      sourceKey: sourceFactKey,
      sourceType: 'fina_mainbz',
      status: 'candidate',
      basis: `Tushare fina_mainbz 产品口径候选: ${itemName}`,
      createdBy: 'import',
    }, fetchedAt)
  }
}

function normalizeSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('TUSHARE_QUOTA_INSUFFICIENT')) return 'PERMISSION_REQUIRED'
  if (/频率|每分钟|访问太频繁|rate/i.test(message)) return 'RATE_LIMITED'
  if (message === 'EMPTY_RESPONSE') return message
  return 'UPSTREAM_ERROR'
}

async function syncDataset(
  db: Database.Database,
  token: string,
  input: IndustryResearchFinancialSyncInput,
  tsCode: string,
  dataset: IndustryResearchFinancialDataset,
  fetchedAt: number,
  fetchers: IndustryResearchFinancialFetchers,
): Promise<IndustryResearchFinancialDatasetResult> {
  try {
    const rows = await fetchers[dataset](token, tsCode)
    if (rows.length === 0) throw new Error('EMPTY_RESPONSE')
    const versionedRows = versionRows(dataset, rows)
    const reportedFacts = dataset === 'fina_mainbz'
      ? []
      : toReportedFacts(dataset, input.companyId, input.securityId, versionedRows, fetchedAt)
    const derivedFacts = deriveSingleQuarterFacts(
      dataset,
      input.companyId,
      input.securityId,
      versionedRows,
      fetchedAt,
    )
    db.transaction(() => {
      if (dataset === 'fina_mainbz') {
        saveMainBusinessDataset(db, input, versionedRows, fetchedAt)
      } else {
        saveResearchFinancialFacts(db, [...reportedFacts, ...derivedFacts], fetchedAt)
      }
      const latestFactDate = rows.reduce<string | null>((latest, row) => (
        latest === null || row.endDate > latest ? row.endDate : latest
      ), null)
      recordResearchFinancialSyncSuccess(
        db,
        input.companyId,
        dataset,
        latestFactDate,
        rows.length,
        fetchedAt,
      )
    })()
    return {
      dataset,
      status: 'success',
      rowCount: rows.length,
      derivedFactCount: derivedFacts.length,
      errorCode: null,
    }
  } catch (error) {
    const errorCode = normalizeSyncError(error)
    recordResearchFinancialSyncFailure(db, input.companyId, dataset, errorCode, fetchedAt)
    return { dataset, status: 'failed', rowCount: 0, derivedFactCount: 0, errorCode }
  }
}

export async function syncIndustryResearchCompanyFinancials(
  db: Database.Database,
  token: string,
  input: IndustryResearchFinancialSyncInput,
  now = Date.now(),
  fetchers: IndustryResearchFinancialFetchers = FETCHERS,
): Promise<IndustryResearchFinancialSyncResult> {
  const tsCode = normalizeTsCode(input.tsCode)
  assertSyncScope(db, input, tsCode)
  const datasets = input.datasets ?? FINANCIAL_DATASETS
  if (datasets.length === 0 || datasets.some((dataset) => !FINANCIAL_DATASETS.includes(dataset))) {
    throw new Error('INVALID_FINANCIAL_DATASETS')
  }
  const uniqueDatasets = Array.from(new Set(datasets))
  const results: IndustryResearchFinancialDatasetResult[] = []
  for (const dataset of uniqueDatasets) {
    results.push(await syncDataset(db, token, input, tsCode, dataset, now, fetchers))
  }
  const successCount = results.filter((result) => result.status === 'success').length
  return {
    companyId: input.companyId,
    securityId: input.securityId,
    tsCode,
    status: successCount === results.length ? 'success' : successCount === 0 ? 'failed' : 'partial',
    datasets: results,
  }
}
