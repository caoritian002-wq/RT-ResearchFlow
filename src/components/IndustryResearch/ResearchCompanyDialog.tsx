import React, { useState } from 'react'
import type { ResearchCompany, ResearchCompanyDraft, ResearchSecurity } from './industryResearchTypes'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'

function localId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

interface Props {
  company?: ResearchCompany | null
  security?: ResearchSecurity | null
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ResearchCompanyDraft) => void
}

export function ResearchCompanyDialog({ company, security, saving, error, onClose, onSubmit }: Props): React.ReactElement {
  const [withSecurity, setWithSecurity] = useState(Boolean(security))
  const [draft, setDraft] = useState<ResearchCompanyDraft>({
    id: company?.companyId ?? localId('company'),
    legalName: company?.legalName ?? '',
    shortName: company?.shortName ?? '',
    unifiedCreditCode: company?.unifiedCreditCode ?? '',
    registrationRegion: company?.registrationRegion ?? '',
    sourceRef: company?.sourceRef ?? '',
    status: company?.status ?? 'candidate',
    exclusionReason: company?.exclusionReason ?? '',
    security: security ? {
      id: security.id,
      tsCode: security.tsCode,
      exchange: security.exchange,
      securityType: security.securityType,
      listStatus: security.listStatus ?? '',
      listDate: security.listDate ?? '',
      delistDate: security.delistDate ?? '',
      sourceRef: security.sourceRef ?? '',
    } : null,
  })
  const set = <K extends keyof ResearchCompanyDraft>(key: K, value: ResearchCompanyDraft[K]) => setDraft(current => ({ ...current, [key]: value }))
  const setSecurity = <K extends keyof NonNullable<ResearchCompanyDraft['security']>>(key: K, value: NonNullable<ResearchCompanyDraft['security']>[K]) => {
    setDraft(current => ({
      ...current,
      security: { id: current.security?.id ?? localId('security'), tsCode: '', exchange: '', securityType: 'stock', listStatus: '', listDate: '', delistDate: '', sourceRef: '', ...current.security, [key]: value },
    }))
  }
  const toggleSecurity = (enabled: boolean) => {
    setWithSecurity(enabled)
    set('security', enabled ? draft.security ?? { id: localId('security'), tsCode: '', exchange: '', securityType: 'stock', listStatus: '', listDate: '', delistDate: '', sourceRef: '' } : null)
  }
  const securityValid = !withSecurity || Boolean(draft.security?.tsCode.trim() && draft.security.exchange.trim() && draft.security.securityType.trim())
  const valid = Boolean(draft.legalName.trim() && securityValid && (draft.status !== 'excluded' || draft.exclusionReason.trim()))
  return <DialogFrame title={company ? '维护公司与证券' : '登记项目公司'} onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (valid) onSubmit(draft) }} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2"><Field label="公司法定名称"><input value={draft.legalName} onChange={event => set('legalName', event.target.value)} className="research-input" maxLength={300} /></Field><Field label="公司简称"><input value={draft.shortName} onChange={event => set('shortName', event.target.value)} className="research-input" maxLength={120} /></Field></div>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="统一社会信用代码"><input value={draft.unifiedCreditCode} onChange={event => set('unifiedCreditCode', event.target.value)} className="research-input" maxLength={64} /></Field><Field label="注册区域"><input value={draft.registrationRegion} onChange={event => set('registrationRegion', event.target.value)} className="research-input" maxLength={120} /></Field></div>
      <div className="grid gap-3 sm:grid-cols-2"><Field label="项目状态"><select value={draft.status} onChange={event => set('status', event.target.value as ResearchCompanyDraft['status'])} className="research-input"><option value="candidate">候选</option><option value="watching">跟踪</option><option value="core">核心</option><option value="excluded">排除</option></select></Field><Field label="公司来源编号"><input value={draft.sourceRef} onChange={event => set('sourceRef', event.target.value)} className="research-input" maxLength={1000} /></Field></div>
      {draft.status === 'excluded' && <Field label="排除理由"><textarea value={draft.exclusionReason} onChange={event => set('exclusionReason', event.target.value)} className="research-input min-h-16 resize-y py-2" maxLength={1000} /></Field>}
      <label className="flex items-center gap-2 border-t border-slate-100 pt-3 text-xs font-medium dark:border-slate-800"><input type="checkbox" checked={withSecurity} onChange={event => toggleSecurity(event.target.checked)} />同时维护一个证券映射</label>
      {withSecurity && draft.security && <div className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <div className="grid gap-3 sm:grid-cols-3"><Field label="规范股票代码"><input value={draft.security.tsCode} onChange={event => setSecurity('tsCode', event.target.value.trim().toUpperCase())} className="research-input font-mono" placeholder="600000.SH" maxLength={16} /></Field><Field label="交易所"><select value={draft.security.exchange} onChange={event => setSecurity('exchange', event.target.value)} className="research-input"><option value="">请选择</option><option value="SSE">上交所</option><option value="SZSE">深交所</option><option value="BSE">北交所</option></select></Field><Field label="证券类型"><input value={draft.security.securityType} onChange={event => setSecurity('securityType', event.target.value)} className="research-input" maxLength={40} /></Field></div>
        <div className="grid gap-3 sm:grid-cols-3"><Field label="上市状态"><input value={draft.security.listStatus} onChange={event => setSecurity('listStatus', event.target.value)} className="research-input" maxLength={40} /></Field><Field label="上市日期"><input type="date" value={draft.security.listDate} onChange={event => setSecurity('listDate', event.target.value)} className="research-input" /></Field><Field label="退市日期"><input type="date" value={draft.security.delistDate} onChange={event => setSecurity('delistDate', event.target.value)} className="research-input" /></Field></div>
        <Field label="证券映射来源编号"><input value={draft.security.sourceRef} onChange={event => setSecurity('sourceRef', event.target.value)} className="research-input" maxLength={1000} /></Field>
      </div>}
      <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/20 dark:text-cyan-300">公司实体与上市证券分离保存。股票代码必须使用带交易所后缀的规范代码。</div>
      {error && <div className="text-xs text-red-600 dark:text-red-300">{error}</div>}
      <DialogActions saving={saving} valid={valid} onClose={onClose} submitLabel="保存公司" />
    </form>
  </DialogFrame>
}