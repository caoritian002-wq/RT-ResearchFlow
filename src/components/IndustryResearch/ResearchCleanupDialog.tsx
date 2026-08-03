import React, { useEffect, useMemo, useState } from 'react'
import { formatResearchDate } from './industryResearchModel'
import type { IndustryResearchResponse, ResearchProject } from './industryResearchTypes'
import { ResearchConfirmDialog, type ResearchConfirmRequest } from './ResearchConfirmDialog'

interface Props {
  open: boolean
  onClose: () => void
  onChanged: (deletedIds: string[]) => void
}

type FilterMode = 'all' | 'draft' | 'archived' | 'active'

const FILTER_LABEL: Record<FilterMode, string> = {
  all: '全部',
  draft: '草稿',
  archived: '已归档',
  active: '研究中/待复核',
}

function responseError(response: IndustryResearchResponse<unknown>): string {
  return response.message || response.code || '清理失败'
}

export function ResearchCleanupDialog({ open, onClose, onChanged }: Props): React.ReactElement | null {
  const [items, setItems] = useState<ResearchProject[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterMode>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmAllText, setConfirmAllText] = useState('')
  const [confirmRequest, setConfirmRequest] = useState<ResearchConfirmRequest | null>(null)
  const [pendingAction, setPendingAction] = useState<'selected' | 'all' | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const response = await window.api.industryResearch.listProjects({
      limit: 200,
      includeArchived: true,
    }) as IndustryResearchResponse<{ items: ResearchProject[]; total: number }>
    setLoading(false)
    if (!response.ok || !response.data) {
      setError(responseError(response))
      return
    }
    setItems(response.data.items)
    setSelected(new Set())
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  const visible = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'draft') return items.filter((item) => item.status === 'draft')
    if (filter === 'archived') return items.filter((item) => item.status === 'archived')
    return items.filter((item) => item.status === 'active' || item.status === 'review_due')
  }, [filter, items])

  if (!open) return null

  const toggle = (projectId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    })
  }

  const toggleAllVisible = () => {
    const ids = visible.map((item) => item.id)
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
    setSelected((current) => {
      const next = new Set(current)
      if (allSelected) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  const askDeleteSelected = () => {
    const projectIds = Array.from(selected)
    if (!projectIds.length) return
    setError(null)
    setPendingAction('selected')
    setConfirmRequest({
      title: '删除所选研究项目',
      description: `确认永久删除选中的 ${projectIds.length} 个研究项目？此操作不可恢复。`,
      details: [
        '将删除项目级图谱、证据、假设、生成运行和候选',
        '共享公司、证券与财务事实会保留',
      ],
      confirmLabel: '永久删除',
      tone: 'danger',
    })
  }

  const askDeleteAll = () => {
    if (confirmAllText.trim() !== '删除全部') {
      setError('请输入确认词：删除全部')
      return
    }
    setError(null)
    setPendingAction('all')
    setConfirmRequest({
      title: '清空全部产业研究',
      description: '将永久清空全部产业研究项目。共享公司与财务事实不会删除。',
      details: [
        '此操作不可恢复',
        '请确认当前没有仍需保留的研究草稿',
      ],
      confirmLabel: '清空全部',
      tone: 'danger',
    })
  }

  const executePending = async () => {
    if (!pendingAction) return
    setSaving(true)
    setError(null)
    const response = pendingAction === 'all'
      ? await window.api.industryResearch.purgeProjects({ all: true }) as IndustryResearchResponse<{ deletedIds: string[]; deletedCount: number }>
      : await window.api.industryResearch.purgeProjects({ projectIds: Array.from(selected) }) as IndustryResearchResponse<{ deletedIds: string[]; deletedCount: number }>
    setSaving(false)
    if (!response.ok || !response.data) {
      setError(responseError(response))
      return
    }
    setConfirmRequest(null)
    setPendingAction(null)
    if (pendingAction === 'all') setConfirmAllText('')
    onChanged(response.data.deletedIds)
    await load()
  }

  return (
    <>
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4">
        <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
            <div>
              <h2 className="text-base font-semibold">清理产业研究</h2>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                永久删除项目级图谱、证据、假设、生成运行和候选。共享公司、证券与财务事实会保留。
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs dark:border-slate-700">关闭</button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
            {(Object.keys(FILTER_LABEL) as FilterMode[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-md px-2.5 py-1 text-xs ${filter === key ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
              >
                {FILTER_LABEL[key]}
              </button>
            ))}
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={() => void load()} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs dark:border-slate-700">刷新</button>
              <button type="button" onClick={toggleAllVisible} className="rounded-md border border-slate-300 px-2.5 py-1 text-xs dark:border-slate-700">
                {visible.length > 0 && visible.every((item) => selected.has(item.id)) ? '取消全选' : '全选当前'}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {loading && <div className="py-10 text-center text-sm text-slate-400">正在读取项目…</div>}
            {!loading && !visible.length && <div className="py-10 text-center text-sm text-slate-400">当前筛选下没有项目。</div>}
            <div className="space-y-2">
              {visible.map((item) => (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-950/40"
                >
                  <input type="checkbox" className="mt-1" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="truncate text-sm font-medium">{item.title}</div>
                      <span className="shrink-0 text-[10px] text-slate-400">{item.status}</span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-slate-500">
                      {item.industry_name} · {item.product_scope} · 更新 {formatResearchDate(item.updated_at)}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">{error}</div>}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={saving || selected.size === 0}
                onClick={askDeleteSelected}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
              >
                删除所选（{selected.size}）
              </button>
              <div className="ml-auto flex items-center gap-2">
                <input
                  value={confirmAllText}
                  onChange={(event) => setConfirmAllText(event.target.value)}
                  placeholder="输入：删除全部"
                  className="h-8 w-36 rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                />
                <button
                  type="button"
                  disabled={saving || items.length === 0}
                  onClick={askDeleteAll}
                  className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600 disabled:opacity-40 dark:border-red-800"
                >
                  清空全部
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ResearchConfirmDialog
        open={Boolean(confirmRequest)}
        request={confirmRequest}
        saving={saving}
        error={error}
        onCancel={() => {
          if (saving) return
          setConfirmRequest(null)
          setPendingAction(null)
        }}
        onConfirm={() => void executePending()}
      />
    </>
  )
}