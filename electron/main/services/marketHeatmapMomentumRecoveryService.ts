import type Database from 'better-sqlite3'
import { getLastNTradingDays, isTradeDay } from '../database/tradeCalRepository'
import {
  SHENWAN_L1_INDUSTRIES,
  SHENWAN_L2_TO_L1_NAME,
} from './eastmoneyIndustryHierarchy'
import {
  fetchCurrentMarketIndustryBoardFacts,
  fetchMarketTrendSeries,
} from './marketResonanceService'
import type { MarketTrendSeries } from './marketResonanceModel'

export type HeatmapMomentumRecoveryBoundary = 'lunch-close' | 'market-close'

export interface HeatmapMomentumRecoveryTarget {
  tradeDate: string
  boundary: HeatmapMomentumRecoveryBoundary
  boundaryTime: '11:30' | '15:00'
}

export interface RecoveredHeatmapMomentum {
  origin: 'historical-recovery'
  sourceProvider: 'eastmoney'
  taxonomy: 'shenwan'
  tradeDate: string
  boundary: HeatmapMomentumRecoveryBoundary
  boundaryTime: string
  baselineTime: string
  capturedAt: number
  windowMinutes: number
  momentum: Record<string, number>
  coverage: {
    l1: { available: number; total: number }
    l2: { available: number; total: number }
  }
  warnings: string[]
}

export interface RecoverHeatmapMomentumRequest {
  windowMinutes: number
  includeL2: boolean
  forceRefresh?: boolean
  existingRecord?: {
    tradeDate: string
    boundary: HeatmapMomentumRecoveryBoundary
    windowMinutes: number
  }
}

interface TrendTarget {
  code: string
  name: string
  level: 'l1' | 'l2'
}

interface FetchedTarget extends TrendTarget {
  series: MarketTrendSeries
}

const MIN_L1_COVERAGE = 10
const MAX_BOUNDARY_LAG_MINUTES = 1
const CACHE_TTL_MS = 10 * 60_000
const cache = new Map<string, { value: RecoveredHeatmapMomentum; cachedAt: number }>()
const inflight = new Map<string, Promise<RecoveredHeatmapMomentum>>()

export function resolveHeatmapMomentumRecoveryTarget(
  db: Database.Database,
  now = Date.now(),
): HeatmapMomentumRecoveryTarget | null {
  const today = beijingCompactDate(now)
  const minute = beijingMinuteOfDay(now)
  const calendarState = safeIsTradeDay(db, today)
  const currentIsTradeDay = calendarState ?? isWeekday(now)

  if (currentIsTradeDay) {
    if (minute >= 11 * 60 + 30 && minute < 13 * 60) {
      return { tradeDate: today, boundary: 'lunch-close', boundaryTime: '11:30' }
    }
    if (minute >= 15 * 60) {
      return { tradeDate: today, boundary: 'market-close', boundaryTime: '15:00' }
    }
    return null
  }

  const latestTradeDate = resolveLatestKnownTradeDate(db, today)
  if (!latestTradeDate || latestTradeDate > today) return null
  return {
    tradeDate: latestTradeDate,
    boundary: 'market-close',
    boundaryTime: '15:00',
  }
}

export async function recoverHeatmapMomentum(
  db: Database.Database,
  request: RecoverHeatmapMomentumRequest,
  now = Date.now(),
): Promise<RecoveredHeatmapMomentum | null> {
  const windowMinutes = normalizeWindowMinutes(request.windowMinutes)
  const target = resolveHeatmapMomentumRecoveryTarget(db, now)
  if (!target) return null
  if (
    !request.forceRefresh
    && request.existingRecord?.tradeDate === compactToDisplayDate(target.tradeDate)
    && request.existingRecord.boundary === target.boundary
    && request.existingRecord.windowMinutes === windowMinutes
  ) return null

  const cacheKey = `${target.tradeDate}:${target.boundary}:${windowMinutes}:${request.includeL2 ? 'l2' : 'l1'}`
  const cached = cache.get(cacheKey)
  if (!request.forceRefresh && cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.value

  const active = inflight.get(cacheKey)
  if (active) return active
  const promise = buildRecoveredMomentum(target, windowMinutes, request.includeL2)
    .then((value) => {
      cache.set(cacheKey, { value, cachedAt: Date.now() })
      return value
    })
    .finally(() => inflight.delete(cacheKey))
  inflight.set(cacheKey, promise)
  return promise
}

async function buildRecoveredMomentum(
  recoveryTarget: HeatmapMomentumRecoveryTarget,
  windowMinutes: number,
  includeL2: boolean,
): Promise<RecoveredHeatmapMomentum> {
  const warnings: string[] = []
  const l1Targets: TrendTarget[] = SHENWAN_L1_INDUSTRIES.map((industry) => ({
    code: industry.code,
    name: industry.name,
    level: 'l1',
  }))
  let l2Targets: TrendTarget[] = []
  if (includeL2) {
    try {
      const facts = await fetchCurrentMarketIndustryBoardFacts()
      const l1Codes = new Set(SHENWAN_L1_INDUSTRIES.map((industry) => industry.code))
      l2Targets = [...facts.values()].flatMap((fact): TrendTarget[] => (
        !l1Codes.has(fact.boardCode) && SHENWAN_L2_TO_L1_NAME[fact.name]
          ? [{ code: fact.boardCode, name: fact.name, level: 'l2' }]
          : []
      ))
    } catch {
      warnings.push('L2_BOARD_LIST_UNAVAILABLE')
    }
  }

  // 先探测一个 L1；目标交易日不可恢复时，不把失败放大到全部行业。
  const [probe, ...remainingL1] = l1Targets
  let first: FetchedTarget
  try {
    first = await fetchTarget(probe, recoveryTarget.tradeDate)
  } catch {
    throw new Error('HEATMAP_MOMENTUM_TRADE_DATE_UNAVAILABLE')
  }
  const settled = await mapWithConcurrency(
    [...remainingL1, ...l2Targets],
    4,
    async (target) => {
      try {
        return await fetchTarget(target, recoveryTarget.tradeDate)
      } catch {
        return null
      }
    },
  )
  const fetched = [first, ...settled.filter((item): item is FetchedTarget => item !== null)]
  const fetchedL1 = fetched.filter((item) => item.level === 'l1')
  const actualBoundaryTime = resolveCommonBoundaryTime(
    fetchedL1,
    recoveryTarget.boundaryTime,
    windowMinutes,
  )
  if (!actualBoundaryTime) throw new Error('HEATMAP_MOMENTUM_BOUNDARY_UNAVAILABLE')

  const baselineTime = shiftMinute(actualBoundaryTime, -windowMinutes)
  const momentum: Record<string, number> = {}
  let l1Available = 0
  let l2Available = 0
  for (const item of fetched) {
    const baseline = item.series.points.find((point) => point.time === baselineTime)
    const current = item.series.points.find((point) => point.time === actualBoundaryTime)
    if (!baseline || !current) continue
    momentum[item.name] = round(current.change - baseline.change, 4)
    if (item.level === 'l1') l1Available += 1
    else l2Available += 1
  }
  if (l1Available < MIN_L1_COVERAGE) throw new Error('HEATMAP_MOMENTUM_INSUFFICIENT_COVERAGE')
  if (l1Available < l1Targets.length) warnings.push('L1_PARTIAL_COVERAGE')
  if (includeL2 && l2Available < l2Targets.length) warnings.push('L2_PARTIAL_COVERAGE')

  return {
    origin: 'historical-recovery',
    sourceProvider: 'eastmoney',
    taxonomy: 'shenwan',
    tradeDate: compactToDisplayDate(recoveryTarget.tradeDate),
    boundary: recoveryTarget.boundary,
    boundaryTime: actualBoundaryTime,
    baselineTime,
    capturedAt: beijingTimestamp(recoveryTarget.tradeDate, actualBoundaryTime),
    windowMinutes,
    momentum,
    coverage: {
      l1: { available: l1Available, total: l1Targets.length },
      l2: { available: l2Available, total: l2Targets.length },
    },
    warnings,
  }
}

async function fetchTarget(target: TrendTarget, tradeDate: string): Promise<FetchedTarget> {
  const fetched = await fetchMarketTrendSeries(
    `90.${target.code}`,
    target.code,
    target.name,
    tradeDate,
    5,
  )
  if (fetched.series.tradeDate !== tradeDate) throw new Error('HEATMAP_MOMENTUM_DATE_MISMATCH')
  return { ...target, series: fetched.series }
}

function resolveCommonBoundaryTime(
  items: FetchedTarget[],
  requestedBoundaryTime: string,
  windowMinutes: number,
): string | null {
  for (let lag = 0; lag <= MAX_BOUNDARY_LAG_MINUTES; lag += 1) {
    const boundaryTime = shiftMinute(requestedBoundaryTime, -lag)
    const baselineTime = shiftMinute(boundaryTime, -windowMinutes)
    const covered = items.filter((item) => {
      const times = new Set(item.series.points.map((point) => point.time))
      return times.has(boundaryTime) && times.has(baselineTime)
    }).length
    if (covered >= MIN_L1_COVERAGE) return boundaryTime
  }
  return null
}

function normalizeWindowMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error('INVALID_HEATMAP_MOMENTUM_REQUEST')
  }
  return value
}

function safeIsTradeDay(db: Database.Database, tradeDate: string): boolean | null {
  try {
    return isTradeDay(db, tradeDate)
  } catch {
    return null
  }
}

function resolveLatestKnownTradeDate(db: Database.Database, beforeDate: string): string | null {
  try {
    const dates = getLastNTradingDays(db, 1, beforeDate)
    if (dates.length > 0) return dates[0]
  } catch {
    // Older or isolated databases can fall back to existing day-level facts.
  }
  const candidates: string[] = []
  for (const table of ['daily_close_cache', 'sector_flow_observations', 'market_resonance_daily_snapshots']) {
    try {
      const row = db.prepare(`SELECT MAX(trade_date) AS trade_date FROM ${table} WHERE trade_date <= ?`)
        .get(beforeDate) as { trade_date: string | null }
      if (row.trade_date && /^\d{8}$/.test(row.trade_date)) candidates.push(row.trade_date)
    } catch {
      // A missing optional table does not block the remaining local sources.
    }
  }
  return candidates.sort((left, right) => right.localeCompare(left))[0] ?? null
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return output
}

function beijingCompactDate(timestamp: number): string {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function beijingMinuteOfDay(timestamp: number): number {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  return date.getUTCHours() * 60 + date.getUTCMinutes()
}

function isWeekday(timestamp: number): boolean {
  const day = new Date(timestamp + 8 * 60 * 60 * 1000).getUTCDay()
  return day >= 1 && day <= 5
}

function shiftMinute(time: string, delta: number): string {
  const [hour, minute] = time.split(':').map(Number)
  const total = hour * 60 + minute + delta
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function compactToDisplayDate(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function beijingTimestamp(tradeDate: string, time: string): number {
  const displayDate = compactToDisplayDate(tradeDate)
  return Date.parse(`${displayDate}T${time}:00+08:00`)
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
