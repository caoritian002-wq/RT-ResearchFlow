import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/appStore'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { SHORT_TERM_WORKBENCH_ACTION_CLASS, ShortTermCombobox, type ShortTermComboboxOption } from './ShortTermDecisionControls'

type DipMode = 'trendDip' | 'arbitrageDip' | 'rotationDip'
type DataMode = 'realtime' | 'eod' | 'fallback'
type ConditionStatus = 'passed' | 'failed' | 'unknown'
type CandidateTier = 'focus' | 'watch' | 'insufficient' | 'rejected'
type DataStatus = 'complete' | 'partial' | 'insufficient'
type ModeStatus = 'available' | 'watch' | 'blocked' | 'empty' | 'insufficient'

interface DipCondition {
  key: string
  label: string
  status: ConditionStatus
  value: string
  detail: string
  required: boolean
}

interface CandidateJudgment {
  tier: CandidateTier
  title: string
  summary: string
  rankScore: number | null
  completeness: number
  dataStatus: DataStatus
  missingFields: string[]
  conditions: DipCondition[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
}

interface DipStock {
  mode: DipMode
  tsCode: string
  stockCode: string
  stockName: string
  price: number | null
  pctChg: number | null
  amountWan: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  recentPeakBoards: number | null
  recentPeakDate: string | null
  recentLimitUpDate: string | null
  ma10: number | null
  ma20: number | null
  ma30: number | null
  ma20Slope5Pct: number | null
  nearestMaLabel: string | null
  distanceToNearestMaPct: number | null
  drop5dPct: number | null
  netMoneyFlowAmount: number | null
  volumeRatio5: number | null
  leaderTsCode: string | null
  leaderName: string | null
  leaderPreviousBoards: number | null
  leaderPctChg: number | null
  judgment: CandidateJudgment
}

interface ModeJudgment {
  mode: DipMode
  status: ModeStatus
  title: string
  summary: string
  screenedCount: number
  focusCount: number
  watchCount: number
  insufficientCount: number
  rejectedCount: number
  completeness: number
  dataStatus: DataStatus
  gates: DipCondition[]
  missingFields: string[]
  strategyKey: string
  strategyVersion: string
}

interface ModeSnapshot {
  stocks: DipStock[]
  judgment: ModeJudgment
}

interface DipBuyRadarSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: DataMode
  rtDataTime: string | null
  sentiment: {
    ztCount: number | null
    dtCount: number | null
    temperature: number | null
    previousTradeDate: string | null
    hotConcepts: Array<{ name: string; ztNum: number }>
    retreatThemes: Array<{ name: string; previousLimitUpCount: number; currentLimitUpCount: number }>
  }
  modes: Record<DipMode, ModeSnapshot>
  strategyVersion: string
}

interface DipBuyRadarProps {
  dataTools?: ReactNode
  onOpenHistory?: (strategyKey: string) => void
}

const MODE_DEFS: Record<DipMode, { label: string; shortQuestion: string }> = {
  trendDip: { label: '趋势低吸', shortQuestion: '强势趋势是否回踩到可验证支撑' },
  arbitrageDip: { label: '套利低吸', shortQuestion: '冰点退潮中是否出现资金或缩量确认' },
  rotationDip: { label: '轮动低吸', shortQuestion: '高位打开后是否存在真实低位补涨' },
}

const TIER_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部观察层级' },
  { value: 'focus', label: '重点观察' },
  { value: 'watch', label: '选择性观察' },
  { value: 'insufficient', label: '证据待补' },
]

const RISK_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部风险状态' },
  { value: 'risk', label: '存在风险或待补' },
  { value: 'clean', label: '未触发风险' },
]

function modeLabel(mode: DataMode): string {
  if (mode === 'realtime') return '盘中实时'
  if (mode === 'fallback') return '最近事实日回退'
  return '盘后完整'
}

function formatDate(value: string | null): string {
  if (!value) return '待补'
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

function formatAmountWan(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '待补'
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(2)}亿`
  return `${value.toFixed(0)}万`
}

function tierClass(tier: CandidateTier): string {
  if (tier === 'focus') return 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/45 dark:text-cyan-200'
  if (tier === 'watch') return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/45 dark:text-blue-200'
  if (tier === 'rejected') return 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/45 dark:text-red-200'
  return 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
}

function modeStatusClass(status: ModeStatus): string {
  if (status === 'available') return 'border-cyan-200 bg-cyan-50/65 dark:border-cyan-900 dark:bg-cyan-950/30'
  if (status === 'watch') return 'border-blue-200 bg-blue-50/60 dark:border-blue-900 dark:bg-blue-950/25'
  if (status === 'blocked') return 'border-amber-200 bg-amber-50/65 dark:border-amber-900 dark:bg-amber-950/25'
  if (status === 'insufficient') return 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-950/30'
  return 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
}

function conditionTone(status: ConditionStatus): string {
  if (status === 'passed') return 'text-cyan-700 dark:text-cyan-300'
  if (status === 'failed') return 'text-red-700 dark:text-red-300'
  return 'text-slate-400'
}

function conditionText(status: ConditionStatus): string {
  if (status === 'passed') return '通过'
  if (status === 'failed') return '未通过'
  return '待补'
}

function hasRisk(stock: DipStock): boolean {
  return stock.judgment.risks.length > 0 || stock.judgment.tier === 'insufficient'
}

function keyMetric(stock: DipStock): { primary: string; secondary: string } {
  if (stock.mode === 'trendDip') {
    return {
      primary: stock.nearestMaLabel && stock.distanceToNearestMaPct != null
        ? `${stock.nearestMaLabel} ${formatPct(stock.distanceToNearestMaPct)}`
        : '均线待补',
      secondary: stock.ma20Slope5Pct == null ? 'MA20方向待补' : `MA20五日 ${formatPct(stock.ma20Slope5Pct)}`,
    }
  }
  if (stock.mode === 'arbitrageDip') {
    const capital = stock.netMoneyFlowAmount != null && stock.netMoneyFlowAmount > 0
      ? `净流入 ${formatAmountWan(stock.netMoneyFlowAmount)}`
      : stock.volumeRatio5 != null
        ? `量比 ${stock.volumeRatio5.toFixed(2)}`
        : '资金/缩量待补'
    return { primary: capital, secondary: `五日 ${formatPct(stock.drop5dPct)}` }
  }
  return {
    primary: `${stock.leaderName ?? '龙头待补'} ${stock.leaderPreviousBoards == null ? '' : `${stock.leaderPreviousBoards}板`}`.trim(),
    secondary: `龙头 ${formatPct(stock.leaderPctChg)}`,
  }
}

function detailMetrics(stock: DipStock): Array<{ label: string; value: string; tone?: string }> {
  if (stock.mode === 'trendDip') {
    return [
      { label: '当前价', value: formatPrice(stock.price) },
      { label: '最近支撑', value: stock.nearestMaLabel && stock.distanceToNearestMaPct != null ? `${stock.nearestMaLabel} ${formatPct(stock.distanceToNearestMaPct)}` : '待补', tone: 'text-cyan-700 dark:text-cyan-300' },
      { label: 'MA20方向', value: formatPct(stock.ma20Slope5Pct) },
    ]
  }
  if (stock.mode === 'arbitrageDip') {
    return [
      { label: '当日涨跌', value: formatPct(stock.pctChg) },
      { label: '五日累计', value: formatPct(stock.drop5dPct) },
      { label: stock.netMoneyFlowAmount != null && stock.netMoneyFlowAmount > 0 ? '资金净流入' : '成交量比', value: stock.netMoneyFlowAmount != null && stock.netMoneyFlowAmount > 0 ? formatAmountWan(stock.netMoneyFlowAmount) : stock.volumeRatio5 == null ? '待补' : stock.volumeRatio5.toFixed(2), tone: 'text-cyan-700 dark:text-cyan-300' },
    ]
  }
  return [
    { label: '候选涨跌', value: formatPct(stock.pctChg) },
    { label: '关联龙头', value: stock.leaderName ?? '待补', tone: 'text-cyan-700 dark:text-cyan-300' },
    { label: '龙头涨跌', value: formatPct(stock.leaderPctChg) },
  ]
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

export function DipBuyRadar({ dataTools, onOpenHistory }: DipBuyRadarProps): JSX.Element {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const [snapshot, setSnapshot] = useState<DipBuyRadarSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeMode, setActiveMode] = useState<DipMode>('trendDip')
  const [tierFilter, setTierFilter] = useState('all')
  const [conceptFilter, setConceptFilter] = useState('all')
  const [riskFilter, setRiskFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [drawerStock, setDrawerStock] = useState<{ tsCode: string; stockCode: string; stockName: string } | null>(null)

  const loadSnapshot = useCallback(async (forceRefresh = false): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const api = (window as typeof window & { api?: { shortTerm?: { dipBuyRadar?: {
        get: (tradeDate?: string) => Promise<{ ok: true; snapshot: DipBuyRadarSnapshot }>
        refresh: (tradeDate?: string) => Promise<{ ok: true; snapshot: DipBuyRadarSnapshot }>
      } } } }).api?.shortTerm?.dipBuyRadar
      if (!api) throw new Error('低吸雷达运行组件尚未加载，请重启应用后再试')
      const response = forceRefresh ? await api.refresh() : await api.get()
      if (!response.snapshot?.modes?.trendDip?.judgment || response.snapshot.strategyVersion !== '2.0.0') {
        throw new Error('低吸雷达V2尚未加载，请重启应用后再试')
      }
      setSnapshot(response.snapshot)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '低吸雷达加载失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSnapshot(false) }, [loadSnapshot])

  const activeSnapshot = snapshot?.modes[activeMode] ?? null
  const conceptOptions = useMemo<ShortTermComboboxOption[]>(() => [
    { value: 'all', label: '全部题材' },
    ...Array.from(new Set((activeSnapshot?.stocks ?? []).map((stock) => stock.conceptName).filter((value): value is string => value != null)))
      .sort((left, right) => left.localeCompare(right, 'zh-CN'))
      .map((value) => ({ value, label: value })),
  ], [activeSnapshot])

  const filtered = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase('zh-CN')
    return (activeSnapshot?.stocks ?? []).filter((stock) => {
      if (tierFilter !== 'all' && stock.judgment.tier !== tierFilter) return false
      if (conceptFilter !== 'all' && stock.conceptName !== conceptFilter) return false
      if (riskFilter === 'risk' && !hasRisk(stock)) return false
      if (riskFilter === 'clean' && hasRisk(stock)) return false
      if (normalized && !`${stock.stockName} ${stock.stockCode} ${stock.conceptName ?? ''} ${stock.leaderName ?? ''}`.toLocaleLowerCase('zh-CN').includes(normalized)) return false
      return true
    })
  }, [activeSnapshot, conceptFilter, riskFilter, search, tierFilter])

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedCode(null)
      return
    }
    if (!filtered.some((stock) => stock.tsCode === selectedCode)) setSelectedCode(filtered[0].tsCode)
  }, [filtered, selectedCode])

  useEffect(() => {
    setTierFilter('all')
    setConceptFilter('all')
    setRiskFilter('all')
    setSearch('')
    setSelectedCode(null)
  }, [activeMode])

  const selected = filtered.find((stock) => stock.tsCode === selectedCode) ?? null
  const resetFilters = (): void => {
    setTierFilter('all')
    setConceptFilter('all')
    setRiskFilter('all')
    setSearch('')
  }
  const openDrawer = (stock: DipStock): void => setDrawerStock({ tsCode: stock.tsCode, stockCode: stock.stockCode, stockName: stock.stockName })

  return (
    <div data-testid="dip-buy-workbench" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">低吸雷达</h2>
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">事实日 {formatDate(snapshot.tradeDate)}</span>}
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">{modeLabel(snapshot.dataMode)}</span>}
            {snapshot?.rtDataTime && <span className="text-[11px] text-slate-400">行情 {snapshot.rtDataTime}</span>}
            {snapshot && <span className="text-[11px] text-slate-400">更新 {formatTime(snapshot.generatedAt)}</span>}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">趋势、冰点套利与题材轮动分别验证，不共享候选门槛</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button type="button" data-testid="dip-buy-refresh" disabled={loading} onClick={() => void loadSnapshot(true)} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>{loading ? '刷新中' : '刷新研判'}</button>
          <button type="button" data-testid="dip-buy-history" disabled={!onOpenHistory || !activeSnapshot} onClick={() => activeSnapshot && onOpenHistory?.(activeSnapshot.judgment.strategyKey)} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>历史表现</button>
          {dataTools}
        </div>
      </header>

      {error && <div role="alert" className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/35 dark:text-red-200"><span>{error}</span><button type="button" onClick={() => void loadSnapshot(true)} className="h-11 px-3 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30">重试</button></div>}

      {snapshot && activeSnapshot && (
        <>
          <nav aria-label="低吸模式" className="grid shrink-0 grid-cols-3 border-b border-slate-200 bg-slate-50/70 px-4 py-2 dark:border-slate-800 dark:bg-slate-950/35">
            {(Object.keys(MODE_DEFS) as DipMode[]).map((mode) => {
              const item = snapshot.modes[mode]
              const active = mode === activeMode
              return <button key={mode} type="button" data-testid={`dip-buy-mode-${mode}`} aria-pressed={active} onClick={() => setActiveMode(mode)} className={`min-h-11 border-b-2 px-3 text-left outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${active ? 'border-cyan-500 bg-white text-cyan-800 dark:bg-slate-900 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:bg-white/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-900/70 dark:hover:text-slate-100'}`}><span className="block text-xs font-semibold">{MODE_DEFS[mode].label}</span><span className="mt-0.5 block truncate text-[10px] opacity-75">重点 {item.judgment.focusCount} · 观察 {item.judgment.watchCount} · 待补 {item.judgment.insufficientCount}</span></button>
            })}
          </nav>

          <section data-testid="dip-buy-conclusion" className={`shrink-0 border-b px-4 py-3 ${modeStatusClass(activeSnapshot.judgment.status)}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{activeSnapshot.judgment.title}</h3><span className="text-[10px] text-slate-400">{MODE_DEFS[activeMode].shortQuestion}</span></div><p className="mt-1 max-w-4xl text-xs leading-5 text-slate-600 dark:text-slate-300">{activeSnapshot.judgment.summary}</p></div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300"><span>重点 <strong className="text-cyan-700 dark:text-cyan-300">{activeSnapshot.judgment.focusCount}</strong></span><span>观察 <strong>{activeSnapshot.judgment.watchCount}</strong></span><span>待补 <strong>{activeSnapshot.judgment.insufficientCount}</strong></span><span>筛除 <strong>{activeSnapshot.judgment.rejectedCount}</strong></span><span>完整度 <strong>{activeSnapshot.judgment.completeness}%</strong></span></div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {activeSnapshot.judgment.gates.map((gate) => <span key={gate.key} title={gate.detail} className={`inline-flex min-h-7 items-center gap-1 rounded border border-current/20 bg-white/60 px-2 text-[10px] font-medium dark:bg-slate-950/30 ${conditionTone(gate.status)}`}><span>{gate.label}</span><span>{gate.value}</span><span>{conditionText(gate.status)}</span></span>)}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
              <span>涨停 {snapshot.sentiment.ztCount ?? '待补'} / 跌停 {snapshot.sentiment.dtCount ?? '待补'}</span>
              <span>退潮题材 {snapshot.sentiment.retreatThemes.length > 0 ? snapshot.sentiment.retreatThemes.slice(0, 3).map((theme) => `${theme.name} ${theme.previousLimitUpCount}→${theme.currentLimitUpCount}`).join(' · ') : '无或待补'}</span>
              <span>当日热点 {snapshot.sentiment.hotConcepts.length > 0 ? snapshot.sentiment.hotConcepts.slice(0, 3).map((theme) => `${theme.name} ${theme.ztNum}`).join(' · ') : '待补'}</span>
            </div>
          </section>

          <div className="shrink-0 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[180px_190px_190px_minmax(180px,1fr)_auto]">
              <ShortTermCombobox value={tierFilter} options={TIER_OPTIONS} ariaLabel="低吸观察层级" testId="dip-buy-tier-filter" onChange={setTierFilter} />
              <ShortTermCombobox value={conceptFilter} options={conceptOptions} ariaLabel="低吸题材筛选" testId="dip-buy-concept-filter" onChange={setConceptFilter} />
              <ShortTermCombobox value={riskFilter} options={RISK_OPTIONS} ariaLabel="低吸风险筛选" testId="dip-buy-risk-filter" onChange={setRiskFilter} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索低吸候选股票" placeholder="搜索代码、名称、题材或龙头" className="h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-xs outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
              <button type="button" onClick={resetFilters} className="h-11 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-600 outline-none hover:border-cyan-500 hover:text-cyan-700 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:text-slate-300">重置</button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden">
            <section className="min-w-0 border-b border-slate-200 xl:min-h-0 xl:border-b-0 xl:border-r dark:border-slate-800">
              {filtered.length > 0 ? (
                <div className="h-full min-h-[280px] overflow-auto">
                  <table className="w-full min-w-[820px] table-fixed text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-medium text-slate-500 shadow-[0_1px_0_rgba(148,163,184,0.25)] dark:bg-slate-950 dark:text-slate-400"><tr><th className="w-40 px-4 py-3">股票</th><th className="w-28 px-3 py-3">观察层级</th><th className="w-28 px-3 py-3 text-right">价格状态</th><th className="w-32 px-3 py-3">模式关键事实</th><th className="w-28 px-3 py-3">近期强势</th><th className="w-32 px-3 py-3">题材</th><th className="px-3 py-3">主要风险</th></tr></thead>
                    <tbody>
                      {filtered.map((stock) => {
                        const active = stock.tsCode === selectedCode
                        const metric = keyMetric(stock)
                        return <tr key={stock.tsCode} data-testid={`dip-buy-row-${stock.stockCode}`} onClick={() => setSelectedCode(stock.tsCode)} onDoubleClick={() => openDrawer(stock)} className={`cursor-pointer border-b border-slate-100 outline-none transition-colors motion-reduce:transition-none dark:border-slate-800 ${active ? 'bg-cyan-50/70 dark:bg-cyan-950/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800/65'}`}>
                          <td className="px-4 py-3"><button type="button" onClick={() => setSelectedCode(stock.tsCode)} className="min-h-11 w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30"><span className="block truncate font-semibold">{stock.stockName}</span><span className="mt-0.5 block font-mono text-[10px] text-slate-400">{stock.stockCode} · {formatAmountWan(stock.amountWan)}</span></button></td>
                          <td className="px-3 py-3"><span className={`inline-flex min-h-7 items-center rounded border px-2 text-[11px] font-medium ${tierClass(stock.judgment.tier)}`}>{stock.judgment.title}</span><span className="mt-1 block text-[10px] text-slate-400">完整度 {stock.judgment.completeness}%</span></td>
                          <td className="px-3 py-3 text-right font-mono"><span className="block">{formatPrice(stock.price)}</span><span className={`mt-0.5 block text-[10px] ${stock.pctChg != null && stock.pctChg < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{formatPct(stock.pctChg)}</span></td>
                          <td className="px-3 py-3"><span className="block truncate font-medium">{metric.primary}</span><span className="mt-0.5 block truncate text-[10px] text-slate-400">{metric.secondary}</span></td>
                          <td className="px-3 py-3"><span>{stock.recentPeakBoards == null ? '待补' : `${stock.recentPeakBoards}板`}</span><span className="mt-0.5 block text-[10px] text-slate-400">{formatDate(stock.recentPeakDate ?? stock.recentLimitUpDate)}</span></td>
                          <td className="px-3 py-3"><span className="block truncate">{stock.conceptName ?? '题材待补'}</span><span className="mt-0.5 block text-[10px] text-slate-400">{stock.conceptLimitUpCount == null ? '广度待补' : `${stock.conceptLimitUpCount}只涨停`}</span></td>
                          <td className="px-3 py-3"><span className="line-clamp-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">{stock.judgment.risks[0] ?? '未触发明确风险'}</span></td>
                        </tr>
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex min-h-[280px] flex-col items-center justify-center px-6 text-center"><h3 className="text-sm font-semibold">{activeSnapshot.stocks.length === 0 ? activeSnapshot.judgment.title : '筛选后没有候选'}</h3><p className="mt-2 max-w-lg text-xs leading-5 text-slate-500 dark:text-slate-400">{activeSnapshot.stocks.length === 0 ? activeSnapshot.judgment.summary : '调整观察层级、题材、风险或搜索条件后重试。'}</p>{activeSnapshot.stocks.length > 0 && <button type="button" onClick={resetFilters} className="mt-3 h-11 rounded-md border border-slate-300 px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700">清除筛选</button>}</div>
              )}
            </section>

            <aside data-testid="dip-buy-detail" className="min-h-[420px] overflow-y-auto bg-slate-50/60 p-4 xl:min-h-0 dark:bg-slate-950/35">
              {selected ? (
                <div className="space-y-5">
                  <div><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{selected.stockName} <span className="font-mono text-[11px] font-normal text-slate-400">{selected.stockCode}</span></h3><span className={`mt-2 inline-flex min-h-7 items-center rounded border px-2 text-[11px] font-medium ${tierClass(selected.judgment.tier)}`}>{selected.judgment.title}</span></div><span className="text-right text-[10px] leading-5 text-slate-400">结论完整度<br /><strong className="text-xs text-slate-700 dark:text-slate-200">{selected.judgment.completeness}%</strong></span></div><p className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{selected.judgment.summary}</p><div className="mt-3 grid grid-cols-3 gap-2 border-y border-slate-200 py-3 text-center dark:border-slate-800">{detailMetrics(selected).map((metric) => <div key={metric.label} className="min-w-0"><span className="block text-[10px] text-slate-400">{metric.label}</span><strong className={`mt-1 block truncate font-mono text-xs ${metric.tone ?? ''}`} title={metric.value}>{metric.value}</strong></div>)}</div></div>
                  <section><h4 className="text-xs font-semibold">前置条件</h4><div className="mt-2 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">{selected.judgment.conditions.map((condition) => <div key={condition.key} className="grid grid-cols-[88px_1fr_auto] gap-2 py-2.5 text-xs"><span className="font-medium text-slate-700 dark:text-slate-200">{condition.label}</span><span className="min-w-0 text-slate-500 dark:text-slate-400"><span className="block text-slate-700 dark:text-slate-200">{condition.value}</span><span className="mt-0.5 block text-[10px] leading-4">{condition.detail}</span></span><span className={`text-[10px] font-medium ${conditionTone(condition.status)}`}>{conditionText(condition.status)}</span></div>)}</div></section>
                  <DetailList title="支持依据" items={selected.judgment.evidence} tone="evidence" />
                  <DetailList title="当前风险" items={selected.judgment.risks} tone="risk" />
                  <DetailList title="继续确认" items={selected.judgment.confirmations} tone="confirm" />
                  <DetailList title="明确失效" items={selected.judgment.invalidations} tone="invalidate" />
                  <button type="button" data-testid="dip-buy-open-stock-drawer" onClick={() => openDrawer(selected)} className="h-11 w-full rounded-md border border-cyan-300 bg-white px-3 text-xs font-semibold text-cyan-800 outline-none transition-colors hover:bg-cyan-50 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-cyan-800 dark:bg-slate-950 dark:text-cyan-200 dark:hover:bg-cyan-950/35">查看日K与筹码结构</button>
                </div>
              ) : <div className="flex h-full min-h-[300px] items-center justify-center text-center text-xs text-slate-400">选择一只候选查看独立前置条件与失效边界</div>}
            </aside>
          </div>
        </>
      )}

      {!snapshot && loading && <div className="flex flex-1 items-center justify-center text-sm text-slate-400">正在重建三套低吸判定…</div>}
      {!snapshot && !loading && !error && <div className="flex flex-1 items-center justify-center text-sm text-slate-400">暂无低吸雷达快照</div>}
      {drawerStock && <StockKlineChipDrawer tsCode={drawerStock.tsCode} stockName={drawerStock.stockName} onClose={() => setDrawerStock(null)} onNavigate={() => { navigateToStock(drawerStock.stockCode, drawerStock.stockName); setDrawerStock(null) }} />}
    </div>
  )
}
