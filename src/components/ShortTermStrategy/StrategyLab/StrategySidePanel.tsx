import { StrategyInsightPanel } from './StrategyInsightPanel'
import { StrategyRunPlan } from './StrategyRunPlan'
import type { StrategyLabMatchRow, StrategyLabRunRow, StrategyLabRunSummary, StrategyLabView } from './strategyLabModel'

export type StrategySideTab = 'run' | 'insight'

interface StrategySidePanelProps {
  activeView: StrategyLabView
  latestRun?: StrategyLabRunRow | null
  latestSummary?: StrategyLabRunSummary | null
  match?: StrategyLabMatchRow | null
  activeTab: StrategySideTab
  onActiveTabChange: (tab: StrategySideTab) => void
  onCreateBacktest?: () => void
}

export function StrategySidePanel({ activeView, latestRun, latestSummary, match, activeTab, onActiveTabChange, onCreateBacktest }: StrategySidePanelProps): JSX.Element {
  const runCount = latestRun ? 1 : 0
  const insightCount = match ? 1 : 0

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">策略执行侧栏</h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">先确认运行路径, 再看命中证据。</p>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5 rounded-lg bg-slate-100 p-1 dark:bg-slate-950/60">
          <button
            type="button"
            onClick={() => onActiveTabChange('run')}
            className={
              'rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ' +
              (activeTab === 'run'
                ? 'bg-white text-slate-950 shadow-sm dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')
            }
          >
            运行计划 <span className="ml-1 tabular-nums opacity-70">{runCount}</span>
          </button>
          <button
            type="button"
            onClick={() => onActiveTabChange('insight')}
            className={
              'rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ' +
              (activeTab === 'insight'
                ? 'bg-white text-slate-950 shadow-sm dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200')
            }
          >
            命中研判 <span className="ml-1 tabular-nums opacity-70">{insightCount}</span>
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {activeTab === 'run' ? (
          <StrategyRunPlan activeView={activeView} latestRun={latestRun} latestSummary={latestSummary} onCreateBacktest={onCreateBacktest} />
        ) : (
          <StrategyInsightPanel activeView={activeView} match={match} />
        )}
      </div>
    </section>
  )
}