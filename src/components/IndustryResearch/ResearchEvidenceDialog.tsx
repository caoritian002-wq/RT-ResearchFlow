import React, { useState } from 'react'
import { validateEvidenceDraft } from './industryResearchModel'
import type { ResearchEvidenceDraft } from './industryResearchTypes'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'

interface Props { saving: boolean; error: string | null; onClose: () => void; onSubmit: (draft: ResearchEvidenceDraft) => void }

export function ResearchEvidenceDialog({ saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [draft, setDraft] = useState<ResearchEvidenceDraft>({ title: '', sourceType: 'public_document', sourceName: '', sourceUrl: '', sourceRef: '', factDate: '', statementKind: 'fact', direction: 'support', reliability: 'primary', primarySourceConfirmed: false, conflictNote: '', excerpt: '' })
  const set = <K extends keyof ResearchEvidenceDraft>(key: K, value: ResearchEvidenceDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const gateError = validateEvidenceDraft(draft)
  return <DialogFrame title="添加研究证据" onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!gateError) onSubmit(draft) }} className="space-y-3">
    <div className="grid grid-cols-2 gap-3"><Field label="陈述类型"><select value={draft.statementKind} onChange={event => set('statementKind', event.target.value as ResearchEvidenceDraft['statementKind'])} className="research-input"><option value="fact">事实</option><option value="estimate">估算</option><option value="hypothesis">假设证据</option></select></Field><Field label="证据方向"><select value={draft.direction} onChange={event => set('direction', event.target.value as ResearchEvidenceDraft['direction'])} className="research-input"><option value="support">支持</option><option value="weaken">弱化</option><option value="refute">证伪</option><option value="neutral">中性</option></select></Field></div>
    <Field label="证据标题"><input value={draft.title} onChange={event => set('title', event.target.value)} className="research-input" /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="来源名称"><input value={draft.sourceName} onChange={event => set('sourceName', event.target.value)} className="research-input" /></Field><Field label="事实日期"><input type="date" value={draft.factDate} onChange={event => set('factDate', event.target.value)} className="research-input" /></Field></div>
    <Field label="原始来源网址"><input type="url" value={draft.sourceUrl} onChange={event => set('sourceUrl', event.target.value)} className="research-input" placeholder="https://" /></Field>
    <Field label="来源编号"><input value={draft.sourceRef} onChange={event => set('sourceRef', event.target.value)} className="research-input" placeholder="公告号、报告编号或数据库记录号" /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="来源类型"><input value={draft.sourceType} onChange={event => set('sourceType', event.target.value)} className="research-input" /></Field><Field label="可靠性"><select value={draft.reliability} onChange={event => set('reliability', event.target.value as ResearchEvidenceDraft['reliability'])} className="research-input"><option value="primary">一手</option><option value="secondary">二手</option><option value="tertiary">三手</option><option value="unknown">未知</option></select></Field></div>
    <Field label="事实摘录"><textarea value={draft.excerpt} onChange={event => set('excerpt', event.target.value)} className="research-input min-h-20 resize-y py-2" /></Field>
    <Field label="冲突说明"><textarea value={draft.conflictNote} onChange={event => set('conflictNote', event.target.value)} className="research-input min-h-14 resize-y py-2" /></Field>
    <label className="flex items-start gap-2 rounded-md border border-slate-200 p-3 text-xs leading-5 dark:border-slate-700"><input type="checkbox" checked={draft.primarySourceConfirmed} onChange={event => set('primarySourceConfirmed', event.target.checked)} className="mt-1" /><span>我已人工打开并核对原始来源。只有勾选后，陈述才可保存为事实。</span></label>
    {(gateError || error) && <div className="text-xs text-red-600 dark:text-red-300">{error || gateError}</div>}
    <DialogActions saving={saving} valid={!gateError} onClose={onClose} submitLabel="保存证据" />
  </form></DialogFrame>
}