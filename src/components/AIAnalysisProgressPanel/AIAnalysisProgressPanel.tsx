import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import type { AIProgressUsage } from '../../store/appStore'

const STEPS = [
  { key: 'fetching', label: '获取文章内容' },
  { key: 'callingRound1', label: '调用第一轮 AI' },
  { key: 'parsingStocks', label: '解析股票代码' },
  { key: 'recoveringCandidates', label: '补充A股标的映射' },
  { key: 'fetchingPrices', label: '拉取股票行情' },
  { key: 'callingRound2', label: '等待第二轮 AI 返回' },
  { key: 'saving', label: '保存分析结果' },
  { key: 'done', label: '分析完成' }
] as const

function stepIndex(step: string): number {
  const map: Record<string, number> = {
    fetching: 0,
    calling: 1,
    callingRound1: 1,
    parsingStocks: 2,
    recoveringCandidates: 3,
    fetchingPrices: 4,
    callingRound2: 5,
    saving: 6,
    done: 7,
    error: 7
  }
  return map[step] ?? -1
}

function formatToken(value?: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '--'
}

function usageStatus(usage: AIProgressUsage): { label: string; className: string } {
  const maxTokens = usage.maxTokens ?? 4096
  const outputTokens = usage.outputTokens
  const truncated = usage.finishReason === 'length' || usage.finishReason === 'max_tokens'
  if (truncated) return { label: '可能已截断', className: 'text-red-500' }
  if (typeof outputTokens === 'number' && outputTokens >= Math.floor(maxTokens * 0.9)) {
    return { label: '接近上限', className: 'text-amber-500' }
  }
  if (typeof outputTokens === 'number') return { label: '未触顶', className: 'text-green-500' }
  return { label: '未返回用量', className: 'text-gray-400 dark:text-gray-500' }
}

function UsageRow({ label, usage }: { label: string; usage?: AIProgressUsage }) {
  if (!usage) return null
  const status = usageStatus(usage)
  return (
    <div className="rounded border border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 px-2 py-1.5 text-[11px] text-gray-600 dark:text-gray-300">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-gray-700 dark:text-gray-200">{label}</span>
        <span className={status.className}>{status.label}</span>
      </div>
      <div className="mt-1 grid grid-cols-4 gap-1 tabular-nums">
        <span>入 {formatToken(usage.inputTokens)}</span>
        <span>出 {formatToken(usage.outputTokens)}</span>
        <span>总 {formatToken(usage.totalTokens)}</span>
        <span>上限 {formatToken(usage.maxTokens ?? 4096)}</span>
      </div>
      <div className="mt-0.5 truncate text-gray-400 dark:text-gray-500">
        {usage.provider}/{usage.model} · finish: {usage.finishReason ?? '--'}
      </div>
    </div>
  )
}

function progressPercent(step: string, current?: number, total?: number): number {
  if (step === 'done') return 100
  const index = stepIndex(step)
  if (index < 0) return 0
  if (step === 'error') return 100
  const completedSteps = index / (STEPS.length - 1)
  const currentStepProgress = index === 0 && current != null && total != null && total > 0
    ? Math.max(0, Math.min(1, current / total)) / (STEPS.length - 1)
    : 0
  return Math.max(4, Math.min(96, Math.round((completedSteps + currentStepProgress) * 100)))
}

function currentStepLabel(step: string, current?: number, total?: number): string {
  if (step === 'error') return '分析失败'
  const item = STEPS[Math.max(0, stepIndex(step))]
  if (!item) return '准备分析'
  if (step === 'fetching' && current != null && total != null) return `${item.label} ${current}/${total}`
  return item.label
}

function CollapseIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {expanded ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
    </svg>
  )
}

export function AIAnalysisProgressPanel() {
  const { aiProgress, setAiProgress } = useAppStore()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousProgressRef = useRef<typeof aiProgress>(null)
  const [isMinimized, setIsMinimized] = useState(false)

  useEffect(() => {
    if (aiProgress && previousProgressRef.current == null) setIsMinimized(false)
    previousProgressRef.current = aiProgress
  }, [aiProgress])

  useEffect(() => {
    if (aiProgress?.step === 'done' || aiProgress?.step === 'error') {
      timerRef.current = setTimeout(() => setAiProgress(null), 2000)
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [aiProgress, setAiProgress])

  if (!aiProgress) return null

  const currentIdx = stepIndex(aiProgress.step)
  const isError = aiProgress.step === 'error'
  const isDone = aiProgress.step === 'done'
  const percent = progressPercent(aiProgress.step, aiProgress.current, aiProgress.total)
  const compactLabel = currentStepLabel(aiProgress.step, aiProgress.current, aiProgress.total)
  const statusTitle = isError ? 'AI 分析失败' : isDone ? 'AI 分析完成' : 'AI 分析进行中'

  if (isMinimized) {
    return (
      <aside
        id="ai-analysis-progress-panel"
        data-testid="ai-analysis-progress-panel"
        data-state="minimized"
        aria-label="AI 分析进度"
        className="fixed bottom-4 right-4 z-[60] w-[min(17rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg shadow-slate-900/15 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/35"
      >
        <div className="flex min-h-14 items-stretch">
          <div className="min-w-0 flex-1 px-3 py-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-semibold text-slate-800 dark:text-slate-100">{statusTitle}</span>
              <span className={['shrink-0 font-mono tabular-nums', isError ? 'text-red-500' : isDone ? 'text-emerald-600 dark:text-emerald-400' : 'text-cyan-700 dark:text-cyan-300'].join(' ')}>{isError ? '失败' : `${percent}%`}</span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400">{compactLabel}</div>
            <div
              role="progressbar"
              aria-label="AI 分析总体进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={isError ? 'AI 分析失败' : `${compactLabel}，${percent}%`}
              className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
            >
              <div
                className={['h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none', isError ? 'bg-red-500' : isDone ? 'bg-emerald-500' : 'bg-cyan-600'].join(' ')}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
          <button
            type="button"
            data-testid="ai-analysis-progress-expand"
            aria-label="展开 AI 分析进度"
            aria-controls="ai-analysis-progress-panel"
            aria-expanded="false"
            title="展开进度"
            onClick={() => setIsMinimized(false)}
            className="flex min-h-11 min-w-11 items-center justify-center border-l border-slate-100 text-slate-500 transition-colors hover:bg-slate-50 hover:text-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:border-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-cyan-300"
          >
            <CollapseIcon expanded={false} />
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside
      id="ai-analysis-progress-panel"
      data-testid="ai-analysis-progress-panel"
      data-state="expanded"
      aria-label="AI 分析进度"
      className="fixed bottom-4 right-4 z-[60] w-80 rounded-lg border border-gray-200 bg-white p-4 shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{statusTitle}</span>
        <div className="flex items-center gap-1">
          {isError && <span className="text-xs text-red-500">失败</span>}
          <button
            type="button"
            data-testid="ai-analysis-progress-minimize"
            aria-label="最小化 AI 分析进度"
            aria-controls="ai-analysis-progress-panel"
            aria-expanded="true"
            title="最小化进度"
            onClick={() => setIsMinimized(true)}
            className="flex min-h-11 min-w-11 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 hover:text-cyan-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-cyan-300"
          >
            <CollapseIcon expanded />
          </button>
        </div>
      </div>
      <ul className="space-y-2">
        {STEPS.map((s, i) => {
          const isDone = i < currentIdx || (aiProgress.step === 'done' && i === STEPS.length - 1)
          const isActive = i === currentIdx && aiProgress.step !== 'done'
          const isCurrent = s.key === 'fetching' && isActive
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span className={[
                'w-4 h-4 rounded-full flex items-center justify-center text-xs shrink-0',
                isDone ? 'bg-green-500 text-white' :
                isError && i === currentIdx ? 'bg-red-500 text-white' :
                isActive ? 'bg-blue-500 text-white' :
                'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500'
              ].join(' ')}>
                {isDone ? '✓' : isError && i === currentIdx ? '✗' : i + 1}
              </span>
              <span className={[
                'text-xs',
                isDone ? 'text-gray-500 dark:text-gray-400 dark:text-gray-500' :
                isActive || (isError && i === currentIdx) ? 'text-gray-900 dark:text-gray-100 font-medium' :
                'text-gray-400 dark:text-gray-500'
              ].join(' ')}>
                {s.label}
                {isCurrent && aiProgress.current != null && aiProgress.total != null && (
                  <span className="ml-1 text-gray-400 dark:text-gray-500">
                    ({aiProgress.current}/{aiProgress.total})
                  </span>
                )}
                {s.key === 'fetching' && isActive && aiProgress.current == null && (
                  <span className="ml-1 text-blue-400">…</span>
                )}
                {s.key !== 'fetching' && isActive && (
                  <span className="ml-1 text-blue-400">…</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {(aiProgress.usages?.round1 || aiProgress.usages?.candidateRecovery || aiProgress.usages?.round2) && (
        <div className="mt-3 space-y-1.5">
          <UsageRow label="第一轮用量" usage={aiProgress.usages.round1} />
          <UsageRow label="标的映射用量" usage={aiProgress.usages.candidateRecovery} />
          <UsageRow label="第二轮用量" usage={aiProgress.usages.round2} />
        </div>
      )}
    </aside>
  )
}
