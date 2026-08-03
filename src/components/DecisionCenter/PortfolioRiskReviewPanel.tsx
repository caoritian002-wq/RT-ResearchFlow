import type { DecisionSignalItem } from './SignalCard'
import { formatCostPrice, formatReviewDate, type DecisionPortfolioRiskReviewData } from './decisionReviewStatsModel'

interface PortfolioRiskReviewPanelProps {
  data: DecisionPortfolioRiskReviewData | null
  loading: boolean
  error: string | null
  rangeDays: number
  onRangeChange: (rangeDays: number) => void
  onReload: () => void
  onLifecycle: (signal: DecisionSignalItem) => void
  onNavigateStock: (signal: DecisionSignalItem) => void
}

const RANGE_OPTIONS = [7, 30, 90]

export function PortfolioRiskReviewPanel({ data, loading, error, rangeDays, onRangeChange, onReload, onLifecycle, onNavigateStock }: PortfolioRiskReviewPanelProps) {
  return (
    <section data-testid="decision-portfolio-risk-review" className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-extrabold text-gray-900 dark:text-gray-100">持仓风险复盘</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400">聚焦持仓信号、成本价缺口和未收口风险</p>
        </div>
        <button type="button" onClick={onReload} disabled={loading} className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
          {loading ? '加载中' : '刷新'}
        </button>
      </div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {RANGE_OPTIONS.map(option => (
          <button key={option} type="button" onClick={() => onRangeChange(option)} className={`rounded border px-2 py-1 text-xs ${rangeDays === option ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'}`}>近 {option} 天</button>
        ))}
      </div>
      {error && <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
      {!error && (
        <>
          <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4">
            <Metric label="持仓数" value={data?.totalPortfolio ?? 0} />
            <Metric label="缺成本价" value={data?.missingCostPrice ?? 0} />
            <Metric label="有风险信号" value={data?.withRiskSignals ?? 0} />
            <Metric label="未收口风险" value={data?.unresolvedRiskSignals ?? 0} />
          </div>
          <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {(data?.items.length ?? 0) === 0 ? (
              <div className="rounded border border-dashed border-gray-200 px-2 py-4 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">暂无持仓风险样本</div>
            ) : data!.items.map(item => (
              <article key={item.tsCode} className="rounded border border-gray-100 px-2 py-1.5 dark:border-gray-800">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100">{item.stockName || item.tsCode}</div>
                    <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">成本 {formatCostPrice(item.costPrice)} · 风险 {item.riskSignals} · 未收口 {item.unresolvedSignals} · 重复 {item.repeatedSignals}</div>
                  </div>
                  {item.latestSignal && <span className="shrink-0 text-[11px] text-gray-400 dark:text-gray-500">最近 {formatReviewDate(item.latestSignal.signalTime)}</span>}
                </div>
                {item.latestSignal && <p className="mt-1 line-clamp-1 text-xs text-gray-600 dark:text-gray-300">{item.latestSignal.title}</p>}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {item.latestSignal && <button type="button" onClick={() => onLifecycle(item.latestSignal!)} className="text-[11px] text-blue-600 hover:underline dark:text-blue-400">事件明细</button>}
                  {item.latestSignal && <button type="button" onClick={() => onNavigateStock(item.latestSignal!)} className="text-[11px] text-blue-600 hover:underline dark:text-blue-400">走势图</button>}
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-100 px-2 py-1.5 dark:border-gray-800">
      <div className="text-[11px] text-gray-500 dark:text-gray-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-gray-900 dark:text-gray-100">{value}</div>
    </div>
  )
}