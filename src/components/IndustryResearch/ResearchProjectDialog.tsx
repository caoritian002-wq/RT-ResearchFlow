import React, { useState } from 'react'
import type { ResearchCreateDraft, ResearchProject } from './industryResearchTypes'

interface Props {
  project?: ResearchProject | null
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ResearchCreateDraft) => void
}

export function ResearchProjectDialog({ project, saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [draft, setDraft] = useState<ResearchCreateDraft>({
    title: project?.title ?? '', industryName: project?.industry_name ?? '', productScope: project?.product_scope ?? '',
    regionScope: project?.region_scope ?? '中国', timeScope: project?.time_scope ?? '近三年', purpose: project?.purpose ?? 'investment',
    depth: project?.depth ?? 'standard', sourceType: 'manual', stopCondition: project?.stop_condition ?? '',
  })
  const valid = draft.title.trim() && draft.industryName.trim() && draft.productScope.trim() && draft.regionScope.trim() && draft.timeScope.trim()
  const set = <K extends keyof ResearchCreateDraft>(key: K, value: ResearchCreateDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  return (
    <DialogFrame title={project ? '编辑研究边界' : '新建产业研究'} onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(draft) }} className="space-y-3">
        <Field label="项目标题"><input value={draft.title} onChange={event => set('title', event.target.value)} className="research-input" maxLength={200} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="产业"><input value={draft.industryName} onChange={event => set('industryName', event.target.value)} className="research-input" maxLength={120} /></Field><Field label="产品范围"><input value={draft.productScope} onChange={event => set('productScope', event.target.value)} className="research-input" maxLength={500} /></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label="区域范围"><input value={draft.regionScope} onChange={event => set('regionScope', event.target.value)} className="research-input" maxLength={200} /></Field><Field label="时间范围"><input value={draft.timeScope} onChange={event => set('timeScope', event.target.value)} className="research-input" maxLength={200} /></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label="研究目的"><select value={draft.purpose} onChange={event => set('purpose', event.target.value as ResearchCreateDraft['purpose'])} className="research-input"><option value="investment">投资研究</option><option value="strategy">战略研究</option><option value="learning">知识学习</option></select></Field><Field label="研究深度"><select value={draft.depth} onChange={event => set('depth', event.target.value as ResearchCreateDraft['depth'])} className="research-input"><option value="quick">快速</option><option value="standard">标准</option><option value="deep">深度</option></select></Field></div>
        <Field label="停止条件"><textarea value={draft.stopCondition} onChange={event => set('stopCondition', event.target.value)} className="research-input min-h-16 resize-y py-2" maxLength={1000} placeholder="例如：关键成本与需求假设均有可反证指标" /></Field>
        <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-300">边界变化会将项目标记为待复核，已有事实不会被自动改写。</div>
        {error && <div className="text-xs text-red-600 dark:text-red-300">{error}</div>}
        <DialogActions saving={saving} valid={Boolean(valid)} onClose={onClose} submitLabel={project ? '保存边界' : '创建项目'} />
      </form>
    </DialogFrame>
  )
}

export function DialogFrame({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  return <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/45 p-4" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><div role="dialog" aria-modal="true" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-md border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"><header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800"><h2 className="text-base font-semibold">{title}</h2><button type="button" onClick={onClose} aria-label="关闭" className="text-xl leading-none text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">×</button></header><div className="p-4">{children}</div></div></div>
}

export function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return <label className="block"><span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span>{children}</label>
}

export function DialogActions({ saving, valid, onClose, submitLabel }: { saving: boolean; valid: boolean; onClose: () => void; submitLabel: string }): React.ReactElement {
  return <div className="flex justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800"><button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700">取消</button><button type="submit" disabled={saving || !valid} className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">{saving ? '保存中' : submitLabel}</button></div>
}