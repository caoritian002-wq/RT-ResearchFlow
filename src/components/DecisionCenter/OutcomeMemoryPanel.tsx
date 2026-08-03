import {
  formatJudgmentTime,
  formatOutcomeReturn,
  judgmentTagLabel,
  outcomeLabelText,
  type DecisionOutcomeMemoryData,
  type OutcomeLabel,
} from './decisionOutcomeMemoryModel'

interface OutcomeMemoryPanelProps {
  data: DecisionOutcomeMemoryData | null
  loading: boolean
  error: string | null
  onReload: () => void
  onNavigateStock?: (tsCode: string, stockName?: string | null) => void
}

function toneClass(label: OutcomeLabel): string {
  if (label === 'aligned') return 'text-emerald-700 dark:text-emerald-300'
  if (label === 'misaligned') return 'text-red-600 dark:text-red-300'
  if (label === 'mixed') return 'text-amber-700 dark:text-amber-300'
  return 'text-slate-500 dark:text-slate-400'
}

/**
 * FR-234: 事后对照迷你面板, 挂在复盘侧栏。
 */
export function OutcomeMemoryPanel({
  data,
  loading,
  error,
  onReload,
  onNavigateStock,
}: OutcomeMemoryPanelProps) {
  const samples = data?.samples?.slice(0, 8) ?? []

  return (
    <div data-testid="decision-outcome-memory" className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">事后对照</div>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
            本地日线窗口对照 judgment, 非胜率承诺。
          </p>
        </div>
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="shrink-0 rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {loading ? '加载中' : '刷新'}
        </button>
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {data && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-[11px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-300">
          <div>
            近 {data.rangeDays} 日 · 窗口 T+{data.horizonDays} · 样本 {data.sampleSize} · 可评估 {data.evaluableSize}
          </div>
          <div className={`mt-1 ${data.bias.insufficientSample ? 'text-amber-700 dark:text-amber-300' : ''}`}>
            {data.bias.hint}
          </div>
        </div>
      )}

      {data && data.bias.byTag.length > 0 && (
        <div className="space-y-1">
          {data.bias.byTag.map((row) => (
            <div
              key={row.tag}
              className="flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1 text-[11px] dark:border-slate-800"
            >
              <span className="font-medium text-slate-700 dark:text-slate-200">{judgmentTagLabel(row.tag)}</span>
              <span className="tabular-nums text-slate-500 dark:text-slate-400">
                一致 {row.aligned} · 相反 {row.misaligned} · 混合 {row.mixed} · 不可评 {row.blocked}
              </span>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && samples.length === 0 && (
        <div className="rounded border border-dashed border-slate-200 px-2 py-3 text-center text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
          暂无带 [judgment:tag] 的结案样本。先在按股研判里留下结论。
        </div>
      )}

      <div className="space-y-1.5">
        {samples.map((item) => {
          const name = item.stockName || item.tsCode
          const clickable = !!onNavigateStock
          const body = (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-slate-900 dark:text-slate-100">
                  {name} · {judgmentTagLabel(item.tag)}
                </span>
                <span className={`shrink-0 tabular-nums ${toneClass(item.outcomeLabel)}`}>
                  {outcomeLabelText(item.outcomeLabel)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
                <span className="truncate">{formatJudgmentTime(item.judgmentAt)} · {item.title}</span>
                <span className="shrink-0 tabular-nums">{formatOutcomeReturn(item.forwardReturnPct)}</span>
              </div>
              <div className="mt-0.5 truncate text-slate-400 dark:text-slate-500">{item.outcomeReason}</div>
            </>
          )
          if (clickable) {
            return (
              <button
                key={`${item.signalId}-${item.tag}`}
                type="button"
                onClick={() => onNavigateStock?.(item.tsCode, item.stockName)}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left text-[11px] hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:bg-slate-900"
              >
                {body}
              </button>
            )
          }
          return (
            <div
              key={`${item.signalId}-${item.tag}`}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] dark:border-slate-800 dark:bg-slate-950/40"
            >
              {body}
            </div>
          )
        })}
      </div>
    </div>
  )
}
