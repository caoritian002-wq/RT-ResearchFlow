import { net } from 'electron'
import type { SectorFlowItem, SectorFlowScope, SectorFlowStock } from './sectorFlowTypes'

const HOST_REALTIME = 'push2.eastmoney.com'
const HOST_DELAY = 'push2delay.eastmoney.com'
const PAGE_SIZE = 100
const MAX_PAGES = 6
const TIMEOUT_MS = 8_000
const BOARD_FIELDS = [
  'f3', 'f6', 'f12', 'f14', 'f20', 'f62', 'f184',
  'f66', 'f69', 'f72', 'f75', 'f78', 'f81', 'f84', 'f87',
  'f104', 'f105', 'f106', 'f124', 'f128', 'f140', 'f136',
].join(',')
const MEMBER_FIELDS = 'f3,f6,f12,f14,f62,f184'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36'

interface EastmoneyDiff {
  [key: string]: unknown
  f3?: unknown
  f6?: unknown
  f12?: unknown
  f14?: unknown
  f20?: unknown
  f62?: unknown
  f184?: unknown
  f66?: unknown
  f69?: unknown
  f72?: unknown
  f75?: unknown
  f78?: unknown
  f81?: unknown
  f84?: unknown
  f87?: unknown
  f104?: unknown
  f105?: unknown
  f106?: unknown
  f124?: unknown
  f128?: unknown
  f140?: unknown
  f136?: unknown
}

interface EastmoneyResponse {
  data?: { total?: number; diff?: EastmoneyDiff[] | null } | null
}

export interface EastmoneySectorFlowResult {
  items: SectorFlowItem[]
  partialScopes: SectorFlowScope[]
  sourceUpdatedAt: number | null
  capturedAt: number
}

export async function fetchEastmoneySectorFlows(): Promise<EastmoneySectorFlowResult> {
  const capturedAt = Date.now()
  const scopes: SectorFlowScope[] = ['concept', 'industry']
  const settled = await Promise.allSettled(scopes.map((scope) => fetchScopeWithFallback(scope)))
  const items: SectorFlowItem[] = []
  const partialScopes: SectorFlowScope[] = []
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]
    if (result.status === 'fulfilled') items.push(...result.value)
    else partialScopes.push(scopes[index])
  }
  if (items.length === 0) throw new Error('EASTMONEY_SECTOR_FLOW_EMPTY')
  const sourceTimes = items
    .map((item) => item.sourceUpdatedAt)
    .filter((value): value is number => value != null)
  return {
    items,
    partialScopes,
    sourceUpdatedAt: sourceTimes.length > 0 ? Math.max(...sourceTimes) : null,
    capturedAt,
  }
}

export async function fetchEastmoneySectorMembers(boardCode: string): Promise<SectorFlowStock[]> {
  if (!/^BK\d{4,6}$/.test(boardCode)) return []
  const primary = isTradingWindow() ? HOST_REALTIME : HOST_DELAY
  try {
    return await fetchMembersFromHost(boardCode, primary)
  } catch (error) {
    if (primary === HOST_DELAY) throw error
    return fetchMembersFromHost(boardCode, HOST_DELAY)
  }
}

export function parseEastmoneySectorBoard(raw: EastmoneyDiff, scope: SectorFlowScope): SectorFlowItem | null {
  const boardCode = textValue(raw.f12)
  const boardName = textValue(raw.f14)
  const totalAmount = finiteNumber(raw.f6)
  const mainNetInflow = finiteNumber(raw.f62)
  const weightedChange = finiteNumber(raw.f3)
  if (!/^BK\d{4,6}$/.test(boardCode) || !boardName) return null
  if (totalAmount == null || totalAmount <= 0 || mainNetInflow == null || weightedChange == null) return null

  const leaderName = textValue(raw.f128)
  const leaderCode = textValue(raw.f140)
  const leaderChange = finiteNumber(raw.f136)
  const leader = leaderName && isAshareCode(leaderCode) && leaderChange != null
    ? stockValue(leaderCode, leaderName, leaderChange, null, null, null)
    : null

  return {
    boardCode,
    boardName,
    scope,
    metricMode: 'verified_flow',
    totalAmount,
    turnoverDirectionStrength: null,
    mainNetInflow,
    mainNetInflowRate: finiteNumber(raw.f184),
    superLargeNetInflow: finiteNumber(raw.f66),
    superLargeNetInflowRate: finiteNumber(raw.f69),
    largeNetInflow: finiteNumber(raw.f72),
    largeNetInflowRate: finiteNumber(raw.f75),
    mediumNetInflow: finiteNumber(raw.f78),
    mediumNetInflowRate: finiteNumber(raw.f81),
    smallNetInflow: finiteNumber(raw.f84),
    smallNetInflowRate: finiteNumber(raw.f87),
    weightedChange,
    totalMarketCap: finiteNumber(raw.f20),
    memberCount: nonNegativeInt(raw.f104) + nonNegativeInt(raw.f105) + nonNegativeInt(raw.f106),
    upCount: nonNegativeInt(raw.f104),
    downCount: nonNegativeInt(raw.f105),
    flatCount: nonNegativeInt(raw.f106),
    previousMainNetInflow: null,
    leader,
    coreStocks: [],
    relatedThemes: [],
    sourceUpdatedAt: normalizeEpochMs(raw.f124),
  }
}

export function parseEastmoneySectorMember(raw: EastmoneyDiff): SectorFlowStock | null {
  const code = textValue(raw.f12)
  const name = textValue(raw.f14)
  const change = finiteNumber(raw.f3)
  if (!isAshareCode(code) || !name || change == null) return null
  return stockValue(
    code,
    name,
    change,
    finiteNumber(raw.f6),
    finiteNumber(raw.f62),
    finiteNumber(raw.f184),
  )
}

function stockValue(
  code: string,
  name: string,
  change: number,
  totalAmount: number | null,
  mainNetInflow: number | null,
  mainNetInflowRate: number | null,
): SectorFlowStock {
  const suffix = code.startsWith('6') ? 'SH' : code.startsWith('4') || code.startsWith('8') || code.startsWith('92') ? 'BJ' : 'SZ'
  return { tsCode: `${code}.${suffix}`, name, change, totalAmount, mainNetInflow, mainNetInflowRate }
}

async function fetchScopeWithFallback(scope: SectorFlowScope): Promise<SectorFlowItem[]> {
  const primary = isTradingWindow() ? HOST_REALTIME : HOST_DELAY
  try {
    return await fetchScopeFromHost(scope, primary)
  } catch (error) {
    if (primary === HOST_DELAY) throw error
    return fetchScopeFromHost(scope, HOST_DELAY)
  }
}

async function fetchScopeFromHost(scope: SectorFlowScope, host: string): Promise<SectorFlowItem[]> {
  const first = await fetchJson(buildBoardUrl(host, scope, 1))
  const total = Math.max(0, Math.trunc(finiteNumber(first.data?.total) ?? 0))
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)))
  const pages: EastmoneyResponse[] = [first]
  for (let page = 2; page <= pageCount; page += 1) {
    pages.push(await fetchJson(buildBoardUrl(host, scope, page)))
  }
  const deduped = new Map<string, SectorFlowItem>()
  for (const raw of pages.flatMap((page) => page.data?.diff ?? [])) {
    const item = parseEastmoneySectorBoard(raw, scope)
    if (item) deduped.set(item.boardCode, item)
  }
  if (deduped.size === 0) throw new Error(`EASTMONEY_${scope.toUpperCase()}_EMPTY`)
  return Array.from(deduped.values())
}

async function fetchMembersFromHost(boardCode: string, host: string): Promise<SectorFlowStock[]> {
  const first = await fetchJson(buildMemberUrl(host, boardCode, 1))
  const total = Math.max(0, Math.trunc(finiteNumber(first.data?.total) ?? 0))
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)))
  const pages: EastmoneyResponse[] = [first]
  for (let page = 2; page <= pageCount; page += 1) {
    pages.push(await fetchJson(buildMemberUrl(host, boardCode, page)))
  }
  const deduped = new Map<string, SectorFlowStock>()
  for (const raw of pages.flatMap((page) => page.data?.diff ?? [])) {
    const member = parseEastmoneySectorMember(raw)
    if (member) deduped.set(member.tsCode, member)
  }
  return Array.from(deduped.values())
}

function buildBoardUrl(host: string, scope: SectorFlowScope, page: number): string {
  const fs = scope === 'concept' ? 'm:90+t:3' : 'm:90+t:2'
  return `https://${host}/api/qt/clist/get?fs=${encodeURIComponent(fs)}&fields=${BOARD_FIELDS}&pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f62&_=${Date.now()}`
}

function buildMemberUrl(host: string, boardCode: string, page: number): string {
  return `https://${host}/api/qt/clist/get?fs=b:${encodeURIComponent(boardCode)}&fields=${MEMBER_FIELDS}&pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f62&_=${Date.now()}`
}

async function fetchJson(url: string): Promise<EastmoneyResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
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
    const json = await response.json() as EastmoneyResponse
    if (!json || typeof json !== 'object') throw new Error('INVALID_RESPONSE')
    return json
  } finally {
    clearTimeout(timeout)
  }
}

function isTradingWindow(): boolean {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const weekday = now.getUTCDay()
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  return weekday >= 1 && weekday <= 5 && ((minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60))
}

function finiteNumber(value: unknown): number | null {
  if (value === '-' || value === '' || value == null) return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegativeInt(value: unknown): number {
  const number = finiteNumber(value)
  return number == null ? 0 : Math.max(0, Math.trunc(number))
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isAshareCode(value: string): boolean {
  return /^(?:00[0-3]\d{3}|30[01]\d{3}|60[0135]\d{3}|68[89]\d{3}|[48]\d{5}|92\d{4})$/.test(value)
}

function normalizeEpochMs(value: unknown): number | null {
  const number = finiteNumber(value)
  if (number == null || number <= 0) return null
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number
  return Number.isFinite(milliseconds) ? Math.trunc(milliseconds) : null
}
