import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  adaptBusinessExposures, adaptDisclosureEvidence, adaptFinancialSyncStates, adaptFinancialTimeline,
  adaptFinancialValidation, adaptProfitBridge, adaptResearchCompanies, FINANCIAL_DATASET_LABELS,
  formatFinancialMetricValue, formatFinancialReportPeriod, formatFinancialValue,
  getFinancialMetricLabel, shouldPreserveProfitBridgeDraft,
} from './industryResearchFinancialModel'
import { ResearchBusinessExposureOverview } from './ResearchBusinessExposureOverview'
import { ResearchBusinessExposureDialog } from './ResearchBusinessExposureDialog'
import { ResearchCompanyDialog } from './ResearchCompanyDialog'
import { ResearchDisclosureEvidenceDialog } from './ResearchDisclosureEvidenceDialog'
import { ResearchProfitBridgeDialog } from './ResearchProfitBridgeDialog'
import type {
  BusinessExposure, BusinessExposureDraft, DisclosureEvidence, DisclosureEvidenceDraft, FinancialDataset,
  FinancialSyncState, FinancialTimelineRevision, FinancialValidation, IndustryResearchResponse, ProfitBridge,
  ProfitBridgeDraft, ResearchCompany, ResearchCompanyDraft, ResearchGraph, ResearchProject, ResearchSecurity,
} from './industryResearchTypes'
import { FINANCIAL_DATASETS } from './industryResearchTypes'

type CompanyPanel = 'exposure' | 'timeline' | 'validation' | 'bridge' | 'sync'
type CompanyDialog = 'company' | 'disclosure' | 'exposure' | 'bridge' | null

const PANEL_LABELS: Array<[CompanyPanel, string]> = [
  ['exposure', '业务暴露'], ['timeline', '财务时间轴'], ['validation', '财务验证'], ['bridge', '利润桥'], ['sync', '同步状态'],
]

const COMPANY_STATUS_LABELS: Record<ResearchCompany['status'], string> = {
  candidate: '候选', watching: '跟踪', core: '核心', excluded: '排除',
}

function responseError(response: IndustryResearchResponse<unknown>): string {
  return response.message || response.code || '公司财务操作失败'
}

function unwrapArray(response: IndustryResearchResponse<unknown>): unknown[] {
  if (!response.ok) throw new Error(responseError(response))
  if (Array.isArray(response.data)) return response.data
  if (response.data && typeof response.data === 'object' && Array.isArray((response.data as { items?: unknown }).items)) return (response.data as { items: unknown[] }).items
  return []
}

function formatDate(value: string | null): string {
  if (!value) return '未知'
  return value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function formatTimestamp(value: number | null): string {
  if (value == null) return '从未'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false })
}

function formatQuarterPeriod(value: string): string {
  if (!/^\d{8}$/.test(value)) return value
  const quarter = ({ '0331': 'Q1', '0630': 'Q2', '0930': 'Q3', '1231': 'Q4' } as Record<string, string>)[value.slice(4)]
  return quarter ? `${value.slice(0, 4)}${quarter}` : formatDate(value)
}

function formatInterimPeriod(value: string): string {
  return /^\d{4}0630$/.test(value) ? `${value.slice(0, 4)}中报` : formatDate(value)
}

function formatAnnualPeriod(value: string): string {
  return /^\d{4}1231$/.test(value) ? `${value.slice(0, 4)}年报` : formatDate(value)
}

function defaultBridgeKey(companyId: string): string {
  return `annual:${companyId}`.slice(0, 128)
}

interface Props {
  project: ResearchProject
  graph: ResearchGraph | null
  onExpandCompanies?: () => Promise<string | null>
  dataRevision?: number | null
}

export function ResearchCompanyFinancialView({ project, graph, onExpandCompanies, dataRevision }: Props): React.ReactElement {
  const [companies, setCompanies] = useState<ResearchCompany[]>([])
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null)
  const [selectedSecurityId, setSelectedSecurityId] = useState<string | null>(null)
  const [panel, setPanel] = useState<CompanyPanel>('exposure')
  const [dialog, setDialog] = useState<CompanyDialog>(null)
  const [editingCompany, setEditingCompany] = useState<ResearchCompany | null>(null)
  const [editingDisclosure, setEditingDisclosure] = useState<DisclosureEvidence | null>(null)
  const [editingExposure, setEditingExposure] = useState<BusinessExposure | null>(null)
  const [disclosures, setDisclosures] = useState<DisclosureEvidence[]>([])
  const [exposures, setExposures] = useState<BusinessExposure[]>([])
  const [timeline, setTimeline] = useState<FinancialTimelineRevision[]>([])
  const [validation, setValidation] = useState<FinancialValidation | null>(null)
  const [syncStates, setSyncStates] = useState<FinancialSyncState[]>([])
  const [bridge, setBridge] = useState<ProfitBridge | null>(null)
  const [bridgeKey, setBridgeKey] = useState('')
  const [activeBridgeKey, setActiveBridgeKey] = useState('')
  const [timelineDatasets, setTimelineDatasets] = useState<FinancialDataset[]>([...FINANCIAL_DATASETS])
  const [syncDatasets, setSyncDatasets] = useState<FinancialDataset[]>([...FINANCIAL_DATASETS])
  const [query, setQuery] = useState('')
  const [loadingCompanies, setLoadingCompanies] = useState(true)
  const [loadingFacts, setLoadingFacts] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [expandingCompanies, setExpandingCompanies] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const companyListRequestIdRef = useRef(0)

  const selectedCompany = useMemo(() => companies.find(item => item.companyId === selectedCompanyId) ?? null, [companies, selectedCompanyId])
  const selectedSecurity = useMemo(() => selectedCompany?.securities.find(item => item.id === selectedSecurityId) ?? selectedCompany?.securities[0] ?? null, [selectedCompany, selectedSecurityId])
  const visibleCompanies = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return normalized ? companies.filter(item => `${item.displayName} ${item.legalName} ${item.securities.map(security => security.tsCode).join(' ')}`.toLocaleLowerCase('zh-CN').includes(normalized)) : companies
  }, [companies, query])

  const clearFacts = useCallback(() => {
    setDisclosures([]); setExposures([]); setTimeline([]); setValidation(null); setSyncStates([]); setBridge(null)
  }, [])

  const loadCompanies = useCallback(async (preferredCompanyId?: string | null) => {
    const requestId = ++companyListRequestIdRef.current
    setLoadingCompanies(true)
    try {
      const response = await window.api.industryResearch.listCompanies(project.id) as IndustryResearchResponse<unknown>
      if (requestId !== companyListRequestIdRef.current) return
      setLoadingCompanies(false)
      if (!response.ok) { setError(responseError(response)); setCompanies([]); setSelectedCompanyId(null); return }
      const adapted = adaptResearchCompanies(response.data)
      setCompanies(adapted)
      setSelectedCompanyId(current => {
        const preferred = preferredCompanyId ?? current
        return preferred && adapted.some(item => item.companyId === preferred) ? preferred : adapted[0]?.companyId ?? null
      })
    } catch (loadError) {
      if (requestId !== companyListRequestIdRef.current) return
      setLoadingCompanies(false); setCompanies([]); setSelectedCompanyId(null)
      setError(loadError instanceof Error ? loadError.message : '项目公司读取失败')
    }
  }, [project.id])

  useEffect(() => {
    requestIdRef.current += 1
    companyListRequestIdRef.current += 1
    setSelectedCompanyId(null); setSelectedSecurityId(null); setDialog(null); clearFacts(); setError(null); setNotice(null)
    void loadCompanies()
  }, [clearFacts, dataRevision, loadCompanies, project.id])

  useEffect(() => {
    const nextSecurityId = selectedCompany?.securities[0]?.id ?? null
    setSelectedSecurityId(current => selectedCompany?.securities.some(item => item.id === current) ? current : nextSecurityId)
    const nextBridgeKey = selectedCompany ? defaultBridgeKey(selectedCompany.companyId) : ''
    setBridgeKey(nextBridgeKey)
    setActiveBridgeKey(nextBridgeKey)
  }, [selectedCompany])

  const loadCompanyFacts = useCallback(async (company: ResearchCompany, security: ResearchSecurity | null, nextBridgeKey: string) => {
    const requestId = ++requestIdRef.current
    clearFacts(); setLoadingFacts(true); setError(null); setNotice(null)
    try {
      const responses = await Promise.all([
        window.api.industryResearch.listDisclosureEvidence(project.id, company.companyId) as Promise<IndustryResearchResponse<unknown>>,
        window.api.industryResearch.listBusinessExposure(project.id, company.companyId) as Promise<IndustryResearchResponse<unknown>>,
        window.api.industryResearch.getFinancialTimeline({ companyId: company.companyId, securityId: security?.id, datasets: timelineDatasets }) as Promise<IndustryResearchResponse<unknown>>,
        window.api.industryResearch.getFinancialValidation(project.id, company.companyId) as Promise<IndustryResearchResponse<unknown>>,
        window.api.industryResearch.getFinancialSyncStatus(company.companyId) as Promise<IndustryResearchResponse<unknown>>,
        window.api.industryResearch.getProfitBridge(project.id, company.companyId, nextBridgeKey) as Promise<IndustryResearchResponse<unknown>>,
      ])
      if (requestId !== requestIdRef.current) return
      setLoadingFacts(false)
      const failures = responses.filter(response => !response.ok)
      setDisclosures(adaptDisclosureEvidence(responses[0].ok ? unwrapArray(responses[0]) : []))
      setExposures(adaptBusinessExposures(responses[1].ok ? unwrapArray(responses[1]) : []))
      setTimeline(adaptFinancialTimeline(responses[2].ok ? unwrapArray(responses[2]) : []))
      setValidation(responses[3].ok ? adaptFinancialValidation(responses[3].data, company.companyId) : null)
      setSyncStates(adaptFinancialSyncStates(responses[4].ok ? unwrapArray(responses[4]) : [], company.companyId))
      setBridge(responses[5].ok ? adaptProfitBridge(responses[5].data) : null)
      if (failures.length) setError(`部分公司事实读取失败：${failures.map(responseError).join('；')}`)
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return
      setLoadingFacts(false)
      setError(loadError instanceof Error ? loadError.message : '公司事实读取失败')
    }
  }, [clearFacts, project.id, timelineDatasets])

  useEffect(() => {
    if (!selectedCompany) { requestIdRef.current += 1; clearFacts(); setLoadingFacts(false); return }
    void loadCompanyFacts(selectedCompany, selectedSecurity, activeBridgeKey || defaultBridgeKey(selectedCompany.companyId))
  }, [activeBridgeKey, clearFacts, loadCompanyFacts, selectedCompany, selectedSecurity])

  const openCompany = (company?: ResearchCompany) => { setEditingCompany(company ?? null); setError(null); setDialog('company') }
  const openDisclosure = (evidence?: DisclosureEvidence) => { setEditingDisclosure(evidence ?? null); setError(null); setDialog('disclosure') }
  const openExposure = (exposure?: BusinessExposure) => { setEditingExposure(exposure ?? null); setError(null); setDialog('exposure') }
  const closeDialog = () => { setDialog(null); setEditingCompany(null); setEditingDisclosure(null); setEditingExposure(null); setError(null) }

  const saveCompany = useCallback(async (draft: ResearchCompanyDraft) => {
    setSaving(true); setError(null)
    const response = await window.api.industryResearch.saveCompany(project.id, {
      id: draft.id, legalName: draft.legalName, shortName: draft.shortName || null,
      unifiedCreditCode: draft.unifiedCreditCode || null, registrationRegion: draft.registrationRegion || null,
      sourceType: 'manual', sourceRef: draft.sourceRef || null, status: draft.status,
      exclusionReason: draft.exclusionReason || null, evidenceIds: editingCompany?.evidenceIds ?? [],
      security: draft.security ? {
        id: draft.security.id, tsCode: draft.security.tsCode, exchange: draft.security.exchange,
        securityType: draft.security.securityType, listStatus: draft.security.listStatus || 'L',
        listDate: draft.security.listDate || null, delistDate: draft.security.delistDate || null,
        mappingSource: 'manual', sourceRef: draft.security.sourceRef || null,
      } : undefined,
    }) as IndustryResearchResponse<unknown>
    setSaving(false)
    if (!response.ok) { setError(responseError(response)); return }
    closeDialog(); await loadCompanies(draft.id); setNotice('公司与证券上下文已保存')
  }, [editingCompany?.evidenceIds, loadCompanies, project.id])

  const saveDisclosure = useCallback(async (draft: DisclosureEvidenceDraft) => {
    if (!selectedCompany) return
    setSaving(true); setError(null)
    const response = await window.api.industryResearch.saveDisclosureEvidence(project.id, selectedCompany.companyId, {
      id: draft.id, title: draft.title, sourceUrl: draft.sourceUrl,
      publishedDate: draft.publishedDate || null, actualPublishedDate: draft.actualPublishedDate || null,
      excerpt: draft.excerpt || null, primarySourceConfirmed: draft.primarySourceConfirmed,
    }) as IndustryResearchResponse<unknown>
    setSaving(false)
    if (!response.ok) { setError(responseError(response)); return }
    closeDialog(); await loadCompanyFacts(selectedCompany, selectedSecurity, activeBridgeKey); setNotice('官方公告证据已保存')
  }, [activeBridgeKey, loadCompanyFacts, project.id, selectedCompany, selectedSecurity])

  const saveExposure = useCallback(async (draft: BusinessExposureDraft) => {
    if (!selectedCompany) return
    setSaving(true); setError(null)
    const response = await window.api.industryResearch.saveBusinessExposure(project.id, {
      id: draft.id, companyId: selectedCompany.companyId,
      researchNodeId: draft.researchNodeId || null, mainBusinessItemId: draft.mainBusinessItemId || null,
      evidenceIds: draft.evidenceId ? [draft.evidenceId] : [], sourceKey: draft.sourceKey,
      sourceType: draft.sourceType, status: draft.status, exposurePct: draft.exposurePct,
      basis: draft.basis, createdBy: 'human', factDate: draft.factDate || null, methodology: draft.methodology || null,
    }) as IndustryResearchResponse<unknown>
    setSaving(false)
    if (!response.ok) { setError(responseError(response)); return }
    closeDialog(); await loadCompanyFacts(selectedCompany, selectedSecurity, activeBridgeKey); setNotice('业务暴露已保存')
  }, [activeBridgeKey, loadCompanyFacts, project.id, selectedCompany, selectedSecurity])

  const saveBridge = useCallback(async (draft: ProfitBridgeDraft) => {
    if (!selectedCompany) return
    setSaving(true); setError(null)
    const response = await window.api.industryResearch.saveProfitBridge({
      projectId: project.id, companyId: selectedCompany.companyId,
      bridge: { ...draft, items: draft.items.filter(item => item.amount != null || item.methodology), createdBy: 'human' },
      expectedUpdatedAt: bridge?.updatedAt ?? null,
    }) as IndustryResearchResponse<unknown>
    setSaving(false)
    if (!response.ok) {
      setError(response.code === 'VERSION_CONFLICT' ? '利润桥已有新版本。当前草稿已保留，请刷新事实后重新提交。' : responseError(response))
      if (!shouldPreserveProfitBridgeDraft(response.code)) setDialog(null)
      return
    }
    closeDialog(); setBridgeKey(draft.bridgeKey); setActiveBridgeKey(draft.bridgeKey)
    await loadCompanyFacts(selectedCompany, selectedSecurity, draft.bridgeKey); setNotice('利润桥新版本已追加保存')
  }, [bridge?.updatedAt, loadCompanyFacts, project.id, selectedCompany, selectedSecurity])

  const syncFinancials = useCallback(async (datasets: FinancialDataset[] = syncDatasets) => {
    if (!selectedCompany || !selectedSecurity || !datasets.length) return
    setSyncing(true); setError(null); setNotice(null)
    try {
      const response = await window.api.industryResearch.syncCompanyFinancials({
        projectId: project.id, companyId: selectedCompany.companyId, securityId: selectedSecurity.id,
        tsCode: selectedSecurity.tsCode, datasets,
      }) as IndustryResearchResponse<unknown>
      if (!response.ok) { setError(responseError(response)); return }
      const result = response.data && typeof response.data === 'object'
        ? response.data as { datasets?: Array<{ status?: string }> }
        : null
      const datasetResults = Array.isArray(result?.datasets) ? result.datasets : []
      const successCount = datasetResults.filter(item => item.status === 'success').length
      const emptyCount = datasetResults.filter(item => item.status === 'empty').length
      const failedCount = datasetResults.length - successCount - emptyCount
      await loadCompanyFacts(selectedCompany, selectedSecurity, activeBridgeKey)
      setNotice(`财报同步完成：${successCount} 项成功${emptyCount ? `，${emptyCount} 项暂无披露` : ''}${failedCount ? `，${failedCount} 项失败` : ''}`)
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : '财报同步失败')
    } finally {
      setSyncing(false)
    }
  }, [activeBridgeKey, loadCompanyFacts, project.id, selectedCompany, selectedSecurity, syncDatasets])

  const expandCompanies = useCallback(async () => {
    if (!onExpandCompanies || expandingCompanies) return
    setExpandingCompanies(true); setError(null); setNotice(null)
    try {
      const message = await onExpandCompanies()
      if (!message) return
      await loadCompanies(selectedCompanyId)
      setNotice(message)
    } catch (expandError) {
      setError(expandError instanceof Error ? expandError.message : '公司映射补全失败')
    } finally {
      setExpandingCompanies(false)
    }
  }, [expandingCompanies, loadCompanies, onExpandCompanies, selectedCompanyId])

  return <div data-testid="industry-research-company-financial" className="flex min-h-[560px] flex-col overflow-hidden rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:h-full lg:min-h-0 lg:flex-row">
    <aside data-testid="industry-research-company-list" className="w-full shrink-0 border-b border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-950/40 lg:w-64 lg:border-b-0 lg:border-r">
      <div className="border-b border-slate-200 p-3 dark:border-slate-800"><div className="flex items-center justify-between gap-2"><div><div className="text-xs font-semibold">项目公司</div><div className="mt-0.5 text-[10px] text-slate-400">{companies.length} 家实体</div></div><div className="flex items-center gap-1.5"><button type="button" data-testid="industry-research-expand-companies" disabled={!onExpandCompanies || expandingCompanies} onClick={() => void expandCompanies()} className="h-8 rounded-md border border-slate-300 px-2 text-[11px] font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300">{expandingCompanies ? '启动中' : '补全链路'}</button><button type="button" onClick={() => openCompany()} className="h-8 rounded-md bg-slate-900 px-2.5 text-xs text-white dark:bg-slate-100 dark:text-slate-900">登记</button></div></div><input data-testid="industry-research-company-search" value={query} onChange={event => setQuery(event.target.value)} className="research-input mt-3" placeholder="搜索公司或代码" /></div>
      <div className="max-h-52 overflow-y-auto p-2 lg:max-h-none lg:h-[calc(100%-105px)]">{loadingCompanies ? <div className="p-4 text-center text-xs text-slate-400">正在读取公司</div> : visibleCompanies.length ? visibleCompanies.map(company => <button key={company.companyId} type="button" data-testid={`industry-research-company-${company.companyId}`} data-trend-score={company.trendScore ?? ''} aria-pressed={selectedCompanyId === company.companyId} onClick={() => setSelectedCompanyId(company.companyId)} className={`mb-1 w-full rounded-md border px-3 py-2 text-left ${selectedCompanyId === company.companyId ? 'border-cyan-300 bg-cyan-50 dark:border-cyan-800 dark:bg-cyan-950/20' : 'border-transparent hover:bg-white dark:hover:bg-slate-900'}`}><div className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-sm font-medium">{company.displayName}</span><span className="shrink-0 text-right"><span className="block text-[10px] text-slate-400">{COMPANY_STATUS_LABELS[company.status]}</span>{company.trendScore != null && <span data-testid={`industry-research-company-score-${company.companyId}`} className="mt-0.5 block text-[10px] font-semibold tabular-nums text-cyan-700 dark:text-cyan-300">综合分 {Math.round(company.trendScore)}</span>}</span></div><div className="mt-1 truncate font-mono text-[10px] text-slate-400">{company.securities.map(item => item.tsCode).join(' · ') || '未映射证券'}</div></button>) : <div className="p-5 text-center text-xs leading-5 text-slate-400">尚未登记项目公司。推荐先建立公司实体与证券映射。</div>}</div>
    </aside>
    <section data-testid="industry-research-company-detail" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!selectedCompany ? <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-slate-400">选择或登记公司后查看本地业务暴露和财务事实。</div> : <>
        <header className="shrink-0 border-b border-slate-200 px-4 py-3 dark:border-slate-800"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><h3 className="truncate text-base font-semibold">{selectedCompany.displayName}</h3><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800">{COMPANY_STATUS_LABELS[selectedCompany.status]}</span></div><div className="mt-1 text-xs text-slate-500">{selectedCompany.legalName}{selectedCompany.registrationRegion ? ` · ${selectedCompany.registrationRegion}` : ''}</div></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => openCompany(selectedCompany)} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs dark:border-slate-700">维护公司</button><button type="button" onClick={() => openDisclosure()} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs dark:border-slate-700">登记公告</button><button type="button" onClick={() => openExposure()} className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs dark:border-slate-700">新增暴露</button></div></div>
          <div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-[11px] text-slate-400">证券上下文</span>{selectedCompany.securities.length ? selectedCompany.securities.map(security => <button key={security.id} type="button" data-testid={`industry-research-security-${security.id}`} aria-pressed={selectedSecurity?.id === security.id} onClick={() => setSelectedSecurityId(security.id)} className={`rounded-md px-2.5 py-1 font-mono text-xs ${selectedSecurity?.id === security.id ? 'bg-cyan-700 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>{security.tsCode}</button>) : <span className="text-xs text-amber-600 dark:text-amber-300">未登记证券，不能执行财务同步</span>}</div>
          <div className="mt-3 flex gap-1 overflow-x-auto border-t border-slate-100 pt-2 dark:border-slate-800">{PANEL_LABELS.map(([key, label]) => <button key={key} type="button" data-testid={`industry-research-company-panel-${key}`} aria-pressed={panel === key} onClick={() => setPanel(key)} className={`shrink-0 rounded-md px-3 py-1.5 text-xs ${panel === key ? 'bg-slate-900 font-medium text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{label}</button>)}</div>
        </header>
        {(error || notice) && <div data-testid="industry-research-company-feedback" role={error ? 'alert' : 'status'} className={`mx-4 mt-3 rounded-md border px-3 py-2 text-xs leading-5 ${error ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300'}`}>{error || notice}</div>}
        <div data-testid="industry-research-company-content" className="min-h-0 flex-1 overflow-y-auto p-4">{loadingFacts ? <div className="py-10 text-center text-sm text-slate-400">正在装配当前公司的本地事实</div> : <>
          {panel === 'exposure' && <ExposurePanel exposures={exposures} disclosures={disclosures} onEdit={openExposure} onEditDisclosure={openDisclosure} />}
          {panel === 'timeline' && <TimelinePanel timeline={timeline} datasets={timelineDatasets} onDatasetsChange={setTimelineDatasets} />}
          {panel === 'validation' && <ValidationPanel validation={validation} syncing={syncing} canSync={Boolean(selectedSecurity)} onSync={() => void syncFinancials([...FINANCIAL_DATASETS])} />}
          {panel === 'bridge' && <BridgePanel bridge={bridge} bridgeKey={bridgeKey} onBridgeKeyChange={setBridgeKey} onLoad={() => setActiveBridgeKey(bridgeKey.trim())} onEdit={() => { setError(null); setDialog('bridge') }} />}
          {panel === 'sync' && <SyncPanel states={syncStates} selected={syncDatasets} onSelectedChange={setSyncDatasets} syncing={syncing} security={selectedSecurity} onSync={() => void syncFinancials()} />}
        </>}</div>
      </>}
    </section>
    {dialog === 'company' && <ResearchCompanyDialog company={editingCompany} security={editingCompany ? selectedSecurity : null} saving={saving} error={error} onClose={closeDialog} onSubmit={draft => void saveCompany(draft)} />}
    {dialog === 'disclosure' && <ResearchDisclosureEvidenceDialog evidence={editingDisclosure} saving={saving} error={error} onClose={closeDialog} onSubmit={draft => void saveDisclosure(draft)} />}
    {dialog === 'exposure' && <ResearchBusinessExposureDialog exposure={editingExposure} nodes={graph?.nodes ?? []} evidence={disclosures} saving={saving} error={error} onClose={closeDialog} onSubmit={draft => void saveExposure(draft)} />}
    {dialog === 'bridge' && selectedCompany && <ResearchProfitBridgeDialog bridge={bridge} defaultBridgeKey={bridgeKey} timeline={timeline} evidence={disclosures} saving={saving} error={error} onClose={closeDialog} onSubmit={draft => void saveBridge(draft)} />}
  </div>
}

function ExposurePanel({ exposures, disclosures, onEdit, onEditDisclosure }: { exposures: BusinessExposure[]; disclosures: DisclosureEvidence[]; onEdit: (exposure: BusinessExposure) => void; onEditDisclosure: (evidence: DisclosureEvidence) => void }): React.ReactElement {
  return <div data-testid="industry-research-company-exposure" className="space-y-6"><ResearchBusinessExposureOverview exposures={exposures} onEdit={onEdit} /><section><div className="mb-2 flex items-center justify-between"><h4 className="text-sm font-semibold">官方公告证据</h4><span className="text-xs text-slate-400">{disclosures.length} 条</span></div>{disclosures.length ? <div className="grid gap-2 xl:grid-cols-2">{disclosures.map(item => <article key={item.id} className="rounded-md border border-slate-200 p-3 dark:border-slate-700"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm font-medium">{item.title}</div><div className="mt-1 text-xs text-slate-400">实际披露 {formatDate(item.actualPublishedDate ?? item.publishedDate)} · {item.primarySourceConfirmed ? '人工已确认' : '未确认'}</div></div><button type="button" onClick={() => onEditDisclosure(item)} className="shrink-0 rounded border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-700">维护</button></div>{item.excerpt && <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{item.excerpt}</p>}<a href={item.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-cyan-700 hover:underline dark:text-cyan-300">打开官方原文</a></article>)}</div> : <Empty text="尚未登记当前公司的官方公告链接。" />}</section></div>
}

function TimelinePanel({ timeline, datasets, onDatasetsChange }: { timeline: FinancialTimelineRevision[]; datasets: FinancialDataset[]; onDatasetsChange: (value: FinancialDataset[]) => void }): React.ReactElement {
  const toggle = (dataset: FinancialDataset) => onDatasetsChange(datasets.includes(dataset) ? datasets.filter(item => item !== dataset) : [...datasets, dataset])
  return <div data-testid="industry-research-company-timeline" className="space-y-3"><div className="flex flex-wrap gap-1.5">{FINANCIAL_DATASETS.map(dataset => <button key={dataset} type="button" aria-pressed={datasets.includes(dataset)} onClick={() => toggle(dataset)} className={`rounded-md border px-2 py-1 text-[11px] ${datasets.includes(dataset) ? 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/20 dark:text-cyan-300' : 'border-slate-200 text-slate-400 dark:border-slate-700'}`}>{FINANCIAL_DATASET_LABELS[dataset]}</button>)}</div>{timeline.length ? timeline.map(revision => {
    const revisionLabel = revision.factKind === 'derived'
      ? revision.derivationStatus === 'derived' ? '已计算单季值' : '单季值待补齐'
      : revision.updateFlag === '1' ? '修订版' : '原始报告'
    return <article key={revision.key} data-testid="industry-research-financial-revision" className="rounded-md border border-slate-200 p-3 dark:border-slate-700"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="text-sm font-semibold">{FINANCIAL_DATASET_LABELS[revision.dataset]} · {formatFinancialReportPeriod(revision.reportPeriod)}</div><div className="mt-1 text-xs text-slate-500">{revision.knowledgeDate ? `${formatDate(revision.knowledgeDate)}披露` : '披露日期未记录'} · {revisionLabel}</div></div><span className="font-mono text-[11px] text-slate-500">{revision.tsCode ?? '公司口径'}</span></div><div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-px overflow-hidden rounded border border-slate-100 bg-slate-100 dark:border-slate-800 dark:bg-slate-800">{revision.metrics.map(metric => <div key={metric.factId} className="bg-white px-3 py-2 dark:bg-slate-900"><div className="text-xs text-slate-500">{getFinancialMetricLabel(revision.dataset, metric.name)}</div><div className="mt-1 text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">{formatFinancialMetricValue(revision.dataset, metric)}</div></div>)}</div><details className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500 dark:border-slate-800"><summary className="w-fit cursor-pointer select-none rounded px-1 py-1 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:bg-slate-800">技术详情</summary><dl className="mt-2 grid gap-2 rounded bg-slate-50 p-3 dark:bg-slate-950"><div><dt className="text-slate-400">来源接口</dt><dd className="mt-0.5 font-mono">{revision.dataset}</dd></div><div><dt className="text-slate-400">来源记录键</dt><dd className="mt-0.5 break-all font-mono">{revision.sourceFactKey}</dd></div><div><dt className="text-slate-400">版本哈希</dt><dd className="mt-0.5 break-all font-mono">{revision.sourceVersion}</dd></div><div><dt className="text-slate-400">上游修订标记</dt><dd className="mt-0.5 font-mono">{revision.updateFlag ?? '未提供'}</dd></div>{revision.formula && <div><dt className="text-slate-400">派生公式</dt><dd className="mt-0.5 break-all font-mono">{revision.formula}</dd></div>}{revision.inputFactIds.length > 0 && <div><dt className="text-slate-400">输入版本</dt><dd className="mt-0.5 space-y-1">{revision.inputFactIds.map(id => <code key={id} className="block break-all">{id}</code>)}</dd></div>}<div><dt className="text-slate-400">事实 ID</dt><dd className="mt-0.5 space-y-1">{revision.metrics.map(metric => <code key={metric.factId} className="block break-all">{getFinancialMetricLabel(revision.dataset, metric.name)}：{metric.factId}</code>)}</dd></div></dl></details></article>
  }) : <Empty text={datasets.length ? '当前证券上下文没有所选数据集的本地财务事实。' : '至少选择一个时间轴数据集。'} />}</div>
}

function ValidationPanel({ validation, syncing, canSync, onSync }: {
  validation: FinancialValidation | null
  syncing: boolean
  canSync: boolean
  onSync: () => void
}): React.ReactElement {
  if (!validation) return <Empty text="财务验证不可用。验证只读取当前公司的本地事实，不会借其他数据补零。" />
  const quality = [['应收账款', validation.quality.receivables], ['存货', validation.quality.inventory], ['合同资产', validation.quality.contractAssets], ['经营现金流', validation.quality.operatingCashflow], ['非经常损益（推导）', validation.quality.nonRecurringProfit]] as const
  const hasCoverage = validation.coverage.recentSingleQuarters.length > 0
    || validation.coverage.latestInterimPeriods.length > 0
    || validation.coverage.recentAnnualPeriods.length > 0
  return <div data-testid="industry-research-company-validation" className="space-y-4"><section className="rounded-md border border-slate-200 p-4 dark:border-slate-700"><div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="text-sm font-semibold">报表覆盖</h4><p className="mt-1 text-xs text-slate-400">{hasCoverage ? '本地事实已装配，可继续对照产业假设。' : '当前公司尚未同步结构化财报。'}</p></div><button type="button" data-testid="industry-research-validation-sync" disabled={!canSync || syncing} onClick={onSync} className="h-9 rounded-md bg-cyan-700 px-3 text-xs font-semibold text-white transition-colors hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-40">{syncing ? '同步中…' : hasCoverage ? '更新最新财报' : '同步最新财报'}</button></div><dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-slate-400">最近单季</dt><dd className="mt-1">{validation.coverage.recentSingleQuarters.map(formatQuarterPeriod).join(' · ') || '未知'}</dd></div><div><dt className="text-xs text-slate-400">最近中报</dt><dd className="mt-1">{validation.coverage.latestInterimPeriods.map(formatInterimPeriod).join(' · ') || '未知'}</dd></div><div><dt className="text-xs text-slate-400">最近年报</dt><dd className="mt-1">{validation.coverage.recentAnnualPeriods.map(formatAnnualPeriod).join(' · ') || '未知'}</dd></div><div><dt className="text-xs text-slate-400">预告或快报</dt><dd className="mt-1">{validation.coverage.latestForecastOrExpress ? `${validation.coverage.latestForecastOrExpress.dataset} · ${formatDate(validation.coverage.latestForecastOrExpress.periodEnd)}` : validation.coverage.latestForecastOrExpressReason ?? '未知'}</dd></div></dl></section><section><h4 className="mb-2 text-sm font-semibold">利润质量缺口</h4><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{quality.map(([label, metric]) => <div key={label} className="rounded-md border border-slate-200 p-3 dark:border-slate-700"><div className="text-xs text-slate-400">{label}</div><div className="mt-1 text-lg font-semibold">{formatFinancialValue(metric.value)}</div><div className="mt-1 text-xs leading-5 text-slate-500">{metric.reason ?? (metric.factId ? '有本地事实支撑' : '缺少本地事实')}</div></div>)}</div></section></div>
}

function BridgePanel({ bridge, bridgeKey, onBridgeKeyChange, onLoad, onEdit }: { bridge: ProfitBridge | null; bridgeKey: string; onBridgeKeyChange: (value: string) => void; onLoad: () => void; onEdit: () => void }): React.ReactElement {
  return <div data-testid="industry-research-company-bridge" className="space-y-3"><div className="flex flex-wrap items-end justify-between gap-3"><label className="min-w-52 flex-1 text-xs font-medium">利润桥键<input value={bridgeKey} onChange={event => onBridgeKeyChange(event.target.value)} className="research-input mt-1 font-mono" maxLength={128} /></label><div className="flex gap-2"><button type="button" disabled={!bridgeKey.trim()} onClick={onLoad} className="rounded-md border border-slate-300 px-3 py-2 text-xs disabled:opacity-40 dark:border-slate-700">查询</button><button type="button" onClick={onEdit} className="rounded-md bg-slate-900 px-3 py-2 text-xs text-white dark:bg-slate-100 dark:text-slate-900">{bridge ? '追加新版本' : '建立利润桥'}</button></div></div>{bridge ? <section data-testid="industry-research-profit-bridge" className="rounded-md border border-slate-200 p-4 dark:border-slate-700"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-semibold">{bridge.basePeriod} → {bridge.targetPeriod}</h4><div className="mt-1 text-xs text-slate-400">V{bridge.version} · {bridge.status === 'estimate' ? '估算' : '假设'} · 更新 {formatTimestamp(bridge.updatedAt)}</div></div><span className="rounded bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{bridge.items.length} 个桥接项</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{bridge.items.map(item => <div key={item.key} className="rounded border border-slate-100 px-3 py-2 dark:border-slate-800"><div className="text-xs text-slate-400">{item.label}</div><div className="mt-1 text-base font-semibold">{formatFinancialValue(item.amount, item.unit)}</div>{item.methodology && <div className="mt-1 text-xs text-slate-500">{item.methodology}</div>}</div>)}</div><div className="mt-3 rounded bg-slate-50 px-3 py-2 font-mono text-xs leading-5 text-slate-600 dark:bg-slate-950 dark:text-slate-300">{bridge.formula ?? '未填写公式'}</div></section> : <Empty text="当前桥键尚无利润桥版本。利润桥只追加保存，历史版本不会被覆盖。" />}</div>
}

function SyncPanel({ states, selected, onSelectedChange, syncing, security, onSync }: { states: FinancialSyncState[]; selected: FinancialDataset[]; onSelectedChange: (value: FinancialDataset[]) => void; syncing: boolean; security: ResearchSecurity | null; onSync: () => void }): React.ReactElement {
  const toggle = (dataset: FinancialDataset) => onSelectedChange(selected.includes(dataset) ? selected.filter(item => item !== dataset) : [...selected, dataset])
  return <div data-testid="industry-research-company-sync" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><h4 className="text-sm font-semibold">九数据集同步状态</h4><p className="mt-1 text-xs text-slate-400">只在点击同步时访问当前证券，数据集串行且相互隔离。</p></div><button type="button" disabled={!security || !selected.length || syncing} onClick={onSync} className="rounded-md bg-cyan-700 px-3 py-2 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{syncing ? '同步中' : `同步所选 ${selected.length} 项`}</button></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{states.map(state => <label key={state.dataset} data-testid={`industry-research-sync-${state.dataset}`} className="flex cursor-pointer gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700"><input type="checkbox" checked={selected.includes(state.dataset)} onChange={() => toggle(state.dataset)} className="mt-1" /><span className="min-w-0"><span className="flex items-center justify-between gap-2"><strong className="text-sm">{FINANCIAL_DATASET_LABELS[state.dataset]}</strong><span className={`text-[10px] ${state.status === 'success' ? 'text-emerald-600' : state.status === 'failed' ? 'text-red-600' : state.status === 'running' ? 'text-cyan-600' : 'text-slate-400'}`}>{state.status}</span></span><span className="mt-1 block text-xs text-slate-400">最近成功 {formatDate(state.lastSuccessFactDate)} · {state.lastSuccessRowCount ?? '未知'} 行</span>{state.lastErrorCode && <span className="mt-1 block font-mono text-[10px] text-red-500">{state.lastErrorCode}</span>}</span></label>)}</div></div>
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <div className="rounded-md border border-dashed border-slate-300 px-5 py-10 text-center text-sm leading-6 text-slate-400 dark:border-slate-700">{text}</div>
}
