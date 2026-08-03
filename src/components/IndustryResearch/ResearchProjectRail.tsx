import React from 'react'
import { formatResearchDate } from './industryResearchModel'
import type { ResearchProject } from './industryResearchTypes'

const STATUS_LABEL: Record<ResearchProject['status'], string> = {
  draft: '草稿',
  active: '研究中',
  review_due: '待复核',
  archived: '已归档',
}

interface Props {
  projects: ResearchProject[]
  selectedId: string | null
  query: string
  loading: boolean
  includeArchived: boolean
  onQueryChange: (value: string) => void
  onSelect: (projectId: string) => void
  onCreate: () => void
  onToggleIncludeArchived: () => void
  onOpenCleanup: () => void
}

export function ResearchProjectRail({
  projects,
  selectedId,
  query,
  loading,
  includeArchived,
  onQueryChange,
  onSelect,
  onCreate,
  onToggleIncludeArchived,
  onOpenCleanup,
}: Props): React.ReactElement {
  return (
    <aside className="flex min-h-0 w-[260px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="border-b border-slate-200 p-3 dark:border-slate-800">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">本地事实项目</div>
            <h1 className="mt-0.5 text-base font-semibold">产业研究</h1>
          </div>
          <button type="button" onClick={onCreate} className="rounded-md bg-cyan-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-cyan-600">
            新建
          </button>
        </div>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索产业、产品"
          className="mt-3 h-8 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs outline-none focus:border-cyan-500 dark:border-slate-700 dark:bg-slate-950"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <input type="checkbox" checked={includeArchived} onChange={onToggleIncludeArchived} />
            显示已归档
          </label>
          <button type="button" onClick={onOpenCleanup} className="text-[11px] text-slate-500 hover:text-red-600">
            清理
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !projects.length && <div className="px-2 py-6 text-center text-xs text-slate-400">正在读取项目</div>}
        {!loading && !projects.length && <div className="px-2 py-6 text-center text-xs leading-5 text-slate-400">暂无研究项目。先定义产业、产品、区域和时间边界。</div>}
        <div className="space-y-1.5">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onSelect(project.id)}
              className={`w-full rounded-md border px-3 py-2.5 text-left transition-colors ${selectedId === project.id ? 'border-cyan-300 bg-cyan-50 dark:border-cyan-700 dark:bg-cyan-950/30' : 'border-transparent hover:border-slate-200 hover:bg-slate-50 dark:hover:border-slate-700 dark:hover:bg-slate-800'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 text-sm font-medium">{project.title}</span>
                <span className={`shrink-0 text-[10px] ${project.status === 'review_due' ? 'text-amber-600 dark:text-amber-300' : 'text-slate-400'}`}>{STATUS_LABEL[project.status]}</span>
              </div>
              <div className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400">{project.product_scope} · {project.region_scope}</div>
              <div className="mt-1 text-[10px] text-slate-400">更新 {formatResearchDate(project.updated_at)}</div>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}