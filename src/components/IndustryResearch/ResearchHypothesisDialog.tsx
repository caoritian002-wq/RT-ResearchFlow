import React, { useState } from 'react'
import { validateHypothesisDraft } from './industryResearchModel'
import type { ResearchHypothesisDraft } from './industryResearchTypes'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'

interface Props { saving: boolean; error: string | null; onClose: () => void; onSubmit: (draft: ResearchHypothesisDraft) => void }

export function ResearchHypothesisDialog({ saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [draft, setDraft] = useState<ResearchHypothesisDraft>({ statement: '', importance: 3, cheapestDisproof: '', verificationMetric: '', threshold: '' })
  const set = <K extends keyof ResearchHypothesisDraft>(key: K, value: ResearchHypothesisDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const gateError = validateHypothesisDraft(draft)
  return <DialogFrame title="新增可证伪假设" onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (!gateError) onSubmit(draft) }} className="space-y-3">
    <Field label="假设陈述"><textarea value={draft.statement} onChange={event => set('statement', event.target.value)} className="research-input min-h-24 resize-y py-2" placeholder="写出可被事实推翻的完整陈述" /></Field>
    <Field label="最低成本反证"><textarea value={draft.cheapestDisproof} onChange={event => set('cheapestDisproof', event.target.value)} className="research-input min-h-20 resize-y py-2" placeholder="最少查哪项数据，就能否定这个假设？" /></Field>
    <div className="grid grid-cols-3 gap-3"><Field label="重要性"><input type="number" min={1} max={5} value={draft.importance} onChange={event => set('importance', Number(event.target.value))} className="research-input" /></Field><Field label="验证指标"><input value={draft.verificationMetric} onChange={event => set('verificationMetric', event.target.value)} className="research-input" /></Field><Field label="证伪阈值"><input value={draft.threshold} onChange={event => set('threshold', event.target.value)} className="research-input" /></Field></div>
    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">假设创建后保留只追加状态事件。弱化、证伪和重开都必须填写原因。</div>
    {(gateError || error) && <div className="text-xs text-red-600 dark:text-red-300">{error || gateError}</div>}
    <DialogActions saving={saving} valid={!gateError} onClose={onClose} submitLabel="保存假设" />
  </form></DialogFrame>
}