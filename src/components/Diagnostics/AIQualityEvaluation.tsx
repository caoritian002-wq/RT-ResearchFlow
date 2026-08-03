import { useCallback, useEffect, useMemo, useState } from 'react'
import { ResearchCombobox } from '../IndustryResearch/ResearchDecisionControls'

type WorkbenchResponse = Awaited<ReturnType<typeof window.api.aiEvaluation.getWorkbench>>
type Workbench = Extract<WorkbenchResponse, { ok: true }>['data']
type RunDetailResponse = Awaited<ReturnType<typeof window.api.aiEvaluation.getRun>>
type RunDetail = Extract<RunDetailResponse, { ok: true }>['data']
type RunRecord = Workbench['runs'][number]
type Conclusion = NonNullable<RunRecord['conclusion']>
type Dimension = keyof Workbench['suite']['dimensionWeights']

interface AIQualityEvaluationProps {
  onOpenAiConfig?: () => void
}

const CONCLUSION_META: Record<Conclusion, { label: string; className: string; bar: string }> = {
  passed: {
    label: '通过',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/35 dark:text-emerald-300',
    bar: 'bg-emerald-500',
  },
  warning: {
    label: '需关注',
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/35 dark:text-amber-300',
    bar: 'bg-amber-500',
  },
  failed: {
    label: '未通过',
    className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-300',
    bar: 'bg-red-500',
  },
}

const DIMENSION_META: Record<Dimension, { label: string; description: string }> = {
  candidateMapping: { label: '候选映射', description: '公司代码与拒绝误映射' },
  directionAccuracy: { label: '方向判断', description: '公司级利好、利空与无关' },
  evidenceDiscipline: { label: '证据纪律', description: '事实、推断与数字边界' },
  marketGrounding: { label: '行情约束', description: '截止日、均线与关键价位' },
  compliance: { label: '合规边界', description: '不输出交易指令或承诺' },
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '尚未完成'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function formatScore(value: number | null | undefined): string {
  return value == null ? '--' : value.toFixed(value % 1 === 0 ? 0 : 1)
}

function formatTokens(value: number | null | undefined): string {
  return value == null ? '未返回' : value.toLocaleString('zh-CN')
}

function runLabel(run: RunRecord): string {
  const state = run.status === 'running'
    ? `${run.progressCurrent}/${run.progressTotal} 进行中`
    : run.status === 'failed'
      ? '调用失败'
      : `${formatScore(run.totalScore)} 分`
  return `${new Date(run.createdAt).toLocaleString('zh-CN', { hour12: false })} · ${state}`
}

function runMeta(run: RunRecord): string {
  return `${run.provider} / ${run.model}`
}

export function AIQualityEvaluation({ onOpenAiConfig }: AIQualityEvaluationProps) {
  const [workbench, setWorkbench] = useState<Workbench | null>(null)
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const loadWorkbench = useCallback(async (): Promise<Workbench | null> => {
    try {
      const response = await window.api.aiEvaluation.getWorkbench()
      if (!response.ok) throw new Error(response.message || 'AI 研判评测状态读取失败')
      setWorkbench(response.data)
      setSelectedProvider((current) => {
        if (current && response.data.targets.some((item) => item.provider === current)) return current
        const activeProvider = response.data.activeRun?.provider
        if (activeProvider && response.data.targets.some((item) => item.provider === activeProvider)) return activeProvider
        return response.data.targets[0]?.provider ?? ''
      })
      setSelectedRunId((current) => {
        if (current && response.data.runs.some((item) => item.id === current)) return current
        return response.data.activeRun?.id ?? response.data.runs[0]?.id ?? null
      })
      setError('')
      return response.data
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 研判评测状态读取失败')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRun = useCallback(async (runId: number): Promise<void> => {
    setDetailLoading(true)
    try {
      const response = await window.api.aiEvaluation.getRun(runId)
      if (!response.ok) throw new Error(response.message || '评测结果读取失败')
      setDetail(response.data)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '评测结果读取失败')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkbench()
  }, [loadWorkbench])

  useEffect(() => {
    if (selectedRunId == null) {
      setDetail(null)
      return
    }
    void loadRun(selectedRunId)
  }, [loadRun, selectedRunId])

  useEffect(() => {
    if (!workbench?.activeRun && detail?.run.status !== 'running') return
    const timer = window.setInterval(() => {
      void loadWorkbench()
      if (selectedRunId != null) void loadRun(selectedRunId)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [detail?.run.status, loadRun, loadWorkbench, selectedRunId, workbench?.activeRun])

  const providerOptions = useMemo(() => workbench?.targets.map((target) => ({
    value: target.provider,
    label: target.providerLabel,
    meta: target.model,
  })) ?? [], [workbench?.targets])

  const runOptions = useMemo(() => workbench?.runs.map((run) => ({
    value: String(run.id),
    label: runLabel(run),
    meta: runMeta(run),
  })) ?? [], [workbench?.runs])

  const selectedTarget = workbench?.targets.find((target) => target.provider === selectedProvider) ?? null
  const run = detail?.run ?? workbench?.runs.find((item) => item.id === selectedRunId) ?? null
  const activeRun = workbench?.activeRun ?? null
  const currentCase = workbench?.suite.cases.find((item) => item.id === run?.currentCaseId) ?? null
  const progress = run && run.progressTotal > 0
    ? Math.min(100, Math.round((run.progressCurrent / run.progressTotal) * 100))
    : 0
  const conclusionMeta = run?.conclusion ? CONCLUSION_META[run.conclusion] : null
  const dimensionEntries = detail?.run.dimensionScores
    ? (Object.entries(detail.run.dimensionScores) as Array<[Dimension, number | null]>)
    : []
  const orderedCases = useMemo(() => [...(detail?.cases ?? [])].sort((left, right) => {
    if (left.status === right.status) return left.completedAt - right.completedAt
    if (left.status === 'failed') return -1
    if (right.status === 'failed') return 1
    return 0
  }), [detail?.cases])

  const startRun = async () => {
    if (!selectedProvider || starting || activeRun) return
    setStarting(true)
    setError('')
    try {
      const response = await window.api.aiEvaluation.startRun(selectedProvider)
      if (!response.ok) throw new Error(response.message || 'AI 研判评测启动失败')
      setSelectedRunId(response.data.runId)
      await loadWorkbench()
      await loadRun(response.data.runId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 研判评测启动失败')
    } finally {
      setStarting(false)
    }
  }

  if (loading && !workbench) {
    return (
      <section data-testid="diagnostics-ai-evaluation" aria-busy="true" className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
        <div className="h-36 animate-pulse bg-gray-100 motion-reduce:animate-none dark:bg-gray-800" />
      </section>
    )
  }

  return (
    <section data-testid="diagnostics-ai-evaluation" className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="border-b border-gray-200 px-4 py-4 dark:border-gray-700">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 max-w-2xl lg:flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">AI 研判评测</h3>
              {workbench && (
                <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                  {workbench.suite.id}@{workbench.suite.version}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-5 text-gray-600 dark:text-gray-300">
              用固定合成样本检查候选映射、方向、证据、行情和合规边界。结果用于发现模型或提示词回归，不代表真实投资准确率。
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
              <span>每次 {workbench?.suite.callCount ?? 4} 次模型调用</span>
              <span>按当前厂商配置消耗 Token</span>
              <span>不写入新闻、会话或决策信号</span>
            </div>
            {workbench && (
              <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                <summary className="w-fit min-h-9 cursor-pointer select-none rounded py-2 pr-2 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:text-gray-100">
                  查看 {workbench.suite.cases.length} 个评测样本
                </summary>
                <div className="grid gap-px overflow-hidden rounded border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800 sm:grid-cols-2">
                  {workbench.suite.cases.map((item, index) => (
                    <div key={item.id} className="bg-white p-3 dark:bg-gray-900">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-cyan-700 dark:text-cyan-300">0{index + 1}</span>
                        <span className="font-medium text-gray-800 dark:text-gray-100">{item.title}</span>
                        <span className="text-[10px] text-gray-400">{item.kind === 'round1' ? '第一轮' : '第二轮'}</span>
                      </div>
                      <p className="mt-1 leading-5 text-gray-500 dark:text-gray-400">{item.purpose}</p>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(220px,1fr)_auto] lg:w-[440px] lg:shrink-0 lg:pr-0">
            <ResearchCombobox
              testId="ai-evaluation-provider"
              value={selectedProvider}
              options={providerOptions}
              placeholder="选择已配置的 AI 厂商"
              searchPlaceholder="搜索厂商或模型"
              disabled={Boolean(activeRun) || starting || providerOptions.length === 0}
              onChange={setSelectedProvider}
            />
            <button
              type="button"
              data-testid="ai-evaluation-start"
              disabled={!selectedTarget || Boolean(activeRun) || starting}
              onClick={() => void startRun()}
              className="min-h-11 whitespace-nowrap rounded-md bg-cyan-700 px-3 text-xs font-medium leading-5 text-white outline-none transition-colors duration-150 hover:bg-cyan-800 focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-500 motion-reduce:transition-none dark:disabled:bg-gray-800 dark:disabled:text-gray-500"
            >
              {starting ? '正在启动…' : activeRun ? '评测进行中' : '运行当前模型评测'}
            </button>
            {selectedTarget && (
              <div className="min-w-0 text-[11px] text-gray-500 dark:text-gray-400 sm:col-span-2">
                本次固定使用 {selectedTarget.providerLabel} / {selectedTarget.model}，不会跨厂商降级。
              </div>
            )}
            {!selectedTarget && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300 sm:col-span-2">
                <span>尚无完整配置的 AI 厂商，需先配置 API Key 和模型。</span>
                {onOpenAiConfig && (
                  <button type="button" onClick={onOpenAiConfig} className="min-h-9 rounded px-2 font-medium text-cyan-700 hover:bg-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:text-cyan-300 dark:hover:bg-cyan-950/30">
                    打开 AI 配置
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          {error}
          <button type="button" onClick={() => void loadWorkbench()} className="ml-2 min-h-9 rounded px-2 font-medium hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:bg-red-950/60">重新读取</button>
        </div>
      )}

      {workbench && workbench.runs.length > 0 && (
        <div className="border-b border-gray-200 bg-gray-50/70 px-4 py-3 dark:border-gray-700 dark:bg-gray-950/30">
          <div className="grid gap-3 md:grid-cols-[minmax(260px,420px)_1fr] md:items-center">
            <div>
              <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">评测记录</div>
              <ResearchCombobox
                testId="ai-evaluation-run"
                value={selectedRunId == null ? '' : String(selectedRunId)}
                options={runOptions}
                placeholder="选择评测记录"
                searchPlaceholder="搜索时间、厂商或模型"
                onChange={(value) => setSelectedRunId(Number(value))}
              />
            </div>
            {activeRun && selectedRunId !== activeRun.id && (
              <div className="flex items-center justify-between gap-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300">
                <span>另一个评测正在后台执行 {activeRun.progressCurrent}/{activeRun.progressTotal}</span>
                <button type="button" onClick={() => setSelectedRunId(activeRun.id)} className="min-h-9 shrink-0 rounded px-2 font-medium hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-blue-950/50">查看任务</button>
              </div>
            )}
          </div>
        </div>
      )}

      {!run && workbench?.runs.length === 0 && (
        <div className="px-4 py-8 text-center">
          <div className="text-sm font-medium text-gray-700 dark:text-gray-200">尚无评测记录</div>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">选择一个已配置厂商后运行，完成结果会在这里保留并用于后续比较。</p>
        </div>
      )}

      {run && (
        <div aria-live="polite" aria-busy={run.status === 'running'} className="min-w-0">
          <div className="px-4 py-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {run.status === 'running' && <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-500 motion-reduce:animate-none" />}
                  {run.status === 'completed' && conclusionMeta && <span className={`rounded border px-2 py-0.5 text-xs font-medium ${conclusionMeta.className}`}>{conclusionMeta.label}</span>}
                  {run.status === 'failed' && <span className="rounded border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-300">运行失败</span>}
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {run.status === 'running'
                      ? `正在评测 ${run.progressCurrent}/${run.progressTotal}`
                      : run.status === 'completed'
                        ? '本次评测已完成'
                        : '本次评测未完成'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {run.status === 'running'
                    ? currentCase ? `当前样本：${currentCase.title}` : '正在保存样本结果并汇总得分'
                    : run.status === 'failed'
                      ? run.errorMessage ?? '模型调用中断，可重新发起完整评测。'
                      : `完成于 ${formatTime(run.completedAt)}`}
                </p>
              </div>
              <div className="shrink-0 text-left sm:text-right">
                <div className="font-mono text-[11px] text-gray-400">{run.provider} / {run.model}</div>
                <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">Token：{formatTokens(run.totalTokens)}</div>
              </div>
            </div>
            {run.status === 'running' && (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                  <div data-testid="ai-evaluation-progress" className="h-full rounded-full bg-blue-500 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-gray-400">
                  <span>可切换到其他页面，主进程会继续执行</span>
                  <span className="font-mono tabular-nums">{progress}%</span>
                </div>
              </div>
            )}
          </div>

          {run.status === 'completed' && detail && (
            <>
              <div className="grid gap-px border-y border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800 lg:grid-cols-[180px_minmax(0,1fr)]">
                <div className="flex items-center justify-between bg-white px-4 py-4 dark:bg-gray-900 lg:block">
                  <div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">综合得分</div>
                    <div data-testid="ai-evaluation-total-score" className="mt-1 font-mono text-3xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatScore(run.totalScore)}</div>
                  </div>
                  <div className="text-right text-[11px] text-gray-500 dark:text-gray-400 lg:mt-2 lg:text-left">
                    {detail.comparison
                      ? <span data-testid="ai-evaluation-comparison">较可比上次 {detail.comparison.delta >= 0 ? '+' : ''}{formatScore(detail.comparison.delta)} 分</span>
                      : detail.baselineChanged
                        ? '评测身份已变化，暂不与上次直接比较'
                        : '暂无同模型、同提示词可比基线'}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-px bg-gray-100 dark:bg-gray-800 sm:grid-cols-3 lg:grid-cols-5">
                  {dimensionEntries.map(([key, value]) => (
                    <div key={key} data-testid={`ai-evaluation-dimension-${key}`} className="min-w-0 bg-white px-3 py-4 dark:bg-gray-900">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-xs font-medium text-gray-700 dark:text-gray-200">{DIMENSION_META[key].label}</span>
                        <span className="shrink-0 font-mono text-base font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatScore(value)}</span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                        <div className={`h-full rounded-full ${value != null && value >= 85 ? 'bg-emerald-500' : value != null && value >= 70 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
                      </div>
                      <div className="mt-1.5 text-[10px] leading-4 text-gray-400 dark:text-gray-500">{DIMENSION_META[key].description}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="px-4 py-4">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">样本定位</h4>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">失败样本优先展示；规则和模型原文只在需要定位时展开。</p>
                  </div>
                  <div className="text-[11px] text-gray-400">输入 {formatTokens(run.inputTokens)} · 输出 {formatTokens(run.outputTokens)} Token</div>
                </div>
                <div className="mt-3 divide-y divide-gray-100 border-y border-gray-100 dark:divide-gray-800 dark:border-gray-800">
                  {orderedCases.map((item) => {
                    const meta = CONCLUSION_META[item.status]
                    const failedRules = item.rules.filter((rule) => !rule.passed)
                    return (
                      <div key={item.caseId} data-testid={`ai-evaluation-case-${item.caseId}`} className="py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`rounded border px-1.5 py-0.5 text-[11px] ${meta.className}`}>{meta.label}</span>
                              <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{item.title}</span>
                              <span className="text-[10px] text-gray-400">{item.kind === 'round1' ? '第一轮' : '第二轮'}</span>
                            </div>
                            <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                              {formatScore(item.score)} 分 · {failedRules.length > 0 ? `${failedRules.length} 项规则失败` : '全部规则通过'} · {formatTokens(item.totalTokens)} Token
                            </div>
                          </div>
                        </div>
                        <details className="mt-2 text-xs">
                          <summary className="w-fit min-h-9 cursor-pointer select-none rounded py-2 pr-2 text-cyan-700 hover:text-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:text-cyan-300 dark:hover:text-cyan-200">
                            查看规则与模型原文
                          </summary>
                          <div className="mt-1 grid gap-3 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
                            <div className="min-w-0">
                              <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">确定性规则</div>
                              <div className="divide-y divide-gray-100 overflow-hidden rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
                                {item.rules.map((rule) => (
                                  <div key={rule.id} className="flex gap-2 px-3 py-2">
                                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${rule.passed ? 'bg-emerald-500' : 'bg-red-500'}`} />
                                    <div className="min-w-0">
                                      <div className="font-medium text-gray-700 dark:text-gray-200">
                                        {rule.title}{rule.blocking && !rule.passed ? '（阻断）' : ''}
                                      </div>
                                      <div className="mt-0.5 leading-5 text-gray-500 dark:text-gray-400">{rule.detail}</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="mb-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">模型原文</div>
                              <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded border border-gray-200 bg-gray-50 p-3 font-sans text-xs leading-5 text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300">{item.responseText}</pre>
                            </div>
                          </div>
                        </details>
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {detailLoading && !detail && <div className="px-4 py-6 text-center text-xs text-gray-500">正在读取评测明细…</div>}
        </div>
      )}
    </section>
  )
}
