import { useCallback, useEffect, useState } from 'react'
import type {
  IndustryResearchResponse,
  IndustryResearchSnapshotSummary,
  ResearchSnapshotDetail,
} from './industryResearchTypes'

const PAGE_SIZE = 12

interface Props {
  open: boolean
  projectId: string
  onClose: () => void
  onOpenDiscussion: (sessionId: number) => void
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function ResearchSnapshotHistoryDialog({ open, projectId, onClose, onOpenDiscussion }: Props): React.ReactElement | null {
  const [items, setItems] = useState<IndustryResearchSnapshotSummary[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<ResearchSnapshotDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true)
    setError(null)
    const response = await window.api.industryResearch.listSnapshots({ projectId, offset: nextOffset, limit: PAGE_SIZE }) as IndustryResearchResponse<{ items: IndustryResearchSnapshotSummary[]; total: number; offset: number; limit: number }>
    setLoading(false)
    if (!response.ok || !response.data) {
      setError(response.message || '读取研究版本失败')
      return
    }
    setItems(response.data.items)
    setTotal(response.data.total)
    setOffset(response.data.offset)
  }, [projectId])

  useEffect(() => {
    if (!open) return
    setDetail(null)
    void load(0)
  }, [load, open])

  const openDetail = async (item: IndustryResearchSnapshotSummary) => {
    setDetailLoading(true)
    setError(null)
    const response = await window.api.industryResearch.getSnapshot({ projectId, snapshotId: item.id }) as IndustryResearchResponse<ResearchSnapshotDetail>
    setDetailLoading(false)
    if (!response.ok || !response.data) {
      setError(response.message || '打开研究版本失败')
      return
    }
    setDetail(response.data)
  }

  if (!open) return null
  const snapshot = detail?.snapshot

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/55 p-4" role="dialog" aria-modal="true" aria-labelledby="snapshot-history-title">
      <div className="flex h-[min(760px,88vh)] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-950">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div><div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">不可变记录</div><h2 id="snapshot-history-title" className="mt-1 text-lg font-semibold">研究版本历史</h2></div>
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">关闭</button>
        </header>
        {error && <div role="alert" className="flex items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300"><span>{error}</span><button type="button" onClick={() => { void load(offset) }} className="font-semibold underline">重试</button></div>}
        <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] max-md:grid-cols-1">
          <aside className="min-h-0 overflow-y-auto border-r border-slate-200 dark:border-slate-800 max-md:border-b max-md:border-r-0">
            {loading && <div className="py-10 text-center text-sm text-slate-500">加载版本中…</div>}
            {!loading && items.length === 0 && <div className="py-10 text-center text-sm text-slate-500">尚无研究版本</div>}
            {!loading && items.map((item) => (
              <button key={item.id} type="button" onClick={() => { void openDetail(item) }} className={`block w-full border-b border-slate-100 px-4 py-3 text-left text-xs dark:border-slate-800 ${detail?.summary.id === item.id ? 'bg-cyan-50 dark:bg-cyan-950/20' : 'hover:bg-slate-50 dark:hover:bg-slate-900'}`}>
                <span className="block truncate font-semibold text-slate-900 dark:text-slate-100">{item.title}</span>
                <span className="mt-1 block text-slate-500">{formatTime(item.createdAt)} · {item.acceptedChangeSetCount} 个变更包</span>
              </button>
            ))}
            {total > PAGE_SIZE && <div className="flex items-center justify-between px-4 py-3 text-xs text-slate-500"><span>{offset + 1}-{Math.min(total, offset + items.length)} / {total}</span><div className="flex gap-1"><button type="button" disabled={offset === 0 || loading} onClick={() => { void load(Math.max(0, offset - PAGE_SIZE)) }} className="rounded border px-2 py-1 disabled:opacity-40 dark:border-slate-700">上一页</button><button type="button" disabled={offset + items.length >= total || loading} onClick={() => { void load(offset + PAGE_SIZE) }} className="rounded border px-2 py-1 disabled:opacity-40 dark:border-slate-700">下一页</button></div></div>}
          </aside>
          <main className="min-h-0 overflow-y-auto p-5">
            {detailLoading && <div className="py-10 text-center text-sm text-slate-500">装配版本详情中…</div>}
            {!detailLoading && !detail && <div className="py-10 text-center text-sm text-slate-500">选择一个版本查看写入结果和来源</div>}
            {!detailLoading && detail && snapshot && (
              <div className="space-y-5">
                <section><h3 className="text-base font-semibold">{detail.summary.title}</h3><p className="mt-1 text-xs text-slate-500">版本结构 V{detail.summary.schemaVersion} · 图谱时间戳 {detail.summary.graphUpdatedAt}</p></section>
                <section className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 text-xs sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-800">
                  {[
                    ['节点', snapshot.graph?.nodes.length ?? 0],
                    ['关系', snapshot.graph?.edges.length ?? 0],
                    ['证据引用', snapshot.evidenceRefs?.length ?? 0],
                    ['假设', snapshot.hypotheses?.length ?? 0],
                  ].map(([label, value]) => <div key={label} className="bg-white px-3 py-3 dark:bg-slate-900"><div className="text-slate-500">{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{value}</div></div>)}
                </section>
                <section className="border-y border-slate-200 py-4 text-xs dark:border-slate-800">
                  <div className="font-semibold">版本来源</div>
                  <p className="mt-1 text-slate-500">{snapshot.source?.originType || 'archive'}{snapshot.source?.originId ? ` · ${snapshot.source.originId}` : ''}</p>
                  {snapshot.source?.sessionId != null && detail.sourceDiscussionAvailable && <button type="button" onClick={() => onOpenDiscussion(snapshot.source!.sessionId!)} className="mt-3 rounded-md bg-cyan-700 px-3 py-1.5 font-semibold text-white">打开来源讨论</button>}
                  {snapshot.source?.sessionId != null && !detail.sourceDiscussionAvailable && <p className="mt-2 text-amber-700 dark:text-amber-300">来源讨论已删除，版本与来源摘要仍保留。</p>}
                </section>
                {snapshot.evidenceRefs && snapshot.evidenceRefs.length > 0 && <details className="border-b border-slate-200 pb-4 dark:border-slate-800"><summary className="cursor-pointer text-sm font-semibold">证据引用 {snapshot.evidenceRefs.length}</summary><div className="mt-2 max-h-56 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">{snapshot.evidenceRefs.map((item) => <div key={item.id} className="py-2 text-xs"><span className="font-medium">{item.title}</span><span className="ml-2 text-slate-500">{item.statementKind}{item.primarySourceConfirmed ? ' · 一级来源已确认' : ''}</span></div>)}</div></details>}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
