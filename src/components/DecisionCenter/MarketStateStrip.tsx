interface MarketStateStripProps {
  summary: {
    totalToday: number
    unreadCount: number
    highPriorityUnreadCount: number
    watchingCount: number
    byType: Record<string, number>
    bySource?: Partial<Record<string, number>>
  } | null
}

export function MarketStateStrip({ summary }: MarketStateStripProps) {
  const typeText = summary
    ? `机会 ${summary.byType.OPPORTUNITY ?? 0} / 风险 ${summary.byType.RISK ?? 0} / 预警 ${summary.byType.ALERT ?? 0}`
    : '机会 0 / 风险 0 / 预警 0'
  const sourceText = summary?.bySource
    ? `趋势 ${summary.bySource.trend ?? 0} / 短线 ${summary.bySource.short_term ?? 0} / 资讯 ${(summary.bySource.news ?? 0) + (summary.bySource.ai ?? 0)}`
    : '趋势 0 / 短线 0 / 资讯 0'

  return (
    <div className="flex min-h-[28px] flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 dark:border-slate-700 dark:bg-slate-900">今日信号 {summary?.totalToday ?? 0}</span>
      <span className="rounded-full border border-red-200 bg-red-50 px-3 py-1 font-medium text-red-600 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">高优先级未读 {summary?.highPriorityUnreadCount ?? 0}</span>
      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 dark:border-slate-700 dark:bg-slate-900">未读 {summary?.unreadCount ?? 0}</span>
      <span className="rounded-full border border-slate-200 bg-white px-3 py-1 dark:border-slate-700 dark:bg-slate-900">关注中 {summary?.watchingCount ?? 0}</span>
      <div className="ml-auto flex flex-wrap gap-2">
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 dark:border-slate-700 dark:bg-slate-900">{typeText}</span>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 dark:border-slate-700 dark:bg-slate-900">{sourceText}</span>
      </div>
    </div>
  )
}
