import { useCallback, useEffect, useState } from 'react'
import type { ReviewReport, ReviewReportKind } from './reviewReportModel'
import { AppConfirmDialog } from '../shared/AppConfirmDialog'

export interface SavedReviewReportSummaryItem {
  id: string
  kind: ReviewReportKind
  periodStart: string
  periodEnd: string
  rangeDays: number
  generatedAt: number
  savedAt: number
  schemaVersion: number
  title: string
  headline: string
  openRiskCount: number
  evidenceGapCount: number
  followUpCount: number
  versionNumber: number
  versionCount: number
}

interface ReviewReportHistoryPanelProps {
  open: boolean
  refreshToken?: number
  onClose: () => void
  onOpenReport: (report: ReviewReport, summary: SavedReviewReportSummaryItem) => void
  onGenerateDaily?: () => void
  onDiscuss?: (summary: SavedReviewReportSummaryItem) => void
}

const PAGE_SIZE = 12

function formatSavedAt(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms))
}

export function ReviewReportHistoryPanel({
  open,
  refreshToken = 0,
  onClose,
  onOpenReport,
  onGenerateDaily,
  onDiscuss,
}: ReviewReportHistoryPanelProps) {
  const [kind, setKind] = useState<'all' | ReviewReportKind>('all')
  const [items, setItems] = useState<SavedReviewReportSummaryItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedPeriod, setSelectedPeriod] = useState<SavedReviewReportSummaryItem | null>(null)
  const [versions, setVersions] = useState<SavedReviewReportSummaryItem[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<SavedReviewReportSummaryItem | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const loadList = useCallback(async (nextOffset: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.api.decision.listReviewReports({
        kind: kind === 'all' ? undefined : kind,
        offset: nextOffset,
        limit: PAGE_SIZE,
      })
      if (!res.ok || !res.data) throw new Error(res.message || res.error || '加载历史复盘失败')
      setItems(res.data.items as SavedReviewReportSummaryItem[])
      setTotal(res.data.total)
      setOffset(res.data.offset)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [kind])

  const loadVersions = useCallback(async (period: SavedReviewReportSummaryItem) => {
    setSelectedPeriod(period)
    setVersionsLoading(true)
    setError(null)
    try {
      const res = await window.api.decision.listReviewReports({
        kind: period.kind,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        includeAllVersions: true,
        limit: 100,
      })
      if (!res.ok || !res.data) throw new Error(res.message || res.error || '加载报告版本失败')
      setVersions(res.data.items as SavedReviewReportSummaryItem[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setSelectedPeriod(null)
    setOffset(0)
    void loadList(0)
  }, [kind, loadList, open, refreshToken])

  const openReport = async (summary: SavedReviewReportSummaryItem) => {
    setOpeningId(summary.id)
    setError(null)
    try {
      const res = await window.api.decision.getReviewReport(summary.id)
      if (!res.ok || !res.data) throw new Error(res.message || res.error || '打开历史复盘失败')
      onOpenReport(res.data.snapshot as ReviewReport, res.data as SavedReviewReportSummaryItem)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpeningId(null)
    }
  }

  const deleteVersion = async (summary: SavedReviewReportSummaryItem) => {
    setDeletingId(summary.id)
    setDeleteError(null)
    try {
      const res = await window.api.decision.deleteReviewReport(summary.id)
      if (!res.ok) throw new Error(res.message || res.error || '删除历史复盘失败')
      if (selectedPeriod) {
        await loadVersions(selectedPeriod)
        if (versions.length <= 1) setSelectedPeriod(null)
      }
      await loadList(offset)
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeletingId(null)
    }
  }

  if (!open) return null

  const visibleItems = selectedPeriod ? versions : items
  const canPrevious = !selectedPeriod && offset > 0
  const canNext = !selectedPeriod && offset + PAGE_SIZE < total

  return (
    <div className="fixed inset-0 z-[9980] flex justify-end" data-testid="review-report-history-panel">
      <button type="button" aria-label="关闭历史复盘" className="absolute inset-0 bg-slate-950/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-[480px] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">Review Archive</div>
              <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
                {selectedPeriod ? `${selectedPeriod.periodStart} 至 ${selectedPeriod.periodEnd}` : '历史复盘'}
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {selectedPeriod ? `${selectedPeriod.versionCount} 个不可变版本` : `共 ${total} 个报告周期`}
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900">关闭</button>
          </div>
          {!selectedPeriod && (
            <div className="mt-3 inline-flex rounded-md border border-slate-200 p-0.5 dark:border-slate-700">
              {(['all', 'daily', 'weekly'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  className={`rounded px-3 py-1 text-xs ${kind === value ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 dark:text-slate-400'}`}
                >
                  {value === 'all' ? '全部' : value === 'daily' ? '日报' : '周报'}
                </button>
              ))}
            </div>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {selectedPeriod && (
            <button type="button" onClick={() => setSelectedPeriod(null)} className="mb-3 text-xs font-semibold text-cyan-700 hover:underline dark:text-cyan-300">返回报告周期</button>
          )}
          {error && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
          {(loading || versionsLoading) && <div className="py-8 text-center text-sm text-slate-500">正在加载历史复盘…</div>}
          {!loading && !versionsLoading && visibleItems.length === 0 && (
            <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center dark:border-slate-700">
              <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">暂无已保存复盘</p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">生成日报或周报后会自动保存到这里。</p>
              {onGenerateDaily && !selectedPeriod && (
                <button type="button" onClick={onGenerateDaily} className="mt-3 rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-800">生成今日复盘</button>
              )}
            </div>
          )}
          {!loading && !versionsLoading && visibleItems.length > 0 && (
            <div className="space-y-2">
              {visibleItems.map((item) => (
                <article key={item.id} data-testid={`review-report-history-item-${item.id}`} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span>{item.kind === 'daily' ? '日报' : '周报'}</span>
                        <span>{item.periodStart === item.periodEnd ? item.periodStart : `${item.periodStart} 至 ${item.periodEnd}`}</span>
                        <span>v{item.versionNumber}/{item.versionCount}</span>
                      </div>
                      <h3 className="mt-1 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{item.title}</h3>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{item.headline}</p>
                      <p className="mt-1 text-[11px] text-slate-400">保存于 {formatSavedAt(item.savedAt)} · 风险 {item.openRiskCount} · 缺口 {item.evidenceGapCount}</p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <button type="button" data-testid={`review-report-open-${item.id}`} disabled={openingId === item.id} onClick={() => { void openReport(item) }} className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">{openingId === item.id ? '打开中' : '打开'}</button>
                      {onDiscuss && <button type="button" data-testid={`review-report-discuss-${item.id}`} onClick={() => onDiscuss(item)} className="rounded-md border border-cyan-200 px-2.5 py-1 text-xs text-cyan-700 dark:border-cyan-800 dark:text-cyan-300">讨论</button>}
                      {!selectedPeriod && <button type="button" data-testid={`review-report-versions-${item.id}`} onClick={() => { void loadVersions(item) }} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">管理版本</button>}
                      {selectedPeriod && <button type="button" data-testid={`review-report-delete-${item.id}`} disabled={deletingId === item.id} onClick={() => { setDeleteError(null); setDeleteTarget(item) }} className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 disabled:opacity-50 dark:border-red-900/60 dark:text-red-300">删除</button>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        {!selectedPeriod && total > PAGE_SIZE && (
          <footer className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            <span>{offset + 1}-{Math.min(offset + PAGE_SIZE, total)} / {total}</span>
            <div className="flex gap-2">
              <button type="button" disabled={!canPrevious || loading} onClick={() => { void loadList(Math.max(0, offset - PAGE_SIZE)) }} className="rounded-md border border-slate-200 px-2.5 py-1 disabled:opacity-40 dark:border-slate-700">上一页</button>
              <button type="button" disabled={!canNext || loading} onClick={() => { void loadList(offset + PAGE_SIZE) }} className="rounded-md border border-slate-200 px-2.5 py-1 disabled:opacity-40 dark:border-slate-700">下一页</button>
            </div>
          </footer>
        )}
      </aside>
      <AppConfirmDialog
        open={deleteTarget != null}
        title="删除复盘报告版本"
        message="这个不可变版本及其快照将被永久删除，同一周期的其他版本不受影响。"
        tone="danger"
        confirmLabel="删除版本"
        busy={deletingId != null}
        error={deleteError}
        testId="review-report-delete-dialog"
        onCancel={() => {
          setDeleteTarget(null)
          setDeleteError(null)
        }}
        onConfirm={() => { if (deleteTarget) void deleteVersion(deleteTarget) }}
      >
        {deleteTarget && (
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-slate-500 dark:text-slate-400">报告</dt>
            <dd className="min-w-0 truncate font-medium text-slate-900 dark:text-slate-100">{deleteTarget.title}</dd>
            <dt className="text-slate-500 dark:text-slate-400">周期</dt>
            <dd className="font-mono tabular-nums text-slate-700 dark:text-slate-200">{deleteTarget.periodStart === deleteTarget.periodEnd ? deleteTarget.periodStart : `${deleteTarget.periodStart} 至 ${deleteTarget.periodEnd}`}</dd>
            <dt className="text-slate-500 dark:text-slate-400">版本</dt>
            <dd className="font-mono tabular-nums text-slate-700 dark:text-slate-200">v{deleteTarget.versionNumber} / {deleteTarget.versionCount}</dd>
          </dl>
        )}
      </AppConfirmDialog>
    </div>
  )
}
