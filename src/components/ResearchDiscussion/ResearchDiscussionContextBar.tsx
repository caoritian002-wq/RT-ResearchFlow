import type { ResearchDiscussionContextItem, ResearchDiscussionSummary } from './researchDiscussionTypes'
import { discussionStatusLabel } from './researchDiscussionModel'

interface Props {
  discussion: ResearchDiscussionSummary
  contextItems: ResearchDiscussionContextItem[]
  canEditContext: boolean
  updating?: boolean
  onUpdateContext: (keys: string[]) => void
  onReturn: () => void
}

export function ResearchDiscussionContextBar({
  discussion,
  contextItems,
  canEditContext,
  updating = false,
  onUpdateContext,
  onReturn,
}: Props) {
  const toggle = (key: string, checked: boolean) => {
    const selected = contextItems.filter((item) => !item.removable || item.key !== key || checked).map((item) => item.key)
    onUpdateContext(selected)
  }

  return (
    <section data-testid="research-discussion-context" className="border-b border-cyan-200 bg-cyan-50/80 px-5 py-3 dark:border-cyan-900/70 dark:bg-cyan-950/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-cyan-800 dark:text-cyan-200">
            <span>{discussionStatusLabel(discussion.status)}</span>
            <span>{discussion.projectTitle || '暂未关联研究项目'}</span>
            <span>{discussion.baseSnapshotId ? '基于最新研究版本' : discussion.projectId ? '空研究基线' : '未归档讨论'}</span>
          </div>
          <h2 className="mt-1 truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{discussion.origin.title}</h2>
          {!discussion.origin.available && <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-300">原来源已不可用，当前保留讨论启动时的有限上下文。</p>}
        </div>
        <button type="button" onClick={onReturn} className="shrink-0 rounded-md border border-cyan-300 bg-white px-3 py-1.5 text-xs font-semibold text-cyan-800 hover:bg-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-600 dark:border-cyan-800 dark:bg-slate-900 dark:text-cyan-200">
          返回来源
        </button>
      </div>
      <details className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        <summary className="cursor-pointer select-none font-medium text-cyan-800 focus:outline-none focus:ring-2 focus:ring-cyan-600 dark:text-cyan-200">本次带入的上下文 · {contextItems.length} 项</summary>
        <div className="mt-2 divide-y divide-cyan-100 border-y border-cyan-100 dark:divide-cyan-900/60 dark:border-cyan-900/60">
          {contextItems.map((item) => (
            <div key={item.key} className="flex gap-3 py-2">
              {item.removable && canEditContext ? (
                <input
                  type="checkbox"
                  checked
                  disabled={updating}
                  aria-label={`带入${item.label}`}
                  onChange={(event) => toggle(item.key, event.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-cyan-700"
                />
              ) : <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-cyan-600" aria-hidden="true" />}
              <div className="min-w-0">
                <div className="font-medium text-slate-800 dark:text-slate-100">{item.label}</div>
                <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap leading-5 text-slate-500 dark:text-slate-400">{item.excerpt}</p>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  )
}

