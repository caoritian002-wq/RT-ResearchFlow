import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  buildResearchCounts,
  formatResearchDate,
  normalizeResearchReportFindings,
  projectReviewReasons,
} from './industryResearchModel'
import { ResearchCompanyFinancialView } from './ResearchCompanyFinancialView'
import { ResearchChangeSetView } from './ResearchChangeSetView'
import { ResearchDecisionWorkbench } from './ResearchDecisionWorkbench'
import { ResearchGraphCanvas } from './ResearchGraphCanvas'
import { ResearchWebSearchConfigPanel } from './ResearchWebSearchConfigPanel'
import {
  ResearchAuditTrace,
  type ResearchEvidenceDiscussionAction,
} from '../shared/ResearchAuditTrace'
import type {
  ResearchCompanyCandidateView,
  ResearchEvidence,
  ResearchEvidenceCandidateView,
  ResearchGraph,
  ResearchGeneratedReportDocument,
  ResearchHypothesis,
  ResearchProject,
  ResearchReport,
  ResearchReportPartitions,
  ResearchNativeWebSearchView,
  ResearchRetrievalPlanView,
  ResearchView,
  ResearchDecisionView,
} from './industryResearchTypes'

interface Props {
  project: ResearchProject
  graph: ResearchGraph | null
  evidence: ResearchEvidence[]
  hypotheses: ResearchHypothesis[]
  report: ResearchReport | null
  view: ResearchView
  loading: boolean
  evidenceCandidates?: ResearchEvidenceCandidateView[]
  selectedTopNIds?: string[]
  companyCandidates?: ResearchCompanyCandidateView[]
  retrievalMode?: string | null
  retrievalPlan?: ResearchRetrievalPlanView | null
  nativeWebSearch?: ResearchNativeWebSearchView | null
  reportPartitions?: ResearchReportPartitions | null
  generatedReport?: ResearchGeneratedReportDocument | null
  generationRunId?: string | null
  provisionalReport?: boolean
  evidenceActionId?: string | null
  changeRefreshToken?: number
  discussionLabel?: string
  discussionBusy?: boolean
  scrollRef?: React.RefObject<HTMLDivElement>
  onViewChange: (view: ResearchView) => void
  onStartDiscussion: () => void
  onDiscussReportChanges?: ResearchEvidenceDiscussionAction
  onOpenDiscussion: (sessionId: number) => void
  onImportArchive: () => void
  onOpenSnapshots: () => void
  onResearchChanged: () => void
  onEditProject: () => void
  onArchive: () => void
  onDelete: () => void
  onEditGraph: () => void
  onConfirmEvidence?: (candidateId: string, action: 'confirm' | 'reject') => void
  onResolveCompany?: (candidate: ResearchCompanyCandidateView, action: 'accept' | 'exclude') => void
  onExpandCompanies?: () => Promise<string | null>
  companyDataRevision?: number | null
  decisionContext?: { view: ResearchDecisionView; companyId: string | null; securityId: string | null }
  onDecisionContextChange?: (state: { view: ResearchDecisionView; companyId: string | null; securityId: string | null }) => void
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return '公开来源'
  }
}

function readableEvidenceTitle(item: ResearchEvidenceCandidateView): string {
  const title = item.title?.trim()
  if (title && !/^https?:\/\//i.test(title) && title.length > 4) return title
  if (item.summary?.trim()) return item.summary.trim().slice(0, 48)
  if (item.query?.trim()) return `与“${item.query.trim().slice(0, 24)}”相关的公开来源`
  return `${hostLabel(item.sourceUrl)} 公开资料`
}

function evidenceStatusMeta(status: string): { label: string; className: string } {
  if (status === 'confirmed') return { label: '已纳入正式库', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' }
  if (status === 'rejected') return { label: '已排除', className: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }
  if (status === 'failed') return { label: '抓取失败', className: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300' }
  if (status === 'partial') return { label: '摘要不完整', className: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' }
  return { label: '系统候选', className: 'bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300' }
}

function sourceKindLabel(kind?: string, providerId?: string): string {
  if (kind === 'local_briefing') return '本地资讯'
  if (kind === 'local_research') return '既有研究证据'
  if (kind === 'official_detail') return '官方详情'
  if (kind === 'user_url') return '用户链接'
  if (providerId === 'openai_native_web_search') return 'GPT 原生搜索'
  if (providerId === 'builtin_web') return '内置弱检索'
  if (providerId === 'tavily' || providerId === 'bing') return '增强搜索'
  if (providerId === 'official_url') return '官方源入口'
  return '网页搜索'
}

function nativeSearchActionLabel(type: ResearchNativeWebSearchView['calls'][number]['action']['type']): string {
  if (type === 'open_page') return '打开页面'
  if (type === 'find_in_page') return '页内查找'
  return '网页搜索'
}

function modeBanner(
  mode?: string | null,
  enhancedSearch?: ResearchRetrievalPlanView['enhancedSearch'],
): { title: string; text: string; className: string; showSearchConfig?: boolean } | null {
  const searchNeedsRepair = enhancedSearch?.status === 'key_unavailable' || enhancedSearch?.status === 'failed'
  const searchReturnedEmpty = enhancedSearch?.status === 'empty'
  const searchSucceeded = enhancedSearch?.status === 'succeeded'
  const searchDisabled = enhancedSearch?.status === 'disabled'
  const showSearchConfig = !searchReturnedEmpty
    && (!enhancedSearch || enhancedSearch.status === 'not_configured' || searchNeedsRepair)
  if (mode === 'strong') {
    return {
      title: '强取证模式',
      text: '增强搜索与详情页可用。系统已自动完成来源筛选；报告中的引用仍应结合原文和可信边界阅读。',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300',
    }
  }
  if (mode === 'mixed') {
    return {
      title: '混合取证模式',
      text: '本地语料与外网结果并存。系统优先使用官方详情页，弱来源仅作为报告线索。',
      className: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/20 dark:text-sky-300',
    }
  }
  if (mode === 'weak') {
    return {
      title: '弱检索模式',
      text: searchNeedsRepair
        ? '增强搜索已经配置，但本轮密钥不可用或调用失败，系统已自动回退。请检查连接后直接重试，无需重新分析或逐条审核来源。'
        : searchReturnedEmpty
          ? '增强搜索本轮未返回可用结果，系统已自动回退到其他来源。当前草稿中的关键判断仍需结合引用原文阅读。'
          : searchSucceeded
            ? '增强搜索本轮已经成功调用，但有效召回或详情页数量不足，因此仍按弱取证展示。'
            : searchDisabled
              ? '本轮已按用户选择关闭联网取证，仅使用本地语料和既有研究材料。'
              : '未完成强外部取证。当前草稿含较多模型推断，可配置 Tavily/Bing 后重新生成。',
      className: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300',
      showSearchConfig,
    }
  }
  if (mode === 'offline') {
    return {
      title: '离线/无外网模式',
      text: searchNeedsRepair
        ? '增强搜索已经配置，但本轮运行故障导致外网取证不可用。请检查连接后重试。'
        : searchDisabled
          ? '本轮已按用户选择关闭联网取证，仅使用本地语料和既有研究材料。'
          : '外网检索不可用。以下内容不得视为已完成外部取证。',
      className: 'border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300',
      showSearchConfig,
    }
  }
  return null
}

function companyStatusMeta(status: string): { label: string; className: string } {
  if (status === 'accepted') return { label: '已纳入', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' }
  if (status === 'excluded') return { label: '已排除', className: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' }
  if (status === 'unmatched') return { label: '待匹配证券', className: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' }
  return { label: '待纳入', className: 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300' }
}

export function ResearchWorkspace({
  project,
  graph,
  evidence,
  hypotheses,
  report,
  view,
  loading,
  evidenceCandidates = [],
  selectedTopNIds = [],
  companyCandidates = [],
  retrievalMode = null,
  retrievalPlan = null,
  nativeWebSearch = null,
  reportPartitions = null,
  generatedReport = null,
  generationRunId = null,
  provisionalReport = false,
  evidenceActionId = null,
  changeRefreshToken = 0,
  discussionLabel = '和 AI 讨论',
  discussionBusy = false,
  scrollRef,
  onViewChange,
  onStartDiscussion,
  onDiscussReportChanges,
  onOpenDiscussion,
  onImportArchive,
  onOpenSnapshots,
  onResearchChanged,
  onEditProject,
  onArchive,
  onDelete,
  onEditGraph,
  onConfirmEvidence,
  onResolveCompany,
  onExpandCompanies,
  companyDataRevision,
  decisionContext,
  onDecisionContextChange,
}: Props): React.ReactElement {
  const counts = buildResearchCounts(graph, evidence, hypotheses)
  const reviewReasons = projectReviewReasons(project, counts)
  const pendingCompanies = companyCandidates.filter((item) => !['accepted', 'excluded'].includes(item.resolutionStatus))
  const sourceCount = evidenceCandidates.length
  const banner = modeBanner(retrievalMode, retrievalPlan?.enhancedSearch)
  // 用户主路径：报告优先；完整候选池只在高级审计中按需查看。
  const viewLabels: Array<[ResearchView, string]> = [
    ['report', '报告'],
    ['decision', '决策'],
    ['changes', '研究增量'],
    ['overview', '概览'],
    ['companies', '公司与财报'],
    ['graph', '图谱'],
    ['hypotheses', '假设'],
    ['evidence', '证据'],
    ['review', '来源与审计'],
  ]

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50 dark:bg-slate-950">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex h-12 min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-semibold" title={project.title}>{project.title}</h2>
              <span className="hidden shrink-0 text-[10px] font-medium text-cyan-700 lg:inline dark:text-cyan-300">{project.industry_name} · {project.purpose === 'investment' ? '投资研究' : project.purpose === 'strategy' ? '战略研究' : '知识学习'}</span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400" title={`产品：${project.product_scope} · 区域：${project.region_scope} · 时间：${project.time_scope} · 数据截至：${formatResearchDate(project.data_as_of)}`}>
              {project.product_scope} · {project.region_scope} · {project.time_scope} · 截至 {formatResearchDate(project.data_as_of)}
            </div>
          </div>
          <button type="button" data-testid="industry-research-discuss" onClick={onStartDiscussion} disabled={discussionBusy} className="h-8 shrink-0 rounded-md bg-cyan-700 px-3 text-xs font-semibold text-white transition-colors hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40">{discussionBusy ? '打开中…' : discussionLabel}</button>
          <ProjectActionMenu onEdit={onEditProject} onArchive={onArchive} onDelete={onDelete} />
        </div>
        <div className="-mx-1 flex h-9 min-w-0 items-stretch gap-0.5 overflow-x-auto border-t border-slate-100 dark:border-slate-800" role="tablist" aria-label="产业研究视图">
          {viewLabels.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              data-testid={`industry-research-view-${key}`}
              onClick={() => onViewChange(key)}
              className={`inline-flex h-9 flex-none items-center justify-center whitespace-nowrap border-b-2 px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 ${view === key ? 'border-cyan-600 font-semibold text-cyan-800 dark:border-cyan-400 dark:text-cyan-200' : 'border-transparent text-slate-500 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800/70 dark:hover:text-slate-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div ref={scrollRef} data-testid="industry-research-workspace-scroll" className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && <div className="py-10 text-center text-sm text-slate-400">正在装配本地事实</div>}
        {!loading && view === 'overview' && (
          <div className="space-y-4">
            {banner && (
              <section className={`rounded-md border p-4 ${banner.className}`}>
                <h3 className="text-sm font-semibold">{banner.title}</h3>
                <p className="mt-1 text-xs leading-5">{banner.text}</p>
                {retrievalPlan && (
                  <p className="mt-2 text-[11px] opacity-80">
                    系统已处理 {retrievalPlan.candidatePoolSize ?? evidenceCandidates.length} 条来源
                    · 代表性来源 {retrievalPlan.selectedTopN ?? 0}
                    · 本地 {retrievalPlan.localHitCount ?? 0}
                    · 外网 {retrievalPlan.webHitCount ?? 0}
                    · 详情页 {retrievalPlan.detailPageCount ?? 0}
                  </p>
                )}
                {banner.showSearchConfig && (
                  <div className="mt-3">
                    <ResearchWebSearchConfigPanel variant="banner" />
                  </div>
                )}
              </section>
            )}
            <section className="rounded-md border border-cyan-200 bg-cyan-50 p-4 dark:border-cyan-900 dark:bg-cyan-950/20">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-cyan-900 dark:text-cyan-100">先读报告结论</h3>
                  <p className="mt-1 text-xs leading-5 text-cyan-800 dark:text-cyan-200">
                    主交付物是完整研究报告。来源筛选、评级和冲突识别由系统完成，无需逐条点击才能阅读结论。
                  </p>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => onViewChange('report')} className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white">
                    打开报告
                  </button>
                  <button type="button" onClick={() => onViewChange('review')} className="rounded-md border border-cyan-300 bg-white px-3 py-1.5 text-xs font-semibold text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-200">
                    来源与审计
                  </button>
                </div>
              </div>
            </section>
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-6 dark:border-slate-800 dark:bg-slate-800">
              {[['节点', counts.nodes], ['关系', counts.edges], ['事实', counts.facts], ['估算', counts.estimates], ['假设', counts.hypotheses], ['来源', sourceCount]].map(([label, value]) => (
                <div key={String(label)} className="bg-white px-3 py-3 dark:bg-slate-900">
                  <div className="text-[11px] text-slate-400">{label}</div>
                  <div className="mt-1 text-xl font-semibold">{value}</div>
                </div>
              ))}
            </div>
            <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h3 className="text-sm font-semibold">研究状态</h3>
              {!reviewReasons.length && pendingCompanies.length === 0 ? (
                <p className="mt-2 text-sm text-emerald-600 dark:text-emerald-300">当前没有系统识别出的复核阻断项。</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {(sourceCount > 0 || pendingCompanies.length > 0) && (
                    <div className="border-l-2 border-cyan-400 pl-3 text-sm text-slate-600 dark:text-slate-300">
                      系统已整理 {sourceCount} 条公开来源和 {companyCandidates.length} 家公司线索；完整记录可按需进入“来源与审计”查看。
                    </div>
                  )}
                  {reviewReasons.map((reason) => (
                    <div key={reason} className="border-l-2 border-amber-400 pl-3 text-sm text-slate-600 dark:text-slate-300">{reason}</div>
                  ))}
                </div>
              )}
            </section>
            <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h3 className="text-sm font-semibold">研究边界</h3>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-slate-400">深度</dt><dd className="mt-1">{project.depth}</dd></div>
                <div><dt className="text-xs text-slate-400">规则快照</dt><dd className="mt-1 font-mono text-xs">{project.skill_rule_version ?? '未记录'}</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs text-slate-400">停止条件</dt><dd className="mt-1">{project.stop_condition || '未设置'}</dd></div>
              </dl>
            </section>
          </div>
        )}
        {!loading && view === 'changes' && (
          <ResearchChangeSetView
            project={project}
            refreshToken={changeRefreshToken}
            onChanged={onResearchChanged}
            onOpenDiscussion={onOpenDiscussion}
            onImportArchive={onImportArchive}
            onOpenSnapshots={onOpenSnapshots}
          />
        )}
        {!loading && view === 'decision' && (
          <ResearchDecisionWorkbench
            project={project}
            evidence={evidence}
            hypotheses={hypotheses}
            initialContext={decisionContext}
            onGoCompanies={() => onViewChange('companies')}
            onContextChange={onDecisionContextChange}
          />
        )}
        {!loading && view === 'review' && (
          <ReviewQueueView
            evidenceCandidates={evidenceCandidates}
            companyCandidates={companyCandidates}
            retrievalMode={retrievalMode}
            retrievalPlan={retrievalPlan}
            nativeWebSearch={nativeWebSearch}
            selectedTopNIds={selectedTopNIds}
            evidenceActionId={evidenceActionId}
            onConfirmEvidence={onConfirmEvidence}
            onResolveCompany={onResolveCompany}
            onGoCompanies={() => onViewChange('companies')}
          />
        )}
        {!loading && view === 'companies' && (
          <ResearchCompanyFinancialView
            project={project}
            graph={graph}
            onExpandCompanies={onExpandCompanies}
            dataRevision={companyDataRevision}
          />
        )}
        {!loading && view === 'graph' && provisionalReport && (!graph || graph.nodes.length === 0) ? (
          <section data-testid="industry-research-provisional-graph" role="status" className="border border-amber-200 bg-amber-50 px-4 py-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            <h3 className="text-sm font-semibold">图谱内容已生成，正在等待写回项目</h3>
            <p className="mt-1 text-xs leading-5">模型产物仍安全保存在本次运行中。使用顶部“写回项目”即可恢复已生成的节点和关系，不会重新搜索或调用模型。</p>
          </section>
        ) : !loading && view === 'graph' ? <ResearchGraphCanvas graph={graph} onEdit={onEditGraph} /> : null}
        {!loading && view === 'evidence' && <EvidenceView evidence={evidence} />}
        {!loading && view === 'hypotheses' && <HypothesisView hypotheses={hypotheses} />}
        {!loading && view === 'report' && (
          <ReportView
            report={report}
            partitions={reportPartitions}
            generated={generatedReport}
            provisional={provisionalReport}
            onCompareCurrent={generationRunId
              ? () => window.api.researchEvidence.compareSnapshot({
                  sourceKind: 'industry_report',
                  projectId: project.id,
                  runId: generationRunId,
                })
              : undefined}
            onDiscussChanges={onDiscussReportChanges}
            onGoReview={() => onViewChange('review')}
          />
        )}
      </div>
    </main>
  )
}

function ProjectActionMenu({ onEdit, onArchive, onDelete }: {
  onEdit: () => void
  onArchive: () => void
  onDelete: () => void
}): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const invoke = (action: () => void) => {
    setOpen(false)
    action()
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="项目操作"
        aria-expanded={open}
        title="项目操作"
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 items-center gap-1.5 rounded-md border border-slate-300 px-2.5 text-xs text-slate-600 transition-colors hover:border-cyan-400 hover:bg-slate-50 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
      >
        <span>项目</span>
        <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor"><circle cx="4" cy="10" r="1.3" /><circle cx="10" cy="10" r="1.3" /><circle cx="16" cy="10" r="1.3" /></svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-40 w-40 rounded-md border border-slate-200 bg-white p-1.5 text-xs shadow-xl shadow-slate-950/10 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/35">
          <button type="button" role="menuitem" onClick={() => invoke(onEdit)} className="flex min-h-9 w-full items-center rounded px-2.5 text-left hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:bg-slate-800">编辑研究边界</button>
          <button type="button" role="menuitem" onClick={() => invoke(onArchive)} className="flex min-h-9 w-full items-center rounded px-2.5 text-left text-amber-700 hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300 dark:hover:bg-amber-950/30">归档项目</button>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          <button type="button" role="menuitem" onClick={() => invoke(onDelete)} className="flex min-h-9 w-full items-center rounded px-2.5 text-left text-red-600 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-300 dark:hover:bg-red-950/30">删除项目</button>
        </div>
      )}
    </div>
  )
}

export function ReviewQueueView({
  evidenceCandidates,
  companyCandidates,
  retrievalMode,
  retrievalPlan,
  nativeWebSearch,
  selectedTopNIds,
  evidenceActionId,
  onConfirmEvidence,
  onResolveCompany,
  onGoCompanies,
}: {
  evidenceCandidates: ResearchEvidenceCandidateView[]
  companyCandidates: ResearchCompanyCandidateView[]
  retrievalMode?: string | null
  retrievalPlan?: ResearchRetrievalPlanView | null
  nativeWebSearch?: ResearchNativeWebSearchView | null
  selectedTopNIds: string[]
  evidenceActionId?: string | null
  onConfirmEvidence?: (candidateId: string, action: 'confirm' | 'reject') => void
  onResolveCompany?: (candidate: ResearchCompanyCandidateView, action: 'accept' | 'exclude') => void
  onGoCompanies: () => void
}): React.ReactElement {
  const [sourceFilter, setSourceFilter] = useState<'representative' | 'all' | 'official' | 'failed'>('representative')
  const [sourceQuery, setSourceQuery] = useState('')
  const representativeIds = useMemo(() => new Set(selectedTopNIds), [selectedTopNIds])
  const filteredEvidence = useMemo(() => {
    const query = sourceQuery.trim().toLowerCase()
    return evidenceCandidates.filter((item, index) => {
      if (sourceFilter === 'representative' && !(representativeIds.has(item.id) || (!representativeIds.size && index < 14))) return false
      if (sourceFilter === 'official' && !['official_detail', 'user_url'].includes(item.sourceKind || '')) return false
      if (sourceFilter === 'failed' && item.status !== 'failed') return false
      if (!query) return true
      return [item.title, item.summary, item.excerpt, item.query, item.sourceUrl]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
  }, [evidenceCandidates, representativeIds, sourceFilter, sourceQuery])
  const banner = modeBanner(retrievalMode, retrievalPlan?.enhancedSearch)
  if (!evidenceCandidates.length && !companyCandidates.length && !nativeWebSearch) {
    return <EmptyState text="暂无来源审计记录。生成完成后，代表性引用、完整候选池和检索计划会集中出现在这里。" />
  }
  return (
    <div className="space-y-4">
      {banner && (
        <section className={`rounded-md border p-4 ${banner.className}`}>
          <h3 className="text-sm font-semibold">{banner.title}</h3>
          <p className="mt-1 text-xs leading-5">{banner.text}</p>
          {retrievalPlan?.message && <p className="mt-2 text-[11px] opacity-80">{retrievalPlan.message}</p>}
          {banner.showSearchConfig && (
            <div className="mt-3">
              <ResearchWebSearchConfigPanel variant="banner" />
            </div>
          )}
        </section>
      )}
      <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="text-sm font-semibold">本次结论的检索与引用</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          系统已经完成检索、分析和结论生成。这里仅用于追溯依据；发现不适用来源时可以单独排除，后续产业研究讨论将不再引用该 URL。
        </p>
        {nativeWebSearch && (
          <div data-testid="industry-research-native-web-search" className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
            {nativeWebSearch.status === 'succeeded' ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-emerald-700 dark:text-emerald-300">
                    GPT 原生网页搜索已完成
                  </span>
                  <span className="text-slate-400">
                    {nativeWebSearch.provider || 'chatgpt'} / {nativeWebSearch.model || '未记录模型'}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <span>{nativeWebSearch.calls.length} 次工具动作</span>
                  <span>{nativeWebSearch.sources.length} 条检索来源</span>
                  <span>{nativeWebSearch.citations.length} 处正文引用</span>
                </div>
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer font-medium text-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-slate-300">
                    查看模型工具调用轨迹
                  </summary>
                  <div className="mt-2 divide-y divide-slate-100 border-y border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                    {nativeWebSearch.calls.map((call, index) => {
                      const parameter = call.action.queries.length
                        ? call.action.queries.join(' / ')
                        : call.action.pattern || call.action.url || '未记录参数'
                      return (
                        <div key={call.id || `${call.action.type}-${index}`} className="grid gap-1 py-2 sm:grid-cols-[88px_minmax(0,1fr)_auto] sm:items-start">
                          <span className="font-medium text-slate-700 dark:text-slate-200">{nativeSearchActionLabel(call.action.type)}</span>
                          <span className="break-all text-slate-500 dark:text-slate-400">{parameter}</span>
                          <span className="text-slate-400">{call.status}</span>
                        </div>
                      )
                    })}
                    {!nativeWebSearch.calls.length && <p className="py-2 text-slate-400">未记录工具动作。</p>}
                  </div>
                </details>
              </>
            ) : nativeWebSearch.status === 'fallback' ? (
              <div className="text-xs leading-5 text-amber-700 dark:text-amber-300">
                GPT 原生搜索未返回可审计来源，本次已自动回退到应用受控检索，不需要用户手动放行。
                {nativeWebSearch.errorMessage ? ` 原因：${nativeWebSearch.errorMessage}` : ''}
              </div>
            ) : (
              <div className="text-xs leading-5 text-slate-500 dark:text-slate-400">本次关闭了联网检索，未调用 GPT 网页搜索工具。</div>
            )}
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['候选来源', evidenceCandidates.length],
            ['代表性来源', selectedTopNIds.length || Math.min(14, evidenceCandidates.length)],
            ['抓取失败', evidenceCandidates.filter((item) => item.status === 'failed').length],
            ['公司线索', companyCandidates.length],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700">
              <div className="text-[11px] text-slate-400">{label}</div>
              <div className="mt-1 text-lg font-semibold">{value}</div>
            </div>
          ))}
        </div>
        {retrievalPlan?.queries?.length ? (
          <details data-testid="industry-research-query-audit" className="mt-3 border-t border-slate-100 pt-3 text-xs dark:border-slate-800">
            <summary className="cursor-pointer font-medium text-slate-600 dark:text-slate-300">查看检索计划与 query 执行记录</summary>
            <div className="mt-2 space-y-2">
              {retrievalPlan.queries.map((query, index) => (
                <div key={query.id || `${query.text}-${index}`} className="grid gap-1 border-l-2 border-slate-200 pl-3 sm:grid-cols-[minmax(0,1fr)_auto] dark:border-slate-700">
                  <span className="break-words text-slate-600 dark:text-slate-300">{query.text || '未记录 query'}</span>
                  <span className="text-slate-400">{query.intent || 'general'} · {query.status || 'unknown'} · {query.hitCount ?? 0} 条</span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">本次结论来源</h3>
              <p className="mt-1 text-[11px] text-slate-400">默认只展示模型实际引用和系统选出的代表性来源，完整候选池按需查看。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={sourceQuery}
                onChange={(event) => setSourceQuery(event.target.value)}
                placeholder="搜索来源"
                className="h-8 w-40 rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <select
                data-testid="industry-research-source-filter"
                value={sourceFilter}
                onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}
                aria-label="来源范围"
                className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="representative">代表性来源</option>
                <option value="all">完整候选池</option>
                <option value="official">官方详情</option>
                <option value="failed">抓取失败</option>
              </select>
            </div>
          </div>
          {!evidenceCandidates.length ? (
            <p className="mt-4 text-sm text-slate-400">暂无候选来源。</p>
          ) : (
            <div className="mt-3 space-y-3">
              {filteredEvidence.map((item) => {
                const status = evidenceStatusMeta(item.status)
                return (
                  <article key={item.id} data-testid={`industry-research-source-${item.id}`} className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/40">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{readableEvidenceTitle(item)}</div>
                        <div className="mt-1 text-[11px] text-slate-400">
                          {hostLabel(item.sourceUrl)} · {sourceKindLabel(item.sourceKind, item.providerId)}
                          {item.isDetailPage ? ' · 详情页' : ' · 非详情/入口'}
                          {typeof item.rankScore === 'number' ? ` · 分 ${item.rankScore.toFixed(2)}` : ''}
                        </div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${status.className}`}>{status.label}</span>
                    </div>
                    {(item.summary || item.excerpt) && (
                      <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{item.summary || item.excerpt}</p>
                    )}
                    {item.failureReason && (
                      <p className="mt-1 text-[11px] text-red-600 dark:text-red-300">{item.failureReason}</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => void window.api.openExternal(item.sourceUrl)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] dark:border-slate-700 dark:bg-slate-900">打开原文</button>
                      {item.status !== 'confirmed' && item.status !== 'failed' && (
                        <button type="button" disabled={Boolean(evidenceActionId)} onClick={() => onConfirmEvidence?.(item.id, 'confirm')} className="rounded-md bg-cyan-700 px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-40">
                          {evidenceActionId === item.id ? '纳入中' : '纳入正式证据库'}
                        </button>
                      )}
                      {item.status !== 'rejected' && (
                        <button
                          type="button"
                          disabled={Boolean(evidenceActionId)}
                          title="排除后，后续产业研究讨论不会再引用该 URL"
                          onClick={() => onConfirmEvidence?.(item.id, 'reject')}
                          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] hover:border-red-300 hover:text-red-700 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-red-800 dark:hover:text-red-300"
                        >
                          {evidenceActionId === item.id ? '处理中' : '排除此来源'}
                        </button>
                      )}
                    </div>
                  </article>
                )
              })}
              {!filteredEvidence.length && <p className="py-8 text-center text-sm text-slate-400">当前筛选下没有来源记录。</p>}
            </div>
          )}
        </section>

        <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">公司线索</h3>
            <button type="button" onClick={onGoCompanies} className="text-[11px] text-cyan-700 hover:underline dark:text-cyan-300">打开公司与财报</button>
          </div>
          {!companyCandidates.length ? (
            <p className="mt-4 text-sm text-slate-400">暂无公司候选。</p>
          ) : (
            <div className="mt-3 space-y-3">
              {companyCandidates.map((item) => {
                const status = companyStatusMeta(item.resolutionStatus)
                const securityText = item.matchedSecurities?.length
                  ? item.matchedSecurities.map((security) => `${security.stockName} ${security.tsCode}`).join(' / ')
                  : '暂无唯一证券匹配'
                return (
                  <article key={item.id} className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/40">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{item.displayName}</div>
                        <div className="mt-1 text-[11px] text-slate-400">{securityText}</div>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${status.className}`}>{status.label}</span>
                    </div>
                    {item.rationale && (
                      <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-600 dark:text-slate-300">{item.rationale}</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.resolutionStatus !== 'accepted' && item.matchedSecurities?.length === 1 && (
                        <button type="button" onClick={() => onResolveCompany?.(item, 'accept')} className="rounded-md bg-cyan-700 px-2.5 py-1 text-[11px] font-semibold text-white">纳入验证</button>
                      )}
                      {item.resolutionStatus !== 'excluded' && (
                        <button type="button" onClick={() => onResolveCompany?.(item, 'exclude')} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] dark:border-slate-700 dark:bg-slate-900">排除</button>
                      )}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function EvidenceView({ evidence }: { evidence: ResearchEvidence[] }): React.ReactElement {
  if (!evidence.length) return <EmptyState text="尚无证据。事实必须绑定人工确认的原始来源。" />
  return (
    <div className="space-y-2">
      {evidence.map((item) => (
        <article key={item.id} className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex justify-between gap-3">
            <h3 className="text-sm font-semibold">{item.title}</h3>
            <span className="text-xs text-slate-400">{item.reliability}</span>
          </div>
          <div className="mt-1 text-xs text-slate-500">{item.source_name} · {formatResearchDate(item.fact_date)} · {item.direction}</div>
          {item.excerpt && <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">{item.excerpt}</p>}
          {item.conflict_note && <div className="mt-3 border-l-2 border-amber-400 pl-3 text-xs text-amber-700 dark:text-amber-300">{item.conflict_note}</div>}
        </article>
      ))}
    </div>
  )
}

function HypothesisView({ hypotheses }: { hypotheses: ResearchHypothesis[] }): React.ReactElement {
  if (!hypotheses.length) return <EmptyState text="尚无假设。每条假设都必须给出最低成本反证。" />
  return (
    <div className="space-y-2">
      {hypotheses.map((item) => (
        <article key={item.id} className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex justify-between gap-3">
            <h3 className="text-sm font-semibold">{item.statement}</h3>
            <span className="text-xs text-slate-400">{item.status} · P{item.importance}</span>
          </div>
          <div className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm dark:bg-slate-950">最低成本反证：{item.cheapest_disproof}</div>
          {item.events.length > 0 && <div className="mt-3 text-xs text-slate-500">最近事件：{item.events[0].reason}</div>}
        </article>
      ))}
    </div>
  )
}

export function ReportView({
  report,
  partitions,
  generated,
  provisional = false,
  onCompareCurrent,
  onDiscussChanges,
  onGoReview,
}: {
  report: ResearchReport | null
  partitions?: ResearchReportPartitions | null
  generated?: ResearchGeneratedReportDocument | null
  provisional?: boolean
  onCompareCurrent?: React.ComponentProps<typeof ResearchAuditTrace>['onCompareCurrent']
  onDiscussChanges?: React.ComponentProps<typeof ResearchAuditTrace>['onDiscussChanges']
  onGoReview?: () => void
}): React.ReactElement {
  const markdown = generated?.markdown || report?.reportDocument?.markdown || null
  if (!report && !markdown) return <EmptyState text="报告尚未生成。完成 AI 研究后，这里会展示完整 Markdown 研究报告。" />
  const effectivePartitions = partitions || report?.reportPartitions || null
  const supported = normalizeResearchReportFindings(effectivePartitions?.supportedFindings)
  const modelOnly = effectivePartitions?.modelOnlyFindings || []
  const pending = effectivePartitions?.pendingSources || []
  const title = generated?.title || report?.reportDocument?.title || null
  const conflicts = generated?.conflicts?.length
    ? generated.conflicts
    : report?.conflicts.map((item) => item.note) || []
  return (
    <div className="space-y-3">
      {provisional && (
        <section data-testid="industry-research-provisional-report" role="status" className="border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
          <h3 className="text-sm font-semibold">报告正文已生成，但尚未写入项目</h3>
          <p className="mt-1 text-xs leading-5">当前正文是本次失败运行中保留的完整产物。图谱、假设和报告状态在写回成功后才会成为项目正式结果。</p>
        </section>
      )}
      <section className="rounded-md border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">研究报告</div>
            <h3 className="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
              {title || '产业研究结论'}
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              先阅读完整结论，再按需核验公开来源与公司。弱取证草稿可独立阅读，但不能当作已完成强外部取证终稿。
            </p>
          </div>
          {onGoReview && (
            <button
              type="button"
              onClick={onGoReview}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
            >
              来源与审计
            </button>
          )}
        </div>
      </section>
      <ResearchAuditTrace
        trace={generated?.researchTrace || report?.reportDocument?.researchTrace}
        onCompareCurrent={onCompareCurrent}
        onDiscussChanges={onDiscussChanges}
      />
      {conflicts.length > 0 && (
        <details className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-red-800 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">
          <summary className="cursor-pointer text-sm font-semibold">重大来源冲突 {conflicts.length}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5">
            {conflicts.map((conflict, index) => <li key={`${conflict}-${index}`}>{conflict}</li>)}
          </ul>
        </details>
      )}
      {markdown ? (
        <article data-testid="industry-research-report-document" className="research-report-markdown overflow-hidden rounded-md border border-slate-200 bg-white px-5 py-6 dark:border-slate-800 dark:bg-slate-900 sm:px-8 sm:py-7">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children, ...props }) => <h1 {...props} className="mb-4 text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{children}</h1>,
              h2: ({ children, ...props }) => <h2 {...props} className="mb-3 mt-8 border-b border-slate-100 pb-2 text-lg font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-100">{children}</h2>,
              h3: ({ children, ...props }) => <h3 {...props} className="mb-2 mt-6 text-base font-semibold text-slate-800 dark:text-slate-100">{children}</h3>,
              p: ({ children, ...props }) => <p {...props} className="my-3 text-sm leading-7 text-slate-700 dark:text-slate-300">{children}</p>,
              ul: ({ children, ...props }) => <ul {...props} className="my-3 list-disc space-y-1.5 pl-5 text-sm leading-7 text-slate-700 dark:text-slate-300">{children}</ul>,
              ol: ({ children, ...props }) => <ol {...props} className="my-3 list-decimal space-y-1.5 pl-5 text-sm leading-7 text-slate-700 dark:text-slate-300">{children}</ol>,
              li: ({ children, ...props }) => <li {...props} className="pl-1">{children}</li>,
              blockquote: ({ children, ...props }) => <blockquote {...props} className="my-4 border-l-4 border-amber-300 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-900 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-200">{children}</blockquote>,
              a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer" className="text-cyan-700 underline decoration-cyan-300 underline-offset-2 dark:text-cyan-300">{children}</a>,
              table: ({ children, ...props }) => <div className="my-4 overflow-x-auto"><table {...props} className="min-w-full border-collapse text-left text-xs">{children}</table></div>,
              th: ({ children, ...props }) => <th {...props} className="border border-slate-200 bg-slate-50 px-3 py-2 font-semibold dark:border-slate-700 dark:bg-slate-950">{children}</th>,
              td: ({ children, ...props }) => <td {...props} className="border border-slate-200 px-3 py-2 align-top dark:border-slate-700">{children}</td>,
              code: ({ children, className, ...props }) => {
                const isBlock = typeof className === 'string' && className.includes('language-')
                if (isBlock) {
                  return <code {...props} className={`${className || ''} block whitespace-pre-wrap text-xs leading-5 text-slate-100`}>{children}</code>
                }
                return <code {...props} className="rounded bg-slate-100 px-1 py-0.5 text-[12px] text-slate-800 dark:bg-slate-800 dark:text-slate-200">{children}</code>
              },
              pre: ({ children, ...props }) => <pre {...props} className="my-4 overflow-x-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">{children}</pre>,
            }}
          >
            {markdown}
          </ReactMarkdown>
        </article>
      ) : report ? (
        <section className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="text-sm font-semibold">确定性摘要</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{report.summary}</p>
          <p className="mt-3 text-xs text-slate-400">当前项目还没有完整 Markdown 报告。重新运行 AI 研究后，这里会优先展示完整文档。</p>
        </section>
      ) : null}
      {effectivePartitions?.evidenceInsufficient && (
        <section className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
          当前检索证据不足。报告仍提供阶段性总结，但其中模型推断与待补来源不能视为已验证事实。
        </section>
      )}
      {(supported.length > 0 || modelOnly.length > 0 || pending.length > 0) && (
        <details className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800 dark:text-slate-100">证据分区（可选）</summary>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            <section className="rounded-md border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
              <h4 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">有证据支撑</h4>
              <ul className="mt-2 space-y-1 text-xs leading-5 text-emerald-900 dark:text-emerald-200">
                {supported.length ? supported.map((item) => <li key={item.text}>• {item.text}</li>) : <li>暂无</li>}
              </ul>
            </section>
            <section className="rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
              <h4 className="text-sm font-semibold text-amber-800 dark:text-amber-300">仅模型推断</h4>
              <ul className="mt-2 space-y-1 text-xs leading-5 text-amber-900 dark:text-amber-200">
                {modelOnly.length ? modelOnly.map((item) => <li key={item}>• {item}</li>) : <li>暂无</li>}
              </ul>
            </section>
            <section className="rounded-md border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950">
              <h4 className="text-sm font-semibold">待补来源</h4>
              <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                {pending.length ? pending.map((item) => <li key={item}>• {item}</li>) : <li>暂无</li>}
              </ul>
            </section>
          </div>
        </details>
      )}
      {report && report.missingSections.length > 0 && (
        <section className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
          缺失部分：{report.missingSections.join('、')}
        </section>
      )}
      {report?.mermaid && (
        <details className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800 dark:text-slate-100">结构化图谱投影</summary>
          <pre className="mt-3 overflow-x-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">{report.mermaid}</pre>
        </details>
      )}
    </div>
  )
}

function EmptyState({ text }: { text: string }): React.ReactElement {
  return <div className="rounded-md border border-dashed border-slate-300 bg-white px-5 py-12 text-center text-sm text-slate-400 dark:border-slate-700 dark:bg-slate-900">{text}</div>
}
