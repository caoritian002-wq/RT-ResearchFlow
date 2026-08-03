import { useCallback, useEffect, useState } from 'react'
import type { IndustryResearchResponse, ResearchChangeCandidate, ResearchChangeSetSummary } from './industryResearchTypes'

const PAGE_SIZE = 20

interface Props {
  item: ResearchChangeSetSummary | null
  onClose: () => void
}

export function ResearchCandidateAuditDialog({ item, onClose }: Props): React.ReactElement | null {
  const [items, setItems] = useState<ResearchChangeCandidate[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (nextOffset: number) => {
    if (!item) return
    setLoading(true)
    setError(null)
    const response = await window.api.industryResearch.listChangeCandidates({
      changeSetId: item.id,
      offset: nextOffset,
      limit: PAGE_SIZE,
    }) as IndustryResearchResponse<{ items: ResearchChangeCandidate[]; total: number; offset: number; limit: number }>
    setLoading(false)
    if (!response.ok || !response.data) {
      setError(response.message || '读取底层候选失败')
      return
    }
    setItems(response.data.items)
    setTotal(response.data.total)
    setOffset(response.data.offset)
  }, [item])

  useEffect(() => {
    if (!item) return
    setItems([])
    setTotal(0)
    setOffset(0)
    void load(0)
  }, [item, load])

  if (!item) return null
  const pageStart = total === 0 ? 0 : offset + 1
  const pageEnd = Math.min(total, offset + items.length)

  return (
    <div className="fixed inset-0 z-[10030] flex items-center justify-center bg-slate-950/55 p-4" role="dialog" aria-modal="true" aria-labelledby="candidate-audit-title">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-950">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">高级审计</div>
            <h2 id="candidate-audit-title" className="mt-1 truncate text-base font-semibold">{item.title}</h2>
            <p className="mt-1 text-xs text-slate-500">底层候选仅用于追溯和冲突检查，不需要逐条确认。</p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 rounded-md border border-slate-300 px-3 py-2 text-xs dark:border-slate-700">关闭</button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {error && <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"><span>{error}</span><button type="button" onClick={() => { void load(offset) }} className="font-semibold underline">重试</button></div>}
          {loading && <div className="py-10 text-center text-sm text-slate-500">正在读取候选…</div>}
          {!loading && items.length === 0 && !error && <div className="py-10 text-center text-sm text-slate-500">没有底层候选</div>}
          {!loading && items.length > 0 && (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {items.map((candidate) => (
                <article key={candidate.id} className="py-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900 dark:text-slate-100">{candidate.kind}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{candidate.statementType}</span>
                    <span className="text-slate-400">{candidate.action}</span>
                  </div>
                  <p className="mt-1 break-all text-slate-500">来源定位：{candidate.sourceLocator}</p>
                  {candidate.conflicts.map((conflict) => <p key={conflict} className="mt-1 text-red-700 dark:text-red-300">冲突：{conflict}</p>)}
                  {candidate.warnings.map((warning) => <p key={warning} className="mt-1 text-amber-700 dark:text-amber-300">注意：{warning}</p>)}
                  {candidate.statementType === 'fact' && <p className="mt-1 font-medium text-amber-700 dark:text-amber-300">只有在接受时补充并人工确认一级来源，才允许写为事实。</p>}
                </article>
              ))}
            </div>
          )}
        </div>
        <footer className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-xs text-slate-500 dark:border-slate-800">
          <span>{pageStart}-{pageEnd} / {total}</span>
          <div className="flex gap-2">
            <button type="button" disabled={offset === 0 || loading} onClick={() => { void load(Math.max(0, offset - PAGE_SIZE)) }} className="rounded-md border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700">上一页</button>
            <button type="button" disabled={offset + items.length >= total || loading} onClick={() => { void load(offset + PAGE_SIZE) }} className="rounded-md border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700">下一页</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
