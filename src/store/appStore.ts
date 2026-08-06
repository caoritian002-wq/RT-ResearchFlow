import { create } from 'zustand'
import type { Briefing, BriefingListOptions, BriefingSourceStat, DailyArchiveRow, Source, AppSettingsRow, DecisionCenterFiltersPreference, ImpactRating, PublicationTimeScope, ScanStatus } from '../../electron/main/database/types'

interface MarketSnapshot {
  updatedAt: string
  industries: Array<{
    name: string
    code?: string
    totalMarketCap: number
    weightedChange: number
    stocks: Array<{ code: string; name: string; price: number; change: number; marketCap: number }>
    subIndustries?: Array<{ code: string; name: string; price: number; change: number; marketCap: number }>
  }>
}

interface HeatmapHistoryEntry {
  snapshot: MarketSnapshot
  fetchedAt: number
}

const HEATMAP_HISTORY_MAX = 20
// FR-102: 动量窗口由 settings.momentumWindowMinutes 动态决定，此处不再需要常量

/** FR-115: 行业云图数据源类型 */
export type HeatmapProvider = 'sina' | 'eastmoney' | 'tushare'

/** FR-115: 返回今日北京时间的日期部分，YYYY-MM-DD */
function getTodayBjDate(): string {
  const now = new Date()
  const bjOffset = 8 * 60
  const bjTime = new Date(now.getTime() + (bjOffset + now.getTimezoneOffset()) * 60_000)
  const y = bjTime.getFullYear()
  const m = String(bjTime.getMonth() + 1).padStart(2, '0')
  const d = String(bjTime.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** FR-104: 今日北京时间日期作为 localStorage key 的一部分（FR-115 升级为按 provider 分槽，见 getProviderCacheKey） */

/** FR-115: 为指定 provider 返回今日 localStorage key，格式 'heatmapCache_{provider}_{YYYY-MM-DD}' */
function getProviderCacheKey(provider: HeatmapProvider, date: string): string {
  return `heatmapCache_${provider}_${date}`
}

export type Tab = 'feed' | 'sources' | 'settings' | 'ai-config' | 'ai-analysis' | 'datasource' | 'stock-chart' | 'market-heatmap' | 'industry-heatmap' | 'short-term-strategy' | 'trend-watcher' | 'decision-center'
export type AIAnalysisSubTab = 'records' | 'deepResearch' | 'industryResearch'

export interface ResearchDiscussionReturnTarget {
  tab: Tab
  subTab?: string
  entityId?: string
  stateKey?: string
  scrollTop?: number
}

export interface StockNavigationContext {
  source: 'decision-signal'
  code: string
  name?: string | null
  signalId: number
  sourceModule: string
  strategyKey: string
  signalType: 'ALERT' | 'OPPORTUNITY' | 'RISK' | 'INFO'
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  priority: number
  score?: number | null
  confidence?: number | null
  title: string
  summary?: string | null
  status?: string
  signalTime: number
  occurrenceCount?: number | null
  reasonJson?: string | null
  sourceRefJson?: string | null
}

export interface DecisionCenterRefreshState {
  version: number
  reason: 'signal-updated' | 'portfolio-updated'
}

export interface FirstPortfolioJourneyState {
  step: 'select-stock' | 'complete-holding'
  stockCode: string | null
  stockName: string | null
}

export type DecisionCenterViewMode = 'portfolio' | 'market'

export interface DecisionCenterFiltersState extends DecisionCenterFiltersPreference {
  /** FR-231: 组合模式默认; 旧 localStorage 无该字段时视为 portfolio */
  viewMode: DecisionCenterViewMode
}

const DECISION_CENTER_FILTERS_STORAGE_KEY = 'decisionCenterFilters'
const DEFAULT_DECISION_CENTER_FILTERS: DecisionCenterFiltersState = {
  status: 'active',
  type: 'all',
  source: 'all',
  portfolioOnly: true,
  minPriority: 1,
  viewMode: 'portfolio',
}

function clampDecisionPriority(value: unknown): number {
  const priority = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(priority)) return DEFAULT_DECISION_CENTER_FILTERS.minPriority
  return Math.max(1, Math.min(5, Math.round(priority)))
}

function normalizeDecisionCenterViewMode(value: unknown): DecisionCenterViewMode {
  return value === 'market' ? 'market' : 'portfolio'
}

function normalizeDecisionCenterFilters(value: unknown): DecisionCenterFiltersState {
  const parsed = value && typeof value === 'object'
    ? value as Partial<DecisionCenterFiltersState> & { viewMode?: unknown }
    : {}
  const viewMode = Object.prototype.hasOwnProperty.call(parsed, 'viewMode')
    ? normalizeDecisionCenterViewMode(parsed.viewMode)
    : 'portfolio'
  return {
    status: typeof parsed.status === 'string' ? parsed.status : DEFAULT_DECISION_CENTER_FILTERS.status,
    type: typeof parsed.type === 'string' ? parsed.type : DEFAULT_DECISION_CENTER_FILTERS.type,
    source: typeof parsed.source === 'string' ? parsed.source : DEFAULT_DECISION_CENTER_FILTERS.source,
    portfolioOnly: viewMode === 'portfolio' ? true : parsed.portfolioOnly === true,
    minPriority: clampDecisionPriority(parsed.minPriority),
    viewMode,
  }
}

function readDecisionCenterFiltersFromLocalStorage(): DecisionCenterFiltersState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(DECISION_CENTER_FILTERS_STORAGE_KEY)
    return raw ? normalizeDecisionCenterFilters(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function readDecisionCenterFilters(): DecisionCenterFiltersState {
  return readDecisionCenterFiltersFromLocalStorage() ?? { ...DEFAULT_DECISION_CENTER_FILTERS }
}

function saveDecisionCenterFilters(filters: DecisionCenterFiltersState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DECISION_CENTER_FILTERS_STORAGE_KEY, JSON.stringify(filters))
  } catch {
    // localStorage 不可用时仅保留当前会话状态。
  }
}

function persistDecisionCenterFilters(filters: DecisionCenterFiltersState): void {
  if (typeof window === 'undefined') return
  const settingsApi = window.api?.settings
  if (!settingsApi || typeof settingsApi.setDecisionCenterFilters !== 'function') return
  void settingsApi.setDecisionCenterFilters(filters).catch((error) => {
    console.error('[DecisionCenter] 持久化筛选偏好失败', error)
  })
}

export interface DecisionSignalSummaryState {
  totalToday: number
  unreadCount: number
  highPriorityUnreadCount: number
  watchingCount: number
  byType: Record<string, number>
  bySource: Record<string, number>
  topSignals: unknown[]
}

export type ShortTermSubTab =
  | 'morningAuction'
  | 'closingHalfHour'
  | 'limitBoardMonitor'
  | 'secondBoardLeader'
  | 'firstYinDip'
  | 'dipBuyRadar'
  | 'strategyLab'
  | 'personalScreener'
  | 'chipMonitor'
  | 'conditionBlocks'
  | 'strategyBacktest'

export interface ScanProgressRow {
  sourceId: number
  sourceName: string
  url: string
  status: 'PENDING' | 'SCANNING' | 'SUCCESS' | 'FAILED'
  newCount: number
  error?: string
}

export interface AISessionSummary {
  id: number
  createdAt: string
  provider: string
  model: string
  articleCount: number
  isError: boolean
  hasRound2?: boolean
  hasStructuredResult?: boolean
  structuredStatus?: 'completed' | 'parse_failed' | null
  discussion?: {
    sessionId: number
    status: string
    origin: { type: string; id: string | null; title: string; available: boolean }
    projectTitle: string | null
  } | null
}

export interface AIArticleCandidate {
  id: number
  title: string
  originalUrl: string
  impactRating: string
  publishedAt: number | null
  isExpired: boolean
}

export interface AIPendingAnalysis {
  scanRunId: number | null
  articles: AIArticleCandidate[]
}

export interface AIProgressState {
  step: 'fetching' | 'calling' | 'callingRound1' | 'parsingStocks' | 'recoveringCandidates' | 'fetchingPrices' | 'callingRound2' | 'saving' | 'done' | 'error'
  current?: number
  total?: number
  usages?: {
    round1?: AIProgressUsage
    candidateRecovery?: AIProgressUsage
    round2?: AIProgressUsage
  }
}

export interface AIProgressUsage {
  provider: string
  model: string
  maxTokens?: number | null
  finishReason?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
}

interface AppState {
  // Briefings feed
  briefings: Briefing[]
  totalCount: number
  unreadCount: number
  briefingSourceStats: BriefingSourceStat[]
  isLoadingBriefings: boolean

  // Filters
  selectedDate: string | null
  selectedRating: ImpactRating | null
  selectedSourceId: number | null
  publicationTimeScope: PublicationTimeScope
  searchQuery: string

  // Scan status
  scanStatus: ScanStatus | null
  isScanning: boolean

  // Archive
  archiveDates: DailyArchiveRow[]

  // Sources
  sources: Source[]

  // Settings
  settings: AppSettingsRow | null

  // Catch-up status
  catchUpMessage: string | null

  // Selected briefing for detail view
  selectedBriefingId: number | null
  briefingDeepLinkId: number | null

  // Pagination
  currentPage: number

  // Scan progress modal
  scanProgressModal: { isOpen: boolean; rows: ScanProgressRow[] }

  // AI analysis
  aiSessions: AISessionSummary[]
  aiPendingAnalysis: AIPendingAnalysis | null
  isAnalyzing: boolean
  aiHasApiKey: boolean
  aiProgress: AIProgressState | null

  // Global tab navigation
  activeTab: Tab
  setActiveTab: (tab: Tab) => void
  aiAnalysisSubTab: AIAnalysisSubTab
  pendingIndustryResearchProjectId: string | null
  pendingResearchDiscussionSessionId: number | null
  pendingResearchDiscussionReturnTarget: ResearchDiscussionReturnTarget | null
  researchDiscussionDrafts: Record<number, string>
  setAIAnalysisSubTab: (subTab: AIAnalysisSubTab) => void
  navigateToIndustryResearch: (projectId?: string | null) => void
  clearPendingIndustryResearchProject: () => void
  navigateToResearchDiscussion: (sessionId: number, initialDraft?: string | null) => void
  clearPendingResearchDiscussion: () => void
  setResearchDiscussionDraft: (sessionId: number, draft: string) => void
  clearResearchDiscussionDraft: (sessionId: number) => void
  returnFromResearchDiscussion: (target: ResearchDiscussionReturnTarget) => void
  clearResearchDiscussionReturnTarget: () => void

  // FR-165: 今日决策看板摘要与顶部红点
  decisionSignalSummary: DecisionSignalSummaryState | null
  decisionUnreadHighPriorityCount: number
  loadDecisionSignalSummary: () => Promise<void>
  initDecisionCenterFilters: () => Promise<void>
  decisionCenterFilters: DecisionCenterFiltersState
  setDecisionCenterFilters: (filter: Partial<DecisionCenterFiltersState>) => void
  premarketScenarioOpenRequest: number
  openPremarketScenario: () => void

  // FR-092: Cross-tab stock navigation
  // FR-107: pendingDisplay 绑定 code，selectedItem 优先使用此处传入的权威信息
  pendingStockCode: string | null
  pendingDisplay: { code: string; name: string } | null
  pendingStockContext: StockNavigationContext | null
  decisionCenterRefresh: DecisionCenterRefreshState | null
  firstPortfolioJourney: FirstPortfolioJourneyState | null
  navigateToStock: (code: string, name?: string, context?: StockNavigationContext | null) => void
  clearPendingStockCode: () => void
  clearPendingStockContext: () => void
  startFirstPortfolioJourney: () => void
  advanceFirstPortfolioJourney: (code: string, name?: string | null) => void
  finishFirstPortfolioJourney: () => void
  clearFirstPortfolioJourney: () => void

  // Theme
  theme: 'light' | 'dark'
  toggleTheme: () => void
  initTheme: () => Promise<void>

  // FR-124: 短线策略子页签持久化
  shortTermActiveSubTab: ShortTermSubTab
  setShortTermActiveSubTab: (subTab: ShortTermSubTab) => Promise<void>
  initShortTermActiveSubTab: () => Promise<void>

  // FR-099/FR-100/FR-115: 行业云图全局状态
  heatmapSnapshot: MarketSnapshot | null
  heatmapLoading: boolean
  heatmapError: string
  heatmapPollingStarted: boolean
  heatmapHistory: HeatmapHistoryEntry[]
  industryMomentum: Record<string, number>
  // FR-115: 双 provider 缓存
  heatmapSnapshotByProvider: Record<HeatmapProvider, MarketSnapshot | null>
  heatmapHistoryByProvider: Record<HeatmapProvider, HeatmapHistoryEntry[]>
  activeHeatmapProvider: HeatmapProvider
  fetchHeatmapSnapshot: () => Promise<void>
  initHeatmapPolling: () => void
  setHeatmapProvider: (provider: HeatmapProvider) => Promise<void>

  // Actions
  loadBriefings: (options?: BriefingListOptions) => Promise<void>
  loadMoreBriefings: () => Promise<void>
  goToPage: (page: number) => Promise<void>
  markRead: (id: number) => Promise<void>
  markAllRead: () => Promise<void>
  setFilter: (filter: Partial<Pick<AppState, 'selectedDate' | 'selectedRating' | 'selectedSourceId' | 'publicationTimeScope' | 'searchQuery'>>) => void
  loadScanStatus: () => Promise<void>
  triggerManualScan: () => Promise<void>
  loadArchiveDates: () => Promise<void>
  loadSources: () => Promise<void>
  loadSettings: () => Promise<void>
  updateSettings: (data: Partial<Omit<AppSettingsRow, 'id'>>) => Promise<void>
  selectBriefing: (id: number | null) => void
  navigateToBriefing: (id: number) => void
  clearBriefingDeepLink: () => void
  loadAISessions: () => Promise<void>
  loadAIConfig: () => Promise<void>
  setAIPendingAnalysis: (data: AIPendingAnalysis | null) => void
  setAiProgress: (progress: AIProgressState | null) => void
  runAIAnalysis: (data: AIPendingAnalysis) => Promise<void>
  setCatchUpMessage: (msg: string | null) => void
  handleNewBriefings: () => void
  openScanProgressModal: (sources: Source[]) => void
  closeScanProgressModal: () => void
  updateSourceProgress: (row: Omit<ScanProgressRow, 'sourceName' | 'url'> & { sourceName: string; url: string }) => void
  requestDecisionCenterRefresh: (reason: DecisionCenterRefreshState['reason']) => void
}

const PAGE_SIZE = 100

export const useAppStore = create<AppState>((set, get) => ({
  briefings: [],
  totalCount: 0,
  unreadCount: 0,
  briefingSourceStats: [],
  isLoadingBriefings: false,
  selectedDate: null,
  selectedRating: null,
  selectedSourceId: null,
  publicationTimeScope: 'all',
  searchQuery: '',
  scanStatus: null,
  isScanning: false,
  archiveDates: [],
  sources: [],
  settings: null,
  catchUpMessage: null,
  selectedBriefingId: null,
  briefingDeepLinkId: null,
  currentPage: 1,
  scanProgressModal: { isOpen: false, rows: [] },
  aiSessions: [],
  aiPendingAnalysis: null,
  isAnalyzing: false,
  aiHasApiKey: false,
  aiProgress: null,
  activeTab: 'decision-center',
  aiAnalysisSubTab: 'records',
  pendingIndustryResearchProjectId: null,
  pendingResearchDiscussionSessionId: null,
  pendingResearchDiscussionReturnTarget: null,
  researchDiscussionDrafts: {},
  decisionSignalSummary: null,
  decisionUnreadHighPriorityCount: 0,
  decisionCenterFilters: readDecisionCenterFilters(),
  premarketScenarioOpenRequest: 0,
  pendingStockCode: null,
  pendingDisplay: null,
  pendingStockContext: null,
  decisionCenterRefresh: null,
  firstPortfolioJourney: null,
  theme: 'light',
  heatmapSnapshot: null,
  heatmapLoading: false,
  heatmapError: '',
  heatmapPollingStarted: false,
  heatmapHistory: [],
  industryMomentum: {},
  // FR-115: 双 provider 缓存初始状态（FR-132 扩展为三 provider）
  heatmapSnapshotByProvider: { sina: null, eastmoney: null, tushare: null },
  heatmapHistoryByProvider: { sina: [], eastmoney: [], tushare: [] },
  activeHeatmapProvider: 'sina',

  loadBriefings: async (options) => {
    set({ isLoadingBriefings: true, currentPage: 1 })
    try {
      const { selectedDate, selectedRating, selectedSourceId, publicationTimeScope, searchQuery } = get()
      const result = await window.api.briefings.list({
        date: options?.date ?? selectedDate ?? undefined,
        impactRating: options?.impactRating ?? selectedRating ?? undefined,
        sourceId: options?.sourceId ?? selectedSourceId ?? undefined,
        publicationTimeScope: options?.publicationTimeScope ?? publicationTimeScope,
        search: (options?.search ?? searchQuery) || undefined,
        limit: PAGE_SIZE,
        offset: 0
      })
      set({
        briefings: result.items,
        totalCount: result.total,
        unreadCount: result.unreadCount,
        briefingSourceStats: result.sourceStats,
        isLoadingBriefings: false
      })
    } catch (err) {
      console.error('Failed to load briefings:', err)
      set({ isLoadingBriefings: false })
    }
  },

  goToPage: async (page) => {
    const { selectedDate, selectedRating, selectedSourceId, publicationTimeScope, searchQuery, totalCount } = get()
    const totalPages = Math.ceil(totalCount / PAGE_SIZE)
    if (page < 1 || page > totalPages) return
    set({ isLoadingBriefings: true, currentPage: page, selectedBriefingId: null, briefingDeepLinkId: null })
    try {
      const result = await window.api.briefings.list({
        date: selectedDate ?? undefined,
        impactRating: selectedRating ?? undefined,
        sourceId: selectedSourceId ?? undefined,
        publicationTimeScope,
        search: searchQuery || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE
      })
      set({
        briefings: result.items,
        totalCount: result.total,
        unreadCount: result.unreadCount,
        briefingSourceStats: result.sourceStats,
        isLoadingBriefings: false
      })
    } catch {
      set({ isLoadingBriefings: false })
    }
  },

  loadMoreBriefings: async () => {
    const { briefings, totalCount, selectedDate, selectedRating, selectedSourceId, publicationTimeScope, searchQuery } = get()
    if (briefings.length >= totalCount) return

    set({ isLoadingBriefings: true })
    try {
      const result = await window.api.briefings.list({
        date: selectedDate ?? undefined,
        impactRating: selectedRating ?? undefined,
        sourceId: selectedSourceId ?? undefined,
        publicationTimeScope,
        search: searchQuery || undefined,
        limit: PAGE_SIZE,
        offset: briefings.length
      })
      set({
        briefings: [...briefings, ...result.items],
        briefingSourceStats: result.sourceStats,
        isLoadingBriefings: false
      })
    } catch {
      set({ isLoadingBriefings: false })
    }
  },

  markRead: async (id) => {
    await window.api.briefings.markRead(id)
    set((state) => ({
      briefings: state.briefings.map((b) =>
        b.id === id ? { ...b, isRead: true, readAt: Date.now() } : b
      ),
      unreadCount: Math.max(0, state.unreadCount - (state.briefings.some((b) => b.id === id && !b.isRead) ? 1 : 0))
    }))
    get().loadArchiveDates()
  },

  markAllRead: async () => {
    const { selectedDate, selectedRating, selectedSourceId, publicationTimeScope, searchQuery } = get()
    await window.api.briefings.markAllRead({
      date: selectedDate ?? undefined,
      impactRating: selectedRating ?? undefined,
      sourceId: selectedSourceId ?? undefined,
      publicationTimeScope,
      search: searchQuery || undefined,
    })
    set((state) => ({
      briefings: state.briefings.map((b) => ({ ...b, isRead: true })),
      unreadCount: 0
    }))
    await Promise.all([get().loadBriefings(), get().loadArchiveDates()])
  },

  setFilter: (filter) => {
    set({ ...filter, selectedBriefingId: null, briefingDeepLinkId: null })
    get().loadBriefings()
  },

  loadScanStatus: async () => {
    const status = await window.api.scan.getStatus()
    set({ scanStatus: status, isScanning: status.isScanning })
  },

  triggerManualScan: async () => {
    // Open modal with current enabled sources as PENDING rows
    get().openScanProgressModal(get().sources)
    set({ isScanning: true })
    // Fire-and-forget: progress tracked via push events
    window.api.scan.triggerManual()
      .catch((err) => console.error('Manual scan failed:', err))
      .finally(() => {
        set({ isScanning: false })
        get().loadScanStatus()
        get().loadBriefings()
        get().loadArchiveDates()
      })
  },

  loadArchiveDates: async () => {
    const dates = await window.api.archive.listDates(90)
    set({ archiveDates: dates })
  },

  loadSources: async () => {
    const sources = await window.api.sources.list()
    set({ sources })
  },

  loadSettings: async () => {
    const settings = await window.api.settings.get()
    set({ settings })
  },

  updateSettings: async (data) => {
    const updated = await window.api.settings.update(data)
    set({ settings: updated })
  },

  selectBriefing: (id) => {
    set({ selectedBriefingId: id, briefingDeepLinkId: null })
    if (id !== null) {
      void get().markRead(id)
    }
  },

  navigateToBriefing: (id) => {
    if (!Number.isSafeInteger(id) || id <= 0) return
    set({
      activeTab: 'feed',
      selectedBriefingId: id,
      briefingDeepLinkId: id,
      selectedDate: null,
      selectedRating: null,
      selectedSourceId: null,
      publicationTimeScope: 'all',
      searchQuery: '',
    })
    void get().loadBriefings()
    void get().markRead(id)
  },

  clearBriefingDeepLink: () => set({ briefingDeepLinkId: null }),

  setActiveTab: (tab) => set({ activeTab: tab }),
  openPremarketScenario: () => set({
    activeTab: 'decision-center',
    premarketScenarioOpenRequest: Date.now(),
  }),
  setAIAnalysisSubTab: (subTab) => set({ aiAnalysisSubTab: subTab }),
  navigateToIndustryResearch: (projectId) => set({
    activeTab: 'ai-analysis',
    aiAnalysisSubTab: 'industryResearch',
    pendingIndustryResearchProjectId: projectId ?? null,
    pendingResearchDiscussionSessionId: null,
  }),
  clearPendingIndustryResearchProject: () => set({ pendingIndustryResearchProjectId: null }),
  navigateToResearchDiscussion: (sessionId, initialDraft) => set((state) => ({
    activeTab: 'ai-analysis',
    aiAnalysisSubTab: 'records',
    pendingResearchDiscussionSessionId: sessionId,
    pendingIndustryResearchProjectId: null,
    researchDiscussionDrafts: initialDraft?.trim() && !state.researchDiscussionDrafts[sessionId]
      ? { ...state.researchDiscussionDrafts, [sessionId]: initialDraft }
      : state.researchDiscussionDrafts,
  })),
  clearPendingResearchDiscussion: () => set({ pendingResearchDiscussionSessionId: null }),
  setResearchDiscussionDraft: (sessionId, draft) => set((state) => ({ researchDiscussionDrafts: { ...state.researchDiscussionDrafts, [sessionId]: draft } })),
  clearResearchDiscussionDraft: (sessionId) => set((state) => {
    const next = { ...state.researchDiscussionDrafts }
    delete next[sessionId]
    return { researchDiscussionDrafts: next }
  }),
  returnFromResearchDiscussion: (target) => {
    if (
      target.tab === 'ai-analysis'
      && target.subTab === 'records'
      && target.stateKey === 'research-discussion'
      && target.entityId
      && /^\d+$/.test(target.entityId)
    ) {
      set({
        activeTab: 'ai-analysis',
        aiAnalysisSubTab: 'records',
        pendingResearchDiscussionSessionId: Number(target.entityId),
        pendingIndustryResearchProjectId: null,
        pendingResearchDiscussionReturnTarget: target,
      })
      return
    }
    if (target.tab === 'ai-analysis' && target.subTab === 'deepResearch') {
      set({
        activeTab: 'ai-analysis',
        aiAnalysisSubTab: 'deepResearch',
        pendingIndustryResearchProjectId: null,
        pendingResearchDiscussionSessionId: null,
        pendingResearchDiscussionReturnTarget: target,
      })
      return
    }
    if (target.tab === 'ai-analysis' && target.subTab === 'industryResearch') {
      set({
        activeTab: 'ai-analysis',
        aiAnalysisSubTab: 'industryResearch',
        pendingIndustryResearchProjectId: target.entityId ?? null,
        pendingResearchDiscussionSessionId: null,
        pendingResearchDiscussionReturnTarget: target,
      })
      return
    }
    if (target.tab === 'feed' && target.entityId && /^\d+$/.test(target.entityId)) {
      set({
        activeTab: 'feed',
        selectedBriefingId: Number(target.entityId),
        pendingResearchDiscussionSessionId: null,
        pendingResearchDiscussionReturnTarget: target,
      })
      return
    }
    set({
      activeTab: target.tab,
      pendingResearchDiscussionSessionId: null,
      pendingResearchDiscussionReturnTarget: target,
    })
  },
  clearResearchDiscussionReturnTarget: () => set({ pendingResearchDiscussionReturnTarget: null }),
  loadDecisionSignalSummary: async () => {
    try {
      const res = await window.api.decision.getSignalSummary()
      if (res.ok && res.data) {
        set({
          decisionSignalSummary: res.data,
          decisionUnreadHighPriorityCount: res.data.highPriorityUnreadCount
        })
      }
    } catch {
      // 摘要加载失败不影响主导航
    }
  },
  initDecisionCenterFilters: async () => {
    const settingsApi = window.api?.settings
    if (!settingsApi || typeof settingsApi.getDecisionCenterFilters !== 'function') return
    const initial = get().decisionCenterFilters
    try {
      const persisted = await settingsApi.getDecisionCenterFilters()
      if (get().decisionCenterFilters !== initial) {
        persistDecisionCenterFilters(get().decisionCenterFilters)
        return
      }
      const next = persisted
        ? normalizeDecisionCenterFilters(persisted)
        : readDecisionCenterFiltersFromLocalStorage() ?? initial
      if (!persisted) await settingsApi.setDecisionCenterFilters(next)
      saveDecisionCenterFilters(next)
      set({ decisionCenterFilters: next })
    } catch (error) {
      console.error('[DecisionCenter] 读取持久筛选偏好失败', error)
    }
  },
  setDecisionCenterFilters: (filter) => {
    const current = get().decisionCenterFilters
    const nextViewMode = filter.viewMode == null
      ? current.viewMode
      : normalizeDecisionCenterViewMode(filter.viewMode)
    const next: DecisionCenterFiltersState = {
      ...current,
      ...filter,
      viewMode: nextViewMode,
      minPriority: filter.minPriority == null ? current.minPriority : clampDecisionPriority(filter.minPriority),
      // 切换视图时同步 portfolioOnly; 组合模式始终 true
      portfolioOnly: nextViewMode === 'portfolio'
        ? true
        : (filter.portfolioOnly == null ? (filter.viewMode != null ? false : current.portfolioOnly) : filter.portfolioOnly === true),
    }
    set({ decisionCenterFilters: next })
    saveDecisionCenterFilters(next)
    persistDecisionCenterFilters(next)
  },
  navigateToStock: (code, name, context) => {
    // 规范化为 6 位纯数字，与 regularStocks.stockCode 格式保持一致
    const normalized = code.includes('.') ? code.split('.')[0] : code
    set({
      activeTab: 'stock-chart',
      pendingStockCode: normalized,
      pendingDisplay: name ? { code: normalized, name } : null,
      pendingStockContext: context ? { ...context, code: normalized, name: name ?? context.name ?? null } : null
    })
  },
  clearPendingStockCode: () => set({ pendingStockCode: null }),
  clearPendingStockContext: () => set({ pendingStockContext: null }),
  startFirstPortfolioJourney: () => set({
    activeTab: 'stock-chart',
    firstPortfolioJourney: {
      step: 'select-stock',
      stockCode: null,
      stockName: null,
    },
  }),
  advanceFirstPortfolioJourney: (code, name) => {
    const journey = get().firstPortfolioJourney
    if (!journey) return
    const normalized = code.includes('.') ? code.split('.')[0] : code
    set({
      firstPortfolioJourney: {
        step: 'complete-holding',
        stockCode: normalized,
        stockName: name ?? null,
      },
    })
  },
  finishFirstPortfolioJourney: () => {
    const current = get().decisionCenterFilters
    const filters: DecisionCenterFiltersState = {
      ...current,
      status: 'active',
      portfolioOnly: true,
      viewMode: 'portfolio',
    }
    saveDecisionCenterFilters(filters)
    persistDecisionCenterFilters(filters)
    set({
      activeTab: 'decision-center',
      decisionCenterFilters: filters,
      decisionCenterRefresh: { version: Date.now(), reason: 'portfolio-updated' },
      firstPortfolioJourney: null,
      pendingStockCode: null,
      pendingDisplay: null,
      pendingStockContext: null,
    })
  },
  clearFirstPortfolioJourney: () => set({ firstPortfolioJourney: null }),
  requestDecisionCenterRefresh: (reason) => set({ decisionCenterRefresh: { version: Date.now(), reason } }),

  toggleTheme: () => {
    const next = get().theme === 'light' ? 'dark' : 'light'
    set({ theme: next })
    document.documentElement.classList.toggle('dark', next === 'dark')
    localStorage.setItem('theme', next)
    window.api.settings.setTheme(next)
  },

  initTheme: async () => {
    try {
      const theme = await window.api.settings.getTheme() as 'light' | 'dark'
      const valid = theme === 'dark' ? 'dark' : 'light'
      set({ theme: valid })
      document.documentElement.classList.toggle('dark', valid === 'dark')
      localStorage.setItem('theme', valid)
    } catch { /* fallback to light */ }
  },

  // FR-124: 短线策略子页签初始化与切换
  shortTermActiveSubTab: 'morningAuction',
  setShortTermActiveSubTab: async (subTab) => {
    set({ shortTermActiveSubTab: subTab })
    try {
      await window.api.shortTerm.setActiveSubTab(subTab)
    } catch { /* persist failure non-fatal */ }
  },
  initShortTermActiveSubTab: async () => {
    try {
      const res = await window.api.shortTerm.getActiveSubTab()
      if (res.ok) set({ shortTermActiveSubTab: res.subTab })
    } catch { /* keep default */ }
  },

  fetchHeatmapSnapshot: async () => {
    if (get().heatmapLoading) return
    // FR-115: 锁定本次请求的目标 provider，确保切换过程中进行中的请求不会写错槽位
    const targetProvider = get().activeHeatmapProvider
    set({ heatmapLoading: true, heatmapError: '' })
    try {
      const res = await window.api.marketHeatmap.getSnapshot()
      if (res.ok) {
        const now = Date.now()
        const snapshot = res.data as MarketSnapshot
        // FR-115: 基于该 provider 自己的历史队列追加
        const prevHistory = get().heatmapHistoryByProvider[targetProvider] ?? []
        const newHistory: HeatmapHistoryEntry[] = [
          ...prevHistory,
          { snapshot, fetchedAt: now }
        ].slice(-HEATMAP_HISTORY_MAX)

        // 计算动量：找最接近 N 分钟前的最早一条历史记录
        const windowMs = Math.max(10_000, (get().settings?.momentumWindowMinutes ?? 3) * 60_000 - 10_000)
        const cutoff = now - windowMs
        const baseline = newHistory.find(h => h.fetchedAt <= cutoff)
        let momentum: Record<string, number> = {}
        if (baseline) {
          // FR-120: 同时纳入 L1 加权涨跌 + L2 子行业涨跌（东财 provider 才有 subIndustries）
          const baseMap = new Map<string, number>()
          for (const i of baseline.snapshot.industries) {
            baseMap.set(i.name, i.weightedChange)
            for (const sub of i.subIndustries ?? []) baseMap.set(sub.name, sub.change)
          }
          for (const ind of snapshot.industries) {
            const base = baseMap.get(ind.name)
            if (base !== undefined) {
              momentum[ind.name] = parseFloat((ind.weightedChange - base).toFixed(3))
            }
            for (const sub of ind.subIndustries ?? []) {
              const subBase = baseMap.get(sub.name)
              if (subBase !== undefined) {
                momentum[sub.name] = parseFloat((sub.change - subBase).toFixed(3))
              }
            }
          }
        }

        // FR-115: 写入 byProvider 槽位（无论当前 active 是否仍是 targetProvider）
        const nextSnapshotMap = { ...get().heatmapSnapshotByProvider, [targetProvider]: snapshot }
        const nextHistoryMap = { ...get().heatmapHistoryByProvider, [targetProvider]: newHistory }

        // 仅当请求期间未发生切换时，同步派生写入顶层字段
        const stillActive = get().activeHeatmapProvider === targetProvider
        if (stillActive) {
          set({
            heatmapSnapshotByProvider: nextSnapshotMap,
            heatmapHistoryByProvider: nextHistoryMap,
            heatmapSnapshot: snapshot,
            heatmapHistory: newHistory,
            industryMomentum: momentum
          })
        } else {
          set({
            heatmapSnapshotByProvider: nextSnapshotMap,
            heatmapHistoryByProvider: nextHistoryMap
          })
        }

        // FR-104/FR-115: 写入 provider 维度的今日 localStorage 缓存，并清理所有非今日 key
        try {
          const today = getTodayBjDate()
          const todayKey = getProviderCacheKey(targetProvider, today)
          localStorage.setItem(todayKey, JSON.stringify(snapshot))
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i)
            if (!k || !k.startsWith('heatmapCache_')) continue
            // 保留两个 provider 的当日 key
            if (k === getProviderCacheKey('sina', today)) continue
            if (k === getProviderCacheKey('eastmoney', today)) continue
            if (k === getProviderCacheKey('tushare', today)) continue
            localStorage.removeItem(k)
          }
        } catch { /* 写入失败静默忽略 */ }
      } else {
        const msgMap: Record<string, string> = {
          UPSTREAM_TIMEOUT: res.message ?? '数据源接口超时，请稍后重试',
          UPSTREAM_ERROR: `数据获取失败：${res.message}`,
          EMPTY_DATA: '数据源返回空数据'
        }
        // FR-115: 仅在请求期间未切换 provider 时才写错误（否则错误属于另一个 provider，不打扰用户）
        if (get().activeHeatmapProvider === targetProvider) {
          set({ heatmapError: msgMap[res.code] ?? res.message })
        }
      }
    } catch (err) {
      if (get().activeHeatmapProvider === targetProvider) {
        set({ heatmapError: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      set({ heatmapLoading: false })
    }
  },

  initHeatmapPolling: () => {
    if (get().heatmapPollingStarted) return

    // FR-115: 启动时先读 DB 中的当前 active provider
    void (async () => {
      let provider: HeatmapProvider = 'sina'
      try {
        provider = await window.api.settings.getMarketHeatmapProvider()
      } catch { /* 失败保持默认 sina */ }

      // FR-104/FR-115/FR-132: 分别读取三个 provider 的今日 localStorage 缓存
      const today = getTodayBjDate()
      const snapMap: Record<HeatmapProvider, MarketSnapshot | null> = { sina: null, eastmoney: null, tushare: null }
      for (const p of ['sina', 'eastmoney', 'tushare'] as const) {
        try {
          const cached = localStorage.getItem(getProviderCacheKey(p, today))
          if (cached) {
            const parsed = JSON.parse(cached)
            if (parsed && Array.isArray(parsed.industries)) {
              snapMap[p] = parsed as MarketSnapshot
            }
          }
        } catch { /* 单个失败不影响另一个 */ }
      }

      // 派生顶层字段（基于当前 active provider 的槽位）
      const activeSnapshot = snapMap[provider]
      set({
        activeHeatmapProvider: provider,
        heatmapSnapshotByProvider: snapMap,
        heatmapSnapshot: activeSnapshot,
        heatmapPollingStarted: true
      })

      get().fetchHeatmapSnapshot()
    })()
  },

  setHeatmapProvider: async (provider) => {
    // 已是当前 provider 则跳过
    if (get().activeHeatmapProvider === provider) return

    // ① 持久化到 DB
    try {
      await window.api.settings.setMarketHeatmapProvider(provider)
    } catch { /* 持久化失败不阻塞 UI 切换 */ }

    // ② 从对应槽位恢复 snapshot + history
    const cachedSnapshot = get().heatmapSnapshotByProvider[provider]
    const cachedHistory = get().heatmapHistoryByProvider[provider] ?? []

    // ③ 基于槽位历史重算动量
    const windowMs = Math.max(10_000, (get().settings?.momentumWindowMinutes ?? 3) * 60_000 - 10_000)
    let momentum: Record<string, number> = {}
    if (cachedSnapshot && cachedHistory.length > 0) {
      const lastEntry = cachedHistory[cachedHistory.length - 1]
      const cutoff = lastEntry.fetchedAt - windowMs
      const baseline = cachedHistory.find(h => h.fetchedAt <= cutoff)
      if (baseline) {
        // FR-120: 同时纳入 L1 + L2 子行业
        const baseMap = new Map<string, number>()
        for (const i of baseline.snapshot.industries) {
          baseMap.set(i.name, i.weightedChange)
          for (const sub of i.subIndustries ?? []) baseMap.set(sub.name, sub.change)
        }
        for (const ind of cachedSnapshot.industries) {
          const base = baseMap.get(ind.name)
          if (base !== undefined) {
            momentum[ind.name] = parseFloat((ind.weightedChange - base).toFixed(3))
          }
          for (const sub of ind.subIndustries ?? []) {
            const subBase = baseMap.get(sub.name)
            if (subBase !== undefined) {
              momentum[sub.name] = parseFloat((sub.change - subBase).toFixed(3))
            }
          }
        }
      }
    }

    // ④ 瞬间切换：派生写入顶层字段（如槽位为空则展示「暂无数据」但不弹错）
    set({
      activeHeatmapProvider: provider,
      heatmapSnapshot: cachedSnapshot,
      heatmapHistory: cachedHistory,
      industryMomentum: momentum,
      heatmapError: ''
    })

    // ⑤ fire-and-forget 后台静默更新
    void get().fetchHeatmapSnapshot()
  },

  setCatchUpMessage: (msg) => set({ catchUpMessage: msg }),

  handleNewBriefings: () => {
    get().loadBriefings()
    get().loadArchiveDates()
    get().loadScanStatus()
  },

  openScanProgressModal: (sources) => {
    const rows: ScanProgressRow[] = sources
      .filter((s) => s.isEnabled)
      .map((s) => ({
        sourceId: s.id,
        sourceName: s.nameCN,
        url: s.feedUrl ?? s.url,
        status: 'PENDING',
        newCount: 0
      }))
    set({ scanProgressModal: { isOpen: true, rows } })
  },

  closeScanProgressModal: () => {
    set((state) => ({ scanProgressModal: { ...state.scanProgressModal, isOpen: false } }))
  },

  updateSourceProgress: (row) => {
    set((state) => ({
      scanProgressModal: {
        ...state.scanProgressModal,
        rows: state.scanProgressModal.rows.map((r) =>
          r.sourceId === row.sourceId
            ? { ...r, status: row.status, newCount: row.newCount, error: row.error }
            : r
        )
      }
    }))
  },

  loadAISessions: async () => {
    const result = await window.api.ai.listSessions()
    set({ aiSessions: result.items })
  },

  loadAIConfig: async () => {
    const config = await window.api.ai.getConfig()
    set({ aiHasApiKey: !!config.hasApiKey })
  },

  setAIPendingAnalysis: (data) => {
    set({ aiPendingAnalysis: data })
  },

  setAiProgress: (progress) => {
    set({ aiProgress: progress })
  },

  runAIAnalysis: async (data) => {
    set({ isAnalyzing: true, aiPendingAnalysis: null })
    try {
      await window.api.ai.analyze({ briefingIds: data.articles.map((a) => a.id), scanRunId: data.scanRunId })
      await get().loadAISessions()
    } finally {
      set({ isAnalyzing: false })
    }
  }
}))
