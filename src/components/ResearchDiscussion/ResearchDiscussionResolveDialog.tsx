import { useEffect, useState } from 'react'
import type { ResearchChangeCandidate, ResearchChangeSetSummary } from './researchDiscussionTypes'

const AUDIT_PAGE_SIZE = 20

export interface ResolveDialogSubmission {
  title: string
  summary: string
  target:
    | { mode: 'existing'; projectId: string }
    | { mode: 'create'; project: { title: string; industry: string; product: string; region: string; timeHorizon: string; purpose: 'learning' | 'strategy' | 'investment'; depth: 'quick' | 'standard' | 'deep' } }
  factConfirmations: Array<{ candidateId: string; primarySourceConfirmed: true; confirmedBy: 'human'; originalSourceUrl: string }>
}

interface Props {
  item: ResearchChangeSetSummary | null
  projectId: string | null
  projectTitle: string | null
  candidates: ResearchChangeCandidate[]
  loadingCandidates?: boolean
  submitting?: boolean
  error?: string | null
  onClose: () => void
  onSubmit: (submission: ResolveDialogSubmission) => void
}

export function ResearchDiscussionResolveDialog({
  item,
  projectId,
  projectTitle,
  candidates,
  loadingCandidates = false,
  submitting = false,
  error,
  onClose,
  onSubmit,
}: Props) {
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [project, setProject] = useState({ title: '', industry: '', product: '', region: '中国', timeHorizon: '未来 1-3 年' })
  const [sourceUrls, setSourceUrls] = useState<Record<string, string>>({})
  const [auditPage, setAuditPage] = useState(0)

  useEffect(() => {
    if (!item) return
    setTitle(item.title)
    setSummary(item.summary)
    setProject((current) => ({ ...current, title: item.title.replace(/新增|修正|增强|弱化|证伪|回访/g, '').trim() || '产业研究草稿' }))
    setSourceUrls({})
    setAuditPage(0)
  }, [item])

  if (!item) return null
  const factCandidates = candidates.filter((candidate) => candidate.statementType === 'fact')
  const auditPageCount = Math.max(1, Math.ceil(candidates.length / AUDIT_PAGE_SIZE))
  const visibleCandidates = candidates.slice(auditPage * AUDIT_PAGE_SIZE, (auditPage + 1) * AUDIT_PAGE_SIZE)
  const canSubmit = Boolean(title.trim() && summary.trim())
    && (projectId != null || Boolean(project.title.trim() && project.industry.trim() && project.product.trim() && project.region.trim() && project.timeHorizon.trim()))
    && factCandidates.every((candidate) => /^https?:\/\//i.test(sourceUrls[candidate.id]?.trim() || ''))

  return (
    <div className="fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/55 p-4" role="dialog" aria-modal="true" aria-labelledby="resolve-change-title">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-slate-950">
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">接受研究增量</div>
            <h2 id="resolve-change-title" className="mt-1 text-lg font-semibold">检查写入内容</h2>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-slate-700">关闭</button>
        </header>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
          <label className="block text-sm font-medium">变更包标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-200 dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="block text-sm font-medium">变更摘要
            <textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={4} className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-200 dark:border-slate-700 dark:bg-slate-900" />
          </label>
          {projectId ? (
            <div className="border-y border-slate-200 py-3 text-sm dark:border-slate-800">
              <div className="text-xs text-slate-500">写入项目</div>
              <div className="mt-1 font-medium">{projectTitle || projectId}</div>
            </div>
          ) : (
            <fieldset className="space-y-3 border-y border-slate-200 py-4 dark:border-slate-800">
              <legend className="text-sm font-semibold">创建研究草稿</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {([
                  ['title', '项目名称'], ['industry', '产业'], ['product', '产品范围'],
                  ['region', '区域'], ['timeHorizon', '时间范围'],
                ] as const).map(([key, label]) => (
                  <label key={key} className={key === 'product' ? 'text-xs sm:col-span-2' : 'text-xs'}>{label}
                    <input value={project[key]} onChange={(event) => setProject((current) => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {loadingCandidates && <div className="py-4 text-center text-sm text-slate-500">正在读取底层候选…</div>}
          {!loadingCandidates && candidates.length > 0 && (
            <details open={item.requiresExpandedReview} className="border-y border-slate-200 py-3 dark:border-slate-800">
              <summary className="cursor-pointer text-sm font-semibold">高级审计 · {candidates.length} 项</summary>
              <div className="mt-3 max-h-64 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
                {visibleCandidates.map((candidate) => (
                  <div key={candidate.id} className="py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2"><strong>{candidate.kind}</strong><span>{candidate.statementType}</span><span className="text-slate-400">{candidate.sourceLocator}</span></div>
                    {candidate.warnings.map((warning) => <p key={warning} className="mt-1 text-amber-700 dark:text-amber-300">{warning}</p>)}
                    {candidate.conflicts.map((conflict) => <p key={conflict} className="mt-1 text-red-700 dark:text-red-300">{conflict}</p>)}
                    {candidate.statementType === 'fact' && (
                      <label className="mt-2 block font-medium">确认该窄事实的一级来源 URL
                        <input value={sourceUrls[candidate.id] ?? ''} onChange={(event) => setSourceUrls((current) => ({ ...current, [candidate.id]: event.target.value }))} placeholder="https://" className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 dark:border-slate-700 dark:bg-slate-900" />
                      </label>
                    )}
                  </div>
                ))}
              </div>
              {candidates.length > AUDIT_PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                  <span>第 {auditPage + 1} / {auditPageCount} 页</span>
                  <div className="flex gap-2">
                    <button type="button" disabled={auditPage === 0} onClick={() => setAuditPage((value) => Math.max(0, value - 1))} className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40 dark:border-slate-700">上一页</button>
                    <button type="button" disabled={auditPage + 1 >= auditPageCount} onClick={() => setAuditPage((value) => Math.min(auditPageCount - 1, value + 1))} className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40 dark:border-slate-700">下一页</button>
                  </div>
                </div>
              )}
            </details>
          )}
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-md border border-slate-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-slate-700">取消</button>
          <button
            type="button"
            data-testid="research-change-accept-submit"
            disabled={!canSubmit || submitting}
            onClick={() => onSubmit({
              title: title.trim(),
              summary: summary.trim(),
              target: projectId
                ? { mode: 'existing', projectId }
                : { mode: 'create', project: { ...project, title: project.title.trim(), industry: project.industry.trim(), product: project.product.trim(), region: project.region.trim(), timeHorizon: project.timeHorizon.trim(), purpose: 'investment', depth: 'standard' } },
              factConfirmations: factCandidates.map((candidate) => ({ candidateId: candidate.id, primarySourceConfirmed: true, confirmedBy: 'human', originalSourceUrl: sourceUrls[candidate.id].trim() })),
            })}
            className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-40"
          >{submitting ? '写入中…' : '接受并写入研究'}</button>
        </footer>
      </div>
    </div>
  )
}
