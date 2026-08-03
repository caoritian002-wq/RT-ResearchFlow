import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import {
  listResearchFinancialSyncStates,
  listResearchProjectCompanies,
  listResearchSecurities,
  recordResearchFinancialSyncStarted,
  saveResearchBusinessExposure,
} from '../database/industryResearchFinancialRepository'
import type {
  IndustryResearchFinancialDataset,
  IndustryResearchFinancialSyncStateRow,
} from '../database/types'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import {
  syncIndustryResearchCompanyFinancials,
  type IndustryResearchFinancialFetchers,
} from './industryResearchFinancialSyncService'

export const PROJECT_FINANCIAL_DATASETS: IndustryResearchFinancialDataset[] = [
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

const PROJECT_FINANCIAL_DATASET_LABELS: Record<IndustryResearchFinancialDataset, string> = {
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

export type ProjectFinancialCollectionStatus =
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'cancelled'

export interface ProjectFinancialCollectionCompany {
  companyId: string
  companyName: string
  securityId: string
  tsCode: string
  coveredDatasets: number
  failedDatasets: number
  pendingDatasets: number
}

export interface ProjectFinancialCollectionState {
  status: ProjectFinancialCollectionStatus
  source: 'tushare'
  totalCompanies: number
  completedCompanies: number
  totalDatasets: number
  coveredDatasets: number
  failedDatasets: number
  pendingDatasets: number
  attemptedDatasets: number
  skippedDatasets: number
  processedDatasets: number
  currentCompanyId: string | null
  currentCompanyName: string | null
  currentTsCode: string | null
  currentCompanyIndex: number | null
  currentDataset: IndustryResearchFinancialDataset | null
  currentDatasetIndex: number | null
  errorCode: string | null
  message: string
  startedAt: number
  updatedAt: number
  completedAt: number | null
  companies: ProjectFinancialCollectionCompany[]
}

interface CollectionTarget {
  companyId: string
  companyName: string
  securityId: string
  tsCode: string
}

interface CollectProjectFinancialsOptions {
  token?: string | null
  fetchers?: IndustryResearchFinancialFetchers
  shouldCancel?: () => boolean
  onProgress?: (state: ProjectFinancialCollectionState) => void
  now?: () => number
}

function isListedAShare(tsCode: string, listStatus: string | null): boolean {
  return /^\d{6}\.(SH|SZ|BJ)$/.test(tsCode) && (listStatus === null || listStatus === 'L')
}

function listTargets(db: Database.Database, projectId: string): CollectionTarget[] {
  return listResearchProjectCompanies(db, projectId)
    .filter((company) => company.status !== 'excluded')
    .flatMap((company) => {
      const security = listResearchSecurities(db, company.company_id)
        .find((item) => isListedAShare(item.ts_code, item.list_status))
      if (!security) return []
      return [{
        companyId: company.company_id,
        companyName: company.short_name || company.legal_name,
        securityId: security.id,
        tsCode: security.ts_code,
      }]
    })
}

function stateMap(
  db: Database.Database,
  companyId: string,
): Map<IndustryResearchFinancialDataset, IndustryResearchFinancialSyncStateRow> {
  return new Map(listResearchFinancialSyncStates(db, companyId).map((item) => [item.dataset, item]))
}

function stableExposureId(projectId: string, sourceFactKey: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ projectId, sourceFactKey }))
    .digest('hex')
    .slice(0, 24)
  return `business_exposure_${hash}`
}

function ensureProjectMainBusinessExposureCandidates(
  db: Database.Database,
  projectId: string,
  target: CollectionTarget,
): void {
  const items = db.prepare(`
    SELECT item.id, item.source_fact_key, item.item_name, item.fetched_at
    FROM industry_research_main_business_items item
    WHERE item.company_id = ? AND item.source_api = 'fina_mainbz'
      AND NOT EXISTS (
        SELECT 1
        FROM industry_research_main_business_items newer
        WHERE newer.company_id = item.company_id
          AND newer.source_api = item.source_api
          AND newer.source_fact_key = item.source_fact_key
          AND (newer.fetched_at > item.fetched_at
            OR (newer.fetched_at = item.fetched_at AND newer.source_version > item.source_version))
      )
    ORDER BY item.report_period DESC, item.item_name
  `).all(target.companyId) as Array<{
    id: string
    source_fact_key: string
    item_name: string
    fetched_at: number
  }>
  db.transaction(() => {
    for (const item of items) {
      saveResearchBusinessExposure(db, {
        id: stableExposureId(projectId, item.source_fact_key),
        projectId,
        companyId: target.companyId,
        mainBusinessItemId: item.id,
        sourceKey: item.source_fact_key,
        sourceType: 'fina_mainbz',
        status: 'candidate',
        basis: `Tushare fina_mainbz 产品口径候选: ${item.item_name}`,
        createdBy: 'import',
      }, item.fetched_at)
    }
  })()
}

function buildState(
  db: Database.Database,
  targets: CollectionTarget[],
  input: {
    status: ProjectFinancialCollectionStatus
    startedAt: number
    updatedAt: number
    completedAt?: number | null
    attemptedDatasets: number
    skippedDatasets: number
    processedDatasets: number
    currentTarget?: CollectionTarget | null
    currentDataset?: IndustryResearchFinancialDataset | null
    errorCode?: string | null
    message: string
  },
): ProjectFinancialCollectionState {
  let coveredDatasets = 0
  let failedDatasets = 0
  let pendingDatasets = 0
  let completedCompanies = 0
  const companies = targets.map((target) => {
    const states = stateMap(db, target.companyId)
    let companyCovered = 0
    let companyFailed = 0
    let companyPending = 0
    for (const dataset of PROJECT_FINANCIAL_DATASETS) {
      const state = states.get(dataset)
      if (state?.last_success_at != null) companyCovered += 1
      if (state?.status === 'failed') companyFailed += 1
      if (state?.status !== 'success') companyPending += 1
    }
    coveredDatasets += companyCovered
    failedDatasets += companyFailed
    pendingDatasets += companyPending
    if (companyPending === 0) completedCompanies += 1
    return {
      companyId: target.companyId,
      companyName: target.companyName,
      securityId: target.securityId,
      tsCode: target.tsCode,
      coveredDatasets: companyCovered,
      failedDatasets: companyFailed,
      pendingDatasets: companyPending,
    }
  })
  return {
    status: input.status,
    source: 'tushare',
    totalCompanies: targets.length,
    completedCompanies,
    totalDatasets: targets.length * PROJECT_FINANCIAL_DATASETS.length,
    coveredDatasets,
    failedDatasets,
    pendingDatasets,
    attemptedDatasets: input.attemptedDatasets,
    skippedDatasets: input.skippedDatasets,
    processedDatasets: input.processedDatasets,
    currentCompanyId: input.currentTarget?.companyId ?? null,
    currentCompanyName: input.currentTarget?.companyName ?? null,
    currentTsCode: input.currentTarget?.tsCode ?? null,
    currentCompanyIndex: input.currentTarget
      ? targets.findIndex((target) => target.companyId === input.currentTarget?.companyId) + 1
      : null,
    currentDataset: input.currentDataset ?? null,
    currentDatasetIndex: input.currentDataset
      ? PROJECT_FINANCIAL_DATASETS.indexOf(input.currentDataset) + 1
      : null,
    errorCode: input.errorCode ?? null,
    message: input.message,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    completedAt: input.completedAt ?? null,
    companies,
  }
}

function resolveToken(db: Database.Database, explicitToken: string | null | undefined): string | null {
  if (explicitToken !== undefined) return explicitToken?.trim() || null
  const config = getDataSourceConfig(db)
  if (!config.tushareEnabled || !config.tushareTokenEncrypted) return null
  return decryptApiKey(config.tushareTokenEncrypted)?.trim() || null
}

export async function collectIndustryResearchProjectFinancials(
  db: Database.Database,
  projectId: string,
  options: CollectProjectFinancialsOptions = {},
): Promise<ProjectFinancialCollectionState> {
  const now = options.now || Date.now
  const startedAt = now()
  const targets = listTargets(db, projectId)
  const emit = (state: ProjectFinancialCollectionState): ProjectFinancialCollectionState => {
    options.onProgress?.(state)
    return state
  }
  if (targets.length === 0) {
    return emit(buildState(db, targets, {
      status: 'blocked', startedAt, updatedAt: now(), completedAt: now(),
      attemptedDatasets: 0, skippedDatasets: 0, processedDatasets: 0,
      errorCode: 'NO_ELIGIBLE_PROJECT_COMPANIES',
      message: '没有可采集的唯一 A 股公司与证券映射',
    }))
  }
  const token = resolveToken(db, options.token)
  if (!token) {
    return emit(buildState(db, targets, {
      status: 'blocked', startedAt, updatedAt: now(), completedAt: now(),
      attemptedDatasets: 0, skippedDatasets: 0, processedDatasets: 0,
      errorCode: 'FINANCIAL_SOURCE_DISABLED',
      message: 'Tushare 财务数据源未启用或 Token 不可用，报告将保留财务覆盖缺口',
    }))
  }

  let attemptedDatasets = 0
  let skippedDatasets = 0
  let processedDatasets = 0
  emit(buildState(db, targets, {
    status: 'running', startedAt, updatedAt: now(), attemptedDatasets, skippedDatasets, processedDatasets,
    message: `开始采集 ${targets.length} 家项目公司的业务与财务数据`,
  }))

  for (const target of targets) {
    ensureProjectMainBusinessExposureCandidates(db, projectId, target)
    for (const dataset of PROJECT_FINANCIAL_DATASETS) {
      if (options.shouldCancel?.()) {
        return emit(buildState(db, targets, {
          status: 'cancelled', startedAt, updatedAt: now(), completedAt: now(),
          attemptedDatasets, skippedDatasets, processedDatasets,
          errorCode: 'FINANCIAL_COLLECTION_CANCELLED',
          message: '财务采集已中断，已完成的数据已保留，可稍后继续收集',
        }))
      }
      const existing = stateMap(db, target.companyId).get(dataset)
      if (existing?.status === 'success' && existing.last_success_at != null) {
        skippedDatasets += 1
        processedDatasets += 1
        continue
      }
      const attemptedAt = now()
      recordResearchFinancialSyncStarted(db, target.companyId, dataset, attemptedAt)
      attemptedDatasets += 1
      emit(buildState(db, targets, {
        status: 'running', startedAt, updatedAt: attemptedAt,
        attemptedDatasets, skippedDatasets, processedDatasets,
        currentTarget: target, currentDataset: dataset,
        message: `正在采集 ${target.companyName}（${target.tsCode}）的${PROJECT_FINANCIAL_DATASET_LABELS[dataset]}`,
      }))
      const syncResult = await syncIndustryResearchCompanyFinancials(db, token, {
        projectId,
        companyId: target.companyId,
        securityId: target.securityId,
        tsCode: target.tsCode,
        datasets: [dataset],
      }, attemptedAt, options.fetchers)
      processedDatasets += 1
      const datasetResult = syncResult.datasets[0]
      emit(buildState(db, targets, {
        status: 'running', startedAt, updatedAt: now(),
        attemptedDatasets, skippedDatasets, processedDatasets,
        currentTarget: target, currentDataset: dataset,
        message: datasetResult?.status === 'success'
          ? `已完成 ${target.companyName}（${target.tsCode}）的${PROJECT_FINANCIAL_DATASET_LABELS[dataset]}`
          : `${target.companyName}（${target.tsCode}）的${PROJECT_FINANCIAL_DATASET_LABELS[dataset]}暂未取得，继续下一项`,
      }))
    }
  }

  const snapshot = buildState(db, targets, {
    status: 'running', startedAt, updatedAt: now(), attemptedDatasets, skippedDatasets, processedDatasets,
    message: '财务采集完成，正在计算覆盖率',
  })
  const finalStatus: ProjectFinancialCollectionStatus = snapshot.pendingDatasets === 0
    ? 'succeeded'
    : snapshot.coveredDatasets > 0
      ? 'partial'
      : 'failed'
  const completedAt = now()
  return emit(buildState(db, targets, {
    status: finalStatus,
    startedAt,
    updatedAt: completedAt,
    completedAt,
    attemptedDatasets,
    skippedDatasets,
    processedDatasets,
    errorCode: finalStatus === 'succeeded' ? null : 'FINANCIAL_COLLECTION_INCOMPLETE',
    message: finalStatus === 'succeeded'
      ? `已完成 ${targets.length} 家公司的业务与财务采集`
      : `财务采集部分完成：已覆盖 ${snapshot.coveredDatasets}/${snapshot.totalDatasets} 个公司数据集，失败 ${snapshot.failedDatasets} 个`,
  }))
}
