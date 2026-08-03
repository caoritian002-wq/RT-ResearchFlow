export type AuctionBacktestPool = 'firstBoard' | 'secondBoard' | 'brokenBoard' | 'brokenConsec' | 'allMarket'
export type AuctionBacktestHorizon = 1 | 2 | 3 | 5
export type AuctionBacktestSortMode = 'date' | 'return' | 'alpha'
export type AuctionBacktestAvailability = 'available' | 'pending' | 'missing'

export interface AuctionBacktestDetail {
  tradeDate: string
  tsCode: string
  stockName?: string | null
  pool: AuctionBacktestPool
  buyPrice: number | null
  ret1d: number | null
  ret2d: number | null
  ret3d: number | null
  ret5d: number | null
  computedAt: number | null
  isOneWord?: number
  idxTodayPct?: number | null
  idxRet1d?: number | null
  idxRet2d?: number | null
  idxRet3d?: number | null
  idxRet5d?: number | null
}

export interface AuctionBacktestMaturityContext {
  tradeDates: string[]
  latestCloseTradeDate: string | null
}

export interface AuctionBacktestSummary {
  signalCount: number
  validCount: number
  pendingCount: number
  missingCount: number
  winRate: number | null
  avgReturn: number | null
  medianReturn: number | null
  avgAlpha: number | null
  coverageRate: number | null
}

export interface AuctionBacktestPoolSummary extends AuctionBacktestSummary {
  pool: AuctionBacktestPool
  rawCount: number
  excludedOneWordCount: number
}

export interface AuctionBacktestPathPoint {
  horizon: AuctionBacktestHorizon
  label: string
  avgReturn: number | null
  avgAlpha: number | null
  sampleCount: number
}

export interface AuctionBacktestConclusion {
  title: string
  detail: string
  tone: 'positive' | 'caution' | 'neutral'
  leaderPool: AuctionBacktestPool | null
}

export interface AuctionBacktestEnvironmentSummary extends AuctionBacktestSummary {
  key: 'strong' | 'range' | 'weak'
  label: string
  threshold: string
}

export const AUCTION_BACKTEST_POOL_LABEL: Record<AuctionBacktestPool, string> = {
  firstBoard: '首板竞价',
  secondBoard: '二板及以上',
  brokenBoard: '炸板回封',
  brokenConsec: '断板修复',
  allMarket: '全市场异动',
}

const RETURN_KEY: Record<AuctionBacktestHorizon, 'ret1d' | 'ret2d' | 'ret3d' | 'ret5d'> = {
  1: 'ret1d',
  2: 'ret2d',
  3: 'ret3d',
  5: 'ret5d',
}

const INDEX_RETURN_KEY: Record<AuctionBacktestHorizon, 'idxRet1d' | 'idxRet2d' | 'idxRet3d' | 'idxRet5d'> = {
  1: 'idxRet1d',
  2: 'idxRet2d',
  3: 'idxRet3d',
  5: 'idxRet5d',
}

const HORIZONS: AuctionBacktestHorizon[] = [1, 2, 3, 5]
const POOLS: AuctionBacktestPool[] = ['firstBoard', 'secondBoard', 'brokenBoard', 'brokenConsec', 'allMarket']

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

export function getAuctionBacktestReturn(
  detail: AuctionBacktestDetail,
  horizon: AuctionBacktestHorizon,
): number | null {
  return detail[RETURN_KEY[horizon]]
}

export function getAuctionBacktestAlpha(
  detail: AuctionBacktestDetail,
  horizon: AuctionBacktestHorizon,
): number | null {
  const value = getAuctionBacktestReturn(detail, horizon)
  const indexValue = detail[INDEX_RETURN_KEY[horizon]] ?? null
  return value == null || indexValue == null ? null : value - indexValue
}

export function getAuctionBacktestAvailability(
  detail: AuctionBacktestDetail,
  horizon: AuctionBacktestHorizon,
  context: AuctionBacktestMaturityContext,
): AuctionBacktestAvailability {
  if (getAuctionBacktestReturn(detail, horizon) != null) return 'available'
  if (!context.latestCloseTradeDate) return 'missing'
  const signalIndex = context.tradeDates.indexOf(detail.tradeDate)
  const latestCloseIndex = context.tradeDates.findLastIndex((date) => date <= context.latestCloseTradeDate!)
  if (signalIndex < 0 || latestCloseIndex < 0) {
    return detail.tradeDate >= context.latestCloseTradeDate ? 'pending' : 'missing'
  }
  return signalIndex + horizon > latestCloseIndex ? 'pending' : 'missing'
}

export function buildAuctionBacktestSummary(
  rows: AuctionBacktestDetail[],
  horizon: AuctionBacktestHorizon,
  context: AuctionBacktestMaturityContext,
): AuctionBacktestSummary {
  const returns: number[] = []
  const alphas: number[] = []
  let pendingCount = 0
  let missingCount = 0

  for (const row of rows) {
    const availability = getAuctionBacktestAvailability(row, horizon, context)
    if (availability === 'pending') pendingCount += 1
    else if (availability === 'missing') missingCount += 1
    const value = getAuctionBacktestReturn(row, horizon)
    if (value != null) returns.push(value)
    const alpha = getAuctionBacktestAlpha(row, horizon)
    if (alpha != null) alphas.push(alpha)
  }

  return {
    signalCount: rows.length,
    validCount: returns.length,
    pendingCount,
    missingCount,
    winRate: returns.length === 0 ? null : returns.filter((value) => value > 0).length / returns.length * 100,
    avgReturn: average(returns),
    medianReturn: median(returns),
    avgAlpha: average(alphas),
    coverageRate: rows.length === 0 ? null : returns.length / rows.length,
  }
}

export function buildAuctionBacktestPoolSummaries(
  details: AuctionBacktestDetail[],
  horizon: AuctionBacktestHorizon,
  excludeOneWord: boolean,
  context: AuctionBacktestMaturityContext,
): AuctionBacktestPoolSummary[] {
  return POOLS.map((pool) => {
    const rawRows = details.filter((row) => row.pool === pool)
    const rows = excludeOneWord ? rawRows.filter((row) => row.isOneWord !== 1) : rawRows
    return {
      pool,
      rawCount: rawRows.length,
      excludedOneWordCount: rawRows.length - rows.length,
      ...buildAuctionBacktestSummary(rows, horizon, context),
    }
  })
}

export function buildAuctionBacktestPath(
  rows: AuctionBacktestDetail[],
): AuctionBacktestPathPoint[] {
  return HORIZONS.map((horizon) => {
    const returns = rows.map((row) => getAuctionBacktestReturn(row, horizon)).filter((value): value is number => value != null)
    const alphas = rows.map((row) => getAuctionBacktestAlpha(row, horizon)).filter((value): value is number => value != null)
    return {
      horizon,
      label: `T+${horizon}`,
      avgReturn: average(returns),
      avgAlpha: average(alphas),
      sampleCount: returns.length,
    }
  })
}

export function buildAuctionBacktestConclusion(
  summaries: AuctionBacktestPoolSummary[],
  horizon: AuctionBacktestHorizon,
): AuctionBacktestConclusion {
  const comparable = summaries.filter((item) => item.validCount >= 10 && item.avgAlpha != null)
  if (comparable.length === 0) {
    return {
      title: '当前样本不足以比较策略稳定性',
      detail: `T+${horizon} 至少需要 10 个已成熟、可执行样本才进行池间比较。`,
      tone: 'neutral',
      leaderPool: null,
    }
  }
  const leader = [...comparable].sort((left, right) => (right.avgAlpha ?? -Infinity) - (left.avgAlpha ?? -Infinity))[0]
  const alpha = leader.avgAlpha ?? 0
  const avgReturn = leader.avgReturn ?? 0
  const winRate = leader.winRate ?? 0
  return {
    title: alpha > 0
      ? `${AUCTION_BACKTEST_POOL_LABEL[leader.pool]}在 T+${horizon} 的相对表现最好`
      : `T+${horizon} 暂无稳定跑赢基准的信号池`,
    detail: alpha > 0
      ? `${leader.validCount} 个成熟样本，胜率 ${winRate.toFixed(1)}%，平均收益 ${formatSignedPct(avgReturn)}，平均超额 ${formatSignedPct(alpha)}。`
      : `相对表现最好的${AUCTION_BACKTEST_POOL_LABEL[leader.pool]}平均超额仍为 ${formatSignedPct(alpha)}，不宜只看胜率。`,
    tone: alpha > 0 ? 'positive' : 'caution',
    leaderPool: leader.pool,
  }
}

export function buildAuctionBacktestEnvironmentSummaries(
  rows: AuctionBacktestDetail[],
  horizon: AuctionBacktestHorizon,
  context: AuctionBacktestMaturityContext,
): AuctionBacktestEnvironmentSummary[] {
  const groups: Array<{
    key: AuctionBacktestEnvironmentSummary['key']
    label: string
    threshold: string
    match: (value: number) => boolean
  }> = [
    { key: 'strong', label: '强势市场', threshold: '基准当日 > +1%', match: (value) => value > 1 },
    { key: 'range', label: '震荡市场', threshold: '基准当日 -1% 至 +1%', match: (value) => value >= -1 && value <= 1 },
    { key: 'weak', label: '弱势市场', threshold: '基准当日 < -1%', match: (value) => value < -1 },
  ]
  return groups.map((group) => ({
    key: group.key,
    label: group.label,
    threshold: group.threshold,
    ...buildAuctionBacktestSummary(
      rows.filter((row) => row.idxTodayPct != null && group.match(row.idxTodayPct)),
      horizon,
      context,
    ),
  }))
}

export function filterAuctionBacktestDetails(
  details: AuctionBacktestDetail[],
  options: {
    pool: AuctionBacktestPool | 'all'
    excludeOneWord: boolean
    query: string
    sortMode: AuctionBacktestSortMode
    horizon: AuctionBacktestHorizon
  },
): AuctionBacktestDetail[] {
  const query = options.query.trim().toLocaleLowerCase('zh-CN')
  const rows = details.filter((row) => {
    if (options.pool !== 'all' && row.pool !== options.pool) return false
    if (options.excludeOneWord && row.isOneWord === 1) return false
    if (!query) return true
    return `${row.tsCode} ${row.stockName ?? ''}`.toLocaleLowerCase('zh-CN').includes(query)
  })

  return rows.sort((left, right) => {
    if (options.sortMode === 'return') {
      return (getAuctionBacktestReturn(right, options.horizon) ?? -Infinity)
        - (getAuctionBacktestReturn(left, options.horizon) ?? -Infinity)
    }
    if (options.sortMode === 'alpha') {
      return (getAuctionBacktestAlpha(right, options.horizon) ?? -Infinity)
        - (getAuctionBacktestAlpha(left, options.horizon) ?? -Infinity)
    }
    return right.tradeDate.localeCompare(left.tradeDate) || left.tsCode.localeCompare(right.tsCode)
  })
}

export function formatSignedPct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}
