export const SECOND_BOARD_STRATEGY_KEY = 'shortTerm.secondBoardLeader'
export const SECOND_BOARD_STRATEGY_VERSION = '2.0.0'

export type SecondBoardDataMode = 'realtime' | 'eod' | 'fallback'
export type SecondBoardTier = 'core' | 'contender' | 'fragile' | 'insufficient'
export type SecondBoardDataStatus = 'complete' | 'partial' | 'insufficient'
export type SecondBoardStance = 'formed' | 'selective' | 'defensive' | 'insufficient'
export type SecondBoardDimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'

export interface SecondBoardJudgmentInput {
  tsCode: string
  stockCode: string
  stockName: string
  pctChg: number | null
  limitTimes: number | null
  firstTime: string | null
  lastTime: string | null
  openTimes: number | null
  fundAmount: number | null
  turnoverRatio: number | null
  prevTurnoverRatio: number | null
  conceptName: string | null
  conceptLimitUpCount: number | null
  hasDumpInstWarning: boolean
  dumpInstDesc: string | null
  dataMode: SecondBoardDataMode
}

export interface SecondBoardThemeContext {
  name: string
  consecutiveCount: number
  limitUpCount: number | null
  maxBoards: number | null
  heightLevels: number[]
  ladderDepth: number
  supportCount: number | null
  formed: boolean
}

export interface SecondBoardDimension {
  key: 'boardPosition' | 'stability' | 'seal' | 'turnover' | 'themeLadder'
  label: string
  score: number | null
  maxScore: number
  status: SecondBoardDimensionStatus
  value: string
  detail: string
}

export interface SecondBoardStockJudgment {
  tier: SecondBoardTier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  dataStatus: SecondBoardDataStatus
  completeness: number
  missingFields: string[]
  dimensions: SecondBoardDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
  theme: SecondBoardThemeContext | null
}

export interface SecondBoardEvaluatedStock extends SecondBoardJudgmentInput {
  judgment: SecondBoardStockJudgment
}

export interface SecondBoardWorkbenchJudgment {
  stance: SecondBoardStance
  title: string
  summary: string
  dataStatus: SecondBoardDataStatus
  completeness: number
  missingFields: string[]
  highestBoard: number | null
  heightDistribution: Array<{ boards: number; count: number }>
  coreCount: number
  contenderCount: number
  fragileCount: number
  insufficientCount: number
  formedThemeCount: number
  isolatedHighCount: number
  themes: SecondBoardThemeContext[]
  strategyVersion: string
}

export interface SecondBoardEvaluation {
  stocks: SecondBoardEvaluatedStock[]
  workbench: SecondBoardWorkbenchJudgment
}

interface ScoredDimension extends SecondBoardDimension {
  missingFields?: string[]
}

function finite(value: number | null): value is number {
  return value != null && Number.isFinite(value)
}

function validTime(value: string | null): string | null {
  if (!value) return null
  const match = /^(\d{2}):?(\d{2})/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 9 || hour > 15 || minute < 0 || minute > 59) return null
  return `${match[1]}:${match[2]}`
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function statusFor(completeness: number): SecondBoardDataStatus {
  if (completeness >= 100) return 'complete'
  if (completeness >= 60) return 'partial'
  return 'insufficient'
}

function validConcept(value: string | null): value is string {
  return value != null && value.trim() !== '' && value !== '无题材' && value !== '题材待补'
}

export function buildSecondBoardThemeContexts(inputs: SecondBoardJudgmentInput[]): Map<string, SecondBoardThemeContext> {
  const groups = new Map<string, SecondBoardJudgmentInput[]>()
  for (const stock of inputs) {
    if (!validConcept(stock.conceptName)) continue
    const group = groups.get(stock.conceptName) ?? []
    group.push(stock)
    groups.set(stock.conceptName, group)
  }

  const contexts = new Map<string, SecondBoardThemeContext>()
  for (const [name, group] of groups) {
    const heights = unique(group
      .map((stock) => finite(stock.limitTimes) && stock.limitTimes >= 2 ? String(Math.round(stock.limitTimes)) : '')
      .filter(Boolean))
      .map(Number)
      .sort((left, right) => right - left)
    const knownLimitUpCounts = group
      .map((stock) => stock.conceptLimitUpCount)
      .filter((value): value is number => finite(value) && value > 0)
    const limitUpCount = knownLimitUpCounts.length > 0 ? Math.max(...knownLimitUpCounts.map(Math.round)) : null
    const consecutiveCount = group.length
    const supportCount = limitUpCount == null ? null : Math.max(0, limitUpCount - consecutiveCount)
    contexts.set(name, {
      name,
      consecutiveCount,
      limitUpCount,
      maxBoards: heights[0] ?? null,
      heightLevels: heights,
      ladderDepth: heights.length,
      supportCount,
      formed: heights.length > 0 && consecutiveCount >= 2 && (heights.length >= 2 || (limitUpCount ?? 0) >= 3),
    })
  }
  return contexts
}

function boardPositionDimension(stock: SecondBoardJudgmentInput, marketHighestBoard: number | null): ScoredDimension {
  if (!finite(stock.limitTimes) || stock.limitTimes < 2) {
    return {
      key: 'boardPosition', label: '梯队位置', score: null, maxScore: 20, status: 'unknown',
      value: '待盘后', detail: '当前来源尚不能确认准确连板高度', missingFields: ['连板高度'],
    }
  }
  const boards = Math.round(stock.limitTimes)
  const isHighest = marketHighestBoard != null && boards === marketHighestBoard
  if (boards <= 2) {
    return { key: 'boardPosition', label: '梯队位置', score: 12, maxScore: 20, status: 'neutral', value: '二板', detail: '处于连板晋级起点，需要更高梯队继续验证' }
  }
  if (boards <= 4) {
    return { key: 'boardPosition', label: '梯队位置', score: isHighest ? 20 : 18, maxScore: 20, status: 'strong', value: `${boards}板${isHighest ? ' · 最高板' : ''}`, detail: isHighest ? '位于当前市场最高连板梯队' : '处于辨识度较高的中高位梯队' }
  }
  return { key: 'boardPosition', label: '梯队位置', score: 15, maxScore: 20, status: 'neutral', value: `${boards}板${isHighest ? ' · 最高板' : ''}`, detail: '高度辨识度高，同时需要防范高位分歧' }
}

function stabilityDimension(stock: SecondBoardJudgmentInput): ScoredDimension {
  const firstTime = validTime(stock.firstTime)
  const openTimes = finite(stock.openTimes) && stock.openTimes >= 0 ? Math.round(stock.openTimes) : null
  const missing: string[] = []
  if (!firstTime) missing.push('首次封板时间')
  if (openTimes == null) missing.push('开板次数')
  if (!firstTime || openTimes == null) {
    return {
      key: 'stability', label: '封板稳定性', score: null, maxScore: 20, status: 'unknown',
      value: '待补', detail: '首次封板时间或开板次数尚未完整', missingFields: missing,
    }
  }
  const [hour, minute] = firstTime.split(':').map(Number)
  const timeValue = hour * 60 + minute
  if (openTimes === 0 && timeValue < 10 * 60 + 30) {
    return { key: 'stability', label: '封板稳定性', score: 20, maxScore: 20, status: 'strong', value: `${firstTime} · 未开板`, detail: '早段封板且未出现开板记录' }
  }
  if (openTimes <= 1 && timeValue <= 11 * 60 + 30) {
    return { key: 'stability', label: '封板稳定性', score: 15, maxScore: 20, status: 'neutral', value: `${firstTime} · ${openTimes}次开板`, detail: '上午完成封板，稳定性仍需持续确认' }
  }
  if (openTimes <= 2) {
    return { key: 'stability', label: '封板稳定性', score: 9, maxScore: 20, status: 'weak', value: `${firstTime} · ${openTimes}次开板`, detail: '封板偏晚或已出现多次分歧' }
  }
  return { key: 'stability', label: '封板稳定性', score: 3, maxScore: 20, status: 'weak', value: `${firstTime} · ${openTimes}次开板`, detail: '反复开板，连板结构明显脆弱' }
}

function sealDimension(stock: SecondBoardJudgmentInput): ScoredDimension {
  if (!finite(stock.fundAmount) || stock.fundAmount <= 0) {
    return {
      key: 'seal', label: '封单承接', score: null, maxScore: 20, status: 'unknown',
      value: '待补', detail: '当前来源没有可确认的封单金额', missingFields: ['封单金额'],
    }
  }
  const amount = stock.fundAmount
  const value = amount >= 10_000 ? `${(amount / 10_000).toFixed(2)}亿` : `${Math.round(amount)}万`
  if (amount >= 10_000) return { key: 'seal', label: '封单承接', score: 20, maxScore: 20, status: 'strong', value, detail: '封单金额达到1亿元以上' }
  if (amount >= 5_000) return { key: 'seal', label: '封单承接', score: 17, maxScore: 20, status: 'strong', value, detail: '封单承接处于较强区间' }
  if (amount >= 2_000) return { key: 'seal', label: '封单承接', score: 12, maxScore: 20, status: 'neutral', value, detail: '封单金额中等，需要结合开板次数判断' }
  if (amount >= 500) return { key: 'seal', label: '封单承接', score: 7, maxScore: 20, status: 'weak', value, detail: '封单承接偏弱' }
  return { key: 'seal', label: '封单承接', score: 3, maxScore: 20, status: 'weak', value, detail: '封单金额较低，开板风险较高' }
}

function turnoverDimension(stock: SecondBoardJudgmentInput): ScoredDimension {
  if (!finite(stock.turnoverRatio) || stock.turnoverRatio <= 0 || !finite(stock.prevTurnoverRatio) || stock.prevTurnoverRatio <= 0) {
    const missing: string[] = []
    if (!finite(stock.turnoverRatio) || stock.turnoverRatio <= 0) missing.push('当日换手率')
    if (!finite(stock.prevTurnoverRatio) || stock.prevTurnoverRatio <= 0) missing.push('前日换手率')
    return {
      key: 'turnover', label: '换手结构', score: null, maxScore: 20, status: 'unknown',
      value: '待补', detail: '当日与前日换手率尚未形成可比数据', missingFields: missing,
    }
  }
  const ratio = stock.turnoverRatio / stock.prevTurnoverRatio
  const value = `${stock.prevTurnoverRatio.toFixed(1)}% → ${stock.turnoverRatio.toFixed(1)}%`
  if (ratio >= 0.75 && ratio <= 1.5) return { key: 'turnover', label: '换手结构', score: 20, maxScore: 20, status: 'strong', value, detail: '换手变化相对均衡，未出现极端扩张或收缩' }
  if (ratio >= 0.5 && ratio <= 2) return { key: 'turnover', label: '换手结构', score: 13, maxScore: 20, status: 'neutral', value, detail: '换手变化可解释，但仍需观察承接质量' }
  return { key: 'turnover', label: '换手结构', score: 5, maxScore: 20, status: 'weak', value, detail: ratio > 2 ? '换手显著放大，分歧加剧' : '换手显著收缩，真实承接证据有限' }
}

function themeLadderDimension(stock: SecondBoardJudgmentInput, theme: SecondBoardThemeContext | null): ScoredDimension {
  if (!validConcept(stock.conceptName) || !theme) {
    return {
      key: 'themeLadder', label: '题材梯队', score: null, maxScore: 20, status: 'unknown',
      value: '待补', detail: '主题材或同题材连板样本尚未确认', missingFields: ['题材梯队'],
    }
  }
  const broad = theme.limitUpCount == null ? '涨停广度待补' : `${theme.limitUpCount}只涨停`
  const value = `${theme.consecutiveCount}只连板 · ${broad}`
  if (theme.formed) return { key: 'themeLadder', label: '题材梯队', score: 20, maxScore: 20, status: 'strong', value, detail: `题材形成${theme.ladderDepth}层高度与同方向助攻` }
  if (theme.consecutiveCount >= 2 || (theme.limitUpCount ?? 0) >= 3) return { key: 'themeLadder', label: '题材梯队', score: 13, maxScore: 20, status: 'neutral', value, detail: '题材存在共振，但高度梯队尚未完整' }
  return { key: 'themeLadder', label: '题材梯队', score: 4, maxScore: 20, status: 'weak', value, detail: '当前属于孤立连板，缺少同题材梯队验证' }
}

export function judgeSecondBoardStock(
  stock: SecondBoardJudgmentInput,
  theme: SecondBoardThemeContext | null,
  marketHighestBoard: number | null,
): SecondBoardStockJudgment {
  const dimensions: ScoredDimension[] = [
    boardPositionDimension(stock, marketHighestBoard),
    stabilityDimension(stock),
    sealDimension(stock),
    turnoverDimension(stock),
    themeLadderDimension(stock, theme),
  ]
  const available = dimensions.filter((dimension) => dimension.score != null)
  const completeness = Math.round(available.length / dimensions.length * 100)
  const dataStatus = statusFor(completeness)
  const totalScore = available.length === 0
    ? null
    : Math.round(available.reduce((sum, dimension) => sum + (dimension.score ?? 0), 0) / available.reduce((sum, dimension) => sum + dimension.maxScore, 0) * 100)
  const repeatedOpenRisk = finite(stock.openTimes) && stock.openTimes >= 3
  const hardRisk = repeatedOpenRisk || stock.hasDumpInstWarning

  let tier: SecondBoardTier
  if (hardRisk) tier = 'fragile'
  else if (dataStatus === 'insufficient') tier = 'insufficient'
  else if (totalScore != null && totalScore >= 72 && theme?.formed && finite(stock.limitTimes)) tier = 'core'
  else if (totalScore != null && totalScore >= 52) tier = 'contender'
  else tier = 'fragile'

  const evidence = dimensions
    .filter((dimension) => dimension.status === 'strong' || dimension.status === 'neutral')
    .map((dimension) => `${dimension.label}：${dimension.detail}`)
  const risks = dimensions
    .filter((dimension) => dimension.status === 'weak')
    .map((dimension) => `${dimension.label}：${dimension.detail}`)
  if (stock.hasDumpInstWarning) risks.unshift(stock.dumpInstDesc ?? '龙虎榜出现机构卖出压力')
  const missingFields = unique(dimensions.flatMap((dimension) => dimension.missingFields ?? []))
  for (const field of missingFields) risks.push(`${field}缺失，当前结论已降低置信度`)

  const confirmations: string[] = []
  if (!finite(stock.limitTimes)) confirmations.push('等待盘后榜单确认准确连板高度')
  if (!validTime(stock.firstTime) || !finite(stock.openTimes)) confirmations.push('等待首次封板时间与开板次数补齐')
  if (!finite(stock.turnoverRatio) || !finite(stock.prevTurnoverRatio)) confirmations.push('等待连续两日换手率形成可比结构')
  if (!theme?.formed) confirmations.push('观察同题材是否补出连板梯队或更多涨停助攻')
  if (confirmations.length === 0) confirmations.push('观察收盘前封单与题材助攻是否保持，次日竞价能否延续承接')

  const invalidations = unique([
    '后续反复开板达到3次及以上',
    '同题材连板梯队断层且高标转为孤立',
    finite(stock.fundAmount) ? '封单金额显著下降且无法快速恢复' : '补齐封单后确认承接明显不足',
    stock.hasDumpInstWarning ? '龙虎榜机构卖出压力继续扩大' : '',
  ])

  const title = tier === 'core'
    ? '题材梯队核心候选'
    : tier === 'contender'
      ? '梯队竞争候选'
      : tier === 'fragile'
        ? '连板结构脆弱'
        : '关键证据待补'
  const summary = totalScore == null
    ? '关键字段尚未形成可复算结论。'
    : `${available.length}/5项研判维度可用，结构质量${totalScore}分${hardRisk ? '，硬风险已触发降级' : '。'}`

  return {
    tier,
    title,
    summary,
    totalScore,
    confidence: completeness,
    dataStatus,
    completeness,
    missingFields,
    dimensions,
    evidence: unique(evidence),
    risks: unique(risks),
    confirmations: unique(confirmations),
    invalidations,
    theme,
  }
}

function compareEvaluated(left: SecondBoardEvaluatedStock, right: SecondBoardEvaluatedStock): number {
  const rank: Record<SecondBoardTier, number> = { core: 0, contender: 1, fragile: 2, insufficient: 3 }
  return rank[left.judgment.tier] - rank[right.judgment.tier]
    || (right.limitTimes ?? -1) - (left.limitTimes ?? -1)
    || (right.judgment.totalScore ?? -1) - (left.judgment.totalScore ?? -1)
    || (right.fundAmount ?? -1) - (left.fundAmount ?? -1)
    || left.tsCode.localeCompare(right.tsCode)
}

export function evaluateSecondBoardWorkbench(inputs: SecondBoardJudgmentInput[]): SecondBoardEvaluation {
  const contexts = buildSecondBoardThemeContexts(inputs)
  const heights = inputs.map((stock) => stock.limitTimes).filter((value): value is number => finite(value) && value >= 2).map(Math.round)
  const highestBoard = heights.length > 0 ? Math.max(...heights) : null
  const stocks = inputs.map((stock) => ({
    ...stock,
    judgment: judgeSecondBoardStock(stock, validConcept(stock.conceptName) ? (contexts.get(stock.conceptName) ?? null) : null, highestBoard),
  })).sort(compareEvaluated)

  if (stocks.length === 0) {
    return {
      stocks,
      workbench: {
        stance: 'insufficient', title: '当前没有二板及以上样本', summary: '可能是事实日没有连板，也可能是盘后涨停榜尚未准备。',
        dataStatus: 'insufficient', completeness: 0, missingFields: [], highestBoard: null, heightDistribution: [],
        coreCount: 0, contenderCount: 0, fragileCount: 0, insufficientCount: 0, formedThemeCount: 0, isolatedHighCount: 0,
        themes: [], strategyVersion: SECOND_BOARD_STRATEGY_VERSION,
      },
    }
  }

  const coreCount = stocks.filter((stock) => stock.judgment.tier === 'core').length
  const contenderCount = stocks.filter((stock) => stock.judgment.tier === 'contender').length
  const fragileCount = stocks.filter((stock) => stock.judgment.tier === 'fragile').length
  const insufficientCount = stocks.filter((stock) => stock.judgment.tier === 'insufficient').length
  const completeness = Math.round(stocks.reduce((sum, stock) => sum + stock.judgment.completeness, 0) / stocks.length)
  const dataStatus = statusFor(completeness)
  const themes = [...contexts.values()].sort((left, right) => (
    Number(right.formed) - Number(left.formed)
    || (right.maxBoards ?? -1) - (left.maxBoards ?? -1)
    || right.consecutiveCount - left.consecutiveCount
    || (right.limitUpCount ?? -1) - (left.limitUpCount ?? -1)
    || left.name.localeCompare(right.name, 'zh-CN')
  ))
  const formedThemeCount = themes.filter((theme) => theme.formed).length
  const isolatedHighCount = highestBoard == null ? 0 : stocks.filter((stock) => stock.limitTimes === highestBoard && (stock.judgment.theme?.consecutiveCount ?? 0) <= 1).length
  const heightDistribution = [...new Set(heights)].sort((left, right) => right - left).map((boards) => ({ boards, count: heights.filter((height) => height === boards).length }))

  let stance: SecondBoardStance
  if (dataStatus === 'insufficient') stance = 'insufficient'
  else if (coreCount > 0 && formedThemeCount > 0) stance = 'formed'
  else if (contenderCount > 0 || coreCount > 0) stance = 'selective'
  else stance = 'defensive'
  const title = stance === 'formed'
    ? '连板梯队已形成，存在核心候选'
    : stance === 'selective'
      ? '连板梯队分化，等待题材竞争确认'
      : stance === 'defensive'
        ? '连板结构偏脆弱，暂以防守观察为主'
        : '关键事实不足，等待盘后确认梯队'
  const highestText = highestBoard == null ? '最高板待确认' : `最高${highestBoard}板`
  const summary = `${highestText}，${heightDistribution.length}个高度层；成形题材${formedThemeCount}个，核心${coreCount}只、竞争${contenderCount}只、脆弱${fragileCount}只、待补${insufficientCount}只；数据完整度${completeness}%。`

  return {
    stocks,
    workbench: {
      stance, title, summary, dataStatus, completeness,
      missingFields: unique(stocks.flatMap((stock) => stock.judgment.missingFields)),
      highestBoard, heightDistribution, coreCount, contenderCount, fragileCount, insufficientCount,
      formedThemeCount, isolatedHighCount, themes, strategyVersion: SECOND_BOARD_STRATEGY_VERSION,
    },
  }
}
