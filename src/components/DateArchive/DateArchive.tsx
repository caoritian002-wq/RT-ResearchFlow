import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import type { Briefing, DailyArchiveRow } from '../../../electron/main/database/types'

interface YearNode {
  year: string
  totalCount: number
  unreadCount: number
  criticalCount: number
  uncertainTimeCount: number
  months: MonthNode[]
}

interface MonthNode {
  yearMonth: string // YYYY-MM
  month: string    // MM
  totalCount: number
  unreadCount: number
  criticalCount: number
  uncertainTimeCount: number
  days: DailyArchiveRow[]
}

type ArchiveSideTab = 'sources' | 'archive'

function buildTree(archiveDates: DailyArchiveRow[]): YearNode[] {
  const yearMap = new Map<string, Map<string, DailyArchiveRow[]>>()

  for (const row of archiveDates) {
    const [year, month] = row.date.split('-')
    if (!yearMap.has(year)) yearMap.set(year, new Map())
    const monthMap = yearMap.get(year)!
    const ym = `${year}-${month}`
    if (!monthMap.has(ym)) monthMap.set(ym, [])
    monthMap.get(ym)!.push(row)
  }

  const years: YearNode[] = []
  for (const [year, monthMap] of yearMap) {
    const months: MonthNode[] = []
    for (const [ym, days] of monthMap) {
      months.push({
        yearMonth: ym,
        month: ym.split('-')[1],
        totalCount: days.reduce((s, d) => s + d.totalCount, 0),
        unreadCount: days.reduce((s, d) => s + d.unreadCount, 0),
        criticalCount: days.reduce((s, d) => s + d.criticalCount, 0),
        uncertainTimeCount: days.reduce((s, d) => s + d.uncertainTimeCount, 0),
        days
      })
    }
    months.sort((a, b) => b.yearMonth.localeCompare(a.yearMonth))
    years.push({
      year,
      totalCount: months.reduce((s, m) => s + m.totalCount, 0),
      unreadCount: months.reduce((s, m) => s + m.unreadCount, 0),
      criticalCount: months.reduce((s, m) => s + m.criticalCount, 0),
      uncertainTimeCount: months.reduce((s, m) => s + m.uncertainTimeCount, 0),
      months
    })
  }
  years.sort((a, b) => b.year.localeCompare(a.year))
  return years
}

function briefingPriority(briefing: Briefing): number {
  const impactBase = briefing.impactRating === 'CRITICAL' ? 300 : briefing.impactRating === 'IMPORTANT' ? 200 : 100
  const unreadBoost = briefing.isRead ? 0 : 50
  return impactBase + unreadBoost + briefing.impactRatingScore
}

function impactText(briefing: Briefing): string {
  if (briefing.impactRating === 'CRITICAL') return '重大'
  if (briefing.impactRating === 'IMPORTANT') return '重要'
  return '一般'
}

function timeText(ms: number): string {
  const date = new Date(ms)
  const bj = new Date(date.getTime() + 8 * 60 * 60_000)
  return `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`
}

export function DateArchive() {
  const {
    archiveDates,
    briefings,
    briefingSourceStats,
    selectedBriefingId,
    selectedDate,
    selectedSourceId,
    publicationTimeScope,
    setFilter,
    selectBriefing
  } = useAppStore()
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set())
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set())
  const [activePanelTab, setActivePanelTab] = useState<ArchiveSideTab>('sources')

  const tree = buildTree(archiveDates)
  const selectedItemClass = 'bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-100 font-medium'
  const highImpactBriefings = briefings
    .filter(briefing => briefing.impactRating !== 'GENERAL')
    .slice()
    .sort((a, b) => briefingPriority(b) - briefingPriority(a) || b.publishedAt - a.publishedAt)
    .slice(0, 3)
  const sourceStats = briefingSourceStats
  const allSourceTotal = sourceStats.reduce((sum, source) => sum + source.total, 0)
  const uncertainTotal = archiveDates.reduce((sum, row) => sum + row.uncertainTimeCount, 0)

  function showSources() {
    setActivePanelTab('sources')
    setFilter({ selectedDate: null, publicationTimeScope: 'all' })
  }

  function showArchive() {
    setActivePanelTab('archive')
    setFilter({ selectedSourceId: null, publicationTimeScope: 'confirmed' })
  }

  function selectArchiveDate(date: string | null) {
    setFilter({ selectedDate: date, selectedSourceId: null })
  }

  function toggleYear(year: string) {
    setExpandedYears((prev) => {
      const next = new Set(prev)
      if (next.has(year)) next.delete(year)
      else next.add(year)
      return next
    })
  }

  function toggleMonth(ym: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev)
      if (next.has(ym)) next.delete(ym)
      else next.add(ym)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-slate-900">
      <div className="shrink-0 border-b border-slate-100 px-3 py-3 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">今日重点</h2>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">按影响排序</span>
        </div>
        <div className="mt-2.5 space-y-2">
          {highImpactBriefings.length > 0 ? (
            highImpactBriefings.map(briefing => {
              const isSelected = selectedBriefingId === briefing.id
              return (
                <button
                  key={briefing.id}
                  type="button"
                  onClick={() => selectBriefing(briefing.id)}
                  className={[
                    'w-full rounded-md border p-2.5 text-left transition-colors',
                    isSelected
                      ? 'border-cyan-300 bg-cyan-50 dark:border-cyan-400/40 dark:bg-cyan-400/10'
                      : 'border-slate-200 bg-slate-50 hover:border-red-200 hover:bg-red-50/70 dark:border-slate-800 dark:bg-slate-950/35 dark:hover:border-red-400/30 dark:hover:bg-red-500/10'
                  ].join(' ')}
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-white px-2 py-0.5 text-[11px] font-semibold text-red-600 shadow-sm dark:bg-red-950/50 dark:text-red-200">{impactText(briefing)}</span>
                    {!briefing.isRead && <span className="rounded bg-cyan-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">未读</span>}
                    <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">{timeText(briefing.publishedAt)}</span>
                  </div>
                  <div className="mt-2 line-clamp-2 text-xs font-semibold leading-snug text-slate-800 dark:text-slate-100">{briefing.title}</div>
                  <div className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400">{briefing.sourceName}</div>
                </button>
              )
            })
          ) : (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
              <div className="text-xs font-semibold text-slate-600 dark:text-slate-300">暂无高影响待处理</div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">当前队列没有重大或重要资讯, 可继续从来源和日期归档回看。</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 py-3">
        <div className="flex shrink-0 items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">{activePanelTab === 'sources' ? '来源分组' : '时间归档'}</div>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">{activePanelTab === 'sources' ? `${sourceStats.length} 组` : `${briefings.length} 条`}</span>
        </div>

        <div className="mt-2 flex shrink-0 rounded-md bg-slate-100 p-1 dark:bg-slate-950/60">
          <button
            type="button"
            data-testid="briefing-side-tab-sources"
            onClick={showSources}
            className={[
              'flex-1 rounded px-2 py-1.5 text-xs font-semibold transition-colors',
              activePanelTab === 'sources'
                ? 'bg-white text-slate-950 shadow-sm dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            ].join(' ')}
          >
            来源分组
          </button>
          <button
            type="button"
            data-testid="briefing-side-tab-archive"
            onClick={showArchive}
            className={[
              'flex-1 rounded px-2 py-1.5 text-xs font-semibold transition-colors',
              activePanelTab === 'archive'
                ? 'bg-white text-slate-950 shadow-sm dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            ].join(' ')}
          >
            时间归档
          </button>
        </div>

        {activePanelTab === 'sources' ? (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {sourceStats.length > 0 ? (
              <div className="space-y-1.5">
                <button
                  type="button"
                  data-testid="briefing-source-filter-all"
                  aria-pressed={selectedSourceId === null}
                  onClick={() => setFilter({ selectedSourceId: null })}
                  className={[
                    'flex min-h-11 w-full items-center rounded-md border px-3 py-2 text-left text-xs transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900',
                    selectedSourceId === null
                      ? 'border-cyan-300 bg-cyan-50 font-semibold text-cyan-900 dark:border-cyan-400/45 dark:bg-cyan-400/10 dark:text-cyan-100'
                      : 'border-slate-100 bg-white text-slate-600 hover:border-cyan-200 hover:bg-cyan-50/60 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-300 dark:hover:border-cyan-400/30 dark:hover:bg-cyan-400/10'
                  ].join(' ')}
                >
                  <span className="min-w-0 flex-1">全部来源</span>
                  <span className="tabular-nums text-[11px] text-slate-400 dark:text-slate-500">{allSourceTotal} 条</span>
                </button>
                {sourceStats.map(source => {
                  const isSelected = selectedSourceId === source.sourceId
                  return (
                  <button
                    key={source.sourceId}
                    type="button"
                    data-testid={`briefing-source-filter-${source.sourceId}`}
                    aria-pressed={isSelected}
                    aria-label={`按来源筛选：${source.sourceName}，共${source.total}条`}
                    onClick={() => setFilter({ selectedSourceId: isSelected ? null : source.sourceId })}
                    className={[
                      'min-h-12 w-full rounded-md border px-3 py-2 text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900',
                      isSelected
                        ? 'border-cyan-300 bg-cyan-50 shadow-sm shadow-cyan-100/60 dark:border-cyan-400/45 dark:bg-cyan-400/10 dark:shadow-black/20'
                        : 'border-slate-100 bg-white hover:border-cyan-200 hover:bg-cyan-50/60 dark:border-slate-800 dark:bg-slate-950/40 dark:hover:border-cyan-400/30 dark:hover:bg-cyan-400/10'
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-cyan-500" />
                      <div className={[
                        'min-w-0 flex-1 truncate text-xs font-semibold',
                        isSelected ? 'text-cyan-900 dark:text-cyan-100' : 'text-slate-700 dark:text-slate-200'
                      ].join(' ')}>{source.sourceName}</div>
                      <span className="tabular-nums text-[11px] text-slate-400 dark:text-slate-500">{source.total} 条</span>
                    </div>
                    <div className="mt-1 flex min-h-4 gap-2 pl-4 text-[11px] text-slate-400 dark:text-slate-500">
                      {source.unread > 0 && <span className="text-cyan-600 dark:text-cyan-300">{source.unread} 未读</span>}
                      {source.highImpact > 0 && <span className="text-red-500 dark:text-red-300">{source.highImpact} 高影响</span>}
                      {isSelected && <span className="ml-auto font-semibold text-cyan-700 dark:text-cyan-200">筛选中</span>}
                    </div>
                  </button>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">暂无来源统计</div>
            )}
          </div>
        ) : (
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-1">
            <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-950/60">
              <button
                type="button"
                data-testid="archive-time-scope-confirmed"
                aria-pressed={publicationTimeScope === 'confirmed'}
                onClick={() => setFilter({ selectedSourceId: null, publicationTimeScope: 'confirmed' })}
                className={[
                  'min-h-11 rounded px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500',
                  publicationTimeScope === 'confirmed'
                    ? 'bg-white text-emerald-700 shadow-sm dark:bg-slate-800 dark:text-emerald-200'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
                ].join(' ')}
              >
                已确认时间
              </button>
              <button
                type="button"
                data-testid="archive-time-scope-uncertain"
                aria-pressed={publicationTimeScope === 'uncertain'}
                onClick={() => setFilter({ selectedSourceId: null, publicationTimeScope: 'uncertain' })}
                className={[
                  'min-h-11 rounded px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500',
                  publicationTimeScope === 'uncertain'
                    ? 'bg-white text-amber-700 shadow-sm dark:bg-slate-800 dark:text-amber-200'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200',
                ].join(' ')}
              >
                待校时 {uncertainTotal}
              </button>
            </div>
            {publicationTimeScope === 'uncertain' && (
              <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200">
                来源未提供可验证的原始发布时间；日期仅表示采集日，不计入正式归档数量。
              </p>
            )}
            <button
              onClick={() => selectArchiveDate(null)}
              className={[
                'w-full rounded-md px-3 py-2 text-left text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-800',
                selectedDate === null ? selectedItemClass : 'text-slate-700 dark:text-slate-300'
              ].join(' ')}
            >
              全部日期
            </button>

            <div className="mt-2 space-y-0.5">
              {tree.map((yearNode) => {
                const yearExpanded = expandedYears.has(yearNode.year)
                const yearSelected = selectedDate === yearNode.year

                return (
                  <div key={yearNode.year}>
                    <div className="flex items-stretch">
                      <button
                        onClick={() => selectArchiveDate(yearNode.year)}
                        className={[
                          'flex-1 rounded-l-lg py-1.5 pl-3 pr-1 text-left text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-800',
                          yearSelected ? selectedItemClass : 'font-medium text-slate-800 dark:text-slate-200'
                        ].join(' ')}
                      >
                        <span>{yearNode.year}年</span>
                        <CountBadges
                          total={yearNode.totalCount}
                          unread={yearNode.unreadCount}
                          critical={yearNode.criticalCount}
                          uncertain={yearNode.uncertainTimeCount}
                        />
                      </button>
                      <button
                        onClick={() => toggleYear(yearNode.year)}
                        className="rounded-r-lg px-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                        aria-label={yearExpanded ? '收起年份' : '展开年份'}
                      >
                        {yearExpanded ? '▾' : '▸'}
                      </button>
                    </div>

                    {yearExpanded &&
                      yearNode.months.map((monthNode) => {
                        const monthExpanded = expandedMonths.has(monthNode.yearMonth)
                        const monthSelected = selectedDate === monthNode.yearMonth

                        return (
                          <div key={monthNode.yearMonth}>
                            <div className="flex items-stretch">
                              <button
                                onClick={() => selectArchiveDate(monthNode.yearMonth)}
                                className={[
                                  'flex-1 rounded-l-lg py-1 pl-6 pr-1 text-left text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-800',
                                  monthSelected ? selectedItemClass : 'text-slate-700 dark:text-slate-300'
                                ].join(' ')}
                              >
                                <span>{parseInt(monthNode.month)}月</span>
                                <CountBadges
                                  total={monthNode.totalCount}
                                  unread={monthNode.unreadCount}
                                  critical={monthNode.criticalCount}
                                  uncertain={monthNode.uncertainTimeCount}
                                />
                              </button>
                              <button
                                onClick={() => toggleMonth(monthNode.yearMonth)}
                                className="rounded-r-lg px-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                                aria-label={monthExpanded ? '收起月份' : '展开月份'}
                              >
                                {monthExpanded ? '▾' : '▸'}
                              </button>
                            </div>

                            {monthExpanded &&
                              monthNode.days
                                .slice()
                                .sort((a, b) => b.date.localeCompare(a.date))
                                .map((day) => {
                                  const daySelected = selectedDate === day.date
                                  const [, , d] = day.date.split('-')
                                  return (
                                    <button
                                      key={day.date}
                                      onClick={() => selectArchiveDate(day.date)}
                                      className={[
                                        'w-full rounded-lg py-0.5 pl-9 pr-2 text-left text-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-800',
                                        daySelected ? selectedItemClass : 'text-slate-600 dark:text-slate-400'
                                      ].join(' ')}
                                    >
                                      <span>{parseInt(d)}日</span>
                                      <CountBadges
                                        total={day.totalCount}
                                        unread={day.unreadCount}
                                        critical={day.criticalCount}
                                        uncertain={day.uncertainTimeCount}
                                      />
                                    </button>
                                  )
                                })}
                          </div>
                        )
                      })}
                  </div>
                )
              })}
            </div>

            {archiveDates.length === 0 && (
              <p className="px-3 py-4 text-xs text-slate-400 dark:text-slate-500">暂无数据</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CountBadges({
  total,
  unread,
  critical,
  uncertain
}: {
  total: number
  unread: number
  critical: number
  uncertain: number
}) {
  return (
    <span className="mt-0.5 flex flex-wrap gap-1 text-[11px]">
      <span className="text-slate-400 dark:text-slate-500">{total}条</span>
      {unread > 0 && <span className="text-cyan-600 dark:text-cyan-300">{unread}未读</span>}
      {critical > 0 && <span className="text-red-500 dark:text-red-300">{critical}重大</span>}
      {uncertain > 0 && <span className="text-amber-600 dark:text-amber-300">{uncertain}待校时</span>}
    </span>
  )
}
