import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { useAppStore } from '../../store/appStore'
import type { AISessionSummary } from '../../store/appStore'
import MermaidBlock, { MermaidAwarePre } from '../MermaidBlock/MermaidBlock'
import IndustryAnalysisDrawer from '../IndustryChain/IndustryAnalysisDrawer'
import { INDUSTRY_CHAINS } from '../../utils/industryChainData'
import { ResearchDiscussionContextBar } from '../ResearchDiscussion/ResearchDiscussionContextBar'
import { ResearchDiscussionChangePanel } from '../ResearchDiscussion/ResearchDiscussionChangePanel'
import type {
  ResearchApiResponse,
  ResearchDiscussionContextItem,
  ResearchDiscussionSummary,
} from '../ResearchDiscussion/researchDiscussionTypes'
import { useResearchDiscussionNavigation } from '../ResearchDiscussion/useResearchDiscussionNavigation'
import { NewResearchDiscussionDialog } from './NewResearchDiscussionDialog'
import { AssistantWebSearchTrace, type ConversationWebSearchTrace } from './AssistantWebSearchTrace'
import { Round2InlineMarketVisual } from './Round2MarketVisuals'
import { normalizeAIResponseMarkdown } from './aiMarkdownModel'
import { prepareRound2MarketMarkdown } from './round2MarketVisualModel'
import { AppConfirmDialog } from '../shared/AppConfirmDialog'
import { publishAppToast } from '../shared/appToastBus'
import { ResearchAuditTrace, type ResearchAuditTraceView } from '../shared/ResearchAuditTrace'
import { ResearchAgentPanel } from './ResearchAgentPanel'

function extractStockCodes(text: string): string[] {
  const codes: string[] = []
  for (const match of text.matchAll(/STOCK_CODES:\s*([^\n]+)/gi)) {
    for (const entry of match[1].split(',')) {
      const raw = entry.trim().split('|')[0].trim().replace(/\.(SH|SZ|BJ)$/i, '')
      if (/^\d{6}$/.test(raw)) codes.push(raw)
    }
  }
  return Array.from(new Set(codes))
}

function stripStockCodeProtocol(text: string): string {
  return text.replace(/^\s*STOCK_CODES:\s*[^\n]*(?:\n|$)/gim, '').trim()
}

function stockKey(value: string): string {
  return value.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

function linkifyStockCodes(text: string, codes: string[]): string {
  if (codes.length === 0) return text
  const pattern = new RegExp(
    `(?<![\\d])(?:${codes.join('|')})(?:\\.[A-Za-z]{2})?(?![\\d])`,
    'g'
  )
  return text.replace(pattern, (match) => {
    const code = match.replace(/\.[A-Za-z]{2}$/, '')
    return `[${match}](#stock:${code})`
  })
}

function MarkdownComponents() {
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  return {
    pre: MermaidAwarePre,
    code({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) {
      if (className?.includes('language-mermaid')) {
        return <MermaidBlock code={String(children).replace(/\n$/, '')} />
      }
      return <code className={className} {...props}>{children}</code>
    },
    a({ href, children, ...props }: React.ComponentPropsWithoutRef<'a'>) {
      if (href?.startsWith('#stock:')) {
        const code = href.replace('#stock:', '')
        return (
          <span
            className="cursor-pointer text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
            onClick={() => navigateToStock(code)}
          >
            {children}
          </span>
        )
      }
      return <a href={href} {...props}>{children}</a>
    }
  }
}

interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
  researchAgentRunId?: string
  webSearchTrace?: ConversationWebSearchTrace
  researchTrace?: ResearchAuditTraceView | null
}

type DeleteDialogState =
  | { kind: 'all' }
  | { kind: 'all-protected'; count: number }
  | { kind: 'session'; session: AISessionSummary }

interface SessionDetail {
  id: number
  createdAt: string
  provider: string
  model: string
  articleUrls: string[]
  promptSent: string
  response: string | null
  responseRound2: string | null
  messages: ConversationMessage[] | null
  isError: boolean
  scanRunId: number | null
  content?: string | null
  structuredResult?: AIAnalysisStructuredResult | null
  discussion?: ResearchDiscussionSummary | null
  contextPreview?: ResearchDiscussionContextItem[]
}

const ROUND2_MARKET_BLOCKED_MARKER = '<!-- round2-market-data-blocked -->'

function isRound2MarketBlocked(response: string | null | undefined): boolean {
  return Boolean(response?.includes(ROUND2_MARKET_BLOCKED_MARKER))
}

interface StructuredTheme {
  name: string
  direction: 'positive' | 'negative' | 'neutral' | 'mixed'
  confidence: number
  evidence: string
}

interface StructuredCandidateStock {
  code: string
  name?: string | null
  direction: 'positive' | 'negative' | 'mixed' | 'unclear'
  evidenceLevel: 'direct' | 'inferred' | 'unverified'
  reason: string
  confidence: number
  evidence: string[]
  riskNotes: string[]
}

interface StructuredVerificationItem {
  title: string
  status: 'todo' | 'done' | 'blocked'
  reason: string
}

interface AIAnalysisStructuredResult {
  status: 'completed' | 'parse_failed'
  schemaVersion: number
  summary: string | null
  confidence: number | null
  primaryTheme: string | null
  themes: StructuredTheme[]
  candidateStocks: StructuredCandidateStock[]
  riskFactors: string[]
  verificationItems: StructuredVerificationItem[]
  errorMessage: string | null
  generatedAt: number | null
}

interface DerivedInsight {
  allText: string
  candidateCodes: string[]
  candidateStocks: StructuredCandidateStock[]
  mermaidCount: number
  skillNames: string[]
  matchChainId: string | undefined
  matchChainName: string | undefined
  headline: string
  primarySummary: string
  verificationItems: string[]
  statusLabel: string
  statusTone: 'ok' | 'warn' | 'error'
  confidence: number | null
  primaryTheme: string | null
  structuredStatus: AIAnalysisStructuredResult['status'] | null
}

type DetailTab = 'analysis' | 'source' | 'round2' | 'chat'
type SessionFilter = 'all' | 'discussion' | 'ok' | 'error' | 'stock'

function formatTime(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function hasStockCodes(response: string | null): boolean {
  return response ? extractStockCodes(response).length > 0 : false
}

function extractSkillNames(promptSent: string | undefined): string[] {
  if (!promptSent) return []
  const matches = promptSent.matchAll(/===== 分析框架：(.+?) =====/g)
  return [...matches].map((match) => match[1])
}

function extractStockNameMap(text: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const stockCodesLine of text.matchAll(/STOCK_CODES:\s*([^\n]+)/gi)) {
    for (const entry of stockCodesLine[1].split(',')) {
      const [rawCode, rawName] = entry.trim().split('|')
      const code = rawCode?.trim().replace(/\.(SH|SZ|BJ)$/i, '')
      const name = rawName?.trim()
      if (/^\d{6}$/.test(code) && name) result.set(code, name)
    }
  }

  for (const match of text.matchAll(/([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z\s*]{1,15})\s*[|｜\s]+(\d{6})(?:\.(?:SH|SZ|BJ))?/g)) {
    const name = match[1].replace(/[|｜]/g, '').trim()
    const code = match[2]
    if (!result.has(code) && /[\u4e00-\u9fa5]/.test(name) && name.length <= 12) result.set(code, name)
  }
  return result
}

function findBestMatchChain(text: string): string | undefined {
  if (!text) return undefined
  const lower = text.toLowerCase()
  let bestId: string | undefined
  let bestScore = 0
  for (const chain of INDUSTRY_CHAINS) {
    if (!chain.keywords) continue
    const score = chain.keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length
    if (score > bestScore) {
      bestScore = score
      bestId = chain.id
    }
  }
  return bestScore >= 1 ? bestId : undefined
}

function firstContentLine(text: string): string {
  const line = text
    .replace(/STOCK_CODES:\s*[^\n]+/gi, '')
    .split('\n')
    .map((item) => item.replace(/^#{1,6}\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter((item) => item.length >= 12)
    .find((item) => !/^I['’]?m\s/i.test(item) && !/checking whether public quote/i.test(item) && !/^执行摘要$/.test(item))
  if (!line) return '当前会话尚未形成可展示的研判摘要。'
  return line.length > 120 ? `${line.slice(0, 120)}...` : line
}

function buildInsightHeadline(structured: AIAnalysisStructuredResult | null, matchChainName: string | undefined, fallbackSummary: string): string {
  const theme = structured?.primaryTheme ?? matchChainName
  if (theme && structured?.summary) return `${theme}: ${structured.summary}`.slice(0, 54)
  if (theme) return `${theme}研判`.slice(0, 54)
  return fallbackSummary.length > 54 ? `${fallbackSummary.slice(0, 54)}...` : fallbackSummary
}

function countMermaidBlocks(text: string): number {
  return (text.match(/```mermaid/gi) ?? []).length
}

function buildVerificationItems(detail: SessionDetail | null, insightText: string, candidateCodes: string[]): string[] {
  if (!detail) return ['选择一条分析记录后生成验证清单。']
  const items: string[] = []
  if (candidateCodes.length > 0) {
    items.push('打开候选股票走势图, 核对日线、分时与持仓上下文。')
  } else {
    items.push('本轮文本没有显式股票代码, 先从原文和题材线索确认标的范围。')
  }
  if (isRound2MarketBlocked(detail.responseRound2)) {
    items.push('近期真实行情不足，先补齐日线数据，再重新运行第二轮复核。')
  } else if (!detail.responseRound2 && candidateCodes.length > 0) {
    items.push('可运行第二轮分析, 用本地行情补充 AI 文本判断。')
  }
  if (detail.articleUrls.length > 1) {
    items.push('对比多篇原文的发布时间和信息来源, 排除重复转载。')
  }
  if (/风险|不确定|回撤|分歧|谨慎|压力/.test(insightText)) {
    items.push('重点复核风险段落, 不把文本结论直接转成交易动作。')
  }
  if (items.length < 3) {
    items.push('必要时用追问补充时间范围、资金面、题材持续性和反证条件。')
  }
  return items.slice(0, 4)
}

function deriveInsight(detail: SessionDetail | null): DerivedInsight {
  if (!detail) {
    return {
      allText: '',
      candidateCodes: [],
      candidateStocks: [],
      mermaidCount: 0,
      skillNames: [],
      matchChainId: undefined,
      matchChainName: undefined,
      headline: '选择一条 AI 分析记录',
      primarySummary: '选择左侧记录查看研判内容。',
      verificationItems: ['选择一条分析记录后生成验证清单。'],
      statusLabel: '待选择',
      statusTone: 'warn',
      confidence: null,
      primaryTheme: null,
      structuredStatus: null
    }
  }
  const allText = [detail.response, detail.responseRound2, ...(detail.messages ?? []).map((message) => message.content)]
    .filter(Boolean)
    .join('\n')
  const structured = detail.structuredResult?.status === 'completed' ? detail.structuredResult : null
  const stockNameMap = extractStockNameMap(allText)
  const responseCandidateCodes = extractStockCodes(allText)
  const structuredByCode = new Map((structured?.candidateStocks ?? []).map((stock) => [stockKey(stock.code), stock]))
  const candidateCodes = Array.from(new Set([
    ...(structured?.candidateStocks ?? []).map((stock) => stockKey(stock.code)),
    ...responseCandidateCodes.map(stockKey),
  ]))
  const matchChainId = findBestMatchChain(allText)
  const matchChainName = structured?.primaryTheme ?? INDUSTRY_CHAINS.find((chain) => chain.id === matchChainId)?.name
  const round2Blocked = isRound2MarketBlocked(detail.responseRound2)
  const statusTone: DerivedInsight['statusTone'] = detail.isError || round2Blocked ? (detail.isError ? 'error' : 'warn') : candidateCodes.length === 0 ? 'warn' : structured || detail.responseRound2 ? 'ok' : 'warn'
  const statusLabel = detail.isError
    ? '分析失败'
    : candidateCodes.length === 0
      ? '待标的映射'
      : round2Blocked
        ? '行情复核受阻'
      : structured
        ? '结构化研判'
        : detail.structuredResult?.status === 'parse_failed'
          ? '结构化失败'
          : detail.responseRound2 ? '已接行情复核' : '待行情复核'
  const fallbackSummary = firstContentLine(detail.response ?? detail.responseRound2 ?? '')
  const candidateStocks = candidateCodes.map((code) => {
    const structuredStock = structuredByCode.get(code)
    if (structuredStock) {
      return {
        ...structuredStock,
        name: structuredStock.name ?? stockNameMap.get(code) ?? null
      }
    }
    return {
      code,
      name: stockNameMap.get(code) ?? null,
      direction: 'unclear' as const,
      evidenceLevel: 'unverified' as const,
      reason: '',
      confidence: 0,
      evidence: [],
      riskNotes: []
    }
  })
  return {
    allText,
    candidateCodes,
    candidateStocks,
    mermaidCount: countMermaidBlocks(allText),
    skillNames: extractSkillNames(detail.promptSent),
    matchChainId,
    matchChainName,
    headline: buildInsightHeadline(structured, matchChainName, structured?.summary ?? fallbackSummary),
    primarySummary: structured?.summary ?? fallbackSummary,
    verificationItems: structured?.verificationItems.map((item) => item.reason ? `${item.title}: ${item.reason}` : item.title) ?? buildVerificationItems(detail, allText, candidateCodes),
    statusLabel,
    statusTone,
    confidence: structured?.confidence ?? null,
    primaryTheme: structured?.primaryTheme ?? null,
    structuredStatus: detail.structuredResult?.status ?? null
  }
}

function sessionMatchesFilter(session: AISessionSummary, filter: SessionFilter, query: string): boolean {
  if (filter === 'discussion' && !session.discussion) return false
  if (filter === 'error' && !session.isError) return false
  if (filter === 'ok' && session.isError) return false
  if (filter === 'stock' && session.articleCount === 0) return false
  const keyword = query.trim().toLowerCase()
  if (!keyword) return true
  return [session.model, session.provider, formatTime(session.createdAt), String(session.articleCount), session.discussion?.origin.title ?? '']
    .some((value) => value.toLowerCase().includes(keyword))
}

function toneClass(tone: DerivedInsight['statusTone']): string {
  if (tone === 'error') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300'
  if (tone === 'warn') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
  return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
}

function formatConfidence(value: number | null): string {
  if (value == null) return '--'
  return `${Math.round(value * 100)}%`
}

const candidateDirectionMeta: Record<StructuredCandidateStock['direction'], { label: string; className: string }> = {
  positive: { label: '利好线索', className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' },
  negative: { label: '利空风险', className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300' },
  mixed: { label: '多空混合', className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300' },
  unclear: { label: '方向待确认', className: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300' },
}

const candidateEvidenceLabel: Record<StructuredCandidateStock['evidenceLevel'], string> = {
  direct: '直接证据',
  inferred: '产业映射推断',
  unverified: '尚未验证',
}

export function AIAnalysis() {
  const { aiSessions, loadAISessions, isAnalyzing } = useAppStore()
  const navigateToStock = useAppStore((state) => state.navigateToStock)
  const pendingDiscussionSessionId = useAppStore((state) => state.pendingResearchDiscussionSessionId)
  const clearPendingDiscussion = useAppStore((state) => state.clearPendingResearchDiscussion)
  const discussionReturnTarget = useAppStore((state) => state.pendingResearchDiscussionReturnTarget)
  const clearDiscussionReturnTarget = useAppStore((state) => state.clearResearchDiscussionReturnTarget)
  const returnFromDiscussion = useAppStore((state) => state.returnFromResearchDiscussion)
  const researchDiscussionDrafts = useAppStore((state) => state.researchDiscussionDrafts)
  const setResearchDiscussionDraft = useAppStore((state) => state.setResearchDiscussionDraft)
  const clearResearchDiscussionDraft = useAppStore((state) => state.clearResearchDiscussionDraft)
  const {
    start: startDiscussion,
    startFromEvidence: startEvidenceDiscussion,
    starting: startingDiscussion,
    error: startDiscussionError,
    clearError: clearStartDiscussionError,
  } = useResearchDiscussionNavigation()
  const markdownComponents = MarkdownComponents()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [sessionsReady, setSessionsReady] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [triggeringRound2, setTriggeringRound2] = useState(false)
  const [recoveringCandidates, setRecoveringCandidates] = useState(false)
  const [portfolioByCode, setPortfolioByCode] = useState<Map<string, string>>(new Map())
  const [followUpInput, setFollowUpInput] = useState('')
  const [sendingFollowUp, setSendingFollowUp] = useState(false)
  const [showIndustryAnalysis, setShowIndustryAnalysis] = useState(false)
  const [industryAnalysisText, setIndustryAnalysisText] = useState('')
  const [industryChainId, setIndustryChainId] = useState<string | undefined>()
  const [generatingStructured, setGeneratingStructured] = useState(false)
  const [activeTab, setActiveTab] = useState<DetailTab>('analysis')
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all')
  const [sessionQuery, setSessionQuery] = useState('')
  const [newDiscussionOpen, setNewDiscussionOpen] = useState(false)
  const [updatingContext, setUpdatingContext] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const insight = useMemo(() => deriveInsight(detail), [detail])
  const round2Segments = useMemo(() => {
    if (!detail?.responseRound2) return []
    const markdown = linkifyStockCodes(
      normalizeAIResponseMarkdown(stripStockCodeProtocol(detail.responseRound2)),
      insight.candidateCodes
    )
    return prepareRound2MarketMarkdown(markdown, insight.candidateStocks)
  }, [detail?.responseRound2, insight.candidateCodes, insight.candidateStocks])
  const round2CandidateByCode = useMemo(
    () => new Map(insight.candidateStocks.map((candidate) => [stockKey(candidate.code), candidate])),
    [insight.candidateStocks]
  )
  const negativePortfolioCandidates = useMemo(
    () => insight.candidateStocks.filter((stock) => stock.direction === 'negative' && portfolioByCode.has(stockKey(stock.code))),
    [insight.candidateStocks, portfolioByCode]
  )
  const knownCodes = insight.candidateCodes
  const linkify = (text: string) => linkifyStockCodes(text, knownCodes)
  const filteredSessions = useMemo(
    () => aiSessions.filter((session) => sessionMatchesFilter(session, sessionFilter, sessionQuery)),
    [aiSessions, sessionFilter, sessionQuery]
  )
  const visibleDetailTabs: Array<[DetailTab, string]> = detail?.discussion
    ? [['chat', '讨论记录']]
    : [['analysis', '本次研判'], ['source', '来源与提示词'], ['round2', '行情复核'], ['chat', '追问记录']]

  useEffect(() => {
    void loadAISessions().finally(() => setSessionsReady(true))
    void window.api.portfolio.list().then((result) => {
      if (!result.ok || !result.data) return
      setPortfolioByCode(new Map(result.data.map((item) => [stockKey(item.tsCode), item.stockName])))
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.ai.onTushareNotConfigured(() => {
      showToast('本地近期日线不足，且未配置 Tushare，第二轮真实行情复核已受阻。可前往「数据源」补齐数据后重新复核。')
    })
    return () => { unsubscribe() }
  }, [])

  useEffect(() => {
    if (pendingDiscussionSessionId != null) {
      if (!sessionsReady) return
      if (aiSessions.some((session) => session.id === pendingDiscussionSessionId)) {
        void handleSelectSession(pendingDiscussionSessionId)
        clearPendingDiscussion()
        return
      }
      clearPendingDiscussion()
      showToast('来源讨论已删除，已接受的研究版本仍然保留。')
    }
    if (aiSessions.length > 0 && selectedId === null) {
      handleSelectSession(aiSessions[0].id)
    }
  }, [aiSessions, pendingDiscussionSessionId, sessionsReady])

  useEffect(() => {
    if (!isAnalyzing) {
      loadAISessions()
    }
  }, [isAnalyzing])

  useEffect(() => {
    if (
      !detail
      || loadingDetail
      || discussionReturnTarget?.stateKey !== 'research-discussion'
      || discussionReturnTarget.entityId !== String(detail.id)
    ) return
    const scrollTop = discussionReturnTarget.scrollTop
    window.requestAnimationFrame(() => {
      if (scrollRef.current && scrollTop != null) scrollRef.current.scrollTop = scrollTop
      clearDiscussionReturnTarget()
    })
  }, [clearDiscussionReturnTarget, detail, discussionReturnTarget, loadingDetail])

  function showToast(message: string) {
    publishAppToast(message, 'info')
  }

  const refreshAfterResearchAgent = useCallback(async () => {
    if (selectedId == null) return
    const latest = await window.api.ai.getSession(selectedId)
    if (latest) setDetail(latest)
    await loadAISessions()
  }, [loadAISessions, selectedId])

  async function handleSelectSession(id: number) {
    setSelectedId(id)
    setLoadingDetail(true)
    setFollowUpInput(researchDiscussionDrafts[id] ?? '')
    try {
      const sessionDetail = await window.api.ai.getSession(id)
      setDetail(sessionDetail)
      setActiveTab(sessionDetail?.discussion ? 'chat' : sessionDetail?.responseRound2 ? 'round2' : 'analysis')
    } finally {
      setLoadingDetail(false)
    }
  }

  function requestDeleteAll() {
    setDeleteError(null)
    setDeleteDialog({ kind: 'all' })
  }

  function requestDeleteSession(session: AISessionSummary, event: React.MouseEvent) {
    event.stopPropagation()
    setDeleteError(null)
    setDeleteDialog({ kind: 'session', session })
  }

  async function confirmDelete() {
    if (!deleteDialog) return
    setDeleteError(null)
    if (deleteDialog.kind === 'session') {
      const id = deleteDialog.session.id
      setDeletingId(id)
      try {
        const result = await window.api.ai.deleteSession(id, true)
        if (result?.ok === false) throw new Error(result.message || result.error || '删除失败')
        if (selectedId === id) {
          setSelectedId(null)
          setDetail(null)
        }
        await loadAISessions()
        setDeleteDialog(null)
        showToast('分析记录已删除。')
      } catch (error) {
        setDeleteError(error instanceof Error ? error.message : String(error))
      } finally {
        setDeletingId(null)
      }
      return
    }

    setDeleting(true)
    try {
      const includeResearchDiscussions = deleteDialog.kind === 'all-protected'
      const result = await window.api.ai.deleteAllSessions(includeResearchDiscussions)
      if (result?.ok === false) throw new Error(result.message || result.error || '清除记录失败')
      setSelectedId(null)
      setDetail(null)
      await loadAISessions()
      if (!includeResearchDiscussions && (result?.protectedResearchDiscussions ?? 0) > 0) {
        setDeleteDialog({ kind: 'all-protected', count: result.protectedResearchDiscussions })
      } else {
        setDeleteDialog(null)
        showToast(includeResearchDiscussions ? '全部分析记录和研究讨论已清除。' : 'AI分析记录已清除。')
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeleting(false)
    }
  }

  async function handleTriggerRound2() {
    if (!detail) return
    setTriggeringRound2(true)
    try {
      const result = await window.api.ai.triggerRound2(detail.id)
      if (result?.responseRound2) {
        const latest = await window.api.ai.getSession(detail.id)
        setDetail(latest ?? ((prev) => prev ? { ...prev, responseRound2: result.responseRound2 } : prev))
        await loadAISessions()
        setActiveTab('round2')
        showToast(result.marketDataStatus === 'blocked' ? '真实行情数据不足，已保留阻断原因；补齐日线后可重新复核。' : '第二轮真实行情复核已完成。')
        setTimeout(() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 100)
      } else if (result?.error) {
        showToast(`第二轮分析失败：${result.error}`)
      }
    } finally {
      setTriggeringRound2(false)
    }
  }

  async function handleRecoverCandidates() {
    if (!detail || recoveringCandidates) return
    setRecoveringCandidates(true)
    try {
      const result = await window.api.ai.recoverCandidates(detail.id)
      if (!result.ok) {
        showToast(result.message || 'A股标的映射失败，请稍后重试。')
        return
      }
      const latest = await window.api.ai.getSession(detail.id)
      if (latest) setDetail(latest)
      await loadAISessions()
      if ((result.stockCodes?.length ?? 0) > 0) {
        showToast(`已补充 ${result.stockCodes!.length} 个A股研究候选，可继续行情复核。`)
      } else {
        showToast('本次恢复仍未得到合法A股代码，请结合原文或产业分析继续核验。')
      }
    } catch {
      showToast('A股标的映射失败，请稍后重试。原研判已保留。')
    } finally {
      setRecoveringCandidates(false)
    }
  }

  async function handleFollowUp() {
    const message = followUpInput.trim()
    if (!message || !detail) return
    setSendingFollowUp(true)
    setFollowUpInput('')
    setActiveTab('chat')

    const optimisticMessages: ConversationMessage[] = [
      ...(detail.messages ?? []),
      { role: 'user', content: message }
    ]
    setDetail((prev) => prev ? { ...prev, messages: optimisticMessages } : prev)
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50)

    try {
      const result = await window.api.ai.followUp(detail.id, message)
      if (result?.messages) {
        const latest = await window.api.ai.getSession(detail.id)
        setDetail(latest ?? ((prev) => prev ? { ...prev, messages: result.messages } : prev))
        await loadAISessions()
        if (detail.discussion) clearResearchDiscussionDraft(detail.id)
      } else if (result?.error) {
        showToast(`追问失败：${result.error}`)
        setDetail((prev) => prev ? { ...prev, messages: detail.messages } : prev)
        setFollowUpInput(message)
      }
    } finally {
      setSendingFollowUp(false)
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 100)
    }
  }

  async function updateDiscussionContext(keys: string[]) {
    if (!detail?.discussion) return
    setUpdatingContext(true)
    const response = await window.api.ai.updateResearchDiscussionContext({
      requestId: crypto.randomUUID(), sessionId: detail.id, includedContextKeys: keys,
    }) as ResearchApiResponse<{ discussion: ResearchDiscussionSummary; contextPreview: ResearchDiscussionContextItem[] }>
    setUpdatingContext(false)
    if (!response.ok || !response.data) {
      showToast(response.message || response.error || '更新上下文失败')
      return
    }
    setDetail((current) => current ? { ...current, discussion: response.data!.discussion, contextPreview: response.data!.contextPreview } : current)
  }

  async function createManualDiscussion(value: { question: string; projectId: string | null }) {
    const result = await startDiscussion({
      origin: { type: 'manual', id: null },
      projectId: value.projectId,
      initialQuestion: value.question,
      mode: 'new',
      returnTarget: { tab: 'ai-analysis', subTab: 'records' },
    })
    if (!result) return
    setNewDiscussionOpen(false)
    await loadAISessions()
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleFollowUp()
    }
  }

  async function handleGenerateStructuredResult(force = true) {
    if (!detail) return
    setGeneratingStructured(true)
    try {
      const result = await window.api.ai.generateStructuredResult(detail.id, force)
      const latest = await window.api.ai.getSession(detail.id)
      setDetail(latest ?? (result?.structuredResult ? { ...detail, structuredResult: result.structuredResult } : detail))
      await loadAISessions()
      if (result?.structuredResult?.status === 'parse_failed') {
        showToast('结构化研判生成失败，当前仍使用文本派生结果。')
      } else {
        showToast('结构化研判已更新。')
      }
    } finally {
      setGeneratingStructured(false)
    }
  }

  function openIndustryAnalysis() {
    if (!detail) return
    const text = [detail.content, detail.response, detail.responseRound2].filter(Boolean).join('\n')
    setIndustryAnalysisText(text.slice(0, 800))
    setIndustryChainId(insight.matchChainId)
    setShowIndustryAnalysis(true)
  }

  if (aiSessions.length === 0 && !isAnalyzing) {
    return (
      <div className="flex flex-1 items-center justify-center bg-slate-50 px-6 text-center dark:bg-slate-950">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">开始一次 AI 讨论</h2>
          <p className="mt-2 text-sm text-slate-500">可以直接提出研究问题，也可以稍后从复盘、信号或产业研究进入。</p>
          <button type="button" data-testid="new-research-discussion" onClick={() => { clearStartDiscussionError(); setNewDiscussionOpen(true) }} className="mt-4 rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800">发起研究讨论</button>
        </div>
        <NewResearchDiscussionDialog
          open={newDiscussionOpen}
          submitting={startingDiscussion}
          error={startDiscussionError}
          onClose={() => setNewDiscussionOpen(false)}
          onSubmit={(value) => { void createManualDiscussion(value) }}
        />
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-1 overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">

      <aside className="flex w-64 flex-shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 px-3 py-3 dark:border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">分析记录</div>
              <div className="mt-0.5 text-[11px] text-slate-500">{aiSessions.length} 条会话</div>
            </div>
            <div className="flex gap-1">
              <button type="button" data-testid="new-research-discussion" onClick={() => { clearStartDiscussionError(); setNewDiscussionOpen(true) }} className="rounded-md bg-cyan-700 px-2 py-1 text-[11px] font-semibold text-white">讨论</button>
              <button onClick={requestDeleteAll} disabled={deleting || aiSessions.length === 0} className="rounded-md border border-red-200 px-2 py-1 text-[11px] text-red-500 transition-colors hover:bg-red-50 disabled:opacity-30 dark:border-red-900 dark:hover:bg-red-950/40">清除</button>
            </div>
          </div>
          <input
            value={sessionQuery}
            onChange={(event) => setSessionQuery(event.target.value)}
            placeholder="搜索模型、厂商或时间"
            className="mt-3 w-full rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs outline-none transition focus:border-blue-300 dark:border-slate-700 dark:bg-slate-950"
          />
          <div className="mt-2 grid grid-cols-5 gap-1 text-[11px]">
            {([
              ['all', '全部'],
              ['discussion', '讨论'],
              ['ok', '完成'],
              ['error', '失败'],
              ['stock', '有文']
            ] as Array<[SessionFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setSessionFilter(value)}
                className={[
                  'rounded-md px-1.5 py-1 transition-colors',
                  sessionFilter === value
                    ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isAnalyzing && (
            <div className="border-b border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-600 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
              分析中...
            </div>
          )}
          {filteredSessions.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-slate-400">没有匹配的分析记录</div>
          ) : filteredSessions.map((session) => (
            <div
              key={session.id}
              className={[
                'group relative border-b border-slate-100 dark:border-slate-800',
                selectedId === session.id ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/70'
              ].join(' ')}
            >
              <button data-testid={`ai-session-${session.id}`} onClick={() => handleSelectSession(session.id)} className="w-full px-3 py-3 pr-8 text-left">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-slate-800 dark:text-slate-200">{formatTime(session.createdAt)}</span>
                  {session.isError && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-600 dark:bg-red-950/50 dark:text-red-300">失败</span>}
                </div>
                <div className="mt-1 truncate text-[11px] text-slate-500">{session.discussion?.origin.title || `${session.provider} · ${session.model}`}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span>{session.discussion ? '研究讨论' : `${session.articleCount} 篇文章来源`}</span>
                  {!session.discussion && session.hasRound2 && <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">已复核</span>}
                  {session.structuredStatus === 'completed' && <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">结构化</span>}
                  {session.structuredStatus === 'parse_failed' && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600 dark:bg-amber-950/40 dark:text-amber-300">回退</span>}
                </div>
              </button>
              <button
                onClick={(event) => requestDeleteSession(session, event)}
                disabled={deletingId === session.id}
                type="button"
                aria-label={`删除记录 ${session.discussion?.origin.title ?? session.id}`}
                className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-lg leading-none text-slate-300 opacity-0 transition-colors hover:bg-red-50 hover:text-red-500 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 disabled:opacity-30 group-hover:opacity-100 dark:hover:bg-red-950/35"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {loadingDetail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">加载中...</div>
        ) : detail ? (
          <>
            {detail.discussion && (
              <ResearchDiscussionContextBar
                discussion={detail.discussion}
                contextItems={detail.contextPreview ?? []}
                canEditContext={(detail.messages?.length ?? 0) === 0}
                updating={updatingContext}
                onUpdateContext={(keys) => { void updateDiscussionContext(keys) }}
                onReturn={() => returnFromDiscussion(detail.discussion!.returnTarget)}
              />
            )}
            <header className="border-b border-slate-200 bg-white px-5 py-4 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex flex-col gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span>{detail.provider} · {detail.model}</span>
                    <span>{formatTime(detail.createdAt)}</span>
                    {!detail.discussion && <span className={['rounded-full border px-2 py-0.5', toneClass(insight.statusTone)].join(' ')}>{insight.statusLabel}</span>}
                    {!detail.discussion && insight.confidence != null && <span>可信度 {formatConfidence(insight.confidence)}</span>}
                  </div>
                  <h2 className="mt-2 line-clamp-1 text-lg font-semibold text-slate-900 dark:text-slate-50">{detail.discussion?.origin.title || insight.headline}</h2>
                  {!detail.discussion && insight.primarySummary !== insight.headline && (
                    <p className="mt-1 line-clamp-2 max-w-5xl text-xs leading-5 text-slate-500 dark:text-slate-400">{insight.primarySummary}</p>
                  )}
                  {detail.structuredResult?.status === 'parse_failed' && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                      结构化研判解析失败，当前显示文本派生结果。{detail.structuredResult.errorMessage ? `原因：${detail.structuredResult.errorMessage}` : ''}
                    </div>
                  )}
                </div>
                {!detail.discussion && <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-300">来源 {detail.articleUrls.length}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-300">候选 {insight.candidateStocks.length}</span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-slate-600 dark:border-slate-700 dark:bg-slate-950/50 dark:text-slate-300">图表 {insight.mermaidCount}</span>
                  <button
                    onClick={() => handleGenerateStructuredResult(true)}
                    disabled={generatingStructured || !detail.response}
                    className="ml-auto rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    {generatingStructured ? '重建中...' : detail.structuredResult?.status === 'completed' ? '重建结构化研判' : '生成结构化研判'}
                  </button>
                </div>}
              </div>
            </header>

            {negativePortfolioCandidates.length > 0 && (
              <div data-testid="ai-portfolio-risk-alert" role="alert" className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                <div className="font-semibold">持仓风险命中：本轮研判识别到可能利空的持仓公司</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span>系统已按P4/P5风险信号进入今日看板，请先核验业务关联和原文证据。</span>
                  {negativePortfolioCandidates.map((stock) => (
                    <button
                      key={stock.code}
                      type="button"
                      onClick={() => navigateToStock(stock.code, stock.name ?? portfolioByCode.get(stockKey(stock.code)))}
                      className="rounded border border-red-300 bg-white px-2 py-1 font-medium hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-400 dark:border-red-800 dark:bg-red-950/60 dark:hover:bg-red-900/50"
                    >
                      查看 {stock.name ?? portfolioByCode.get(stockKey(stock.code)) ?? stock.code}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {detail.response && insight.candidateStocks.length === 0 && (
              <div data-testid="ai-candidate-recovery-state" role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                <div>
                  <div className="font-semibold">尚未映射到A股公司，行情复核链路未完成</div>
                  <div className="mt-1 opacity-80">系统会补充产业链研究候选并标注推断等级，不会把候选直接当成已验证事实。</div>
                </div>
                <button
                  type="button"
                  onClick={() => { void handleRecoverCandidates() }}
                  disabled={recoveringCandidates}
                  className="min-h-9 rounded-md bg-amber-700 px-3 py-2 font-semibold text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {recoveringCandidates ? '正在映射...' : '重新映射A股标的'}
                </button>
              </div>
            )}

            <div className="border-b border-slate-200 bg-white px-5 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex gap-1 overflow-x-auto py-2 text-xs">
                {visibleDetailTabs.map(([value, label]) => (
                  <button
                    key={value}
                    onClick={() => setActiveTab(value)}
                    className={[
                      'rounded-md px-3 py-1.5 transition-colors',
                      activeTab === value
                        ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                        : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                    ].join(' ')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5">
              {activeTab === 'analysis' && (
                <section className="space-y-4">
                  {insight.candidateStocks.length > 0 && (
                    <section className="xl:hidden" aria-labelledby="compact-candidate-heading">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 id="compact-candidate-heading" className="text-sm font-semibold text-slate-800 dark:text-slate-100">A股影响标的</h3>
                        <span className="text-xs text-slate-400">{insight.candidateStocks.length} 家</span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {insight.candidateStocks.map((stock) => {
                          const direction = candidateDirectionMeta[stock.direction]
                          const isPortfolio = portfolioByCode.has(stockKey(stock.code))
                          return (
                            <button
                              key={stock.code}
                              type="button"
                              data-testid={`ai-compact-candidate-${stock.code}`}
                              onClick={() => navigateToStock(stock.code, stock.name ?? portfolioByCode.get(stockKey(stock.code)))}
                              className="min-w-0 rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-blue-700 dark:hover:bg-slate-800"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{stock.name ?? portfolioByCode.get(stockKey(stock.code)) ?? '名称待补全'}</span>
                                  <span className="mt-0.5 block text-[11px] text-slate-400">{stock.code}</span>
                                </span>
                                {stock.confidence > 0 && <span className="text-[11px] text-slate-400">可信度 {formatConfidence(stock.confidence)}</span>}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${direction.className}`}>{direction.label}</span>
                                <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{candidateEvidenceLabel[stock.evidenceLevel]}</span>
                                {isPortfolio && <span className="rounded border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-300">我的持仓</span>}
                              </div>
                              {stock.reason && <div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{stock.reason}</div>}
                            </button>
                          )
                        })}
                      </div>
                    </section>
                  )}
                  <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">第一轮分析</span>
                      {insight.skillNames.map((name) => (
                        <span key={name} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{name}</span>
                      ))}
                    </div>
                    {detail.response ? (
                      <div className="prose prose-sm max-w-none text-slate-800 dark:prose-invert dark:text-slate-200">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
                          {linkify(normalizeAIResponseMarkdown(stripStockCodeProtocol(detail.response)))}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <div className="rounded-lg bg-slate-50 px-3 py-5 text-sm text-slate-400 dark:bg-slate-950/60">无响应内容</div>
                    )}
                  </div>
                </section>
              )}

              {activeTab === 'source' && (
                <section className="space-y-4">
                  <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <h3 className="text-sm font-semibold">原始来源</h3>
                    <div className="mt-3 max-h-48 space-y-1 overflow-y-auto">
                      {detail.articleUrls.length > 0 ? detail.articleUrls.map((url, index) => (
                        <a key={index} href={url} target="_blank" rel="noreferrer" className="block truncate rounded-md bg-slate-50 px-3 py-2 text-xs text-blue-600 hover:underline dark:bg-slate-950/60 dark:text-blue-300">
                          {url}
                        </a>
                      )) : <div className="text-sm text-slate-400">本会话未记录文章来源。</div>}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <h3 className="text-sm font-semibold">发送给模型的提示词</h3>
                    <pre className="mt-3 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">
                      {detail.promptSent || '无提示词记录'}
                    </pre>
                  </div>
                </section>
              )}

              {activeTab === 'round2' && (
                <section className="space-y-4">
                  <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">第二轮真实行情复核</h3>
                      {hasStockCodes(detail.response) && (
                        <button
                          onClick={handleTriggerRound2}
                          disabled={triggeringRound2}
                          className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700 disabled:bg-blue-300"
                        >
                          {triggeringRound2 ? '正在读取行情并复核...' : detail.responseRound2 ? '重新用近期行情复核' : '用近期真实行情复核'}
                        </button>
                      )}
                    </div>
                    {detail.responseRound2 ? (
                      <div data-testid="ai-round2-report-body" className="prose prose-sm mt-4 max-w-none text-slate-800 dark:prose-invert dark:text-slate-200">
                        {round2Segments.map((segment, index) => {
                          if (segment.kind === 'markdown') {
                            return (
                              <ReactMarkdown key={`markdown-${index}`} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
                                {segment.markdown}
                              </ReactMarkdown>
                            )
                          }
                          const candidate = round2CandidateByCode.get(segment.code)
                          if (!candidate) return null
                          const fallback = segment.fallbackMarkdown ? (
                            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
                              {segment.fallbackMarkdown}
                            </ReactMarkdown>
                          ) : undefined
                          return (
                            <Round2InlineMarketVisual
                              key={`visual-${segment.code}-${index}`}
                              candidate={candidate}
                              createdAt={detail.createdAt}
                              fallback={fallback}
                            />
                          )
                        })}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-lg bg-slate-50 px-3 py-8 text-center text-sm text-slate-500 dark:bg-slate-950/60 dark:text-slate-400">
                        <div>{hasStockCodes(detail.response) ? '尚未运行第二轮行情复核。' : '第一轮尚未形成可复核的A股标的。'}</div>
                        {!hasStockCodes(detail.response) && (
                          <button
                            type="button"
                            onClick={() => { void handleRecoverCandidates() }}
                            disabled={recoveringCandidates}
                            className="mt-3 min-h-9 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
                          >
                            {recoveringCandidates ? '正在映射...' : '重新映射A股标的'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {activeTab === 'chat' && (
                <section className="space-y-4">
                  <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                    <h3 className="text-sm font-semibold">{detail.discussion ? '讨论记录' : '追问记录'}</h3>
                    {detail.messages && detail.messages.length > 0 ? (
                      <div className="mt-4 space-y-3">
                        {detail.messages.map((message, index) => (
                          <div key={index} className={['flex', message.role === 'user' ? 'justify-end' : 'justify-start'].join(' ')}>
                            <div className={[
                              'max-w-[85%] rounded-xl px-3 py-2 text-xs',
                              message.role === 'user'
                                ? 'rounded-br-sm bg-blue-600 text-white'
                                : 'rounded-bl-sm bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200'
                            ].join(' ')}>
                              {message.role === 'assistant' ? (
                                <div>
                                  <div className="prose prose-sm max-w-none prose-h1:mb-3 prose-h1:mt-2 prose-h1:text-base prose-h2:mb-2 prose-h2:mt-3 prose-h2:text-sm prose-li:my-0 prose-p:my-2 dark:prose-invert">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
                                      {linkify(normalizeAIResponseMarkdown(message.content))}
                                    </ReactMarkdown>
                                  </div>
                                  <ResearchAuditTrace
                                    trace={message.researchTrace}
                                    variant="compact"
                                    onCompareCurrent={() => window.api.researchEvidence.compareSnapshot({
                                      sourceKind: 'discussion_message',
                                      sessionId: detail.id,
                                      messageIndex: index,
                                    })}
                                    onDiscussChanges={() => startEvidenceDiscussion({
                                      source: {
                                        sourceKind: 'discussion_message',
                                        sessionId: detail.id,
                                        messageIndex: index,
                                      },
                                      returnTarget: {
                                        tab: 'ai-analysis',
                                        subTab: 'records',
                                        entityId: String(detail.id),
                                        stateKey: 'research-discussion',
                                        scrollTop: scrollRef.current?.scrollTop,
                                      },
                                    })}
                                  />
                                  <AssistantWebSearchTrace trace={message.webSearchTrace} />
                                </div>
                              ) : <span className="whitespace-pre-wrap">{message.content}</span>}
                            </div>
                          </div>
                        ))}
                        {sendingFollowUp && <div className="text-xs text-slate-400">思考中...</div>}
                      </div>
                    ) : (
                      <div className="mt-4 rounded-lg bg-slate-50 px-3 py-8 text-center text-sm text-slate-400 dark:bg-slate-950/60">{detail.discussion ? '输入问题开始讨论' : '暂无追问记录'}</div>
                    )}
                  </div>
                  {detail.discussion && (
                    <ResearchDiscussionChangePanel
                      discussion={detail.discussion}
                      messageCount={detail.messages?.length ?? 0}
                      onChanged={async () => {
                        const latest = await window.api.ai.getSession(detail.id)
                        if (latest) setDetail(latest)
                        await loadAISessions()
                      }}
                    />
                  )}
                </section>
              )}
            </div>

            {detail.discussion && (
              <ResearchAgentPanel
                sessionId={detail.id}
                draftQuestion={followUpInput}
                onCompleted={refreshAfterResearchAgent}
              />
            )}

            <div className="flex-shrink-0 border-t border-slate-200 bg-white px-5 py-3 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex gap-2">
                <textarea
                  ref={inputRef}
                  value={followUpInput}
                  onChange={(event) => {
                    setFollowUpInput(event.target.value)
                    if (detail.discussion) setResearchDiscussionDraft(detail.id, event.target.value)
                  }}
                  onKeyDown={handleInputKeyDown}
                  disabled={sendingFollowUp}
                  placeholder={detail.discussion ? '继续讨论…' : '继续追问... (Enter 发送, Shift+Enter 换行)'}
                  rows={2}
                  className="min-h-[52px] flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs outline-none transition focus:border-blue-300 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950"
                />
                <button
                  onClick={handleFollowUp}
                  disabled={!followUpInput.trim() || sendingFollowUp}
                  className="h-[52px] flex-shrink-0 rounded-lg bg-blue-600 px-4 text-xs text-white transition-colors hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-700"
                >
                  发送
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">选择左侧记录查看详情</div>
        )}
      </main>

      {!detail?.discussion && <aside className="hidden w-80 flex-shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 xl:flex">
        <div className="border-b border-slate-200 px-4 py-4 dark:border-slate-800">
          <div className="text-sm font-semibold">研判侧栏</div>
          <div className="mt-1 text-xs text-slate-500">基于现有会话文本派生, 不代表交易指令</div>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs">
          <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <div className="font-medium text-slate-700 dark:text-slate-200">模型与来源</div>
            <div className="mt-3 space-y-2 text-slate-500">
              <div className="flex justify-between gap-3"><span>模型</span><span className="truncate text-slate-700 dark:text-slate-200">{detail ? `${detail.provider} / ${detail.model}` : '--'}</span></div>
              <div className="flex justify-between"><span>文章</span><span>{detail?.articleUrls.length ?? 0} 篇</span></div>
              <div className="flex justify-between"><span>追问</span><span>{detail?.messages?.length ?? 0} 条</span></div>
              <div className="flex justify-between"><span>状态</span><span>{insight.statusLabel}</span></div>
              <div className="flex justify-between"><span>可信度</span><span>{formatConfidence(insight.confidence)}</span></div>
              <div className="flex justify-between gap-3"><span>主线</span><span className="truncate text-slate-700 dark:text-slate-200">{insight.primaryTheme ?? insight.matchChainName ?? '--'}</span></div>
            </div>
          </section>

          <section data-testid="ai-candidate-list" className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-slate-700 dark:text-slate-200">候选股票</div>
              <span className="text-slate-400">{knownCodes.length}</span>
            </div>
            <div className="mt-3 space-y-2">
              {insight.candidateStocks.length > 0 ? insight.candidateStocks.map((stock) => {
                const direction = candidateDirectionMeta[stock.direction]
                const isPortfolio = portfolioByCode.has(stockKey(stock.code))
                return (
                  <button
                    key={stock.code}
                    type="button"
                    data-testid={`ai-candidate-${stock.code}`}
                    onClick={() => navigateToStock(stock.code, stock.name ?? portfolioByCode.get(stockKey(stock.code)))}
                    className="block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-slate-700 transition-colors hover:border-blue-300 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200 dark:hover:border-blue-700 dark:hover:bg-slate-800"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 font-medium">
                        <span className="block truncate">{stock.name ?? portfolioByCode.get(stockKey(stock.code)) ?? '名称待补全'}</span>
                        <span className="mt-0.5 block text-[10px] font-normal text-slate-400">{stock.code}</span>
                      </span>
                      {stock.confidence > 0 && <span className="text-[10px] text-slate-400">{formatConfidence(stock.confidence)}</span>}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${direction.className}`}>{direction.label}</span>
                      <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">{candidateEvidenceLabel[stock.evidenceLevel]}</span>
                      {isPortfolio && <span className="rounded border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-300">我的持仓</span>}
                    </div>
                    {stock.reason && <div className="mt-2 line-clamp-3 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{stock.reason}</div>}
                  </button>
                )
              }) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                  <div className="font-medium">尚无A股候选</div>
                  <button type="button" onClick={() => { void handleRecoverCandidates() }} disabled={recoveringCandidates} className="mt-2 min-h-8 rounded border border-amber-300 bg-white px-2 py-1.5 text-[11px] font-semibold hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/40">
                    {recoveringCandidates ? '正在映射...' : '重新映射A股标的'}
                  </button>
                </div>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <div className="font-medium text-slate-700 dark:text-slate-200">验证清单</div>
            <ol className="mt-3 space-y-2 text-slate-500">
              {insight.verificationItems.map((item, index) => (
                <li key={item} className="flex gap-2">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] text-slate-500 dark:bg-slate-800">{index + 1}</span>
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
            <div className="font-medium text-slate-700 dark:text-slate-200">研判动作</div>
            <div className="mt-3 space-y-2">
              <button
                onClick={openIndustryAnalysis}
                disabled={!detail?.response}
                className="w-full rounded-lg bg-teal-600 px-3 py-2 text-left text-white transition-colors hover:bg-teal-700 disabled:bg-slate-300 dark:disabled:bg-slate-700"
                title={insight.matchChainName ? `自动匹配：${insight.matchChainName}` : '产业分析'}
              >
                产业分析{insight.matchChainName ? ` · ${insight.matchChainName}` : ''}
              </button>
              <button
                onClick={handleTriggerRound2}
                disabled={!detail || !hasStockCodes(detail.response) || triggeringRound2}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {triggeringRound2 ? '正在读取行情并复核...' : detail?.responseRound2 ? '重新用近期行情复核' : '用近期真实行情复核'}
              </button>
              {!hasStockCodes(detail?.response ?? null) && (
                <button
                  type="button"
                  onClick={() => { void handleRecoverCandidates() }}
                  disabled={!detail || recoveringCandidates}
                  className="w-full rounded-lg border border-amber-300 px-3 py-2 text-left font-medium text-amber-800 transition-colors hover:bg-amber-50 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-950/30"
                >
                  {recoveringCandidates ? 'A股标的映射中...' : '重新映射A股标的'}
                </button>
              )}
              <button
                onClick={() => handleGenerateStructuredResult(true)}
                disabled={!detail || generatingStructured || !detail.response}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {generatingStructured ? '结构化重建中...' : '重建结构化研判'}
              </button>
              <button
                onClick={() => inputRef.current?.focus()}
                disabled={!detail}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                继续追问
              </button>
            </div>
          </section>
        </div>
      </aside>}

      <IndustryAnalysisDrawer
        open={showIndustryAnalysis}
        onClose={() => setShowIndustryAnalysis(false)}
        text={industryAnalysisText}
        defaultChainId={industryChainId}
      />
      <NewResearchDiscussionDialog
        open={newDiscussionOpen}
        submitting={startingDiscussion}
        error={startDiscussionError}
        onClose={() => setNewDiscussionOpen(false)}
        onSubmit={(value) => { void createManualDiscussion(value) }}
      />
      <AppConfirmDialog
        key={deleteDialog?.kind ?? 'closed'}
        open={deleteDialog != null}
        title={deleteDialog?.kind === 'all'
          ? '清除AI分析记录'
          : deleteDialog?.kind === 'all-protected'
            ? '继续清除研究讨论'
            : deleteDialog?.session.discussion
              ? '删除研究讨论'
              : '删除分析记录'}
        message={deleteDialog?.kind === 'all'
          ? '普通分析记录将被永久删除。研究讨论会保留，并在需要时单独向你确认。'
          : deleteDialog?.kind === 'all-protected'
            ? `另有 ${deleteDialog.count} 条研究讨论。删除后，尚未处理的研究变更包会失效。`
            : deleteDialog?.session.discussion
              ? '这条讨论将从研判记录中移除，尚未处理的研究变更包会随之失效。'
              : '这条AI分析记录及其追问内容将被永久删除。'}
        tone="danger"
        confirmLabel={deleteDialog?.kind === 'all-protected' ? '继续清除' : deleteDialog?.kind === 'all' ? '清除记录' : '确认删除'}
        busy={deleting || deletingId != null}
        error={deleteError}
        testId="ai-analysis-delete-dialog"
        onCancel={() => {
          setDeleteDialog(null)
          setDeleteError(null)
        }}
        onConfirm={() => { void confirmDelete() }}
      >
        {deleteDialog?.kind === 'all-protected' && (
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">已写入产业研究的内容不会被回退或删除。</p>
        )}
        {deleteDialog?.kind === 'session' && (
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-slate-500 dark:text-slate-400">记录</dt>
            <dd className="min-w-0 truncate font-medium text-slate-900 dark:text-slate-100">
              {deleteDialog.session.discussion?.origin.title || `${deleteDialog.session.provider} / ${deleteDialog.session.model}`}
            </dd>
            <dt className="text-slate-500 dark:text-slate-400">时间</dt>
            <dd className="font-mono tabular-nums text-slate-700 dark:text-slate-200">{formatTime(deleteDialog.session.createdAt)}</dd>
            {deleteDialog.session.discussion && (
              <>
                <dt className="text-slate-500 dark:text-slate-400">研究结果</dt>
                <dd className="text-slate-700 dark:text-slate-200">已写入产业研究的内容保持不变</dd>
              </>
            )}
          </dl>
        )}
      </AppConfirmDialog>
    </div>
  )
}
