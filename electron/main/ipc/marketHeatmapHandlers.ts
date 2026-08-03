import { ipcMain } from 'electron'
import {
  fetchMarketSnapshot,
  fetchIndustryConstituents,
  EmptyDataError,
  type HeatmapStock
} from '../services/marketHeatmapService'

/**
 * FR-096/FR-114: 行业云图 IPC 处理器
 * - marketHeatmap:getSnapshot                — 拉取全市场快照
 * - marketHeatmap:getIndustryConstituents    — Hover 懒加载单个行业成分股
 *   （仅东财数据源会发上游请求；新浪模式从 lastSnapshot 缓存读取）
 *
 * 四层防护（仅 getIndustryConstituents）：
 *   1. LRU 缓存（TTL 30s，容量 100）
 *   2. Singleflight（同行业并发请求合并）
 *   3. 令牌桶限速（全局 2 QPS，容量 4）
 *   4. 前端防抖（300ms hover 才触发，不在 IPC 层）
 */

interface CacheEntry {
  data: HeatmapStock[]
  cachedAt: number
}

const CACHE_TTL_MS = 30_000
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
      return { ok: false, code: 'UPSTREAM_ERROR', message: msg }
    }
  })

  // FR-114: hover 懒加载行业成分股
  ipcMain.handle(
    'marketHeatmap:getIndustryConstituents',
    async (_event, payload: { industryCode?: string; industryName?: string } | undefined) => {
      const industryCode = (payload?.industryCode ?? '').trim()
      const industryName = (payload?.industryName ?? '').trim()
      if (!industryName && !industryCode) {
        return { ok: false, code: 'INVALID_PARAM', message: 'missing industryCode and industryName' }
      }

      // 缓存 key 同时考虑 code 和 name（新浪模式下 code 可能为空，但 name 必不为空）
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
