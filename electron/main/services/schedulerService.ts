import {
  getPremarketNetworkEnabled,
  getSettings,
} from '../database/settingsRepository'
import { getDb } from '../database/db'
import { runScan } from './scanEngine'
import { syncIntradayForPredictedStocks, runAllPendingBacktests } from './backtestService'
import {
  fetchStockMinuteDaily,
  fetchLimitListDaily,
  fetchKplList,
  fetchKplConceptCons,
  fetchTopList,
  fetchDailyByDate,
  fetchDailyBasicByDate,
  fetchIndexPrices,
  fetchStockBasic,
  fetchTradeCal,
  fetchEastmoneyMinuteOHLCV
} from './tushareService'
import { upsertStockMinute, cleanupStockMinuteCache } from '../database/stockMinuteCacheRepository'
import {
  upsertLimitList,
  cleanupOlderThan as cleanupLimitListOlderThan
} from '../database/limitListDailyRepository'
import {
  upsertConceptDaily,
  cleanupOlderThan as cleanupConceptDailyOlderThan
} from '../database/kplConceptDailyRepository'
import { clearAllAndReplace as clearAndReplaceConceptMembers } from '../database/kplConceptMembersRepository'
import { upsertThsConceptIndex, clearAllAndReplaceThsMembers } from '../database/thsConceptMembersRepository'
import { upsertDcConceptMembers } from '../database/dcConceptMembersRepository'
import { fetchThsIndex, fetchThsMembers, fetchDcConceptCons } from './tushareService'
import {
  upsertTopList,
  cleanupOlderThan as cleanupTopListOlderThan
} from '../database/topListDailyRepository'
import { cleanupOlderThan as cleanupShortTermSignalsOlderThan } from '../database/shortTermSignalsRepository'
import {
  upsertDailyClose
} from '../database/dailyCloseCacheRepository'
import { runDailyCloseMaintenance } from './dailyCloseMaintenanceService'
import { listStockInfos, insertPricesIfMissing } from '../database/stockPriceCacheRepository'
import type { StockPriceCacheRow } from '../database/types'
import { cleanupChipsCache } from '../database/cyqChipsCacheRepository'
import { cleanupCyqPerfCache } from '../database/cyqPerfCacheRepository'
import { cleanupTopInstDaily } from '../database/topInstDailyRepository'
import { cleanupFactorCache } from '../database/stkFactorCacheRepository'
import {
  clearAllAndInsert as clearAndInsertStockBasic,
  isStockBasicCacheStale,
} from '../database/stockBasicCacheRepository'
import { cleanupScreenerResults } from '../database/stockScreenerResultsRepository'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { BrowserWindow } from 'electron'
import { refreshRtKCache, clearRtKCache } from './sharedRtKCache'
import { getOrCreateMorningAuctionSnapshot, refreshMorningAuctionSnapshot } from './morningAuctionService'
import { refreshClosingHalfHourSnapshot } from './closingHalfHourService'
import { appendTimelinePoint, clearTodayTimeline, clearConceptHeatCache } from './marketOverviewService'
import { refreshTradingCalendar, clearTradingCalendarCache } from './tradingCalendarService'
import { runChipStructureSync } from './chipStructureSyncService'
import { cleanupMonitorResults } from '../database/chipMonitorRepository'
import { archiveCurrentSnapshot } from './sectorFlowService'
import { cleanupStkAuctionCache } from '../database/stkAuctionCacheRepository'
import { cleanupBacktestDetail } from '../database/backtestDetailRepository'
import { cleanupBacktestRuns } from '../database/strategyBacktestRepository'
import { getLastNTradingDays, isTradeDay } from '../database/tradeCalRepository'
import { syncTradeCalIfNeeded } from './tradeCalSyncService'
import { cleanupTimelineOlderThan } from '../database/marketTimelineRepository'
import { recomputeTrendScoresRealtime, computeAndSaveTrendScoresEOD, cleanupTrendData } from './trendWatchlistService'
import { cleanupOldDecisionSignals, expireOldDecisionSignals } from './decisionSignalService'
import { runPortfolioForecastJob } from './portfolioForecastService'
import { HISTORICAL_DAILY_TARGET_TRADE_DAYS, runHistoricalDailySync } from './historicalDailySyncService'
import { runStartupDailyCloseCatchUp } from './dailyCloseCatchUpService'
import {
  beginAfterCloseSyncRun,
  completeAfterCloseSyncRun,
  getAfterCloseSyncRun,
  getLatestAfterCloseSyncRun,
  shouldStartAfterCloseSyncRun,
  updateAfterCloseSyncTask,
  type AfterCloseSyncRun,
  type AfterCloseSyncTaskKey,
  type AfterCloseSyncTaskStatus,
  type AfterCloseSyncTrigger,
} from '../database/afterCloseSyncRepository'
import {
  AFTER_CLOSE_SYNC_HOUR_BJ,
  AFTER_CLOSE_SYNC_MINUTE_BJ,
  getBeijingEpochForYmd,
  getBeijingYmd,
  getLastSettledCalendarDate,
  isWeekdayYmd,
  offsetYmd,
} from './marketSettlementPolicy'
import {
  buildPremarketCaptureStatus,
  captureCurrentPremarketStage,
  getNextPremarketCaptureRun,
  isPremarketTradingDay,
  PREMARKET_CAPTURE_STAGES,
  reconcilePremarketCaptureForToday,
  runPremarketCaptureStage,
  type PremarketCaptureCurrentResult,
  type PremarketCaptureStage,
  type PremarketCaptureStatusView,
} from './premarketCaptureCoordinator'
import {
  reconcilePremarketScenariosForToday,
  runPremarketScenarioStage,
} from './premarketRehearsalService'
import { runPremarketOutcomeValidation } from './premarketOutcomeService'
import { deliverPremarketScenarioNotification } from './premarketNotificationService'
import {
  PREMARKET_AUCTION_CONFIRM_HOUR_BJ,
  PREMARKET_AUCTION_CONFIRM_MINUTE_BJ,
} from './premarketCutoffPolicy'

let _timer: ReturnType<typeof setTimeout> | null = null
let _nextScanAt: number | null = null
let _backtestTimer: ReturnType<typeof setTimeout> | null = null
let _minuteCleanupTimer: ReturnType<typeof setTimeout> | null = null
// 统一盘后协调器（18:00，晚于各盘后数据实际发布时间）
let _afterCloseDailyTimer: ReturnType<typeof setTimeout> | null = null
let _conceptMembersTimer: ReturnType<typeof setTimeout> | null = null
// FR-133/sharedRtKCache: 盘中每 60s 自动刷新全市场实时行情缓存
let _rtKRefreshTimer: ReturnType<typeof setInterval> | null = null
// FR-137: 早盘竞价定时自动触发（09:15 预热 + 09:28 刷新）
let _morningAuction915Timer: ReturnType<typeof setTimeout> | null = null
let _morningAuction928Timer: ReturnType<typeof setTimeout> | null = null
let _closingHalfHourTimer: ReturnType<typeof setTimeout> | null = null
// FR-162: 交易日历月度同步 cron
let _tradeCalSyncTimer: ReturnType<typeof setTimeout> | null = null
let _portfolioForecastTimer: ReturnType<typeof setTimeout> | null = null
let _premarketOvernightTimer: ReturnType<typeof setTimeout> | null = null
let _premarketAsiaOpenTimer: ReturnType<typeof setTimeout> | null = null
let _premarketScenario845Timer: ReturnType<typeof setTimeout> | null = null
let _premarketNotification929Timer: ReturnType<typeof setTimeout> | null = null

// FR-123: 个股分钟级 K 线订阅状态（全局唯一活跃订阅）
let _activeMinuteSubscription: { stockCode: string; intervalId: ReturnType<typeof setInterval> | null } | null = null
let _consecutiveMinuteFailCount = 0
let _afterCloseRunPromise: Promise<AfterCloseSyncRun> | null = null
let _stockBasicSyncPromise: Promise<StockBasicSyncResult | null> | null = null

export function getNextScanAt(): number | null {
  return _nextScanAt
}

export function startScheduler(): void {
  stopScheduler()
  scheduleNext()
  scheduleBacktestCron()
  scheduleMinuteCleanupCron()
  // 所有盘后任务统一由 18:00 协调器触发
  scheduleAfterCloseDailySync()
  scheduleConceptMembersSync()
  scheduleRtKRefresh()
  scheduleMorningAuctionTimers()
  schedulePremarketScenario845()
  schedulePremarketNotification929()
  void reconcilePremarketNotificationForToday().catch((error) => {
    console.warn('[Premarket] notification reconcile failed:', error instanceof Error ? error.message : String(error))
  })
  void reconfigurePremarketCaptures().catch((error) => {
    console.warn('[Premarket] scheduler setup failed:', error instanceof Error ? error.message : String(error))
  })
  scheduleClosingHalfHourFinalize()
  scheduleTradeCalSync()
  schedulePortfolioForecast()
  void runStartupStockBasicSyncIfStale().catch((error) =>
    console.warn('[StockBasicSync] startup catch-up failed:', error instanceof Error ? error.message : String(error))
  )
  // 启动时立即拉一次交易日历，确保调休补班日判断正确
  const _token = getTushareTokenOrNull()
  if (_token) {
    void refreshTradingCalendar(_token).catch((error) =>
      console.warn('[TradingCalendar] startup refresh failed:', error instanceof Error ? error.message : String(error))
    )
    void runStartupDailyCloseCatchUp(getDb(), _token)
      .then((result) => console.log(`[DailyCloseCatchUp] checked=${result.totalTradeDays} synced=${result.syncedTradeDays} failed=${result.failedTradeDays}`))
      .catch((error) => console.warn('[DailyCloseCatchUp] startup catch-up failed:', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        void runStartupAfterCloseCatchUp().catch((error) =>
          console.warn('[AfterCloseSync] startup catch-up failed:', error instanceof Error ? error.message : String(error))
        )
      })
  } else {
    void runStartupAfterCloseCatchUp().catch((error) =>
      console.warn('[AfterCloseSync] startup catch-up failed:', error instanceof Error ? error.message : String(error))
    )
  }
}

export function stopScheduler(): void {
  if (_timer) {
    clearTimeout(_timer)
    _timer = null
    _nextScanAt = null
  }
  if (_backtestTimer) {
    clearTimeout(_backtestTimer)
    _backtestTimer = null
  }
  if (_minuteCleanupTimer) {
    clearTimeout(_minuteCleanupTimer)
    _minuteCleanupTimer = null
  }
  if (_afterCloseDailyTimer) {
    clearTimeout(_afterCloseDailyTimer)
    _afterCloseDailyTimer = null
  }
  if (_conceptMembersTimer) {
    clearTimeout(_conceptMembersTimer)
    _conceptMembersTimer = null
  }
  if (_rtKRefreshTimer) {
    clearInterval(_rtKRefreshTimer)
    _rtKRefreshTimer = null
  }
  if (_morningAuction915Timer) {
    clearTimeout(_morningAuction915Timer)
    _morningAuction915Timer = null
  }
  if (_morningAuction928Timer) {
    clearTimeout(_morningAuction928Timer)
    _morningAuction928Timer = null
  }
  if (_closingHalfHourTimer) {
    clearTimeout(_closingHalfHourTimer)
    _closingHalfHourTimer = null
  }
  if (_tradeCalSyncTimer) {
    clearTimeout(_tradeCalSyncTimer)
    _tradeCalSyncTimer = null
  }
  if (_portfolioForecastTimer) {
    clearTimeout(_portfolioForecastTimer)
    _portfolioForecastTimer = null
  }
  clearPremarketCaptureTimers()
  if (_premarketScenario845Timer) {
    clearTimeout(_premarketScenario845Timer)
    _premarketScenario845Timer = null
  }
  if (_premarketNotification929Timer) {
    clearTimeout(_premarketNotification929Timer)
    _premarketNotification929Timer = null
  }
  unsubscribeStockMinute()
}

export function reschedule(): void {
  if (_timer) clearTimeout(_timer)
  _timer = null
  _nextScanAt = null
  scheduleNext()
}

function scheduleNext(): void {
  const settings = getSettings()
  const intervalMs = settings.scanIntervalMinutes * 60 * 1000
  _nextScanAt = Date.now() + intervalMs

  _timer = setTimeout(async () => {
    try {
      await runScan('SCHEDULED')
    } catch (err) {
      console.error('[Scheduler] Scan failed:', err)
    }
    scheduleNext()
  }, intervalMs)
}

/**
 * Schedule the 15:05 (Beijing time) daily backtest cron.
 * Calculates ms until next 15:05 BJ time, then repeats every 24h.
 */
function scheduleBacktestCron(): void {
  const now = Date.now()
  const bjNow = new Date(now + 8 * 60 * 60 * 1000)

  // Target: 15:05 Beijing time today
  const target = new Date(bjNow)
  target.setUTCHours(15, 5, 0, 0)

  // If already past 15:05 today, schedule for tomorrow
  let delayMs = target.getTime() - bjNow.getTime()
  if (delayMs <= 0) {
    delayMs += 24 * 60 * 60 * 1000
  }

  _backtestTimer = setTimeout(async () => {
    await runBacktestCronJob()
    // Reschedule for next day
    scheduleBacktestCron()
  }, delayMs)
}

async function runBacktestCronJob(): Promise<void> {
  // Only run on weekdays (Monday=1 .. Friday=5)
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const dow = bjNow.getUTCDay()
  if (dow === 0 || dow === 6) return

  try {
    const db = getDb()
    const synced = await syncIntradayForPredictedStocks(db)
    const backtested = runAllPendingBacktests(db)
    console.log(`[Backtest Cron] Synced ${synced} intraday entries, backtested ${backtested} forecasts`)
  } catch (err) {
    console.error('[Backtest Cron] Error:', err)
  }
}

// ──────────────────────────────────────────────────────────────────────
// FR-123: 个股分钟级 K 线订阅 + 60s 轮询 + 16:00 cleanup cron
// ──────────────────────────────────────────────────────────────────────

/** 主进程内联版本: 判断当前是否在 A 股交易时段（周一~周五 09:30–11:30、13:00–15:00 北京时间） */
function isInTradingHoursMain(): boolean {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const day = bjNow.getUTCDay()
  if (day < 1 || day > 5) return false
  const totalMin = bjNow.getUTCHours() * 60 + bjNow.getUTCMinutes()
  return (totalMin >= 9 * 60 + 30 && totalMin < 11 * 60 + 30)
      || (totalMin >= 13 * 60 && totalMin < 15 * 60)
}

/** 6 位 A 股代码 → Tushare ts_code 后缀 */
function toTsCodeForMinute(code: string): string {
  if (/^(43|83|87|92|88|430|831|832|833|834|835|836|837|838|839|870|871|872|873|874|875|876|877|878|879|880|881|882|883|884|885|886|887|888|889|890|891|892|893|894|895|896|897|898|899|900|901|902|903|904|905|906|907|908|909|910|911|912|913|914|915|916|917|918|919|920)/.test(code)) return `${code}.BJ`
  if (code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) return `${code}.SH`
  return `${code}.SZ`
}

/**
 * 拉取一次当日分钟 K 线并写入 DB; 成功推 stockMinuteUpdated 事件。
 *
 * 数据源优先级：Tushare 374 rt_min（有权限时精度/实时性最佳）→ 失败/无权限回退东财 push2his
 * klt=1 完整 OHLCV（免 token，60s 节奏经探针验证不触发反爬）。
 * 仅当两者都连续失败 3 次才推 fallback 并自动 unsubscribe。
 */
async function pullStockMinute(stockCode: string): Promise<void> {
  const db = getDb()
  const dsCfg = getDataSourceConfig(db)
  let gotData = false

  // 1. 优先 Tushare rt_min_daily（doc_id=369，一次拉全天分钟 K）
  if (dsCfg.tushareEnabled && dsCfg.tushareTokenEncrypted) {
    const token = decryptApiKey(dsCfg.tushareTokenEncrypted)
    if (token) {
      try {
        const rows = await fetchStockMinuteDaily(token, toTsCodeForMinute(stockCode))
        if (rows.length > 0) {
          upsertStockMinute(db, rows)
          gotData = true
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[MinuteCron] Tushare pull ${stockCode} failed, fallback to Eastmoney: ${msg}`)
      }
    }
  }

  // 2. 无 Tushare / Tushare 未取到 → 东财 push2his klt=1 完整 OHLCV（免 token）
  if (!gotData) {
    try {
      const bars = await fetchEastmoneyMinuteOHLCV(stockCode)
      if (bars.length > 0) {
        const now = Date.now()
        upsertStockMinute(db, bars.map((b) => ({
          stockCode,
          tradeDate: b.tradeDate,
          tsMinute: b.tsMinute,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          vol: b.vol,
          amount: b.amount,
          fetchedAt: now
        })))
        gotData = true
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[MinuteCron] Eastmoney pull ${stockCode} failed: ${msg}`)
    }
  }

  // 3. 结果处理
  if (gotData) {
    _consecutiveMinuteFailCount = 0
    BrowserWindow.getAllWindows().forEach((w) =>
      w.webContents.send('datasource:stockMinuteUpdated', { stockCode })
    )
  } else {
    _consecutiveMinuteFailCount++
    console.warn(`[MinuteCron] pull ${stockCode} got no data (${_consecutiveMinuteFailCount}/3)`)
    if (_consecutiveMinuteFailCount >= 3) {
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send('datasource:stockMinuteFallback', { stockCode })
      )
      unsubscribeStockMinute()
    }
  }
}

/** 订阅个股分钟 K 线轮询. 同股重复调用幂等; 切换股票自动 unsubscribe 旧订阅. */
export function subscribeStockMinute(stockCode: string): void {
  if (_activeMinuteSubscription?.stockCode === stockCode) return
  if (_activeMinuteSubscription) unsubscribeStockMinute()

  // 立即拉一次（无论是否盘中, 用于补全当日数据）
  void pullStockMinute(stockCode)

  const intervalId = setInterval(() => {
    if (!isInTradingHoursMain()) return
    void pullStockMinute(stockCode)
  }, 60_000)

  _activeMinuteSubscription = { stockCode, intervalId }
  console.log(`[MinuteCron] subscribeStockMinute(${stockCode}) started`)
}

/** 取消当前活跃订阅. 幂等. */
export function unsubscribeStockMinute(): void {
  if (_activeMinuteSubscription?.intervalId) {
    clearInterval(_activeMinuteSubscription.intervalId)
  }
  if (_activeMinuteSubscription) {
    console.log(`[MinuteCron] unsubscribeStockMinute(${_activeMinuteSubscription.stockCode})`)
  }
  _activeMinuteSubscription = null
  _consecutiveMinuteFailCount = 0
}

/** 每日北京时间 16:00 清理 7 天前的分钟 K 缓存 */
function scheduleMinuteCleanupCron(): void {
  const now = Date.now()
  const bjNow = new Date(now + 8 * 60 * 60 * 1000)
  const target = new Date(bjNow)
  target.setUTCHours(16, 0, 0, 0)
  let delayMs = target.getTime() - bjNow.getTime()
  if (delayMs <= 0) delayMs += 24 * 60 * 60 * 1000

  _minuteCleanupTimer = setTimeout(() => {
    const db = getDb()
    try {
      const removed = cleanupStockMinuteCache(db, 7)
      console.log(`[MinuteCleanup] removed ${removed} rows older than 7 days`)
    } catch (err) {
      console.error('[MinuteCleanup] Error:', err)
    }

    try {
      const result = runDailyCloseMaintenance(db)
      console.log(`[DailyCloseCleanup] removed=${result.removedRows ?? 0} remaining_trade_days=${result.remainingTradeDays ?? 0}`)
    } catch (err) {
      console.error('[DailyCloseCleanup] Error:', err)
    }

    // FR-124: 与 16:00 时机合并清理短线策略相关过期数据
    try {
        const r1 = cleanupLimitListOlderThan(db, 90)
        const r2 = cleanupConceptDailyOlderThan(db, 90)
        const r3 = cleanupTopListOlderThan(db, 180)
        const r4 = cleanupShortTermSignalsOlderThan(db, 30)
        const r6 = cleanupChipsCache(db, 30)
        const r7 = cleanupFactorCache(db, 30)
        const r8 = cleanupScreenerResults(db, 30)
        const r9 = cleanupMonitorResults(db, 30)
        const r10 = cleanupStkAuctionCache(db, 90)
        const r11 = cleanupBacktestDetail(db, 180)
        const r12 = cleanupTimelineOlderThan(db, 7)
        const r13 = cleanupOldDecisionSignals(db, 180)
        const r14 = cleanupBacktestRuns(db, 180)
        const r15 = cleanupCyqPerfCache(db, 90)
        const r16 = cleanupTopInstDaily(db, 180)
        expireOldDecisionSignals(db)
        // FR-164: 清理趋势数据
        cleanupTrendData(db)
        console.log(`[ShortTermCleanup] limit_list=${r1} kpl_concept=${r2} top_list=${r3} signals=${r4} chips=${r6} factor=${r7} screener=${r8} chip_monitor=${r9} stk_auction=${r10} backtest_detail=${r11} timeline=${r12} decision=${r13} strategy_backtest=${r14} cyq_perf=${r15} top_inst=${r16}`)
    } catch (err) {
      console.error('[ShortTermCleanup] Error:', err)
    }
    scheduleMinuteCleanupCron()
  }, delayMs)
}

// ──────────────────────────────────────────────────────────
// FR-124 短线策略数据同步 cron
// ──────────────────────────────────────────────────────────

/** 计算到指定北京时间（hh:mm）的下次延迟毫秒（已过则推到次日） */
function delayUntilBjTime(hh: number, mm: number): number {
  const now = Date.now()
  const bjNow = new Date(now + 8 * 60 * 60 * 1000)
  const target = new Date(bjNow)
  target.setUTCHours(hh, mm, 0, 0)
  let delayMs = target.getTime() - bjNow.getTime()
  if (delayMs <= 0) delayMs += 24 * 60 * 60 * 1000
  return delayMs
}

function getBjTodayYmd(): string {
  return getBeijingYmd()
}

/** 将 YYYYMMDD 格式日期往前/后偏移 days 天 */
function offsetBjDateYmd(ymd: string, days: number): string {
  return offsetYmd(ymd, days)
}

function isBjWeekday(): boolean {
  const dow = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCDay()
  return dow !== 0 && dow !== 6
}

/**
 * 判断指定 YYYYMMDD 日期是否为 A 股交易日。
 * 优先读 trade_cal DB（精确识别调休补班）；表为空时 fallback 到 weekday 判断。
 */
function isTradingDay(ymd: string): boolean {
  try {
    const result = isTradeDay(getDb(), ymd)
    if (result !== null) return result
  } catch {
    // DB 不可用时使用 fallback
  }
  return isWeekdayYmd(ymd)
}

function clearPremarketCaptureTimers(): void {
  if (_premarketOvernightTimer) {
    clearTimeout(_premarketOvernightTimer)
    _premarketOvernightTimer = null
  }
  if (_premarketAsiaOpenTimer) {
    clearTimeout(_premarketAsiaOpenTimer)
    _premarketAsiaOpenTimer = null
  }
}

function setPremarketTimer(
  stage: PremarketCaptureStage,
  timer: ReturnType<typeof setTimeout> | null,
): void {
  if (stage === 'overnight') _premarketOvernightTimer = timer
  else _premarketAsiaOpenTimer = timer
}

function schedulePremarketCaptureStage(stage: PremarketCaptureStage): void {
  if (!getPremarketNetworkEnabled()) return
  const nextRun = getNextPremarketCaptureRun(getDb(), stage)
  if (!nextRun) return
  const timer = setTimeout(async () => {
    setPremarketTimer(stage, null)
    try {
      if (!getPremarketNetworkEnabled()) return
      const now = Date.now()
      const tradeDate = getBeijingYmd(now)
      if (!isPremarketTradingDay(getDb(), tradeDate)) return
      await runPremarketCaptureStage(getDb(), stage, now)
    } catch (error) {
      console.warn(`[Premarket] ${stage} capture failed:`, error instanceof Error ? error.message : String(error))
    } finally {
      if (getPremarketNetworkEnabled()) schedulePremarketCaptureStage(stage)
    }
  }, Math.max(0, nextRun.scheduledAt - Date.now()))
  setPremarketTimer(stage, timer)
}

function schedulePremarketScenario845(): void {
  const nextRun = getNextPremarketCaptureRun(getDb(), 'asia_open')
  if (!nextRun) return
  _premarketScenario845Timer = setTimeout(async () => {
    _premarketScenario845Timer = null
    try {
      if (getPremarketNetworkEnabled()) {
        await runPremarketCaptureStage(getDb(), 'asia_open', Date.now())
      }
      await runPremarketScenarioStage(getDb(), {
        tradeDate: nextRun.tradeDate,
        stage: 'asia_open',
        now: Date.now(),
      })
    } catch (error) {
      console.warn('[Premarket] 08:45 scenario failed:', error instanceof Error ? error.message : String(error))
    } finally {
      schedulePremarketScenario845()
    }
  }, Math.max(0, nextRun.scheduledAt - Date.now()))
}

export const PREMARKET_NOTIFICATION_HOUR_BJ = 9
export const PREMARKET_NOTIFICATION_MINUTE_BJ = 29
export const PREMARKET_NOTIFICATION_GRACE_MS = 5 * 60 * 1000

export function getNextPremarketNotificationRun(now = Date.now()): { tradeDate: string; scheduledAt: number } | null {
  let tradeDate = getBeijingYmd(now)
  let scheduledAt = getBeijingEpochForYmd(
    tradeDate,
    PREMARKET_NOTIFICATION_HOUR_BJ,
    PREMARKET_NOTIFICATION_MINUTE_BJ,
  )
  if (scheduledAt <= now) tradeDate = offsetYmd(tradeDate, 1)
  for (let offset = 0; offset < 370; offset += 1) {
    const candidate = offsetYmd(tradeDate, offset)
    if (!isTradingDay(candidate)) continue
    scheduledAt = getBeijingEpochForYmd(
      candidate,
      PREMARKET_NOTIFICATION_HOUR_BJ,
      PREMARKET_NOTIFICATION_MINUTE_BJ,
    )
    return { tradeDate: candidate, scheduledAt }
  }
  return null
}

export function schedulePremarketNotification929(): void {
  if (_premarketNotification929Timer) clearTimeout(_premarketNotification929Timer)
  const next = getNextPremarketNotificationRun()
  if (!next) return
  _premarketNotification929Timer = setTimeout(() => {
    _premarketNotification929Timer = null
    try {
      const win = BrowserWindow.getAllWindows()[0] ?? undefined
      deliverPremarketScenarioNotification(getDb(), next.tradeDate, win)
    } catch (error) {
      console.warn('[Premarket] 09:29 notification failed:', error instanceof Error ? error.message : String(error))
    } finally {
      schedulePremarketNotification929()
    }
  }, Math.max(0, next.scheduledAt - Date.now()))
}

export async function reconcilePremarketNotificationForToday(now = Date.now()): Promise<void> {
  const tradeDate = getBeijingYmd(now)
  if (!isTradingDay(tradeDate)) return
  const scheduledAt = getBeijingEpochForYmd(
    tradeDate,
    PREMARKET_NOTIFICATION_HOUR_BJ,
    PREMARKET_NOTIFICATION_MINUTE_BJ,
  )
  if (now < scheduledAt || now > scheduledAt + PREMARKET_NOTIFICATION_GRACE_MS) return
  const win = BrowserWindow.getAllWindows()[0] ?? undefined
  deliverPremarketScenarioNotification(getDb(), tradeDate, win, now)
}

export async function reconfigurePremarketCaptures(now = Date.now()): Promise<void> {
  clearPremarketCaptureTimers()
  const enabled = getPremarketNetworkEnabled()
  if (enabled) {
    for (const stage of PREMARKET_CAPTURE_STAGES) schedulePremarketCaptureStage(stage)
    await reconcilePremarketCaptureForToday(getDb(), true, now)
  }
  await reconcilePremarketScenariosForToday(getDb(), now)
}

export function getPremarketCaptureScheduleStatus(
  now = Date.now(),
): PremarketCaptureStatusView {
  const enabled = getPremarketNetworkEnabled()
  return buildPremarketCaptureStatus(
    getDb(),
    enabled,
    enabled && _premarketOvernightTimer !== null && _premarketAsiaOpenTimer !== null,
    now,
  )
}

export async function captureCurrentPremarketWindow(
  now = Date.now(),
): Promise<PremarketCaptureCurrentResult> {
  return captureCurrentPremarketStage(getDb(), getPremarketNetworkEnabled(), now)
}

/** 仅工作日生效；获取 Tushare token，未配置返回 null */
function getTushareTokenOrNull(): string | null {
  try {
    const cfg = getDataSourceConfig(getDb())
    if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted) return null
    return decryptApiKey(cfg.tushareTokenEncrypted)
  } catch {
    return null
  }
}

/** 通用：失败重试包装（最多 3 次，指数退避 1s/3s/9s） */
async function withCronRetry<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const delays = [1000, 3000, 9000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${name}] Attempt ${attempt + 1} failed: ${msg}`)
      if (attempt < delays.length - 1) {
        await new Promise((r) => setTimeout(r, delays[attempt]))
      }
    }
  }
  console.error(`[${name}] All 3 retries failed, will retry next cron cycle`)
  return null
}

export interface AfterCloseScheduleStatus {
  scheduledTime: '18:00'
  active: boolean
  nextRunAt: number
  lastRun: AfterCloseSyncRun | null
}

function getNextAfterCloseRunAt(now = Date.now()): number {
  let tradeDate = getBeijingYmd(now)
  let target = getBeijingEpochForYmd(tradeDate)
  if (target <= now) tradeDate = offsetYmd(tradeDate, 1)
  for (let offset = 0; offset < 370; offset += 1) {
    const candidate = offsetYmd(tradeDate, offset)
    if (isTradingDay(candidate)) return getBeijingEpochForYmd(candidate)
  }
  return getBeijingEpochForYmd(tradeDate)
}

export function getAfterCloseScheduleStatus(now = Date.now()): AfterCloseScheduleStatus {
  return {
    scheduledTime: '18:00',
    active: _afterCloseDailyTimer !== null,
    nextRunAt: getNextAfterCloseRunAt(now),
    lastRun: getLatestAfterCloseSyncRun(getDb()),
  }
}

function resolveLatestSettledTradeDate(now = Date.now()): string | null {
  const cutoffDate = getLastSettledCalendarDate(now)
  const calendarDates = getLastNTradingDays(getDb(), 1, cutoffDate)
  if (calendarDates.length > 0) return calendarDates[0]
  for (let offset = 0; offset < 10; offset += 1) {
    const candidate = offsetYmd(cutoffDate, -offset)
    if (isWeekdayYmd(candidate)) return candidate
  }
  return null
}

async function runTrackedAfterCloseTask(
  tradeDate: string,
  taskKey: AfterCloseSyncTaskKey,
  task: () => Promise<{ status?: Extract<AfterCloseSyncTaskStatus, 'completed' | 'partial'>; message?: string } | void>,
): Promise<{ taskKey: AfterCloseSyncTaskKey; status: AfterCloseSyncTaskStatus; message: string | null }> {
  const db = getDb()
  updateAfterCloseSyncTask(db, tradeDate, taskKey, 'running', null)
  try {
    const result = await task()
    const status = result?.status ?? 'completed'
    const message = result?.message ?? null
    updateAfterCloseSyncTask(db, tradeDate, taskKey, status, message)
    return { taskKey, status, message }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    updateAfterCloseSyncTask(db, tradeDate, taskKey, 'failed', message)
    console.warn(`[AfterCloseSync] ${taskKey} failed for ${tradeDate}:`, message)
    return { taskKey, status: 'failed', message }
  }
}

function markAfterCloseTaskBlocked(
  tradeDate: string,
  taskKey: AfterCloseSyncTaskKey,
  message: string,
): { taskKey: AfterCloseSyncTaskKey; status: 'blocked'; message: string } {
  updateAfterCloseSyncTask(getDb(), tradeDate, taskKey, 'blocked', message)
  return { taskKey, status: 'blocked', message }
}

export function runUnifiedAfterCloseSyncJob(
  tradeDate = getBjTodayYmd(),
  trigger: AfterCloseSyncTrigger = 'scheduled',
): Promise<AfterCloseSyncRun> {
  if (_afterCloseRunPromise) return _afterCloseRunPromise
  const db = getDb()
  const existing = getAfterCloseSyncRun(db, tradeDate)
  if (!shouldStartAfterCloseSyncRun(existing)) {
    if (!existing) return Promise.reject(new Error('AFTER_CLOSE_RUN_NOT_FOUND'))
    return Promise.resolve(existing)
  }

  let promise: Promise<AfterCloseSyncRun>
  promise = (async () => {
    beginAfterCloseSyncRun(db, tradeDate, trigger)
    const results: Array<{ taskKey: AfterCloseSyncTaskKey; status: AfterCloseSyncTaskStatus; message: string | null }> = []
    const token = getTushareTokenOrNull()

    if (!token) {
      const message = 'TUSHARE_DISABLED'
      results.push(markAfterCloseTaskBlocked(tradeDate, 'security_master', message))
      results.push(markAfterCloseTaskBlocked(tradeDate, 'short_term_daily', message))
      results.push(markAfterCloseTaskBlocked(tradeDate, 'market_daily', message))
      results.push(markAfterCloseTaskBlocked(tradeDate, 'chip_structure', message))
    } else {
      results.push(await runTrackedAfterCloseTask(tradeDate, 'security_master', async () => {
        const synced = await runStockBasicSyncJob()
        if (!synced) throw new Error('STOCK_BASIC_SYNC_INCOMPLETE')
        const message = `证券 ${synced.rowCount}，恢复候选 ${synced.remappedCandidates}，登记公司 ${synced.materializedProjectCompanies}`
        return synced.remapError
          ? { status: 'partial', message: `${message}；候选重映射失败：${synced.remapError}` }
          : { message }
      }))
      results.push(await runTrackedAfterCloseTask(tradeDate, 'short_term_daily', async () => {
        const completed = await runAfterCloseDailySyncJob(tradeDate)
        if (!completed) throw new Error('SHORT_TERM_DAILY_INCOMPLETE')
      }))
      results.push(await runTrackedAfterCloseTask(tradeDate, 'market_daily', async () => {
        const completed = await runTopListSyncJob(tradeDate)
        if (!completed) throw new Error('MARKET_DAILY_INCOMPLETE')
      }))
      results.push(await runTrackedAfterCloseTask(tradeDate, 'chip_structure', async () => {
        const win = BrowserWindow.getAllWindows()[0] ?? undefined
        const status = await runChipStructureSync(db, token, {
          scope: 'structure',
          tradeDate,
          webContents: win?.webContents,
        })
        if (status.state === 'failed') throw new Error('CHIP_STRUCTURE_FAILED')
        if (status.state === 'partial') {
          return {
            status: 'partial',
            message: `成功 ${status.success}，部分 ${status.partial}，失败 ${status.failed}`,
          }
        }
        return { message: `成功 ${status.success}，无记录 ${status.noRecord}` }
      }))
    }

    results.push(await runTrackedAfterCloseTask(tradeDate, 'sector_snapshot', async () => {
      await archiveCurrentSnapshot(db)
    }))
    results.push(await runTrackedAfterCloseTask(tradeDate, 'trend_scores', async () => {
      const eodWin = BrowserWindow.getAllWindows()[0] ?? undefined
      await computeAndSaveTrendScoresEOD(db, eodWin)
    }))
    results.push(await runTrackedAfterCloseTask(tradeDate, 'premarket_validation', async () => {
      const validation = runPremarketOutcomeValidation(db, tradeDate)
      if (!validation) return { status: 'partial', message: 'AUCTION_SCENARIO_VERSION_MISSING' }
      const counts = validation.record.validation.counts
      return {
        status: validation.record.status === 'matured' ? 'completed' : 'partial',
        message: `成熟 ${counts.matured}，缺失 ${counts.missing}${validation.reused ? '，复用修订' : ''}`,
      }
    }))

    const completedCount = results.filter((result) => result.status === 'completed').length
    const blockedCount = results.filter((result) => result.status === 'blocked').length
    const problemResults = results.filter((result) => result.status !== 'completed')
    const status = problemResults.length === 0
      ? 'completed'
      : completedCount > 0
        ? 'partial'
        : blockedCount === results.length
          ? 'blocked'
          : 'failed'
    const errorSummary = problemResults.length > 0
      ? problemResults.map((result) => `${result.taskKey}:${result.message ?? result.status}`).join('; ').slice(0, 1000)
      : null
    const completed = completeAfterCloseSyncRun(db, tradeDate, status, errorSummary)
    console.log(`[AfterCloseSync] ${tradeDate} ${trigger} ${completed.status}`)
    return completed
  })().finally(() => {
    if (_afterCloseRunPromise === promise) _afterCloseRunPromise = null
  })
  _afterCloseRunPromise = promise
  return promise
}

export async function runStartupAfterCloseCatchUp(now = Date.now()): Promise<AfterCloseSyncRun | null> {
  const tradeDate = resolveLatestSettledTradeDate(now)
  if (!tradeDate) return null
  return runUnifiedAfterCloseSyncJob(tradeDate, 'startup_catch_up')
}

/** 每个交易日北京时间 18:00 统一执行全部盘后任务。 */
export function scheduleAfterCloseDailySync(): void {
  _afterCloseDailyTimer = setTimeout(async () => {
    try {
      const tradeDate = getBjTodayYmd()
      if (isTradingDay(tradeDate)) await runUnifiedAfterCloseSyncJob(tradeDate, 'scheduled')
    } catch (error) {
      console.warn('[AfterCloseSync] 18:00 coordinator failed:', error instanceof Error ? error.message : String(error))
    } finally {
      scheduleAfterCloseDailySync()
    }
  }, delayUntilBjTime(AFTER_CLOSE_SYNC_HOUR_BJ, AFTER_CLOSE_SYNC_MINUTE_BJ))
}

export async function runAfterCloseDailySyncJob(tradeDate = getBjTodayYmd()): Promise<boolean> {
  const token = getTushareTokenOrNull()
  if (!token) return false
  // limit_list_d：今日无数据时往前回溯，最多 7 个日历日（覆盖节假日）
  const limitListResult = await withCronRetry('AfterCloseDaily.limit_list_d', async () => {
    let found = false
    for (let offset = 0; offset < 7 && !found; offset++) {
      const dateStr = offsetBjDateYmd(tradeDate, -offset)
      const rows = await fetchLimitListDaily(token, dateStr)
      if (rows.length > 0) {
        upsertLimitList(getDb(), rows)
        console.log(`[AfterCloseDaily] limit_list_d ${dateStr} upserted ${rows.length} rows`)
        found = true
      } else {
        console.log(
          `[AfterCloseDaily] limit_list_d ${dateStr} returned 0 rows, trying previous day…`
        )
      }
    }
    if (!found) {
      console.log(`[AfterCloseDaily] limit_list_d: no data found in last 7 days`)
    }
    return found
  })
  // kpl_list：同样回溯
  const kplListResult = await withCronRetry('AfterCloseDaily.kpl_list', async () => {
    let found = false
    for (let offset = 0; offset < 7 && !found; offset++) {
      const dateStr = offsetBjDateYmd(tradeDate, -offset)
      const rows = await fetchKplList(token, dateStr)
      if (rows.length > 0) {
        upsertConceptDaily(getDb(), rows)
        console.log(`[AfterCloseDaily] kpl_list ${dateStr} upserted ${rows.length} rows`)
        found = true
      } else {
        console.log(
          `[AfterCloseDaily] kpl_list ${dateStr} returned 0 rows, trying previous day…`
        )
      }
    }
    if (!found) {
      console.log(`[AfterCloseDaily] kpl_list: no data found in last 7 days`)
    }
    return found
  })
  return limitListResult === true && kplListResult === true
}

/** 统一盘后批次中的龙虎榜、全市场日K和个性选股任务。 */
export async function runTopListSyncJob(tradeDate = getBjTodayYmd()): Promise<boolean> {
  const token = getTushareTokenOrNull()
  if (!token) return false
  // top_list 盘后发布，今日无数据时往前回溯
  const topListResult = await withCronRetry('TopListSync', async () => {
    let found = false
    for (let offset = 0; offset < 7 && !found; offset++) {
      const dateStr = offsetBjDateYmd(tradeDate, -offset)
      const rows = await fetchTopList(token, dateStr)
      if (rows.length > 0) {
        upsertTopList(getDb(), rows)
        console.log(`[TopListSync] top_list ${dateStr} upserted ${rows.length} rows`)
        found = true
      } else {
        console.log(`[TopListSync] top_list ${dateStr} returned 0 rows, trying previous day…`)
      }
    }
    if (!found) {
      console.log(`[TopListSync] top_list: no data found in last 7 days`)
    }
    return found
  })
  const dailyCompleted = await runDailyOHLCVSyncJob(tradeDate)
  let screenerCompleted = false
  try {
    const { runScreener } = await import('./stockScreenerService')
    runScreener(getDb(), tradeDate)
    screenerCompleted = true
    console.log(`[Screener] daily screener run completed for ${tradeDate}`)
  } catch (err) {
    console.warn('[Screener] daily screener run failed:', err instanceof Error ? err.message : String(err))
  }
  return topListResult === true && dailyCompleted && screenerCompleted
}

/**
 * FR-139: 全市场当日 OHLCV 全量写入 daily_close_cache。
 * 每日 18:00 统一盘后批次触发，约 5000 行覆盖全 A 股。
 * 为 hover 微缩蜡烛图提供离线数据，避免逐股实时补拉。
 */
export async function runDailyOHLCVSyncJob(tradeDate: string): Promise<boolean> {
  const token = getTushareTokenOrNull()
  if (!token) return false
  const result = await withCronRetry('DailyOHLCVSync', async () => {
    const rows = await fetchDailyByDate(token, tradeDate)
    if (rows.length === 0) {
      console.log(`[DailyOHLCVSync] ${tradeDate} returned 0 rows, skipping`)
      return false
    }
    let mergedRows = rows
    try {
      const basics = await fetchDailyBasicByDate(token, tradeDate)
      console.log(`[DailyOHLCVSync] ${tradeDate} daily_basic rows=${basics.length}`)
      if (basics.length > 0) {
        const trMap = new Map(basics.map((r) => [r.tsCode, r.turnoverRate]))
        mergedRows = rows.map((r) => ({
          ...r,
          turnoverRate: trMap.get(r.tsCode) ?? r.turnoverRate ?? null,
        }))
        const mergedCount = mergedRows.filter(r => r.turnoverRate != null).length
        console.log(`[DailyOHLCVSync] ${tradeDate} merged turnover_rate=${mergedCount}/${mergedRows.length}`)
      } else {
        console.warn(`[DailyOHLCVSync] ${tradeDate} daily_basic returned 0 rows, turnover_rate remains null`)
      }
    } catch (err) {
      console.warn('[DailyOHLCVSync] daily_basic merge failed:', err instanceof Error ? err.message : String(err))
    }

    upsertDailyClose(getDb(), mergedRows)
    console.log(`[DailyOHLCVSync] ${tradeDate} upserted ${mergedRows.length} rows`)

    // 方案 A：同步自选股到 stock_price_cache，填补每日空缺交易日
    await syncWatchlistToStockPriceCache(mergedRows, tradeDate)
    return true
  })
  return result === true
}

/**
 * 每日 OHLCV 写完 daily_close_cache 后，自动将自选股当日数据同步到 stock_price_cache。
 * - 普通 A 股：直接从刚写好的 mergedRows 取数，INSERT OR IGNORE（不覆盖已有记录的 amount 等字段）
 * - 预设指数：调 Eastmoney Kline API（fetchIndexPrices），无 Tushare 积分消耗
 */
async function syncWatchlistToStockPriceCache(dailyRows: DailyRow[], tradeDate: string): Promise<void> {
  const PRESET_INDICES = ['000001.SH', '399001.SZ', '399006.SZ']
  const db = getDb()
  const watchlist = listStockInfos(db)
  if (watchlist.length === 0) return

  // 构建当日快速查找 Map（tsCode → DailyRow）
  const dailyMap = new Map(dailyRows.map((r) => [r.tsCode, r]))

  const toInsert: StockPriceCacheRow[] = []
  const nowMs = Date.now()

  for (const { stockCode } of watchlist) {
    if (PRESET_INDICES.includes(stockCode)) continue // 指数走 Eastmoney 路径
    const daily = dailyMap.get(stockCode)
    if (!daily) continue // 当日停牌或未在 daily 数据中
    toInsert.push({
      stockCode,
      tradeDate: daily.tradeDate,
      open: daily.open ?? null,
      high: daily.high ?? null,
      low: daily.low ?? null,
      close: daily.close,
      volume: daily.vol ?? null,
      amount: null, // daily API 未拉 amount；INSERT OR IGNORE 保留已有精确值
      fetchedAt: nowMs,
    })
  }

  if (toInsert.length > 0) {
    insertPricesIfMissing(db, toInsert)
    console.log(`[SyncWatchlist] ${tradeDate}: filled ${toInsert.length} row(s) in stock_price_cache`)
  }

  // 预设指数：调 Eastmoney API 更新，增量模式（force=false）
  for (const tsCode of PRESET_INDICES) {
    if (watchlist.some((s) => s.stockCode === tsCode)) {
      try {
        await fetchIndexPrices(db, tsCode, false)
      } catch {
        // Eastmoney 失败静默处理，不影响其他股票
      }
    }
  }
}

/**
 * DailyRow 类型（本地别名，避免在此文件重复导入 tushareService 类型）
 * 注意：此处仅用于 syncWatchlistToStockPriceCache 内部，不对外暴露。
 */
type DailyRow = Awaited<ReturnType<typeof fetchDailyByDate>>[number]

/** 每周一北京 04:00：只同步当前题材源的成分股。证券主数据由18:00协调器独立负责。 */
export function scheduleConceptMembersSync(): void {
  _conceptMembersTimer = setTimeout(async () => {
    const dow = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCDay()
    if (dow === 1) {
      await runConceptMembersSyncJob()
    }
    scheduleConceptMembersSync()
  }, delayUntilBjTime(4, 0))
}

export async function runConceptMembersSyncJob(): Promise<void> {
  const db = getDb()
  // 读取当前选择的题材数据源（默认 kpl）
  const sourceRow = db.prepare('SELECT concept_source FROM app_settings WHERE id = 1').get() as { concept_source: string | null } | undefined
  const source = sourceRow?.concept_source === 'ths' ? 'ths' : sourceRow?.concept_source === 'dc' ? 'dc' : 'kpl'
  await runConceptMembersSyncForSource(source)
}

/**
 * 按指定数据源同步题材成分股（可手动触发）
 * - kpl: fetchKplConceptCons + clearAndReplaceConceptMembers（全量替换）
 * - ths: fetchThsIndex → 遍历每个概念 fetchThsMembers → clearAllAndReplaceThsMembers（全量替换）
 * - dc:  fetchDcConceptCons(tradeDate) → upsertDcConceptMembers（按日累积，不清空历史）
 */
export async function runConceptMembersSyncForSource(source: string): Promise<void> {
  const token = getTushareTokenOrNull()
  if (!token) return
  const db = getDb()
  const today = getBjTodayYmd()

  if (source === 'ths') {
    await withCronRetry('ConceptMembersSync-THS', async () => {
      const pushProgress = (current: number, total: number, message: string) => {
        BrowserWindow.getAllWindows().forEach(w =>
          w.webContents.send('shortTerm:conceptSyncProgress', { source: 'ths', current, total, message })
        )
      }

      console.log('[ConceptMembersSync-THS] fetching ths_index...')
      pushProgress(0, 0, '正在拉取同花顺概念目录…')
      const indexItems = await fetchThsIndex(token)
      if (indexItems.length === 0) {
        console.warn('[ConceptMembersSync-THS] ths_index returned 0 items, skipping')
        pushProgress(0, 0, '概念目录为空，请检查 Tushare 积分或网络')
        return
      }
      // 写入概念目录
      upsertThsConceptIndex(db, indexItems.map(r => ({ tsCode: r.tsCode, name: r.name, count: r.count })))
      console.log(`[ConceptMembersSync-THS] index upserted ${indexItems.length} concepts, fetching members...`)
      pushProgress(0, indexItems.length, `已获取 ${indexItems.length} 个概念，开始同步成分股…`)

      // 逐个概念拉成员股（分批，每批间隔 3s 防限速）
      const allMembers: Array<{ tsCode: string; conCode: string; conName: string | null }> = []
      const BATCH_SIZE = 10
      for (let i = 0; i < indexItems.length; i += BATCH_SIZE) {
        const batch = indexItems.slice(i, i + BATCH_SIZE)
        const results = await Promise.allSettled(
          batch.map(idxItem =>
            fetchThsMembers(token, idxItem.tsCode).then(members =>
              // 将 API 返回的成分股名替换为概念名（idxItem.name），
              // 因为 ths_member.name 是股票名，con_name 列应存概念名
              members.map(m => ({ ...m, conName: idxItem.name }))
            )
          )
        )
        for (const result of results) {
          if (result.status === 'fulfilled') {
            allMembers.push(...result.value)
          }
        }
        const done = Math.min(i + BATCH_SIZE, indexItems.length)
        pushProgress(done, indexItems.length, `同步成分股 ${done}/${indexItems.length}，已收集 ${allMembers.length} 条记录…`)
        if (i + BATCH_SIZE < indexItems.length) {
          await new Promise(resolve => setTimeout(resolve, 3000))
        }
      }
      if (allMembers.length === 0) {
        console.warn('[ConceptMembersSync-THS] got 0 member rows, skipping replace')
        pushProgress(0, indexItems.length, '成分股为空，请检查 Tushare 积分（ths_member 需 6000 积分）')
        return
      }
      clearAllAndReplaceThsMembers(db, allMembers)
      console.log(`[ConceptMembersSync-THS] ths_concept_members fully replaced with ${allMembers.length} rows`)
      pushProgress(indexItems.length, indexItems.length, `✅ 同步完成：${indexItems.length} 个概念，${allMembers.length} 条成分股记录`)
    })
    return
  }

  if (source === 'dc') {
    await withCronRetry('ConceptMembersSync-DC', async () => {
      // DC 按最近有效交易日拉取今日快照
      let tradeDate = today
      for (let i = 0; i < 7; i++) {
        const d = offsetBjDateYmd(today, -i)
        const cnt = (db.prepare('SELECT COUNT(*) as c FROM limit_list_daily WHERE trade_date = ?').get(d) as { c: number }).c
        if (cnt > 0) { tradeDate = d; break }
      }
      console.log(`[ConceptMembersSync-DC] fetching dc_concept_cons for tradeDate=${tradeDate}`)
      const rows = await fetchDcConceptCons(token, tradeDate)
      if (rows.length === 0) {
        console.warn(`[ConceptMembersSync-DC] got 0 rows for ${tradeDate}, skipping`)
        return
      }
      upsertDcConceptMembers(db, rows)
      console.log(`[ConceptMembersSync-DC] dc_concept_members upserted ${rows.length} rows for ${tradeDate}`)
    })
    return
  }

  // 默认 KPL 路径
  await withCronRetry('ConceptMembersSync', async () => {
    // 获取最近有效交易日（kpl_concept_cons 必须传 trade_date，否则返回空）
    let tradeDate = today
    // 从 limit_list_daily 找最近有数据的交易日（最多往前 7 天）
    for (let i = 0; i < 7; i++) {
      const d = offsetBjDateYmd(today, -i)
      const count = (db.prepare('SELECT COUNT(*) as c FROM limit_list_daily WHERE trade_date = ?').get(d) as { c: number }).c
      if (count > 0) { tradeDate = d; break }
    }
    console.log(`[ConceptMembersSync] fetching kpl_concept_cons for tradeDate=${tradeDate}`)
    const rows = await fetchKplConceptCons(token, tradeDate)
    if (rows.length === 0) {
      console.warn(`[ConceptMembersSync] got 0 rows for ${tradeDate}, skipping replace`)
      return
    }
    clearAndReplaceConceptMembers(db, rows)
    console.log(`[ConceptMembersSync] kpl_concept_members fully replaced with ${rows.length} rows`)
  })
}

/**
 * 独立同步证券主数据。身份数据以 stock_basic 为准，daily_basic 股本补充失败不阻断新股入库。
 */
export interface StockBasicSyncResult {
  rowCount: number
  filledCircFloat: number
  latestOpenTradeDate: string | null
  remappedCandidates: number
  materializedProjectCompanies: number
  remapError: string | null
}

export function runStockBasicSyncJob(): Promise<StockBasicSyncResult | null> {
  if (_stockBasicSyncPromise) return _stockBasicSyncPromise
  const token = getTushareTokenOrNull()
  if (!token) {
    console.warn('[StockBasicSync] Tushare 未配置，跳过同步')
    return Promise.resolve(null)
  }

  let promise: Promise<StockBasicSyncResult | null>
  promise = (async () => {
    const synced = await withCronRetry('StockBasicSync', async () => {
      const basicRows = await fetchStockBasic(token)
      if (basicRows.length === 0) throw new Error('STOCK_BASIC_EMPTY')

      const today = getBjTodayYmd()
      let latestOpenTradeDate: string | null = null
      const floatShareMap = new Map<string, number | null>()
      try {
        const startDate = offsetBjDateYmd(today, -14)
        const calRows = await fetchTradeCal(token, 'SSE', startDate, today)
        latestOpenTradeDate = calRows
          .filter((row) => row.isOpen === 1)
          .map((row) => row.calDate)
          .sort((left, right) => right.localeCompare(left))[0] ?? null
        if (latestOpenTradeDate) {
          const dailyBasicRows = await fetchDailyBasicByDate(token, latestOpenTradeDate)
          for (const row of dailyBasicRows) floatShareMap.set(row.tsCode, row.floatShare)
        }
      } catch (error) {
        console.warn('[StockBasicSync] optional circ_float fill failed:', error instanceof Error ? error.message : String(error))
      }

      const now = Date.now()
      const cacheRows = basicRows.map(r => ({
        tsCode: r.tsCode,
        name: r.name,
        industry: r.industry,
        market: r.market,
        listStatus: r.listStatus,
        circFloat: floatShareMap.get(r.tsCode) ?? null,
        updatedAt: now,
      }))
      clearAndInsertStockBasic(getDb(), cacheRows)
      const filledCircFloat = cacheRows.filter(r => r.circFloat != null).length
      console.log(`[StockBasicSync] stock_basic_cache fully replaced with ${basicRows.length} rows, circ_float filled ${filledCircFloat}/${cacheRows.length}, latestOpenTradeDate=${latestOpenTradeDate ?? 'unavailable'}`)
      return { rowCount: basicRows.length, filledCircFloat, latestOpenTradeDate }
    })
    if (!synced) throw new Error('STOCK_BASIC_SYNC_FAILED')

    let remappedCandidates = 0
    let materializedProjectCompanies = 0
    let remapError: string | null = null
    try {
      const { remapUnmatchedIndustryResearchCompanyCandidates } = await import('./industryResearchGenerationService')
      const remapped = remapUnmatchedIndustryResearchCompanyCandidates(getDb())
      remappedCandidates = remapped.remappedCandidates
      materializedProjectCompanies = remapped.materializedProjectCompanies
      console.log(`[StockBasicSync] unmatched company remap scanned=${remapped.scannedCandidates} remapped=${remappedCandidates} materialized=${materializedProjectCompanies}`)
    } catch (error) {
      remapError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      console.warn('[StockBasicSync] company remap failed:', remapError)
    }
    return {
      ...synced,
      remappedCandidates,
      materializedProjectCompanies,
      remapError,
    }
  })().finally(() => {
    if (_stockBasicSyncPromise === promise) _stockBasicSyncPromise = null
  })
  _stockBasicSyncPromise = promise
  return promise
}

export function runStartupStockBasicSyncIfStale(now = Date.now()): Promise<StockBasicSyncResult | null> {
  const expectedBeijingYmd = getBeijingYmd(now)
  if (!isStockBasicCacheStale(getDb(), expectedBeijingYmd)) return Promise.resolve(null)
  console.log(`[StockBasicSync] startup cache is stale for ${expectedBeijingYmd}, triggering catch-up`)
  return runStockBasicSyncJob()
}

/**
 * 历史日线数据初始化兼容入口。
 * 统一复用 FR-229 的 480 个交易日目标，避免旧短线入口把完整底座降回 90 日。
 *
 * @param onProgress 每完成一天调用一次，参数含 done（已完成数）、total（总天数）、date（当天 YYYYMMDD）
 */
export async function runInitialDailyDataSync(
  onProgress: (p: { done: number; total: number; date: string }) => void
): Promise<void> {
  const token = getTushareTokenOrNull()
  if (!token) {
    const err = new Error('Tushare 未配置，无法初始化日线数据') as Error & { code: string }
    err.code = 'TUSHARE_DISABLED'
    throw err
  }

  await runHistoricalDailySync(getDb(), token, undefined, {
    tradeDayCount: HISTORICAL_DAILY_TARGET_TRADE_DAYS,
    onProgress: (progress) => onProgress({
      done: progress.processedTradeDays,
      total: progress.totalTradeDays,
      date: progress.currentTradeDate ?? '',
    }),
  })
}

/** 盘中每 60s 自动刷新 sharedRtKCache（全市场实时行情快照） */
export function scheduleRtKRefresh(): void {
  if (_rtKRefreshTimer) {
    clearInterval(_rtKRefreshTimer)
    _rtKRefreshTimer = null
  }
  _rtKRefreshTimer = setInterval(async () => {
    const token = getTushareTokenOrNull()
    if (!token) return
    // 仅在交易时段（北京时间 09:15–15:00 工作日）执行刷新
    if (!isInTradingHoursMain()) return
    try {
      await refreshRtKCache(token)
      console.log(`[RtKRefresh] cache refreshed at ${new Date().toISOString()}`)
      // 追加今日涨停/跌停时间序列点 + 失效概念热度缓存（下次前端请求时重算）
      appendTimelinePoint(getDb())
      clearConceptHeatCache()
      // FR-164: 实时更新趋势 Watchlist 评分缓存（仅内存，不写 DB）
      const trendWin = BrowserWindow.getAllWindows()[0] ?? undefined
      recomputeTrendScoresRealtime(getDb(), trendWin)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[RtKRefresh] failed: ${msg}`)
    }
  }, 60_000)

  // 每天 04:00 北京时间清空 rt_k 缓存（防止跨日残留）
  // 利用 clearSwL1Cache 已调用 clearRtKCache，行业云图 04:00 清缓存已覆盖该逻辑
  // 此处额外保底：独立 setTimeout 确保即使行业云图从未使用也能清理
  const msUntil4 = delayUntilBjTime(4, 0)
  setTimeout(() => {
    clearRtKCache()
    clearTodayTimeline()
    clearConceptHeatCache()
    clearTradingCalendarCache()
    console.log('[RtKRefresh] daily cache cleared at 04:00 BJ')
    // 04:00 日切后重新拉取今日交易日历
    const tok = getTushareTokenOrNull()
    if (tok) void refreshTradingCalendar(tok)
  }, msUntil4)
}

/** FR-137: 早盘竞价定时自动触发（09:15 预热 + 09:28 刷新），链式 setTimeout 每日循环 */
function scheduleMorningAuctionTimers(): void {
  // 获取当前北京时间小时和分钟，用于启动补偿判断
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const bjHHMM = bjNow.getUTCHours() * 100 + bjNow.getUTCMinutes()
  const auctionConfirmHHMM = PREMARKET_AUCTION_CONFIRM_HOUR_BJ * 100
    + PREMARKET_AUCTION_CONFIRM_MINUTE_BJ

  // 09:15 预热：链式注册，无论是否工作日均链式循环；仅交易日执行快照预热
  function schedule915(): void {
    _morningAuction915Timer = setTimeout(async function fire915() {
      if (isTradingDay(getBjTodayYmd())) {
        const today = getBjTodayYmd()
        try {
          await getOrCreateMorningAuctionSnapshot(today)
          console.log(`[MorningAuction] 09:15 pre-warm done for ${today}`)
        } catch (err) {
          console.warn('[MorningAuction] 09:15 pre-warm failed:', err)
        }
      }
      schedule915()
    }, delayUntilBjTime(9, 15))
  }

  // 09:28 刷新：给 stk_auction 留出上游出数时间，再冻结竞价确认版。
  function schedule928(): void {
    _morningAuction928Timer = setTimeout(async function fire928() {
      if (isTradingDay(getBjTodayYmd())) {
        const today = getBjTodayYmd()
        try {
          await refreshMorningAuctionSnapshot(today)
          console.log(`[MorningAuction] 09:28 refresh done for ${today}`)
        } catch (err) {
          console.warn('[MorningAuction] 09:28 refresh failed:', err)
        }
        try {
          await runPremarketScenarioStage(getDb(), {
            tradeDate: today,
            stage: 'auction_confirmed',
            now: Date.now(),
          })
          console.log(`[Premarket] 09:28 scenario done for ${today}`)
        } catch (err) {
          console.warn('[Premarket] 09:28 scenario failed:', err)
        }
      }
      schedule928()
    }, delayUntilBjTime(PREMARKET_AUCTION_CONFIRM_HOUR_BJ, PREMARKET_AUCTION_CONFIRM_MINUTE_BJ))
  }

  // 启动补偿逻辑：根据当前北京时间决定是否立即执行
  if (bjHHMM >= 915 && bjHHMM < auctionConfirmHHMM) {
    // 09:15–09:28 之间启动：立即执行预热（fire-and-forget），跳过当天 09:15 timer
    if (isTradingDay(getBjTodayYmd())) {
      const today = getBjTodayYmd()
      void getOrCreateMorningAuctionSnapshot(today).catch(err => {
        console.warn('[MorningAuction] startup pre-warm failed:', err)
      })
    }
  }
  // 无论落在哪个区间，均注册链式 timer（等待今天或明天的时刻）
  schedule915()
  schedule928()
}

/** FR-250: 15:01形成尾盘最终快照；启动落在15:01至18:00时执行一次当日补偿。 */
function scheduleClosingHalfHourFinalize(): void {
  const runToday = async (): Promise<void> => {
    const today = getBjTodayYmd()
    if (!isTradingDay(today)) return
    try {
      const token = getTushareTokenOrNull()
      if (token) await refreshRtKCache(token)
      const snapshot = await refreshClosingHalfHourSnapshot(today)
      console.log(`[ClosingHalfHour] 15:01 finalize done date=${snapshot.tradeDate} candidates=${snapshot.candidateCount} saved=${snapshot.stocks.filter((stock) => stock.judgment.tier === 'active' || stock.judgment.tier === 'confirm').length}`)
    } catch (error) {
      console.warn('[ClosingHalfHour] 15:01 finalize failed:', error instanceof Error ? error.message : String(error))
    }
  }

  const scheduleNext = (): void => {
    _closingHalfHourTimer = setTimeout(async () => {
      await runToday()
      scheduleNext()
    }, delayUntilBjTime(15, 1))
  }

  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes()
  if (hhmm >= 1501 && hhmm < 1800) void runToday()
  scheduleNext()
}

// ──────────────────────────────────────────────────────────
// FR-162: 交易日历每月同步 cron
// ──────────────────────────────────────────────────────────

/**
 * 链式 setTimeout，每月 1 日北京时间 04:00 自动同步交易日历。
 * 确保节假日调整（如调休补班通知）每月至少同步一次。
 */
function scheduleTradeCalSync(): void {
  // 计算距下一个月 1 日 04:00 的毫秒数
  function msUntilNextFirstOfMonth(): number {
    // 北京 04:00 = UTC 前一天 20:00，但这里用链式方式计算，每次触发后再注册即可
    // 近似：24h 后再精确判断，每次触发时检测是否为 1 日
    return 24 * 60 * 60 * 1000 // 每天检查一次
  }

  _tradeCalSyncTimer = setTimeout(async function fire() {
    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    if (bjNow.getUTCDate() === 1) {
      const token = getTushareTokenOrNull()
      if (token) {
        try {
          await syncTradeCalIfNeeded(getDb(), token)
        } catch (err) {
          console.warn('[TradeCal] monthly sync failed:', err instanceof Error ? err.message : String(err))
        }
      }
    }
    scheduleTradeCalSync()
  }, msUntilNextFirstOfMonth())
}

// ──────────────────────────────────────────────────────────
// FR-168: 持仓批量预测每日 13:15 cron
// ──────────────────────────────────────────────────────────

/**
 * 链式 setTimeout，每个交易日北京时间 13:15 自动触发持仓批量预测.
 * 13:15 为午盘开盘后约 15 分钟，分时数据已充足但任务结束有富余时间.
 */
function schedulePortfolioForecast(): void {
  _portfolioForecastTimer = setTimeout(async function fire() {
    if (isBjWeekday()) {
      const db = getDb()
      const win = BrowserWindow.getAllWindows()[0] ?? null
      try {
        await runPortfolioForecastJob(db, win)
      } catch (err) {
        console.warn('[Portfolio] 13:15 cron failed:', err)
      }
    }
    schedulePortfolioForecast()
  }, delayUntilBjTime(13, 15))
}
