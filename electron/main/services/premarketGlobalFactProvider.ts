import { net } from 'electron'
import type {
  ExternalAssetObservation,
  ExternalAssetRegion,
  ExternalAssetRole,
  ExternalFactStatus,
  PremarketSourceRecord,
  PremarketStage,
} from './premarketScenarioTypes'

export const PREMARKET_GLOBAL_PROVIDER_ID = 'eastmoney-global-public-v1'

const ENDPOINT = 'https://push2delay.eastmoney.com/api/qt/ulist.np/get'
const FIELD_LIST = 'f12,f13,f14,f2,f3,f4,f17,f18,f124'
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_RETRY_COUNT = 1
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tradeWatching/1.0'

interface AssetDefinition {
  assetId: string
  securityId: string
  fallbackName: string
  region: ExternalAssetRegion
  role: ExternalAssetRole
  stages: readonly PremarketStage[]
  maxAgeMs: number
}

const HOUR_MS = 60 * 60 * 1000
const COMPLETED_US_SESSION_MAX_AGE_MS = 120 * HOUR_MS

export const PREMARKET_EXTERNAL_ASSETS: readonly AssetDefinition[] = [
  { assetId: 'us.dow', securityId: '100.DJIA', fallbackName: '道琼斯', region: 'us', role: 'risk_asset', stages: ['overnight', 'asia_open'], maxAgeMs: COMPLETED_US_SESSION_MAX_AGE_MS },
  { assetId: 'us.nasdaq', securityId: '100.NDX', fallbackName: '纳斯达克', region: 'us', role: 'risk_asset', stages: ['overnight', 'asia_open'], maxAgeMs: COMPLETED_US_SESSION_MAX_AGE_MS },
  { assetId: 'us.sp500', securityId: '100.SPX', fallbackName: '标普500', region: 'us', role: 'risk_asset', stages: ['overnight', 'asia_open'], maxAgeMs: COMPLETED_US_SESSION_MAX_AGE_MS },
  { assetId: 'asia.nikkei225', securityId: '100.N225', fallbackName: '日经225', region: 'asia', role: 'risk_asset', stages: ['asia_open'], maxAgeMs: 2 * HOUR_MS },
  { assetId: 'asia.kospi', securityId: '100.KS11', fallbackName: '韩国KOSPI', region: 'asia', role: 'risk_asset', stages: ['asia_open'], maxAgeMs: 2 * HOUR_MS },
  { assetId: 'china.a50_future', securityId: '104.CN00Y', fallbackName: 'A50期指当月连续', region: 'china_offshore', role: 'china_proxy', stages: ['overnight', 'asia_open'], maxAgeMs: 24 * HOUR_MS },
  { assetId: 'china.ftse_a50', securityId: '100.XIN9', fallbackName: '富时中国A50', region: 'china_offshore', role: 'china_proxy', stages: ['overnight', 'asia_open'], maxAgeMs: 24 * HOUR_MS },
  { assetId: 'fx.usdcnh', securityId: '133.USDCNH', fallbackName: '美元兑离岸人民币', region: 'china_offshore', role: 'currency', stages: ['overnight', 'asia_open'], maxAgeMs: 24 * HOUR_MS },
  { assetId: 'rates.us10y', securityId: '171.US10Y', fallbackName: '美国10年期国债收益率', region: 'us', role: 'rates', stages: ['overnight', 'asia_open'], maxAgeMs: COMPLETED_US_SESSION_MAX_AGE_MS },
  { assetId: 'volatility.vixy', securityId: '107.VIXY', fallbackName: 'VIX短期期货ETF', region: 'us', role: 'volatility_proxy', stages: ['overnight', 'asia_open'], maxAgeMs: COMPLETED_US_SESSION_MAX_AGE_MS },
  { assetId: 'commodity.copper', securityId: '101.HG00Y', fallbackName: 'COMEX铜', region: 'global', role: 'commodity', stages: ['overnight', 'asia_open'], maxAgeMs: 24 * HOUR_MS },
] as const

interface EastmoneyDiffItem {
  f2?: unknown
  f3?: unknown
  f12?: unknown
  f13?: unknown
  f14?: unknown
  f17?: unknown
  f18?: unknown
  f124?: unknown
}

interface EastmoneyResponse {
  data?: { diff?: EastmoneyDiffItem[] | null }
}

export interface PremarketFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type PremarketFetch = (
  url: string,
  init: RequestInit,
) => Promise<PremarketFetchResponse>

export interface PremarketExternalFactResult {
  providerId: typeof PREMARKET_GLOBAL_PROVIDER_ID
  status: ExternalFactStatus
  observations: ExternalAssetObservation[]
  source: PremarketSourceRecord
  warnings: string[]
}

export interface FetchPremarketExternalFactsOptions {
  stage: Extract<PremarketStage, 'overnight' | 'asia_open'>
  cutoffAt: number
  fetcher?: PremarketFetch
  now?: () => number
  timeoutMs?: number
  retryCount?: number
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function buildUrl(definitions: readonly AssetDefinition[]): string {
  const params = new URLSearchParams({
    secids: definitions.map((item) => item.securityId).join(','),
    fields: FIELD_LIST,
    fltt: '2',
    invt: '2',
  })
  return `${ENDPOINT}?${params.toString()}`
}

async function defaultFetch(url: string, init: RequestInit): Promise<PremarketFetchResponse> {
  return net.fetch(url, init) as Promise<PremarketFetchResponse>
}

async function requestJson(
  url: string,
  fetcher: PremarketFetch,
  timeoutMs: number,
): Promise<EastmoneyResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    })
    if (!response.ok) throw new Error(`HTTP_${response.status}`)
    return await response.json() as EastmoneyResponse
  } finally {
    clearTimeout(timer)
  }
}

async function requestWithRetry(
  url: string,
  fetcher: PremarketFetch,
  timeoutMs: number,
  retryCount: number,
): Promise<EastmoneyResponse> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      return await requestJson(url, fetcher, timeoutMs)
    } catch (error) {
      lastError = error
      if (attempt < retryCount) await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('NETWORK_ERROR')
}

function mapObservation(
  definition: AssetDefinition,
  item: EastmoneyDiffItem,
  cutoffAt: number,
  warnings: string[],
): ExternalAssetObservation | null {
  const latest = toFiniteNumber(item.f2)
  const open = toFiniteNumber(item.f17)
  const previousClose = toFiniteNumber(item.f18)
  const changePercent = toFiniteNumber(item.f3)
  const observedSeconds = toFiniteNumber(item.f124)
  if (latest === null || previousClose === null || changePercent === null || observedSeconds === null) {
    warnings.push(`OBSERVATION_FIELDS_MISSING:${definition.assetId}`)
    return null
  }
  const observedAt = Math.round(observedSeconds * 1000)
  if (observedAt > cutoffAt + FUTURE_TOLERANCE_MS) {
    warnings.push(`OBSERVATION_AFTER_CUTOFF:${definition.assetId}`)
    return null
  }
  if (cutoffAt - observedAt > definition.maxAgeMs) {
    warnings.push(`OBSERVATION_STALE:${definition.assetId}`)
    return null
  }
  return {
    assetId: definition.assetId,
    providerSecurityId: definition.securityId,
    name: toStringValue(item.f14) ?? definition.fallbackName,
    region: definition.region,
    role: definition.role,
    latest,
    open,
    previousClose,
    changePercent,
    observedAt,
  }
}

export async function fetchPremarketExternalFacts(
  options: FetchPremarketExternalFactsOptions,
): Promise<PremarketExternalFactResult> {
  const now = options.now ?? Date.now
  const attemptedAt = now()
  const definitions = PREMARKET_EXTERNAL_ASSETS.filter((item) => item.stages.includes(options.stage))
  const warnings: string[] = []
  const fetcher = options.fetcher ?? defaultFetch
  try {
    const payload = await requestWithRetry(
      buildUrl(definitions),
      fetcher,
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      options.retryCount ?? DEFAULT_RETRY_COUNT,
    )
    const rows = Array.isArray(payload.data?.diff) ? payload.data.diff : []
    const bySecurityId = new Map<string, EastmoneyDiffItem>()
    for (const row of rows) {
      const code = toStringValue(row.f12)
      const market = toFiniteNumber(row.f13)
      if (code && market !== null) bySecurityId.set(`${market}.${code}`, row)
    }
    const observations: ExternalAssetObservation[] = []
    for (const definition of definitions) {
      const row = bySecurityId.get(definition.securityId)
      if (!row) {
        warnings.push(`OBSERVATION_MISSING:${definition.assetId}`)
        continue
      }
      const observation = mapObservation(definition, row, options.cutoffAt, warnings)
      if (observation) observations.push(observation)
    }
    observations.sort((a, b) => a.assetId.localeCompare(b.assetId))
    const status: ExternalFactStatus = observations.length === definitions.length
      ? 'ready'
      : observations.length > 0
        ? 'partial'
        : 'blocked'
    const completedAt = now()
    return {
      providerId: PREMARKET_GLOBAL_PROVIDER_ID,
      status,
      observations,
      source: {
        sourceId: PREMARKET_GLOBAL_PROVIDER_ID,
        status,
        attemptedAt,
        completedAt,
        observationCount: observations.length,
        expectedCount: definitions.length,
        errorCode: observations.length === 0 ? 'NO_USABLE_OBSERVATIONS' : null,
      },
      warnings,
    }
  } catch (error) {
    const completedAt = now()
    const errorCode = error instanceof Error && /^HTTP_\d+$/.test(error.message)
      ? error.message
      : error instanceof Error && error.name === 'AbortError'
        ? 'REQUEST_TIMEOUT'
        : 'NETWORK_ERROR'
    return {
      providerId: PREMARKET_GLOBAL_PROVIDER_ID,
      status: 'failed',
      observations: [],
      source: {
        sourceId: PREMARKET_GLOBAL_PROVIDER_ID,
        status: 'failed',
        attemptedAt,
        completedAt,
        observationCount: 0,
        expectedCount: definitions.length,
        errorCode,
      },
      warnings: [errorCode],
    }
  }
}
