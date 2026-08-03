import React, { useState } from 'react'
import type { DisclosureEvidence, DisclosureEvidenceDraft } from './industryResearchTypes'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'

interface Props {
  evidence?: DisclosureEvidence | null
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: DisclosureEvidenceDraft) => void
}

export function ResearchDisclosureEvidenceDialog({ evidence, saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [draft, setDraft] = useState<DisclosureEvidenceDraft>({
    id: evidence?.id ?? `disclosure:${crypto.randomUUID()}`,
    title: evidence?.title ?? '', sourceUrl: evidence?.sourceUrl ?? '', publishedDate: evidence?.publishedDate ?? '',
    actualPublishedDate: evidence?.actualPublishedDate ?? '', excerpt: evidence?.excerpt ?? '',
    primarySourceConfirmed: evidence?.primarySourceConfirmed ?? false,
  })
  const set = <K extends keyof DisclosureEvidenceDraft>(key: K, value: DisclosureEvidenceDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const validUrl = /^https?:\/\//i.test(draft.sourceUrl.trim())
  const valid = Boolean(draft.title.trim() && validUrl && draft.primarySourceConfirmed)
  return <DialogFrame title={evidence ? '维护公告证据' : '登记官方公告证据'} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (valid) onSubmit(draft) }} className="space-y-3">
      <Field label="公告标题"><input value={draft.title} onChange={event => set('title', event.target.value)} className="research-input" maxLength={300} /></Field>
      <Field label="官方原文网址"><input type="url" value={draft.sourceUrl} onChange={event => set('sourceUrl', event.target.value)} className="research-input" placeholder="https://" maxLength={2000} /></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="公告日期"><input type="date" value={draft.publishedDate} onChange={event => set('publishedDate', event.target.value)} className="research-input" /></Field><Field label="实际披露日期"><input type="date" value={draft.actualPublishedDate} onChange={event => set('actualPublishedDate', event.target.value)} className="research-input" /></Field></div>
      <Field label="事实摘录"><textarea value={draft.excerpt} onChange={event => set('excerpt', event.target.value)} className="research-input min-h-24 resize-y py-2" maxLength={5000} /></Field>
      <label className="flex items-start gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs leading-5 dark:border-slate-700"><input type="checkbox" checked={draft.primarySourceConfirmed} onChange={event => set('primarySourceConfirmed', event.target.checked)} className="mt-1" /><span>我已人工打开并确认该网址是当前公司的官方原文。应用只保存链接和人工摘录，不抓取或保存公告全文。</span></label>
      {!validUrl && draft.sourceUrl && <div className="text-xs text-amber-700 dark:text-amber-300">只接受 HTTP 或 HTTPS 官方链接。</div>}
      {error && <div className="text-xs text-red-600 dark:text-red-300">{error}</div>}
      <DialogActions saving={saving} valid={valid} onClose={onClose} submitLabel="保存公告证据" />
    </form>
  </DialogFrame>
}