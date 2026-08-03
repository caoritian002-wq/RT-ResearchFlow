export const LIMIT_BOARD_STRATEGY_KEY = 'shortTerm.limitBoardMonitor'
export const LIMIT_BOARD_STRATEGY_VERSION = '2.0.0'

export type LimitBoardDataMode = 'realtime' | 'eod'
export type LimitBoardQualityTier = 'focus' | 'watch' | 'fragile'
export type LimitBoardDataStatus = 'complete' | 'partial' | 'insufficient'
export type LimitBoardWorkbenchStance = 'focus' | 'selective' | 'defensive' | 'insufficient'
export type LimitBoardDimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'

export interface LimitBoardJudgmentInput {
  tsCode: string
  stockCode: string
  stockName: string
  limitTime: string
  limitPrice: number
  pctChg: number
  fundAmount: number
  openTimes: number
  limitTimes: number
  conceptName: string
  conceptZtNum: number
  hasDumpInstWarning: boolean
  dumpInstDesc: string | null
  dataMode: LimitBoardDataMode
}

export interface LimitBoardQualityDimension {
  key: 'time' | 'stability' | 'seal' | 'theme' | 'boardPosition'
  label: string
  score: number | null
  maxScore: number
  status: LimitBoardDimensionStatus
  value: string
  detail: string
}

export interface LimitBoardStockQuality {
  tier: LimitBoardQualityTier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  dataStatus: LimitBoardDataStatus
  completeness: number
  missingFields: string[]
  dimensions: LimitBoardQualityDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
}

export interface LimitBoardThemeSummary {
  name: string
  stockCount: number
  focusCount: number
  watchCount: number
  averageScore: number | null
}

export interface LimitBoardWorkbenchJudgment {
  stance: LimitBoardWorkbenchStance
  title: string
  summary: string
  dataStatus: LimitBoardDataStatus
  completeness: number
  missingFields: string[]
  focusCount: number
  watchCount: number
  fragileCount: number
  themes: LimitBoardThemeSummary[]
  strategyVersion: string
}

interface ScoredDimension extends LimitBoardQualityDimension {
  missingField?: string
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

function validLimitTime(value: string): string | null {
  const match = /^(\d{2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 9 || hour > 15 || minute < 0 || minute > 59) return null
  return `${match[1]}:${match[2]}`
}

function timeDimension(stock: LimitBoardJudgmentInput): ScoredDimension {
  const time = validLimitTime(stock.limitTime)
  if (!time) {
    return {
      key: 'time', label: '封板时间', score: null, maxScore: 25, status: 'unknown',
      value: '待补', detail: '分钟数据尚未给出首次封板时间', missingField: '首次封板时间',
    }
  }
  const [hour, minute] = time.split(':').map(Number)
  const total = hour * 60 + minute
  if (total < 10 * 60 + 30) {
    return { key: 'time', label: '封板时间', score: 25, maxScore: 25, status: 'strong', value: time, detail: '10:30前封板，时间结构较强' }
  }
  if (total <= 11 * 60 + 30) {
    return { key: 'time', label: '封板时间', score: 17, maxScore: 25, status: 'neutral', value: time, detail: '上午后段封板，仍需观察稳定性' }
  }
  return { key: 'time', label: '封板时间', score: 8, maxScore: 25, status: 'weak', value: time, detail: '午后封板，持续性证据相对偏弱' }
}

function stabilityDimension(stock: LimitBoardJudgmentInput): ScoredDimension {
  if (!finite(stock.openTimes) || stock.openTimes < 0) {
    return {
      key: 'stability', label: '封板稳定性', score: null, maxScore: 25, status: 'unknown',
      value: '待补', detail: '分钟数据尚未给出开板次数', missingField: '开板次数',
    }
  }
  if (stock.openTimes === 0) {
    return { key: 'stability', label: '封板稳定性', score: 25, maxScore: 25, status: 'strong', value: '未开板', detail: '当前未出现开板记录' }
  }
  if (stock.openTimes <= 2) {
    return {
      key: 'stability', label: '封板稳定性', score: stock.openTimes === 1 ? 18 : 12,
      maxScore: 25, status: 'neutral', value: `${stock.openTimes}次`, detail: '出现开板，需确认后续能否维持封单',
    }
  }
  return {
    key: 'stability', label: '封板稳定性', score: 3, maxScore: 25, status: 'weak',
    value: `${stock.openTimes}次`, detail: '反复开板，封板结构脆弱',
  }
}

function sealDimension(stock: LimitBoardJudgmentInput): ScoredDimension {
  if (!finite(stock.fundAmount) || stock.fundAmount <= 0) {
    return {
      key: 'seal', label: '封单承接', score: null, maxScore: 20, status: 'unknown',
      value: '待补', detail: '当前来源未提供可确认的封单金额', missingField: '封单金额',
    }
  }
  const amount = stock.fundAmount
  const value = amount >= 10_000 ? `${(amount / 10_000).toFixed(2)}亿` : `${Math.round(amount)}万`
  if (amount >= 10_000) return { key: 'seal', label: '封单承接', score: 20, maxScore: 20, status: 'strong', value, detail: '封单金额达到1亿元以上' }
  if (amount >= 5_000) return { key: 'seal', label: '封单承接', score: 16, maxScore: 20, status: 'strong', value, detail: '封单金额处于较强区间' }
  if (amount >= 2_000) return { key: 'seal', label: '封单承接', score: 12, maxScore: 20, status: 'neutral', value, detail: '封单金额中等，需结合开板次数判断' }
  if (amount >= 500) return { key: 'seal', label: '封单承接', score: 7, maxScore: 20, status: 'weak', value, detail: '封单金额偏低' }
  return { key: 'seal', label: '封单承接', score: 3, maxScore: 20, status: 'weak', value, detail: '封单金额较弱，开板风险较高' }
}

function themeDimension(stock: LimitBoardJudgmentInput): ScoredDimension {
  const hasTheme = stock.conceptName.trim() !== '' && stock.conceptName !== '无题材'
  if (!hasTheme || !finite(stock.conceptZtNum) || stock.conceptZtNum <= 0) {
    return {
      key: 'theme', label: '题材广度', score: null, maxScore: 20, status: 'unknown',
      value: '待补', detail: '尚未确认主题材及同题材涨停广度', missingField: '题材广度',
    }
  }
  const count = Math.round(stock.conceptZtNum)
  if (count >= 8) return { key: 'theme', label: '题材广度', score: 20, maxScore: 20, status: 'strong', value: `${stock.conceptName} · ${count}只`, detail: '同题材涨停广度突出' }
  if (count >= 5) return { key: 'theme', label: '题材广度', score: 16, maxScore: 20, status: 'strong', value: `${stock.conceptName} · ${count}只`, detail: '题材形成较强涨停共振' }
  if (count >= 3) return { key: 'theme', label: '题材广度', score: 12, maxScore: 20, status: 'neutral', value: `${stock.conceptName} · ${count}只`, detail: '题材存在一定涨停共振' }
  if (count === 2) return { key: 'theme', label: '题材广度', score: 8, maxScore: 20, status: 'neutral', value: `${stock.conceptName} · 2只`, detail: '题材只有有限跟随' }
  return { key: 'theme', label: '题材广度', score: 4, maxScore: 20, status: 'weak', value: `${stock.conceptName} · 1只`, detail: '题材涨停孤立，缺少同方向验证' }
}

function boardPositionDimension(stock: LimitBoardJudgmentInput): ScoredDimension {
  if (!finite(stock.limitTimes) || stock.limitTimes < 1) {
    return {
      key: 'boardPosition', label: '连板位置', score: null, maxScore: 10, status: 'unknown',
      value: '待补', detail: '尚未确认当前连板位置', missingField: '连板位置',
    }
  }
  const times = Math.round(stock.limitTimes)
  if (times === 1) return { key: 'boardPosition', label: '连板位置', score: 6, maxScore: 10, status: 'neutral', value: '首板', detail: '首板需要次日承接继续验证' }
  if (times === 2) return { key: 'boardPosition', label: '连板位置', score: 9, maxScore: 10, status: 'strong', value: '二板', detail: '进入连板确认阶段' }
  if (times <= 4) return { key: 'boardPosition', label: '连板位置', score: 10, maxScore: 10, status: 'strong', value: `${times}板`, detail: '处于连板辨识度较高区间' }
  return { key: 'boardPosition', label: '连板位置', score: 7, maxScore: 10, status: 'neutral', value: `${times}板`, detail: '高度较高，同时需要防范高位分歧' }
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function dataStatusFor(completeness: number): LimitBoardDataStatus {
  if (completeness >= 100) return 'complete'
  if (completeness >= 60) return 'partial'
  return 'insufficient'
}

export function judgeLimitBoardStock(stock: LimitBoardJudgmentInput): LimitBoardStockQuality {
  const dimensions: ScoredDimension[] = [
    timeDimension(stock),
    stabilityDimension(stock),
    sealDimension(stock),
    themeDimension(stock),
    boardPositionDimension(stock),
  ]
  const available = dimensions.filter((item) => item.score != null)
  const availableScore = available.reduce((sum, item) => sum + (item.score ?? 0), 0)
  const availableMax = available.reduce((sum, item) => sum + item.maxScore, 0)
  const completeness = Math.round(available.length / dimensions.length * 100)
  const dataStatus = dataStatusFor(completeness)
  const totalScore = availableMax > 0 ? Math.round(availableScore / availableMax * 100) : null
  const repeatedOpenRisk = finite(stock.openTimes) && stock.openTimes >= 3
  const hardRisk = repeatedOpenRisk || stock.hasDumpInstWarning

  let tier: LimitBoardQualityTier
  if (hardRisk) tier = 'fragile'
  else if (dataStatus !== 'insufficient' && totalScore != null && totalScore >= 75) tier = 'focus'
  else if (totalScore != null && totalScore >= 50) tier = 'watch'
  else tier = 'fragile'

  const evidence = dimensions
    .filter((item) => item.status === 'strong' || item.status === 'neutral')
    .map((item) => `${item.label}：${item.detail}`)
  const risks = dimensions
    .filter((item) => item.status === 'weak')
    .map((item) => `${item.label}：${item.detail}`)
  if (stock.hasDumpInstWarning) risks.unshift(stock.dumpInstDesc ?? '龙虎榜出现卖出压力风险')
  for (const field of dimensions.flatMap((item) => item.missingField ? [item.missingField] : [])) {
    risks.push(`${field}缺失，当前结论已降低置信度`)
  }

  const confirmations: string[] = []
  if (validLimitTime(stock.limitTime) == null || stock.openTimes < 0) confirmations.push('等待分钟数据补齐首次封板时间与开板次数')
  if (stock.fundAmount <= 0) confirmations.push('等待可确认的封单金额，避免把接口空值当作弱封单')
  if (stock.conceptName === '无题材' || stock.conceptZtNum <= 0) confirmations.push('等待主题材与同题材涨停家数完成映射')
  if (confirmations.length === 0) confirmations.push('观察收盘前封单是否保持，次日竞价是否出现同题材承接')

  const invalidations = unique([
    '后续反复开板达到3次及以上',
    '同题材涨停共振明显收缩或核心股率先开板',
    stock.fundAmount > 0 ? '封单金额显著下降且无法快速恢复' : '补齐封单后确认承接明显不足',
    stock.hasDumpInstWarning ? '龙虎榜卖出压力继续扩大' : '',
  ])

  const title = dataStatus === 'insufficient'
    ? '证据待补'
    : tier === 'focus'
      ? '封板结构较完整'
      : tier === 'watch'
        ? '选择性观察'
        : '封板结构脆弱'
  const summary = totalScore == null
    ? '关键字段尚未形成可复算结论。'
    : `${available.length}/5项关键事实可用，封板质量 ${totalScore} 分${hardRisk ? '，硬风险已触发降级' : '。'}`

  return {
    tier,
    title,
    summary,
    totalScore,
    confidence: completeness,
    dataStatus,
    completeness,
    missingFields: dimensions.flatMap((item) => item.missingField ? [item.missingField] : []),
    dimensions,
    evidence: unique(evidence),
    risks: unique(risks),
    confirmations: unique(confirmations),
    invalidations,
  }
}

export function buildLimitBoardWorkbenchJudgment(
  stocks: Array<Pick<LimitBoardJudgmentInput, 'conceptName'> & { quality: LimitBoardStockQuality }>,
): LimitBoardWorkbenchJudgment {
  if (stocks.length === 0) {
    return {
      stance: 'insufficient',
      title: '当前没有可研判的涨停样本',
      summary: '可能是事实日确实没有涨停，也可能是涨停榜数据尚未准备，请结合页面数据模式判断。',
      dataStatus: 'insufficient',
      completeness: 0,
      missingFields: [],
      focusCount: 0,
      watchCount: 0,
      fragileCount: 0,
      themes: [],
      strategyVersion: LIMIT_BOARD_STRATEGY_VERSION,
    }
  }

  const focusCount = stocks.filter((stock) => stock.quality.tier === 'focus').length
  const watchCount = stocks.filter((stock) => stock.quality.tier === 'watch').length
  const fragileCount = stocks.filter((stock) => stock.quality.tier === 'fragile').length
  const completeness = Math.round(stocks.reduce((sum, stock) => sum + stock.quality.completeness, 0) / stocks.length)
  const dataStatus = dataStatusFor(completeness)
  const themeMap = new Map<string, Array<(typeof stocks)[number]>>()
  for (const stock of stocks) {
    if (!stock.conceptName || stock.conceptName === '无题材') continue
    const group = themeMap.get(stock.conceptName) ?? []
    group.push(stock)
    themeMap.set(stock.conceptName, group)
  }
  const themes = [...themeMap.entries()].map(([name, group]) => {
    const scores = group.map((stock) => stock.quality.totalScore).filter((score): score is number => score != null)
    return {
      name,
      stockCount: group.length,
      focusCount: group.filter((stock) => stock.quality.tier === 'focus').length,
      watchCount: group.filter((stock) => stock.quality.tier === 'watch').length,
      averageScore: scores.length > 0 ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null,
    }
  }).sort((left, right) => (
    right.focusCount - left.focusCount
    || right.stockCount - left.stockCount
    || (right.averageScore ?? -1) - (left.averageScore ?? -1)
    || left.name.localeCompare(right.name, 'zh-CN')
  )).slice(0, 3)

  const focusThreshold = Math.max(2, Math.ceil(stocks.length * 0.15))
  let stance: LimitBoardWorkbenchStance
  if (dataStatus === 'insufficient') stance = 'insufficient'
  else if (focusCount >= focusThreshold) stance = 'focus'
  else if (focusCount > 0 || watchCount > 0) stance = 'selective'
  else stance = 'defensive'

  const title = stance === 'focus'
    ? '涨停池存在可重点跟踪的封板结构'
    : stance === 'selective'
      ? '涨停池分化，适合选择性观察'
      : stance === 'defensive'
        ? '涨停池封板结构偏脆弱'
        : '关键事实不足，暂不形成强结论'
  const missingFields = unique(stocks.flatMap((stock) => stock.quality.missingFields))
  const themeLead = themes[0]
  const summary = `共${stocks.length}只涨停股，重点${focusCount}只、观察${watchCount}只、脆弱${fragileCount}只；数据完整度${completeness}%${themeLead ? `。${themeLead.name}以${themeLead.stockCount}只形成当前最宽题材聚合` : '，尚未形成可确认的题材聚合'}。`

  return {
    stance,
    title,
    summary,
    dataStatus,
    completeness,
    missingFields,
    focusCount,
    watchCount,
    fragileCount,
    themes,
    strategyVersion: LIMIT_BOARD_STRATEGY_VERSION,
  }
}
