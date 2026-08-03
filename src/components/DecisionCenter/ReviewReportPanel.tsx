import { useMemo, useState, type ReactNode } from 'react'
import type { ReviewReport } from './reviewReportModel'
import { formatReviewReportText } from './reviewReportModel'

interface ReviewReportPanelProps {
  open: boolean
  report: ReviewReport | null
  loading?: boolean
  error?: string | null
  saveState?: 'idle' | 'saving' | 'saved' | 'error'
  saveError?: string | null
  savedMeta?: { versionNumber: number; versionCount: number; savedAt: number } | null
  onRetrySave?: () => void
  onDiscuss?: () => void
  discussLabel?: string
  discussLoading?: boolean
  discussDisabledReason?: string | null
  onClose: () => void
  onNavigateStock?: (tsCode: string, stockName?: string | null) => void
}

function formatGeneratedAt(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${hh}:${mm}`
}

/**
 * FR-233/FR-236: 日/周复盘报告抽屉与快照保存反馈。
 */
export function ReviewReportPanel({
  open,
  report,
  loading = false,
  error = null,
  saveState = 'idle',
  saveError = null,
  savedMeta = null,
  onRetrySave,
  onDiscuss,
  discussLabel = '和 AI 讨论',
  discussLoading = false,
  discussDisabledReason = null,
  onClose,
  onNavigateStock,
}: ReviewReportPanelProps) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(
    () => (report ? formatReviewReportText(report) : ''),
    [report],
  )

  if (!open) return null

  const handleCopy = async () => {
    if (!report) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const badge = report?.kind === 'weekly' ? 'Weekly Review' : 'Daily Review'
  const rangeHint = report?.kind === 'weekly'
    ? `近 ${report.rangeDays} 个自然日`
    : '当日快照'

  return (
    <div className="fixed inset-0 z-[9990] flex justify-end" data-testid="review-report-panel">
      <button
        type="button"
        aria-label="关闭复盘报告"
        className="absolute inset-0 bg-slate-950/40"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-[440px] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <div className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">
              {badge}
            </div>
            <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">
              {report?.title ?? (loading ? '生成中…' : '复盘报告')}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {report
                ? `生成于 ${formatGeneratedAt(report.generatedAt)} · ${rangeHint}`
                : (loading ? '正在拉取近一周持仓相关信号…' : '暂无报告')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onDiscuss && (
              <button
                type="button"
                data-testid="review-report-discuss"
                onClick={onDiscuss}
                disabled={!report || loading || discussLoading || Boolean(discussDisabledReason)}
                title={discussDisabledReason ?? undefined}
                className="rounded-md bg-cyan-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-40"
              >{discussLoading ? '打开中…' : discussLabel}</button>
            )}
            <button
              type="button"
              onClick={() => { void handleCopy() }}
              disabled={!report || loading}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {copied ? '已复制' : '复制文本'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              关闭
            </button>
          </div>
        </header>

        <div data-testid="review-report-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              正在生成复盘报告…
            </div>
          )}
          {!loading && error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}
          {!loading && !error && report && (
            <>
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-800 dark:bg-slate-900">
            <span className={saveState === 'error'
              ? 'text-red-700 dark:text-red-300'
              : 'text-slate-600 dark:text-slate-300'}>
              {saveState === 'saving' && '正在保存到本地历史…'}
              {saveState === 'saved' && savedMeta && `已保存 · 版本 ${savedMeta.versionNumber}/${savedMeta.versionCount}`}
              {saveState === 'error' && `保存失败: ${saveError || '未知错误'}`}
              {saveState === 'idle' && '等待保存'}
            </span>
            {saveState === 'error' && onRetrySave && (
              <button
                type="button"
                onClick={onRetrySave}
                className="shrink-0 font-semibold text-red-700 hover:underline dark:text-red-300"
              >
                重试保存
              </button>
            )}
          </div>
          <p className="rounded-lg border border-cyan-100 bg-cyan-50/80 px-3 py-2 text-sm leading-6 text-cyan-950 dark:border-cyan-900/50 dark:bg-cyan-950/30 dark:text-cyan-100">
            {report.headline}
          </p>

          <section className="mt-4">
            <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">摘要</h3>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <SummaryCell label="持仓" value={report.summary.holdingCount} />
              <SummaryCell label="相关信号" value={report.summary.portfolioSignalCount} />
              <SummaryCell label="已处理" value={report.summary.processedCount} />
              <SummaryCell label="未处理风险" value={report.summary.openRiskCount} tone="red" />
              <SummaryCell label="证据缺口" value={report.summary.evidenceGapCount} tone="amber" />
              <SummaryCell label="待验证" value={report.summary.followUpCount} tone="blue" />
            </div>
          </section>

          <ReportSection
            title="已处理"
            empty="暂无已结案/已忽略的持仓相关处理记录"
            count={report.processed.length}
          >
            {report.processed.map((item) => (
              <ReportRow
                key={`p-${item.signalId}`}
                title={`${item.stockName} · ${item.tagLabel}`}
                body={`${item.title}${item.note && item.note !== '无备注' ? ` · ${item.note}` : ''}`}
                onClick={item.tsCode ? () => onNavigateStock?.(item.tsCode!, item.stockName) : undefined}
              />
            ))}
          </ReportSection>

          <ReportSection
            title="未处理风险"
            empty="当前无开放持仓风险"
            count={report.openRisks.length}
          >
            {report.openRisks.map((item) => (
              <ReportRow
                key={`r-${item.signalId}`}
                title={`${item.stockName} · P${item.priority}`}
                body={`${item.title} · ${item.status}`}
                tone="red"
                onClick={item.tsCode ? () => onNavigateStock?.(item.tsCode!, item.stockName) : undefined}
              />
            ))}
          </ReportSection>

          <ReportSection
            title="证据缺口"
            empty="暂无成本等证据缺口"
            count={report.evidenceGaps.length}
          >
            {report.evidenceGaps.map((item) => (
              <ReportRow
                key={`g-${item.tsCode}`}
                title={item.stockName}
                body={item.reason}
                tone="amber"
                onClick={() => onNavigateStock?.(item.tsCode, item.stockName)}
              />
            ))}
          </ReportSection>

          <ReportSection
            title="待验证清单"
            empty="暂无信息不足/继续观察类回访点"
            count={report.followUps.length}
          >
            {report.followUps.map((item) => (
              <ReportRow
                key={`f-${item.signalId}`}
                title={`${item.stockName} · ${item.tagLabel}`}
                body={`${item.title}${item.note ? ` · ${item.note}` : ''}`}
                tone="blue"
                onClick={item.tsCode ? () => onNavigateStock?.(item.tsCode!, item.stockName) : undefined}
              />
            ))}
          </ReportSection>

          <p className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            {report.disclaimer}
          </p>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function SummaryCell({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: number
  tone?: 'slate' | 'red' | 'amber' | 'blue'
}) {
  const valueClass = {
    slate: 'text-slate-900 dark:text-slate-100',
    red: 'text-red-600 dark:text-red-300',
    amber: 'text-amber-700 dark:text-amber-300',
    blue: 'text-blue-700 dark:text-blue-300',
  }[tone]
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-0.5 text-lg font-extrabold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}

function ReportSection({
  title,
  empty,
  count,
  children,
}: {
  title: string
  empty: string
  count: number
  children: ReactNode
}) {
  return (
    <section className="mt-5">
      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h3>
      <div className="mt-2 space-y-2">
        {count === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            {empty}
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

function ReportRow({
  title,
  body,
  tone = 'slate',
  onClick,
}: {
  title: string
  body: string
  tone?: 'slate' | 'red' | 'amber' | 'blue'
  onClick?: () => void
}) {
  const borderClass = {
    slate: 'border-slate-200 dark:border-slate-800',
    red: 'border-red-200 dark:border-red-900/50',
    amber: 'border-amber-200 dark:border-amber-900/50',
    blue: 'border-blue-200 dark:border-blue-900/50',
  }[tone]
  const className = `w-full rounded-lg border ${borderClass} bg-white px-3 py-2 text-left dark:bg-slate-950/60 ${onClick ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900' : ''}`
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</div>
        <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{body}</div>
      </button>
    )
  }
  return (
    <div className={className}>
      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</div>
      <div className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{body}</div>
    </div>
  )
}
