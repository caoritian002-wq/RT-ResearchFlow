import React, { useMemo, useState } from 'react'
import { validateConfirmedExposureDraft } from './industryResearchFinancialModel'
import type { BusinessExposure, BusinessExposureDraft, DisclosureEvidence, ResearchNode } from './industryResearchTypes'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'

interface Props {
  exposure?: BusinessExposure | null
  nodes: ResearchNode[]
  evidence: DisclosureEvidence[]
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: BusinessExposureDraft) => void
}

export function ResearchBusinessExposureDialog({ exposure, nodes, evidence, saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [draft, setDraft] = useState<BusinessExposureDraft>({
    id: exposure?.id ?? `exposure:${crypto.randomUUID()}`,
    researchNodeId: exposure?.researchNodeId ?? '', mainBusinessItemId: exposure?.mainBusinessItemId ?? '',
    evidenceId: exposure?.evidenceId ?? exposure?.evidenceIds[0] ?? '', sourceKey: exposure?.sourceKey ?? `manual:${crypto.randomUUID()}`,
    sourceType: exposure?.sourceType ?? 'manual', status: exposure?.status ?? 'candidate',
    exposurePct: exposure?.exposurePct ?? null, basis: exposure?.basis ?? '', factDate: exposure?.factDate ?? '',
    methodology: exposure?.methodology ?? '',
  })
  const set = <K extends keyof BusinessExposureDraft>(key: K, value: BusinessExposureDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const confirmedEvidence = useMemo(() => evidence.filter(item => item.createdBy === 'human' && item.primarySourceConfirmed), [evidence])
  const validationError = validateConfirmedExposureDraft(draft, evidence)
  const valid = validationError == null
  const importedCandidate = draft.sourceType === 'fina_mainbz'
  return <DialogFrame title={exposure ? '维护业务暴露' : '新增业务暴露'} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (valid) onSubmit(draft) }} className="space-y-3">
      {exposure && <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"><strong className="font-medium text-slate-800 dark:text-slate-100">{exposure.mainBusinessItemName ?? '人工维护的业务暴露'}</strong><span className="ml-2 text-slate-400">{importedCandidate ? '来自 Tushare 主营构成' : '人工维护'}</span></div>}
      <Field label="验证状态"><select value={draft.status} onChange={event => set('status', event.target.value as BusinessExposureDraft['status'])} className="research-input"><option value="candidate">待验证</option><option value="confirmed" disabled={importedCandidate}>已确认</option><option value="not_separable" disabled={importedCandidate}>无法拆分</option><option value="excluded" disabled={importedCandidate}>排除</option></select></Field>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="研究节点"><select value={draft.researchNodeId} onChange={event => set('researchNodeId', event.target.value)} className="research-input"><option value="">未绑定</option>{nodes.map(node => <option key={node.id} value={node.id}>{node.name}</option>)}</select></Field><Field label="业务暴露比例"><input type="number" min={0} max={100} step="0.0001" value={draft.exposurePct ?? ''} onChange={event => set('exposurePct', event.target.value === '' ? null : Number(event.target.value))} className="research-input" placeholder="未知时留空" /></Field></div>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="官方公告证据"><select value={draft.evidenceId} onChange={event => set('evidenceId', event.target.value)} className="research-input"><option value="">未绑定</option>{confirmedEvidence.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></Field><Field label="事实日期"><input type="date" value={draft.factDate} onChange={event => set('factDate', event.target.value)} className="research-input" /></Field></div>
      <Field label="判断依据"><textarea value={draft.basis} onChange={event => set('basis', event.target.value)} className="research-input min-h-20 resize-y py-2" maxLength={2000} /></Field>
      <Field label="方法说明"><textarea value={draft.methodology} onChange={event => set('methodology', event.target.value)} className="research-input min-h-16 resize-y py-2" maxLength={2000} /></Field>
      {importedCandidate && <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">主营构成同步记录只作为候选，不能在此直接升级为人工确认状态。</div>}
      <details className="text-xs text-slate-500"><summary className="w-fit cursor-pointer select-none rounded px-1 py-1 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:bg-slate-800">技术详情</summary><dl className="mt-2 grid gap-2 rounded bg-slate-50 p-3 dark:bg-slate-950"><div><dt className="text-slate-400">来源记录键</dt><dd className="mt-0.5 break-all font-mono">{draft.sourceKey}</dd></div><div><dt className="text-slate-400">暴露记录 ID</dt><dd className="mt-0.5 break-all font-mono">{draft.id}</dd></div>{draft.mainBusinessItemId && <div><dt className="text-slate-400">主营构成记录 ID</dt><dd className="mt-0.5 break-all font-mono">{draft.mainBusinessItemId}</dd></div>}</dl></details>
      {(validationError || error) && <div className="text-xs text-red-600 dark:text-red-300">{validationError || error}</div>}
      <DialogActions saving={saving} valid={valid} onClose={onClose} submitLabel="保存业务暴露" />
    </form>
  </DialogFrame>
}
