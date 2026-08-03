import { useMemo, useState } from 'react'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { useAppStore } from '../../store/appStore'
import {
  TrendPageHeader,
  WorkbenchError,
  formatSigned,
  formatTrendDate,
  valueTone,
} from './TrendWorkbenchUi'
import type { TrendWorkbenchEvent, TrendWorkbenchPageProps } from './trendWorkbenchTypes'

type KindFilter = 'all' | 'risk' | 'opportunity'
type ScopeFilter = 'all' | 'portfolio'
type StateFilter = 'all' | 'active' | 'recovered' | 'unknown'

const EVENT_META: Record<string, { label: string; referenceLabel: string; explanation: string }> = {
  BREAK_MA60: { label: '跌破 MA60', referenceLabel: 'MA60', explanation: '价格从均线上方跌到下方，趋势结构需要复核' },
  BREAK_HIGH20: { label: '突破 20 日高点', referenceLabel: '前 20 日高点', explanation: '价格突破触发前的 20 日区间高点' },
  STOP_LOSS_5PCT: { label: '单日跌幅超过 5%', referenceLabel: '前收盘', explanation: '相对前收盘的单日跌幅达到风险阈值' },
}

const STATE_LABEL: Record<TrendWorkbenchEvent['currentState'], string> = {
  active: '条件仍成立',
  recovered: '已恢复',
  unknown: '待补行情',
}

export function TrendAlerts({ snapshot, loading, errorMessage, onRefresh }: TrendWorkbenchPageProps) {
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<TrendWorkbenchEvent | null>(null)
  const navigateToStock = useAppStore((state) => state.navigateToStock)

  const events = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return [...(snapshot?.events ?? [])]
      .filter((event) => {
        if (kindFilter !== 'all' && event.kind !== kindFilter) return false
        if (scopeFilter === 'portfolio' && !event.isPortfolio) return false
        if (stateFilter !== 'all' && event.currentState !== stateFilter) return false
        if (!keyword) return true
        const label = EVENT_META[event.alertType]?.label ?? event.alertType
        return event.stockName.toLowerCase().includes(keyword)
          || event.stockCode.includes(keyword)
          || label.toLowerCase().includes(keyword)
      })
      .sort((left, right) => {
        const leftPriority = eventPriority(left)
        const rightPriority = eventPriority(right)
        if (leftPriority !== rightPriority) return leftPriority - rightPriority
        return right.alertDate.localeCompare(left.alertDate) || right.createdAt - left.createdAt
      })
  }, [kindFilter, query, scopeFilter, snapshot?.events, stateFilter])

  const counts = useMemo(() => {
    const all = snapshot?.events ?? []
    return {
      activeRisk: all.filter((event) => event.kind === 'risk' && event.currentState === 'active').length,
      activeOpportunity: all.filter((event) => event.kind === 'opportunity' && event.currentState === 'active').length,
      portfolio: all.filter((event) => event.isPortfolio).length,
      recovered: all.filter((event) => event.currentState === 'recovered').length,
    }
  }, [snapshot?.events])

  return (
    <div data-testid="trend-events" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TrendPageHeader
        title="趋势事件"
        subtitle="查看触发条件、事后表现和当前是否恢复，事件记录本身不等同于买卖指令"
        loading={loading}
        onRefresh={onRefresh}
        meta={snapshot && <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">近90日 · {snapshot.events.length}条</span>}
      />

      {errorMessage && <WorkbenchError message={errorMessage} onRetry={onRefresh} />}

      <div className="grid grid-cols-2 border-b border-slate-200 bg-white sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-950">
        <EventSummary label="持续风险" value={counts.activeRisk} tone="risk" />
        <EventSummary label="持续机会" value={counts.activeOpportunity} tone="opportunity" />
        <EventSummary label="持仓相关" value={counts.portfolio} tone="neutral" />
        <EventSummary label="已经恢复" value={counts.recovered} tone="neutral" />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-950 sm:px-5">
        <FilterGroup
          label="事件方向"
          value={kindFilter}
          onChange={(value) => setKindFilter(value as KindFilter)}
          options={[['all', '全部'], ['risk', '风险'], ['opportunity', '机会']]}
        />
        <FilterGroup
          label="股票范围"
          value={scopeFilter}
          onChange={(value) => setScopeFilter(value as ScopeFilter)}
          options={[['all', '全部股票'], ['portfolio', '只看持仓']]}
        />
        <FilterGroup
          label="当前状态"
          value={stateFilter}
          onChange={(value) => setStateFilter(value as StateFilter)}
          options={[['all', '全部状态'], ['active', '仍成立'], ['recovered', '已恢复'], ['unknown', '待补行情']]}
        />
        <label className="ml-auto flex min-h-11 min-w-[210px] items-center rounded-md border border-slate-300 bg-white px-3 focus-within:border-cyan-500 focus-within:ring-2 focus-within:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900">
          <span className="sr-only">搜索股票或事件</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索股票或事件" className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100" />
        </label>
      </div>

      {!snapshot && loading ? (
        <div className="space-y-2 p-5" aria-label="趋势事件加载中">{Array.from({ length: 7 }, (_, index) => <div key={index} className="h-14 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />)}</div>
      ) : events.length === 0 ? (
        <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">当前筛选下没有趋势事件</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">事件只在价格实际穿越阈值时产生，不会因持续位于阈值一侧而重复记录</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[940px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100/95 text-slate-500 backdrop-blur dark:bg-slate-900/95 dark:text-slate-400">
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="px-4 py-2 text-left font-medium">股票</th>
                <th className="px-3 py-2 text-left font-medium">事件</th>
                <th className="px-3 py-2 text-left font-medium">触发日期</th>
                <th className="px-3 py-2 text-right font-medium">触发价</th>
                <th className="px-3 py-2 text-right font-medium">参考阈值</th>
                <th className="px-3 py-2 text-right font-medium">当前价</th>
                <th className="px-3 py-2 text-right font-medium">事件后涨跌</th>
                <th className="px-4 py-2 text-left font-medium">当前状态</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event, index) => {
                const meta = EVENT_META[event.alertType] ?? { label: event.alertType, referenceLabel: '参考值', explanation: '历史趋势事件' }
                return (
                  <tr
                    key={`${event.id ?? index}-${event.tsCode}-${event.alertDate}`}
                    tabIndex={0}
                    onClick={() => setSelected(event)}
                    onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') setSelected(event) }}
                    className="cursor-pointer border-b border-slate-100 bg-white transition-colors motion-reduce:transition-none hover:bg-cyan-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:border-slate-900 dark:bg-slate-950 dark:hover:bg-cyan-950/20"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2"><span className="font-medium text-slate-900 dark:text-slate-100">{event.stockName}</span>{event.isPortfolio && <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">持仓</span>}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">{event.stockCode}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className={event.kind === 'risk' ? 'font-medium text-emerald-700 dark:text-emerald-300' : 'font-medium text-rose-700 dark:text-rose-300'}>{meta.label}</div>
                      <div className="mt-0.5 max-w-56 truncate text-[11px] text-slate-400" title={meta.explanation}>{meta.explanation}</div>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-slate-600 dark:text-slate-300">{formatTrendDate(event.alertDate)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">{formatPrice(event.triggerPrice)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="font-mono tabular-nums text-slate-800 dark:text-slate-200">{formatPrice(event.referencePrice)}</div>
                      <div className="mt-0.5 text-[10px] text-slate-400">{meta.referenceLabel}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">{formatPrice(event.currentPrice)}</td>
                    <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${valueTone(event.changeSinceTrigger)}`}>{formatSigned(event.changeSinceTrigger, '%')}</td>
                    <td className="px-4 py-2.5"><EventStateBadge state={event.currentState} kind={event.kind} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <StockKlineChipDrawer
          tsCode={selected.tsCode}
          stockName={selected.stockName}
          onClose={() => setSelected(null)}
          onNavigate={() => {
            navigateToStock(selected.stockCode, selected.stockName)
            setSelected(null)
          }}
        />
      )}
    </div>
  )
}

function eventPriority(event: TrendWorkbenchEvent): number {
  if (event.isPortfolio && event.kind === 'risk' && event.currentState === 'active') return 0
  if (event.kind === 'risk' && event.currentState === 'active') return 1
  if (event.kind === 'opportunity' && event.currentState === 'active') return 2
  if (event.currentState === 'unknown') return 3
  return 4
}

function FilterGroup({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <div className="flex items-center rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-800 dark:bg-slate-900" role="group" aria-label={label}>
      {options.map(([key, optionLabel]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)} className={`min-h-10 rounded px-2.5 text-xs font-medium transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${value === key ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}>{optionLabel}</button>
      ))}
    </div>
  )
}

function EventSummary({ label, value, tone }: { label: string; value: number; tone: 'risk' | 'opportunity' | 'neutral' }) {
  const toneClass = tone === 'risk' ? 'text-emerald-600 dark:text-emerald-300' : tone === 'opportunity' ? 'text-rose-600 dark:text-rose-300' : 'text-slate-900 dark:text-slate-100'
  return <div className="border-r border-slate-200 px-4 py-3 last:border-r-0 dark:border-slate-800 sm:px-5"><div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div><div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div></div>
}

function EventStateBadge({ state, kind }: { state: TrendWorkbenchEvent['currentState']; kind: TrendWorkbenchEvent['kind'] }) {
  const className = state === 'active'
    ? kind === 'risk'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
      : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300'
    : state === 'recovered'
      ? 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-300'
      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
  return <span className={`inline-flex rounded border px-2 py-1 text-[11px] font-medium ${className}`}>{STATE_LABEL[state]}</span>
}

function formatPrice(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(2)
}
