import { buildLocalTrendSummary, type LocalTrendFactTone, type LocalTrendSummaryStatus } from './localTrendSummary'
import { formatTrendDate } from './TrendWorkbenchUi'
import type { TrendWorkbenchItem } from './trendWorkbenchTypes'

const STATUS_META: Record<LocalTrendSummaryStatus, { label: string; className: string }> = {
  ready: { label: '事实完整', className: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300' },
  degraded: { label: '部分维度', className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300' },
  insufficient: { label: '证据不足', className: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300' },
}

export function LocalTrendSummaryPanel({ item }: { item: TrendWorkbenchItem }) {
  const summary = buildLocalTrendSummary(item)
  const status = STATUS_META[summary.status]

  return (
    <div data-testid={`local-trend-summary-${item.stockCode}`} data-summary-status={summary.status} data-headline={summary.headline} className="text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">本地规则</span>
        <span className={`rounded border px-2 py-0.5 font-medium ${status.className}`}>{status.label}</span>
        <span className="text-slate-400">截至 {formatTrendDate(summary.asOf)}{summary.validWeightPct == null ? '' : ` · 有效权重 ${summary.validWeightPct}%`}</span>
      </div>

      <div data-testid={`local-trend-headline-${item.stockCode}`} className="mt-2 text-sm font-semibold leading-5 text-slate-900 dark:text-slate-100">{summary.headline}</div>

      {summary.facts.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
          {summary.facts.map((fact) => (
            <div key={fact.key} className="flex min-w-0 items-baseline justify-between gap-2">
              <dt className="truncate text-slate-500 dark:text-slate-400">{fact.label}</dt>
              <dd className={`shrink-0 font-medium tabular-nums ${factTone(fact.tone)}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {summary.risks.length > 0 && (
        <div className="mt-3 border-l-2 border-amber-400 pl-3 text-amber-800 dark:border-amber-500 dark:text-amber-200">
          <div className="font-medium">风险事实</div>
          <div className="mt-1 leading-5">{summary.risks.join('；')}</div>
        </div>
      )}

      {summary.unknowns.length > 0 && (
        <div className="mt-3 border-t border-slate-200 pt-2 leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">
          未知项：{summary.unknowns.join('；')}
        </div>
      )}
    </div>
  )
}

function factTone(tone: LocalTrendFactTone): string {
  if (tone === 'positive') return 'text-rose-600 dark:text-rose-300'
  if (tone === 'negative') return 'text-emerald-600 dark:text-emerald-300'
  return 'text-slate-700 dark:text-slate-200'
}
