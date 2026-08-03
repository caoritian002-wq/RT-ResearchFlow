import type Database from 'better-sqlite3'
import { listPortfolioStocks } from '../database/portfolioRepository'
import { getPrevTradeDay, isTradeDay } from '../database/tradeCalRepository'
import { toPremarketScenarioRevisionSummary } from '../database/premarketScenarioVersionRepository'
import { getBeijingYmd, isWeekdayYmd } from './marketSettlementPolicy'
import { getPremarketStageCutoffAt } from './premarketCutoffPolicy'
import { runPremarketOutcomeValidation } from './premarketOutcomeService'
import { runPremarketScenarioStage } from './premarketRehearsalService'
import type {
  PremarketScenarioRetryProgress,
  PremarketScenarioRetryResponse,
  PremarketScenarioRetrySourceResult,
} from './premarketRehearsalTypes'
import type { StockAnnouncementRefreshResult } from './stockFundamentalService'

interface RetryOptions {
  now?: number
  clock?: () => number
  refreshExternal: (tradeDate: string) => Promise<{
    status: 'completed' | 'partial' | 'unavailable' | 'failed'
    itemCount: number
    errorCode: string | null
  }>
  refreshAuction: (tradeDate: string) => Promise<{
    status: 'completed' | 'unavailable' | 'failed'
    itemCount: number
    errorCode: string | null
  }>
  scanBriefings: () => Promise<{ runId: number; newBriefingsFound: number }>
  refreshAnnouncement: (stockCode: string) => Promise<StockAnnouncementRefreshResult>
  onProgress?: (progress: PremarketScenarioRetryProgress) => void
}

const flights = new WeakMap<Database.Database, Promise<PremarketScenarioRetryResponse>>()

function resolveTargetTradeDate(db: Database.Database, now: number): string | null {
  const today = getBeijingYmd(now)
  const state = isTradeDay(db, today)
  if (state === true || (state === null && isWeekdayYmd(today))) return today
  return getPrevTradeDay(db, today)
}

function progress(
  options: RetryOptions,
  phase: PremarketScenarioRetryProgress['phase'],
  message: string,
  current: number | null = null,
  total: number | null = null,
): void {
  options.onProgress?.({ phase, message, current, total })
}

function sourceWarning(result: PremarketScenarioRetrySourceResult): string | null {
  if (result.status === 'completed' && result.errorCode == null) return null
  return `MANUAL_BACKFILL_${result.source.toUpperCase()}_${result.errorCode ?? result.status.toUpperCase()}`
}

async function mapWithConcurrency<T>(
  values: string[],
  concurrency: number,
  worker: (value: string, index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(values.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(values[index]!, index)
    }
  })
  await Promise.all(runners)
  return results
}

async function executeRetry(
  db: Database.Database,
  options: RetryOptions,
): Promise<PremarketScenarioRetryResponse> {
  const requestedAt = options.now ?? options.clock?.() ?? Date.now()
  const targetTradeDate = resolveTargetTradeDate(db, requestedAt)
  if (!targetTradeDate) {
    return {
      ok: false,
      code: 'PREMARKET_RETRY_TARGET_UNAVAILABLE',
      message: '交易日历中没有可补采的盘前推演日期',
    }
  }
  if (
    targetTradeDate === getBeijingYmd(requestedAt)
    && requestedAt < getPremarketStageCutoffAt(targetTradeDate, 'auction_confirmed')
  ) {
    return {
      ok: false,
      code: 'PREMARKET_RETRY_BEFORE_CONFIRMATION',
      message: '09:28竞价确认后才能重新补采盘前推演',
    }
  }

  progress(options, 'starting', `正在准备 ${targetTradeDate} 的历史可还原事实`)
  const sources: PremarketScenarioRetrySourceResult[] = []
  progress(options, 'external', '正在恢复08:45外盘历史事实')
  try {
    const external = await options.refreshExternal(targetTradeDate)
    sources.push({
      source: 'external',
      status: external.status,
      itemCount: external.itemCount,
      errorCode: external.errorCode,
    })
  } catch {
    sources.push({
      source: 'external',
      status: 'failed',
      itemCount: 0,
      errorCode: 'EXTERNAL_HISTORY_RECOVERY_FAILED',
    })
  }

  progress(options, 'auction', '正在补采09:25定稿竞价事实')
  const auction = await options.refreshAuction(targetTradeDate)
  sources.push({
    source: 'auction',
    status: auction.status,
    itemCount: auction.itemCount,
    errorCode: auction.errorCode,
  })

  progress(options, 'briefings', '正在扫描资讯，并按09:30发布时间截断')
  try {
    const scan = await options.scanBriefings()
    sources.push({
      source: 'briefings',
      status: 'completed',
      itemCount: scan.newBriefingsFound,
      errorCode: null,
    })
  } catch (error) {
    const busy = error instanceof Error && error.message === 'Scan already in progress'
    sources.push({
      source: 'briefings',
      status: busy ? 'partial' : 'failed',
      itemCount: 0,
      errorCode: busy ? 'SCAN_ALREADY_RUNNING' : 'BRIEFING_SCAN_FAILED',
    })
  }

  const holdingCodes = [...new Set(listPortfolioStocks(db).map((item) => item.tsCode))].slice(0, 50)
  progress(options, 'announcements', '正在补采持仓公告索引', 0, holdingCodes.length)
  let announcementCompleted = 0
  let announcementFailed = 0
  let announcementProcessed = 0
  const announcementResults = await mapWithConcurrency(holdingCodes, 3, async (stockCode) => {
    const result = await options.refreshAnnouncement(stockCode)
    if (result.ok) announcementCompleted += 1
    else announcementFailed += 1
    announcementProcessed += 1
    progress(
      options,
      'announcements',
      `正在补采持仓公告索引（${announcementProcessed}/${holdingCodes.length}）`,
      announcementProcessed,
      holdingCodes.length,
    )
    return result
  })
  sources.push({
    source: 'announcements',
    status: announcementFailed === 0
      ? 'completed'
      : announcementCompleted > 0 ? 'partial' : holdingCodes.length === 0 ? 'completed' : 'failed',
    itemCount: announcementResults.reduce((sum, item) => sum + (item.ok ? item.rowsWritten : 0), 0),
    errorCode: announcementFailed > 0 ? 'ANNOUNCEMENT_BACKFILL_PARTIAL' : null,
  })

  progress(options, 'generating', '正在按09:30事实边界生成新修订')
  const generatedAt = options.clock?.() ?? options.now ?? Date.now()
  const additionalWarnings = sources
    .map(sourceWarning)
    .filter((item): item is string => item != null)
  const saved = await runPremarketScenarioStage(db, {
    tradeDate: targetTradeDate,
    stage: 'auction_confirmed',
    now: generatedAt,
    requestedAt,
    revisionKind: 'manual_backfill',
    appendRevision: true,
    additionalWarnings,
  })
  if (generatedAt >= getPremarketStageCutoffAt(targetTradeDate, 'after_close')) {
    runPremarketOutcomeValidation(db, targetTradeDate, generatedAt)
  }
  const revision = toPremarketScenarioRevisionSummary(saved.version)
  progress(options, 'completed', `补采完成，已生成修订 R${revision.revision}`)
  return { ok: true, tradeDate: targetTradeDate, revision, sources }
}

export function retryPremarketScenario(
  db: Database.Database,
  options: RetryOptions,
): Promise<PremarketScenarioRetryResponse> {
  const current = flights.get(db)
  if (current) return current
  let promise: Promise<PremarketScenarioRetryResponse>
  promise = executeRetry(db, options)
    .catch((error): PremarketScenarioRetryResponse => ({
      ok: false,
      code: 'PREMARKET_RETRY_FAILED',
      message: error instanceof Error ? error.message : '盘前推演补采失败',
    }))
    .finally(() => {
      if (flights.get(db) === promise) flights.delete(db)
    })
  flights.set(db, promise)
  return promise
}
