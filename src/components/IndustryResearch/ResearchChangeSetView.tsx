import { useCallback, useEffect, useMemo, useState } from 'react'
import { ResearchDiscussionResolveDialog, type ResolveDialogSubmission } from '../ResearchDiscussion/ResearchDiscussionResolveDialog'
import { loadAllResearchChangeCandidates } from '../ResearchDiscussion/researchChangeCandidateLoader'
import { canResolveChangeSet, changeSetActionLabel, changeSetStatusLabel } from '../ResearchDiscussion/researchDiscussionModel'
import { ResearchCandidateAuditDialog } from './ResearchCandidateAuditDialog'
import type {
  IndustryResearchResponse,
  IndustryResearchSnapshotSummary,
  ResearchChangeCandidate,
  ResearchChangeResolveResult,
  ResearchChangeSetSummary,
  ResearchProject,
} from './industryResearchTypes'

interface Props {
  project: ResearchProject
  refreshToken?: number
  onChanged: () => void
  onOpenDiscussion: (sessionId: number) => void
  onImportArchive: () => void
  onOpenSnapshots: () => void
  onSnapshotCountChange?: (count: number) => void
}

function riskLabel(risk: ResearchChangeSetSummary['risk']): string {
  if (risk === 'high') return '高风险，需展开检查'
  if (risk === 'medium') return '中风险'
  return '低风险'
}

export function ResearchChangeSetView({
  project,
  refreshToken = 0,
  onChanged,
  onOpenDiscussion,
  onImportArchive,
  onOpenSnapshots,
  onSnapshotCountChange,
}: Props): React.ReactElement {
  const [items, setItems] = useState<ResearchChangeSetSummary[]>([])
  const [latestSnapshot, setLatestSnapshot] = useState<IndustryResearchSnapshotSummary | null>(null)
  const [snapshotCount, setSnapshotCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [resolveItem, setResolveItem] = useState<ResearchChangeSetSummary | null>(null)
  const [auditItem, setAuditItem] = useState<ResearchChangeSetSummary | null>(null)
  const [candidates, setCandidates] = useState<ResearchChangeCandidate[]>([])
  const [loadingCandidates, setLoadingCandidates] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [changesResponse, snapshotsResponse] = await Promise.all([
      window.api.industryResearch.listChangeSets({ projectId: project.id, limit: 100 }) as Promise<IndustryResearchResponse<{ items: ResearchChangeSetSummary[]; total: number }>>,
      window.api.industryResearch.listSnapshots({ projectId: project.id, offset: 0, limit: 1 }) as Promise<IndustryResearchResponse<{ items: IndustryResearchSnapshotSummary[]; total: number }>>,
    ])
    setLoading(false)
    if (!changesResponse.ok || !changesResponse.data) {
      setError(changesResponse.message || '加载研究增量失败')
      return
    }
    setItems(changesResponse.data.items)
    if (snapshotsResponse.ok && snapshotsResponse.data) {
      setLatestSnapshot(snapshotsResponse.data.items[0] ?? null)
      setSnapshotCount(snapshotsResponse.data.total)
      onSnapshotCountChange?.(snapshotsResponse.data.total)
    }
  }, [onSnapshotCountChange, project.id])

  useEffect(() => { void load() }, [load, refreshToken])

  const visibleItems = useMemo(() => {
    const latestBatchId = items[0]?.batchId
    return latestBatchId ? items.filter((item) => item.batchId === latestBatchId) : []
  }, [items])
  const olderCount = Math.max(0, items.length - visibleItems.length)
  const pendingCount = visibleItems.filter(canResolveChangeSet).length
  const sourceSessionId = visibleItems.find((item) => item.sourceSessionId != null)?.sourceSessionId ?? null

  const resolveSimple = async (item: ResearchChangeSetSummary, action: 'reject' | 'defer') => {
    setResolvingId(item.id)
    setError(null)
    setNotice(null)
    const response = await window.api.industryResearch.resolveChangeSets({
      requestId: crypto.randomUUID(),
      batchId: item.batchId,
      changeSetIds: [item.id],
      action,
    }) as IndustryResearchResponse<ResearchChangeResolveResult>
    setResolvingId(null)
    if (!response.ok) {
      setError(response.message || '处理研究增量失败')
      return
    }
    setNotice(action === 'defer' ? '该变更包已暂存，不会形成全局待办。' : '该变更包已忽略。')
    await load()
  }

  const openResolve = async (item: ResearchChangeSetSummary) => {
    setResolveItem(item)
    setCandidates([])
    setLoadingCandidates(true)
    setError(null)
    try {
      setCandidates(await loadAllResearchChangeCandidates(item.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取底层候选失败')
    } finally {
      setLoadingCandidates(false)
    }
  }

  const accept = async (submission: ResolveDialogSubmission) => {
    if (!resolveItem) return
    setResolvingId(resolveItem.id)
    setError(null)
    setNotice(null)
    const response = await window.api.industryResearch.resolveChangeSets({
      requestId: crypto.randomUUID(),
      batchId: resolveItem.batchId,
      changeSetIds: [resolveItem.id],
      action: 'accept',
      target: submission.target,
      userEdits: [{ changeSetId: resolveItem.id, title: submission.title, summary: submission.summary }],
      expectedGraphUpdatedAt: project.graph_updated_at,
      expectedSnapshotId: latestSnapshot?.id ?? null,
      factConfirmations: submission.factConfirmations,
    }) as IndustryResearchResponse<ResearchChangeResolveResult>
    setResolvingId(null)
    if (!response.ok || !response.data) {
      setError(response.message || '写入产业研究失败')
      return
    }
    setResolveItem(null)
    setNotice(`已原子写入 ${response.data.appliedSummary.length} 项研究变化，并生成不可变版本。`)
    await load()
    onChanged()
  }

  return (
    <div data-testid="industry-research-change-sets" className="space-y-4">
      <section className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-semibold">研究增量</h3>
          <p className="mt-1 text-xs text-slate-500">{visibleItems.length > 0 ? `本批 ${visibleItems.length} 个语义变更包 · ${pendingCount} 个待处理` : '当前项目没有待处理的讨论增量'}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sourceSessionId != null && <button type="button" onClick={() => onOpenDiscussion(sourceSessionId)} className="rounded-md border border-cyan-200 px-3 py-1.5 text-xs font-semibold text-cyan-700 hover:bg-cyan-50 dark:border-cyan-800 dark:text-cyan-300 dark:hover:bg-cyan-950/20">返回来源讨论</button>}
          <button type="button" onClick={onOpenSnapshots} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">研究版本{snapshotCount ? ` (${snapshotCount})` : ''}</button>
          <button type="button" onClick={onImportArchive} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-500 dark:border-slate-700">高级导入</button>
        </div>
      </section>
      {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300"><span>{error}</span><button type="button" onClick={() => { void load() }} className="font-semibold underline">重试</button></div>}
      {notice && <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">{notice}</div>}
      {loading && <div className="py-10 text-center text-sm text-slate-500">加载研究增量中…</div>}
      {!loading && visibleItems.length === 0 && (
        <div className="border-y border-slate-200 py-10 text-center dark:border-slate-800">
          <p className="text-sm font-medium">讨论整理后的变化会显示在这里</p>
          <p className="mt-1 text-xs text-slate-500">日常入口仍是从当前项目继续讨论；只有显式整理才会生成变更包。</p>
        </div>
      )}
      {!loading && visibleItems.length > 0 && (
        <div className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {visibleItems.map((item) => (
            <article key={item.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500"><span>{changeSetActionLabel(item.action)}</span><span>{riskLabel(item.risk)}</span><span>{changeSetStatusLabel(item.status)}</span><span>{item.candidateCount} 项底层变化</span></div>
                  <h4 className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{item.title}</h4>
                  <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{item.summary}</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">影响：{item.impact}</p>
                  {(item.requiresExpandedReview || item.risk === 'high') ? (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300"><strong>可信边界：</strong>{item.confidenceBoundary}{item.evidenceSummary.length > 0 && <p className="mt-1">依据：{item.evidenceSummary.join('；')}</p>}</div>
                  ) : <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">可信边界：{item.confidenceBoundary}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <button type="button" onClick={() => setAuditItem(item)} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs dark:border-slate-700">高级审计</button>
                  {canResolveChangeSet(item) && <>
                    <button type="button" onClick={() => { void openResolve(item) }} disabled={Boolean(resolvingId)} className="rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900">检查并接受</button>
                    <button type="button" onClick={() => { void resolveSimple(item, 'defer') }} disabled={Boolean(resolvingId)} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700">暂存</button>
                    <button type="button" onClick={() => { void resolveSimple(item, 'reject') }} disabled={Boolean(resolvingId)} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-500 disabled:opacity-40 dark:border-slate-700">忽略</button>
                  </>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {olderCount > 0 && <p className="text-xs text-slate-500">另有 {olderCount} 个较早批次变更包；已接受结果可在研究版本中追溯。</p>}
      <ResearchDiscussionResolveDialog
        item={resolveItem}
        projectId={project.id}
        projectTitle={project.title}
        candidates={candidates}
        loadingCandidates={loadingCandidates}
        submitting={resolveItem != null && resolvingId === resolveItem.id}
        error={resolveItem ? error : null}
        onClose={() => { if (!resolvingId) setResolveItem(null) }}
        onSubmit={(submission) => { void accept(submission) }}
      />
      <ResearchCandidateAuditDialog item={auditItem} onClose={() => setAuditItem(null)} />
    </div>
  )
}
