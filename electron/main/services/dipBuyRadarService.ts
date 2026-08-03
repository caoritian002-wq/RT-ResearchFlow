import { getDb } from '../database/db'
import { queryDailyClose, upsertDailyClose } from '../database/dailyCloseCacheRepository'
import { getLimitListByDate } from '../database/limitListDailyRepository'
import { countMoneyFlowByDate, getMoneyFlowMapByDate, upsertMoneyFlowRows } from '../database/moneyFlowRepository'
import { replaceSignalsByStrategyAndDate, type ShortTermSignalInsert } from '../database/shortTermSignalsRepository'
import { queryAllActive } from '../database/stockBasicCacheRepository'
import { getLastNTradingDays } from '../database/tradeCalRepository'
import type { LimitListDailyRow } from '../database/types'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import { getConceptSource } from '../database/settingsRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { computeThemeZtNumLocal, getConceptsByStockRouted, getMembersByConceptRouted } from './conceptRouter'
import {
  buildDipModeJudgment,
  DIP_BUY_STRATEGY_KEYS,
  DIP_BUY_STRATEGY_VERSION,
  dipGate,
  judgeArbitrageDip,
  judgeRotationDip,
  judgeTrendDip,
  type DipCandidateJudgment,
  type DipCondition,
  type DipDataMode,
  type DipMode,
  type DipModeJudgment,
} from './dipBuyJudgmentModel'
import { getLimitDownToday, getLimitPct, getLimitUpToday, getRtKCache, getRtKCachedAt, type SharedRtKEntry } from './sharedRtKCache'
import { fetchDailyForCandidates, fetchMoneyFlow, type DailyRow } from './tushareService'

export interface DipStock {
  mode: DipMode
  tsCode: string
  stockCode: string
  stockName: string
  price: number | null
  pctChg: number | null
  amountWan: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  recentPeakBoards: number | null
  recentPeakDate: string | null
  recentLimitUpDate: string | null
  ma10: number | null
  ma20: number | null
  ma30: number | null
  ma20Slope5Pct: number | null
  nearestMaLabel: string | null
  distanceToNearestMaPct: number | null
  drop5dPct: number | null
  netMoneyFlowAmount: number | null
  volumeRatio5: number | null
  leaderTsCode: string | null
  leaderName: string | null
  leaderPreviousBoards: number | null
  leaderPctChg: number | null
  judgment: DipCandidateJudgment
}

export interface DipModeSnapshot {
  stocks: DipStock[]
  judgment: DipModeJudgment
}

export interface RetreatTheme {
  name: string
  previousLimitUpCount: number
  currentLimitUpCount: number
}

export interface MarketSentiment {
  ztCount: number | null
  dtCount: number | null
  temperature: number | null
  previousTradeDate: string | null
  hotConcepts: Array<{ name: string; ztNum: number }>
  retreatThemes: RetreatTheme[]
}

export interface DipBuyRadarSnapshot {
  requestedTradeDate: string
  tradeDate: string
  generatedAt: number
  dataMode: DipDataMode
  rtDataTime: string | null
  sentiment: MarketSentiment
  modes: Record<DipMode, DipModeSnapshot>
  strategyVersion: string
}

interface RecentLimitEvent {
  latestLimitUpDate: string
  peakDate: string | null
  peakBoards: number | null
  name: string | null
  hasUnknownHeight: boolean
}

interface CurrentFacts {
  price: number | null
  pctChg: number | null
  volume: number | null
  amountWan: number | null
  isLimitUp: boolean | null
  isLimitDown: boolean | null
}

interface RotationLeader {
  tsCode: string
  name: string
  boards: number
  pctChg: number
  isLimitUp: boolean
  conceptCode: string
  conceptName: string
}

const HISTORY_TRADE_DAYS = 35
const MAX_CANDIDATES_PER_SOURCE = 100
const MAX_NETWORK_HISTORY_CODES = 24
const MAX_VISIBLE_STOCKS = 25
const MAX_VISIBLE_INSUFFICIENT = 5
const MAX_SAVED_PER_MODE = 10

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number, digits = 2): number {
  const base = 10 ** digits
  return Math.round(value * base) / base
}

function getBjTodayYmd(): string {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
}

function toBjTime(timestamp: number): string | null {
  if (timestamp <= 0) return null
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function subtractCalendarDays(ymd: string, days: number): string {
  const timestamp = Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)) - 1,
    Number(ymd.slice(6, 8)),
  ) - days * 86_400_000
  const date = new Date(timestamp)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function normalizeTsCode(value: string): string {
  const trimmed = value.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(trimmed)) return trimmed
  const code = trimmed.replace(/\.(SH|SZ|BJ)$/i, '')
  if (code.startsWith('6') || code.startsWith('9')) return `${code}.SH`
  if (code.startsWith('8') || code.startsWith('4')) return `${code}.BJ`
  return `${code}.SZ`
}

function resolveFactDate(requestedTradeDate: string): { tradeDate: string; dataMode: DipDataMode; realtimeCache: Map<string, SharedRtKEntry> | null } {
  const today = getBjTodayYmd()
  const realtimeCache = requestedTradeDate === today ? getRtKCache() : null
  if (realtimeCache && realtimeCache.size > 0) {
    return { tradeDate: requestedTradeDate, dataMode: 'realtime', realtimeCache }
  }
  const exactRows = getLimitListByDate(getDb(), requestedTradeDate)
  if (exactRows.length > 0) return { tradeDate: requestedTradeDate, dataMode: 'eod', realtimeCache: null }
  const fallback = getDb().prepare(`
    SELECT MAX(trade_date) AS trade_date
    FROM limit_list_daily
    WHERE trade_date <= ?
  `).get(requestedTradeDate) as { trade_date: string | null } | undefined
  if (fallback?.trade_date) return { tradeDate: fallback.trade_date, dataMode: 'fallback', realtimeCache: null }
  return { tradeDate: requestedTradeDate, dataMode: 'eod', realtimeCache: null }
}

function fallbackTradeDates(endDate: string, limit: number): string[] {
  const rows = getDb().prepare(`
    SELECT trade_date AS tradeDate
    FROM (
      SELECT DISTINCT trade_date
      FROM daily_close_cache
      WHERE trade_date <= ?
      UNION
      SELECT DISTINCT trade_date
      FROM limit_list_daily
      WHERE trade_date <= ?
    )
    ORDER BY tradeDate DESC
    LIMIT ?
  `).all(endDate, endDate, limit) as Array<{ tradeDate: string }>
  return rows.map((row) => row.tradeDate).reverse()
}

function resolveTradeDates(endDate: string): string[] {
  const calendar = getLastNTradingDays(getDb(), HISTORY_TRADE_DAYS, endDate)
  const fallback = fallbackTradeDates(endDate, HISTORY_TRADE_DAYS)
  const selected = calendar.length >= Math.min(20, fallback.length) ? calendar : fallback
  return Array.from(new Set(selected.filter((date) => date <= endDate))).sort()
}

function collectLimitRows(tradeDates: string[]): Map<string, LimitListDailyRow[]> {
  const result = new Map<string, LimitListDailyRow[]>()
  for (const tradeDate of tradeDates) result.set(tradeDate, getLimitListByDate(getDb(), tradeDate))
  return result
}

function buildRecentEvents(rowsByDate: Map<string, LimitListDailyRow[]>): Map<string, RecentLimitEvent> {
  const result = new Map<string, RecentLimitEvent>()
  for (const rows of rowsByDate.values()) {
    for (const row of rows) {
      if (row.limit !== 'U') continue
      const tsCode = normalizeTsCode(row.tsCode)
      const previous = result.get(tsCode)
      const height = finite(row.limitTimes) ? row.limitTimes : null
      const peakIsHigher = height != null && (previous?.peakBoards == null || height > previous.peakBoards)
      result.set(tsCode, {
        latestLimitUpDate: !previous || row.tradeDate > previous.latestLimitUpDate ? row.tradeDate : previous.latestLimitUpDate,
        peakDate: peakIsHigher ? row.tradeDate : previous?.peakDate ?? (height != null ? row.tradeDate : null),
        peakBoards: peakIsHigher ? height : previous?.peakBoards ?? height,
        name: row.name ?? previous?.name ?? null,
        hasUnknownHeight: previous?.hasUnknownHeight === true || height == null,
      })
    }
  }
  return result
}

function pickConcept(
  tsCode: string,
  tradeDate: string,
  currentThemeCounts: Map<string, number>,
  preferredNames?: Set<string>,
): { code: string; name: string } | null {
  const concepts = getConceptsByStockRouted(getDb(), tsCode, getConceptSource(), tradeDate)
  const eligible = preferredNames ? concepts.filter((concept) => preferredNames.has(concept.conceptName)) : concepts
  const pool = eligible.length > 0 ? eligible : preferredNames ? [] : concepts
  if (pool.length === 0) return null
  pool.sort((left, right) => (currentThemeCounts.get(right.conceptName) ?? 0) - (currentThemeCounts.get(left.conceptName) ?? 0))
  return { code: pool[0].conceptCode, name: pool[0].conceptName }
}

async function ensureDailyHistory(tsCodes: string[], startDate: string, endDate: string): Promise<Map<string, DailyRow[]>> {
  const db = getDb()
  let rows = queryDailyClose(db, tsCodes, startDate)
  const missing = tsCodes.filter((tsCode) => {
    const available = (rows.get(tsCode) ?? []).filter((row) => row.tradeDate <= endDate).length
    return available < 30
  })
  if (missing.length === 0) return rows
  const config = getDataSourceConfig(db)
  if (!config.tushareEnabled || !config.tushareTokenEncrypted) return rows
  const token = decryptApiKey(config.tushareTokenEncrypted)
  if (!token) return rows
  try {
    const fetched = await fetchDailyForCandidates(token, missing.slice(0, MAX_NETWORK_HISTORY_CODES), startDate, endDate)
    if (fetched.length > 0) upsertDailyClose(db, fetched)
    rows = queryDailyClose(db, tsCodes, startDate)
  } catch (error) {
    console.warn('[DipBuyRadar] candidate daily backfill skipped:', error instanceof Error ? error.message : error)
  }
  return rows
}

async function ensureMoneyFlow(tradeDate: string, dataMode: DipDataMode): Promise<void> {
  if (dataMode === 'realtime' || countMoneyFlowByDate(getDb(), tradeDate) > 0) return
  const config = getDataSourceConfig(getDb())
  if (!config.tushareEnabled || !config.tushareTokenEncrypted) return
  const token = decryptApiKey(config.tushareTokenEncrypted)
  if (!token) return
  try {
    const rows = await fetchMoneyFlow(token, undefined, tradeDate)
    if (rows.length > 0) upsertMoneyFlowRows(getDb(), rows)
  } catch (error) {
    console.warn('[DipBuyRadar] moneyflow backfill skipped:', error instanceof Error ? error.message : error)
  }
}

function rowsUntil(rows: DailyRow[] | undefined, tradeDate: string): DailyRow[] {
  return (rows ?? []).filter((row) => row.tradeDate <= tradeDate).sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
}

function calcMa(rows: DailyRow[], endIndex: number, length: number): number | null {
  if (endIndex < length - 1) return null
  let sum = 0
  for (let index = endIndex - length + 1; index <= endIndex; index += 1) sum += rows[index].close
  return sum / length
}

function getCurrentFacts(
  tsCode: string,
  stockName: string,
  tradeDate: string,
  dataMode: DipDataMode,
  realtimeCache: Map<string, SharedRtKEntry> | null,
  dailyRows: DailyRow[] | undefined,
  limitRows: Map<string, LimitListDailyRow>,
): CurrentFacts {
  const realtime = dataMode === 'realtime' ? realtimeCache?.get(tsCode) : undefined
  const history = rowsUntil(dailyRows, tradeDate)
  const daily = history.find((row) => row.tradeDate === tradeDate)
  const limitRow = limitRows.get(tsCode)
  const pctChg = realtime?.change ?? daily?.pctChg ?? limitRow?.pctChg ?? null
  const price = realtime?.price ?? daily?.close ?? limitRow?.close ?? null
  const threshold = getLimitPct(tsCode, realtime?.name ?? stockName) - 0.3
  const isLimitUp = limitRow?.limit === 'U'
    ? true
    : finite(pctChg)
      ? pctChg >= threshold
      : null
  const isLimitDown = limitRow?.limit === 'D'
    ? true
    : finite(pctChg)
      ? pctChg <= -threshold
      : null
  return {
    price,
    pctChg,
    volume: dataMode === 'realtime' ? null : daily?.vol ?? null,
    amountWan: realtime ? round(realtime.amount / 10_000, 0) : limitRow?.amount ?? null,
    isLimitUp,
    isLimitDown,
  }
}

function trendMetrics(rows: DailyRow[] | undefined, tradeDate: string, dataMode: DipDataMode, currentPrice: number | null): {
  ma10: number | null
  ma20: number | null
  ma30: number | null
  ma20Slope5Pct: number | null
  nearestMaLabel: string | null
  distanceToNearestMaPct: number | null
} {
  let history = rowsUntil(rows, tradeDate)
  if (dataMode === 'realtime') history = history.filter((row) => row.tradeDate < tradeDate)
  const endIndex = history.length - 1
  const ma10 = calcMa(history, endIndex, 10)
  const ma20 = calcMa(history, endIndex, 20)
  const ma30 = calcMa(history, endIndex, 30)
  const ma20Before = calcMa(history, endIndex - 5, 20)
  const ma20Slope5Pct = finite(ma20) && finite(ma20Before) && ma20Before > 0
    ? round((ma20 / ma20Before - 1) * 100)
    : null
  const candidates = [
    { label: 'MA10', value: ma10 },
    { label: 'MA20', value: ma20 },
    { label: 'MA30', value: ma30 },
  ].filter((item): item is { label: string; value: number } => finite(item.value) && item.value > 0 && finite(currentPrice))
    .map((item) => ({ ...item, distance: ((currentPrice as number) / item.value - 1) * 100 }))
    .sort((left, right) => Math.abs(left.distance) - Math.abs(right.distance))
  return {
    ma10: finite(ma10) ? round(ma10) : null,
    ma20: finite(ma20) ? round(ma20) : null,
    ma30: finite(ma30) ? round(ma30) : null,
    ma20Slope5Pct,
    nearestMaLabel: candidates[0]?.label ?? null,
    distanceToNearestMaPct: candidates[0] ? round(candidates[0].distance) : null,
  }
}

function returnAndVolumeMetrics(rows: DailyRow[] | undefined, tradeDate: string, dataMode: DipDataMode): {
  drop5dPct: number | null
  volumeRatio5: number | null
} {
  const history = rowsUntil(rows, tradeDate)
  const currentIndex = history.findIndex((row) => row.tradeDate === tradeDate)
  if (currentIndex < 0) return { drop5dPct: null, volumeRatio5: null }
  const current = history[currentIndex]
  const drop5dPct = currentIndex >= 5 && history[currentIndex - 5].close > 0
    ? round((current.close / history[currentIndex - 5].close - 1) * 100)
    : null
  if (dataMode === 'realtime' || !finite(current.vol) || currentIndex < 5) {
    return { drop5dPct, volumeRatio5: null }
  }
  const previousVolumes = history.slice(currentIndex - 5, currentIndex).map((row) => row.vol).filter(finite)
  const averageVolume = previousVolumes.length === 5
    ? previousVolumes.reduce((sum, value) => sum + value, 0) / 5
    : null
  return {
    drop5dPct,
    volumeRatio5: finite(averageVolume) && averageVolume > 0 ? round((current.vol as number) / averageVolume, 3) : null,
  }
}

function stockNameMap(): Map<string, string> {
  return new Map(queryAllActive(getDb()).map((row) => [normalizeTsCode(row.tsCode), row.name ?? row.tsCode]))
}

function tierOrder(judgment: DipCandidateJudgment): number {
  if (judgment.tier === 'focus') return 0
  if (judgment.tier === 'watch') return 1
  if (judgment.tier === 'insufficient') return 2
  return 3
}

function visibleStocks(stocks: DipStock[]): DipStock[] {
  const sorted = [...stocks].sort((left, right) => tierOrder(left.judgment) - tierOrder(right.judgment)
    || (right.judgment.rankScore ?? -1) - (left.judgment.rankScore ?? -1)
    || left.stockCode.localeCompare(right.stockCode))
  return [
    ...sorted.filter((stock) => stock.judgment.tier === 'focus' || stock.judgment.tier === 'watch').slice(0, MAX_VISIBLE_STOCKS),
    ...sorted.filter((stock) => stock.judgment.tier === 'insufficient').slice(0, MAX_VISIBLE_INSUFFICIENT),
  ]
}

function signalTime(tradeDate: string, generatedAt: number): number {
  if (tradeDate === getBjTodayYmd() || !/^\d{8}$/.test(tradeDate)) return generatedAt
  return Date.parse(`${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}T07:00:00.000Z`)
}

function persistSignals(snapshot: DipBuyRadarSnapshot): void {
  if (snapshot.dataMode === 'fallback' || snapshot.requestedTradeDate !== snapshot.tradeDate) return
  const triggerAt = signalTime(snapshot.tradeDate, snapshot.generatedAt)
  for (const mode of Object.keys(DIP_BUY_STRATEGY_KEYS) as DipMode[]) {
    const modeSnapshot = snapshot.modes[mode]
    const selected = modeSnapshot.stocks
      .filter((stock) => stock.judgment.tier === 'focus' || stock.judgment.tier === 'watch')
      .slice(0, MAX_SAVED_PER_MODE)
    const rows: ShortTermSignalInsert[] = selected.map((stock) => ({
      strategy: DIP_BUY_STRATEGY_KEYS[mode],
      tsCode: stock.tsCode,
      name: stock.stockName,
      triggerAt,
      tradeDate: snapshot.tradeDate,
      signalStrength: stock.judgment.rankScore,
      signalMeta: JSON.stringify({
        strategyVersion: snapshot.strategyVersion,
        mode,
        dataMode: snapshot.dataMode,
        generatedAt: snapshot.generatedAt,
        tier: stock.judgment.tier,
        concept: stock.conceptName,
        recentPeakBoards: stock.recentPeakBoards,
        recentPeakDate: stock.recentPeakDate,
        recentLimitUpDate: stock.recentLimitUpDate,
        ma10: stock.ma10,
        ma20: stock.ma20,
        ma30: stock.ma30,
        ma20Slope5Pct: stock.ma20Slope5Pct,
        distanceToNearestMaPct: stock.distanceToNearestMaPct,
        drop5dPct: stock.drop5dPct,
        netMoneyFlowAmount: stock.netMoneyFlowAmount,
        volumeRatio5: stock.volumeRatio5,
        leaderTsCode: stock.leaderTsCode,
        leaderName: stock.leaderName,
        leaderPreviousBoards: stock.leaderPreviousBoards,
        leaderPctChg: stock.leaderPctChg,
        dataStatus: stock.judgment.dataStatus,
        completeness: stock.judgment.completeness,
        conditions: stock.judgment.conditions,
        evidence: stock.judgment.evidence,
        risks: stock.judgment.risks,
        confirmations: stock.judgment.confirmations,
        invalidations: stock.judgment.invalidations,
        workbench: modeSnapshot.judgment,
      }),
    }))
    replaceSignalsByStrategyAndDate(getDb(), DIP_BUY_STRATEGY_KEYS[mode], snapshot.tradeDate, rows)
  }
}

async function buildSnapshot(requestedTradeDate: string): Promise<DipBuyRadarSnapshot> {
  const { tradeDate, dataMode, realtimeCache } = resolveFactDate(requestedTradeDate)
  const tradeDates = resolveTradeDates(tradeDate)
  const rowsByDate = collectLimitRows(tradeDates)
  const currentLimitRows = getLimitListByDate(getDb(), tradeDate)
  rowsByDate.set(tradeDate, currentLimitRows)
  const currentLimitMap = new Map(currentLimitRows.map((row) => [normalizeTsCode(row.tsCode), row]))
  const previousTradeDate = [...tradeDates].filter((date) => date < tradeDate).at(-1) ?? null
  const previousLimitRows = previousTradeDate ? rowsByDate.get(previousTradeDate) ?? [] : []
  const recentEvents = buildRecentEvents(rowsByDate)
  const limitCoverageDays = Array.from(rowsByDate.values()).filter((rows) => rows.length > 0).length
  const names = stockNameMap()
  const source = getConceptSource()

  const ztCount = dataMode === 'realtime'
    ? getLimitUpToday().length
    : currentLimitRows.length > 0
      ? currentLimitRows.filter((row) => row.limit === 'U').length
      : null
  const dtCount = dataMode === 'realtime'
    ? getLimitDownToday().length
    : currentLimitRows.length > 0
      ? currentLimitRows.filter((row) => row.limit === 'D').length
      : null
  const temperature = finite(ztCount) && finite(dtCount)
    ? Math.max(0, Math.min(100, Math.round(50 + (ztCount - dtCount) * 0.6)))
    : null
  const currentThemeCounts = computeThemeZtNumLocal(getDb(), tradeDate, source)
  const previousThemeCounts = previousTradeDate
    ? computeThemeZtNumLocal(getDb(), previousTradeDate, source)
    : new Map<string, number>()
  const previousThemeCoverageKnown = previousTradeDate != null
    && (previousLimitRows.filter((row) => row.limit === 'U').length === 0 || previousThemeCounts.size > 0)
  const retreatThemes: RetreatTheme[] = previousThemeCoverageKnown
    ? Array.from(previousThemeCounts.entries())
      .filter(([, count]) => count >= 2)
      .map(([name, previousLimitUpCount]) => ({
        name,
        previousLimitUpCount,
        currentLimitUpCount: currentThemeCounts.get(name) ?? 0,
      }))
      .filter((item) => item.currentLimitUpCount <= Math.floor(item.previousLimitUpCount / 2))
      .sort((left, right) => right.previousLimitUpCount - left.previousLimitUpCount || left.name.localeCompare(right.name, 'zh-CN'))
    : []
  const retreatThemeCount = previousThemeCoverageKnown ? retreatThemes.length : null
  const retreatThemeNames = new Set(retreatThemes.map((theme) => theme.name))
  const hotConcepts = Array.from(currentThemeCounts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([name, ztNum]) => ({ name, ztNum }))

  const trendCodes = Array.from(recentEvents.entries())
    .filter(([, event]) => finite(event.peakBoards) && event.peakBoards >= 2)
    .sort((left, right) => (right[1].peakBoards ?? 0) - (left[1].peakBoards ?? 0)
      || right[1].latestLimitUpDate.localeCompare(left[1].latestLimitUpDate))
    .slice(0, MAX_CANDIDATES_PER_SOURCE)
    .map(([tsCode]) => tsCode)
  const arbitrageCodes = Array.from(recentEvents.entries())
    .sort((left, right) => right[1].latestLimitUpDate.localeCompare(left[1].latestLimitUpDate))
    .slice(0, MAX_CANDIDATES_PER_SOURCE)
    .map(([tsCode]) => tsCode)

  const previousLeaders = previousLimitRows
    .filter((row) => row.limit === 'U' && finite(row.limitTimes) && row.limitTimes >= 5)
    .sort((left, right) => (right.limitTimes ?? 0) - (left.limitTimes ?? 0))
  const rotationLeaders: RotationLeader[] = []
  const rotationMemberCodes: string[] = []
  let leaderCurrentKnownCount = 0
  for (const leaderRow of previousLeaders) {
    const leaderTsCode = normalizeTsCode(leaderRow.tsCode)
    const leaderName = leaderRow.name ?? names.get(leaderTsCode) ?? leaderTsCode
    const concepts = getConceptsByStockRouted(getDb(), leaderTsCode, source, tradeDate)
      .sort((left, right) => (currentThemeCounts.get(right.conceptName) ?? 0) - (currentThemeCounts.get(left.conceptName) ?? 0))
    for (const concept of concepts.slice(0, 2)) {
      const members = getMembersByConceptRouted(getDb(), concept.conceptCode, source, tradeDate)
      for (const member of members) rotationMemberCodes.push(normalizeTsCode(member.stockCode))
    }
    if (concepts.length === 0) continue
    rotationLeaders.push({
      tsCode: leaderTsCode,
      name: leaderName,
      boards: leaderRow.limitTimes as number,
      pctChg: Number.NaN,
      isLimitUp: false,
      conceptCode: concepts[0].conceptCode,
      conceptName: concepts[0].conceptName,
    })
  }

  const allCandidateCodes = Array.from(new Set([
    ...trendCodes,
    ...arbitrageCodes,
    ...previousLeaders.map((row) => normalizeTsCode(row.tsCode)),
    ...rotationMemberCodes,
  ])).slice(0, 220)
  const startDate = subtractCalendarDays(tradeDate, 100)
  const dailyMap = await ensureDailyHistory(allCandidateCodes, startDate, tradeDate)
  await ensureMoneyFlow(tradeDate, dataMode)
  const moneyFlowMap = getMoneyFlowMapByDate(getDb(), tradeDate)

  for (const leader of rotationLeaders) {
    const current = getCurrentFacts(
      leader.tsCode,
      leader.name,
      tradeDate,
      dataMode,
      realtimeCache,
      dailyMap.get(leader.tsCode),
      currentLimitMap,
    )
    if (finite(current.pctChg) && current.isLimitUp != null) leaderCurrentKnownCount += 1
    leader.pctChg = current.pctChg ?? Number.NaN
    leader.isLimitUp = current.isLimitUp ?? false
  }
  const eligibleRotationLeaders = rotationLeaders.filter((leader) => finite(leader.pctChg) && !leader.isLimitUp && leader.pctChg > 0)

  const trendAll: DipStock[] = trendCodes.map((tsCode) => {
    const event = recentEvents.get(tsCode)!
    const stockName = event.name ?? names.get(tsCode) ?? tsCode
    const current = getCurrentFacts(tsCode, stockName, tradeDate, dataMode, realtimeCache, dailyMap.get(tsCode), currentLimitMap)
    const metrics = trendMetrics(dailyMap.get(tsCode), tradeDate, dataMode, current.price)
    const concept = pickConcept(tsCode, tradeDate, currentThemeCounts)
    const conceptLimitUpCount = concept ? currentThemeCounts.get(concept.name) ?? 0 : null
    const judgment = judgeTrendDip({
      dataMode,
      currentPrice: current.price,
      currentIsLimitUp: current.isLimitUp,
      recentPeakBoards: event.peakBoards,
      recentPeakDate: event.peakDate,
      ...metrics,
      themeName: concept?.name ?? null,
      themeLimitUpCount: conceptLimitUpCount,
    })
    return {
      mode: 'trendDip', tsCode, stockCode: tsCode.split('.')[0], stockName,
      price: current.price, pctChg: current.pctChg, amountWan: current.amountWan,
      conceptName: concept?.name ?? null, conceptLimitUpCount,
      recentPeakBoards: event.peakBoards, recentPeakDate: event.peakDate, recentLimitUpDate: event.latestLimitUpDate,
      ...metrics,
      drop5dPct: null, netMoneyFlowAmount: null, volumeRatio5: null,
      leaderTsCode: null, leaderName: null, leaderPreviousBoards: null, leaderPctChg: null,
      judgment,
    }
  })

  const arbitrageAll: DipStock[] = arbitrageCodes.map((tsCode) => {
    const event = recentEvents.get(tsCode)!
    const stockName = event.name ?? names.get(tsCode) ?? tsCode
    const current = getCurrentFacts(tsCode, stockName, tradeDate, dataMode, realtimeCache, dailyMap.get(tsCode), currentLimitMap)
    const metrics = returnAndVolumeMetrics(dailyMap.get(tsCode), tradeDate, dataMode)
    const concept = pickConcept(tsCode, tradeDate, currentThemeCounts, retreatThemeNames)
    const conceptsKnown = getConceptsByStockRouted(getDb(), tsCode, source, tradeDate).length > 0
    const moneyFlow = moneyFlowMap.get(tsCode)
    const netMoneyFlowAmount = moneyFlow?.netMfAmount ?? null
    const judgment = judgeArbitrageDip({
      dataMode,
      marketLimitUpCount: ztCount,
      retreatThemeCount,
      recentLimitUpDate: event.latestLimitUpDate,
      themeName: concept?.name ?? null,
      themeRetreated: concept ? true : conceptsKnown ? false : null,
      currentPctChg: current.pctChg,
      currentIsLimitDown: current.isLimitDown,
      drop5dPct: metrics.drop5dPct,
      netMoneyFlowAmount,
      volumeRatio5: metrics.volumeRatio5,
    })
    return {
      mode: 'arbitrageDip', tsCode, stockCode: tsCode.split('.')[0], stockName,
      price: current.price, pctChg: current.pctChg, amountWan: current.amountWan,
      conceptName: concept?.name ?? null,
      conceptLimitUpCount: concept ? currentThemeCounts.get(concept.name) ?? 0 : null,
      recentPeakBoards: event.peakBoards, recentPeakDate: event.peakDate, recentLimitUpDate: event.latestLimitUpDate,
      ma10: null, ma20: null, ma30: null, ma20Slope5Pct: null, nearestMaLabel: null, distanceToNearestMaPct: null,
      drop5dPct: metrics.drop5dPct, netMoneyFlowAmount, volumeRatio5: metrics.volumeRatio5,
      leaderTsCode: null, leaderName: null, leaderPreviousBoards: null, leaderPctChg: null,
      judgment,
    }
  })

  const rotationAll: DipStock[] = []
  for (const leader of eligibleRotationLeaders) {
    const members = getMembersByConceptRouted(getDb(), leader.conceptCode, source, tradeDate)
    for (const member of members) {
      const tsCode = normalizeTsCode(member.stockCode)
      if (tsCode === leader.tsCode) continue
      const stockName = member.stockName || names.get(tsCode) || tsCode
      const current = getCurrentFacts(tsCode, stockName, tradeDate, dataMode, realtimeCache, dailyMap.get(tsCode), currentLimitMap)
      const event = recentEvents.get(tsCode)
      const recentPeakBoards = event
        ? event.hasUnknownHeight && event.peakBoards == null ? null : event.peakBoards
        : limitCoverageDays >= 10 ? 0 : null
      const themeLimitUpCount = currentThemeCounts.get(leader.conceptName) ?? 0
      const judgment = judgeRotationDip({
        dataMode,
        leaderName: leader.name,
        leaderPreviousBoards: leader.boards,
        leaderIsLimitUp: leader.isLimitUp,
        leaderPctChg: leader.pctChg,
        sameTheme: true,
        themeName: leader.conceptName,
        themeLimitUpCount,
        candidateRecentPeakBoards: recentPeakBoards,
        candidatePctChg: current.pctChg,
      })
      rotationAll.push({
        mode: 'rotationDip', tsCode, stockCode: tsCode.split('.')[0], stockName,
        price: current.price, pctChg: current.pctChg, amountWan: current.amountWan,
        conceptName: leader.conceptName, conceptLimitUpCount: themeLimitUpCount,
        recentPeakBoards, recentPeakDate: event?.peakDate ?? null, recentLimitUpDate: event?.latestLimitUpDate ?? null,
        ma10: null, ma20: null, ma30: null, ma20Slope5Pct: null, nearestMaLabel: null, distanceToNearestMaPct: null,
        drop5dPct: null, netMoneyFlowAmount: null, volumeRatio5: null,
        leaderTsCode: leader.tsCode, leaderName: leader.name, leaderPreviousBoards: leader.boards, leaderPctChg: leader.pctChg,
        judgment,
      })
    }
  }
  const rotationMap = new Map<string, DipStock>()
  for (const stock of rotationAll) {
    const existing = rotationMap.get(stock.tsCode)
    if (!existing || tierOrder(stock.judgment) < tierOrder(existing.judgment)
      || (stock.judgment.rankScore ?? -1) > (existing.judgment.rankScore ?? -1)) {
      rotationMap.set(stock.tsCode, stock)
    }
  }
  const deduplicatedRotation = Array.from(rotationMap.values())

  const trendGates: DipCondition[] = [
    trendCodes.length > 0
      ? dipGate.passed('trendSource', '近期强势池', `${trendCodes.length}只`, '近30个交易日存在二板及以上真实事件')
      : limitCoverageDays >= 10
        ? dipGate.failed('trendSource', '近期强势池', '0只', '近期没有二板及以上真实事件')
        : dipGate.unknown('trendSource', '近期强势池', '近期涨停事件覆盖不足'),
    trendAll.some((stock) => stock.ma30 != null)
      ? dipGate.passed('trendDaily', '均线覆盖', `${trendAll.filter((stock) => stock.ma30 != null).length}只可计算`, '至少一个来源股票具备MA30历史')
      : trendCodes.length === 0
        ? dipGate.passed('trendDaily', '均线覆盖', '无需计算', '当前没有近期强势来源股票')
        : dipGate.unknown('trendDaily', '均线覆盖', '来源股票日线不足30根'),
  ]
  const arbitrageGates: DipCondition[] = [
    ztCount == null
      ? dipGate.unknown('marketIce', '市场冰点', '当日涨停总数缺失')
      : ztCount < 30
        ? dipGate.passed('marketIce', '市场冰点', `${ztCount}只涨停`, '涨停数低于30')
        : dipGate.failed('marketIce', '市场冰点', `${ztCount}只涨停`, '涨停数不少于30'),
    retreatThemeCount == null
      ? dipGate.unknown('themeRetreat', '题材退潮', '前后交易日题材广度不足')
      : retreatThemeCount > 0
        ? dipGate.passed('themeRetreat', '题材退潮', `${retreatThemeCount}个`, '至少一个前一日主流题材涨停广度下降过半')
        : dipGate.failed('themeRetreat', '题材退潮', '0个', '没有主流题材涨停广度下降过半'),
    arbitrageCodes.length > 0
      ? dipGate.passed('recentHotPool', '前期热点池', `${arbitrageCodes.length}只`, '近30个交易日存在涨停来源股票')
      : limitCoverageDays >= 10
        ? dipGate.failed('recentHotPool', '前期热点池', '0只', '近期没有涨停来源股票')
        : dipGate.unknown('recentHotPool', '前期热点池', '近期涨停事件覆盖不足'),
  ]
  const rotationGates: DipCondition[] = [
    previousTradeDate == null
      ? dipGate.unknown('previousLeader', '前一日高标', '前一交易日缺失')
      : previousLeaders.length > 0
        ? dipGate.passed('previousLeader', '前一日高标', `${previousLeaders.length}只`, '前一交易日存在五板及以上真实高标')
        : previousLimitRows.length > 0
          ? dipGate.failed('previousLeader', '前一日高标', '0只', '前一交易日没有五板及以上高标')
          : dipGate.unknown('previousLeader', '前一日高标', '前一交易日涨停榜缺失'),
    previousTradeDate == null || previousLimitRows.length === 0
      ? dipGate.unknown('openedLeader', '打开高度', '前一交易日高标与当前行情不足')
      : previousLeaders.length === 0
        ? dipGate.failed('openedLeader', '打开高度', '0只', '没有可检查的五板及以上高标')
      : eligibleRotationLeaders.length > 0
        ? dipGate.passed('openedLeader', '打开高度', `${eligibleRotationLeaders.length}只`, '高位龙头打开涨停但仍保持红盘')
        : leaderCurrentKnownCount === previousLeaders.length
          ? dipGate.failed('openedLeader', '打开高度', '0只', '高位龙头仍涨停或已经跌入绿盘')
          : dipGate.unknown('openedLeader', '打开高度', '高位龙头当前行情缺失'),
  ]

  const modes: Record<DipMode, DipModeSnapshot> = {
    trendDip: {
      stocks: visibleStocks(trendAll),
      judgment: buildDipModeJudgment({ mode: 'trendDip', gates: trendGates, judgments: trendAll.map((stock) => stock.judgment), screenedCount: trendAll.length }),
    },
    arbitrageDip: {
      stocks: visibleStocks(arbitrageAll),
      judgment: buildDipModeJudgment({ mode: 'arbitrageDip', gates: arbitrageGates, judgments: arbitrageAll.map((stock) => stock.judgment), screenedCount: arbitrageAll.length }),
    },
    rotationDip: {
      stocks: visibleStocks(deduplicatedRotation),
      judgment: buildDipModeJudgment({ mode: 'rotationDip', gates: rotationGates, judgments: deduplicatedRotation.map((stock) => stock.judgment), screenedCount: deduplicatedRotation.length }),
    },
  }
  const snapshot: DipBuyRadarSnapshot = {
    requestedTradeDate,
    tradeDate,
    generatedAt: Date.now(),
    dataMode,
    rtDataTime: dataMode === 'realtime' ? toBjTime(getRtKCachedAt()) : null,
    sentiment: { ztCount, dtCount, temperature, previousTradeDate, hotConcepts, retreatThemes },
    modes,
    strategyVersion: DIP_BUY_STRATEGY_VERSION,
  }
  try {
    persistSignals(snapshot)
  } catch (error) {
    console.warn('[DipBuyRadar] persist signals failed:', error)
  }
  console.log(`[DipBuyRadar] requested=${requestedTradeDate} fact=${tradeDate} mode=${dataMode} trend=${modes.trendDip.stocks.length} arbitrage=${modes.arbitrageDip.stocks.length} rotation=${modes.rotationDip.stocks.length}`)
  return snapshot
}

let cachedRequestDate: string | null = null
let cachedSnapshot: DipBuyRadarSnapshot | null = null
let inFlight: Promise<DipBuyRadarSnapshot> | null = null

export async function getOrCreateDipBuyRadarSnapshot(tradeDate: string): Promise<DipBuyRadarSnapshot> {
  if (cachedSnapshot && cachedRequestDate === tradeDate) return cachedSnapshot
  if (inFlight && cachedRequestDate === tradeDate) return inFlight
  cachedRequestDate = tradeDate
  inFlight = buildSnapshot(tradeDate)
  try {
    cachedSnapshot = await inFlight
    return cachedSnapshot
  } finally {
    inFlight = null
  }
}

export async function refreshDipBuyRadarSnapshot(tradeDate: string): Promise<DipBuyRadarSnapshot> {
  cachedRequestDate = tradeDate
  inFlight = buildSnapshot(tradeDate)
  try {
    cachedSnapshot = await inFlight
    return cachedSnapshot
  } finally {
    inFlight = null
  }
}
