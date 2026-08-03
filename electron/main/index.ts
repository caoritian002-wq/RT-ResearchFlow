import { app, BrowserWindow, shell, net, ipcMain, Menu } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { initDb, getDb } from './database/db'
import { seedBuiltInSources } from './database/sourceRepository'
import { BUILT_IN_SOURCES } from './database/seeds'
import { registerBriefingHandlers } from './ipc/briefingHandlers'
import { registerSourceHandlers } from './ipc/sourceHandlers'
import { registerScanHandlers, sendScanEvent } from './ipc/scanHandlers'
import { registerSettingsHandlers } from './ipc/settingsHandlers'
import { registerArchiveHandlers } from './ipc/archiveHandlers'
import { registerDetailHandlers } from './ipc/detailHandlers'
import { registerAIHandlers } from './ipc/aiHandlers'
import { registerAiEvaluationHandlers } from './ipc/aiEvaluationHandlers'
import { registerSkillHandlers } from './ipc/skillHandlers'
import { registerBacktestHandlers } from './ipc/backtestHandlers'
import { registerMarketHeatmapHandlers } from './ipc/marketHeatmapHandlers'
import { registerShortTermHandlers } from './ipc/shortTermHandlers'
import { registerMarketOverviewHandlers } from './ipc/marketOverviewHandlers'
import { registerScreenerHandlers } from './ipc/screenerHandlers'
import { registerSectorFlowHandlers } from './ipc/sectorFlowHandlers'
import { registerTradeCalHandlers } from './ipc/tradeCalHandlers'
import { registerTrendHandlers } from './ipc/trendHandlers'
import { registerDecisionHandlers } from './ipc/decisionHandlers'
import { registerPortfolioHandlers } from './ipc/portfolioHandlers'
import { registerSupplyChainHandlers } from './ipc/supplyChainHandlers'
import { registerIndustryResearchHandlers } from './ipc/industryResearchHandlers'
import { registerDiagnosticsHandlers } from './ipc/diagnosticsHandlers'
import { registerDataSafetyHandlers } from './ipc/dataSafetyHandlers'
import { registerBaseDataPackageHandlers } from './ipc/baseDataPackageHandlers'
import { registerConditionBlockHandlers } from './ipc/conditionBlockHandlers'
import { registerStrategyBacktestHandlers } from './ipc/strategyBacktestHandlers'
import { registerMinuteDataHandlers } from './ipc/minuteDataHandlers'
import { registerStrategyLabHandlers } from './ipc/strategyLabHandlers'
import { registerChipStructureHandlers } from './ipc/chipStructureHandlers'
import { registerStockFundamentalHandlers } from './ipc/stockFundamentalHandlers'
import { registerResearchEvidenceHandlers } from './ipc/researchEvidenceHandlers'
import { registerResearchAccessHandlers } from './ipc/researchAccessHandlers'
import { registerResearchAgentHandlers } from './ipc/researchAgentHandlers'
import { registerPremarketHandlers } from './ipc/premarketHandlers'
import {
  startResearchAccessTransport,
  stopResearchAccessTransport,
} from './services/researchAccessTransport'
import { initDefaultEdgesIfEmpty } from './database/supplyChainRepository'
import { getAIConfig } from './database/aiConfigRepository'
import { deleteSessionsOlderThan } from './database/aiAnalysisSessionRepository'
import { getDataSourceConfig } from './database/dataSourceRepository'
import { setEventHandlers } from './services/scanEngine'
import { decryptApiKey } from './utils/apiKeyEncryption'
import { isArticleExpired } from './utils/articleAgeUtils'
import { startScheduler, stopScheduler, runConceptMembersSyncJob } from './services/schedulerService'
import { syncTradeCalIfNeeded } from './services/tradeCalSyncService'
import { scheduleDailyCleanup } from './services/cleanerService'
import { emitDecisionSignals, type DecisionSignalInput } from './services/decisionSignalService'
import {
  startHeartbeat,
  stopHeartbeat,
  recordCloseTime,
  runCatchUpIfNeeded
} from './services/catchUpService'
import {
  applicationDataPathErrorMessage,
  configureApplicationDataPaths,
} from './services/applicationDataPathService'
import { showFatalErrorWindow } from './fatalErrorWindow'
import {
  isAllowedApplicationNavigation,
  normalizeExternalHttpUrl,
  shouldAllowRendererPermission,
} from './security/navigationPolicy'

let mainWindow: BrowserWindow | null = null
let databaseReady = false

/**
 * FR-050/053: Check if AI analysis should be triggered after a scan.
 * Queries qualifying briefings, applies time filter, pushes scan:aiAnalysisAvailable.
 */
function triggerAIAnalysisIfAvailable(scanRunId: number | null, briefingScanRunId: number): void {
  if (!mainWindow) return
  try {
    const db = getDb()
    const aiConfig = getAIConfig(db)
    const hasKey = !!(aiConfig.provider && aiConfig.model && decryptApiKey(aiConfig.apiKeyEncrypted))
    if (!hasKey) return

    const ratingOrder = ['CRITICAL', 'IMPORTANT', 'GENERAL']
    const minIdx = ratingOrder.indexOf(aiConfig.triggerRating)
    const eligibleRatings = ratingOrder.slice(0, minIdx + 1)
    const placeholders = eligibleRatings.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT id, title, originalUrl, impactRating, impactRatingScore, publishedAt, summary
         FROM briefings
         WHERE scanRunId = ? AND impactRating IN (${placeholders})
         ORDER BY impactRatingScore DESC
         LIMIT ?`
      )
      .all(briefingScanRunId, ...eligibleRatings, aiConfig.maxArticlesPerBatch) as {
        id: number
        title: string
        originalUrl: string
        impactRating: string
        impactRatingScore: number
        publishedAt: number | null
        summary: string
      }[]

    if (rows.length === 0) return

    const articles = rows.map((r) => ({
      id: r.id,
      title: r.title,
      originalUrl: r.originalUrl,
      impactRating: r.impactRating,
      publishedAt: r.publishedAt,
      isExpired: isArticleExpired(r.publishedAt, r.summary ?? '', aiConfig.maxArticleAgeDays)
    }))

    // Only push event if at least one non-expired article exists
    const activeCount = articles.filter((a) => !a.isExpired).length
    if (activeCount === 0) return

    const newsSignals: DecisionSignalInput[] = rows
      .filter((r) => r.impactRating === 'CRITICAL' || r.impactRatingScore >= 30)
      .slice(0, 10)
      .map((r) => ({
        sourceModule: 'news',
        strategyKey: 'news.critical',
        signalType: 'INFO',
        direction: 'NEUTRAL',
        priority: r.impactRating === 'CRITICAL' ? 4 : 3,
        score: r.impactRatingScore,
        confidence: 70,
        title: r.title,
        summary: r.summary,
        reason: { impactRating: r.impactRating, impactRatingScore: r.impactRatingScore },
        sourceRef: { briefingId: r.id, originalUrl: r.originalUrl, scanRunId: briefingScanRunId },
        signalTime: r.publishedAt ?? Date.now(),
        dedupKey: `news:critical:${r.id}`,
      }))
    emitDecisionSignals(db, newsSignals, mainWindow ?? undefined)

    sendScanEvent(mainWindow, 'scan:aiAnalysisAvailable', { scanRunId, articles })
  } catch (err) {
    console.error('[AI] Failed to check analysis availability:', err)
  }
}

function createWindow(): void {
  const rendererFilePath = join(__dirname, '../renderer/index.html')
  const rendererEntryUrl = !app.isPackaged && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(rendererFilePath).toString()

  mainWindow = new BrowserWindow({
    width: 1680,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    title: 'RT-ResearchFlow',
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    },
    backgroundColor: '#f9fafb',
    show: false
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
  })
  mainWindow.on('will-resize', (event) => {
    event.preventDefault()
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow!.show()
  })

  const windowSession = mainWindow.webContents.session
  windowSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(shouldAllowRendererPermission())
  })
  windowSession.setPermissionCheckHandler(() => shouldAllowRendererPermission())
  windowSession.setDevicePermissionHandler(() => shouldAllowRendererPermission())

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedApplicationNavigation(url, rendererEntryUrl)) event.preventDefault()
  })
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedApplicationNavigation(url, rendererEntryUrl)) event.preventDefault()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalHttpUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl).catch((error) => {
        console.warn('[Security] Failed to open external URL:', error)
      })
    }
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(rendererEntryUrl)
  } else {
    void mainWindow.loadFile(rendererFilePath)
  }
}

async function bootstrap(): Promise<void> {
  // 0. Hide the native menu bar. Global notices live in the in-app message center.
  Menu.setApplicationMenu(null)

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
  })
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => {
    mainWindow?.close()
  })
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)
  ipcMain.handle('system:openExternal', async (event, value: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { ok: false as const, error: 'UNAUTHORIZED' as const }
    }
    const externalUrl = normalizeExternalHttpUrl(value)
    if (!externalUrl) return { ok: false as const, error: 'INVALID_URL' as const }
    try {
      await shell.openExternal(externalUrl)
      return { ok: true as const }
    } catch (error) {
      console.warn('[Security] Failed to open external URL:', error)
      return { ok: false as const, error: 'OPEN_FAILED' as const }
    }
  })
  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  // 1. Initialize database
  initDb()
  databaseReady = true
  seedBuiltInSources(BUILT_IN_SOURCES)
  initDefaultEdgesIfEmpty(getDb())
  const researchAccessStatus = await startResearchAccessTransport(getDb(), app.getPath('userData'))
  if (researchAccessStatus.state !== 'ready') {
    console.warn(`[ResearchAccess] Local transport unavailable: ${researchAccessStatus.errorCode ?? 'unknown'}`)
  }

  // 2. Register all IPC handlers
  registerBriefingHandlers()
  registerSourceHandlers()
  registerScanHandlers()
  registerSettingsHandlers()
  registerArchiveHandlers()
  registerDetailHandlers()
  registerAIHandlers(() => mainWindow)
  registerAiEvaluationHandlers()
  registerSkillHandlers()
  registerBacktestHandlers()
  registerMarketHeatmapHandlers()
  registerShortTermHandlers()
  registerMarketOverviewHandlers()
  registerScreenerHandlers()
  registerSectorFlowHandlers()
  registerTradeCalHandlers()
  registerTrendHandlers()
  registerDecisionHandlers()
  registerPortfolioHandlers(() => mainWindow)
  registerSupplyChainHandlers()
  registerIndustryResearchHandlers(() => mainWindow)
  registerDiagnosticsHandlers()
  registerDataSafetyHandlers()
  registerBaseDataPackageHandlers()
  registerConditionBlockHandlers()
  registerStrategyBacktestHandlers()
  registerMinuteDataHandlers()
  registerStrategyLabHandlers(() => mainWindow)
  registerChipStructureHandlers()
  registerStockFundamentalHandlers()
  registerResearchEvidenceHandlers()
  registerResearchAccessHandlers()
  registerResearchAgentHandlers(() => mainWindow)
  registerPremarketHandlers()

  // 3. Wire scan engine events to renderer push events
  setEventHandlers({
    onScanStarted: (runId) => {
      mainWindow && sendScanEvent(mainWindow, 'scan:started', { runId })
    },
    onScanCompleted: (runId, newCount) => {
      mainWindow && sendScanEvent(mainWindow, 'scan:completed', { runId, newCount })
      if (newCount > 0) triggerAIAnalysisIfAvailable(runId, runId)
    },
    onNewBriefings: (count) => {
      mainWindow && sendScanEvent(mainWindow, 'briefings:new', { count })
    },
    onSourceStatusChanged: (sourceId, status) => {
      mainWindow && sendScanEvent(mainWindow, 'source:statusChanged', { sourceId, status })
    },
    onSourceProgress: (sourceId, sourceName, url, status, newCount, error) => {
      mainWindow && sendScanEvent(mainWindow, 'scan:source-progress', { sourceId, sourceName, url, status, newCount, error })
    }
  })

  // 4. Create window
  createWindow()

  // 5. Start heartbeat
  startHeartbeat()

  // 6 & 7. Defer catch-up scan and scheduler until renderer signals ready (FR-001)
  // This prevents scan tasks from competing with startup rendering and slowing down UI display.
  // 使用 handle（非 handleOnce）以兼容开发模式下渲染进程热重载时的重复调用；
  // rendererReadyHandled 守卫确保副作用仅执行一次。
  let rendererReadyHandled = false
  ipcMain.handle('renderer:ready', async () => {
    if (rendererReadyHandled) return
    rendererReadyHandled = true

    const catchupResult = await runCatchUpIfNeeded((msg) => {
      mainWindow && sendScanEvent(mainWindow, 'catchup:status', { message: msg })
    })
    if (catchupResult.ran && catchupResult.newCount > 0 && catchupResult.scanRunId) {
      triggerAIAnalysisIfAvailable(null, catchupResult.scanRunId)
    }

    startScheduler()

    // 9c. 首次启动检查：kpl_concept_members 表为空时立即触发全量同步
    // 解决新数据库/首次部署时题材数据永远为空（cron 只在每周一 04:00 执行）
    const conceptCount = (getDb().prepare('SELECT COUNT(*) as c FROM kpl_concept_members').get() as { c: number }).c
    if (conceptCount === 0) {
      console.log('[Startup] kpl_concept_members is empty, triggering initial sync...')
      void runConceptMembersSyncJob()
    }

    // 9d. 启动时按需同步交易日历（FR-162）
    const dsCfg = getDataSourceConfig(getDb())
    if (dsCfg.tushareEnabled && dsCfg.tushareTokenEncrypted) {
      const token = decryptApiKey(dsCfg.tushareTokenEncrypted)
      if (token) {
        void syncTradeCalIfNeeded(getDb(), token).catch((err) =>
          console.warn('[Startup] syncTradeCalIfNeeded failed:', err instanceof Error ? err.message : String(err))
        )
      }
    }
  })

  // 8. Schedule daily data cleanup
  scheduleDailyCleanup()

  // 9a. Auto-cleanup AI analysis sessions if configured
  const db = getDb()
  const aiConfig = getAIConfig(db)
  if (aiConfig.autoCleanupDays && aiConfig.autoCleanupDays > 0) {
    const olderThanMs = aiConfig.autoCleanupDays * 24 * 60 * 60 * 1000
    const { deleted } = deleteSessionsOlderThan(db, olderThanMs, false)
    if (deleted > 0) {
      console.log(`[AI] Auto-cleaned ${deleted} old analysis session(s)`)
    }
  }

  // 9. Network status monitoring
  let lastOnlineState = net.isOnline()
  setInterval(() => {
    const online = net.isOnline()
    if (online !== lastOnlineState) {
      lastOnlineState = online
      mainWindow && sendScanEvent(mainWindow, 'network:statusChanged', { online })
    }
  }, 30_000)
}

let applicationDataReady = true
let applicationDataFailure: string | null = null
try {
  const dataPath = configureApplicationDataPaths(app)
  console.log(`[AppData] mode=${dataPath.mode} root=${dataPath.dataRoot} migrated=${dataPath.migrated}`)
} catch (error) {
  applicationDataReady = false
  applicationDataFailure = applicationDataPathErrorMessage(error)
  console.error('[AppData] Initialization failed:', error)
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.tradewatch.app')
}

if (applicationDataReady) {
  app.whenReady().then(bootstrap).catch((error) => {
    const details = error instanceof Error ? error.stack ?? error.message : String(error)
    console.error('[Startup] Bootstrap failed:', error)
    showFatalErrorWindow({
      title: '应用启动失败',
      message: '应用无法安全完成本地数据库或启动服务初始化。你的数据没有被自动覆盖，请根据下方信息检查后重新启动。',
      details,
    })
  })
} else {
  app.whenReady().then(() => {
    showFatalErrorWindow({
      title: '本地数据目录初始化失败',
      message: '应用无法安全准备本地数据目录，因此已停止继续启动，避免使用空数据或覆盖旧数据。',
      details: applicationDataFailure ?? '未提供错误详情。',
    })
  }).catch(console.error)
}

app.on('window-all-closed', () => {
  if (applicationDataReady && databaseReady) recordCloseTime()
  stopHeartbeat()
  stopScheduler()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('before-quit', () => {
  if (applicationDataReady && databaseReady) recordCloseTime()
  void stopResearchAccessTransport()
})
