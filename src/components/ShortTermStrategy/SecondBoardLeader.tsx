import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/appStore'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { SHORT_TERM_WORKBENCH_ACTION_CLASS, ShortTermCombobox, type ShortTermComboboxOption } from './ShortTermDecisionControls'

type DataMode = 'realtime' | 'eod' | 'fallback'
type Tier = 'core' | 'contender' | 'fragile' | 'insufficient'
type DataStatus = 'complete' | 'partial' | 'insufficient'
type DimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'

interface ThemeContext {
  name: string
  consecutiveCount: number
  limitUpCount: number | null
  maxBoards: number | null
  heightLevels: number[]
  ladderDepth: number
  supportCount: number | null
  formed: boolean
}

interface Dimension {
  key: 'boardPosition' | 'stability' | 'seal' | 'turnover' | 'themeLadder'
  label: string
  score: number | null
  maxScore: number
  status: DimensionStatus
  value: string
  detail: string
}

interface StockJudgment {
  tier: Tier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  dataStatus: DataStatus
  completeness: number
  missingFields: string[]
  dimensions: Dimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
  theme: ThemeContext | null
}

interface SecondBoardStock {
  tsCode: string
  stockCode: string
  stockName: string
  pctChg: number | null
  limitTimes: number | null
  firstTime: string | null
  lastTime: string | null
  openTimes: number | null
  fundAmount: number | null
  turnoverRatio: number | null
  prevTurnoverRatio: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  hasDumpInstWarning: boolean
  dumpInstDesc: string | null
  dataMode: DataMode
  judgment: StockJudgment
}

interface WorkbenchJudgment {
  stance: 'formed' | 'selective' | 'defensive' | 'insufficient'
  title: string
  summary: string
  dataStatus: DataStatus
  completeness: number
  missingFields: string[]
  highestBoard: number | null
  heightDistribution: Array<{ boards: number; count: number }>
  coreCount: number
  contenderCount: number
  fragileCount: number
  insufficientCount: number
  formedThemeCount: number
  isolatedHighCount: number
  themes: ThemeContext[]
  strategyVersion: string
}

interface SecondBoardSnapshot {
  tradeDate: string
  generatedAt: number
  isMock: boolean
  totalSecondBoardCount: number
  conceptList: string[]
  stocks: SecondBoardStock[]
  dataMode: DataMode
  rtDataTime: string | null
  strategyVersion: string
  workbench: WorkbenchJudgment
}

interface SecondBoardLeaderProps {
  dataTools?: ReactNode
  onOpenHistory?: () => void
}

const TIER_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部研判层级' },
  { value: 'core', label: '核心候选' },
  { value: 'contender', label: '竞争候选' },
  { value: 'fragile', label: '结构脆弱' },
  { value: 'insufficient', label: '证据待补' },
]

const RISK_OPTIONS: ShortTermComboboxOption[] = [
  { value: 'all', label: '全部风险状态' },
  { value: 'risk', label: '存在明确风险' },
  { value: 'clean', label: '未触发硬风险' },
]

function modeLabel(mode: DataMode): string {
  if (mode === 'realtime') return '盘中实时'
  if (mode === 'fallback') return '最近盘后回退'
  return '盘后完整'
}

function statusLabel(status: DataStatus): string {
  if (status === 'complete') return '数据完整'
  if (status === 'partial') return '部分数据'
  return '证据不足'
}

function tierLabel(tier: Tier): string {
  if (tier === 'core') return '核心候选'
  if (tier === 'contender') return '竞争候选'
  if (tier === 'fragile') return '结构脆弱'
  return '证据待补'
}

function tierClass(tier: Tier): string {
  if (tier === 'core') return 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/45 dark:text-cyan-200'
  if (tier === 'contender') return 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/45 dark:text-blue-200'
  if (tier === 'fragile') return 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/45 dark:text-rose-200'
  return 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
}

function dimensionClass(status: DimensionStatus): string {
  if (status === 'strong') return 'border-cyan-200 bg-cyan-50/70 dark:border-cyan-900 dark:bg-cyan-950/25'
  if (status === 'weak') return 'border-rose-200 bg-rose-50/70 dark:border-rose-900 dark:bg-rose-950/25'
  if (status === 'unknown') return 'border-dashed border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900'
  return 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '待补'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatAmount(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '待补'
  return value >= 10_000 ? `${(value / 10_000).toFixed(2)}亿` : `${Math.round(value)}万`
}

function boardLabel(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '待盘后' : `${Math.round(value)}板`
}

function riskTriggered(stock: SecondBoardStock): boolean {
  return stock.hasDumpInstWarning || (stock.openTimes != null && stock.openTimes >= 3) || stock.judgment.tier === 'fragile'
}

function EvidenceList({ title, items, tone = 'neutral' }: { title: string; items: string[]; tone?: 'neutral' | 'risk' | 'confirm' }): JSX.Element {
  const markerClass = tone === 'risk' ? 'bg-rose-500' : tone === 'confirm' ? 'bg-cyan-500' : 'bg-slate-400'
  return (
    <section>
      <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100">{title}</h4>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
            <span aria-hidden="true" className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${markerClass}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function SecondBoardLeader({ dataTools, onOpenHistory }: SecondBoardLeaderProps): JSX.Element {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const [snapshot, setSnapshot] = useState<SecondBoardSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState('all')
  const [heightFilter, setHeightFilter] = useState('all')
  const [conceptFilter, setConceptFilter] = useState('all')
  const [riskFilter, setRiskFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [drawerStock, setDrawerStock] = useState<{ tsCode: string; stockCode: string; stockName: string } | null>(null)

  const loadSnapshot = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError(null)
    try {
      const api = (window as typeof window & {
        api?: { shortTerm?: { secondBoardLeader?: {
          get: (tradeDate?: string) => Promise<{ ok: true; snapshot: SecondBoardSnapshot }>
          refresh: (tradeDate?: string) => Promise<{ ok: true; snapshot: SecondBoardSnapshot }>
        } } }
      }).api
      if (!api?.shortTerm?.secondBoardLeader) throw new Error('连板梯队运行组件尚未加载，请重启应用后再试')
      const response = forceRefresh ? await api.shortTerm.secondBoardLeader.refresh() : await api.shortTerm.secondBoardLeader.get()
      setSnapshot(response.snapshot)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '连板梯队加载失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSnapshot(false) }, [loadSnapshot])

  const heightOptions = useMemo<ShortTermComboboxOption[]>(() => [
    { value: 'all', label: '全部连板高度' },
    ...(snapshot?.workbench.heightDistribution ?? []).map((item) => ({ value: String(item.boards), label: `${item.boards}板`, meta: `${item.count}只` })),
    ...(snapshot?.stocks.some((stock) => stock.limitTimes == null) ? [{ value: 'unknown', label: '高度待盘后' }] : []),
  ], [snapshot])
  const conceptOptions = useMemo<ShortTermComboboxOption[]>(() => [
    { value: 'all', label: '全部题材' },
    ...(snapshot?.conceptList ?? []).map((concept) => {
      const theme = snapshot?.workbench.themes.find((item) => item.name === concept)
      return { value: concept, label: concept, meta: theme?.formed ? '梯队成形' : theme ? `${theme.consecutiveCount}只连板` : undefined }
    }),
    ...(snapshot?.stocks.some((stock) => !stock.conceptName) ? [{ value: 'unknown', label: '题材待补' }] : []),
  ], [snapshot])

  const filteredStocks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return (snapshot?.stocks ?? []).filter((stock) => {
      if (tierFilter !== 'all' && stock.judgment.tier !== tierFilter) return false
      if (heightFilter === 'unknown' && stock.limitTimes != null) return false
      if (heightFilter !== 'all' && heightFilter !== 'unknown' && stock.limitTimes !== Number(heightFilter)) return false
      if (conceptFilter === 'unknown' && stock.conceptName) return false
      if (conceptFilter !== 'all' && conceptFilter !== 'unknown' && stock.conceptName !== conceptFilter) return false
      if (riskFilter === 'risk' && !riskTriggered(stock)) return false
      if (riskFilter === 'clean' && riskTriggered(stock)) return false
      if (normalized && !`${stock.stockName} ${stock.stockCode} ${stock.conceptName ?? ''}`.toLocaleLowerCase('zh-CN').includes(normalized)) return false
      return true
    })
  }, [conceptFilter, heightFilter, query, riskFilter, snapshot, tierFilter])

  useEffect(() => {
    if (filteredStocks.length === 0) {
      setSelectedCode(null)
      return
    }
    if (!selectedCode || !filteredStocks.some((stock) => stock.tsCode === selectedCode)) setSelectedCode(filteredStocks[0].tsCode)
  }, [filteredStocks, selectedCode])

  const selectedStock = filteredStocks.find((stock) => stock.tsCode === selectedCode) ?? null
  const resetFilters = (): void => {
    setTierFilter('all')
    setHeightFilter('all')
    setConceptFilter('all')
    setRiskFilter('all')
    setQuery('')
  }
  const filtersActive = tierFilter !== 'all' || heightFilter !== 'all' || conceptFilter !== 'all' || riskFilter !== 'all' || query.trim() !== ''

  const openStockDrawer = (stock: SecondBoardStock): void => {
    setDrawerStock({ tsCode: stock.tsCode, stockCode: stock.stockCode, stockName: stock.stockName })
  }

  return (
    <div data-testid="second-board-workbench" className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex min-h-[64px] shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">连板梯队</h2>
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">事实日 {snapshot.tradeDate}</span>}
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">{modeLabel(snapshot.dataMode)}</span>}
            {snapshot?.rtDataTime && <span className="text-[11px] text-slate-400">行情 {snapshot.rtDataTime}</span>}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">判断市场高度、题材梯队和高标是否拥有同方向助攻</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button type="button" data-testid="second-board-refresh" disabled={loading} onClick={() => void loadSnapshot(true)} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>
            {loading ? '刷新中' : '刷新快照'}
          </button>
          <button type="button" data-testid="second-board-history" onClick={onOpenHistory} disabled={!onOpenHistory} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>
            历史表现
          </button>
          {dataTools}
        </div>
      </header>

      {error && (
        <div role="alert" className="mx-4 mt-3 flex shrink-0 items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          <span>{error}</span>
          <button type="button" onClick={() => void loadSnapshot(true)} className="h-11 shrink-0 rounded border border-rose-300 px-3 font-medium outline-none focus-visible:ring-2 focus-visible:ring-rose-500/30 dark:border-rose-700">重试</button>
        </div>
      )}

      {snapshot && (
        <section data-testid="second-board-conclusion" className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded border px-2 py-1 text-[11px] font-semibold ${snapshot.workbench.stance === 'formed' ? 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200' : snapshot.workbench.stance === 'defensive' ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200' : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'}`}>{statusLabel(snapshot.workbench.dataStatus)}</span>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{snapshot.workbench.title}</h3>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">{snapshot.workbench.summary}</p>
            </div>
            <dl className="flex shrink-0 flex-wrap gap-x-5 gap-y-2 text-xs">
              <div><dt className="text-slate-400">最高高度</dt><dd className="mt-0.5 font-semibold tabular-nums">{snapshot.workbench.highestBoard == null ? '待盘后' : `${snapshot.workbench.highestBoard}板`}</dd></div>
              <div><dt className="text-slate-400">高度层</dt><dd className="mt-0.5 font-semibold tabular-nums">{snapshot.workbench.heightDistribution.length}</dd></div>
              <div><dt className="text-slate-400">成形题材</dt><dd className="mt-0.5 font-semibold tabular-nums">{snapshot.workbench.formedThemeCount}</dd></div>
              <div><dt className="text-slate-400">完整度</dt><dd className="mt-0.5 font-semibold tabular-nums">{snapshot.workbench.completeness}%</dd></div>
            </dl>
          </div>
          {snapshot.workbench.themes.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="题材竞争摘要">
              {snapshot.workbench.themes.slice(0, 4).map((theme) => (
                <button key={theme.name} type="button" aria-pressed={conceptFilter === theme.name} onClick={() => setConceptFilter((current) => current === theme.name ? 'all' : theme.name)} className={`min-h-11 rounded-md border px-3 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${conceptFilter === theme.name ? 'border-cyan-500 bg-cyan-50 text-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-100' : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-cyan-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200'}`}>
                  <span className="font-semibold">{theme.name}</span>
                  <span className="ml-2 text-[11px] text-slate-500 dark:text-slate-400">{theme.maxBoards == null ? '高度待补' : `${theme.maxBoards}板`} · {theme.consecutiveCount}只连板 · {theme.limitUpCount == null ? '广度待补' : `${theme.limitUpCount}只涨停`}</span>
                  <span className={`ml-2 text-[10px] font-medium ${theme.formed ? 'text-cyan-700 dark:text-cyan-300' : 'text-amber-700 dark:text-amber-300'}`}>{theme.formed ? '梯队成形' : '待确认'}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3 md:grid-cols-5 dark:border-slate-800 dark:bg-slate-950">
        <ShortTermCombobox value={tierFilter} options={TIER_OPTIONS} ariaLabel="研判层级" testId="second-board-tier-filter" onChange={setTierFilter} />
        <ShortTermCombobox value={heightFilter} options={heightOptions} ariaLabel="连板高度" testId="second-board-height-filter" onChange={setHeightFilter} />
        <ShortTermCombobox value={conceptFilter} options={conceptOptions} ariaLabel="题材筛选" testId="second-board-concept-filter" searchPlaceholder="搜索题材" onChange={setConceptFilter} />
        <ShortTermCombobox value={riskFilter} options={RISK_OPTIONS} ariaLabel="风险状态" testId="second-board-risk-filter" onChange={setRiskFilter} />
        <div className="flex min-w-0 gap-2">
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索股票" placeholder="名称 / 代码" className="h-11 min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 text-xs outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
          <button type="button" disabled={!filtersActive} onClick={resetFilters} className="h-11 shrink-0 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium outline-none hover:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900">重置</button>
        </div>
      </div>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 xl:grid-cols-[minmax(0,1fr)_328px] xl:overflow-hidden">
        <section className="flex min-h-[280px] min-w-0 flex-col overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" aria-label="连板候选">
          <div className="grid min-h-11 shrink-0 grid-cols-[minmax(148px,1.25fr)_76px_minmax(110px,0.9fr)_minmax(150px,1.15fr)_92px] items-center gap-2 border-b border-slate-200 bg-slate-100 px-3 text-[11px] font-medium text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            <span>股票 / 层级</span><span>梯队</span><span>封板结构</span><span>题材竞争</span><span>风险</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!snapshot && <div className="flex min-h-52 items-center justify-center text-sm text-slate-400">正在读取连板事实…</div>}
            {snapshot && filteredStocks.length === 0 && (
              <div className="flex min-h-52 flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{snapshot.totalSecondBoardCount === 0 ? (snapshot.dataMode === 'fallback' ? '当前交易日盘后榜单尚未准备' : '事实日没有二板及以上股票') : '当前筛选没有匹配候选'}</p>
                <p className="max-w-xl text-xs leading-5 text-slate-500 dark:text-slate-400">{snapshot.totalSecondBoardCount === 0 ? '可刷新快照，或通过题材数据与盘后基础数据工具补齐本地事实。' : '调整层级、高度、题材、风险或搜索条件后重试。'}</p>
                {snapshot.totalSecondBoardCount > 0 && <button type="button" onClick={resetFilters} className="h-11 rounded-md border border-slate-300 px-4 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700">清除筛选</button>}
              </div>
            )}
            {filteredStocks.map((stock) => {
              const selected = stock.tsCode === selectedStock?.tsCode
              const stability = stock.judgment.dimensions.find((item) => item.key === 'stability')
              return (
                <button key={stock.tsCode} type="button" data-testid={`second-board-row-${stock.stockCode}`} aria-pressed={selected} onClick={() => setSelectedCode(stock.tsCode)} onDoubleClick={() => openStockDrawer(stock)} className={`grid min-h-[68px] w-full grid-cols-[minmax(148px,1.25fr)_76px_minmax(110px,0.9fr)_minmax(150px,1.15fr)_92px] items-center gap-2 border-b border-slate-100 px-3 text-left outline-none transition-colors motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/40 dark:border-slate-800 ${selected ? 'bg-cyan-50/80 dark:bg-cyan-950/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70'}`}>
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2"><span className="truncate text-xs font-semibold text-slate-900 dark:text-white">{stock.stockName || '名称待补'}</span><span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${tierClass(stock.judgment.tier)}`}>{tierLabel(stock.judgment.tier)}</span></span>
                    <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-500"><span className="font-mono">{stock.stockCode}</span><span className={stock.pctChg != null && stock.pctChg > 0 ? 'text-rose-600 dark:text-rose-300' : ''}>{formatPct(stock.pctChg)}</span></span>
                  </span>
                  <span><span className="block text-xs font-semibold tabular-nums">{boardLabel(stock.limitTimes)}</span><span className="mt-1 block text-[10px] text-slate-400">{stock.judgment.totalScore == null ? '不可评分' : `${stock.judgment.totalScore}分`}</span></span>
                  <span><span className="block text-xs text-slate-700 dark:text-slate-200">{stability?.value ?? '待补'}</span><span className="mt-1 block text-[10px] text-slate-400">封单 {formatAmount(stock.fundAmount)}</span></span>
                  <span className="min-w-0"><span className="block truncate text-xs font-medium text-slate-700 dark:text-slate-200">{stock.conceptName ?? '题材待补'}</span><span className="mt-1 block truncate text-[10px] text-slate-400">{stock.judgment.theme ? `${stock.judgment.theme.consecutiveCount}只连板 · ${stock.judgment.theme.limitUpCount == null ? '广度待补' : `${stock.judgment.theme.limitUpCount}只涨停`}` : '梯队待确认'}</span></span>
                  <span className={`text-[11px] font-medium ${riskTriggered(stock) ? 'text-rose-700 dark:text-rose-300' : 'text-slate-500 dark:text-slate-400'}`}>{riskTriggered(stock) ? '需警惕' : stock.judgment.dataStatus === 'insufficient' ? '待补' : '未触发'}</span>
                </button>
              )
            })}
          </div>
          <div className="flex min-h-11 shrink-0 items-center justify-between border-t border-slate-200 px-3 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400"><span>显示 {filteredStocks.length} / {snapshot?.stocks.length ?? 0} 只</span><span>单击研判 · 双击K线与筹码</span></div>
        </section>

        <aside data-testid="second-board-detail" className="min-h-[320px] overflow-y-auto rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900" aria-label="选中股票研判">
          {!selectedStock ? (
            <div className="flex h-full min-h-64 items-center justify-center text-center text-xs leading-5 text-slate-400">选择一只候选，查看入选依据、风险、确认和失效条件</div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><h3 className="truncate text-sm font-semibold">{selectedStock.stockName || '名称待补'}</h3><p className="mt-1 font-mono text-[11px] text-slate-400">{selectedStock.stockCode} · {boardLabel(selectedStock.limitTimes)}</p></div>
                  <span className={`shrink-0 rounded border px-2 py-1 text-[10px] font-semibold ${tierClass(selectedStock.judgment.tier)}`}>{tierLabel(selectedStock.judgment.tier)}</span>
                </div>
                <h4 className="mt-3 text-sm font-semibold text-slate-900 dark:text-white">{selectedStock.judgment.title}</h4>
                <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{selectedStock.judgment.summary}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {selectedStock.judgment.dimensions.map((dimension) => (
                  <div key={dimension.key} className={`min-h-[74px] rounded border p-2.5 ${dimensionClass(dimension.status)}`}>
                    <div className="flex items-center justify-between gap-2"><span className="text-[10px] text-slate-500 dark:text-slate-400">{dimension.label}</span><span className="text-[10px] font-semibold tabular-nums text-slate-500">{dimension.score == null ? '待补' : `${dimension.score}/${dimension.maxScore}`}</span></div>
                    <p className="mt-1 text-xs font-semibold text-slate-800 dark:text-slate-100">{dimension.value}</p>
                    <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{dimension.detail}</p>
                  </div>
                ))}
              </div>
              {selectedStock.judgment.evidence.length > 0 && <EvidenceList title="入选依据" items={selectedStock.judgment.evidence} />}
              {selectedStock.judgment.risks.length > 0 && <EvidenceList title="风险与缺口" items={selectedStock.judgment.risks} tone="risk" />}
              <EvidenceList title="继续确认" items={selectedStock.judgment.confirmations} tone="confirm" />
              <EvidenceList title="明确失效" items={selectedStock.judgment.invalidations} tone="risk" />
              <button type="button" data-testid="second-board-open-stock-drawer" onClick={() => openStockDrawer(selectedStock)} className="h-11 w-full rounded-md border border-cyan-300 bg-cyan-50 px-3 text-xs font-semibold text-cyan-800 outline-none transition-colors hover:border-cyan-500 hover:bg-cyan-100 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-cyan-800 dark:bg-cyan-950/35 dark:text-cyan-200 dark:hover:border-cyan-600">
                查看日K与筹码结构
              </button>
            </div>
          )}
        </aside>
      </main>

      {drawerStock && (
        <StockKlineChipDrawer tsCode={drawerStock.tsCode} stockName={drawerStock.stockName} onClose={() => setDrawerStock(null)} onNavigate={() => { navigateToStock(drawerStock.stockCode, drawerStock.stockName); setDrawerStock(null) }} />
      )}
      {snapshot && <span className="sr-only" aria-live="polite">连板梯队已更新，共{snapshot.totalSecondBoardCount}只候选，更新时间{formatTime(snapshot.generatedAt)}</span>}
    </div>
  )
}
