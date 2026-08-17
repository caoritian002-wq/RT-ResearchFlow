import type Database from 'better-sqlite3'
import { upsertDailyClose } from '../database/dailyCloseCacheRepository'
import {
  advanceSuccessfulPublicDailyCheckpoints,
  upsertPublicMarketSyncJob,
  type PublicMarketSyncJob,
} from '../database/publicMarketDataRepository'
import { transformSinaMarketSnapshotRows } from '../../../scripts/lib/canonical-daily-bar-transformer.mjs'
import {
  getPersistentPublicMarketRequestGovernor,
  PublicMarketProviderCoolingDownError,
  type PersistentPublicMarketRequestGovernor,
} from './publicMarketRequestGovernor'
import { getRecentSinaMarketRows } from './publicStockUniverseService'
import type { DailyRow } from './tushareService'

const PUBLIC_DAILY_SNAPSHOT_JOB_KEY = 'daily_snapshot_public'
const MIN_PUBLIC_DAILY_SNAPSHOT_ROWS = 4_000
const DEFAULT_TIMEOUT_MS = 15_000

interface PublicDailySnapshotDependencies {
  fetchImpl?: typeof fetch
  governor?: PersistentPublicMarketRequestGovernor
  now?: () => number
  timeoutMs?: number
  marketRows?: unknown[]
  onProgress?: (job: PublicMarketSyncJob) => void
}

export interface PublicDailySnapshotSyncResult {
  tradeDate: string
  quoteTime: string
  writtenRows: number
  rejectedRows: number
  advancedCheckpoints: number
  dailyRows: DailyRow[]
}

function errorWithCode(code: string, message = code): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

export function parseSinaQuoteTradeClock(text: string): { tradeDate: string; quoteTime: string } | null {
  const match = text.match(/,(\d{4}-\d{2}-\d{2}),(\d{2}:\d{2}:\d{2})(?:,|")/)
  if (!match) return null
  return {
    tradeDate: match[1].replaceAll('-', ''),
    quoteTime: match[2],
  }
}

async function fetchSinaQuoteTradeClock(
  governor: PersistentPublicMarketRequestGovernor,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ tradeDate: string; quoteTime: string }> {
  const governed = await governor.run('sina', async () => {
    const response = await fetchImpl('https://hq.sinajs.cn/list=sh000001', {
      headers: {
        Accept: 'text/plain,*/*',
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121 Safari/537.36',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: response.status, text: await response.text() }
  })
  if (governed.value.status < 200 || governed.value.status >= 400) {
    throw errorWithCode('PUBLIC_SNAPSHOT_DATE_HTTP_ERROR')
  }
  const parsed = parseSinaQuoteTradeClock(governed.value.text)
  if (!parsed) throw errorWithCode('PUBLIC_SNAPSHOT_DATE_UNAVAILABLE')
  return parsed
}

function publishJob(
  db: Database.Database,
  job: PublicMarketSyncJob,
  onProgress?: (job: PublicMarketSyncJob) => void,
): void {
  upsertPublicMarketSyncJob(db, job)
  onProgress?.({ ...job })
}

export async function runPublicDailySnapshotSync(
  db: Database.Database,
  expectedTradeDate: string,
  dependencies: PublicDailySnapshotDependencies = {},
): Promise<PublicDailySnapshotSyncResult> {
  if (!/^\d{8}$/.test(expectedTradeDate)) throw errorWithCode('PUBLIC_SNAPSHOT_INVALID_TRADE_DATE')
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const marketRows = dependencies.marketRows ?? getRecentSinaMarketRows(startedAt)?.rows
  if (!marketRows || marketRows.length < MIN_PUBLIC_DAILY_SNAPSHOT_ROWS) {
    throw errorWithCode(
      'PUBLIC_SNAPSHOT_MARKET_ROWS_UNAVAILABLE',
      '本轮没有可复用的完整公共证券截面，不额外重复全市场请求',
    )
  }
  publishJob(db, {
    jobKey: PUBLIC_DAILY_SNAPSHOT_JOB_KEY,
    status: 'running',
    totalItems: marketRows.length,
    processedItems: 0,
    writtenRows: 0,
    currentItem: expectedTradeDate,
    message: '正在校验公共盘后截面的真实交易日期',
    startedAt,
    completedAt: null,
    updatedAt: startedAt,
  }, dependencies.onProgress)

  try {
    const quote = await fetchSinaQuoteTradeClock(
      dependencies.governor ?? getPersistentPublicMarketRequestGovernor(db),
      dependencies.fetchImpl ?? fetch,
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    if (quote.tradeDate !== expectedTradeDate || quote.quoteTime < '15:00:00') {
      throw errorWithCode(
        'PUBLIC_SNAPSHOT_NOT_SETTLED',
        `公共截面实际时间 ${quote.tradeDate} ${quote.quoteTime}，不写入预期交易日 ${expectedTradeDate}`,
      )
    }
    const transformed = transformSinaMarketSnapshotRows(marketRows, quote.tradeDate)
    if (transformed.rows.length < MIN_PUBLIC_DAILY_SNAPSHOT_ROWS) {
      throw errorWithCode(
        'PUBLIC_SNAPSHOT_INCOMPLETE',
        `公共盘后截面规范日线仅 ${transformed.rows.length} 条，本次不写入`,
      )
    }
    const dailyRows: DailyRow[] = transformed.rows.flatMap((row) => row.pctChg == null ? [] : [{
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
    const completedAt = now()
    upsertDailyClose(db, dailyRows, {
      dataSource: 'sina_snapshot',
      amountSource: 'sina_snapshot',
      turnoverSource: 'sina_snapshot',
      fetchedAt: completedAt,
    })
    const advancedCheckpoints = advanceSuccessfulPublicDailyCheckpoints(db, quote.tradeDate, completedAt)
    publishJob(db, {
      jobKey: PUBLIC_DAILY_SNAPSHOT_JOB_KEY,
      status: 'success',
      totalItems: marketRows.length,
      processedItems: marketRows.length,
      writtenRows: dailyRows.length,
      currentItem: null,
      message: `公共盘后截面写入 ${dailyRows.length} 条，复用证券池请求且未逐股补采`,
      startedAt,
      completedAt,
      updatedAt: completedAt,
    }, dependencies.onProgress)
    return {
      tradeDate: quote.tradeDate,
      quoteTime: quote.quoteTime,
      writtenRows: dailyRows.length,
      rejectedRows: transformed.rejected.length,
      advancedCheckpoints,
      dailyRows,
    }
  } catch (error) {
    const failedAt = now()
    publishJob(db, {
      jobKey: PUBLIC_DAILY_SNAPSHOT_JOB_KEY,
      status: error instanceof PublicMarketProviderCoolingDownError ? 'cooldown' : 'failed',
      totalItems: marketRows.length,
      processedItems: 0,
      writtenRows: 0,
      currentItem: expectedTradeDate,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      startedAt,
      completedAt: failedAt,
      updatedAt: failedAt,
    }, dependencies.onProgress)
    throw error
  }
}
