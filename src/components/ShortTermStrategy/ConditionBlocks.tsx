import { useCallback, useEffect, useMemo, useState } from 'react'
import { normalizeDevUserTier, readDevUserTier, type DevUserTier } from '../../utils/devUserTier'

interface TemplateSummary {
  id: number
  templateKey: string
  name: string
  description: string | null
  version: number
  enabled: boolean
  updatedAt: number
  lastRunAt: number | null
  lastMatchCount: number | null
}

interface MatchRow {
  id: number
  runId: number
  templateKey: string
  templateVersion: number
  tsCode: string
  stockName: string | null
  tradeDate: string
  windowStart: string | null
  windowEnd: string | null
  totalScore: number
  dataStatus: string
  evidenceJson: string
  createdAt: number
}

interface ScanSummary {
  scanMode: ScanMode
  dateStart: string
  dateEnd: string
  totalStocks: number
  dailyPrefilteredStocks: number
  dailyCandidateStocks: number
  minuteCompleteStocks: number
  minuteIncompleteStocks: number
  evaluatedStocks: number
  unevaluatedStocks: number
  minuteCacheHitGaps: number
  minuteMissingGaps: number
  minuteFetchAttempted: number
  minuteFetchSucceeded: number
  minuteFetchFailed: number
  minuteFetchEmpty: number
  minuteFetchSkippedByLimit: number
  minuteFetchSkippedByFailureGuard: number
  minuteFetchStoppedByFailureGuard: boolean
  minuteUserTier?: DevUserTier
  minuteDataProviderId: string
  minuteDataProviderLabel: string
  minuteGranularity: '1m' | '5m'
  minuteDataSource: 'localFree' | 'userProvided' | 'cloudFree' | 'cloudPro'
  minuteDataApproximate: boolean
  minuteExactEvaluatedStocks: number
  minuteApproxEvaluatedStocks: number
  minuteDataQualityNote: string
  stocksWithMinuteData: number
  evaluatedTradeDays: number
  minuteRows: number
  matchedCount: number
}

type ScanMode = 'complete' | 'quick'
type ScanStage = 'prepare' | 'prefilter' | 'minuteCheck' | 'minuteFetch' | 'evaluate' | 'save' | 'done' | 'failed'

interface ScanProgressEvent {
  stage: ScanStage
  current: number
  total: number
  message: string
  stats?: Partial<ScanSummary>
}

interface ScanStep {
  key: ScanStage
  label: string
}

const SCAN_STEPS: ScanStep[] = [
  { key: 'prepare', label: '准备模板与股池' },
  { key: 'prefilter', label: '执行日线预筛' },
  { key: 'minuteCheck', label: '检查分钟缓存' },
  { key: 'minuteFetch', label: '检查并限速补拉分钟线' },
  { key: 'evaluate', label: '执行分钟条件' },
  { key: 'save', label: '写入扫描结果' },
  { key: 'done', label: '完成' },
]

function formatTime(ts: number | null): string {
  if (!ts) return '暂无'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function todayYmd(): string {
  const now = new Date()
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
  return `${bj.getFullYear()}${String(bj.getMonth() + 1).padStart(2, '0')}${String(bj.getDate()).padStart(2, '0')}`
}

function offsetYmd(days: number): string {
  const now = new Date()
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000)
  bj.setDate(bj.getDate() + days)
  return `${bj.getFullYear()}${String(bj.getMonth() + 1).padStart(2, '0')}${String(bj.getDate()).padStart(2, '0')}`
}

function ymdToDash(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : ''
}

function dashToYmd(value: string): string {
  return value.replace(/-/g, '')
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-red-600 dark:text-red-300'
  if (score >= 60) return 'text-amber-600 dark:text-amber-300'
  return 'text-slate-600 dark:text-slate-300'
}

function scanProgress(progress: ScanProgressEvent | null): number {
  if (!progress) return 0
  if (progress.stage === 'done' || progress.stage === 'failed') return 100
  const index = SCAN_STEPS.findIndex(item => item.key === progress.stage)
  const base = index < 0 ? 0 : index / SCAN_STEPS.length * 100
  const span = 100 / SCAN_STEPS.length
  const inner = progress.total > 0 ? Math.max(0, Math.min(1, progress.current / progress.total)) : 0
  return Math.max(3, Math.min(98, Math.round(base + span * inner)))
}

function scanEmptyHint(summary: ScanSummary | null): string {
  if (!summary) return '暂无命中结果。可先运行扫描，或等待本地分钟线数据补齐。'
  if (summary.totalStocks === 0) return '本次扫描的股票池为空。请先在持仓、趋势池、筹码监控或模板手动股池中加入股票。'
  if (summary.minuteCompleteStocks === 0) return `本次扫描全市场 ${summary.totalStocks} 只，日线候选 ${summary.dailyCandidateStocks} 只，但日期范围 ${summary.dateStart} - ${summary.dateEnd} 内没有分钟线完整覆盖的候选。已尝试补拉 ${summary.minuteFetchAttempted} 个缺口，成功 ${summary.minuteFetchSucceeded} 个，未评估 ${summary.unevaluatedStocks} 只。`
  if (summary.evaluatedTradeDays === 0) return `本次扫描有 ${summary.minuteCompleteStocks} 只股票分钟线完整，但没有形成可评估交易日。`
  if (summary.unevaluatedStocks > 0) return `本次完整评估 ${summary.evaluatedStocks} 只，仍有 ${summary.unevaluatedStocks} 只因分钟线不完整未评估。当前已评估样本暂无命中，不能等同于全部 ${summary.dailyCandidateStocks} 只候选均无命中。`
  return `本次从本地日线全市场覆盖 ${summary.totalStocks} 只出发，日线预筛 ${summary.dailyCandidateStocks} 只，分钟线完整并实际评估 ${summary.evaluatedStocks} 只、${summary.evaluatedTradeDays} 个交易日、${summary.minuteRows} 根分钟线，当前模板条件下暂无命中。可放宽阈值或调整日线预筛范围后重扫。`
}

function toSafeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeScanSummary(raw: Partial<ScanSummary>): ScanSummary {
  const totalStocks = toSafeNumber(raw.totalStocks)
  const stocksWithMinuteData = toSafeNumber(raw.stocksWithMinuteData)
  const dailyPrefilteredStocks = toSafeNumber(raw.dailyPrefilteredStocks, totalStocks)
  const dailyCandidateStocks = toSafeNumber(raw.dailyCandidateStocks, dailyPrefilteredStocks)
  const minuteCompleteStocks = toSafeNumber(raw.minuteCompleteStocks, stocksWithMinuteData)
  return {
    scanMode: raw.scanMode === 'quick' ? 'quick' : 'complete',
    dateStart: raw.dateStart ?? '',
    dateEnd: raw.dateEnd ?? '',
    totalStocks,
    dailyPrefilteredStocks,
    dailyCandidateStocks,
    minuteCompleteStocks,
    minuteIncompleteStocks: toSafeNumber(raw.minuteIncompleteStocks, Math.max(0, dailyCandidateStocks - minuteCompleteStocks)),
    evaluatedStocks: toSafeNumber(raw.evaluatedStocks, stocksWithMinuteData),
    unevaluatedStocks: toSafeNumber(raw.unevaluatedStocks, Math.max(0, dailyCandidateStocks - stocksWithMinuteData)),
    minuteCacheHitGaps: toSafeNumber(raw.minuteCacheHitGaps),
    minuteMissingGaps: toSafeNumber(raw.minuteMissingGaps),
    minuteFetchAttempted: toSafeNumber(raw.minuteFetchAttempted),
    minuteFetchSucceeded: toSafeNumber(raw.minuteFetchSucceeded),
    minuteFetchFailed: toSafeNumber(raw.minuteFetchFailed),
    minuteFetchEmpty: toSafeNumber(raw.minuteFetchEmpty),
    minuteFetchSkippedByLimit: toSafeNumber(raw.minuteFetchSkippedByLimit),
    minuteFetchSkippedByFailureGuard: toSafeNumber(raw.minuteFetchSkippedByFailureGuard),
    minuteFetchStoppedByFailureGuard: raw.minuteFetchStoppedByFailureGuard === true,
    minuteUserTier: normalizeDevUserTier(raw.minuteUserTier),
    minuteDataProviderId: typeof raw.minuteDataProviderId === 'string' ? raw.minuteDataProviderId : 'sinaHistory5m',
    minuteDataProviderLabel: typeof raw.minuteDataProviderLabel === 'string' ? raw.minuteDataProviderLabel : '新浪历史5分钟',
    minuteGranularity: raw.minuteGranularity === '1m' ? '1m' : '5m',
    minuteDataSource: raw.minuteDataSource === 'cloudPro' || raw.minuteDataSource === 'cloudFree' || raw.minuteDataSource === 'userProvided' ? raw.minuteDataSource : 'localFree',
    minuteDataApproximate: raw.minuteDataApproximate !== false,
    minuteExactEvaluatedStocks: toSafeNumber(raw.minuteExactEvaluatedStocks),
    minuteApproxEvaluatedStocks: toSafeNumber(raw.minuteApproxEvaluatedStocks),
    minuteDataQualityNote: typeof raw.minuteDataQualityNote === 'string' ? raw.minuteDataQualityNote : '免费历史分钟近似能力, 不等同于1分钟精确扫描',
    stocksWithMinuteData,
    evaluatedTradeDays: toSafeNumber(raw.evaluatedTradeDays),
    minuteRows: toSafeNumber(raw.minuteRows),
    matchedCount: toSafeNumber(raw.matchedCount),
  }
}

function getTemplateScopeNumber(templateJson: unknown, key: 'dailyPrefilterLimit' | 'autoFetchMinuteLimit', fallback: number): number {
  const value = (templateJson as { scope?: Record<string, unknown> } | null)?.scope?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function scanConfigSummary(scanMode: ScanMode, dateStart: string, dateEnd: string, dailyLimit: number, minuteLimit: number): string {
  return `${scanMode === 'complete' ? '完整扫描' : '快速扫描'} · 区间 ${ymdToDash(dateStart)} - ${ymdToDash(dateEnd)} · 日线预筛 ${dailyLimit} · 统一分钟数据入口 · 分钟补拉 ${scanMode === 'complete' ? '按缺口补齐' : minuteLimit}`
}

function tierLabel(tier: DevUserTier): string {
  return tier === 'pro' ? '付费用户' : '免费用户'
}

export function ConditionBlocks(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [templateJson, setTemplateJson] = useState<unknown | null>(null)
  const [matches, setMatches] = useState<MatchRow[]>([])
  const [selectedEvidence, setSelectedEvidence] = useState<unknown | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [scanProgressEvent, setScanProgressEvent] = useState<ScanProgressEvent | null>(null)
  const [lastSummary, setLastSummary] = useState<ScanSummary | null>(null)
  const [scanDateStart, setScanDateStart] = useState(() => offsetYmd(-30))
  const [scanDateEnd, setScanDateEnd] = useState(() => todayYmd())
  const [scanMode, setScanMode] = useState<ScanMode>('complete')
  const [dailyPrefilterLimit, setDailyPrefilterLimit] = useState(500)
  const [autoFetchMinuteLimit, setAutoFetchMinuteLimit] = useState(120)
  const [devUserTier, setDevUserTier] = useState<DevUserTier>(() => readDevUserTier())
  const [showScanConfig, setShowScanConfig] = useState(false)
  const [showScanDetails, setShowScanDetails] = useState(false)
  const [showTemplateDetail, setShowTemplateDetail] = useState(false)
  const [showEvidenceDetail, setShowEvidenceDetail] = useState(false)
  const [matchQuery, setMatchQuery] = useState('')
  const [minScore, setMinScore] = useState('')
  const [dataStatusFilter, setDataStatusFilter] = useState('all')

  const selected = useMemo(() => templates.find(t => t.id === selectedId) ?? null, [templates, selectedId])
  const filteredMatches = useMemo(() => {
    const query = matchQuery.trim().toLowerCase()
    const scoreFloor = minScore.trim() === '' ? null : Number(minScore)
    return matches.filter((match) => {
      if (query && !match.tsCode.toLowerCase().includes(query) && !(match.stockName ?? '').toLowerCase().includes(query)) return false
      if (scoreFloor !== null && Number.isFinite(scoreFloor) && match.totalScore < scoreFloor) return false
      if (dataStatusFilter !== 'all' && match.dataStatus !== dataStatusFilter) return false
      return true
    })
  }, [dataStatusFilter, matchQuery, matches, minScore])
  const dataStatusOptions = useMemo(() => Array.from(new Set(matches.map(match => match.dataStatus))).filter(Boolean), [matches])

  const showToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 5000)
  }, [])

  const loadTemplates = useCallback(async (options?: { keepMessage?: boolean }) => {
    setLoading(true)
    if (!options?.keepMessage) setMessage(null)
    try {
      const res = await window.api.conditionBlocks.listTemplates()
      if (!res.ok) throw new Error(res.error)
      setTemplates(res.templates)
      setSelectedId((current) => current ?? res.templates[0]?.id ?? null)
    } catch (err) {
      setMessage(`加载模板失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadTemplateDetail = useCallback(async (id: number) => {
    try {
      const res = await window.api.conditionBlocks.getTemplate(id)
      if (!res.ok) throw new Error(res.error)
      setTemplateJson(res.template)
    } catch (err) {
      setMessage(`加载模板详情失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const loadMatches = useCallback(async (templateKey?: string) => {
    try {
      const res = await window.api.conditionBlocks.listMatches({ templateKey, limit: 100 })
      if (!res.ok) throw new Error(res.error)
      setMatches(res.matches)
    } catch (err) {
      setMessage(`加载命中结果失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  useEffect(() => { void loadTemplates() }, [loadTemplates])

  useEffect(() => {
    if (!selectedId) return
    void loadTemplateDetail(selectedId)
  }, [loadTemplateDetail, selectedId])

  useEffect(() => { void loadMatches(selected?.templateKey) }, [loadMatches, selected?.templateKey])

  useEffect(() => {
    if (!templateJson) return
    setDailyPrefilterLimit(getTemplateScopeNumber(templateJson, 'dailyPrefilterLimit', 500))
    setAutoFetchMinuteLimit(getTemplateScopeNumber(templateJson, 'autoFetchMinuteLimit', 120))
  }, [templateJson])

  useEffect(() => {
    const handleTierChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ tier?: unknown }>).detail
      setDevUserTier(normalizeDevUserTier(detail?.tier))
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'tradeWatch.devUserTier') setDevUserTier(normalizeDevUserTier(event.newValue))
    }
    window.addEventListener('trade-watch:dev-user-tier-changed', handleTierChanged)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener('trade-watch:dev-user-tier-changed', handleTierChanged)
      window.removeEventListener('storage', handleStorage)
    }
  }, [])

  useEffect(() => {
    const off = window.api.conditionBlocks.onProgress?.((progress: ScanProgressEvent) => {
      setScanProgressEvent(progress)
      if (progress.stats) {
        setLastSummary((current) => normalizeScanSummary({ ...(current ?? {}), ...progress.stats }))
      }
    })
    return off
  }, [])

  const handleRun = async (): Promise<void> => {
    if (!selected) return
    setRunning(true)
    setCancelling(false)
    setMessage(null)
    setLastSummary(null)
    setScanProgressEvent({ stage: 'prepare', current: 0, total: 1, message: '准备扫描' })
    try {
      const res = await window.api.conditionBlocks.runScan({
        templateId: selected.id,
        force: true,
        scanMode,
        userTier: import.meta.env.DEV ? devUserTier : undefined,
        scopeOverride: {
          dateStart: scanDateStart,
          dateEnd: scanDateEnd,
          dailyPrefilterLimit,
          autoFetchMinuteLimit,
        },
      })
      if (!res.ok) throw new Error(res.error)
      const summary = normalizeScanSummary(res.summary)
      setLastSummary(summary)
      const quality = summary.minuteDataApproximate ? `${summary.minuteGranularity}近似` : `${summary.minuteGranularity}精确`
      const summaryText = `扫描完成：${summary.scanMode === 'complete' ? '完整扫描' : '快速扫描'}，本地日线覆盖 ${summary.totalStocks} 只，日线候选 ${summary.dailyCandidateStocks} 只，分钟完整 ${summary.minuteCompleteStocks} 只，实际评估 ${summary.evaluatedStocks} 只（${quality}），未评估 ${summary.unevaluatedStocks} 只，命中 ${res.matchedCount} 条${res.cached ? '（使用缓存）' : ''}`
      setMessage(summaryText)
      await loadTemplates({ keepMessage: true })
      await loadMatches(selected.templateKey)
      setScanProgressEvent({ stage: 'done', current: 1, total: 1, message: summaryText, stats: summary })
      showToast(summaryText)
    } catch (err) {
      const text = `扫描失败：${err instanceof Error ? err.message : String(err)}`
      setMessage(text)
      showToast(text)
    } finally {
      setRunning(false)
      setCancelling(false)
      window.setTimeout(() => setScanProgressEvent(null), 1600)
    }
  }

  const handleCancelScan = async (): Promise<void> => {
    if (!running || cancelling) return
    setCancelling(true)
    setScanProgressEvent((current) => current ? { ...current, message: '正在终止扫描...' } : { stage: 'failed', current: 0, total: 1, message: '正在终止扫描...' })
    try {
      const res = await window.api.conditionBlocks.cancelScan()
      if (!res.ok) throw new Error(res.error)
      const text = '已请求终止扫描, 已缓存的分钟数据会保留。'
      setMessage(text)
      showToast(text)
    } catch (err) {
      const text = `终止扫描失败：${err instanceof Error ? err.message : String(err)}`
      setMessage(text)
      showToast(text)
      setCancelling(false)
    }
  }

  const handleEvidence = async (id: number): Promise<void> => {
    try {
      setShowEvidenceDetail(true)
      setSelectedEvidence(null)
      const res = await window.api.conditionBlocks.getMatchEvidence(id)
      if (!res.ok) throw new Error(res.error)
      setSelectedEvidence(res.evidence)
    } catch (err) {
      setMessage(`读取证据失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="flex h-full min-h-0 bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {toast && (
        <div className="fixed bottom-4 right-4 z-[10050] max-w-md rounded-lg border border-blue-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-xl dark:border-blue-800 dark:bg-slate-900 dark:text-slate-100">
          {toast}
        </div>
      )}
      {showScanConfig && (
        <div className="fixed inset-0 z-[10040] flex items-center justify-center bg-slate-950/40 px-4">
          <div className="w-full max-w-xl rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
              <div>
                <div className="text-sm font-semibold">扫描配置</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">配置只影响本次运行, 会参与扫描缓存哈希。</div>
              </div>
              <button type="button" onClick={() => setShowScanConfig(false)} className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">×</button>
            </div>
            <div className="grid grid-cols-2 gap-3 p-4 text-xs">
              <div className="col-span-2 grid grid-cols-2 gap-2 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => setScanMode('complete')}
                  className={`rounded px-3 py-2 text-left ${scanMode === 'complete' ? 'bg-blue-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                >
                  <span className="block text-sm font-medium">完整扫描</span>
                  <span className="mt-1 block text-[11px] opacity-80">日线候选全部补齐分钟线后再评估</span>
                </button>
                <button
                  type="button"
                  onClick={() => setScanMode('quick')}
                  className={`rounded px-3 py-2 text-left ${scanMode === 'quick' ? 'bg-blue-600 text-white' : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'}`}
                >
                  <span className="block text-sm font-medium">快速扫描</span>
                  <span className="mt-1 block text-[11px] opacity-80">只补拉上限内缺口, 用于试跑</span>
                </button>
              </div>
              <label className="space-y-1">
                <span className="block text-slate-500 dark:text-slate-400">开始日期</span>
                <input
                  type="date"
                  value={ymdToDash(scanDateStart)}
                  max={ymdToDash(scanDateEnd)}
                  onChange={(event) => setScanDateStart(dashToYmd(event.target.value))}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-slate-500 dark:text-slate-400">结束日期</span>
                <input
                  type="date"
                  value={ymdToDash(scanDateEnd)}
                  min={ymdToDash(scanDateStart)}
                  max={ymdToDash(todayYmd())}
                  onChange={(event) => setScanDateEnd(dashToYmd(event.target.value))}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-slate-500 dark:text-slate-400">日线预筛上限</span>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  step={50}
                  value={dailyPrefilterLimit}
                  onChange={(event) => setDailyPrefilterLimit(Math.max(1, Math.min(1000, Number(event.target.value) || 1)))}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-slate-500 dark:text-slate-400">分钟补拉上限</span>
                <input
                  type="number"
                  min={0}
                  max={500}
                  step={20}
                  value={autoFetchMinuteLimit}
                  onChange={(event) => setAutoFetchMinuteLimit(Math.max(0, Math.min(500, Number(event.target.value) || 0)))}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                />
              </label>
              <div className="col-span-2 rounded border border-blue-100 bg-blue-50 p-3 text-[11px] leading-5 text-blue-800 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-200">
                日线预筛上限决定进入分钟线检查的候选规模。完整扫描会围绕全部候选补齐扫描区间分钟缺口, 未补齐会记录为未评估; 快速扫描才使用分钟补拉上限截断试跑。已有缓存会直接复用, 不重复请求上游。
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700">
              <button type="button" onClick={() => setShowScanConfig(false)} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">取消</button>
              <button type="button" onClick={() => setShowScanConfig(false)} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">保存配置</button>
            </div>
          </div>
        </div>
      )}
      {showTemplateDetail && (
        <div className="fixed inset-0 z-[10040] flex items-center justify-center bg-slate-950/40 px-4">
          <div className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
              <div>
                <div className="text-sm font-semibold">模板详情</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{selected?.name ?? '未选择模板'} · JSON 仅用于排查和维护。</div>
              </div>
              <button type="button" onClick={() => setShowTemplateDetail(false)} className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">×</button>
            </div>
            <div className="min-h-0 overflow-auto p-4">
              <pre className="rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100">{templateJson ? JSON.stringify(templateJson, null, 2) : '请选择模板'}</pre>
            </div>
          </div>
        </div>
      )}
      {showEvidenceDetail && (
        <div className="fixed inset-0 z-[10040] flex items-center justify-center bg-slate-950/40 px-4">
          <div className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
              <div>
                <div className="text-sm font-semibold">命中证据</div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">查看单条命中记录的窗口、条件得分和证据 JSON。</div>
              </div>
              <button type="button" onClick={() => setShowEvidenceDetail(false)} className="rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">×</button>
            </div>
            <div className="min-h-0 overflow-auto p-4">
              <pre className="min-h-80 rounded bg-slate-950 p-3 text-xs leading-5 text-slate-100">{selectedEvidence ? JSON.stringify(selectedEvidence, null, 2) : '正在加载证据...'}</pre>
            </div>
          </div>
        </div>
      )}
      <aside className="w-72 shrink-0 overflow-auto border-r border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">条件积木模板</h2>
          <button type="button" onClick={() => void loadTemplates()} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">刷新</button>
        </div>
        {loading && <div className="text-xs text-slate-500">加载中...</div>}
        <div className="space-y-2">
          {templates.map(template => (
            <button
              key={template.id}
              type="button"
              onClick={() => setSelectedId(template.id)}
              className={`w-full rounded border p-3 text-left transition-colors ${selectedId === template.id ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950/40' : 'border-slate-200 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800'}`}
            >
              <div className="text-sm font-medium">{template.name}</div>
              <div className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{template.description ?? '暂无说明'}</div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                <span>v{template.version}</span>
                <span>命中 {template.lastMatchCount ?? 0}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-base font-semibold">{selected?.name ?? '条件积木'}</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{selected?.description ?? '从本地分钟线中扫描可解释的盘中形态。'}</p>
              {selected && <div className="mt-2 text-xs text-slate-400">最近扫描：{formatTime(selected.lastRunAt)}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => setShowTemplateDetail(true)} className="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">模板详情</button>
              <button type="button" onClick={() => setShowScanConfig(true)} className="rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">扫描配置</button>
              <button
                type="button"
                onClick={() => void handleRun()}
                disabled={!selected || running}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {running ? '扫描中...' : '运行扫描'}
              </button>
              {running && (
                <button
                  type="button"
                  onClick={() => void handleCancelScan()}
                  disabled={cancelling}
                  className="rounded border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  {cancelling ? '终止中...' : '终止扫描'}
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">当前配置：{scanConfigSummary(scanMode, scanDateStart, scanDateEnd, dailyPrefilterLimit, autoFetchMinuteLimit)}{import.meta.env.DEV ? ` · 模拟${tierLabel(devUserTier)}` : ''}</div>
          <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            数据层级：条件积木只调用统一分钟数据入口, 由数据层按用户层级选择实际 Provider。开发环境当前模拟{tierLabel(devUserTier)}; 免费层默认使用新浪历史 5 分钟近似, 付费层优先请求 1 分钟精确能力。近似结果会在摘要和日志中标注, 不等同于 1 分钟精确扫描。
          </div>
          {message && <div className="mt-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">{message}</div>}
          {(running || scanProgressEvent) && (
            <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/40">
              <div className="mb-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>{scanProgressEvent?.message ?? '准备扫描'}</span>
                <span>{scanProgress(scanProgressEvent)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div className="h-full rounded-full bg-blue-600 transition-all duration-300" style={{ width: `${scanProgress(scanProgressEvent)}%` }} />
              </div>
              <div className="mt-2 grid grid-cols-4 gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                {SCAN_STEPS.map(step => (
                  <div key={step.key} className={SCAN_STEPS.findIndex(item => item.key === scanProgressEvent?.stage) >= SCAN_STEPS.findIndex(item => item.key === step.key) ? 'font-medium text-blue-700 dark:text-blue-300' : ''}>{step.label}</div>
                ))}
              </div>
            </div>
          )}
          {lastSummary && !running && (
            <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-950/40">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
                <span>本地日线覆盖 {lastSummary.totalStocks}</span><span className="text-slate-400">→</span>
                <span>日线候选 {lastSummary.dailyCandidateStocks}</span><span className="text-slate-400">→</span>
                <span>分钟完整 {lastSummary.minuteCompleteStocks}</span><span className="text-slate-400">→</span>
                <span>已评估 {lastSummary.evaluatedStocks}</span><span className="text-slate-400">→</span>
                <span className="text-red-600 dark:text-red-300">命中 {lastSummary.matchedCount}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-slate-500 dark:text-slate-400">
                <span>{lastSummary.scanMode === 'complete' ? '完整扫描' : '快速扫描'} · 区间 {lastSummary.dateStart} - {lastSummary.dateEnd} · 未评估 {lastSummary.unevaluatedStocks} · 补拉尝试 {lastSummary.minuteFetchAttempted}, 成功 {lastSummary.minuteFetchSucceeded}, 失败/空 {lastSummary.minuteFetchFailed + lastSummary.minuteFetchEmpty}, 上限跳过 {lastSummary.minuteFetchSkippedByLimit}, 失败保护跳过 {lastSummary.minuteFetchSkippedByFailureGuard}</span>
                <button type="button" onClick={() => setShowScanDetails(value => !value)} className="rounded border border-slate-300 px-2 py-1 text-[11px] hover:bg-white dark:border-slate-600 dark:hover:bg-slate-800">{showScanDetails ? '收起详情' : '展开详情'}</button>
              </div>
              <div className={`mt-2 rounded px-3 py-2 text-xs ${lastSummary.minuteDataApproximate ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200'}`}>
                数据能力：{tierLabel(lastSummary.minuteUserTier ?? devUserTier)} · {lastSummary.minuteDataProviderLabel} · {lastSummary.minuteGranularity}{lastSummary.minuteDataApproximate ? '近似' : '精确'} · 精确评估 {lastSummary.minuteExactEvaluatedStocks} 只 · 近似评估 {lastSummary.minuteApproxEvaluatedStocks} 只。{lastSummary.minuteDataQualityNote}
              </div>
              {showScanDetails && (
                <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
                  <div><span className="text-slate-400">缓存命中</span><div className="mt-1 font-medium">{lastSummary.minuteCacheHitGaps}</div></div>
                  <div><span className="text-slate-400">分钟缺口</span><div className="mt-1 font-medium">{lastSummary.minuteMissingGaps}</div></div>
                  <div><span className="text-slate-400">分钟不完整</span><div className="mt-1 font-medium">{lastSummary.minuteIncompleteStocks}</div></div>
                  <div><span className="text-slate-400">未评估股票</span><div className="mt-1 font-medium">{lastSummary.unevaluatedStocks}</div></div>
                  <div><span className="text-slate-400">评估交易日</span><div className="mt-1 font-medium">{lastSummary.evaluatedTradeDays}</div></div>
                  <div><span className="text-slate-400">分钟线行数</span><div className="mt-1 font-medium">{lastSummary.minuteRows}</div></div>
                  <div><span className="text-slate-400">补拉成功</span><div className="mt-1 font-medium">{lastSummary.minuteFetchSucceeded}</div></div>
                  <div><span className="text-slate-400">补拉失败</span><div className="mt-1 font-medium">{lastSummary.minuteFetchFailed}</div></div>
                  <div><span className="text-slate-400">空数据</span><div className="mt-1 font-medium">{lastSummary.minuteFetchEmpty}</div></div>
                  <div><span className="text-slate-400">保护跳过</span><div className="mt-1 font-medium">{lastSummary.minuteFetchSkippedByFailureGuard}</div></div>
                  <div><span className="text-slate-400">失败保护</span><div className="mt-1 font-medium">{lastSummary.minuteFetchStoppedByFailureGuard ? '已触发' : '未触发'}</div></div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="min-h-0 flex flex-1 overflow-hidden">
          <section className="flex min-h-0 flex-1 flex-col p-4">
            <div className="flex min-h-0 flex-1 flex-col rounded border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
                <div>
                  <div className="text-sm font-semibold">扫描结果</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">共 {matches.length} 条命中，当前筛选显示 {filteredMatches.length} 条。</div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <input
                    type="search"
                    value={matchQuery}
                    onChange={(event) => setMatchQuery(event.target.value)}
                    placeholder="搜索代码/名称"
                    className="w-40 rounded border border-slate-300 bg-white px-2 py-1.5 text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={minScore}
                    onChange={(event) => setMinScore(event.target.value)}
                    placeholder="最低得分"
                    className="w-24 rounded border border-slate-300 bg-white px-2 py-1.5 text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                  />
                  <select
                    value={dataStatusFilter}
                    onChange={(event) => setDataStatusFilter(event.target.value)}
                    className="rounded border border-slate-300 bg-white px-2 py-1.5 text-slate-800 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                  >
                    <option value="all">全部状态</option>
                    {dataStatusOptions.map(status => <option key={status} value={status}>{status}</option>)}
                  </select>
                  {(matchQuery || minScore || dataStatusFilter !== 'all') && (
                    <button type="button" onClick={() => { setMatchQuery(''); setMinScore(''); setDataStatusFilter('all') }} className="rounded border border-slate-300 px-2 py-1.5 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800">清空筛选</button>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    <tr>
                      <th className="px-3 py-2 text-left">股票</th>
                      <th className="px-3 py-2 text-left">日期</th>
                      <th className="px-3 py-2 text-left">窗口</th>
                      <th className="px-3 py-2 text-right">得分</th>
                      <th className="px-3 py-2 text-left">状态</th>
                      <th className="px-3 py-2 text-left">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredMatches.map(match => (
                      <tr key={match.id} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-2">{match.stockName ?? match.tsCode}<div className="text-xs text-slate-400">{match.tsCode}</div></td>
                        <td className="px-3 py-2">{match.tradeDate}</td>
                        <td className="px-3 py-2">{match.windowStart ?? '--'} - {match.windowEnd ?? '--'}</td>
                        <td className={`px-3 py-2 text-right font-medium ${scoreColor(match.totalScore)}`}>{match.totalScore.toFixed(1)}</td>
                        <td className="px-3 py-2">{match.dataStatus}</td>
                        <td className="px-3 py-2"><button type="button" onClick={() => void handleEvidence(match.id)} className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800">证据</button></td>
                      </tr>
                    ))}
                    {matches.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-12 text-center text-sm text-slate-500">{scanEmptyHint(lastSummary)}</td></tr>
                    )}
                    {matches.length > 0 && filteredMatches.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-12 text-center text-sm text-slate-500">当前筛选条件下没有结果。</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="mt-4 shrink-0 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              回测联动已预留：当前命中结果可映射为 FR-211 的 BacktestSignal。真实一键回测入口将在策略回测 IPC/UI 完成后接入。
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
