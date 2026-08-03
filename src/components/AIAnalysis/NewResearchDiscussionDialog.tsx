import { useEffect, useState } from 'react'
import type { ResearchApiResponse } from '../ResearchDiscussion/researchDiscussionTypes'

interface ProjectOption { id: string; title: string }

interface Props {
  open: boolean
  submitting?: boolean
  error?: string | null
  onClose: () => void
  onSubmit: (value: { question: string; projectId: string | null }) => void
}

export function NewResearchDiscussionDialog({ open, submitting = false, error, onClose, onSubmit }: Props) {
  const [question, setQuestion] = useState('')
  const [projectId, setProjectId] = useState('')
  const [projects, setProjects] = useState<ProjectOption[]>([])

  useEffect(() => {
    if (!open) return
    void (async () => {
      const response = await window.api.industryResearch.listProjects({ limit: 200 }) as ResearchApiResponse<{ items: ProjectOption[] }>
      if (response.ok && response.data) setProjects(response.data.items)
    })()
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-[10010] flex items-center justify-center bg-slate-950/55 p-4" role="dialog" aria-modal="true" aria-labelledby="new-discussion-title">
      <form
        className="w-full max-w-xl rounded-lg bg-white shadow-2xl dark:bg-slate-950"
        onSubmit={(event) => { event.preventDefault(); if (question.trim()) onSubmit({ question: question.trim(), projectId: projectId || null }) }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div><div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">Research Discussion</div><h2 id="new-discussion-title" className="mt-1 text-lg font-semibold">发起研究讨论</h2></div>
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">关闭</button>
        </header>
        <div className="space-y-4 px-5 py-4">
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
          <label className="block text-sm font-medium">研究问题
            <textarea autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} rows={5} maxLength={4000} className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-200 dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <label className="block text-sm font-medium">关联产业研究
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">
              <option value="">暂不关联</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
            </select>
          </label>
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
          <button type="button" onClick={onClose} disabled={submitting} className="rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700">取消</button>
          <button type="submit" data-testid="new-research-discussion-submit" disabled={!question.trim() || submitting} className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{submitting ? '创建中…' : '开始讨论'}</button>
        </footer>
      </form>
    </div>
  )
}

