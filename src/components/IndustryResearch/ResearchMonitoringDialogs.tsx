import React, { useState } from 'react'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'
import type { ResearchDecisionItem, ResearchDecisionTrigger, ResearchMonitoringItem } from './industryResearchTypes'

export interface MonitoringSaveDraft {
  monitoringItemId: string
  expectedVersion: number
  name: string
  valueKind: ResearchMonitoringItem['valueKind']
  frequency: ResearchMonitoringItem['frequency']
  sourceName: string
  sourceRef: string | null
  unit: string | null
  timingType: ResearchMonitoringItem['timingType']
  staleAfterMs: number
  nextReviewAt: number | null
  hypothesisIds: string[]
  scenarioSetVersionIds: string[]
  decisionIds: string[]
  status: ResearchMonitoringItem['status']
}

export function ResearchMonitoringDialog({ item, decisions, saving, error, onClose, onSubmit }: {
  item?: ResearchMonitoringItem | null
  decisions: ResearchDecisionItem[]
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: MonitoringSaveDraft) => void
}): React.ReactElement {
  const [name, setName] = useState(item?.name ?? '')
  const [valueKind, setValueKind] = useState<ResearchMonitoringItem['valueKind']>(item?.valueKind ?? 'number')
  const [frequency, setFrequency] = useState<ResearchMonitoringItem['frequency']>(item?.frequency ?? 'monthly')
  const [sourceName, setSourceName] = useState(item?.sourceName ?? '')
  const [sourceRef, setSourceRef] = useState(item?.sourceRef ?? '')
  const [unit, setUnit] = useState(item?.unit ?? '')
  const [timing, setTiming] = useState<ResearchMonitoringItem['timingType']>(item?.timingType ?? 'unknown')
  const [staleDays, setStaleDays] = useState(String(Math.round((item?.staleAfterMs ?? 30 * 86400000) / 86400000)))
  const [nextReview, setNextReview] = useState(item?.nextReviewAt ? new Date(item.nextReviewAt).toISOString().slice(0, 10) : '')
  const [decisionId, setDecisionId] = useState('')
  const valid = name.trim() && sourceName.trim() && Number(staleDays) > 0
  return <DialogFrame title={item ? '更新监控项' : '新增监控项'} onClose={saving ? () => undefined : onClose}>
    <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault(); if (!valid) return
      onSubmit({ monitoringItemId: item?.id ?? crypto.randomUUID(), expectedVersion: item?.version ?? 0,
        name, valueKind, frequency, sourceName, sourceRef: sourceRef.trim() || null, unit: unit.trim() || null,
        timingType: timing, staleAfterMs: Number(staleDays) * 86400000,
        nextReviewAt: nextReview ? new Date(`${nextReview}T09:00:00+08:00`).getTime() : null,
        hypothesisIds: [], scenarioSetVersionIds: [], decisionIds: decisionId ? [decisionId] : [], status: item?.status ?? 'active' })
    }}>
      <Field label="监控项名称"><input value={name} onChange={(event) => setName(event.target.value)} className="research-input" maxLength={500} /></Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="值类型"><select value={valueKind} onChange={(event) => setValueKind(event.target.value as ResearchMonitoringItem['valueKind'])} className="research-input"><option value="number">数值</option><option value="text">文本</option><option value="event">事件</option></select></Field>
        <Field label="频率"><select value={frequency} onChange={(event) => setFrequency(event.target.value as ResearchMonitoringItem['frequency'])} className="research-input"><option value="daily">每日</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="quarterly">每季</option><option value="event_driven">事件驱动</option></select></Field>
        <Field label="时序属性"><select value={timing} onChange={(event) => setTiming(event.target.value as ResearchMonitoringItem['timingType'])} className="research-input"><option value="leading">领先</option><option value="coincident">同步</option><option value="lagging">滞后</option><option value="unknown">未知</option></select></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="来源名称"><input value={sourceName} onChange={(event) => setSourceName(event.target.value)} className="research-input" /></Field><Field label="来源引用"><input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} className="research-input" /></Field></div>
      <div className="grid gap-3 sm:grid-cols-3"><Field label="单位"><input value={unit} onChange={(event) => setUnit(event.target.value)} className="research-input" /></Field><Field label="过期天数"><input type="number" min="1" value={staleDays} onChange={(event) => setStaleDays(event.target.value)} className="research-input" /></Field><Field label="下次回访"><input type="date" value={nextReview} onChange={(event) => setNextReview(event.target.value)} className="research-input" /></Field></div>
      <Field label="关联决策"><select value={decisionId} onChange={(event) => setDecisionId(event.target.value)} className="research-input"><option value="">不关联</option>{decisions.map((decision) => <option key={decision.decisionId} value={decision.decisionId}>{decision.rationale.slice(0, 40)}</option>)}</select></Field>
      {error && <div role="alert" className="text-xs text-red-600">{error}</div>}
      <DialogActions saving={saving} valid={Boolean(valid)} onClose={onClose} submitLabel="保存监控项" />
    </form>
  </DialogFrame>
}

export function ResearchObservationDialog({ item, saving, error, onClose, onSubmit }: {
  item: ResearchMonitoringItem
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (value: number | string, sourceRef: string | null) => void
}): React.ReactElement {
  const [value, setValue] = useState('')
  const [sourceRef, setSourceRef] = useState(item.sourceRef ?? '')
  const valid = item.valueKind === 'number' ? value !== '' && Number.isFinite(Number(value)) : value.trim().length > 0
  return <DialogFrame title={`追加观测 · ${item.name}`} onClose={saving ? () => undefined : onClose}>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit(item.valueKind === 'number' ? Number(value) : value.trim(), sourceRef.trim() || null) }}>
      <Field label={`观测值${item.unit ? `（${item.unit}）` : ''}`}><input type={item.valueKind === 'number' ? 'number' : 'text'} step="any" value={value} onChange={(event) => setValue(event.target.value)} className="research-input" /></Field>
      <Field label="来源引用"><input value={sourceRef} onChange={(event) => setSourceRef(event.target.value)} className="research-input" /></Field>
      {error && <div role="alert" className="text-xs text-red-600">{error}</div>}
      <DialogActions saving={saving} valid={valid} onClose={onClose} submitLabel="追加观测" />
    </form>
  </DialogFrame>
}

export interface TriggerSaveDraft {
  triggerId: string
  expectedVersion: number
  decisionId: string
  monitoringItemId: string
  metricName: string
  operator: ResearchDecisionTrigger['operator']
  threshold: number | string | null
  validationWindowMs: number
  actionIfNotTriggered: ResearchDecisionTrigger['actionIfNotTriggered']
  proposedActionIfTriggered: ResearchDecisionTrigger['proposedActionIfTriggered']
  expiresAt: number | null
  status: ResearchDecisionTrigger['status']
}

export function ResearchTriggerDialog({ decisions, monitoringItems, saving, error, onClose, onSubmit }: {
  decisions: ResearchDecisionItem[]
  monitoringItems: ResearchMonitoringItem[]
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: TriggerSaveDraft) => void
}): React.ReactElement {
  const [decisionId, setDecisionId] = useState(decisions[0]?.decisionId ?? '')
  const [monitoringId, setMonitoringId] = useState(monitoringItems[0]?.id ?? '')
  const [metric, setMetric] = useState('')
  const [operator, setOperator] = useState<ResearchDecisionTrigger['operator']>('gte')
  const [threshold, setThreshold] = useState('')
  const [proposed, setProposed] = useState<ResearchDecisionTrigger['proposedActionIfTriggered']>('monitor')
  const valid = decisionId && monitoringId && metric.trim() && (operator === 'changed' || threshold !== '')
  return <DialogFrame title="新增决策触发器" onClose={saving ? () => undefined : onClose}>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (valid) onSubmit({ triggerId: crypto.randomUUID(), expectedVersion: 0, decisionId, monitoringItemId: monitoringId, metricName: metric, operator, threshold: operator === 'changed' ? null : Number.isFinite(Number(threshold)) ? Number(threshold) : threshold, validationWindowMs: 7 * 86400000, actionIfNotTriggered: 'monitor', proposedActionIfTriggered: proposed, expiresAt: null, status: 'active' }) }}>
      <Field label="关联决策"><select value={decisionId} onChange={(event) => setDecisionId(event.target.value)} className="research-input">{decisions.map((decision) => <option key={decision.decisionId} value={decision.decisionId}>{decision.rationale.slice(0, 60)}</option>)}</select></Field>
      <Field label="监控项"><select value={monitoringId} onChange={(event) => setMonitoringId(event.target.value)} className="research-input">{monitoringItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <div className="grid gap-3 sm:grid-cols-3"><Field label="指标名称"><input value={metric} onChange={(event) => setMetric(event.target.value)} className="research-input" /></Field><Field label="比较符"><select value={operator} onChange={(event) => setOperator(event.target.value as ResearchDecisionTrigger['operator'])} className="research-input"><option value="gte">≥</option><option value="gt">&gt;</option><option value="lte">≤</option><option value="lt">&lt;</option><option value="eq">=</option><option value="changed">发生变化</option></select></Field><Field label="阈值"><input disabled={operator === 'changed'} value={threshold} onChange={(event) => setThreshold(event.target.value)} className="research-input" /></Field></div>
      <Field label="命中后候选动作"><select value={proposed} onChange={(event) => setProposed(event.target.value as ResearchDecisionTrigger['proposedActionIfTriggered'])} className="research-input"><option value="continue_research">继续研究</option><option value="wait_financial_validation">等待财报验证</option><option value="wait_price">等待价格</option><option value="monitor">仅跟踪</option><option value="exclude">排除</option></select></Field>
      {error && <div role="alert" className="text-xs text-red-600">{error}</div>}
      <DialogActions saving={saving} valid={Boolean(valid)} onClose={onClose} submitLabel="保存触发器" />
    </form>
  </DialogFrame>
}
