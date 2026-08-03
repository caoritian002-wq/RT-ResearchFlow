import type Database from 'better-sqlite3'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { upsertStkAuctionCache } from '../database/stkAuctionCacheRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { fetchStkAuction } from './tushareService'

export interface PremarketAuctionBackfillResult {
  status: 'completed' | 'unavailable' | 'failed'
  itemCount: number
  errorCode: string | null
}

export async function refreshPremarketAuctionHistory(
  db: Database.Database,
  tradeDate: string,
): Promise<PremarketAuctionBackfillResult> {
  const config = getDataSourceConfig(db)
  const token = config.tushareEnabled && config.tushareTokenEncrypted
    ? decryptApiKey(config.tushareTokenEncrypted)
    : null
  if (!token) {
    return { status: 'unavailable', itemCount: 0, errorCode: 'TUSHARE_NOT_CONFIGURED' }
  }
  try {
    const rows = await fetchStkAuction(token, tradeDate)
    if (rows.length > 0) upsertStkAuctionCache(db, rows)
    return {
      status: 'completed',
      itemCount: rows.length,
      errorCode: rows.length > 0 ? null : 'AUCTION_HISTORY_EMPTY',
    }
  } catch (error) {
    console.warn('[Premarket] auction history backfill failed:', error instanceof Error ? error.message : String(error))
    return { status: 'failed', itemCount: 0, errorCode: 'AUCTION_HISTORY_FETCH_FAILED' }
  }
}
