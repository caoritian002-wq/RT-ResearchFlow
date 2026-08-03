import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  ResearchAgentPreflightView,
  ResearchAgentRunDetailView,
  ResearchAgentRunSummaryView,
  ResearchAgentSubjectView,
} from '../../../electron/main/services/researchAgentRunManager'
import { ResearchAuditTrace } from '../shared/ResearchAuditTrace'
import { AppConfirmDialog } from '../shared/AppConfirmDialog'

const BUTTON = 'min-h-11 rounded-md border px-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none'
const SECONDARY = `${BUTTON} border-slate-300 bg-white text-slate-700 hover:border-cyan-500 hover:text-cyan-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-200`
const PRIMARY = `${BUTTON} border-cyan-700 bg-cyan-700 text-white hover:bg-cyan-800 dark:border-cyan-500 dark:bg-cyan-500 dark:text-slate-950 dark:hover:bg-cyan-400`
const DANGER = `${BUTTON} border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-slate-900 dark:text-red-300 dark:hover:bg-red-950/35`

interface Props {
  sessionId: number
  draftQuestion: string
  onCompleted: () => Promise<void> | void
}

const BASE_STATUS_META: Record<ResearchAgentRunSummaryView['status'], { label: string; tone: string }> = {
  queued: { label: '等待启动', tone: 'text-slate-600 dark:text-slate-300' },
  running: { label: '运行中', tone: 'text-cyan-700 dark:text-cyan-300' },
  paused: { label: '已暂停', tone: 'text-amber-700 dark:text-amber-300' },
  needs_attention: { label: '需处理', tone: 'text-red-700 dark:text-red-300' },
  succeeded: { label: '已完成', tone: 'text-emerald-700 dark:text-emerald-300' },
  failed: { label: '失败', tone: 'text-red-700 dark:text-red-300' },
  cancelled: { label: '已取消', tone: 'text-slate-500 dark:text-slate-400' },
}

export function researchRunStatusMeta(run: Pick<ResearchAgentRunSummaryView, 'status' | 'resultSemantics'>): { label: string; tone: string } {
  return { ...BASE_STATUS_META[run.status], label: run.resultSemantics.executionLabel }
}

function researchConclusionMeta(run: Pick<ResearchAgentRunSummaryView, 'resultSemantics'>): { label: string; tone: string } {
  const tone = {
    pending: 'text-slate-500 dark:text-slate-400',
    complete: 'text-emerald-700 dark:text-emerald-300',
    limited: 'text-amber-700 dark:text-amber-300',
    blocked: 'text-red-700 dark:text-red-300',
    unavailable: 'text-slate-500 dark:text-slate-400',
  }[run.resultSemantics.conclusionCoverage]
  return { label: run.resultSemantics.conclusionLabel, tone }
}

const PHASE_LABEL: Record<ResearchAgentRunSummaryView['phase'], string> = {
  planning: '研究计划',
  tooling: '本地事实',
  synthesis: '证据门禁 / 综合',
  audit: '确定性审计',
  persist: '本地写回',
}

const MULTI_PERSPECTIVE_PHASE_LABEL: Record<ResearchAgentRunSummaryView['phase'], string> = {
  planning: '锁定证据',
  tooling: '正反研判',
  synthesis: '中立主持',
  audit: '引用审计',
  persist: '讨论写回',
}

export function ResearchAgentPanel({ sessionId, draftQuestion, onCompleted }: Props) {
  const [runs, setRuns] = useState<ResearchAgentRunSummaryView[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResearchAgentRunDetailView | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [preflight, setPreflight] = useState<ResearchAgentPreflightView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingCancelRunId, setPendingCancelRunId] = useState<string | null>(null)
  const [pendingReviewRunId, setPendingReviewRunId] = useState<string | null>(null)
  const previousStatuses = useRef(new Map<string, ResearchAgentRunSummaryView['status']>())
  const selectedRunIdRef = useRef<string | null>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)

  const loadRuns = useCallback(async () => {
    const result = await window.api.researchAgent.listRuns(sessionId)
    if (!result.ok) {
      setError(result.message)
      return
    }
    const next = result.data
    const completed = next.some((run) => (
      run.status === 'succeeded' && previousStatuses.current.get(run.id) !== 'succeeded'
    ))
    previousStatuses.current = new Map(next.map((run) => [run.id, run.status]))
    setRuns(next)
    if (completed) await onCompleted()
  }, [onCompleted, sessionId])

  useEffect(() => {
    setSelectedRunId(null)
    selectedRunIdRef.current = null
    setDetail(null)
    setError(null)
    void loadRuns()
  }, [loadRuns, sessionId])

  useEffect(() => window.api.researchAgent.onProgress((event) => {
    void loadRuns()
    if (event.runId === selectedRunIdRef.current) {
      void window.api.researchAgent.getRun(event.runId).then((result) => {
        if (result.ok) {
          setDetail((current) => (
            current?.run.id === result.data.run.id && current.run.revision > result.data.run.revision
              ? current
              : result.data
          ))
        }
      })
    }
  }), [loadRuns])

  async function openDialog() {
    setDialogOpen(true)
    setLoading(true)
    setError(null)
    const result = await window.api.researchAgent.preflight(sessionId)
    setLoading(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setPreflight(result.data)
  }

  async function selectRun(runId: string) {
    setSelectedRunId(runId)
    selectedRunIdRef.current = runId
    setBusy(`detail:${runId}`)
    const result = await window.api.researchAgent.getRun(runId)
    setBusy(null)
    if (!result.ok) setError(result.message)
    else setDetail(result.data)
  }

  async function mutate(runId: string, action: 'resume' | 'cancel') {
    setBusy(`${action}:${runId}`)
    setError(null)
    const result = action === 'resume'
      ? await window.api.researchAgent.resumeRun({ requestId: crypto.randomUUID(), runId })
      : await window.api.researchAgent.cancelRun({ requestId: crypto.randomUUID(), runId })
    setBusy(null)
    if (!result.ok) setError(result.message)
    await loadRuns()
    if (result.ok) await selectRun(runId)
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
    setSelectedRunId(result.data.run.id)
    selectedRunIdRef.current = result.data.run.id
    await loadRuns()
    await selectRun(result.data.run.id)
  }

  const closeDialog = useCallback(() => {
    if (busy) return
    setDialogOpen(false)
    setPreflight(null)
    window.setTimeout(() => openButtonRef.current?.focus(), 0)
  }, [busy])

  return (
    <section data-testid="research-agent-panel" className="max-h-[40vh] flex-shrink-0 overflow-y-auto border-t border-slate-200 bg-slate-50/70 px-5 py-3 dark:border-slate-800 dark:bg-slate-950/35">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">深度研究</div>
          <div className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
            {runs.length > 0 ? `${runs.length} 次运行 · ${researchRunStatusMeta(runs[0]).label}${runs[0].status === 'succeeded' ? ` · ${researchConclusionMeta(runs[0]).label}` : ''}` : '尚无运行'}
          </div>
        </div>
        <button ref={openButtonRef} type="button" data-testid="research-agent-open" className={PRIMARY} onClick={() => { void openDialog() }}>
          新建深度研究
        </button>
      </div>

      {error && <div role="alert" className="mt-3 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">{error}</div>}

      {runs.length > 0 && (
        <div className="mt-3 grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
          <div className="max-h-72 space-y-1 overflow-y-auto pr-1" aria-label="深度研究运行列表">
            {runs.map((run) => {
              const meta = researchRunStatusMeta(run)
              const conclusion = researchConclusionMeta(run)
              return (
                <button
                  key={run.id}
                  type="button"
                  data-testid={`research-agent-run-${run.id}`}
                  onClick={() => { void selectRun(run.id) }}
                  className={`min-h-11 w-full border-l-2 px-3 py-2 text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 motion-reduce:transition-none ${selectedRunId === run.id ? 'border-cyan-600 bg-white dark:bg-slate-900' : 'border-transparent hover:bg-white dark:hover:bg-slate-900'}`}
                >
                  <div className="flex items-center justify-between gap-2"><span className={`font-semibold ${meta.tone}`}>{meta.label}</span><span className="text-slate-400">{phaseLabel(run.runKind, run.phase)}</span></div>
                  {run.status === 'succeeded' && <div className={`mt-0.5 text-[11px] ${conclusion.tone}`}>{conclusion.label} · {run.runKind === 'multi_perspective' ? '多视角' : '单 Agent'}</div>}
                  <div className="mt-1 truncate text-slate-600 dark:text-slate-300">{run.question}</div>
                </button>
              )
            })}
          </div>
          <div className="min-w-0 border-l border-slate-200 pl-3 dark:border-slate-800">
            {detail ? (
              <ResearchAgentRunDetail
                detail={detail}
                busy={busy}
                onResume={() => { void mutate(detail.run.id, 'resume') }}
                onCancel={() => setPendingCancelRunId(detail.run.id)}
                onStartReview={() => setPendingReviewRunId(detail.run.id)}
              />
            ) : <div className="flex min-h-24 items-center justify-center text-xs text-slate-400">选择一次运行查看账本</div>}
          </div>
        </div>
      )}

      {dialogOpen && (
        <ResearchAgentStartDialog
          sessionId={sessionId}
          initialQuestion={draftQuestion}
          preflight={preflight}
          loading={loading}
          error={error}
          onClose={closeDialog}
          onStarted={async (run) => {
            setDialogOpen(false)
            setPreflight(null)
            setSelectedRunId(run.id)
            await loadRuns()
            await selectRun(run.id)
          }}
        />
      )}
      <AppConfirmDialog
        open={pendingCancelRunId != null}
        title="取消这次深度研究？"
        message="取消会终止后续模型和事实调用，当前账本与已保存证据仍会保留。"
        tone="danger"
        statusLabel="运行终态"
        confirmLabel="确认取消"
        busy={pendingCancelRunId != null && busy === `cancel:${pendingCancelRunId}`}
        error={pendingCancelRunId ? error : null}
        testId="research-agent-cancel-dialog"
        onCancel={() => setPendingCancelRunId(null)}
        onConfirm={() => {
          if (!pendingCancelRunId) return
          void mutate(pendingCancelRunId, 'cancel').then(() => setPendingCancelRunId(null))
        }}
      />
      <AppConfirmDialog
        open={pendingReviewRunId != null}
        title="启动多视角复核？"
        message={`将复用来源运行 ${pendingReviewRunId?.slice(0, 8) ?? ''} 的不可变证据。多方与空方至少完成两轮交锋，并按实质分歧继续复核，收敛后由中立主持汇总；模型调用按研究需要，不调用工具，也不会再次联网。`}
        statusLabel="执行策略"
        confirmLabel="开始复核"
        busy={pendingReviewRunId != null && busy === `review:${pendingReviewRunId}`}
        error={pendingReviewRunId ? error : null}
        testId="research-agent-review-dialog"
        onCancel={() => setPendingReviewRunId(null)}
        onConfirm={() => {
          if (!pendingReviewRunId) return
          void startReview(pendingReviewRunId)
        }}
      />
    </section>
  )
}

function ResearchAgentStartDialog({
  sessionId,
  initialQuestion,
  preflight,
  loading,
  error,
  onClose,
  onStarted,
}: {
  sessionId: number
  initialQuestion: string
  preflight: ResearchAgentPreflightView | null
  loading: boolean
  error: string | null
  onClose: () => void
  onStarted: (run: ResearchAgentRunSummaryView) => Promise<void>
}) {
  const [question, setQuestion] = useState(initialQuestion)
  const [stockCodes, setStockCodes] = useState('')
  const [includePortfolio, setIncludePortfolio] = useState(false)
  const [confirmedProject, setConfirmedProject] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const project = preflight?.suggestedSubjects.find((subject) => subject.kind === 'industry_project') ?? null
  const suggestedStocks = preflight?.suggestedSubjects.filter((subject): subject is Extract<ResearchAgentSubjectView, { kind: 'stock' }> => subject.kind === 'stock') ?? []
  const suggestedStockCodes = suggestedStocks.map((subject) => subject.tsCode).join(' ')

  useEffect(() => {
    if (suggestedStockCodes) setStockCodes((current) => current || suggestedStockCodes)
  }, [suggestedStockCodes])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submitting) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, submitting])

  const subjects = useMemo<ResearchAgentSubjectView[]>(() => {
    if (project) return confirmedProject ? [project] : []
    return normalizeStockSubjects(stockCodes)
  }, [confirmedProject, project, stockCodes])

  async function submit() {
    const trimmed = question.trim()
    if (trimmed.length < 10) return setLocalError('研究问题至少需要 10 个字符')
    if (subjects.length < 1) return setLocalError(project ? '请确认产业项目主体' : '请填写并确认至少一只A股')
    setSubmitting(true)
    setLocalError(null)
    const result = await window.api.researchAgent.startRun({
      requestId: crypto.randomUUID(),
      sessionId,
      question: trimmed,
      subjects,
      includePortfolio,
      confirmedBudgetVersion: 'single-agent-unrestricted-v3',
      parentRunId: null,
    })
    setSubmitting(false)
    if (!result.ok) return setLocalError(result.message)
    await onStarted(result.data.run)
  }

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/60 p-4" role="dialog" aria-modal="true" aria-labelledby="research-agent-dialog-title">
      <div className="flex max-h-[calc(100vh-32px)] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-950">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div><div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">single-agent.v1</div><h2 id="research-agent-dialog-title" className="mt-1 text-base font-semibold">开始深度研究</h2></div>
          <button type="button" className={SECONDARY} onClick={onClose} disabled={submitting}>关闭</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && <div className="py-10 text-center text-sm text-slate-500">正在重建受信上下文…</div>}
          {(error || localError) && <div role="alert" className="mb-4 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{localError || error}</div>}
          {preflight && (
            <div className="space-y-5">
              <div className="grid gap-3 border-b border-slate-200 pb-4 text-xs sm:grid-cols-3 dark:border-slate-800">
                <Metric label="固定模型" value={`${preflight.model.provider} / ${preflight.model.model}`} />
                <Metric label="资料截点" value={formatAsOf(preflight.asOf)} />
                <Metric label="金额成本" value={preflight.costEstimate.status === 'unavailable' ? '无法估算' : '--'} />
              </div>
              {!preflight.ready && <div className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{preflight.unavailableReason}</div>}
              <div data-testid="research-agent-evidence-policy" className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                证据策略：本地预检后按缺口取证。{preflight.evidencePolicy.message}
              </div>
              <label className="block text-sm font-medium">研究问题
                <textarea autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={4000} rows={5} className="mt-1.5 w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900" />
              </label>
              {project ? (
                <label className="flex min-h-11 cursor-pointer items-center gap-3 border-y border-slate-200 py-2 text-sm dark:border-slate-800">
                  <input type="checkbox" checked={confirmedProject} onChange={(event) => setConfirmedProject(event.target.checked)} className="h-4 w-4 accent-cyan-700" />
                  <span><span className="font-medium">{project.label || project.id}</span><span className="ml-2 font-mono text-xs text-slate-400">{project.id}</span></span>
                </label>
              ) : (
                <label className="block text-sm font-medium">A股主体
                  <input value={stockCodes} onChange={(event) => setStockCodes(event.target.value)} placeholder="600519.SH 000001.SZ" className="mt-1.5 h-11 w-full rounded-md border border-slate-300 bg-white px-3 font-mono text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900" />
                  <span className="mt-1 block text-xs text-slate-500">已确认 {subjects.length}/5</span>
                </label>
              )}
              <label className="flex min-h-11 cursor-pointer items-center gap-3 border-y border-slate-200 py-2 text-sm dark:border-slate-800">
                <input type="checkbox" checked={includePortfolio} onChange={(event) => setIncludePortfolio(event.target.checked)} className="h-4 w-4 accent-cyan-700" />
                <span><span className="font-medium">包含当前持仓事实</span><span className="ml-2 text-xs text-slate-500">敏感范围</span></span>
              </label>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-slate-200 pb-4 text-xs sm:grid-cols-4 dark:border-slate-800">
                <Metric label="模型调用" value={preflight.budget.maxModelCalls == null ? '按研究需要' : `最多 ${preflight.budget.maxModelCalls} 次`} />
                <Metric label="事实工具" value={preflight.budget.maxToolCalls == null ? '按研究需要' : `最多 ${preflight.budget.maxToolCalls} 次`} />
                <Metric label="模型输入" value="单次 96 KiB" />
                <Metric label="最终输出" value={preflight.budget.maxFinalOutputTokens == null ? '由模型端决定' : `最多 ${preflight.budget.maxFinalOutputTokens} tokens`} />
              </div>
              <div className="border-l-2 border-slate-300 px-3 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                不设项目级运行时长和单次模型等待上限。{preflight.costEstimate.message}
              </div>
              <div>
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">本次可用工具</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {preflight.availableTools.filter((tool) => !tool.sensitive || includePortfolio).map((tool) => <code key={tool.id} className="bg-slate-100 px-2 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{tool.id}</code>)}
                </div>
              </div>
            </div>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <button type="button" className={SECONDARY} onClick={onClose} disabled={submitting}>取消</button>
          <button type="button" data-testid="research-agent-start" className={PRIMARY} onClick={() => { void submit() }} disabled={!preflight?.ready || submitting || subjects.length === 0 || question.trim().length < 10}>{submitting ? '正在创建…' : '开始深度研究'}</button>
        </footer>
      </div>
    </div>
  )
}

export function ResearchAgentRunDetail({ detail, busy, onResume, onCancel, onRetry, onDelete, onStartReview, onOpenDiscussion }: {
  detail: ResearchAgentRunDetailView
  busy: string | null
  onResume: () => void
  onCancel: () => void
  onRetry?: () => void
  onDelete?: () => void
  onStartReview: () => void
  onOpenDiscussion?: () => void
}) {
  const { run } = detail
  const [activeTab, setActiveTab] = useState<'report' | 'evidence'>('report')
  const reportTabRef = useRef<HTMLButtonElement>(null)
  const evidenceTabRef = useRef<HTMLButtonElement>(null)
  const status = researchRunStatusMeta(run)
  const conclusion = researchConclusionMeta(run)
  const plan = readResearchPlan(detail.plan)
  const canResume = ['queued', 'paused', 'failed'].includes(run.status)
    && (run.status !== 'failed' || run.retryable)
    && !run.cancelRequested
  const canCancel = !['succeeded', 'cancelled'].includes(run.status)
  useEffect(() => {
    setActiveTab('report')
  }, [run.id])

  const selectAdjacentTab = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'report' : 'evidence'
    setActiveTab(next)
    window.requestAnimationFrame(() => {
      if (next === 'report') reportTabRef.current?.focus()
      else evidenceTabRef.current?.focus()
    })
  }

  return (
    <div className="min-w-0 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span data-testid="research-agent-execution-status" className={`font-semibold ${status.tone}`}>执行状态：{status.label}</span>
            {run.status === 'succeeded' && <span data-testid="research-agent-conclusion-coverage" className={`font-semibold ${conclusion.tone}`}>结论覆盖：{researchConclusionCoverageLabel(run.resultSemantics.conclusionCoverage)}</span>}
            <span className="text-slate-400">{run.runKind === 'multi_perspective' ? '多视角复核' : '单 Agent 研究'} · {phaseLabel(run.runKind, run.phase)}</span>
          </div>
          <div className="mt-1 break-words text-slate-600 dark:text-slate-300">{run.question}</div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {onOpenDiscussion && run.discussionSessionId != null && <button type="button" data-testid="research-agent-open-discussion" className={SECONDARY} onClick={onOpenDiscussion}>打开讨论</button>}
          {detail.reviewEligibility.eligible && <button type="button" data-testid="research-agent-start-review" className={PRIMARY} onClick={onStartReview} disabled={busy === `review:${run.id}`}>{busy === `review:${run.id}` ? '处理中…' : '多视角复核'}</button>}
          {canResume && <button type="button" className={SECONDARY} onClick={onResume} disabled={busy === `resume:${run.id}`}>{busy === `resume:${run.id}` ? '处理中…' : run.status === 'queued' ? '启动' : '继续'}</button>}
          {onRetry && detail.retryEligibility.eligible && <button type="button" data-testid="research-agent-retry" className={SECONDARY} onClick={onRetry} disabled={busy === `retry:${run.id}`}>{busy === `retry:${run.id}` ? '处理中…' : '重新研究'}</button>}
          {canCancel && <button type="button" className={DANGER} onClick={onCancel} disabled={busy === `cancel:${run.id}`}>{busy === `cancel:${run.id}` ? '处理中…' : '取消'}</button>}
          {onDelete && detail.deleteEligibility.eligible && <button type="button" data-testid="research-agent-delete" className={DANGER} onClick={onDelete} disabled={busy === `delete:${run.id}`}>{busy === `delete:${run.id}` ? '处理中…' : '删除记录'}</button>}
        </div>
      </div>
      {run.status === 'needs_attention' && <div className="mt-3 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950/30 dark:text-red-300">模型或联网请求可能已经送达并产生费用，但没有取得可验证的完整响应。同一账本不能继续；可使用“重新研究”创建新的可追溯运行。</div>}
      {run.errorMessage && run.status !== 'needs_attention' && <div className="mt-3 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{run.errorMessage}</div>}
      {run.runKind === 'single_agent' && run.status === 'succeeded' && !detail.reviewEligibility.eligible && detail.reviewEligibility.reason && <div className="mt-3 border-l-2 border-slate-300 px-3 py-2 text-slate-500 dark:border-slate-700 dark:text-slate-400">多视角复核不可用：{detail.reviewEligibility.reason}</div>}
      <div className="mt-4 flex border-b border-slate-200 dark:border-slate-800" role="tablist" aria-label="深度研究详情">
        <button
          ref={reportTabRef}
          id={`research-agent-report-tab-${run.id}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'report'}
          aria-controls={`research-agent-report-panel-${run.id}`}
          tabIndex={activeTab === 'report' ? 0 : -1}
          data-testid="research-agent-report-tab"
          onClick={() => setActiveTab('report')}
          onKeyDown={selectAdjacentTab}
          className={`min-h-11 border-b-2 px-4 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/40 motion-reduce:transition-none ${activeTab === 'report' ? 'border-cyan-600 text-cyan-800 dark:border-cyan-400 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}
        >
          研究报告
        </button>
        <button
          ref={evidenceTabRef}
          id={`research-agent-evidence-tab-${run.id}`}
          type="button"
          role="tab"
          aria-selected={activeTab === 'evidence'}
          aria-controls={`research-agent-evidence-panel-${run.id}`}
          tabIndex={activeTab === 'evidence' ? 0 : -1}
          data-testid="research-agent-evidence-tab"
          onClick={() => setActiveTab('evidence')}
          onKeyDown={selectAdjacentTab}
          className={`min-h-11 border-b-2 px-4 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/40 motion-reduce:transition-none ${activeTab === 'evidence' ? 'border-cyan-600 text-cyan-800 dark:border-cyan-400 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}
        >
          证据
        </button>
      </div>
      <div
        id={`research-agent-report-panel-${run.id}`}
        role="tabpanel"
        aria-labelledby={`research-agent-report-tab-${run.id}`}
        hidden={activeTab !== 'report'}
        className="pt-4"
      >
        {run.status === 'succeeded' && run.resultSemantics.conclusionCoverage === 'limited' && detail.conclusionExplanation && (
          <div data-testid="research-agent-conclusion-explanation" className="mb-4 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            <span className="font-semibold">为什么结论覆盖受限：</span>{detail.conclusionExplanation}
          </div>
        )}
        {run.status === 'succeeded' && run.resultSemantics.conclusionCoverage === 'blocked' && (
          <div className="mb-4 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-red-800 dark:bg-red-950/30 dark:text-red-200">
            研究流程已结束，但本次没有形成可发布的完整结论。报告保留已确认事实与剩余缺口；具体来源和取证过程可在“证据”中查看。
          </div>
        )}
        {run.runKind === 'multi_perspective' ? <MultiPerspectiveReport detail={detail} /> : detail.reportMarkdown ? (
          <section data-testid="research-agent-report">
            <div className="prose prose-sm max-w-none prose-h1:mb-3 prose-h1:mt-2 prose-h1:text-lg prose-h2:mb-2 prose-h2:mt-4 prose-h2:text-sm prose-li:my-0 prose-p:my-2 dark:prose-invert"><ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.reportMarkdown}</ReactMarkdown></div>
          </section>
        ) : (
          <div className="border-l-2 border-slate-300 px-3 py-3 leading-5 text-slate-500 dark:border-slate-700 dark:text-slate-400">
            {['queued', 'running', 'paused'].includes(run.status) ? '研究报告尚未生成，当前进度会持续保留。' : '本次运行没有可展示的研究报告。'}
          </div>
        )}
      </div>
      <div
        id={`research-agent-evidence-panel-${run.id}`}
        role="tabpanel"
        aria-labelledby={`research-agent-evidence-tab-${run.id}`}
        hidden={activeTab !== 'evidence'}
        className="pt-4"
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
          <Metric label="结论覆盖" value={researchConclusionCoverageLabel(run.resultSemantics.conclusionCoverage)} />
          <Metric label="模型" value={formatBudgetUsage(run.modelCallCount, run.maxModelCalls)} />
          <Metric label="工具" value={formatBudgetUsage(run.toolCallCount, run.maxToolCalls)} />
          <Metric label="Token" value={run.usageStatus === 'not_started' ? '--' : run.usageStatus === 'complete' ? String(run.totalTokens) : `${run.totalTokens}（不完整）`} />
          <Metric label="金额" value={run.costStatus === 'complete' && run.costCurrency ? `${run.estimatedCost.toFixed(4)} ${run.costCurrency}` : '无法估算'} />
        </div>
        {run.runKind === 'single_agent'
          ? <ResearchEvidenceProcess detail={detail} />
          : <MultiPerspectiveEvidence detail={detail} />}
        {run.runKind === 'single_agent' && plan && (
          <details data-testid="research-agent-plan" className="mt-3 border-t border-slate-200 dark:border-slate-800">
            <summary className="flex min-h-11 cursor-pointer items-center font-semibold">研究计划</summary>
            <div className="grid gap-3 pb-3 sm:grid-cols-2">
              <div>
                <div className="font-medium text-slate-700 dark:text-slate-200">待核验问题</div>
                <ol className="mt-1.5 space-y-1 text-slate-500 dark:text-slate-400">
                  {plan.questions.map((question, index) => <li key={question}>{index + 1}. {question}</li>)}
                </ol>
              </div>
              <div>
                <div className="font-medium text-slate-700 dark:text-slate-200">停止条件</div>
                <ul className="mt-1.5 space-y-1 text-slate-500 dark:text-slate-400">
                  {plan.stopConditions.map((condition) => <li key={condition}>- {condition}</li>)}
                </ul>
              </div>
            </div>
          </details>
        )}
        <details className="mt-3 border-y border-slate-200 dark:border-slate-800">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold">步骤与证据账本</summary>
          <div className="space-y-3 pb-3">
            <ol className="space-y-1">
              {detail.steps.map((step) => <li key={step.id} className="flex justify-between gap-3"><span>{step.ordinal}. {phaseLabel(run.runKind, step.kind)}</span><span className="text-slate-500">{step.status} · {step.attemptCount} 次</span></li>)}
            </ol>
            {detail.modelCalls.length > 0 && (
              <div data-testid="research-agent-model-calls" className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                <div className="font-medium text-slate-700 dark:text-slate-200">模型调用摘要</div>
                {detail.modelCalls.map((call) => (
                  <div key={call.id} className="grid gap-1 sm:grid-cols-[160px_minmax(0,1fr)]">
                    <span>{modelCallPurposeLabel(call.purpose)}</span>
                    <span className="min-w-0 break-words text-slate-500">
                      {call.status} · {call.totalTokens == null ? 'Token 未返回' : `${call.totalTokens} tokens`}
                      {call.estimatedCost != null && call.costCurrency ? ` · ${call.estimatedCost.toFixed(4)} ${call.costCurrency}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
        <ResearchAuditTrace trace={detail.researchTrace} variant="compact" />
      </div>
    </div>
  )
}

function MultiPerspectiveReport({ detail }: { detail: ResearchAgentRunDetailView }) {
  const review = detail.multiPerspective
  if (!review) {
    return <section className="mt-3 border-y border-slate-200 py-3 text-slate-500 dark:border-slate-800 dark:text-slate-400">共享证据正在校验，角色调用尚未开始。</section>
  }
  const { bull, bear, moderator } = review
  return (
    <section data-testid="research-agent-multi-perspective" className="mt-3 border-y border-slate-200 py-3 dark:border-slate-800">
      <div data-testid="research-agent-moderator">
        <h4 className="font-semibold text-slate-800 dark:text-slate-100">中立主持</h4>
        {!moderator ? <p className="mt-2 text-slate-500 dark:text-slate-400">等待多方与空方均完成后生成。</p> : (
          <div className="mt-2 space-y-4">
            <div><div className="font-medium text-slate-700 dark:text-slate-200">中立结论</div><p className="mt-1 leading-5 text-slate-600 dark:text-slate-300">{moderator.conclusion.statement} <EvidenceRefs values={moderator.conclusion.evidenceRefs} /></p></div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div data-testid="research-agent-consensus">
                <div className="font-medium text-slate-700 dark:text-slate-200">已确认共识</div>
                <ul className="mt-1.5 space-y-1.5 text-slate-600 dark:text-slate-300">{moderator.consensus.length > 0 ? moderator.consensus.map((item) => <li key={`${item.statement}-${item.evidenceRefs.join('-')}`}>- {item.statement} <EvidenceRefs values={item.evidenceRefs} /></li>) : <li>- 暂无可确认共识</li>}</ul>
              </div>
              <div data-testid="research-agent-unknowns">
                <div className="font-medium text-slate-700 dark:text-slate-200">剩余未知</div>
                <ul className="mt-1.5 space-y-1.5 text-slate-600 dark:text-slate-300">{moderator.unknowns.length > 0 ? moderator.unknowns.map((item) => <li key={item}>- {item}</li>) : <li>- 未识别到额外未知项</li>}</ul>
              </div>
            </div>
            <div data-testid="research-agent-disagreements">
              <div className="font-medium text-slate-700 dark:text-slate-200">核心分歧</div>
              <div className="mt-1.5 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {moderator.disagreements.map((item) => <div key={item.topic} className="py-2"><div className="flex flex-wrap items-center justify-between gap-2 font-semibold"><span>{item.topic}</span><span className="text-[11px] text-slate-400">{confidenceLabel(item.materiality)}重要性</span></div><div className="mt-1 grid gap-1 text-slate-600 dark:text-slate-300 sm:grid-cols-[44px_minmax(0,1fr)]"><span className="text-emerald-700 dark:text-emerald-300">多方</span><span>{item.bullPosition}</span><span className="text-red-700 dark:text-red-300">空方</span><span>{item.bearPosition}</span><span className="text-slate-400">证据</span><EvidenceRefs values={item.evidenceRefs} /></div></div>)}
              </div>
            </div>
            <div data-testid="research-agent-verification-checklist">
              <div className="font-medium text-slate-700 dark:text-slate-200">验证清单</div>
              <ol className="mt-1.5 space-y-2 text-slate-600 dark:text-slate-300">{moderator.verificationChecklist.map((item, index) => <li key={item.question}>{index + 1}. {item.question}<div className="mt-0.5 pl-4 text-slate-400">{item.reason} · {item.preferredSource}</div></li>)}</ol>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-4 border-t border-slate-200 pt-3 dark:border-slate-800 lg:grid-cols-2 lg:divide-x lg:divide-slate-200 dark:lg:divide-slate-800">
        <MultiPerspectiveRoleSection title="多方研判" role={bull} testId="research-agent-bull" />
        <div className="lg:pl-4"><MultiPerspectiveRoleSection title="空方研判" role={bear} testId="research-agent-bear" /></div>
      </div>
    </section>
  )
}

function MultiPerspectiveEvidence({ detail }: { detail: ResearchAgentRunDetailView }) {
  const review = detail.multiPerspective
  if (!review) {
    return <section className="mt-3 border-y border-slate-200 py-3 text-slate-500 dark:border-slate-800 dark:text-slate-400">共享证据尚未固化。</section>
  }
  const { quality } = review
  return (
    <section data-testid="research-agent-multi-perspective-evidence" className="mt-3 border-y border-slate-200 py-3 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="font-semibold text-slate-800 dark:text-slate-100">共享证据边界</h4>
          <div className="mt-1 text-slate-500 dark:text-slate-400">来源运行 {review.sourceRunId.slice(0, 8)} · 证据 {review.evidenceSnapshotSha256.slice(0, 12)}…</div>
        </div>
        <div className="text-right text-slate-500 dark:text-slate-400"><div className="font-semibold text-emerald-700 dark:text-emerald-300">零次重新取数</div><div className="mt-1">3 个固定角色 · 同一资料截点</div></div>
      </div>
      {quality && (
        <div className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800" data-testid="research-agent-quality-summary">
          <div className="font-medium text-slate-700 dark:text-slate-200">结构质量对比</div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5">
            <Metric label="原报告有效引用" value={String(quality.sourceReportValidReferenceCount)} />
            <Metric label="正反主张" value={String(quality.roleClaimCount)} />
            <Metric label="核心分歧" value={String(quality.disagreementCount)} />
            <Metric label="剩余未知" value={String(quality.unknownCount)} />
            <Metric label="验证事项" value={String(quality.verificationCount)} />
          </div>
          <p className="mt-2 text-[11px] leading-5 text-slate-400">{quality.note}</p>
        </div>
      )}
    </section>
  )
}

function MultiPerspectiveRoleSection({ title, role, testId }: {
  title: string
  role: NonNullable<ResearchAgentRunDetailView['multiPerspective']>['bull']
  testId: string
}) {
  return (
    <div data-testid={testId}>
      <h4 className="font-semibold text-slate-800 dark:text-slate-100">{title}</h4>
      {!role ? <p className="mt-2 text-slate-500 dark:text-slate-400">角色尚未完成。</p> : <>
        <p className="mt-2 leading-5 text-slate-700 dark:text-slate-200">{role.thesis}</p>
        <ol className="mt-2 space-y-2 text-slate-600 dark:text-slate-300">{role.claims.map((claim) => <li key={claim.id}><span className="font-medium text-slate-700 dark:text-slate-200">{claim.id}</span> · {claim.statement} <EvidenceRefs values={claim.evidenceRefs} /><span className="ml-1 text-[11px] text-slate-400">{confidenceLabel(claim.confidence)}置信</span></li>)}</ol>
        {role.counterpoints.length > 0 && <div className="mt-3"><div className="font-medium text-slate-700 dark:text-slate-200">对相反事实的回应</div><ul className="mt-1.5 space-y-1.5 text-slate-600 dark:text-slate-300">{role.counterpoints.map((item) => <li key={`${item.statement}-${item.evidenceRefs.join('-')}`}>- {item.statement} <EvidenceRefs values={item.evidenceRefs} /></li>)}</ul></div>}
        {role.unknowns.length > 0 && <div className="mt-3"><div className="font-medium text-slate-700 dark:text-slate-200">本角色未知项</div><ul className="mt-1.5 space-y-1 text-slate-500 dark:text-slate-400">{role.unknowns.map((item) => <li key={item}>- {item}</li>)}</ul></div>}
      </>}
    </div>
  )
}

function EvidenceRefs({ values }: { values: string[] }) {
  return <span className="inline-flex flex-wrap gap-1 align-middle">{values.map((value) => <code key={value} className="text-[11px] text-cyan-700 dark:text-cyan-300">[{value}]</code>)}</span>
}

function ResearchEvidenceProcess({ detail }: { detail: ResearchAgentRunDetailView }) {
  const { run, toolCalls } = detail
  const localCalls = toolCalls.filter((call) => call.scope === 'local')
  const networkCalls = toolCalls.filter((call) => call.scope === 'network')
  const localGate = detail.evidenceGateHistory.find((item) => item.stage === 'local')?.gate ?? detail.evidenceGate
  const latestGate = detail.evidenceGate
  const initialGaps = localGate?.checks.filter((check) => check.status === 'failed') ?? []
  const remainingGaps = latestGate?.checks.filter((check) => check.status === 'failed') ?? []
  const candidateCount = networkCalls.reduce((sum, call) => sum + call.candidates.length, 0)
  const documentCount = effectiveDocumentCount(networkCalls)
  const sourceCount = effectiveSourceCount(toolCalls)
  const unrestricted = run.budgetVersion === 'single-agent-unrestricted-v3'
  const blocked = run.outcome === 'blocked'
  const completedWithGaps = unrestricted
    && latestGate?.decision === 'network_required'
    && run.status === 'succeeded'

  return (
    <section data-testid="research-agent-evidence-overview" className="mt-3 border-y border-slate-200 py-3 dark:border-slate-800">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-semibold text-slate-800 dark:text-slate-100">证据覆盖与联网过程</h4>
          <p className="mt-1 leading-5 text-slate-500 dark:text-slate-400">先核验本地不可变事实，硬缺口存在时才开放受控联网工具；每次补证后重新执行同版本门禁。</p>
        </div>
        <span className={`font-semibold ${blocked ? 'text-red-700 dark:text-red-300' : latestGate?.decision === 'local_sufficient' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
          {blocked ? '完整结论已阻断' : latestGate?.decision === 'local_sufficient' ? '证据评估已通过' : completedWithGaps ? '已降级完成' : '证据仍在核验'}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5" data-testid="research-agent-coverage-metrics">
        <Metric label="本地工具" value={`${localCalls.length} 次`} />
        <Metric label="联网工具" value={`${networkCalls.length} 次`} />
        <Metric label="候选来源" value={`${candidateCount} 项`} />
        <Metric label="可用正文" value={`${documentCount} 份`} />
        <Metric label="已固化来源" value={`${sourceCount} 个`} />
      </div>

      {localGate && (
        <div data-testid="research-agent-evidence-gate" className={`mt-3 border-l-2 px-3 py-2 ${initialGaps.length > 0 ? 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100' : 'border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100'}`}>
          <div className="font-semibold">{initialGaps.length > 0 ? '为什么需要联网' : '本地证据覆盖充分'}</div>
          <div className="mt-1 leading-5">{localGate.summary}</div>
          {initialGaps.length > 0 && <ul className="mt-1.5 space-y-1">{initialGaps.map((check) => <li key={check.code}>- {check.message}</li>)}</ul>}
          {initialGaps.length > 0 && localGate.requiredNetworkTools.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="建议联网工具">
              {localGate.requiredNetworkTools.map((toolId) => <code key={toolId} className="bg-white/70 px-1.5 py-0.5 text-[11px] dark:bg-slate-900/60">{toolId}</code>)}
            </div>
          )}
        </div>
      )}

      {localCalls.length > 0 && (
        <details className="mt-2" data-testid="research-agent-local-evidence">
          <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-semibold"><span>本地证据覆盖</span><span className="font-normal text-slate-400">{localCalls.length} 次调用</span></summary>
          <div className="divide-y divide-slate-200 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {localCalls.map((call) => <LocalToolCall key={call.id} call={call} />)}
          </div>
        </details>
      )}

      {networkCalls.length > 0 && (
        <details open className="mt-2" data-testid="research-agent-network-evidence">
          <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 font-semibold"><span>受控联网证据</span><span className="font-normal text-slate-400">{networkCalls.length} 次调用</span></summary>
          <div className="divide-y divide-slate-200 border-t border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {networkCalls.map((call) => <NetworkToolCall key={call.id} call={call} />)}
          </div>
        </details>
      )}

      {latestGate && (
        <div data-testid="research-agent-remaining-unknowns" className={`mt-3 border-l-2 px-3 py-2 ${remainingGaps.length > 0 ? 'border-red-500 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-200' : 'border-emerald-500 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'}`}>
          <div className="font-semibold">{remainingGaps.length > 0 ? '剩余未知项' : '联网后门禁结果'}</div>
          {remainingGaps.length > 0
            ? <ul className="mt-1.5 space-y-1">{remainingGaps.map((check) => <li key={check.code}>- {check.message}</li>)}</ul>
            : <p className="mt-1 leading-5">当前问题要求的最低证据条件已满足；这不代表结论确定，也不等于交易建议。</p>}
          {remainingGaps.length > 0 && (
            <p className="mt-2 leading-5">
              {unrestricted
                ? '联网仍不足时继续使用已固化资料完成综合，结论覆盖最多标记为受限，并保留全部未知项。'
                : '联网仍不足时仅保留结论覆盖受限或形成受阻的结果，不调用模型生成完整综合结论。'}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

type ResearchAgentToolCallView = ResearchAgentRunDetailView['toolCalls'][number]

function LocalToolCall({ call }: { call: ResearchAgentToolCallView }) {
  const warnings = readStrings(call.warnings)
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[180px_minmax(0,1fr)]">
      <code className="break-all text-slate-700 dark:text-slate-200">{call.toolId}</code>
      <div className="min-w-0 break-words text-slate-500 dark:text-slate-400">
        <div>{toolCallStatusLabel(call.status)} · {call.factDate ? formatAsOf(call.factDate) : '事实日未知'} · {formatCoverage(call.coverage)} · {call.stableReferences.length} 个引用</div>
        {readSourceIds(call.sources).length > 0 && <div className="mt-1">来源：{readSourceIds(call.sources).join('、')}</div>}
        {warnings.length > 0 && <div className="mt-1 text-amber-700 dark:text-amber-300">{warnings.join('；')}</div>}
        {call.failure && <ToolFailure failure={call.failure} />}
      </div>
    </div>
  )
}

function NetworkToolCall({ call }: { call: ResearchAgentToolCallView }) {
  const warnings = readStrings(call.warnings)
  return (
    <article className="min-w-0 py-3" data-testid={`research-agent-network-call-${call.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="break-all font-semibold text-slate-800 dark:text-slate-100">{call.toolId}</code>
        <span className="text-slate-500 dark:text-slate-400">{toolCallStatusLabel(call.status)} · {formatCoverage(call.coverage)}</span>
      </div>

      {call.kind === 'search' && call.request.query && (
        <div className="mt-2 grid gap-1 sm:grid-cols-[88px_minmax(0,1fr)]">
          <span className="text-slate-400">实际查询</span>
          <span className="min-w-0 break-words text-slate-700 dark:text-slate-200">{call.request.query}</span>
          {call.searchProvider && <><span className="text-slate-400">搜索服务</span><span>{call.searchProvider}</span></>}
        </div>
      )}

      {call.candidates.length > 0 && (
        <ol className="mt-2 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800" data-testid="research-agent-search-candidates">
          {call.candidates.map((candidate, index) => (
            <li key={candidate.candidateId} className="py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 font-medium text-slate-800 dark:text-slate-100">{index + 1}. {candidate.title}</span>
                <span className="shrink-0 text-[11px] text-slate-500">{sourceClassLabel(candidate.sourceClass)} · {candidate.publishedAt ? formatSourceTime(candidate.publishedAt) : '发布时间未知'}</span>
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-cyan-700 dark:text-cyan-300">{candidate.url}</div>
              {candidate.snippet && <p className="mt-1 break-words leading-5 text-slate-500 dark:text-slate-400">{candidate.snippet}</p>}
            </li>
          ))}
        </ol>
      )}

      {call.document && (
        <div className="mt-2" data-testid="research-agent-document">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="font-medium text-slate-800 dark:text-slate-100">{call.document.title}</span>
            <span className="text-[11px] text-slate-500">{sourceClassLabel(call.document.sourceClass)} · {call.document.publishedAt ? formatSourceTime(call.document.publishedAt) : '发布时间未知'}</span>
          </div>
          <div className="mt-1 break-all font-mono text-[11px] text-cyan-700 dark:text-cyan-300">{call.document.finalUrl}</div>
          <blockquote className="mt-2 border-l-2 border-slate-300 pl-3 leading-5 text-slate-600 dark:border-slate-700 dark:text-slate-300">{call.document.excerpt}{call.document.excerptTruncated ? '…' : ''}</blockquote>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <span>抓取 {formatTimestamp(call.document.fetchedAt)}</span>
            <span>{call.document.mimeKind.toUpperCase()}</span>
            <span>正文哈希 {call.document.contentSha256.slice(0, 12)}…</span>
          </div>
        </div>
      )}

      {call.network && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400" data-testid="research-agent-network-envelope">
          <span>{call.network.method} {call.network.requestHost}</span>
          <span>HTTP {call.network.statusCode}</span>
          <span>{formatBytes(call.network.decodedBytes)}</span>
          <span>{call.network.redirectCount} 次重定向</span>
          <span>{formatTimestamp(call.network.fetchedAt)}</span>
        </div>
      )}
      {warnings.length > 0 && <div className="mt-2 text-amber-700 dark:text-amber-300">{warnings.join('；')}</div>}
      {call.failure && <ToolFailure failure={call.failure} />}
    </article>
  )
}

function ToolFailure({ failure }: { failure: NonNullable<ResearchAgentToolCallView['failure']> }) {
  return (
    <div className="mt-2 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950/30 dark:text-red-300" data-testid="research-agent-tool-failure">
      <div className="font-semibold">{toolFailureLabel(failure.category)} · {failure.code}</div>
      <div className="mt-1 leading-5">{failure.message}</div>
      <div className="mt-1 text-[11px]">{failure.resultUnknown ? '结果与费用均可能未知，禁止在同一运行自动重放。' : failure.retryable ? '失败发生在可确认边界，可由用户显式发起后续运行。' : '该失败不应原样重试。'}</div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-slate-400">{label}</div><div className="mt-0.5 break-words font-medium text-slate-700 dark:text-slate-200">{value}</div></div>
}

function formatBudgetUsage(completed: number, maximum: number | null): string {
  return maximum == null ? `${completed}（按需）` : `${completed}/${maximum}`
}

export function normalizeStockSubjects(value: string): ResearchAgentSubjectView[] {
  const values = value.split(/[\s,，;；]+/).map((item) => item.trim().toUpperCase()).filter(Boolean)
  const subjects: ResearchAgentSubjectView[] = []
  for (const value of values) {
    const match = value.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/)
    if (!match) continue
    const market = /^(4|8|92)/.test(match[1]) ? 'BJ' : /^(5|6|9|11)/.test(match[1]) ? 'SH' : 'SZ'
    if (match[2] && match[2] !== market) continue
    const tsCode = `${match[1]}.${market}`
    if (!subjects.some((subject) => subject.kind === 'stock' && subject.tsCode === tsCode)) subjects.push({ kind: 'stock', tsCode, label: null })
    if (subjects.length >= 5) break
  }
  return subjects
}

export function formatAsOf(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function readResearchPlan(value: unknown): { questions: string[]; stopConditions: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const questions = Array.isArray(record.questions)
    ? record.questions.filter((item): item is string => typeof item === 'string').slice(0, 6)
    : []
  const stopConditions = Array.isArray(record.stopConditions)
    ? record.stopConditions.filter((item): item is string => typeof item === 'string').slice(0, 6)
    : []
  return questions.length > 0 || stopConditions.length > 0 ? { questions, stopConditions } : null
}

function phaseLabel(
  runKind: ResearchAgentRunSummaryView['runKind'],
  phase: ResearchAgentRunSummaryView['phase'],
): string {
  return runKind === 'multi_perspective' ? MULTI_PERSPECTIVE_PHASE_LABEL[phase] : PHASE_LABEL[phase]
}

function modelCallPurposeLabel(value: string): string {
  if (value === 'planning') return '研究计划'
  if (value === 'synthesis') return '综合报告'
  if (value === 'bull_case') return '多方研判'
  if (value === 'bear_case') return '空方研判'
  if (/^bull_round_\d+$/.test(value)) return `多方第 ${value.split('_').at(-1)} 轮`
  if (/^bear_round_\d+$/.test(value)) return `空方第 ${value.split('_').at(-1)} 轮`
  if (/^convergence_round_\d+$/.test(value)) return `第 ${value.split('_').at(-1)} 轮收敛评估`
  if (value === 'moderator') return '中立主持'
  if (value.startsWith('tool_decision_')) return `事实决策 ${value.slice('tool_decision_'.length)}`
  return value
}

function confidenceLabel(value: 'high' | 'medium' | 'low'): string {
  return { high: '高', medium: '中', low: '低' }[value]
}

function researchConclusionCoverageLabel(value: ResearchAgentRunSummaryView['resultSemantics']['conclusionCoverage']): string {
  return {
    pending: '待形成',
    complete: '完整',
    limited: '受限',
    blocked: '形成受阻',
    unavailable: '未形成',
  }[value]
}

function toolCallStatusLabel(value: string): string {
  return {
    prepared: '已准备',
    submitted: '已提交',
    succeeded: '已固化',
    failed: '失败',
    blocked: '已阻断',
    safe_failed: '安全失败',
    outcome_unknown: '结果未知',
    cancelled: '已取消',
  }[value] ?? value
}

function toolFailureLabel(value: NonNullable<ResearchAgentToolCallView['failure']>['category']): string {
  return {
    cancelled: '调用已取消',
    rate_limited: '上游限流',
    network: '联网失败',
    security: '安全策略阻断',
    configuration: '服务未配置',
    tool: '工具失败',
    outcome_unknown: '调用结果未知',
  }[value]
}

function sourceClassLabel(value: ResearchAgentToolCallView['candidates'][number]['sourceClass']): string {
  if (value === 'official') return '官方来源'
  if (value === 'primary') return '一级来源'
  return '二级来源'
}

function readStrings(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 20)
}

function readSourceIds(value: unknown[]): string[] {
  return value.flatMap((item): string[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const id = (item as Record<string, unknown>).id
    return typeof id === 'string' && id.trim() ? [id.trim().slice(0, 200)] : []
  }).slice(0, 20)
}

function effectiveSourceCount(toolCalls: ResearchAgentToolCallView[]): number {
  const identities = new Set<string>()
  const documentHashes = new Set<string>()
  for (const call of toolCalls) {
    const available = typeof call.coverage.available === 'number' && Number.isFinite(call.coverage.available)
      ? call.coverage.available
      : 0
    if (call.status !== 'succeeded' || available <= 0 || call.kind === 'search') continue
    if (call.document) {
      if (documentHashes.has(call.document.contentSha256)) continue
      documentHashes.add(call.document.contentSha256)
      identities.add(`document:${canonicalDisplayDomain(call.document.sourceDomain)}`)
      continue
    }
    for (const source of call.sources) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue
      const record = source as Record<string, unknown>
      if (record.status !== 'ready' || typeof record.id !== 'string' || !record.id.trim()) continue
      identities.add(`fact:${record.id.trim().slice(0, 200)}`)
    }
  }
  return identities.size
}

function effectiveDocumentCount(toolCalls: ResearchAgentToolCallView[]): number {
  const hashes = new Set<string>()
  for (const call of toolCalls) {
    const available = typeof call.coverage.available === 'number' && Number.isFinite(call.coverage.available)
      ? call.coverage.available
      : 0
    if (call.status !== 'succeeded' || available <= 0 || !call.document) continue
    hashes.add(call.document.contentSha256)
  }
  return hashes.size
}

function canonicalDisplayDomain(value: string): string {
  const domain = value.toLowerCase().replace(/^www\d*\./, '')
  const labels = domain.split('.').filter(Boolean)
  const suffix = labels.slice(-2).join('.')
  return labels.length > 2 && ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn'].includes(suffix)
    ? labels.slice(-3).join('.')
    : labels.slice(-2).join('.')
}

function formatCoverage(value: Record<string, unknown>): string {
  const available = typeof value.available === 'number' && Number.isFinite(value.available) ? value.available : null
  const required = typeof value.required === 'number' && Number.isFinite(value.required) ? value.required : null
  const unit = typeof value.unit === 'string' && value.unit.trim() ? coverageUnitLabel(value.unit) : '项'
  if (available == null) return '覆盖未知'
  return required == null ? `${available} ${unit}` : `${available}/${required} ${unit}`
}

function coverageUnitLabel(value: string): string {
  return {
    bars: '根行情',
    candidates: '项候选',
    documents: '份正文',
    quotes: '份快照',
    reports: '期报告',
  }[value] ?? value
}

function formatSourceTime(value: string): string {
  if (/^\d{8}$/.test(value)) return formatAsOf(value)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? formatTimestamp(timestamp) : value
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}
