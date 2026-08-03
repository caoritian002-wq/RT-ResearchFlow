import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { getDataSourceConfig } from '../database/dataSourceRepository'
import {
  getPremarketFactSnapshot,
  savePremarketFactSnapshot,
  type SavedPremarketFactSnapshot,
} from '../database/premarketFactSnapshotRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { offsetYmd } from './marketSettlementPolicy'
import { getPremarketStageCutoffAt } from './premarketCutoffPolicy'
import { evaluateExternalRiskBreadth } from './premarketExternalRiskModel'
import { PREMARKET_FACT_RULE_VERSION } from './premarketSnapshotService'
import type {
  ExternalAssetObservation,
  ExternalAssetRegion,
  ExternalAssetRole,
  ExternalFactStatus,
  PremarketSourceRecord,
} from './premarketScenarioTypes'
import {
  fetchGlobalIndexDaily,
  type TushareGlobalIndexDailyRow,
} from './tushareService'

export const PREMARKET_GLOBAL_RECOVERY_PROVIDER_ID = 'premarket-global-recovery-v1'
export const TUSHARE_GLOBAL_INDEX_PROVIDER_ID = 'tushare-index-global-v1'
export const EASTMONEY_GLOBAL_HISTORY_PROVIDER_ID = 'eastmoney-global-history-v1'

const EASTMONEY_HISTORY_ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const RECOVERY_ASSET_COUNT = 7
const MINUTE_LOOKBACK_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000

interface RecoveryAssetDefinition {
  assetId: string
  tushareCode?: string
  securityId: string
  name: string
  region: ExternalAssetRegion
  role: ExternalAssetRole
  mode: 'previous_close' | 'cutoff_minute'
}

const RECOVERY_ASSETS: readonly RecoveryAssetDefinition[] = [
  { assetId: 'us.dow', tushareCode: 'DJI', securityId: '100.DJIA', name: '道琼斯', region: 'us', role: 'risk_asset', mode: 'previous_close' },
  { assetId: 'us.nasdaq', tushareCode: 'IXIC', securityId: '100.NDX', name: '纳斯达克', region: 'us', role: 'risk_asset', mode: 'previous_close' },
  { assetId: 'us.sp500', tushareCode: 'SPX', securityId: '100.SPX', name: '标普500', region: 'us', role: 'risk_asset', mode: 'previous_close' },
  { assetId: 'asia.nikkei225', securityId: '100.N225', name: '日经225', region: 'asia', role: 'risk_asset', mode: 'cutoff_minute' },
  { assetId: 'asia.kospi', securityId: '100.KS11', name: '韩国KOSPI', region: 'asia', role: 'risk_asset', mode: 'cutoff_minute' },
  { assetId: 'china.a50_future', securityId: '104.CN00Y', name: 'A50期指当月连续', region: 'china_offshore', role: 'china_proxy', mode: 'cutoff_minute' },
  { assetId: 'fx.usdcnh', securityId: '133.USDCNH', name: '美元兑离岸人民币', region: 'china_offshore', role: 'currency', mode: 'cutoff_minute' },
] as const

interface TushareDailyFetcher {
  (token: string, startDate: string, endDate: string): Promise<TushareGlobalIndexDailyRow[]>
}

export interface PremarketRecoveryFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type PremarketRecoveryFetch = (
  url: string,
  init: RequestInit,
) => Promise<PremarketRecoveryFetchResponse>

interface EastmoneyKlineResponse {
  rc?: number
  data?: {
    name?: string
    klines?: string[] | null
  } | null
}

export interface RecoverPremarketExternalOptions {
  token?: string | null
  tushareUnavailableCode?: 'TUSHARE_NOT_CONFIGURED' | 'TUSHARE_TOKEN_UNAVAILABLE'
  now?: number
  fetcher?: PremarketRecoveryFetch
  fetchTushareDaily?: TushareDailyFetcher
}

export interface PremarketExternalRecoveryResult {
  status: ExternalFactStatus
  observations: ExternalAssetObservation[]
  sources: PremarketSourceRecord[]
  warnings: string[]
}

export interface PremarketExternalRecoverySnapshotResult {
  status: 'completed' | 'partial' | 'unavailable' | 'failed'
  itemCount: number
  errorCode: string | null
  snapshot: SavedPremarketFactSnapshot['snapshot'] | null
  sources: PremarketSourceRecord[]
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function parseYmd(value: string): { year: number; month: number; day: number } | null {
  if (!/^\d{8}$/.test(value)) return null
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(4, 6)),
    day: Number(value.slice(6, 8)),
  }
}

function timeZoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  ) - at.getTime()
}

function usCloseAt(tradeDate: string): number | null {
  const date = parseYmd(tradeDate)
  if (!date) return null
  const localGuess = Date.UTC(date.year, date.month - 1, date.day, 16, 0, 0)
  const offset = timeZoneOffsetMs(new Date(localGuess), 'America/New_York')
  return localGuess - offset
}

function beijingMinuteAt(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`)
}

function observation(
  definition: RecoveryAssetDefinition,
  latest: number,
  open: number | null,
  previousClose: number,
  changePercent: number,
  observedAt: number,
): ExternalAssetObservation | null {
  if (
    !Number.isFinite(latest)
    || !Number.isFinite(previousClose)
    || previousClose <= 0
    || !Number.isFinite(changePercent)
    || !Number.isFinite(observedAt)
  ) return null
  return {
    assetId: definition.assetId,
    providerSecurityId: definition.securityId,
    name: definition.name,
    region: definition.region,
    role: definition.role,
    latest,
    open,
    previousClose,
    changePercent,
    observedAt,
  }
}

function latestTushareRow(
  rows: readonly TushareGlobalIndexDailyRow[],
  code: string,
  tradeDate: string,
): TushareGlobalIndexDailyRow | null {
  return rows
    .filter((row) => row.tsCode === code && row.tradeDate < tradeDate)
    .sort((left, right) => right.tradeDate.localeCompare(left.tradeDate))[0] ?? null
}

async function requestJson(url: string, fetcher: PremarketRecoveryFetch): Promise<EastmoneyKlineResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tradeWatching/1.0',
        Accept: 'application/json,text/plain,*/*',
      },
    })
    if (!response.ok) throw new Error(`HTTP_${response.status}`)
    return await response.json() as EastmoneyKlineResponse
  } finally {
    clearTimeout(timer)
  }
}

function buildKlineUrl(definition: RecoveryAssetDefinition, tradeDate: string): string {
  const url = new URL(EASTMONEY_HISTORY_ENDPOINT)
  url.searchParams.set('secid', definition.securityId)
  url.searchParams.set('klt', definition.mode === 'previous_close' ? '101' : '1')
  url.searchParams.set('fqt', '0')
  url.searchParams.set('beg', definition.mode === 'previous_close' ? offsetYmd(tradeDate, -10) : tradeDate)
  url.searchParams.set('end', tradeDate)
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60')
  url.searchParams.set('lmt', definition.mode === 'previous_close' ? '20' : '1000')
  return url.toString()
}

async function fetchEastmoneyObservation(
  definition: RecoveryAssetDefinition,
  tradeDate: string,
  cutoffAt: number,
  fetcher: PremarketRecoveryFetch,
): Promise<ExternalAssetObservation | null> {
  const payload = await requestJson(buildKlineUrl(definition, tradeDate), fetcher)
  if (payload.rc !== 0 || !Array.isArray(payload.data?.klines)) return null
  if (definition.mode === 'previous_close') {
    const row = payload.data.klines
      .map((item) => item.split(','))
      .filter((parts) => /^\d{4}-\d{2}-\d{2}$/.test(parts[0] ?? ''))
      .map((parts) => ({ parts, tradeDate: (parts[0] ?? '').replace(/-/g, '') }))
      .filter((item) => item.tradeDate < tradeDate)
      .sort((left, right) => right.tradeDate.localeCompare(left.tradeDate))[0]
    if (!row) return null
    const latest = finite(row.parts[2])
    const open = finite(row.parts[1])
    const changePercent = finite(row.parts[8])
    const observedAt = usCloseAt(row.tradeDate)
    if (latest === null || changePercent === null || observedAt === null || observedAt > cutoffAt) return null
    const previousClose = latest / (1 + changePercent / 100)
    return observation(definition, latest, open, previousClose, changePercent, observedAt)
  }
  const selected = payload.data.klines
    .map((item) => item.split(','))
    .map((parts) => ({ parts, observedAt: beijingMinuteAt(parts[0] ?? '') }))
    .filter((item): item is { parts: string[]; observedAt: number } => item.observedAt != null)
    .filter((item) => item.observedAt <= cutoffAt && cutoffAt - item.observedAt <= MINUTE_LOOKBACK_MS)
    .sort((left, right) => right.observedAt - left.observedAt)[0]
  if (!selected) return null
  const latest = finite(selected.parts[2])
  const open = finite(selected.parts[1])
  const changePercent = finite(selected.parts[8])
  if (latest === null || changePercent === null) return null
  const previousClose = latest / (1 + changePercent / 100)
  return observation(definition, latest, open, previousClose, changePercent, selected.observedAt)
}

function sourceRecord(
  sourceId: string,
  attemptedAt: number,
  completedAt: number,
  count: number,
  expectedCount: number,
  errorCode: string | null,
): PremarketSourceRecord {
  const status: ExternalFactStatus = count === expectedCount
    ? 'ready'
    : count > 0 ? 'partial' : errorCode ? 'failed' : 'blocked'
  return { sourceId, status, attemptedAt, completedAt, observationCount: count, expectedCount, errorCode }
}

export async function recoverPremarketExternalFacts(
  tradeDate: string,
  cutoffAt: number,
  options: RecoverPremarketExternalOptions = {},
): Promise<PremarketExternalRecoveryResult> {
  const now = options.now ?? Date.now()
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init) as Promise<PremarketRecoveryFetchResponse>)
  const tushareFetcher = options.fetchTushareDaily ?? fetchGlobalIndexDaily
  const observations = new Map<string, ExternalAssetObservation>()
  const sources: PremarketSourceRecord[] = []
  const warnings: string[] = []

  const usDefinitions = RECOVERY_ASSETS.filter((item) => item.tushareCode)
  if (options.token) {
    const attemptedAt = now
    try {
      const rows = await tushareFetcher(options.token, offsetYmd(tradeDate, -10), tradeDate)
      for (const definition of usDefinitions) {
        const row = latestTushareRow(rows, definition.tushareCode!, tradeDate)
        const observedAt = row ? usCloseAt(row.tradeDate) : null
        const item = row && observedAt !== null && observedAt <= cutoffAt
          ? observation(definition, row.close, row.open, row.previousClose, row.changePercent, observedAt)
          : null
        if (item) observations.set(item.assetId, item)
      }
      const count = usDefinitions.filter((item) => observations.has(item.assetId)).length
      sources.push(sourceRecord(
        TUSHARE_GLOBAL_INDEX_PROVIDER_ID,
        attemptedAt,
        now,
        count,
        usDefinitions.length,
        count === 0 ? 'TUSHARE_GLOBAL_EMPTY' : null,
      ))
      if (count < usDefinitions.length) warnings.push('TUSHARE_GLOBAL_PARTIAL')
    } catch (error) {
      const quota = error instanceof Error && error.message === 'TUSHARE_QUOTA_INSUFFICIENT'
      sources.push(sourceRecord(
        TUSHARE_GLOBAL_INDEX_PROVIDER_ID,
        attemptedAt,
        now,
        0,
        usDefinitions.length,
        quota ? 'TUSHARE_QUOTA_INSUFFICIENT' : 'TUSHARE_GLOBAL_FAILED',
      ))
      warnings.push(quota ? 'TUSHARE_QUOTA_INSUFFICIENT' : 'TUSHARE_GLOBAL_FAILED')
    }
  } else {
    const errorCode = options.tushareUnavailableCode ?? 'TUSHARE_NOT_CONFIGURED'
    sources.push({
      sourceId: TUSHARE_GLOBAL_INDEX_PROVIDER_ID,
      status: 'blocked',
      attemptedAt: now,
      completedAt: now,
      observationCount: 0,
      expectedCount: usDefinitions.length,
      errorCode,
    })
    warnings.push(errorCode)
  }

  const publicTargets = RECOVERY_ASSETS.filter((item) => !observations.has(item.assetId))
  const attemptedAt = now
  const settled = await Promise.all(publicTargets.map(async (definition) => {
    try {
      return {
        definition,
        item: await fetchEastmoneyObservation(definition, tradeDate, cutoffAt, fetcher),
      }
    } catch {
      return { definition, item: null }
    }
  }))
  let publicCount = 0
  for (const result of settled) {
    if (result.item) {
      observations.set(result.item.assetId, result.item)
      publicCount += 1
    } else {
      warnings.push(`EASTMONEY_HISTORY_MISSING:${result.definition.assetId}`)
    }
  }
  sources.push(sourceRecord(
    EASTMONEY_GLOBAL_HISTORY_PROVIDER_ID,
    attemptedAt,
    now,
    publicCount,
    publicTargets.length,
    publicCount === 0 && publicTargets.length > 0 ? 'EASTMONEY_HISTORY_EMPTY' : null,
  ))

  const ordered = [...observations.values()].sort((left, right) => left.assetId.localeCompare(right.assetId))
  const externalRisk = evaluateExternalRiskBreadth(ordered)
  const status: ExternalFactStatus = ordered.length === RECOVERY_ASSET_COUNT
    ? 'ready'
    : externalRisk.tone !== 'insufficient'
      ? 'partial'
      : ordered.length > 0 ? 'partial' : 'blocked'
  if (externalRisk.tone === 'insufficient') warnings.push('EXTERNAL_RISK_COVERAGE_INSUFFICIENT')
  return { status, observations: ordered, sources, warnings: [...new Set(warnings)] }
}

export async function recoverPremarketExternalSnapshot(
  db: Database.Database,
  tradeDate: string,
  options: RecoverPremarketExternalOptions = {},
): Promise<PremarketExternalRecoverySnapshotResult> {
  const requestedAt = options.now ?? Date.now()
  const cutoffAt = getPremarketStageCutoffAt(tradeDate, 'asia_open')
  const config = getDataSourceConfig(db)
  const token = options.token !== undefined
    ? options.token
    : config.tushareEnabled && config.tushareTokenEncrypted
      ? decryptApiKey(config.tushareTokenEncrypted)
      : null
  const tushareUnavailableCode = options.tushareUnavailableCode
    ?? (options.token === undefined && config.tushareEnabled && config.tushareTokenEncrypted && !token
      ? 'TUSHARE_TOKEN_UNAVAILABLE'
      : 'TUSHARE_NOT_CONFIGURED')
  const result = await recoverPremarketExternalFacts(tradeDate, cutoffAt, {
    ...options,
    token,
    tushareUnavailableCode,
  })
  const externalRisk = evaluateExternalRiskBreadth(result.observations)
  const existing = getPremarketFactSnapshot(db, tradeDate, 'asia_open', PREMARKET_FACT_RULE_VERSION)
  const usable = externalRisk.tone !== 'insufficient'
  if (!usable && existing && existing.facts.externalRisk.tone !== 'insufficient') {
    return {
      status: result.observations.length > 0 ? 'partial' : 'failed',
      itemCount: result.observations.length,
      errorCode: 'EXTERNAL_RECOVERY_INSUFFICIENT',
      snapshot: existing,
      sources: result.sources,
    }
  }
  const snapshot = savePremarketFactSnapshot(db, {
    id: randomUUID(),
    tradeDate,
    stage: 'asia_open',
    status: result.status,
    ruleVersion: PREMARKET_FACT_RULE_VERSION,
    appendRevision: existing != null,
    revisionKind: 'manual_backfill',
    requestedAt,
    cutoffAt,
    capturedAt: requestedAt,
    providerId: PREMARKET_GLOBAL_RECOVERY_PROVIDER_ID,
    facts: {
      schemaVersion: 1,
      tradeDate,
      stage: 'asia_open',
      cutoffAt,
      observations: result.observations,
      externalRisk,
    },
    sources: result.sources,
    warnings: [...new Set([...result.warnings, ...externalRisk.warnings])],
    createdAt: requestedAt,
  }).snapshot
  return {
    status: usable ? snapshot.status === 'ready' ? 'completed' : 'partial' : 'failed',
    itemCount: result.observations.length,
    errorCode: usable ? null : 'EXTERNAL_RECOVERY_INSUFFICIENT',
    snapshot,
    sources: result.sources,
  }
}
