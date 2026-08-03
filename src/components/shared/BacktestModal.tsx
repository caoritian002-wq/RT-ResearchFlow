import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useAppStore } from '../../store/appStore'
import { ResearchCombobox } from '../IndustryResearch/ResearchDecisionControls'
import { StockKlineChipDrawer } from './StockMiniChart'
import { RightDrawer } from './RightDrawer'
import {
  AUCTION_BACKTEST_POOL_LABEL,
  buildAuctionBacktestConclusion,
  buildAuctionBacktestEnvironmentSummaries,
  buildAuctionBacktestPath,
  buildAuctionBacktestPoolSummaries,
  buildAuctionBacktestSummary,
  filterAuctionBacktestDetails,
  formatSignedPct,
  getAuctionBacktestAlpha,
  getAuctionBacktestAvailability,
  getAuctionBacktestReturn,
  type AuctionBacktestDetail,
  type AuctionBacktestHorizon,
  type AuctionBacktestPool,
  type AuctionBacktestSortMode,
} from './auctionBacktestViewModel'

interface Props {
  open: boolean
  onClose: () => void
}

const RANGE_OPTIONS = [7, 30, 60, 90] as const
const HORIZON_OPTIONS: AuctionBacktestHorizon[] = [1, 2, 3, 5]
const PAGE_SIZE = 120

const POOL_OPTIONS = [
  { value: 'all', label: '全部信号池', meta: '横向比较' },
  ...Object.entries(AUCTION_BACKTEST_POOL_LABEL).map(([value, label]) => ({ value, label })),
]

const SORT_OPTIONS = [
  { value: 'date', label: '信号日从新到旧' },
  { value: 'return', label: '当前周期收益从高到低' },
  { value: 'alpha', label: '当前周期超额从高到低' },
]

function daysAgoYmd(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function formatTradeDate(value: string | null): string {
  if (!value || value.length !== 8) return '--'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function valueTone(value: number | null): string {
  if (value == null) return 'text-slate-400 dark:text-slate-500'
  if (value > 0) return 'text-red-600 dark:text-red-300'
  if (value < 0) return 'text-emerald-600 dark:text-emerald-300'
  return 'text-slate-700 dark:text-slate-200'
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-4 w-4 ${spinning ? 'animate-spin motion-reduce:animate-none' : ''}`} fill="none">
      <path d="M15.2 7.1A5.8 5.8 0 1 0 15 13.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M15.2 3.8v3.5h-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <circle cx="8.5" cy="8.5" r="4.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="m12 12 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function Metric({ label, value, detail, tone = 'normal' }: {
  label: string
  value: string
  detail: string
  tone?: 'normal' | 'positive' | 'negative'
}): React.ReactElement {
  const valueClass = tone === 'positive'
    ? 'text-red-600 dark:text-red-300'
    : tone === 'negative'
      ? 'text-emerald-600 dark:text-emerald-300'
      : 'text-slate-950 dark:text-slate-50'
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-0.5 truncate text-[10px] text-slate-400" title={detail}>{detail}</div>
    </div>
  )
}

export function BacktestModal({ open, onClose }: Props): React.ReactElement | null {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const requestIdRef = useRef(0)
  const rangeRef = useRef<number>(30)
  const [range, setRange] = useState<number>(30)
  const [horizon, setHorizon] = useState<AuctionBacktestHorizon>(1)
  const [poolFilter, setPoolFilter] = useState<AuctionBacktestPool | 'all'>('all')
  const [sortMode, setSortMode] = useState<AuctionBacktestSortMode>('date')
  const [searchQuery, setSearchQuery] = useState('')
  const [excludeOneWord, setExcludeOneWord] = useState(true)
  const [detailView, setDetailView] = useState<'samples' | 'environment'>('samples')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [details, setDetails] = useState<AuctionBacktestDetail[]>([])
  const [computedDates, setComputedDates] = useState<string[]>([])
  const [tradeDates, setTradeDates] = useState<string[]>([])
  const [latestCloseTradeDate, setLatestCloseTradeDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ pct: number; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [clickedStock, setClickedStock] = useState<{ tsCode: string; stockCode: string; stockName: string } | null>(null)

  rangeRef.current = range

  const loadData = useCallback(async (rangeValue: number): Promise<void> => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)
    try {
      const status = await window.api.shortTerm.backtestGetStatus()
      if (requestId !== requestIdRef.current) return
      setRunning(status.running)
      setComputedDates(status.computedDates)
      setLatestCloseTradeDate(status.latestCloseTradeDate ?? null)

      let dates = await window.api.tradeCal.getLastNTradingDays(rangeValue)
      if (dates.length === 0) dates = status.computedDates.slice(-rangeValue)
      if (requestId !== requestIdRef.current) return
      setTradeDates(dates)
      const startDate = dates[0] ?? daysAgoYmd(rangeValue * 2)
      const endDate = dates[dates.length - 1] ?? daysAgoYmd(0)
      const response = await window.api.shortTerm.backtestGetDetails(startDate, endDate)
      if (requestId !== requestIdRef.current) return
      if (!response.ok) {
        setError('回测区间无效，请切换观察范围后重试。')
        return
      }
      setDetails(response.details)
    } catch (reason) {
      if (requestId !== requestIdRef.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void loadData(range)
  }, [loadData, open, range])

  useEffect(() => {
    if (!open) return
    const cleanup = window.api.shortTerm.onBacktestProgress((next) => {
      if (next.pct < 0) {
        setRunning(false)
        setProgress(null)
        setError(next.message.replace(/^\s*计算失败\s*:\s*/, '补齐失败：'))
        return
      }
      setProgress(next)
      if (next.pct >= 100) {
        setRunning(false)
        setProgress(null)
        void loadData(rangeRef.current)
      }
    })
    return cleanup
  }, [loadData, open])

  useEffect(() => {
    if (!open) setClickedStock(null)
  }, [open])

  useEffect(() => setVisibleCount(PAGE_SIZE), [excludeOneWord, horizon, poolFilter, searchQuery, sortMode])

  const handleRun = useCallback(async (): Promise<void> => {
    if (running) return
    setError(null)
    setRunning(true)
    setProgress({ pct: 0, message: `正在准备补齐近 ${rangeRef.current} 个交易日…` })
    try {
      const response = await window.api.shortTerm.backtestRun({ days: rangeRef.current, force: false })
      if (response.ok) return
      if (response.error === 'JOB_RUNNING') {
        setProgress({ pct: 0, message: '已有历史补齐任务运行中，完成后将自动刷新。' })
        return
      }
      setRunning(false)
      setProgress(null)
      setError('Tushare 尚未启用，无法补齐缺失的精确 9:25 竞价与日线历史。')
    } catch (reason) {
      setRunning(false)
      setProgress(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [running])

  const context = useMemo(() => ({ tradeDates, latestCloseTradeDate }), [latestCloseTradeDate, tradeDates])
  const poolSummaries = useMemo(
    () => buildAuctionBacktestPoolSummaries(details, horizon, excludeOneWord, context),
    [context, details, excludeOneWord, horizon],
  )
  const conclusion = useMemo(() => buildAuctionBacktestConclusion(poolSummaries, horizon), [horizon, poolSummaries])
  const selectedRows = useMemo(
    () => details.filter((row) => (poolFilter === 'all' || row.pool === poolFilter) && (!excludeOneWord || row.isOneWord !== 1)),
    [details, excludeOneWord, poolFilter],
  )
  const selectedSummary = useMemo(
    () => buildAuctionBacktestSummary(selectedRows, horizon, context),
    [context, horizon, selectedRows],
  )
  const path = useMemo(() => buildAuctionBacktestPath(selectedRows), [selectedRows])
  const environments = useMemo(
    () => buildAuctionBacktestEnvironmentSummaries(selectedRows, horizon, context),
    [context, horizon, selectedRows],
  )
  const filteredDetails = useMemo(
    () => filterAuctionBacktestDetails(details, {
      pool: poolFilter,
      excludeOneWord,
      query: searchQuery,
      sortMode,
      horizon,
    }),
    [details, excludeOneWord, horizon, poolFilter, searchQuery, sortMode],
  )
  const visibleDetails = filteredDetails.slice(0, visibleCount)
  const excludedCount = details.filter((row) => row.isOneWord === 1).length
  const selectedPoolLabel = poolFilter === 'all' ? '全部信号池' : AUCTION_BACKTEST_POOL_LABEL[poolFilter]
  const conclusionClass = conclusion.tone === 'positive'
    ? 'border-red-200 bg-red-50/65 dark:border-red-900 dark:bg-red-950/20'
    : conclusion.tone === 'caution'
      ? 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20'
      : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60'

  const openStock = (detail: AuctionBacktestDetail): void => {
    const stockCode = detail.tsCode.split('.')[0]
    setClickedStock({
      tsCode: detail.tsCode,
      stockCode,
      stockName: detail.stockName || stockCode,
    })
  }

  const closeDrawer = (): void => {
    setClickedStock(null)
    onClose()
  }

  return (
    <>
      <RightDrawer
        open={open}
        title="竞价信号历史表现"
        description={`以信号日 9:25 竞价撮合价为观察起点，对比后续第 N 个交易日收盘收益与指数收盘口径基准。日线截止 ${formatTradeDate(latestCloseTradeDate)}。`}
        actions={(
          <button
            type="button"
            data-testid="auction-backtest-sync"
            disabled={running}
            onClick={() => void handleRun()}
            className="flex h-11 items-center gap-2 rounded-md bg-cyan-700 px-3.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-cyan-800 active:bg-cyan-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/35 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            <RefreshIcon spinning={running} />
            {running ? '补齐中' : '补齐当前范围'}
          </button>
        )}
        onClose={closeDrawer}
        defaultWidth={1220}
        minWidth={760}
        maxWidth={1400}
        testId="auction-backtest-drawer"
        bodyClassName="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-0 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
      >
        <div className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 px-5 py-3 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-950/95">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <span className="mb-1.5 block text-[11px] font-medium text-slate-500 dark:text-slate-400">观察范围</span>
              <div className="flex rounded-md bg-slate-100 p-1 dark:bg-slate-900" role="group" aria-label="回测交易日范围">
                {RANGE_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`auction-backtest-range-${value}`}
                    aria-pressed={range === value}
                    onClick={() => setRange(value)}
                    className={`h-9 min-w-14 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${range === value ? 'bg-white text-cyan-800 shadow-sm dark:bg-slate-800 dark:text-cyan-200' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}
                  >
                    {value}日
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="mb-1.5 block text-[11px] font-medium text-slate-500 dark:text-slate-400">观察周期</span>
              <div className="flex rounded-md bg-slate-100 p-1 dark:bg-slate-900" role="group" aria-label="收益观察周期">
                {HORIZON_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`auction-backtest-horizon-${value}`}
                    aria-pressed={horizon === value}
                    onClick={() => setHorizon(value)}
                    className={`h-9 min-w-12 rounded px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${horizon === value ? 'bg-white text-cyan-800 shadow-sm dark:bg-slate-800 dark:text-cyan-200' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'}`}
                  >
                    T+{value}
                  </button>
                ))}
              </div>
            </div>
            <label className="min-w-[210px] flex-1 lg:max-w-[280px]">
              <span className="mb-1.5 block text-[11px] font-medium text-slate-500 dark:text-slate-400">信号池</span>
              <ResearchCombobox
                value={poolFilter}
                options={POOL_OPTIONS}
                placeholder="选择信号池"
                searchPlaceholder="搜索信号池"
                testId="auction-backtest-pool"
                disabled={loading}
                onChange={(value) => setPoolFilter(value as AuctionBacktestPool | 'all')}
              />
            </label>
            <button
              type="button"
              data-testid="auction-backtest-exclude-one-word"
              role="switch"
              aria-checked={excludeOneWord}
              onClick={() => setExcludeOneWord((current) => !current)}
              className="flex h-10 items-center gap-2 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:border-cyan-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
            >
              <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${excludeOneWord ? 'bg-cyan-700' : 'bg-slate-300 dark:bg-slate-700'}`} aria-hidden="true">
                <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${excludeOneWord ? 'translate-x-4' : 'translate-x-0'}`} />
              </span>
              排除一字板
              <span className="tabular-nums text-slate-400">{excludedCount}</span>
            </button>
            <div className="ml-auto text-right text-[10px] leading-5 text-slate-400">
              <div>{computedDates.length} 个历史信号日</div>
              <div className="tabular-nums">{tradeDates.length ? `${formatTradeDate(tradeDates[0])} 至 ${formatTradeDate(tradeDates.at(-1) ?? null)}` : '当前范围无交易日'}</div>
            </div>
          </div>
        </div>

        {(progress || (running && !progress)) && (
          <div className="border-b border-cyan-200 bg-cyan-50 px-5 py-2.5 dark:border-cyan-900 dark:bg-cyan-950/25" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-4 text-xs text-cyan-900 dark:text-cyan-100">
              <span>{progress?.message ?? '历史补齐任务正在运行。'}</span>
              <span className="shrink-0 font-mono tabular-nums">{progress && progress.pct > 0 ? `${Math.min(100, progress.pct)}%` : '处理中'}</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-cyan-100 dark:bg-cyan-950">
              <div
                className={`h-full bg-cyan-600 transition-[width] duration-300 motion-reduce:transition-none ${!progress || progress.pct === 0 ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''}`}
                style={progress && progress.pct > 0 ? { width: `${Math.min(100, progress.pct)}%` } : undefined}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-between gap-4 border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/25 dark:text-red-200" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => void loadData(range)} className="h-9 shrink-0 rounded-md border border-red-300 px-3 font-semibold hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 dark:border-red-800 dark:hover:bg-red-950">重新读取</button>
          </div>
        )}

        <section className={`border-b px-5 py-4 ${conclusionClass}`} data-testid="auction-backtest-conclusion">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-3xl">
              <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">回测结论 · T+{horizon}</div>
              <h2 className="mt-1 text-base font-semibold text-slate-950 dark:text-slate-50">{conclusion.title}</h2>
              <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{conclusion.detail}</p>
            </div>
            <div className="shrink-0 rounded-md border border-slate-200/80 bg-white/75 px-3 py-2 text-right text-[10px] leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-400">
              <div>{selectedPoolLabel}</div>
              <div className="tabular-nums">完整度 {selectedSummary.coverageRate == null ? '--' : `${Math.round(selectedSummary.coverageRate * 100)}%`}</div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 divide-x divide-y divide-slate-200 border-t border-slate-200 sm:grid-cols-5 sm:divide-y-0 dark:divide-slate-800 dark:border-slate-800">
            <Metric label="成熟样本" value={`${selectedSummary.validCount}`} detail={`共 ${selectedSummary.signalCount} 条可执行信号`} />
            <Metric label="胜率" value={selectedSummary.winRate == null ? '--' : `${selectedSummary.winRate.toFixed(1)}%`} detail="收益大于 0 的样本占比" />
            <Metric label="平均收益" value={formatSignedPct(selectedSummary.avgReturn)} detail={`T+${horizon} 收盘相对竞价价`} tone={(selectedSummary.avgReturn ?? 0) > 0 ? 'positive' : (selectedSummary.avgReturn ?? 0) < 0 ? 'negative' : 'normal'} />
            <Metric label="平均超额" value={formatSignedPct(selectedSummary.avgAlpha)} detail="减去同期对应基准" tone={(selectedSummary.avgAlpha ?? 0) > 0 ? 'positive' : (selectedSummary.avgAlpha ?? 0) < 0 ? 'negative' : 'normal'} />
            <Metric label="未形成结果" value={`${selectedSummary.pendingCount + selectedSummary.missingCount}`} detail={`待到期 ${selectedSummary.pendingCount} · 缺日线 ${selectedSummary.missingCount}`} />
          </div>
        </section>

        <div className="grid border-b border-slate-200 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)] dark:border-slate-800">
          <section className="min-w-0 px-5 py-4 xl:border-r xl:border-slate-200 dark:xl:border-slate-800">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">信号池比较</h3>
                <p className="mt-0.5 text-[10px] text-slate-400">只使用已成熟、可执行的 T+{horizon} 样本</p>
              </div>
              {poolFilter !== 'all' && <button type="button" onClick={() => setPoolFilter('all')} className="h-9 rounded px-2.5 text-xs font-medium text-cyan-700 hover:bg-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:text-cyan-300 dark:hover:bg-cyan-950/30">恢复全部</button>}
            </div>
            <div className="overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
              {poolSummaries.map((summary) => {
                const active = poolFilter === summary.pool
                const noExecutable = summary.signalCount === 0 && summary.excludedOneWordCount > 0
                return (
                  <button
                    key={summary.pool}
                    type="button"
                    data-testid={`auction-backtest-pool-summary-${summary.pool}`}
                    aria-pressed={active}
                    onClick={() => setPoolFilter(active ? 'all' : summary.pool)}
                    className={`grid min-h-14 w-full grid-cols-[minmax(120px,1fr)_72px_88px_88px] items-center gap-3 border-b border-slate-100 px-3 text-left text-xs transition-colors last:border-b-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:border-slate-800 dark:hover:bg-slate-900 ${active ? 'bg-cyan-50/70 dark:bg-cyan-950/25' : ''}`}
                  >
                    <span className="min-w-0">
                      <strong className="block truncate text-slate-800 dark:text-slate-100">{AUCTION_BACKTEST_POOL_LABEL[summary.pool]}</strong>
                      <span className="mt-0.5 block truncate text-[10px] text-slate-400">
                        {noExecutable
                          ? `${summary.excludedOneWordCount} 条均为一字板，已排除`
                          : `${summary.validCount}/${summary.signalCount} 成熟样本${summary.missingCount ? ` · ${summary.missingCount} 缺口` : ''}`}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block text-[10px] text-slate-400">胜率</span>
                      <strong className="mt-0.5 block tabular-nums text-slate-800 dark:text-slate-100">{summary.winRate == null ? '--' : `${summary.winRate.toFixed(1)}%`}</strong>
                    </span>
                    <span className="text-right">
                      <span className="block text-[10px] text-slate-400">平均收益</span>
                      <strong className={`mt-0.5 block tabular-nums ${valueTone(summary.avgReturn)}`}>{formatSignedPct(summary.avgReturn)}</strong>
                    </span>
                    <span className="text-right">
                      <span className="block text-[10px] text-slate-400">平均超额</span>
                      <strong className={`mt-0.5 block tabular-nums ${valueTone(summary.avgAlpha)}`}>{formatSignedPct(summary.avgAlpha)}</strong>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="min-w-0 px-5 py-4">
            <div className="mb-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">平均收益路径</h3>
              <p className="mt-0.5 text-[10px] text-slate-400">{selectedPoolLabel} · 各周期独立成熟样本</p>
            </div>
            <div className="h-[210px] w-full" data-testid="auction-backtest-path-chart" aria-label={`${selectedPoolLabel}平均收益与超额收益路径`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={path} margin={{ top: 12, right: 12, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 4" stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                  <YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => `${value}%`} stroke="#94a3b8" width={48} />
                  <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
                  <Tooltip
                    formatter={(value, name) => [typeof value === 'number' ? formatSignedPct(value) : '--', name === 'avgReturn' ? '平均收益' : '平均超额']}
                    labelFormatter={(label) => `${label} 观察`}
                    contentStyle={{ borderRadius: 6, borderColor: '#334155', background: '#0f172a', color: '#f8fafc', fontSize: 12 }}
                  />
                  <Line type="monotone" dataKey="avgReturn" name="avgReturn" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="avgAlpha" name="avgAlpha" stroke="#0891b2" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 flex items-center gap-4 text-[10px] text-slate-500 dark:text-slate-400">
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 bg-red-600" />平均收益</span>
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 border-t-2 border-dashed border-cyan-600" />平均超额</span>
            </div>
          </section>
        </div>

        <section className="bg-white dark:bg-slate-950">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
            <div className="flex rounded-md bg-slate-100 p-1 dark:bg-slate-900" role="tablist" aria-label="回测详情视图">
              <button type="button" data-testid="auction-backtest-tab-samples" role="tab" aria-selected={detailView === 'samples'} onClick={() => setDetailView('samples')} className={`h-9 rounded px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${detailView === 'samples' ? 'bg-white text-cyan-800 shadow-sm dark:bg-slate-800 dark:text-cyan-200' : 'text-slate-500 dark:text-slate-400'}`}>样本明细</button>
              <button type="button" data-testid="auction-backtest-tab-environment" role="tab" aria-selected={detailView === 'environment'} onClick={() => setDetailView('environment')} className={`h-9 rounded px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${detailView === 'environment' ? 'bg-white text-cyan-800 shadow-sm dark:bg-slate-800 dark:text-cyan-200' : 'text-slate-500 dark:text-slate-400'}`}>市场环境</button>
            </div>
            {detailView === 'samples' && (
              <>
                <label className="relative min-w-[220px] flex-1 lg:max-w-sm">
                  <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400"><SearchIcon /></span>
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="搜索代码或名称"
                    aria-label="搜索回测样本"
                    className="h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm outline-none transition-colors hover:border-cyan-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-950 dark:hover:border-cyan-600"
                  />
                </label>
                <div className="min-w-[220px]">
                  <ResearchCombobox
                    value={sortMode}
                    options={SORT_OPTIONS}
                    placeholder="选择排序"
                    searchPlaceholder="搜索排序方式"
                    testId="auction-backtest-sort"
                    onChange={(value) => setSortMode(value as AuctionBacktestSortMode)}
                  />
                </div>
              </>
            )}
            <span className="ml-auto text-[11px] tabular-nums text-slate-400">{detailView === 'samples' ? `${filteredDetails.length} 条` : `${environments.reduce((sum, item) => sum + item.signalCount, 0)} 条有环境事实`}</span>
          </div>

          {loading && details.length === 0 ? (
            <div className="grid min-h-72 place-items-center text-sm text-slate-400" role="status">正在读取本地回测事实…</div>
          ) : detailView === 'environment' ? (
            <div className="px-5 py-4">
              <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-800">
                <div className="grid grid-cols-[minmax(150px,1fr)_90px_90px_100px_100px] gap-3 bg-slate-50 px-4 py-2 text-[10px] font-medium text-slate-400 dark:bg-slate-900">
                  <span>市场环境</span><span className="text-right">成熟样本</span><span className="text-right">胜率</span><span className="text-right">平均收益</span><span className="text-right">平均超额</span>
                </div>
                {environments.map((item) => (
                  <div key={item.key} className="grid min-h-16 grid-cols-[minmax(150px,1fr)_90px_90px_100px_100px] items-center gap-3 border-t border-slate-100 px-4 text-xs dark:border-slate-800">
                    <span><strong className="block text-slate-800 dark:text-slate-100">{item.label}</strong><span className="mt-0.5 block text-[10px] text-slate-400">{item.threshold}</span></span>
                    <span className="text-right tabular-nums">{item.validCount}/{item.signalCount}</span>
                    <span className="text-right font-medium tabular-nums">{item.winRate == null ? '--' : `${item.winRate.toFixed(1)}%`}</span>
                    <span className={`text-right font-medium tabular-nums ${valueTone(item.avgReturn)}`}>{formatSignedPct(item.avgReturn)}</span>
                    <span className={`text-right font-medium tabular-nums ${valueTone(item.avgAlpha)}`}>{formatSignedPct(item.avgAlpha)}</span>
                  </div>
                ))}
              </div>
              {environments.every((item) => item.signalCount === 0) && <div className="py-12 text-center text-xs text-slate-400">当前范围没有可用的基准当日涨跌事实。</div>}
            </div>
          ) : filteredDetails.length === 0 ? (
            <div className="grid min-h-72 place-items-center px-6 text-center">
              <div>
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200">{details.length === 0 ? '当前范围还没有竞价回测信号' : '当前筛选条件没有匹配样本'}</div>
                <div className="mt-1 text-xs text-slate-400">{details.length === 0 ? '补齐当前范围后会重新读取本地结果。' : '请调整信号池、搜索或一字板口径。'}</div>
              </div>
            </div>
          ) : (
            <>
              <div
                className="max-h-[58vh] overflow-auto"
                data-testid="auction-backtest-sample-scroll"
              >
                <table className="w-full min-w-[860px] text-xs">
                  <thead
                    className="sticky top-0 z-20 bg-slate-50 text-[10px] font-medium text-slate-400 shadow-[0_1px_0_rgba(148,163,184,0.22)] dark:bg-slate-900"
                    data-testid="auction-backtest-sample-header"
                  >
                    <tr>
                      <th className="px-4 py-2.5 text-left">信号日</th>
                      <th className="px-3 py-2.5 text-left">股票</th>
                      <th className="px-3 py-2.5 text-left">信号池</th>
                      <th className="px-3 py-2.5 text-right">竞价撮合价</th>
                      <th className="px-3 py-2.5 text-right">T+{horizon} 收益</th>
                      <th className="px-3 py-2.5 text-right">超额收益</th>
                      <th className="px-4 py-2.5 text-right">样本状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDetails.map((detail) => {
                      const availability = getAuctionBacktestAvailability(detail, horizon, context)
                      const value = getAuctionBacktestReturn(detail, horizon)
                      const alpha = getAuctionBacktestAlpha(detail, horizon)
                      return (
                        <tr
                          key={`${detail.tradeDate}-${detail.tsCode}-${detail.pool}`}
                          data-testid={`auction-backtest-sample-${detail.tradeDate}-${detail.tsCode.split('.')[0]}-${detail.pool}`}
                          tabIndex={0}
                          onDoubleClick={() => openStock(detail)}
                          onKeyDown={(event) => { if (event.key === 'Enter') openStock(detail) }}
                          className="border-t border-slate-100 outline-none transition-colors hover:bg-cyan-50/50 focus:bg-cyan-50 focus:ring-2 focus:ring-inset focus:ring-cyan-500 dark:border-slate-900 dark:hover:bg-cyan-950/15 dark:focus:bg-cyan-950/25"
                        >
                          <td className="whitespace-nowrap px-4 py-2.5 font-mono tabular-nums text-slate-500 dark:text-slate-400">{formatTradeDate(detail.tradeDate)}</td>
                          <td className="px-3 py-2.5"><strong className="block text-slate-800 dark:text-slate-100">{detail.stockName || detail.tsCode.split('.')[0]}</strong><span className="mt-0.5 block font-mono text-[10px] text-slate-400">{detail.tsCode}{detail.isOneWord === 1 ? ' · 一字板' : ''}</span></td>
                          <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300">{AUCTION_BACKTEST_POOL_LABEL[detail.pool]}</td>
                          <td className="px-3 py-2.5 text-right font-mono tabular-nums">{detail.buyPrice?.toFixed(2) ?? '--'}</td>
                          <td className={`px-3 py-2.5 text-right font-semibold tabular-nums ${valueTone(value)}`}>{formatSignedPct(value)}</td>
                          <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${valueTone(alpha)}`}>{formatSignedPct(alpha)}</td>
                          <td className="px-4 py-2.5 text-right">
                            <span className={`inline-flex min-h-6 items-center rounded border px-2 text-[10px] font-medium ${availability === 'available' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300' : availability === 'pending' ? 'border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300'}`}>{availability === 'available' ? '已成熟' : availability === 'pending' ? '待到期' : '缺日线'}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {visibleCount < filteredDetails.length && (
                <div className="border-t border-slate-100 px-5 py-3 text-center dark:border-slate-800">
                  <button type="button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)} className="h-10 rounded-md border border-slate-300 px-4 text-xs font-medium text-slate-600 hover:border-cyan-400 hover:text-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:text-slate-300 dark:hover:border-cyan-600 dark:hover:text-cyan-200">加载更多（{filteredDetails.length - visibleCount} 条）</button>
                </div>
              )}
            </>
          )}

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 text-[10px] leading-5 text-slate-400 dark:border-slate-800">
            <span>胜率与均值只计入已成熟收益；待到期和缺日线分开披露。</span>
            <span>超额收益 = 个股收益 - 同期对应基准收益</span>
          </footer>
        </section>
      </RightDrawer>

      {open && clickedStock && (
        <StockKlineChipDrawer
          tsCode={clickedStock.tsCode}
          stockName={clickedStock.stockName}
          zIndex={10020}
          onClose={() => setClickedStock(null)}
          onNavigate={() => {
            navigateToStock(clickedStock.stockCode, clickedStock.stockName)
            closeDrawer()
          }}
        />
      )}
    </>
  )
}
