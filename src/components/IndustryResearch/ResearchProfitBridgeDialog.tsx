import React, { useMemo, useState } from 'react'
import { formatFinancialReportPeriod, getFinancialMetricLabel, validateProfitBridgeDraft } from './industryResearchFinancialModel'
import type { DisclosureEvidence, FinancialTimelineRevision, ProfitBridge, ProfitBridgeDraft, ProfitBridgeItem, ProfitBridgeItemKey } from './industryResearchTypes'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'

const BRIDGE_ITEMS: Array<{ key: ProfitBridgeItemKey; label: string }> = [
  { key: 'volume', label: '销量' }, { key: 'price', label: '售价' }, { key: 'product_mix', label: '产品结构' },
  { key: 'raw_material', label: '原料' }, { key: 'depreciation_expense', label: '折旧费用' },
  { key: 'other_business_drag', label: '其他业务拖累' }, { key: 'other', label: '其他' },
]

function initialItems(bridge?: ProfitBridge | null): ProfitBridgeItem[] {
  return BRIDGE_ITEMS.map(definition => bridge?.items.find(item => item.key === definition.key) ?? {
    key: definition.key, label: definition.label, amount: null, unit: null, methodology: null,
  })
}

interface Props {
  bridge?: ProfitBridge | null
  defaultBridgeKey: string
  timeline: FinancialTimelineRevision[]
  evidence: DisclosureEvidence[]
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ProfitBridgeDraft) => void
}

export function ResearchProfitBridgeDialog({ bridge, defaultBridgeKey, timeline, evidence, saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [draft, setDraft] = useState<ProfitBridgeDraft>({
    bridgeKey: bridge?.bridgeKey ?? defaultBridgeKey, basePeriod: bridge?.basePeriod ?? '', targetPeriod: bridge?.targetPeriod ?? '',
    status: bridge?.status ?? 'hypothesis', items: initialItems(bridge), formula: bridge?.formula ?? '',
    inputFactIds: bridge?.inputFactIds ?? [], evidenceIds: bridge?.evidenceIds ?? [],
  })
  const factOptions = useMemo(() => timeline.flatMap(revision => revision.metrics.map(metric => ({
    id: metric.factId,
    label: `${formatFinancialReportPeriod(revision.reportPeriod)} · ${getFinancialMetricLabel(revision.dataset, metric.name)} · ${revision.updateFlag === '1' ? '修订版' : '原始报告'}`,
  }))), [timeline])
  const set = <K extends keyof ProfitBridgeDraft>(key: K, value: ProfitBridgeDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const setItem = (key: ProfitBridgeItemKey, patch: Partial<ProfitBridgeItem>) => setDraft(current => ({
    ...current, items: current.items.map(item => item.key === key ? { ...item, ...patch } : item),
  }))
  const toggleId = (field: 'inputFactIds' | 'evidenceIds', id: string) => set(field, draft[field].includes(id) ? draft[field].filter(item => item !== id) : [...draft[field], id])
  const estimateAllowed = validateProfitBridgeDraft({ ...draft, status: 'estimate' }) == null
  const validationError = validateProfitBridgeDraft(draft)
  const valid = validationError == null
  return <DialogFrame title={bridge ? `新增利润桥版本 V${bridge.version + 1}` : '建立利润桥'} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (valid) onSubmit(draft) }} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3"><Field label="桥键"><input value={draft.bridgeKey} onChange={event => set('bridgeKey', event.target.value)} className="research-input font-mono" maxLength={128} /></Field><Field label="基准期"><input value={draft.basePeriod} onChange={event => set('basePeriod', event.target.value)} className="research-input font-mono" placeholder="20231231" maxLength={32} /></Field><Field label="目标期"><input value={draft.targetPeriod} onChange={event => set('targetPeriod', event.target.value)} className="research-input font-mono" placeholder="20241231" maxLength={32} /></Field></div>
      <Field label="研究状态"><select value={draft.status} onChange={event => set('status', event.target.value as ProfitBridgeDraft['status'])} className="research-input"><option value="hypothesis">假设</option><option value="estimate" disabled={!estimateAllowed}>估算</option></select></Field>
      <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700"><table className="w-full min-w-[620px] text-left text-xs"><thead className="bg-slate-50 text-slate-500 dark:bg-slate-950"><tr><th className="px-3 py-2">桥接项</th><th className="px-3 py-2">金额</th><th className="px-3 py-2">单位</th><th className="px-3 py-2">方法</th></tr></thead><tbody>{draft.items.map(item => <tr key={item.key} className="border-t border-slate-100 dark:border-slate-800"><td className="px-3 py-2 font-medium">{item.label}</td><td className="px-3 py-2"><input type="number" step="any" value={item.amount ?? ''} onChange={event => setItem(item.key, { amount: event.target.value === '' ? null : Number(event.target.value) })} className="research-input font-mono" /></td><td className="px-3 py-2"><input value={item.unit ?? ''} onChange={event => setItem(item.key, { unit: event.target.value || null })} className="research-input" maxLength={40} /></td><td className="px-3 py-2"><input value={item.methodology ?? ''} onChange={event => setItem(item.key, { methodology: event.target.value || null })} className="research-input" maxLength={1000} /></td></tr>)}</tbody></table></div>
      <Field label="透明公式"><textarea value={draft.formula} onChange={event => set('formula', event.target.value)} className="research-input min-h-20 resize-y py-2 font-mono text-xs" maxLength={2000} placeholder="目标利润 = 基准利润 + 各桥接项" /></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="输入财务事实"><div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-700">{factOptions.length ? factOptions.map(item => <label key={item.id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={draft.inputFactIds.includes(item.id)} onChange={() => toggleId('inputFactIds', item.id)} className="mt-0.5" /><span>{item.label}</span></label>) : <div className="text-xs text-slate-400">当前公司尚无可引用财务事实</div>}</div></Field><Field label="公告证据"><div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-slate-700">{evidence.length ? evidence.map(item => <label key={item.id} className="flex items-start gap-2 text-xs"><input type="checkbox" checked={draft.evidenceIds.includes(item.id)} onChange={() => toggleId('evidenceIds', item.id)} className="mt-0.5" /><span>{item.title}</span></label>) : <div className="text-xs text-slate-400">当前公司尚无公告证据</div>}</div></Field></div>
      <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-300">保存会追加新版本，不覆盖历史。估算状态必须同时具备透明公式、有效桥接项和当前公司的输入财务事实。</div>
      {(validationError || error) && <div className="text-xs text-red-600 dark:text-red-300">{validationError || error}</div>}
      <DialogActions saving={saving} valid={valid} onClose={onClose} submitLabel="保存新版本" />
    </form>
  </DialogFrame>
}
