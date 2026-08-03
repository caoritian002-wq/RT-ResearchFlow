export type BacktestCredibilityStatus = 'reliable' | 'degraded' | 'blocked'
export type BacktestCredibilityConclusion = 'unavailable' | 'exploratory' | 'comparable'

export interface BacktestCredibilityAssessmentView {
  version: 1
  assessedAt: number
  conclusion: BacktestCredibilityConclusion
  summary: string
  dataQualityFingerprint: string
  gates: Array<{
    key: 'dataFoundation' | 'temporalIntegrity' | 'executionRealism' | 'sampleAdequacy' | 'stabilityValidation'
    title: string
    status: BacktestCredibilityStatus
    summary: string
    details: string[]
  }>
  sample: {
    totalSignals: number
    validSignals: number
    signalDayCount: number
    missingRate: number | null
  }
  periodSlices: Array<{
    label: '前半区间' | '后半区间'
    sampleCount: number
    avgReturn: number | null
    winRate: number | null
  }>
}

const STATUS_META: Record<BacktestCredibilityStatus, { label: string; dot: string; text: string }> = {
  reliable: { label: '可用', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300' },
  degraded: { label: '需注意', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300' },
  blocked: { label: '阻断', dot: 'bg-red-500', text: 'text-red-700 dark:text-red-300' },
}

const CONCLUSION_META: Record<BacktestCredibilityConclusion, { label: string; className: string }> = {
  unavailable: { label: '暂不可判断', className: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-200' },
  exploratory: { label: '探索性参考', className: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/25 dark:text-amber-200' },
  comparable: { label: '同口径可比较', className: 'border-cyan-200 bg-cyan-50 text-cyan-900 dark:border-cyan-900/70 dark:bg-cyan-950/25 dark:text-cyan-200' },
}

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '不可统计'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function BacktestCredibilityBand({
  assessment,
  testId = 'backtest-credibility',
}: {
  assessment: BacktestCredibilityAssessmentView
  testId?: string
}): JSX.Element {
  const conclusion = CONCLUSION_META[assessment.conclusion]
  return (
    <section data-testid={testId} aria-label="回测可信度" className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">本次结果可信度</h3>
            <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${conclusion.className}`}>{conclusion.label}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{assessment.summary}</p>
        </div>
        <div className="shrink-0 text-right text-[11px] leading-5 text-slate-500 dark:text-slate-400">
          <div>{assessment.sample.validSignals} / {assessment.sample.totalSignals} 笔有效</div>
          <div>{assessment.sample.signalDayCount} 个信号日</div>
        </div>
      </div>
      <div className="grid grid-cols-2 border-t border-slate-200 sm:grid-cols-3 xl:grid-cols-5 dark:border-slate-800">
        {assessment.gates.map(gate => {
          const meta = STATUS_META[gate.status]
          return (
            <div key={gate.key} title={gate.details.join('\n')} className="min-w-0 border-b border-r border-slate-200 px-3 py-2.5 last:border-r-0 xl:border-b-0 dark:border-slate-800">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">{gate.title}</span>
                <span className={`ml-auto shrink-0 text-[10px] ${meta.text}`}>{meta.label}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{gate.summary}</p>
            </div>
          )
        })}
      </div>
      {assessment.periodSlices.some(slice => slice.sampleCount > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
          {assessment.periodSlices.map(slice => (
            <span key={slice.label}>{slice.label} {slice.sampleCount} 笔 · 平均 {fmtPct(slice.avgReturn)}</span>
          ))}
        </div>
      )}
    </section>
  )
}
