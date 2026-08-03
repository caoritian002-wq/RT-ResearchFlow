import { useEffect, useState, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import MermaidBlock from '../MermaidBlock/MermaidBlock'
import { useAppStore } from '../../store/appStore'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts'

interface ForecastPoint {
  time: string
  price: number
}

interface ForecastRecord {
  id: number
  stockCode: string
  type: 'today' | 'morrow'
  points: string
  aiReason: string | null
  provider: string
  model: string | null
  createdAt: string
  targetDate?: string | null
  backtestDirection?: number | null
  backtestCloseDeviation?: number | null
  backtestMAPE?: number | null
  backtestPearson?: number | null
  backtestAt?: number | null
  // FR-163f: 结构化 AI 输出
  direction?: string | null
  confidence?: number | null
  keySupport?: number | null
  keyResistance?: number | null
  // FR-174: 用户反馈再次预测链路
  parentForecastId?: number | null
  userFeedback?: string | null
  // FR-188: 预测准确率增强闭环
  inputSnapshot?: string | null
  errorAnalysis?: string | null
  userOutcomeTag?: 'valid' | 'invalid' | 'uncertain' | null
  userOutcomeNote?: string | null
  userOutcomeUpdatedAt?: number | null
}

interface ForecastDetail extends Omit<ForecastRecord, 'points'> {
  points: ForecastPoint[]
}

interface ForecastPanelProps {
  stockCode: string
  stockName: string
  isOpen: boolean
  onClose: () => void
}

function formatCreatedAt(iso: string): string {
  try {
    const d = new Date(iso)
    const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
    const mm = String(bj.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(bj.getUTCDate()).padStart(2, '0')
    const hh = String(bj.getUTCHours()).padStart(2, '0')
    const mi = String(bj.getUTCMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${mi}`
  } catch {
    return iso
  }
}

const TYPE_LABEL: Record<string, string> = { today: '今日', morrow: '明日' }
const CHART_COLORS = ['#f97316', '#8b5cf6', '#06b6d4', '#22c55e', '#ef4444', '#ec4899', '#14b8a6', '#eab308', '#6366f1', '#f43f5e']

function ymdFromBjDate(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function inferTargetDate(record: Pick<ForecastRecord, 'type' | 'createdAt' | 'targetDate'>): string {
  if (record.targetDate) return record.targetDate
  const created = new Date(record.createdAt)
  const target = new Date(created.getTime() + 8 * 60 * 60 * 1000)
  if (record.type === 'morrow') {
    target.setUTCDate(target.getUTCDate() + 1)
    const day = target.getUTCDay()
    if (day === 6) target.setUTCDate(target.getUTCDate() + 2)
    if (day === 0) target.setUTCDate(target.getUTCDate() + 1)
  }
  return ymdFromBjDate(target)
}

function formatTargetDate(ymd: string): string {
  if (!/^\d{8}$/.test(ymd)) return ymd
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

function groupTypeLabel(records: ForecastRecord[]): string {
  const types = new Set(records.map(item => item.type))
  if (types.size === 1) return `${TYPE_LABEL[records[0]?.type] ?? '预测'}预测`
  return '预测记录'
}

function recordLabel(r: ForecastRecord): string {
  const model = r.model ? `/${r.model}` : ''
  return `[${TYPE_LABEL[r.type] ?? r.type}] ${r.provider}${model} ${formatCreatedAt(r.createdAt)}`
}

type InputSnapshot = {
  dataLabel?: string | null
  dataPointCount?: number | null
  dailyPointCount?: number | null
  contextChars?: number | null
  promptChars?: number | null
  forecastPointCount?: number | null
  userFeedback?: string | null
  parentForecastId?: number | null
}

type ErrorAnalysis = {
  tags?: string[]
  summary?: string
  metrics?: Record<string, number>
}

function parseJsonSafe<T>(value?: string | null): T | null {
  if (!value) return null
  try { return JSON.parse(value) as T } catch { return null }
}

const ERROR_TAG_LABELS: Record<string, string> = {
  DIRECTION_MISMATCH: '方向错判',
  CLOSE_DEVIATION_HIGH: '收盘偏差高',
  MAPE_HIGH: '整体误差高',
  SHAPE_MISMATCH: '形态不匹配',
  VOLATILITY_UNDERESTIMATED: '波动低估',
  VOLATILITY_OVERESTIMATED: '波动高估',
  AFTERNOON_REVERSAL_MISSED: '午后反转漏判',
}

const OUTCOME_LABELS: Record<string, string> = {
  valid: '有效样本',
  invalid: '无效样本',
  uncertain: '待复盘',
}

// T328: Backtest accuracy badge
function BacktestBadge({ record }: { record: ForecastRecord }) {
  if (record.backtestAt == null) {
    return <span className="text-[9px] px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 shrink-0">待回测</span>
  }
  const mape = record.backtestMAPE ?? 0
  const ok = mape < 5
  return (
    <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${ok ? 'bg-green-50 dark:bg-green-900/30 text-green-600' : 'bg-red-50 dark:bg-red-900/30 text-red-500'}`}>
      {record.backtestDirection === 1 ? '✓' : '✗'} {mape.toFixed(1)}%
    </span>
  )
}

// FR-163f: AI 方向徽章
function DirectionBadge({ record }: { record: ForecastRecord }) {
  if (!record.direction) return null
  const map: Record<string, { label: string; cls: string }> = {
    up: { label: '↑ 看涨', cls: 'bg-red-50 dark:bg-red-900/30 text-red-500' },
    down: { label: '↓ 看跌', cls: 'bg-green-50 dark:bg-green-900/30 text-green-600' },
    flat: { label: '→ 震荡', cls: 'bg-gray-100 dark:bg-gray-700 text-gray-500' },
  }
  const info = map[record.direction] ?? { label: record.direction, cls: 'bg-gray-100 dark:bg-gray-700 text-gray-400' }
  const conf = record.confidence != null ? ` ${(record.confidence > 1 ? record.confidence : record.confidence * 100).toFixed(0)}%` : ''
  return (
    <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 font-medium ${info.cls}`}>
      {info.label}{conf}
    </span>
  )
}

export function ForecastPanel({ stockCode, stockName, isOpen, onClose }: ForecastPanelProps) {
  const [records, setRecords] = useState<ForecastRecord[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [details, setDetails] = useState<Map<number, ForecastDetail>>(new Map())
  const [loading, setLoading] = useState(false)
  const [maxComparison, setMaxComparison] = useState(5)
  const [maxError, setMaxError] = useState('')
  // Track open/closed state for each collapse panel (key = record id)
  const [openPanels, setOpenPanels] = useState<Set<number>>(new Set())
  // T328: Actual intraday data cache for backtested records
  const [intradayCache, setIntradayCache] = useState<Map<string, { time: string; price: number }[]>>(new Map())
  // T329: Stats tab
  const [activeTab, setActiveTab] = useState<'chart' | 'stats'>('chart')
  const [stats, setStats] = useState<{ provider: string; model: string; avgDirection: number; avgCloseDeviation: number; avgMAPE: number; avgPearson: number; count: number }[]>([])
  const [statsStockFilter, setStatsStockFilter] = useState<string>('')
  const [statsTypeFilter, setStatsTypeFilter] = useState<'all' | 'today' | 'morrow'>('all')
  const [statsPortfolioOnly, setStatsPortfolioOnly] = useState(false)
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<number, string>>({})
  const [revisionLoading, setRevisionLoading] = useState<Record<number, boolean>>({})
  const [revisionErrors, setRevisionErrors] = useState<Record<number, string>>({})
  const [outcomeDrafts, setOutcomeDrafts] = useState<Record<number, { tag: 'valid' | 'invalid' | 'uncertain' | ''; note: string }>>({})
  const [outcomeSaving, setOutcomeSaving] = useState<Record<number, boolean>>({})
  const [outcomeMessages, setOutcomeMessages] = useState<Record<number, string>>({})
  const [expandedTargetDates, setExpandedTargetDates] = useState<Set<string>>(new Set())

  const groupedRecords = useMemo(() => {
    const groupMap = new Map<string, ForecastRecord[]>()
    for (const record of records) {
      const targetDate = inferTargetDate(record)
      const list = groupMap.get(targetDate) ?? []
      list.push(record)
      groupMap.set(targetDate, list)
    }
    return Array.from(groupMap.entries())
      .map(([targetDate, groupRecords]) => ({
        targetDate,
        records: groupRecords.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      }))
      .sort((a, b) => b.targetDate.localeCompare(a.targetDate))
  }, [records])

  // T284/T285: Load forecast list + config when panel opens
  const reloadList = useCallback(async () => {
    if (!isOpen) return
    setLoading(true)
    setMaxError('')
    try {
      const config = await window.api.ai.getConfig() as { maxForecastComparison?: number }
      setMaxComparison(config.maxForecastComparison ?? 5)

      const list = await window.api.ai.listForecasts(stockCode) as ForecastRecord[]
      setRecords(list)
      if (list.length > 0) {
        setSelectedIds(new Set([list[0].id]))
        setOpenPanels(new Set([list[0].id]))
        setExpandedTargetDates(new Set([inferTargetDate(list[0])]))
      } else {
        setSelectedIds(new Set())
        setDetails(new Map())
        setOpenPanels(new Set())
        setExpandedTargetDates(new Set())
      }
    } catch {
      setRecords([])
      setSelectedIds(new Set())
      setDetails(new Map())
      setOpenPanels(new Set())
      setExpandedTargetDates(new Set())
    }
    setLoading(false)
  }, [isOpen, stockCode])

  useEffect(() => { reloadList() }, [reloadList])

  // Load details for selected IDs
  useEffect(() => {
    if (selectedIds.size === 0) { setDetails(new Map()); return }
    const idsToLoad = [...selectedIds].filter(id => !details.has(id))
    if (idsToLoad.length === 0) {
      setDetails(prev => {
        const next = new Map<number, ForecastDetail>()
        for (const [id, d] of prev) {
          if (selectedIds.has(id)) next.set(id, d)
        }
        return next
      })
      return
    }
    Promise.all(
      idsToLoad.map(id =>
        window.api.ai.getForecast(id).then(data => {
          const d = data as ForecastDetail & { error?: { message: string } }
          if (d.error) return null
          return d
        }).catch(() => null)
      )
    ).then(results => {
      setDetails(prev => {
        const next = new Map(prev)
        for (const d of results) {
          if (d) next.set(d.id, d)
        }
        for (const id of next.keys()) {
          if (!selectedIds.has(id)) next.delete(id)
        }
        return next
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds])

  // T328: Load actual intraday data for backtested selected records
  useEffect(() => {
    const backtested = [...selectedIds]
      .map(id => records.find(r => r.id === id))
      .filter((r): r is ForecastRecord => r != null && r.backtestAt != null)

    if (backtested.length === 0) return

    for (const r of backtested) {
      const targetDate = inferTargetDate(r)
      const cacheKey = `${r.stockCode}:${targetDate}`
      if (intradayCache.has(cacheKey)) continue

      window.api.backtest.getIntradayCache(r.stockCode, targetDate).then((data: unknown) => {
        if (!data) return
        const row = data as { points: string }
        try {
          const pts = JSON.parse(row.points) as { time: string; price: number }[]
          setIntradayCache(prev => new Map(prev).set(cacheKey, pts))
        } catch { /* ignore */ }
      }).catch(() => { /* ignore */ })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, records])

  // T329: Load stats when stats tab is active
  useEffect(() => {
    if (activeTab !== 'stats') return
    window.api.backtest.getStats({
      stockCode: statsStockFilter || undefined,
      type: statsTypeFilter,
      portfolioOnly: statsPortfolioOnly,
    }).then((data: unknown) => {
      setStats(data as typeof stats)
    }).catch(() => setStats([]))
  }, [activeTab, statsStockFilter, statsTypeFilter, statsPortfolioOnly])

  // T285: Toggle select with max comparison guard
  const handleToggleSelect = useCallback((id: number) => {
    setMaxError('')
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        if (next.size >= maxComparison) {
          setMaxError(`已达最大对比数 (${maxComparison})`)
          return prev
        }
        next.add(id)
      }
      return next
    })
    // Auto-open collapse panel when selected
    setOpenPanels(prev => {
      const next = new Set(prev)
      if (!next.has(id)) next.add(id)
      else next.delete(id)
      return next
    })
  }, [maxComparison])

  // T286: Delete single record
  const handleDelete = useCallback(async (id: number) => {
    await window.api.ai.deleteForecast(id)
    const updated = records.filter((r) => r.id !== id)
    setRecords(updated)
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      if (next.size === 0 && updated.length > 0) {
        next.add(updated[0].id)
        setExpandedTargetDates(prevDates => new Set(prevDates).add(inferTargetDate(updated[0])))
      }
      return next
    })
    setOpenPanels(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [records])

  // T286: Delete all records
  const handleDeleteAll = useCallback(async () => {
    await window.api.ai.deleteAllForecasts(stockCode)
    setRecords([])
    setSelectedIds(new Set())
    setDetails(new Map())
    setOpenPanels(new Set())
    setExpandedTargetDates(new Set())
  }, [stockCode])

  const handleReviseForecast = useCallback(async (record: ForecastDetail) => {
    const feedback = (feedbackDrafts[record.id] ?? '').trim()
    if (!feedback) {
      setRevisionErrors(prev => ({ ...prev, [record.id]: '请先输入补充信息' }))
      return
    }
    setRevisionLoading(prev => ({ ...prev, [record.id]: true }))
    setRevisionErrors(prev => ({ ...prev, [record.id]: '' }))
    try {
      const response = await window.api.ai.reviseTrendForecast({
        forecastId: record.id,
        stockCode,
        userFeedback: feedback,
      }) as { ok: boolean; forecasts?: ForecastDetail[]; message?: string; error?: { message?: string } }
      if (!response.ok || !response.forecasts || response.forecasts.length === 0) {
        setRevisionErrors(prev => ({ ...prev, [record.id]: response.message ?? response.error?.message ?? '再次预测失败' }))
        return
      }
      const newIds = response.forecasts.map(item => item.id)
      setFeedbackDrafts(prev => ({ ...prev, [record.id]: '' }))
      await reloadList()
      setSelectedIds(new Set(newIds))
      setOpenPanels(new Set(newIds))
      setDetails(new Map(response.forecasts.map(item => [item.id, item])))
    } catch (err) {
      setRevisionErrors(prev => ({ ...prev, [record.id]: err instanceof Error ? err.message : '再次预测失败' }))
    } finally {
      setRevisionLoading(prev => ({ ...prev, [record.id]: false }))
    }
  }, [feedbackDrafts, reloadList, stockCode])

  const handleSaveOutcome = useCallback(async (record: ForecastDetail) => {
    const draft = outcomeDrafts[record.id] ?? {
      tag: record.userOutcomeTag ?? '',
      note: record.userOutcomeNote ?? '',
    }
    setOutcomeSaving(prev => ({ ...prev, [record.id]: true }))
    setOutcomeMessages(prev => ({ ...prev, [record.id]: '' }))
    try {
      const response = await window.api.backtest.updateForecastOutcome({
        forecastId: record.id,
        tag: draft.tag || null,
        note: draft.note || null,
      }) as { ok: boolean; error?: { message?: string } }
      if (!response.ok) {
        setOutcomeMessages(prev => ({ ...prev, [record.id]: response.error?.message ?? '保存失败' }))
        return
      }
      const nextTag = draft.tag || null
      const nextNote = draft.note.trim() || null
      setRecords(prev => prev.map(item => item.id === record.id ? { ...item, userOutcomeTag: nextTag, userOutcomeNote: nextNote, userOutcomeUpdatedAt: Date.now() } : item))
      setDetails(prev => {
        const next = new Map(prev)
        const current = next.get(record.id)
        if (current) next.set(record.id, { ...current, userOutcomeTag: nextTag, userOutcomeNote: nextNote, userOutcomeUpdatedAt: Date.now() })
        return next
      })
      setOutcomeMessages(prev => ({ ...prev, [record.id]: '已保存' }))
    } catch (err) {
      setOutcomeMessages(prev => ({ ...prev, [record.id]: err instanceof Error ? err.message : '保存失败' }))
    } finally {
      setOutcomeSaving(prev => ({ ...prev, [record.id]: false }))
    }
  }, [outcomeDrafts])

  if (!isOpen) return null

  // T287: Build multi-line chart data
  const selectedDetails = [...selectedIds]
    .map(id => details.get(id))
    .filter((d): d is ForecastDetail => d != null)

  // T328: Build actual intraday maps for backtested records
  const actualMaps = new Map<number, Map<string, number>>()
  for (const d of selectedDetails) {
    const rec = records.find(r => r.id === d.id)
    if (!rec || rec.backtestAt == null) continue
    const targetDate = inferTargetDate(rec)
    const cached = intradayCache.get(`${rec.stockCode}:${targetDate}`)
    if (cached) {
      const prefix = rec.type === 'morrow' ? '明日' : ''
      actualMaps.set(d.id, new Map(cached.map(p => [`${prefix}${p.time}`, p.price])))
    }
  }

  const allTimesSet = new Set<string>()
  for (const d of selectedDetails) {
    const prefix = d.type === 'morrow' ? '明日' : ''
    for (const p of d.points) {
      allTimesSet.add(`${prefix}${p.time}`)
    }
    // T328: add actual intraday times
    const am = actualMaps.get(d.id)
    if (am) for (const t of am.keys()) allTimesSet.add(t)
  }
  const allTimes = Array.from(allTimesSet).sort((a, b) => {
    const aM = a.startsWith('明日'); const bM = b.startsWith('明日')
    if (aM !== bM) return aM ? 1 : -1
    return a.localeCompare(b)
  })

  const detailMaps = selectedDetails.map(d => {
    const prefix = d.type === 'morrow' ? '明日' : ''
    return new Map(d.points.map(p => [`${prefix}${p.time}`, p.price]))
  })

  const chartData = allTimes.map(t => {
    const row: Record<string, unknown> = { time: t }
    selectedDetails.forEach((d, i) => {
      row[`line_${d.id}`] = detailMaps[i].get(t) ?? null
      // T328: actual data
      const am = actualMaps.get(d.id)
      if (am) row[`actual_${d.id}`] = am.get(t) ?? null
    })
    return row
  })

  const hasChartData = chartData.length > 0
  const hasRecords = records.length > 0
  const hasSelection = selectedIds.size > 0

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* FR-174: 右侧抽屉，保留原预测面板内部能力 */}
      <div className="absolute right-0 top-0 bottom-0 bg-white dark:bg-gray-900 shadow-2xl w-[min(92vw,1180px)] flex flex-col overflow-hidden animate-[slideInFromRight_180ms_ease-out]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-900 dark:text-gray-100">{stockName}</span>
            <span className="text-sm text-gray-400 dark:text-gray-500">{stockCode}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">预测记录</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500 transition-colors text-xl leading-none"
            title="关闭"
          >
            ×
          </button>
        </div>

        {/* T284: Left-right body */}
        <div className="flex flex-row flex-1 min-h-0">

          {/* T285/T286: Left panel — 25% width, prediction list */}
          <div className="w-1/4 flex flex-col border-r border-gray-100 dark:border-gray-700 min-h-0">
            {/* List area */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">加载中…</div>
              ) : !hasRecords ? (
                // T289: Empty state
                <div className="flex flex-col items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500 text-center gap-2 px-4">
                  <span className="text-2xl">📊</span>
                  <span>暂无预测记录</span>
                  <span className="text-xs">请先点击「预测走势」发起预测</span>
                </div>
              ) : (
                groupedRecords.map((group) => {
                  const expanded = expandedTargetDates.has(group.targetDate)
                  return (
                    <div key={group.targetDate} className="border-b border-gray-100 dark:border-gray-700 last:border-b-0">
                      <button
                        type="button"
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/80 hover:bg-gray-100 dark:hover:bg-gray-800 text-xs transition-colors"
                        onClick={() => {
                          setExpandedTargetDates(prev => {
                            const next = new Set(prev)
                            if (next.has(group.targetDate)) next.delete(group.targetDate)
                            else next.add(group.targetDate)
                            return next
                          })
                        }}
                      >
                        <span className="font-medium text-gray-700 dark:text-gray-200 truncate">
                          {formatTargetDate(group.targetDate)} {groupTypeLabel(group.records)}
                        </span>
                        <span className="flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500 shrink-0">
                          <span>{group.records.length} 条</span>
                          <span>{expanded ? '⌃' : '⌄'}</span>
                        </span>
                      </button>
                      {expanded && group.records.map((r) => {
                        const checked = selectedIds.has(r.id)
                        const colorIdx = [...selectedIds].indexOf(r.id)
                        const color = checked && colorIdx >= 0 ? CHART_COLORS[colorIdx % CHART_COLORS.length] : undefined
                        return (
                          <div
                            key={r.id}
                            className="group flex items-center gap-2 px-3 py-2 text-xs cursor-pointer select-none hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors border-t border-gray-50 dark:border-gray-700"
                            onClick={() => handleToggleSelect(r.id)}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleToggleSelect(r.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="rounded shrink-0 cursor-pointer"
                            />
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: color ?? '#d1d5db' }}
                            />
                            <span className="truncate flex-1" style={{ color: color ?? '#6b7280' }}>
                              {recordLabel(r)}
                            </span>
                            {r.parentForecastId != null && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-500 shrink-0">修正</span>
                            )}
                            <BacktestBadge record={r} />
                            <DirectionBadge record={r} />
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDelete(r.id) }}
                              className="text-gray-300 hover:text-red-400 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="删除"
                            >
                              ✕
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )
                })
              )}
            </div>

            {/* T286: Bottom actions */}
            {hasRecords && (
              <div className="shrink-0 px-3 py-2 border-t border-gray-100 dark:border-gray-700 flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-400 dark:text-gray-500">{records.length} 条 / 已选 {selectedIds.size}</span>
                <button
                  onClick={handleDeleteAll}
                  className="text-[10px] px-2 py-1 rounded border border-red-200 dark:border-red-700 text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 dark:bg-red-900/30 transition-colors"
                  title="删除全部记录"
                >
                  全部删除
                </button>
              </div>
            )}

            {/* T285: Max comparison error */}
            {maxError && (
              <div className="shrink-0 px-3 py-1 border-t border-orange-50">
                <p className="text-[10px] text-orange-500">{maxError}</p>
              </div>
            )}
          </div>

          {/* T287/T288/T329: Right panel — 75% width, chart + reasons + stats */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* T329: Tab switcher */}
            <div className="shrink-0 flex border-b border-gray-100 dark:border-gray-700 px-4">
              <button
                className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${activeTab === 'chart' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500'}`}
                onClick={() => setActiveTab('chart')}
              >
                图表
              </button>
              <button
                className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${activeTab === 'stats' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500'}`}
                onClick={() => setActiveTab('stats')}
              >
                统计
              </button>
            </div>

            {activeTab === 'stats' ? (
              /* T329: Stats tab */
              <div className="flex-1 overflow-y-auto p-4">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <label className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500">股票筛选：</label>
                  <select
                    className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                    value={statsStockFilter}
                    onChange={(e) => setStatsStockFilter(e.target.value)}
                  >
                    <option value="">全部</option>
                    <option value={stockCode}>{stockCode}</option>
                  </select>
                  <label className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 ml-2">类型：</label>
                  <select
                    className="text-xs border border-gray-200 dark:border-gray-700 rounded px-2 py-1"
                    value={statsTypeFilter}
                    onChange={(e) => setStatsTypeFilter(e.target.value as typeof statsTypeFilter)}
                  >
                    <option value="all">全部</option>
                    <option value="today">今日预测</option>
                    <option value="morrow">明日预测</option>
                  </select>
                  <label className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 ml-2">
                    <input
                      type="checkbox"
                      checked={statsPortfolioOnly}
                      onChange={(e) => setStatsPortfolioOnly(e.target.checked)}
                    />
                    仅持仓
                  </label>
                </div>
                {stats.length === 0 ? (
                  <div className="text-sm text-gray-400 dark:text-gray-500 text-center py-8">暂无回测统计数据</div>
                ) : (
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 dark:text-gray-500">
                        <th className="text-left px-3 py-2 font-medium">厂商</th>
                        <th className="text-left px-3 py-2 font-medium">模型</th>
                        <th className="text-right px-3 py-2 font-medium">方向准确率</th>
                        <th className="text-right px-3 py-2 font-medium">平均MAPE</th>
                        <th className="text-right px-3 py-2 font-medium">平均Pearson r</th>
                        <th className="text-right px-3 py-2 font-medium">条数</th>
                        <th className="text-left px-3 py-2 font-medium">可信度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((s, i) => (
                        <tr key={i} className="border-t border-gray-50 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800">
                          <td className="px-3 py-2">{s.provider}</td>
                          <td className="px-3 py-2">{s.model}</td>
                          <td className="px-3 py-2 text-right">{(s.avgDirection * 100).toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right">{s.avgMAPE.toFixed(2)}%</td>
                          <td className="px-3 py-2 text-right">{s.avgPearson.toFixed(4)}</td>
                          <td className="px-3 py-2 text-right">{s.count}</td>
                          <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                            {s.count < 5 ? '样本偏少' : s.count < 20 ? '可参考' : '较稳定'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : !hasSelection && !loading ? (
              // T289: No selection state
              <div className="flex flex-col items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500 text-center gap-2">
                <span className="text-2xl">←</span>
                <span>{hasRecords ? '请在左侧选择预测记录' : '暂无预测数据'}</span>
              </div>
            ) : (
              <>
                {/* T287: Chart area — top 50% */}
                <div className="h-1/2 p-4 border-b border-gray-50 dark:border-gray-700">
                  {loading ? (
                    <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">加载中…</div>
                  ) : !hasChartData ? (
                    <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500">正在加载预测数据…</div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={chartData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 10 }}
                          interval={Math.max(1, Math.floor(chartData.length / 10))}
                          tickLine={false}
                        />
                        <YAxis
                          domain={['auto', 'auto']}
                          tick={{ fontSize: 10 }}
                          width={52}
                          tickFormatter={(v: number) => v.toFixed(2)}
                        />
                        <Tooltip
                          formatter={((value: number, name: string) => [value?.toFixed(2), name]) as never}
                          labelStyle={{ fontSize: 11 }}
                          contentStyle={{ fontSize: 11 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        {selectedDetails.map((d, i) => {
                          const label = `[${TYPE_LABEL[d.type] ?? d.type}] ${d.provider}${d.model ? `/${d.model}` : ''}`
                          const hasActual = actualMaps.has(d.id)
                          return [
                            <Line
                              key={d.id}
                              type="monotone"
                              dataKey={`line_${d.id}`}
                              name={label}
                              stroke={CHART_COLORS[i % CHART_COLORS.length]}
                              strokeWidth={2}
                              strokeDasharray={d.type === 'morrow' ? '4 2' : undefined}
                              dot={false}
                              connectNulls={true}
                            />,
                            // T328: actual intraday overlay (blue solid line)
                            hasActual ? (
                              <Line
                                key={`actual_${d.id}`}
                                type="monotone"
                                dataKey={`actual_${d.id}`}
                                name={`${label} 实际`}
                                stroke="#3b82f6"
                                strokeWidth={1.5}
                                dot={false}
                                connectNulls={true}
                              />
                            ) : null
                          ]
                        })}
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {/* T288: AI reasoning collapse panels — bottom 50% */}
                <div className="h-1/2 overflow-y-auto p-4">
                  {selectedDetails.length === 0 ? null : (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 dark:text-gray-500 mb-2">AI 预测理由</p>
                      {selectedDetails.map((d, i) => {
                        const title = `[${TYPE_LABEL[d.type] ?? d.type}] ${d.provider}${d.model ? `/${d.model}` : ''} ${formatCreatedAt(d.createdAt)}`
                        const isOpenPanel = openPanels.has(d.id)
                        const rec = records.find(r => r.id === d.id)
                        const inputSnapshot = parseJsonSafe<InputSnapshot>(rec?.inputSnapshot ?? d.inputSnapshot)
                        const errorAnalysis = parseJsonSafe<ErrorAnalysis>(rec?.errorAnalysis ?? d.errorAnalysis)
                        const outcomeDraft = outcomeDrafts[d.id] ?? {
                          tag: (rec?.userOutcomeTag ?? d.userOutcomeTag ?? '') as 'valid' | 'invalid' | 'uncertain' | '',
                          note: rec?.userOutcomeNote ?? d.userOutcomeNote ?? '',
                        }
                        return (
                          <div key={d.id} className="border border-gray-100 dark:border-gray-700 rounded overflow-hidden">
                            <button
                              type="button"
                              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 text-xs font-medium text-gray-600 dark:text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 dark:bg-gray-700 transition-colors flex items-center gap-2 text-left"
                              onClick={() => setOpenPanels(prev => {
                                const next = new Set(prev)
                                if (next.has(d.id)) next.delete(d.id)
                                else next.add(d.id)
                                return next
                              })}
                            >
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                              />
                              <span className="flex-1 truncate">{title}</span>
                              <span className="text-gray-400 dark:text-gray-500 shrink-0">{isOpenPanel ? '▲' : '▼'}</span>
                            </button>
                            {isOpenPanel && (
                              <div className="px-3 py-2">
                                {/* FR-163f: 方向/置信度/支撑阻力摘要 */}
                                {(rec?.direction || rec?.keySupport != null || rec?.keyResistance != null) && (
                                  <div className="flex flex-wrap gap-2 mb-2 text-[10px]">
                                    {rec?.direction && (() => {
                                      const dirMap: Record<string, { label: string; cls: string }> = {
                                        up: { label: '↑ 看涨', cls: 'text-red-500' },
                                        down: { label: '↓ 看跌', cls: 'text-green-600' },
                                        flat: { label: '→ 震荡', cls: 'text-gray-500' },
                                      }
                                      const info = dirMap[rec.direction] ?? { label: rec.direction, cls: 'text-gray-400' }
                                      const conf = rec.confidence != null ? `，置信度 ${(rec.confidence > 1 ? rec.confidence : rec.confidence * 100).toFixed(0)}%` : ''
                                      return <span className={`font-semibold ${info.cls}`}>{info.label}{conf}</span>
                                    })()}
                                    {rec?.keySupport != null && (
                                      <span className="text-green-600">支撑：{rec.keySupport.toFixed(2)}</span>
                                    )}
                                    {rec?.keyResistance != null && (
                                      <span className="text-red-500">阻力：{rec.keyResistance.toFixed(2)}</span>
                                    )}
                                  </div>
                                )}
                                <div className="prose prose-sm max-w-none text-gray-700 dark:text-gray-300">
                                  {d.aiReason ? (
                                    <ReactMarkdown
                                      remarkPlugins={[remarkGfm]}
                                      rehypePlugins={[rehypeRaw]}
                                      components={{
                                        code({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
                                          if (className?.includes('language-mermaid')) {
                                            return <MermaidBlock code={String(children).replace(/\n$/, '')} />
                                          }
                                          return <code className={className} {...props}>{children}</code>
                                        },
                                        a({ href, children, ...props }: React.ComponentPropsWithoutRef<'a'>) {
                                          if (href?.startsWith('#stock:')) {
                                            const code = href.replace('#stock:', '')
                                            return (
                                              <span
                                                className="text-blue-600 dark:text-blue-400 underline cursor-pointer hover:text-blue-800 dark:hover:text-blue-300"
                                                onClick={() => useAppStore.getState().navigateToStock(code)}
                                              >
                                                {children}
                                              </span>
                                            )
                                          }
                                          return <a href={href} {...props}>{children}</a>
                                        }
                                      }}
                                    >
                                      {d.aiReason}
                                    </ReactMarkdown>
                                  ) : (
                                    <span className="text-gray-400 dark:text-gray-500 text-xs">暂无 AI 理由</span>
                                  )}
                                </div>
                                {d.userFeedback && (
                                  <div className="mt-2 rounded border border-indigo-100 dark:border-indigo-800 bg-indigo-50/60 dark:bg-indigo-900/20 px-2 py-1.5 text-xs text-indigo-700 dark:text-indigo-300">
                                    <span className="font-medium">用户补充：</span>{d.userFeedback}
                                  </div>
                                )}
                                {/* T328: Backtest summary card */}
                                {rec?.backtestAt != null && (
                                  <div className="mt-2 p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-100 dark:border-gray-700 grid grid-cols-4 gap-2 text-[10px]">
                                    <div className="text-center">
                                      <div className="text-gray-400 dark:text-gray-500">方向</div>
                                      <div className={rec.backtestDirection === 1 ? 'text-green-600 font-bold' : 'text-red-500 font-bold'}>
                                        {rec.backtestDirection === 1 ? '✓ 正确' : '✗ 错误'}
                                      </div>
                                    </div>
                                    <div className="text-center">
                                      <div className="text-gray-400 dark:text-gray-500">收盘偏差</div>
                                      <div className="font-medium">{(rec.backtestCloseDeviation ?? 0).toFixed(2)}%</div>
                                    </div>
                                    <div className="text-center">
                                      <div className="text-gray-400 dark:text-gray-500">MAPE</div>
                                      <div className="font-medium">{(rec.backtestMAPE ?? 0).toFixed(2)}%</div>
                                    </div>
                                    <div className="text-center">
                                      <div className="text-gray-400 dark:text-gray-500">Pearson r</div>
                                      <div className="font-medium">{(rec.backtestPearson ?? 0).toFixed(4)}</div>
                                    </div>
                                  </div>
                                )}
                                {(errorAnalysis || inputSnapshot) && (
                                  <div className="mt-2 rounded border border-amber-100 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-900/20 px-2 py-2 text-[10px] text-amber-800 dark:text-amber-200 space-y-1.5">
                                    {errorAnalysis && (
                                      <div>
                                        <div className="font-medium mb-1">误差归因</div>
                                        <div className="flex flex-wrap gap-1 mb-1">
                                          {(errorAnalysis.tags ?? []).length > 0 ? (errorAnalysis.tags ?? []).map(tag => (
                                            <span key={tag} className="rounded bg-white/70 dark:bg-gray-800 px-1.5 py-0.5 text-amber-700 dark:text-amber-200 border border-amber-100 dark:border-amber-800">
                                              {ERROR_TAG_LABELS[tag] ?? tag}
                                            </span>
                                          )) : <span className="text-amber-600 dark:text-amber-300">暂无显著误差标签</span>}
                                        </div>
                                        {errorAnalysis.summary && <div className="text-amber-700 dark:text-amber-200">{errorAnalysis.summary}</div>}
                                      </div>
                                    )}
                                    {inputSnapshot && (
                                      <div className="border-t border-amber-100 dark:border-amber-800 pt-1.5">
                                        <div className="font-medium mb-1">输入快照</div>
                                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-amber-700 dark:text-amber-200">
                                          <span>数据：{inputSnapshot.dataLabel ?? '未记录'}</span>
                                          <span>分时点：{inputSnapshot.dataPointCount ?? '—'}</span>
                                          <span>日线点：{inputSnapshot.dailyPointCount ?? '—'}</span>
                                          <span>上下文：{inputSnapshot.contextChars ?? 0} 字符</span>
                                          <span>Prompt：{inputSnapshot.promptChars ?? 0} 字符</span>
                                          <span>预测点：{inputSnapshot.forecastPointCount ?? d.points.length}</span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                                <div className="mt-2 rounded border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-2 py-2 text-xs">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">样本标签</span>
                                    {(rec?.userOutcomeTag ?? d.userOutcomeTag) && (
                                      <span className="text-[10px] rounded bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 text-blue-600 dark:text-blue-300">
                                        {OUTCOME_LABELS[(rec?.userOutcomeTag ?? d.userOutcomeTag) as string] ?? rec?.userOutcomeTag ?? d.userOutcomeTag}
                                      </span>
                                    )}
                                  </div>
                                  <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-start">
                                    <select
                                      value={outcomeDraft.tag}
                                      onChange={(event) => {
                                        setOutcomeDrafts(prev => ({ ...prev, [d.id]: { ...outcomeDraft, tag: event.target.value as typeof outcomeDraft.tag } }))
                                        setOutcomeMessages(prev => ({ ...prev, [d.id]: '' }))
                                      }}
                                      className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200"
                                    >
                                      <option value="">未标注</option>
                                      <option value="valid">有效样本</option>
                                      <option value="invalid">无效样本</option>
                                      <option value="uncertain">待复盘</option>
                                    </select>
                                    <textarea
                                      value={outcomeDraft.note}
                                      onChange={(event) => {
                                        setOutcomeDrafts(prev => ({ ...prev, [d.id]: { ...outcomeDraft, note: event.target.value } }))
                                        setOutcomeMessages(prev => ({ ...prev, [d.id]: '' }))
                                      }}
                                      rows={2}
                                      className="resize-none rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200"
                                      placeholder="记录这条预测为何有效或无效"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => handleSaveOutcome(d)}
                                      disabled={outcomeSaving[d.id]}
                                      className="rounded border border-gray-300 dark:border-gray-600 px-2 py-1.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-700 disabled:opacity-50"
                                    >
                                      {outcomeSaving[d.id] ? '保存中' : '保存'}
                                    </button>
                                  </div>
                                  {outcomeMessages[d.id] && <div className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">{outcomeMessages[d.id]}</div>}
                                </div>
                                <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3">
                                  <label className="block text-[10px] text-gray-400 dark:text-gray-500 mb-1">补充信息后再次预测</label>
                                  <textarea
                                    value={feedbackDrafts[d.id] ?? ''}
                                    onChange={(e) => {
                                      setFeedbackDrafts(prev => ({ ...prev, [d.id]: e.target.value }))
                                      setRevisionErrors(prev => ({ ...prev, [d.id]: '' }))
                                    }}
                                    rows={2}
                                    className="w-full resize-none rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1.5 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
                                    placeholder="例如：刚刚放量跌破均线，请重新评估尾盘走势。"
                                  />
                                  <div className="mt-2 flex items-center justify-between gap-2">
                                    <span className="text-[10px] text-red-400 min-h-[14px]">{revisionErrors[d.id] ?? ''}</span>
                                    <button
                                      type="button"
                                      onClick={() => handleReviseForecast(d)}
                                      disabled={revisionLoading[d.id] || !(feedbackDrafts[d.id] ?? '').trim()}
                                      className="text-xs px-2.5 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                    >
                                      {revisionLoading[d.id] ? '预测中…' : '再次预测'}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}