import type { StrategyLabView, StrategyTemplateCard } from './strategyLabModel'

interface StrategyTemplateLibraryProps {
  templates: StrategyTemplateCard[]
  activeView: StrategyLabView
  selectedStrategyId?: number | null
  onSelect: (template: StrategyTemplateCard) => void
  onDuplicate?: (template: StrategyTemplateCard) => void
  onToggleEnabled?: (template: StrategyTemplateCard) => void
  onDelete?: (template: StrategyTemplateCard) => void
  onCreate?: () => void
}

function statusLabel(status: StrategyTemplateCard['status']): string {
  if (status === 'ready') return '可运行'
  if (status === 'draft') return '草稿'
  if (status === 'disabled') return '停用'
  return '规划中'
}

export function StrategyTemplateLibrary({ templates, activeView, selectedStrategyId, onSelect, onDuplicate, onToggleEnabled, onDelete, onCreate }: StrategyTemplateLibraryProps): JSX.Element {
  return (
    <aside className="flex min-h-0 w-[220px] shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
      <div className="border-b border-slate-200 bg-white px-3 py-3 dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">策略模板库</p>
            <h2 className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100">策略实验室</h2>
          </div>
          <button type="button" onClick={onCreate} className="min-h-8 rounded-md border border-slate-200 px-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">新建</button>
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">个性选股和条件积木快速模板。</p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {templates.map((template) => {
          const active = template.strategyId ? selectedStrategyId === template.strategyId : activeView === template.id
          return (
            <article
              key={template.strategyId ?? template.id}
              className={
                'w-full rounded-md border p-3 text-left transition-colors ' +
                (active
                  ? 'border-teal-500 bg-teal-50 shadow-sm dark:border-teal-400 dark:bg-teal-950/30'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-600')
              }
            >
              <button type="button" onClick={() => onSelect(template)} className="block w-full text-left focus:outline-none">
                <div className="flex items-center justify-between gap-2">
                  <span className={
                    'rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
                    (template.source === 'screener'
                      ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200'
                      : template.source === 'conditionBlocks'
                        ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200'
                        : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200')
                  }>
                    {template.source === 'screener' ? '快速选股' : template.source === 'conditionBlocks' ? '分钟形态' : '组合模板'}
                  </span>
                  <span className={
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ' +
                    (template.status === 'ready'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                      : template.status === 'disabled'
                        ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300'
                        : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200')
                  }>
                    {statusLabel(template.status)}
                  </span>
                </div>
                <h3 className="mt-2 text-sm font-semibold leading-5 text-slate-900 dark:text-slate-100">{template.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600 dark:text-slate-300">{template.description}</p>
                <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-400 dark:text-slate-500">
                  <span>{template.isBuiltin ? '原生模板' : '用户策略'}</span>
                  <span className="font-mono">{template.lastRunAt ? '已运行' : '0 只'}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {template.tags.slice(0, 3).map(tag => (
                    <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
              {template.strategyId && (
                <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-100 pt-2 dark:border-slate-800">
                  <button type="button" onClick={() => onDuplicate?.(template)} className="min-h-7 rounded border border-slate-200 px-2 text-[11px] text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">复制</button>
                  <button type="button" onClick={() => onToggleEnabled?.(template)} className="min-h-7 rounded border border-slate-200 px-2 text-[11px] text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">{template.enabled === false ? '启用' : '停用'}</button>
                  {!template.isBuiltin && (
                    <button type="button" onClick={() => onDelete?.(template)} className="min-h-7 rounded border border-rose-200 px-2 text-[11px] text-rose-600 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/30">删除</button>
                  )}
                </div>
              )}
            </article>
          )
        })}
      </div>
    </aside>
  )
}