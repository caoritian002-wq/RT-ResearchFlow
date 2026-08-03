import { RightDrawer } from '../shared/RightDrawer'
import { SHORT_TERM_WORKBENCH_ACTION_CLASS } from './ShortTermDecisionControls'

export type ConceptDataSource = 'kpl' | 'ths' | 'dc'

interface SyncProgress {
  current: number
  total: number
  message: string
}

interface FullSyncProgress {
  done: number
  total: number
}

interface ShortTermDataToolsDrawerProps {
  open: boolean
  source: ConceptDataSource
  sourceReady: boolean | null
  sourceSyncedAt: number | null
  sourceSyncProgress: SyncProgress | null
  fullSyncProgress: FullSyncProgress | null
  tushareReady: boolean | null
  syncingBaseData: boolean
  syncingAllConcepts: boolean
  message: string | null
  onSourceChange: (source: ConceptDataSource) => void
  onSyncCurrentSource: () => void
  onSyncBaseData: () => void
  onSyncAllConcepts: () => void
  onClose: () => void
}

const SOURCE_META: Record<ConceptDataSource, { name: string; abbreviation: string }> = {
  kpl: { name: '开盘啦', abbreviation: 'KPL' },
  ths: { name: '同花顺', abbreviation: 'THS' },
  dc: { name: '东方财富', abbreviation: 'DC' },
}

export function conceptSourceName(source: ConceptDataSource): string {
  return SOURCE_META[source].name
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const diffHours = Math.floor(diffMs / 3600000)
  if (diffHours < 1) return '刚刚'
  if (diffHours < 24) return `${diffHours}小时前`
  return `${Math.floor(diffMs / 86400000)}天前`
}

export function ConceptDataToolsButton({
  source,
  onClick,
  variant = 'compact',
}: {
  source: ConceptDataSource
  onClick: () => void
  variant?: 'compact' | 'workbench'
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      data-testid={`concept-data-tools-${variant}`}
      className={variant === 'workbench'
        ? SHORT_TERM_WORKBENCH_ACTION_CLASS
        : 'h-8 cursor-pointer whitespace-nowrap rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 transition-colors hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-700 dark:hover:bg-cyan-950/30 dark:hover:text-cyan-200'}
    >
      题材数据 · {conceptSourceName(source)}
    </button>
  )
}

export function ShortTermDataToolsDrawer({
  open,
  source,
  sourceReady,
  sourceSyncedAt,
  sourceSyncProgress,
  fullSyncProgress,
  tushareReady,
  syncingBaseData,
  syncingAllConcepts,
  message,
  onSourceChange,
  onSyncCurrentSource,
  onSyncBaseData,
  onSyncAllConcepts,
  onClose,
}: ShortTermDataToolsDrawerProps): JSX.Element {
  const sourceMeta = SOURCE_META[source]
  const sourceProgressPercent = sourceSyncProgress && sourceSyncProgress.total > 0
    ? Math.round(sourceSyncProgress.current / sourceSyncProgress.total * 100)
    : 5

  return (
    <RightDrawer
      open={open}
      title="短线数据管理"
      description="管理题材归因来源与盘后基础缓存；不会修改策略条件或触发策略运行。"
      onClose={onClose}
      defaultWidth={520}
      minWidth={420}
      maxWidth={620}
      testId="short-term-data-tools-drawer"
      bodyClassName="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4 dark:bg-slate-950"
    >
      <div data-testid="short-term-data-tools-content" className="space-y-4">
        <section className="rounded-md border border-cyan-200 bg-cyan-50/70 p-4 dark:border-cyan-900/70 dark:bg-cyan-950/25">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">当前用途</p>
              <h3 className="mt-1 text-sm font-semibold text-slate-950 dark:text-slate-100">题材归因与共振验证</h3>
              <p className="mt-1.5 text-xs leading-5 text-slate-600 dark:text-slate-300">
                为竞价候选、涨停监控等短线页面补充题材标签、板块联动和筛选依据，不是股票行情源。
              </p>
            </div>
            <span className="shrink-0 rounded border border-cyan-200 bg-white px-2 py-1 text-[11px] font-semibold text-cyan-800 dark:border-cyan-800 dark:bg-slate-900 dark:text-cyan-200">
              {sourceMeta.name}
            </span>
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">题材来源</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">切换后，短线页面统一使用所选来源的本地题材成分。</p>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-950" role="group" aria-label="题材数据来源">
            {(Object.keys(SOURCE_META) as ConceptDataSource[]).map((item) => {
              const meta = SOURCE_META[item]
              const selected = source === item
              return (
                <button
                  key={item}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSourceChange(item)}
                  className={`min-h-11 rounded px-2 py-1.5 text-center transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500/30 ${selected
                    ? 'bg-white text-cyan-800 shadow-sm ring-1 ring-slate-200 dark:bg-slate-800 dark:text-cyan-200 dark:ring-slate-700'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100'}`}
                >
                  <span className="block text-xs font-semibold">{meta.name}</span>
                  <span className="mt-0.5 block text-[10px] font-medium text-slate-400">{meta.abbreviation}</span>
                </button>
              )
            })}
          </div>

          <div className="mt-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">本地题材成分</span>
              <span className={sourceReady === false ? 'text-amber-700 dark:text-amber-300' : sourceReady === null ? 'text-slate-400' : 'text-emerald-700 dark:text-emerald-300'}>
                {sourceReady === null ? '检查中' : sourceReady ? '可用' : '待同步'}
              </span>
            </div>
            {source === 'ths' && sourceSyncedAt !== null && !sourceSyncProgress && (
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">最近同步：{formatRelativeTime(sourceSyncedAt)}</p>
            )}
            {sourceSyncProgress && (
              <div className="mt-2" aria-live="polite">
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate">{sourceSyncProgress.message || '题材同步中'}</span>
                  <span className="font-mono">{sourceSyncProgress.total > 0 ? `${sourceSyncProgress.current}/${sourceSyncProgress.total}` : '同步中'}</span>
                </div>
                <span className="block h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <span className="block h-full rounded-full bg-cyan-600 transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${sourceProgressPercent}%` }} />
                </span>
              </div>
            )}
            {syncingAllConcepts && (
              <div className="mt-2 text-[11px] text-cyan-700 dark:text-cyan-300" aria-live="polite">
                全量题材同步 {fullSyncProgress ? `${fullSyncProgress.done}/${fullSyncProgress.total}` : '准备中'}
              </div>
            )}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(source === 'ths' || source === 'dc') && (
              <button
                type="button"
                onClick={onSyncCurrentSource}
                disabled={Boolean(sourceSyncProgress) || tushareReady === false}
                className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {sourceReady === false ? `同步${sourceMeta.name}题材` : `更新${sourceMeta.name}题材`}
              </button>
            )}
            <button
              type="button"
              onClick={onSyncAllConcepts}
              disabled={syncingAllConcepts || tushareReady === false}
              className={`min-h-10 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 ${(source === 'kpl') ? 'sm:col-span-2' : ''}`}
            >
              {syncingAllConcepts ? '同步全量题材中…' : '同步全量股票题材'}
            </button>
          </div>
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">盘后基础数据</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">补充涨停、龙虎榜等盘后缓存；它与上面的题材来源是两套独立数据。</p>
          <button
            type="button"
            onClick={onSyncBaseData}
            disabled={syncingBaseData || tushareReady === false}
            className="mt-3 min-h-10 w-full rounded-md bg-cyan-700 px-3 text-xs font-semibold text-white hover:bg-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {syncingBaseData ? '同步盘后数据中…' : '同步盘后基础数据'}
          </button>
        </section>

        {message && (
          <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-800 dark:border-blue-800 dark:bg-blue-950/35 dark:text-blue-200" role="status">
            {message}
          </div>
        )}

        {tushareReady === false && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            Tushare 未配置或当前套餐不可用，暂时无法执行同步；已有本地数据仍可继续读取。
          </div>
        )}
      </div>
    </RightDrawer>
  )
}
