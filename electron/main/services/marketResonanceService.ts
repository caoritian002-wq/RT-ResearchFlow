import { net } from 'electron'
import type Database from 'better-sqlite3'
import {
  getMarketResonanceSnapshotRecord,
  saveMarketResonanceSnapshot,
} from '../database/marketResonanceSnapshotRepository'
import {
  SHENWAN_L1_INDUSTRIES,
  SHENWAN_L2_TO_L1_NAME,
} from './eastmoneyIndustryHierarchy'
import {
  buildMarketIndustryStructure,
  getShenwanL2Names,
  isMarketIndustryStructure,
  type MarketIndustryStructure,
} from './marketResonanceIndustryModel'
import {
  calculateMarketResonance,
  type MarketBenchmarkKey,
  type MarketResonanceMetric,
  type MarketTrendPoint,
  type MarketTrendSeries,
} from './marketResonanceModel'

export type MarketResonanceDataMode = 'realtime' | 'archive' | 'partial'

export interface MarketResonanceBenchmark extends MarketTrendSeries {
  key: MarketBenchmarkKey
}

export interface MarketResonanceSector extends MarketTrendSeries {
  boardCode: string
  breadthRate: number | null
  upCount: number | null
  downCount: number | null
  flatCount: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
  structure: MarketIndustryStructure
  metrics: Record<MarketBenchmarkKey, MarketResonanceMetric>
}

export interface MarketResonanceSnapshot {
  tradeDate: string
  recoverableTradeDates: string[]
  dataMode: MarketResonanceDataMode
  sourceMode: 'realtime' | 'local_archive' | 'network_backfill'
  sourceLabel: string
  generatedAt: number
  coverage: {
    available: number
    total: number
    benchmarkTrends: { available: number; total: number }
    sectorTrends: { available: number; total: number }
    boardFacts: { available: number; total: number }
  }
  benchmarks: MarketResonanceBenchmark[]
  sectors: MarketResonanceSector[]
}

interface EastmoneyTrendResponse {
  data?: {
    code?: string
    name?: string
    preClose?: number | string
    trends?: string[] | null
  } | null
}

interface EastmoneyBoardResponse {
  data?: {
    total?: number
    diff?: Array<Record<string, unknown>> | null
  } | null
}

interface FetchedTrendSeries {
  series: MarketTrendSeries
  availableTradeDates: string[]
}

export interface MarketResonanceBoardFact {
  boardCode: string
  name: string
  weightedChange: number
  upCount: number | null
  downCount: number | null
  flatCount: number | null
  breadthRate: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
}

const BENCHMARKS: ReadonlyArray<{ key: MarketBenchmarkKey; secid: string; name: string }> = [
  { key: 'shanghai', secid: '1.000001', name: '上证指数' },
  { key: 'csi300', secid: '1.000300', name: '沪深300' },
  { key: 'chinext', secid: '0.399006', name: '创业板指' },
]
const CACHE_TTL_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000
const TREND_FIELDS_1 = 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13'
const TREND_FIELDS_2 = 'f51,f52,f53,f54,f55,f56,f57,f58'
const BOARD_FIELDS = 'f3,f12,f14,f62,f184,f104,f105,f106'
const EASTMONEY_UT = 'fa5fd1943c7b386f172d6893dbfba10b'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36'
const MAX_TREND_DAYS = 5

const cached = new Map<string, { snapshot: MarketResonanceSnapshot; cachedAt: number }>()
const inflight = new Map<string, Promise<MarketResonanceSnapshot>>()
let currentBoardFactsCache: { facts: Map<string, MarketResonanceBoardFact>; cachedAt: number } | null = null

export interface MarketResonanceSnapshotRequest {
  tradeDate?: string | null
  forceRefresh?: boolean
}

export async function getMarketResonanceSnapshot(
  db: Database.Database,
  request: MarketResonanceSnapshotRequest = {},
): Promise<MarketResonanceSnapshot> {
  const requestedTradeDate = normalizeTradeDate(request.tradeDate)
  const forceRefresh = request.forceRefresh === true
  const tradeDate = requestedTradeDate ?? (
    isTradingWindow() ? null : resolveLatestLocalTradeDate(db)
  )
  const cacheKey = tradeDate ?? 'latest'
  if (tradeDate && !isLiveTradeDate(tradeDate) && !forceRefresh) {
    const archived = readArchivedSnapshot(db, tradeDate)
    if (archived) return archived
  }
  const cacheEntry = cached.get(cacheKey)
  if (!forceRefresh && cacheEntry && Date.now() - cacheEntry.cachedAt < CACHE_TTL_MS) return cacheEntry.snapshot
  const inflightKey = `${cacheKey}:${forceRefresh ? 'refresh' : 'read'}`
  let activeRequest = inflight.get(inflightKey)
  if (activeRequest) return activeRequest
  if (forceRefresh) {
    const pendingRead = inflight.get(`${cacheKey}:read`)
    if (pendingRead) {
      try {
        await pendingRead
      } catch {
        // A failed ordinary read does not prevent the explicit recovery attempt.
      }
      activeRequest = inflight.get(inflightKey)
      if (activeRequest) return activeRequest
    }
  }
  const promise = buildSnapshot(db, tradeDate)
    .then((snapshot) => {
      const resolved = snapshot.sourceMode === 'realtime'
        ? snapshot
        : persistArchivedSnapshot(db, snapshot)
      cached.set(cacheKey, { snapshot: resolved, cachedAt: Date.now() })
      return resolved
    })
    .finally(() => {
      inflight.delete(inflightKey)
    })
  inflight.set(inflightKey, promise)
  return promise
}

function resolveLatestLocalTradeDate(db: Database.Database): string | null {
  const dates: string[] = []
  for (const table of [
    'market_resonance_daily_snapshots',
    'sector_flow_observations',
    'daily_close_cache',
    'market_timeline_daily',
  ]) {
    try {
      const row = db.prepare(`SELECT MAX(trade_date) AS trade_date FROM ${table}`).get() as {
        trade_date: string | null
      }
      if (row.trade_date && /^\d{8}$/.test(row.trade_date) && row.trade_date <= bjYmd()) {
        dates.push(row.trade_date)
      }
    } catch {
      // Isolated service tests may only create the FR-261 tables.
    }
  }
  return dates.sort((left, right) => right.localeCompare(left))[0] ?? null
}

export async function archiveMarketResonanceSnapshot(
  db: Database.Database,
  tradeDate: string,
): Promise<MarketResonanceSnapshot> {
  return getMarketResonanceSnapshot(db, { tradeDate, forceRefresh: true })
}

async function buildSnapshot(
  db: Database.Database,
  requestedTradeDate: string | null,
): Promise<MarketResonanceSnapshot> {
  const trendRequests = [
    ...BENCHMARKS.map((benchmark) => ({
      kind: 'benchmark' as const,
      key: benchmark.key,
      code: benchmark.secid,
      name: benchmark.name,
      secid: benchmark.secid,
      trendDays: requestedTradeDate || benchmark.key === 'shanghai' ? MAX_TREND_DAYS : 1,
    })),
    ...SHENWAN_L1_INDUSTRIES.map((sector) => ({
      kind: 'sector' as const,
      code: sector.code,
      name: sector.name,
      secid: `90.${sector.code}`,
      trendDays: requestedTradeDate ? MAX_TREND_DAYS : 1,
    })),
  ]
  const runTrendRequest = async (request: typeof trendRequests[number]) => ({
    request,
      fetched: await fetchMarketTrendSeries(
      request.secid,
      request.code,
      request.name,
      requestedTradeDate,
      request.trendDays,
    ),
  })
  let settled: Array<PromiseSettledResult<Awaited<ReturnType<typeof runTrendRequest>>>>
  if (requestedTradeDate) {
    // Avoid multiplying a missing historical window across every benchmark and sector.
    const [probeRequest, ...remainingRequests] = trendRequests
    let probeResult: PromiseSettledResult<Awaited<ReturnType<typeof runTrendRequest>>>
    try {
      probeResult = { status: 'fulfilled', value: await runTrendRequest(probeRequest) }
    } catch (reason) {
      probeResult = { status: 'rejected', reason }
    }
    const remainingResults = probeResult.status === 'fulfilled'
      ? await mapWithConcurrency(remainingRequests, 6, runTrendRequest)
      : []
    settled = [probeResult, ...remainingResults]
  } else {
    settled = await mapWithConcurrency(trendRequests, 6, runTrendRequest)
  }
  const allBenchmarks: MarketResonanceBenchmark[] = []
  const allSectorSeries: Array<{ boardCode: string; series: MarketTrendSeries }> = []
  const recoverableBenchmarkDates = new Map<string, number>()
  const recoverableSectorDates = new Map<string, number>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    const { request, fetched } = result.value
    const { series } = fetched
    const dateCoverage = request.kind === 'benchmark' ? recoverableBenchmarkDates : recoverableSectorDates
    for (const date of fetched.availableTradeDates) {
      dateCoverage.set(date, (dateCoverage.get(date) ?? 0) + 1)
    }
    if (request.kind === 'benchmark') allBenchmarks.push({ ...series, key: request.key })
    else allSectorSeries.push({ boardCode: request.code, series })
  }
  const recoverableTradeDates = [...new Set([
    ...recoverableBenchmarkDates.keys(),
    ...recoverableSectorDates.keys(),
  ])]
    .filter((date) => (
      (recoverableBenchmarkDates.get(date) ?? 0) >= 1
      && (!requestedTradeDate || (recoverableSectorDates.get(date) ?? 0) >= 10)
    ))
    .sort()
  const tradeDate = requestedTradeDate ?? mostCommonTradeDate([
    ...allBenchmarks.map((item) => item.tradeDate),
    ...allSectorSeries.map((item) => item.series.tradeDate),
  ])
  const benchmarks = allBenchmarks.filter((item) => item.tradeDate === tradeDate)
  const sectorSeries = allSectorSeries.filter((item) => item.series.tradeDate === tradeDate)
  if (benchmarks.length < BENCHMARKS.length || sectorSeries.length < SHENWAN_L1_INDUSTRIES.length) {
    const rejected = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .reduce<Record<string, number>>((summary, result) => {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
        summary[reason] = (summary[reason] ?? 0) + 1
        return summary
      }, {})
    console.warn('[MarketResonance] partial trend coverage', {
      benchmarks: benchmarks.length,
      sectors: sectorSeries.length,
      rejected,
    })
  }
  const archivedFacts = readMarketIndustryBoardFacts(db, tradeDate)
  const useCurrentFacts = archivedFacts.size === 0 && tradeDate === bjYmd()
  const allFacts = archivedFacts.size > 0
    ? archivedFacts
    : useCurrentFacts
      ? await fetchCurrentMarketIndustryBoardFacts().catch(() => new Map<string, MarketResonanceBoardFact>())
      : new Map<string, MarketResonanceBoardFact>()
  const facts = selectL1Facts(allFacts)
  if (benchmarks.length === 0 && sectorSeries.length < 10 && facts.size < 10) {
    throw new Error('MARKET_RESONANCE_INSUFFICIENT')
  }
  const fetchedBenchmarkByKey = new Map(benchmarks.map((benchmark) => [benchmark.key, benchmark]))
  const displayBenchmarkByKey = new Map(BENCHMARKS.map((definition) => {
    const fetched = fetchedBenchmarkByKey.get(definition.key)
    return [definition.key, fetched ?? placeholderBenchmark(definition, tradeDate)] as const
  }))
  const sectorSeriesByCode = new Map(sectorSeries.map((item) => [item.boardCode, item.series]))
  const sectors = SHENWAN_L1_INDUSTRIES.flatMap((definition): MarketResonanceSector[] => {
    const fact = facts.get(definition.code)
    const series = sectorSeriesByCode.get(definition.code)
      ?? (fact ? placeholderSector(definition.code, fact.name || definition.name, tradeDate, fact.weightedChange) : null)
    if (!series) return []
    const boardCode = definition.code
    const breadthRate = fact?.breadthRate ?? null
    const metrics = Object.fromEntries(BENCHMARKS.map(({ key }) => {
      const benchmark = fetchedBenchmarkByKey.get(key)
      return [key, benchmark
        ? calculateMarketResonance(benchmark, series, breadthRate)
        : unavailableMetric(series.change)]
    })) as Record<MarketBenchmarkKey, MarketResonanceMetric>
    return [{
      ...series,
      boardCode,
      name: fact?.name || series.name,
      breadthRate,
      upCount: fact?.upCount ?? null,
      downCount: fact?.downCount ?? null,
      flatCount: fact?.flatCount ?? null,
      mainNetInflow: fact?.mainNetInflow ?? null,
      mainNetInflowRate: fact?.mainNetInflowRate ?? null,
      structure: buildMarketIndustryStructure(
        definition.name,
        fact?.weightedChange ?? series.change,
        getChildFacts(allFacts, definition.name),
      ),
      metrics,
    }]
  })
  const boardFactsAvailable = sectors.filter((sector) => facts.has(sector.boardCode)).length
  const benchmarkTrendsAvailable = benchmarks.length
  const sectorTrendsAvailable = sectorSeries.length
  const partial = benchmarkTrendsAvailable < BENCHMARKS.length
    || sectorTrendsAvailable < SHENWAN_L1_INDUSTRIES.length
    || boardFactsAvailable < SHENWAN_L1_INDUSTRIES.length
  const live = tradeDate === bjYmd() && isTradingWindow()
  const dataMode: MarketResonanceDataMode = partial
    ? 'partial'
    : live
      ? 'realtime'
      : 'archive'
  const sourceMode: MarketResonanceSnapshot['sourceMode'] = live
    ? 'realtime'
    : 'network_backfill'
  const sourceLabel = archivedFacts.size > 0
    ? benchmarks.length > 0 && sectorSeries.length >= 10
      ? '东方财富历史分钟行情与本地板块资金存档'
      : '本地板块资金存档；历史分钟曲线暂不可恢复'
    : useCurrentFacts
      ? '东方财富指数、申万一级行业一分钟行情与当前板块截面'
      : '东方财富历史分钟行情；板块截面未存档'
  const fullyCovered = benchmarkTrendsAvailable === BENCHMARKS.length
    ? Math.min(sectorTrendsAvailable, boardFactsAvailable)
    : 0
  return {
    tradeDate,
    recoverableTradeDates,
    dataMode,
    sourceMode,
    sourceLabel,
    generatedAt: Date.now(),
    coverage: {
      available: fullyCovered,
      total: SHENWAN_L1_INDUSTRIES.length,
      benchmarkTrends: { available: benchmarkTrendsAvailable, total: BENCHMARKS.length },
      sectorTrends: { available: sectorTrendsAvailable, total: SHENWAN_L1_INDUSTRIES.length },
      boardFacts: { available: boardFactsAvailable, total: SHENWAN_L1_INDUSTRIES.length },
    },
    benchmarks: BENCHMARKS.map(({ key }) => displayBenchmarkByKey.get(key) as MarketResonanceBenchmark),
    sectors,
  }
}

export async function fetchMarketTrendSeries(
  secid: string,
  code: string,
  fallbackName: string,
  requestedTradeDate: string | null,
  ndays: number,
): Promise<FetchedTrendSeries> {
  let response: EastmoneyTrendResponse | null = null
  let lastError: unknown = null
  for (const host of eastmoneyHosts(ndays)) {
    const url = new URL(`https://${host}/api/qt/stock/trends2/get`)
    url.searchParams.set('secid', secid)
    url.searchParams.set('fields1', TREND_FIELDS_1)
    url.searchParams.set('fields2', TREND_FIELDS_2)
    url.searchParams.set('ut', EASTMONEY_UT)
    url.searchParams.set('iscr', '0')
    url.searchParams.set('ndays', String(ndays))
    url.searchParams.set('_', String(Date.now()))
    try {
      response = await fetchJson<EastmoneyTrendResponse>(url.toString())
      const trends = response.data?.trends ?? []
      if (!trends.length) continue
      if (requestedTradeDate && !containsTradeDate(trends, requestedTradeDate)) {
        lastError = new Error('EASTMONEY_TREND_DATE_UNAVAILABLE')
        continue
      }
      if (!requestedTradeDate && ndays > 1 && countTrendDates(trends) < 2) {
        lastError = new Error('EASTMONEY_TREND_HISTORY_UNAVAILABLE')
        continue
      }
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!response?.data?.trends?.length) throw lastError instanceof Error ? lastError : new Error('EASTMONEY_TREND_EMPTY')
  const responsePreClose = finiteNumber(response.data?.preClose)
  const rawTrends = response.data?.trends ?? []
  if (rawTrends.length < MIN_TREND_POINTS) throw new Error('EASTMONEY_TREND_EMPTY')
  const grouped = new Map<string, Array<{ time: string; price: number }>>()
  for (const raw of rawTrends) {
    const parts = raw.split(',')
    if (parts.length < 2) continue
    const [datePart, timePart] = parts[0].trim().split(/\s+/)
    const price = finiteNumber(parts[1])
    if (!datePart || !/^\d{2}:\d{2}$/.test(timePart ?? '') || price == null || price <= 0) continue
    const tradeDate = datePart.replace(/-/g, '')
    const bucket = grouped.get(tradeDate) ?? []
    bucket.push({ time: timePart, price })
    grouped.set(tradeDate, bucket)
  }
  const dates = [...grouped.keys()].sort()
  const tradeDate = requestedTradeDate ?? dates.at(-1) ?? ''
  const selected = grouped.get(tradeDate) ?? []
  const selectedIndex = dates.indexOf(tradeDate)
  const previousDate = selectedIndex > 0 ? dates[selectedIndex - 1] : null
  const previousClose = previousDate
    ? grouped.get(previousDate)?.at(-1)?.price ?? null
    : responsePreClose
  if (!tradeDate || selected.length < MIN_TREND_POINTS || previousClose == null || previousClose <= 0) {
    throw new Error(requestedTradeDate ? 'EASTMONEY_TREND_DATE_UNAVAILABLE' : 'EASTMONEY_TREND_INVALID')
  }
  const points: MarketTrendPoint[] = selected.map((point) => ({
    time: point.time,
    change: round((point.price / previousClose - 1) * 100, 4),
  }))
  return {
    availableTradeDates: dates,
    series: {
      code,
      name: textValue(response.data?.name) || fallbackName,
      tradeDate,
      change: points.at(-1)?.change ?? 0,
      points,
    },
  }
}

export function readMarketIndustryBoardFacts(
  db: Database.Database,
  tradeDate: string,
): Map<string, MarketResonanceBoardFact> {
  const rows = db.prepare(`
    SELECT board_code, board_name, weighted_change, up_count, down_count, flat_count,
           main_net_inflow, main_net_inflow_rate
    FROM sector_flow_observations
    WHERE trade_date = ?
      AND provider = 'eastmoney'
      AND scope = 'industry'
      AND metric_kind = 'verified_flow'
  `).all(tradeDate) as Array<{
    board_code: string
    board_name: string
    weighted_change: number
    up_count: number
    down_count: number
    flat_count: number
    main_net_inflow: number | null
    main_net_inflow_rate: number | null
  }>
  const l1Codes = new Set(SHENWAN_L1_INDUSTRIES.map((industry) => industry.code))
  const facts = new Map<string, MarketResonanceBoardFact>()
  for (const row of rows) {
    if (!l1Codes.has(row.board_code) && !SHENWAN_L2_TO_L1_NAME[row.board_name]) continue
    const memberCount = row.up_count + row.down_count + row.flat_count
    facts.set(row.board_code, {
      boardCode: row.board_code,
      name: row.board_name,
      weightedChange: row.weighted_change,
      upCount: row.up_count,
      downCount: row.down_count,
      flatCount: row.flat_count,
      breadthRate: memberCount > 0 ? row.up_count / memberCount : null,
      mainNetInflow: row.main_net_inflow,
      mainNetInflowRate: row.main_net_inflow_rate,
    })
  }
  return facts
}

function persistArchivedSnapshot(
  db: Database.Database,
  snapshot: MarketResonanceSnapshot,
): MarketResonanceSnapshot {
  const dataMode: 'archive' | 'partial' = snapshot.dataMode === 'partial' ? 'partial' : 'archive'
  const archived: MarketResonanceSnapshot = {
    ...snapshot,
    dataMode,
    sourceMode: 'network_backfill',
  }
  const snapshotJson = JSON.stringify(archived)
  const record = saveMarketResonanceSnapshot(db, {
    tradeDate: archived.tradeDate,
    dataMode,
    sourceLabel: archived.sourceLabel,
    coverageAvailable: archived.coverage.available,
    coverageTotal: archived.coverage.total,
    snapshotJson,
    capturedAt: archived.generatedAt,
  })
  return record.snapshotJson === snapshotJson
    ? archived
    : projectArchivedRecord(record, archived.tradeDate, readMarketIndustryBoardFacts(db, archived.tradeDate))
}

function readArchivedSnapshot(db: Database.Database, tradeDate: string): MarketResonanceSnapshot | null {
  const record = getMarketResonanceSnapshotRecord(db, tradeDate)
  if (!record) return null
  return projectArchivedRecord(record, tradeDate, readMarketIndustryBoardFacts(db, tradeDate))
}

function projectArchivedRecord(
  record: NonNullable<ReturnType<typeof getMarketResonanceSnapshotRecord>>,
  tradeDate: string,
  facts: Map<string, MarketResonanceBoardFact> = new Map(),
): MarketResonanceSnapshot {
  try {
    const snapshot = JSON.parse(record.snapshotJson) as Partial<MarketResonanceSnapshot>
    if (
      snapshot.tradeDate !== tradeDate
      || !Array.isArray(snapshot.benchmarks)
      || !Array.isArray(snapshot.sectors)
      || snapshot.benchmarks.length === 0
      || snapshot.sectors.length < 10
      || snapshot.benchmarks.some((item) => item?.tradeDate !== tradeDate)
      || snapshot.sectors.some((item) => item?.tradeDate !== tradeDate)
    ) {
      throw new Error('MARKET_RESONANCE_ARCHIVE_CORRUPTED')
    }
    const benchmarkTrendsAvailable = snapshot.benchmarks.length
    const sectorTrendsAvailable = snapshot.sectors.length
    const boardFactsAvailable = snapshot.sectors.filter((item) => (
      item.upCount != null || item.downCount != null || item.flatCount != null
    )).length
    const sectors = snapshot.sectors.map((sector) => {
      const derived = buildMarketIndustryStructure(
        sector.name,
        sector.change,
        getChildFacts(facts, sector.name),
      )
      return {
        ...sector,
        structure: derived.available > 0 || !isMarketIndustryStructure(sector.structure)
          ? derived
          : sector.structure,
      }
    })
    return {
      ...snapshot,
      tradeDate,
      recoverableTradeDates: Array.isArray(snapshot.recoverableTradeDates)
        ? snapshot.recoverableTradeDates.filter((date): date is string => typeof date === 'string' && /^\d{8}$/.test(date))
        : [tradeDate],
      dataMode: record.dataMode,
      sourceMode: 'local_archive',
      sourceLabel: `${record.sourceLabel} · 本地存档`,
      generatedAt: record.capturedAt,
      sectors,
      coverage: {
        available: record.coverageAvailable,
        total: record.coverageTotal,
        benchmarkTrends: snapshot.coverage?.benchmarkTrends ?? {
          available: benchmarkTrendsAvailable,
          total: BENCHMARKS.length,
        },
        sectorTrends: snapshot.coverage?.sectorTrends ?? {
          available: sectorTrendsAvailable,
          total: SHENWAN_L1_INDUSTRIES.length,
        },
        boardFacts: snapshot.coverage?.boardFacts ?? {
          available: boardFactsAvailable,
          total: SHENWAN_L1_INDUSTRIES.length,
        },
      },
    } as MarketResonanceSnapshot
  } catch (error) {
    if (error instanceof Error && error.message === 'MARKET_RESONANCE_ARCHIVE_CORRUPTED') throw error
    throw new Error('MARKET_RESONANCE_ARCHIVE_CORRUPTED')
  }
}

function normalizeTradeDate(value: string | null | undefined): string | null {
  if (value == null || value === '') return null
  if (!isValidCompactDate(value)) throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  if (value > bjYmd()) throw new Error('INVALID_MARKET_OVERVIEW_REQUEST')
  return value
}

function isLiveTradeDate(tradeDate: string): boolean {
  return tradeDate === bjYmd() && isTradingWindow()
}

const MIN_TREND_POINTS = 30

export async function fetchCurrentMarketIndustryBoardFacts(): Promise<Map<string, MarketResonanceBoardFact>> {
  if (currentBoardFactsCache && Date.now() - currentBoardFactsCache.cachedAt < CACHE_TTL_MS) {
    return currentBoardFactsCache.facts
  }
  let lastError: unknown = null
  for (const host of eastmoneyHosts()) {
    try {
      const facts = await fetchIndustryBoardFactsFromHost(host)
      currentBoardFactsCache = { facts, cachedAt: Date.now() }
      return facts
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('EASTMONEY_BOARD_EMPTY')
}

async function fetchIndustryBoardFactsFromHost(host: string): Promise<Map<string, MarketResonanceBoardFact>> {
  const facts = new Map<string, MarketResonanceBoardFact>()
  let page = 1
  let total = 1
  while ((page - 1) * 200 < total && page <= 4) {
    const url = new URL(`https://${host}/api/qt/clist/get`)
    url.searchParams.set('fs', 'm:90+t:2')
    url.searchParams.set('fields', BOARD_FIELDS)
    url.searchParams.set('pn', String(page))
    url.searchParams.set('pz', '200')
    url.searchParams.set('po', '1')
    url.searchParams.set('np', '1')
    url.searchParams.set('fltt', '2')
    url.searchParams.set('invt', '2')
    url.searchParams.set('fid', 'f62')
    url.searchParams.set('_', String(Date.now()))
    const response = await fetchJson<EastmoneyBoardResponse>(url.toString())
    total = Math.max(0, Math.trunc(finiteNumber(response.data?.total) ?? 0))
    for (const raw of response.data?.diff ?? []) {
      const boardCode = textValue(raw.f12)
      const name = textValue(raw.f14)
      if (
        !SHENWAN_L1_INDUSTRIES.some((industry) => industry.code === boardCode)
        && !SHENWAN_L2_TO_L1_NAME[name]
      ) continue
      const upCount = nonNegativeNumber(raw.f104)
      const downCount = nonNegativeNumber(raw.f105)
      const flatCount = nonNegativeNumber(raw.f106)
      const memberCount = (upCount ?? 0) + (downCount ?? 0) + (flatCount ?? 0)
      facts.set(boardCode, {
        boardCode,
        name,
        weightedChange: finiteNumber(raw.f3) ?? 0,
        upCount,
        downCount,
        flatCount,
        breadthRate: memberCount > 0 ? (upCount ?? 0) / memberCount : null,
        mainNetInflow: finiteNumber(raw.f62),
        mainNetInflowRate: finiteNumber(raw.f184),
      })
    }
    page += 1
  }
  return facts
}

function selectL1Facts(
  facts: Map<string, MarketResonanceBoardFact>,
): Map<string, MarketResonanceBoardFact> {
  const allowed = new Set(SHENWAN_L1_INDUSTRIES.map((industry) => industry.code))
  return new Map([...facts].filter(([boardCode]) => allowed.has(boardCode)))
}

function getChildFacts(
  facts: Map<string, MarketResonanceBoardFact>,
  parentIndustryName: string,
): MarketResonanceBoardFact[] {
  const expected = new Set(getShenwanL2Names(parentIndustryName))
  return [...facts.values()].filter((fact) => expected.has(fact.name))
}

function eastmoneyHosts(ndays = 1): string[] {
  if (ndays > 1) {
    return ['push2his.eastmoney.com', 'push2delay.eastmoney.com', 'push2.eastmoney.com']
  }
  return isTradingWindow()
    ? ['push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2his.eastmoney.com']
    : ['push2delay.eastmoney.com', 'push2his.eastmoney.com']
}

function containsTradeDate(trends: string[], tradeDate: string): boolean {
  const date = `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
  return trends.some((trend) => trend.startsWith(`${date} `))
}

function countTrendDates(trends: string[]): number {
  return new Set(trends.flatMap((trend) => {
    const date = trend.slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? [date] : []
  })).size
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://quote.eastmoney.com/',
      },
    } as RequestInit)
    if (!response.ok) throw new Error(`HTTP_${response.status}`)
    return await response.json() as T
  } finally {
    clearTimeout(timeout)
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  })
  await Promise.all(workers)
  return results
}

function unavailableMetric(sectorReturn: number): MarketResonanceMetric {
  return {
    sampleCount: 0,
    correlation: null,
    directionAgreement: null,
    recentAgreement: null,
    excessReturn: sectorReturn,
    sectorReturn,
    benchmarkReturn: 0,
    lagMinutes: null,
    score: 0,
    state: 'insufficient',
  }
}

function placeholderBenchmark(
  definition: { key: MarketBenchmarkKey; secid: string; name: string },
  tradeDate: string,
): MarketResonanceBenchmark {
  return {
    key: definition.key,
    code: definition.secid,
    name: definition.name,
    tradeDate,
    change: 0,
    points: [],
  }
}

function placeholderSector(
  code: string,
  name: string,
  tradeDate: string,
  weightedChange: number,
): MarketTrendSeries {
  return {
    code,
    name,
    tradeDate,
    change: weightedChange,
    points: [],
  }
}

function isValidCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function mostCommonTradeDate(dates: string[]): string {
  const counts = new Map<string, number>()
  for (const date of dates) {
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? ''
}

function isTradingWindow(): boolean {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const weekday = now.getUTCDay()
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  return weekday >= 1 && weekday <= 5
    && ((minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60))
}

function bjYmd(): string {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function finiteNumber(value: unknown): number | null {
  if (value === '' || value === '-' || value == null) return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value)
  return number == null ? null : Math.max(0, Math.trunc(number))
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
