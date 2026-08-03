import { useState } from 'react'
import type { DecisionReviewSignalItem } from '../DecisionCenter/decisionReviewStatsModel'
import { formatReviewDate, sourceLabel, statusLabel, typeLabel } from '../DecisionCenter/decisionReviewStatsModel'
import type { DecisionSignalItem } from '../DecisionCenter/SignalCard'

interface StockSignalHistoryPanelProps {
  items: DecisionReviewSignalItem[]
  total: number
  loading: boolean
  error: string | null
  rangeDays: number
  onRangeChange: (rangeDays: number) => void
  onReload: () => void
  onLifecycle: (signal: DecisionSignalItem) => void
}

const RANGE_OPTIONS = [7, 30, 90]

export function StockSignalHistoryPanel({ items, total, loading, error, rangeDays, onRangeChange, onReload, onLifecycle }: StockSignalHistoryPanelProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <section data-testid="stock-signal-history" className="mb-1.5 shrink-0 rounded-md border border-gray-200 bg-white px-3 py-2 shadow-sm shadow-gray-100/50 dark:border-gray-700 dark:bg-gray-900 dark:shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">历史信号</h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">近 {rangeDays} 天 · 共 {total} 条{loading ? ' · 加载中' : ''}</span>
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-gray-500 dark:text-gray-400">同股线索回看默认收起, 避免挤压走势图。</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setExpanded(value => !value)} className="rounded border border-blue-200 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30">
            {expanded ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2">
          <div className="mb-2 flex flex-wrap items-center justify-end gap-1.5">
          {RANGE_OPTIONS.map(option => (
            <button key={option} type="button" onClick={() => onRangeChange(option)} className={`rounded border px-2 py-1 text-xs ${rangeDays === option ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'}`}>近 {option} 天</button>
          ))}
          <button type="button" onClick={onReload} disabled={loading} className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">{loading ? '加载中' : '刷新'}</button>
          </div>
          {error ? (
            <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">{error}</div>
          ) : items.length === 0 ? (
            <div className="rounded border border-dashed border-gray-200 px-3 py-3 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">近 {rangeDays} 天暂无同股历史信号</div>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-gray-500 dark:text-gray-400">展示最近 {items.length} 条</div>
              <div className="grid gap-2 lg:grid-cols-2">
                {items.map(item => (
                  <article key={item.id} className="rounded border border-gray-100 px-2 py-1.5 dark:border-gray-800">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">{item.title}</div>
                        <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">{formatReviewDate(item.signalTime)} · {sourceLabel(item.sourceModule)} · {typeLabel(item.signalType)} · {statusLabel(item.status)}</div>
                      </div>
                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">P{item.priority}</span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-gray-600 dark:text-gray-300">{item.summary}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => onLifecycle(item)} className="text-[11px] text-blue-600 hover:underline dark:text-blue-400">事件明细</button>
                      {(item.occurrenceCount ?? 1) > 1 && <span className="text-[11px] text-amber-600 dark:text-amber-300">触发 {item.occurrenceCount} 次</span>}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}