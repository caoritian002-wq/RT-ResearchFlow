import type { DecisionCenterViewMode } from '../../store/appStore'

interface SignalFiltersProps {
  status: string
  type: string
  source: string
  portfolioOnly: boolean
  minPriority: number
  viewMode: DecisionCenterViewMode
  onStatusChange: (value: string) => void
  onTypeChange: (value: string) => void
  onSourceChange: (value: string) => void
  onPortfolioOnlyChange: (value: boolean) => void
  onMinPriorityChange: (value: number) => void
  onViewModeChange: (value: DecisionCenterViewMode) => void
}

const SOURCE_OPTIONS = [
  ['all', '全部来源'],
  ['trend', '趋势'],
  ['short_term', '短线'],
  ['sector_flow', '板块资金'],
  ['news', '资讯'],
  ['ai', 'AI'],
]

const TYPE_OPTIONS = [
  ['all', '全部类型'],
  ['OPPORTUNITY', '机会'],
  ['ALERT', '预警'],
  ['RISK', '风险'],
  ['INFO', '信息'],
]

const STATUS_OPTIONS = [
  ['active', '待处理'],
  ['all', '全部'],
  ['NEW', '未读'],
  ['WATCHING', '关注中'],
  ['READ', '已读'],
]

export function SignalFilters({
  status,
  type,
  source,
  minPriority,
  viewMode,
  onStatusChange,
  onTypeChange,
  onSourceChange,
  onPortfolioOnlyChange,
  onMinPriorityChange,
  onViewModeChange,
}: SignalFiltersProps) {
  const minPriorityPct = ((minPriority - 1) / 4) * 100
  const filterButtonClass = 'rounded-md border px-2.5 py-1 text-xs font-medium leading-4 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-300 dark:focus:ring-slate-700'
  const activeButtonClass = 'border-slate-900 bg-slate-900 text-white shadow-sm dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950'
  const inactiveButtonClass = 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800'
  const viewActiveClass = 'border-cyan-700 bg-cyan-700 text-white shadow-sm dark:border-cyan-400 dark:bg-cyan-400 dark:text-slate-950'
  const compactSources = SOURCE_OPTIONS.filter(([value]) => value === 'all' || value === 'trend' || value === 'short_term' || value === 'news')
  const extraSourceOptions = SOURCE_OPTIONS.filter(([value]) => value !== 'all' && !compactSources.some(([compactValue]) => compactValue === value))
  const visibleStatusOptions = STATUS_OPTIONS.filter(([value]) => value !== 'READ')
  const isPortfolioView = viewMode === 'portfolio'

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="看板视图">
        <button
          type="button"
          data-testid="decision-view-mode-portfolio"
          aria-pressed={viewMode === 'portfolio'}
          onClick={() => onViewModeChange('portfolio')}
          className={`${filterButtonClass} ${isPortfolioView ? viewActiveClass : inactiveButtonClass}`}
        >组合</button>
        <button
          type="button"
          data-testid="decision-view-mode-market"
          aria-pressed={viewMode === 'market'}
          onClick={() => onViewModeChange('market')}
          className={`${filterButtonClass} ${!isPortfolioView ? viewActiveClass : inactiveButtonClass}`}
        >全部信号</button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleStatusOptions.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onStatusChange(value)}
            className={`${filterButtonClass} ${status === value ? activeButtonClass : inactiveButtonClass}`}
          >{label}</button>
        ))}
        <select
          value={type}
          onChange={(e) => {
            // 组合模式主切换已接管持仓范围, 类型下拉只改 signalType
            if (!isPortfolioView && e.target.value === 'portfolio') {
              onPortfolioOnlyChange(true)
              return
            }
            if (!isPortfolioView) onPortfolioOnlyChange(false)
            onTypeChange(e.target.value === 'portfolio' ? 'all' : e.target.value)
          }}
          className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none transition-colors hover:bg-slate-50 focus:border-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="类型筛选"
        >
          <option value="all">全部类型</option>
          {TYPE_OPTIONS.filter(([value]) => value !== 'all').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {compactSources.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => onSourceChange(value)}
            className={`${filterButtonClass} ${source === value ? activeButtonClass : inactiveButtonClass}`}
          >{label}</button>
        ))}
        <select
          value={extraSourceOptions.some(([value]) => value === source) ? source : 'all'}
          onChange={(e) => onSourceChange(e.target.value)}
          className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none transition-colors hover:bg-slate-50 focus:border-slate-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label="更多来源"
        >
          <option value="all">更多来源</option>
          {extraSourceOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      <label className="grid grid-cols-[64px_minmax(0,1fr)_36px] items-center gap-2 pt-0.5 text-xs text-slate-600 dark:text-slate-300">
        <span className="shrink-0">最低优先级</span>
        <span className="relative flex h-6 min-w-0 items-center">
          <span className="pointer-events-none absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-slate-200 dark:bg-slate-700" />
          <span className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-gradient-to-r from-amber-500 to-orange-500" style={{ width: `${minPriorityPct}%` }} />
          <input
            data-testid="decision-min-priority-filter"
            type="range"
            min={1}
            max={5}
            value={minPriority}
            onChange={(e) => onMinPriorityChange(Number(e.target.value))}
            className="decision-priority-range relative z-10 h-6 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-1 dark:focus-visible:ring-amber-600 dark:focus-visible:ring-offset-slate-950"
          />
        </span>
        <span className="text-right font-semibold tabular-nums text-slate-700 dark:text-slate-200">P{minPriority}+</span>
      </label>
    </div>
  )
}
