import { useState } from 'react'
import type { DecisionActionItem, DecisionActionKind } from './decisionActionQueue'
import type { DecisionProgressModel } from './decisionProgressModel'
import type { DecisionSignalItem } from './SignalCard'

interface ActionQueuePanelProps {
  items: DecisionActionItem[]
  progress: DecisionProgressModel
  embedded?: boolean
  /** FR-231: 组合模式可覆盖标题与空态文案 */
  title?: string
  subtitle?: string
  emptyText?: string
  /** FR-232: 组合模式将 lifecycle 显示为「研判」 */
  judgmentMode?: boolean
  onRead: (id: number) => void
  onWatch: (id: number) => void
  onDismiss: (id: number) => void
  onLifecycle: (item: DecisionActionItem) => void
  onNavigateStock: (signal: DecisionSignalItem) => void
  onChainAnalysis: (text: string) => void
}

function priorityClass(priority: number): string {
  if (priority >= 5) return 'bg-red-600 text-white dark:bg-red-500 dark:text-white'
  if (priority >= 4) return 'bg-orange-500 text-white dark:bg-orange-500 dark:text-white'
  return 'bg-blue-50 text-blue-700 ring-1 ring-blue-100 dark:bg-blue-950/40 dark:text-blue-300 dark:ring-blue-900/60'
}

function actionLabel(action: DecisionActionKind, judgmentMode = false): string {
  return {
    read: '标记已读',
    watch: '关注',
    dismiss: '忽略',
    lifecycle: judgmentMode ? '研判' : '事件明细',
    stock: '看走势',
    chain: '产业链'
  }[action]
}

function actionClass(action: DecisionActionKind): string {
  if (action === 'stock') return 'border-slate-900 bg-slate-900 text-white shadow-sm hover:bg-slate-700 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
  if (action === 'chain') return 'border-slate-900 bg-slate-900 text-white shadow-sm hover:bg-slate-700 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white'
  if (action === 'lifecycle') return 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-950/50'
  if (action === 'watch') return 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/50'
  if (action === 'dismiss') return 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
  return 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800'
}

function taskTone(priority: number): string {
  if (priority >= 5) return 'border-red-200 bg-gradient-to-b from-white to-red-50/70 shadow-red-100/50 dark:border-red-900/60 dark:from-slate-900 dark:to-red-950/20 dark:shadow-none'
  if (priority >= 4) return 'border-amber-200 bg-gradient-to-b from-white to-amber-50/70 dark:border-amber-900/60 dark:from-slate-900 dark:to-amber-950/20'
  return 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
}

export function progressPct(progress: DecisionProgressModel): number {
  if (progress.total <= 0) return 0
  const completed = Math.max(0, progress.total - progress.pending)
  return Math.min(100, Math.round((completed / progress.total) * 100))
}

export function ActionQueuePanel({
  items,
  progress,
  embedded = false,
  title,
  subtitle,
  emptyText,
  judgmentMode = false,
  onRead,
  onWatch,
  onDismiss,
  onLifecycle,
  onNavigateStock,
  onChainAnalysis,
}: ActionQueuePanelProps) {
  const [openMenuId, setOpenMenuId] = useState<number | null>(null)

  const handleAction = (item: DecisionActionItem, action: DecisionActionKind) => {
    setOpenMenuId(null)
    const signal = item.signal
    // 合成成本缺口项 id < 0, 禁止走状态变更 API
    if (signal.id < 0 && (action === 'read' || action === 'watch' || action === 'dismiss' || action === 'lifecycle')) {
      if (signal.tsCode) onNavigateStock(signal)
      return
    }
    if (action === 'read') onRead(signal.id)
    else if (action === 'watch') onWatch(signal.id)
    else if (action === 'dismiss') onDismiss(signal.id)
    else if (action === 'lifecycle') onLifecycle(item)
    else if (action === 'stock' && signal.tsCode) onNavigateStock(signal)
    else if (action === 'chain') onChainAnalysis(`${signal.title} ${signal.summary ?? ''}`.trim())
  }

  const heading = title ?? `今日处置队列 (${items.length})`
  const sub = subtitle ?? '按风险 / 持仓 / 未读排序'
  const emptyMessage = emptyText
    ?? (progress.total === 0 ? '当前筛选条件下暂无信号。' : '待处理行动已经清空, 可以继续查看关注项或最新信号。')

  const content = (
    <>
      {!embedded && (
        <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="shrink-0 text-sm font-extrabold text-slate-900 dark:text-slate-100">{heading}</h2>
              <span className="truncate text-xs text-slate-500 dark:text-slate-400">{sub}</span>
            </div>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div data-testid="decision-action-empty" className="mt-3 rounded border border-dashed border-gray-200 px-3 py-5 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {emptyMessage}
        </div>
      ) : (
        <div className={embedded ? 'grid gap-2' : 'min-h-0 flex-1 space-y-2 overflow-y-auto p-3'}>
          {items.map((item) => {
            const signal = item.signal
            const secondaryAction = item.secondaryActions[0]
            const menuActions = item.secondaryActions.slice(secondaryAction ? 1 : 0)
            const cardTitle = item.displayTitle ?? signal.title
            const cardSummary = item.displaySummary ?? signal.summary
            return (
              <article key={`${signal.tsCode ?? 'x'}-${signal.id}`} data-testid="decision-action-item" className={`rounded-[9px] border p-3 shadow-sm ${taskTone(signal.priority)}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className={`rounded-md px-2 py-1 text-[11px] font-extrabold leading-4 ${priorityClass(signal.priority)}`}>P{signal.priority}</span>
                  <span className="shrink-0 text-[11px] text-slate-400 dark:text-slate-500">
                    {(item.sourceCount ?? 1) > 1 ? `${item.sourceCount} 源 · ` : ''}
                    {new Date(signal.signalTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <h3 className="mt-2 line-clamp-2 text-sm font-bold leading-[1.4] text-slate-950 dark:text-slate-100">{cardTitle}</h3>
                <p className="mt-1 line-clamp-2 text-xs leading-[1.55] text-slate-500 dark:text-slate-400">{cardSummary}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {item.reasons.slice(0, 3).map(reason => <span key={reason} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] leading-4 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{reason}</span>)}
                </div>
                <div data-testid="decision-trust-hint" className="mt-2 rounded-md bg-white/75 px-2 py-1.5 text-xs leading-5 text-slate-600 ring-1 ring-slate-100 dark:bg-slate-950/40 dark:text-slate-300 dark:ring-slate-800">
                  {item.trustHint}
                </div>
                {item.gaps.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {item.gaps.map(gap => <span key={gap} className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] leading-4 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">{gap}</span>)}
                  </div>
                )}
                <div className="mt-3 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleAction(item, item.primaryAction)}
                    className={`min-h-8 min-w-[72px] rounded-md border px-2.5 py-1.5 text-xs font-semibold ${actionClass(item.primaryAction)}`}
                  >
                    {actionLabel(item.primaryAction, judgmentMode)}
                  </button>
                  {secondaryAction && (
                    <button
                      type="button"
                      onClick={() => handleAction(item, secondaryAction)}
                      className={`min-h-8 min-w-[64px] rounded-md border px-2.5 py-1.5 text-xs font-medium ${actionClass(secondaryAction)}`}
                    >
                      {actionLabel(secondaryAction, judgmentMode)}
                    </button>
                  )}
                  {menuActions.length > 0 && (
                    <div className="relative ml-auto">
                      <button
                        type="button"
                        onClick={() => setOpenMenuId(openMenuId === signal.id ? null : signal.id)}
                        className="min-h-8 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800"
                        aria-expanded={openMenuId === signal.id}
                      >
                        更多
                      </button>
                      {openMenuId === signal.id && (
                        <div className="absolute bottom-full right-0 z-20 mb-1 w-24 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/30">
                          {menuActions.map((action) => (
                            <button
                              key={action}
                              type="button"
                              onClick={() => handleAction(item, action)}
                              className="block w-full px-3 py-1.5 text-left text-xs text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              {actionLabel(action, judgmentMode)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </>
  )

  if (embedded) {
    return <div data-testid="decision-action-queue">{content}</div>
  }

  return (
    <section data-testid="decision-action-queue" className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white/90 shadow-sm shadow-slate-200/70 dark:border-slate-800 dark:bg-slate-900/90 dark:shadow-none">
      {content}
    </section>
  )
}