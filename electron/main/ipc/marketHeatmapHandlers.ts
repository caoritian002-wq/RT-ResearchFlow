import { ipcMain } from 'electron'
import {
  fetchMarketSnapshot,
  fetchIndustryConstituents,
  EmptyDataError,
  type HeatmapStock
} from '../services/marketHeatmapService'
import { getDb } from '../database/db'
import { recoverHeatmapMomentum } from '../services/marketHeatmapMomentumRecoveryService'

/**
 * FR-096/FR-114: 行业云图 IPC 处理器
 * - marketHeatmap:getSnapshot                — 拉取全市场快照
 * - marketHeatmap:getIndustryConstituents    — Hover 懒加载单个行业成分股
 * - marketHeatmap:recoverMomentum            — 午休/盘后恢复最近交易边界动量
 *   （东财按板块读取；新浪仅对 hangye_Zxx 二级行业按需读取）
 *
 * 四层防护（仅 getIndustryConstituents）：
 *   1. LRU 缓存（TTL 60s，容量 100）
 *   2. Singleflight（同行业并发请求合并）
 *   3. 令牌桶限速（全局 2 QPS，容量 4）
 *   4. 前端防抖（300ms hover 才触发，不在 IPC 层）
 */

interface CacheEntry {
  data: HeatmapStock[]
  cachedAt: number
}

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 100
const constituentCache = new Map<string, CacheEntry>()
const inflightRequests = new Map<string, Promise<HeatmapStock[]>>()

// 令牌桶：容量 4，每 500ms 补 1 个 → 2 QPS
const TOKEN_CAPACITY = 4
const TOKEN_REFILL_INTERVAL_MS = 500
let tokens = TOKEN_CAPACITY

setInterval(() => {
  if (tokens < TOKEN_CAPACITY) tokens++
}, TOKEN_REFILL_INTERVAL_MS).unref?.()

async function acquireToken(): Promise<void> {
  while (tokens <= 0) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  tokens--
}

function getCached(key: string): HeatmapStock[] | null {
  const entry = constituentCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    constituentCache.delete(key)
    return null
  }
  return entry.data
}

function setCached(key: string, data: HeatmapStock[]): void {
  if (constituentCache.size >= CACHE_MAX) {
    // 删除最旧的一条（Map 迭代顺序为插入顺序）
    const oldestKey = constituentCache.keys().next().value
    if (oldestKey) constituentCache.delete(oldestKey)
  }
  constituentCache.set(key, { data, cachedAt: Date.now() })
}

export function registerMarketHeatmapHandlers(): void {
  ipcMain.handle('marketHeatmap:getSnapshot', async () => {
    try {
      const snapshot = await fetchMarketSnapshot()
      return { ok: true, data: snapshot }
    } catch (err) {
      if (err instanceof EmptyDataError) {
        return { ok: false, code: 'EMPTY_DATA', message: err.message }
      }
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted|timeout/i.test(err.message))
      if (isAbort) {
        return { ok: false, code: 'UPSTREAM_TIMEOUT', message: '数据源接口超时，请稍后重试' }
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[marketHeatmap] fetch failed:', msg)
      if (/SINA_RATE_LIMIT(?:ED|_COOLDOWN)|HTTP (403|429|456)/i.test(msg)) {
        return { ok: false, code: 'UPSTREAM_RATE_LIMITED', message: '数据源请求过于频繁，请稍后重试' }
      }
      return { ok: false, code: 'UPSTREAM_ERROR', message: '数据源暂时不可用，请稍后重试' }
    }
  })

  ipcMain.handle(
    'marketHeatmap:recoverMomentum',
    async (_event, payload: {
      windowMinutes?: number
      includeL2?: boolean
      forceRefresh?: boolean
      existingRecord?: {
        tradeDate?: string
        boundary?: string
        windowMinutes?: number
      }
    } | undefined) => {
      const windowMinutes = payload?.windowMinutes
      if (
        !Number.isInteger(windowMinutes)
        || (windowMinutes as number) < 1
        || (windowMinutes as number) > 30
        || typeof payload?.includeL2 !== 'boolean'
        || (payload.forceRefresh != null && typeof payload.forceRefresh !== 'boolean')
        || (
          payload.existingRecord != null
          && (
            !/^\d{4}-\d{2}-\d{2}$/.test(payload.existingRecord.tradeDate ?? '')
            || !['lunch-close', 'market-close'].includes(payload.existingRecord.boundary ?? '')
            || !Number.isInteger(payload.existingRecord.windowMinutes)
            || (payload.existingRecord.windowMinutes as number) < 1
            || (payload.existingRecord.windowMinutes as number) > 30
          )
        )
      ) {
        return { ok: false, code: 'INVALID_PARAM', message: '动量恢复参数无效' }
      }
      try {
        const data = await recoverHeatmapMomentum(getDb(), {
          windowMinutes: windowMinutes as number,
          includeL2: payload.includeL2,
          forceRefresh: payload.forceRefresh === true,
          ...(payload.existingRecord ? {
            existingRecord: {
              tradeDate: payload.existingRecord.tradeDate as string,
              boundary: payload.existingRecord.boundary as 'lunch-close' | 'market-close',
              windowMinutes: payload.existingRecord.windowMinutes as number,
            },
          } : {}),
        })
        return { ok: true, data }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[marketHeatmap] momentum recovery failed:', message)
        if (/TIMEOUT|ABORT/i.test(message)) {
          return { ok: false, code: 'UPSTREAM_TIMEOUT', message: '历史分钟数据读取超时，请稍后重试' }
        }
        if (/HTTP_(403|429|456)|RATE_LIMIT/i.test(message)) {
          return { ok: false, code: 'UPSTREAM_RATE_LIMITED', message: '历史分钟数据请求过于频繁，请稍后重试' }
        }
        if (/TRADE_DATE_UNAVAILABLE|BOUNDARY_UNAVAILABLE|INSUFFICIENT_COVERAGE/.test(message)) {
          return { ok: false, code: 'HISTORICAL_DATA_UNAVAILABLE', message: '该交易边界的行业分钟数据暂不可恢复' }
        }
        return { ok: false, code: 'UPSTREAM_ERROR', message: '历史分钟数据暂不可用，请稍后重试' }
      }
    },
  )

  // FR-114: hover 懒加载行业成分股
  ipcMain.handle(
    'marketHeatmap:getIndustryConstituents',
    async (_event, payload: { industryCode?: string; industryName?: string } | undefined) => {
      const industryCode = (payload?.industryCode ?? '').trim()
      const industryName = (payload?.industryName ?? '').trim()
      if (!industryName && !industryCode) {
        return { ok: false, code: 'INVALID_PARAM', message: 'missing industryCode and industryName' }
      }

      // 缓存 key 同时考虑 code 和 name；新浪 L2 始终使用 hangye_Zxx 代码。
      const cacheKey = industryCode || `name:${industryName}`

      // 1) LRU 缓存命中
      const cached = getCached(cacheKey)
      if (cached) {
        return { ok: true, data: cached }
      }

      // 2) Singleflight 命中
      const inflight = inflightRequests.get(cacheKey)
      if (inflight) {
        try {
          const data = await inflight
          return { ok: true, data }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { ok: false, code: 'UPSTREAM_ERROR', message: msg }
        }
      }

      // 3) 令牌桶限速 → 实际发起请求
      const promise = (async () => {
        await acquireToken()
        return fetchIndustryConstituents(industryCode, industryName)
      })()
      inflightRequests.set(cacheKey, promise)

      try {
        const data = await promise
        setCached(cacheKey, data)
        return { ok: true, data }
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || /aborted|timeout/i.test(err.message))
        if (isAbort) {
          return { ok: false, code: 'UPSTREAM_TIMEOUT', message: '数据源接口超时' }
        }
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[marketHeatmap] constituents ${cacheKey} failed:`, msg)
        return { ok: false, code: 'UPSTREAM_ERROR', message: msg }
      } finally {
        inflightRequests.delete(cacheKey)
      }
    }
  )
}
