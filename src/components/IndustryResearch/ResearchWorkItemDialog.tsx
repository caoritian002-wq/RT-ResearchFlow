import React, { useState } from 'react'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'
import type { ResearchWorkItem } from './industryResearchTypes'

export interface ResearchWorkItemSaveDraft {
  workItemId: string
  expectedVersion: number
  question: string
  effort: ResearchWorkItem['effort']
  conclusionSensitivity: 'low' | 'medium' | 'high'
  evidenceUncertainty: 'low' | 'medium' | 'high'
  changeVelocity: 'low' | 'medium' | 'high'
  stopReason: string | null
  nextTriggerMetric: string | null
  affectedObjectIds: string[]
  status: ResearchWorkItem['status']
}

export function ResearchWorkItemDialog({ item, saving, error, onClose, onSubmit }: {
  item?: ResearchWorkItem | null
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ResearchWorkItemSaveDraft) => void
}): React.ReactElement {
  const [question, setQuestion] = useState(item?.question ?? '')
  const [effort, setEffort] = useState<ResearchWorkItem['effort']>(item?.effort ?? 'standard_validation')
  const [sensitivity, setSensitivity] = useState<'low' | 'medium' | 'high'>(item?.conclusionSensitivity ?? 'medium')
  const [uncertainty, setUncertainty] = useState<'low' | 'medium' | 'high'>(item?.evidenceUncertainty ?? 'medium')
  const [velocity, setVelocity] = useState<'low' | 'medium' | 'high'>(item?.changeVelocity ?? 'medium')
  const [status, setStatus] = useState<ResearchWorkItem['status']>(item?.status ?? 'open')
  const [stopReason, setStopReason] = useState(item?.stopReason ?? '')
  const [nextTrigger, setNextTrigger] = useState(item?.nextTriggerMetric ?? '')
  const valid = question.trim() && (status !== 'stopped' || stopReason.trim() || nextTrigger.trim())
  return <DialogFrame title={item ? '更新研究工作项' : '新增研究工作项'} onClose={saving ? () => undefined : onClose}>
    <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault()
      if (!valid) return
      onSubmit({
        workItemId: item?.id ?? crypto.randomUUID(), expectedVersion: item?.version ?? 0,
        question, effort, conclusionSensitivity: sensitivity, evidenceUncertainty: uncertainty,
        changeVelocity: velocity, stopReason: stopReason.trim() || null,
        nextTriggerMetric: nextTrigger.trim() || null, affectedObjectIds: item?.affectedObjectIds ?? [], status,
      })
    }}>
      <Field label="研究问题"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} className="research-input min-h-24 resize-y py-2" maxLength={4000} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="投入级别"><select value={effort} onChange={(event) => setEffort(event.target.value as ResearchWorkItem['effort'])} className="research-input"><option value="quick_pass">快速通过</option><option value="standard_validation">标准验证</option><option value="deep_research">深度研究</option></select></Field>
        <Field label="状态"><select value={status} onChange={(event) => setStatus(event.target.value as ResearchWorkItem['status'])} className="research-input"><option value="open">进行中</option><option value="blocked">受阻</option><option value="completed">已完成</option><option value="stopped">停止扩展</option></select></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['结论敏感度', sensitivity, setSensitivity],
          ['证据不确定性', uncertainty, setUncertainty],
          ['变化速度', velocity, setVelocity],
        ].map(([label, value, setter]) => <Field key={String(label)} label={String(label)}><select value={String(value)} onChange={(event) => (setter as React.Dispatch<React.SetStateAction<'low' | 'medium' | 'high'>>)(event.target.value as 'low' | 'medium' | 'high')} className="research-input"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></Field>)}
      </div>
      <Field label="停止理由"><input value={stopReason} onChange={(event) => setStopReason(event.target.value)} className="research-input" maxLength={2000} /></Field>
      <Field label="下一触发指标"><input value={nextTrigger} onChange={(event) => setNextTrigger(event.target.value)} className="research-input" maxLength={500} /></Field>
      {error && <div role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</div>}
      <DialogActions saving={saving} valid={Boolean(valid)} onClose={onClose} submitLabel="保存工作项" />
    </form>
  </DialogFrame>
}
