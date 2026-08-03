import React, { useEffect, useState } from 'react'
import { ResearchWebSearchConfigPanel } from './ResearchWebSearchConfigPanel'
import type {
  ResearchGeneratedReportDocument,
  ResearchNativeWebSearchView,
  ResearchReportFindingInput,
} from './industryResearchTypes'
import {
  buildFinancialCollectionProgress,
  buildResearchStageProgress,
  formatResearchWaitDuration,
  type ProjectFinancialCollectionView,
} from './industryResearchProgressModel'

export type { ProjectFinancialCollectionView } from './industryResearchProgressModel'

export interface GenerationRunView {
  id: string
  projectId: string
  researchQuestion: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  currentStage: string
  lastSuccessfulStage: string | null
  progressCurrent: number
  progressTotal: number
  progressMessage: string
  cancelRequested: boolean
  provider: string | null
  model: string | null
  errorCode: string | null
  errorMessage: string | null
  retryable: boolean
  selectedTopNIds?: string[]
  retrievalMode?: string | null
  nativeWebSearch?: ResearchNativeWebSearchView | null
  retrievalPlan?: {
    localHitCount?: number
    webHitCount?: number
    detailPageCount?: number
    selectedTopN?: number
    candidatePoolSize?: number
    message?: string
    degradedCode?: string | null
    enhancedSearch?: {
      providerId?: string | null
      configured?: boolean
      status?: 'disabled' | 'not_configured' | 'key_unavailable' | 'succeeded' | 'empty' | 'failed'
      errorCode?: string | null
    }
    queries?: Array<{ intent?: string; text?: string; hitCount?: number; status?: string }>
  } | null
  reportPartitions?: {
    supportedFindings?: ResearchReportFindingInput[]
    modelOnlyFindings?: string[]
    pendingSources?: string[]
    evidenceInsufficient?: boolean
  } | null
  reportDocument?: ResearchGeneratedReportDocument | null
  financialCollection?: ProjectFinancialCollectionView | null
  createdAt?: number
  startedAt?: number | null
  updatedAt?: number
  completedAt?: number | null
}

interface Props {
  run: GenerationRunView | null
  busy?: boolean
  onCancel?: () => void
  onRetry?: () => void
  onContinueFinancials?: () => void
}

const STATUS_LABEL: Record<GenerationRunView['status'], string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const MODE_META: Record<string, { label: string; className: string; hint: string }> = {
  strong: {
    label: '强取证',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    hint: '增强搜索与详情页可用',
  },
  mixed: {
    label: '混合取证',
    className: 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
    hint: '本地语料与外网结果混合',
  },
  weak: {
    label: '弱检索',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
    hint: '未完成强外部取证，结论需谨慎核验',
  },
  offline: {
    label: '离线/无外网',
    className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    hint: '外网不可用，仅模型与本地线索',
  },
}

export function ResearchGenerationStatus({ run, busy, onCancel, onRetry, onContinueFinancials }: Props): React.ReactElement | null {
  const [showSearchConfig, setShowSearchConfig] = useState(false)
  const [showCompletedDetails, setShowCompletedDetails] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  const runIsActive = Boolean(run && ['queued', 'running'].includes(run.status))
  useEffect(() => {
    if (!runIsActive) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 5_000)
    return () => window.clearInterval(timer)
  }, [run?.id, runIsActive])
  if (!run) return null
  const isActive = ['queued', 'running'].includes(run.status)
  const financialCollection = run.financialCollection
  const stageProgress = buildResearchStageProgress({
    status: run.status,
    stage: run.currentStage,
    progressCurrent: run.progressCurrent,
    progressTotal: run.progressTotal,
    financialCollection,
  })
  const financialProgress = buildFinancialCollectionProgress(financialCollection)
  const isReportGenerating = isActive && run.currentStage === 'report'
  const reportWaitStartedAt = run.updatedAt ?? run.startedAt ?? clock
  const reportWaitMs = Math.max(0, clock - reportWaitStartedAt)
  const reportWaitLabel = formatResearchWaitDuration(reportWaitMs)
  const reportWaitIsLong = reportWaitMs >= 120_000
  const financialInterrupted = run.status === 'failed'
    && run.currentStage === 'companies'
    && run.lastSuccessfulStage === 'companies'
  const canContinueFinancials = Boolean(onContinueFinancials)
    && !isActive
    && (financialInterrupted
      || !financialCollection
      || (financialCollection.status !== 'succeeded'
        && financialCollection.errorCode !== 'NO_ELIGIBLE_PROJECT_COMPANIES'))
  const stageLabel = stageProgress.label
  const persistencePending = run.status === 'failed'
    && run.currentStage === 'report'
    && Boolean(run.reportDocument?.markdown)
    && run.lastSuccessfulStage === 'companies'
  const mode = run.retrievalMode ? MODE_META[run.retrievalMode] : null
  const plan = run.retrievalPlan
  const showWeakConfig = run.retrievalMode === 'weak' || run.retrievalMode === 'offline'
  const enhancedSearch = plan?.enhancedSearch
  const enhancedSearchNeedsRepair = enhancedSearch?.status === 'key_unavailable'
    || enhancedSearch?.status === 'failed'
  const enhancedSearchReturnedEmpty = enhancedSearch?.status === 'empty'
  const enhancedSearchSucceeded = enhancedSearch?.status === 'succeeded'
  const enhancedSearchDisabled = enhancedSearch?.status === 'disabled'
  const enhancedProvider = enhancedSearch?.providerId === 'tavily'
    ? 'Tavily'
    : enhancedSearch?.providerId === 'bing'
      ? 'Bing'
      : '增强搜索'
  const weakSearchMessage = enhancedSearchNeedsRepair
    ? enhancedSearch?.status === 'key_unavailable'
      ? `${enhancedProvider} 已配置，但保存的密钥本轮无法解密。应用已自动回退；完整重启后可直接重试，无需重新填写密钥。`
      : `${enhancedProvider} 已配置并已发起调用，但本轮请求失败。应用已自动回退，可检查连接后重试。`
    : enhancedSearchReturnedEmpty
      ? `${enhancedProvider} 已正常调用，但本轮没有返回可用结果，应用已自动回退到其他来源。`
      : enhancedSearchSucceeded
        ? `${enhancedProvider} 本轮调用成功，但有效召回或详情页数量不足，因此仍按弱取证展示。`
        : enhancedSearchDisabled
          ? '本轮已按用户选择关闭联网取证，仅使用本地语料。'
          : '当前为弱检索/离线取证。配置 Tavily 或 Bing 后，下次研究可提升公开资料质量。'
  const canOpenSearchConfig = showWeakConfig
    && (!enhancedSearch || enhancedSearch.status === 'not_configured' || enhancedSearchNeedsRepair)
  if (run.status === 'succeeded') {
    return (
      <section data-testid="industry-research-generation-complete" className="min-w-0">
        <div className="flex min-h-8 items-center gap-2 text-[11px]">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
          <span className="shrink-0 font-semibold text-emerald-700 dark:text-emerald-300">AI 研究已完成</span>
          <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300" title={run.researchQuestion}>{run.researchQuestion}</span>
          {mode && <span className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${mode.className}`} title={showWeakConfig ? weakSearchMessage : mode.hint}>{mode.label}</span>}
          {financialCollection && (
            <span
              data-testid="industry-research-financial-coverage"
              className={`hidden shrink-0 rounded px-1.5 py-0.5 font-semibold lg:inline ${financialCollection.status === 'succeeded'
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'}`}
              title={financialCollection.message}
            >
              财务 {financialCollection.coveredDatasets}/{financialCollection.totalDatasets}
            </span>
          )}
          <span className="hidden shrink-0 text-slate-400 xl:inline">代表性来源 {plan?.selectedTopN ?? 0} · 详情页 {plan?.detailPageCount ?? 0}</span>
          {canContinueFinancials && (
            <button
              type="button"
              disabled={busy}
              onClick={onContinueFinancials}
              className="min-h-8 shrink-0 rounded-md border border-cyan-300 bg-white px-2.5 font-semibold text-cyan-700 transition-colors hover:bg-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-cyan-800 dark:bg-slate-900 dark:text-cyan-300 dark:hover:bg-cyan-950/30"
            >
              继续收集并更新报告
            </button>
          )}
          <button
            type="button"
            aria-expanded={showCompletedDetails}
            onClick={() => setShowCompletedDetails((current) => !current)}
            className="shrink-0 rounded px-2 py-1 font-medium text-cyan-700 transition-colors hover:bg-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:text-cyan-300 dark:hover:bg-cyan-950/30"
          >
            {showCompletedDetails ? '收起' : '运行详情'}
          </button>
        </div>
        {showCompletedDetails && (
          <div className="grid gap-x-5 gap-y-1 border-t border-slate-200 py-2 text-[11px] text-slate-500 sm:grid-cols-2 lg:grid-cols-4 dark:border-slate-800 dark:text-slate-400">
            <span>模型：{run.provider && run.model ? `${run.provider}/${run.model}` : '未记录'}</span>
            <span>来源：候选 {plan?.candidatePoolSize ?? 0} / 代表 {plan?.selectedTopN ?? 0}</span>
            <span>检索：本地 {plan?.localHitCount ?? 0} / 外网 {plan?.webHitCount ?? 0}</span>
            <span>完成阶段：{stageLabel}</span>
            {financialCollection && <span>公司财务：覆盖 {financialCollection.coveredDatasets}/{financialCollection.totalDatasets} · 失败 {financialCollection.failedDatasets}</span>}
          </div>
        )}
      </section>
    )
  }
  return (
    <section className="rounded-md border border-slate-200 bg-white px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">AI 研究</span>
            <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{run.researchQuestion}</span>
            {mode && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${mode.className}`} title={mode.hint}>
                {mode.label}
              </span>
            )}
          </div>
          <div aria-live="polite" className={`mt-0.5 text-[11px] ${reportWaitIsLong ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'}`}>
            {persistencePending ? '待写回' : STATUS_LABEL[run.status]} · {stageLabel}
            {run.provider && run.model ? ` · ${run.provider}/${run.model}` : ''}
            {isReportGenerating
              ? ` · ${reportWaitIsLong ? '模型返回时间较长' : '正在等待模型返回'}`
              : run.progressMessage ? ` · ${run.progressMessage}` : ''}
          </div>
          {plan && (
            <div className="mt-1 text-[11px] text-slate-400">
              系统已处理 {plan.candidatePoolSize ?? 0} 条来源 · 代表性来源 {plan.selectedTopN ?? 0}
              · 本地 {plan.localHitCount ?? 0} · 外网 {plan.webHitCount ?? 0}
              · 详情页 {plan.detailPageCount ?? 0}
              {mode ? ` · ${mode.hint}` : ''}
            </div>
          )}
          {isReportGenerating && (
            <div
              data-testid="industry-research-report-waiting"
              role="status"
              className={`mt-2 flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-[11px] ${reportWaitIsLong
                ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/25 dark:text-amber-300'
                : 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/25 dark:text-cyan-200'}`}
            >
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" aria-hidden="true" />
              <span>
                <strong>报告生成中，尚未完成。</strong>
                {reportWaitIsLong
                  ? <>
                      {' 模型返回时间较长，'}
                      <span aria-hidden="true">已等待 {reportWaitLabel}；</span>
                      可以继续等待，或取消后稍后重试。
                    </>
                  : <>
                      <span aria-hidden="true"> 本步骤已等待 {reportWaitLabel}。</span>
                      {' 模型正在组织完整正文，完成后会自动切换为100%。'}
                    </>}
              </span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {isActive && onCancel && (
            <button
              type="button"
              disabled={busy || run.cancelRequested}
              onClick={onCancel}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-[11px] disabled:opacity-40 dark:border-slate-700"
            >
              {run.cancelRequested ? '取消中' : '取消'}
            </button>
          )}
          {run.retryable && onRetry && (
            !financialInterrupted &&
            <button
              type="button"
              disabled={busy}
              title={persistencePending ? '复用已经生成的报告和图谱，只重新写入项目，不再调用模型' : undefined}
              onClick={onRetry}
              className="rounded-md bg-cyan-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {persistencePending ? '写回项目' : '重试'}
            </button>
          )}
          {financialInterrupted && onContinueFinancials && (
            <button
              type="button"
              disabled={busy}
              onClick={onContinueFinancials}
              className="min-h-8 rounded-md bg-cyan-700 px-2.5 text-[11px] font-semibold text-white hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              继续收集并更新报告
            </button>
          )}
        </div>
      </div>
      {isActive && (
        <div className="mt-2 space-y-2">
          <div>
            <div className="mb-1 flex items-center justify-between gap-3 text-[10px] text-slate-500 dark:text-slate-400">
              <span>{isReportGenerating ? stageProgress.completedLabel : stageProgress.positionLabel} · {stageLabel}</span>
              <span className="shrink-0 tabular-nums">{isReportGenerating ? `已等待 ${reportWaitLabel}` : `${stageProgress.percent}%`}</span>
            </div>
            <div
              data-testid="industry-research-stage-progress"
              role="progressbar"
              aria-label={`产业研究${stageProgress.positionLabel}，${stageLabel}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={stageProgress.percent}
              aria-valuetext={isReportGenerating
                ? `${stageProgress.completedLabel}，研究报告生成中，尚未完成`
                : `${stageProgress.percent}%`}
              className="relative h-1.5 overflow-hidden rounded bg-slate-100 dark:bg-slate-800"
            >
              <div className="h-full bg-cyan-600 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${stageProgress.percent}%` }} />
              {isReportGenerating && (
                <div
                  aria-hidden="true"
                  className="absolute inset-y-0 right-0 animate-pulse bg-cyan-300/45 motion-reduce:animate-none dark:bg-cyan-700/35"
                  style={{ left: `${stageProgress.percent}%` }}
                />
              )}
            </div>
          </div>
          {isActive && financialCollection?.status === 'running' && financialProgress && (
            <div data-testid="industry-research-financial-progress">
              <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-[10px] text-slate-500 dark:text-slate-400">
                <span className="min-w-0 truncate" title={financialProgress.currentLabel}>
                  {financialProgress.positionLabel}{financialProgress.currentLabel ? ` · ${financialProgress.currentLabel}` : ''}
                </span>
                <span className="shrink-0 tabular-nums">{financialProgress.processedLabel}</span>
              </div>
              <div
                role="progressbar"
                aria-label={`公司财务采集，${financialProgress.processedLabel}`}
                aria-valuemin={0}
                aria-valuemax={financialProgress.total}
                aria-valuenow={financialProgress.processed}
                className="h-1.5 overflow-hidden rounded bg-slate-100 dark:bg-slate-800"
              >
                <div className="h-full bg-emerald-500 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${financialProgress.percent}%` }} />
              </div>
            </div>
          )}
        </div>
      )}
      {(run.errorCode || run.errorMessage) && (
        <div role="alert" className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
          {persistencePending
            ? '报告和图谱内容已经生成，但尚未写入项目事实库。点击“写回项目”只执行本地恢复，不会重新搜索或调用模型。'
            : <>{run.errorCode ? `${run.errorCode}：` : ''}{run.errorMessage || '生成出现可恢复问题'}</>}
        </div>
      )}
      {showWeakConfig && !showSearchConfig && (
        <div
          role={enhancedSearchNeedsRepair ? 'alert' : 'status'}
          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300"
        >
          <span>{weakSearchMessage}</span>
          {canOpenSearchConfig && (
            <button
              type="button"
              onClick={() => setShowSearchConfig(true)}
              className="shrink-0 rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40"
            >
              {enhancedSearchNeedsRepair ? '检查搜索连接' : '配置增强搜索'}
            </button>
          )}
        </div>
      )}
      {canOpenSearchConfig && showSearchConfig && (
        <div className="mt-2">
          <ResearchWebSearchConfigPanel variant="banner" defaultExpanded />
        </div>
      )}
    </section>
  )
}
