import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isInTradingHours } from '../../utils/tradingHours'

type MetricMode = 'verified_flow' | 'turnover_strength'
type Scope = 'concept' | 'industry'
type ThemeState = 'continuation' | 'rotation' | 'divergence' | 'retreat' | 'insufficient'

interface FlowStock {
  tsCode: string
  name: string
  change: number
  totalAmount: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
}

interface FlowItem {
  boardCode: string
  boardName: string
  scope: Scope
  metricMode: MetricMode
  totalAmount: number
  turnoverDirectionStrength: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
  weightedChange: number
  memberCount: number
  upCount: number
  downCount: number
  flatCount: number
  previousMainNetInflow: number | null
  leader: FlowStock | null
  coreStocks: FlowStock[]
  relatedThemes: Array<{ boardCode: string; boardName: string }>
}

interface ThemeGuidance {
  boardCode: string
  boardName: string
  scope: Scope
  state: ThemeState
  score: number
  confidence: number
  mainNetInflow: number
  mainNetInflowRate: number | null
  previousMainNetInflow: number | null
  weightedChange: number
  breadthRate: number | null
  reason: string
  coreStocks: FlowStock[]
  relatedThemes: Array<{ boardCode: string; boardName: string }>
  confirmations: string[]
  invalidations: string[]
}

interface FlowSnapshot {
  items: FlowItem[]
  guidance: {
    stance: 'focus' | 'selective' | 'defensive' | 'insufficient'
    confidence: number
    summary: string
    focusThemes: ThemeGuidance[]
    riskThemes: ThemeGuidance[]
  }
  tradeDate: string | null
  updatedAt: string
  capturedAt: number
  dataMode: 'realtime' | 'archive' | 'degraded' | 'empty'
  metricMode: MetricMode
  provider: 'eastmoney' | 'local_estimate'
  sourceLabel: string
  quality: {
    isVerified: boolean
    partialScopes: Scope[]
    archived: boolean
    message: string
  }
}

type DirectionFilter = 'all' | 'positive' | 'risk'
type ScopeFilter = 'all' | Scope
type SortKey = 'mainFlow' | 'flowRate' | 'change' | 'amount'

const STATE_LABEL: Record<ThemeState, string> = {
  continuation: '延续',
  rotation: '轮动',
  divergence: '分化',
  retreat: '退潮',
  insufficient: '证据不足',
}

const STANCE_LABEL = {
  focus: '主线集中',
  selective: '选择性确认',
  defensive: '风险优先',
  insufficient: '证据不足',
} as const

export function SectorFlow() {
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('mainFlow')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadSnapshot = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError('')
    try {
      const response = await window.api.sectorFlow.getSnapshot(forceRefresh)
      if (response.ok) setSnapshot(response.snapshot as FlowSnapshot)
      else setError(response.message ?? '板块资金加载失败，请稍后重试。')
    } catch {
      setError('板块资金加载失败，请检查网络后重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot(false)
  }, [loadSnapshot])

  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (isInTradingHours()) void loadSnapshot(false)
    }, 60_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [loadSnapshot])

  const tableItems = useMemo(() => {
    if (!snapshot) return []
    const filtered = snapshot.items.filter((item) => {
      if (scopeFilter !== 'all' && item.scope !== scopeFilter) return false
      const metric = item.metricMode === 'verified_flow' ? item.mainNetInflow ?? 0 : item.turnoverDirectionStrength ?? 0
      if (directionFilter === 'positive') return metric > 0
      if (directionFilter === 'risk') return metric < 0
      return true
    })
    return filtered.sort((left, right) => {
      if (sortKey === 'flowRate') return (right.mainNetInflowRate ?? right.turnoverDirectionStrength ?? 0) - (left.mainNetInflowRate ?? left.turnoverDirectionStrength ?? 0)
      if (sortKey === 'change') return right.weightedChange - left.weightedChange
      if (sortKey === 'amount') return right.totalAmount - left.totalAmount
      return (right.mainNetInflow ?? right.turnoverDirectionStrength ?? 0) - (left.mainNetInflow ?? left.turnoverDirectionStrength ?? 0)
    })
  }, [directionFilter, scopeFilter, snapshot, sortKey])

  return (
    <div
      className="h-full w-full overflow-y-auto overflow-x-hidden bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100"
      aria-busy={loading}
      data-testid="sector-flow-workbench"
    >
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-950/95">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">板块资金与明早竞价</h2>
              {snapshot && <SourceBadge snapshot={snapshot} />}
            </div>
            <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">
              {snapshot ? `${snapshot.sourceLabel} · ${formatTradeDate(snapshot.tradeDate)} · ${formatUpdateTime(snapshot.updatedAt)}` : '正在读取板块资金事实'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadSnapshot(true)}
            disabled={loading}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 transition-colors hover:border-blue-400 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-blue-500 dark:hover:bg-blue-950/40"
          >
            <RefreshIcon spinning={loading} />
            {loading ? '更新中' : '刷新资金'}
          </button>
        </div>
      </header>

      <div aria-live="polite">
        {error && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{error}</span>
              <button type="button" onClick={() => void loadSnapshot(true)} className="min-h-11 px-3 font-medium underline underline-offset-4">重新加载</button>
            </div>
          </div>
        )}
      </div>

      {loading && !snapshot && <LoadingState />}
      {!loading && snapshot?.dataMode === 'empty' && <EmptyState onRetry={() => void loadSnapshot(true)} />}

      {snapshot && snapshot.dataMode !== 'empty' && (
        <main>
          <section className="border-b border-gray-200 bg-white px-4 py-4 dark:border-gray-800 dark:bg-gray-950" data-testid="sector-flow-guidance">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-4xl">
                <div className="flex items-center gap-2">
                  <TargetIcon />
                  <h3 className="text-sm font-semibold">明早竞价观察</h3>
                  <span className={stanceClass(snapshot.guidance.stance)}>{STANCE_LABEL[snapshot.guidance.stance]}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-gray-700 dark:text-gray-300">{snapshot.guidance.summary}</p>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className="text-xl font-semibold">{snapshot.guidance.confidence}<span className="ml-1 text-xs font-normal text-gray-400">/ 100</span></div>
                <div className="text-xs text-gray-500 dark:text-gray-400">结论可信度</div>
              </div>
            </div>
            <div className={`mt-3 flex items-start gap-2 border-l-2 px-3 py-2 text-xs leading-5 ${snapshot.quality.isVerified ? 'border-cyan-500 bg-cyan-50 text-cyan-900 dark:bg-cyan-950/30 dark:text-cyan-200' : 'border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200'}`}>
              <QualityIcon verified={snapshot.quality.isVerified} />
              <span>{snapshot.quality.message}</span>
            </div>
          </section>

          <section className="border-b border-gray-200 px-4 py-4 dark:border-gray-800">
            <SectionTitle title="重点主题" subtitle="按已取得的真实成分重合度合并同一批股票的重复概念" />
            {snapshot.guidance.focusThemes.length > 0 ? (
              <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
                {snapshot.guidance.focusThemes.map((theme, index) => (
                  <ThemeCard key={theme.boardCode} theme={theme} index={index + 1} kind="focus" />
                ))}
              </div>
            ) : (
              <InlineEmpty text="当前没有达到重点观察门槛的真实资金主题。" />
            )}
          </section>

          {snapshot.guidance.riskThemes.length > 0 && (
            <section className="border-b border-gray-200 bg-white px-4 py-4 dark:border-gray-800 dark:bg-gray-950">
              <SectionTitle title="风险与分化" subtitle="用于识别明早可能继续扩散的弱势方向" />
              <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
                {snapshot.guidance.riskThemes.map((theme, index) => (
                  <ThemeCard key={theme.boardCode} theme={theme} index={index + 1} kind="risk" />
                ))}
              </div>
            </section>
          )}

          <section className="px-4 py-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <SectionTitle title="完整板块明细" subtitle={`${tableItems.length} 条匹配结果，板块间存在成分重合，金额不可直接求和`} />
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  label="方向"
                  value={directionFilter}
                  options={[['all', '全部'], ['positive', '正向'], ['risk', '风险']]}
                  onChange={(value) => setDirectionFilter(value as DirectionFilter)}
                />
                <SegmentedControl
                  label="范围"
                  value={scopeFilter}
                  options={[['all', '全部'], ['concept', '概念'], ['industry', '行业']]}
                  onChange={(value) => setScopeFilter(value as ScopeFilter)}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1" aria-label="明细排序">
              {([['mainFlow', snapshot.metricMode === 'verified_flow' ? '主力净流入' : '方向强度'], ['flowRate', '净流入率'], ['change', '涨跌幅'], ['amount', '成交额']] as Array<[SortKey, string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={sortKey === key}
                  onClick={() => setSortKey(key)}
                  className={`min-h-11 rounded-md px-3 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${sortKey === key ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900' : 'text-gray-600 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-800'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <FlowTable items={tableItems} metricMode={snapshot.metricMode} />
          </section>
        </main>
      )}
    </div>
  )
}

function SourceBadge({ snapshot }: { snapshot: FlowSnapshot }) {
  const label = snapshot.metricMode === 'verified_flow'
    ? snapshot.dataMode === 'realtime' ? '真实资金 · 盘中' : '真实资金 · 盘后'
    : '降级 · 成交方向强度'
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium ${snapshot.metricMode === 'verified_flow' ? 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${snapshot.metricMode === 'verified_flow' ? 'bg-cyan-500' : 'bg-amber-500'}`} />
      {label}
    </span>
  )
}

function ThemeCard({ theme, index, kind }: { theme: ThemeGuidance; index: number; kind: 'focus' | 'risk' }) {
  const isFocus = kind === 'focus'
  return (
    <article
      data-testid={`sector-flow-${kind}-theme`}
      className={`min-w-0 rounded-md border bg-white p-3 shadow-sm dark:bg-gray-900 ${isFocus ? 'border-cyan-200 dark:border-cyan-900' : 'border-rose-200 dark:border-rose-950'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-gray-400">{String(index).padStart(2, '0')}</span>
            <h4 className="truncate text-sm font-semibold" title={theme.boardName}>{theme.boardName}</h4>
            <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">{STATE_LABEL[theme.state]}</span>
          </div>
          <div className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">{theme.scope === 'concept' ? '概念板块' : '行业板块'} · 可信度 {theme.confidence}</div>
        </div>
        <div className={`shrink-0 text-right font-mono text-sm font-semibold ${theme.mainNetInflow >= 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
          {formatMoney(theme.mainNetInflow)}
          <div className="text-[10px] font-normal">{formatPercent(theme.mainNetInflowRate)}</div>
        </div>
      </div>
      <p className="mt-2 min-h-10 text-xs leading-5 text-gray-600 dark:text-gray-300">{theme.reason}</p>
      <div className="mt-2 border-t border-gray-100 pt-2 dark:border-gray-800">
        <div className="text-[10px] font-medium text-gray-500 dark:text-gray-400">核心股票</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {theme.coreStocks.length > 0 ? theme.coreStocks.map((stock) => (
            <span key={stock.tsCode} className="whitespace-nowrap">
              {stock.name} <span className={numberClass(stock.change)}>{formatPercent(stock.change)}</span>
            </span>
          )) : <span className="text-gray-400">成分资金暂未取到</span>}
        </div>
      </div>
      {theme.relatedThemes.length > 0 && (
        <div className="mt-2 text-[11px] leading-5 text-gray-500 dark:text-gray-400">
          已合并：{theme.relatedThemes.map((item) => item.boardName).join('、')}
        </div>
      )}
      <div className="mt-2 grid gap-1.5 text-[11px] leading-5">
        <div className="flex gap-2"><span className="shrink-0 font-medium text-cyan-700 dark:text-cyan-300">确认</span><span>{theme.confirmations[0]}</span></div>
        <div className="flex gap-2"><span className="shrink-0 font-medium text-rose-700 dark:text-rose-300">失效</span><span>{theme.invalidations[0]}</span></div>
      </div>
    </article>
  )
}

function FlowTable({ items, metricMode }: { items: FlowItem[]; metricMode: MetricMode }) {
  if (items.length === 0) return <InlineEmpty text="当前筛选条件下没有板块。" />
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <table className="w-full min-w-[900px] border-collapse text-xs">
        <thead className="bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">板块</th>
            <th className="px-3 py-2 text-left font-medium">范围</th>
            <th className="px-3 py-2 text-right font-medium">{metricMode === 'verified_flow' ? '主力净流入' : '成交方向强度'}</th>
            <th className="px-3 py-2 text-right font-medium">{metricMode === 'verified_flow' ? '净流入率' : '加权涨跌'}</th>
            <th className="px-3 py-2 text-right font-medium">较前日</th>
            <th className="px-3 py-2 text-right font-medium">板块涨跌</th>
            <th className="px-3 py-2 text-right font-medium">上涨覆盖</th>
            <th className="px-3 py-2 text-right font-medium">成交额</th>
            <th className="px-3 py-2 text-left font-medium">领涨股</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const mainMetric = item.metricMode === 'verified_flow' ? item.mainNetInflow : item.turnoverDirectionStrength
            const breadth = item.memberCount > 0 ? item.upCount / item.memberCount * 100 : null
            const delta = item.mainNetInflow != null && item.previousMainNetInflow != null ? item.mainNetInflow - item.previousMainNetInflow : null
            return (
              <tr key={`${item.scope}:${item.boardCode}`} className="border-t border-gray-100 transition-colors hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60">
                <td className="max-w-48 px-3 py-2 font-medium"><span className="block truncate" title={item.boardName}>{item.boardName}</span></td>
                <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{item.scope === 'concept' ? '概念' : '行业'}</td>
                <td className={`px-3 py-2 text-right font-mono font-medium ${numberClass(mainMetric)}`}>{item.metricMode === 'verified_flow' ? formatMoney(mainMetric) : formatPercent(mainMetric)}</td>
                <td className={`px-3 py-2 text-right font-mono ${numberClass(item.mainNetInflowRate ?? item.weightedChange)}`}>{item.metricMode === 'verified_flow' ? formatPercent(item.mainNetInflowRate) : formatPercent(item.weightedChange)}</td>
                <td className={`px-3 py-2 text-right font-mono ${numberClass(delta)}`}>{delta == null ? '--' : formatMoney(delta)}</td>
                <td className={`px-3 py-2 text-right font-mono ${numberClass(item.weightedChange)}`}>{formatPercent(item.weightedChange)}</td>
                <td className="px-3 py-2 text-right font-mono">{breadth == null ? '--' : `${breadth.toFixed(0)}%`} <span className="text-gray-400">({item.upCount}/{item.memberCount})</span></td>
                <td className="px-3 py-2 text-right font-mono text-gray-600 dark:text-gray-300">{formatMoney(item.totalAmount)}</td>
                <td className="px-3 py-2">{item.leader ? <span>{item.leader.name} <span className={numberClass(item.leader.change)}>{formatPercent(item.leader.change)}</span></span> : '--'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SegmentedControl({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <span className="mr-1 text-[11px] text-gray-500 dark:text-gray-400">{label}</span>
      {options.map(([key, optionLabel]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`min-h-11 rounded-md px-3 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${value === key ? 'bg-blue-600 text-white dark:bg-blue-500' : 'bg-white text-gray-600 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'}`}
        >
          {optionLabel}
        </button>
      ))}
    </div>
  )
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return <div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p></div>
}

function LoadingState() {
  return (
    <div className="space-y-3 p-4" aria-label="正在加载板块资金">
      <div className="h-24 animate-pulse rounded-md bg-gray-200 dark:bg-gray-800" />
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {[0, 1, 2].map((index) => <div key={index} className="h-48 animate-pulse rounded-md bg-gray-200 dark:bg-gray-800" />)}
      </div>
    </div>
  )
}

function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
      <QualityIcon verified={false} />
      <h3 className="mt-3 text-sm font-semibold">暂无板块资金事实</h3>
      <p className="mt-2 max-w-lg text-xs leading-5 text-gray-500 dark:text-gray-400">真实接口和本地行情均没有返回可用数据。刷新会重新尝试真实主力资金，不会用空值生成结论。</p>
      <button type="button" onClick={onRetry} className="mt-4 min-h-11 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500">重新加载</button>
    </div>
  )
}

function InlineEmpty({ text }: { text: string }) {
  return <div className="mt-3 border-l-2 border-gray-300 px-3 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">{text}</div>
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.34 5.66" strokeLinecap="round" />
      <path d="M20 4v7h-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg className="h-5 w-5 text-cyan-600 dark:text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M22 12h-3" strokeLinecap="round" />
    </svg>
  )
}

function QualityIcon({ verified }: { verified: boolean }) {
  return (
    <svg className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {verified ? <><path d="M12 3 5 6v5c0 4.5 2.8 7.8 7 10 4.2-2.2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></> : <><path d="M12 3 3 20h18L12 3Z" /><path d="M12 9v5M12 17h.01" /></>}
    </svg>
  )
}

function stanceClass(stance: FlowSnapshot['guidance']['stance']): string {
  if (stance === 'focus') return 'rounded bg-cyan-100 px-2 py-1 text-[11px] font-medium text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200'
  if (stance === 'defensive') return 'rounded bg-rose-100 px-2 py-1 text-[11px] font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-200'
  return 'rounded bg-amber-100 px-2 py-1 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200'
}

function numberClass(value: number | null): string {
  if (value == null || value === 0) return 'text-gray-500 dark:text-gray-400'
  return value > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
}

function formatMoney(value: number | null): string {
  if (value == null) return '--'
  const absolute = Math.abs(value)
  if (absolute >= 1e8) return `${value >= 0 ? '+' : ''}${(value / 1e8).toFixed(2)}亿`
  if (absolute >= 1e4) return `${value >= 0 ? '+' : ''}${(value / 1e4).toFixed(0)}万`
  return `${value >= 0 ? '+' : ''}${value.toFixed(0)}`
}

function formatPercent(value: number | null): string {
  if (value == null) return '--'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatTradeDate(value: string | null): string {
  if (!value || value.length !== 8) return '日期未知'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function formatUpdateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '更新时间未知'
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
}
