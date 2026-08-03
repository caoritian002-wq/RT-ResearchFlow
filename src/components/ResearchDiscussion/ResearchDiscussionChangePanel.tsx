import { useCallback, useEffect, useState } from 'react'
import { activeChangeSets, canResolveChangeSet, changeSetActionLabel, changeSetStatusLabel } from './researchDiscussionModel'
import type {
  ResearchApiResponse,
  ResearchCandidateBatchSummary,
  ResearchChangeCandidate,
  ResearchChangeSetSummary,
  ResearchDiscussionSummary,
} from './researchDiscussionTypes'
import { ResearchDiscussionResolveDialog, type ResolveDialogSubmission } from './ResearchDiscussionResolveDialog'
import { loadAllResearchChangeCandidates } from './researchChangeCandidateLoader'

interface Props {
  discussion: ResearchDiscussionSummary
  messageCount: number
  onChanged?: () => void
}

export function ResearchDiscussionChangePanel({ discussion, messageCount, onChanged }: Props) {
  const [batch, setBatch] = useState<ResearchCandidateBatchSummary | null>(null)
  const [items, setItems] = useState<ResearchChangeSetSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [dialogItem, setDialogItem] = useState<ResearchChangeSetSummary | null>(null)
  const [candidates, setCandidates] = useState<ResearchChangeCandidate[]>([])
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await window.api.industryResearch.listChangeSets({ sessionId: discussion.sessionId, limit: 100 }) as ResearchApiResponse<{ items: ResearchChangeSetSummary[] }>
    setLoading(false)
    if (!response.ok || !response.data) {
      setError(response.message || response.error || '加载研究增量失败')
      return
    }
    const next = activeChangeSets(response.data.items)
    setItems(next)
    if (next[0]) setBatch((current) => current?.id === next[0].batchId ? current : { id: next[0].batchId } as ResearchCandidateBatchSummary)
  }, [discussion.sessionId])

  useEffect(() => { void load() }, [load])

  const prepare = async () => {
    if (messageCount <= 0) return
    setPreparing(true)
    setError(null)
    setNotice(null)
    const response = await window.api.industryResearch.prepareDiscussionChanges({
      requestId: crypto.randomUUID(),
      sessionId: discussion.sessionId,
      throughMessageIndex: messageCount - 1,
      projectId: discussion.projectId,
      baseSnapshotId: discussion.baseSnapshotId,
    }) as ResearchApiResponse<{
      batch: ResearchCandidateBatchSummary | null
      changeSets: ResearchChangeSetSummary[]
      noMaterialChange: boolean
      summary: string
    }>
    setPreparing(false)
    if (!response.ok || !response.data) {
      setError(response.message || response.error || '整理讨论失败')
      return
    }
    setBatch(response.data.batch)
    setItems(response.data.changeSets)
    setNotice(response.data.summary)
    onChanged?.()
  }

  const resolve = async (
    item: ResearchChangeSetSummary,
    action: 'reject' | 'defer',
  ) => {
    setResolvingId(item.id)
    setError(null)
    const response = await window.api.industryResearch.resolveChangeSets({
      requestId: crypto.randomUUID(), batchId: item.batchId, changeSetIds: [item.id], action,
    }) as ResearchApiResponse<unknown>
    setResolvingId(null)
    if (!response.ok) {
      setError(response.message || response.error || '处理变更包失败')
      return
    }
    setNotice(action === 'defer' ? '已暂存，可稍后继续处理。' : '已忽略该研究增量。')
    await load()
    onChanged?.()
  }

  const openResolve = async (item: ResearchChangeSetSummary) => {
    setDialogItem(item)
    setCandidates([])
    setLoadingCandidates(true)
    try {
      setCandidates(await loadAllResearchChangeCandidates(item.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取底层候选失败')
    } finally {
      setLoadingCandidates(false)
    }
  }

  const accept = async (submission: ResolveDialogSubmission) => {
    if (!dialogItem) return
    setResolvingId(dialogItem.id)
    setError(null)
    const response = await window.api.industryResearch.resolveChangeSets({
      requestId: crypto.randomUUID(),
      batchId: dialogItem.batchId,
      changeSetIds: [dialogItem.id],
      action: 'accept',
      target: submission.target,
      userEdits: [{ changeSetId: dialogItem.id, title: submission.title, summary: submission.summary }],
      factConfirmations: submission.factConfirmations,
    }) as ResearchApiResponse<{ projectId: string | null; appliedSummary: Array<{ type: string; label: string }> }>
    setResolvingId(null)
    if (!response.ok || !response.data) {
      setError(response.message || response.error || '写入产业研究失败')
      return
    }
    setDialogItem(null)
    setNotice(`已写入 ${response.data.appliedSummary.length} 项研究变化。`)
    await load()
    onChanged?.()
  }

  return (
    <section data-testid="research-discussion-change-panel" className="border-t border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">研究增量</h3>
          <p className="mt-1 text-xs text-slate-500">{items.length ? `${items.length} 个语义变更包 · ${batch?.candidateCount ?? items.reduce((sum, item) => sum + item.candidateCount, 0)} 项底层变化` : '尚未整理本次讨论'}</p>
        </div>
        <button
          type="button"
          data-testid="prepare-discussion-changes"
          onClick={() => { void prepare() }}
          disabled={messageCount <= 0 || preparing}
          className="rounded-md bg-cyan-700 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-40"
        >{preparing ? '整理中…' : '整理本次讨论'}</button>
      </div>
      {error && <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
      {notice && <div role="status" className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</div>}
      {loading && <div className="py-4 text-center text-xs text-slate-500">正在加载研究增量…</div>}
      {!loading && items.length > 0 && (
        <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {items.map((item) => (
            <article key={item.id} data-testid={`research-change-set-${item.id}`} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap gap-2 text-[11px] text-slate-500"><span>{changeSetActionLabel(item.action)}</span><span>{item.risk === 'high' ? '高风险' : item.risk === 'medium' ? '中风险' : '低风险'}</span><span>{changeSetStatusLabel(item.status)}</span></div>
                  <h4 className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{item.title}</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{item.summary}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">影响：{item.impact}</p>
                  <p className="mt-1 text-[11px] leading-5 text-amber-700 dark:text-amber-300">可信边界：{item.confidenceBoundary}</p>
                </div>
                {canResolveChangeSet(item) && (
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <button type="button" onClick={() => { void openResolve(item) }} disabled={Boolean(resolvingId)} className="rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900">检查并接受</button>
                    <button type="button" onClick={() => { void resolve(item, 'defer') }} disabled={Boolean(resolvingId)} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">暂存</button>
                    <button type="button" onClick={() => { void resolve(item, 'reject') }} disabled={Boolean(resolvingId)} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-500 disabled:opacity-40 dark:border-slate-700">忽略</button>
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <ResearchDiscussionResolveDialog
        item={dialogItem}
        projectId={discussion.projectId}
        projectTitle={discussion.projectTitle}
        candidates={candidates}
        loadingCandidates={loadingCandidates}
        submitting={dialogItem != null && resolvingId === dialogItem.id}
        error={dialogItem ? error : null}
        onClose={() => { if (!resolvingId) setDialogItem(null) }}
        onSubmit={(submission) => { void accept(submission) }}
      />
    </section>
  )
}
