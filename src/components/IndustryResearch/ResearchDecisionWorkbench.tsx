import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'
import { ResearchDecisionDialog, type ResearchDecisionSaveDraft } from './ResearchDecisionDialog'
import { getBeijingDateValue, ResearchCombobox, ResearchDatePicker } from './ResearchDecisionControls'
import { ResearchMonitoringDialog, ResearchObservationDialog, ResearchTriggerDialog, type MonitoringSaveDraft, type TriggerSaveDraft } from './ResearchMonitoringDialogs'
import { ResearchScenarioValuationDialog, type ResearchScenarioSaveDraft, type ResearchValuationFactOption } from './ResearchScenarioValuationDialog'
import { ResearchSkillAdoptionDialog } from './ResearchSkillAdoptionDialog'
import { ResearchWorkItemDialog, type ResearchWorkItemSaveDraft } from './ResearchWorkItemDialog'
import {
  DECISION_ACTION_LABELS,
  formatDecisionNumber,
  groupReviewQueue,
  reviewAgenda,
} from './industryResearchDecisionModel'
import { adaptFinancialTimeline, formatFinancialReportPeriod, getFinancialMetricLabel } from './industryResearchFinancialModel'
import type {
  IndustryResearchResponse,
  ResearchDecisionAction,
  ResearchDecisionItem,
  ResearchDecisionView,
  ResearchDecisionWorkbenchData,
  ResearchEvidence,
  ResearchHypothesis,
  ResearchMarketContext,
  ResearchMonitoringItem,
  ResearchProject,
  ResearchReviewQueueItem,
  ResearchScenarioSet,
  ResearchValuationPreview,
  ResearchWorkItem,
} from './industryResearchTypes'

type Dialog = 'scenario' | 'decision' | 'work' | 'skill' | 'monitor' | 'observation' | 'trigger' | 'resolve' | null

function responseError(response: IndustryResearchResponse<unknown>): string {
  return response.message || response.code || '产业研究决策操作失败'
}

function formatDate(value: string | number | null | undefined): string {
  if (value == null) return '未设置'
  if (typeof value === 'number') return new Date(value).toLocaleDateString('zh-CN')
  const compact = value.replaceAll('-', '')
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}` : value
}

function statusClass(status: 'ok' | 'degraded' | 'blocked'): string {
  return status === 'ok' ? 'text-emerald-700 dark:text-emerald-300' : status === 'degraded' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300'
}

const MARKET_STATUS_LABELS = { ok: '可用', degraded: '部分受限', blocked: '阻断' } as const
const SKILL_STATUS_LABELS: Record<string, string> = {
  current: '已采用当前规则',
  changed: '发现规则更新',
  current_skill_missing: '当前规则文件不可用',
  legacy_hash_only: '旧项目仅保留规则哈希',
  legacy_snapshot_missing: '旧项目规则快照缺失',
}
const WORK_EFFORT_LABELS: Record<string, string> = { quick_pass: '快速通过', standard_validation: '标准验证', deep_research: '深度研究' }
const WORK_STATUS_LABELS: Record<string, string> = { open: '进行中', blocked: '受阻', completed: '已完成', stopped: '已停止' }
const MONITORING_FREQUENCY_LABELS: Record<string, string> = { daily: '每日', weekly: '每周', monthly: '每月', quarterly: '每季', event_driven: '事件驱动' }
const MONITORING_STATUS_LABELS: Record<string, string> = { active: '启用', paused: '暂停', closed: '关闭' }
const TRIGGER_OPERATOR_LABELS: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', changed: '发生变化' }
const EVENT_TYPE_LABELS: Record<string, string> = { created: '创建', maintained: '维持', upgraded: '升级', downgraded: '降级', invalidated: '失效', closed: '关闭' }
const SUBJECT_KIND_LABELS: Record<string, string> = {
  decision: '研究决策', decision_trigger: '决策触发器', hypothesis: '研究假设',
  monitoring_item: '监控项', work_item: '研究工作项', project: '研究项目', skill_adoption: '规则采用',
}

export function ResearchDecisionWorkbench({ project, evidence, hypotheses, initialContext, onGoCompanies, onContextChange }: {
  project: ResearchProject
  evidence: ResearchEvidence[]
  hypotheses: ResearchHypothesis[]
  initialContext?: { view: ResearchDecisionView; companyId: string | null; securityId: string | null }
  onGoCompanies: () => void
  onContextChange?: (state: { view: ResearchDecisionView; companyId: string | null; securityId: string | null }) => void
}): React.ReactElement {
  const [view, setView] = useState<ResearchDecisionView>(initialContext?.view ?? 'current')
  const [data, setData] = useState<ResearchDecisionWorkbenchData | null>(null)
  const [companyId, setCompanyId] = useState<string | null>(initialContext?.companyId ?? null)
  const [securityId, setSecurityId] = useState<string | null>(initialContext?.securityId ?? null)
  const [valuationDate, setValuationDate] = useState(getBeijingDateValue())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [editingWork, setEditingWork] = useState<ResearchWorkItem | null>(null)
  const [editingMonitor, setEditingMonitor] = useState<ResearchMonitoringItem | null>(null)
  const [valuation, setValuation] = useState<ResearchValuationPreview | null>(null)
  const [valuationFacts, setValuationFacts] = useState<ResearchValuationFactOption[]>([])
  const [frozen, setFrozen] = useState<{ marketSnapshotId: string; valuationSnapshotId: string; status: 'ok' | 'degraded' | 'blocked' } | null>(null)
  const [selectedDecision, setSelectedDecision] = useState<ResearchDecisionItem | null>(null)
  const [replay, setReplay] = useState<Record<string, unknown> | null>(null)
  const [triggerReview, setTriggerReview] = useState<ResearchReviewQueueItem | null>(null)
  const [resolveItem, setResolveItem] = useState<ResearchReviewQueueItem | null>(null)
  const [resolveReason, setResolveReason] = useState('已检查当前规则、事实和后续动作。')
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number } | null>(null)
  const requestRef = useRef(0)

  const load = useCallback(async (targetCompany = companyId, targetSecurity = securityId, targetValuationDate = valuationDate) => {
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    const response = await window.api.industryResearch.getDecisionWorkbench({
      projectId: project.id,
      companyId: targetCompany,
      securityId: targetSecurity,
      valuationDate: targetValuationDate,
    }) as IndustryResearchResponse<ResearchDecisionWorkbenchData>
    if (requestId !== requestRef.current) return
    setLoading(false)
    if (!response.ok || !response.data) { setError(responseError(response)); return }
    setData(response.data)
    setCompanyId(response.data.selectedCompanyId)
    setSecurityId(response.data.selectedSecurityId)
    const companyDecisions = response.data.decisions.filter((item) => item.companyId === response.data!.selectedCompanyId)
    setSelectedDecision((current) => companyDecisions.find((item) => item.decisionId === current?.decisionId) ?? companyDecisions[0] ?? null)
  }, [companyId, project.id, securityId, valuationDate])

  useEffect(() => { void load(initialContext?.companyId ?? null, initialContext?.securityId ?? null) }, [project.id])
  useEffect(() => { onContextChange?.({ view, companyId, securityId }) }, [companyId, onContextChange, securityId, view])

  const selectedCompany = data?.companies.find((company) => company.company_id === companyId) ?? null
  const scenario = data?.scenarioSets[0] ?? null
  const market = data?.marketContext ?? null

  const refreshValuation = useCallback(async (source = scenario, context = market) => {
    if (!source?.valuationMethod || !companyId || !securityId || !context?.factFingerprint) { setValuation(null); return }
    const response = await window.api.industryResearch.previewValuation({
      projectId: project.id, companyId, securityId,
      valuationDate: source.valuationDate ?? valuationDate,
      valuationMethod: source.valuationMethod,
      scenarios: source.scenarios.map((item) => ({ name: item.name, weightPct: item.weightPct, inputs: item.valuationInputs, factIds: item.factIds })),
      marketFingerprint: context.factFingerprint,
    }) as IndustryResearchResponse<ResearchValuationPreview>
    if (response.ok && response.data) setValuation(response.data)
    else { setValuation(null); setError(responseError(response)) }
  }, [companyId, market, project.id, scenario, securityId, valuationDate])

  useEffect(() => { void refreshValuation() }, [scenario?.versionId, market?.factFingerprint])

  const run = async (operation: () => Promise<IndustryResearchResponse<unknown>>, success: string, reload = true) => {
    setSaving(true); setError(null); setNotice(null)
    const response = await operation()
    setSaving(false)
    if (!response.ok) { setError(responseError(response)); return false }
    setDialog(null); setNotice(success)
    if (reload) await load(companyId, securityId)
    return true
  }

  const changeCompany = async (next: string) => {
    const targetCompany = next || null
    const company = data?.companies.find((item) => item.company_id === targetCompany)
    const nextSecurity = company?.securities[0]?.id ?? null
    setCompanyId(targetCompany); setSecurityId(nextSecurity); setFrozen(null); setValuation(null); setValuationFacts([])
    await load(targetCompany, nextSecurity)
  }
  const changeSecurity = (next: string) => {
    const targetSecurity = next || null
    setSecurityId(targetSecurity); setFrozen(null); setValuation(null); setValuationFacts([])
    void load(companyId, targetSecurity)
  }

  const changeValuationDate = (next: string) => {
    setValuationDate(next)
    setFrozen(null)
    setValuation(null)
    setValuationFacts([])
    void load(companyId, securityId, next)
  }

  const syncMarket = async () => {
    if (!companyId || !securityId) return
    const targets = data?.companies
      .filter((company) => company.status !== 'excluded')
      .flatMap((company) => {
        const security = company.company_id === companyId
          ? company.securities.find((item) => item.id === securityId) ?? company.securities[0]
          : company.securities[0]
        return security ? [{ companyId: company.company_id, securityId: security.id }] : []
      }) ?? []
    targets.sort((left, right) => left.companyId === companyId ? -1 : right.companyId === companyId ? 1 : 0)
    if (!targets.length) return

    setSaving(true)
    setError(null)
    setNotice(null)
    setSyncProgress({ current: 0, total: targets.length })
    let succeeded = 0
    let partial = 0
    let failed = 0
    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]
        try {
          const response = await window.api.industryResearch.syncMarketData({
            projectId: project.id,
            companyId: target.companyId,
            securityId: target.securityId,
            requestId: crypto.randomUUID(),
            valuationDate,
          }) as IndustryResearchResponse<{ status?: string }>
          if (!response.ok) failed += 1
          else if (response.data?.status === 'success') succeeded += 1
          else partial += 1
        } catch {
          failed += 1
        }
        setSyncProgress({ current: index + 1, total: targets.length })
      }
    } finally {
      setSaving(false)
      setSyncProgress(null)
    }
    if (failed === targets.length) setError('项目行情补齐失败，请检查 Tushare 权限、网络和诊断页数据状态。')
    else setNotice(`项目行情补齐完成：完整 ${succeeded} 家，部分 ${partial} 家${failed ? `，失败 ${failed} 家` : ''}`)
    await load(companyId, securityId, valuationDate)
  }
  const saveScenario = async (draft: ResearchScenarioSaveDraft) => {
    if (!companyId) return
    const success = await run(() => window.api.industryResearch.saveScenarioSet({ projectId: project.id, companyId, requestId: crypto.randomUUID(), ...draft }) as Promise<IndustryResearchResponse<unknown>>, '情景版本已保存')
    if (success) setFrozen(null)
  }
  const openScenario = async () => {
    setDialog('scenario')
    if (!companyId || !securityId) { setValuationFacts([]); return }
    const response = await window.api.industryResearch.getFinancialTimeline({
      companyId, securityId,
      datasets: ['income', 'balancesheet', 'cashflow', 'fina_indicator'],
    }) as IndustryResearchResponse<unknown>
    if (!response.ok) { setValuationFacts([]); setError(responseError(response)); return }
    const revisions = adaptFinancialTimeline(response.data)
    const seen = new Set<string>()
    setValuationFacts(revisions.flatMap((revision) => revision.metrics.flatMap((metric) => {
      if (seen.has(metric.factId) || metric.value == null || !metric.unit) return []
      seen.add(metric.factId)
      return [{
        factId: metric.factId,
        label: `${getFinancialMetricLabel(revision.dataset, metric.name)} · ${formatFinancialReportPeriod(revision.reportPeriod)} · ${revision.updateFlag === '1' ? '修订版' : '原始报告'}`,
        value: metric.value,
        unit: metric.unit,
        currency: metric.currency,
      }]
    })))
  }
  const capture = async () => {
    if (!companyId || !securityId || !scenario || !market?.factFingerprint) return
    setSaving(true); setError(null)
    const response = await window.api.industryResearch.captureValuationSnapshot({
      projectId: project.id, companyId, securityId, requestId: crypto.randomUUID(),
      scenarioSetVersionId: scenario.versionId, valuationDate: scenario.valuationDate ?? valuationDate,
      marketFingerprint: market.factFingerprint,
    }) as IndustryResearchResponse<{ marketSnapshotId: string; valuationSnapshotId: string; status: 'ok' | 'degraded' | 'blocked' }>
    setSaving(false)
    if (!response.ok || !response.data) { setError(responseError(response)); return }
    setFrozen(response.data); setNotice('市场与估值快照已冻结')
  }
  const saveWork = (draft: ResearchWorkItemSaveDraft) => run(() => window.api.industryResearch.saveWorkItem({ projectId: project.id, requestId: crypto.randomUUID(), ...draft }) as Promise<IndustryResearchResponse<unknown>>, '研究工作项已保存')
  const adoptSkill = (note: string) => {
    if (!data?.skillAdoption.current) return Promise.resolve(false)
    return run(() => window.api.industryResearch.adoptSkillVersion({ projectId: project.id, requestId: crypto.randomUUID(), targetContentHash: data.skillAdoption.current!.contentHash, migrationNote: note, expectedUpdatedAt: data.skillAdoption.projectUpdatedAt }) as Promise<IndustryResearchResponse<unknown>>, '新规则已采用，分组复核已生成')
  }
  const saveMonitor = (draft: MonitoringSaveDraft) => run(() => window.api.industryResearch.saveMonitoringItem({ projectId: project.id, requestId: crypto.randomUUID(), ...draft }) as Promise<IndustryResearchResponse<unknown>>, '监控项已保存')
  const saveObservation = (value: number | string, sourceRef: string | null) => {
    if (!editingMonitor) return Promise.resolve(false)
    const now = Date.now()
    return run(() => window.api.industryResearch.appendMonitoringObservation({ projectId: project.id, requestId: crypto.randomUUID(), monitoringItemId: editingMonitor.id, expectedVersion: editingMonitor.version, value, unit: editingMonitor.unit, sourceRef, observedAt: now, availableAt: now, dataAsOf: new Date(now).toISOString().slice(0, 10), methodologyVersion: 'manual-observation-v1' }) as Promise<IndustryResearchResponse<unknown>>, '监控观测已追加')
  }
  const saveTrigger = (draft: TriggerSaveDraft) => run(() => window.api.industryResearch.saveDecisionTrigger({ projectId: project.id, requestId: crypto.randomUUID(), ...draft }) as Promise<IndustryResearchResponse<unknown>>, '触发器已保存')
  const evaluate = () => {
    const ids = data?.triggers.filter((item) => item.status === 'active').map((item) => item.id) ?? []
    if (!ids.length) { setError('当前没有可求值的活动触发器'); return }
    void run(() => window.api.industryResearch.evaluateDecisionTriggers({ projectId: project.id, requestId: crypto.randomUUID(), triggerIds: ids }) as Promise<IndustryResearchResponse<unknown>>, '触发器求值完成')
  }
  const saveDecision = async (draft: ResearchDecisionSaveDraft) => {
    const currentDecision = triggerReview
      ? data?.decisions.find((item) => item.decisionId === triggerReview.payload?.decisionId) ?? null
      : selectedDecision
    const decisionCompanyId = currentDecision ? currentDecision.companyId : companyId
    if (triggerReview?.sourceEventId) {
      const success = await run(() => window.api.industryResearch.resolveTriggerReview({
        projectId: project.id, evaluationId: triggerReview.sourceEventId!, requestId: crypto.randomUUID(),
        resolution: 'confirm', reason: draft.rationale,
        decisionEvent: { projectId: project.id, companyId: decisionCompanyId, requestId: crypto.randomUUID(), ...draft },
      }) as Promise<IndustryResearchResponse<unknown>>, '触发已确认并追加决策')
      if (success) setTriggerReview(null)
      return
    }
    await run(() => window.api.industryResearch.appendDecisionEvent({ projectId: project.id, companyId: decisionCompanyId, requestId: crypto.randomUUID(), ...draft }) as Promise<IndustryResearchResponse<unknown>>, '研究决策已保存')
  }
  const resolveReview = async () => {
    if (!resolveItem) return
    const response = resolveItem.kind === 'trigger' && resolveItem.sourceEventId
      ? () => window.api.industryResearch.resolveTriggerReview({ projectId: project.id, evaluationId: resolveItem.sourceEventId!, requestId: crypto.randomUUID(), resolution: 'dismiss', reason: resolveReason })
      : () => window.api.industryResearch.resolveReviewItem({ projectId: project.id, reviewGroupId: resolveItem.id, requestId: crypto.randomUUID(), resolution: 'dismiss', reason: resolveReason })
    const success = await run(response as () => Promise<IndustryResearchResponse<unknown>>, '待复核事项已驳回')
    if (success) setResolveItem(null)
  }
  const openReplay = async (decision: ResearchDecisionItem) => {
    setSelectedDecision(decision); setReplay(null); setError(null)
    const response = await window.api.industryResearch.getDecisionReplay(project.id, decision.decisionId) as IndustryResearchResponse<Record<string, unknown>>
    if (!response.ok || !response.data) { setError(responseError(response)); return }
    setReplay(response.data)
  }

  if (loading && !data) return <div className="py-12 text-center text-sm text-slate-400">正在装配决策事实</div>
  if (!data) return <div className="border-l-2 border-red-500 pl-3 text-sm text-red-700">{error ?? '决策工作台不可用'}</div>

  const pendingCount = data.reviewQueue.length
  const triggerDecision = triggerReview
    ? data.decisions.find((item) => item.decisionId === triggerReview.payload?.decisionId) ?? null
    : null
  const panelLabels: Array<[ResearchDecisionView, string]> = [['current', '当前研判'], ['review', `待复核 ${pendingCount}`], ['monitoring', '监控与回访'], ['history', '历史']]
  const companyOptions = data.companies.map((company) => ({
    value: company.company_id,
    label: company.display_name,
    meta: company.trend_score != null
      ? `综合分 ${Math.round(company.trend_score)} · ${company.trend_score_ts_code ?? company.securities[0]?.ts_code ?? '公司口径'}`
      : company.securities[0]?.ts_code ?? `${company.securities.length} 个证券`,
  }))
  const securityOptions = (selectedCompany?.securities ?? []).map((security) => ({
    value: security.id,
    label: security.ts_code,
    meta: security.exchange,
  }))
  return <div data-testid="industry-research-decision-workbench" className="min-w-0 space-y-4">
    <section className="border-b border-slate-200 pb-3 dark:border-slate-800">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-3">
          <ControlField label="项目公司">
            <ResearchCombobox testId="industry-research-decision-company" value={companyId ?? ''} options={companyOptions} placeholder="选择项目公司" searchPlaceholder="搜索公司或证券代码" disabled={saving} onChange={(next) => void changeCompany(next)} />
          </ControlField>
          <ControlField label="证券">
            <ResearchCombobox testId="industry-research-decision-security" value={securityId ?? ''} options={securityOptions} placeholder="选择证券" searchPlaceholder="搜索证券代码" disabled={saving || !companyId} onChange={changeSecurity} />
          </ControlField>
          <ControlField label="估值请求日">
            <ResearchDatePicker value={valuationDate} max={getBeijingDateValue()} disabled={saving} onChange={setValuationDate} onCommit={changeValuationDate} />
          </ControlField>
        </div>
        <button type="button" data-testid="industry-research-sync-project-market" disabled={!companyId || !securityId || saving} onClick={() => void syncMarket()} className="min-h-10 shrink-0 rounded-md bg-cyan-700 px-3 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40">{syncProgress ? `补齐 ${syncProgress.current}/${syncProgress.total}` : '补齐项目行情'}</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1 sm:grid-cols-4 dark:bg-slate-800" role="tablist">
        {panelLabels.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} data-testid={`industry-research-decision-panel-${key}`} className={`min-h-9 rounded px-2 text-xs ${view === key ? 'bg-white font-semibold shadow-sm dark:bg-slate-950' : 'text-slate-500'}`}>{label}</button>)}
      </div>
    </section>
    {(error || notice) && <div role={error ? 'alert' : 'status'} className={`flex items-start justify-between gap-3 border-l-2 pl-3 text-xs ${error ? 'border-red-500 text-red-700 dark:text-red-300' : 'border-emerald-500 text-emerald-700 dark:text-emerald-300'}`}><span>{error || notice}</span><button type="button" onClick={() => { setError(null); setNotice(null) }} className="font-medium">关闭</button></div>}
    {view === 'current' && <CurrentView data={data} market={market} valuation={valuation} scenario={scenario} frozen={frozen} selectedDecision={selectedDecision} onGoCompanies={onGoCompanies} onSkill={() => setDialog('skill')} onScenario={() => void openScenario()} onCapture={() => void capture()} onDecision={() => setDialog('decision')} onWork={(item) => { setEditingWork(item); setDialog('work') }} saving={saving} />}
    {view === 'review' && <ReviewView items={data.reviewQueue} onConfirm={(item) => { if (item.kind === 'trigger') { void (async () => { const target = data.decisions.find((decision) => decision.decisionId === item.payload?.decisionId); if (target?.companyId && target.companyId !== companyId) await changeCompany(target.companyId); setTriggerReview(item); setDialog('decision') })() } else { setResolveItem(item); setDialog('resolve') } }} onDismiss={(item) => { setResolveItem(item); setDialog('resolve') }} />}
    {view === 'monitoring' && <MonitoringView items={data.monitoringItems} triggers={data.triggers} queue={data.reviewQueue} onAdd={() => { setEditingMonitor(null); setDialog('monitor') }} onEdit={(item) => { setEditingMonitor(item); setDialog('monitor') }} onObserve={(item) => { setEditingMonitor(item); setDialog('observation') }} onTrigger={() => setDialog('trigger')} onEvaluate={evaluate} />}
    {view === 'history' && <HistoryView decisions={data.decisions} selected={selectedDecision} replay={replay} onOpen={(item) => void openReplay(item)} />}

    {dialog === 'scenario' && market && <ResearchScenarioValuationDialog current={scenario} market={market} facts={valuationFacts} saving={saving} error={error} onClose={() => setDialog(null)} onSubmit={(draft) => void saveScenario(draft)} />}
    {dialog === 'work' && <ResearchWorkItemDialog item={editingWork} saving={saving} error={error} onClose={() => setDialog(null)} onSubmit={(draft) => void saveWork(draft)} />}
    {dialog === 'skill' && <ResearchSkillAdoptionDialog adoption={data.skillAdoption} saving={saving} error={error} onClose={() => setDialog(null)} onSubmit={(note) => void adoptSkill(note)} />}
    {dialog === 'monitor' && <ResearchMonitoringDialog item={editingMonitor} decisions={data.decisions} saving={saving} error={error} onClose={() => setDialog(null)} onSubmit={(draft) => void saveMonitor(draft)} />}
    {dialog === 'observation' && editingMonitor && <ResearchObservationDialog item={editingMonitor} saving={saving} error={error} onClose={() => setDialog(null)} onSubmit={(value, sourceRef) => void saveObservation(value, sourceRef)} />}
    {dialog === 'trigger' && <ResearchTriggerDialog decisions={data.decisions} monitoringItems={data.monitoringItems} saving={saving} error={error} onClose={() => setDialog(null)} onSubmit={(draft) => void saveTrigger(draft)} />}
    {dialog === 'decision' && <ResearchDecisionDialog current={triggerDecision ?? selectedDecision} forcedDecisionId={typeof triggerReview?.payload?.decisionId === 'string' ? triggerReview.payload.decisionId : null} forcedAction={typeof triggerReview?.payload?.proposedAction === 'string' ? triggerReview.payload.proposedAction as ResearchDecisionAction : null} sourceTriggerEvaluationId={triggerReview?.sourceEventId ?? null} scenario={scenario} workItems={data.workItems} evidence={evidence} hypotheses={hypotheses} marketSnapshotId={frozen?.marketSnapshotId ?? triggerDecision?.marketSnapshotId ?? selectedDecision?.marketSnapshotId ?? null} valuationSnapshotId={frozen?.valuationSnapshotId ?? triggerDecision?.valuationSnapshotId ?? selectedDecision?.valuationSnapshotId ?? null} snapshotBlocked={frozen?.status === 'blocked' || valuation?.status === 'blocked'} saving={saving} error={error} onClose={() => { setDialog(null); setTriggerReview(null) }} onSubmit={(draft) => void saveDecision(draft)} />}
    {dialog === 'resolve' && resolveItem && <DialogFrame title={resolveItem.kind === 'trigger' ? '驳回触发复核' : '处置分组复核'} onClose={saving ? () => undefined : () => setDialog(null)}><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (resolveReason.trim()) void resolveReview() }}><p className="text-sm leading-6">{resolveItem.reason}</p><Field label="处置原因"><textarea value={resolveReason} onChange={(event) => setResolveReason(event.target.value)} className="research-input min-h-20 resize-y py-2" /></Field><DialogActions saving={saving} valid={Boolean(resolveReason.trim())} onClose={() => setDialog(null)} submitLabel="驳回并追加事实" /></form></DialogFrame>}
  </div>
}

function CurrentView({ data, market, valuation, scenario, frozen, selectedDecision, onGoCompanies, onSkill, onScenario, onCapture, onDecision, onWork, saving }: {
  data: ResearchDecisionWorkbenchData
  market: ResearchMarketContext | null
  valuation: ResearchValuationPreview | null
  scenario: ResearchScenarioSet | null
  frozen: { status: 'ok' | 'degraded' | 'blocked' } | null
  selectedDecision: ResearchDecisionItem | null
  onGoCompanies: () => void
  onSkill: () => void
  onScenario: () => void
  onCapture: () => void
  onDecision: () => void
  onWork: (item: ResearchWorkItem | null) => void
  saving: boolean
}): React.ReactElement {
  return <div data-testid="industry-research-decision-current" className="space-y-5">
    {data.skillAdoption.status !== 'current' && <section className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-500 pl-3"><div><h3 className="text-sm font-semibold">研究规则需要处理</h3><p className="mt-1 text-xs text-slate-500">状态：{SKILL_STATUS_LABELS[data.skillAdoption.status] ?? data.skillAdoption.status}</p></div><button type="button" disabled={!data.skillAdoption.current} onClick={onSkill} className="min-h-9 rounded-md border border-amber-300 px-3 text-xs font-medium text-amber-700 disabled:opacity-40">查看差异并采用</button></section>}
    {!market?.tsCode && <section className="flex items-center justify-between gap-3 border-l-2 border-amber-500 pl-3"><span className="text-sm">项目缺少可用公司证券映射。</span><button type="button" onClick={onGoCompanies} className="rounded-md border border-slate-300 px-3 py-2 text-xs">维护公司与证券</button></section>}
    {market && <section aria-labelledby="market-heading" className="space-y-3"><div className="flex items-center justify-between"><div><h3 id="market-heading" className="text-sm font-semibold">市场定价</h3><p className={`mt-1 text-xs ${statusClass(market.status)}`}>{MARKET_STATUS_LABELS[market.status]} · 共同行情日 {formatDate(market.marketDate)}</p></div><span className="font-mono text-xs text-slate-400">{market.tsCode ?? '未选择'}</span></div>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-3 dark:border-slate-800 dark:bg-slate-800">
        <Metric label="收盘价" value={formatDecisionNumber(market.rawClose, ' 元')} />
        <Metric label="基准" value={market.benchmarkName ?? '不可用'} />
        <Metric label="PE TTM" value={formatDecisionNumber(market.valuationDaily?.peTtm)} />
        <Metric label="PB" value={formatDecisionNumber(market.valuationDaily?.pb)} />
        <Metric label={`PE历史位置 · ${market.valuationHistory?.peTtm.sampleCount ?? 0}日`} value={formatDecisionNumber(market.valuationHistory?.peTtm.percentile, '%')} />
        <Metric label={`PB历史位置 · ${market.valuationHistory?.pb.sampleCount ?? 0}日`} value={formatDecisionNumber(market.valuationHistory?.pb.percentile, '%')} />
      </div>
      {market.reasons.length > 0 && <div className="space-y-1 border-l-2 border-amber-400 pl-3 text-xs text-slate-600 dark:text-slate-300">{market.reasons.map((reason) => <div key={`${reason.code}-${reason.scope}`}>{reason.message}</div>)}</div>}
      {market.comparables?.status === 'blocked' && <div className="border-l-2 border-slate-300 pl-3 text-xs text-slate-500">项目内可比样本不足（{market.comparables.sampleCount}/{market.comparables.minimumSample}），不显示伪排名。</div>}
      {market.comparables?.status === 'ok' && <details className="border-l-2 border-slate-300 pl-3"><summary className="cursor-pointer text-xs font-medium">项目内可比 · {market.comparables.sampleCount}家公司</summary><div className="mt-2 overflow-hidden rounded-md border border-slate-200 dark:border-slate-700"><table className="w-full table-fixed text-left text-xs"><thead className="bg-slate-50 text-slate-500 dark:bg-slate-900"><tr><th className="w-[38%] px-3 py-2">公司</th><th className="px-3 py-2 text-right">PE</th><th className="px-3 py-2 text-right">PB</th><th className="px-3 py-2 text-right">PS</th></tr></thead><tbody>{market.comparables.rows.map((item) => <tr key={item.companyId} className="border-t border-slate-100 dark:border-slate-800"><td className="px-3 py-2"><span className="block truncate" title={item.companyName}>{item.companyName}</span><span className="font-mono text-[10px] text-slate-400">{item.tsCode}</span></td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.peTtm)}</td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.pb)}</td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.psTtm)}</td></tr>)}</tbody></table></div></details>}
      {market.series.length > 1 && <div className="h-[220px] w-full" aria-label="个股前复权与基准指数归一化相对表现"><ResponsiveContainer width="100%" height="100%"><LineChart data={market.series} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}><CartesianGrid strokeDasharray="3 3" opacity={0.25} /><XAxis dataKey="tradeDate" tick={{ fontSize: 10 }} minTickGap={32} /><YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} /><Tooltip /><Legend /><Line type="monotone" dataKey="stock" name="个股前复权" stroke="#c2413b" dot={false} strokeWidth={1.8} connectNulls={false} /><Line type="monotone" dataKey="benchmark" name="基准指数" stroke="#168a9f" dot={false} strokeWidth={1.6} /></LineChart></ResponsiveContainer></div>}
      <div className="overflow-hidden rounded-md border border-slate-200 dark:border-slate-700"><table className="w-full table-fixed text-left text-xs"><thead className="bg-slate-50 text-slate-500 dark:bg-slate-900"><tr><th className="w-[34%] px-3 py-2">窗口</th><th className="px-3 py-2 text-right">个股</th><th className="px-3 py-2 text-right">基准</th><th className="px-3 py-2 text-right">超额</th></tr></thead><tbody>{market.windows.map((item) => <tr key={item.days} className="border-t border-slate-100 dark:border-slate-800"><td className="px-3 py-2"><span className="block">{item.days}日 · {item.status}</span>{item.reason && <span className="mt-0.5 block truncate text-[10px] text-slate-400" title={item.reason}>{item.reason}</span>}</td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.stockReturnPct, '%')}</td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.benchmarkReturnPct, '%')}</td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.excessReturnPct, '%')}</td></tr>)}</tbody></table></div>
      {market.events?.length > 0 && <details className="border-t border-slate-200 pt-3 dark:border-slate-800"><summary className="cursor-pointer text-xs font-medium">关键事件窗口 · {market.events.length}</summary><div className="mt-2 overflow-hidden rounded-md border border-slate-200 dark:border-slate-700"><table className="w-full table-fixed text-left text-xs"><thead className="bg-slate-50 text-slate-500 dark:bg-slate-900"><tr><th className="w-[42%] px-3 py-2">事件</th><th className="px-3 py-2 text-right">前5日</th><th className="px-3 py-2 text-right">后5日</th><th className="px-3 py-2 text-right">后5日超额</th></tr></thead><tbody>{market.events.slice(0, 8).map((item) => <tr key={item.id} className="border-t border-slate-100 dark:border-slate-800"><td className="px-3 py-2"><span className="block truncate" title={item.label}>{item.label}</span><span className="mt-0.5 block text-[10px] text-slate-400">{formatDate(item.anchorDate ?? item.availableDate)} · {item.kind}</span></td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.pre5Pct, '%')}</td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.post5Pct, '%')}</td><td className="px-3 py-2 text-right font-mono">{formatDecisionNumber(item.excessPost5Pct, '%')}</td></tr>)}</tbody></table></div></details>}
    </section>}
    <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">三情景估值</h3><p className="mt-1 text-xs text-slate-500">{scenario ? `V${scenario.version} · ${scenario.valuationMethod ?? '未配置方法'}` : '尚未建立情景'}</p></div><div className="flex gap-2"><button type="button" onClick={onScenario} className="rounded-md border border-slate-300 px-3 py-2 text-xs">{scenario ? '追加版本' : '建立情景'}</button><button type="button" disabled={!scenario || !valuation || saving} onClick={onCapture} className="rounded-md bg-slate-900 px-3 py-2 text-xs text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900">冻结估值</button></div></div>
      {valuation ? <><div className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-3 dark:border-slate-800 dark:bg-slate-800">{valuation.scenarios.map((item) => <div key={item.name} className="min-w-0 bg-white px-3 py-3 dark:bg-slate-950"><div className="text-[11px] text-slate-400">{item.name === 'bear' ? '悲观' : item.name === 'base' ? '基准' : '乐观'}</div><div className="mt-1 font-mono text-base font-semibold">{formatDecisionNumber(item.fairPrice, ' 元')}</div><div className={`mt-1 text-[10px] ${statusClass(item.status)}`}>{MARKET_STATUS_LABELS[item.status]}</div>{item.impliedAssumptionLabel && <div className="mt-2 text-[10px] leading-4 text-slate-500"><span className="block">{item.impliedAssumptionLabel}</span><span className="font-mono">{formatDecisionNumber(item.impliedAssumption)}</span></div>}</div>)}</div><div className="grid gap-2 text-xs sm:grid-cols-4"><MetricLine label="价值区间" value={`${formatDecisionNumber(valuation.fairValueLow)} - ${formatDecisionNumber(valuation.fairValueHigh)}`} /><MetricLine label="加权价值" value={formatDecisionNumber(valuation.weightedFairValue, ' 元')} /><MetricLine label="上行/下行" value={`${formatDecisionNumber(valuation.upsidePct, '%')} / ${formatDecisionNumber(valuation.downsidePct, '%')}`} /><MetricLine label="收益风险比" value={formatDecisionNumber(valuation.rewardRiskRatio)} /></div>{valuation.reasons.length > 0 && <details className="border-l-2 border-amber-400 pl-3 text-xs text-slate-600 dark:text-slate-300"><summary className="cursor-pointer">估值限制与缺口 · {valuation.reasons.length}</summary><ul className="mt-2 space-y-1">{valuation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></details>}{frozen && <div className={`border-l-2 pl-3 text-xs ${frozen.status === 'blocked' ? 'border-red-500 text-red-700' : 'border-emerald-500 text-emerald-700'}`}>已冻结快照 · {MARKET_STATUS_LABELS[frozen.status]}</div>}</> : <div className="border-l-2 border-slate-300 pl-3 text-xs text-slate-500">保存完整情景并具备市场事实后才显示估值结果。</div>}
    </section>
    <section className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800"><div className="flex items-center justify-between"><div><h3 className="text-sm font-semibold">当前研究动作</h3><p className="mt-1 text-xs text-slate-500">{selectedDecision ? `${DECISION_ACTION_LABELS[selectedDecision.action]} · 有效至 ${formatDate(selectedDecision.validUntil)}` : '尚未保存决策'}</p></div><button type="button" onClick={onDecision} className="rounded-md bg-cyan-700 px-3 py-2 text-xs font-semibold text-white">{selectedDecision ? '追加事件' : '建立决策'}</button></div>{selectedDecision && <div className="grid gap-3 sm:grid-cols-[1fr_1fr]"><div><div className="text-xs text-slate-400">依据</div><p className="mt-1 text-sm leading-6">{selectedDecision.rationale}</p></div><div><div className="text-xs text-slate-400">失效条件</div><p className="mt-1 text-sm leading-6">{selectedDecision.invalidationCondition}</p></div></div>}</section>
    <section className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">研究工作项</h3><button type="button" onClick={() => onWork(null)} className="rounded-md border border-slate-300 px-3 py-2 text-xs">新增</button></div>{data.workItems.length ? data.workItems.map((item) => <button key={item.versionId} type="button" onClick={() => onWork(item)} className="flex w-full items-start justify-between gap-3 border-t border-slate-100 py-3 text-left first:border-t-0 dark:border-slate-800"><span><span className="block text-sm font-medium">{item.question}</span><span className="mt-1 block text-xs text-slate-400">{WORK_EFFORT_LABELS[item.effort] ?? item.effort} · {WORK_STATUS_LABELS[item.status] ?? item.status}</span></span><span className="shrink-0 text-xs text-cyan-700">维护</span></button>) : <div className="text-xs text-slate-500">暂无研究工作项。</div>}</section>
  </div>
}

function ReviewView({ items, onConfirm, onDismiss }: { items: ResearchReviewQueueItem[]; onConfirm: (item: ResearchReviewQueueItem) => void; onDismiss: (item: ResearchReviewQueueItem) => void }): React.ReactElement {
  const groups = groupReviewQueue(items)
  return <div data-testid="industry-research-decision-review" className="space-y-5">{groups.length ? groups.map((group) => <section key={group.kind}><div className="flex items-center justify-between border-b border-slate-200 pb-2 dark:border-slate-800"><h3 className="text-sm font-semibold">{group.label}</h3><span className="text-xs text-slate-400">{group.items.length}</span></div><div className="divide-y divide-slate-100 dark:divide-slate-800">{group.items.map((item) => <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3"><div className="min-w-0 flex-1"><div className="text-sm leading-6">{item.reason}</div><div className="mt-1 text-xs text-slate-400">{SUBJECT_KIND_LABELS[item.subjectKind] ?? item.subjectKind} · {item.dueAt ? formatDate(item.dueAt) : '无固定日期'}</div></div><div className="flex gap-2">{item.persisted && <button type="button" onClick={() => onDismiss(item)} className="rounded-md border border-slate-300 px-3 py-2 text-xs">驳回</button>}<button type="button" onClick={() => onConfirm(item)} className="rounded-md bg-cyan-700 px-3 py-2 text-xs font-medium text-white">{item.kind === 'trigger' ? '复核并更新决策' : '处置分组'}</button></div></div>)}</div></section>) : <div className="py-12 text-center text-sm text-slate-400">当前没有待复核事项</div>}</div>
}

function MonitoringView({ items, triggers, queue, onAdd, onEdit, onObserve, onTrigger, onEvaluate }: {
  items: ResearchMonitoringItem[]
  triggers: ResearchDecisionWorkbenchData['triggers']
  queue: ResearchReviewQueueItem[]
  onAdd: () => void
  onEdit: (item: ResearchMonitoringItem) => void
  onObserve: (item: ResearchMonitoringItem) => void
  onTrigger: () => void
  onEvaluate: () => void
}): React.ReactElement {
  const agenda = reviewAgenda(queue)
  return <div data-testid="industry-research-decision-monitoring" className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.8fr)]"><div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">监控项与触发器</h3><div className="flex flex-wrap gap-2"><button type="button" onClick={onAdd} className="rounded-md border border-slate-300 px-3 py-2 text-xs">新增监控</button><button type="button" disabled={!items.length} onClick={onTrigger} className="rounded-md border border-slate-300 px-3 py-2 text-xs disabled:opacity-40">新增触发器</button><button type="button" disabled={!triggers.length} onClick={onEvaluate} className="rounded-md bg-cyan-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40">显式求值</button></div></div><div className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">{items.map((item) => <div key={item.versionId} className="py-3"><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-medium">{item.name}</div><div className="mt-1 text-xs text-slate-400">{MONITORING_FREQUENCY_LABELS[item.frequency] ?? item.frequency} · {item.sourceName} · {MONITORING_STATUS_LABELS[item.status] ?? item.status}</div></div><div className="flex gap-2"><button type="button" onClick={() => onObserve(item)} className="rounded border border-slate-300 px-2 py-1.5 text-xs">追加观测</button><button type="button" onClick={() => onEdit(item)} className="rounded border border-slate-300 px-2 py-1.5 text-xs">维护</button></div></div><div className="mt-2 text-xs text-slate-600 dark:text-slate-300">最新：{item.latestObservation ? `${String(item.latestObservation.value)} ${item.latestObservation.unit ?? ''} · ${formatDate(item.latestObservation.dataAsOf)}` : '缺少观测'}</div></div>)}</div>{triggers.length > 0 && <div><h4 className="text-xs font-semibold text-slate-500">活动触发器</h4>{triggers.map((trigger) => <div key={trigger.versionId} className="mt-2 border-l-2 border-slate-300 pl-3 text-xs">{trigger.metricName} {TRIGGER_OPERATOR_LABELS[trigger.operator] ?? trigger.operator} {String(trigger.threshold ?? '')} · 命中后 {DECISION_ACTION_LABELS[trigger.proposedActionIfTriggered]}</div>)}</div>}</div><aside className="space-y-4"><h3 className="text-sm font-semibold">回访议程</h3>{agenda.map((bucket) => <section key={bucket.key}><div className="flex items-center justify-between border-b border-slate-200 pb-1 text-xs font-medium dark:border-slate-800"><span>{bucket.label}</span><span className="text-slate-400">{bucket.items.length}</span></div>{bucket.items.map((item) => <div key={item.id} className="py-2 text-xs leading-5">{item.reason}</div>)}</section>)}</aside></div>
}

function HistoryView({ decisions, selected, replay, onOpen }: { decisions: ResearchDecisionItem[]; selected: ResearchDecisionItem | null; replay: Record<string, unknown> | null; onOpen: (item: ResearchDecisionItem) => void }): React.ReactElement {
  const market = replay?.marketContext as Record<string, unknown> | undefined
  const marketStatus = market?.status === 'ok' || market?.status === 'degraded' || market?.status === 'blocked' ? market.status : 'blocked'
  return <div data-testid="industry-research-decision-history" className="grid min-w-0 gap-5 xl:grid-cols-[280px_minmax(0,1fr)]"><aside className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">{decisions.map((decision) => <button key={decision.id} type="button" onClick={() => onOpen(decision)} className={`w-full px-3 py-3 text-left ${selected?.id === decision.id ? 'bg-cyan-50 dark:bg-cyan-950/20' : ''}`}><span className="block text-sm font-medium">{DECISION_ACTION_LABELS[decision.action]}</span><span className="mt-1 block text-xs text-slate-400">{formatDate(decision.dataAsOf)} · {EVENT_TYPE_LABELS[decision.eventType] ?? decision.eventType}</span></button>)}</aside><section className="min-w-0">{replay ? <div className="space-y-4"><div><h3 className="text-sm font-semibold">决策时点回放</h3><p className="mt-1 text-xs text-slate-500">只读取事件冻结的规则、研究版本与市场快照。</p></div><div className={`border-l-2 pl-3 text-sm ${marketStatus === 'blocked' ? 'border-red-500 text-red-700 dark:text-red-300' : 'border-emerald-500 text-emerald-700 dark:text-emerald-300'}`}>市场上下文：{MARKET_STATUS_LABELS[marketStatus]} · {String(market?.reason ?? '已冻结')}</div><div className="grid gap-3 sm:grid-cols-2"><MetricLine label="决策价格" value={formatDecisionNumber(typeof market?.price === 'number' ? market.price : null, ' 元')} /><MetricLine label="行情日" value={formatDate(typeof market?.marketDate === 'string' ? market.marketDate : null)} /></div><details className="border-t border-slate-200 pt-3 text-xs dark:border-slate-800"><summary className="cursor-pointer font-medium">完整回放结构</summary><pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-[11px] text-slate-200">{JSON.stringify(replay, null, 2)}</pre></details></div> : <div className="py-12 text-center text-sm text-slate-400">选择一条决策查看当时信息</div>}</section></div>
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement { return <div className="min-w-0 bg-white px-3 py-3 dark:bg-slate-950"><div className="text-[11px] text-slate-400">{label}</div><div className="mt-1 truncate font-mono text-base font-semibold tabular-nums">{value}</div></div> }
function MetricLine({ label, value }: { label: string; value: string }): React.ReactElement { return <div className="border-l-2 border-slate-200 pl-3 dark:border-slate-700"><div className="text-[11px] text-slate-400">{label}</div><div className="mt-1 font-mono text-sm font-medium tabular-nums">{value}</div></div> }
function ControlField({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement { return <div className="min-w-0"><div className="mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</div>{children}</div> }
