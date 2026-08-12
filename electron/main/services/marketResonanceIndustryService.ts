import type Database from 'better-sqlite3'
import { SHENWAN_L1_INDUSTRIES } from './eastmoneyIndustryHierarchy'
import {
  fetchCurrentMarketIndustryBoardFacts,
  fetchMarketTrendSeries,
  readMarketIndustryBoardFacts,
  type MarketResonanceBoardFact,
} from './marketResonanceService'
import {
  buildMarketIndustryStructure,
  getShenwanL2Names,
  type MarketIndustryStructure,
} from './marketResonanceIndustryModel'
import type { MarketTrendPoint } from './marketResonanceModel'

export interface MarketResonanceIndustryChild {
  boardCode: string
  name: string
  tradeDate: string
  change: number
  excessVsParent: number | null
  breadthRate: number | null
  upCount: number | null
  downCount: number | null
  flatCount: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
  points: MarketTrendPoint[]
}

export interface MarketResonanceIndustryChildren {
  tradeDate: string
  parentIndustryCode: string
  parentIndustryName: string
  factSource: 'local_archive' | 'current_network'
  structure: MarketIndustryStructure
  trendCoverage: { available: number; total: number }
  children: MarketResonanceIndustryChild[]
}

export interface MarketResonanceIndustryChildrenRequest {
  tradeDate: string
  parentIndustryCode: string
  forceRefresh?: boolean
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { result: MarketResonanceIndustryChildren; cachedAt: number }>()
const inflight = new Map<string, Promise<MarketResonanceIndustryChildren>>()

export async function getMarketResonanceIndustryChildren(
  db: Database.Database,
  request: MarketResonanceIndustryChildrenRequest,
): Promise<MarketResonanceIndustryChildren> {
  const parent = SHENWAN_L1_INDUSTRIES.find((industry) => industry.code === request.parentIndustryCode)
  if (!parent || !/^\d{8}$/.test(request.tradeDate)) {
    throw new Error('INVALID_MARKET_RESONANCE_CHILDREN_REQUEST')
  }
  const cacheKey = `${request.tradeDate}:${parent.code}`
  const inflightKey = `${cacheKey}:${request.forceRefresh ? 'refresh' : 'read'}`
  if (!request.forceRefresh) {
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.result
    const active = inflight.get(`${cacheKey}:refresh`) ?? inflight.get(inflightKey)
    if (active) return active
  } else {
    let activeRefresh = inflight.get(inflightKey)
    if (activeRefresh) return activeRefresh
    const pendingRead = inflight.get(`${cacheKey}:read`)
    if (pendingRead) {
      try {
        await pendingRead
      } catch {
        // An explicit retry still runs after an ordinary read failure.
      }
      activeRefresh = inflight.get(inflightKey)
      if (activeRefresh) return activeRefresh
    }
  }

  const promise = buildChildren(db, request.tradeDate, parent)
    .then((result) => {
      cache.set(cacheKey, { result, cachedAt: Date.now() })
      return result
    })
    .finally(() => {
      inflight.delete(inflightKey)
    })
  inflight.set(inflightKey, promise)
  return promise
}

async function buildChildren(
  db: Database.Database,
  tradeDate: string,
  parent: (typeof SHENWAN_L1_INDUSTRIES)[number],
): Promise<MarketResonanceIndustryChildren> {
  let facts = readMarketIndustryBoardFacts(db, tradeDate)
  let factSource: MarketResonanceIndustryChildren['factSource'] = 'local_archive'
  if (facts.size === 0 && tradeDate === beijingYmd()) {
    facts = await fetchCurrentMarketIndustryBoardFacts()
    factSource = 'current_network'
  }
  const expectedNames = new Set(getShenwanL2Names(parent.name))
  const childFacts = [...facts.values()]
    .filter((fact) => expectedNames.has(fact.name))
  const parentChange = facts.get(parent.code)?.weightedChange ?? null
  const runTrendRequest = async (fact: MarketResonanceBoardFact) => ({
    boardCode: fact.boardCode,
    series: await fetchMarketTrendSeries(
      `90.${fact.boardCode}`,
      fact.boardCode,
      fact.name,
      tradeDate,
      5,
    ),
  })
  let settled: Array<PromiseSettledResult<Awaited<ReturnType<typeof runTrendRequest>>>>
  if (tradeDate === beijingYmd()) {
    settled = await Promise.allSettled(childFacts.map(runTrendRequest))
  } else {
    const [probeFact, ...remainingFacts] = childFacts
    settled = []
    if (probeFact) {
      try {
        settled.push({ status: 'fulfilled', value: await runTrendRequest(probeFact) })
        settled.push(...await Promise.allSettled(remainingFacts.map(runTrendRequest)))
      } catch (reason) {
        // Probe a missing historical window once before expanding into the whole child group.
        settled.push({ status: 'rejected', reason })
      }
    }
  }
  const seriesByCode = new Map(settled.flatMap((result) => (
    result.status === 'fulfilled'
      && result.value.series.series.tradeDate === tradeDate
      ? [[result.value.boardCode, result.value.series.series] as const]
      : []
  )))
  const children = childFacts.map((fact) => projectChild(
    fact,
    tradeDate,
    parentChange,
    seriesByCode.get(fact.boardCode)?.points ?? [],
  )).sort((left, right) => (
    (right.excessVsParent ?? right.change) - (left.excessVsParent ?? left.change)
    || right.change - left.change
    || left.name.localeCompare(right.name, 'zh-CN')
  ))
  return {
    tradeDate,
    parentIndustryCode: parent.code,
    parentIndustryName: parent.name,
    factSource,
    structure: buildMarketIndustryStructure(parent.name, parentChange, childFacts),
    trendCoverage: {
      available: children.filter((child) => child.points.length > 0).length,
      total: children.length,
    },
    children,
  }
}

function projectChild(
  fact: MarketResonanceBoardFact,
  tradeDate: string,
  parentChange: number | null,
  points: MarketTrendPoint[],
): MarketResonanceIndustryChild {
  return {
    boardCode: fact.boardCode,
    name: fact.name,
    tradeDate,
    change: fact.weightedChange,
    excessVsParent: parentChange == null ? null : round(fact.weightedChange - parentChange, 4),
    breadthRate: fact.breadthRate,
    upCount: fact.upCount,
    downCount: fact.downCount,
    flatCount: fact.flatCount,
    mainNetInflow: fact.mainNetInflow,
    mainNetInflowRate: fact.mainNetInflowRate,
    points,
  }
}

function beijingYmd(): string {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
