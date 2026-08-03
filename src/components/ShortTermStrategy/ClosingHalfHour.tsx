import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAppStore } from '../../store/appStore'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'
import { SHORT_TERM_WORKBENCH_ACTION_CLASS, ShortTermCombobox } from './ShortTermDecisionControls'

type Tier = 'active' | 'confirm' | 'retreat' | 'insufficient'
type LegacyForm = 'spikeBreakOpen' | 'dipReboundNotBreakOpen' | 'mildPullAboveBaseline' | 'riseFallHoldBaseline' | 'flatNoMove' | 'lastTenSharpDrop'

interface Dimension {
  key: 'direction' | 'closePosition' | 'participation' | 'stability' | 'keyLevel'
  label: string
  score: number | null
  maxScore: number
  status: 'strong' | 'neutral' | 'weak' | 'unknown'
  value: string
  detail: string
}

interface StockJudgment {
  tier: Tier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  completeness: number
  dataStatus: 'complete' | 'partial' | 'insufficient'
  missingFields: string[]
  metrics: {
    baseline1430: number | null
    latestPrice: number | null
    latestTime: string | null
    tailReturnPct: number | null
    tailHighPct: number | null
    tailLowPct: number | null
    lateReturnPct: number | null
    closePositionPct: number | null
    maxDrawdownPct: number | null
    pathEfficiencyPct: number | null
    tailVolumeSharePct: number | null
    tailVolumePace: number | null
    pointCount: number
  }
  dimensions: Dimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
  legacyForms: LegacyForm[]
}

interface ClosingStock {
  tsCode: string
  stockCode: string
  stockName: string
  open: number | null
  previousClose: number | null
  closeFinal: number | null
  pctChg: number | null
  amountYuan: number | null
  judgment: StockJudgment
}

interface ClosingSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: 'realtime' | 'eod' | 'history'
  candidateSource: 'realtimeActive' | 'localMinuteCache' | 'eodLimitList' | 'savedSignal'
  windowStatus: 'waiting' | 'live' | 'closed' | 'historical'
  latestMinute: string | null
  candidateCount: number
  stocks: ClosingStock[]
  judgment: {
    stance: 'active' | 'selective' | 'defensive' | 'insufficient'
    title: string
    summary: string
    activeCount: number
    confirmCount: number
    retreatCount: number
    insufficientCount: number
    analyzedCount: number
    completeness: number
    dataStatus: 'complete' | 'partial' | 'insufficient'
    missingFields: string[]
    strategyVersion: string
  }
  strategyVersion: string
}

interface ClosingHalfHourProps {
  dataTools?: ReactNode
  onOpenHistory?: () => void
}

const TIER_OPTIONS = [
  { value: 'all', label: '全部层级' },
  { value: 'active', label: '主动增强' },
  { value: 'confirm', label: '等待确认' },
  { value: 'retreat', label: '冲高回落或撤退' },
  { value: 'insufficient', label: '数据不足' },
]

const FORM_LABELS: Record<LegacyForm, string> = {
  spikeBreakOpen: '冲高后跌破开盘价',
  dipReboundNotBreakOpen: '下探后收复开盘价',
  mildPullAboveBaseline: '尾盘平稳抬升',
  riseFallHoldBaseline: '冲高回落守住14:30',
  flatNoMove: '尾盘窄幅整理',
  lastTenSharpDrop: '最后10分钟急跌',
}

const FORM_OPTIONS = [
  { value: 'all', label: '全部路径标签' },
  ...Object.entries(FORM_LABELS).map(([value, label]) => ({ value, label })),
]

function formatTradeDate(value: string): string {
  return value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatPct(value: number | null): string {
  return value == null ? '待补' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatPrice(value: number | null): string {
  return value == null ? '待补' : value.toFixed(2)
}

function tierStyle(tier: Tier): string {
  if (tier === 'active') return 'border-cyan-300 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/45 dark:text-cyan-200'
  if (tier === 'confirm') return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-200'
  if (tier === 'retreat') return 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/35 dark:text-red-200'
  return 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'
}

function pctTone(value: number | null): string {
  if (value == null) return 'text-slate-400'
  return value < 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'
}

function stanceStyle(stance: ClosingSnapshot['judgment']['stance']): string {
  if (stance === 'active') return 'border-cyan-200 bg-cyan-50/75 dark:border-cyan-900 dark:bg-cyan-950/30'
  if (stance === 'defensive') return 'border-red-200 bg-red-50/75 dark:border-red-950 dark:bg-red-950/30'
  if (stance === 'selective') return 'border-amber-200 bg-amber-50/65 dark:border-amber-900 dark:bg-amber-950/25'
  return 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/60'
}

function modeLabel(snapshot: ClosingSnapshot): string {
  if (snapshot.dataMode === 'history') return '历史快照'
  if (snapshot.dataMode === 'realtime') return snapshot.windowStatus === 'live' ? '尾盘进行中' : '实时缓存'
  return snapshot.candidateSource === 'localMinuteCache' ? '本地分钟恢复' : '盘后榜单回退'
}

function statusLabel(status: Dimension['status']): string {
  return status === 'strong' ? '支持' : status === 'weak' ? '风险' : status === 'neutral' ? '中性' : '未知'
}

function DetailList({ title, items, tone }: { title: string; items: string[]; tone: 'evidence' | 'risk' | 'confirm' | 'invalidate' }): JSX.Element {
  const marker = tone === 'evidence' ? 'bg-cyan-500' : tone === 'risk' || tone === 'invalidate' ? 'bg-red-500' : 'bg-amber-500'
  return (
    <section>
      <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100">{title}</h4>
      <ul className="mt-2 space-y-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
        {items.length > 0 ? items.map((item) => (
          <li key={item} className="flex gap-2"><span aria-hidden="true" className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${marker}`} /><span>{item}</span></li>
        )) : <li className="text-slate-400">当前没有可确认项目</li>}
      </ul>
    </section>
  )
}

export function ClosingHalfHour({ dataTools, onOpenHistory }: ClosingHalfHourProps = {}): JSX.Element {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const [snapshot, setSnapshot] = useState<ClosingSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState('all')
  const [formFilter, setFormFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [drawerStock, setDrawerStock] = useState<{ tsCode: string; stockCode: string; stockName: string } | null>(null)

  const loadSnapshot = useCallback(async (forceRefresh = false): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const api = (window as typeof window & { api?: { shortTerm?: { closingHalfHour?: {
        get: (tradeDate?: string) => Promise<{ ok: true; snapshot: ClosingSnapshot }>
        refresh: (tradeDate?: string) => Promise<{ ok: true; snapshot: ClosingSnapshot }>
      } } } }).api?.shortTerm?.closingHalfHour
      if (!api) throw new Error('尾盘研判运行组件尚未加载，请重启应用后再试')
      const response = forceRefresh ? await api.refresh() : await api.get()
      setSnapshot(response.snapshot)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '尾盘研判加载失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadSnapshot(false) }, [loadSnapshot])

  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN')
    return (snapshot?.stocks ?? []).filter((stock) => {
      if (tierFilter !== 'all' && stock.judgment.tier !== tierFilter) return false
      if (formFilter !== 'all' && !stock.judgment.legacyForms.includes(formFilter as LegacyForm)) return false
      if (keyword && !`${stock.stockCode} ${stock.stockName}`.toLocaleLowerCase('zh-CN').includes(keyword)) return false
      return true
    })
  }, [formFilter, search, snapshot, tierFilter])

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedCode(null)
      return
    }
    if (!filtered.some((stock) => stock.tsCode === selectedCode)) setSelectedCode(filtered[0].tsCode)
  }, [filtered, selectedCode])

  const selected = filtered.find((stock) => stock.tsCode === selectedCode) ?? null
  const resetFilters = (): void => {
    setTierFilter('all')
    setFormFilter('all')
    setSearch('')
  }
  const openDrawer = (stock: ClosingStock): void => setDrawerStock({ tsCode: stock.tsCode, stockCode: stock.stockCode, stockName: stock.stockName })

  return (
    <div data-testid="closing-half-hour-workbench" className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">尾盘行为</h2>
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">事实日 {formatTradeDate(snapshot.tradeDate)}</span>}
            {snapshot && <span className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-300">{modeLabel(snapshot)}</span>}
            {snapshot?.latestMinute && <span className="text-[11px] text-slate-400">覆盖至 {snapshot.latestMinute}</span>}
            {snapshot && <span className="text-[11px] text-slate-400">更新 {formatTime(snapshot.generatedAt)}</span>}
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">判断14:30后是否出现可延续的主动行为，以及次日需要确认或规避什么</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button type="button" data-testid="closing-half-hour-refresh" disabled={loading} onClick={() => void loadSnapshot(true)} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>{loading ? '刷新中' : '刷新研判'}</button>
          <button type="button" data-testid="closing-half-hour-history" disabled={!onOpenHistory} onClick={onOpenHistory} className={SHORT_TERM_WORKBENCH_ACTION_CLASS}>历史表现</button>
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
        <>
          <section data-testid="closing-half-hour-conclusion" className={`shrink-0 border-b px-4 py-3 ${stanceStyle(snapshot.judgment.stance)}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{snapshot.judgment.title}</h3>
                <p className="mt-1 max-w-4xl text-xs leading-5 text-slate-600 dark:text-slate-300">{snapshot.judgment.summary}</p>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300">
                <span>主动 <strong className="font-semibold text-cyan-700 dark:text-cyan-300">{snapshot.judgment.activeCount}</strong></span>
                <span>待确认 <strong>{snapshot.judgment.confirmCount}</strong></span>
                <span>撤退 <strong className="font-semibold text-red-700 dark:text-red-300">{snapshot.judgment.retreatCount}</strong></span>
                <span>不足 <strong>{snapshot.judgment.insufficientCount}</strong></span>
                <span>完整度 <strong>{snapshot.judgment.completeness}%</strong></span>
              </div>
            </div>
          </section>

          <div className="shrink-0 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[180px_220px_minmax(180px,1fr)_auto]">
              <ShortTermCombobox value={tierFilter} options={TIER_OPTIONS} ariaLabel="尾盘行为层级" testId="closing-tier-filter" onChange={setTierFilter} />
              <ShortTermCombobox value={formFilter} options={FORM_OPTIONS} ariaLabel="尾盘路径标签" testId="closing-form-filter" onChange={setFormFilter} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索尾盘候选股票" placeholder="搜索代码或名称" className="h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-xs outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
              <button type="button" onClick={resetFilters} className="h-11 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-600 outline-none hover:border-cyan-500 hover:text-cyan-700 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700 dark:text-slate-300">重置</button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden">
            <section className="min-w-0 border-b border-slate-200 xl:min-h-0 xl:border-b-0 xl:border-r dark:border-slate-800">
              {filtered.length > 0 ? (
                <div className="h-full min-h-[280px] overflow-auto">
                  <table className="w-full min-w-[780px] table-fixed text-left text-xs">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-medium text-slate-500 shadow-[0_1px_0_rgba(148,163,184,0.25)] dark:bg-slate-950 dark:text-slate-400">
                      <tr><th className="w-40 px-4 py-3">股票</th><th className="w-32 px-3 py-3">尾盘行为</th><th className="w-24 px-3 py-3 text-right">14:30后</th><th className="w-24 px-3 py-3 text-right">收盘位置</th><th className="w-28 px-3 py-3 text-right">成交参与</th><th className="w-24 px-3 py-3 text-right">最大回撤</th><th className="px-3 py-3">路径事实</th></tr>
                    </thead>
                    <tbody>
                      {filtered.map((stock) => {
                        const active = stock.tsCode === selectedCode
                        const metrics = stock.judgment.metrics
                        return (
                          <tr key={stock.tsCode} data-testid={`closing-half-hour-row-${stock.stockCode}`} onClick={() => setSelectedCode(stock.tsCode)} onDoubleClick={() => openDrawer(stock)} className={`cursor-pointer border-b border-slate-100 outline-none transition-colors motion-reduce:transition-none dark:border-slate-800 ${active ? 'bg-cyan-50/70 dark:bg-cyan-950/25' : 'hover:bg-slate-50 dark:hover:bg-slate-800/65'}`}>
                            <td className="px-4 py-3"><button type="button" onClick={() => setSelectedCode(stock.tsCode)} className="min-h-11 w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/30"><span className="block truncate font-semibold text-slate-900 dark:text-slate-100">{stock.stockName}</span><span className="mt-0.5 block font-mono text-[10px] text-slate-400">{stock.stockCode}</span></button></td>
                            <td className="px-3 py-3"><span className={`inline-flex min-h-7 items-center rounded border px-2 text-[11px] font-medium ${tierStyle(stock.judgment.tier)}`}>{stock.judgment.title}</span></td>
                            <td className={`px-3 py-3 text-right font-mono font-semibold ${pctTone(metrics.tailReturnPct)}`}>{formatPct(metrics.tailReturnPct)}</td>
                            <td className="px-3 py-3 text-right text-slate-700 dark:text-slate-200">{metrics.closePositionPct == null ? '待补' : `${metrics.closePositionPct.toFixed(0)}%`}</td>
                            <td className="px-3 py-3 text-right text-slate-700 dark:text-slate-200">{metrics.tailVolumePace == null ? '待补' : `${metrics.tailVolumePace.toFixed(2)}倍`}</td>
                            <td className="px-3 py-3 text-right text-slate-700 dark:text-slate-200">{metrics.maxDrawdownPct == null ? '待补' : `${metrics.maxDrawdownPct.toFixed(2)}%`}</td>
                            <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{stock.judgment.legacyForms.length > 0 ? stock.judgment.legacyForms.slice(0, 2).map((form) => <span key={form} className="rounded bg-slate-100 px-2 py-1 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{FORM_LABELS[form]}</span>) : <span className="text-slate-400">未命中旧形态标签</span>}</div></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex min-h-[280px] flex-col items-center justify-center px-6 text-center">
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{snapshot.stocks.length === 0 ? snapshot.windowStatus === 'waiting' ? '尾盘窗口尚未开启' : '当前没有可研判的分钟路径' : '筛选后没有候选'}</h3>
                  <p className="mt-2 max-w-lg text-xs leading-5 text-slate-500 dark:text-slate-400">{snapshot.stocks.length === 0 ? snapshot.windowStatus === 'waiting' ? '14:30后再刷新；若本地已有上一交易日快照，页面会优先展示并明确标记历史事实日。' : '请刷新实时行情和分钟数据；缺少精确14:30记录时不会生成替代结论。' : '调整层级、路径标签或股票搜索条件后重试。'}</p>
                  {snapshot.stocks.length > 0 && <button type="button" onClick={resetFilters} className="mt-3 h-11 rounded-md border border-slate-300 px-3 text-xs font-medium focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-slate-700">清除筛选</button>}
                </div>
              )}
            </section>

            <aside data-testid="closing-half-hour-detail" className="min-h-[420px] overflow-y-auto bg-slate-50/60 p-4 xl:min-h-0 dark:bg-slate-950/35">
              {selected ? (
                <div className="space-y-5">
                  <div>
                    <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{selected.stockName} <span className="font-mono text-[11px] font-normal text-slate-400">{selected.stockCode}</span></h3><span className={`mt-2 inline-flex min-h-7 items-center rounded border px-2 text-[11px] font-medium ${tierStyle(selected.judgment.tier)}`}>{selected.judgment.title}</span></div><span className="text-right text-[10px] leading-5 text-slate-400">结论完整度<br /><strong className="text-xs text-slate-700 dark:text-slate-200">{selected.judgment.completeness}%</strong></span></div>
                    <p className="mt-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{selected.judgment.summary}</p>
                    <div className="mt-3 grid grid-cols-3 gap-2 border-y border-slate-200 py-3 text-center dark:border-slate-800"><div><span className="block text-[10px] text-slate-400">14:30</span><strong className="mt-1 block font-mono text-xs">{formatPrice(selected.judgment.metrics.baseline1430)}</strong></div><div><span className="block text-[10px] text-slate-400">最新</span><strong className="mt-1 block font-mono text-xs">{formatPrice(selected.closeFinal)}</strong></div><div><span className="block text-[10px] text-slate-400">当日涨跌</span><strong className="mt-1 block font-mono text-xs">{formatPct(selected.pctChg)}</strong></div></div>
                  </div>

                  <section><h4 className="text-xs font-semibold">五维事实</h4><div className="mt-2 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">{selected.judgment.dimensions.map((dimension) => <div key={dimension.key} className="grid grid-cols-[84px_1fr_auto] gap-2 py-2.5 text-xs"><span className="font-medium text-slate-700 dark:text-slate-200">{dimension.label}</span><span className="min-w-0 text-slate-500 dark:text-slate-400"><span className="block text-slate-700 dark:text-slate-200">{dimension.value}</span><span className="mt-0.5 block text-[10px] leading-4">{dimension.detail}</span></span><span className={`text-[10px] font-medium ${dimension.status === 'strong' ? 'text-cyan-700 dark:text-cyan-300' : dimension.status === 'weak' ? 'text-red-700 dark:text-red-300' : 'text-slate-400'}`}>{statusLabel(dimension.status)}</span></div>)}</div></section>
                  <DetailList title="支持依据" items={selected.judgment.evidence} tone="evidence" />
                  <DetailList title="当前风险" items={selected.judgment.risks} tone="risk" />
                  <DetailList title="次日继续确认" items={selected.judgment.confirmations} tone="confirm" />
                  <DetailList title="明确失效" items={selected.judgment.invalidations} tone="invalidate" />
                  <button type="button" data-testid="closing-half-hour-open-stock-drawer" onClick={() => openDrawer(selected)} className="h-11 w-full rounded-md border border-cyan-300 bg-white px-3 text-xs font-semibold text-cyan-800 outline-none transition-colors hover:bg-cyan-50 focus-visible:ring-2 focus-visible:ring-cyan-500/30 dark:border-cyan-800 dark:bg-slate-950 dark:text-cyan-200 dark:hover:bg-cyan-950/35">查看日K与筹码结构</button>
                </div>
              ) : <div className="flex h-full min-h-[300px] items-center justify-center text-center text-xs text-slate-400">选择一只候选查看尾盘路径与次日条件</div>}
            </aside>
          </div>
        </>
      )}

      {!snapshot && !loading && !error && <div className="flex flex-1 items-center justify-center text-sm text-slate-400">暂无尾盘研判快照</div>}
      {drawerStock && <StockKlineChipDrawer tsCode={drawerStock.tsCode} stockName={drawerStock.stockName} onClose={() => setDrawerStock(null)} onNavigate={() => { navigateToStock(drawerStock.stockCode, drawerStock.stockName); setDrawerStock(null) }} />}
    </div>
  )
}
