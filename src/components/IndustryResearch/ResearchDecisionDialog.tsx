import React, { useMemo, useState } from 'react'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'
import { DECISION_ACTION_LABELS } from './industryResearchDecisionModel'
import type {
  ResearchDecisionAction,
  ResearchDecisionItem,
  ResearchEvidence,
  ResearchHypothesis,
  ResearchScenarioSet,
  ResearchWorkItem,
} from './industryResearchTypes'

export interface ResearchDecisionSaveDraft {
  decisionId: string
  expectedLastEventId: string | null
  eventType: ResearchDecisionItem['eventType']
  action: ResearchDecisionAction
  rationale: string
  dataAsOf: string
  valuationDate: string | null
  validUntil: number
  invalidationCondition: string
  scenarioSetVersionId: string | null
  workItemVersionIds: string[]
  factIds: string[]
  evidenceIds: string[]
  hypothesisIds: string[]
  sourceTriggerEvaluationId: string | null
  marketSnapshotId: string | null
  valuationSnapshotId: string | null
}

function today(): string { return new Date().toISOString().slice(0, 10) }
function futureDate(): string { return new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10) }
const ACTION_RANK: Record<ResearchDecisionAction, number> = {
  continue_research: 4,
  wait_financial_validation: 3,
  wait_price: 2,
  monitor: 1,
  exclude: 0,
}

function eventTypeForAction(current: ResearchDecisionItem | null | undefined, action: ResearchDecisionAction): ResearchDecisionItem['eventType'] {
  if (!current) return 'created'
  if (current.action === action) return 'maintained'
  return ACTION_RANK[action] > ACTION_RANK[current.action] ? 'upgraded' : 'downgraded'
}

export function ResearchDecisionDialog({
  current,
  forcedDecisionId,
  forcedAction,
  sourceTriggerEvaluationId,
  scenario,
  workItems,
  evidence,
  hypotheses,
  marketSnapshotId,
  valuationSnapshotId,
  snapshotBlocked,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  current?: ResearchDecisionItem | null
  forcedDecisionId?: string | null
  forcedAction?: ResearchDecisionAction | null
  sourceTriggerEvaluationId?: string | null
  scenario: ResearchScenarioSet | null
  workItems: ResearchWorkItem[]
  evidence: ResearchEvidence[]
  hypotheses: ResearchHypothesis[]
  marketSnapshotId: string | null
  valuationSnapshotId: string | null
  snapshotBlocked: boolean
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ResearchDecisionSaveDraft) => void
}): React.ReactElement {
  const [action, setAction] = useState<ResearchDecisionAction>(forcedAction ?? current?.action ?? 'continue_research')
  const [eventType, setEventType] = useState<ResearchDecisionItem['eventType']>(() => eventTypeForAction(current, forcedAction ?? current?.action ?? 'continue_research'))
  const [rationale, setRationale] = useState(current?.rationale ?? '')
  const [dataAsOf, setDataAsOf] = useState(current?.dataAsOf ?? today())
  const [validUntil, setValidUntil] = useState(current ? new Date(current.validUntil).toISOString().slice(0, 10) : futureDate())
  const [invalidation, setInvalidation] = useState(current?.invalidationCondition ?? '')
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>(current?.evidenceIds ?? (evidence[0] ? [evidence[0].id] : []))
  const [selectedHypotheses, setSelectedHypotheses] = useState<string[]>(current?.hypothesisIds ?? (hypotheses[0] ? [hypotheses[0].id] : []))
  const [selectedWork, setSelectedWork] = useState<string[]>(current?.workItemVersionIds ?? workItems.filter((item) => item.status === 'open').map((item) => item.versionId))
  const waitPriceAllowed = Boolean(marketSnapshotId && valuationSnapshotId && !snapshotBlocked)
  const valid = useMemo(() => rationale.trim() && invalidation.trim() && validUntil
    && (selectedEvidence.length > 0 || selectedHypotheses.length > 0)
    && (action !== 'wait_price' || waitPriceAllowed), [action, invalidation, rationale, selectedEvidence.length, selectedHypotheses.length, validUntil, waitPriceAllowed])
  const toggle = (items: string[], id: string, setter: React.Dispatch<React.SetStateAction<string[]>>) => setter(items.includes(id) ? items.filter((item) => item !== id) : [...items, id])
  return <DialogFrame title={current ? '追加决策事件' : '建立研究决策'} onClose={saving ? () => undefined : onClose}>
    <form className="space-y-4" onSubmit={(event) => {
      event.preventDefault(); if (!valid) return
      onSubmit({
        decisionId: current?.decisionId ?? forcedDecisionId ?? crypto.randomUUID(),
        expectedLastEventId: current?.id ?? null,
        eventType, action, rationale, dataAsOf,
        valuationDate: scenario?.valuationDate ?? null,
        validUntil: new Date(`${validUntil}T23:59:59+08:00`).getTime(), invalidationCondition: invalidation,
        scenarioSetVersionId: scenario?.versionId ?? null, workItemVersionIds: selectedWork,
        factIds: [], evidenceIds: selectedEvidence, hypothesisIds: selectedHypotheses,
        sourceTriggerEvaluationId: sourceTriggerEvaluationId ?? null,
        marketSnapshotId, valuationSnapshotId,
      })
    }}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="研究动作"><select value={action} disabled={Boolean(forcedAction)} onChange={(event) => { const next = event.target.value as ResearchDecisionAction; setAction(next); setEventType(eventTypeForAction(current, next)) }} className="research-input disabled:cursor-not-allowed disabled:opacity-70">{Object.entries(DECISION_ACTION_LABELS).map(([value, label]) => <option key={value} value={value} disabled={value === 'wait_price' && !waitPriceAllowed}>{label}</option>)}</select></Field>
        <Field label="事件类型"><select value={eventType} disabled={!current} onChange={(event) => setEventType(event.target.value as ResearchDecisionItem['eventType'])} className="research-input disabled:cursor-not-allowed disabled:opacity-70"><option value="created">创建</option><option value="maintained">维持</option><option value="upgraded">升级</option><option value="downgraded">降级</option><option value="invalidated">失效</option><option value="closed">关闭</option></select></Field>
        <Field label="数据截至"><input type="date" value={dataAsOf} onChange={(event) => setDataAsOf(event.target.value)} className="research-input" /></Field>
        <Field label="有效期至"><input type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} className="research-input" /></Field>
      </div>
      {forcedAction && <div role="status" className="border-l-2 border-cyan-600 pl-3 text-xs text-slate-600 dark:text-slate-300">本次操作确认触发器提出的“{DECISION_ACTION_LABELS[forcedAction]}”。如需其他动作，请先驳回本次触发复核，再单独追加决策事件。</div>}
      {action === 'wait_price' && !waitPriceAllowed && <div role="status" className="border-l-2 border-amber-500 pl-3 text-xs text-amber-700 dark:text-amber-300">等待价格必须先保存情景并冻结非阻断市场与估值快照。</div>}
      <Field label="决策依据"><textarea value={rationale} onChange={(event) => setRationale(event.target.value)} className="research-input min-h-24 resize-y py-2" maxLength={4000} /></Field>
      <Field label="失效条件"><textarea value={invalidation} onChange={(event) => setInvalidation(event.target.value)} className="research-input min-h-20 resize-y py-2" maxLength={2000} /></Field>
      <fieldset className="border-y border-slate-200 py-3 dark:border-slate-700"><legend className="px-1 text-xs font-medium">关联证据或假设</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">
        {evidence.slice(0, 8).map((item) => <label key={item.id} className="flex min-h-10 items-start gap-2 text-xs"><input type="checkbox" checked={selectedEvidence.includes(item.id)} onChange={() => toggle(selectedEvidence, item.id, setSelectedEvidence)} className="mt-0.5" /><span>{item.title}</span></label>)}
        {hypotheses.slice(0, 8).map((item) => <label key={item.id} className="flex min-h-10 items-start gap-2 text-xs"><input type="checkbox" checked={selectedHypotheses.includes(item.id)} onChange={() => toggle(selectedHypotheses, item.id, setSelectedHypotheses)} className="mt-0.5" /><span>{item.statement}</span></label>)}
      </div></fieldset>
      {workItems.length > 0 && <fieldset><legend className="text-xs font-medium">关联工作项</legend><div className="mt-2 space-y-2">{workItems.map((item) => <label key={item.versionId} className="flex min-h-9 items-start gap-2 text-xs"><input type="checkbox" checked={selectedWork.includes(item.versionId)} onChange={() => toggle(selectedWork, item.versionId, setSelectedWork)} /><span>{item.question}</span></label>)}</div></fieldset>}
      {error && <div role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</div>}
      <DialogActions saving={saving} valid={Boolean(valid)} onClose={onClose} submitLabel={sourceTriggerEvaluationId ? '确认触发并追加决策' : '保存决策事件'} />
    </form>
  </DialogFrame>
}
