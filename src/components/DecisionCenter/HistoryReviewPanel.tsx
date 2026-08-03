import type { DecisionSignalItem } from './SignalCard'
import { formatFullReviewDate, sourceLabel, statusLabel, typeLabel, type DecisionHistorySignalsData } from './decisionReviewStatsModel'
import { getBeijingDateValue, ResearchDatePicker } from '../IndustryResearch/ResearchDecisionControls'

interface HistoryReviewPanelProps {
  data: DecisionHistorySignalsData | null
  loading: boolean
  error: string | null
  rangeDays: number
  onRangeChange: (rangeDays: number) => void
  tradeDate: string
  onTradeDateChange: (tradeDate: string) => void
  portfolioOnly: boolean
  onPortfolioOnlyChange: (value: boolean) => void
  onReload: () => void
  onLifecycle: (signal: DecisionSignalItem) => void
  onNavigateStock: (signal: DecisionSignalItem) => void
}

const RANGE_OPTIONS = [7, 30, 90]

export function HistoryReviewPanel({ data, loading, error, rangeDays, onRangeChange, tradeDate, onTradeDateChange, portfolioOnly, onPortfolioOnlyChange, onReload, onLifecycle, onNavigateStock }: HistoryReviewPanelProps) {
  const availableDates = data?.availableDates ?? []
  const dateValue = tradeDate || data?.selectedTradeDate || availableDates[0] || getBeijingDateValue()
  return (
    <section data-testid="decision-history-review" className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">历史信号回看</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">按日期回看信号脉络, 支持聚焦持仓</p>
        </div>
        <button type="button" onClick={onReload} disabled={loading} className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
          {loading ? '加载中' : '刷新'}
        </button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {RANGE_OPTIONS.map(option => (
          <button key={option} type="button" onClick={() => onRangeChange(option)} className={`rounded border px-2 py-1 text-xs ${rangeDays === option ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'}`}>近 {option} 天</button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={portfolioOnly} onChange={(e) => onPortfolioOnlyChange(e.target.checked)} className="rounded" />
          只看持仓
        </label>
      </div>
      <div className="mb-2 grid grid-cols-[minmax(0,180px)_minmax(0,1fr)] items-center gap-2">
        <ResearchDatePicker
          value={dateValue}
          testId="decision-history-trade-date"
          max={getBeijingDateValue()}
          ariaLabel="历史信号日期"
          triggerAriaLabel="打开历史信号日期选择器"
          dialogLabel="选择要回看的信号日期"
          footerHint="选择无信号日期时会保留空结果，不会改写历史事实"
          quickSelectLabel="今天"
          onChange={onTradeDateChange}
        />
        <p className="min-w-0 text-xs text-gray-500 dark:text-gray-400">
          {availableDates.length > 0
            ? `近 ${rangeDays} 天共有 ${availableDates.length} 个信号日，最近为 ${availableDates[0]}`
            : `近 ${rangeDays} 天没有可回看的信号日`}
        </p>
      </div>
      {error && <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
      {!error && (
        <div className="space-y-1.5">
          <div className="text-xs text-gray-500 dark:text-gray-400">{dateValue} 共 {data?.total ?? 0} 条，当前展示 {data?.items.length ?? 0} 条</div>
          {(data?.items.length ?? 0) === 0 ? (
            <div className="rounded border border-dashed border-gray-200 px-2 py-4 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">暂无历史信号</div>
          ) : data!.items.map(item => (
            <article key={item.id} className="rounded border border-gray-100 px-2 py-1.5 dark:border-gray-800">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">{item.title}</div>
                  <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {formatFullReviewDate(item.signalTime)} · {sourceLabel(item.sourceModule)} · {typeLabel(item.signalType)} · {statusLabel(item.status)}
                  </div>
                </div>
                <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">P{item.priority}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-gray-600 dark:text-gray-300">{item.summary}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <button type="button" onClick={() => onLifecycle(item)} className="text-[11px] text-blue-600 hover:underline dark:text-blue-400">事件明细</button>
                {item.tsCode && <button type="button" onClick={() => onNavigateStock(item)} className="text-[11px] text-blue-600 hover:underline dark:text-blue-400">走势图</button>}
                {(item.occurrenceCount ?? 1) > 1 && <span className="text-[11px] text-amber-600 dark:text-amber-300">触发 {item.occurrenceCount} 次</span>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
