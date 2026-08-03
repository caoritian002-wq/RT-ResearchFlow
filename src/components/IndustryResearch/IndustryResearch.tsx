import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { ResearchCleanupDialog } from './ResearchCleanupDialog'
import { ResearchConfirmDialog, type ResearchConfirmRequest } from './ResearchConfirmDialog'
import { ResearchEvidenceDialog } from './ResearchEvidenceDialog'
import { ResearchGenerationDialog, type ResearchGenerationDraft } from './ResearchGenerationDialog'
import { ResearchGenerationStatus, type GenerationRunView } from './ResearchGenerationStatus'
import { ResearchHypothesisDialog } from './ResearchHypothesisDialog'
import { ResearchHypothesisStatusDialog } from './ResearchHypothesisStatusDialog'
import { ResearchGraphDialog, type ResearchGraphSaveDraft } from './ResearchGraphDialog'
import { ResearchProjectDialog } from './ResearchProjectDialog'
import { ResearchProjectRail } from './ResearchProjectRail'
import { ResearchSidePanel } from './ResearchSidePanel'
import { ResearchWorkspace } from './ResearchWorkspace'
import { ResearchArchiveImportDialog } from './ResearchArchiveImportDialog'
import { ResearchSnapshotHistoryDialog } from './ResearchSnapshotHistoryDialog'
import { useResearchDiscussionNavigation } from '../ResearchDiscussion/useResearchDiscussionNavigation'
import { decodeDecisionReturnState, encodeDecisionReturnState } from './industryResearchDecisionModel'
import type {
  IndustryResearchResponse,
  ResearchCompanyCandidateView,
  ResearchCreateDraft,
  ResearchEvidence,
  ResearchEvidenceCandidateView,
  ResearchEvidenceDraft,
  ResearchGraph,
  ResearchHypothesis,
  ResearchHypothesisDraft,
  ResearchProject,
  ResearchReport,
  ResearchDiscussionSummary,
  ResearchView,
  ResearchDecisionView,
} from './industryResearchTypes'

type Dialog =
  | 'project-create'
  | 'project-blank'
  | 'project-edit'
  | 'evidence'
  | 'hypothesis'
  | 'hypothesis-status'
  | 'graph'
  | 'cleanup'
  | null

interface ProjectDetail {
  project: ResearchProject
  graph: ResearchGraph
  evidence: ResearchEvidence[]
  hypotheses: ResearchHypothesis[]
  skillStatus: 'current' | 'changed' | 'missing'
}

function responseError(response: IndustryResearchResponse<unknown>): string {
  return response.message || response.code || '产业研究数据操作失败'
}

function createLocalId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

export function IndustryResearch(): React.ReactElement {
  const pendingProjectId = useAppStore((state) => state.pendingIndustryResearchProjectId)
  const clearPendingProject = useAppStore((state) => state.clearPendingIndustryResearchProject)
  const discussionReturnTarget = useAppStore((state) => state.pendingResearchDiscussionReturnTarget)
  const clearDiscussionReturnTarget = useAppStore((state) => state.clearResearchDiscussionReturnTarget)
  const navigateToResearchDiscussion = useAppStore((state) => state.navigateToResearchDiscussion)
  const {
    start: startDiscussion,
    startFromEvidence: startEvidenceDiscussion,
    starting: discussionStarting,
    error: discussionStartError,
    clearError: clearDiscussionStartError,
  } = useResearchDiscussionNavigation()
  const [projects, setProjects] = useState<ResearchProject[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [report, setReport] = useState<ResearchReport | null>(null)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [view, setView] = useState<ResearchView>('report')
  const [researchLedgerOpen, setResearchLedgerOpen] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [statusHypothesis, setStatusHypothesis] = useState<ResearchHypothesis | null>(null)
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generationRun, setGenerationRun] = useState<GenerationRunView | null>(null)
  const [evidenceCandidates, setEvidenceCandidates] = useState<ResearchEvidenceCandidateView[]>([])
  const [companyCandidates, setCompanyCandidates] = useState<ResearchCompanyCandidateView[]>([])
  const [evidenceActionId, setEvidenceActionId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ResearchConfirmRequest | null>(null)
  const [pendingConfirmAction, setPendingConfirmAction] = useState<'archive' | 'delete' | null>(null)
  const [archiveImportOpen, setArchiveImportOpen] = useState(false)
  const [snapshotHistoryOpen, setSnapshotHistoryOpen] = useState(false)
  const [snapshotCount, setSnapshotCount] = useState(0)
  const [changeRefreshToken, setChangeRefreshToken] = useState(0)
  const [projectDiscussion, setProjectDiscussion] = useState<ResearchDiscussionSummary | null>(null)
  const [decisionContext, setDecisionContext] = useState<{ view: ResearchDecisionView; companyId: string | null; securityId: string | null }>({ view: 'current', companyId: null, securityId: null })
  const requestIdRef = useRef(0)
  const generationRequestIdRef = useRef(0)
  const selectedProjectRef = useRef<string | null>(null)
  const evidenceActionLockRef = useRef(false)
  const workspaceScrollRef = useRef<HTMLDivElement>(null)
  const pendingReturnScrollTopRef = useRef<number | null>(null)
  selectedProjectRef.current = selectedId

  useEffect(() => {
    setResearchLedgerOpen(false)
  }, [selectedId])

  const clearSelectionState = useCallback(() => {
    setSelectedId(null)
    setDetail(null)
    setReport(null)
    setGenerationRun(null)
    setEvidenceCandidates([])
    setCompanyCandidates([])
  }, [])

  const loadProjects = useCallback(async (preferredId?: string | null) => {
    setLoadingProjects(true)
    const response = await window.api.industryResearch.listProjects({
      limit: 200,
      includeArchived,
    }) as IndustryResearchResponse<{ items: ResearchProject[]; total: number }>
    setLoadingProjects(false)
    if (!response.ok || !response.data) {
      setError(responseError(response))
      return
    }
    setProjects(response.data.items)
    setSelectedId((current) => {
      const target = preferredId || current
      if (target && response.data!.items.some((item) => item.id === target)) return target
      return response.data!.items.find((item) => item.status !== 'archived')?.id
        ?? response.data!.items[0]?.id
        ?? null
    })
  }, [includeArchived])

  const loadGeneration = useCallback(async (projectId: string) => {
    const requestId = ++generationRequestIdRef.current
    const response = await window.api.industryResearch.getGenerationRun(projectId) as IndustryResearchResponse<{
      run: GenerationRunView | null
      evidenceCandidates: ResearchEvidenceCandidateView[]
      companyCandidates: ResearchCompanyCandidateView[]
      retrievalMode?: string | null
      retrievalPlan?: GenerationRunView['retrievalPlan']
      reportPartitions?: GenerationRunView['reportPartitions']
      reportDocument?: GenerationRunView['reportDocument']
      financialCollection?: GenerationRunView['financialCollection']
    }>
    if (requestId !== generationRequestIdRef.current || selectedProjectRef.current !== projectId) return null
    if (!response.ok || !response.data) {
      setError(responseError(response))
      return null
    }
    const run = response.data.run
      ? {
          ...response.data.run,
          retrievalMode: response.data.run.retrievalMode ?? response.data.retrievalMode ?? null,
          retrievalPlan: response.data.run.retrievalPlan ?? response.data.retrievalPlan ?? null,
          reportPartitions: response.data.run.reportPartitions ?? response.data.reportPartitions ?? null,
          reportDocument: response.data.run.reportDocument ?? response.data.reportDocument ?? null,
          financialCollection: response.data.run.financialCollection ?? response.data.financialCollection ?? null,
        }
      : null
    setGenerationRun(run)
    const nextEvidence = response.data.evidenceCandidates || []
    const nextCompanies = response.data.companyCandidates || []
    setEvidenceCandidates(nextEvidence)
    setCompanyCandidates(nextCompanies)
    return run
  }, [])

  const loadDetail = useCallback(async (projectId: string) => {
    const requestId = ++requestIdRef.current
    setLoadingDetail(true)
    setError(null)
    const [detailResponse, reportResponse, snapshotsResponse] = await Promise.all([
      window.api.industryResearch.getProject(projectId) as Promise<IndustryResearchResponse<ProjectDetail>>,
      window.api.industryResearch.getReport(projectId) as Promise<IndustryResearchResponse<ResearchReport>>,
      window.api.industryResearch.listSnapshots({ projectId, offset: 0, limit: 1 }) as Promise<IndustryResearchResponse<{ total: number }>>,
      loadGeneration(projectId),
    ])
    if (requestId !== requestIdRef.current) return
    setLoadingDetail(false)
    if (!detailResponse.ok || !detailResponse.data) {
      setDetail(null)
      setReport(null)
      setError(responseError(detailResponse))
      return
    }
    setDetail(detailResponse.data)
    setSnapshotCount(snapshotsResponse.ok && snapshotsResponse.data ? snapshotsResponse.data.total : 0)
    if (reportResponse.ok && reportResponse.data) setReport(reportResponse.data)
    else setReport(null)
  }, [loadGeneration])

  const loadProjectDiscussion = useCallback(async (projectId: string) => {
    const response = await window.api.ai.listResearchDiscussions({ projectId, offset: 0, limit: 20 }) as IndustryResearchResponse<{ items: ResearchDiscussionSummary[] }>
    if (selectedProjectRef.current !== projectId) return
    if (!response.ok || !response.data) {
      setProjectDiscussion(null)
      return
    }
    setProjectDiscussion(response.data.items.find((item) => item.status !== 'archived') ?? null)
  }, [])

  useEffect(() => {
    void loadProjects(pendingProjectId)
  }, [loadProjects, pendingProjectId])

  useEffect(() => {
    if (pendingProjectId) {
      setSelectedId(pendingProjectId)
      clearPendingProject()
    }
  }, [clearPendingProject, pendingProjectId])

  useEffect(() => {
    if (!discussionReturnTarget || discussionReturnTarget.tab !== 'ai-analysis' || discussionReturnTarget.subTab !== 'industryResearch') return
    pendingReturnScrollTopRef.current = typeof discussionReturnTarget.scrollTop === 'number'
      ? Math.max(0, discussionReturnTarget.scrollTop)
      : null
    if (discussionReturnTarget.entityId) setSelectedId(discussionReturnTarget.entityId)
    const decisionState = decodeDecisionReturnState(discussionReturnTarget.stateKey)
    if (decisionState) {
      setView('decision')
      setDecisionContext(decisionState)
    } else {
      const match = discussionReturnTarget.stateKey?.match(/^industry-research:(.+)$/)
      const targetView = match?.[1] as ResearchView | undefined
      if (targetView && ['report', 'decision', 'changes', 'overview', 'companies', 'graph', 'hypotheses', 'evidence', 'review'].includes(targetView)) setView(targetView)
    }
    clearDiscussionReturnTarget()
  }, [clearDiscussionReturnTarget, discussionReturnTarget])

  useEffect(() => {
    const scrollTop = pendingReturnScrollTopRef.current
    if (scrollTop == null || loadingDetail || !detail) return
    const frame = requestAnimationFrame(() => {
      if (!workspaceScrollRef.current) return
      workspaceScrollRef.current.scrollTop = scrollTop
      pendingReturnScrollTopRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [detail, loadingDetail, view])

  useEffect(() => {
    if (!selectedId) {
      generationRequestIdRef.current += 1
      setDetail(null)
      setReport(null)
      setGenerationRun(null)
      setEvidenceCandidates([])
      setCompanyCandidates([])
      setProjectDiscussion(null)
      setSnapshotCount(0)
      setArchiveImportOpen(false)
      setSnapshotHistoryOpen(false)
      return
    }
    setGenerationRun(null)
    setEvidenceCandidates([])
    setCompanyCandidates([])
    setEvidenceActionId(null)
    setNotice(null)
    setProjectDiscussion(null)
    setSnapshotCount(0)
    setArchiveImportOpen(false)
    setSnapshotHistoryOpen(false)
    void loadDetail(selectedId)
    void loadProjectDiscussion(selectedId)
  }, [loadDetail, loadProjectDiscussion, selectedId])

  useEffect(() => {
    const stop = window.api.industryResearch.onGenerationProgress?.((payload) => {
      if (!selectedId || payload.projectId !== selectedId) return
      setGenerationRun((current) => current && current.id === payload.runId ? {
        ...current,
        status: payload.status as GenerationRunView['status'],
        currentStage: payload.stage,
        progressCurrent: payload.progressCurrent,
        progressTotal: payload.progressTotal,
        progressMessage: payload.message,
        updatedAt: payload.updatedAt,
        financialCollection: (payload.financialCollection as GenerationRunView['financialCollection']) ?? current.financialCollection,
      } : current)
      if (payload.status === 'succeeded' || payload.status === 'failed' || payload.status === 'cancelled') {
        void loadDetail(selectedId)
      }
    })
    return () => { stop?.() }
  }, [loadDetail, loadGeneration, selectedId])

  useEffect(() => {
    if (!selectedId || !generationRun || !['queued', 'running'].includes(generationRun.status)) return
    let disposed = false
    const refresh = async () => {
      const refreshed = await loadGeneration(selectedId)
      if (disposed || !refreshed) return
      if (['succeeded', 'failed', 'cancelled'].includes(refreshed.status)) {
        await loadDetail(selectedId)
      }
    }
    const timer = window.setInterval(() => { void refresh() }, 12_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [generationRun?.id, generationRun?.status, loadDetail, loadGeneration, selectedId])

  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((item) =>
      [item.title, item.industry_name, item.product_scope, item.region_scope]
        .join(' ')
        .toLowerCase()
        .includes(q))
  }, [projects, query])

  const submitProject = useCallback(async (draft: ResearchCreateDraft) => {
    setSaving(true)
    setError(null)
    const response = detail && dialog === 'project-edit'
      ? await window.api.industryResearch.updateProject(detail.project.id, draft) as IndustryResearchResponse<ResearchProject>
      : await window.api.industryResearch.createProject(draft) as IndustryResearchResponse<ResearchProject>
    setSaving(false)
    if (!response.ok || !response.data) {
      setError(responseError(response))
      return
    }
    setDialog(null)
    await loadProjects(response.data.id)
    setSelectedId(response.data.id)
  }, [detail, dialog, loadProjects])

  const submitGeneration = useCallback(async (draft: ResearchGenerationDraft) => {
    setSaving(true)
    setError(null)
    // 新建研究必须创建新项目，禁止复用当前选中项目，否则会覆盖/污染既有研究（如光纤被锂矿覆盖）
    const response = await window.api.industryResearch.startGeneration({
      researchQuestion: draft.researchQuestion,
      scope: {
        title: draft.title || null,
        industryName: draft.industryName || null,
        productScope: draft.productScope || null,
        regionScope: draft.regionScope || null,
        timeScope: draft.timeScope || null,
        purpose: draft.purpose,
        depth: draft.depth,
        enableWebRetrieval: draft.enableWebRetrieval,
      },
    }) as IndustryResearchResponse<{ projectId: string; run: GenerationRunView }>
    setSaving(false)
    if (!response.ok || !response.data) {
      setError(responseError(response))
      return
    }
    setDialog(null)
    setGenerationRun(response.data.run)
    setView('report')
    await loadProjects(response.data.projectId)
    setSelectedId(response.data.projectId)
  }, [loadProjects])

  const cancelGeneration = useCallback(async () => {
    if (!selectedId || !generationRun) return
    const response = await window.api.industryResearch.cancelGeneration(selectedId, generationRun.id) as IndustryResearchResponse<GenerationRunView>
    if (!response.ok || !response.data) {
      setError(responseError(response))
      return
    }
    setGenerationRun(response.data)
  }, [generationRun, selectedId])

  const retryGeneration = useCallback(async () => {
    if (!selectedId || !generationRun) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await window.api.industryResearch.retryGenerationStage(selectedId, generationRun.id) as IndustryResearchResponse<GenerationRunView>
      if (!response.ok || !response.data) {
        setError(responseError(response))
        return
      }
      setGenerationRun(response.data)
      if (response.data.status === 'succeeded') {
        await loadDetail(selectedId)
        setNotice('现有报告和图谱已写入项目，本次恢复未重新调用模型。')
      }
    } finally {
      setSaving(false)
    }
  }, [generationRun, loadDetail, selectedId])

  const continueFinancialCollection = useCallback(async () => {
    if (!selectedId || !generationRun) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const response = await window.api.industryResearch.continueFinancialCollection(
        selectedId,
        generationRun.id,
      ) as IndustryResearchResponse<GenerationRunView>
      if (!response.ok || !response.data) {
        setError(responseError(response))
        return
      }
      setGenerationRun(response.data)
      setView('report')
      setNotice('已从公司映射阶段继续收集；成功数据集会跳过，完成后自动更新报告。')
    } finally {
      setSaving(false)
    }
  }, [generationRun, selectedId])

  const confirmEvidence = useCallback(async (candidateId: string, action: 'confirm' | 'reject') => {
    const projectId = selectedProjectRef.current
    if (!projectId || evidenceActionLockRef.current) return
    evidenceActionLockRef.current = true
    setEvidenceActionId(candidateId)
    setError(null)
    setNotice(null)
    try {
      const response = await window.api.industryResearch.confirmEvidenceCandidate(projectId, candidateId, action) as IndustryResearchResponse<ResearchEvidenceCandidateView>
      if (selectedProjectRef.current !== projectId) return
      if (!response.ok) {
        setError(responseError(response))
        return
      }
      setNotice(action === 'confirm'
        ? '来源已纳入项目正式证据库，仍保持“估算/支持材料”语义。'
        : '来源已排除；后续产业研究讨论不会再引用该 URL。')
      await loadDetail(projectId)
    } finally {
      evidenceActionLockRef.current = false
      if (selectedProjectRef.current === projectId) setEvidenceActionId(null)
    }
  }, [loadDetail])

  const resolveCompany = useCallback(async (candidate: ResearchCompanyCandidateView, action: 'accept' | 'exclude') => {
    if (!selectedId || !generationRun) return
    const securityTsCode = candidate.matchedSecurities?.length === 1 ? candidate.matchedSecurities[0].tsCode : null
    if (action === 'accept' && !securityTsCode) {
      setError('该公司没有唯一证券匹配，暂不能纳入验证')
      return
    }
    const response = await window.api.industryResearch.resolveCompanyCandidate({
      projectId: selectedId,
      runId: generationRun.id,
      candidateId: candidate.id,
      action,
      securityTsCode,
      exclusionReason: action === 'exclude' ? '用户排除' : null,
    }) as IndustryResearchResponse<unknown>
    if (!response.ok) {
      setError(responseError(response))
      return
    }
    await Promise.all([loadGeneration(selectedId), loadDetail(selectedId)])
    if (action === 'accept') setView('companies')
  }, [generationRun, loadDetail, loadGeneration, selectedId])

  const submitEvidence = useCallback(async (draft: ResearchEvidenceDraft) => {
    if (!selectedId) return
    setSaving(true)
    setError(null)
    const response = await window.api.industryResearch.saveEvidence(selectedId, {
      id: createLocalId('evidence'),
      title: draft.title,
      sourceType: draft.sourceType,
      sourceName: draft.sourceName,
      sourceUrl: draft.sourceUrl || null,
      sourceRef: draft.sourceRef || null,
      publishedDate: null,
      factDate: draft.factDate || null,
      metricName: null,
      metricValue: null,
      unit: null,
      region: null,
      productSpec: null,
      methodology: null,
      statementKind: draft.statementKind,
      direction: draft.direction,
      reliability: draft.reliability,
      createdBy: 'manual',
      primarySourceConfirmed: draft.primarySourceConfirmed,
      conflictNote: draft.conflictNote || null,
      excerpt: draft.excerpt || null,
    }) as IndustryResearchResponse<ResearchEvidence>
    setSaving(false)
    if (!response.ok) { setError(responseError(response)); return }
    setDialog(null)
    await loadDetail(selectedId)
  }, [loadDetail, selectedId])

  const submitHypothesis = useCallback(async (draft: ResearchHypothesisDraft) => {
    if (!selectedId) return
    setSaving(true)
    setError(null)
    const response = await window.api.industryResearch.saveHypothesis(selectedId, {
      id: createLocalId('hypothesis'),
      statement: draft.statement,
      importance: draft.importance,
      status: 'open',
      cheapestDisproof: draft.cheapestDisproof,
      verificationMetric: draft.verificationMetric || null,
      threshold: draft.threshold || null,
      dueAt: null,
      evidenceIds: [],
    }) as IndustryResearchResponse<ResearchHypothesis>
    setSaving(false)
    if (!response.ok) { setError(responseError(response)); return }
    setDialog(null)
    await loadDetail(selectedId)
  }, [loadDetail, selectedId])

  const askArchiveCurrent = useCallback(() => {
    if (!selectedId || !detail) return
    setError(null)
    setPendingConfirmAction('archive')
    setConfirmRequest({
      title: '归档研究项目',
      description: `确认归档「${detail.project.title}」？`,
      details: [
        '归档后默认从主队列隐藏',
        '可在左侧勾选“显示已归档”后查看',
        '归档不会删除研究事实',
      ],
      confirmLabel: '确认归档',
      tone: 'warning',
    })
  }, [detail, selectedId])

  const askDeleteCurrent = useCallback(() => {
    if (!selectedId || !detail) return
    if (snapshotCount > 0) {
      setError('该项目已有不可变研究版本，只能归档，不能物理删除')
      return
    }
    setError(null)
    setPendingConfirmAction('delete')
    setConfirmRequest({
      title: '删除研究项目',
      description: `确认永久删除「${detail.project.title}」？`,
      details: [
        '将删除该项目的图谱、证据、假设、生成运行和候选',
        '此操作不可恢复',
        '共享公司与财务事实会保留',
      ],
      confirmLabel: '永久删除',
      tone: 'danger',
    })
  }, [detail, selectedId, snapshotCount])

  const executeConfirmAction = useCallback(async () => {
    if (!selectedId || !pendingConfirmAction) return
    setSaving(true)
    setError(null)
    if (pendingConfirmAction === 'archive') {
      const response = await window.api.industryResearch.archiveProject(selectedId) as IndustryResearchResponse<ResearchProject>
      setSaving(false)
      if (!response.ok) {
        setError(responseError(response))
        return
      }
    } else {
      const response = await window.api.industryResearch.deleteProject(selectedId) as IndustryResearchResponse<{ projectId: string; deleted: boolean }>
      setSaving(false)
      if (!response.ok) {
        setError(responseError(response))
        return
      }
    }
    setConfirmRequest(null)
    setPendingConfirmAction(null)
    clearSelectionState()
    await loadProjects()
  }, [clearSelectionState, loadProjects, pendingConfirmAction, selectedId])

  const handleCleanupChanged = useCallback(async (deletedIds: string[]) => {
    if (selectedId && deletedIds.includes(selectedId)) clearSelectionState()
    await loadProjects()
  }, [clearSelectionState, loadProjects, selectedId])

  const changeHypothesisStatus = useCallback(async (status: ResearchHypothesis['status'], reason: string) => {
    if (!selectedId || !statusHypothesis) return
    setSaving(true)
    setError(null)
    const response = await window.api.industryResearch.updateHypothesisStatus({
      projectId: selectedId,
      hypothesisId: statusHypothesis.id,
      status,
      reason,
      evidenceIds: [],
    }) as IndustryResearchResponse<ResearchHypothesis>
    setSaving(false)
    if (!response.ok) { setError(responseError(response)); return }
    setDialog(null)
    setStatusHypothesis(null)
    await loadDetail(selectedId)
  }, [loadDetail, selectedId, statusHypothesis])

  const saveGraph = useCallback(async (draft: ResearchGraphSaveDraft) => {
    if (!selectedId) return
    setSaving(true)
    setError(null)
    const response = await window.api.industryResearch.saveGraph({ projectId: selectedId, ...draft }) as IndustryResearchResponse<{ graphUpdatedAt: number }>
    setSaving(false)
    if (!response.ok) {
      setError(response.code === 'VERSION_CONFLICT' ? '图谱已被更新，请刷新后重试' : responseError(response))
      return
    }
    setDialog(null)
    await loadDetail(selectedId)
  }, [loadDetail, selectedId])

  const openDialog = (next: Dialog) => { setError(null); setDialog(next) }

  const startProjectDiscussion = useCallback(async () => {
    if (!detail) return
    clearDiscussionStartError()
    await startDiscussion({
      origin: { type: 'industry_research', id: detail.project.id },
      projectId: detail.project.id,
      initialQuestion: `请基于当前研究版本，继续讨论「${detail.project.title}」中最值得验证的变化、反证和公司线索。`,
      mode: 'continue_or_create',
      returnTarget: {
        tab: 'ai-analysis',
        subTab: 'industryResearch',
        entityId: detail.project.id,
        stateKey: view === 'decision'
          ? encodeDecisionReturnState(decisionContext.view, decisionContext.companyId, decisionContext.securityId)
          : `industry-research:${view}`,
      },
    })
  }, [clearDiscussionStartError, decisionContext, detail, startDiscussion, view])

  const handleResearchChanged = useCallback(() => {
    if (!selectedId) return
    setChangeRefreshToken((value) => value + 1)
    void loadDetail(selectedId)
    void loadProjects(selectedId)
    void loadProjectDiscussion(selectedId)
  }, [loadDetail, loadProjectDiscussion, loadProjects, selectedId])

  return (
    <div data-testid="industry-research-page" className="flex min-h-0 min-w-0 flex-1 bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <ResearchProjectRail
        projects={filteredProjects}
        selectedId={selectedId}
        query={query}
        loading={loadingProjects}
        includeArchived={includeArchived}
        onQueryChange={setQuery}
        onSelect={(projectId) => {
          if (projectId !== selectedId) {
            setDecisionContext({ view: 'current', companyId: null, securityId: null })
          }
          setSelectedId(projectId)
        }}
        onCreate={() => openDialog('project-create')}
        onToggleIncludeArchived={() => setIncludeArchived((value) => !value)}
        onOpenCleanup={() => openDialog('cleanup')}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        {detail ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {generationRun && (
              <div className={`shrink-0 border-b border-slate-200 bg-slate-50 px-4 dark:border-slate-800 dark:bg-slate-950 ${generationRun.status === 'succeeded' ? 'py-0.5' : 'py-2'}`}>
                <ResearchGenerationStatus
                  run={generationRun}
                  busy={saving}
                  onCancel={() => void cancelGeneration()}
                  onRetry={() => void retryGeneration()}
                  onContinueFinancials={() => void continueFinancialCollection()}
                />
              </div>
            )}
            {(error || discussionStartError || notice) && !dialog && (
              <div
                role={error || discussionStartError ? 'alert' : 'status'}
                className={`flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-xs ${error || discussionStartError
                  ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300'}`}
              >
                <span>{error || discussionStartError || notice}</span>
                <button type="button" onClick={() => { setError(null); clearDiscussionStartError(); setNotice(null) }} className="shrink-0 font-medium hover:underline">关闭</button>
              </div>
            )}
            <ResearchWorkspace
              project={detail.project}
              graph={detail.graph}
              evidence={detail.evidence}
              hypotheses={detail.hypotheses}
              report={report}
              view={view}
              loading={loadingDetail}
              evidenceCandidates={evidenceCandidates}
              selectedTopNIds={generationRun?.selectedTopNIds ?? []}
              companyCandidates={companyCandidates}
              retrievalMode={generationRun?.retrievalMode ?? null}
              retrievalPlan={generationRun?.retrievalPlan ?? null}
              nativeWebSearch={generationRun?.nativeWebSearch ?? null}
              reportPartitions={generationRun?.reportPartitions ?? report?.reportPartitions ?? null}
              generatedReport={generationRun?.reportDocument ?? report?.reportDocument ?? null}
              generationRunId={generationRun?.reportDocument?.researchTrace ? generationRun.id : null}
              provisionalReport={generationRun?.status === 'failed'
                && generationRun.currentStage === 'report'
                && generationRun.lastSuccessfulStage === 'companies'
                && Boolean(generationRun.reportDocument?.markdown)}
              evidenceActionId={evidenceActionId}
              changeRefreshToken={changeRefreshToken}
              hasSnapshots={snapshotCount > 0}
              discussionLabel={projectDiscussion ? '继续讨论' : '和 AI 讨论'}
              discussionBusy={discussionStarting}
              scrollRef={workspaceScrollRef}
              onViewChange={setView}
              onStartDiscussion={() => { void startProjectDiscussion() }}
              onDiscussReportChanges={generationRun?.reportDocument?.researchTrace
                ? () => startEvidenceDiscussion({
                    source: {
                      sourceKind: 'industry_report',
                      projectId: detail.project.id,
                      runId: generationRun.id,
                    },
                    returnTarget: {
                      tab: 'ai-analysis',
                      subTab: 'industryResearch',
                      entityId: detail.project.id,
                      stateKey: 'industry-research:report',
                    },
                  })
                : undefined}
              onOpenDiscussion={navigateToResearchDiscussion}
              onImportArchive={() => setArchiveImportOpen(true)}
              onOpenSnapshots={() => setSnapshotHistoryOpen(true)}
              onResearchChanged={handleResearchChanged}
              onSnapshotCountChange={setSnapshotCount}
              onEditProject={() => openDialog('project-edit')}
              onArchive={askArchiveCurrent}
              onDelete={askDeleteCurrent}
              onEditGraph={() => openDialog('graph')}
              onConfirmEvidence={(candidateId, action) => void confirmEvidence(candidateId, action)}
              onResolveCompany={(candidate, action) => void resolveCompany(candidate, action)}
              decisionContext={decisionContext}
              onDecisionContextChange={setDecisionContext}
            />
          </div>
        ) : (
          <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-slate-50 p-6 text-center dark:bg-slate-950">
            <div>
              <h2 className="text-lg font-semibold">从研究问题开始</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
                系统会自动检索、筛选并交叉核对公开来源，先交付完整报告；之后再按需追溯来源或选择要继续验证的公司。
              </p>
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <button type="button" onClick={() => openDialog('project-create')} className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white">新建 AI 研究</button>
                <button type="button" onClick={() => openDialog('cleanup')} className="rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700">清理项目</button>
              </div>
              {error && <p className="mt-3 text-sm text-red-600 dark:text-red-300">{error}</p>}
            </div>
          </main>
        )}
        {detail && view !== 'decision' && (
          <ResearchSidePanel
            evidence={detail.evidence}
            hypotheses={detail.hypotheses}
            open={researchLedgerOpen}
            onOpenChange={setResearchLedgerOpen}
            onAddEvidence={() => openDialog('evidence')}
            onAddHypothesis={() => openDialog('hypothesis')}
            onChangeHypothesisStatus={(hypothesis) => {
              setStatusHypothesis(hypothesis)
              openDialog('hypothesis-status')
            }}
          />
        )}
      </div>

      {dialog === 'project-create' && (
        <ResearchGenerationDialog
          saving={saving}
          error={error}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => void submitGeneration(draft)}
          onOpenBlank={() => openDialog('project-blank')}
        />
      )}
      {dialog === 'project-blank' && (
        <ResearchProjectDialog
          saving={saving}
          error={error}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => void submitProject(draft)}
        />
      )}
      {dialog === 'project-edit' && detail && (
        <ResearchProjectDialog
          project={detail.project}
          saving={saving}
          error={error}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => void submitProject(draft)}
        />
      )}
      {dialog === 'evidence' && (
        <ResearchEvidenceDialog
          saving={saving}
          error={error}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => void submitEvidence(draft)}
        />
      )}
      {dialog === 'hypothesis' && (
        <ResearchHypothesisDialog
          saving={saving}
          error={error}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => void submitHypothesis(draft)}
        />
      )}
      {dialog === 'hypothesis-status' && statusHypothesis && (
        <ResearchHypothesisStatusDialog
          hypothesis={statusHypothesis}
          saving={saving}
          error={error}
          onClose={() => {
            setDialog(null)
            setStatusHypothesis(null)
          }}
          onSubmit={(status, reason) => void changeHypothesisStatus(status, reason)}
        />
      )}
      {dialog === 'graph' && detail && (
        <ResearchGraphDialog
          graph={detail.graph}
          saving={saving}
          error={error}
          onClose={() => setDialog(null)}
          onSubmit={(draft) => void saveGraph(draft)}
        />
      )}
      <ResearchCleanupDialog
        open={dialog === 'cleanup'}
        onClose={() => setDialog(null)}
        onChanged={(deletedIds) => void handleCleanupChanged(deletedIds)}
      />
      <ResearchConfirmDialog
        open={Boolean(confirmRequest)}
        request={confirmRequest}
        saving={saving}
        error={error}
        onCancel={() => {
          if (saving) return
          setConfirmRequest(null)
          setPendingConfirmAction(null)
        }}
        onConfirm={() => void executeConfirmAction()}
      />
      {detail && <ResearchArchiveImportDialog
        open={archiveImportOpen}
        projectId={detail.project.id}
        onClose={() => setArchiveImportOpen(false)}
        onImported={() => {
          setView('changes')
          setChangeRefreshToken((value) => value + 1)
        }}
      />}
      {detail && <ResearchSnapshotHistoryDialog
        open={snapshotHistoryOpen}
        projectId={detail.project.id}
        onClose={() => setSnapshotHistoryOpen(false)}
        onOpenDiscussion={(sessionId) => {
          setSnapshotHistoryOpen(false)
          navigateToResearchDiscussion(sessionId)
        }}
      />}
    </div>
  )
}
