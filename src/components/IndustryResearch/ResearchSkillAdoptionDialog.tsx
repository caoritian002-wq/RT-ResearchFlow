import React, { useState } from 'react'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'
import type { ResearchDecisionWorkbenchData } from './industryResearchTypes'

export function ResearchSkillAdoptionDialog({ adoption, saving, error, onClose, onSubmit }: {
  adoption: ResearchDecisionWorkbenchData['skillAdoption']
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (note: string) => void
}): React.ReactElement {
  const [note, setNote] = useState('按新规则复核研究边界、情景与决策，不自动改变既有事实。')
  const diff = adoption.diff
  return <DialogFrame title="采用当前研究规则" onClose={saving ? () => undefined : onClose}>
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (note.trim()) onSubmit(note) }}>
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="border-l-2 border-emerald-500 pl-3">新增 {diff?.added.length ?? 0}</div>
        <div className="border-l-2 border-amber-500 pl-3">变化 {diff?.changed.length ?? 0}</div>
        <div className="border-l-2 border-slate-400 pl-3">移除 {diff?.removed.length ?? 0}</div>
      </div>
      {(diff?.changed.length ?? 0) > 0 && <div className="max-h-40 overflow-y-auto border-y border-slate-200 py-2 text-xs dark:border-slate-700">{diff!.changed.map((item) => <div key={item} className="py-1">{item}</div>)}</div>}
      <Field label="迁移说明"><textarea value={note} onChange={(event) => setNote(event.target.value)} className="research-input min-h-24 resize-y py-2" maxLength={4000} /></Field>
      {error && <div role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</div>}
      <DialogActions saving={saving} valid={Boolean(note.trim() && adoption.current)} onClose={onClose} submitLabel="采用并生成分组复核" />
    </form>
  </DialogFrame>
}
