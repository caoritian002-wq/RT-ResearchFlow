import type Database from 'better-sqlite3'
import {
  getLatestPremarketFactSnapshot,
  premarketFactSnapshotExists,
  type SavedPremarketFactSnapshot,
} from '../database/premarketFactSnapshotRepository'
import { isTradeDay } from '../database/tradeCalRepository'
import {
  getPremarketCaptureWindowState,
  getPremarketStageCutoffAt,
  PREMARKET_CAPTURE_GRACE_MS,
} from './premarketCutoffPolicy'
import type { PremarketFetch } from './premarketGlobalFactProvider'
import {
  capturePremarketFactSnapshot,
  PREMARKET_FACT_RULE_VERSION,
} from './premarketSnapshotService'
import type {
  EvidenceConfidence,
  ExternalFactStatus,
  ExternalRiskTone,
  PremarketSnapshotStatus,
} from './premarketScenarioTypes'
import {
  getBeijingYmd,
  isWeekdayYmd,
  offsetYmd,
} from './marketSettlementPolicy'

export const PREMARKET_CAPTURE_STAGES = ['overnight', 'asia_open'] as const
export type PremarketCaptureStage = typeof PREMARKET_CAPTURE_STAGES[number]

const SCHEDULED_TIME: Record<PremarketCaptureStage, '07:30' | '08:45'> = {
  overnight: '07:30',
  asia_open: '08:45',
}

export interface PremarketStageStatusView {
  stage: PremarketCaptureStage
  scheduledTime: '07:30' | '08:45'
  inProgress: boolean
  latest: {
    tradeDate: string
    status: PremarketSnapshotStatus
    capturedAt: number
    sourceStatus: ExternalFactStatus
    sourceAttemptedAt: number | null
    sourceCompletedAt: number | null
    observationCount: number
    expectedCount: number
    errorCode: string | null
    warningCount: number
    externalRiskTone: ExternalRiskTone
    confidence: EvidenceConfidence
  } | null
  readError: string | null
}

export interface PremarketCaptureStatusView {
  enabled: boolean
  schedulerActive: boolean
  checkedAt: number
  tradeDate: string
  tradingDay: boolean
  currentWindow: {
    stage: PremarketCaptureStage
    closesAt: number
    snapshotExists: boolean
    canCapture: boolean
  } | null
  nextRun: {
    tradeDate: string
    stage: PremarketCaptureStage
    scheduledAt: number
  } | null
  stages: PremarketStageStatusView[]
}

export type PremarketCaptureCurrentCode =
  | 'CAPTURED'
  | 'CAPTURED_PARTIAL'
  | 'SNAPSHOT_REUSED'
  | 'PREMARKET_NETWORK_DISABLED'
  | 'PREMARKET_NOT_TRADING_DAY'
  | 'PREMARKET_NO_ACTIVE_WINDOW'
  | 'PREMARKET_CAPTURE_BLOCKED'
  | 'PREMARKET_CAPTURE_FAILED'

export interface PremarketCaptureCurrentResult {
  ok: boolean
  code: PremarketCaptureCurrentCode
  reused: boolean
}

const captureFlights = new WeakMap<
  Database.Database,
  Map<string, Promise<SavedPremarketFactSnapshot>>
>()

function getFlightMap(db: Database.Database): Map<string, Promise<SavedPremarketFactSnapshot>> {
  let flights = captureFlights.get(db)
  if (!flights) {
    flights = new Map()
    captureFlights.set(db, flights)
  }
  return flights
}

function toStableErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /^[A-Z0-9_:.-]{1,120}$/.test(message) ? message : 'PREMARKET_STATUS_READ_FAILED'
}

export function isPremarketTradingDay(
  db: Database.Database,
  tradeDate: string,
): boolean {
  try {
    const calendarResult = isTradeDay(db, tradeDate)
    if (calendarResult !== null) return calendarResult
  } catch {
    // A missing or temporarily unavailable calendar falls back to weekday semantics.
  }
  return isWeekdayYmd(tradeDate)
}

export function getCurrentPremarketCaptureStage(
  now = Date.now(),
): PremarketCaptureStage | null {
  const tradeDate = getBeijingYmd(now)
  return PREMARKET_CAPTURE_STAGES.find((stage) => (
    getPremarketCaptureWindowState(tradeDate, stage, now) === 'open'
  )) ?? null
}

export function getNextPremarketCaptureRun(
  db: Database.Database,
  stage: PremarketCaptureStage,
  now = Date.now(),
): { tradeDate: string; stage: PremarketCaptureStage; scheduledAt: number } | null {
  const today = getBeijingYmd(now)
  for (let offset = 0; offset < 370; offset += 1) {
    const tradeDate = offsetYmd(today, offset)
    if (!isPremarketTradingDay(db, tradeDate)) continue
    const scheduledAt = getPremarketStageCutoffAt(tradeDate, stage)
    if (scheduledAt > now) return { tradeDate, stage, scheduledAt }
  }
  return null
}

function getNextAnyPremarketCaptureRun(
  db: Database.Database,
  now: number,
): PremarketCaptureStatusView['nextRun'] {
  const candidates = PREMARKET_CAPTURE_STAGES
    .map((stage) => getNextPremarketCaptureRun(db, stage, now))
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
  return candidates[0] ?? null
}

function readStageStatus(
  db: Database.Database,
  stage: PremarketCaptureStage,
  now: number,
): PremarketStageStatusView {
  try {
    const snapshot = getLatestPremarketFactSnapshot(db, stage)
    const source = snapshot?.sources[0]
    return {
      stage,
      scheduledTime: SCHEDULED_TIME[stage],
      inProgress: getFlightMap(db).has(`${getBeijingYmd(now)}|${stage}|${PREMARKET_FACT_RULE_VERSION}`),
      latest: snapshot ? {
        tradeDate: snapshot.tradeDate,
        status: snapshot.status,
        capturedAt: snapshot.capturedAt,
        sourceStatus: source?.status ?? snapshot.status,
        sourceAttemptedAt: source?.attemptedAt ?? null,
        sourceCompletedAt: source?.completedAt ?? null,
        observationCount: source?.observationCount ?? snapshot.facts.observations.length,
        expectedCount: source?.expectedCount ?? 0,
        errorCode: source?.errorCode
          ?? (snapshot.status === 'failed' || snapshot.status === 'blocked' ? snapshot.warnings[0] ?? null : null),
        warningCount: snapshot.warnings.length,
        externalRiskTone: snapshot.facts.externalRisk.tone,
        confidence: snapshot.facts.externalRisk.confidence,
      } : null,
      readError: null,
    }
  } catch (error) {
    return {
      stage,
      scheduledTime: SCHEDULED_TIME[stage],
      inProgress: false,
      latest: null,
      readError: toStableErrorCode(error),
    }
  }
}

export function buildPremarketCaptureStatus(
  db: Database.Database,
  enabled: boolean,
  schedulerActive: boolean,
  now = Date.now(),
): PremarketCaptureStatusView {
  const tradeDate = getBeijingYmd(now)
  const tradingDay = isPremarketTradingDay(db, tradeDate)
  const currentStage = tradingDay ? getCurrentPremarketCaptureStage(now) : null
  let currentWindow: PremarketCaptureStatusView['currentWindow'] = null
  if (currentStage) {
    const snapshotExists = premarketFactSnapshotExists(
      db,
      tradeDate,
      currentStage,
      PREMARKET_FACT_RULE_VERSION,
    )
    currentWindow = {
      stage: currentStage,
      closesAt: getPremarketStageCutoffAt(tradeDate, currentStage) + PREMARKET_CAPTURE_GRACE_MS,
      snapshotExists,
      canCapture: enabled && !snapshotExists,
    }
  }
  return {
    enabled,
    schedulerActive,
    checkedAt: now,
    tradeDate,
    tradingDay,
    currentWindow,
    nextRun: getNextAnyPremarketCaptureRun(db, now),
    stages: PREMARKET_CAPTURE_STAGES.map((stage) => readStageStatus(db, stage, now)),
  }
}

export function runPremarketCaptureStage(
  db: Database.Database,
  stage: PremarketCaptureStage,
  now = Date.now(),
  fetcher?: PremarketFetch,
): Promise<SavedPremarketFactSnapshot> {
  const tradeDate = getBeijingYmd(now)
  const key = `${tradeDate}|${stage}|${PREMARKET_FACT_RULE_VERSION}`
  const flights = getFlightMap(db)
  const existingFlight = flights.get(key)
  if (existingFlight) return existingFlight

  let flight: Promise<SavedPremarketFactSnapshot>
  flight = capturePremarketFactSnapshot(db, { tradeDate, stage, now, fetcher })
    .finally(() => {
      if (flights.get(key) === flight) flights.delete(key)
    })
  flights.set(key, flight)
  return flight
}

export async function reconcilePremarketCaptureForToday(
  db: Database.Database,
  enabled: boolean,
  now = Date.now(),
  fetcher?: PremarketFetch,
): Promise<SavedPremarketFactSnapshot[]> {
  if (!enabled) return []
  const tradeDate = getBeijingYmd(now)
  if (!isPremarketTradingDay(db, tradeDate)) return []
  const results: SavedPremarketFactSnapshot[] = []
  for (const stage of PREMARKET_CAPTURE_STAGES) {
    if (getPremarketCaptureWindowState(tradeDate, stage, now) === 'early') continue
    try {
      results.push(await runPremarketCaptureStage(db, stage, now, fetcher))
    } catch (error) {
      console.warn(`[Premarket] startup reconciliation skipped ${stage}:`, toStableErrorCode(error))
    }
  }
  return results
}

export async function captureCurrentPremarketStage(
  db: Database.Database,
  enabled: boolean,
  now = Date.now(),
  fetcher?: PremarketFetch,
): Promise<PremarketCaptureCurrentResult> {
  if (!enabled) return { ok: false, code: 'PREMARKET_NETWORK_DISABLED', reused: false }
  const tradeDate = getBeijingYmd(now)
  if (!isPremarketTradingDay(db, tradeDate)) {
    return { ok: false, code: 'PREMARKET_NOT_TRADING_DAY', reused: false }
  }
  const stage = getCurrentPremarketCaptureStage(now)
  if (!stage) return { ok: false, code: 'PREMARKET_NO_ACTIVE_WINDOW', reused: false }
  try {
    const result = await runPremarketCaptureStage(db, stage, now, fetcher)
    if (result.snapshot.status === 'failed') {
      return { ok: false, code: 'PREMARKET_CAPTURE_FAILED', reused: result.reused }
    }
    if (result.snapshot.status === 'blocked') {
      return { ok: false, code: 'PREMARKET_CAPTURE_BLOCKED', reused: result.reused }
    }
    return {
      ok: true,
      code: result.reused
        ? 'SNAPSHOT_REUSED'
        : result.snapshot.status === 'partial'
          ? 'CAPTURED_PARTIAL'
          : 'CAPTURED',
      reused: result.reused,
    }
  } catch {
    return { ok: false, code: 'PREMARKET_CAPTURE_FAILED', reused: false }
  }
}
