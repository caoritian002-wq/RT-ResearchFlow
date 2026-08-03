export interface MorningAuctionThemePeer {
  tsCode: string
  stockName: string
  auctionPctChg: number
  auctionAmount: number
}

export interface MorningAuctionThemeEvidence {
  name: string
  score: number
  direct: boolean
  peerCount: number
  activePeerCount: number
  averageAuctionPct: number | null
  totalAuctionAmount: number
  peers: MorningAuctionThemePeer[]
  basis: string[]
}

export interface MorningAuctionThemeAttribution {
  state: 'direct' | 'resonance' | 'unresolved'
  confidence: 'high' | 'medium' | 'low' | 'none'
  primary: MorningAuctionThemeEvidence | null
  resonance: MorningAuctionThemeEvidence[]
  staticThemes: string[]
  allThemes: string[]
  directReason: string | null
  sourceTradeDate: string | null
  summary: string
}

export type MorningAuctionMarketThemeState =
  | 'confirmed_continuation'
  | 'unconfirmed_continuation'
  | 'new_rotation'
  | 'isolated_risk'
  | 'auction_only'
  | 'insufficient'

export interface MorningAuctionMarketTheme {
  name: string
  aliases: string[]
  state: MorningAuctionMarketThemeState
  score: number
  confidence: number
  stockCodes: string[]
  stocks: Array<{
    tsCode: string
    stockName: string
    auctionPctChg: number
    auctionAmount: number
    role: 'primary' | 'resonance'
  }>
  auction: {
    candidateCount: number
    activeCandidateCount: number
    primaryCandidateCount: number
    directCandidateCount: number
    medianPctChg: number | null
    totalAuctionAmount: number
    leaderConcentration: number | null
    limitUpCount: number
  }
  flow: null | {
    tradeDate: string
    boardCode: string
    boardName: string
    mainNetInflow: number
    mainNetInflowRate: number | null
    weightedChange: number
    breadthRate: number | null
    matchKind: 'name' | 'member_overlap'
  }
  summary: string
  basis: string[]
  risks: string[]
}

export interface MorningAuctionMarketThemeSummary {
  status: 'ready' | 'no_verified_flow' | 'no_auction_theme'
  flowTradeDate: string | null
  candidateStockCount: number
  attributedStockCount: number
  coverageRate: number | null
  summary: string
  themes: MorningAuctionMarketTheme[]
}

export function isMorningAuctionMarketThemeRuntimeOutdated(
  snapshotLoaded: boolean,
  summary: MorningAuctionMarketThemeSummary | null | undefined,
): boolean {
  return snapshotLoaded && summary == null
}

export interface MorningAuctionBaseStock {
  tsCode: string
  stockCode: string
  stockName: string
  auctionPrice: number
  pctChg: number
  auctionAmount: number
  auctionTurnover: number
  currentPrice: number | null
  currentPctChg: number | null
  currentAmount: number | null
  pctChg3d: number | null
  pctChg5d: number | null
  conceptNames: string[]
  themeAttribution?: MorningAuctionThemeAttribution | null
}

export interface MorningAuctionThemeTableDisplay {
  primary: { label: string; name: string | null; tone: 'direct' | 'inferred' | 'unresolved' }
  secondary: { label: string; name: string } | null
  hiddenCount: number
  totalCount: number
}

export interface MorningAuctionSnapshotLike<Stock extends MorningAuctionBaseStock = MorningAuctionBaseStock> {
  threeOne: {
    firstBoard: Stock[]
    secondBoard: Stock[]
    brokenBoard: Stock[]
    brokenConsec: Stock[]
    allMarket: Stock[]
  }
  weakToStrong: {
    badBoard: Stock[]
    tailAttack: Stock[]
    brokenBoard: Stock[]
    afternoonReseal: Stock[]
    reversal: Stock[]
  }
  boardCategory: {
    first: Stock[]
    second: Stock[]
    third: Stock[]
    n: Stock[]
  }
}

export interface MorningAuctionChipEntry {
  tradeDate: string | null
  dateRelation: 'same_day' | 'history' | 'missing'
  winnerRate: number | null
  thickProfitPct: number | null
  trappedPct: number | null
  concentration: number | null
  costDeviationPct: number | null
  loosening1d: number | null
  loosening3d: number | null
  loosening5d: number | null
  bottomPct: number | null
  pctChg: number | null
  turnoverRate: number | null
  completenessStatus: 'complete' | 'partial' | 'blocked'
  consistencyStatus: 'matched' | 'warning' | 'not_comparable'
}

export type MorningAuctionCandidateGroup = 'threeOne' | 'weakToStrong' | 'boardCategory' | 'allMarket'

export interface MorningAuctionCandidate<Stock extends MorningAuctionBaseStock = MorningAuctionBaseStock> {
  id: string
  stock: Stock
  group: MorningAuctionCandidateGroup
  poolKey: string
  poolLabel: string
  signalLabel: string
  reason: string
  rankScore: number
  tags: string[]
  riskFlags: string[]
  verificationItems: string[]
  chipEntry: MorningAuctionChipEntry | null
}

export interface MorningAuctionPoolStat {
  key: string
  label: string
  count: number
  leadStockName: string
  leadPctChg: number | null
  description: string
}

export interface MorningAuctionWorkbench<Stock extends MorningAuctionBaseStock = MorningAuctionBaseStock> {
  candidates: Array<MorningAuctionCandidate<Stock>>
  poolStats: MorningAuctionPoolStat[]
  totalCandidates: number
  limitUpCount: number
  highIntentCount: number
  chipCoveredCount: number
  missingHistoryCount: number
}

export interface MorningAuctionFocusEvidence {
  key: 'auction' | 'momentum' | 'concept'
  label: string
  text: string
}

interface PoolConfig {
  group: MorningAuctionCandidateGroup
  key: string
  label: string
  signalLabel: string
  reason: string
  baseScore: number
  description: string
}

export function hasChipSignal(entry: MorningAuctionChipEntry | null): boolean {
  if (!entry) return false
  return entry.winnerRate != null || entry.thickProfitPct != null || entry.trappedPct != null ||
    entry.concentration != null || entry.costDeviationPct != null || entry.bottomPct != null ||
    entry.loosening1d != null || entry.loosening3d != null || entry.loosening5d != null
}

export function hasSameDayChipEvidence(entry: MorningAuctionChipEntry | null): boolean {
  return entry?.dateRelation === 'same_day' && hasChipSignal(entry)
}

export function resolveChipConclusionPctChg(
  entry: MorningAuctionChipEntry,
  currentPctChg: number | null
): number | null {
  return entry.dateRelation === 'same_day' ? currentPctChg ?? entry.pctChg : entry.pctChg
}

export function getChipSyncPlaceholder(attempted: boolean, syncing: boolean): string {
  if (!attempted) return '未同步'
  return syncing ? '同步中' : '同步无数据'
}

export function getMorningAuctionThemeConfidenceLabel(
  confidence: MorningAuctionThemeAttribution['confidence'],
): string {
  if (confidence === 'high') return '较强依据'
  if (confidence === 'medium') return '中等依据'
  if (confidence === 'low') return '线索判断'
  return '证据不足'
}

export function buildMorningAuctionThemeTableDisplay(
  stock: Pick<MorningAuctionBaseStock, 'conceptNames' | 'themeAttribution'>,
): MorningAuctionThemeTableDisplay {
  const attribution = stock.themeAttribution ?? null
  const allThemes = attribution?.allThemes.length ? attribution.allThemes : stock.conceptNames
  if (!attribution?.primary) {
    const firstStatic = allThemes[0] ?? null
    return {
      primary: { label: '主炒题材待确认', name: null, tone: 'unresolved' },
      secondary: firstStatic ? { label: '线索', name: firstStatic } : null,
      hiddenCount: Math.max(0, allThemes.length - (firstStatic ? 1 : 0)),
      totalCount: allThemes.length,
    }
  }
  const secondary = attribution.resonance[0]
    ? { label: '共振', name: attribution.resonance[0].name }
    : null
  const displayedNames = new Set([attribution.primary.name, secondary?.name].filter(Boolean))
  return {
    primary: {
      label: attribution.state === 'direct' ? '主炒' : '主炒线索',
      name: attribution.primary.name,
      tone: attribution.state === 'direct' ? 'direct' : 'inferred',
    },
    secondary,
    hiddenCount: allThemes.filter((name) => !displayedNames.has(name)).length,
    totalCount: allThemes.length,
  }
}

function formatEvidencePct(value: number | null): string {
  if (value == null) return '待补'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function formatEvidenceAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '待补'
  if (value >= 10000) return `${(value / 10000).toFixed(2)}亿`
  return `${value.toFixed(0)}万`
}

export function buildMorningAuctionFocusEvidence<Stock extends MorningAuctionBaseStock>(
  candidate: MorningAuctionCandidate<Stock>
): MorningAuctionFocusEvidence[] {
  const stock = candidate.stock
  const historyReady = stock.pctChg3d != null || stock.pctChg5d != null
  const attribution = stock.themeAttribution ?? null
  const conceptText = attribution?.primary
    ? `${attribution.summary}${attribution.directReason ? ` 上一交易日原因：${attribution.directReason}` : ''}`
    : stock.conceptNames.length > 0
      ? `已找到 ${stock.conceptNames.length} 项静态关联题材，但缺少直接原因或竞价共振，主炒题材仍待确认。`
    : '当前没有可用题材归因, 题材共振证据仍受阻。'

  return [
    {
      key: 'auction',
      label: '竞价强度',
      text: `竞价涨幅 ${formatEvidencePct(stock.pctChg)}, 竞价金额 ${formatEvidenceAmount(stock.auctionAmount)}, 换手率 ${stock.auctionTurnover.toFixed(2)}%; 当前属于${candidate.poolLabel}。`,
    },
    {
      key: 'momentum',
      label: '近期持续性',
      text: historyReady
        ? `3日涨跌 ${formatEvidencePct(stock.pctChg3d)}, 5日涨跌 ${formatEvidencePct(stock.pctChg5d)}, 需结合价格位置和筹码状态继续验证。`
        : '3日与5日涨跌尚未补齐, 当前无法确认近期持续性。',
    },
    {
      key: 'concept',
      label: '题材线索',
      text: conceptText,
    },
  ]
}

function getChipKey(tsCode: string): string {
  return tsCode.includes('.') ? tsCode : tsCode.slice(0, 6)
}

function buildCandidate<Stock extends MorningAuctionBaseStock>(
  stock: Stock,
  config: PoolConfig,
  chipEntry: MorningAuctionChipEntry | null
): MorningAuctionCandidate<Stock> {
  const amountScore = Math.min(28, Math.log10(Math.max(stock.auctionAmount, 1)) * 4)
  const turnoverScore = Math.min(22, Math.max(0, stock.auctionTurnover) * 7)
  const momentumScore = Math.min(20, Math.max(0, stock.pctChg) * 1.2)
  const currentScore = Math.min(12, Math.max(0, stock.currentPctChg ?? 0) * 0.7)
  const chipScore = hasSameDayChipEvidence(chipEntry) ? 8 : 0
  const themeScore = stock.themeAttribution?.state === 'direct'
    ? stock.themeAttribution.confidence === 'high' ? 8 : 6
    : stock.themeAttribution?.state === 'resonance' ? 4 : 0
  const rankScore = Math.round(config.baseScore + amountScore + turnoverScore + momentumScore + currentScore + chipScore + themeScore)

  const tags = [config.label]
  if (stock.themeAttribution?.primary?.name) tags.push(stock.themeAttribution.primary.name)
  else if (stock.conceptNames[0]) tags.push(stock.conceptNames[0])
  if ((stock.currentPctChg ?? stock.pctChg) >= 9.8) tags.push('现价涨停')
  if (stock.pctChg3d != null && stock.pctChg3d > 8) tags.push('近3日强势')
  if (hasSameDayChipEvidence(chipEntry)) tags.push('同日筹码')
  else if (chipEntry?.dateRelation === 'history' && hasChipSignal(chipEntry)) tags.push('历史筹码参考')

  const riskFlags: string[] = []
  if (/ST/i.test(stock.stockName)) riskFlags.push('ST 风险')
  if (stock.pctChg >= 9.5 && stock.auctionTurnover < 0.2) riskFlags.push('一字流动性')
  if (stock.pctChg5d != null && stock.pctChg5d > 25) riskFlags.push('短期涨幅偏高')
  if (hasSameDayChipEvidence(chipEntry) && chipEntry?.loosening1d != null && chipEntry.loosening1d > 12) riskFlags.push('筹码松动')

  const verificationItems = [
    stock.currentPctChg == null ? '等待实时涨幅确认' : '确认现价承接是否延续',
    stock.themeAttribution?.primary
      ? '观察主驱动题材是否继续扩散'
      : stock.conceptNames.length === 0 ? '补充题材归因' : '等待直接原因或竞价共振确认主炒题材',
    hasSameDayChipEvidence(chipEntry)
      ? '复核同日筹码结论与竞价方向是否一致'
      : chipEntry?.dateRelation === 'history'
        ? `仅有 ${chipEntry.tradeDate ?? '历史'} 筹码证据, 不作为当日确认项`
        : '可同步筹码后复核底部筹码',
  ]
  if (stock.pctChg3d == null || stock.pctChg5d == null) verificationItems.push('等待 3日/5日涨跌补齐')

  return {
    id: `${config.group}:${config.key}:${stock.tsCode}`,
    stock,
    group: config.group,
    poolKey: config.key,
    poolLabel: config.label,
    signalLabel: config.signalLabel,
    reason: config.reason,
    rankScore,
    tags,
    riskFlags,
    verificationItems,
    chipEntry,
  }
}

function pushPool<Stock extends MorningAuctionBaseStock>(
  candidates: Array<MorningAuctionCandidate<Stock>>,
  stats: MorningAuctionPoolStat[],
  rows: Stock[],
  config: PoolConfig,
  chipDataMap: Map<string, MorningAuctionChipEntry>
): void {
  const sorted = [...rows].sort((left, right) => {
    const leftPower = left.auctionAmount * Math.max(left.auctionTurnover, 0.01)
    const rightPower = right.auctionAmount * Math.max(right.auctionTurnover, 0.01)
    return rightPower - leftPower
  })

  for (const stock of sorted) {
    const chipEntry = chipDataMap.get(stock.tsCode) ?? chipDataMap.get(getChipKey(stock.tsCode)) ?? null
    candidates.push(buildCandidate(stock, config, chipEntry))
  }

  const lead = sorted[0]
  stats.push({
    key: config.key,
    label: config.label,
    count: rows.length,
    leadStockName: lead?.stockName ?? '暂无',
    leadPctChg: lead ? lead.pctChg : null,
    description: config.description,
  })
}

export function buildMorningAuctionWorkbench<Stock extends MorningAuctionBaseStock>(
  snapshot: MorningAuctionSnapshotLike<Stock> | null,
  chipDataMap: Map<string, MorningAuctionChipEntry>
): MorningAuctionWorkbench<Stock> {
  if (!snapshot) {
    return {
      candidates: [],
      poolStats: [],
      totalCandidates: 0,
      limitUpCount: 0,
      highIntentCount: 0,
      chipCoveredCount: 0,
      missingHistoryCount: 0,
    }
  }

  const candidates: Array<MorningAuctionCandidate<Stock>> = []
  const poolStats: MorningAuctionPoolStat[] = []

  pushPool(candidates, poolStats, snapshot.threeOne.brokenBoard, {
    group: 'threeOne', key: 'brokenBoard', label: '炸板修复', signalLabel: '竞价双第一', baseScore: 22,
    description: '昨日炸板后今日竞价高开, 观察修复资金是否回流。',
    reason: '昨日炸板后仍有资金在竞价阶段回补, 适合先看承接强度。'
  }, chipDataMap)
  pushPool(candidates, poolStats, snapshot.threeOne.firstBoard, {
    group: 'threeOne', key: 'firstBoard', label: '首板续强', signalLabel: '竞价双第一', baseScore: 26,
    description: '昨日首板, 今日竞价继续强势, 关注题材扩散。',
    reason: '首板后竞价继续靠前, 代表短线资金愿意给二次确认。'
  }, chipDataMap)
  pushPool(candidates, poolStats, snapshot.threeOne.secondBoard, {
    group: 'threeOne', key: 'secondBoard', label: '连板晋级', signalLabel: '竞价双第一', baseScore: 29,
    description: '二板及以上候选, 弹性高同时波动更大。',
    reason: '连板股竞价继续强势, 需要重点验证封单与分歧承接。'
  }, chipDataMap)
  pushPool(candidates, poolStats, snapshot.threeOne.brokenConsec, {
    group: 'threeOne', key: 'brokenConsec', label: '断板回流', signalLabel: '竞价双第一', baseScore: 20,
    description: '连板断开后尝试回流, 先看修复质量。',
    reason: '断板后竞价再度活跃, 可能是高标资金回流, 也可能只是反抽。'
  }, chipDataMap)
  pushPool(candidates, poolStats, snapshot.threeOne.allMarket, {
    group: 'allMarket', key: 'allMarket', label: '全市场异动', signalLabel: '竞价异动', baseScore: 18,
    description: '非涨停池的全市场竞价放量高开候选。',
    reason: '全市场范围内竞价金额和换手同时放大, 适合作为盘前扩展观察池。'
  }, chipDataMap)

  const weakPools: Array<[Stock[], PoolConfig]> = [
    [snapshot.weakToStrong.badBoard, { group: 'weakToStrong', key: 'badBoard', label: '烂板转强', signalLabel: '弱转强', baseScore: 24, description: '昨日分歧重, 今日竞价转强。', reason: '昨日多次开板后今日竞价转强, 重点看分歧后的主动修复。' }],
    [snapshot.weakToStrong.tailAttack, { group: 'weakToStrong', key: 'tailAttack', label: '尾盘偷袭', signalLabel: '弱转强', baseScore: 21, description: '尾盘封板后次日竞价确认。', reason: '尾盘封板股次日继续积极, 需要验证是否不是一日游。' }],
    [snapshot.weakToStrong.brokenBoard, { group: 'weakToStrong', key: 'weakBrokenBoard', label: '断板转强', signalLabel: '弱转强', baseScore: 25, description: '断板后重新获得竞价资金。', reason: '断板后重新转强, 适合观察资金是否重新选择该方向。' }],
    [snapshot.weakToStrong.afternoonReseal, { group: 'weakToStrong', key: 'afternoonReseal', label: '午后回封', signalLabel: '弱转强', baseScore: 23, description: '午后回封次日延续。', reason: '午后回封后竞价延续, 关注是否有板块共振配合。' }],
    [snapshot.weakToStrong.reversal, { group: 'weakToStrong', key: 'reversal', label: '反包转强', signalLabel: '弱转强', baseScore: 20, description: '昨日大跌后竞价反包。', reason: '反包形态波动大, 需要优先排查消息和流动性风险。' }],
  ]
  for (const [rows, config] of weakPools) pushPool(candidates, poolStats, rows, config, chipDataMap)

  const boardPools: Array<[Stock[], PoolConfig]> = [
    [snapshot.boardCategory.first, { group: 'boardCategory', key: 'boardFirst', label: '首板板态', signalLabel: '板态分类', baseScore: 14, description: '首板池, 看弹性与题材宽度。', reason: '首板池提供题材发酵线索, 需要结合竞价金额筛选。' }],
    [snapshot.boardCategory.second, { group: 'boardCategory', key: 'boardSecond', label: '二板板态', signalLabel: '板态分类', baseScore: 16, description: '二板池, 看晋级梯队。', reason: '二板池代表接力梯队, 需要核对封单和昨日分歧。' }],
    [snapshot.boardCategory.third, { group: 'boardCategory', key: 'boardThird', label: '三板板态', signalLabel: '板态分类', baseScore: 18, description: '三板池, 进入高度竞争。', reason: '三板股已进入高度竞争, 需要重点观察分歧承接。' }],
    [snapshot.boardCategory.n, { group: 'boardCategory', key: 'boardN', label: '高标板态', signalLabel: '板态分类', baseScore: 19, description: '四板及以上, 弹性与风险都高。', reason: '高标股情绪代表性强, 需要优先排查高位回撤风险。' }],
  ]
  for (const [rows, config] of boardPools) pushPool(candidates, poolStats, rows, config, chipDataMap)

  candidates.sort((left, right) => right.rankScore - left.rankScore)

  const uniqueStocks = new Map<string, MorningAuctionCandidate<Stock>>()
  for (const candidate of candidates) {
    if (!uniqueStocks.has(candidate.stock.tsCode)) uniqueStocks.set(candidate.stock.tsCode, candidate)
  }
  const uniqueCandidates = [...uniqueStocks.values()]

  return {
    candidates: uniqueCandidates,
    poolStats,
    totalCandidates: uniqueCandidates.length,
    limitUpCount: uniqueCandidates.filter(item => (item.stock.currentPctChg ?? item.stock.pctChg) >= 9.8).length,
    highIntentCount: uniqueCandidates.filter(item => item.stock.auctionAmount >= 500 && item.stock.auctionTurnover >= 0.15).length,
    chipCoveredCount: uniqueCandidates.filter(item => hasSameDayChipEvidence(item.chipEntry)).length,
    missingHistoryCount: uniqueCandidates.filter(item => item.stock.pctChg3d == null || item.stock.pctChg5d == null).length,
  }
}
