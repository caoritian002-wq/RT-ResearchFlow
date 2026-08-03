import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { getMarketOverviewSnapshot, type MarketOverviewSnapshot } from '../services/marketOverviewService'
import {
  getMarketResonanceSnapshot,
  type MarketResonanceSnapshot,
} from '../services/marketResonanceService'
import { getRtKCache } from '../services/sharedRtKCache'

// ─── 内存缓存（60s TTL）────────────────────────────────────────

export type MarketOverviewWithResonanceSnapshot = MarketOverviewSnapshot & {
  resonance: MarketResonanceSnapshot
}

let _overviewCache: MarketOverviewWithResonanceSnapshot | null = null
let _overviewCachedAt = 0
const OVERVIEW_TTL = 60_000

// singleflight：避免前端高频点击导致并发重复计算
let _overviewInflight: Promise<MarketOverviewWithResonanceSnapshot> | null = null

async function fetchOverview(forceRefresh = false): Promise<MarketOverviewWithResonanceSnapshot> {
  if (!forceRefresh && _overviewCache !== null && Date.now() - _overviewCachedAt < OVERVIEW_TTL) {
    return _overviewCache
  }
  if (_overviewInflight) {
    return _overviewInflight
  }
  _overviewInflight = (async () => {
    const db = getDb()
    const [baseSnapshot, resonance] = await Promise.all([
      Promise.resolve(getMarketOverviewSnapshot(db)),
      getMarketResonanceSnapshot(forceRefresh),
    ])
    const snapshot = { ...baseSnapshot, resonance }
    _overviewCache = snapshot
    _overviewCachedAt = Date.now()
    return snapshot
  })()
  try {
    return await _overviewInflight
  } finally {
    _overviewInflight = null
  }
}

// ─── IPC 注册 ─────────────────────────────────────────────────

export function registerMarketOverviewHandlers(): void {
  /** 市场共振快照：市场背景 + 指数/申万一级行业一分钟共振指标 */
  ipcMain.handle('market:getMarketOverview', async (_event, payload?: { forceRefresh?: boolean }) => {
    try {
      const snapshot = await fetchOverview(payload?.forceRefresh === true)
      return { ok: true, snapshot }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[MarketOverview] getMarketOverview error:', msg)
      return {
        ok: false,
        code: 'MARKET_RESONANCE_UNAVAILABLE',
        error: '指数与行业分时数据暂不可用，请稍后重试。',
      }
    }
  })

  /** 题材成分股列表：从 kpl_concept_members 查询，并从 sharedRtKCache 补充实时行情 */
  ipcMain.handle('market:getConceptConstituents', (_event, payload: { conCode?: string }) => {
    const conCode = payload?.conCode?.trim()
    if (!conCode) {
      return { ok: false, error: 'Missing conCode', code: 'INVALID_PARAM' }
    }
    try {
      const db = getDb()
      const cache = getRtKCache()
      // con_code 列存成员股 ts_code，ts_code 列存题材代码
      const rows = db
        .prepare(
          `SELECT con_code, name FROM kpl_concept_members WHERE ts_code = ? ORDER BY hot_num DESC LIMIT 100`
        )
        .all(conCode) as { con_code: string; name: string | null }[]

      const members = rows.map((r) => {
        const entry = cache?.get(r.con_code)
        const rawCode = r.con_code.split('.')[0]
        return {
          tsCode: r.con_code,
          stockCode: rawCode,
          name: r.name ?? entry?.name ?? rawCode,
          change: entry?.change ?? 0,
          price: entry?.price ?? 0,
        }
      })
      // 按涨跌幅绝对值降序
      members.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      return { ok: true, members }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[MarketOverview] getConceptConstituents error:', msg)
      return { ok: false, error: msg, code: 'UPSTREAM_ERROR' }
    }
  })
}
