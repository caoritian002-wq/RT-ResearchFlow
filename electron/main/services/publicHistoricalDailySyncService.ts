import type Database from 'better-sqlite3'
import { upsertDailyClose, type DailyCloseWriteSource } from '../database/dailyCloseCacheRepository'
import { queryAllActive } from '../database/stockBasicCacheRepository'
import {
  deferPublicMarketRequestsUntil,
  getPublicDailySyncCheckpoint,
  getPublicMarketProviderState,
  getPublicMarketSyncJob,
  listPendingPublicDailyCodes,
  upsertPublicDailySyncCheckpoint,
  upsertPublicMarketSyncJob,
  type PublicDailyCheckpointStatus,
  type PublicMarketSyncJob,
} from '../database/publicMarketDataRepository'
import {
  sinaSymbol,
  tencentSymbol,
  transformSinaDailySeries,
  transformTencentDailySeries,
  type CanonicalDailyBar,
} from '../../../scripts/lib/canonical-daily-bar-transformer.mjs'
import {
  getPersistentPublicMarketRequestGovernor,
  PublicMarketProviderCoolingDownError,
  type PersistentPublicMarketRequestGovernor,
} from './publicMarketRequestGovernor'
import type { DailyRow } from './tushareService'

const PUBLIC_DAILY_JOB_KEY = 'historical_daily_public'
const TARGET_TRADE_DAYS = 480
const REQUESTED_ROWS = TARGET_TRADE_DAYS + 1
const DEFAULT_TIMEOUT_MS = 15_000
export const PUBLIC_HISTORICAL_DAILY_BATCH_SIZE = 400
export const PUBLIC_HISTORICAL_DAILY_BATCH_PAUSE_MS = 60_000

interface PublicHistoricalDailyDependencies {
  fetchImpl?: typeof fetch
  governor?: PersistentPublicMarketRequestGovernor
  now?: () => number
  timeoutMs?: number
  onProgress?: (job: PublicMarketSyncJob) => void
  acceptEmptyBeforeFirstClose?: boolean
}

export interface PublicHistoricalDailySyncResult {
  targetEndDate: string
  totalStocks: number
  processedStocks: number
  syncedStocks: number
  failedStocks: number
  writtenRows: number
  failedCodes: string[]
}

interface PublicHistoryFetchResult {
  provider: 'sina' | 'tencent'
  rows: DailyRow[]
}

function errorWithCode(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function sinaHistoryUrl(tsCode: string): string {
  const symbol = sinaSymbol(tsCode)
  if (!symbol) throw errorWithCode('PUBLIC_DAILY_INVALID_CODE')
  const url = new URL('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData')
  url.searchParams.set('symbol', symbol)
  url.searchParams.set('scale', '240')
  url.searchParams.set('ma', 'no')
  url.searchParams.set('datalen', String(REQUESTED_ROWS))
  return url.toString()
}

function tencentHistoryUrl(tsCode: string): string {
  const symbol = tencentSymbol(tsCode)
  if (!symbol) throw errorWithCode('PUBLIC_DAILY_INVALID_CODE')
  const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/kline/kline')
  url.searchParams.set('param', `${symbol},day,,,${REQUESTED_ROWS}`)
  return url.toString()
}

function canonicalToDailyRows(rows: CanonicalDailyBar[]): DailyRow[] {
  return rows.flatMap((row) => row.pctChg == null ? [] : [{
    tsCode: row.tsCode,
    tradeDate: row.tradeDate,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    pctChg: row.pctChg,
    vol: row.vol,
    amount: row.amount,
    turnoverRate: row.turnoverRate,
  }])
}

async function fetchJson(
  governor: PersistentPublicMarketRequestGovernor,
  provider: 'sina' | 'tencent',
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<unknown> {
  const governed = await governor.run(provider, async () => {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: provider === 'sina' ? 'https://finance.sina.com.cn/' : 'https://stockapp.finance.qq.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121 Safari/537.36',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    if (!response.ok) return { status: response.status, body: null }
    const body: unknown = JSON.parse(text)
    return { status: response.status, body }
  })
  if (governed.value.status < 200 || governed.value.status >= 400) {
    throw errorWithCode(
      `PUBLIC_${provider.toUpperCase()}_HTTP_${governed.value.status}`,
      `${provider}公共日线请求失败（HTTP ${governed.value.status}）`,
    )
  }
  return governed.value.body
}

async function fetchSinaHistory(
  tsCode: string,
  targetEndDate: string,
  dependencies: Required<Pick<PublicHistoricalDailyDependencies, 'fetchImpl' | 'governor' | 'timeoutMs'>>
    & Pick<PublicHistoricalDailyDependencies, 'acceptEmptyBeforeFirstClose'>,
): Promise<PublicHistoryFetchResult> {
  const body = await fetchJson(dependencies.governor, 'sina', sinaHistoryUrl(tsCode), dependencies.fetchImpl, dependencies.timeoutMs)
  const rawRows = Array.isArray(body) ? body : []
  const transformed = transformSinaDailySeries(tsCode, rawRows, {
    maxTradeDate: targetEndDate,
    limit: TARGET_TRADE_DAYS,
  })
  const rows = canonicalToDailyRows(transformed.rows)
  if (rows.length === 0 && !dependencies.acceptEmptyBeforeFirstClose) {
    throw errorWithCode('PUBLIC_SINA_DAILY_EMPTY')
  }
  return { provider: 'sina', rows }
}

async function fetchTencentHistory(
  tsCode: string,
  targetEndDate: string,
  dependencies: Required<Pick<PublicHistoricalDailyDependencies, 'fetchImpl' | 'governor' | 'timeoutMs'>>,
): Promise<PublicHistoryFetchResult> {
  if (tsCode.endsWith('.BJ')) throw errorWithCode('PUBLIC_TENCENT_BJ_UNSUPPORTED')
  const body = await fetchJson(dependencies.governor, 'tencent', tencentHistoryUrl(tsCode), dependencies.fetchImpl, dependencies.timeoutMs)
  const symbol = tencentSymbol(tsCode)
  const rawRows = symbol && typeof body === 'object' && body !== null
    ? (body as { data?: Record<string, { day?: unknown[] }> }).data?.[symbol]?.day
    : null
  const transformed = transformTencentDailySeries(tsCode, Array.isArray(rawRows) ? rawRows : [], {
    maxTradeDate: targetEndDate,
    limit: TARGET_TRADE_DAYS,
  })
  const rows = canonicalToDailyRows(transformed.rows)
  if (rows.length === 0) throw errorWithCode('PUBLIC_TENCENT_DAILY_EMPTY')
  return { provider: 'tencent', rows }
}

export async function fetchPublicDailyHistoryForCode(
  db: Database.Database,
  tsCode: string,
  targetEndDate: string,
  dependencies: PublicHistoricalDailyDependencies = {},
): Promise<PublicHistoryFetchResult> {
  const resolved = {
    fetchImpl: dependencies.fetchImpl ?? fetch,
    governor: dependencies.governor ?? getPersistentPublicMarketRequestGovernor(db),
    timeoutMs: dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    acceptEmptyBeforeFirstClose: dependencies.acceptEmptyBeforeFirstClose === true,
  }
  try {
    return await fetchSinaHistory(tsCode, targetEndDate, resolved)
  } catch (sinaError) {
    if (tsCode.endsWith('.BJ')) throw sinaError
    try {
      return await fetchTencentHistory(tsCode, targetEndDate, resolved)
    } catch (tencentError) {
      if (
        sinaError instanceof PublicMarketProviderCoolingDownError
        && tencentError instanceof PublicMarketProviderCoolingDownError
      ) {
        throw new PublicMarketProviderCoolingDownError(
          'sina+tencent',
          Math.max(sinaError.resumeAt, tencentError.resumeAt),
          'ALL_PUBLIC_DAILY_PROVIDERS_COOLDOWN',
        )
      }
      const message = [sinaError, tencentError]
        .map((error) => error instanceof Error ? error.message : String(error))
        .join('；')
      throw errorWithCode('PUBLIC_DAILY_ALL_PROVIDERS_FAILED', message)
    }
  }
}

function publishJob(
  db: Database.Database,
  job: PublicMarketSyncJob,
  onProgress?: (job: PublicMarketSyncJob) => void,
): void {
  upsertPublicMarketSyncJob(db, job)
  onProgress?.({ ...job })
}

function errorStatus(error: unknown): PublicDailyCheckpointStatus {
  return error instanceof PublicMarketProviderCoolingDownError ? 'cooldown' : 'failed'
}

function writeMetadata(provider: 'sina' | 'tencent', fetchedAt: number): {
  dataSource: DailyCloseWriteSource
  fetchedAt: number
} {
  return { dataSource: provider, fetchedAt }
}

function isFirstListingDayBeforeTarget(
  stock: { name: string | null; updatedAt: number } | undefined,
  targetEndDate: string,
): boolean {
  if (!String(stock?.name ?? '').trim().toUpperCase().startsWith('N')) return false
  const observedAt = Number(stock?.updatedAt)
  if (!Number.isFinite(observedAt) || observedAt <= 0) return false
  const observedDate = new Date(observedAt + 8 * 60 * 60_000)
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')
  return observedDate > targetEndDate
}

let publicHistoricalDailyPromise: Promise<PublicHistoricalDailySyncResult> | null = null

export function runPublicHistoricalDailySync(
  db: Database.Database,
  targetEndDate: string,
  dependencies: PublicHistoricalDailyDependencies = {},
): Promise<PublicHistoricalDailySyncResult> {
  if (!/^\d{8}$/.test(targetEndDate)) return Promise.reject(errorWithCode('PUBLIC_DAILY_INVALID_TARGET_DATE'))
  if (publicHistoricalDailyPromise) return publicHistoricalDailyPromise
  const now = dependencies.now ?? Date.now
  const startedAt = now()

  let promise: Promise<PublicHistoricalDailySyncResult>
  promise = (async () => {
    const activeStocks = queryAllActive(db)
    if (activeStocks.length === 0) throw errorWithCode('PUBLIC_STOCK_UNIVERSE_NOT_READY')
    const pendingCodes = listPendingPublicDailyCodes(db, targetEndDate, TARGET_TRADE_DAYS)
    const activeStockByCode = new Map(activeStocks.map(stock => [stock.tsCode, stock]))
    const completedBefore = Math.max(0, activeStocks.length - pendingCodes.length)
    const result: PublicHistoricalDailySyncResult = {
      targetEndDate,
      totalStocks: activeStocks.length,
      processedStocks: completedBefore,
      syncedStocks: 0,
      failedStocks: 0,
      writtenRows: 0,
      failedCodes: [],
    }
    publishJob(db, {
      jobKey: PUBLIC_DAILY_JOB_KEY,
      status: 'running',
      totalItems: result.totalStocks,
      processedItems: result.processedStocks,
      writtenRows: 0,
      currentItem: pendingCodes[0] ?? null,
      message: '公共历史日线正在后台低频回补，可跨应用会话继续',
      startedAt,
      completedAt: null,
      updatedAt: startedAt,
    }, dependencies.onProgress)

    for (const [pendingIndex, tsCode] of pendingCodes.entries()) {
      const existing = getPublicDailySyncCheckpoint(db, tsCode)
      const attemptAt = now()
      upsertPublicDailySyncCheckpoint(db, {
        tsCode,
        primaryProvider: 'sina',
        status: 'running',
        targetEndDate,
        lastSuccessDate: existing?.lastSuccessDate ?? null,
        writtenRows: existing?.writtenRows ?? 0,
        lastError: null,
        attempts: (existing?.attempts ?? 0) + 1,
        updatedAt: attemptAt,
      })

      try {
        const fetched = await fetchPublicDailyHistoryForCode(db, tsCode, targetEndDate, {
          ...dependencies,
          acceptEmptyBeforeFirstClose: isFirstListingDayBeforeTarget(
            activeStockByCode.get(tsCode),
            targetEndDate,
          ),
        })
        const fetchedAt = now()
        upsertDailyClose(db, fetched.rows, writeMetadata(fetched.provider, fetchedAt))
        const lastSuccessDate = fetched.rows.at(-1)?.tradeDate ?? targetEndDate
        upsertPublicDailySyncCheckpoint(db, {
          tsCode,
          primaryProvider: fetched.provider,
          status: 'success',
          targetEndDate,
          lastSuccessDate,
          writtenRows: fetched.rows.length,
          lastError: null,
          attempts: (existing?.attempts ?? 0) + 1,
          updatedAt: fetchedAt,
        })
        result.syncedStocks += 1
        result.writtenRows += fetched.rows.length
      } catch (error) {
        const failedAt = now()
        const status = errorStatus(error)
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
        upsertPublicDailySyncCheckpoint(db, {
          tsCode,
          primaryProvider: 'sina',
          status,
          targetEndDate,
          lastSuccessDate: existing?.lastSuccessDate ?? null,
          writtenRows: existing?.writtenRows ?? 0,
          lastError: message,
          attempts: (existing?.attempts ?? 0) + 1,
          updatedAt: failedAt,
        })
        result.failedStocks += 1
        result.failedCodes.push(tsCode)
        if (error instanceof PublicMarketProviderCoolingDownError) {
          result.processedStocks += 1
          publishJob(db, {
            jobKey: PUBLIC_DAILY_JOB_KEY,
            status: 'cooldown',
            totalItems: result.totalStocks,
            processedItems: result.processedStocks,
            writtenRows: result.writtenRows,
            currentItem: tsCode,
            message: `公共历史日线已暂停，数据源冷却至 ${new Date(error.resumeAt).toLocaleString('zh-CN')}，冷却结束后可从检查点继续`,
            startedAt,
            completedAt: failedAt,
            updatedAt: failedAt,
          }, dependencies.onProgress)
          return result
        }
      }

      result.processedStocks += 1
      const progressAt = now()
      if (
        pendingIndex < pendingCodes.length - 1
        && result.processedStocks % PUBLIC_HISTORICAL_DAILY_BATCH_SIZE === 0
      ) {
        deferPublicMarketRequestsUntil(
          db,
          progressAt + PUBLIC_HISTORICAL_DAILY_BATCH_PAUSE_MS,
          progressAt,
        )
      }
      publishJob(db, {
        jobKey: PUBLIC_DAILY_JOB_KEY,
        status: 'running',
        totalItems: result.totalStocks,
        processedItems: result.processedStocks,
        writtenRows: result.writtenRows,
        currentItem: tsCode,
        message: `公共历史日线 ${result.processedStocks}/${result.totalStocks}，失败 ${result.failedStocks}`,
        startedAt,
        completedAt: null,
        updatedAt: progressAt,
      }, dependencies.onProgress)
    }

    const completedAt = now()
    publishJob(db, {
      jobKey: PUBLIC_DAILY_JOB_KEY,
      status: result.failedStocks > 0 ? 'partial' : 'success',
      totalItems: result.totalStocks,
      processedItems: result.processedStocks,
      writtenRows: result.writtenRows,
      currentItem: null,
      message: result.failedStocks > 0
        ? `公共历史日线本轮完成，${result.failedStocks} 只待后续重试`
        : '公共历史日线同步完成',
      startedAt,
      completedAt,
      updatedAt: completedAt,
    }, dependencies.onProgress)
    return result
  })().catch((error) => {
    const failedAt = now()
    publishJob(db, {
      jobKey: PUBLIC_DAILY_JOB_KEY,
      status: error instanceof PublicMarketProviderCoolingDownError ? 'cooldown' : 'failed',
      totalItems: queryAllActive(db).length,
      processedItems: 0,
      writtenRows: 0,
      currentItem: null,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      startedAt,
      completedAt: failedAt,
      updatedAt: failedAt,
    }, dependencies.onProgress)
    throw error
  }).finally(() => {
    if (publicHistoricalDailyPromise === promise) publicHistoricalDailyPromise = null
  })
  publicHistoricalDailyPromise = promise
  return promise
}

export function isPublicHistoricalDailySyncRunning(): boolean {
  return publicHistoricalDailyPromise !== null
}

export function runStartupPublicHistoricalDailySyncIfNeeded(
  db: Database.Database,
  targetEndDate: string,
  dependencies: PublicHistoricalDailyDependencies = {},
): Promise<PublicHistoricalDailySyncResult | null> {
  const job = getPublicMarketSyncJob(db, PUBLIC_DAILY_JOB_KEY)
  if (!job || !['running', 'partial', 'cooldown'].includes(job.status)) return Promise.resolve(null)
  if (job.status === 'cooldown') {
    const now = dependencies.now?.() ?? Date.now()
    const resumeAt = Math.max(
      getPublicMarketProviderState(db, 'sina', now).blockedUntil,
      getPublicMarketProviderState(db, 'tencent', now).blockedUntil,
    )
    if (resumeAt > now) return Promise.resolve(null)
  }
  return runPublicHistoricalDailySync(db, targetEndDate, dependencies)
}
