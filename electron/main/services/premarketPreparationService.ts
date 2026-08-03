import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getLatestPremarketPreparation,
  savePremarketPreparation,
} from '../database/premarketPreparationRepository'
import { getNextTradeDay, isTradeDay } from '../database/tradeCalRepository'
import { getPremarketNetworkEnabled } from '../database/settingsRepository'
import { getPremarketStageCutoffAt } from './premarketCutoffPolicy'
import { evaluateExternalRiskBreadth } from './premarketExternalRiskModel'
import {
  PREMARKET_EXTERNAL_ASSETS,
  PREMARKET_GLOBAL_PROVIDER_ID,
  fetchPremarketExternalFacts,
  type PremarketExternalFactResult,
  type PremarketFetch,
} from './premarketGlobalFactProvider'
import type {
  PremarketPreparationBriefingsV1,
  PremarketPreparationReadResponse,
  PremarketPreparationRefreshResponse,
  PremarketPreparationSnapshot,
  PremarketPreparationView,
} from './premarketRehearsalTypes'
import { getBeijingYmd, isWeekdayYmd, offsetYmd } from './marketSettlementPolicy'

const PREPARATION_RECENT_WINDOW_MS = 72 * 60 * 60 * 1000
const flights = new WeakMap<Database.Database, Map<string, Promise<PremarketPreparationRefreshResponse>>>()

export interface PremarketBriefingScanResult {
  runId: number
  newBriefingsFound: number
}

interface RefreshPremarketPreparationOptions {
  now?: number
  fetcher?: PremarketFetch
  scanBriefings: () => Promise<PremarketBriefingScanResult>
}

function toView(snapshot: PremarketPreparationSnapshot): PremarketPreparationView {
  const { externalSha256: _externalSha256, briefingsSha256: _briefingsSha256, ...view } = snapshot
  return view
}

export function resolvePremarketPreparationTargetTradeDate(
  db: Database.Database,
  now = Date.now(),
): string | null {
  const today = getBeijingYmd(now)
  const calendarState = isTradeDay(db, today)
  const todayTrading = calendarState ?? isWeekdayYmd(today)
  if (todayTrading && now < getPremarketStageCutoffAt(today, 'auction_confirmed')) return today
  const knownNext = getNextTradeDay(db, today)
  if (knownNext) return knownNext
  const calendarCount = (db.prepare('SELECT COUNT(*) AS count FROM trade_cal').get() as { count: number }).count
  if (calendarCount > 0) return null
  for (let offset = 1; offset < 15; offset += 1) {
    const candidate = offsetYmd(today, offset)
    if (isWeekdayYmd(candidate)) return candidate
  }
  return null
}

export function readPremarketPreparation(
  db: Database.Database,
  now = Date.now(),
): PremarketPreparationReadResponse {
  const targetTradeDate = resolvePremarketPreparationTargetTradeDate(db, now)
  const preparation = targetTradeDate
    ? getLatestPremarketPreparation(db, targetTradeDate)
    : null
  return {
    ok: true,
    targetTradeDate,
    preparation: preparation ? toView(preparation) : null,
  }
}

function readBriefingCoverage(
  db: Database.Database,
  now: number,
  scanResult: PromiseSettledResult<PremarketBriefingScanResult>,
): PremarketPreparationBriefingsV1 {
  const latest = db.prepare(`
    SELECT MAX(publishedAt) AS latestPublishedAt
    FROM briefings
    WHERE publishedAt <= ?
  `).get(now + 5 * 60 * 1000) as { latestPublishedAt: number | null }
  const coverage = db.prepare(`
    SELECT COUNT(*) AS recentCount, COUNT(DISTINCT sourceId) AS sourceCount
    FROM briefings
    WHERE publishedAt BETWEEN ? AND ?
  `).get(now - PREPARATION_RECENT_WINDOW_MS, now + 5 * 60 * 1000) as {
    recentCount: number
    sourceCount: number
  }
  if (scanResult.status === 'fulfilled') {
    return {
      schemaVersion: 1,
      scanStatus: 'completed',
      scanRunId: scanResult.value.runId,
      newBriefingsFound: scanResult.value.newBriefingsFound,
      recentCount: coverage.recentCount,
      sourceCount: coverage.sourceCount,
      latestPublishedAt: latest.latestPublishedAt,
      windowHours: 72,
      errorCode: null,
    }
  }
  const message = scanResult.reason instanceof Error ? scanResult.reason.message : String(scanResult.reason)
  const busy = message === 'Scan already in progress'
  return {
    schemaVersion: 1,
    scanStatus: busy ? 'busy' : 'failed',
    scanRunId: null,
    newBriefingsFound: 0,
    recentCount: coverage.recentCount,
    sourceCount: coverage.sourceCount,
    latestPublishedAt: latest.latestPublishedAt,
    windowHours: 72,
    errorCode: busy ? 'BRIEFING_SCAN_IN_PROGRESS' : 'BRIEFING_SCAN_FAILED',
  }
}

function failedExternalResult(now: number): PremarketExternalFactResult {
  return {
    providerId: PREMARKET_GLOBAL_PROVIDER_ID,
    status: 'failed',
    observations: [],
    source: {
      sourceId: PREMARKET_GLOBAL_PROVIDER_ID,
      status: 'failed',
      attemptedAt: now,
      completedAt: now,
      observationCount: 0,
      expectedCount: PREMARKET_EXTERNAL_ASSETS.filter((item) => item.stages.includes('asia_open')).length,
      errorCode: 'NETWORK_ERROR',
    },
    warnings: ['NETWORK_ERROR'],
  }
}

async function executeRefresh(
  db: Database.Database,
  targetTradeDate: string,
  options: RefreshPremarketPreparationOptions,
): Promise<PremarketPreparationRefreshResponse> {
  const now = options.now ?? Date.now()
  const [externalSettled, scanResult] = await Promise.allSettled([
    fetchPremarketExternalFacts({
      stage: 'asia_open',
      cutoffAt: now,
      fetcher: options.fetcher,
      now: () => now,
    }),
    Promise.resolve().then(options.scanBriefings),
  ])
  const externalResult = externalSettled.status === 'fulfilled'
    ? externalSettled.value
    : failedExternalResult(now)
  const briefings = readBriefingCoverage(db, now, scanResult)
  const externalRisk = evaluateExternalRiskBreadth(externalResult.observations)
  const external = {
    schemaVersion: 1 as const,
    targetTradeDate,
    capturedAt: now,
    status: externalResult.status,
    observations: externalResult.observations,
    externalRisk,
    source: externalResult.source,
  }
  const warnings = [...new Set([
    ...externalResult.warnings,
    ...externalRisk.warnings,
    ...(briefings.errorCode ? [briefings.errorCode] : []),
  ])]
  const status = externalResult.status === 'ready' && briefings.scanStatus === 'completed'
    ? 'ready' as const
    : externalResult.status === 'failed' && briefings.scanStatus === 'failed'
      ? 'failed' as const
      : 'partial' as const
  const saved = savePremarketPreparation(db, {
    id: randomUUID(),
    targetTradeDate,
    status,
    capturedAt: now,
    external,
    briefings,
    warnings,
    createdAt: now,
  })
  return { ok: true, preparation: toView(saved) }
}

export function refreshPremarketPreparation(
  db: Database.Database,
  options: RefreshPremarketPreparationOptions,
): Promise<PremarketPreparationRefreshResponse> {
  if (!getPremarketNetworkEnabled(db)) {
    return Promise.resolve({
      ok: false,
      code: 'PREMARKET_NETWORK_DISABLED',
      message: '盘前联网采集尚未开启，请先在采集设置中开启',
    })
  }
  const now = options.now ?? Date.now()
  const targetTradeDate = resolvePremarketPreparationTargetTradeDate(db, now)
  if (!targetTradeDate) {
    return Promise.resolve({
      ok: false,
      code: 'PREMARKET_PREPARATION_TARGET_UNAVAILABLE',
      message: '本地交易日历尚未覆盖下一交易日',
    })
  }
  let map = flights.get(db)
  if (!map) {
    map = new Map()
    flights.set(db, map)
  }
  const current = map.get(targetTradeDate)
  if (current) return current
  let promise: Promise<PremarketPreparationRefreshResponse>
  promise = executeRefresh(db, targetTradeDate, options)
    .catch((error) => ({
      ok: false as const,
      code: 'PREMARKET_PREPARATION_FAILED' as const,
      message: error instanceof Error ? error.message : '下一交易日准备资料更新失败',
    }))
    .finally(() => {
      if (map?.get(targetTradeDate) === promise) map.delete(targetTradeDate)
    })
  map.set(targetTradeDate, promise)
  return promise
}
