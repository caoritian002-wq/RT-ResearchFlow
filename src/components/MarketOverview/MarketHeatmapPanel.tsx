import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import {
  getBeijingDateValue,
  ResearchDatePicker,
} from '../IndustryResearch/ResearchDecisionControls'

type BenchmarkKey = 'shanghai' | 'csi300' | 'chinext'
type ResonanceState =
  | 'leading_sync'
  | 'synchronized'
  | 'falling_sync'
  | 'defensive'
  | 'lagging'
  | 'diverging'
  | 'weak'
  | 'insufficient'
type ViewFilter = 'focus' | 'defensive' | 'risk' | 'all'
type IndustryStructureState =
  | 'broad_strength'
  | 'concentrated_lead'
  | 'divergent'
  | 'broad_weakness'
  | 'insufficient'

interface DistributionBin {
  label: string
  count: number
  isPositive: boolean | null
}

interface TimelinePoint {
  time: string
  limitUp: number
  limitDown: number
}

interface TrendPoint {
  time: string
  change: number
}

interface ResonanceMetric {
  sampleCount: number
  correlation: number | null
  directionAgreement: number | null
  recentAgreement: number | null
  excessReturn: number
  sectorReturn: number
  benchmarkReturn: number
  lagMinutes: number | null
  score: number
  state: ResonanceState
}

interface ResonanceBenchmark {
  key: BenchmarkKey
  code: string
  name: string
  tradeDate: string
  change: number
  points: TrendPoint[]
}

interface ResonanceSector {
  boardCode: string
  code: string
  name: string
  tradeDate: string
  change: number
  points: TrendPoint[]
  breadthRate: number | null
  upCount: number | null
  downCount: number | null
  flatCount: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
  structure: IndustryStructure
  metrics: Record<BenchmarkKey, ResonanceMetric>
}

interface IndustryStructure {
  state: IndustryStructureState
  available: number
  total: number
  leaders: string[]
  laggards: string[]
  summary: string
}

interface ResonanceIndustryChild {
  boardCode: string
  name: string
  tradeDate: string
  change: number
  excessVsParent: number | null
  breadthRate: number | null
  upCount: number | null
  downCount: number | null
  flatCount: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
  points: TrendPoint[]
}

interface ResonanceIndustryChildren {
  tradeDate: string
  parentIndustryCode: string
  parentIndustryName: string
  factSource: 'local_archive' | 'current_network'
  structure: IndustryStructure
  trendCoverage: { available: number; total: number }
  children: ResonanceIndustryChild[]
}

interface MarketOverviewSnapshot {
  distribution: DistributionBin[]
  timeline: TimelinePoint[]
  generatedAt: number
  coverage: {
    distribution: { available: boolean; sampleCount: number }
    timeline: { mode: 'exact' | 'approximate' | 'missing'; pointCount: number }
  }
  resonance: {
    tradeDate: string
    dataMode: 'realtime' | 'archive' | 'partial'
    sourceMode: 'realtime' | 'local_archive' | 'network_backfill'
    sourceLabel: string
    generatedAt: number
    coverage: {
      available: number
      total: number
      benchmarkTrends: { available: number; total: number }
      sectorTrends: { available: number; total: number }
      boardFacts: { available: number; total: number }
    }
    benchmarks: ResonanceBenchmark[]
    sectors: ResonanceSector[]
  }
  navigation: {
    selectedTradeDate: string
    previousTradeDate: string | null
    nextTradeDate: string | null
    latestTradeDate: string
  }
  quality: {
    status: 'complete' | 'partial'
    missingParts: Array<
      | 'benchmark_trends'
      | 'sector_trends'
      | 'board_facts'
      | 'distribution'
      | 'timeline'
      | 'timeline_approximate'
    >
  }
}

interface SnapshotRequest {
  tradeDate?: string
  forceRefresh?: boolean
}

interface RefreshAttempt {
  status: 'idle' | 'running' | 'failed' | 'retained'
  operation: '加载' | '切换' | '刷新' | '补采'
  message?: string
}

const BENCHMARK_LABELS: Record<BenchmarkKey, string> = {
  shanghai: '上证指数',
  csi300: '沪深300',
  chinext: '创业板指',
}

const STATE_META: Record<ResonanceState, { label: string; className: string }> = {
  leading_sync: {
    label: '共振领涨',
    className: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  },
  synchronized: {
    label: '同步跟随',
    className: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300',
  },
  falling_sync: {
    label: '共振走弱',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  defensive: {
    label: '逆势抗跌',
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  },
  lagging: {
    label: '明显掉队',
    className: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950/40 dark:text-orange-300',
  },
  diverging: {
    label: '走势背离',
    className: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
  },
  weak: {
    label: '关系较弱',
    className: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300',
  },
  insufficient: {
    label: '样本不足',
    className: 'border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400',
  },
}

const STRUCTURE_META: Record<IndustryStructureState, { label: string; className: string }> = {
  broad_strength: {
    label: '普遍走强',
    className: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  },
  concentrated_lead: {
    label: '集中领涨',
    className: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  },
  divergent: {
    label: '内部分化',
    className: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300',
  },
  broad_weakness: {
    label: '普遍走弱',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  },
  insufficient: {
    label: '证据不足',
    className: 'border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400',
  },
}

export function MarketHeatmapPanel() {
  const [snapshot, setSnapshot] = useState<MarketOverviewSnapshot | null>(null)
  const [benchmarkKey, setBenchmarkKey] = useState<BenchmarkKey>('shanghai')
  const [viewFilter, setViewFilter] = useState<ViewFilter>('all')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [expandedParentCode, setExpandedParentCode] = useState<string | null>(null)
  const [childrenResult, setChildrenResult] = useState<ResonanceIndustryChildren | null>(null)
  const [childrenLoadingCode, setChildrenLoadingCode] = useState<string | null>(null)
  const [childrenError, setChildrenError] = useState('')
  const [selectedChildCode, setSelectedChildCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initialError, setInitialError] = useState('')
  const [refreshAttempt, setRefreshAttempt] = useState<RefreshAttempt>({ status: 'idle', operation: '加载' })
  const requestSequenceRef = useRef(0)
  const childrenRequestSequenceRef = useRef(0)
  const retryRequestRef = useRef<SnapshotRequest>({ forceRefresh: true })
  const workbenchRef = useRef<HTMLDivElement | null>(null)
  const snapshotRef = useRef<MarketOverviewSnapshot | null>(null)

  const loadSnapshot = useCallback(async (request: SnapshotRequest = {}) => {
    const requestSequence = requestSequenceRef.current + 1
    requestSequenceRef.current = requestSequence
    retryRequestRef.current = { ...request, forceRefresh: true }
    const displayedSnapshot = snapshotRef.current
    const displayedHistorical = Boolean(
      displayedSnapshot
      && (
        displayedSnapshot.resonance.sourceMode !== 'realtime'
        || displayedSnapshot.navigation.selectedTradeDate !== displayedSnapshot.navigation.latestTradeDate
      ),
    )
    const operation = request.forceRefresh
      ? displayedHistorical ? '补采' : '刷新'
      : request.tradeDate ? '切换' : displayedSnapshot ? '刷新' : '加载'
    setLoading(true)
    setRefreshAttempt({ status: 'running', operation })
    try {
      const response = await window.api.market.getMarketOverview(request)
      if (requestSequence !== requestSequenceRef.current) return
      if (!response.ok) {
        if (displayedSnapshot) {
          setRefreshAttempt({
            status: 'failed',
            operation,
            message: buildRefreshFailureMessage(operation, response.error, displayedSnapshot),
          })
        } else {
          setInitialError(response.error)
          setRefreshAttempt({ status: 'idle', operation })
        }
        return
      }
      const next = response.snapshot as MarketOverviewSnapshot
      snapshotRef.current = next
      setSnapshot(next)
      childrenRequestSequenceRef.current += 1
      setExpandedParentCode(null)
      setChildrenResult(null)
      setChildrenLoadingCode(null)
      setChildrenError('')
      setSelectedChildCode(null)
      setInitialError('')
      if (request.forceRefresh && next.resonance.sourceMode === 'local_archive') {
        setRefreshAttempt({
          status: 'retained',
          operation,
          message: '本次补采没有取得覆盖更完整的数据，继续展示现有本地快照。',
        })
      } else {
        setRefreshAttempt({ status: 'idle', operation })
      }
      setSelectedCode((current) => current && next.resonance.sectors.some((sector) => sector.boardCode === current)
        ? current
        : pickDefaultSector(next.resonance.sectors, 'shanghai')?.boardCode ?? null)
      if (request.tradeDate) workbenchRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    } catch {
      if (requestSequence !== requestSequenceRef.current) return
      const message = '指数与行业分时数据暂不可用，请稍后重试。'
      if (displayedSnapshot) {
        setRefreshAttempt({
          status: 'failed',
          operation,
          message: buildRefreshFailureMessage(operation, message, displayedSnapshot),
        })
      } else {
        setInitialError(message)
        setRefreshAttempt({ status: 'idle', operation })
      }
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot()
  }, [loadSnapshot])

  const selectedTradeDate = snapshot?.navigation.selectedTradeDate ?? null
  const latestTradeDate = snapshot?.navigation.latestTradeDate ?? null
  const resonanceSourceMode = snapshot?.resonance.sourceMode ?? null

  useEffect(() => {
    if (!selectedTradeDate || !latestTradeDate || !resonanceSourceMode) return
    // 仅最新实时视图轮询; 历史选中日与本地存档/补采结果都停止 60 秒刷新
    const isLatestRealtime = resonanceSourceMode === 'realtime'
      && selectedTradeDate === latestTradeDate
    if (!isLatestRealtime) return
    const timer = setInterval(() => {
      void loadSnapshot({ tradeDate: selectedTradeDate })
    }, 60_000)
    return () => clearInterval(timer)
  }, [latestTradeDate, loadSnapshot, resonanceSourceMode, selectedTradeDate])

  const benchmark = snapshot?.resonance.benchmarks.find((item) => item.key === benchmarkKey) ?? null
  const allSectors = useMemo(
    () => snapshot?.resonance.sectors ?? [],
    [snapshot?.resonance.sectors],
  )
  const orderedSectors = useMemo(
    () => sortSectors(allSectors, benchmarkKey, viewFilter),
    [allSectors, benchmarkKey, viewFilter],
  )
  const viewFilterOptions = useMemo<Array<{ key: ViewFilter; label: string; count: number }>>(() => ([
    { key: 'all', label: '全部行业', count: allSectors.length },
    { key: 'focus', label: '共振/同步', count: countSectorsByFilter(allSectors, benchmarkKey, 'focus') },
    { key: 'defensive', label: '逆势抗跌', count: countSectorsByFilter(allSectors, benchmarkKey, 'defensive') },
    { key: 'risk', label: '背离转弱', count: countSectorsByFilter(allSectors, benchmarkKey, 'risk') },
  ]), [allSectors, benchmarkKey])
  const selectedSector = allSectors.find((sector) => sector.boardCode === selectedCode)
    ?? pickDefaultSector(allSectors, benchmarkKey)
    ?? null
  const selectedChild = childrenResult && childrenResult.tradeDate === snapshot?.navigation.selectedTradeDate
    ? childrenResult.children.find((child) => child.boardCode === selectedChildCode) ?? null
    : null
  const selectedChildParent = selectedChild
    ? allSectors.find((sector) => sector.boardCode === childrenResult?.parentIndustryCode) ?? null
    : null
  const selectedMetric = selectedSector?.metrics[benchmarkKey] ?? null
  const marketPulse = useMemo(() => buildMarketPulse(snapshot), [snapshot])
  const summary = useMemo(() => buildSummary(allSectors, benchmarkKey, benchmark), [allSectors, benchmarkKey, benchmark])
  const hasComparableSectors = allSectors.some((sector) => sector.metrics[benchmarkKey].state !== 'insufficient')
  const isHistoricalView = Boolean(
    snapshot
    && (
      snapshot.resonance.sourceMode !== 'realtime'
      || snapshot.navigation.selectedTradeDate !== snapshot.navigation.latestTradeDate
    ),
  )

  useEffect(() => {
    const current = selectedCode ? allSectors.find((sector) => sector.boardCode === selectedCode) : null
    const next = pickDefaultSector(allSectors, benchmarkKey)
    if (current?.boardCode === next?.boardCode) return
    if (current?.metrics[benchmarkKey].state !== 'insufficient') return
    setSelectedCode(next?.boardCode ?? null)
  }, [allSectors, benchmarkKey, selectedCode])

  useEffect(() => {
    if (allSectors.length > 0 && !hasComparableSectors) setViewFilter('all')
  }, [allSectors.length, benchmarkKey, hasComparableSectors])

  useEffect(() => {
    if (!expandedParentCode) return
    if (orderedSectors.some((sector) => sector.boardCode === expandedParentCode)) return
    childrenRequestSequenceRef.current += 1
    setExpandedParentCode(null)
    setChildrenLoadingCode(null)
    setChildrenError('')
    setSelectedChildCode(null)
  }, [expandedParentCode, orderedSectors])

  const toggleIndustryChildren = async (sector: ResonanceSector, forceRefresh = false) => {
    const currentSnapshot = snapshotRef.current
    if (!currentSnapshot) return
    if (!forceRefresh && expandedParentCode === sector.boardCode) {
      childrenRequestSequenceRef.current += 1
      setExpandedParentCode(null)
      setChildrenLoadingCode(null)
      setChildrenError('')
      setSelectedChildCode(null)
      return
    }
    setExpandedParentCode(sector.boardCode)
    setSelectedCode(sector.boardCode)
    setSelectedChildCode(null)
    setChildrenError('')
    if (
      !forceRefresh
      && childrenResult?.tradeDate === currentSnapshot.navigation.selectedTradeDate
      && childrenResult.parentIndustryCode === sector.boardCode
    ) return

    const requestSequence = childrenRequestSequenceRef.current + 1
    childrenRequestSequenceRef.current = requestSequence
    setChildrenLoadingCode(sector.boardCode)
    try {
      const response = await window.api.market.getMarketResonanceChildren({
        tradeDate: currentSnapshot.navigation.selectedTradeDate,
        parentIndustryCode: sector.boardCode,
        ...(forceRefresh ? { forceRefresh: true } : {}),
      })
      if (requestSequence !== childrenRequestSequenceRef.current) return
      if (!response.ok) {
        setChildrenError(response.error)
        return
      }
      if (
        response.result.tradeDate !== snapshotRef.current?.navigation.selectedTradeDate
        || response.result.parentIndustryCode !== sector.boardCode
      ) return
      setChildrenResult(response.result as ResonanceIndustryChildren)
      setChildrenError('')
    } catch {
      if (requestSequence === childrenRequestSequenceRef.current) {
        setChildrenError('二级行业数据暂不可用，请稍后重试。')
      }
    } finally {
      if (requestSequence === childrenRequestSequenceRef.current) setChildrenLoadingCode(null)
    }
  }

  if (!snapshot && loading) return <ResonanceSkeleton />

  return (
    <div
      ref={workbenchRef}
      data-testid="market-resonance-workbench"
      aria-busy={loading}
      className="h-full overflow-y-auto bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
    >
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold">市场共振</h1>
              {snapshot && <SourceModeBadge mode={snapshot.resonance.sourceMode} />}
              {snapshot && <QualityBadge status={snapshot.quality.status} />}
              {snapshot && (
                <span
                  className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
                  title={`分钟曲线 ${snapshot.resonance.coverage.sectorTrends.available}/${snapshot.resonance.coverage.sectorTrends.total}；板块截面 ${snapshot.resonance.coverage.boardFacts.available}/${snapshot.resonance.coverage.boardFacts.total}`}
                >
                  完整覆盖 {snapshot.resonance.coverage.available}/{snapshot.resonance.coverage.total} 个一级行业
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              比较行业与指数的分钟收益、同向持续性和超额强弱
            </p>
          </div>
          {snapshot && (
            <div
              data-testid="market-resonance-date-navigation"
              className="flex flex-wrap items-end justify-end gap-2"
              aria-label="交易日选择"
            >
              <button
                type="button"
                disabled={loading || !snapshot.navigation.previousTradeDate}
                onClick={() => {
                  const previous = snapshot.navigation.previousTradeDate
                  if (previous) void loadSnapshot({ tradeDate: previous })
                }}
                className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors motion-reduce:transition-none hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-300"
                aria-label="前一交易日"
                title={snapshot.navigation.previousTradeDate ? `前一交易日 ${formatTradeDate(snapshot.navigation.previousTradeDate)}` : '没有更早的可回看交易日'}
              >
                ← 上一交易日
              </button>
              <div className="w-[188px]">
                <ResearchDatePicker
                  value={formatTradeDate(snapshot.navigation.selectedTradeDate)}
                  max={formatTradeDate(snapshot.navigation.latestTradeDate) || getBeijingDateValue()}
                  disabled={loading}
                  testId="market-resonance-date-picker"
                  ariaLabel="市场共振交易日，格式为年-月-日"
                  triggerAriaLabel="打开市场共振交易日选择器"
                  dialogLabel="选择市场共振交易日"
                  footerHint="回看该交易日的共振、分布、时间线与行业资金"
                  onChange={() => {
                    // 仅在确认提交时切换, 避免输入过程中频繁请求
                  }}
                  onCommit={(next) => {
                    const compact = toCompactTradeDate(next)
                    if (!compact || compact === snapshot.navigation.selectedTradeDate) return
                    // 选到不晚于最新交易日的“今天”时, 直接回到最新视图
                    if (compact === snapshot.navigation.latestTradeDate) {
                      void loadSnapshot()
                      return
                    }
                    void loadSnapshot({ tradeDate: compact })
                  }}
                />
              </div>
              <button
                type="button"
                disabled={loading || !snapshot.navigation.nextTradeDate}
                onClick={() => {
                  const next = snapshot.navigation.nextTradeDate
                  if (next) void loadSnapshot({ tradeDate: next })
                }}
                className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors motion-reduce:transition-none hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-300"
                aria-label="后一交易日"
                title={snapshot.navigation.nextTradeDate ? `后一交易日 ${formatTradeDate(snapshot.navigation.nextTradeDate)}` : '已经是最新可回看的交易日'}
              >
                下一交易日 →
              </button>
              {snapshot.navigation.selectedTradeDate !== snapshot.navigation.latestTradeDate && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => { void loadSnapshot() }}
                  className="min-h-11 px-2 text-sm font-medium text-cyan-700 transition-colors motion-reduce:transition-none hover:text-cyan-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-50 dark:text-cyan-300 dark:hover:text-cyan-100"
                >
                  回到最新
                </button>
              )}
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  void loadSnapshot({
                    tradeDate: snapshot.navigation.selectedTradeDate,
                    forceRefresh: true,
                  })
                }}
                className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors motion-reduce:transition-none hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-300"
              >
                {loading ? `${refreshAttempt.operation}中…` : (isHistoricalView ? '重新补采' : '刷新数据')}
              </button>
            </div>
          )}
        </div>
        <div className="mt-3 flex max-w-full gap-1 overflow-x-auto" role="tablist" aria-label="共振基准指数">
          {(Object.keys(BENCHMARK_LABELS) as BenchmarkKey[]).map((key) => {
            const item = snapshot?.resonance.benchmarks.find((candidate) => candidate.key === key)
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={benchmarkKey === key}
                disabled={!item}
                onClick={() => setBenchmarkKey(key)}
                className={`min-h-11 shrink-0 rounded-md px-3 text-sm transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${
                  benchmarkKey === key
                    ? 'bg-slate-900 text-white dark:bg-cyan-500 dark:text-slate-950'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                } disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {BENCHMARK_LABELS[key]}
                {item && <span className={`ml-2 tabular-nums ${benchmarkKey === key ? 'opacity-85' : changeTextClass(item.change)}`}>{formatPercent(item.change)}</span>}
              </button>
            )
          })}
        </div>
      </header>

      <div aria-live="polite" className="sr-only">
        {loading ? `${refreshAttempt.operation}市场共振数据中` : refreshAttempt.message || initialError}
      </div>
      {initialError && !snapshot && (
        <div role="alert" className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300 sm:mx-5">
          <span>{initialError}</span>
          <button type="button" onClick={() => { void loadSnapshot(retryRequestRef.current) }} className="min-h-11 px-2 font-medium underline underline-offset-4">重新尝试</button>
        </div>
      )}
      {snapshot && (refreshAttempt.status === 'failed' || refreshAttempt.status === 'retained') && refreshAttempt.message && (
        <div role="status" className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200 sm:mx-5">
          <span>{refreshAttempt.message}</span>
          <button type="button" onClick={() => { void loadSnapshot(retryRequestRef.current) }} className="min-h-11 px-2 font-medium underline underline-offset-4">再次尝试</button>
        </div>
      )}

      {snapshot && benchmark && (
        <main className="px-4 pb-8 sm:px-5">
          <section data-testid="market-resonance-summary" className="border-b border-slate-200 py-4 dark:border-slate-800">
            {snapshot.quality.status === 'partial' && (
              <p className="mb-3 border-l-2 border-amber-400 pl-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
                {buildCoverageNotice(snapshot.quality.missingParts)}
              </p>
            )}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div>
                <p className="text-xs font-semibold uppercase text-cyan-700 dark:text-cyan-300">盘面结论</p>
                <h2 className="mt-1 text-lg font-semibold leading-7">{summary.headline}</h2>
                <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600 dark:text-slate-300">{summary.detail}</p>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 lg:text-right">
                {snapshot.resonance.sourceLabel}<br />
                更新 {new Date(snapshot.resonance.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            <div className="mt-4 grid grid-cols-2 border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-4">
              <PulseMetric
                label="基准涨跌"
                value={snapshot.resonance.coverage.benchmarkTrends.available > 0 ? formatPercent(benchmark.change) : '--'}
                valueClass={snapshot.resonance.coverage.benchmarkTrends.available > 0 ? changeTextClass(benchmark.change) : ''}
              />
              <PulseMetric label="共振/同步行业" value={`${summary.focusCount} 个`} />
              <PulseMetric label={marketPulse.breadthLabel} value={marketPulse.breadthText} />
              <PulseMetric label="涨停 / 跌停" value={marketPulse.limitText} />
            </div>
          </section>

          <div className="grid gap-5 py-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <section className="min-w-0" aria-labelledby="resonance-ranking-title">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
                <div>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h2 id="resonance-ranking-title" className="text-sm font-semibold">行业共振排序</h2>
                    <span
                      data-testid="market-resonance-visible-count"
                      className="text-xs tabular-nums text-slate-500 dark:text-slate-400"
                      aria-live="polite"
                    >
                      当前展示 {orderedSectors.length}/{allSectors.length} 个一级行业
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {hasComparableSectors
                      ? `点击行业查看与 ${benchmark.name} 的归一化分时对比`
                      : '点击行业查看同日板块事实与分钟曲线缺失说明'}
                  </p>
                </div>
                <div className="flex max-w-full gap-1 overflow-x-auto" role="group" aria-label="行业状态筛选">
                  {viewFilterOptions.map(({ key, label, count }) => (
                    <button
                      key={key}
                      type="button"
                      aria-label={`${label}，${count} 个一级行业`}
                      aria-pressed={viewFilter === key}
                      onClick={() => setViewFilter(key)}
                      className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${viewFilter === key
                        ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                    >
                      <span>{label}</span>
                      <span
                        aria-hidden="true"
                        className={`min-w-5 rounded px-1 py-0.5 text-center text-[11px] tabular-nums ${viewFilter === key
                          ? 'bg-white/70 text-cyan-800 dark:bg-slate-900/70 dark:text-cyan-200'
                          : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                      >
                        {count}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="max-h-[560px] overflow-auto border-b border-slate-200 dark:border-slate-800">
                <table className="w-full min-w-[900px] border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">行业</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">内部结构</th>
                      <th className="px-3 py-2 text-right font-medium">行业涨跌</th>
                      <th className="px-3 py-2 text-right font-medium" title="行业累计收益减去基准指数累计收益">超额收益</th>
                      <th className="px-3 py-2 text-right font-medium" title="行业与指数一分钟收益的 Pearson 相关系数">相关性</th>
                      <th className="px-3 py-2 text-right font-medium" title="行业与指数分钟涨跌方向一致的有效样本占比">同向率</th>
                      <th className="px-3 py-2 text-right font-medium">上涨覆盖</th>
                      <th className="px-3 py-2 text-right font-medium">主力净额</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderedSectors.map((sector) => {
                      const metric = sector.metrics[benchmarkKey]
                      const selected = selectedSector?.boardCode === sector.boardCode
                      const expanded = expandedParentCode === sector.boardCode
                      return (
                        <Fragment key={sector.boardCode}>
                          <tr
                            data-testid="market-resonance-row"
                            className={`border-t border-slate-100 transition-colors motion-reduce:transition-none dark:border-slate-800/80 ${selected ? 'bg-cyan-50 dark:bg-cyan-950/30' : 'bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-900'}`}
                          >
                            <td className="p-0">
                              <div className="flex min-w-[148px] items-stretch">
                                <button
                                  type="button"
                                  aria-label={`${expanded ? '收起' : '展开'}${sector.name}二级行业`}
                                  aria-expanded={expanded}
                                  aria-controls={`market-resonance-children-${sector.boardCode}`}
                                  onClick={() => { void toggleIndustryChildren(sector) }}
                                  className="flex min-h-11 min-w-11 items-center justify-center text-slate-500 transition-colors motion-reduce:transition-none hover:bg-slate-100 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-cyan-300"
                                  title={`${expanded ? '收起' : '展开'}${sector.name}二级行业`}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={`text-lg leading-none transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`}
                                  >
                                    ›
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedCode(sector.boardCode)
                                    setSelectedChildCode(null)
                                  }}
                                  className="min-h-11 min-w-0 flex-1 px-1 pr-3 py-2 text-left font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500"
                                >
                                  {sector.name}
                                </button>
                              </div>
                            </td>
                            <td className="px-3 py-2"><StateBadge state={metric.state} /></td>
                            <td className="px-3 py-2"><StructureBadge structure={sector.structure} /></td>
                            <NumberCell value={formatPercent(metric.sectorReturn)} numericValue={metric.sectorReturn} />
                            <NumberCell
                              value={metric.state === 'insufficient' ? '--' : formatPercent(metric.excessReturn)}
                              numericValue={metric.state === 'insufficient' ? null : metric.excessReturn}
                            />
                            <td className="px-3 py-2 text-right tabular-nums">{formatRatio(metric.correlation)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatAgreement(metric.directionAgreement)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatAgreement(sector.breadthRate)}</td>
                            <NumberCell value={formatMoney(sector.mainNetInflow)} numericValue={sector.mainNetInflow} />
                          </tr>
                          {expanded && (
                            <tr className="border-t border-cyan-100 bg-cyan-50/60 dark:border-cyan-950 dark:bg-cyan-950/20">
                              <td colSpan={9} className="p-0">
                                <IndustryChildrenPanel
                                  id={`market-resonance-children-${sector.boardCode}`}
                                  parent={sector}
                                  result={childrenResult?.parentIndustryCode === sector.boardCode ? childrenResult : null}
                                  loading={childrenLoadingCode === sector.boardCode}
                                  error={childrenError}
                                  selectedChildCode={selectedChildCode}
                                  onRetry={() => { void toggleIndustryChildren(sector, true) }}
                                  onSelect={(child) => {
                                    setSelectedCode(sector.boardCode)
                                    setSelectedChildCode(child.boardCode)
                                  }}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
                {orderedSectors.length === 0 && (
                  <div className="bg-white px-4 py-12 text-center text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                    当前基准下没有符合此状态的行业，可切换“全部行业”查看完整结果。
                  </div>
                )}
              </div>
            </section>

            <section
              data-testid="market-resonance-detail"
              className="min-w-0 border-t-2 border-slate-900 bg-white pt-3 dark:border-cyan-400 dark:bg-slate-950 xl:sticky xl:top-[132px] xl:self-start"
              aria-labelledby="resonance-detail-title"
            >
              {selectedChild && selectedChildParent ? (
                <ChildIndustryDetail
                  child={selectedChild}
                  parent={selectedChildParent}
                  benchmark={benchmark}
                  structure={childrenResult?.structure ?? selectedChildParent.structure}
                />
              ) : selectedSector && selectedMetric ? (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3 px-1">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 id="resonance-detail-title" className="text-base font-semibold">{selectedSector.name}</h2>
                        <StateBadge state={selectedMetric.state} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">对比 {benchmark.name} · {selectedMetric.sampleCount} 个对齐分钟</p>
                    </div>
                    <span className={`text-lg font-semibold tabular-nums ${changeTextClass(selectedMetric.sectorReturn)}`}>{formatPercent(selectedMetric.sectorReturn)}</span>
                  </div>
                  <div role="img" className="mt-3 h-[290px] w-full" aria-label={`${selectedSector.name}与${benchmark.name}分时收益对比图`}>
                    <div className="flex items-center gap-4 px-2 pb-1 text-[11px] text-slate-500 dark:text-slate-400" aria-hidden="true">
                      <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-cyan-600 dark:border-cyan-400" />{selectedSector.name}</span>
                      <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-dotted border-slate-500" />{benchmark.name}</span>
                    </div>
                    <div className="h-[268px]">
                      {benchmark.points.length > 0 && selectedSector.points.length > 0
                        ? <ResonanceLineChart benchmark={benchmark} sector={selectedSector} />
                        : (
                          <div className="flex h-full items-center justify-center border-y border-slate-200 px-6 text-center text-sm text-slate-500 dark:border-slate-800 dark:text-slate-400">
                            该交易日分钟曲线暂不可恢复，保留展示同日行业涨跌、上涨覆盖与主力资金事实。
                          </div>
                        )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 border-y border-slate-200 dark:border-slate-800">
                    <DetailMetric
                      label="超额收益"
                      value={selectedMetric.state === 'insufficient' ? '--' : formatPercent(selectedMetric.excessReturn)}
                      valueClass={selectedMetric.state === 'insufficient' ? '' : changeTextClass(selectedMetric.excessReturn)}
                    />
                    <DetailMetric label="收益相关性" value={formatRatio(selectedMetric.correlation)} />
                    <DetailMetric label="全日同向率" value={formatAgreement(selectedMetric.directionAgreement)} />
                    <DetailMetric label="近30分钟同向" value={formatAgreement(selectedMetric.recentAgreement)} />
                    <DetailMetric label="上涨覆盖" value={formatAgreement(selectedSector.breadthRate)} />
                    <DetailMetric label="领先关系" value={formatLag(selectedMetric.lagMinutes)} />
                  </div>
                  <p className="px-1 pt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
                    {buildSectorExplanation(selectedSector, benchmark, selectedMetric)}
                  </p>
                  <p className="px-1 pt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
                    相关性基于一分钟收益而非价格点位；领先关系只描述当日统计，不构成因果判断。
                  </p>
                </>
              ) : (
                <div className="py-16 text-center text-sm text-slate-500 dark:text-slate-400">选择一个行业查看详情。</div>
              )}
            </section>
          </div>
        </main>
      )}
    </div>
  )
}

function IndustryChildrenPanel({
  id,
  parent,
  result,
  loading,
  error,
  selectedChildCode,
  onRetry,
  onSelect,
}: {
  id: string
  parent: ResonanceSector
  result: ResonanceIndustryChildren | null
  loading: boolean
  error: string
  selectedChildCode: string | null
  onRetry: () => void
  onSelect: (child: ResonanceIndustryChild) => void
}) {
  return (
    <div id={id} role="region" aria-label={`${parent.name}二级行业`} className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{parent.name} · 二级行业</p>
            {result && <StructureBadge structure={result.structure} />}
            {loading && <span className="text-[11px] text-cyan-700 dark:text-cyan-300">更新中…</span>}
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
            {result?.structure.summary ?? parent.structure.summary}
          </p>
        </div>
        {result && (
          <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
            {result.factSource === 'current_network' ? '当前联网截面' : '本地同日事实'} · 分钟 {result.trendCoverage.available}/{result.trendCoverage.total}
          </span>
        )}
      </div>

      {loading && !result && (
        <div className="mt-3 grid gap-2" aria-label="二级行业加载中">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-11 animate-pulse bg-white/80 motion-reduce:animate-none dark:bg-slate-900/80" />
          ))}
        </div>
      )}

      {!loading && error && !result && (
        <div role="alert" className="mt-3 flex min-h-16 flex-wrap items-center justify-between gap-3 border-y border-amber-200 py-2 text-sm text-amber-800 dark:border-amber-900 dark:text-amber-200">
          <span>{error}</span>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-11 px-3 text-xs font-medium underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
          >
            重新获取
          </button>
        </div>
      )}

      {result && result.children.length === 0 && (
        <div className="mt-3 flex min-h-16 flex-wrap items-center justify-between gap-3 border-y border-slate-200 py-2 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
          <span>该交易日没有足够的二级行业事实，当前不能判断内部结构。</span>
          <button
            type="button"
            disabled={loading}
            onClick={onRetry}
            className="min-h-11 px-3 text-xs font-medium underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-50"
          >
            重新获取
          </button>
        </div>
      )}

      {result && result.children.length > 0 && (
        <div className="mt-3 overflow-x-auto border-y border-cyan-100 dark:border-cyan-950">
          <table className="w-full min-w-[620px] border-collapse text-xs">
            <thead className="bg-white/70 text-slate-500 dark:bg-slate-900/70 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">二级行业</th>
                <th className="px-3 py-2 text-right font-medium">相对父级</th>
                <th className="px-3 py-2 text-right font-medium">行业涨跌</th>
                <th className="px-3 py-2 text-right font-medium">上涨覆盖</th>
                <th className="px-3 py-2 text-right font-medium">主力净额</th>
              </tr>
            </thead>
            <tbody>
              {result.children.map((child) => {
                const selected = selectedChildCode === child.boardCode
                return (
                  <tr
                    key={child.boardCode}
                    data-testid="market-resonance-child-row"
                    className={`border-t border-cyan-100 dark:border-cyan-950 ${selected ? 'bg-cyan-100/80 dark:bg-cyan-950/60' : 'bg-white/40 hover:bg-white dark:bg-slate-950/40 dark:hover:bg-slate-900'}`}
                  >
                    <td className="p-0">
                      <button
                        type="button"
                        onClick={() => onSelect(child)}
                        className="min-h-11 w-full px-3 py-2 text-left font-medium text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 dark:text-slate-100"
                      >
                        {child.name}
                      </button>
                    </td>
                    <NumberCell value={child.excessVsParent == null ? '--' : formatPercent(child.excessVsParent)} numericValue={child.excessVsParent} />
                    <NumberCell value={formatPercent(child.change)} numericValue={child.change} />
                    <td className="px-3 py-2 text-right tabular-nums">{formatAgreement(child.breadthRate)}</td>
                    <NumberCell value={formatMoney(child.mainNetInflow)} numericValue={child.mainNetInflow} />
                  </tr>
                )
              })}
            </tbody>
          </table>
          {error && (
            <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:text-amber-200">
              <span>{error} 继续展示上一次结果。</span>
              <button type="button" onClick={onRetry} className="min-h-11 px-2 font-medium underline underline-offset-4">再次尝试</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ChildIndustryDetail({
  child,
  parent,
  benchmark,
  structure,
}: {
  child: ResonanceIndustryChild
  parent: ResonanceSector
  benchmark: ResonanceBenchmark
  structure: IndustryStructure
}) {
  const hasComparableTrend = child.points.length > 0 && parent.points.length > 0 && benchmark.points.length > 0
  const benchmarkExcess = benchmark.points.length > 0 ? child.change - benchmark.change : null
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3 px-1">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="resonance-detail-title" className="text-base font-semibold">{child.name}</h2>
            <span className="border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[11px] font-medium text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300">二级行业</span>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">所属 {parent.name} · 对比 {benchmark.name}</p>
        </div>
        <span className={`text-lg font-semibold tabular-nums ${changeTextClass(child.change)}`}>{formatPercent(child.change)}</span>
      </div>
      <div role="img" className="mt-3 h-[290px] w-full" aria-label={`${child.name}、${parent.name}与${benchmark.name}分时收益对比图`}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 pb-1 text-[11px] text-slate-500 dark:text-slate-400" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-cyan-600 dark:border-cyan-400" />{child.name}</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-dashed border-amber-500" />{parent.name}</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-5 border-t-2 border-dotted border-slate-500" />{benchmark.name}</span>
        </div>
        <div className="h-[268px]">
          {hasComparableTrend
            ? <ResonanceLineChart benchmark={benchmark} sector={parent} child={child} />
            : (
              <div className="flex h-full items-center justify-center border-y border-slate-200 px-6 text-center text-sm leading-6 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                该交易日二级行业分钟曲线暂不可恢复，继续展示同日涨跌、上涨覆盖和主力资金事实。
              </div>
            )}
        </div>
      </div>
      <div className="grid grid-cols-2 border-y border-slate-200 dark:border-slate-800">
        <DetailMetric label="相对父级" value={child.excessVsParent == null ? '--' : formatPercent(child.excessVsParent)} valueClass={child.excessVsParent == null ? '' : changeTextClass(child.excessVsParent)} />
        <DetailMetric label="相对基准" value={benchmarkExcess == null ? '--' : formatPercent(benchmarkExcess)} valueClass={benchmarkExcess == null ? '' : changeTextClass(benchmarkExcess)} />
        <DetailMetric label="上涨覆盖" value={formatAgreement(child.breadthRate)} />
        <DetailMetric label="主力净额" value={formatMoney(child.mainNetInflow)} valueClass={child.mainNetInflow == null ? '' : changeTextClass(child.mainNetInflow)} />
        <DetailMetric label="父级涨跌" value={formatPercent(parent.change)} valueClass={changeTextClass(parent.change)} />
        <DetailMetric label="分钟覆盖" value={hasComparableTrend ? `${child.points.length} 点` : '--'} />
      </div>
      <p className="px-1 pt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
        {structure.summary} {child.name}当日相对{parent.name}{child.excessVsParent == null ? '暂不可比' : `${child.excessVsParent >= 0 ? '跑赢' : '落后'} ${Math.abs(child.excessVsParent).toFixed(2)} 个百分点`}。
      </p>
      <p className="px-1 pt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
        二级行业结构基于同日板块事实；分钟线只在展开时按需恢复，不构成因果或方向预测。
      </p>
    </>
  )
}

function ResonanceLineChart({
  benchmark,
  sector,
  child,
}: {
  benchmark: ResonanceBenchmark
  sector: ResonanceSector
  child?: ResonanceIndustryChild
}) {
  const data = useMemo(() => {
    const sectorByTime = new Map(sector.points.map((point) => [point.time, point.change]))
    const childByTime = new Map(child?.points.map((point) => [point.time, point.change]) ?? [])
    return benchmark.points.flatMap((point) => {
      const sectorChange = sectorByTime.get(point.time)
      const childChange = child ? childByTime.get(point.time) : null
      return sectorChange == null || (child && childChange == null)
        ? []
        : [{
            time: point.time,
            benchmark: point.change,
            sector: sectorChange,
            ...(child ? { child: childChange } : {}),
          }]
    })
  }, [benchmark, child, sector])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: -6 }}>
        <CartesianGrid stroke="currentColor" className="text-slate-200 dark:text-slate-800" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="time" minTickGap={38} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(value: number) => `${value.toFixed(1)}%`} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={46} />
        <Tooltip content={<ResonanceTooltip benchmarkName={benchmark.name} sectorName={sector.name} childName={child?.name} />} />
        <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="benchmark" name={benchmark.name} stroke="#64748b" strokeWidth={1.5} strokeDasharray="2 3" dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="sector" name={sector.name} stroke={child ? '#f59e0b' : '#0891b2'} strokeWidth={child ? 1.5 : 2} strokeDasharray={child ? '6 3' : undefined} dot={false} isAnimationActive={false} />
        {child && <Line type="monotone" dataKey="child" name={child.name} stroke="#0891b2" strokeWidth={2} dot={false} isAnimationActive={false} />}
      </LineChart>
    </ResponsiveContainer>
  )
}

function ResonanceTooltip({
  active,
  payload,
  label,
  benchmarkName,
  sectorName,
  childName,
}: {
  active?: boolean
  payload?: Array<{ dataKey?: string | number; value?: number }>
  label?: string
  benchmarkName: string
  sectorName: string
  childName?: string
}) {
  if (!active || !payload?.length) return null
  const benchmarkValue = payload.find((item) => item.dataKey === 'benchmark')?.value
  const sectorValue = payload.find((item) => item.dataKey === 'sector')?.value
  const childValue = payload.find((item) => item.dataKey === 'child')?.value
  return (
    <div className="min-w-40 border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="mb-1 font-medium tabular-nums">{label}</p>
      {childName && <p className="flex justify-between gap-4"><span>{childName}</span><span className="tabular-nums text-cyan-300">{formatPercent(childValue ?? 0)}</span></p>}
      <p className="flex justify-between gap-4"><span>{sectorName}</span><span className={`tabular-nums ${childName ? 'text-amber-300' : 'text-cyan-300'}`}>{formatPercent(sectorValue ?? 0)}</span></p>
      <p className="flex justify-between gap-4"><span>{benchmarkName}</span><span className="tabular-nums text-slate-300">{formatPercent(benchmarkValue ?? 0)}</span></p>
    </div>
  )
}

function StateBadge({ state }: { state: ResonanceState }) {
  const meta = STATE_META[state]
  return <span className={`inline-flex whitespace-nowrap border px-1.5 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
}

function StructureBadge({ structure }: { structure: IndustryStructure }) {
  const meta = STRUCTURE_META[structure.state]
  return (
    <span
      className={`inline-flex whitespace-nowrap border px-1.5 py-0.5 text-[11px] font-medium ${meta.className}`}
      title={`${structure.summary} 覆盖 ${structure.available}/${structure.total}`}
    >
      {meta.label}
    </span>
  )
}

function SourceModeBadge({ mode }: { mode: 'realtime' | 'local_archive' | 'network_backfill' }) {
  const label = mode === 'realtime' ? '盘中实时' : mode === 'network_backfill' ? '联网补采' : '本地存档'
  const className = mode === 'realtime'
    ? 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300'
    : mode === 'network_backfill'
      ? 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
      : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
  return <span className={`border px-1.5 py-0.5 text-[11px] font-medium ${className}`}>{label}</span>
}

function QualityBadge({ status }: { status: 'complete' | 'partial' }) {
  const className = status === 'complete'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
  return <span className={`border px-1.5 py-0.5 text-[11px] font-medium ${className}`}>{status === 'complete' ? '覆盖完整' : '部分覆盖'}</span>
}

function PulseMetric({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0 border-r border-slate-200 px-3 py-3 last:border-r-0 dark:border-slate-800">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-base font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  )
}

function DetailMetric({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="border-b border-r border-slate-200 px-3 py-2.5 odd:border-r dark:border-slate-800">
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  )
}

function NumberCell({ value, numericValue }: { value: string; numericValue: number | null }) {
  return <td className={`px-3 py-2 text-right tabular-nums ${numericValue == null ? 'text-slate-400' : changeTextClass(numericValue)}`}>{value}</td>
}

function ResonanceSkeleton() {
  return (
    <div className="h-full overflow-hidden bg-slate-50 p-5 dark:bg-slate-950" aria-label="市场共振数据加载中">
      <div className="h-14 animate-pulse bg-slate-200 dark:bg-slate-800" />
      <div className="mt-5 h-32 animate-pulse bg-slate-200 dark:bg-slate-800" />
      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="h-[480px] animate-pulse bg-slate-200 dark:bg-slate-800" />
        <div className="h-[480px] animate-pulse bg-slate-200 dark:bg-slate-800" />
      </div>
    </div>
  )
}

function pickDefaultSector(sectors: ResonanceSector[], benchmarkKey: BenchmarkKey): ResonanceSector | null {
  const comparable = [...sectors]
    .filter((sector) => sector.metrics[benchmarkKey].state !== 'insufficient')
    .sort((left, right) => right.metrics[benchmarkKey].score - left.metrics[benchmarkKey].score)[0]
  return comparable ?? [...sectors]
    .sort((left, right) => (
      Math.abs(right.mainNetInflow ?? 0) - Math.abs(left.mainNetInflow ?? 0)
      || right.change - left.change
    ))[0] ?? null
}

function sortSectors(sectors: ResonanceSector[], benchmarkKey: BenchmarkKey, filter: ViewFilter): ResonanceSector[] {
  const filtered = sectors.filter((sector) => sectorMatchesViewFilter(sector, benchmarkKey, filter))
  return filtered.sort((left, right) => {
    const leftMetric = left.metrics[benchmarkKey]
    const rightMetric = right.metrics[benchmarkKey]
    if (filter === 'defensive') return rightMetric.excessReturn - leftMetric.excessReturn
    if (filter === 'risk') return leftMetric.excessReturn - rightMetric.excessReturn
    return rightMetric.score - leftMetric.score || rightMetric.excessReturn - leftMetric.excessReturn
  })
}

function countSectorsByFilter(
  sectors: ResonanceSector[],
  benchmarkKey: BenchmarkKey,
  filter: ViewFilter,
): number {
  return sectors.filter((sector) => sectorMatchesViewFilter(sector, benchmarkKey, filter)).length
}

function sectorMatchesViewFilter(
  sector: ResonanceSector,
  benchmarkKey: BenchmarkKey,
  filter: ViewFilter,
): boolean {
  const state = sector.metrics[benchmarkKey].state
  if (filter === 'focus') return state === 'leading_sync' || state === 'synchronized'
  if (filter === 'defensive') return state === 'defensive'
  if (filter === 'risk') return state === 'falling_sync' || state === 'lagging' || state === 'diverging'
  return true
}

function buildSummary(sectors: ResonanceSector[], benchmarkKey: BenchmarkKey, benchmark: ResonanceBenchmark | null) {
  if (!benchmark || sectors.length === 0) {
    return { headline: '正在等待可比的指数与行业分时数据', detail: '数据到齐后将按同向持续性与超额收益给出排序。', focusCount: 0 }
  }
  if (sectors.every((sector) => sector.metrics[benchmarkKey].state === 'insufficient')) {
    const strongest = [...sectors].sort((left, right) => right.change - left.change)[0]
    return {
      headline: '该交易日分钟共振曲线暂不可恢复',
      detail: `当前继续展示同日全市场分布、涨跌停时间线、行业涨跌、上涨覆盖与主力资金；不输出相关性、超额收益或共振方向。${strongest?.structure.summary ?? ''}`,
      focusCount: 0,
    }
  }
  const leaders = sectors
    .filter((sector) => sector.metrics[benchmarkKey].state === 'leading_sync')
    .sort((left, right) => right.metrics[benchmarkKey].score - left.metrics[benchmarkKey].score)
  const synchronized = sectors
    .filter((sector) => sector.metrics[benchmarkKey].state === 'synchronized')
    .sort((left, right) => right.metrics[benchmarkKey].score - left.metrics[benchmarkKey].score)
  const risks = sectors
    .filter((sector) => ['falling_sync', 'lagging'].includes(sector.metrics[benchmarkKey].state))
    .sort((left, right) => left.metrics[benchmarkKey].excessReturn - right.metrics[benchmarkKey].excessReturn)
  const focus = leaders.length > 0 ? leaders : synchronized
  const names = focus.slice(0, 3).map((sector) => sector.name)
  const headline = names.length > 0
    ? `${names.join('、')}是当前相对清晰的${leaders.length > 0 ? '共振强势方向' : '指数跟随方向'}`
    : `${benchmark.name}当前缺少稳定的行业共振主线`
  const riskNames = risks.slice(0, 2).map((sector) => sector.name)
  const structureDetail = focus[0]?.structure.summary ?? ''
  const detail = riskNames.length > 0
    ? `${benchmark.name}${formatPercent(benchmark.change)}；${names.join('、') || '暂无行业'}的分钟同向性相对更稳定，${riskNames.join('、')}则明显掉队或同步走弱。`
    : `${benchmark.name}${formatPercent(benchmark.change)}；当前没有出现显著掉队行业，仍需结合超额收益和上涨覆盖判断共振质量。`
  return { headline, detail: `${detail}${structureDetail}`, focusCount: leaders.length + synchronized.length }
}

function buildMarketPulse(snapshot: MarketOverviewSnapshot | null) {
  if (!snapshot) return { breadthLabel: '全市场上涨覆盖', breadthText: '--', limitText: '--' }
  const up = snapshot.distribution.filter((item) => item.isPositive === true).reduce((sum, item) => sum + item.count, 0)
  const down = snapshot.distribution.filter((item) => item.isPositive === false).reduce((sum, item) => sum + item.count, 0)
  const total = snapshot.distribution.reduce((sum, item) => sum + item.count, 0)
  const sectorUp = snapshot.resonance.sectors.reduce((sum, sector) => sum + (sector.upCount ?? 0), 0)
  const sectorDown = snapshot.resonance.sectors.reduce((sum, sector) => sum + (sector.downCount ?? 0), 0)
  const fallbackTotal = sectorUp + sectorDown
  const latestTimeline = snapshot.timeline.at(-1)
  return {
    breadthLabel: total > 0 ? '全市场上涨覆盖' : fallbackTotal > 0 ? '行业成分上涨覆盖' : '全市场上涨覆盖',
    breadthText: total > 0
      ? `${Math.round(up / total * 100)}%（${up}/${up + down}）`
      : fallbackTotal > 0
        ? `${Math.round(sectorUp / fallbackTotal * 100)}%（${sectorUp}/${fallbackTotal}）`
        : '--',
    limitText: latestTimeline ? `${latestTimeline.limitUp} / ${latestTimeline.limitDown}` : '--',
  }
}

function buildSectorExplanation(
  sector: ResonanceSector,
  benchmark: ResonanceBenchmark,
  metric: ResonanceMetric,
): string {
  if (metric.state === 'insufficient') return `可对齐分钟样本不足，当前不输出共振判断。${sector.structure.summary}`
  const correlation = metric.correlation == null ? '相关性暂不可用' : `收益相关性 ${metric.correlation.toFixed(2)}`
  const agreement = metric.directionAgreement == null ? '同向率暂不可用' : `${Math.round(metric.directionAgreement * 100)}% 的有效分钟同向`
  const excess = `相对${benchmark.name}${metric.excessReturn >= 0 ? '跑赢' : '落后'} ${Math.abs(metric.excessReturn).toFixed(2)} 个百分点`
  const breadth = sector.breadthRate == null ? '上涨覆盖未知' : `上涨覆盖 ${Math.round(sector.breadthRate * 100)}%`
  return `${sector.name}与${benchmark.name}${correlation}，${agreement}，当日${excess}，${breadth}。${sector.structure.summary}`
}

function formatLag(lag: number | null): string {
  if (lag == null) return '--'
  if (lag <= -2) return `行业领先 ${Math.abs(lag)} 分钟`
  if (lag >= 2) return `行业滞后 ${lag} 分钟`
  return '基本同步'
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatRatio(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '--' : value.toFixed(2)
}

function formatAgreement(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '--' : `${Math.round(value * 100)}%`
}

function formatMoney(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '--'
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `${value >= 0 ? '+' : '-'}${(absolute / 100_000_000).toFixed(1)}亿`
  return `${value >= 0 ? '+' : '-'}${(absolute / 10_000).toFixed(0)}万`
}

function formatTradeDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value || ''
}

function buildRefreshFailureMessage(
  operation: RefreshAttempt['operation'],
  error: string,
  displayedSnapshot: MarketOverviewSnapshot,
): string {
  const savedAt = new Date(displayedSnapshot.resonance.generatedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${operation}失败：${error} 继续展示 ${savedAt} 保存的${displayedSnapshot.resonance.sourceMode === 'local_archive' ? '本地快照' : '当前结果'}。`
}

function buildCoverageNotice(missingParts: MarketOverviewSnapshot['quality']['missingParts']): string {
  const labels: Record<MarketOverviewSnapshot['quality']['missingParts'][number], string> = {
    benchmark_trends: '部分基准指数分钟曲线',
    sector_trends: '部分行业分钟曲线',
    board_facts: '部分行业广度与资金截面',
    distribution: '全市场涨跌分布',
    timeline: '涨跌停时间线',
    timeline_approximate: '精确涨跌停时间线（当前为同日近似重建）',
  }
  const missing = [...new Set(missingParts)].map((part) => labels[part])
  return `当前缺少${missing.join('、')}，结论仅基于已覆盖事实。`
}

function toCompactTradeDate(value: string): string | null {
  if (/^\d{8}$/.test(value)) return value
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.replaceAll('-', '')
  return null
}

function changeTextClass(value: number): string {
  if (value > 0) return 'text-rose-600 dark:text-rose-400'
  if (value < 0) return 'text-emerald-600 dark:text-emerald-400'
  return 'text-slate-600 dark:text-slate-300'
}
