import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/appStore'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { SHORT_TERM_WORKBENCH_ACTION_CLASS, ShortTermCombobox, type ShortTermComboboxOption } from './ShortTermDecisionControls'

type DataMode = 'realtime' | 'eod' | 'fallback'
type State = 'divergence' | 'waiting' | 'confirmed' | 'failed' | 'insufficient'
type DataStatus = 'complete' | 'partial' | 'insufficient'
type DimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'

interface Dimension {
  key: 'leaderIdentity' | 'divergenceQuality' | 'turnover' | 'repairProgress' | 'themeSupport'
  label: string
  score: number | null
  maxScore: number
  status: DimensionStatus
  value: string
  detail: string
}

interface StockJudgment {
  state: State
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  completeness: number
  dataStatus: DataStatus
  missingFields: string[]
  metrics: {
    isYin: boolean | null
    divergenceClosePositionPct: number | null
    drawdownFromPeakPct: number | null
    turnoverVsPeakPct: number | null
    repairProgressPct: number | null
    distanceToConfirmPct: number | null
    distanceToInvalidationPct: number | null
  }
  dimensions: Dimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
}

interface FirstYinStock {
  tsCode: string
  stockCode: string
  stockName: string
  price: number | null
  pctChg: number | null
  turnoverRatio: number | null
  peakTurnoverRatio: number | null
  peakBoards: number
  peakDate: string
  divergenceDate: string
  sessionsSinceDivergence: number
  confirmPrice: number | null
  invalidationPrice: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  judgment: StockJudgment
}

interface WorkbenchJudgment {
  stance: 'confirmed' | 'watch' | 'defensive' | 'insufficient'
  title: string
  summary: string
  divergenceCount: number
  waitingCount: number
  confirmedCount: number
  failedCount: number
  insufficientCount: number
  analyzedCount: number
  completeness: number
  dataStatus: DataStatus
  missingFields: string[]
  strategyVersion: string
}

interface FirstYinSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: DataMode
  rtDataTime: string | null
  candidateCount: number
  conceptList: string[]
  stocks: FirstYinStock[]
  judgment: WorkbenchJudgment
  strategyVersion: string
}

interface FirstYinDipProps {
  dataTools?: ReactNode
  onOpenHistory?: () => void
}

const STATE_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部事件状态' },
  { value: 'confirmed', label: '修复确认' },
  { value: 'waiting', label: '修复等待' },
  { value: 'divergence', label: '首次分歧' },
  { value: 'failed', label: '修复失败' },
  { value: 'insufficient', label: '证据待补' },
]

const PEAK_OPTIONS: ShortTermComboboxOption[] = [
  { value: '3', label: '三板及以上' },
  { value: '4', label: '四板及以上' },
  { value: '5', label: '五板及以上' },
  { value: '6', label: '六板及以上' },
]

const RISK_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部风险状态' },
  { value: 'risk', label: '存在明确风险' },
  { value: 'clean', label: '未触发硬风险' },
]

function modeLabel(mode: DataMode): string {
  if (mode === 'realtime') return '盘中实时'
  if (mode === 'fallback') return '最近事实日回退'
  return '盘后完整'
}

function formatDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '待补'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatPrice(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '待补' : value.toFixed(2)
}

function stateClass(state: State): string {
  if (state === 'confirmed') return 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/45 dark:text-cyan-200'
  if (state === 'waiting') return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/45 dark:text-blue-200'
  if (state === 'divergence') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/45 dark:text-amber-200'
  if (state === 'failed') return 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/45 dark:text-red-200'
  return 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
}

function stanceClass(stance: WorkbenchJudgment['stance']): string {
  if (stance === 'confirmed') return 'border-cyan-200 bg-cyan-50/65 dark:border-cyan-900 dark:bg-cyan-950/30'
  if (stance === 'watch') return 'border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/25'
  if (stance === 'defensive') return 'border-red-200 bg-red-50/65 dark:border-red-900 dark:bg-red-950/25'
  return 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/30'
}

function statusText(status: DimensionStatus): string {
  if (status === 'strong') return '支持'
  if (status === 'weak') return '偏弱'
  if (status === 'unknown') return '待补'
  return '中性'
}

function hasRisk(stock: FirstYinStock): boolean {
  return stock.judgment.state === 'failed' || stock.judgment.dimensions.some((dimension) => dimension.status === 'weak')
}

function DetailList({ title, items, tone }: { title: string; items: string[]; tone: 'evidence' | 'risk' | 'confirm' | 'invalidate' }): JSX.Element {
  const dot = tone === 'risk' || tone === 'invalidate' ? 'bg-red-500' : tone === 'confirm' ? 'bg-cyan-500' : 'bg-slate-400'
  return (
    <section>
      <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100">{title}</h4>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => <li key={item} className="flex gap-2 text-xs leading-5 text-slate-600 dark:text-slate-300"><span aria-hidden="true" className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} /><span>{item}</span></li>)}
        </ul>
      ) : <p className="mt-2 text-xs text-slate-400">当前没有可披露项</p>}
    </section>
  )
}

export function FirstYinDip({ dataTools, onOpenHistory }: FirstYinDipProps): JSX.Element {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const [snapshot, setSnapshot] = useState<FirstYinSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stateFilter, setStateFilter] = useState('all')
  const [conceptFilter, setConceptFilter] = useState('all')
  const [peakFilter, setPeakFilter] = useState('3')
  const [riskFilter, setRiskFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [drawerStock, setDrawerStock] = useState<{ tsCode: string; stockCode: string; stockName: string } | null>(null)

  const loadSnapshot = useCallback(async (forceRefresh = false): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const api = (window as typeof window & { api?: { shortTerm?: { firstYinDip?: {
        get: (tradeDate?: string) => Promise<{ ok: true; snapshot: FirstYinSnapshot }>
        refresh: (tradeDate?: string) => Promise<{ ok: true; snapshot: FirstYinSnapshot }>
      } } } }).api?.shortTerm?.firstYinDip
      if (!api) throw new Error('首阴状态机运行组件尚未加载，请重启应用后再试')
      const response = forceRefresh ? await api.refresh() : await api.get()
      if (!response.snapshot?.judgment || response.snapshot.strategyVersion !== '2.0.0') {
        throw new Error('首阴状态机版本尚未加载，请重启应用后再试')
      }
      setSnapshot(response.snapshot)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '首阴回踩加载失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSnapshot(false) }, [loadSnapshot])

  const conceptOptions = useMemo<ShortTermComboboxOption[]>(() => [
    { value: 'all', label: '全部题材' },
    ...(snapshot?.conceptList ?? []).map((concept) => ({ value: concept, label: concept })),
  ], [snapshot])

  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN')
    const minPeak = Number(peakFilter)
    return (snapshot?.stocks ?? []).filter((stock) => {
      if (stateFilter !== 'all' && stock.judgment.state !== stateFilter) return false
      if (conceptFilter !== 'all' && stock.conceptName !== conceptFilter) return false
      if (stock.peakBoards < minPeak) return false
      if (riskFilter === 'risk' && !hasRisk(stock)) return false
      if (riskFilter === 'clean' && hasRisk(stock)) return false
      if (keyword && !`${stock.stockCode} ${stock.stockName}`.toLocaleLowerCase('zh-CN').includes(keyword)) return false
      return true
    })
  }, [conceptFilter, peakFilter, riskFilter, search, snapshot, stateFilter])

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedCode(null)
      return
    }
    if (!filtered.some((stock) => stock.tsCode === selectedCode)) setSelectedCode(filtered[0].tsCode)
  }, [filtered, selectedCode])

  const selected = filtered.find((stock) => stock.tsCode === selectedCode) ?? null
  const resetFilters = (): void => {
    setStateFilter('all')
    setConceptFilter('all')
    setPeakFilter('3')
    setRiskFilter('all')
    setSearch('')
  }
  const openDrawer = (stock: FirstYinStock): void => setDrawerStock({ tsCode: stock.tsCode, stockCode: stock.stockCode, stockName: stock.stockName })

  return (
    <div data-testid="first-yin-workbench" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">首阴回踩</h2>
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">事实日 {formatDate(snapshot.tradeDate)}</span>}
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">{modeLabel(snapshot.dataMode)}</span>}
            {snapshot?.rtDataTime && <span className="text-[11px] text-slate-400">行情 {snapshot.rtDataTime}</span>}
            {snapshot && <span className="text-[11px] text-slate-400">更新 {formatTime(snapshot.generatedAt)}</span>}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">追踪近期高标断板后的首次分歧、修复边界与失败状态</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button type="button" data-testid="first-yin-refresh" disabled={loading} onClick={() => void loadSnapshot(true)} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>{loading ? '刷新中' : '刷新研判'}</button>
          <button type="button" data-testid="first-yin-history" disabled={!onOpenHistory} onClick={onOpenHistory} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>历史表现</button>
          {dataTools}
        </div>
      </header>

      {error && <div role="alert" className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/35 dark:text-red-200"><span>{error}</span><button type="button" onClick={() => void loadSnapshot(true)} className="h-11 px-3 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30">重试</button></div>}

      {snapshot && (
        <>
          <section data-testid="first-yin-conclusion" className={`shrink-0 border-b px-4 py-3 ${stanceClass(snapshot.judgment.stance)}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1"><h3 className="text-sm font-semibold">{snapshot.judgment.title}</h3><p className="mt-1 max-w-4xl text-xs leading-5 text-slate-600 dark:text-slate-300">{snapshot.judgment.summary}</p></div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300"><span>分歧 <strong>{snapshot.judgment.divergenceCount}</strong></span><span>等待 <strong>{snapshot.judgment.waitingCount}</strong></span><span>确认 <strong className="text-cyan-700 dark:text-cyan-300">{snapshot.judgment.confirmedCount}</strong></span><span>失败 <strong className="text-red-700 dark:text-red-300">{snapshot.judgment.failedCount}</strong></span><span>不足 <strong>{snapshot.judgment.insufficientCount}</strong></span><span>完整度 <strong>{snapshot.judgment.completeness}%</strong></span></div>
            </div>
          </section>

          <div className="shrink-0 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[170px_190px_170px_180px_minmax(180px,1fr)_auto]">
              <ShortTermCombobox value={stateFilter} options={STATE_OPTIONS} ariaLabel="首阴事件状态" testId="first-yin-state-filter" onChange={setStateFilter} />
              <ShortTermCombobox value={conceptFilter} options={conceptOptions} ariaLabel="首阴题材筛选" testId="first-yin-concept-filter" onChange={setConceptFilter} />
              <ShortTermCombobox value={peakFilter} options={PEAK_OPTIONS} ariaLabel="最低高标高度" testId="first-yin-peak-filter" onChange={setPeakFilter} />
              <ShortTermCombobox value={riskFilter} options={RISK_OPTIONS} ariaLabel="首阴风险筛选" testId="first-yin-risk-filter" onChange={setRiskFilter} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索首阴候选股票" placeholder="搜索代码或名称" className="h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-xs outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
              <button type="button" onClick={resetFilters} className="h-11 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-600 outline-none hover:border-cyan-500 hover:text-cyan-700 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:text-slate-300">重置</button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden">
            <section className="min-w-0 border-b border-slate-200 xl:min-h-0 xl:border-b-0 xl:border-r dark:border-slate-800">
              {filtered.length > 0 ? (
                <div className="h-full min-h-[280px] overflow-auto">
                  <table className="w-full min-w-[880px] table-fixed text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-medium text-slate-500 shadow-[0_1px_0_rgba(148,163,184,0.25)] dark:bg-slate-950 dark:text-slate-400"><tr><th className="w-40 px-4 py-3">股票</th><th className="w-28 px-3 py-3">当前状态</th><th className="w-28 px-3 py-3">高标事件</th><th className="w-28 px-3 py-3">首次分歧</th><th className="w-28 px-3 py-3 text-right">确认 / 失效</th><th className="w-24 px-3 py-3 text-right">修复进度</th><th className="w-28 px-3 py-3 text-right">换手承接</th><th className="px-3 py-3">题材支撑</th></tr></thead>
                    <tbody>
                      {filtered.map((stock) => {
                        const active = stock.tsCode === selectedCode
                        return (
                          <tr key={stock.tsCode} data-testid={`first-yin-row-${stock.stockCode}`} onClick={() => setSelectedCode(stock.tsCode)} onDoubleClick={() => openDrawer(stock)} className={`cursor-pointer border-b border-slate-100 outline-none transition-colors motion-reduce:transition-none dark:border-slate-800 ${active ? 'bg-cyan-50/70 dark:bg-cyan-950/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800/65'}`}>
                            <td className="px-4 py-3"><button type="button" onClick={() => setSelectedCode(stock.tsCode)} className="min-h-11 w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30"><span className="block truncate font-semibold">{stock.stockName}</span><span className="mt-0.5 block font-mono text-[10px] text-slate-400">{stock.stockCode} · {formatPct(stock.pctChg)}</span></button></td>
                            <td className="px-3 py-3"><span className={`inline-flex min-h-7 items-center rounded border px-2 text-[11px] font-medium ${stateClass(stock.judgment.state)}`}>{stock.judgment.title}</span></td>
                            <td className="px-3 py-3"><strong>{stock.peakBoards}板</strong><span className="mt-0.5 block text-[10px] text-slate-400">{formatDate(stock.peakDate)}</span></td>
                            <td className="px-3 py-3"><span>{formatDate(stock.divergenceDate)}</span><span className="mt-0.5 block text-[10px] text-slate-400">第{stock.sessionsSinceDivergence}个交易日</span></td>
                            <td className="px-3 py-3 text-right font-mono"><span className="block text-cyan-700 dark:text-cyan-300">{formatPrice(stock.confirmPrice)}</span><span className="mt-0.5 block text-[10px] text-red-600 dark:text-red-300">{formatPrice(stock.invalidationPrice)}</span></td>
                            <td className="px-3 py-3 text-right font-mono">{stock.judgment.metrics.repairProgressPct == null ? '待补' : `${stock.judgment.metrics.repairProgressPct.toFixed(0)}%`}</td>
                            <td className="px-3 py-3 text-right"><span>{stock.turnoverRatio == null ? '待补' : `${stock.turnoverRatio.toFixed(2)}%`}</span><span className="mt-0.5 block text-[10px] text-slate-400">{stock.judgment.metrics.turnoverVsPeakPct == null ? '高标日待补' : `高标日${stock.judgment.metrics.turnoverVsPeakPct.toFixed(0)}%`}</span></td>
                            <td className="px-3 py-3"><span className="block truncate">{stock.conceptName ?? '题材待补'}</span><span className="mt-0.5 block text-[10px] text-slate-400">{stock.conceptLimitUpCount == null ? '广度待补' : `${stock.conceptLimitUpCount}只涨停`}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex min-h-[280px] flex-col items-center justify-center px-6 text-center"><h3 className="text-sm font-semibold">{snapshot.stocks.length === 0 ? '近期没有可跟踪的高标断板事件' : '筛选后没有候选'}</h3><p className="mt-2 max-w-lg text-xs leading-5 text-slate-500 dark:text-slate-400">{snapshot.stocks.length === 0 ? '候选只来自近期真实三板及以上连板事件；若预期有数据，请先补齐目标日的涨停榜和日线缓存。' : '调整状态、题材、高标高度、风险或搜索条件后重试。'}</p>{snapshot.stocks.length > 0 && <button type="button" onClick={resetFilters} className="mt-3 h-11 rounded-md border border-slate-300 px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700">清除筛选</button>}</div>
              )}
            </section>

            <aside data-testid="first-yin-detail" className="min-h-[420px] overflow-y-auto bg-slate-50/60 p-4 xl:min-h-0 dark:bg-slate-950/35">
              {selected ? (
                <div className="space-y-5">
                  <div><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{selected.stockName} <span className="font-mono text-[11px] font-normal text-slate-400">{selected.stockCode}</span></h3><span className={`mt-2 inline-flex min-h-7 items-center rounded border px-2 text-[11px] font-medium ${stateClass(selected.judgment.state)}`}>{selected.judgment.title}</span></div><span className="text-right text-[10px] leading-5 text-slate-400">结论完整度<br /><strong className="text-xs text-slate-700 dark:text-slate-200">{selected.judgment.completeness}%</strong></span></div><p className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{selected.judgment.summary}</p><div className="mt-3 grid grid-cols-3 gap-2 border-y border-slate-200 py-3 text-center dark:border-slate-800"><div><span className="block text-[10px] text-slate-400">当前价</span><strong className="mt-1 block font-mono text-xs">{formatPrice(selected.price)}</strong></div><div><span className="block text-[10px] text-slate-400">确认线</span><strong className="mt-1 block font-mono text-xs text-cyan-700 dark:text-cyan-300">{formatPrice(selected.confirmPrice)}</strong></div><div><span className="block text-[10px] text-slate-400">失效线</span><strong className="mt-1 block font-mono text-xs text-red-700 dark:text-red-300">{formatPrice(selected.invalidationPrice)}</strong></div></div></div>
                  <section><h4 className="text-xs font-semibold">五维事实</h4><div className="mt-2 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">{selected.judgment.dimensions.map((dimension) => <div key={dimension.key} className="grid grid-cols-[84px_1fr_auto] gap-2 py-2.5 text-xs"><span className="font-medium text-slate-700 dark:text-slate-200">{dimension.label}</span><span className="min-w-0 text-slate-500 dark:text-slate-400"><span className="block text-slate-700 dark:text-slate-200">{dimension.value}</span><span className="mt-0.5 block text-[10px] leading-4">{dimension.detail}</span></span><span className={`text-[10px] font-medium ${dimension.status === 'strong' ? 'text-cyan-700 dark:text-cyan-300' : dimension.status === 'weak' ? 'text-red-700 dark:text-red-300' : 'text-slate-400'}`}>{statusText(dimension.status)}</span></div>)}</div></section>
                  <DetailList title="支持依据" items={selected.judgment.evidence} tone="evidence" />
                  <DetailList title="当前风险" items={selected.judgment.risks} tone="risk" />
                  <DetailList title="继续确认" items={selected.judgment.confirmations} tone="confirm" />
                  <DetailList title="明确失效" items={selected.judgment.invalidations} tone="invalidate" />
                  <button type="button" data-testid="first-yin-open-stock-drawer" onClick={() => openDrawer(selected)} className="h-11 w-full rounded-md border border-cyan-300 bg-white px-3 text-xs font-semibold text-cyan-800 outline-none transition-colors hover:bg-cyan-50 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-cyan-800 dark:bg-slate-950 dark:text-cyan-200 dark:hover:bg-cyan-950/35">查看日K与筹码结构</button>
                </div>
              ) : <div className="flex h-full min-h-[300px] items-center justify-center text-center text-xs text-slate-400">选择一只候选查看状态边界与后续条件</div>}
            </aside>
          </div>
        </>
      )}

      {!snapshot && loading && <div className="flex flex-1 items-center justify-center text-sm text-slate-400">正在重建近期高标事件状态…</div>}
      {!snapshot && !loading && !error && <div className="flex flex-1 items-center justify-center text-sm text-slate-400">暂无首阴回踩快照</div>}
      {drawerStock && <StockKlineChipDrawer tsCode={drawerStock.tsCode} stockName={drawerStock.stockName} onClose={() => setDrawerStock(null)} onNavigate={() => { navigateToStock(drawerStock.stockCode, drawerStock.stockName); setDrawerStock(null) }} />}
    </div>
  )
}
