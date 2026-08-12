import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { getMarketOverviewSnapshot, type MarketOverviewSnapshot } from '../services/marketOverviewService'
import {
  getMarketResonanceSnapshot,
  type MarketResonanceSnapshot,
} from '../services/marketResonanceService'
import {
  getMarketResonanceIndustryChildren,
  type MarketResonanceIndustryChildrenRequest,
} from '../services/marketResonanceIndustryService'
import { SHENWAN_L1_CODE_SET } from '../services/eastmoneyIndustryHierarchy'
import { getNextTradeDay, getPrevTradeDay } from '../database/tradeCalRepository'
import { getRtKCache } from '../services/sharedRtKCache'

// ─── 内存缓存（60s TTL）────────────────────────────────────────

export type MarketOverviewWithResonanceSnapshot = MarketOverviewSnapshot & {
  resonance: MarketResonanceSnapshot
  navigation: MarketOverviewNavigation
  quality: MarketOverviewQuality
}

export interface MarketOverviewNavigation {
  selectedTradeDate: string
  previousTradeDate: string | null
  nextTradeDate: string | null
  latestTradeDate: string
}

type MarketOverviewMissingPart =
  | 'benchmark_trends'
  | 'sector_trends'
  | 'board_facts'
  | 'distribution'
  | 'timeline'
  | 'timeline_approximate'

export interface MarketOverviewQuality {
  status: 'complete' | 'partial'
  missingParts: MarketOverviewMissingPart[]
}

interface MarketOverviewRequest {
  tradeDate?: string | null
  forceRefresh?: boolean
}

const _overviewCache = new Map<string, { snapshot: MarketOverviewWithResonanceSnapshot; cachedAt: number }>()
const OVERVIEW_TTL = 60_000

// singleflight：避免前端高频点击导致并发重复计算
const _overviewInflight = new Map<string, Promise<MarketOverviewWithResonanceSnapshot>>()

async function fetchOverview(request: MarketOverviewRequest = {}): Promise<MarketOverviewWithResonanceSnapshot> {
  const tradeDate = normalizeTradeDate(request.tradeDate)
  const forceRefresh = request.forceRefresh === true
  const cacheKey = tradeDate ?? 'latest'
  const cached = _overviewCache.get(cacheKey)
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < OVERVIEW_TTL) {
    return cached.snapshot
  }
  const inflightKey = `${cacheKey}:${forceRefresh ? 'refresh' : 'read'}`
  let activeRequest = _overviewInflight.get(inflightKey)
  if (activeRequest) return activeRequest
  if (forceRefresh) {
    const pendingRead = _overviewInflight.get(`${cacheKey}:read`)
    if (pendingRead) {
      try {
        await pendingRead
      } catch {
        // The explicit recovery still runs after an ordinary read failure.
      }
      activeRequest = _overviewInflight.get(inflightKey)
      if (activeRequest) return activeRequest
    }
  }

  const promise = (async () => {
    const db = getDb()
    const resonance = await getMarketResonanceSnapshot(db, { tradeDate, forceRefresh })
    const baseSnapshot = getMarketOverviewSnapshot(db, { tradeDate: resonance.tradeDate })
    const snapshot = {
      ...baseSnapshot,
      resonance,
      navigation: resolveNavigation(
        db,
        resonance.tradeDate,
        resonance.recoverableTradeDates ?? [resonance.tradeDate],
      ),
      quality: resolveOverviewQuality(baseSnapshot, resonance),
    }
    if (resonance.sourceMode === 'network_backfill') _overviewCache.delete(cacheKey)
    else _overviewCache.set(cacheKey, { snapshot, cachedAt: Date.now() })
    return snapshot
  })().finally(() => {
    _overviewInflight.delete(inflightKey)
  })
  _overviewInflight.set(inflightKey, promise)
  return promise
}

function resolveNavigation(
  db: ReturnType<typeof getDb>,
  selectedTradeDate: string,
  recoverableTradeDates: string[],
): MarketOverviewNavigation {
  const latestRow = db.prepare(`
    SELECT MAX(trade_date) AS trade_date
    FROM (
      SELECT trade_date FROM daily_close_cache
      UNION ALL SELECT trade_date FROM market_timeline_daily
      UNION ALL SELECT trade_date FROM sector_flow_observations
      UNION ALL SELECT trade_date FROM market_resonance_daily_snapshots
    )
  `).get() as { trade_date: string | null }
  const today = beijingYmd()
  const latestTradeDate = [selectedTradeDate, latestRow.trade_date ?? '', ...recoverableTradeDates]
    .filter((date) => isValidCompactDate(date) && date <= today)
    .sort((left, right) => right.localeCompare(left))[0]
  const previousTradeDate = nearestTradeDate([
    getPrevTradeDay(db, selectedTradeDate),
    getStoredAdjacentTradeDate(db, selectedTradeDate, 'previous'),
    getRecoverableAdjacentTradeDate(recoverableTradeDates, selectedTradeDate, 'previous'),
  ], 'previous')
  const candidateNext = nearestTradeDate([
    getNextTradeDay(db, selectedTradeDate),
    getStoredAdjacentTradeDate(db, selectedTradeDate, 'next'),
    getRecoverableAdjacentTradeDate(recoverableTradeDates, selectedTradeDate, 'next'),
  ], 'next')
  return {
    selectedTradeDate,
    previousTradeDate,
    nextTradeDate: candidateNext && candidateNext <= latestTradeDate ? candidateNext : null,
    latestTradeDate,
  }
}

function nearestTradeDate(
  candidates: Array<string | null>,
  direction: 'previous' | 'next',
): string | null {
  return candidates
    .filter((date): date is string => Boolean(date))
    .sort((left, right) => direction === 'previous'
      ? right.localeCompare(left)
      : left.localeCompare(right))[0] ?? null
}

function getRecoverableAdjacentTradeDate(
  recoverableTradeDates: string[],
  tradeDate: string,
  direction: 'previous' | 'next',
): string | null {
  const candidates = recoverableTradeDates
    .filter((date) => direction === 'previous' ? date < tradeDate : date > tradeDate)
    .sort((left, right) => direction === 'previous'
      ? right.localeCompare(left)
      : left.localeCompare(right))
  return candidates[0] ?? null
}

function getStoredAdjacentTradeDate(
  db: ReturnType<typeof getDb>,
  tradeDate: string,
  direction: 'previous' | 'next',
): string | null {
  const operator = direction === 'previous' ? '<' : '>'
  const aggregate = direction === 'previous' ? 'MAX' : 'MIN'
  const row = db.prepare(`
    SELECT ${aggregate}(trade_date) AS trade_date
    FROM (
      SELECT trade_date FROM daily_close_cache
      UNION ALL SELECT trade_date FROM market_timeline_daily
      UNION ALL SELECT trade_date FROM sector_flow_observations
      UNION ALL SELECT trade_date FROM market_resonance_daily_snapshots
    )
    WHERE trade_date ${operator} ?
  `).get(tradeDate) as { trade_date: string | null }
  return row.trade_date ?? null
}

function normalizeTradeDate(value: string | null | undefined): string | null {
  if (value == null) return null
  if (!isValidCompactDate(value)) throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  const today = beijingYmd()
  if (value > today) throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  return value
}

function isValidCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function parseMarketOverviewRequest(payload: unknown): MarketOverviewRequest {
  if (payload === undefined) return {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  }
  const input = payload as Record<string, unknown>
  const allowedKeys = new Set(['tradeDate', 'forceRefresh'])
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  }
  if (
    Object.prototype.hasOwnProperty.call(input, 'forceRefresh')
    && typeof input.forceRefresh !== 'boolean'
  ) {
    throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  }
  if (
    Object.prototype.hasOwnProperty.call(input, 'tradeDate')
    && input.tradeDate !== null
    && typeof input.tradeDate !== 'string'
  ) {
    throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  }
  const tradeDate = normalizeTradeDate(input.tradeDate as string | null | undefined)
  return {
    ...(tradeDate ? { tradeDate } : {}),
    ...(typeof input.forceRefresh === 'boolean' ? { forceRefresh: input.forceRefresh } : {}),
  }
}

function parseMarketResonanceChildrenRequest(payload: unknown): MarketResonanceIndustryChildrenRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('INVALID_MARKET_RESONANCE_CHILDREN_REQUEST')
  }
  const input = payload as Record<string, unknown>
  const allowedKeys = new Set(['tradeDate', 'parentIndustryCode', 'forceRefresh'])
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error('INVALID_MARKET_RESONANCE_CHILDREN_REQUEST')
  }
  if (
    typeof input.tradeDate !== 'string'
    || !isValidCompactDate(input.tradeDate)
    || input.tradeDate > beijingYmd()
    || typeof input.parentIndustryCode !== 'string'
    || !SHENWAN_L1_CODE_SET.has(input.parentIndustryCode)
    || (
      Object.prototype.hasOwnProperty.call(input, 'forceRefresh')
      && typeof input.forceRefresh !== 'boolean'
    )
  ) {
    throw new Error('INVALID_MARKET_RESONANCE_CHILDREN_REQUEST')
  }
  return {
    tradeDate: input.tradeDate,
    parentIndustryCode: input.parentIndustryCode,
    ...(typeof input.forceRefresh === 'boolean' ? { forceRefresh: input.forceRefresh } : {}),
  }
}

function resolveOverviewQuality(
  overview: MarketOverviewSnapshot,
  resonance: MarketResonanceSnapshot,
): MarketOverviewQuality {
  const missingParts: MarketOverviewMissingPart[] = []
  if (resonance.coverage.benchmarkTrends.available < resonance.coverage.benchmarkTrends.total) {
    missingParts.push('benchmark_trends')
  }
  if (resonance.coverage.sectorTrends.available < resonance.coverage.sectorTrends.total) {
    missingParts.push('sector_trends')
  }
  if (resonance.coverage.boardFacts.available < resonance.coverage.boardFacts.total) {
    missingParts.push('board_facts')
  }
  if (!overview.coverage.distribution.available) missingParts.push('distribution')
  if (overview.coverage.timeline.mode === 'missing') missingParts.push('timeline')
  if (overview.coverage.timeline.mode === 'approximate') missingParts.push('timeline_approximate')
  return {
    status: missingParts.length > 0 ? 'partial' : 'complete',
    missingParts,
  }
}

function beijingYmd(now = Date.now()): string {
  const date = new Date(now + 8 * 60 * 60 * 1000)
  return (
    `${date.getUTCFullYear()}`
    + `${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    + `${String(date.getUTCDate()).padStart(2, '0')}`
  )
}

function marketOverviewError(error: unknown): { code: string; error: string } {
  const message = error instanceof Error ? error.message : String(error)
  if (
    message === 'INVALID_MARKET_OVERVIEW_REQUEST'
    || message === 'INVALID_TRADE_DATE'
  ) {
    return {
      code: 'INVALID_MARKET_OVERVIEW_REQUEST',
      error: '交易日期格式不正确, 或不能选择未来日期。',
    }
  }
  if (message === 'MARKET_RESONANCE_ARCHIVE_CORRUPTED') {
    return {
      code: 'MARKET_RESONANCE_ARCHIVE_CORRUPTED',
      error: '本地历史快照已损坏, 可重新补采该交易日。',
    }
  }
  if (
    message === 'EASTMONEY_TREND_DATE_UNAVAILABLE'
    || message === 'MARKET_RESONANCE_INSUFFICIENT'
    || message === 'MARKET_HISTORY_DATE_UNAVAILABLE'
  ) {
    return {
      code: 'MARKET_HISTORY_DATE_UNAVAILABLE',
      error: '该交易日的历史分钟数据暂不完整, 可稍后重新补采。',
    }
  }
  return {
    code: 'MARKET_RESONANCE_UNAVAILABLE',
    error: '指数与行业分时数据暂不可用, 请稍后重试。',
  }
}

// ─── IPC 注册 ─────────────────────────────────────────────────

export function registerMarketOverviewHandlers(): void {
  /** 市场共振快照：市场背景 + 指数/申万一级行业一分钟共振指标 */
  ipcMain.handle('market:getMarketOverview', async (_event, payload?: unknown) => {
    try {
      const snapshot = await fetchOverview(parseMarketOverviewRequest(payload))
      return { ok: true, snapshot }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[MarketOverview] getMarketOverview error:', msg)
      return { ok: false, ...marketOverviewError(err) }
    }
  })

  /** FR-262：只在展开一级行业时读取对应申万二级事实与分钟曲线。 */
  ipcMain.handle('market:getMarketResonanceChildren', async (_event, payload?: unknown) => {
    try {
      const request = parseMarketResonanceChildrenRequest(payload)
      const result = await getMarketResonanceIndustryChildren(getDb(), request)
      return { ok: true, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'INVALID_MARKET_RESONANCE_CHILDREN_REQUEST') {
        return {
          ok: false,
          code: 'INVALID_MARKET_RESONANCE_CHILDREN_REQUEST',
          error: '交易日期或一级行业参数不正确。',
        }
      }
      console.error('[MarketOverview] getMarketResonanceChildren error:', message)
      return {
        ok: false,
        code: 'MARKET_RESONANCE_CHILDREN_UNAVAILABLE',
        error: '二级行业数据暂不可用，请稍后重试。',
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
