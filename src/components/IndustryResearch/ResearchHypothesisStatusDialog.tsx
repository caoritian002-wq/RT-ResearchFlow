import React, { useState } from 'react'
import type { HypothesisStatus, ResearchHypothesis } from './industryResearchTypes'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'

interface Props {
  hypothesis: ResearchHypothesis
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (status: HypothesisStatus, reason: string) => void
}

export function ResearchHypothesisStatusDialog({ hypothesis, saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [status, setStatus] = useState<HypothesisStatus>(hypothesis.status === 'refuted' ? 'reopened' : 'weakened')
  const [reason, setReason] = useState('')
  return <DialogFrame title="更新假设状态" onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (reason.trim()) onSubmit(status, reason.trim()) }} className="space-y-3">
    <div className="rounded-md border border-slate-200 p-3 text-sm leading-6 dark:border-slate-700">{hypothesis.statement}</div>
    <Field label="目标状态"><select value={status} onChange={event => setStatus(event.target.value as HypothesisStatus)} className="research-input"><option value="supported">暂获支持</option><option value="weakened">弱化</option><option value="refuted">证伪</option><option value="reopened">重开</option></select></Field>
    <Field label="变化原因"><textarea value={reason} onChange={event => setReason(event.target.value)} className="research-input min-h-24 resize-y py-2" placeholder="说明触发状态变化的事实或证据缺口" /></Field>
    <div className="text-xs leading-5 text-slate-500">状态事件只追加保存，不覆盖历史。关联证据可在证据账本中继续补充。</div>
    {error && <div className="text-xs text-red-600 dark:text-red-300">{error}</div>}
    <DialogActions saving={saving} valid={Boolean(reason.trim())} onClose={onClose} submitLabel="记录状态变化" />
  </form></DialogFrame>
}