import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/appStore'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { SHORT_TERM_WORKBENCH_ACTION_CLASS, ShortTermCombobox, type ShortTermComboboxOption } from './ShortTermDecisionControls'

type LimitTimeWindow = 'before1030' | 'between1030_1130' | 'after1300' | 'unknown'
type QualityTier = 'focus' | 'watch' | 'fragile'
type DataStatus = 'complete' | 'partial' | 'insufficient'
type DimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'

interface QualityDimension {
  key: string
  label: string
  score: number | null
  maxScore: number
  status: DimensionStatus
  value: string
  detail: string
}

interface StockQuality {
  tier: QualityTier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  dataStatus: DataStatus
  completeness: number
  missingFields: string[]
  dimensions: QualityDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
}

interface LimitBoardStock {
  tsCode: string
  stockCode: string
  stockName: string
  limitTime: string
  limitPrice: number
  pctChg: number
  fundAmount: number
  openTimes: number
  limitTimes: number
  conceptName: string
  conceptZtNum: number
  hasDumpInstWarning: boolean
  dumpInstDesc: string | null
  timeWindow: LimitTimeWindow
  quality: StockQuality
}

interface ThemeSummary {
  name: string
  stockCount: number
  focusCount: number
  watchCount: number
  averageScore: number | null
}

interface WorkbenchJudgment {
  stance: 'focus' | 'selective' | 'defensive' | 'insufficient'
  title: string
  summary: string
  dataStatus: DataStatus
  completeness: number
  missingFields: string[]
  focusCount: number
  watchCount: number
  fragileCount: number
  themes: ThemeSummary[]
  strategyVersion: string
}

interface LimitBoardSnapshot {
  tradeDate: string
  generatedAt: number
  isMock: boolean
  inTradingHours: boolean
  totalLimitCount: number
  conceptList: string[]
  stocks: LimitBoardStock[]
  dataMode: 'realtime' | 'eod'
  rtDataTime: string | null
  strategyVersion: string
  workbench: WorkbenchJudgment
}

type QualityFilter = 'all' | QualityTier
type TimeFilter = 'all' | LimitTimeWindow
type PriceFilter = 'all' | 'lt50' | '50to100' | 'gt100'

const QUALITY_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部质量层级' },
  { value: 'focus', label: '重点观察' },
  { value: 'watch', label: '选择性观察' },
  { value: 'fragile', label: '封板脆弱' },
]
const TIME_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部封板时段' },
  { value: 'before1030', label: '10:30前' },
  { value: 'between1030_1130', label: '10:30至11:30' },
  { value: 'after1300', label: '午后封板' },
  { value: 'unknown', label: '时间待补' },
]
const PRICE_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部价格' },
  { value: 'lt50', label: '50元以下' },
  { value: '50to100', label: '50至100元' },
  { value: 'gt100', label: '100元以上' },
]
const BREADTH_OPTIONS: ShortTermComboboxOption[] = [
  { value: '0', label: '全部题材广度' },
  { value: '2', label: '至少2只涨停' },
  { value: '3', label: '至少3只涨停' },
  { value: '5', label: '至少5只涨停' },
]

function priceMatches(price: number, filter: PriceFilter): boolean {
  if (filter === 'lt50') return price < 50
  if (filter === '50to100') return price >= 50 && price <= 100
  if (filter === 'gt100') return price > 100
  return true
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '待补'
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}亿`
  return `${Math.round(value)}万`
}

function formatTradeDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function qualityLabel(tier: QualityTier): string {
  if (tier === 'focus') return '重点观察'
  if (tier === 'watch') return '选择性观察'
  return '封板脆弱'
}

function tierTone(tier: QualityTier): string {
  if (tier === 'focus') return 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/45 dark:text-cyan-200'
  if (tier === 'watch') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
  return 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200'
}

function stanceLabel(stance: WorkbenchJudgment['stance']): string {
  if (stance === 'focus') return '存在重点'
  if (stance === 'selective') return '选择观察'
  if (stance === 'defensive') return '偏防守'
  return '证据不足'
}

function dataStatusLabel(status: DataStatus): string {
  if (status === 'complete') return '数据完整'
  if (status === 'partial') return '部分数据'
  return '数据不足'
}

function dimensionTone(status: DimensionStatus): string {
  if (status === 'strong') return 'bg-cyan-600 dark:bg-cyan-400'
  if (status === 'neutral') return 'bg-slate-500 dark:bg-slate-400'
  if (status === 'weak') return 'bg-amber-500 dark:bg-amber-400'
  return 'bg-slate-200 dark:bg-slate-700'
}

function BoardPosition({ times }: { times: number }): JSX.Element {
  const label = times < 1 ? '待补' : times === 1 ? '首板' : `${times}板`
  return <span className="font-medium text-slate-700 dark:text-slate-200">{label}</span>
}

interface LimitBoardMonitorProps {
  dataTools?: ReactNode
  onOpenHistory?: () => void
}

export function LimitBoardMonitor({ dataTools, onOpenHistory }: LimitBoardMonitorProps): JSX.Element {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const [snapshot, setSnapshot] = useState<LimitBoardSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>('all')
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all')
  const [priceFilter, setPriceFilter] = useState<PriceFilter>('all')
  const [conceptFilter, setConceptFilter] = useState('all')
  const [minBreadth, setMinBreadth] = useState('0')
  const [excludeST, setExcludeST] = useState(true)
  const [excludeHardRisk, setExcludeHardRisk] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [drawerStock, setDrawerStock] = useState<{ tsCode: string; stockCode: string; stockName: string } | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSnapshot = useCallback(async (forceRefresh = false): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const api = window.api.shortTerm.limitBoardMonitor
      const result = forceRefresh ? await api.refresh() : await api.get()
      if (!result.ok) throw new Error('涨停快照加载失败')
      setSnapshot(result.snapshot as LimitBoardSnapshot)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '涨停快照加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSnapshot(false) }, [loadSnapshot])

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = null
    if (snapshot?.inTradingHours) intervalRef.current = setInterval(() => void loadSnapshot(true), 30_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [loadSnapshot, snapshot?.inTradingHours])

  const filteredStocks = useMemo(() => {
    if (!snapshot) return []
    const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN')
    const tierRank: Record<QualityTier, number> = { focus: 0, watch: 1, fragile: 2 }
    return snapshot.stocks.filter((stock) => {
      if (qualityFilter !== 'all' && stock.quality.tier !== qualityFilter) return false
      if (timeFilter !== 'all' && stock.timeWindow !== timeFilter) return false
      if (!priceMatches(stock.limitPrice, priceFilter)) return false
      if (conceptFilter !== 'all' && stock.conceptName !== conceptFilter) return false
      if (stock.conceptZtNum < Number(minBreadth)) return false
      if (excludeST && /ST/i.test(stock.stockName)) return false
      if (excludeHardRisk && (stock.hasDumpInstWarning || stock.openTimes >= 3)) return false
      if (normalizedSearch && !`${stock.stockName} ${stock.stockCode} ${stock.conceptName}`.toLocaleLowerCase('zh-CN').includes(normalizedSearch)) return false
      return true
    }).sort((left, right) => (
      tierRank[left.quality.tier] - tierRank[right.quality.tier]
      || (right.quality.totalScore ?? -1) - (left.quality.totalScore ?? -1)
      || right.fundAmount - left.fundAmount
      || left.tsCode.localeCompare(right.tsCode)
    ))
  }, [conceptFilter, excludeHardRisk, excludeST, minBreadth, priceFilter, qualityFilter, search, snapshot, timeFilter])

  useEffect(() => {
    if (filteredStocks.length === 0) {
      setSelectedCode(null)
      return
    }
    if (!selectedCode || !filteredStocks.some((stock) => stock.tsCode === selectedCode)) setSelectedCode(filteredStocks[0].tsCode)
  }, [filteredStocks, selectedCode])

  const selectedStock = filteredStocks.find((stock) => stock.tsCode === selectedCode) ?? null
  const conceptOptions = useMemo<ShortTermComboboxOption[]>(() => [
    { value: 'all', label: '全部题材' },
    ...(snapshot?.conceptList ?? []).map((concept) => ({ value: concept, label: concept })),
  ], [snapshot?.conceptList])

  const resetFilters = (): void => {
    setQualityFilter('all')
    setTimeFilter('all')
    setPriceFilter('all')
    setConceptFilter('all')
    setMinBreadth('0')
    setExcludeST(true)
    setExcludeHardRisk(false)
    setSearch('')
  }

  const openStockDrawer = (stock: LimitBoardStock): void => {
    setDrawerStock({ tsCode: stock.tsCode, stockCode: stock.stockCode, stockName: stock.stockName })
  }

  return (
    <div data-testid="limit-board-workbench" className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex min-h-[64px] shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">涨停质量</h2>
            {snapshot && (
              <>
                <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 dark:border-slate-700 dark:text-slate-300">事实日 {formatTradeDate(snapshot.tradeDate)}</span>
                <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 dark:border-slate-700 dark:text-slate-300">{snapshot.dataMode === 'realtime' ? `实时${snapshot.rtDataTime ? ` ${snapshot.rtDataTime}` : ''}` : '盘后'}</span>
              </>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">判断封板结构是否完整，并给出后续确认与失效条件</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button type="button" data-testid="limit-board-refresh" disabled={loading} onClick={() => void loadSnapshot(true)} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>{loading ? '刷新中' : '刷新快照'}</button>
          <button type="button" data-testid="limit-board-history" onClick={onOpenHistory} disabled={!onOpenHistory} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>历史表现</button>
          {dataTools}
        </div>
      </header>

      {error && (
        <div role="alert" className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/35 dark:text-red-200">
          <span>{error}</span>
          <button type="button" onClick={() => void loadSnapshot(true)} className="h-11 px-3 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30">重试</button>
        </div>
      )}

      {snapshot && (
        <section data-testid="limit-board-conclusion" className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="min-w-[260px] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded border border-cyan-200 bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200">{stanceLabel(snapshot.workbench.stance)}</span>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{snapshot.workbench.title}</h3>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">{snapshot.workbench.summary}</p>
            </div>
            <dl className="flex shrink-0 items-center gap-4 text-center">
              <div><dt className="text-[10px] text-slate-400">重点</dt><dd className="mt-0.5 font-semibold tabular-nums text-cyan-700 dark:text-cyan-300">{snapshot.workbench.focusCount}</dd></div>
              <div><dt className="text-[10px] text-slate-400">观察</dt><dd className="mt-0.5 font-semibold tabular-nums text-amber-700 dark:text-amber-300">{snapshot.workbench.watchCount}</dd></div>
              <div><dt className="text-[10px] text-slate-400">脆弱</dt><dd className="mt-0.5 font-semibold tabular-nums text-red-700 dark:text-red-300">{snapshot.workbench.fragileCount}</dd></div>
              <div className="min-w-20"><dt className="text-[10px] text-slate-400">{dataStatusLabel(snapshot.workbench.dataStatus)}</dt><dd className="mt-0.5 font-semibold tabular-nums">{snapshot.workbench.completeness}%</dd></div>
            </dl>
            {snapshot.workbench.themes.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] font-medium text-slate-400">题材聚合</span>
                {snapshot.workbench.themes.map((theme) => (
                  <button key={theme.name} type="button" onClick={() => setConceptFilter(theme.name)} className="min-h-11 rounded border border-slate-200 px-2 text-[11px] text-slate-600 outline-none hover:border-cyan-400 hover:text-cyan-800 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:text-slate-300 dark:hover:border-cyan-600 dark:hover:text-cyan-200">{theme.name} · {theme.stockCount}只</button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {snapshot && (
        <section aria-label="涨停质量筛选" className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-950">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-[repeat(5,minmax(128px,1fr))_minmax(180px,1.4fr)_auto]">
            <ShortTermCombobox testId="limit-board-quality-filter" ariaLabel="质量层级" value={qualityFilter} options={QUALITY_OPTIONS} onChange={(value) => setQualityFilter(value as QualityFilter)} />
            <ShortTermCombobox testId="limit-board-time-filter" ariaLabel="封板时段" value={timeFilter} options={TIME_OPTIONS} onChange={(value) => setTimeFilter(value as TimeFilter)} />
            <ShortTermCombobox testId="limit-board-price-filter" ariaLabel="价格区间" value={priceFilter} options={PRICE_OPTIONS} onChange={(value) => setPriceFilter(value as PriceFilter)} />
            <ShortTermCombobox testId="limit-board-concept-filter" ariaLabel="题材" value={conceptFilter} options={conceptOptions} searchPlaceholder="搜索题材" onChange={setConceptFilter} />
            <ShortTermCombobox testId="limit-board-breadth-filter" ariaLabel="题材涨停广度" value={minBreadth} options={BREADTH_OPTIONS} onChange={setMinBreadth} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索股票、代码或题材" placeholder="搜索股票、代码或题材" className="h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-xs outline-none placeholder:text-slate-400 hover:border-cyan-500 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/25 dark:border-slate-700 dark:bg-slate-950" />
            <button type="button" onClick={resetFilters} className="h-11 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-600 outline-none hover:border-cyan-500 hover:text-cyan-800 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300">重置</button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={excludeST} onChange={(event) => setExcludeST(event.target.checked)} className="h-4 w-4 accent-cyan-700" />排除ST</label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300"><input type="checkbox" checked={excludeHardRisk} onChange={(event) => setExcludeHardRisk(event.target.checked)} className="h-4 w-4 accent-cyan-700" />隐藏硬风险</label>
            </div>
            <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400">当前 {filteredStocks.length} / {snapshot.stocks.length} 只 · 默认按封板质量排序</span>
          </div>
        </section>
      )}

      {!snapshot && !error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-500" aria-live="polite">{loading ? '正在建立涨停质量快照' : '等待涨停数据'}</div>
      ) : snapshot && snapshot.stocks.length === 0 ? (
        <div data-testid="limit-board-empty" className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-lg">
            <h3 className="text-sm font-semibold">事实日没有可研判的涨停样本</h3>
            <p className="mt-2 text-xs leading-6 text-slate-500 dark:text-slate-400">当前为{snapshot.dataMode === 'eod' ? '盘后涨停榜' : '实时截面'}。若数据尚未同步，请打开题材数据工具并刷新；若事实日数据完整，则代表当日没有符合涨停规则的股票。</p>
          </div>
        </div>
      ) : snapshot ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-h-0 min-w-0 overflow-hidden bg-white dark:bg-slate-900" aria-label="涨停候选">
            <div className="h-full overflow-auto">
              <table className="min-w-[760px] w-full table-fixed text-left text-xs">
                <thead className="sticky top-0 z-10 bg-slate-100 text-[11px] font-medium text-slate-500 shadow-[0_1px_0_0_rgba(148,163,184,0.25)] dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="w-[112px] px-3 py-2">研判</th>
                    <th className="w-[132px] px-3 py-2">股票</th>
                    <th className="w-[112px] px-3 py-2">封板状态</th>
                    <th className="w-[86px] px-3 py-2 text-right">封单</th>
                    <th className="w-[154px] px-3 py-2">题材共振</th>
                    <th className="w-[72px] px-3 py-2">位置</th>
                    <th className="px-3 py-2">首要风险</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStocks.map((stock) => {
                    const selected = selectedCode === stock.tsCode
                    return (
                      <tr
                        key={stock.tsCode}
                        tabIndex={0}
                        aria-selected={selected}
                        data-testid={`limit-board-row-${stock.stockCode}`}
                        onClick={() => setSelectedCode(stock.tsCode)}
                        onDoubleClick={() => openStockDrawer(stock)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setSelectedCode(stock.tsCode)
                          }
                        }}
                        className={`h-14 cursor-pointer border-b border-slate-100 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/40 dark:border-slate-800 ${selected ? 'bg-cyan-50/80 dark:bg-cyan-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/65'}`}
                      >
                        <td className="px-3 py-2"><span className={`inline-flex rounded border px-2 py-1 text-[10px] font-semibold ${tierTone(stock.quality.tier)}`}>{qualityLabel(stock.quality.tier)}</span><div className="mt-1 tabular-nums text-[10px] text-slate-400">{stock.quality.totalScore == null ? '待补分' : `${stock.quality.totalScore}分`}</div></td>
                        <td className="px-3 py-2"><div className="truncate font-semibold text-slate-900 dark:text-slate-100">{stock.stockName || stock.stockCode}</div><div className="mt-1 font-mono text-[10px] text-slate-400">{stock.stockCode} · {stock.limitPrice > 0 ? stock.limitPrice.toFixed(2) : '—'}</div></td>
                        <td className="px-3 py-2"><div className="font-medium tabular-nums text-slate-700 dark:text-slate-200">{stock.limitTime === '—' ? '时间待补' : stock.limitTime.slice(0, 5)}</div><div className="mt-1 text-[10px] text-slate-400">{stock.openTimes < 0 ? '开板待补' : stock.openTimes === 0 ? '未开板' : `开板${stock.openTimes}次`}</div></td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatAmount(stock.fundAmount)}</td>
                        <td className="px-3 py-2"><div className="truncate font-medium text-slate-700 dark:text-slate-200">{stock.conceptName}</div><div className="mt-1 text-[10px] text-slate-400">{stock.conceptZtNum > 0 ? `${stock.conceptZtNum}只涨停共振` : '广度待补'}</div></td>
                        <td className="px-3 py-2"><BoardPosition times={stock.limitTimes} /></td>
                        <td className="px-3 py-2"><div className={`line-clamp-2 leading-4 ${stock.quality.risks.length > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-400'}`}>{stock.quality.risks[0] ?? '暂无硬风险'}</div></td>
                      </tr>
                    )
                  })}
                  {filteredStocks.length === 0 && (
                    <tr><td colSpan={7} className="h-48 px-6 text-center"><div className="text-sm font-medium text-slate-700 dark:text-slate-200">当前筛选没有匹配项</div><button type="button" onClick={resetFilters} className="mt-3 h-11 rounded-md border border-slate-300 px-4 text-xs font-medium text-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:text-cyan-200">清除筛选</button></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <aside data-testid="limit-board-detail" className="min-h-0 overflow-y-auto border-t border-slate-200 bg-slate-50 px-4 py-3 lg:border-l lg:border-t-0 dark:border-slate-800 dark:bg-slate-950" aria-label="选中股票研判">
            {selectedStock ? (
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><h3 className="truncate text-sm font-semibold">{selectedStock.stockName}</h3><p className="mt-1 font-mono text-[10px] text-slate-400">{selectedStock.tsCode} · 规则 v{snapshot.strategyVersion}</p></div>
                  <span className={`shrink-0 rounded border px-2 py-1 text-[10px] font-semibold ${tierTone(selectedStock.quality.tier)}`}>{qualityLabel(selectedStock.quality.tier)}</span>
                </div>
                <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{selectedStock.quality.summary}</p>
                <div className="mt-4 space-y-2 border-y border-slate-200 py-3 dark:border-slate-800">
                  {selectedStock.quality.dimensions.map((dimension) => (
                    <div key={dimension.key}>
                      <div className="flex items-center justify-between gap-3 text-[11px]"><span className="text-slate-500 dark:text-slate-400">{dimension.label}</span><span className="truncate font-medium text-slate-700 dark:text-slate-200">{dimension.value}</span></div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><div className={`h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none ${dimensionTone(dimension.status)}`} style={{ width: dimension.score == null ? '0%' : `${Math.round(dimension.score / dimension.maxScore * 100)}%` }} /></div>
                      <p className="mt-1 text-[10px] leading-4 text-slate-400">{dimension.detail}</p>
                    </div>
                  ))}
                </div>
                <section className="mt-4"><h4 className="text-[11px] font-semibold text-slate-700 dark:text-slate-200">入选依据</h4><ul className="mt-2 space-y-1.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{selectedStock.quality.evidence.length > 0 ? selectedStock.quality.evidence.map((item) => <li key={item}>· {item}</li>) : <li>· 关键依据尚未补齐</li>}</ul></section>
                <section className="mt-4"><h4 className="text-[11px] font-semibold text-amber-800 dark:text-amber-200">风险</h4><ul className="mt-2 space-y-1.5 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{selectedStock.quality.risks.length > 0 ? selectedStock.quality.risks.map((item) => <li key={item}>· {item}</li>) : <li>· 暂无已识别硬风险，仍需观察盘中变化</li>}</ul></section>
                <section className="mt-4 grid grid-cols-1 gap-3">
                  <div><h4 className="text-[11px] font-semibold text-cyan-800 dark:text-cyan-200">继续确认</h4><ul className="mt-2 space-y-1 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{selectedStock.quality.confirmations.map((item) => <li key={item}>· {item}</li>)}</ul></div>
                  <div><h4 className="text-[11px] font-semibold text-red-800 dark:text-red-200">明确失效</h4><ul className="mt-2 space-y-1 text-[11px] leading-4 text-slate-600 dark:text-slate-300">{selectedStock.quality.invalidations.map((item) => <li key={item}>· {item}</li>)}</ul></div>
                </section>
                <button type="button" data-testid="limit-board-open-stock-drawer" onClick={() => openStockDrawer(selectedStock)} className="mt-5 h-11 w-full rounded-md bg-slate-900 px-3 text-xs font-semibold text-white outline-none transition-colors hover:bg-cyan-800 focus-visible:ring-2 focus-visible:ring-cyan-500/40 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-cyan-200">查看日K与筹码结构</button>
              </div>
            ) : <div className="flex h-full min-h-40 items-center justify-center text-xs text-slate-400">选择一只股票查看研判</div>}
          </aside>
        </div>
      ) : null}

      {drawerStock && (
        <StockKlineChipDrawer
          tsCode={drawerStock.tsCode}
          stockName={drawerStock.stockName}
          onClose={() => setDrawerStock(null)}
          onNavigate={() => { navigateToStock(drawerStock.stockCode, drawerStock.stockName); setDrawerStock(null) }}
        />
      )}
    </div>
  )
}
