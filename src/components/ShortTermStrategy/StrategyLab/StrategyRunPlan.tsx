import type { StrategyLabView } from './strategyLabModel'
import type { StrategyLabRunRow, StrategyLabRunSummary } from './strategyLabModel'
import { buildRunPlan, viewTitle } from './strategyLabModel'

interface StrategyRunPlanProps {
  activeView: StrategyLabView
  latestRun?: StrategyLabRunRow | null
  latestSummary?: StrategyLabRunSummary | null
  onCreateBacktest?: () => void
}

function statusText(status?: StrategyLabRunRow['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'running') return '运行中'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'queued') return '排队中'
  return '未运行'
}

export function StrategyRunPlan({ activeView, latestRun, latestSummary, onCreateBacktest }: StrategyRunPlanProps): JSX.Element {
  const items = buildRunPlan(activeView)
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-300">运行计划</p>
          <h3 className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{viewTitle(activeView)}</h3>
        </div>
        <span className="rounded bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300">统一入口</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">时间范围</p>
          <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-100">{latestSummary?.dateStart && latestSummary?.dateEnd ? `${latestSummary.dateStart} - ${latestSummary.dateEnd}` : '近 20 个交易日'}</p>
        </div>
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">运行状态</p>
          <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-100">{statusText(latestRun?.status)}</p>
        </div>
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">股票池</p>
          <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-100">{latestSummary?.totalStocks ?? '全市场 + 持仓'}</p>
        </div>
        <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">补拉预算</p>
          <p className="mt-1 text-xs font-semibold text-slate-900 dark:text-slate-100">{latestRun?.backtestRunId ? `回测 #${latestRun.backtestRunId}` : '120 缺口'}</p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((item) => (
          <div key={item.label} className="rounded border border-slate-100 bg-slate-50 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-950/50">
            <p className="text-[11px] text-slate-500 dark:text-slate-400">{item.label}</p>
            <p className={
              'mt-1 text-xs font-semibold leading-5 ' +
              (item.tone === 'success'
                ? 'text-emerald-700 dark:text-emerald-300'
                : item.tone === 'warning'
                  ? 'text-amber-700 dark:text-amber-300'
                  : 'text-slate-800 dark:text-slate-100')
            }>
              {item.value}
            </p>
          </div>
        ))}
      </div>
      <button type="button" onClick={onCreateBacktest} disabled={!onCreateBacktest || !latestRun || latestRun.status !== 'completed'} className="mt-3 min-h-9 w-full rounded-md bg-blue-700 px-3 text-xs font-semibold text-white hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700">
        生成策略回测
      </button>
    </div>
  )
}