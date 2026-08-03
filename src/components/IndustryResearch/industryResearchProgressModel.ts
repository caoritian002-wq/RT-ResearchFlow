export interface ProjectFinancialCollectionView {
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'blocked' | 'cancelled'
  source: 'tushare'
  totalCompanies: number
  completedCompanies: number
  totalDatasets: number
  coveredDatasets: number
  failedDatasets: number
  pendingDatasets: number
  attemptedDatasets: number
  skippedDatasets: number
  processedDatasets?: number
  currentCompanyId: string | null
  currentCompanyName: string | null
  currentTsCode: string | null
  currentCompanyIndex?: number | null
  currentDataset: string | null
  currentDatasetIndex?: number | null
  errorCode: string | null
  message: string
  startedAt: number
  updatedAt: number
  completedAt: number | null
  companies: Array<{
    companyId: string
    companyName: string
    securityId: string
    tsCode: string
    coveredDatasets: number
    failedDatasets: number
    pendingDatasets: number
  }>
}

export const RESEARCH_STAGE_LABELS: Record<string, string> = {
  retrieve: '联网取证',
  scope: '研究边界',
  map: '结构化图谱',
  evidence: '证据整理',
  hypothesis: '核心假设',
  companies: '公司映射',
  report: '研究报告',
}

export const FINANCIAL_DATASET_LABELS: Record<string, string> = {
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

function boundedInteger(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback
}

export function buildResearchStageProgress(input: {
  status: string
  stage: string
  progressCurrent: number
  progressTotal: number
  financialCollection?: ProjectFinancialCollectionView | null
}) {
  const total = boundedInteger(input.progressTotal)
  const current = Math.min(total, boundedInteger(input.progressCurrent))
  const active = input.status === 'queued' || input.status === 'running'
  const completed = input.status === 'succeeded' ? total : Math.max(0, current - 1)
  const label = active && input.stage === 'report'
    ? '研究报告生成中（尚未完成）'
    : input.stage === 'companies' && input.financialCollection?.status === 'running'
      ? '公司业务与财务采集'
      : RESEARCH_STAGE_LABELS[input.stage] || input.stage || '准备研究'
  return {
    current,
    total,
    completed,
    label,
    percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
    positionLabel: total > 0 ? `阶段 ${current}/${total}` : '正在准备',
    completedLabel: total > 0 ? `已完成 ${completed}/${total} 个阶段` : '正在准备',
  }
}

export function formatResearchWaitDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}秒`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}小时${minutes}分`
  return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分钟`
}

export function buildFinancialCollectionProgress(collection?: ProjectFinancialCollectionView | null) {
  if (!collection || collection.totalDatasets <= 0) return null
  const total = boundedInteger(collection.totalDatasets)
  const hasExactProcessed = Number.isFinite(Number(collection.processedDatasets))
  const legacyInFlight = collection.status === 'running' && collection.currentDataset ? 1 : 0
  const processed = Math.min(total, hasExactProcessed
    ? boundedInteger(collection.processedDatasets)
    : Math.max(0, boundedInteger(collection.skippedDatasets) + boundedInteger(collection.attemptedDatasets) - legacyInFlight))
  const companyIndex = boundedInteger(collection.currentCompanyIndex)
  const datasetIndex = boundedInteger(collection.currentDatasetIndex)
  const companyLabel = [collection.currentCompanyName, collection.currentTsCode && `（${collection.currentTsCode}）`]
    .filter(Boolean)
    .join('')
  const datasetLabel = collection.currentDataset
    ? FINANCIAL_DATASET_LABELS[collection.currentDataset] || collection.currentDataset
    : ''
  return {
    processed,
    total,
    percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    processedLabel: `已处理 ${processed}/${total}`,
    coverageLabel: `已覆盖 ${boundedInteger(collection.coveredDatasets)}/${total}`,
    positionLabel: [
      companyIndex > 0 && collection.totalCompanies > 0 ? `公司 ${companyIndex}/${collection.totalCompanies}` : '',
      datasetIndex > 0 ? `数据项 ${datasetIndex}/9` : '',
    ].filter(Boolean).join(' · '),
    currentLabel: [companyLabel, datasetLabel].filter(Boolean).join(' · '),
  }
}
