import { useMemo, useState } from 'react'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { useAppStore } from '../../store/appStore'
import {
  ScoreSparkline,
  TrendBenchmarkMeta,
  TrendPageHeader,
  TrendStateBadge,
  WorkbenchError,
  formatSigned,
  formatTrendDate,
  valueTone,
} from './TrendWorkbenchUi'
import { buildLocalTrendSummary, type LocalTrendSummaryStatus } from './localTrendSummary'
import type { TrendState, TrendWorkbenchItem, TrendWorkbenchPageProps } from './trendWorkbenchTypes'

type RadarFilter = 'all' | 'portfolio' | 'strengthening' | 'weakening' | 'insufficient'

const FILTERS: Array<{ key: RadarFilter; label: string }> = [
  { key: 'all', label: '全部观察' },
  { key: 'portfolio', label: '我的持仓' },
  { key: 'strengthening', label: '正在转强' },
  { key: 'weakening', label: '走弱与破位' },
  { key: 'insufficient', label: '数据待补' },
]

const STATE_ORDER: Record<TrendState, number> = {
  broken: 0,
  weakening: 1,
  strengthening: 2,
  strong: 3,
  stable: 4,
  insufficient: 5,
}

export function TrendDashboard({ snapshot, loading, errorMessage, onRefresh }: TrendWorkbenchPageProps) {
  const [filter, setFilter] = useState<RadarFilter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<TrendWorkbenchItem | null>(null)
  const navigateToStock = useAppStore((state) => state.navigateToStock)

  const items = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return [...(snapshot?.items ?? [])]
      .filter((item) => {
        if (filter === 'portfolio' && !item.isPortfolio) return false
        if (filter === 'strengthening' && item.trendState !== 'strengthening') return false
        if (filter === 'weakening' && !['weakening', 'broken'].includes(item.trendState)) return false
        if (filter === 'insufficient' && item.dataCoverage.state === 'ready') return false
        if (!keyword) return true
        return item.stockName.toLowerCase().includes(keyword)
          || item.stockCode.includes(keyword)
          || item.categories.some((value) => value.toLowerCase().includes(keyword))
      })
      .sort((left, right) => {
        const state = STATE_ORDER[left.trendState] - STATE_ORDER[right.trendState]
        if (state !== 0) return state
        const delta = (right.scoreDelta5d ?? -999) - (left.scoreDelta5d ?? -999)
        if (delta !== 0) return delta
        return (right.totalScore ?? -1) - (left.totalScore ?? -1)
      })
  }, [filter, query, snapshot?.items])

  const counts = useMemo(() => {
    const all = snapshot?.items ?? []
    return {
      strengthening: all.filter((item) => item.trendState === 'strengthening').length,
      weakening: all.filter((item) => ['weakening', 'broken'].includes(item.trendState)).length,
      strong: all.filter((item) => item.trendState === 'strong').length,
      missing: all.filter((item) => item.dataCoverage.state !== 'ready').length,
    }
  }, [snapshot?.items])

  return (
    <div data-testid="trend-radar" className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TrendPageHeader
        title="趋势雷达"
        subtitle="关注评分变化、相对强度和结构破坏，而不是只看某一天的静态分数"
        loading={loading}
        onRefresh={onRefresh}
        meta={snapshot && (
          <span className="flex flex-wrap items-center gap-2 text-xs tabular-nums text-slate-500 dark:text-slate-400">
            <span>行情至 {formatTrendDate(snapshot.dataHealth.latestTradeDate)} · {snapshot.dataHealth.total}只</span>
            {snapshot.dataHealth.benchmark && <TrendBenchmarkMeta health={snapshot.dataHealth.benchmark} />}
          </span>
        )}
      />

      {errorMessage && <WorkbenchError message={errorMessage} onRetry={onRefresh} />}

      <div className="grid grid-cols-2 border-b border-slate-200 bg-white sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-950">
        <RadarSummary label="正在转强" value={counts.strengthening} tone="positive" />
        <RadarSummary label="走弱或破位" value={counts.weakening} tone={counts.weakening > 0 ? 'risk' : 'neutral'} />
        <RadarSummary label="保持强势" value={counts.strong} tone="neutral" />
        <RadarSummary label="数据待补" value={counts.missing} tone={counts.missing > 0 ? 'warning' : 'neutral'} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-950 sm:px-5">
        <div className="flex max-w-full gap-1 overflow-x-auto" role="tablist" aria-label="趋势雷达筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={filter === item.key}
              onClick={() => setFilter(item.key)}
              className={`min-h-11 shrink-0 rounded-md px-3 text-sm transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                filter === item.key
                  ? 'bg-slate-900 text-white dark:bg-cyan-500 dark:text-slate-950'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >{item.label}</button>
          ))}
        </div>
        <label className="ml-auto flex min-h-11 min-w-[220px] items-center rounded-md border border-slate-300 bg-white px-3 focus-within:border-cyan-500 focus-within:ring-2 focus-within:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900">
          <span className="sr-only">搜索股票、代码或分类</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索股票、代码或分类"
            className="w-full bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
        </label>
      </div>

      {!snapshot && loading ? (
        <RadarSkeleton />
      ) : items.length === 0 ? (
        <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <div className="text-sm font-medium text-slate-700 dark:text-slate-200">当前筛选下没有股票</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">调整筛选，或前往“观察池”添加需要持续跟踪的股票</div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1240px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100/95 text-slate-500 backdrop-blur dark:bg-slate-900/95 dark:text-slate-400">
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="px-4 py-2 text-left font-medium">股票与分类</th>
                <th className="px-2 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">本地结论</th>
                <th className="px-2 py-2 text-right font-medium">当前分</th>
                <th className="px-2 py-2 text-right font-medium">5日变化</th>
                <th className="px-2 py-2 text-right font-medium">20日变化</th>
                <th className="px-2 py-2 text-right font-medium">20日超额</th>
                <th className="px-2 py-2 text-right font-medium">最大回撤</th>
                <th className="px-3 py-2 text-left font-medium">评分轨迹</th>
                <th className="px-4 py-2 text-left font-medium">数据状态</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.tsCode}
                  tabIndex={0}
                  onClick={() => setSelected(item)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelected(item) }}
                  className="cursor-pointer border-b border-slate-100 bg-white transition-colors motion-reduce:transition-none hover:bg-cyan-50/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:border-slate-900 dark:bg-slate-950 dark:hover:bg-cyan-950/20"
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900 dark:text-slate-100">{item.stockName}</span>
                      {item.isPortfolio && <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">持仓</span>}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="font-mono">{item.stockCode}</span>
                      <span className="max-w-48 truncate">{item.subCategories.join(' / ') || item.categories.join(' / ') || '未分类'}</span>
                    </div>
                  </td>
                  <td className="px-2 py-2.5"><TrendStateBadge state={item.trendState} /></td>
                  <td className="max-w-[260px] px-3 py-2.5"><LocalSummaryCell item={item} /></td>
                  <td className="px-2 py-2.5 text-right text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{item.totalScore ?? '—'}</td>
                  <td className={`px-2 py-2.5 text-right tabular-nums ${valueTone(item.scoreDelta5d)}`}>{formatSigned(item.scoreDelta5d)}</td>
                  <td className={`px-2 py-2.5 text-right tabular-nums ${valueTone(item.scoreDelta20d)}`}>{formatSigned(item.scoreDelta20d)}</td>
                  <td className={`px-2 py-2.5 text-right tabular-nums ${valueTone(item.benchmarkHealth?.state === 'current' ? item.facts?.excessReturn20d : null)}`}>{formatSigned(item.benchmarkHealth?.state === 'current' ? item.facts?.excessReturn20d : null, '%')}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{item.facts?.maxDrawdown20d == null ? '—' : `${item.facts.maxDrawdown20d.toFixed(1)}%`}</td>
                  <td className="px-3 py-1.5"><ScoreSparkline points={item.scoreHistory} label={`${item.stockName}最近评分轨迹`} /></td>
                  <td className="px-4 py-2.5">
                    <div className={item.dataCoverage.state === 'ready' ? 'text-slate-700 dark:text-slate-200' : 'text-amber-700 dark:text-amber-300'}>
                      {item.dataCoverage.state === 'ready' ? `${item.dataCoverage.bars}根日线` : `${item.dataCoverage.bars}/${item.dataCoverage.requiredBars}根`}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      评分 {formatTrendDate(item.scoreDate)} · 行情{item.quoteSource === 'realtime' ? ` ${item.quoteTime}` : ` ${formatTrendDate(item.quoteTime)}`}
                    </div>
                  </td>
                </tr>
              ))}
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

function LocalSummaryCell({ item }: { item: TrendWorkbenchItem }) {
  const summary = buildLocalTrendSummary(item)
  return (
    <div data-testid={`local-trend-radar-${item.stockCode}`} data-headline={summary.headline} data-summary-status={summary.status}>
      <div className="leading-4 text-slate-700 dark:text-slate-200">{summary.headline}</div>
      <div className={`mt-1 text-[10px] ${summaryStatusTone(summary.status)}`}>本地规则 · {summaryStatusLabel(summary.status)}{summary.validWeightPct == null ? '' : ` · 权重${summary.validWeightPct}%`}</div>
    </div>
  )
}

function summaryStatusLabel(status: LocalTrendSummaryStatus): string {
  if (status === 'ready') return '事实完整'
  if (status === 'degraded') return '部分维度'
  return '证据不足'
}

function summaryStatusTone(status: LocalTrendSummaryStatus): string {
  if (status === 'ready') return 'text-cyan-700 dark:text-cyan-300'
  if (status === 'degraded') return 'text-amber-700 dark:text-amber-300'
  return 'text-rose-700 dark:text-rose-300'
}

function RadarSummary({ label, value, tone }: { label: string; value: number; tone: 'positive' | 'risk' | 'warning' | 'neutral' }) {
  const valueClass = tone === 'positive'
    ? 'text-rose-600 dark:text-rose-300'
    : tone === 'risk'
      ? 'text-emerald-600 dark:text-emerald-300'
      : tone === 'warning'
        ? 'text-amber-600 dark:text-amber-300'
        : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="border-r border-slate-200 px-4 py-3 last:border-r-0 dark:border-slate-800 sm:px-5">
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}

function RadarSkeleton() {
  return (
    <div className="space-y-2 p-5" aria-label="趋势雷达加载中">
      {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-800" />)}
    </div>
  )
}
