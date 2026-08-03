import type Database from 'better-sqlite3'
import { getRtKCache } from './sharedRtKCache'
import { getSectorConceptSource } from '../database/settingsRepository'
import { emitDecisionSignals, type DecisionSignalInput } from './decisionSignalService'
import {
  getLatestVerifiedObservationDate,
  getPreviousVerifiedFlowMap,
  listSectorFlowObservations,
  upsertSectorFlowObservations,
} from '../database/sectorFlowObservationRepository'
import {
  fetchEastmoneySectorFlows,
  fetchEastmoneySectorMembers,
} from './eastmoneySectorFlowProvider'
import {
  buildSectorFlowGuidance,
  selectSectorFlowMemberCandidateCodes,
} from './sectorFlowGuidanceModel'
import type {
  SectorFlowItem,
  SectorFlowScope,
  SectorFlowSnapshot,
  SectorFlowStock,
} from './sectorFlowTypes'

export type {
  SectorFlowAuctionGuidance,
  SectorFlowItem,
  SectorFlowMetricMode,
  SectorFlowProvider,
  SectorFlowScope,
  SectorFlowSnapshot,
  SectorFlowStock,
  SectorFlowThemeGuidance,
} from './sectorFlowTypes'

const CACHE_TTL_MS = 60_000
let cache: { data: SectorFlowSnapshot; cachedAt: number } | null = null
let inflight: Promise<SectorFlowSnapshot> | null = null

interface ConceptBucket {
  name: string
  members: string[]
}

export function invalidateSectorFlowCache(): void {
  cache = null
}

export async function computeSectorFlowSnapshot(
  db: Database.Database,
  forceRefresh = false,
): Promise<SectorFlowSnapshot> {
  if (inflight) return inflight
  if (!forceRefresh && cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) return cache.data

  inflight = computeFreshSnapshot(db)
    .then((snapshot) => {
      if (snapshot.metricMode === 'verified_flow' && snapshot.dataMode !== 'empty') {
        emitSectorFlowDecisionSignals(db, snapshot)
      }
      cache = { data: snapshot, cachedAt: Date.now() }
      return snapshot
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function computeFreshSnapshot(db: Database.Database): Promise<SectorFlowSnapshot> {
  try {
    return await computeVerifiedSnapshot(db)
  } catch (error) {
    console.warn('[sectorFlowService] verified flow unavailable:', error instanceof Error ? error.message : String(error))
    const archived = loadLatestVerifiedSnapshot(db)
    if (archived) return archived
    return computeLocalTurnoverStrength(db)
  }
}

async function computeVerifiedSnapshot(db: Database.Database): Promise<SectorFlowSnapshot> {
  const fetched = await fetchEastmoneySectorFlows()
  const tradeDate = toBjYmd(fetched.sourceUpdatedAt ?? fetched.capturedAt)
  const previousMap = getPreviousVerifiedFlowMap(db, tradeDate)
  const withPrevious = fetched.items.map((item) => ({
    ...item,
    previousMainNetInflow: previousMap.get(itemKey(item.scope, item.boardCode)) ?? null,
  }))
  const candidateCodes = selectSectorFlowMemberCandidateCodes(withPrevious)
  const membersByBoard = await fetchCandidateMembers(candidateCodes)
  const result = buildSectorFlowGuidance(withPrevious, membersByBoard)
  let archived = true
  try {
    upsertSectorFlowObservations(db, tradeDate, 'eastmoney', result.items, fetched.capturedAt)
  } catch (error) {
    archived = false
    console.warn('[sectorFlowService] observation archive failed:', error)
  }
  const realtime = tradeDate === toBjYmd(Date.now()) && isTradingHours()
  return {
    items: sortDisplayItems(result.items),
    guidance: result.guidance,
    tradeDate,
    updatedAt: new Date(fetched.sourceUpdatedAt ?? fetched.capturedAt).toISOString(),
    capturedAt: fetched.capturedAt,
    dataMode: realtime ? 'realtime' : 'archive',
    metricMode: 'verified_flow',
    provider: 'eastmoney',
    sourceLabel: '东方财富板块主力资金',
    quality: {
      isVerified: true,
      partialScopes: fetched.partialScopes,
      archived,
      message: buildVerifiedQualityMessage(
        fetched.partialScopes,
        archived,
        membersByBoard.size,
        candidateCodes.length,
      ),
    },
  }
}

function loadLatestVerifiedSnapshot(db: Database.Database): SectorFlowSnapshot | null {
  try {
    const tradeDate = getLatestVerifiedObservationDate(db)
    if (!tradeDate) return null
    const previousMap = getPreviousVerifiedFlowMap(db, tradeDate)
    const archivedItems = listSectorFlowObservations(db, tradeDate, 'eastmoney').map((item) => ({
      ...item,
      previousMainNetInflow: previousMap.get(itemKey(item.scope, item.boardCode)) ?? null,
    }))
    if (archivedItems.length === 0) return null
    const membersByBoard = new Map(archivedItems.map((item) => [item.boardCode, item.coreStocks]))
    const result = buildSectorFlowGuidance(archivedItems, membersByBoard)
    const sourceUpdatedAt = Math.max(...result.items.map((item) => item.sourceUpdatedAt ?? 0))
    return {
      items: sortDisplayItems(result.items),
      guidance: result.guidance,
      tradeDate,
      updatedAt: sourceUpdatedAt > 0 ? new Date(sourceUpdatedAt).toISOString() : compactDateToIso(tradeDate),
      capturedAt: Date.now(),
      dataMode: 'archive',
      metricMode: 'verified_flow',
      provider: 'eastmoney',
      sourceLabel: '东方财富板块主力资金（最近存档）',
      quality: {
        isVerified: true,
        partialScopes: [],
        archived: true,
        message: '实时接口暂不可用，当前展示最近一次已核验的本地存档。',
      },
    }
  } catch (error) {
    console.warn('[sectorFlowService] archived flow unavailable:', error)
    return null
  }
}

function computeLocalTurnoverStrength(db: Database.Database): SectorFlowSnapshot {
  const capturedAt = Date.now()
  const source = getSectorConceptSource()
  const rtKCache = getRtKCache()
  if (!rtKCache || rtKCache.size === 0) return emptySnapshot(capturedAt)
  const conceptMap = buildConceptMap(db, source)
  const items: SectorFlowItem[] = []

  for (const [boardCode, bucket] of conceptMap) {
    let totalAmount = 0
    let directionalAmount = 0
    let weightedChangeSum = 0
    let upCount = 0
    let downCount = 0
    let flatCount = 0
    const members: SectorFlowStock[] = []
    for (const tsCode of bucket.members) {
      const quote = rtKCache.get(tsCode)
      if (!quote || !Number.isFinite(quote.amount) || quote.amount <= 0 || !Number.isFinite(quote.change)) continue
      totalAmount += quote.amount
      weightedChangeSum += quote.change * quote.amount
      if (quote.change > 0) {
        directionalAmount += quote.amount
        upCount += 1
      } else if (quote.change < 0) {
        directionalAmount -= quote.amount
        downCount += 1
      } else {
        flatCount += 1
      }
      members.push({
        tsCode,
        name: quote.name || tsCode,
        change: quote.change,
        totalAmount: quote.amount,
        mainNetInflow: null,
        mainNetInflowRate: null,
      })
    }
    const memberCount = upCount + downCount + flatCount
    if (memberCount < 3 || totalAmount < 50_000_000) continue
    const leader = [...members].sort((left, right) => right.change - left.change)[0] ?? null
    items.push({
      boardCode,
      boardName: bucket.name,
      scope: 'concept',
      metricMode: 'turnover_strength',
      totalAmount,
      turnoverDirectionStrength: directionalAmount / totalAmount * 100,
      mainNetInflow: null,
      mainNetInflowRate: null,
      superLargeNetInflow: null,
      superLargeNetInflowRate: null,
      largeNetInflow: null,
      largeNetInflowRate: null,
      mediumNetInflow: null,
      mediumNetInflowRate: null,
      smallNetInflow: null,
      smallNetInflowRate: null,
      weightedChange: weightedChangeSum / totalAmount,
      totalMarketCap: null,
      memberCount,
      upCount,
      downCount,
      flatCount,
      previousMainNetInflow: null,
      leader,
      coreStocks: members.sort((left, right) => Math.abs(right.change) - Math.abs(left.change)).slice(0, 3),
      relatedThemes: [],
      sourceUpdatedAt: capturedAt,
    })
  }
  const result = buildSectorFlowGuidance(items, new Map())
  const tradeDate = toBjYmd(capturedAt)
  try {
    upsertSectorFlowObservations(db, tradeDate, 'local_estimate', result.items, capturedAt)
  } catch (error) {
    console.warn('[sectorFlowService] local strength archive failed:', error)
  }
  return {
    items: [...result.items]
      .sort((left, right) => Math.abs(right.turnoverDirectionStrength ?? 0) - Math.abs(left.turnoverDirectionStrength ?? 0))
      .slice(0, 80),
    guidance: result.guidance,
    tradeDate,
    updatedAt: new Date(capturedAt).toISOString(),
    capturedAt,
    dataMode: result.items.length > 0 ? 'degraded' : 'empty',
    metricMode: 'turnover_strength',
    provider: 'local_estimate',
    sourceLabel: `本地${source.toUpperCase()}成分行情`,
    quality: {
      isVerified: false,
      partialScopes: ['industry'],
      archived: false,
      message: '真实板块资金暂不可用，仅展示上涨/下跌成交额形成的方向强度，不能视为主力净流入。',
    },
  }
}

function emptySnapshot(capturedAt: number): SectorFlowSnapshot {
  return {
    items: [],
    guidance: {
      stance: 'insufficient',
      confidence: 0,
      summary: '暂无可用板块资金或本地成交事实。',
      focusThemes: [],
      riskThemes: [],
    },
    tradeDate: null,
    updatedAt: new Date(capturedAt).toISOString(),
    capturedAt,
    dataMode: 'empty',
    metricMode: 'turnover_strength',
    provider: 'local_estimate',
    sourceLabel: '暂无数据',
    quality: {
      isVerified: false,
      partialScopes: ['concept', 'industry'],
      archived: false,
      message: '真实接口和本地行情均无可用数据，请稍后刷新。',
    },
  }
}

function emitSectorFlowDecisionSignals(db: Database.Database, snapshot: SectorFlowSnapshot): void {
  if (snapshot.metricMode !== 'verified_flow' || !snapshot.tradeDate) return
  const signalTime = snapshot.dataMode === 'realtime'
    ? Date.now()
    : compactDateToTimestamp(snapshot.tradeDate)
  const inputs: DecisionSignalInput[] = snapshot.guidance.focusThemes.map((theme, index) => ({
    sourceModule: 'sector_flow',
    strategyKey: 'sectorFlow.auctionWatch',
    conceptCode: theme.boardCode,
    conceptName: theme.boardName,
    signalType: 'INFO',
    direction: 'NEUTRAL',
    priority: index === 0 && theme.confidence >= 75 ? 4 : 3,
    score: theme.score,
    confidence: theme.confidence,
    title: `${theme.boardName} 次日竞价待确认`,
    summary: `${theme.reason} 确认：${theme.confirmations[0]} 失效：${theme.invalidations[0]}`,
    reason: {
      state: theme.state,
      mainNetInflow: theme.mainNetInflow,
      mainNetInflowRate: theme.mainNetInflowRate,
      weightedChange: theme.weightedChange,
      breadthRate: theme.breadthRate,
      coreStocks: theme.coreStocks,
      relatedThemes: theme.relatedThemes,
      confirmations: theme.confirmations,
      invalidations: theme.invalidations,
    },
    sourceRef: {
      provider: snapshot.provider,
      metricMode: snapshot.metricMode,
      tradeDate: snapshot.tradeDate,
      updatedAt: snapshot.updatedAt,
    },
    signalTime,
    dedupKey: `sector_flow:auctionWatch:${snapshot.tradeDate}:${theme.boardCode}`,
  }))
  emitDecisionSignals(db, inputs)
}

export async function archiveCurrentSnapshot(db: Database.Database): Promise<void> {
  await computeSectorFlowSnapshot(db, true)
}

/** FR-243 不再用当前概念成分和日线回算历史资金流。 */
export async function ensureSectorFlowBackfill(_db: Database.Database): Promise<void> {
  return Promise.resolve()
}

async function fetchCandidateMembers(boardCodes: string[]): Promise<Map<string, SectorFlowStock[]>> {
  const result = new Map<string, SectorFlowStock[]>()
  const batchSize = 4
  for (let index = 0; index < boardCodes.length; index += batchSize) {
    const batch = boardCodes.slice(index, index + batchSize)
    const settled = await Promise.allSettled(batch.map((boardCode) => fetchEastmoneySectorMembers(boardCode)))
    for (let offset = 0; offset < settled.length; offset += 1) {
      const item = settled[offset]
      if (item.status === 'fulfilled' && item.value.length > 0) result.set(batch[offset], item.value)
    }
  }
  return result
}

function buildVerifiedQualityMessage(
  partialScopes: SectorFlowScope[],
  archived: boolean,
  loadedMemberBoards: number,
  requestedMemberBoards: number,
): string {
  const scopeMessage = partialScopes.length > 0
    ? `已取得部分真实主力资金，${partialScopes.map(scopeLabel).join('、')}暂时缺失`
    : '概念与行业板块资金均已核验'
  const archiveMessage = archived ? '并完成本地存档' : '，但本次本地存档失败'
  const memberMessage = requestedMemberBoards === 0
    ? ''
    : loadedMemberBoards === requestedMemberBoards
      ? `；${loadedMemberBoards}个候选的成分明细已用于主题去重`
      : `；${loadedMemberBoards}/${requestedMemberBoards}个候选取得成分明细，去重与核心股置信度已按覆盖下调`
  return `${scopeMessage}${archiveMessage}${memberMessage}。`
}

function buildConceptMap(
  db: Database.Database,
  source: 'kpl' | 'ths' | 'dc',
): Map<string, ConceptBucket> {
  const map = new Map<string, ConceptBucket>()
  if (source === 'kpl') {
    const rows = db.prepare('SELECT ts_code, con_code, con_name FROM kpl_concept_members').all() as Array<{
      ts_code: string; con_code: string; con_name: string | null
    }>
    for (const row of rows) appendConcept(map, row.ts_code, row.con_name, row.con_code)
  } else if (source === 'ths') {
    const rows = db.prepare('SELECT ts_code, con_code, con_name FROM ths_concept_members').all() as Array<{
      ts_code: string; con_code: string; con_name: string | null
    }>
    for (const row of rows) appendConcept(map, row.con_code, row.con_name, row.ts_code)
  } else {
    const rows = db.prepare(`
      SELECT theme_code, theme_name, ts_code FROM dc_concept_members
      WHERE trade_date = (SELECT MAX(trade_date) FROM dc_concept_members)
    `).all() as Array<{ theme_code: string; theme_name: string | null; ts_code: string }>
    for (const row of rows) appendConcept(map, row.theme_code, row.theme_name, row.ts_code)
  }
  return map
}

function appendConcept(
  map: Map<string, ConceptBucket>,
  boardCode: string,
  boardName: string | null,
  tsCode: string,
): void {
  if (!boardCode || !tsCode) return
  const bucket = map.get(boardCode) ?? { name: boardName || boardCode, members: [] }
  bucket.members.push(tsCode)
  map.set(boardCode, bucket)
}

function sortDisplayItems(items: SectorFlowItem[]): SectorFlowItem[] {
  return [...items]
    .sort((left, right) => Math.abs(right.mainNetInflow ?? 0) - Math.abs(left.mainNetInflow ?? 0))
    .slice(0, 120)
    .sort((left, right) => (right.mainNetInflow ?? 0) - (left.mainNetInflow ?? 0))
}

function itemKey(scope: SectorFlowScope, boardCode: string): string {
  return `${scope}:${boardCode}`
}

function toBjYmd(timestamp: number): string {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

function isTradingHours(): boolean {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const day = date.getUTCDay()
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return day >= 1 && day <= 5 && ((minute >= 9 * 60 + 15 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60))
}

function compactDateToTimestamp(value: string): number {
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  return Date.UTC(year, month - 1, day, 12 - 8)
}

function compactDateToIso(value: string): string {
  return new Date(compactDateToTimestamp(value)).toISOString()
}

function scopeLabel(scope: SectorFlowScope): string {
  return scope === 'concept' ? '概念板块' : '行业板块'
}
