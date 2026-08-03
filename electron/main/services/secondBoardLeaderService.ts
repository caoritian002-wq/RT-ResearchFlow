import { getDb } from '../database/db'
import { getLimitListByDate, getLatestAvailableTradeDate } from '../database/limitListDailyRepository'
import { replaceSignalsByStrategyAndDate, type ShortTermSignalInsert } from '../database/shortTermSignalsRepository'
import { getTopListByDate } from '../database/topListDailyRepository'
import { getPrevTradeDay } from '../database/tradeCalRepository'
import { getConceptSource } from '../database/settingsRepository'
import { computeThemeZtNumLocal, getConceptsByStockRouted } from './conceptRouter'
import { getLimitPct, getRtKCache, getRtKCachedAt } from './sharedRtKCache'
import {
  SECOND_BOARD_STRATEGY_KEY,
  SECOND_BOARD_STRATEGY_VERSION,
  evaluateSecondBoardWorkbench,
  type SecondBoardDataMode,
  type SecondBoardEvaluatedStock,
  type SecondBoardJudgmentInput,
  type SecondBoardWorkbenchJudgment,
} from './secondBoardJudgmentModel'

export type SecondBoardStock = SecondBoardEvaluatedStock

export interface SecondBoardSnapshot {
  tradeDate: string
  generatedAt: number
  isMock: boolean
  totalSecondBoardCount: number
  conceptList: string[]
  stocks: SecondBoardStock[]
  dataMode: SecondBoardDataMode
  rtDataTime: string | null
  strategyVersion: string
  workbench: SecondBoardWorkbenchJudgment
}

type CandidateFacts = Omit<SecondBoardJudgmentInput, 'dataMode'>

let cachedRequestDate: string | null = null
let cachedSnapshot: SecondBoardSnapshot | null = null

function getPreviousTradeDate(tradeDate: string): string | null {
  const db = getDb()
  try {
    const previous = getPrevTradeDay(db, tradeDate)
    if (previous) return previous
  } catch {
    // Fall back to the locally available limit-up calendar.
  }
  const row = db.prepare('SELECT MAX(trade_date) AS previous FROM limit_list_daily WHERE trade_date < ?').get(tradeDate) as { previous: string | null } | undefined
  return row?.previous ?? null
}

function buildDumpRiskMap(tradeDate: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of getTopListByDate(getDb(), tradeDate)) {
    if (row.lSell == null || row.lBuy == null || row.lBuy <= 0) continue
    const ratio = row.lSell / row.lBuy
    if (ratio <= 2) continue
    const reason = row.reason ? ` · ${row.reason}` : ''
    map.set(row.tsCode, `机构卖出/买入比 ${ratio.toFixed(1)}（龙虎榜${reason}）`)
  }
  return map
}

function primaryConcept(tsCode: string, tradeDate?: string): string | null {
  const concepts = getConceptsByStockRouted(getDb(), tsCode, getConceptSource(), tradeDate)
  return concepts[0]?.conceptName?.trim() || null
}

function buildEodFacts(requestedTradeDate: string): { facts: CandidateFacts[]; tradeDate: string; mode: 'eod' | 'fallback' } | null {
  const db = getDb()
  let tradeDate = requestedTradeDate
  let rows = getLimitListByDate(db, requestedTradeDate)
  let mode: 'eod' | 'fallback' = 'eod'
  if (rows.length === 0) {
    const latest = getLatestAvailableTradeDate(db)
    if (!latest) return null
    tradeDate = latest
    rows = getLimitListByDate(db, latest)
    mode = latest === requestedTradeDate ? 'eod' : 'fallback'
  }
  const candidates = rows.filter((row) => row.limit === 'U' && row.limitTimes != null && row.limitTimes >= 2)
  const previousDate = getPreviousTradeDate(tradeDate)
  const previousRows = previousDate ? getLimitListByDate(db, previousDate) : []
  const previousByCode = new Map(previousRows.map((row) => [row.tsCode, row]))
  const themeLimitUpCounts = computeThemeZtNumLocal(db, tradeDate, getConceptSource())
  const dumpRisks = buildDumpRiskMap(tradeDate)

  const facts = candidates.map<CandidateFacts>((row) => {
    const conceptName = primaryConcept(row.tsCode, tradeDate)
    const dumpInstDesc = dumpRisks.get(row.tsCode) ?? null
    return {
      tsCode: row.tsCode,
      stockCode: row.tsCode.split('.')[0],
      stockName: row.name ?? '',
      pctChg: row.pctChg,
      limitTimes: row.limitTimes,
      firstTime: row.firstTime,
      lastTime: row.lastTime,
      openTimes: row.openTimes,
      fundAmount: row.fdAmount,
      turnoverRatio: row.turnoverRatio,
      prevTurnoverRatio: previousByCode.get(row.tsCode)?.turnoverRatio ?? null,
      conceptName,
      conceptLimitUpCount: conceptName ? (themeLimitUpCounts.get(conceptName) ?? null) : null,
      hasDumpInstWarning: dumpInstDesc != null,
      dumpInstDesc,
    }
  })
  return { facts, tradeDate, mode }
}

function buildRealtimeFacts(tradeDate: string): { facts: CandidateFacts[]; rtDataTime: string | null } | null {
  const cache = getRtKCache()
  if (!cache || cache.size === 0) return null
  const previousDate = getPreviousTradeDate(tradeDate)
  if (!previousDate) return null
  const previousRows = getLimitListByDate(getDb(), previousDate)
  const previousLimitUp = new Map(previousRows.filter((row) => row.limit === 'U').map((row) => [row.tsCode, row]))
  if (previousLimitUp.size === 0) return null

  const currentLimitUp: Array<{ tsCode: string; conceptName: string | null }> = []
  for (const [tsCode, entry] of cache) {
    const limitPct = getLimitPct(tsCode, entry.name)
    if (entry.change < limitPct - 0.3 || entry.change > limitPct + 1.5) continue
    currentLimitUp.push({ tsCode, conceptName: primaryConcept(tsCode, tradeDate) })
  }
  const currentThemeCounts = new Map<string, number>()
  for (const row of currentLimitUp) {
    if (!row.conceptName) continue
    currentThemeCounts.set(row.conceptName, (currentThemeCounts.get(row.conceptName) ?? 0) + 1)
  }
  const dumpRisks = buildDumpRiskMap(tradeDate)
  const facts: CandidateFacts[] = []
  for (const row of currentLimitUp) {
    const previous = previousLimitUp.get(row.tsCode)
    const entry = cache.get(row.tsCode)
    if (!previous || !entry) continue
    const fundAmount = entry.bidPrice1 != null && entry.bidVolume1 != null
      ? Math.round(entry.bidPrice1 * entry.bidVolume1 / 10_000)
      : null
    const dumpInstDesc = dumpRisks.get(row.tsCode) ?? null
    facts.push({
      tsCode: row.tsCode,
      stockCode: row.tsCode.split('.')[0],
      stockName: entry.name ?? previous.name ?? '',
      pctChg: entry.change,
      limitTimes: null,
      firstTime: null,
      lastTime: null,
      openTimes: null,
      fundAmount,
      turnoverRatio: null,
      prevTurnoverRatio: previous.turnoverRatio,
      conceptName: row.conceptName,
      conceptLimitUpCount: row.conceptName ? (currentThemeCounts.get(row.conceptName) ?? null) : null,
      hasDumpInstWarning: dumpInstDesc != null,
      dumpInstDesc,
    })
  }
  const cachedAt = getRtKCachedAt()
  const rtDataTime = cachedAt > 0 ? new Date(cachedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }) : null
  return { facts, rtDataTime }
}

function signalTime(snapshot: SecondBoardSnapshot): number {
  const bjToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
  if (snapshot.tradeDate === bjToday) return snapshot.generatedAt
  if (!/^\d{8}$/.test(snapshot.tradeDate)) return snapshot.generatedAt
  return Date.parse(`${snapshot.tradeDate.slice(0, 4)}-${snapshot.tradeDate.slice(4, 6)}-${snapshot.tradeDate.slice(6, 8)}T07:00:00.000Z`)
}

function selectedSignals(snapshot: SecondBoardSnapshot): SecondBoardStock[] {
  return [
    ...snapshot.stocks.filter((stock) => stock.judgment.tier === 'core'),
    ...snapshot.stocks.filter((stock) => stock.judgment.tier === 'contender' && stock.judgment.dataStatus !== 'insufficient').slice(0, 5),
  ]
}

function persistSignals(snapshot: SecondBoardSnapshot): void {
  const triggerAt = signalTime(snapshot)
  const rows: ShortTermSignalInsert[] = selectedSignals(snapshot).map((stock) => ({
    strategy: SECOND_BOARD_STRATEGY_KEY,
    tsCode: stock.tsCode,
    name: stock.stockName,
    triggerAt,
    tradeDate: snapshot.tradeDate,
    signalStrength: stock.judgment.totalScore,
    signalMeta: JSON.stringify({
      strategyVersion: snapshot.strategyVersion,
      dataMode: snapshot.dataMode,
      generatedAt: snapshot.generatedAt,
      tier: stock.judgment.tier,
      limitTimes: stock.limitTimes,
      theme: stock.judgment.theme,
      dataStatus: stock.judgment.dataStatus,
      completeness: stock.judgment.completeness,
      dimensions: stock.judgment.dimensions,
      evidence: stock.judgment.evidence,
      risks: stock.judgment.risks,
      confirmations: stock.judgment.confirmations,
      invalidations: stock.judgment.invalidations,
    }),
  }))
  replaceSignalsByStrategyAndDate(getDb(), SECOND_BOARD_STRATEGY_KEY, snapshot.tradeDate, rows)
}

function finalizeSnapshot(
  tradeDate: string,
  mode: SecondBoardDataMode,
  facts: CandidateFacts[],
  rtDataTime: string | null,
): SecondBoardSnapshot {
  const generatedAt = Date.now()
  const evaluation = evaluateSecondBoardWorkbench(facts.map((stock) => ({ ...stock, dataMode: mode })))
  const snapshot: SecondBoardSnapshot = {
    tradeDate,
    generatedAt,
    isMock: false,
    totalSecondBoardCount: evaluation.stocks.length,
    conceptList: Array.from(new Set(evaluation.stocks.map((stock) => stock.conceptName).filter((value): value is string => value != null && value !== '无题材'))).sort((left, right) => left.localeCompare(right, 'zh-CN')),
    stocks: evaluation.stocks,
    dataMode: mode,
    rtDataTime,
    strategyVersion: SECOND_BOARD_STRATEGY_VERSION,
    workbench: evaluation.workbench,
  }
  try {
    persistSignals(snapshot)
  } catch (error) {
    console.warn('[secondBoardLeader] persist strategy signals failed:', error)
  }
  return snapshot
}

function buildSnapshot(requestedTradeDate: string): SecondBoardSnapshot {
  const todayRows = getLimitListByDate(getDb(), requestedTradeDate)
  if (todayRows.length > 0) {
    const eod = buildEodFacts(requestedTradeDate)
    return finalizeSnapshot(eod?.tradeDate ?? requestedTradeDate, eod?.mode ?? 'eod', eod?.facts ?? [], null)
  }
  const realtime = buildRealtimeFacts(requestedTradeDate)
  if (realtime) return finalizeSnapshot(requestedTradeDate, 'realtime', realtime.facts, realtime.rtDataTime)
  const fallback = buildEodFacts(requestedTradeDate)
  return finalizeSnapshot(fallback?.tradeDate ?? requestedTradeDate, fallback?.mode ?? 'fallback', fallback?.facts ?? [], null)
}

export function getOrCreateSecondBoardSnapshot(tradeDate: string): SecondBoardSnapshot {
  if (!cachedSnapshot || cachedRequestDate !== tradeDate) {
    cachedRequestDate = tradeDate
    cachedSnapshot = buildSnapshot(tradeDate)
  }
  return cachedSnapshot
}

export function refreshSecondBoardSnapshot(tradeDate: string): SecondBoardSnapshot {
  cachedRequestDate = tradeDate
  cachedSnapshot = buildSnapshot(tradeDate)
  return cachedSnapshot
}
