import { getDb } from '../database/db'
import { queryDailyClose } from '../database/dailyCloseCacheRepository'
import { getLimitListByDate } from '../database/limitListDailyRepository'
import { replaceSignalsByStrategyAndDate, type ShortTermSignalInsert } from '../database/shortTermSignalsRepository'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import type { LimitListDailyRow } from '../database/types'
import { computeThemeZtNumLocal, getConceptsByStockRouted } from './conceptRouter'
import { getConceptSource } from '../database/settingsRepository'
import { getRtKCache, getRtKCachedAt, type SharedRtKEntry } from './sharedRtKCache'
import {
  buildFirstYinWorkbenchJudgment,
  FIRST_YIN_STRATEGY_KEY,
  FIRST_YIN_STRATEGY_VERSION,
  judgeFirstYinStock,
  type FirstYinDataMode,
  type FirstYinStockJudgment,
  type FirstYinWorkbenchJudgment,
} from './firstYinDipJudgmentModel'

export interface FirstYinStock {
  tsCode: string
  stockCode: string
  stockName: string
  price: number | null
  pctChg: number | null
  turnoverRatio: number | null
  peakTurnoverRatio: number | null
  peakBoards: number
  peakDate: string
  divergenceDate: string
  sessionsSinceDivergence: number
  confirmPrice: number | null
  invalidationPrice: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  judgment: FirstYinStockJudgment
}

export interface FirstYinSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: FirstYinDataMode
  rtDataTime: string | null
  candidateCount: number
  conceptList: string[]
  stocks: FirstYinStock[]
  judgment: FirstYinWorkbenchJudgment
  strategyVersion: string
}

interface PeakEvent {
  row: LimitListDailyRow
  dateIndex: number
}

const EVENT_TRADE_DAYS = 10
const MAX_STATE_SESSIONS = 4
const MAX_SAVED_WAITING = 5

function getBjTodayYmd(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
}

function toBjTime(timestamp: number): string | null {
  if (timestamp <= 0) return null
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  })
}

function queryLatestDateAtOrBefore(requestedTradeDate: string): string | null {
  const db = getDb()
  const row = db.prepare(`
    SELECT MAX(trade_date) AS tradeDate
    FROM daily_close_cache
    WHERE trade_date <= ?
  `).get(requestedTradeDate) as { tradeDate: string | null } | undefined
  return row?.tradeDate ?? null
}

function fallbackTradeDates(endDate: string, limit: number): string[] {
  const rows = getDb().prepare(`
    SELECT trade_date AS tradeDate
    FROM (
      SELECT DISTINCT trade_date FROM daily_close_cache WHERE trade_date <= ?
      UNION
      SELECT DISTINCT trade_date FROM limit_list_daily WHERE trade_date <= ?
    )
    ORDER BY trade_date DESC
    LIMIT ?
  `).all(endDate, endDate, limit) as Array<{ tradeDate: string }>
  return rows.map((row) => row.tradeDate).reverse()
}

function resolveTradeDates(endDate: string): string[] {
  const calendarDates = getLastNTradingDays(getDb(), EVENT_TRADE_DAYS, endDate)
  const fallbackDates = fallbackTradeDates(endDate, EVENT_TRADE_DAYS)
  const dates = calendarDates.length >= Math.min(5, fallbackDates.length) ? calendarDates : fallbackDates
  return Array.from(new Set(dates)).sort()
}

function selectLatestPeakEvents(rows: LimitListDailyRow[], dateIndex: Map<string, number>): Map<string, PeakEvent> {
  const selected = new Map<string, PeakEvent>()
  for (const row of rows) {
    if (row.limit !== 'U' || row.limitTimes == null || row.limitTimes < 3) continue
    const index = dateIndex.get(row.tradeDate)
    if (index == null) continue
    const previous = selected.get(row.tsCode)
    if (!previous || index > previous.dateIndex) selected.set(row.tsCode, { row, dateIndex: index })
  }
  return selected
}

function signalTime(tradeDate: string, generatedAt: number): number {
  if (tradeDate === getBjTodayYmd()) return generatedAt
  if (!/^\d{8}$/.test(tradeDate)) return generatedAt
  return Date.parse(`${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}T07:00:00.000Z`)
}

function persistSignals(snapshot: FirstYinSnapshot): void {
  if (snapshot.dataMode === 'fallback' || snapshot.requestedTradeDate !== snapshot.tradeDate) return
  const selected = [
    ...snapshot.stocks.filter((stock) => stock.judgment.state === 'confirmed'),
    ...snapshot.stocks.filter((stock) => stock.judgment.state === 'waiting' && stock.judgment.dataStatus !== 'insufficient').slice(0, MAX_SAVED_WAITING),
  ]
  const triggerAt = signalTime(snapshot.tradeDate, snapshot.generatedAt)
  const rows: ShortTermSignalInsert[] = selected.map((stock) => ({
    strategy: FIRST_YIN_STRATEGY_KEY,
    tsCode: stock.tsCode,
    name: stock.stockName,
    triggerAt,
    tradeDate: snapshot.tradeDate,
    signalStrength: stock.judgment.totalScore,
    signalMeta: JSON.stringify({
      strategyVersion: snapshot.strategyVersion,
      dataMode: snapshot.dataMode,
      generatedAt: snapshot.generatedAt,
      state: stock.judgment.state,
      peakDate: stock.peakDate,
      peakBoards: stock.peakBoards,
      divergenceDate: stock.divergenceDate,
      sessionsSinceDivergence: stock.sessionsSinceDivergence,
      confirmPrice: stock.confirmPrice,
      invalidationPrice: stock.invalidationPrice,
      theme: stock.conceptName,
      dataStatus: stock.judgment.dataStatus,
      completeness: stock.judgment.completeness,
      dimensions: stock.judgment.dimensions,
      evidence: stock.judgment.evidence,
      risks: stock.judgment.risks,
      confirmations: stock.judgment.confirmations,
      invalidations: stock.judgment.invalidations,
      workbench: snapshot.judgment,
    }),
  }))
  replaceSignalsByStrategyAndDate(getDb(), FIRST_YIN_STRATEGY_KEY, snapshot.tradeDate, rows)
}

function currentRealtimeRow(entry: SharedRtKEntry | undefined): {
  price: number | null
  close: number | null
  pctChg: number | null
  turnover: number | null
} {
  return {
    price: entry?.price ?? null,
    close: null,
    pctChg: entry?.change ?? null,
    turnover: null,
  }
}

function buildSnapshot(requestedTradeDate: string): FirstYinSnapshot {
  const db = getDb()
  const today = getBjTodayYmd()
  const rtCache = requestedTradeDate === today ? getRtKCache() : null
  const realtime = rtCache != null && rtCache.size > 0
  const latestClosedDate = queryLatestDateAtOrBefore(requestedTradeDate)
  const factDate = realtime ? requestedTradeDate : latestClosedDate ?? requestedTradeDate
  const dataMode: FirstYinDataMode = realtime
    ? 'realtime'
    : factDate === requestedTradeDate
      ? 'eod'
      : 'fallback'

  const completedDates = latestClosedDate ? resolveTradeDates(latestClosedDate) : []
  const tradeDates = realtime
    ? Array.from(new Set([...completedDates, requestedTradeDate])).sort()
    : resolveTradeDates(factDate)
  const dateIndex = new Map(tradeDates.map((date, index) => [date, index]))
  const limitRows = tradeDates.flatMap((date) => getLimitListByDate(db, date))
  const limitUpKeys = new Set(limitRows.filter((row) => row.limit === 'U').map((row) => `${row.tsCode}|${row.tradeDate}`))
  const peakEvents = selectLatestPeakEvents(limitRows, dateIndex)
  const candidateCodes = Array.from(peakEvents.keys())
  const earliestDate = tradeDates[0] ?? factDate
  const dailyMap = queryDailyClose(db, candidateCodes, earliestDate)
  const source = getConceptSource()
  const hasFactDateLimitRows = getLimitListByDate(db, factDate).length > 0
  const themeCounts = realtime || hasFactDateLimitRows
    ? computeThemeZtNumLocal(db, factDate, source)
    : new Map<string, number>()
  const stocks: FirstYinStock[] = []

  for (const [tsCode, event] of peakEvents) {
    let divergenceIndex = event.dateIndex + 1
    while (divergenceIndex < tradeDates.length && limitUpKeys.has(`${tsCode}|${tradeDates[divergenceIndex]}`)) divergenceIndex += 1
    if (divergenceIndex >= tradeDates.length) continue
    const currentIndex = dateIndex.get(factDate)
    if (currentIndex == null || currentIndex < divergenceIndex) continue
    const sessionsSinceDivergence = currentIndex - divergenceIndex
    if (sessionsSinceDivergence > MAX_STATE_SESSIONS) continue

    const divergenceDate = tradeDates[divergenceIndex]
    const rows = dailyMap.get(tsCode) ?? []
    const byDate = new Map(rows.map((row) => [row.tradeDate, row]))
    const peakDaily = byDate.get(event.row.tradeDate)
    const divergenceDaily = byDate.get(divergenceDate)
    const currentDaily = byDate.get(factDate)
    const rtEntry = realtime ? rtCache?.get(tsCode) : undefined
    const current = realtime
      ? currentRealtimeRow(rtEntry)
      : {
          price: currentDaily?.close ?? null,
          close: currentDaily?.close ?? null,
          pctChg: currentDaily?.pctChg ?? null,
          turnover: currentDaily?.turnoverRate ?? null,
        }
    const divergenceIsRealtime = realtime && divergenceDate === requestedTradeDate
    const divergenceOpen = divergenceIsRealtime ? rtEntry?.open ?? null : divergenceDaily?.open ?? null
    const divergenceHigh = divergenceIsRealtime ? rtEntry?.high ?? null : divergenceDaily?.high ?? null
    const divergenceLow = divergenceIsRealtime ? rtEntry?.low ?? null : divergenceDaily?.low ?? null
    const divergenceClose = divergenceIsRealtime ? rtEntry?.price ?? null : divergenceDaily?.close ?? null
    const divergencePctChg = divergenceIsRealtime ? rtEntry?.change ?? null : divergenceDaily?.pctChg ?? null
    const divergenceTurnover = divergenceIsRealtime ? null : divergenceDaily?.turnoverRate ?? event.row.turnoverRatio ?? null
    const concepts = getConceptsByStockRouted(db, tsCode, source, factDate)
    const conceptName = concepts[0]?.conceptName?.trim() || null
    const conceptLimitUpCount = conceptName && themeCounts.has(conceptName) ? themeCounts.get(conceptName) ?? null : null
    const judgment = judgeFirstYinStock({
      tsCode,
      stockCode: tsCode.split('.')[0],
      stockName: rtEntry?.name ?? event.row.name ?? '',
      dataMode,
      peakDate: event.row.tradeDate,
      peakBoards: event.row.limitTimes,
      peakClose: peakDaily?.close ?? event.row.close ?? null,
      peakTurnoverRate: peakDaily?.turnoverRate ?? event.row.turnoverRatio ?? null,
      divergenceDate,
      divergenceOpen,
      divergenceHigh,
      divergenceLow,
      divergenceClose,
      divergencePctChg,
      divergenceTurnoverRate: divergenceTurnover,
      currentDate: factDate,
      sessionsSinceDivergence,
      currentPrice: current.price,
      currentClose: current.close,
      currentPctChg: current.pctChg,
      currentTurnoverRate: current.turnover,
      currentIsClosed: !realtime,
      themeName: conceptName,
      themeLimitUpCount: conceptLimitUpCount,
    })
    stocks.push({
      tsCode,
      stockCode: tsCode.split('.')[0],
      stockName: rtEntry?.name ?? event.row.name ?? '',
      price: current.price,
      pctChg: current.pctChg,
      turnoverRatio: divergenceTurnover,
      peakTurnoverRatio: peakDaily?.turnoverRate ?? event.row.turnoverRatio ?? null,
      peakBoards: event.row.limitTimes ?? 3,
      peakDate: event.row.tradeDate,
      divergenceDate,
      sessionsSinceDivergence,
      confirmPrice: divergenceHigh,
      invalidationPrice: divergenceLow,
      conceptName,
      conceptLimitUpCount,
      judgment,
    })
  }

  const stateOrder: Record<FirstYinStockJudgment['state'], number> = {
    confirmed: 0,
    waiting: 1,
    divergence: 2,
    failed: 3,
    insufficient: 4,
  }
  stocks.sort((left, right) => stateOrder[left.judgment.state] - stateOrder[right.judgment.state]
    || (right.judgment.totalScore ?? -1) - (left.judgment.totalScore ?? -1)
    || right.peakBoards - left.peakBoards)
  const judgment = buildFirstYinWorkbenchJudgment(stocks.map((stock) => stock.judgment))
  const snapshot: FirstYinSnapshot = {
    requestedTradeDate,
    tradeDate: factDate,
    generatedAt: Date.now(),
    dataMode,
    rtDataTime: realtime ? toBjTime(getRtKCachedAt()) : null,
    candidateCount: stocks.length,
    conceptList: Array.from(new Set(stocks.map((stock) => stock.conceptName).filter((value): value is string => value != null))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    stocks,
    judgment,
    strategyVersion: FIRST_YIN_STRATEGY_VERSION,
  }
  try {
    persistSignals(snapshot)
  } catch (error) {
    console.warn('[firstYinDip] persist strategy signals failed:', error)
  }
  console.log(`[FirstYinDip] requested=${requestedTradeDate} fact=${factDate} mode=${dataMode} candidates=${stocks.length}`)
  return snapshot
}

let cachedRequestDate: string | null = null
let cachedSnapshot: FirstYinSnapshot | null = null

export function getOrCreateFirstYinSnapshot(tradeDate: string): FirstYinSnapshot {
  if (!cachedSnapshot || cachedRequestDate !== tradeDate) {
    cachedRequestDate = tradeDate
    cachedSnapshot = buildSnapshot(tradeDate)
  }
  return cachedSnapshot
}

export function refreshFirstYinSnapshot(tradeDate: string): FirstYinSnapshot {
  cachedRequestDate = tradeDate
  cachedSnapshot = buildSnapshot(tradeDate)
  return cachedSnapshot
}
