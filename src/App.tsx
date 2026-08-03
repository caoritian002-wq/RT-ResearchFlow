import { lazy, Suspense, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useAppStore } from './store/appStore'
import { isInTradingHours } from './utils/tradingHours'
import { FilterBar } from './components/FilterBar/FilterBar'
import { DateArchive } from './components/DateArchive/DateArchive'
import { BriefingFeed } from './components/BriefingFeed/BriefingFeed'
import { BriefingDetail } from './components/BriefingDetail/BriefingDetail'
import { ScanProgressModal } from './components/ScanProgressModal/ScanProgressModal'
import { MARKET_OVERVIEW_SUB_TABS, type MarketOverviewSubTab } from './components/MarketOverview/marketOverviewNavigation'
import { SHORT_TERM_SUB_TABS } from './components/ShortTermStrategy/shortTermNavigation'
import { TREND_WATCHER_SUB_TABS, type TrendWatcherSubTab } from './components/TrendWatcher/trendWatcherNavigation'
import { AIAnalysisConfirmDialog } from './components/AIAnalysisConfirmDialog/AIAnalysisConfirmDialog'
import { AIAnalysisProgressPanel } from './components/AIAnalysisProgressPanel/AIAnalysisProgressPanel'
import { ConfigDrawer, type ConfigDrawerTab } from './components/ConfigDrawer/ConfigDrawer'
import { MessageCenterDrawer } from './components/MessageCenter/MessageCenterDrawer'
import { AppTitleBar } from './components/AppWindow/AppTitleBar'
import { PrimaryNavigationIcon, type PrimaryNavigationIconName } from './components/AppWindow/PrimaryNavigationIcon'
import { formatBjTime, type MessageCenterItem } from './components/MessageCenter/messageCenterModel'
import { ColdStartGuide } from './components/Onboarding/ColdStartGuide'
import { buildOnboardingModel, type DiagnosticsHealthSnapshot } from './components/Onboarding/onboardingModel'
import { buildInitializationModel } from './components/Onboarding/initializationModel'
import {
  createInitialFlowState,
  INITIALIZATION_TASKS,
  shouldSkipInitializationTask,
  type InitializationFlowState,
  type InitializationTaskKey
} from './components/Onboarding/initializationTaskModel'
import type { AIPendingAnalysis, Tab } from './store/appStore'
import type { ShortTermSubTab } from './store/appStore'
import {
  buildFinancialCollectionProgress,
  buildResearchStageProgress,
  type ProjectFinancialCollectionView,
} from './components/IndustryResearch/industryResearchProgressModel'
import { AppConfirmDialog } from './components/shared/AppConfirmDialog'
import { AppToast, type AppToastTone } from './components/shared/AppToast'
import { subscribeAppToast } from './components/shared/appToastBus'

const AIAnalysis = lazy(() => import('./components/AIAnalysis/AIAnalysis').then((module) => ({ default: module.AIAnalysis })))
const DeepResearchWorkbench = lazy(() => import('./components/AIAnalysis/DeepResearchWorkbench').then((module) => ({ default: module.DeepResearchWorkbench })))
const IndustryResearch = lazy(() => import('./components/IndustryResearch/IndustryResearch').then((module) => ({ default: module.IndustryResearch })))
const StockChart = lazy(() => import('./components/StockChart/StockChart').then((module) => ({ default: module.StockChart })))
const MarketHeatmap = lazy(() => import('./components/MarketHeatmap/MarketHeatmap').then((module) => ({ default: module.MarketHeatmap })))
const MarketOverview = lazy(() => import('./components/MarketOverview/MarketOverview').then((module) => ({ default: module.MarketOverview })))
const ShortTermStrategy = lazy(() => import('./components/ShortTermStrategy/ShortTermStrategy').then((module) => ({ default: module.ShortTermStrategy })))
const TrendWatcher = lazy(() => import('./components/TrendWatcher/TrendWatcher').then((module) => ({ default: module.TrendWatcher })))
const DecisionCenter = lazy(() => import('./components/DecisionCenter/DecisionCenter').then((module) => ({ default: module.DecisionCenter })))

const ONBOARDING_DISMISSED_KEY = 'trade-watch:onboarding:v1:dismissed'
const NAVIGATION_EXPANDED_STORAGE_KEY = 'trade-watch:navigation:v1:expanded'

const CONFIG_TAB_MAP: Partial<Record<Tab, ConfigDrawerTab>> = {
  sources: 'sources',
  settings: 'settings',
  'ai-config': 'ai-config',
  datasource: 'datasource'
}

interface IndustryResearchBackgroundTask {
  projectId: string
  runId: string
  status: string
  stage: string
  progressCurrent: number
  progressTotal: number
  message: string
  updatedAt: number
  financialCollection?: ProjectFinancialCollectionView | null
}

interface IndustryResearchRunPollView {
  id: string
  projectId: string
  status: string
  currentStage: string
  progressCurrent: number
  progressTotal: number
  progressMessage: string
  updatedAt: number
  financialCollection?: ProjectFinancialCollectionView | null
}

function researchTaskLabel(task: IndustryResearchBackgroundTask): string {
  if (task.status === 'succeeded') return '产业研究已完成'
  if (task.status === 'failed') return '产业研究生成失败'
  if (task.status === 'cancelled') return '产业研究已取消'
  return task.message || '产业研究正在生成'
}

function isTerminalResearchTask(task: IndustryResearchBackgroundTask): boolean {
  return task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled'
}

function SidebarTooltip({ label, hidden = false }: { label: string; hidden?: boolean }) {
  if (hidden) return null
  return (
    <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-50 translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-sm border border-cyan-500/70 bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg shadow-slate-950/30 transition-[opacity,transform] duration-150 group-hover:translate-x-0 group-hover:opacity-100 dark:border-cyan-300/70 dark:bg-slate-900 dark:text-slate-100">
      <span aria-hidden="true" className="absolute -left-2 top-1/2 h-px w-2 -translate-y-1/2 bg-cyan-500 dark:bg-cyan-300" />
      {label}
    </span>
  )
}

function WorkbenchFallback() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center bg-white dark:bg-slate-950"
      role="status"
      aria-live="polite"
      aria-label="正在加载工作台"
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <span
          className="h-7 w-7 animate-spin rounded-full border-2 border-slate-200 border-t-cyan-600 motion-reduce:[animation-duration:1.8s] dark:border-slate-700 dark:border-t-cyan-300"
          aria-hidden="true"
        />
        <span className="text-sm font-medium text-slate-600 dark:text-slate-300">正在加载工作台...</span>
      </div>
    </div>
  )
}

type SecondaryNavItem = {
  key: string
  label: string
  current: boolean
  onSelect: () => void
}

const SECONDARY_NAV_TABS = new Set<Tab>(['trend-watcher', 'industry-heatmap', 'short-term-strategy', 'ai-analysis'])

function readMarketOverviewSubTab(): MarketOverviewSubTab {
  const saved = localStorage.getItem('marketOverviewSubTab')
  return saved === 'heatmap' || saved === 'sectorFlow' || saved === 'industry' ? saved : 'industry'
}

function readNavigationExpanded(): boolean {
  try {
    return localStorage.getItem(NAVIGATION_EXPANDED_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

function NavigationToggleIcon({ expanded }: { expanded: boolean }) {
  return (
    <span className="relative block h-5 w-5 shrink-0" aria-hidden="true">
      <span className="absolute inset-y-0 left-0 w-1.5 border border-current opacity-55" />
      <span className="absolute inset-y-0 left-2.5 right-0 border-y border-r border-current opacity-80" />
      <span
        className={`absolute left-[11px] top-1/2 h-1.5 w-1.5 -translate-y-1/2 border-b border-l border-current transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-45' : 'rotate-[225deg]'}`}
      />
    </span>
  )
}

function NavigationChevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mr-1 h-1.5 w-1.5 shrink-0 border-b border-r border-current transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-[225deg]' : 'rotate-45'}`}
    />
  )
}

export default function App() {
  const [configDrawerOpen, setConfigDrawerOpen] = useState(false)
  const [configDrawerTab, setConfigDrawerTab] = useState<ConfigDrawerTab>('settings')
  const [messageCenterOpen, setMessageCenterOpen] = useState(false)
  const [navigationExpanded, setNavigationExpanded] = useState(() => readNavigationExpanded())
  const [expandedNavTab, setExpandedNavTab] = useState<Tab | null>(null)
  const [navFlyoutTab, setNavFlyoutTab] = useState<Tab | null>(null)
  const [navFlyoutAnchorY, setNavFlyoutAnchorY] = useState<number | null>(null)
  const [marketOverviewSubTab, setMarketOverviewSubTab] = useState<MarketOverviewSubTab>(() => readMarketOverviewSubTab())
  const [trendWatcherSubTab, setTrendWatcherSubTab] = useState<TrendWatcherSubTab>('portfolio')
  const [onboardingSnapshot, setOnboardingSnapshot] = useState<DiagnosticsHealthSnapshot | null>(null)
  const [onboardingLoading, setOnboardingLoading] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1')
  const [initializationFlow, setInitializationFlow] = useState<InitializationFlowState>(() => createInitialFlowState())
  const [industryResearchTask, setIndustryResearchTask] = useState<IndustryResearchBackgroundTask | null>(null)
  const [startupBacktestSync, setStartupBacktestSync] = useState<{ stockCodes: string[] } | null>(null)
  const [startupBacktestSyncing, setStartupBacktestSyncing] = useState(false)
  const [startupBacktestError, setStartupBacktestError] = useState<string | null>(null)
  const [appToast, setAppToast] = useState<{ message: string; tone: AppToastTone } | null>(null)
  const industryResearchStageProgress = industryResearchTask
    ? buildResearchStageProgress({
        status: industryResearchTask.status,
        stage: industryResearchTask.stage,
        progressCurrent: industryResearchTask.progressCurrent,
        progressTotal: industryResearchTask.progressTotal,
        financialCollection: industryResearchTask.financialCollection,
      })
    : null
  const industryResearchFinancialProgress = industryResearchTask?.stage === 'companies'
    && industryResearchTask.financialCollection?.status === 'running'
    ? buildFinancialCollectionProgress(industryResearchTask.financialCollection)
    : null
  const {
    selectedBriefingId,
    briefings,
    catchUpMessage,
    unreadCount,
    scanStatus,
    isScanning,
    settings,
    loadBriefings,
    loadArchiveDates,
    loadSources,
    loadSettings,
    loadScanStatus,
    loadAIConfig,
    triggerManualScan,
    setCatchUpMessage,
    handleNewBriefings,
    updateSourceProgress,
    setAIPendingAnalysis,
    setAiProgress,
    activeTab,
    setActiveTab,
    theme,
    toggleTheme,
    initTheme,
    initShortTermActiveSubTab,
    initDecisionCenterFilters,
    loadDecisionSignalSummary,
    decisionUnreadHighPriorityCount,
    heatmapPollingStarted,
    initHeatmapPolling,
    fetchHeatmapSnapshot,
    shortTermActiveSubTab,
    setShortTermActiveSubTab,
    aiAnalysisSubTab,
    setAIAnalysisSubTab,
    clearPendingResearchDiscussion,
    navigateToIndustryResearch,
    openPremarketScenario
  } = useAppStore()
  const navShellRef = useRef<HTMLDivElement>(null)
  const highImpactCount = useMemo(
    () => briefings.filter(item => item.impactRating === 'CRITICAL' || item.impactRating === 'IMPORTANT').length,
    [briefings]
  )
  const feedPendingCount = useMemo(
    () => briefings.filter(item => !item.isRead || item.impactRating === 'CRITICAL' || item.impactRating === 'IMPORTANT').length,
    [briefings]
  )
  const feedSourceCount = useMemo(
    () => new Set(briefings.map(item => item.sourceName)).size,
    [briefings]
  )

  // Bootstrap: load initial data
  useEffect(() => {
    Promise.all([loadBriefings(), loadArchiveDates(), loadSources(), loadSettings(), loadScanStatus(), loadAIConfig(), initTheme(), initShortTermActiveSubTab(), initDecisionCenterFilters(), loadDecisionSignalSummary()])
    // Notify main process that UI is ready; triggers catch-up scan and scheduler (FR-001)
    window.api.notifyReady()
    const backtestApi = window.api.backtest as typeof window.api.backtest & {
      getStartupSyncRequirement?: () => Promise<{ required: boolean; stockCodes: string[] }>
    }
    if (typeof backtestApi.getStartupSyncRequirement === 'function') {
      void backtestApi.getStartupSyncRequirement().then((result) => {
        if (result.required && result.stockCodes.length > 0) setStartupBacktestSync({ stockCodes: result.stockCodes })
      }).catch((error) => {
        console.warn('[Backtest Startup] Failed to inspect intraday requirement:', error)
      })
    }
  }, [])

  useEffect(() => subscribeAppToast(setAppToast), [])

  useEffect(() => window.api.premarket.onOpenScenario(openPremarketScenario), [openPremarketScenario])

  async function handleStartupBacktestSync() {
    setStartupBacktestSyncing(true)
    setStartupBacktestError(null)
    try {
      const result = await window.api.backtest.syncIntraday()
      setStartupBacktestSync(null)
      setAppToast({
        message: `分时数据同步完成，已缓存 ${result.synced} 条记录，回测 ${result.backtested} 条预测。`,
        tone: 'success',
      })
    } catch (error) {
      setStartupBacktestError(error instanceof Error ? error.message : '分时数据同步失败，请检查网络或数据源配置。')
    } finally {
      setStartupBacktestSyncing(false)
    }
  }

  useEffect(() => {
    if (!industryResearchTask || isTerminalResearchTask(industryResearchTask)) return
    let disposed = false
    const refresh = async () => {
      const response = await window.api.industryResearch.getGenerationRun(
        industryResearchTask.projectId,
        industryResearchTask.runId,
      ) as { ok: boolean; data?: { run?: IndustryResearchRunPollView | null } }
      const run = response.ok ? response.data?.run : null
      if (disposed || !run || run.id !== industryResearchTask.runId) return
      setIndustryResearchTask((current) => current?.runId === run.id ? {
        projectId: run.projectId,
        runId: run.id,
        status: run.status,
        stage: run.currentStage,
        progressCurrent: run.progressCurrent,
        progressTotal: run.progressTotal,
        message: run.progressMessage,
        updatedAt: run.updatedAt,
        financialCollection: run.financialCollection ?? current.financialCollection,
      } : current)
    }
    const timer = window.setInterval(() => { void refresh() }, 12_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [industryResearchTask?.projectId, industryResearchTask?.runId, industryResearchTask?.status])

  useEffect(() => {
    const stop = window.api.industryResearch.onGenerationProgress?.((payload) => {
      setIndustryResearchTask({
        ...payload,
        financialCollection: payload.financialCollection as ProjectFinancialCollectionView | null | undefined,
      })
    })
    return () => { stop?.() }
  }, [])

  useEffect(() => {
    if (!industryResearchTask || !isTerminalResearchTask(industryResearchTask)) return
    const timer = window.setTimeout(() => {
      setIndustryResearchTask((current) => current?.runId === industryResearchTask.runId ? null : current)
    }, 10_000)
    return () => window.clearTimeout(timer)
  }, [industryResearchTask])

  useEffect(() => {
    const configTab = CONFIG_TAB_MAP[activeTab]
    if (!configTab) return
    setConfigDrawerTab(configTab)
    setConfigDrawerOpen(true)
    setActiveTab('decision-center')
  }, [activeTab, setActiveTab])

  useEffect(() => {
    if (!SECONDARY_NAV_TABS.has(activeTab)) setNavFlyoutTab(null)
  }, [activeTab])

  useEffect(() => {
    if (!navFlyoutTab) return
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      if (navShellRef.current?.contains(event.target as Node)) return
      setNavFlyoutTab(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavFlyoutTab(null)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [navFlyoutTab])

  const loadOnboardingHealth = async () => {
    setOnboardingLoading(true)
    try {
      const res = await window.api.diagnostics.getHealth()
      if (res.ok) {
        setOnboardingSnapshot(res.data)
      }
    } catch (err) {
      console.warn('[Onboarding] Failed to load diagnostics health', err)
    } finally {
      setOnboardingLoading(false)
    }
  }

  useEffect(() => {
    void loadOnboardingHealth()
  }, [])

  useEffect(() => {
    const off = window.api.diagnostics.onHistoricalDailyProgress?.((progress) => {
      updateInitializationTask('sync-historical-daily', {
        message: `${progress.message}（${progress.processedTradeDays}/${progress.totalTradeDays}, 写入 ${progress.insertedRows} 行）`,
      })
      if (initializationFlow.currentTaskKey === 'sync-historical-daily') {
        setInitializationFlow(prev => ({ ...prev, message: progress.message }))
      }
    })
    return () => off?.()
  }, [initializationFlow.currentTaskKey])

  useEffect(() => {
    if (onboardingDismissed || !onboardingSnapshot) return
    const model = buildOnboardingModel(onboardingSnapshot)
    if (model.shouldPrompt) setOnboardingOpen(true)
  }, [onboardingDismissed, onboardingSnapshot])

  function openOnboardingGuide() {
    setConfigDrawerOpen(false)
    setOnboardingDismissed(false)
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY)
    setOnboardingOpen(true)
    void loadOnboardingHealth()
  }

  function closeOnboardingGuide() {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1')
    setOnboardingDismissed(true)
    setOnboardingOpen(false)
  }

  function openConfigFromGuide(tab: ConfigDrawerTab) {
    setConfigDrawerTab(tab)
    setConfigDrawerOpen(true)
  }

  function openConfigFromInitialization(tab: ConfigDrawerTab) {
    setConfigDrawerTab(tab)
    setConfigDrawerOpen(true)
  }

  const onboardingModel = useMemo(() => buildOnboardingModel(onboardingSnapshot), [onboardingSnapshot])
  const initializationModel = useMemo(
    () => buildInitializationModel(onboardingSnapshot, onboardingModel.nextStep?.action, onboardingLoading || initializationFlow.running),
    [onboardingSnapshot, onboardingModel.nextStep?.action, onboardingLoading, initializationFlow.running]
  )

  function updateInitializationTask(taskKey: InitializationTaskKey, patch: Partial<InitializationFlowState['tasks'][number]>) {
    setInitializationFlow(prev => ({
      ...prev,
      tasks: prev.tasks.map(task => task.key === taskKey ? { ...task, ...patch } : task)
    }))
  }

  async function runInitializationFlow(onlyTaskKey?: InitializationTaskKey) {
    if (initializationFlow.running) return
    const startedAt = Date.now()
    setOnboardingDismissed(false)
    localStorage.removeItem(ONBOARDING_DISMISSED_KEY)
    setOnboardingOpen(true)

    const queue = onlyTaskKey ? INITIALIZATION_TASKS.filter(task => task.key === onlyTaskKey) : INITIALIZATION_TASKS
    setInitializationFlow(prev => ({
      running: true,
      startedAt,
      tasks: prev.tasks.map(task => queue.some(item => item.key === task.key) ? { ...task, status: 'pending', startedAt: undefined, endedAt: undefined, message: undefined, error: undefined } : task),
      message: onlyTaskKey ? '正在重试初始化任务。' : '正在执行一键初始化。',
      error: undefined
    }))

    let latestSnapshot = onboardingSnapshot
    for (const task of queue) {
      if (task.key !== 'refresh-before' && task.key !== 'refresh-after') {
        const datasourceReady = latestSnapshot?.groups.flatMap(group => group.items).find(item => item.key === 'config.tushare')?.status === 'ok'
        if (!datasourceReady) {
          updateInitializationTask(task.key, { status: 'retryable', endedAt: Date.now(), error: 'Tushare 未配置或不可用, 请先打开数据源配置。' })
          setInitializationFlow(prev => ({ ...prev, running: false, endedAt: Date.now(), currentTaskKey: undefined, error: 'Tushare 未配置或不可用, 初始化已暂停。' }))
          return
        }
      }

      const skipReason = shouldSkipInitializationTask(latestSnapshot, task)
      if (skipReason) {
        updateInitializationTask(task.key, { status: 'skipped', message: skipReason, startedAt: Date.now(), endedAt: Date.now() })
        continue
      }

      const taskStartedAt = Date.now()
      setInitializationFlow(prev => ({ ...prev, currentTaskKey: task.key, message: `正在执行：${task.title}` }))
      updateInitializationTask(task.key, { status: 'running', startedAt: taskStartedAt, endedAt: undefined, message: undefined, error: undefined })

      try {
        const res = await window.api.diagnostics.runCheck(task.action)
        if (!res.ok) {
          updateInitializationTask(task.key, { status: 'retryable', endedAt: Date.now(), error: res.message || '任务执行失败' })
          setInitializationFlow(prev => ({ ...prev, running: false, endedAt: Date.now(), currentTaskKey: undefined, error: res.message || `${task.title} 执行失败` }))
          await loadOnboardingHealth()
          return
        }
        updateInitializationTask(task.key, { status: 'success', endedAt: Date.now(), message: res.data.message })
        if (task.action === 'refreshHealth') {
          const health = await window.api.diagnostics.getHealth()
          if (health.ok) {
            latestSnapshot = health.data
            setOnboardingSnapshot(health.data)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : `${task.title} 执行失败`
        updateInitializationTask(task.key, { status: 'retryable', endedAt: Date.now(), error: message })
        setInitializationFlow(prev => ({ ...prev, running: false, endedAt: Date.now(), currentTaskKey: undefined, error: message }))
        await loadOnboardingHealth()
        return
      }
    }

    await loadOnboardingHealth()
    await loadDecisionSignalSummary()
    setInitializationFlow(prev => ({ ...prev, running: false, endedAt: Date.now(), currentTaskKey: undefined, message: '初始化任务已完成。', error: undefined }))
  }

  function startInitializationFlow() {
    void runInitializationFlow()
  }

  function retryInitializationTask(taskKey: InitializationTaskKey) {
    void runInitializationFlow(taskKey)
  }

  // FR-099: 首次进入行业云图 Tab 时启动轮询
  useEffect(() => {
    if (activeTab === 'industry-heatmap' && !heatmapPollingStarted) {
      initHeatmapPolling()
    }
  }, [activeTab, heatmapPollingStarted])

  // FR-099: 全局 60s 轮询，不随 Tab 切换停止
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (!heatmapPollingStarted) return
    if (pollingIntervalRef.current !== null) return // 已经在运行
    pollingIntervalRef.current = setInterval(() => {
      if (isInTradingHours()) {
        fetchHeatmapSnapshot()
      }
    }, 60_000)
    // 注意：此 interval 有意不清除（全局持续运行）
  }, [heatmapPollingStarted])

  // Subscribe to push events from main process
  useEffect(() => {
    const offCatchup = window.api.on('catchup:status', (data) => {
      setCatchUpMessage((data as { message: string }).message)
    })
    const offNew = window.api.on('briefings:new', () => {
      handleNewBriefings()
    })
    const offCompleted = window.api.on('scan:completed', () => {
      loadScanStatus()
      handleNewBriefings()
    })
    const offStarted = window.api.on('scan:started', () => {
      loadScanStatus()
    })
    const offProgress = window.api.on('scan:source-progress', (data) => {
      const d = data as { sourceId: number; sourceName: string; url: string; status: 'PENDING' | 'SCANNING' | 'SUCCESS' | 'FAILED'; newCount: number; error?: string }
      updateSourceProgress(d)
    })
    const offAiAvailable = window.api.on('scan:aiAnalysisAvailable', (data) => {
      const d = data as AIPendingAnalysis
      // Only prompt if autoAiAnalysisPrompt is enabled in settings
      if (settings?.autoAiAnalysisPrompt) {
        setAIPendingAnalysis(d)
      }
    })
    const offAiProgress = window.api.ai.onAnalyzeProgress((data) => {
      setAiProgress(data)
    })
    const offDecisionSignal = window.api.decision.onSignalCreated(() => {
      loadDecisionSignalSummary()
    })

    return () => {
      offCatchup()
      offNew()
      offCompleted()
      offStarted()
      offProgress()
      offAiAvailable()
      offAiProgress()
      offDecisionSignal()
    }
  }, [settings?.autoAiAnalysisPrompt])

  const NAV_TABS: Array<{ tab: Tab; label: string; icon: PrimaryNavigationIconName }> = [
    { tab: 'decision-center', label: '今日看板', icon: 'dashboard' },
    { tab: 'stock-chart', label: '股票走势图', icon: 'stock' },
    { tab: 'trend-watcher', label: '长线趋势', icon: 'trend' },
    // { tab: 'market-heatmap', label: '大盘云图（旧版）', icon: 'heatmap' }, // 暂时从 UI 隐藏，代码保留
    { tab: 'industry-heatmap', label: '大盘云图', icon: 'heatmap' },
    { tab: 'short-term-strategy', label: '短线策略', icon: 'strategy' },
    { tab: 'feed', label: '资讯', icon: 'news' },
    { tab: 'ai-analysis', label: 'AI分析', icon: 'ai' }
  ]

  const secondaryNavItemsByTab = useMemo<Partial<Record<Tab, SecondaryNavItem[]>>>(() => ({
    'trend-watcher': TREND_WATCHER_SUB_TABS.map(item => ({
        key: item.key,
        label: item.label,
        current: activeTab === 'trend-watcher' && trendWatcherSubTab === item.key,
        onSelect: () => {
          setTrendWatcherSubTab(item.key)
          setActiveTab('trend-watcher')
          setNavFlyoutTab(null)
        }
      })),
    'industry-heatmap': MARKET_OVERVIEW_SUB_TABS.map(([key, label]) => ({
        key,
        label,
        current: activeTab === 'industry-heatmap' && marketOverviewSubTab === key,
        onSelect: () => {
          setMarketOverviewSubTab(key)
          setActiveTab('industry-heatmap')
          setNavFlyoutTab(null)
        }
      })),
    'short-term-strategy': SHORT_TERM_SUB_TABS.map(([key, label]) => ({
        key,
        label,
        current: activeTab === 'short-term-strategy' && (
          shortTermActiveSubTab === key ||
          (key === 'strategyLab' && (shortTermActiveSubTab === 'personalScreener' || shortTermActiveSubTab === 'conditionBlocks'))
        ),
        onSelect: () => {
          void setShortTermActiveSubTab(key as ShortTermSubTab)
          setActiveTab('short-term-strategy')
          setNavFlyoutTab(null)
        }
      })),
    'ai-analysis': [
        {
          key: 'records',
          label: '研判记录',
          current: activeTab === 'ai-analysis' && aiAnalysisSubTab === 'records',
          onSelect: () => {
            clearPendingResearchDiscussion()
            setAIAnalysisSubTab('records')
            setActiveTab('ai-analysis')
            setNavFlyoutTab(null)
          }
        },
        {
          key: 'deepResearch',
          label: '深度研究',
          current: activeTab === 'ai-analysis' && aiAnalysisSubTab === 'deepResearch',
          onSelect: () => {
            clearPendingResearchDiscussion()
            setAIAnalysisSubTab('deepResearch')
            setActiveTab('ai-analysis')
            setNavFlyoutTab(null)
          }
        },
        {
          key: 'industryResearch',
          label: '产业研究',
          current: activeTab === 'ai-analysis' && aiAnalysisSubTab === 'industryResearch',
          onSelect: () => {
            clearPendingResearchDiscussion()
            setAIAnalysisSubTab('industryResearch')
            setActiveTab('ai-analysis')
            setNavFlyoutTab(null)
          }
        }
      ]
  }), [activeTab, aiAnalysisSubTab, clearPendingResearchDiscussion, marketOverviewSubTab, setAIAnalysisSubTab, setActiveTab, setShortTermActiveSubTab, shortTermActiveSubTab, trendWatcherSubTab])

  const navFlyoutTitle = navFlyoutTab ? NAV_TABS.find(item => item.tab === navFlyoutTab)?.label : undefined
  const navFlyoutItems = navFlyoutTab ? secondaryNavItemsByTab[navFlyoutTab] ?? [] : []

  const handleNavigationToggle = () => {
    setNavigationExpanded((current) => {
      const next = !current
      try {
        localStorage.setItem(NAVIGATION_EXPANDED_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // The preference remains available for the current renderer session.
      }
      if (next) {
        setNavFlyoutTab(null)
        setExpandedNavTab(SECONDARY_NAV_TABS.has(activeTab) ? activeTab : null)
      } else {
        setExpandedNavTab(null)
      }
      return next
    })
  }

  const handlePrimaryNavClick = (tab: Tab, event: ReactMouseEvent<HTMLButtonElement>) => {
    const hasSecondary = SECONDARY_NAV_TABS.has(tab)
    if (hasSecondary) {
      if (navigationExpanded) {
        setExpandedNavTab(prev => prev === tab ? null : tab)
        setNavFlyoutTab(null)
        return
      }
      const shellRect = navShellRef.current?.getBoundingClientRect()
      const buttonRect = event.currentTarget.getBoundingClientRect()
      setNavFlyoutAnchorY(shellRect ? buttonRect.top - shellRect.top + buttonRect.height / 2 : buttonRect.height / 2)
      setNavFlyoutTab(prev => prev === tab ? null : tab)
      return
    }
    setActiveTab(tab)
    setExpandedNavTab(null)
    setNavFlyoutTab(null)
  }

  const messages = useMemo<MessageCenterItem[]>(() => {
    const items: MessageCenterItem[] = []
    if (catchUpMessage) {
      items.push({
        id: 'catch-up-status',
        title: '启动补漏状态更新',
        description: catchUpMessage,
        source: '资讯',
        tone: catchUpMessage.includes('失败') ? 'danger' : catchUpMessage.includes('完成') ? 'success' : 'info',
        actionLabel: '查看资讯',
        onAction: () => { setActiveTab('feed'); setMessageCenterOpen(false) }
      })
    }
    if (isScanning) {
      items.push({
        id: 'scan-running',
        title: '资讯扫描正在运行',
        description: '扫描进度会在当前任务完成后更新资讯列表。',
        source: '资讯',
        tone: 'info',
        actionLabel: '查看资讯',
        onAction: () => { setActiveTab('feed'); setMessageCenterOpen(false) }
      })
    } else if (scanStatus?.lastScanAt) {
      items.push({
        id: 'scan-last',
        title: '最近一次资讯扫描完成',
        description: `上次扫描时间 ${formatBjTime(scanStatus.lastScanAt)}。立即扫描已移入资讯页工具区。`,
        source: '资讯',
        timeLabel: formatBjTime(scanStatus.lastScanAt),
        tone: 'success',
        actionLabel: '打开资讯',
        onAction: () => { setActiveTab('feed'); setMessageCenterOpen(false) }
      })
    }
    if (unreadCount > 0) {
      items.push({
        id: 'briefing-unread',
        title: `${unreadCount} 条资讯未读`,
        description: '未读资讯已回到资讯模块上下文中处理, 不再占用全局顶部状态栏。',
        source: '资讯',
        tone: 'info',
        actionLabel: '处理资讯',
        onAction: () => { setActiveTab('feed'); setMessageCenterOpen(false) }
      })
    }
    if (decisionUnreadHighPriorityCount > 0) {
      items.push({
        id: 'decision-high-priority',
        title: `${decisionUnreadHighPriorityCount} 条高优先级信号未读`,
        description: '这类消息只提示你回到今日看板, 具体研判和处置仍在今日看板完成。',
        source: '今日看板',
        tone: 'warning',
        actionLabel: '打开看板',
        onAction: () => { setActiveTab('decision-center'); setMessageCenterOpen(false) }
      })
    }
    if (initializationFlow.running) {
      items.push({
        id: 'initialization-running',
        title: '一键初始化正在执行',
        description: initializationFlow.message ?? '初始化任务仍在进行中。',
        source: '初始化',
        tone: 'info',
        actionLabel: '查看引导',
        onAction: () => { openOnboardingGuide(); setMessageCenterOpen(false) }
      })
    } else if (initializationFlow.error) {
      items.push({
        id: 'initialization-error',
        title: '初始化任务需要处理',
        description: initializationFlow.error,
        source: '初始化',
        tone: 'danger',
        actionLabel: '查看引导',
        onAction: () => { openOnboardingGuide(); setMessageCenterOpen(false) }
      })
    }
    return items
  }, [catchUpMessage, decisionUnreadHighPriorityCount, initializationFlow.error, initializationFlow.message, initializationFlow.running, isScanning, scanStatus?.lastScanAt, setActiveTab, unreadCount])

  return (
    <div className="flex h-screen flex-col bg-slate-50 text-slate-900 select-none dark:bg-slate-950 dark:text-slate-100">
      <AppTitleBar navigationExpanded={navigationExpanded} />
      <ScanProgressModal />
      <AIAnalysisConfirmDialog />
      <AIAnalysisProgressPanel />
      <AppToast
        message={appToast?.message ?? null}
        tone={appToast?.tone}
        testId="app-global-toast"
        onClose={() => setAppToast(null)}
      />
      <AppConfirmDialog
        open={startupBacktestSync != null}
        title="补齐预测回测分时数据"
        message={`检测到 ${startupBacktestSync?.stockCodes.length ?? 0} 只股票缺少历史分时缓存。补齐后，预测准确率统计会使用更完整的真实行情。`}
        tone="default"
        statusLabel="可稍后处理"
        confirmLabel="立即同步"
        cancelLabel="稍后再说"
        busy={startupBacktestSyncing}
        error={startupBacktestError}
        testId="startup-backtest-sync-dialog"
        onCancel={() => {
          setStartupBacktestSync(null)
          setStartupBacktestError(null)
        }}
        onConfirm={() => { void handleStartupBacktestSync() }}
      >
        {startupBacktestSync && (
          <div className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-200">待补股票：</span>
            <span className="ml-1 font-mono tabular-nums">
              {startupBacktestSync.stockCodes.slice(0, 10).join('、')}
              {startupBacktestSync.stockCodes.length > 10 ? ` 等 ${startupBacktestSync.stockCodes.length} 只` : ''}
            </span>
          </div>
        )}
      </AppConfirmDialog>
      <ConfigDrawer
        open={configDrawerOpen}
        activeTab={configDrawerTab}
        onTabChange={setConfigDrawerTab}
        onClose={() => setConfigDrawerOpen(false)}
        onOpenGuide={openOnboardingGuide}
        theme={theme}
        onToggleTheme={toggleTheme}
        initializationFlow={initializationFlow}
        onStartInitialization={startInitializationFlow}
      />
      <MessageCenterDrawer open={messageCenterOpen} messages={messages} onClose={() => setMessageCenterOpen(false)} />
      {onboardingOpen && (
        <ColdStartGuide
          snapshot={onboardingSnapshot}
          loading={onboardingLoading}
          flow={initializationFlow}
          onRefresh={loadOnboardingHealth}
          onOpenConfig={openConfigFromGuide}
          onNavigate={setActiveTab}
          onStartInitialization={startInitializationFlow}
          onRetryTask={retryInitializationTask}
          onClose={closeOnboardingGuide}
        />
      )}

      <div className="flex min-h-0 flex-1">
      <div
        ref={navShellRef}
        data-testid="app-navigation-shell"
        data-expanded={navigationExpanded ? 'true' : 'false'}
        className={`relative ${navFlyoutTab ? 'z-[200]' : 'z-30'} flex shrink-0 transition-[width] duration-200 motion-reduce:transition-none ${navigationExpanded ? 'w-56' : 'w-16'}`}
      >
      <aside className="flex min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-white text-slate-500 shadow-sm dark:border-slate-900 dark:bg-slate-950 dark:text-slate-300 dark:shadow-xl">
        <div className="shrink-0 border-b border-slate-200 px-2 py-2 dark:border-slate-800">
          <button
            data-testid="navigation-toggle"
            type="button"
            onClick={handleNavigationToggle}
            aria-label={navigationExpanded ? '收起导航' : '展开导航'}
            aria-expanded={navigationExpanded}
            title={navigationExpanded ? '收起导航' : '展开导航'}
            className={`group flex h-11 w-full items-center rounded-sm border border-transparent text-slate-500 transition-colors hover:border-slate-300 hover:bg-slate-100 hover:text-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-1 motion-reduce:transition-none dark:text-slate-400 dark:hover:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-cyan-200 dark:focus:ring-cyan-300 ${navigationExpanded ? 'justify-between gap-3 px-3' : 'justify-center'}`}
          >
            <NavigationToggleIcon expanded={navigationExpanded} />
            {navigationExpanded && <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">收起导航</span>}
          </button>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-2" aria-label="一级导航">
          {NAV_TABS.map(({ tab, label, icon }) => {
            const hasSecondary = SECONDARY_NAV_TABS.has(tab)
            const secondaryExpanded = navigationExpanded ? expandedNavTab === tab : navFlyoutTab === tab
            const inlineItems = secondaryNavItemsByTab[tab] ?? []
            return (
            <div key={tab} className="w-full shrink-0">
            <button
              data-testid={`nav-tab-${tab}`}
              type="button"
              onClick={(event) => handlePrimaryNavClick(tab, event)}
              aria-label={label}
              aria-haspopup={hasSecondary && !navigationExpanded ? 'menu' : undefined}
              aria-controls={hasSecondary && navigationExpanded ? `secondary-nav-group-${tab}` : undefined}
              aria-expanded={hasSecondary ? secondaryExpanded : undefined}
              className={[
                'app-primary-nav-button group relative flex h-11 shrink-0 items-center rounded-sm border transition-[color,background-color,border-color,box-shadow] focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-white motion-reduce:transition-none dark:focus:ring-cyan-300 dark:focus:ring-offset-slate-950',
                navigationExpanded ? 'w-full justify-start gap-3 px-3' : 'mx-auto w-11 justify-center',
                activeTab === tab
                  ? 'is-active border-cyan-500 bg-cyan-50 text-cyan-700 shadow-[0_0_14px_rgba(6,182,212,0.10)] dark:border-cyan-400 dark:bg-cyan-950/55 dark:text-cyan-100'
                  : secondaryExpanded
                    ? 'is-expanded border-blue-300 bg-slate-100 text-blue-700 dark:border-blue-500/70 dark:bg-slate-800 dark:text-blue-200'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:bg-slate-100 hover:text-cyan-700 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-cyan-200'
              ].join(' ')}
            >
              <span className="relative flex h-6 w-6 items-center justify-center">
                <PrimaryNavigationIcon name={icon} />
                {tab === 'decision-center' && decisionUnreadHighPriorityCount > 0 && (
                  <span className="absolute -right-3 -top-2 min-w-5 rounded-[2px] bg-red-500 px-1 text-[10px] font-medium leading-4 text-white ring-2 ring-white dark:ring-slate-950">
                    {decisionUnreadHighPriorityCount > 9 ? '9+' : decisionUnreadHighPriorityCount}
                  </span>
                )}
              </span>
              {navigationExpanded && <span data-testid={`nav-label-${tab}`} className="min-w-0 flex-1 truncate text-left text-sm font-medium">{label}</span>}
              {navigationExpanded && hasSecondary && <NavigationChevron expanded={secondaryExpanded} />}
              <span aria-hidden="true" className="nav-tech-corner-pixel" />
              <SidebarTooltip label={label} hidden={navigationExpanded || navFlyoutTab !== null} />
            </button>
            {navigationExpanded && hasSecondary && secondaryExpanded && inlineItems.length > 0 && (
              <div
                id={`secondary-nav-group-${tab}`}
                role="group"
                aria-label={`${label}二级导航`}
                className="ml-5 mt-1 flex flex-col gap-0.5 border-l border-slate-200 pb-1 pl-3 dark:border-slate-800"
              >
                {inlineItems.map(item => (
                  <button
                    key={item.key}
                    data-testid={`secondary-nav-${tab}-${item.key}`}
                    type="button"
                    onClick={item.onSelect}
                    aria-current={item.current ? 'page' : undefined}
                    className={[
                      'group/secondary relative flex min-h-11 w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-[13px] transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-400 motion-reduce:transition-none dark:focus:ring-cyan-300',
                      item.current
                        ? 'bg-cyan-50 font-medium text-cyan-800 dark:bg-cyan-400/15 dark:text-cyan-100'
                        : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white'
                    ].join(' ')}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.current ? 'bg-cyan-500 dark:bg-cyan-300' : 'bg-slate-300 group-hover/secondary:bg-cyan-400 dark:bg-slate-700'}`} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            )}
            </div>
            )
          })}
        </nav>
        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-slate-200 px-2 py-2 dark:border-slate-800">
          <button
            data-testid="open-message-center-btn"
            type="button"
            onClick={() => {
              setNavFlyoutTab(null)
              setMessageCenterOpen(true)
            }}
            className={`app-primary-nav-button group relative flex h-11 shrink-0 items-center rounded-sm border transition-[color,background-color,border-color,box-shadow] focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-white motion-reduce:transition-none dark:focus:ring-cyan-300 dark:focus:ring-offset-slate-950 ${navigationExpanded ? 'w-full justify-start gap-3 px-3' : 'w-11 justify-center'} ${messageCenterOpen ? 'is-active border-cyan-500 bg-cyan-50 text-cyan-700 dark:border-cyan-400 dark:bg-cyan-950/55 dark:text-cyan-100' : 'border-transparent text-slate-500 hover:border-slate-300 hover:bg-slate-100 hover:text-cyan-700 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-cyan-200'}`}
            aria-label="打开消息中心"
            aria-expanded={messageCenterOpen}
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <PrimaryNavigationIcon name="messages" />
              {messages.length > 0 && (
                <span className="absolute -right-2 -top-1 h-2.5 w-2.5 rounded-[1px] bg-amber-400 ring-2 ring-white dark:ring-slate-950" />
              )}
            </span>
            {navigationExpanded && <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">消息中心</span>}
            <span aria-hidden="true" className="nav-tech-corner-pixel" />
            <SidebarTooltip label="消息中心" hidden={navigationExpanded} />
          </button>
          <button
            data-testid="open-config-drawer-btn"
            type="button"
            onClick={() => {
              setNavFlyoutTab(null)
              setConfigDrawerTab('settings')
              setConfigDrawerOpen(true)
            }}
            className={`app-primary-nav-button group relative flex h-11 shrink-0 items-center rounded-sm border transition-[color,background-color,border-color,box-shadow] focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-white motion-reduce:transition-none dark:focus:ring-cyan-300 dark:focus:ring-offset-slate-950 ${navigationExpanded ? 'w-full justify-start gap-3 px-3' : 'w-11 justify-center'} ${configDrawerOpen ? 'is-active border-cyan-500 bg-cyan-50 text-cyan-700 dark:border-cyan-400 dark:bg-cyan-950/55 dark:text-cyan-100' : 'border-transparent text-slate-500 hover:border-slate-300 hover:bg-slate-100 hover:text-cyan-700 dark:text-slate-300 dark:hover:border-slate-700 dark:hover:bg-slate-800 dark:hover:text-cyan-200'}`}
            aria-label="打开配置中心"
            aria-expanded={configDrawerOpen}
          >
            <span className="relative flex h-6 w-6 items-center justify-center"><PrimaryNavigationIcon name="settings" /></span>
            {navigationExpanded && <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">配置中心</span>}
            <span aria-hidden="true" className="nav-tech-corner-pixel" />
            <SidebarTooltip label="配置中心" hidden={navigationExpanded} />
          </button>
        </div>
      </aside>
      {!navigationExpanded && navFlyoutTab && navFlyoutItems.length > 0 && (
        <div
          role="menu"
          aria-label={`${navFlyoutTitle ?? '模块'}二级导航`}
          style={{ top: navFlyoutAnchorY ?? 24 }}
          className="app-nav-flyout absolute left-full top-0 z-50 ml-3 flex max-h-[calc(100vh-var(--app-titlebar-height)-24px)] w-56 flex-col overflow-visible rounded-lg border border-slate-200/90 bg-white/95 p-1.5 text-slate-700 shadow-[0_18px_45px_rgba(15,23,42,0.16)] backdrop-blur dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-100 dark:shadow-black/40"
        >
          <span aria-hidden="true" className="absolute -left-3 top-1/2 h-px w-3 -translate-y-1/2 bg-cyan-300/80 dark:bg-cyan-300/60" />
          <span aria-hidden="true" className="absolute -left-[5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border-b border-l border-slate-200/90 bg-white/95 dark:border-slate-700 dark:bg-slate-900/95" />
          <div className="relative px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {navFlyoutTitle}
          </div>
          <div className="relative max-h-[min(430px,calc(100vh-var(--app-titlebar-height)-88px))] overflow-y-auto pr-1">
            <div className="flex flex-col gap-1">
              {navFlyoutItems.map(item => (
                <button
                  key={item.key}
                  data-testid={`secondary-nav-${navFlyoutTab}-${item.key}`}
                  type="button"
                  role="menuitem"
                  onClick={item.onSelect}
                  className={[
                    'flex min-h-10 w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400 dark:focus:ring-cyan-300',
                    item.current
                      ? 'bg-cyan-50 font-medium text-cyan-700 ring-1 ring-inset ring-cyan-200 dark:bg-cyan-400/15 dark:text-cyan-200 dark:ring-cyan-300/25'
                      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-950 hover:ring-1 hover:ring-inset hover:ring-slate-200 dark:text-slate-300 dark:hover:bg-slate-800/70 dark:hover:text-white dark:hover:ring-slate-700'
                  ].join(' ')}
                >
                  <span>{item.label}</span>
                  {item.current && <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 dark:bg-cyan-300" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {industryResearchTask && !(activeTab === 'ai-analysis' && aiAnalysisSubTab === 'industryResearch') && (
          <button
            type="button"
            data-testid="industry-research-background-task"
            aria-live="polite"
            aria-label={`${researchTaskLabel(industryResearchTask)}，点击返回产业研究项目`}
            onClick={() => navigateToIndustryResearch(industryResearchTask.projectId)}
            className={[
              'flex min-h-[52px] shrink-0 flex-col justify-center gap-1 border-b px-4 py-1.5 text-left text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-400',
              industryResearchTask.status === 'failed'
                ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-950 dark:bg-red-950/45 dark:text-red-200 dark:hover:bg-red-950/65'
                : industryResearchTask.status === 'succeeded'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-950 dark:bg-emerald-950/45 dark:text-emerald-200 dark:hover:bg-emerald-950/65'
                  : 'border-cyan-200 bg-cyan-50 text-cyan-900 hover:bg-cyan-100 dark:border-cyan-950 dark:bg-cyan-950/45 dark:text-cyan-100 dark:hover:bg-cyan-950/65'
            ].join(' ')}
          >
            <div className="flex w-full min-w-0 items-center gap-2">
              {!isTerminalResearchTask(industryResearchTask) && (
                <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" aria-hidden="true" />
              )}
              <span className="shrink-0 font-semibold">
                {isTerminalResearchTask(industryResearchTask) ? researchTaskLabel(industryResearchTask) : '产业研究后台'}
              </span>
              {!isTerminalResearchTask(industryResearchTask) && industryResearchStageProgress && (
                <span className="shrink-0 text-current/75">{industryResearchStageProgress.label}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-current/80" title={industryResearchTask.message}>
                {isTerminalResearchTask(industryResearchTask)
                  ? industryResearchTask.message
                  : industryResearchFinancialProgress?.currentLabel || industryResearchTask.message}
              </span>
              <span className="shrink-0 font-semibold">查看</span>
            </div>
            {!isTerminalResearchTask(industryResearchTask) && industryResearchStageProgress && (
              <div className="flex w-full min-w-0 items-center gap-2 pl-[22px]">
                <div
                  data-testid="industry-research-background-progress"
                  role="progressbar"
                  aria-label={industryResearchFinancialProgress
                    ? `公司财务采集，${industryResearchFinancialProgress.processedLabel}`
                    : `产业研究${industryResearchStageProgress.completedLabel}，${industryResearchStageProgress.label}`}
                  aria-valuemin={0}
                  aria-valuemax={industryResearchFinancialProgress?.total || 100}
                  aria-valuenow={industryResearchFinancialProgress?.processed ?? industryResearchStageProgress.percent}
                  aria-valuetext={industryResearchFinancialProgress
                    ? industryResearchFinancialProgress.processedLabel
                    : industryResearchTask.stage === 'report'
                      ? `${industryResearchStageProgress.completedLabel}，研究报告生成中，尚未完成`
                      : `${industryResearchStageProgress.percent}%`}
                  className="h-1.5 min-w-0 flex-1 overflow-hidden rounded bg-current/15"
                >
                  <div
                    className="h-full bg-current transition-[width] duration-300 motion-reduce:transition-none"
                    style={{ width: `${industryResearchFinancialProgress?.percent ?? industryResearchStageProgress.percent}%` }}
                  />
                </div>
                <span className="shrink-0 tabular-nums text-[10px] text-current/75">
                  {industryResearchFinancialProgress?.processedLabel
                    || (industryResearchTask.stage === 'report'
                      ? industryResearchStageProgress.completedLabel
                      : industryResearchStageProgress.positionLabel)}
                </span>
              </div>
            )}
          </button>
        )}
        {/* Main content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<WorkbenchFallback />}>
        {activeTab === 'feed' && (
          <div className="flex flex-1 overflow-hidden bg-[#eef3f5] text-slate-900 dark:bg-slate-950 dark:text-slate-100">
            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
              <header className="flex shrink-0 items-stretch gap-4 rounded-lg border border-slate-200/80 bg-white px-4 py-3 shadow-sm shadow-slate-200/60 dark:border-slate-800 dark:bg-slate-900/90 dark:shadow-black/20">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-bold uppercase tracking-[0.26em] text-cyan-600 dark:text-cyan-300">News Intelligence</div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h1 className="text-[26px] font-semibold tracking-tight text-slate-950 dark:text-white">资讯情报台</h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400">先看影响, 再读全文, 最后进入验证</p>
                  </div>
                  <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500 dark:text-slate-400">
                    把扫描、未读、重大事件和来源分组收束到同一工作流, 避免资讯列表成为无重点的信息堆栈。
                  </p>
                </div>
                <div data-testid="feed-summary-panel" className="flex shrink-0 items-stretch gap-3">
                  <div className="grid grid-cols-4 items-stretch gap-2">
                    <div data-testid="feed-summary-metric" className="flex min-w-[92px] flex-col items-center justify-center rounded-md border border-slate-200/80 bg-white px-3 py-2 text-center shadow-sm shadow-slate-100/70 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-black/10">
                      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">重大影响</div>
                      <div className="mt-1 text-2xl font-semibold leading-none tabular-nums text-red-500">{highImpactCount}</div>
                    </div>
                    <div data-testid="feed-summary-metric" className="flex min-w-[92px] flex-col items-center justify-center rounded-md border border-slate-200/80 bg-white px-3 py-2 text-center shadow-sm shadow-slate-100/70 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-black/10">
                      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">未读资讯</div>
                      <div className="mt-1 text-2xl font-semibold leading-none tabular-nums text-slate-950 dark:text-white">{unreadCount}</div>
                    </div>
                    <div data-testid="feed-summary-metric" className="flex min-w-[92px] flex-col items-center justify-center rounded-md border border-slate-200/80 bg-white px-3 py-2 text-center shadow-sm shadow-slate-100/70 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-black/10">
                      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">待处理</div>
                      <div className="mt-1 text-2xl font-semibold leading-none tabular-nums text-slate-950 dark:text-white">{feedPendingCount}</div>
                    </div>
                    <div data-testid="feed-summary-metric" className="flex min-w-[92px] flex-col items-center justify-center rounded-md border border-slate-200/80 bg-white px-3 py-2 text-center shadow-sm shadow-slate-100/70 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-black/10">
                      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">来源在线</div>
                      <div className="mt-1 text-2xl font-semibold leading-none tabular-nums text-cyan-700 dark:text-cyan-300">{feedSourceCount}</div>
                    </div>
                  </div>
                  <div data-testid="feed-summary-scan" className="flex min-w-[132px] flex-col items-center justify-center gap-2 rounded-md border border-slate-200/80 bg-white px-3 py-2 text-center shadow-sm shadow-slate-100/70 dark:border-slate-800 dark:bg-slate-950/40 dark:shadow-black/10">
                    <button
                      type="button"
                      onClick={() => void triggerManualScan()}
                      disabled={isScanning}
                      className="w-full rounded-md border border-cyan-500 bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-cyan-500/20 transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500 disabled:shadow-none dark:disabled:border-slate-700 dark:disabled:bg-slate-800 dark:disabled:text-slate-500"
                    >
                      {isScanning ? '扫描中' : '立即扫描'}
                    </button>
                    <div className="text-center text-[11px] leading-4 text-slate-500 dark:text-slate-400">
                      {scanStatus?.lastScanAt ? `上次 ${new Date(scanStatus.lastScanAt + 8 * 60 * 60 * 1000).toISOString().slice(11, 16)} · ${isScanning ? '扫描中' : '扫描待命'}` : isScanning ? '扫描中' : '暂无扫描'}
                    </div>
                  </div>
                </div>
              </header>
              <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(390px,0.95fr)_minmax(440px,1.05fr)] gap-3 overflow-hidden">
                <aside className="min-h-0 overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-900/90 dark:shadow-black/20">
                  <DateArchive />
                </aside>
                <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-900/90 dark:shadow-black/20">
                  <FilterBar />
                  <BriefingFeed />
                </section>
                <section className="min-h-0 min-w-0 overflow-hidden rounded-lg border border-slate-200/80 bg-white shadow-sm shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-900/90 dark:shadow-black/20">
                  <BriefingDetail briefingId={selectedBriefingId} />
                </section>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ai-analysis' && (
          <div data-testid="ai-analysis-page" className="flex flex-1 bg-white dark:bg-gray-900 overflow-hidden">
            {aiAnalysisSubTab === 'records' && <AIAnalysis />}
            {aiAnalysisSubTab === 'deepResearch' && (
              <DeepResearchWorkbench
                onOpenAiConfig={() => {
                  setConfigDrawerTab('ai-config')
                  setConfigDrawerOpen(true)
                }}
              />
            )}
            {aiAnalysisSubTab === 'industryResearch' && <IndustryResearch />}
          </div>
        )}

        {activeTab === 'stock-chart' && (
          <div data-testid="stock-chart-page" className="flex flex-1 bg-white dark:bg-gray-900 overflow-hidden">
            <StockChart />
          </div>
        )}

        {activeTab === 'market-heatmap' && (
          <div className="flex flex-1 bg-white dark:bg-gray-900 overflow-hidden">
            <MarketHeatmap />
          </div>
        )}

        {activeTab === 'industry-heatmap' && (
          <div className="flex flex-1 bg-white dark:bg-gray-900 overflow-hidden">
            <MarketOverview activeSubTab={marketOverviewSubTab} onSubTabChange={setMarketOverviewSubTab} />
          </div>
        )}

        {activeTab === 'short-term-strategy' && (
          <div className="flex min-h-0 flex-1 overflow-hidden bg-white dark:bg-gray-900">
            <ShortTermStrategy />
          </div>
        )}

        {activeTab === 'trend-watcher' && (
          <div className="flex-1 bg-white dark:bg-gray-900 overflow-hidden">
            <TrendWatcher activeSubTab={trendWatcherSubTab} onSubTabChange={setTrendWatcherSubTab} />
          </div>
        )}

        {activeTab === 'decision-center' && (
          <div data-testid="decision-center-page" className="flex-1 bg-white dark:bg-gray-900 overflow-hidden">
            <DecisionCenter
              initialization={initializationModel}
              initializationFlow={initializationFlow}
              onOpenGuide={openOnboardingGuide}
              onStartInitialization={startInitializationFlow}
              onOpenConfig={openConfigFromInitialization}
            />
          </div>
        )}
        </Suspense>
        </div>
      </div>
      </div>
    </div>
  )
}
