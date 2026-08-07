import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ResearchAgentPreflightView,
  ResearchAgentRunDetailView,
  ResearchAgentRunSummaryView,
  ResearchAgentSubjectView,
} from '../../../electron/main/services/researchAgentRunManager'
import type { ResearchAgentRunnerProgress } from '../../../electron/main/services/researchAgentRunner'
import { useAppStore } from '../../store/appStore'
import { ResearchCombobox } from '../IndustryResearch/ResearchDecisionControls'
import type { ResearchApiResponse } from '../ResearchDiscussion/researchDiscussionTypes'
import { AppConfirmDialog } from '../shared/AppConfirmDialog'
import {
  formatAsOf,
  normalizeStockSubjects,
  ResearchAgentRunDetail,
  researchRunStatusMeta,
} from './ResearchAgentPanel'

const BUTTON = 'min-h-11 rounded-md border px-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none'
const PRIMARY = `${BUTTON} border-cyan-700 bg-cyan-700 text-white hover:bg-cyan-800 dark:border-cyan-500 dark:bg-cyan-500 dark:text-slate-950 dark:hover:bg-cyan-400`
const SECONDARY = `${BUTTON} border-slate-300 bg-white text-slate-700 hover:border-cyan-500 hover:text-cyan-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-200`

type RunFilter = 'all' | 'active' | 'completed'
type SubjectMode = 'stock' | 'industry_project'

interface ProjectOption {
  id: string
  title: string
}

interface Props {
  onOpenAiConfig: () => void
}

const ACTIVE_STATUSES = new Set<ResearchAgentRunSummaryView['status']>(['queued', 'running', 'paused', 'needs_attention'])
const RUNNING_STATUSES = new Set<ResearchAgentRunSummaryView['status']>(['queued', 'running'])
const PHASES: ResearchAgentRunSummaryView['phase'][] = ['planning', 'tooling', 'synthesis', 'audit', 'persist']

export function DeepResearchWorkbench({ onOpenAiConfig }: Props) {
  const navigateToDiscussion = useAppStore((state) => state.navigateToResearchDiscussion)
  const [runs, setRuns] = useState<ResearchAgentRunSummaryView[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResearchAgentRunDetailView | null>(null)
  const [filter, setFilter] = useState<RunFilter>('all')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [pendingCancelRunId, setPendingCancelRunId] = useState<string | null>(null)
  const [pendingReviewRunId, setPendingReviewRunId] = useState<string | null>(null)
  const [pendingRetryRunId, setPendingRetryRunId] = useState<string | null>(null)
  const [pendingDeleteRunId, setPendingDeleteRunId] = useState<string | null>(null)
  const [progressByRun, setProgressByRun] = useState<Record<string, ResearchAgentRunnerProgress>>({})
  const [, setClock] = useState(0)
  const selectedRunIdRef = useRef<string | null>(null)
  const filterRef = useRef<RunFilter>('all')
  const detailRequestRef = useRef(0)
  const runsRequestRef = useRef(0)
  const refreshTimerRef = useRef<number | null>(null)
  const latestProgressRef = useRef<Record<string, ResearchAgentRunnerProgress>>({})
  const launchButtonRef = useRef<HTMLButtonElement>(null)

  const loadDetail = useCallback(async (runId: string) => {
    const request = ++detailRequestRef.current
    setSelectedRunId(runId)
    selectedRunIdRef.current = runId
    setDetailLoading(true)
    const result = await window.api.researchAgent.getRun(runId)
    if (request !== detailRequestRef.current) return
    setDetailLoading(false)
    if (!result.ok) {
      setError(result.message)
      setDetail(null)
      return
    }
    setDetail(result.data)
  }, [])

  const loadRuns = useCallback(async (preferredRunId?: string) => {
    const request = ++runsRequestRef.current
    setError(null)
    const result = await window.api.researchAgent.listRuns(null)
    if (request !== runsRequestRef.current) return
    setLoading(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setRuns(result.data)
    const visibleRuns = result.data.filter((run) => matchesRunFilter(run, filterRef.current))
    const current = preferredRunId ?? selectedRunIdRef.current
    const nextId = current && visibleRuns.some((run) => run.id === current)
      ? current
      : visibleRuns[0]?.id ?? null
    if (!nextId) {
      setSelectedRunId(null)
      selectedRunIdRef.current = null
      setDetail(null)
      return
    }
    await loadDetail(nextId)
  }, [loadDetail])

  const scheduleRunsRefresh = useCallback((preferredRunId: string | undefined, immediate: boolean) => {
    if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null
      void loadRuns(preferredRunId)
    }, immediate ? 0 : 180)
  }, [loadRuns])

  useEffect(() => { void loadRuns() }, [loadRuns])

  useEffect(() => window.api.researchAgent.onProgress((event) => {
    const previous = latestProgressRef.current[event.runId]
    if (
      previous
      && (event.revision < previous.revision
        || (event.revision === previous.revision && event.updatedAt < previous.updatedAt))
    ) return
    latestProgressRef.current[event.runId] = event
    setProgressByRun((current) => ({ ...current, [event.runId]: event }))
    setRuns((current) => current.map((run) => run.id === event.runId
      ? event.revision < run.revision || (event.revision === run.revision && event.updatedAt < run.updatedAt) ? run : {
          ...run,
          status: event.status,
          phase: event.phase,
          modelCallCount: event.modelCalls.completed,
          toolCallCount: event.toolCalls.completed,
          revision: Math.max(run.revision, event.revision),
          updatedAt: Math.max(run.updatedAt, event.updatedAt),
        }
      : run))
    scheduleRunsRefresh(
      event.runId === selectedRunIdRef.current ? event.runId : undefined,
      !RUNNING_STATUSES.has(event.status),
    )
  }), [scheduleRunsRefresh])

  useEffect(() => () => {
    if (refreshTimerRef.current != null) window.clearTimeout(refreshTimerRef.current)
  }, [])

  useEffect(() => {
    if (!runs.some((run) => RUNNING_STATUSES.has(run.status))) return
    const timer = window.setInterval(() => setClock((value) => value + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [runs])

  async function mutate(runId: string, action: 'resume' | 'cancel') {
    setBusy(`${action}:${runId}`)
    setError(null)
    const result = action === 'resume'
      ? await window.api.researchAgent.resumeRun({ requestId: crypto.randomUUID(), runId })
      : await window.api.researchAgent.cancelRun({ requestId: crypto.randomUUID(), runId })
    setBusy(null)
    if (!result.ok) setError(result.message)
    await loadRuns(runId)
  }

  async function startReview(sourceRunId: string) {
    setBusy(`review:${sourceRunId}`)
    setError(null)
    const result = await window.api.researchAgent.startReview({
      requestId: crypto.randomUUID(),
      sourceRunId,
      confirmedBudgetVersion: 'multi-perspective-unrestricted-v2',
    })
    setBusy(null)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setPendingReviewRunId(null)
    await loadRuns(result.data.run.id)
  }

  async function retryRun(sourceRunId: string) {
    setBusy(`retry:${sourceRunId}`)
    setError(null)
    const result = await window.api.researchAgent.retryRun({
      requestId: crypto.randomUUID(),
      sourceRunId,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    })
    setBusy(null)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setPendingRetryRunId(null)
    filterRef.current = 'all'
    setFilter('all')
    setProgressByRun((current) => ({
      ...current,
      [result.data.run.id]: optimisticProgress(result.data.run, '新运行已创建，正在等待主进程规划'),
    }))
    await loadRuns(result.data.run.id)
  }

  async function deleteRun(runId: string) {
    setBusy(`delete:${runId}`)
    setError(null)
    const result = await window.api.researchAgent.deleteRun({ requestId: crypto.randomUUID(), runId })
    setBusy(null)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setPendingDeleteRunId(null)
    setProgressByRun((current) => {
      const next = { ...current }
      for (const deletedRunId of result.data.deletedRunIds) delete next[deletedRunId]
      return next
    })
    await loadRuns()
  }

  const activeCount = runs.filter((run) => ACTIVE_STATUSES.has(run.status)).length
  const filteredRuns = useMemo(() => runs.filter((run) => matchesRunFilter(run, filter)), [filter, runs])
  const progressRun = runs.find((run) => run.id === selectedRunId && RUNNING_STATUSES.has(run.status))
    ?? runs.find((run) => RUNNING_STATUSES.has(run.status))
    ?? null

  function changeFilter(nextFilter: RunFilter) {
    filterRef.current = nextFilter
    setFilter(nextFilter)
    const visibleRuns = runs.filter((run) => matchesRunFilter(run, nextFilter))
    const current = selectedRunIdRef.current
    if (current && visibleRuns.some((run) => run.id === current)) return
    const nextId = visibleRuns[0]?.id ?? null
    if (nextId) {
      void loadDetail(nextId)
      return
    }
    detailRequestRef.current += 1
    setSelectedRunId(null)
    selectedRunIdRef.current = null
    setDetail(null)
    setDetailLoading(false)
  }

  return (
    <section data-testid="deep-research-workbench" className="flex h-full min-h-0 flex-1 flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex min-h-[76px] flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="text-lg font-semibold">深度研究</h1>
            <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{runs.length} 次运行 · {activeCount} 次待处理</span>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">本地预检 · 必要时受控联网 · 可恢复研究账本</p>
        </div>
        <button ref={launchButtonRef} type="button" data-testid="deep-research-start" className={PRIMARY} onClick={() => setLaunchOpen(true)}>
          开始深度研究
        </button>
      </header>

      {error && <div role="alert" className="border-b border-red-200 bg-red-50 px-6 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
      {progressRun && (
        <ResearchProgressBand
          run={progressRun}
          progress={progressByRun[progressRun.id] ?? null}
          onSelect={() => { void loadDetail(progressRun.id) }}
        />
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="grid grid-cols-3 gap-1 border-b border-slate-200 p-3 dark:border-slate-800" role="group" aria-label="研究运行筛选">
            {([
              ['all', '全部'],
              ['active', '进行中'],
              ['completed', '已结束'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => changeFilter(key)}
                className={`min-h-11 rounded-md border px-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 motion-reduce:transition-none ${filter === key ? 'border-cyan-600 bg-cyan-50 text-cyan-800 dark:border-cyan-500 dark:bg-cyan-950/45 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="深度研究运行列表">
            {loading ? (
              <div className="flex min-h-32 items-center justify-center text-xs text-slate-400">正在读取研究账本…</div>
            ) : filteredRuns.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">{runs.length === 0 ? '尚无深度研究' : '当前筛选没有运行'}</div>
                {runs.length === 0 && <button type="button" className={`${PRIMARY} mt-4`} onClick={() => setLaunchOpen(true)}>开始深度研究</button>}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredRuns.map((run) => {
                  const meta = researchRunStatusMeta(run)
                  return (
                    <button
                      key={run.id}
                      type="button"
                      data-testid={`deep-research-run-${run.id}`}
                      onClick={() => { void loadDetail(run.id) }}
                      className={`min-h-[76px] w-full border-l-2 px-3 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 motion-reduce:transition-none ${selectedRunId === run.id ? 'border-cyan-600 bg-slate-50 dark:bg-slate-950/60' : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/70'}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className={`font-semibold ${meta.tone}`}>{meta.label}</span>
                        <span className="text-slate-400">{run.runKind === 'multi_perspective' ? '多视角' : '单 Agent'}</span>
                      </div>
                      {run.status === 'succeeded' && <div data-testid={`deep-research-coverage-${run.id}`} className={`mt-0.5 text-[11px] font-medium ${run.resultSemantics.conclusionCoverage === 'complete' ? 'text-emerald-700 dark:text-emerald-300' : run.resultSemantics.conclusionCoverage === 'limited' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`}>{run.resultSemantics.conclusionLabel}</div>}
                      <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-700 dark:text-slate-200">{run.question}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                        <span>{phaseLabel(run.phase)}</span>
                        <span className="tabular-nums">{formatTimestamp(run.updatedAt)}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </aside>

        <main className="min-h-0 min-w-0 overflow-y-auto px-6 py-5">
          {detailLoading && detail?.run.id !== selectedRunId ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-slate-400">正在读取运行详情…</div>
          ) : detail ? (
            <ResearchAgentRunDetail
              detail={detail}
              busy={busy}
              onResume={() => { void mutate(detail.run.id, 'resume') }}
              onCancel={() => { setError(null); setPendingCancelRunId(detail.run.id) }}
              onRetry={() => { setError(null); setPendingRetryRunId(detail.run.id) }}
              onDelete={() => { setError(null); setPendingDeleteRunId(detail.run.id) }}
              onStartReview={() => { setError(null); setPendingReviewRunId(detail.run.id) }}
              onOpenDiscussion={detail.run.discussionSessionId == null ? undefined : () => navigateToDiscussion(detail.run.discussionSessionId!)}
            />
          ) : (
            <div className="flex min-h-48 items-center justify-center text-sm text-slate-400">选择一次运行查看研究账本</div>
          )}
        </main>
      </div>

      <DirectResearchDialog
        open={launchOpen}
        onClose={() => {
          setLaunchOpen(false)
          window.setTimeout(() => launchButtonRef.current?.focus(), 0)
        }}
        onOpenAiConfig={onOpenAiConfig}
        onStarted={async (run) => {
          setLaunchOpen(false)
          setProgressByRun((current) => ({
            ...current,
            [run.id]: optimisticProgress(run, '运行已创建，正在等待主进程规划'),
          }))
          await loadRuns(run.id)
        }}
      />
      <AppConfirmDialog
        open={pendingCancelRunId != null}
        title="取消这次深度研究？"
        message="取消会终止后续模型和事实调用，当前账本与已保存证据仍会保留。"
        tone="danger"
        statusLabel="运行终止"
        confirmLabel="确认取消"
        busy={pendingCancelRunId != null && busy === `cancel:${pendingCancelRunId}`}
        error={pendingCancelRunId ? error : null}
        testId="deep-research-cancel-dialog"
        onCancel={() => setPendingCancelRunId(null)}
        onConfirm={() => {
          if (!pendingCancelRunId) return
          void mutate(pendingCancelRunId, 'cancel').then(() => setPendingCancelRunId(null))
        }}
      />
      <AppConfirmDialog
        open={pendingRetryRunId != null}
        title="重新执行这次深度研究？"
        message={detail?.run.id === pendingRetryRunId && detail.run.status === 'needs_attention'
          ? '旧运行存在结果或费用未知的调用。本次会使用当前资料截点创建新的连续研究账本，可能产生重复费用，旧账本保持不变。'
          : '本次会复用原问题和研究主体，以当前资料截点创建新的连续研究账本；旧运行保持不变，可用于对照。'}
        statusLabel="新建重试运行"
        confirmLabel="重新研究"
        busy={pendingRetryRunId != null && busy === `retry:${pendingRetryRunId}`}
        error={pendingRetryRunId ? error : null}
        testId="deep-research-retry-dialog"
        onCancel={() => setPendingRetryRunId(null)}
        onConfirm={() => {
          if (!pendingRetryRunId) return
          void retryRun(pendingRetryRunId)
        }}
      />
      <AppConfirmDialog
        open={pendingDeleteRunId != null}
        title="删除这条研究记录？"
        message="只删除当前选中的研究记录及其步骤、模型调用、工具证据和讨论生成消息；其他重试记录会保留。此操作不可撤销。"
        tone="danger"
        statusLabel="永久删除"
        confirmLabel="确认删除"
        busy={pendingDeleteRunId != null && busy === `delete:${pendingDeleteRunId}`}
        error={pendingDeleteRunId ? error : null}
        testId="deep-research-delete-dialog"
        onCancel={() => setPendingDeleteRunId(null)}
        onConfirm={() => {
          if (!pendingDeleteRunId) return
          void deleteRun(pendingDeleteRunId)
        }}
      />
      <AppConfirmDialog
        open={pendingReviewRunId != null}
        title="启动多视角复核？"
        message="将复用来源运行的不可变证据。多方与空方至少完成两轮交锋，并按实质分歧继续复核，收敛后由中立主持汇总；模型调用按研究需要，不调用工具，也不会再次联网。"
        statusLabel="执行策略"
        confirmLabel="开始复核"
        busy={pendingReviewRunId != null && busy === `review:${pendingReviewRunId}`}
        error={pendingReviewRunId ? error : null}
        testId="deep-research-review-dialog"
        onCancel={() => setPendingReviewRunId(null)}
        onConfirm={() => {
          if (!pendingReviewRunId) return
          void startReview(pendingReviewRunId)
        }}
      />
    </section>
  )
}

function ResearchProgressBand({ run, progress, onSelect }: {
  run: ResearchAgentRunSummaryView
  progress: ResearchAgentRunnerProgress | null
  onSelect: () => void
}) {
  const phaseIndex = PHASES.indexOf(progress?.phase ?? run.phase)
  const running = (progress?.status ?? run.status) === 'running'
  const startedAt = progress?.executionStartedAt ?? run.startedAt ?? run.createdAt
  return (
    <button
      type="button"
      data-testid="deep-research-progress"
      onClick={onSelect}
      className="w-full border-b border-cyan-200 bg-cyan-50 px-6 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-600 dark:border-cyan-950 dark:bg-cyan-950/25"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div role="status" aria-live="polite" aria-atomic="true" className="flex items-center gap-2 text-xs font-semibold text-cyan-900 dark:text-cyan-100">
            <span className={`h-2 w-2 shrink-0 rounded-full bg-cyan-600 ${running ? 'motion-safe:animate-pulse' : ''}`} aria-hidden="true" />
            <span>{running ? '深度研究进行中' : '深度研究等待启动'}</span>
            {progress?.stepOrdinal != null && <span className="font-normal text-cyan-700 dark:text-cyan-300">第 {progress.stepOrdinal} 步</span>}
            <span className="font-normal text-cyan-700 dark:text-cyan-300">{progress?.message ?? `${phaseLabel(run.phase)}处理中`}</span>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1" aria-label={`当前阶段：${phaseLabel(progress?.phase ?? run.phase)}`}>
            {PHASES.map((phase, index) => (
              <div key={phase} className="flex min-w-0 flex-1 items-center gap-1">
                <span className={`h-1.5 min-w-3 flex-1 rounded-full ${index <= phaseIndex ? 'bg-cyan-600 dark:bg-cyan-400' : 'bg-cyan-200 dark:bg-cyan-950'}`} />
                <span className={`hidden shrink-0 text-[10px] xl:inline ${index === phaseIndex ? 'font-semibold text-cyan-800 dark:text-cyan-200' : 'text-cyan-600/70 dark:text-cyan-400/60'}`}>{phaseLabel(phase)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-[11px] tabular-nums text-cyan-800 dark:text-cyan-200">
          <span>模型 {formatProgressUsage(progress?.modelCalls.completed ?? run.modelCallCount, progress?.modelCalls.maximum ?? run.maxModelCalls)}</span>
          <span>工具 {formatProgressUsage(progress?.toolCalls.completed ?? run.toolCallCount, progress?.toolCalls.maximum ?? run.maxToolCalls)}</span>
          <span>耗时 {formatDuration(Date.now() - startedAt)}</span>
        </div>
      </div>
    </button>
  )
}

function DirectResearchDialog({ open, onClose, onOpenAiConfig, onStarted }: {
  open: boolean
  onClose: () => void
  onOpenAiConfig: () => void
  onStarted: (run: ResearchAgentRunSummaryView) => Promise<void>
}) {
  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<SubjectMode>('stock')
  const [stockCodes, setStockCodes] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null)
  const [includePortfolio, setIncludePortfolio] = useState(false)
  const [preflight, setPreflight] = useState<ResearchAgentPreflightView | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const questionRef = useRef<HTMLTextAreaElement>(null)
  const onCloseRef = useRef(onClose)
  const submittingRef = useRef(submitting)

  useEffect(() => {
    onCloseRef.current = onClose
    submittingRef.current = submitting
  }, [onClose, submitting])

  useEffect(() => {
    if (!open) return
    let active = true
    setProjectLoadError(null)
    void (async () => {
      try {
        const response = await window.api.industryResearch.listProjects({ limit: 200 }) as ResearchApiResponse<{ items: ProjectOption[] }>
        if (!active) return
        if (response.ok) {
          setProjects(response.data?.items ?? [])
          return
        }
        setProjects([])
        setProjectLoadError(response.message || '产业研究项目读取失败')
      } catch {
        if (!active) return
        setProjects([])
        setProjectLoadError('产业研究项目读取失败，请稍后重试')
      }
    })()
    return () => { active = false }
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    setPreflight(null)
    setError(null)
    void window.api.researchAgent.preflightDirect({ projectId: mode === 'industry_project' && projectId ? projectId : null })
      .then((response) => {
        if (!active) return
        setLoading(false)
        if (!response.ok) {
          setError(response.message)
          return
        }
        setPreflight(response.data)
      })
      .catch(() => {
        if (!active) return
        setLoading(false)
        setError('研究能力预检失败，请稍后重试')
      })
    return () => { active = false }
  }, [mode, open, projectId])

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const appRoot = document.getElementById('root')
    const rootWasInert = appRoot?.inert ?? false
    const previousBodyOverflow = document.body.style.overflow
    if (appRoot) appRoot.inert = true
    document.body.style.overflow = 'hidden'
    const frame = window.requestAnimationFrame(() => questionRef.current?.focus({ preventScroll: true }))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (submittingRef.current) return
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      if (appRoot) appRoot.inert = rootWasInert
      document.body.style.overflow = previousBodyOverflow
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [open])

  const selectedProject = projects.find((project) => project.id === projectId) ?? null
  const projectOptions = useMemo(() => projects.map((project) => ({
    value: project.id,
    label: project.title,
  })), [projects])
  const subjects = useMemo<ResearchAgentSubjectView[]>(() => (
    mode === 'industry_project'
      ? selectedProject ? [{ kind: 'industry_project', id: selectedProject.id, label: selectedProject.title }] : []
      : normalizeStockSubjects(stockCodes)
  ), [mode, selectedProject, stockCodes])
  const canSubmit = Boolean(preflight?.ready && question.trim().length >= 10 && subjects.length > 0 && !submitting)

  async function submit() {
    const trimmed = question.trim()
    if (trimmed.length < 10) return setError('研究问题至少需要10个字符')
    if (subjects.length < 1) return setError(mode === 'stock' ? '请确认至少一只A股研究主体' : '请选择产业研究项目')
    setSubmitting(true)
    setError(null)
    const result = await window.api.researchAgent.startDirect({
      requestId: crypto.randomUUID(),
      question: trimmed,
      subjects,
      includePortfolio,
      projectId: mode === 'industry_project' ? projectId : null,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
    })
    setSubmitting(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    await onStarted(result.data.run)
    setQuestion('')
    setStockCodes('')
    setProjectId('')
    setIncludePortfolio(false)
  }

  if (!open) return null
  const dialog = (
    <div className="electron-no-drag fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/60 p-4 dark:bg-black/65" role="presentation">
      <div ref={dialogRef} className="flex max-h-[calc(100vh-32px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-950" role="dialog" aria-modal="true" aria-labelledby="direct-research-title" tabIndex={-1}>
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">single-agent.v1</div>
            <h2 id="direct-research-title" className="mt-1 text-base font-semibold">开始深度研究</h2>
          </div>
          <button type="button" className={SECONDARY} onClick={onClose} disabled={submitting}>关闭</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <div role="alert" className="mb-4 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
          {loading && <div className="mb-4 text-xs text-slate-500">正在检查模型与研究能力…</div>}
          {preflight && !preflight.ready && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <span>{preflight.unavailableReason}</span>
              <button type="button" className={SECONDARY} onClick={() => { onClose(); onOpenAiConfig() }}>打开 AI 配置</button>
            </div>
          )}
          <div className="space-y-5">
            <label className="block text-sm font-medium">研究问题
              <textarea ref={questionRef} value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={4000} rows={5} className="mt-1.5 w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900" />
              <span className="mt-1 block text-xs tabular-nums text-slate-400">{question.trim().length}/4000</span>
            </label>

            <fieldset>
              <legend className="text-sm font-medium">研究主体</legend>
              <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-900" role="group" aria-label="研究主体类型">
                {([
                  ['stock', 'A股'],
                  ['industry_project', '产业项目'],
                ] as const).map(([key, label]) => (
                  <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)} className={`min-h-11 rounded-md px-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 motion-reduce:transition-none ${mode === key ? 'bg-white text-cyan-800 shadow-sm dark:bg-slate-800 dark:text-cyan-200' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'}`}>{label}</button>
                ))}
              </div>
            </fieldset>

            {mode === 'stock' ? (
              <label className="block text-sm font-medium">股票代码
                <input value={stockCodes} onChange={(event) => setStockCodes(event.target.value)} placeholder="600519.SH 000001.SZ" className="mt-1.5 h-11 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900" />
                <span className="mt-1 block text-xs text-slate-500">已确认 {subjects.length}/5</span>
              </label>
            ) : (
              <div className="block text-sm font-medium">
                <div>产业研究项目</div>
                <div className="mt-1.5">
                  <ResearchCombobox
                    value={projectId}
                    options={projectOptions}
                    placeholder={projectLoadError ? '项目读取失败' : projects.length > 0 ? '请选择项目' : '暂无产业研究项目'}
                    searchPlaceholder="搜索产业研究项目"
                    testId="direct-research-project"
                    ariaLabel="产业研究项目"
                    disabled={projectLoadError != null}
                    onChange={setProjectId}
                  />
                </div>
                {projectLoadError && <span role="alert" className="mt-1 block text-xs text-red-600 dark:text-red-300">{projectLoadError}</span>}
              </div>
            )}

            <label className="flex min-h-11 cursor-pointer items-center gap-3 border-y border-slate-200 py-2 text-sm dark:border-slate-800">
              <input type="checkbox" checked={includePortfolio} onChange={(event) => setIncludePortfolio(event.target.checked)} className="h-4 w-4 accent-cyan-700" />
              <span><span className="font-medium">包含当前持仓事实</span><span className="ml-2 text-xs text-slate-500">敏感范围</span></span>
            </label>

            {preflight && (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-slate-200 pb-4 text-xs sm:grid-cols-4 dark:border-slate-800">
                  <Metric label="固定模型" value={preflight.model.configured ? `${preflight.model.provider} / ${preflight.model.model}` : '未配置'} />
                  <Metric label="资料截点" value={formatAsOf(preflight.asOf)} />
                  <Metric label="模型调用" value={preflight.budget.maxModelCalls == null ? '按研究需要' : `最多 ${preflight.budget.maxModelCalls} 次`} />
                  <Metric label="事实工具" value={preflight.budget.maxToolCalls == null ? '按研究需要' : `最多 ${preflight.budget.maxToolCalls} 次`} />
                  <Metric label="模型等待" value={preflight.budget.maxModelCallDurationMs == null ? '不设项目上限' : `最多 ${Math.round(preflight.budget.maxModelCallDurationMs / 1_000)} 秒`} />
                  <Metric label="最终输出" value={preflight.budget.maxFinalOutputTokens == null ? '由模型端决定' : `最多 ${preflight.budget.maxFinalOutputTokens} tokens`} />
                </div>
                <div data-testid="direct-research-evidence-policy" className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  {preflight.evidencePolicy.message}
                </div>
              </>
            )}
          </div>
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <button type="button" className={SECONDARY} onClick={onClose} disabled={submitting}>取消</button>
          <button type="button" data-testid="direct-research-submit" className={PRIMARY} onClick={() => { void submit() }} disabled={!canSubmit}>{submitting ? '正在创建…' : '开始深度研究'}</button>
        </footer>
      </div>
    </div>
  )
  return createPortal(dialog, document.body)
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-slate-400">{label}</div><div className="mt-0.5 break-words font-medium text-slate-700 dark:text-slate-200">{value}</div></div>
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function phaseLabel(phase: ResearchAgentRunSummaryView['phase']): string {
  return ({
    planning: '规划',
    tooling: '取证',
    synthesis: '综合',
    audit: '审计',
    persist: '写回',
  })[phase]
}

function formatProgressUsage(completed: number, maximum: number | null): string {
  return maximum == null ? `${completed} 次` : `${completed}/${maximum}`
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function optimisticProgress(run: ResearchAgentRunSummaryView, message: string): ResearchAgentRunnerProgress {
  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    stepOrdinal: null,
    message,
    revision: run.revision,
    executionStartedAt: run.startedAt ?? run.createdAt,
    modelCalls: { completed: run.modelCallCount, maximum: run.maxModelCalls },
    toolCalls: { completed: run.toolCallCount, maximum: run.maxToolCalls },
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, completeness: 'unknown' },
    updatedAt: run.updatedAt,
  }
}

function matchesRunFilter(run: ResearchAgentRunSummaryView, filter: RunFilter): boolean {
  return filter === 'all'
    || (filter === 'active' && ACTIVE_STATUSES.has(run.status))
    || (filter === 'completed' && !ACTIVE_STATUSES.has(run.status))
}
