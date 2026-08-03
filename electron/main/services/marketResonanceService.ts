import { net } from 'electron'
import { SHENWAN_L1_INDUSTRIES } from './eastmoneyIndustryHierarchy'
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
  metrics: Record<MarketBenchmarkKey, MarketResonanceMetric>
}

export interface MarketResonanceSnapshot {
  tradeDate: string
  dataMode: MarketResonanceDataMode
  sourceLabel: string
  generatedAt: number
  coverage: { available: number; total: number }
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

interface BoardFact {
  boardCode: string
  name: string
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
const BOARD_FIELDS = 'f12,f14,f62,f184,f104,f105,f106'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36'

let cached: { snapshot: MarketResonanceSnapshot; cachedAt: number } | null = null
let inflight: Promise<MarketResonanceSnapshot> | null = null

export async function getMarketResonanceSnapshot(forceRefresh = false): Promise<MarketResonanceSnapshot> {
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.snapshot
  if (inflight) return inflight
  inflight = buildSnapshot()
    .then((snapshot) => {
      cached = { snapshot, cachedAt: Date.now() }
      return snapshot
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function buildSnapshot(): Promise<MarketResonanceSnapshot> {
  const boardFactsPromise = fetchIndustryBoardFacts().catch(() => new Map<string, BoardFact>())
  const trendRequests = [
    ...BENCHMARKS.map((benchmark) => ({
      kind: 'benchmark' as const,
      key: benchmark.key,
      code: benchmark.secid,
      name: benchmark.name,
      secid: benchmark.secid,
    })),
    ...SHENWAN_L1_INDUSTRIES.map((sector) => ({
      kind: 'sector' as const,
      code: sector.code,
      name: sector.name,
      secid: `90.${sector.code}`,
    })),
  ]
  const settled = await mapWithConcurrency(trendRequests, 6, async (request) => ({
    request,
    series: await fetchTrendSeries(request.secid, request.code, request.name),
  }))
  const benchmarks: MarketResonanceBenchmark[] = []
  const sectorSeries: Array<{ boardCode: string; series: MarketTrendSeries }> = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    const { request, series } = result.value
    if (request.kind === 'benchmark') benchmarks.push({ ...series, key: request.key })
    else sectorSeries.push({ boardCode: request.code, series })
  }
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
  if (benchmarks.length === 0 || sectorSeries.length < 10) throw new Error('MARKET_RESONANCE_INSUFFICIENT')

  const facts = await boardFactsPromise
  const benchmarkByKey = new Map(benchmarks.map((benchmark) => [benchmark.key, benchmark]))
  const sectors = sectorSeries.map(({ boardCode, series }): MarketResonanceSector => {
    const fact = facts.get(boardCode)
    const breadthRate = fact?.breadthRate ?? null
    const metrics = Object.fromEntries(BENCHMARKS.map(({ key }) => {
      const benchmark = benchmarkByKey.get(key)
      return [key, benchmark
        ? calculateMarketResonance(benchmark, series, breadthRate)
        : unavailableMetric(series.change)]
    })) as Record<MarketBenchmarkKey, MarketResonanceMetric>
    return {
      ...series,
      boardCode,
      name: fact?.name || series.name,
      breadthRate,
      upCount: fact?.upCount ?? null,
      downCount: fact?.downCount ?? null,
      flatCount: fact?.flatCount ?? null,
      mainNetInflow: fact?.mainNetInflow ?? null,
      mainNetInflowRate: fact?.mainNetInflowRate ?? null,
      metrics,
    }
  })
  const tradeDate = mostCommonTradeDate([
    ...benchmarks.map((item) => item.tradeDate),
    ...sectors.map((item) => item.tradeDate),
  ])
  const partial = benchmarks.length < BENCHMARKS.length || sectors.length < SHENWAN_L1_INDUSTRIES.length
  const dataMode: MarketResonanceDataMode = partial
    ? 'partial'
    : tradeDate === bjYmd() && isTradingWindow()
      ? 'realtime'
      : 'archive'
  return {
    tradeDate,
    dataMode,
    sourceLabel: '东方财富指数与申万一级行业一分钟行情',
    generatedAt: Date.now(),
    coverage: { available: sectors.length, total: SHENWAN_L1_INDUSTRIES.length },
    benchmarks: BENCHMARKS.flatMap(({ key }) => {
      const benchmark = benchmarkByKey.get(key)
      return benchmark ? [benchmark] : []
    }),
    sectors,
  }
}

async function fetchTrendSeries(
  secid: string,
  code: string,
  fallbackName: string,
): Promise<MarketTrendSeries> {
  let response: EastmoneyTrendResponse | null = null
  let lastError: unknown = null
  for (const host of eastmoneyHosts()) {
    const url = new URL(`https://${host}/api/qt/stock/trends2/get`)
    url.searchParams.set('secid', secid)
    url.searchParams.set('fields1', TREND_FIELDS_1)
    url.searchParams.set('fields2', TREND_FIELDS_2)
    url.searchParams.set('iscr', '0')
    url.searchParams.set('ndays', '1')
    url.searchParams.set('_', String(Date.now()))
    try {
      response = await fetchJson<EastmoneyTrendResponse>(url.toString())
      if (response.data?.trends?.length) break
    } catch (error) {
      lastError = error
    }
  }
  if (!response?.data?.trends?.length) throw lastError instanceof Error ? lastError : new Error('EASTMONEY_TREND_EMPTY')
  const preClose = finiteNumber(response.data?.preClose)
  const rawTrends = response.data?.trends ?? []
  if (preClose == null || preClose <= 0 || rawTrends.length < MIN_TREND_POINTS) throw new Error('EASTMONEY_TREND_EMPTY')
  const points: MarketTrendPoint[] = []
  let tradeDate = ''
  for (const raw of rawTrends) {
    const parts = raw.split(',')
    if (parts.length < 2) continue
    const [datePart, timePart] = parts[0].trim().split(/\s+/)
    const price = finiteNumber(parts[1])
    if (!datePart || !/^\d{2}:\d{2}$/.test(timePart ?? '') || price == null || price <= 0) continue
    tradeDate = datePart.replace(/-/g, '')
    points.push({ time: timePart, change: round((price / preClose - 1) * 100, 4) })
  }
  if (!tradeDate || points.length < MIN_TREND_POINTS) throw new Error('EASTMONEY_TREND_INVALID')
  return {
    code,
    name: textValue(response.data?.name) || fallbackName,
    tradeDate,
    change: points.at(-1)?.change ?? 0,
    points,
  }
}

const MIN_TREND_POINTS = 30

async function fetchIndustryBoardFacts(): Promise<Map<string, BoardFact>> {
  let lastError: unknown = null
  for (const host of eastmoneyHosts()) {
    try {
      return await fetchIndustryBoardFactsFromHost(host)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('EASTMONEY_BOARD_EMPTY')
}

async function fetchIndustryBoardFactsFromHost(host: string): Promise<Map<string, BoardFact>> {
  const facts = new Map<string, BoardFact>()
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
      if (!SHENWAN_L1_INDUSTRIES.some((industry) => industry.code === boardCode)) continue
      const upCount = nonNegativeNumber(raw.f104)
      const downCount = nonNegativeNumber(raw.f105)
      const flatCount = nonNegativeNumber(raw.f106)
      const memberCount = (upCount ?? 0) + (downCount ?? 0) + (flatCount ?? 0)
      facts.set(boardCode, {
        boardCode,
        name: textValue(raw.f14),
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

function eastmoneyHosts(): string[] {
  return isTradingWindow()
    ? ['push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2his.eastmoney.com']
    : ['push2delay.eastmoney.com', 'push2his.eastmoney.com']
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
