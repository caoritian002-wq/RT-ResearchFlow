import type Database from 'better-sqlite3'
import {
  mergePublicStockIdentities,
  type PublicStockIdentityMergeResult,
} from '../database/stockBasicCacheRepository'
import {
  getPublicMarketSyncJob,
  upsertPublicMarketSyncJob,
  type PublicMarketSyncJob,
} from '../database/publicMarketDataRepository'
import {
  deduplicateStockUniverse,
  transformSinaStockUniverseRows,
  type CanonicalStockIdentity,
} from '../../../scripts/lib/public-stock-universe-transformer.mjs'
import {
  getPersistentPublicMarketRequestGovernor,
  PublicMarketProviderCoolingDownError,
  type PersistentPublicMarketRequestGovernor,
} from './publicMarketRequestGovernor'

const PUBLIC_STOCK_JOB_KEY = 'stock_universe'
const SINA_UNIVERSE_PROVIDER = 'sina'
const SINA_UNIVERSE_PAGE_SIZE = 100
const SINA_UNIVERSE_MAX_PAGES = 80
const MIN_PUBLIC_STOCK_UNIVERSE_ROWS = 4_000
const DEFAULT_TIMEOUT_MS = 15_000

interface PublicStockUniverseDependencies {
  fetchImpl?: typeof fetch
  governor?: PersistentPublicMarketRequestGovernor
  now?: () => number
  timeoutMs?: number
  onProgress?: (job: PublicMarketSyncJob) => void
}

export interface PublicStockUniverseFetchResult {
  rows: CanonicalStockIdentity[]
  marketRows: unknown[]
  pageCount: number
  rawRows: number
  rejectedRows: number
  identityConflicts: number
}

export interface PublicStockUniverseSyncResult extends PublicStockIdentityMergeResult {
  source: 'sina'
  pageCount: number
  rejectedRows: number
  identityConflicts: number
}

function pageUrl(page: number): string {
  const url = new URL('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData')
  url.searchParams.set('page', String(page))
  url.searchParams.set('num', String(SINA_UNIVERSE_PAGE_SIZE))
  url.searchParams.set('sort', 'symbol')
  url.searchParams.set('asc', '1')
  url.searchParams.set('node', 'hs_a')
  return url.toString()
}

function errorWithCode(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function createJob(
  now: number,
  patch: Partial<PublicMarketSyncJob> = {},
): PublicMarketSyncJob {
  return {
    jobKey: PUBLIC_STOCK_JOB_KEY,
    status: 'running',
    totalItems: SINA_UNIVERSE_MAX_PAGES,
    processedItems: 0,
    writtenRows: 0,
    currentItem: null,
    message: '正在低频读取公共证券列表',
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...patch,
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

export async function fetchPublicStockUniverse(
  db: Database.Database,
  dependencies: PublicStockUniverseDependencies = {},
): Promise<PublicStockUniverseFetchResult> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const governor = dependencies.governor ?? getPersistentPublicMarketRequestGovernor(db)
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = dependencies.now ?? Date.now
  const transformedRows: CanonicalStockIdentity[] = []
  const marketRows: unknown[] = []
  let rejectedRows = 0
  let rawRows = 0
  let pageCount = 0
  const startedAt = getPublicMarketSyncJob(db, PUBLIC_STOCK_JOB_KEY)?.startedAt ?? now()

  for (let page = 1; page <= SINA_UNIVERSE_MAX_PAGES; page += 1) {
    const jobNow = now()
    publishJob(db, createJob(startedAt, {
      processedItems: page - 1,
      writtenRows: rawRows,
      currentItem: `第 ${page} 页`,
      message: `正在读取公共证券列表第 ${page} 页，全部请求按单并发低频执行`,
      updatedAt: jobNow,
    }), dependencies.onProgress)

    const governed = await governor.run(SINA_UNIVERSE_PROVIDER, async () => {
      const response = await fetchImpl(pageUrl(page), {
        headers: {
          Accept: 'application/json,text/plain,*/*',
          Referer: 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121 Safari/537.36',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      if (!response.ok) return { status: response.status, body: null }
      const body: unknown = JSON.parse(text)
      if (!Array.isArray(body)) throw errorWithCode('PUBLIC_STOCK_UNIVERSE_INVALID_RESPONSE')
      return { status: response.status, body }
    })
    if (governed.value.status < 200 || governed.value.status >= 400) {
      throw errorWithCode(
        `PUBLIC_STOCK_UNIVERSE_HTTP_${governed.value.status}`,
        `公共证券列表请求失败（HTTP ${governed.value.status}）`,
      )
    }

    const pageRows = governed.value.body ?? []
    const transformed = transformSinaStockUniverseRows(pageRows)
    pageCount = page
    rawRows += pageRows.length
    marketRows.push(...pageRows)
    rejectedRows += transformed.rejected.length
    transformedRows.push(...transformed.rows)
    if (pageRows.length < SINA_UNIVERSE_PAGE_SIZE) break
  }

  const deduplicated = deduplicateStockUniverse(transformedRows)
  if (
    deduplicated.rows.length < MIN_PUBLIC_STOCK_UNIVERSE_ROWS
    || rejectedRows > 0
    || deduplicated.conflicts.length > 0
  ) {
    throw errorWithCode(
      'PUBLIC_STOCK_UNIVERSE_INCOMPLETE',
      `公共证券列表覆盖不足：唯一证券 ${deduplicated.rows.length}，拒绝 ${rejectedRows}，冲突 ${deduplicated.conflicts.length}`,
    )
  }
  return {
    rows: deduplicated.rows,
    marketRows,
    pageCount,
    rawRows,
    rejectedRows,
    identityConflicts: deduplicated.conflicts.length,
  }
}

let publicStockUniverseSyncPromise: Promise<PublicStockUniverseSyncResult> | null = null
let recentSinaMarketRows: { capturedAt: number; rows: unknown[] } | null = null

export function runPublicStockUniverseSync(
  db: Database.Database,
  dependencies: PublicStockUniverseDependencies = {},
): Promise<PublicStockUniverseSyncResult> {
  if (publicStockUniverseSyncPromise) return publicStockUniverseSyncPromise
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  publishJob(db, createJob(startedAt), dependencies.onProgress)

  let promise: Promise<PublicStockUniverseSyncResult>
  promise = (async () => {
    try {
      const fetched = await fetchPublicStockUniverse(db, dependencies)
      const observedAt = now()
      recentSinaMarketRows = { capturedAt: observedAt, rows: fetched.marketRows }
      const merged = mergePublicStockIdentities(db, fetched.rows.map((row) => ({
        tsCode: row.tsCode,
        name: row.name,
        market: row.market,
        listStatus: 'L',
        observedAt,
      })))
      const result: PublicStockUniverseSyncResult = {
        ...merged,
        source: 'sina',
        pageCount: fetched.pageCount,
        rejectedRows: fetched.rejectedRows,
        identityConflicts: fetched.identityConflicts,
      }
      publishJob(db, createJob(startedAt, {
        status: 'success',
        totalItems: fetched.pageCount,
        processedItems: fetched.pageCount,
        writtenRows: merged.totalRows,
        currentItem: null,
        message: `公共证券列表同步完成：${merged.totalRows} 只，新增 ${merged.insertedRows} 只`,
        completedAt: observedAt,
        updatedAt: observedAt,
      }), dependencies.onProgress)
      return result
    } catch (error) {
      const failedAt = now()
      const coolingDown = error instanceof PublicMarketProviderCoolingDownError
      const currentJob = getPublicMarketSyncJob(db, PUBLIC_STOCK_JOB_KEY)
      publishJob(db, createJob(startedAt, {
        status: coolingDown ? 'cooldown' : 'failed',
        totalItems: currentJob?.totalItems ?? SINA_UNIVERSE_MAX_PAGES,
        processedItems: currentJob?.processedItems ?? 0,
        writtenRows: currentJob?.writtenRows ?? 0,
        currentItem: currentJob?.currentItem ?? null,
        message: coolingDown
          ? `公共证券来源冷却至 ${new Date(error.resumeAt).toLocaleString('zh-CN')}`
          : (error instanceof Error ? error.message : String(error)).slice(0, 300),
        completedAt: failedAt,
        updatedAt: failedAt,
      }), dependencies.onProgress)
      throw error
    }
  })().finally(() => {
    if (publicStockUniverseSyncPromise === promise) publicStockUniverseSyncPromise = null
  })
  publicStockUniverseSyncPromise = promise
  return promise
}

export function isPublicStockUniverseSyncRunning(): boolean {
  return publicStockUniverseSyncPromise !== null
}

export function getRecentSinaMarketRows(
  now = Date.now(),
  maxAgeMs = 20 * 60_000,
): { capturedAt: number; rows: unknown[] } | null {
  if (!recentSinaMarketRows || now - recentSinaMarketRows.capturedAt > maxAgeMs) return null
  return recentSinaMarketRows
}
