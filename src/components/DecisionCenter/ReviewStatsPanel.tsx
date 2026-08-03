import { useMemo } from 'react'
import type { DecisionSignalItem } from './SignalCard'
import {
  buildDecisionReviewStatsModel,
  formatReviewDate,
  noiseLevelLabel,
  sourceLabel,
  statusLabel,
  typeLabel,
  type DecisionReviewStatsData,
  type DecisionReviewSignalItem,
} from './decisionReviewStatsModel'

interface ReviewStatsPanelProps {
  data: DecisionReviewStatsData | null
  loading: boolean
  error: string | null
  rangeDays: number
  onRangeChange: (rangeDays: number) => void
  onReload: () => void
  onLifecycle: (signal: DecisionSignalItem) => void
  onNavigateStock: (signal: DecisionSignalItem) => void
}

const RANGE_OPTIONS = [7, 30, 90]

export function ReviewStatsPanel({ data, loading, error, rangeDays, onRangeChange, onReload, onLifecycle, onNavigateStock }: ReviewStatsPanelProps) {
  const model = useMemo(() => buildDecisionReviewStatsModel(data), [data])

  return (
    <section data-testid="decision-review-stats" className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
      <div className="border-b border-gray-100 p-3 dark:border-gray-800">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-extrabold text-gray-900 dark:text-gray-100">复盘提示</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">只看历史处理结构, 不计算交易收益</p>
        </div>
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >{loading ? '加载中' : '刷新'}</button>
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {RANGE_OPTIONS.map(option => (
          <button
            key={option}
            type="button"
            onClick={() => onRangeChange(option)}
            className={`rounded border px-2 py-1 text-xs ${rangeDays === option ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'}`}
          >近 {option} 天</button>
        ))}
      </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {!error && (
        <>
          <div className="rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-600 dark:bg-slate-950/40 dark:text-slate-300">{model.sampleHint}</div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {model.summaryCards.map(card => <MiniCard key={card.label} label={card.label} value={card.value} />)}
          </div>
          <DistributionGroup title="来源分布" items={model.sourceDistribution} />
          <DistributionGroup title="类型分布" items={model.typeDistribution} />
          <DistributionGroup title="处置结果" items={model.resolutionDistribution} emptyText="暂无处置结果" />
          <DistributionGroup title="优先级" items={model.priorityDistribution} />
          <NoiseSuggestionList items={data?.noiseSuggestions ?? []} />
          <ReviewList title="待复盘" items={data?.pendingReview ?? []} onLifecycle={onLifecycle} onNavigateStock={onNavigateStock} />
          <ReviewList title="重复触发" items={data?.repeatedSignals ?? []} onLifecycle={onLifecycle} onNavigateStock={onNavigateStock} showOccurrence />
        </>
      )}
      </div>
    </section>
  )
}

function NoiseSuggestionList({ items }: { items: NonNullable<DecisionReviewStatsData['noiseSuggestions']> }) {
  return (
    <div data-testid="decision-noise-insights" className="mt-3">
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-gray-700 dark:text-gray-200">
        <span>降噪建议</span>
        <span className="text-gray-400 dark:text-gray-500">{items.length} 条</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded border border-dashed border-gray-200 px-2 py-3 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">暂无明显噪声模式</div>
      ) : (
        <div className="space-y-1.5">
          {items.slice(0, 3).map(item => (
            <div key={item.id} className="rounded border border-amber-100 bg-amber-50 px-2 py-1.5 text-xs dark:border-amber-900/60 dark:bg-amber-950/20">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-amber-800 dark:text-amber-200">{item.title}</span>
                <span className="shrink-0 rounded bg-white/70 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-black/20 dark:text-amber-300">{noiseLevelLabel(item.level)}</span>
              </div>
              <p className="mt-1 text-amber-700 dark:text-amber-300">{item.summary}</p>
              <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{item.metric}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MiniCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-100 px-2 py-1.5 dark:border-gray-800">
      <div className="text-[11px] text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
}

function DistributionGroup({ title, items, emptyText = '暂无数据' }: { title: string; items: Array<{ label: string; value: number }>; emptyText?: string }) {
  const total = items.reduce((sum, item) => sum + item.value, 0)
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-medium text-gray-700 dark:text-gray-200">{title}</div>
      {items.length === 0 ? <div className="text-xs text-gray-400 dark:text-gray-500">{emptyText}</div> : (
        <div className="space-y-1">
          {items.slice(0, 5).map(item => {
            const width = total > 0 ? Math.max(8, Math.round((item.value / total) * 100)) : 0
            return (
              <div key={item.label} className="grid grid-cols-[64px_minmax(0,1fr)_28px] items-center gap-2 text-xs">
                <span className="truncate text-gray-500 dark:text-gray-400">{item.label}</span>
                <span className="h-1.5 overflow-hidden rounded bg-gray-100 dark:bg-gray-800"><span className="block h-full rounded bg-blue-500" style={{ width: `${width}%` }} /></span>
                <span className="text-right text-gray-600 dark:text-gray-300">{item.value}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ReviewList({ title, items, onLifecycle, onNavigateStock, showOccurrence = false }: { title: string; items: DecisionReviewSignalItem[]; onLifecycle: (signal: DecisionSignalItem) => void; onNavigateStock: (signal: DecisionSignalItem) => void; showOccurrence?: boolean }) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-xs font-medium text-gray-700 dark:text-gray-200">
        <span>{title}</span>
        <span className="text-gray-400 dark:text-gray-500">{items.length} 条</span>
      </div>
      {items.length === 0 ? <div className="rounded border border-dashed border-gray-200 px-2 py-3 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">暂无{title}项</div> : (
        <div className="space-y-1.5">
          {items.slice(0, 5).map(item => (
            <div key={item.id} className="rounded border border-gray-100 px-2 py-1.5 dark:border-gray-800">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">{item.title}</div>
                  <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {sourceLabel(item.sourceModule)} · {statusLabel(item.status)} · {formatReviewDate(item.lastSeenAt ?? item.signalTime)}
                    {showOccurrence && ` · ${item.occurrenceCount} 次`}
                  </div>
                </div>
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">P{item.priority}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <button type="button" onClick={() => onLifecycle(item)} className="text-[11px] text-blue-600 hover:underline dark:text-blue-400">事件明细</button>
                {item.tsCode && <button type="button" onClick={() => onNavigateStock(item)} className="text-[11px] text-blue-600 hover:underline dark:text-blue-400">走势图</button>}
                <span className="text-[11px] text-gray-400 dark:text-gray-500">{typeLabel(item.signalType)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
