import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChipInstitutionCoverageStatus,
  ChipInstitutionEvidence,
  ChipStructureDetail,
  ChipStructureMetricName,
  ChipStructureSummary,
} from '../../../electron/main/database/types'
import { useAppStore } from '../../store/appStore'
import { StockKlineChipDrawer } from '../shared/StockMiniChart'

const PRESET_CODES = ['000001.SH', '399001.SZ', '399006.SZ']

type SourceFilter = 'all' | 'watchlist' | 'screener' | 'morningAuction' | 'portfolio'
type StatusFilter = 'all' | 'complete' | 'partial' | 'blocked' | 'warning'
type ChipMode = 'relative' | 'absolute'
type SyncScope = 'structure' | 'institution' | 'all'
type SyncStage = 'structure' | 'institution' | null
type AfterCloseScheduleStatus = Awaited<ReturnType<typeof window.api.chipStructure.getSyncStatus>>['schedule']

interface WorkbenchStock {
  tsCode: string
  source: Exclude<SourceFilter, 'all'>
  stockName: string | null
  addedAt: number
  summary: ChipStructureSummary
}

interface StatusCounts {
  complete: number
  partial: number
  blocked: number
  consistencyWarning: number
  stale: number
}

const SOURCE_LABELS: Record<SourceFilter, string> = {
  all: '全部来源',
  watchlist: '自选股',
  screener: '策略选股',
  morningAuction: '早盘竞价',
  portfolio: '我的持仓',
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: '全部状态',
  complete: '事实完整',
  partial: '部分可用',
  blocked: '事实缺失',
  warning: '一致性告警',
}

const METRIC_LABELS: Record<ChipStructureMetricName, string> = {
  winnerRate: '获利筹码',
  thickProfitPct: '厚浮盈区',
  thinProfitPct: '薄浮盈区',
  trappedPct: '套牢区',
  deepLowPct: '深度低位',
  concentration: '成本集中度',
  costDeviationPct: '现价偏离成本',
}

const MISSING_REASON_LABELS: Record<string, string> = {
  CYQ_PERF_MISSING: '缺少官方成本聚合',
  CYQ_CHIPS_MISSING: '缺少价格级筹码分布',
  DAILY_CLOSE_MISSING: '缺少同日收盘价',
  INSUFFICIENT_HISTORY: '有效筹码历史不足',
  DATE_MISMATCH: '事实日期不一致',
  UPSTREAM_UNAVAILABLE: '上游暂不可用',
  QUOTA_INSUFFICIENT: 'Tushare 权限不足',
}

function normalizeCode(tsCode: string): string {
  return tsCode.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function dedupeStocks<T extends { tsCode: string; stockName: string | null }>(items: T[]): T[] {
  const byCode = new Map<string, T>()
  for (const item of items) {
    const code = normalizeCode(item.tsCode)
    if (!code || PRESET_CODES.some((preset) => normalizeCode(preset) === code)) continue
    byCode.set(code, { ...item, tsCode: code })
  }
  return Array.from(byCode.values())
}

function formatPercent(value: number | null, digits = 1): string {
  if (value == null) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function formatNumber(value: number | null, digits = 2): string {
  return value == null ? '—' : value.toFixed(digits)
}

function formatDate(value: string | null): string {
  if (!value || value.length !== 8) return '—'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function formatAmount(value: number | null): string {
  if (value == null) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `${value >= 0 ? '+' : ''}${(value / 100_000_000).toFixed(2)}亿`
  if (absolute >= 10_000) return `${value >= 0 ? '+' : ''}${(value / 10_000).toFixed(2)}万`
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}元`
}

function formatUpdatedAt(value: number | null): string {
  return value == null ? '—' : new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function formatScheduleAt(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function scheduleStatusLabel(status: NonNullable<AfterCloseScheduleStatus['lastRun']>['status']): string {
  if (status === 'completed') return '完成'
  if (status === 'partial') return '部分完成'
  if (status === 'running') return '执行中'
  if (status === 'blocked') return '受阻'
  return '失败'
}

function metricTone(value: number | null): string {
  if (value == null) return 'text-slate-400 dark:text-slate-500'
  if (value > 0) return 'text-rose-600 dark:text-rose-400'
  if (value < 0) return 'text-emerald-600 dark:text-emerald-400'
  return 'text-slate-600 dark:text-slate-300'
}

function completenessTone(status: ChipStructureSummary['completenessStatus']): string {
  if (status === 'complete') return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800'
  if (status === 'partial') return 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800'
  return 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
}

function completenessLabel(status: ChipStructureSummary['completenessStatus']): string {
  return status === 'complete' ? '完整' : status === 'partial' ? '部分' : '缺失'
}

function sourceLabel(source: WorkbenchStock['source']): string {
  return source === 'portfolio'
    ? '持仓'
    : source === 'screener'
      ? '选股'
      : source === 'morningAuction'
        ? '竞价'
        : '自选'
}

function FactBar({
  label,
  value,
  tone = 'blue',
}: {
  label: string
  value: number | null
  tone?: 'blue' | 'rose' | 'emerald' | 'slate'
}): JSX.Element {
  const width = value == null ? 0 : Math.max(0, Math.min(100, value))
  const color = tone === 'rose'
    ? 'bg-rose-500'
    : tone === 'emerald'
      ? 'bg-emerald-500'
      : tone === 'slate'
        ? 'bg-slate-500'
        : 'bg-blue-500'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-slate-500 dark:text-slate-400">{label}</span>
        <span className="font-mono tabular-nums text-slate-800 dark:text-slate-200">
          {value == null ? '—' : `${value.toFixed(1)}%`}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-sm bg-slate-100 dark:bg-slate-800">
        <div className={`h-full rounded-sm ${color}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone?: string
}): JSX.Element {
  return (
    <div className="min-w-0 border-r border-slate-200 px-4 py-3 last:border-r-0 dark:border-slate-800">
      <div className="text-[10px] font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 truncate font-mono text-lg font-semibold tabular-nums ${tone ?? 'text-slate-900 dark:text-slate-100'}`}>
        {value}
      </div>
      <div className="mt-0.5 truncate text-[10px] text-slate-400 dark:text-slate-500">{detail}</div>
    </div>
  )
}

function ChangeMatrix({ detail }: { detail: ChipStructureDetail }): JSX.Element {
  const metrics: ChipStructureMetricName[] = ['winnerRate', 'trappedPct', 'concentration', 'costDeviationPct']
  return (
    <div className="overflow-hidden rounded border border-slate-200 dark:border-slate-800">
      <div className="grid grid-cols-[minmax(84px,1fr)_repeat(4,44px)] bg-slate-50 px-2 py-1.5 text-[10px] text-slate-500 dark:bg-slate-900 dark:text-slate-400">
        <span>结构变化</span>
        {[1, 3, 5, 12].map((days) => <span key={days} className="text-right">{days}日</span>)}
      </div>
      {metrics.map((metric) => (
        <div key={metric} className="grid grid-cols-[minmax(84px,1fr)_repeat(4,44px)] border-t border-slate-100 px-2 py-1.5 text-[10px] dark:border-slate-800">
          <span className="truncate text-slate-600 dark:text-slate-300">{METRIC_LABELS[metric]}</span>
          {detail.changes[metric].map((change) => (
            <span
              key={change.days}
              className={`text-right font-mono tabular-nums ${metricTone(change.value)}`}
              title={change.reason === 'INSUFFICIENT_HISTORY' ? '有效筹码交易日不足' : undefined}
            >
              {change.value == null ? '—' : `${change.value >= 0 ? '+' : ''}${change.value.toFixed(1)}`}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

const INSTITUTION_STATUS_LABELS: Record<ChipInstitutionCoverageStatus, string> = {
  available: '有公开记录',
  no_record: '当日无记录',
  not_synced: '尚未同步',
  failed: '同步失败',
}

const INSTITUTION_STATUS_DESCRIPTIONS: Record<ChipInstitutionCoverageStatus, string> = {
  available: '目标交易日存在公开披露的机构席位记录。',
  no_record: '该日期已完成全量同步，但该股票无可用机构席位记录。',
  not_synced: '该日期尚未同步机构席位数据，当前不能判断是否存在公开记录。',
  failed: '该日期最近同步失败，当前不能判断是否存在公开记录。',
}

function institutionStatusTone(status: ChipInstitutionCoverageStatus): string {
  if (status === 'available') return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800'
  if (status === 'failed') return 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900'
  if (status === 'not_synced') return 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900'
  return 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700'
}

function InstitutionEvidencePanel({ evidence }: { evidence: ChipInstitutionEvidence }): JSX.Element {
  return (
    <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold">机构席位行为证据</h4>
          <div className="mt-0.5 text-[9px] text-slate-400">龙虎榜公开披露 · 独立于筹码成本结构</div>
        </div>
        <span className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] ring-1 ring-inset ${institutionStatusTone(evidence.coverageStatus)}`}>
          {INSTITUTION_STATUS_LABELS[evidence.coverageStatus]}
        </span>
      </div>

      <div className="mt-2 text-[10px] leading-4 text-slate-500 dark:text-slate-400">
        {INSTITUTION_STATUS_DESCRIPTIONS[evidence.coverageStatus]}
      </div>
      <div className="mt-2 flex items-center justify-between text-[9px] text-slate-400">
        <span>交易日 {formatDate(evidence.tradeDate)}</span>
        <span>更新 {formatUpdatedAt(evidence.updatedAt)}</span>
      </div>

      {evidence.coverageStatus === 'available' && (
        <>
          <div className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded bg-slate-200 text-center dark:bg-slate-800">
            {[
              ['席位', `${evidence.institutionCount}`],
              ['买入', formatAmount(evidence.buyAmount)],
              ['卖出', formatAmount(evidence.sellAmount)],
              ['净额', formatAmount(evidence.netAmount)],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 bg-slate-50 px-1 py-1.5 dark:bg-slate-900">
                <div className="text-[9px] text-slate-400">{label}</div>
                <div className={`mt-1 truncate font-mono text-[10px] tabular-nums ${label === '净额' ? metricTone(evidence.netAmount) : ''}`} title={value}>{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 max-h-48 overflow-y-auto border-y border-slate-100 dark:border-slate-800">
            {evidence.records.map((record, index) => (
              <div key={`${record.institutionName}-${record.reason ?? ''}-${index}`} className="border-b border-slate-100 py-2 last:border-b-0 dark:border-slate-800">
                <div className="flex items-start justify-between gap-2 text-[10px]">
                  <span className="min-w-0 truncate font-medium text-slate-700 dark:text-slate-200" title={record.institutionName || undefined}>{record.institutionName || '席位名称待补'}</span>
                  <span className={`shrink-0 font-mono tabular-nums ${metricTone(record.netAmount)}`}>净 {formatAmount(record.netAmount)}</span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2 text-[9px] text-slate-500 dark:text-slate-400">
                  <span>买 {formatAmount(record.buyAmount)} · {record.buyRate == null ? '—' : `${record.buyRate.toFixed(2)}%`}</span>
                  <span className="text-right">卖 {formatAmount(record.sellAmount)} · {record.sellRate == null ? '—' : `${record.sellRate.toFixed(2)}%`}</span>
                </div>
                {record.reason && <div className="mt-1 text-[9px] leading-4 text-slate-400">{record.reason}</div>}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-2 border-t border-slate-100 pt-2 text-[9px] leading-4 text-slate-400 dark:border-slate-800">
        {evidence.limitation}
      </div>
    </div>
  )
}

export function ChipMonitor(): JSX.Element {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const [stocks, setStocks] = useState<WorkbenchStock[]>([])
  const [total, setTotal] = useState(0)
  const [statusCounts, setStatusCounts] = useState<StatusCounts>({
    complete: 0,
    partial: 0,
    blocked: 0,
    consistencyWarning: 0,
    stale: 0,
  })
  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [drawerStock, setDrawerStock] = useState<{ tsCode: string; stockName: string } | null>(null)
  const [detail, setDetail] = useState<ChipStructureDetail | null>(null)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [chipMode, setChipMode] = useState<ChipMode>(() => (
    localStorage.getItem('chipMonitorMode') === 'absolute' ? 'absolute' : 'relative'
  ))
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [scheduleStatus, setScheduleStatus] = useState<AfterCloseScheduleStatus | null>(null)
  const [progress, setProgress] = useState({
    scope: 'structure' as SyncScope,
    stage: null as SyncStage,
    done: 0,
    total: 0,
    currentStock: '',
    success: 0,
    noRecord: 0,
    partial: 0,
    failed: 0,
  })
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [watchlistConfirm, setWatchlistConfirm] = useState<Array<{ tsCode: string; stockName: string | null }> | null>(null)
  const [portfolioConfirm, setPortfolioConfirm] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const requestIdRef = useRef(0)
  const listRequestKeyRef = useRef<string | null>(null)
  const detailRequestIdRef = useRef(0)
  const syncSubmittingRef = useRef(false)

  async function loadStocks(): Promise<void> {
    const requestKey = JSON.stringify([sourceFilter, statusFilter, deferredSearch, chipMode])
    if (listRequestKeyRef.current === requestKey) return
    listRequestKeyRef.current = requestKey
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const response = await window.api.chipStructure.listStocks({
        source: sourceFilter,
        status: statusFilter,
        search: deferredSearch,
        mode: chipMode,
        limit: 500,
      })
      if (requestId !== requestIdRef.current) return
      if (!response.ok) {
        setMessage({ tone: 'error', text: response.error.message })
        return
      }
      setStocks(response.stocks)
      setTotal(response.total)
      setStatusCounts(response.statusCounts)
      setSelectedCode((current) => {
        if (current && response.stocks.some((stock) => stock.tsCode === current)) return current
        return response.stocks[0]?.tsCode ?? null
      })
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : '读取筹码结构失败' })
      }
    } finally {
      if (requestId === requestIdRef.current) {
        listRequestKeyRef.current = null
        setLoading(false)
      }
    }
  }

  async function loadDetail(tsCode: string): Promise<void> {
    const requestId = ++detailRequestIdRef.current
    setDetailLoading(true)
    try {
      const response = await window.api.chipStructure.getStockDetail({ tsCode, mode: chipMode })
      if (requestId !== detailRequestIdRef.current) return
      if (response.ok) setDetail(response.detail)
      else setMessage({ tone: 'error', text: response.error.message })
    } catch (error) {
      if (requestId === detailRequestIdRef.current) {
        setMessage({ tone: 'error', text: error instanceof Error ? error.message : '读取筹码详情失败' })
      }
    } finally {
      if (requestId === detailRequestIdRef.current) setDetailLoading(false)
    }
  }

  async function startRefresh(scope: SyncScope): Promise<void> {
    if (syncSubmittingRef.current || running) return
    syncSubmittingRef.current = true
    setRunning(true)
    setMessage(null)
    setProgress({ scope, stage: null, done: 0, total: 0, currentStock: '', success: 0, noRecord: 0, partial: 0, failed: 0 })
    try {
      const response = await window.api.chipStructure.refresh({ scope, force: true })
      if (!response.ok) {
        if (response.error.code === 'JOB_RUNNING') {
          const statusResponse = await window.api.chipStructure.getSyncStatus()
          if (statusResponse.status.state === 'running') {
            setProgress({
              scope: statusResponse.status.scope,
              stage: statusResponse.status.stage,
              done: statusResponse.status.done,
              total: statusResponse.status.total,
              currentStock: statusResponse.status.currentStock ?? '',
              success: statusResponse.status.success,
              noRecord: statusResponse.status.noRecord,
              partial: statusResponse.status.partial,
              failed: statusResponse.status.failed,
            })
            return
          }
        }
        setRunning(false)
        setMessage({ tone: 'error', text: response.error.message })
        return
      }
      setProgress({ scope, stage: null, done: 0, total: response.total, currentStock: '', success: 0, noRecord: 0, partial: 0, failed: 0 })
    } catch (error) {
      setRunning(false)
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : '无法启动筹码结构同步' })
    } finally {
      syncSubmittingRef.current = false
    }
  }

  async function prepareWatchlistImport(): Promise<void> {
    const all = await window.api.datasource.listStocks()
    const filtered = dedupeStocks(all.map((stock) => ({
      tsCode: stock.stockCode,
      stockName: stock.stockName,
    })))
    if (filtered.length === 0) {
      setMessage({ tone: 'info', text: '股票走势图中暂无可导入的自选股' })
      return
    }
    setWatchlistConfirm(filtered)
  }

  async function confirmWatchlistImport(): Promise<void> {
    if (!watchlistConfirm) return
    setImporting(true)
    try {
      await window.api.shortTerm.chipMonitorSyncWatchlist({ stocks: watchlistConfirm })
      setWatchlistConfirm(null)
      await loadStocks()
      await startRefresh('structure')
    } finally {
      setImporting(false)
    }
  }

  async function preparePortfolioImport(): Promise<void> {
    const response = await window.api.portfolio.list()
    const count = response.ok && response.data
      ? dedupeStocks(response.data.map((stock) => ({ tsCode: stock.tsCode, stockName: stock.stockName }))).length
      : 0
    if (count === 0) {
      setMessage({ tone: 'info', text: '当前没有可导入的持仓股票' })
      return
    }
    setPortfolioConfirm(count)
  }

  async function confirmPortfolioImport(): Promise<void> {
    if (portfolioConfirm == null) return
    setImporting(true)
    try {
      await window.api.shortTerm.chipMonitorSyncPortfolio()
      setPortfolioConfirm(null)
      await loadStocks()
      await startRefresh('structure')
    } finally {
      setImporting(false)
    }
  }

  useEffect(() => {
    void loadStocks()
  }, [sourceFilter, statusFilter, deferredSearch, chipMode])

  useEffect(() => {
    if (!selectedCode) {
      setDetail(null)
      return
    }
    void loadDetail(selectedCode)
  }, [selectedCode, chipMode])

  useEffect(() => {
    void window.api.chipStructure.getSyncStatus().then((response) => {
      setScheduleStatus(response.schedule)
      if (response.status.state === 'running') {
        setRunning(true)
        setProgress({
          scope: response.status.scope,
          stage: response.status.stage,
          done: response.status.done,
          total: response.status.total,
          currentStock: response.status.currentStock ?? '',
          success: response.status.success,
          noRecord: response.status.noRecord,
          partial: response.status.partial,
          failed: response.status.failed,
        })
      }
    })
    const offProgress = window.api.chipStructure.onProgress((payload) => {
      setRunning(true)
      setProgress({
        scope: payload.scope,
        stage: payload.stage,
        done: payload.done,
        total: payload.total,
        currentStock: payload.currentStock,
        success: payload.success,
        noRecord: payload.noRecord,
        partial: payload.partial,
        failed: payload.failed,
      })
    })
    const offDone = window.api.chipStructure.onDone((payload) => {
      setRunning(false)
      setMessage({
        tone: payload.state === 'failed' ? 'error' : 'info',
        text: `同步完成：成功 ${payload.success}，无记录 ${payload.noRecord}，部分 ${payload.partial}，失败 ${payload.failed}`,
      })
      void window.api.shortTerm.chipMonitorRecompute({ mode: chipMode }).then(async () => {
        await loadStocks()
        if (selectedCode) await loadDetail(selectedCode)
      })
      window.setTimeout(() => {
        void window.api.chipStructure.getSyncStatus().then((response) => setScheduleStatus(response.schedule))
      }, 500)
    })
    return () => {
      offProgress()
      offDone()
    }
  }, [chipMode, selectedCode])

  useEffect(() => {
    const refreshSchedule = (): void => {
      void window.api.chipStructure.getSyncStatus().then((response) => setScheduleStatus(response.schedule))
    }
    const interval = window.setInterval(refreshSchedule, 30_000)
    return () => window.clearInterval(interval)
  }, [])

  const selectedStock = useMemo(
    () => stocks.find((stock) => stock.tsCode === selectedCode) ?? null,
    [stocks, selectedCode],
  )

  const maxChipPercent = useMemo(
    () => detail?.chips.reduce((max, chip) => Math.max(max, chip.percent), 0) ?? 0,
    [detail],
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">筹码结构工作台</h2>
            <span className="rounded-sm bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">本地事实</span>
          </div>
          <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">成本分布仅描述价格结构，不推断账户身份</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => void preparePortfolioImport()} disabled={running || importing} className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">导入持仓</button>
          <button type="button" onClick={() => void prepareWatchlistImport()} disabled={running || importing} className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">导入自选</button>
          <button type="button" onClick={() => void loadStocks()} disabled={loading} className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">刷新本地</button>
          <button type="button" onClick={() => void startRefresh('structure')} disabled={running || total === 0} className="rounded border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-800 dark:bg-slate-900 dark:text-blue-300 dark:hover:bg-blue-950/40">同步结构</button>
          <button type="button" onClick={() => void startRefresh('institution')} disabled={running || total === 0} className="rounded border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:bg-slate-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40">同步机构</button>
          <button type="button" onClick={() => void startRefresh('all')} disabled={running || total === 0} className="rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">{running ? '同步中' : '同步全部'}</button>
        </div>
      </header>

      <div
        className="flex min-h-7 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-slate-50 px-4 py-1 text-[10px] text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400"
        aria-live="polite"
        data-testid="after-close-schedule-status"
      >
        <span className="font-medium text-slate-700 dark:text-slate-200">统一盘后同步 · 18:00</span>
        {scheduleStatus ? (
          <>
            <span>{scheduleStatus.active ? '调度已注册' : '调度未注册'}</span>
            <span>
              上次 {scheduleStatus.lastRun
                ? `${formatDate(scheduleStatus.lastRun.tradeDate)} · ${scheduleStatusLabel(scheduleStatus.lastRun.status)}`
                : '尚无运行记录'}
            </span>
            <span className="font-mono tabular-nums">下次 {formatScheduleAt(scheduleStatus.nextRunAt)}</span>
            {scheduleStatus.lastRun?.errorSummary && (
              <span className="min-w-0 flex-1 truncate text-amber-700 dark:text-amber-300" title={scheduleStatus.lastRun.errorSummary}>
                {scheduleStatus.lastRun.errorSummary}
              </span>
            )}
          </>
        ) : (
          <span>正在读取调度状态</span>
        )}
      </div>

      <section className="grid shrink-0 grid-cols-5 border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <MetricCard label="监控股池" value={`${total}`} detail="当前筛选结果" />
        <MetricCard label="事实完整" value={`${statusCounts.complete}`} detail="三类同日事实可用" tone="text-emerald-600 dark:text-emerald-400" />
        <MetricCard label="部分可用" value={`${statusCounts.partial}`} detail="至少一类筹码事实" tone="text-amber-600 dark:text-amber-400" />
        <MetricCard label="事实缺失" value={`${statusCounts.blocked}`} detail="无法形成结构快照" />
        <MetricCard label="一致性告警" value={`${statusCounts.consistencyWarning}`} detail={`过期 ${statusCounts.stale} 只`} tone={statusCounts.consistencyWarning > 0 ? 'text-rose-600 dark:text-rose-400' : undefined} />
      </section>

      {(message || running || watchlistConfirm || portfolioConfirm != null) && (
        <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
          {message && (
            <div className={`flex items-center justify-between rounded border px-3 py-2 text-xs ${message.tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300' : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300'}`}>
              <span>{message.text}</span>
              <button type="button" onClick={() => setMessage(null)} className="ml-3 text-current opacity-70 hover:opacity-100" aria-label="关闭提示">关闭</button>
            </div>
          )}
          {running && (
            <div className="flex items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
              <span className="w-40 truncate">{progress.stage === 'institution' ? '机构证据' : progress.stage === 'structure' ? '成本结构' : '准备同步'} · {progress.currentStock || '准备中'}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-slate-200 dark:bg-slate-800">
                <div className="h-full bg-blue-600 transition-[width]" style={{ width: progress.total > 0 ? `${progress.done / progress.total * 100}%` : '0%' }} />
              </div>
              <span className="font-mono tabular-nums">{progress.done}/{progress.total}</span>
              <span className="text-slate-400">成功 {progress.success} · 无记录 {progress.noRecord} · 部分 {progress.partial} · 失败 {progress.failed}</span>
            </div>
          )}
          {watchlistConfirm && (
            <div className="flex items-center gap-3 text-xs text-slate-700 dark:text-slate-200">
              <span>将导入 {watchlistConfirm.length} 只自选股，并显式同步筹码结构事实。</span>
              <button type="button" onClick={() => setWatchlistConfirm(null)} className="ml-auto text-slate-500 hover:text-slate-800 dark:hover:text-slate-100">取消</button>
              <button type="button" onClick={() => void confirmWatchlistImport()} disabled={importing} className="rounded bg-blue-600 px-2.5 py-1 text-white disabled:opacity-50">确认导入</button>
            </div>
          )}
          {portfolioConfirm != null && (
            <div className="flex items-center gap-3 text-xs text-slate-700 dark:text-slate-200">
              <span>将导入 {portfolioConfirm} 只持仓股，并显式同步筹码结构事实。</span>
              <button type="button" onClick={() => setPortfolioConfirm(null)} className="ml-auto text-slate-500 hover:text-slate-800 dark:hover:text-slate-100">取消</button>
              <button type="button" onClick={() => void confirmPortfolioImport()} disabled={importing} className="rounded bg-blue-600 px-2.5 py-1 text-white disabled:opacity-50">确认导入</button>
            </div>
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索代码或名称" aria-label="搜索筹码结构股票" className="w-48 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950" />
        <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950">
          {Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950">
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <div className="ml-auto flex rounded border border-slate-300 p-0.5 dark:border-slate-700">
          {(['relative', 'absolute'] as ChipMode[]).map((mode) => (
            <button key={mode} type="button" onClick={() => { setChipMode(mode); localStorage.setItem('chipMonitorMode', mode) }} className={`rounded-sm px-2 py-0.5 text-[11px] ${chipMode === mode ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'}`}>{mode === 'relative' ? '相对低位' : '绝对低位'}</button>
          ))}
        </div>
      </div>

      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_360px]">
        <section className="min-w-0 overflow-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
          <table className="w-full min-w-[1080px] border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 shadow-[0_1px_0_rgba(148,163,184,0.25)] dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">股票</th>
                <th className="px-2 py-2 text-left font-medium">来源</th>
                <th className="px-2 py-2 text-right font-medium">事实日期</th>
                <th className="px-2 py-2 text-right font-medium">最近同步</th>
                <th className="px-2 py-2 text-right font-medium">获利筹码</th>
                <th className="px-2 py-2 text-right font-medium">厚浮盈区</th>
                <th className="px-2 py-2 text-right font-medium">薄浮盈区</th>
                <th className="px-2 py-2 text-right font-medium">套牢区</th>
                <th className="px-2 py-2 text-right font-medium">深度低位</th>
                <th className="px-2 py-2 text-right font-medium">集中度</th>
                <th className="px-2 py-2 text-right font-medium">成本偏离</th>
                <th className="px-2 py-2 text-right font-medium">主要变化</th>
                <th className="px-3 py-2 text-center font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {stocks.map((stock) => {
                const summary = stock.summary
                const selected = stock.tsCode === selectedCode
                return (
                  <tr
                    key={stock.tsCode}
                    data-testid={`chip-monitor-row-${normalizeCode(stock.tsCode)}`}
                    onClick={() => setSelectedCode(stock.tsCode)}
                    onDoubleClick={() => setDrawerStock({
                      tsCode: stock.tsCode,
                      stockName: stock.stockName || '名称待补',
                    })}
                    className={`cursor-pointer border-b border-slate-100 transition-colors dark:border-slate-900 ${selected ? 'bg-blue-50/80 dark:bg-blue-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-900/70'}`}
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{stock.stockName || '名称待补'}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-slate-400">{normalizeCode(stock.tsCode)}</div>
                    </td>
                    <td className="px-2 py-2 text-slate-500 dark:text-slate-400">{sourceLabel(stock.source)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400">{formatDate(summary.tradeDate)}</td>
                    <td className="px-2 py-2 text-right text-[10px] tabular-nums text-slate-500 dark:text-slate-400">{formatUpdatedAt(summary.updatedAt)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{formatPercent(summary.winnerRate)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{formatPercent(summary.thickProfitPct)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{formatPercent(summary.thinProfitPct)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{formatPercent(summary.trappedPct)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{formatPercent(summary.deepLowPct)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{formatPercent(summary.concentration)}</td>
                    <td className={`px-2 py-2 text-right font-mono tabular-nums ${metricTone(summary.costDeviationPct)}`}>{formatPercent(summary.costDeviationPct)}</td>
                    <td className={`px-2 py-2 text-right font-mono tabular-nums ${metricTone(summary.primaryChange?.value ?? null)}`}>{summary.primaryChange ? `${summary.primaryChange.days}日 ${summary.primaryChange.value >= 0 ? '+' : ''}${summary.primaryChange.value.toFixed(1)}` : '—'}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex rounded-sm px-1.5 py-0.5 text-[10px] ring-1 ring-inset ${completenessTone(summary.completenessStatus)}`}>{completenessLabel(summary.completenessStatus)}</span>
                      {summary.consistencyStatus === 'warning' && <span className="ml-1 inline-flex rounded-sm bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">偏差</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!loading && stocks.length === 0 && (
            <div className="flex h-full min-h-64 flex-col items-center justify-center px-6 text-center">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">当前条件下没有筹码结构股票</div>
              <p className="mt-2 max-w-md text-xs leading-5 text-slate-500 dark:text-slate-400">导入持仓或自选股后，使用“同步结构”显式获取成本分布事实。查询和切换筛选不会触发外部请求。</p>
            </div>
          )}
          {loading && stocks.length === 0 && <div className="p-6 text-xs text-slate-500">正在读取本地筹码事实...</div>}
        </section>

        <aside className="min-h-0 overflow-y-auto bg-slate-50 p-3 dark:bg-slate-900/70">
          {!selectedStock && <div className="flex h-full items-center justify-center text-xs text-slate-500">从左侧选择一只股票查看事实详情</div>}
          {selectedStock && (
            <div className="space-y-3">
              <div className="flex items-start gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-semibold">{selectedStock.stockName || detail?.stockName || '名称待补'}</h3>
                    <span className={`rounded-sm px-1.5 py-0.5 text-[10px] ring-1 ring-inset ${completenessTone(selectedStock.summary.completenessStatus)}`}>{completenessLabel(selectedStock.summary.completenessStatus)}</span>
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-slate-500">{normalizeCode(selectedStock.tsCode)} · 事实 {formatDate(detail?.tradeDate ?? selectedStock.summary.tradeDate)} · 同步 {formatUpdatedAt(detail?.updatedAt ?? selectedStock.summary.updatedAt)}</div>
                </div>
                <button type="button" onClick={() => navigateToStock(normalizeCode(selectedStock.tsCode), selectedStock.stockName ?? undefined)} className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">走势图</button>
              </div>

              {detailLoading && !detail && <div className="py-8 text-center text-xs text-slate-500">正在读取本地详情...</div>}
              {detail && (
                <>
                  <div className="grid grid-cols-3 gap-px overflow-hidden rounded border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800">
                    {[
                      ['收盘价', formatNumber(detail.close), '同日行情'],
                      ['成本中位', formatNumber(detail.costPercentiles.cost50Pct), '50% 成本位'],
                      ['加权成本', formatNumber(detail.costPercentiles.weightedAvg), '官方聚合'],
                    ].map(([label, value, note]) => (
                      <div key={label} className="bg-white px-2 py-2 dark:bg-slate-950">
                        <div className="text-[9px] text-slate-400">{label}</div>
                        <div className="mt-1 font-mono text-sm font-semibold tabular-nums">{value}</div>
                        <div className="mt-0.5 text-[9px] text-slate-400">{note}</div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
                    <div className="mb-3 flex items-center justify-between">
                      <h4 className="text-xs font-semibold">成本结构</h4>
                      <span className="text-[10px] text-slate-400">0-100%</span>
                    </div>
                    <div className="space-y-3">
                      <FactBar label="获利筹码" value={detail.structure.winnerRateFromPerf ?? detail.structure.winnerRateFromChips} tone="rose" />
                      <FactBar label="厚浮盈区" value={detail.structure.thickProfitPct} tone="rose" />
                      <FactBar label="薄浮盈区" value={detail.structure.thinProfitPct} tone="blue" />
                      <FactBar label="套牢区" value={detail.structure.trappedPct} tone="emerald" />
                      <FactBar label="深度低位筹码" value={detail.structure.deepLowPct} tone="slate" />
                    </div>
                  </div>

                  <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
                    <h4 className="mb-2 text-xs font-semibold">成本分位</h4>
                    <div className="grid grid-cols-6 gap-1 text-center">
                      {[
                        ['5%', detail.costPercentiles.cost5Pct],
                        ['15%', detail.costPercentiles.cost15Pct],
                        ['50%', detail.costPercentiles.cost50Pct],
                        ['85%', detail.costPercentiles.cost85Pct],
                        ['95%', detail.costPercentiles.cost95Pct],
                        ['均值', detail.costPercentiles.weightedAvg],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="min-w-0 rounded-sm bg-slate-50 px-1 py-1.5 dark:bg-slate-900">
                          <div className="text-[9px] text-slate-400">{label}</div>
                          <div className="mt-1 truncate font-mono text-[10px] tabular-nums">{formatNumber(value as number | null)}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                      <div className="rounded-sm bg-slate-50 px-2 py-1.5 dark:bg-slate-900"><span className="text-slate-400">集中度</span><span className="float-right font-mono">{formatPercent(detail.structure.concentration)}</span></div>
                      <div className="rounded-sm bg-slate-50 px-2 py-1.5 dark:bg-slate-900"><span className="text-slate-400">现价偏离</span><span className={`float-right font-mono ${metricTone(detail.structure.costDeviationPct)}`}>{formatPercent(detail.structure.costDeviationPct)}</span></div>
                    </div>
                  </div>

                  <ChangeMatrix detail={detail} />

                  <InstitutionEvidencePanel evidence={detail.institutionEvidence} />

                  {detail.legacy && (
                    <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
                      <div className="mb-2 flex items-center justify-between"><h4 className="text-xs font-semibold">低位筹码兼容指标</h4><span className="text-[10px] text-slate-400">{detail.legacy.mode === 'relative' ? '相对低位' : '绝对低位'}</span></div>
                      <div className="grid grid-cols-5 gap-1 text-center text-[10px]">
                        {[
                          ['底部占比', detail.legacy.bottomPct],
                          ['底部均价', detail.legacy.bottomAvgCost],
                          ['1日松动', detail.legacy.loosening1d],
                          ['3日松动', detail.legacy.loosening3d],
                          ['5日松动', detail.legacy.loosening5d],
                        ].map(([label, value]) => (
                          <div key={String(label)} className="rounded-sm bg-slate-50 px-1 py-1.5 dark:bg-slate-900"><div className="text-[9px] text-slate-400">{label}</div><div className="mt-1 font-mono tabular-nums">{value == null ? '—' : Number(value).toFixed(1)}</div></div>
                        ))}
                      </div>
                    </div>
                  )}

                  {detail.chips.length > 0 && (
                    <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
                      <div className="mb-2 flex items-center justify-between"><h4 className="text-xs font-semibold">价格级筹码峰</h4><span className="text-[10px] text-slate-400">{detail.chips.length} 个价位</span></div>
                      <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                        {[...detail.chips].sort((a, b) => b.percent - a.percent).slice(0, 12).map((chip) => (
                          <div key={chip.price} className="grid grid-cols-[48px_1fr_38px] items-center gap-2 text-[9px]"><span className="font-mono text-slate-500">{chip.price.toFixed(2)}</span><div className="h-1 bg-slate-100 dark:bg-slate-800"><div className="h-full bg-blue-500" style={{ width: `${maxChipPercent > 0 ? chip.percent / maxChipPercent * 100 : 0}%` }} /></div><span className="text-right font-mono">{chip.percent.toFixed(2)}%</span></div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className={`rounded border p-3 text-[10px] ${detail.consistency.status === 'warning' ? 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300' : 'border-slate-200 bg-white text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300'}`}>
                    <div className="flex items-center justify-between"><span className="font-semibold">获利比例一致性</span><span>{detail.consistency.status === 'matched' ? '匹配' : detail.consistency.status === 'warning' ? '存在偏差' : '不可比较'}</span></div>
                    <div className="mt-1 leading-4">官方 {formatPercent(detail.consistency.officialWinnerRate)} · 价格级重算 {formatPercent(detail.consistency.recomputedWinnerRate)} · 偏差 {detail.consistency.differencePctPoint == null ? '—' : `${detail.consistency.differencePctPoint.toFixed(1)} 个百分点`}</div>
                    {detail.consistency.reason && <div className="mt-1 text-slate-500 dark:text-slate-400">{detail.consistency.reason}</div>}
                  </div>

                  <div className="rounded border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
                    <h4 className="mb-2 text-xs font-semibold">事实来源</h4>
                    <div className="space-y-1.5">
                      {detail.sources.map((source) => (
                        <div key={source.source} className="flex items-center justify-between text-[10px]"><span className="text-slate-500 dark:text-slate-400">{source.source}</span><span className="font-mono text-slate-600 dark:text-slate-300">{source.status === 'available' ? formatDate(source.tradeDate) : source.status === 'stale' ? `${formatDate(source.tradeDate)} · 过期` : '缺失'}</span></div>
                      ))}
                    </div>
                  </div>

                  {detail.missingReasons.length > 0 && (
                    <div className="rounded border border-amber-200 bg-amber-50 p-3 text-[10px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                      <div className="font-semibold">待补事实</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">{detail.missingReasons.map((reason) => <span key={reason} className="rounded-sm bg-white/70 px-1.5 py-0.5 dark:bg-slate-950/40">{MISSING_REASON_LABELS[reason] ?? reason}</span>)}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </aside>
      </main>

      {drawerStock && (
        <StockKlineChipDrawer
          tsCode={drawerStock.tsCode}
          stockName={drawerStock.stockName}
          onClose={() => setDrawerStock(null)}
          onNavigate={() => {
            navigateToStock(normalizeCode(drawerStock.tsCode), drawerStock.stockName)
            setDrawerStock(null)
          }}
        />
      )}
    </div>
  )
}
