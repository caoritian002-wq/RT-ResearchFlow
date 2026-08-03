import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import {
  getLatestPremarketScenarioVersionBefore,
  getPremarketScenarioVersion,
  getPremarketScenarioVersionById,
  listPremarketScenarioVersions,
  savePremarketScenarioVersion,
  toPremarketScenarioRevisionSummary,
  type SavedPremarketScenarioVersion,
} from '../database/premarketScenarioVersionRepository'
import {
  getPremarketScenarioFactCutoffAt,
  getPremarketStageCutoffAt,
} from './premarketCutoffPolicy'
import { buildPremarketScenarioEvidence } from './premarketEvidenceBuilder'
import type {
  PremarketScenarioDisplayContext,
  PremarketScenarioReadResponse,
  PremarketScenarioRevisionKind,
  PremarketScenarioStage,
  PremarketScenarioView,
  PremarketScenarioVersion,
} from './premarketRehearsalTypes'
import {
  buildPremarketScenarioResult,
  PREMARKET_SCENARIO_RULE_VERSION,
} from './premarketScenarioModel'
import { isTradeDay } from '../database/tradeCalRepository'
import { getBeijingYmd, isWeekdayYmd } from './marketSettlementPolicy'
import { getLatestPremarketAIExplanation } from '../database/premarketAIExplanationRepository'
import { buildPremarketCalibration, readPremarketOutcome } from './premarketOutcomeService'

const flights = new WeakMap<Database.Database, Map<string, Promise<SavedPremarketScenarioVersion>>>()

function getFlights(db: Database.Database): Map<string, Promise<SavedPremarketScenarioVersion>> {
  let map = flights.get(db)
  if (!map) {
    map = new Map()
    flights.set(db, map)
  }
  return map
}

function toView(version: PremarketScenarioVersion): PremarketScenarioView {
  const { evidenceSha256: _evidenceSha256, scenarioSha256: _scenarioSha256, ...view } = version
  return view
}

export function createPremarketScenarioVersion(
  db: Database.Database,
  input: {
    tradeDate: string
    stage: PremarketScenarioStage
    now?: number
    requestedAt?: number
    revisionKind?: PremarketScenarioRevisionKind
    appendRevision?: boolean
    additionalWarnings?: string[]
  },
): SavedPremarketScenarioVersion {
  const now = input.now ?? Date.now()
  const cutoffAt = getPremarketStageCutoffAt(input.tradeDate, input.stage)
  if (now < cutoffAt) throw new Error('PREMARKET_SCENARIO_BEFORE_CUTOFF')
  const existing = getPremarketScenarioVersion(
    db,
    input.tradeDate,
    input.stage,
    PREMARKET_SCENARIO_RULE_VERSION,
  )
  if (existing && !input.appendRevision) return { version: existing, reused: true }
  if (input.appendRevision && input.stage !== 'auction_confirmed') {
    throw new Error('PREMARKET_SCENARIO_REVISION_STAGE_UNSUPPORTED')
  }
  const revision = input.appendRevision ? (existing?.revision ?? 0) + 1 : 1
  const revisionKind = input.revisionKind ?? 'scheduled'
  const parent = input.stage === 'auction_confirmed'
    ? getPremarketScenarioVersion(db, input.tradeDate, 'asia_open', PREMARKET_SCENARIO_RULE_VERSION)
    : null
  const evidence = buildPremarketScenarioEvidence(db, {
    tradeDate: input.tradeDate,
    stage: input.stage,
    generatedAt: now,
  })
  if (input.stage === 'auction_confirmed' && !parent) {
    evidence.warnings = [...evidence.warnings, 'ASIA_OPEN_SCENARIO_VERSION_MISSING']
  }
  if (input.additionalWarnings?.length) {
    evidence.warnings = [...new Set([...evidence.warnings, ...input.additionalWarnings])].slice(0, 200)
  }
  const scenario = buildPremarketScenarioResult(evidence)
  return savePremarketScenarioVersion(db, {
    id: randomUUID(),
    tradeDate: input.tradeDate,
    stage: input.stage,
    status: scenario.status,
    ruleVersion: PREMARKET_SCENARIO_RULE_VERSION,
    baseFactSnapshotId: evidence.market.baseFactSnapshotId,
    parentVersionId: parent?.id ?? null,
    previousRevisionId: input.appendRevision ? existing?.id ?? null : null,
    revision,
    revisionKind,
    requestedAt: input.requestedAt ?? now,
    cutoffAt,
    factCutoffAt: getPremarketScenarioFactCutoffAt(input.tradeDate, input.stage),
    generatedAt: now,
    evidence,
    scenario,
    warnings: scenario.warnings,
    createdAt: now,
  })
}

export function runPremarketScenarioStage(
  db: Database.Database,
  input: {
    tradeDate: string
    stage: PremarketScenarioStage
    now?: number
    requestedAt?: number
    revisionKind?: PremarketScenarioRevisionKind
    appendRevision?: boolean
    additionalWarnings?: string[]
  },
): Promise<SavedPremarketScenarioVersion> {
  const key = `${input.appendRevision ? 'append' : 'base'}|${input.tradeDate}|${input.stage}|${PREMARKET_SCENARIO_RULE_VERSION}`
  const map = getFlights(db)
  const current = map.get(key)
  if (current) return current
  let flight: Promise<SavedPremarketScenarioVersion>
  flight = Promise.resolve()
    .then(() => createPremarketScenarioVersion(db, input))
    .finally(() => {
      if (map.get(key) === flight) map.delete(key)
    })
  map.set(key, flight)
  return flight
}

export async function reconcilePremarketScenariosForToday(
  db: Database.Database,
  now = Date.now(),
): Promise<SavedPremarketScenarioVersion[]> {
  const tradeDate = getBeijingYmd(now)
  const results: SavedPremarketScenarioVersion[] = []
  const calendarState = isTradeDay(db, tradeDate)
  if (calendarState === false || (calendarState === null && !isWeekdayYmd(tradeDate))) return results
  if (now < getPremarketStageCutoffAt(tradeDate, 'asia_open')) return results
  results.push(await runPremarketScenarioStage(db, { tradeDate, stage: 'asia_open', now }))
  if (now >= getPremarketStageCutoffAt(tradeDate, 'auction_confirmed')) {
    results.push(await runPremarketScenarioStage(db, { tradeDate, stage: 'auction_confirmed', now }))
  }
  return results
}

export interface SelectedPremarketScenario {
  version: PremarketScenarioVersion
  displayContext: PremarketScenarioDisplayContext
}

export function selectDisplayedPremarketScenario(
  db: Database.Database,
  now = Date.now(),
): SelectedPremarketScenario | null {
  const requestedTradeDate = getBeijingYmd(now)
  const calendarState = isTradeDay(db, requestedTradeDate)
  const requestedTradingDay = calendarState ?? isWeekdayYmd(requestedTradeDate)
  const auctionCutoff = getPremarketStageCutoffAt(requestedTradeDate, 'auction_confirmed')
  const initialCutoff = getPremarketStageCutoffAt(requestedTradeDate, 'asia_open')
  const currentVersion = now >= auctionCutoff
    ? getPremarketScenarioVersion(db, requestedTradeDate, 'auction_confirmed', PREMARKET_SCENARIO_RULE_VERSION)
      ?? getPremarketScenarioVersion(db, requestedTradeDate, 'asia_open', PREMARKET_SCENARIO_RULE_VERSION)
    : now >= initialCutoff
      ? getPremarketScenarioVersion(db, requestedTradeDate, 'asia_open', PREMARKET_SCENARIO_RULE_VERSION)
      : null
  if (currentVersion) {
    return {
      version: currentVersion,
      displayContext: {
        requestedTradeDate,
        displayTradeDate: currentVersion.tradeDate,
        isFallback: false,
        requestedTradingDay,
        fallbackReason: null,
      },
    }
  }
  const fallback = getLatestPremarketScenarioVersionBefore(db, requestedTradeDate)
  if (!fallback) return null
  return {
    version: fallback,
    displayContext: {
      requestedTradeDate,
      displayTradeDate: fallback.tradeDate,
      isFallback: true,
      requestedTradingDay,
      fallbackReason: requestedTradingDay ? 'current_version_unavailable' : 'non_trading_day',
    },
  }
}

export function readCurrentPremarketScenario(
  db: Database.Database,
  now = Date.now(),
): PremarketScenarioReadResponse {
  try {
    const selected = selectDisplayedPremarketScenario(db, now)
    if (!selected) {
      return {
        ok: false,
        code: 'SCENARIO_NOT_AVAILABLE',
        message: '本地尚未生成可回看的盘前推演版本',
      }
    }
    const { version, displayContext } = selected
    return {
      ok: true,
      version: toView(version),
      revisions: listPremarketScenarioVersions(db, version.tradeDate, version.stage)
        .map(toPremarketScenarioRevisionSummary),
      displayContext,
      outcome: readPremarketOutcome(db, version, now),
      calibration: buildPremarketCalibration(db, now),
      explanation: getLatestPremarketAIExplanation(db, version.id),
    }
  } catch (error) {
    return {
      ok: false,
      code: 'SCENARIO_READ_FAILED',
      message: error instanceof Error ? error.message : '盘前推演版本读取失败',
    }
  }
}

export function readPremarketScenarioRevision(
  db: Database.Database,
  versionId: string,
  now = Date.now(),
): PremarketScenarioReadResponse {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(versionId)) {
      return { ok: false, code: 'SCENARIO_NOT_AVAILABLE', message: '盘前推演修订不存在' }
    }
    const version = getPremarketScenarioVersionById(db, versionId)
    if (!version) {
      return { ok: false, code: 'SCENARIO_NOT_AVAILABLE', message: '盘前推演修订不存在' }
    }
    const requestedTradeDate = getBeijingYmd(now)
    const calendarState = isTradeDay(db, requestedTradeDate)
    const requestedTradingDay = calendarState ?? isWeekdayYmd(requestedTradeDate)
    const isFallback = version.tradeDate !== requestedTradeDate
    const displayContext: PremarketScenarioDisplayContext = {
      requestedTradeDate,
      displayTradeDate: version.tradeDate,
      isFallback,
      requestedTradingDay,
      fallbackReason: isFallback
        ? requestedTradingDay ? 'current_version_unavailable' : 'non_trading_day'
        : null,
    }
    return {
      ok: true,
      version: toView(version),
      revisions: listPremarketScenarioVersions(db, version.tradeDate, version.stage)
        .map(toPremarketScenarioRevisionSummary),
      displayContext,
      outcome: readPremarketOutcome(db, version, now),
      calibration: buildPremarketCalibration(db, now),
      explanation: getLatestPremarketAIExplanation(db, version.id),
    }
  } catch (error) {
    return {
      ok: false,
      code: 'SCENARIO_READ_FAILED',
      message: error instanceof Error ? error.message : '盘前推演修订读取失败',
    }
  }
}
