import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { BriefingCard } from '../BriefingCard/BriefingCard'
import IndustryAnalysisDrawer from '../IndustryChain/IndustryAnalysisDrawer'
import type { Briefing } from '../../../electron/main/database/types'

function briefingPriority(briefing: Briefing): number {
  const impactBase = briefing.impactRating === 'CRITICAL' ? 300 : briefing.impactRating === 'IMPORTANT' ? 200 : 100
  const unreadBoost = briefing.isRead ? 0 : 50
  return impactBase + unreadBoost + briefing.impactRatingScore
}

export function BriefingFeed() {
  const {
    briefings,
    totalCount,
    isLoadingBriefings,
    selectedBriefingId,
    selectedDate,
    selectedSourceId,
    publicationTimeScope,
    briefingSourceStats,
    currentPage,
    selectBriefing,
    setFilter,
    goToPage,
    markAllRead
  } = useAppStore()

  const [chainText, setChainText] = useState<string>('')
  const [showChain, setShowChain] = useState(false)

  const totalPages = Math.ceil(totalCount / 100)
  const sortedBriefings = useMemo(
    () => briefings.slice().sort((a, b) => briefingPriority(b) - briefingPriority(a) || b.publishedAt - a.publishedAt),
    [briefings]
  )
  const highImpactCount = briefings.filter(briefing => briefing.impactRating !== 'GENERAL').length
  const queueUnreadCount = briefings.filter(briefing => !briefing.isRead).length
  const sourceCount = new Set(briefings.map(briefing => briefing.sourceName)).size
  const selectedSource = briefingSourceStats.find(source => source.sourceId === selectedSourceId) ?? null

  useEffect(() => {
    if (sortedBriefings.length === 0) return
    if (selectedBriefingId && sortedBriefings.some(briefing => briefing.id === selectedBriefingId)) return
    selectBriefing(sortedBriefings[0].id)
  }, [selectBriefing, selectedBriefingId, sortedBriefings])

  return (
    <>
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Feed header */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-slate-100 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900/80">
        <span data-testid="briefing-feed-total" className="text-xs font-medium text-slate-500 dark:text-slate-400">共 {totalCount} 条</span>
        {selectedDate && (
          <span data-testid="briefing-feed-active-date" className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-200">
            日期 · {selectedDate}
          </span>
        )}
        <span className="ml-2 rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 dark:bg-red-400/10 dark:text-red-200">{highImpactCount} 高影响</span>
        <span className="rounded bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-200">{queueUnreadCount} 待读</span>
        {selectedSource ? (
          <button
            type="button"
            data-testid="briefing-feed-active-source"
            onClick={() => setFilter({ selectedSourceId: null })}
            aria-label={`清除来源筛选：${selectedSource.sourceName}`}
            className="flex min-w-0 max-w-44 items-center gap-1 rounded bg-cyan-50 px-2 py-0.5 text-xs font-semibold text-cyan-800 transition-colors hover:bg-cyan-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:bg-cyan-400/15 dark:text-cyan-100 dark:hover:bg-cyan-400/25"
          >
            <span className="truncate">来源 · {selectedSource.sourceName}</span>
            <span className="shrink-0 text-[11px] font-medium opacity-75">清除</span>
          </button>
        ) : (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300">{sourceCount} 来源</span>
        )}
        {publicationTimeScope !== 'all' && (
          <span
            data-testid="briefing-feed-time-scope"
            className={[
              'rounded px-2 py-0.5 text-xs font-semibold',
              publicationTimeScope === 'confirmed'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-200'
                : 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200',
            ].join(' ')}
          >
            {publicationTimeScope === 'confirmed' ? '发布时间已确认' : '发布时间待校时'}
          </span>
        )}
        {totalPages > 1 && (
          <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
            第 {currentPage} / {totalPages} 页
          </span>
        )}
        <button
          onClick={() => markAllRead()}
          className="ml-auto rounded px-2 py-1 text-xs font-medium text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          全部标为已读
        </button>
      </div>

      {/* Briefing list */}
      <div data-testid="briefing-feed-list" className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 px-2.5 py-2.5 dark:bg-slate-950/20">
        {isLoadingBriefings && (
          <div className="py-4 text-center text-xs text-slate-400 dark:text-slate-500">加载中…</div>
        )}

        {!isLoadingBriefings && briefings.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-xs text-slate-400 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-500">当前条件下暂无资讯</div>
        )}

        {!isLoadingBriefings && sortedBriefings.length > 0 && (
          <div className="space-y-1.5">
            {sortedBriefings.map((briefing) => (
              <div
                key={briefing.id}
                style={{ contentVisibility: 'auto', containIntrinsicSize: '0 86px' }}
              >
                <BriefingCard
                  briefing={briefing}
                  isSelected={briefing.id === selectedBriefingId}
                  onClick={() => selectBriefing(briefing.id)}
                  onChainClick={text => { setChainText(text); setShowChain(true) }}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-3 py-2 border-t border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-900 shrink-0">
          <button
            onClick={() => goToPage(1)}
            disabled={currentPage <= 1}
            className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
          >
            «
          </button>
          <button
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
          >
            ‹
          </button>

          {/* Page number buttons (show up to 5 around current) */}
          {buildPageRange(currentPage, totalPages).map((p) =>
            p === -1 ? (
              <span key={`ellipsis-${Math.random()}`} className="text-xs text-gray-400 dark:text-gray-500">
                …
              </span>
            ) : (
              <button
                key={p}
                onClick={() => goToPage(p)}
                className={[
                  'text-xs px-2 py-1 rounded border transition-colors',
                  p === currentPage
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800'
                ].join(' ')}
              >
                {p}
              </button>
            )
          )}

          <button
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
          >
            ›
          </button>
          <button
            onClick={() => goToPage(totalPages)}
            disabled={currentPage >= totalPages}
            className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
          >
            »
          </button>
        </div>
      )}
    </div>
    <IndustryAnalysisDrawer
      open={showChain}
      text={chainText}
      onClose={() => setShowChain(false)}
    />
    </>
  )
}

function buildPageRange(current: number, total: number): number[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)
  const pages: number[] = []
  pages.push(1)
  if (current > 3) pages.push(-1)
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) {
    pages.push(p)
  }
  if (current < total - 2) pages.push(-1)
  pages.push(total)
  return pages
}
