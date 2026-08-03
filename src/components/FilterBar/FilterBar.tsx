import { useAppStore } from '../../store/appStore'
import type { ImpactRating } from '../../../electron/main/database/types'

const RATINGS: { value: ImpactRating | null; label: string }[] = [
  { value: null, label: '全部影响' },
  { value: 'CRITICAL', label: '重大' },
  { value: 'IMPORTANT', label: '重要' },
  { value: 'GENERAL', label: '一般' }
]

export function FilterBar() {
  const { selectedRating, searchQuery, setFilter, scanStatus, isScanning, unreadCount } = useAppStore()

  function formatTime(ms: number | null | undefined): string {
    if (!ms) return '暂无扫描'
    const bjMs = ms + 8 * 60 * 60 * 1000
    const date = new Date(bjMs)
    const hh = String(date.getUTCHours()).padStart(2, '0')
    const mm = String(date.getUTCMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-slate-100 bg-white px-3 py-3 dark:border-slate-800 dark:bg-slate-900/90">
      <div className="flex items-center gap-2">
        <div className="flex rounded-md border border-slate-200 bg-white p-1 shadow-sm shadow-slate-100/80 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-black/10">
          {RATINGS.map(({ value, label }) => (
            <button
              key={label}
              onClick={() => setFilter({ selectedRating: value })}
              className={[
                'rounded px-2.5 py-1 text-xs transition-colors',
                selectedRating === value
                  ? 'bg-slate-900 font-semibold text-white shadow-sm dark:bg-cyan-400 dark:text-slate-950'
                  : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="hidden shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white p-1 shadow-sm shadow-slate-100/80 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-black/10 xl:flex">
          <span className="rounded bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-200">未读优先</span>
          <span className="rounded px-2 py-1 text-xs text-slate-500 dark:text-slate-400">来源</span>
        </div>

        <input
          type="text"
          placeholder="搜索标题 / 摘要 / 股票代码"
          value={searchQuery}
          onChange={(e) => setFilter({ searchQuery: e.target.value })}
          className="ml-auto min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 shadow-sm shadow-slate-100/80 placeholder:text-slate-400 focus:border-cyan-300 focus:outline-none dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-200 dark:shadow-black/10 dark:focus:border-cyan-500"
        />
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500 dark:text-slate-400">
        <span>上次 {formatTime(scanStatus?.lastScanAt)} · {isScanning ? '自动扫描中' : '扫描待命'}</span>
        <span>{unreadCount > 0 ? `${unreadCount} 条未读` : '暂无未读'}</span>
      </div>
    </div>
  )
}
