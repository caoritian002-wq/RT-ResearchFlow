import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  metrics: Record<BenchmarkKey, ResonanceMetric>
}

interface MarketOverviewSnapshot {
  distribution: DistributionBin[]
  timeline: TimelinePoint[]
  generatedAt: number
  resonance: {
    tradeDate: string
    dataMode: 'realtime' | 'archive' | 'partial'
    sourceLabel: string
    generatedAt: number
    coverage: { available: number; total: number }
    benchmarks: ResonanceBenchmark[]
    sectors: ResonanceSector[]
  }
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

export function MarketHeatmapPanel() {
  const [snapshot, setSnapshot] = useState<MarketOverviewSnapshot | null>(null)
  const [benchmarkKey, setBenchmarkKey] = useState<BenchmarkKey>('shanghai')
  const [viewFilter, setViewFilter] = useState<ViewFilter>('focus')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSnapshot = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    try {
      const response = await window.api.market.getMarketOverview(forceRefresh)
      if (!response.ok) {
        setErrorMessage(response.error)
        return
      }
      const next = response.snapshot as MarketOverviewSnapshot
      setSnapshot(next)
      setErrorMessage('')
      setSelectedCode((current) => current && next.resonance.sectors.some((sector) => sector.boardCode === current)
        ? current
        : pickDefaultSector(next.resonance.sectors, 'shanghai')?.boardCode ?? null)
    } catch {
      setErrorMessage('指数与行业分时数据暂不可用，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot(false)
    pollRef.current = setInterval(() => { void loadSnapshot(false) }, 60_000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [loadSnapshot])

  const benchmark = snapshot?.resonance.benchmarks.find((item) => item.key === benchmarkKey) ?? null
  const allSectors = snapshot?.resonance.sectors ?? []
  const orderedSectors = useMemo(
    () => sortSectors(allSectors, benchmarkKey, viewFilter),
    [allSectors, benchmarkKey, viewFilter],
  )
  const selectedSector = allSectors.find((sector) => sector.boardCode === selectedCode)
    ?? pickDefaultSector(allSectors, benchmarkKey)
    ?? null
  const selectedMetric = selectedSector?.metrics[benchmarkKey] ?? null
  const marketPulse = useMemo(() => buildMarketPulse(snapshot), [snapshot])
  const summary = useMemo(() => buildSummary(allSectors, benchmarkKey, benchmark), [allSectors, benchmarkKey, benchmark])

  useEffect(() => {
    const current = selectedCode ? allSectors.find((sector) => sector.boardCode === selectedCode) : null
    if (current?.metrics[benchmarkKey].state !== 'insufficient') return
    setSelectedCode(pickDefaultSector(allSectors, benchmarkKey)?.boardCode ?? null)
  }, [allSectors, benchmarkKey, selectedCode])

  if (!snapshot && loading) return <ResonanceSkeleton />

  return (
    <div
      data-testid="market-resonance-workbench"
      className="h-full overflow-y-auto bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
    >
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold">市场共振</h1>
              {snapshot && <DataModeBadge mode={snapshot.resonance.dataMode} />}
              {snapshot && (
                <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {formatTradeDate(snapshot.resonance.tradeDate)} · 覆盖 {snapshot.resonance.coverage.available}/{snapshot.resonance.coverage.total} 个一级行业
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              比较行业与指数的分钟收益、同向持续性和超额强弱
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => { void loadSnapshot(true) }}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors motion-reduce:transition-none hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-300"
          >
            {loading ? '刷新中…' : '刷新数据'}
          </button>
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

      <div aria-live="polite" className="sr-only">{loading ? '市场共振数据刷新中' : errorMessage}</div>
      {errorMessage && (
        <div role="alert" className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300 sm:mx-5">
          <span>{errorMessage}</span>
          <button type="button" onClick={() => { void loadSnapshot(true) }} className="min-h-11 px-2 font-medium underline underline-offset-4">重新加载</button>
        </div>
      )}

      {snapshot && benchmark && (
        <main className="px-4 pb-8 sm:px-5">
          <section data-testid="market-resonance-summary" className="border-b border-slate-200 py-4 dark:border-slate-800">
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
              <PulseMetric label="基准涨跌" value={formatPercent(benchmark.change)} valueClass={changeTextClass(benchmark.change)} />
              <PulseMetric label="同向走强行业" value={`${summary.focusCount} 个`} />
              <PulseMetric label={marketPulse.breadthLabel} value={marketPulse.breadthText} />
              <PulseMetric label="涨停 / 跌停" value={marketPulse.limitText} />
            </div>
          </section>

          <div className="grid gap-5 py-5 xl:grid-cols-[minmax(0,1fr)_420px]">
            <section className="min-w-0" aria-labelledby="resonance-ranking-title">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
                <div>
                  <h2 id="resonance-ranking-title" className="text-sm font-semibold">行业共振排序</h2>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">点击行业查看与 {benchmark.name} 的归一化分时对比</p>
                </div>
                <div className="flex max-w-full gap-1 overflow-x-auto" role="group" aria-label="行业状态筛选">
                  {([
                    ['focus', '共振走强'],
                    ['defensive', '逆势抗跌'],
                    ['risk', '背离转弱'],
                    ['all', '全部行业'],
                  ] as Array<[ViewFilter, string]>).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={viewFilter === key}
                      onClick={() => setViewFilter(key)}
                      className={`min-h-11 shrink-0 rounded-md px-3 text-xs font-medium transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${viewFilter === key
                        ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200'
                        : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="max-h-[560px] overflow-auto border-b border-slate-200 dark:border-slate-800">
                <table className="w-full min-w-[760px] border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-left text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 font-medium">行业</th>
                      <th className="px-3 py-2 font-medium">状态</th>
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
                      return (
                        <tr
                          key={sector.boardCode}
                          data-testid="market-resonance-row"
                          className={`border-t border-slate-100 transition-colors motion-reduce:transition-none dark:border-slate-800/80 ${selected ? 'bg-cyan-50 dark:bg-cyan-950/30' : 'bg-white hover:bg-slate-50 dark:bg-slate-950 dark:hover:bg-slate-900'}`}
                        >
                          <td className="p-0">
                            <button
                              type="button"
                              onClick={() => setSelectedCode(sector.boardCode)}
                              className="min-h-11 w-full px-3 py-2 text-left font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500"
                            >
                              {sector.name}
                            </button>
                          </td>
                          <td className="px-3 py-2"><StateBadge state={metric.state} /></td>
                          <NumberCell value={formatPercent(metric.sectorReturn)} numericValue={metric.sectorReturn} />
                          <NumberCell value={formatPercent(metric.excessReturn)} numericValue={metric.excessReturn} />
                          <td className="px-3 py-2 text-right tabular-nums">{formatRatio(metric.correlation)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatAgreement(metric.directionAgreement)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatAgreement(sector.breadthRate)}</td>
                          <NumberCell value={formatMoney(sector.mainNetInflow)} numericValue={sector.mainNetInflow} />
                        </tr>
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
              {selectedSector && selectedMetric ? (
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
                  <div className="mt-3 h-[290px] w-full" aria-label={`${selectedSector.name}与${benchmark.name}分时收益对比图`}>
                    <div className="flex items-center gap-4 px-2 pb-1 text-[11px] text-slate-500 dark:text-slate-400" aria-hidden="true">
                      <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 bg-cyan-600 dark:bg-cyan-400" />{selectedSector.name}</span>
                      <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-5 bg-slate-500" />{benchmark.name}</span>
                    </div>
                    <div className="h-[268px]"><ResonanceLineChart benchmark={benchmark} sector={selectedSector} /></div>
                  </div>
                  <div className="grid grid-cols-2 border-y border-slate-200 dark:border-slate-800">
                    <DetailMetric label="超额收益" value={formatPercent(selectedMetric.excessReturn)} valueClass={changeTextClass(selectedMetric.excessReturn)} />
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

function ResonanceLineChart({ benchmark, sector }: { benchmark: ResonanceBenchmark; sector: ResonanceSector }) {
  const data = useMemo(() => {
    const sectorByTime = new Map(sector.points.map((point) => [point.time, point.change]))
    return benchmark.points.flatMap((point) => {
      const sectorChange = sectorByTime.get(point.time)
      return sectorChange == null ? [] : [{ time: point.time, benchmark: point.change, sector: sectorChange }]
    })
  }, [benchmark, sector])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 10, right: 12, bottom: 4, left: -6 }}>
        <CartesianGrid stroke="currentColor" className="text-slate-200 dark:text-slate-800" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="time" minTickGap={38} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(value: number) => `${value.toFixed(1)}%`} tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} axisLine={false} width={46} />
        <Tooltip content={<ResonanceTooltip benchmarkName={benchmark.name} sectorName={sector.name} />} />
        <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
        <Line type="monotone" dataKey="benchmark" name={benchmark.name} stroke="#64748b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="sector" name={sector.name} stroke="#0891b2" strokeWidth={2} dot={false} isAnimationActive={false} />
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
}: {
  active?: boolean
  payload?: Array<{ dataKey?: string | number; value?: number }>
  label?: string
  benchmarkName: string
  sectorName: string
}) {
  if (!active || !payload?.length) return null
  const benchmarkValue = payload.find((item) => item.dataKey === 'benchmark')?.value
  const sectorValue = payload.find((item) => item.dataKey === 'sector')?.value
  return (
    <div className="min-w-40 border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 shadow-xl">
      <p className="mb-1 font-medium tabular-nums">{label}</p>
      <p className="flex justify-between gap-4"><span>{sectorName}</span><span className="tabular-nums text-cyan-300">{formatPercent(sectorValue ?? 0)}</span></p>
      <p className="flex justify-between gap-4"><span>{benchmarkName}</span><span className="tabular-nums text-slate-300">{formatPercent(benchmarkValue ?? 0)}</span></p>
    </div>
  )
}

function StateBadge({ state }: { state: ResonanceState }) {
  const meta = STATE_META[state]
  return <span className={`inline-flex whitespace-nowrap border px-1.5 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
}

function DataModeBadge({ mode }: { mode: 'realtime' | 'archive' | 'partial' }) {
  const label = mode === 'realtime' ? '盘中实时' : mode === 'partial' ? '部分覆盖' : '最近交易日'
  const className = mode === 'realtime'
    ? 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300'
    : mode === 'partial'
      ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
      : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
  return <span className={`border px-1.5 py-0.5 text-[11px] font-medium ${className}`}>{label}</span>
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
  return [...sectors]
    .filter((sector) => sector.metrics[benchmarkKey].state !== 'insufficient')
    .sort((left, right) => right.metrics[benchmarkKey].score - left.metrics[benchmarkKey].score)[0] ?? null
}

function sortSectors(sectors: ResonanceSector[], benchmarkKey: BenchmarkKey, filter: ViewFilter): ResonanceSector[] {
  const filtered = sectors.filter((sector) => {
    const state = sector.metrics[benchmarkKey].state
    if (filter === 'focus') return state === 'leading_sync' || state === 'synchronized'
    if (filter === 'defensive') return state === 'defensive'
    if (filter === 'risk') return state === 'falling_sync' || state === 'lagging' || state === 'diverging'
    return true
  })
  return filtered.sort((left, right) => {
    const leftMetric = left.metrics[benchmarkKey]
    const rightMetric = right.metrics[benchmarkKey]
    if (filter === 'defensive') return rightMetric.excessReturn - leftMetric.excessReturn
    if (filter === 'risk') return leftMetric.excessReturn - rightMetric.excessReturn
    return rightMetric.score - leftMetric.score || rightMetric.excessReturn - leftMetric.excessReturn
  })
}

function buildSummary(sectors: ResonanceSector[], benchmarkKey: BenchmarkKey, benchmark: ResonanceBenchmark | null) {
  if (!benchmark || sectors.length === 0) {
    return { headline: '正在等待可比的指数与行业分时数据', detail: '数据到齐后将按同向持续性与超额收益给出排序。', focusCount: 0 }
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
  const detail = riskNames.length > 0
    ? `${benchmark.name}${formatPercent(benchmark.change)}；${names.join('、') || '暂无行业'}的分钟同向性相对更稳定，${riskNames.join('、')}则明显掉队或同步走弱。`
    : `${benchmark.name}${formatPercent(benchmark.change)}；当前没有出现显著掉队行业，仍需结合超额收益和上涨覆盖判断共振质量。`
  return { headline, detail, focusCount: leaders.length + synchronized.length }
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
  if (metric.state === 'insufficient') return '可对齐分钟样本不足，当前不输出共振判断。'
  const correlation = metric.correlation == null ? '相关性暂不可用' : `收益相关性 ${metric.correlation.toFixed(2)}`
  const agreement = metric.directionAgreement == null ? '同向率暂不可用' : `${Math.round(metric.directionAgreement * 100)}% 的有效分钟同向`
  const excess = `相对${benchmark.name}${metric.excessReturn >= 0 ? '跑赢' : '落后'} ${Math.abs(metric.excessReturn).toFixed(2)} 个百分点`
  const breadth = sector.breadthRate == null ? '上涨覆盖未知' : `上涨覆盖 ${Math.round(sector.breadthRate * 100)}%`
  return `${sector.name}与${benchmark.name}${correlation}，${agreement}，当日${excess}，${breadth}。`
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
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value || '--'
}

function changeTextClass(value: number): string {
  if (value > 0) return 'text-rose-600 dark:text-rose-400'
  if (value < 0) return 'text-emerald-600 dark:text-emerald-400'
  return 'text-slate-600 dark:text-slate-300'
}
