import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { DecisionSignalItem } from './SignalCard'

type DecisionSignalResolution =
  | 'RESOLVED_VALID'
  | 'RESOLVED_INVALID'
  | 'RESOLVED_MISSED'
  | 'RESOLVED_DUPLICATE'
  | 'RESOLVED_DATA_ISSUE'
  | 'RESOLVED_MANUAL'

type DecisionSignalEventType =
  | 'CREATED'
  | 'UPDATED'
  | 'READ'
  | 'WATCHED'
  | 'DISMISSED'
  | 'EXPIRED'
  | 'RESOLVED'
  | 'REOPENED'
  | 'NOTE_ADDED'

interface DecisionSignalEventItem {
  id: number
  signalId: number
  eventType: DecisionSignalEventType
  fromStatus: string | null
  toStatus: string | null
  resolution: DecisionSignalResolution | null
  reason: string | null
  note: string | null
  createdAt: number
}

interface SignalLifecycleDrawerProps {
  signal: DecisionSignalItem | null
  open: boolean
  onClose: () => void
  onUpdated: (signal?: DecisionSignalItem) => void
  onDiscuss?: (signal: DecisionSignalItem) => void
}

const RESOLUTION_OPTIONS: Array<{ value: DecisionSignalResolution; label: string }> = [
  { value: 'RESOLVED_VALID', label: '有效, 已处理' },
  { value: 'RESOLVED_INVALID', label: '无效信号' },
  { value: 'RESOLVED_MISSED', label: '错过窗口' },
  { value: 'RESOLVED_DUPLICATE', label: '重复/噪音' },
  { value: 'RESOLVED_DATA_ISSUE', label: '数据问题' },
  { value: 'RESOLVED_MANUAL', label: '人工关闭' },
]

const EVENT_LABEL: Record<DecisionSignalEventType, string> = {
  CREATED: '创建',
  UPDATED: '再次触发',
  READ: '已读',
  WATCHED: '关注',
  DISMISSED: '忽略',
  EXPIRED: '过期',
  RESOLVED: '处置',
  REOPENED: '重新打开',
  NOTE_ADDED: '添加备注',
}

function formatTime(ms: number | null): string {
  if (!ms) return '--'
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function resolutionLabel(value: DecisionSignalResolution | null): string {
  return RESOLUTION_OPTIONS.find(option => option.value === value)?.label ?? '未处置'
}

export function SignalLifecycleDrawer({ signal, open, onClose, onUpdated, onDiscuss }: SignalLifecycleDrawerProps) {
  const [events, setEvents] = useState<DecisionSignalEventItem[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resolution, setResolution] = useState<DecisionSignalResolution>('RESOLVED_VALID')
  const [note, setNote] = useState('')
  const [dismissReason, setDismissReason] = useState('')

  const canRender = open && signal != null
  const currentResolution = signal?.resolution ?? null

  useEffect(() => {
    if (!canRender || !signal) return
    setResolution(signal.resolution ?? 'RESOLVED_VALID')
    setNote(signal.resolutionNote ?? '')
    setDismissReason('')
    setLoading(true)
    setError(null)
    window.api.decision.getTimeline(signal.id)
      .then((res) => {
        if (!res.ok) throw new Error(res.message || res.error || '加载生命周期失败')
        setEvents(res.data ?? [])
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [canRender, signal])

  const summaryRows = useMemo(() => {
    if (!signal) return []
    return [
      ['首次出现', formatTime(signal.firstSeenAt ?? signal.signalTime)],
      ['最近触发', formatTime(signal.lastSeenAt ?? signal.signalTime)],
      ['触发次数', `${signal.occurrenceCount ?? 1}`],
      ['当前状态', signal.status],
      ['处置结果', resolutionLabel(currentResolution)],
    ]
  }, [currentResolution, signal])

  if (!canRender || !signal) return null

  const handleResolve = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.decision.resolve(signal.id, resolution, note.trim() || undefined)
      if (!res.ok) throw new Error(res.message || res.error || '保存处置结果失败')
      onUpdated(res.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleDismiss = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await window.api.decision.dismiss(signal.id, dismissReason.trim() || '人工忽略', note.trim() || undefined)
      if (!res.ok) throw new Error(res.message || res.error || '忽略信号失败')
      onUpdated(res.data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex justify-end bg-black/30" onClick={onClose}>
      <div
        data-testid="signal-lifecycle-scroll"
        className="h-full w-full max-w-xl overflow-y-auto border-l border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">事件明细</h2>
              <p className="mt-1 truncate text-sm text-gray-500 dark:text-gray-400">{signal.title}</p>
              <p className="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">单信号事件流水, 不是研判总结</p>
            </div>
            <div className="flex shrink-0 gap-2">
              {onDiscuss && <button type="button" data-testid="signal-detail-discuss" onClick={() => onDiscuss(signal)} className="rounded border border-cyan-200 px-2.5 py-1 text-sm font-medium text-cyan-700 hover:bg-cyan-50 dark:border-cyan-800 dark:text-cyan-300">讨论此信号</button>}
              <button onClick={onClose} className="rounded border border-gray-200 px-2 py-1 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">关闭</button>
            </div>
          </div>
        </div>

        <div className="space-y-4 p-4">
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          <section className="rounded border border-gray-200 p-3 dark:border-gray-700">
            <div className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">信号摘要</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {summaryRows.map(([label, value]) => (
                <div key={label} className="rounded bg-gray-50 px-2 py-1 dark:bg-gray-950/40">
                  <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
                  <div className="mt-0.5 text-gray-900 dark:text-gray-100">{value}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded border border-gray-200 p-3 dark:border-gray-700">
            <div className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">处置结果</div>
            <div className="space-y-2">
              <select
                value={resolution}
                onChange={(e) => setResolution(e.target.value as DecisionSignalResolution)}
                className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              >
                {RESOLUTION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="记录处置依据、复盘备注或后续观察点"
                rows={3}
                className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void handleResolve()}
                  disabled={saving}
                  className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
                >保存处置</button>
                <input
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  placeholder="忽略原因"
                  className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
                />
                <button
                  onClick={() => void handleDismiss()}
                  disabled={saving}
                  className="rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >忽略</button>
              </div>
            </div>
          </section>

          <section className="rounded border border-gray-200 p-3 dark:border-gray-700">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">事件时间线</div>
              {loading && <span className="text-xs text-gray-500 dark:text-gray-400">加载中</span>}
            </div>
            {events.length === 0 && !loading ? (
              <div className="rounded border border-dashed border-gray-200 px-3 py-5 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                暂无事件
              </div>
            ) : (
              <div className="space-y-2">
                {(() => {
                  // FR-232: 再次触发折叠为 ×N, 避免刷屏
                  const updated = events.filter((event) => event.eventType === 'UPDATED')
                  const others = events.filter((event) => event.eventType !== 'UPDATED')
                  const nodes: ReactNode[] = []
                  if (updated.length > 0) {
                    const first = updated[0]!
                    const last = updated[updated.length - 1]!
                    nodes.push(
                      <div key="updated-fold" className="rounded bg-gray-50 px-3 py-2 text-sm dark:bg-gray-950/40">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-gray-900 dark:text-gray-100">再次触发 ×{updated.length}</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{formatTime(last.createdAt)}</span>
                        </div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                          首次 {formatTime(first.createdAt)} · 最近 {formatTime(last.createdAt)}
                        </div>
                      </div>,
                    )
                  }
                  for (const event of others) {
                    nodes.push(
                      <div key={event.id} className="rounded bg-gray-50 px-3 py-2 text-sm dark:bg-gray-950/40">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium text-gray-900 dark:text-gray-100">{EVENT_LABEL[event.eventType]}</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{formatTime(event.createdAt)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                          {event.fromStatus && event.toStatus && <span>{event.fromStatus} → {event.toStatus}</span>}
                          {event.resolution && <span>{resolutionLabel(event.resolution)}</span>}
                          {event.reason && <span>原因: {event.reason}</span>}
                        </div>
                        {event.note && <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">{event.note}</div>}
                      </div>,
                    )
                  }
                  return nodes
                })()}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
