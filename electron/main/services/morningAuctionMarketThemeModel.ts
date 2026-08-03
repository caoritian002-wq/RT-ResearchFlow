import type {
  MorningAuctionMarketTheme,
  MorningAuctionMarketThemeState,
  MorningAuctionMarketThemeStock,
  MorningAuctionMarketThemeSummary,
  MorningAuctionThemeAttribution,
} from '../database/types'
import type { SectorFlowItem } from './sectorFlowTypes'

export interface MorningAuctionMarketThemeStockInput {
  tsCode: string
  stockName: string
  pctChg: number
  auctionAmount: number
  attribution: MorningAuctionThemeAttribution | null
}

interface ThemeMember extends MorningAuctionMarketThemeStock {
  direct: boolean
}

interface ThemeBucket {
  name: string
  members: Map<string, ThemeMember>
  matchedFlow: FlowMatch | null
}

interface ThemeCluster {
  buckets: ThemeBucket[]
}

interface FlowMatch {
  item: SectorFlowItem
  kind: 'name' | 'member_overlap'
  score: number
}

const ACTIVE_MIN_PCT = 1
const ACTIVE_MIN_AMOUNT = 100

export function buildMorningAuctionMarketThemes(
  stockInputs: MorningAuctionMarketThemeStockInput[],
  flowItems: SectorFlowItem[],
  flowTradeDate: string | null,
): MorningAuctionMarketThemeSummary {
  const stocks = [...new Map(stockInputs.map((stock) => [normalizeStockCode(stock.tsCode), stock])).values()]
  const buckets = buildThemeBuckets(stocks)
  const attributedStockCount = stocks.filter((stock) => stock.attribution?.primary != null).length
  const coverageRate = stocks.length > 0 ? round(attributedStockCount / stocks.length) : null

  if (buckets.length === 0) {
    return {
      status: 'no_auction_theme',
      flowTradeDate,
      candidateStockCount: stocks.length,
      attributedStockCount,
      coverageRate,
      summary: stocks.length > 0
        ? '当前竞价候选尚未形成可聚合的直接题材或多股共振。'
        : '当前没有可用于聚合竞价主线的候选股票。',
      themes: [],
    }
  }

  for (const bucket of buckets) bucket.matchedFlow = matchFlow(bucket, flowItems)
  const themes = clusterThemeBuckets(buckets)
    .map((cluster) => buildMarketTheme(cluster, flowTradeDate))
    .sort(compareThemes)
    .slice(0, 12)

  const status = flowTradeDate && flowItems.length > 0 ? 'ready' : 'no_verified_flow'
  const headline = themes[0]
  return {
    status,
    flowTradeDate,
    candidateStockCount: stocks.length,
    attributedStockCount,
    coverageRate,
    summary: headline
      ? `${headline.name}暂列竞价主线首位：${headline.summary}`
      : '当前竞价题材仍缺少足够的聚合证据。',
    themes,
  }
}

function buildThemeBuckets(stocks: MorningAuctionMarketThemeStockInput[]): ThemeBucket[] {
  const byName = new Map<string, ThemeBucket>()
  const append = (
    stock: MorningAuctionMarketThemeStockInput,
    name: string,
    role: ThemeMember['role'],
    direct: boolean,
  ): void => {
    const normalized = normalizeThemeName(name)
    if (!normalized) return
    const bucket = byName.get(normalized) ?? { name: name.trim(), members: new Map(), matchedFlow: null }
    const code = normalizeStockCode(stock.tsCode)
    const existing = bucket.members.get(code)
    if (!existing || role === 'primary') {
      bucket.members.set(code, {
        tsCode: stock.tsCode,
        stockName: stock.stockName,
        auctionPctChg: stock.pctChg,
        auctionAmount: Math.max(0, stock.auctionAmount),
        role,
        direct: direct || existing?.direct === true,
      })
    } else if (direct && !existing.direct) {
      bucket.members.set(code, { ...existing, direct: true })
    }
    byName.set(normalized, bucket)
  }

  for (const stock of stocks) {
    const attribution = stock.attribution
    if (!attribution?.primary) continue
    append(stock, attribution.primary.name, 'primary', attribution.primary.direct)
    for (const evidence of attribution.resonance) {
      append(stock, evidence.name, 'resonance', evidence.direct)
    }
  }
  return [...byName.values()]
}

function matchFlow(bucket: ThemeBucket, flowItems: SectorFlowItem[]): FlowMatch | null {
  const bucketCodes = new Set(bucket.members.keys())
  const normalizedName = normalizeThemeName(bucket.name)
  const looseName = normalizeLooseThemeName(bucket.name)
  let best: FlowMatch | null = null

  for (const item of flowItems) {
    let score = 0
    let kind: FlowMatch['kind'] = 'member_overlap'
    const boardName = normalizeThemeName(item.boardName)
    const looseBoardName = normalizeLooseThemeName(item.boardName)
    if (boardName === normalizedName) {
      score = 100
      kind = 'name'
    } else if (looseName.length >= 2 && looseName === looseBoardName) {
      score = 92
      kind = 'name'
    } else {
      const coreCodes = new Set(item.coreStocks.map((stock) => normalizeStockCode(stock.tsCode)))
      const intersection = intersectionSize(bucketCodes, coreCodes)
      const containment = intersection / Math.max(1, Math.min(bucketCodes.size, coreCodes.size))
      const namesRelated = looseName.length >= 2
        && looseBoardName.length >= 2
        && (looseName.includes(looseBoardName) || looseBoardName.includes(looseName))
      if (intersection >= 2) score = 70 + containment * 20
      else if (intersection === 1 && namesRelated) score = 62
    }
    if (score <= 0) continue
    if (
      !best
      || score > best.score
      || (score === best.score && item.scope === 'concept' && best.item.scope !== 'concept')
      || (score === best.score && item.scope === best.item.scope && Math.abs(item.mainNetInflow ?? 0) > Math.abs(best.item.mainNetInflow ?? 0))
    ) {
      best = { item, kind, score }
    }
  }
  return best
}

function clusterThemeBuckets(buckets: ThemeBucket[]): ThemeCluster[] {
  const sorted = [...buckets].sort((left, right) => bucketPriority(right) - bucketPriority(left))
  const clusters: ThemeCluster[] = []
  for (const bucket of sorted) {
    const codes = new Set(bucket.members.keys())
    const cluster = clusters.find((entry) => entry.buckets.some((candidate) => {
      if (bucket.matchedFlow && candidate.matchedFlow?.item.boardCode === bucket.matchedFlow.item.boardCode) return true
      const candidateCodes = new Set(candidate.members.keys())
      const intersection = intersectionSize(codes, candidateCodes)
      if (intersection < 2) return false
      const union = codes.size + candidateCodes.size - intersection
      const jaccard = intersection / Math.max(1, union)
      const containment = intersection / Math.max(1, Math.min(codes.size, candidateCodes.size))
      return jaccard >= 0.55 || containment >= 0.72
    }))
    if (cluster) cluster.buckets.push(bucket)
    else clusters.push({ buckets: [bucket] })
  }
  return clusters
}

function buildMarketTheme(cluster: ThemeCluster, flowTradeDate: string | null): MorningAuctionMarketTheme {
  const representative = [...cluster.buckets].sort((left, right) => bucketPriority(right) - bucketPriority(left))[0]
  const flowMatch = [...cluster.buckets]
    .map((bucket) => bucket.matchedFlow)
    .filter((match): match is FlowMatch => match != null)
    .sort((left, right) => right.score - left.score)[0] ?? null
  const members = new Map<string, ThemeMember>()
  for (const bucket of cluster.buckets) {
    for (const [code, member] of bucket.members) {
      const existing = members.get(code)
      if (!existing || member.role === 'primary') members.set(code, { ...member, direct: member.direct || existing?.direct === true })
      else if (member.direct && !existing.direct) members.set(code, { ...existing, direct: true })
    }
  }

  const stocks = [...members.values()].sort((left, right) => right.auctionAmount - left.auctionAmount)
  const activeStocks = stocks.filter(isActiveStock)
  const medianPctChg = median((activeStocks.length > 0 ? activeStocks : stocks).map((stock) => stock.auctionPctChg))
  const totalAuctionAmount = round(stocks.reduce((sum, stock) => sum + stock.auctionAmount, 0))
  const leaderConcentration = totalAuctionAmount > 0 ? round(stocks[0].auctionAmount / totalAuctionAmount) : null
  const primaryCandidateCount = stocks.filter((stock) => stock.role === 'primary').length
  const directCandidateCount = stocks.filter((stock) => stock.direct).length
  const limitUpCount = stocks.filter(isNearLimitUp).length
  const strongAuction = activeStocks.length >= 2 && (medianPctChg ?? -Infinity) >= 1 && (leaderConcentration ?? 1) <= 0.78
  const isolated = activeStocks.length <= 1 || (leaderConcentration ?? 0) > 0.78
  const flow = flowMatch?.item ?? null
  const positiveFlow = (flow?.mainNetInflow ?? 0) > 0
  const state = classifyState(Boolean(flow), positiveFlow, strongAuction, isolated)
  const auctionScore = scoreAuction(activeStocks.length, medianPctChg, totalAuctionAmount, leaderConcentration, directCandidateCount)
  const flowScore = flow ? scoreFlow(flow) : 35
  const score = Math.round(clamp(auctionScore * 0.68 + flowScore * 0.32, 0, 100))
  const confidence = Math.round(clamp(
    24
      + Math.min(28, activeStocks.length * 9)
      + Math.min(14, directCandidateCount * 7)
      + (flowMatch?.kind === 'name' ? 18 : flowMatch ? 12 : 0)
      + (flow?.mainNetInflowRate != null ? 8 : 0)
      - ((leaderConcentration ?? 0) > 0.78 ? 15 : 0),
    20,
    92,
  ))
  const aliases = [...new Set(cluster.buckets.map((bucket) => bucket.name))]
  const name = flowMatch?.item.boardName ?? representative.name
  const breadthRate = flow && flow.memberCount > 0 ? round(flow.upCount / flow.memberCount) : null
  const basis = buildBasis(activeStocks.length, medianPctChg, totalAuctionAmount, directCandidateCount, flowMatch, flowTradeDate)
  const risks = buildRisks(state, leaderConcentration, flowMatch, flowTradeDate)

  return {
    name,
    aliases,
    state,
    score,
    confidence,
    stockCodes: stocks.map((stock) => stock.tsCode),
    stocks: stocks.slice(0, 5).map(({ direct: _direct, ...stock }) => stock),
    auction: {
      candidateCount: stocks.length,
      activeCandidateCount: activeStocks.length,
      primaryCandidateCount,
      directCandidateCount,
      medianPctChg,
      totalAuctionAmount,
      leaderConcentration,
      limitUpCount,
    },
    flow: flow && flowTradeDate ? {
      tradeDate: flowTradeDate,
      boardCode: flow.boardCode,
      boardName: flow.boardName,
      mainNetInflow: flow.mainNetInflow ?? 0,
      mainNetInflowRate: flow.mainNetInflowRate,
      weightedChange: flow.weightedChange,
      breadthRate,
      matchKind: flowMatch?.kind ?? 'member_overlap',
    } : null,
    summary: buildSummary(state, activeStocks.length, medianPctChg),
    basis,
    risks,
  }
}

function classifyState(
  hasFlow: boolean,
  positiveFlow: boolean,
  strongAuction: boolean,
  isolated: boolean,
): MorningAuctionMarketThemeState {
  if (!hasFlow) return strongAuction ? 'auction_only' : 'insufficient'
  if (positiveFlow) return strongAuction ? 'confirmed_continuation' : 'unconfirmed_continuation'
  if (strongAuction) return 'new_rotation'
  return isolated ? 'isolated_risk' : 'insufficient'
}

function scoreAuction(
  activeCount: number,
  medianPctChg: number | null,
  amount: number,
  concentration: number | null,
  directCount: number,
): number {
  const breadth = Math.min(32, activeCount * 11)
  const strength = medianPctChg == null ? 0 : clamp((medianPctChg - 0.5) * 5, 0, 24)
  const amountScore = amount > 0 ? clamp(Math.log10(amount / 500 + 1) * 18, 0, 22) : 0
  const direct = Math.min(12, directCount * 6)
  const concentrationPenalty = (concentration ?? 0) > 0.78 ? 18 : (concentration ?? 0) > 0.65 ? 8 : 0
  return clamp(18 + breadth + strength + amountScore + direct - concentrationPenalty, 0, 100)
}

function scoreFlow(flow: SectorFlowItem): number {
  const rate = clamp(flow.mainNetInflowRate ?? 0, -10, 10)
  const breadth = flow.memberCount > 0 ? flow.upCount / flow.memberCount : 0.5
  return clamp(50 + rate * 3 + clamp(flow.weightedChange, -5, 5) * 3 + (breadth - 0.5) * 30, 0, 100)
}

function buildBasis(
  activeCount: number,
  medianPctChg: number | null,
  totalAuctionAmount: number,
  directCount: number,
  flowMatch: FlowMatch | null,
  flowTradeDate: string | null,
): string[] {
  const basis = [
    `${activeCount} 只有效竞价候选`,
    `竞价涨幅中位数 ${formatPct(medianPctChg)}`,
    `竞价金额 ${formatAmount(totalAuctionAmount)}`,
  ]
  if (directCount > 0) basis.push(`${directCount} 只有上一交易日直接题材依据`)
  if (flowMatch && flowTradeDate) basis.push(`${flowTradeDate} 真实板块资金 · ${flowMatch.kind === 'name' ? '名称匹配' : '核心股票重合匹配'}`)
  return basis
}

function buildRisks(
  state: MorningAuctionMarketThemeState,
  concentration: number | null,
  flowMatch: FlowMatch | null,
  flowTradeDate: string | null,
): string[] {
  const risks: string[] = []
  if ((concentration ?? 0) > 0.78) risks.push(`最大单股贡献 ${Math.round((concentration ?? 0) * 100)}%，板块强度可能由孤立个股驱动`)
  if (!flowMatch || !flowTradeDate) risks.push('缺少可匹配的上一交易日真实板块资金，只能保留竞价线索')
  if (state === 'unconfirmed_continuation') risks.push('昨日资金流入尚未得到多股竞价扩散确认')
  if (state === 'new_rotation') risks.push('今日竞价与昨日资金方向不一致，仍需开盘后验证是否转为真实轮动')
  if (state === 'confirmed_continuation') risks.push('若核心候选开盘后快速转弱或板块扩散收窄，延续确认失效')
  if (state === 'isolated_risk') risks.push('当前缺少同题材候选共振，持续性存疑')
  if (risks.length === 0) risks.push('仍需观察开盘后板块广度和核心候选承接')
  return risks
}

function buildSummary(state: MorningAuctionMarketThemeState, activeCount: number, medianPctChg: number | null): string {
  const evidence = `${activeCount} 只有效候选，竞价中位涨幅 ${formatPct(medianPctChg)}`
  const labels: Record<MorningAuctionMarketThemeState, string> = {
    confirmed_continuation: '昨日资金流入得到今日多股竞价确认',
    unconfirmed_continuation: '昨日资金流入尚未得到今日竞价扩散确认',
    new_rotation: '昨日资金未支持，但今日出现多股竞价转强线索',
    isolated_risk: '昨日资金偏弱且今日主要由孤立个股驱动',
    auction_only: '今日竞价形成多股共振，但缺少昨日真实资金确认',
    insufficient: '当前题材或资金覆盖不足，暂不确认市场主线',
  }
  return `${labels[state]}；${evidence}。`
}

function compareThemes(left: MorningAuctionMarketTheme, right: MorningAuctionMarketTheme): number {
  const stateRank: Record<MorningAuctionMarketThemeState, number> = {
    confirmed_continuation: 6,
    new_rotation: 5,
    auction_only: 4,
    unconfirmed_continuation: 3,
    isolated_risk: 2,
    insufficient: 1,
  }
  return stateRank[right.state] - stateRank[left.state]
    || right.score - left.score
    || right.auction.activeCandidateCount - left.auction.activeCandidateCount
}

function bucketPriority(bucket: ThemeBucket): number {
  const members = [...bucket.members.values()]
  return members.filter((member) => member.role === 'primary').length * 20
    + members.filter((member) => member.direct).length * 12
    + members.filter(isActiveStock).length * 8
    + Math.min(10, members.reduce((sum, member) => sum + member.auctionAmount, 0) / 1000)
}

function isActiveStock(stock: Pick<MorningAuctionMarketThemeStock, 'auctionPctChg' | 'auctionAmount'>): boolean {
  return stock.auctionPctChg >= ACTIVE_MIN_PCT && stock.auctionAmount >= ACTIVE_MIN_AMOUNT
}

function isNearLimitUp(stock: MorningAuctionMarketThemeStock): boolean {
  const code = normalizeStockCode(stock.tsCode)
  const name = stock.stockName.toUpperCase()
  const limit = name.includes('ST')
    ? 5
    : stock.tsCode.toUpperCase().endsWith('.BJ') || /^[48]/.test(code)
      ? 30
      : /^(300|301|688|689)/.test(code)
        ? 20
        : 10
  return stock.auctionPctChg >= limit - 0.3
}

function normalizeStockCode(value: string): string {
  return value.trim().toUpperCase().split('.')[0]
}

function normalizeThemeName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s·•・—_\-（）()]/g, '')
}

function normalizeLooseThemeName(value: string): string {
  return normalizeThemeName(value).replace(/(?:概念|板块|主题|产业链|指数)$/g, '')
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let size = 0
  for (const value of left) if (right.has(value)) size += 1
  return size
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return round(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
}

function formatPct(value: number | null): string {
  if (value == null) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatAmount(value: number): string {
  return value >= 10_000 ? `${(value / 10_000).toFixed(2)}亿` : `${value.toFixed(0)}万`
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
