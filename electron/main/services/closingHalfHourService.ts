import { getDb } from '../database/db'
import { getLimitListByDate } from '../database/limitListDailyRepository'
import { getStockMinuteByDate, upsertStockMinute } from '../database/stockMinuteCacheRepository'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { getSignalsByStrategy, replaceSignalsByStrategyAndDate, type ShortTermSignalInsert } from '../database/shortTermSignalsRepository'
import { isTradeDay } from '../database/tradeCalRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { fetchStockMinuteDaily } from './tushareService'
import { getRtKCache, getRtKCachedAt, type SharedRtKEntry } from './sharedRtKCache'
import {
  buildClosingHalfHourWorkbenchJudgment,
  CLOSING_HALF_HOUR_STRATEGY_KEY,
  CLOSING_HALF_HOUR_STRATEGY_VERSION,
  judgeClosingHalfHourStock,
  type ClosingHalfHourDataMode,
  type ClosingHalfHourLegacyForm,
  type ClosingHalfHourStockJudgment,
  type ClosingHalfHourWorkbenchJudgment,
  type ClosingMinutePoint,
} from './closingHalfHourJudgmentModel'
import type { StockMinuteCacheRow } from '../database/types'

export type ClosingHalfHourWindowStatus = 'waiting' | 'live' | 'closed' | 'historical'
export type ClosingHalfHourCandidateSource = 'realtimeActive' | 'localMinuteCache' | 'eodLimitList' | 'savedSignal'

export interface ClosingHalfHourStock {
  tsCode: string
  stockCode: string
  stockName: string
  open: number | null
  previousClose: number | null
  closeFinal: number | null
  pctChg: number | null
  amountYuan: number | null
  judgment: ClosingHalfHourStockJudgment
}

export interface ClosingHalfHourSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: ClosingHalfHourDataMode
  candidateSource: ClosingHalfHourCandidateSource
  windowStatus: ClosingHalfHourWindowStatus
  latestMinute: string | null
  candidateCount: number
  stocks: ClosingHalfHourStock[]
  judgment: ClosingHalfHourWorkbenchJudgment
  strategyVersion: string
}

interface CandidateRow {
  tsCode: string
  name: string | null
  pctChg: number | null
  amountYuan: number | null
  previousClose: number | null
  priority: number
}

interface SavedSignalMeta {
  schemaVersion?: string
  generatedAt?: number
  dataMode?: ClosingHalfHourDataMode
  candidateSource?: ClosingHalfHourCandidateSource
  stock?: ClosingHalfHourStock
  workbench?: ClosingHalfHourWorkbenchJudgment
}

const MAX_REALTIME_CANDIDATES = 80
const MAX_SAVED_ACTIVE = 20
const MAX_SAVED_CONFIRM = 5
const FETCH_CONCURRENCY = 3

function getBjTodayYmd(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
}

function getBjMinutesNow(): number {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return now.getUTCHours() * 60 + now.getUTCMinutes()
}

function fallbackWeekday(tradeDate: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(tradeDate)
  if (!match) return false
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return day !== 0 && day !== 6
}

function resolveWindowStatus(tradeDate: string): ClosingHalfHourWindowStatus {
  const today = getBjTodayYmd()
  if (tradeDate !== today) return 'historical'
  const db = getDb()
  const knownTradeDay = isTradeDay(db, tradeDate)
  if (!(knownTradeDay ?? fallbackWeekday(tradeDate))) return 'historical'
  const minutes = getBjMinutesNow()
  if (minutes < 14 * 60 + 30) return 'waiting'
  if (minutes <= 15 * 60) return 'live'
  return 'closed'
}

function toTsCode(code: string): string {
  if (/^(4|8|92)/.test(code)) return `${code}.BJ`
  if (/^(5|6|9)/.test(code)) return `${code}.SH`
  return `${code}.SZ`
}

function toMinutePoints(rows: StockMinuteCacheRow[]): ClosingMinutePoint[] {
  return rows.map((row) => ({
    time: row.tsMinute,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    vol: row.vol,
    amount: row.amount,
  }))
}

function queryTodaySignalCodes(tradeDate: string): Set<string> {
  const rows = getDb().prepare(`
    SELECT DISTINCT ts_code AS tsCode
    FROM short_term_signals
    WHERE trade_date = ? AND ts_code IS NOT NULL AND strategy <> ?
  `).all(tradeDate, CLOSING_HALF_HOUR_STRATEGY_KEY) as Array<{ tsCode: string }>
  return new Set(rows.map((row) => row.tsCode.includes('.') ? row.tsCode : toTsCode(row.tsCode)))
}

function realtimeCandidates(tradeDate: string, cache: Map<string, SharedRtKEntry>): CandidateRow[] {
  const signalCodes = queryTodaySignalCodes(tradeDate)
  const candidates: CandidateRow[] = []
  for (const [tsCode, entry] of cache) {
    const fromShortTermSignal = signalCodes.has(tsCode)
    if (!fromShortTermSignal && Math.abs(entry.change) < 3) continue
    candidates.push({
      tsCode,
      name: entry.name,
      pctChg: entry.change,
      amountYuan: entry.amount > 0 ? entry.amount : null,
      previousClose: entry.preClose > 0 ? entry.preClose : null,
      priority: fromShortTermSignal ? 1 : 0,
    })
  }
  return candidates
    .sort((left, right) => right.priority - left.priority || (right.amountYuan ?? 0) - (left.amountYuan ?? 0))
    .slice(0, MAX_REALTIME_CANDIDATES)
}

function queryLocalCandidateCodes(tradeDate: string): string[] {
  const rows = getDb().prepare(`
    SELECT stock_code AS stockCode, MAX(fetched_at) AS fetchedAt
    FROM stock_minute_cache
    WHERE trade_date = ? AND ts_minute >= '14:30'
    GROUP BY stock_code
    ORDER BY fetchedAt DESC
    LIMIT ?
  `).all(tradeDate, MAX_REALTIME_CANDIDATES) as Array<{ stockCode: string }>
  return rows.map((row) => toTsCode(row.stockCode))
}

function queryStockName(tsCode: string): string | null {
  const row = getDb().prepare(`
    SELECT name FROM stock_basic_cache
    WHERE ts_code IN (?, ?)
    ORDER BY CASE WHEN ts_code = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(tsCode, tsCode.split('.')[0], tsCode) as { name: string | null } | undefined
  return row?.name ?? null
}

function queryPreviousClose(tsCode: string, tradeDate: string): number | null {
  const row = getDb().prepare(`
    SELECT close FROM daily_close_cache
    WHERE ts_code IN (?, ?) AND trade_date < ? AND close > 0
    ORDER BY trade_date DESC, CASE WHEN ts_code = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(tsCode, tsCode.split('.')[0], tradeDate, tsCode) as { close: number } | undefined
  return row?.close ?? null
}

function localCandidates(tradeDate: string): { source: ClosingHalfHourCandidateSource; rows: CandidateRow[] } {
  const limitRows = getLimitListByDate(getDb(), tradeDate)
  const limitByCode = new Map(limitRows.map((row) => [row.tsCode, row]))
  const localCodes = queryLocalCandidateCodes(tradeDate)
  const codes = localCodes.length > 0
    ? localCodes
    : limitRows.filter((row) => row.limit === 'U' || row.limit === 'D').map((row) => row.tsCode)
  return {
    source: localCodes.length > 0 ? 'localMinuteCache' : 'eodLimitList',
    rows: Array.from(new Set(codes)).slice(0, MAX_REALTIME_CANDIDATES).map((tsCode) => {
      const limit = limitByCode.get(tsCode)
      return {
        tsCode,
        name: limit?.name ?? queryStockName(tsCode),
        pctChg: limit?.pctChg ?? null,
        amountYuan: limit?.amount ?? null,
        previousClose: queryPreviousClose(tsCode, tradeDate),
        priority: 0,
      }
    }),
  }
}

async function fetchMinuteData(token: string, candidates: CandidateRow[], tradeDate: string): Promise<void> {
  if (tradeDate !== getBjTodayYmd()) return
  let success = 0
  let failed = 0
  for (let index = 0; index < candidates.length; index += FETCH_CONCURRENCY) {
    const batch = candidates.slice(index, index + FETCH_CONCURRENCY)
    await Promise.all(batch.map(async (candidate) => {
      try {
        const rows = await fetchStockMinuteDaily(token, candidate.tsCode, '1MIN')
        const sameDayRows = rows.filter((row) => row.tradeDate === tradeDate)
        if (sameDayRows.length > 0) upsertStockMinute(getDb(), sameDayRows)
        success += 1
      } catch (error) {
        failed += 1
        if (failed === 1) console.warn('[ClosingHalfHour] 分钟数据首个失败:', error instanceof Error ? error.message : String(error))
      }
    }))
  }
  console.log(`[ClosingHalfHour] 分钟数据完成 success=${success} failed=${failed} candidates=${candidates.length}`)
}

function latestMinute(stocks: ClosingHalfHourStock[]): string | null {
  const times = stocks.flatMap((stock) => stock.judgment.metrics.latestTime ? [stock.judgment.metrics.latestTime] : [])
  return times.length > 0 ? times.sort().at(-1) ?? null : null
}

function buildStock(candidate: CandidateRow, tradeDate: string, dataMode: ClosingHalfHourDataMode): ClosingHalfHourStock {
  const rows = getStockMinuteByDate(getDb(), candidate.tsCode.split('.')[0], tradeDate)
  const first = rows.find((row) => row.tsMinute >= '09:30' && row.tsMinute <= '15:00' && row.open != null)
  const open = first?.open ?? null
  const previousClose = candidate.previousClose ?? queryPreviousClose(candidate.tsCode, tradeDate)
  const last = rows.filter((row) => row.tsMinute <= '15:00' && row.close != null).at(-1)
  const pctChg = candidate.pctChg ?? (
    previousClose != null && previousClose > 0 && last?.close != null
      ? Math.round((last.close - previousClose) / previousClose * 10_000) / 100
      : null
  )
  const judgment = judgeClosingHalfHourStock({
    tsCode: candidate.tsCode,
    stockCode: candidate.tsCode.split('.')[0],
    stockName: candidate.name ?? candidate.tsCode,
    dataMode,
    dayOpen: open,
    previousClose,
    pctChg,
    dayAmount: candidate.amountYuan,
    minutePoints: toMinutePoints(rows),
  })
  return {
    tsCode: candidate.tsCode,
    stockCode: candidate.tsCode.split('.')[0],
    stockName: candidate.name ?? candidate.tsCode,
    open,
    previousClose,
    closeFinal: judgment.metrics.latestPrice,
    pctChg,
    amountYuan: candidate.amountYuan,
    judgment,
  }
}

function tierRank(stock: ClosingHalfHourStock): number {
  return stock.judgment.tier === 'active' ? 0
    : stock.judgment.tier === 'confirm' ? 1
      : stock.judgment.tier === 'retreat' ? 2
        : 3
}

function sortStocks(stocks: ClosingHalfHourStock[]): ClosingHalfHourStock[] {
  return stocks.sort((left, right) => tierRank(left) - tierRank(right)
    || (right.judgment.totalScore ?? -1) - (left.judgment.totalScore ?? -1)
    || (right.judgment.metrics.tailReturnPct ?? -999) - (left.judgment.metrics.tailReturnPct ?? -999))
}

function persistSnapshot(snapshot: ClosingHalfHourSnapshot): void {
  if (snapshot.stocks.length === 0 || snapshot.windowStatus === 'waiting' || snapshot.windowStatus === 'historical') return
  const active = snapshot.stocks.filter((stock) => stock.judgment.tier === 'active').slice(0, MAX_SAVED_ACTIVE)
  const confirm = snapshot.stocks.filter((stock) => stock.judgment.tier === 'confirm').slice(0, MAX_SAVED_CONFIRM)
  const rows: ShortTermSignalInsert[] = [...active, ...confirm].map((stock) => ({
    strategy: CLOSING_HALF_HOUR_STRATEGY_KEY,
    tsCode: stock.tsCode,
    name: stock.stockName,
    triggerAt: snapshot.generatedAt,
    tradeDate: snapshot.tradeDate,
    signalStrength: stock.judgment.totalScore,
    signalMeta: JSON.stringify({
      schemaVersion: CLOSING_HALF_HOUR_STRATEGY_VERSION,
      generatedAt: snapshot.generatedAt,
      dataMode: snapshot.dataMode,
      candidateSource: snapshot.candidateSource,
      stock,
      workbench: snapshot.judgment,
    } satisfies SavedSignalMeta),
  }))
  replaceSignalsByStrategyAndDate(getDb(), CLOSING_HALF_HOUR_STRATEGY_KEY, snapshot.tradeDate, rows)
}

function latestSavedTradeDate(requestedTradeDate: string): string | null {
  const row = getDb().prepare(`
    SELECT MAX(trade_date) AS tradeDate
    FROM short_term_signals
    WHERE strategy = ? AND trade_date <= ?
  `).get(CLOSING_HALF_HOUR_STRATEGY_KEY, requestedTradeDate) as { tradeDate: string | null } | undefined
  return row?.tradeDate ?? null
}

function restoreSavedSnapshot(requestedTradeDate: string, exact = false): ClosingHalfHourSnapshot | null {
  const tradeDate = exact ? requestedTradeDate : latestSavedTradeDate(requestedTradeDate)
  if (!tradeDate) return null
  const rows = getSignalsByStrategy(getDb(), CLOSING_HALF_HOUR_STRATEGY_KEY, tradeDate)
  const parsed = rows.flatMap((row) => {
    if (!row.signalMeta) return []
    try {
      const meta = JSON.parse(row.signalMeta) as SavedSignalMeta
      return meta.stock ? [{ meta, stock: meta.stock }] : []
    } catch {
      return []
    }
  })
  if (parsed.length === 0) return null
  const stocks = sortStocks(parsed.map((item) => item.stock))
  const first = parsed[0].meta
  return {
    requestedTradeDate,
    tradeDate,
    generatedAt: first.generatedAt ?? rows[0]?.createdAt ?? Date.now(),
    dataMode: 'history',
    candidateSource: 'savedSignal',
    windowStatus: 'historical',
    latestMinute: latestMinute(stocks),
    candidateCount: stocks.length,
    stocks,
    judgment: first.workbench ?? buildClosingHalfHourWorkbenchJudgment(stocks.map((stock) => stock.judgment)),
    strategyVersion: first.schemaVersion ?? CLOSING_HALF_HOUR_STRATEGY_VERSION,
  }
}

async function buildSnapshot(requestedTradeDate: string, forceRefresh: boolean): Promise<ClosingHalfHourSnapshot> {
  const windowStatus = resolveWindowStatus(requestedTradeDate)
  if (windowStatus === 'historical') {
    const restored = restoreSavedSnapshot(requestedTradeDate)
    if (restored) return restored
  }
  if (windowStatus === 'waiting') {
    const restored = restoreSavedSnapshot(requestedTradeDate)
    if (restored) return restored
    return {
      requestedTradeDate,
      tradeDate: requestedTradeDate,
      generatedAt: Date.now(),
      dataMode: 'realtime',
      candidateSource: 'realtimeActive',
      windowStatus,
      latestMinute: null,
      candidateCount: 0,
      stocks: [],
      judgment: buildClosingHalfHourWorkbenchJudgment([]),
      strategyVersion: CLOSING_HALF_HOUR_STRATEGY_VERSION,
    }
  }
  if (!forceRefresh && windowStatus === 'closed') {
    const restored = restoreSavedSnapshot(requestedTradeDate, true)
    if (restored) return restored
  }

  const realtime = requestedTradeDate === getBjTodayYmd() ? getRtKCache() : null
  const realtimeUsable = realtime != null && realtime.size > 0 && windowStatus !== 'historical'
  const local = realtimeUsable ? null : localCandidates(requestedTradeDate)
  const candidates = realtimeUsable ? realtimeCandidates(requestedTradeDate, realtime) : local?.rows ?? []
  const dataMode: ClosingHalfHourDataMode = realtimeUsable ? 'realtime' : 'eod'
  const candidateSource: ClosingHalfHourCandidateSource = realtimeUsable ? 'realtimeActive' : local?.source ?? 'localMinuteCache'

  if (realtimeUsable && (windowStatus === 'live' || forceRefresh)) {
    const cfg = getDataSourceConfig(getDb())
    const token = cfg.tushareEnabled && cfg.tushareTokenEncrypted ? decryptApiKey(cfg.tushareTokenEncrypted) : null
    if (token) await fetchMinuteData(token, candidates, requestedTradeDate)
  }

  const stocks = sortStocks(candidates.map((candidate) => buildStock(candidate, requestedTradeDate, dataMode)))
  const judgment = buildClosingHalfHourWorkbenchJudgment(stocks.map((stock) => stock.judgment))
  const snapshot: ClosingHalfHourSnapshot = {
    requestedTradeDate,
    tradeDate: requestedTradeDate,
    generatedAt: Date.now(),
    dataMode,
    candidateSource,
    windowStatus,
    latestMinute: latestMinute(stocks),
    candidateCount: candidates.length,
    stocks,
    judgment,
    strategyVersion: CLOSING_HALF_HOUR_STRATEGY_VERSION,
  }
  persistSnapshot(snapshot)
  console.log(`[ClosingHalfHour] date=${snapshot.tradeDate} mode=${dataMode} source=${candidateSource} candidates=${candidates.length} analyzed=${stocks.length} latest=${snapshot.latestMinute ?? 'none'} rtCachedAt=${getRtKCachedAt()}`)
  return snapshot
}

let cachedSnapshot: ClosingHalfHourSnapshot | null = null

export async function getOrCreateClosingHalfHourSnapshot(tradeDate: string): Promise<ClosingHalfHourSnapshot> {
  const currentWindow = resolveWindowStatus(tradeDate)
  const crossedWindowBoundary = cachedSnapshot != null
    && cachedSnapshot.requestedTradeDate === tradeDate
    && cachedSnapshot.windowStatus !== currentWindow
    && currentWindow !== 'historical'
  if (!cachedSnapshot || cachedSnapshot.requestedTradeDate !== tradeDate || crossedWindowBoundary) {
    cachedSnapshot = await buildSnapshot(tradeDate, false)
  }
  return cachedSnapshot
}

export async function refreshClosingHalfHourSnapshot(tradeDate: string): Promise<ClosingHalfHourSnapshot> {
  cachedSnapshot = await buildSnapshot(tradeDate, true)
  return cachedSnapshot
}

export const closingHalfHourLegacyFormLabels: Record<ClosingHalfHourLegacyForm, string> = {
  spikeBreakOpen: '冲高后跌破开盘价',
  dipReboundNotBreakOpen: '下探后收复开盘价',
  mildPullAboveBaseline: '尾盘平稳抬升',
  riseFallHoldBaseline: '冲高回落守住14:30',
  flatNoMove: '尾盘窄幅整理',
  lastTenSharpDrop: '最后10分钟急跌',
}
