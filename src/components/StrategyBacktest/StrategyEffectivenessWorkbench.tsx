import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getBeijingDateValue, ResearchDatePicker } from '../IndustryResearch/ResearchDecisionControls'
import { BacktestCredibilityBand, type BacktestCredibilityAssessmentView } from './BacktestCredibilityBand'

type Horizon = 1 | 2 | 3 | 5
type HorizonRecord = Record<'1' | '2' | '3' | '5', number | null>

interface CatalogItem {
  id: string
  label: string
  description: string
  source: 'auction' | 'strategyLab'
  direction: 'long' | 'short'
  version: string
  entryBasis: 'auction_925' | 'next_trade_open'
  latestRunAt: number | null
  availableDateStart: string | null
  availableDateEnd: string | null
  available: boolean
  unavailableReason: string | null
}

interface HorizonMetric {
  horizon: Horizon
  validCount: number
  missingRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  winRate: number | null
  profitFactor: number | null
  dateWeightedReturn: number | null
  avgExcess: number | null
  p25: number | null
  p75: number | null
  best: number | null
  worst: number | null
}

interface Ranking {
  strategyId: string
  label: string
  source: 'auction' | 'strategyLab'
  direction: 'long' | 'short'
  version: string
  entryBasis: 'auction_925' | 'next_trade_open'
  signalCount: number
  signalDayCount: number
  metrics: HorizonMetric[]
}

interface Observation {
  id: string
  strategyId: string
  strategyLabel: string
  source: 'auction' | 'strategyLab'
  version: string
  tsCode: string
  stockName: string | null
  signalDate: string
  direction: 'long' | 'short'
  entryBasis: 'auction_925' | 'next_trade_open'
  entryDate: string | null
  entryPrice: number | null
  score: number | null
  status: 'valid' | 'partial' | 'data_insufficient' | 'excluded'
  missingReason: 'ONE_WORD_LIMIT' | 'NO_ENTRY_PRICE' | 'NO_FUTURE_CLOSE' | null
  returns: HorizonRecord
  benchmarkReturns: HorizonRecord
  excessReturns: HorizonRecord
}

interface EffectivenessResult {
  generatedAt: number
  dateRange: { start: string; end: string }
  horizons: Horizon[]
  selectedStrategyIds: string[]
  catalog: CatalogItem[]
  rankings: Ranking[]
  overlaps: Array<{
    leftStrategyId: string
    rightStrategyId: string
    intersectionCount: number
    unionCount: number
    overlapRate: number | null
  }>
  observations: Observation[]
  credibility: BacktestCredibilityAssessmentView
  coverage: {
    totalSignals: number
    validSignals: number
    partialSignals: number
    excludedSignals: number
    insufficientSignals: number
    truncated: boolean
    note: string
  }
}

interface EvaluateOptions {
  dateStart?: string
  dateEnd?: string
  strategyIds?: string[]
}

interface BackfillProgress {
  pct: number
  message: string
}

const HORIZON_LABELS: Record<Horizon, string> = {
  1: '次日收盘',
  2: '第2交易日',
  3: '第3交易日',
  5: '第5交易日',
}

const CHART_COLORS = ['#0891b2', '#e11d48', '#d97706', '#4f46e5', '#059669', '#64748b']

function todayYmd(): string {
  return getBeijingDateValue().replace(/-/g, '')
}

function offsetYmd(days: number): string {
  const now = new Date()
  const beijing = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
  beijing.setDate(beijing.getDate() + days)
  return `${beijing.getFullYear()}${String(beijing.getMonth() + 1).padStart(2, '0')}${String(beijing.getDate()).padStart(2, '0')}`
}

function ymdToDash(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : ''
}

function dashToYmd(value: string): string {
  return value.replace(/-/g, '')
}

function shortDate(value: string | null): string {
  if (!value) return '—'
  return /^\d{8}$/.test(value) ? `${value.slice(4, 6)}/${value.slice(6, 8)}` : value
}

function longDate(value: string | null): string {
  if (!value) return '未知'
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function backfillDaysFrom(dateStart: string): number {
  if (!/^\d{8}$/.test(dateStart)) return 90
  const start = Date.UTC(Number(dateStart.slice(0, 4)), Number(dateStart.slice(4, 6)) - 1, Number(dateStart.slice(6, 8)))
  const endValue = todayYmd()
  const end = Date.UTC(Number(endValue.slice(0, 4)), Number(endValue.slice(4, 6)) - 1, Number(endValue.slice(6, 8)))
  const calendarDays = Math.max(0, Math.ceil((end - start) / 86_400_000))
  return Math.min(365, Math.max(15, Math.ceil(calendarDays * 5 / 7) + 10))
}

function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

function fmtPrice(value: number | null): string {
  return value == null ? '—' : value.toFixed(value >= 100 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '')
}

function returnTone(value: number | null | undefined): string {
  if (value == null) return 'text-slate-400 dark:text-slate-500'
  if (value > 0) return 'text-rose-600 dark:text-rose-300'
  if (value < 0) return 'text-emerald-600 dark:text-emerald-300'
  return 'text-slate-600 dark:text-slate-300'
}

function sourceLabel(source: CatalogItem['source']): string {
  return source === 'auction' ? '早盘竞价' : '策略实验室'
}

function entryBasisLabel(entryBasis: CatalogItem['entryBasis']): string {
  return entryBasis === 'auction_925' ? '9:25竞价撮合价' : '下一交易日开盘价'
}

function statusLabel(observation: Observation): string {
  if (observation.status === 'valid') return '四周期完整'
  if (observation.status === 'partial') return '部分周期可用'
  if (observation.missingReason === 'ONE_WORD_LIMIT') return '一字板已排除'
  if (observation.missingReason === 'NO_ENTRY_PRICE') return '缺少入场价'
  return '观察期未完成'
}

function metricFor(ranking: Ranking, horizon: Horizon): HorizonMetric | null {
  return ranking.metrics.find(metric => metric.horizon === horizon) ?? null
}

function compactLabel(label: string): string {
  return label.length > 8 ? `${label.slice(0, 8)}…` : label
}

export function StrategyEffectivenessWorkbench(): JSX.Element {
  const [dateStart, setDateStart] = useState(offsetYmd(-30))
  const [dateEnd, setDateEnd] = useState(todayYmd())
  const [horizon, setHorizon] = useState<Horizon>(1)
  const [data, setData] = useState<EffectivenessResult | null>(null)
  const [draftStrategyIds, setDraftStrategyIds] = useState<string[]>([])
  const [selectorOpen, setSelectorOpen] = useState(false)
  const [strategyQuery, setStrategyQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailView, setDetailView] = useState<'signals' | 'overlap'>('signals')
  const [detailLimit, setDetailLimit] = useState(50)
  const [statusFilter, setStatusFilter] = useState<'all' | 'usable' | 'missing'>('all')
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillProgress, setBackfillProgress] = useState<BackfillProgress | null>(null)
  const selectorRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const activeBackfillRef = useRef<Required<EvaluateOptions> | null>(null)

  const evaluate = async (options?: EvaluateOptions): Promise<void> => {
    const nextDateStart = options?.dateStart ?? dateStart
    const nextDateEnd = options?.dateEnd ?? dateEnd
    const nextStrategyIds = options?.strategyIds
    const requestId = ++requestRef.current
    setError(null)
    if (!/^\d{8}$/.test(nextDateStart) || !/^\d{8}$/.test(nextDateEnd) || nextDateStart > nextDateEnd) {
      setError('请选择有效的信号日期范围')
      return
    }
    const api = window.api.strategyBacktest
    if (typeof api?.evaluateSignals !== 'function') {
      setError('策略评估运行组件尚未加载，请完全重启应用后再试。')
      return
    }
    setLoading(true)
    try {
      const response = await api.evaluateSignals({
        dateStart: nextDateStart,
        dateEnd: nextDateEnd,
        strategyIds: nextStrategyIds,
        excludeUntradeable: true,
      })
      if (requestId !== requestRef.current) return
      if (!response.ok) {
        setError(response.message)
        return
      }
      const next = response.data as EffectivenessResult
      setData(next)
      setDraftStrategyIds(next.selectedStrategyIds)
      setDetailLimit(50)
      setSelectorOpen(false)
    } catch (reason) {
      if (requestId === requestRef.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    void evaluate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onProgress = window.api.shortTerm?.onBacktestProgress
    if (typeof onProgress !== 'function') return
    return onProgress((progress) => {
      if (!activeBackfillRef.current) return
      setBackfillProgress(progress)
      if (progress.pct < 0) {
        activeBackfillRef.current = null
        setBackfillRunning(false)
        setError(progress.message || '竞价历史补齐失败，请稍后重试。')
        return
      }
      if (progress.pct < 100) return
      const request = activeBackfillRef.current
      activeBackfillRef.current = null
      setBackfillRunning(false)
      void evaluate(request)
    })
  // The completion callback carries a frozen request, so the mount-time evaluator is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectorOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!selectorRef.current?.contains(event.target as Node)) setSelectorOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectorOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [selectorOpen])

  const currentDate = getBeijingDateValue()
  const startDateValue = ymdToDash(dateStart)
  const endDateValue = ymdToDash(dateEnd)
  const dateError = !/^\d{8}$/.test(dateStart) || !/^\d{8}$/.test(dateEnd)
    ? '请输入完整日期'
    : dateStart > dateEnd
      ? '开始日期不能晚于结束日期'
      : endDateValue > currentDate
        ? '结束日期不能晚于今天'
        : null

  const sortedRankings = useMemo(() => {
    if (!data) return []
    return [...data.rankings].sort((left, right) => {
      const leftMetric = metricFor(left, horizon)
      const rightMetric = metricFor(right, horizon)
      const leftEnough = (leftMetric?.validCount ?? 0) >= 5 ? 1 : 0
      const rightEnough = (rightMetric?.validCount ?? 0) >= 5 ? 1 : 0
      if (leftEnough !== rightEnough) return rightEnough - leftEnough
      const leftReturn = leftMetric?.dateWeightedReturn ?? Number.NEGATIVE_INFINITY
      const rightReturn = rightMetric?.dateWeightedReturn ?? Number.NEGATIVE_INFINITY
      if (leftReturn !== rightReturn) return rightReturn - leftReturn
      return (rightMetric?.validCount ?? 0) - (leftMetric?.validCount ?? 0)
    })
  }, [data, horizon])

  const selectedMetricTotals = useMemo(() => {
    const metrics = sortedRankings.map(ranking => metricFor(ranking, horizon)).filter((metric): metric is HorizonMetric => metric != null)
    const valid = metrics.reduce((sum, metric) => sum + metric.validCount, 0)
    const signals = sortedRankings.reduce((sum, ranking) => sum + ranking.signalCount, 0)
    return { valid, signals, coverage: signals > 0 ? valid / signals : null }
  }, [horizon, sortedRankings])

  const leader = sortedRankings.find(ranking => (metricFor(ranking, horizon)?.validCount ?? 0) >= 5)
    ?? sortedRankings.find(ranking => (metricFor(ranking, horizon)?.validCount ?? 0) > 0)
    ?? null
  const leaderMetric = leader ? metricFor(leader, horizon) : null
  const chartRankings = sortedRankings.filter(ranking => (metricFor(ranking, horizon)?.validCount ?? 0) > 0).slice(0, 6)
  const pathData = ([1, 2, 3, 5] as Horizon[]).map(item => ({
    horizon: HORIZON_LABELS[item],
    ...Object.fromEntries(chartRankings.map(ranking => [ranking.strategyId, metricFor(ranking, item)?.avgReturn ?? null])),
  }))
  const stabilityData = chartRankings.map(ranking => {
    const metric = metricFor(ranking, horizon)
    return {
      name: compactLabel(ranking.label),
      strategyId: ranking.strategyId,
      按信号等权: metric?.avgReturn ?? null,
      按信号日等权: metric?.dateWeightedReturn ?? null,
    }
  })

  const catalog = data?.catalog ?? []
  const filteredCatalog = catalog.filter(item => {
    const query = strategyQuery.trim().toLocaleLowerCase('zh-CN')
    return !query || `${item.label} ${item.description} ${sourceLabel(item.source)}`.toLocaleLowerCase('zh-CN').includes(query)
  })
  const catalogById = new Map(catalog.map(item => [item.id, item]))
  const selectedCatalog = (data?.selectedStrategyIds ?? []).map(id => catalogById.get(id)).filter((item): item is CatalogItem => item != null)
  const selectedRanges = selectedCatalog.filter((item): item is CatalogItem & { availableDateStart: string; availableDateEnd: string } => Boolean(item.availableDateStart && item.availableDateEnd))
  const suggestedRange = selectedRanges.length === selectedCatalog.length && selectedRanges.length > 0
    ? {
        start: selectedRanges.map(item => item.availableDateStart).sort().at(-1) ?? '',
        end: selectedRanges.map(item => item.availableDateEnd).sort()[0] ?? '',
      }
    : null
  const usableSuggestedRange = suggestedRange && suggestedRange.start <= suggestedRange.end ? suggestedRange : null
  const hasSelectedAuction = selectedCatalog.some(item => item.source === 'auction')
  const noSignals = data?.coverage.totalSignals === 0
  const filteredObservations = (data?.observations ?? []).filter(observation => {
    if (statusFilter === 'usable') return observation.status === 'valid' || observation.status === 'partial'
    if (statusFilter === 'missing') return observation.status === 'excluded' || observation.status === 'data_insufficient'
    return true
  })
  const visibleObservations = filteredObservations.slice(0, detailLimit)
  const overlaps = [...(data?.overlaps ?? [])].sort((left, right) => (right.overlapRate ?? -1) - (left.overlapRate ?? -1))

  const toggleStrategy = (id: string): void => {
    setDraftStrategyIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id].slice(0, 20))
  }

  const useAvailableRange = (): void => {
    if (!data || !usableSuggestedRange) return
    setDateStart(usableSuggestedRange.start)
    setDateEnd(usableSuggestedRange.end)
    void evaluate({
      dateStart: usableSuggestedRange.start,
      dateEnd: usableSuggestedRange.end,
      strategyIds: data.selectedStrategyIds,
    })
  }

  const backfillAuctionRange = async (): Promise<void> => {
    if (!data || backfillRunning) return
    const api = window.api.shortTerm
    if (typeof api?.backtestRun !== 'function' || typeof api?.onBacktestProgress !== 'function') {
      setError('竞价历史同步组件尚未加载，请完全重启应用后再试。')
      return
    }
    const request = {
      dateStart: data.dateRange.start,
      dateEnd: data.dateRange.end,
      strategyIds: data.selectedStrategyIds,
    }
    activeBackfillRef.current = request
    setBackfillRunning(true)
    setBackfillProgress({ pct: 0, message: '正在准备补齐当前区间的竞价历史…' })
    try {
      const response = await api.backtestRun({ days: backfillDaysFrom(request.dateStart), force: false })
      if (response.ok) return
      if (response.error === 'JOB_RUNNING') {
        setBackfillProgress({ pct: 0, message: '已有竞价历史任务运行中，完成后将自动重新评估。' })
        return
      }
      activeBackfillRef.current = null
      setBackfillRunning(false)
      setError('Tushare 尚未启用，无法补齐精确的9:25竞价历史。')
    } catch (reason) {
      activeBackfillRef.current = null
      setBackfillRunning(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div data-testid="strategy-effectiveness-scroll" className="h-full min-h-0 overflow-y-auto bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/95">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-cyan-700 dark:text-cyan-300">信号后真实表现</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-50">策略效果评估</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500 dark:text-slate-400">比较策略选股在统一观察周期下的表现；无需资金、仓位或买入数量。</p>
          </div>
          <div className="flex min-h-9 items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-800">只读本地事实</span>
            {data && <span className="tabular-nums">{new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })} 更新</span>}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-[minmax(150px,0.8fr)_minmax(150px,0.8fr)_minmax(260px,1.4fr)_auto]">
          <label className="min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">信号开始日</span>
            <ResearchDatePicker
              value={startDateValue}
              testId="strategy-effectiveness-date-start"
              max={endDateValue && endDateValue < currentDate ? endDateValue : currentDate}
              disabled={loading}
              ariaLabel="策略评估信号开始日期"
              triggerAriaLabel="打开策略评估开始日期选择器"
              dialogLabel="选择策略评估开始日期"
              footerHint="按信号发生日筛选"
              quickSelectLabel="今天"
              onChange={value => setDateStart(dashToYmd(value))}
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">信号结束日</span>
            <ResearchDatePicker
              value={endDateValue}
              testId="strategy-effectiveness-date-end"
              min={startDateValue}
              max={currentDate}
              disabled={loading}
              ariaLabel="策略评估信号结束日期"
              triggerAriaLabel="打开策略评估结束日期选择器"
              dialogLabel="选择策略评估结束日期"
              footerHint="观察结果可延伸至结束日之后"
              quickSelectLabel="今天"
              onChange={value => setDateEnd(dashToYmd(value))}
            />
          </label>
          <div ref={selectorRef} className="relative col-span-2 min-w-0 lg:col-span-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-300">对比策略</span>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={selectorOpen}
              data-testid="strategy-effectiveness-selector"
              onClick={() => setSelectorOpen(current => !current)}
              className="flex h-10 w-full items-center justify-between gap-3 rounded-md border border-slate-300 bg-white px-3 text-left text-sm shadow-sm outline-none transition-colors hover:border-cyan-400 focus-visible:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-950 dark:hover:border-cyan-600"
            >
              <span className="min-w-0 truncate font-medium">
                {draftStrategyIds.length === 0
                  ? '请选择至少一套策略'
                  : `${draftStrategyIds.length} 套 · ${draftStrategyIds.slice(0, 2).map(id => catalogById.get(id)?.label ?? id).join('、')}${draftStrategyIds.length > 2 ? '…' : ''}`}
              </span>
              <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 motion-reduce:transition-none ${selectorOpen ? 'rotate-180' : ''}`} fill="none">
                <path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {selectorOpen && (
              <div role="dialog" aria-label="选择要比较的策略" className="absolute right-0 top-[calc(100%+6px)] z-50 w-full min-w-[360px] max-w-[520px] overflow-hidden rounded-md border border-slate-200 bg-white shadow-xl shadow-slate-950/15 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/40">
                <div className="border-b border-slate-100 p-3 dark:border-slate-800">
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300" htmlFor="strategy-effectiveness-search">搜索策略</label>
                  <input
                    id="strategy-effectiveness-search"
                    value={strategyQuery}
                    onChange={event => setStrategyQuery(event.target.value)}
                    placeholder="名称、来源或说明"
                    className="mt-1.5 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-950"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-500 dark:text-slate-400">最多同时比较20套；图表展示排名前6套。</span>
                    <div className="flex gap-1">
                      <button type="button" onClick={() => setDraftStrategyIds(catalog.filter(item => item.available).slice(0, 20).map(item => item.id))} className="min-h-8 rounded px-2 text-cyan-700 hover:bg-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:text-cyan-300 dark:hover:bg-cyan-950/30">全选可用</button>
                      <button type="button" onClick={() => setDraftStrategyIds([])} className="min-h-8 rounded px-2 text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:text-slate-400 dark:hover:bg-slate-800">清空</button>
                    </div>
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto p-1.5">
                  {filteredCatalog.map(item => (
                    <label key={item.id} className={`flex min-h-12 items-center gap-3 rounded px-2.5 py-2 transition-colors ${item.available ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800' : 'cursor-not-allowed opacity-50'}`}>
                      <input
                        type="checkbox"
                        checked={draftStrategyIds.includes(item.id)}
                        disabled={!item.available}
                        onChange={() => toggleStrategy(item.id)}
                        className="h-4 w-4 shrink-0 accent-cyan-700"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium"><span>{item.label}</span><span className="text-[10px] font-normal text-slate-400">{sourceLabel(item.source)}</span></span>
                        <span className="mt-0.5 block truncate text-[11px] text-slate-500 dark:text-slate-400">{item.available ? item.description : item.unavailableReason}</span>
                      </span>
                    </label>
                  ))}
                  {filteredCatalog.length === 0 && <div className="px-3 py-10 text-center text-xs text-slate-400">没有匹配策略</div>}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={loading || Boolean(dateError) || draftStrategyIds.length === 0}
            onClick={() => void evaluate({ strategyIds: draftStrategyIds })}
            className="col-span-2 h-10 self-end rounded-md bg-cyan-700 px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 disabled:cursor-not-allowed disabled:bg-slate-400 lg:col-span-1"
          >
            {loading ? '评估中…' : '重新评估'}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="grid grid-cols-4 rounded-md bg-slate-100 p-1 dark:bg-slate-950" role="group" aria-label="观察周期">
            {([1, 2, 3, 5] as Horizon[]).map(item => (
              <button
                key={item}
                type="button"
                aria-pressed={horizon === item}
                onClick={() => setHorizon(item)}
                className={`min-h-9 rounded px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${horizon === item ? 'bg-white text-cyan-800 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-cyan-200 dark:ring-slate-700' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}
              >
                {item === 1 ? '次日' : `第${item}日`}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">观察点：{HORIZON_LABELS[horizon]}；收益已按看多/看空方向调整。</p>
        </div>
        {dateError && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{dateError}</p>}
        {error && (
          <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
            <span>{error}</span>
            {error.includes('重启应用') && <button type="button" onClick={() => void window.api.app.relaunch()} className="min-h-9 rounded border border-red-300 px-3 font-semibold hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 dark:border-red-800 dark:hover:bg-red-950">重启应用</button>}
          </div>
        )}
      </header>

      {loading && !data ? (
        <div className="grid min-h-72 place-items-center px-5" aria-live="polite">
          <div className="w-full max-w-xl">
            <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><div className="h-full w-1/3 animate-pulse rounded-full bg-cyan-600 motion-reduce:animate-none" /></div>
            <p className="mt-3 text-center text-sm text-slate-500 dark:text-slate-400">正在读取本地信号、日线和策略版本…</p>
          </div>
        </div>
      ) : data ? (
        <main className="px-5 pb-8 pt-5">
          <BacktestCredibilityBand assessment={data.credibility} testId="strategy-effectiveness-credibility" />
          <section aria-labelledby="effectiveness-conclusion-title" className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="grid grid-cols-2 divide-x divide-y divide-slate-200 lg:grid-cols-4 lg:divide-y-0 dark:divide-slate-800">
              {[
                ['领先策略', leader?.label ?? '样本不足', leaderMetric?.dateWeightedReturn == null ? '无可比较收益' : `按信号日等权 ${fmtPct(leaderMetric.dateWeightedReturn)}`],
                ['有效样本', `${selectedMetricTotals.valid} / ${selectedMetricTotals.signals}`, `${data.coverage.partialSignals} 条部分周期可用`],
                ['数据覆盖', fmtRatio(selectedMetricTotals.coverage), `${data.coverage.excludedSignals} 条不可执行 · ${data.coverage.insufficientSignals} 条待观察`],
                ['比较范围', `${data.rankings.length} 套策略`, `${data.dateRange.start.slice(4, 6)}/${data.dateRange.start.slice(6, 8)} 至 ${data.dateRange.end.slice(4, 6)}/${data.dateRange.end.slice(6, 8)}`],
              ].map(([label, value, note]) => (
                <div key={label} className="min-h-24 px-4 py-3.5 text-center">
                  <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</p>
                  <p className="mt-1.5 truncate text-lg font-semibold tabular-nums text-slate-950 dark:text-slate-50" title={value}>{value}</p>
                  <p className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400" title={note}>{note}</p>
                </div>
              ))}
            </div>
            <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-800">
              <h3 id="effectiveness-conclusion-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">当前结论</h3>
              <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">
                {leader && leaderMetric?.dateWeightedReturn != null
                  ? `${HORIZON_LABELS[horizon]}口径下，${leader.label}的按信号日等权收益为 ${fmtPct(leaderMetric.dateWeightedReturn)}，按信号等权收益为 ${fmtPct(leaderMetric.avgReturn)}，胜率 ${fmtRatio(leaderMetric.winRate)}，有效样本 ${leaderMetric.validCount} 条。${leaderMetric.validCount < 5 ? '当前样本仍少，只能视为线索，不能形成稳定结论。' : '排名优先考虑至少5条有效样本，避免单个高收益样本占据首位。'}`
                  : selectedCatalog.length === 1
                    ? noSignals
                      ? `${selectedCatalog[0].label}在所选区间没有已记录的策略信号，因此不能计算收益；空样本不会被记为0收益。`
                      : `${selectedCatalog[0].label}在所选区间有 ${data.coverage.totalSignals} 条信号，但暂无可用于${HORIZON_LABELS[horizon]}统计的有效收益样本；缺失值不会被记为0收益。`
                    : data.coverage.note}
              </p>
            </div>
            {noSignals && (
              <div data-testid="strategy-effectiveness-data-gap" className="border-t border-amber-200 bg-amber-50 px-4 py-4 dark:border-amber-900/70 dark:bg-amber-950/20">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 max-w-4xl">
                    <h4 className="text-sm font-semibold text-amber-950 dark:text-amber-100">当前区间没有可计算的策略信号</h4>
                    <p className="mt-1 text-xs leading-5 text-amber-900/80 dark:text-amber-200/80">
                      {selectedRanges.length > 0
                        ? `所选策略的本地可用范围：${selectedRanges.map(item => `${item.label} ${longDate(item.availableDateStart)} 至 ${longDate(item.availableDateEnd)}`).join('；')}。这不是“收益为0”，而是当前日期范围没有对应的入场事实。`
                        : '所选策略尚无可定位的本地信号日期；这不是“收益为0”。策略实验室策略需要先完成一次运行，竞价策略需要先补齐竞价历史。'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {usableSuggestedRange && (
                      <button type="button" disabled={loading || backfillRunning} onClick={useAvailableRange} className="min-h-11 rounded-md border border-amber-300 bg-white px-3 text-xs font-semibold text-amber-950 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/30 disabled:opacity-50 dark:border-amber-800 dark:bg-slate-900 dark:text-amber-100 dark:hover:bg-amber-950/40">
                        查看已有区间结果
                      </button>
                    )}
                    {hasSelectedAuction && (
                      <button type="button" disabled={loading || backfillRunning} onClick={() => void backfillAuctionRange()} className="min-h-11 rounded-md bg-cyan-700 px-3 text-xs font-semibold text-white transition-colors hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 disabled:bg-slate-400">
                        {backfillRunning ? '正在补齐…' : '补齐当前区间'}
                      </button>
                    )}
                  </div>
                </div>
                {backfillProgress && (
                  <div className="mt-3" aria-live="polite">
                    <div className="h-1.5 overflow-hidden rounded-full bg-amber-100 dark:bg-amber-950">
                      <div className="h-full rounded-full bg-cyan-600 transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${Math.max(2, Math.min(100, backfillProgress.pct))}%` }} />
                    </div>
                    <p className="mt-1.5 text-xs text-amber-900/80 dark:text-amber-200/80">{backfillProgress.message}</p>
                  </div>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="strategy-ranking-title" className="mt-6 overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <div>
                <h3 id="strategy-ranking-title" className="text-sm font-semibold">策略排名 · {HORIZON_LABELS[horizon]}</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">先比较按信号日等权收益；少于5条有效样本的策略降级排序。</p>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">按信号日等权可削弱单日信号爆量造成的偏差</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px] text-left text-xs">
                <thead className="bg-slate-50 text-[11px] font-medium text-slate-500 dark:bg-slate-950/60 dark:text-slate-400">
                  <tr>
                    <th className="w-12 px-3 py-2.5 text-center">排名</th>
                    <th className="px-3 py-2.5">策略 / 口径</th>
                    <th className="px-3 py-2.5 text-right">信号 / 日期</th>
                    <th className="px-3 py-2.5 text-right">有效覆盖</th>
                    <th className="px-3 py-2.5 text-right">按信号日等权</th>
                    <th className="px-3 py-2.5 text-right">按信号等权</th>
                    <th className="px-3 py-2.5 text-right">中位收益</th>
                    <th className="px-3 py-2.5 text-right">胜率</th>
                    <th className="px-3 py-2.5 text-right">平均超额</th>
                    <th className="px-3 py-2.5 text-right">P25 - P75</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {sortedRankings.map((ranking, index) => {
                    const metric = metricFor(ranking, horizon)
                    const enough = (metric?.validCount ?? 0) >= 5
                    return (
                      <tr key={ranking.strategyId} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60">
                        <td className="px-3 py-3 text-center font-mono text-sm text-slate-500 dark:text-slate-400">{metric?.validCount ? index + 1 : '—'}</td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><span>{ranking.label}</span>{!enough && metric?.validCount ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">样本少</span> : null}</div>
                          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{sourceLabel(ranking.source)} · {entryBasisLabel(ranking.entryBasis)} · {ranking.version}</div>
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums">{ranking.signalCount} / {ranking.signalDayCount}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{metric?.validCount ?? 0} <span className="text-slate-400">({metric?.missingRate == null ? '—' : `${((1 - metric.missingRate) * 100).toFixed(0)}%`})</span></td>
                        <td className={`px-3 py-3 text-right font-semibold tabular-nums ${returnTone(metric?.dateWeightedReturn)}`}>{fmtPct(metric?.dateWeightedReturn)}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${returnTone(metric?.avgReturn)}`}>{fmtPct(metric?.avgReturn)}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${returnTone(metric?.medianReturn)}`}>{fmtPct(metric?.medianReturn)}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{fmtRatio(metric?.winRate)}</td>
                        <td className={`px-3 py-3 text-right tabular-nums ${returnTone(metric?.avgExcess)}`}>{fmtPct(metric?.avgExcess)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">{fmtPct(metric?.p25)} - {fmtPct(metric?.p75)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {sortedRankings.length === 0 && <div className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">没有已选择的策略</div>}
          </section>

          <section className="strategy-effectiveness-chart mt-6 grid overflow-hidden rounded-md border border-slate-200 bg-white lg:grid-cols-2 lg:divide-x dark:border-slate-800 dark:bg-slate-900 dark:lg:divide-slate-800">
            <div className="min-w-0 border-b border-slate-200 p-4 lg:border-b-0 dark:border-slate-800">
              <div>
                <h3 className="text-sm font-semibold">收益路径</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">同一策略从次日至第5交易日的方向调整平均收益。</p>
              </div>
              {chartRankings.length > 0 ? (
                <div role="img" aria-label={`收益路径图，展示${chartRankings.map(item => item.label).join('、')}`} className="mt-3 h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={pathData} margin={{ top: 8, right: 14, left: -6, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 4" vertical={false} opacity={0.28} />
                      <XAxis dataKey="horizon" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tickFormatter={value => `${Number(value).toFixed(0)}%`} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
                      <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
                      <Tooltip formatter={(value, name) => [fmtPct(Number(value)), String(name)]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {chartRankings.map((ranking, index) => (
                        <Line key={ranking.strategyId} type="monotone" dataKey={ranking.strategyId} name={ranking.label} stroke={CHART_COLORS[index]} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : <div className="grid h-72 place-items-center text-sm text-slate-500 dark:text-slate-400">暂无可绘制的收益路径</div>}
            </div>
            <div className="min-w-0 p-4">
              <div>
                <h3 className="text-sm font-semibold">稳定性对照 · {HORIZON_LABELS[horizon]}</h3>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">两种等权结果差距越大，越可能受单日信号数量影响。</p>
              </div>
              {stabilityData.length > 0 ? (
                <div role="img" aria-label="按信号等权与按信号日等权收益对比图" className="mt-3 h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stabilityData} layout="vertical" margin={{ top: 8, right: 14, left: 6, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 4" horizontal={false} opacity={0.28} />
                      <XAxis type="number" tickFormatter={value => `${Number(value).toFixed(0)}%`} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" width={78} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <ReferenceLine x={0} stroke="#94a3b8" strokeDasharray="3 3" />
                      <Tooltip formatter={(value, name) => [fmtPct(Number(value)), String(name)]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="按信号等权" fill="#0891b2" radius={[0, 2, 2, 0]} isAnimationActive={false} />
                      <Bar dataKey="按信号日等权" fill="#d97706" radius={[0, 2, 2, 0]} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : <div className="grid h-72 place-items-center text-sm text-slate-500 dark:text-slate-400">暂无可比较的稳定性样本</div>}
            </div>
          </section>

          <section aria-labelledby="effectiveness-detail-title" className="mt-6 overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 dark:border-slate-800">
              <div className="flex min-h-12 items-end gap-1" role="tablist" aria-label="评估详情">
                <button type="button" role="tab" aria-selected={detailView === 'signals'} onClick={() => setDetailView('signals')} className={`min-h-11 border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${detailView === 'signals' ? 'border-cyan-600 text-cyan-800 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}>信号明细</button>
                <button type="button" role="tab" aria-selected={detailView === 'overlap'} onClick={() => setDetailView('overlap')} className={`min-h-11 border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${detailView === 'overlap' ? 'border-cyan-600 text-cyan-800 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}>策略重合</button>
              </div>
              <h3 id="effectiveness-detail-title" className="sr-only">策略评估详情</h3>
              {detailView === 'signals' && (
                <div className="flex rounded bg-slate-100 p-1 dark:bg-slate-950" role="group" aria-label="信号状态筛选">
                  {([['all', '全部'], ['usable', '可用'], ['missing', '缺口']] as const).map(([key, label]) => (
                    <button key={key} type="button" aria-pressed={statusFilter === key} onClick={() => { setStatusFilter(key); setDetailLimit(50) }} className={`min-h-8 rounded px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${statusFilter === key ? 'bg-white font-medium text-cyan-800 shadow-sm dark:bg-slate-800 dark:text-cyan-200' : 'text-slate-500 dark:text-slate-400'}`}>{label}</button>
                  ))}
                </div>
              )}
            </div>

            {detailView === 'signals' ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[960px] text-left text-xs">
                    <thead className="bg-slate-50 text-[11px] text-slate-500 dark:bg-slate-950/60 dark:text-slate-400">
                      <tr><th className="px-3 py-2.5">股票</th><th className="px-3 py-2.5">策略</th><th className="px-3 py-2.5">信号日</th><th className="px-3 py-2.5">观察起点</th><th className="px-3 py-2.5 text-right">{HORIZON_LABELS[horizon]}</th><th className="px-3 py-2.5 text-right">同期基准</th><th className="px-3 py-2.5 text-right">超额</th><th className="px-3 py-2.5">状态</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {visibleObservations.map(item => {
                        const key = String(horizon) as keyof HorizonRecord
                        return (
                          <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                            <td className="px-3 py-3"><div className="font-semibold text-slate-900 dark:text-slate-100">{item.stockName ?? item.tsCode.slice(0, 6)}</div><div className="mt-0.5 font-mono text-[11px] text-slate-400">{item.tsCode}</div></td>
                            <td className="px-3 py-3"><div>{item.strategyLabel}</div><div className="mt-0.5 text-[11px] text-slate-400">{item.direction === 'short' ? '看空' : '看多'} · {item.version}</div></td>
                            <td className="px-3 py-3 tabular-nums">{shortDate(item.signalDate)}</td>
                            <td className="px-3 py-3"><div className="tabular-nums">{shortDate(item.entryDate)} · {fmtPrice(item.entryPrice)}</div><div className="mt-0.5 text-[11px] text-slate-400">{entryBasisLabel(item.entryBasis)}</div></td>
                            <td className={`px-3 py-3 text-right font-semibold tabular-nums ${returnTone(item.returns[key])}`}>{fmtPct(item.returns[key])}</td>
                            <td className={`px-3 py-3 text-right tabular-nums ${returnTone(item.benchmarkReturns[key])}`}>{fmtPct(item.benchmarkReturns[key])}</td>
                            <td className={`px-3 py-3 text-right tabular-nums ${returnTone(item.excessReturns[key])}`}>{fmtPct(item.excessReturns[key])}</td>
                            <td className="px-3 py-3"><span className={`inline-flex rounded px-2 py-1 text-[11px] ${item.status === 'valid' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200' : item.status === 'partial' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>{statusLabel(item)}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                {visibleObservations.length === 0 && <div className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">当前筛选下没有信号明细</div>}
                {detailLimit < filteredObservations.length && <div className="border-t border-slate-100 p-3 text-center dark:border-slate-800"><button type="button" onClick={() => setDetailLimit(limit => limit + 50)} className="min-h-10 rounded-md border border-slate-300 px-4 text-xs font-medium hover:border-cyan-400 hover:text-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:hover:border-cyan-600 dark:hover:text-cyan-200">再显示50条</button></div>}
              </>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="bg-slate-50 text-[11px] text-slate-500 dark:bg-slate-950/60 dark:text-slate-400"><tr><th className="px-4 py-2.5">策略A</th><th className="px-4 py-2.5">策略B</th><th className="px-4 py-2.5 text-right">同股同日交集</th><th className="px-4 py-2.5 text-right">并集</th><th className="px-4 py-2.5 text-right">重合率</th></tr></thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {overlaps.map(item => <tr key={`${item.leftStrategyId}:${item.rightStrategyId}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/60"><td className="px-4 py-3 font-medium">{catalogById.get(item.leftStrategyId)?.label ?? item.leftStrategyId}</td><td className="px-4 py-3 font-medium">{catalogById.get(item.rightStrategyId)?.label ?? item.rightStrategyId}</td><td className="px-4 py-3 text-right tabular-nums">{item.intersectionCount}</td><td className="px-4 py-3 text-right tabular-nums">{item.unionCount}</td><td className="px-4 py-3 text-right font-semibold tabular-nums">{fmtRatio(item.overlapRate)}</td></tr>)}
                  </tbody>
                </table>
                {overlaps.length === 0 && <div className="px-4 py-12 text-center text-sm text-slate-500 dark:text-slate-400">至少选择两套策略后才能比较信号重合</div>}
              </div>
            )}
          </section>

          <p className="mt-4 text-xs leading-5 text-slate-500 dark:text-slate-400">{data.coverage.note}{data.coverage.truncated ? ' 明细仅展示最近1000条，汇总仍使用完整集合。' : ''}</p>
        </main>
      ) : (
        <div className="grid min-h-72 place-items-center px-5 text-center text-sm text-slate-500 dark:text-slate-400">暂无评估结果</div>
      )}
    </div>
  )
}
