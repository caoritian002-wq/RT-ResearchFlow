export const FIRST_YIN_STRATEGY_KEY = 'shortTerm.firstYinDip'
export const FIRST_YIN_STRATEGY_VERSION = '2.0.0'

export type FirstYinDataMode = 'realtime' | 'eod' | 'fallback'
export type FirstYinState = 'divergence' | 'waiting' | 'confirmed' | 'failed' | 'insufficient'
export type FirstYinDataStatus = 'complete' | 'partial' | 'insufficient'
export type FirstYinStance = 'confirmed' | 'watch' | 'defensive' | 'insufficient'
export type FirstYinDimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'

export interface FirstYinJudgmentInput {
  tsCode: string
  stockCode: string
  stockName: string
  dataMode: FirstYinDataMode
  peakDate: string
  peakBoards: number | null
  peakClose: number | null
  peakTurnoverRate: number | null
  divergenceDate: string
  divergenceOpen: number | null
  divergenceHigh: number | null
  divergenceLow: number | null
  divergenceClose: number | null
  divergencePctChg: number | null
  divergenceTurnoverRate: number | null
  currentDate: string
  sessionsSinceDivergence: number
  currentPrice: number | null
  currentClose: number | null
  currentPctChg: number | null
  currentTurnoverRate: number | null
  currentIsClosed: boolean
  themeName: string | null
  themeLimitUpCount: number | null
}

export interface FirstYinMetrics {
  isYin: boolean | null
  divergenceClosePositionPct: number | null
  drawdownFromPeakPct: number | null
  turnoverVsPeakPct: number | null
  repairProgressPct: number | null
  distanceToConfirmPct: number | null
  distanceToInvalidationPct: number | null
}

export interface FirstYinDimension {
  key: 'leaderIdentity' | 'divergenceQuality' | 'turnover' | 'repairProgress' | 'themeSupport'
  label: string
  score: number | null
  maxScore: number
  status: FirstYinDimensionStatus
  value: string
  detail: string
}

export interface FirstYinStockJudgment {
  state: FirstYinState
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  completeness: number
  dataStatus: FirstYinDataStatus
  missingFields: string[]
  metrics: FirstYinMetrics
  dimensions: FirstYinDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
}

export interface FirstYinWorkbenchJudgment {
  stance: FirstYinStance
  title: string
  summary: string
  divergenceCount: number
  waitingCount: number
  confirmedCount: number
  failedCount: number
  insufficientCount: number
  analyzedCount: number
  completeness: number
  dataStatus: FirstYinDataStatus
  missingFields: string[]
  strategyVersion: string
}

interface ScoredDimension extends FirstYinDimension {
  missingField?: string
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number, digits = 2): number {
  const base = 10 ** digits
  return Math.round(value * base) / base
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function pct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

export function calculateFirstYinMetrics(input: FirstYinJudgmentInput): FirstYinMetrics {
  const isYin = finite(input.divergenceOpen) && finite(input.divergenceClose)
    ? input.divergenceClose < input.divergenceOpen
    : finite(input.divergencePctChg)
      ? input.divergencePctChg < 0
      : null
  const divergenceClosePositionPct = finite(input.divergenceHigh)
    && finite(input.divergenceLow)
    && finite(input.divergenceClose)
    && input.divergenceHigh > input.divergenceLow
    ? round((input.divergenceClose - input.divergenceLow) / (input.divergenceHigh - input.divergenceLow) * 100, 1)
    : null
  const drawdownFromPeakPct = finite(input.peakClose) && input.peakClose > 0 && finite(input.divergenceClose)
    ? round((input.divergenceClose - input.peakClose) / input.peakClose * 100)
    : null
  const turnoverVsPeakPct = finite(input.divergenceTurnoverRate)
    && finite(input.peakTurnoverRate)
    && input.peakTurnoverRate > 0
    ? round(input.divergenceTurnoverRate / input.peakTurnoverRate * 100, 1)
    : null
  const repairProgressPct = finite(input.currentPrice)
    && finite(input.divergenceHigh)
    && finite(input.divergenceLow)
    && input.divergenceHigh > input.divergenceLow
    ? round((input.currentPrice - input.divergenceLow) / (input.divergenceHigh - input.divergenceLow) * 100, 1)
    : null
  const distanceToConfirmPct = finite(input.currentPrice) && input.currentPrice > 0 && finite(input.divergenceHigh)
    ? round((input.divergenceHigh - input.currentPrice) / input.currentPrice * 100)
    : null
  const distanceToInvalidationPct = finite(input.currentPrice) && input.currentPrice > 0 && finite(input.divergenceLow)
    ? round((input.currentPrice - input.divergenceLow) / input.currentPrice * 100)
    : null
  return {
    isYin,
    divergenceClosePositionPct,
    drawdownFromPeakPct,
    turnoverVsPeakPct,
    repairProgressPct,
    distanceToConfirmPct,
    distanceToInvalidationPct,
  }
}

function identityDimension(input: FirstYinJudgmentInput): ScoredDimension {
  if (!finite(input.peakBoards)) {
    return { key: 'leaderIdentity', label: '高标辨识度', score: null, maxScore: 20, status: 'unknown', value: '待补', detail: '缺少该次连续涨停的真实高度', missingField: '高标连板高度' }
  }
  if (input.peakBoards >= 6) return { key: 'leaderIdentity', label: '高标辨识度', score: 20, maxScore: 20, status: 'strong', value: `${input.peakBoards}板`, detail: '该次连板高度具备较强市场辨识度' }
  if (input.peakBoards >= 4) return { key: 'leaderIdentity', label: '高标辨识度', score: 16, maxScore: 20, status: 'strong', value: `${input.peakBoards}板`, detail: '该次连板达到中高位梯队' }
  if (input.peakBoards >= 3) return { key: 'leaderIdentity', label: '高标辨识度', score: 12, maxScore: 20, status: 'neutral', value: `${input.peakBoards}板`, detail: '达到首阴观察的最低高标门槛' }
  return { key: 'leaderIdentity', label: '高标辨识度', score: 0, maxScore: 20, status: 'weak', value: `${input.peakBoards}板`, detail: '没有达到三板及以上高标门槛' }
}

function divergenceDimension(metrics: FirstYinMetrics): ScoredDimension {
  if (!finite(metrics.divergenceClosePositionPct) || !finite(metrics.drawdownFromPeakPct)) {
    return { key: 'divergenceQuality', label: '首次分歧质量', score: null, maxScore: 20, status: 'unknown', value: '待补', detail: '分歧日OHLC或高标收盘价缺失', missingField: '分歧日OHLC/高标收盘价' }
  }
  const value = `收于区间${metrics.divergenceClosePositionPct.toFixed(0)}% · 较高标${pct(metrics.drawdownFromPeakPct)}`
  if (metrics.divergenceClosePositionPct >= 60 && metrics.drawdownFromPeakPct >= -8) {
    return { key: 'divergenceQuality', label: '首次分歧质量', score: 20, maxScore: 20, status: 'strong', value, detail: '分歧日收盘位置较高且回撤受控' }
  }
  if (metrics.divergenceClosePositionPct >= 35 && metrics.drawdownFromPeakPct >= -12) {
    return { key: 'divergenceQuality', label: '首次分歧质量', score: 12, maxScore: 20, status: 'neutral', value, detail: '分歧仍在可修复范围，但承接不强' }
  }
  return { key: 'divergenceQuality', label: '首次分歧质量', score: 3, maxScore: 20, status: 'weak', value, detail: '分歧日收在低位或高标回撤过大' }
}

function turnoverDimension(input: FirstYinJudgmentInput, metrics: FirstYinMetrics): ScoredDimension {
  if (!finite(input.divergenceTurnoverRate)) {
    return { key: 'turnover', label: '换手承接', score: null, maxScore: 20, status: 'unknown', value: '待补', detail: '分歧日换手率缺失，不按0%处理', missingField: '分歧日换手率' }
  }
  const compare = finite(metrics.turnoverVsPeakPct) ? ` · 高标日${metrics.turnoverVsPeakPct.toFixed(0)}%` : ' · 高标日待补'
  const value = `${input.divergenceTurnoverRate.toFixed(2)}%${compare}`
  if (input.divergenceTurnoverRate >= 15 && (metrics.turnoverVsPeakPct ?? 0) >= 70) {
    return { key: 'turnover', label: '换手承接', score: 20, maxScore: 20, status: 'strong', value, detail: '绝对换手与相对高标日换手均具备承接' }
  }
  if (input.divergenceTurnoverRate >= 8 || (metrics.turnoverVsPeakPct ?? 0) >= 50) {
    return { key: 'turnover', label: '换手承接', score: 12, maxScore: 20, status: 'neutral', value, detail: '换手中性，不能仅凭单一阈值判定安全' }
  }
  return { key: 'turnover', label: '换手承接', score: 4, maxScore: 20, status: 'weak', value, detail: '分歧换手偏弱，承接证据有限' }
}

function repairDimension(metrics: FirstYinMetrics): ScoredDimension {
  if (!finite(metrics.repairProgressPct)) {
    return { key: 'repairProgress', label: '修复进度', score: null, maxScore: 25, status: 'unknown', value: '待补', detail: '当前价或分歧日高低点缺失', missingField: '当前价/确认失效线' }
  }
  const value = `${metrics.repairProgressPct.toFixed(0)}%`
  if (metrics.repairProgressPct > 100) return { key: 'repairProgress', label: '修复进度', score: 25, maxScore: 25, status: 'strong', value, detail: '价格已经越过分歧日高点，等待收盘事实确认' }
  if (metrics.repairProgressPct >= 70) return { key: 'repairProgress', label: '修复进度', score: 19, maxScore: 25, status: 'strong', value, detail: '价格接近分歧日确认线' }
  if (metrics.repairProgressPct >= 30) return { key: 'repairProgress', label: '修复进度', score: 12, maxScore: 25, status: 'neutral', value, detail: '价格仍在分歧区间内修复' }
  return { key: 'repairProgress', label: '修复进度', score: 2, maxScore: 25, status: 'weak', value, detail: '价格靠近或跌破分歧日低点' }
}

function themeDimension(input: FirstYinJudgmentInput): ScoredDimension {
  if (!input.themeName || !finite(input.themeLimitUpCount)) {
    return { key: 'themeSupport', label: '题材支撑', score: null, maxScore: 15, status: 'unknown', value: input.themeName ?? '待补', detail: '题材或同题材涨停广度缺失', missingField: '题材支撑' }
  }
  const value = `${input.themeName} · ${input.themeLimitUpCount}只涨停`
  if (input.themeLimitUpCount >= 3) return { key: 'themeSupport', label: '题材支撑', score: 15, maxScore: 15, status: 'strong', value, detail: '同题材仍有三只及以上涨停支撑' }
  if (input.themeLimitUpCount >= 1) return { key: 'themeSupport', label: '题材支撑', score: 9, maxScore: 15, status: 'neutral', value, detail: '题材仍有有限活跃度' }
  return { key: 'themeSupport', label: '题材支撑', score: 2, maxScore: 15, status: 'weak', value, detail: '同题材没有涨停支撑，个股修复更孤立' }
}

function deriveState(input: FirstYinJudgmentInput, metrics: FirstYinMetrics): FirstYinState {
  if (!finite(input.peakBoards) || input.peakBoards < 3 || !finite(input.divergenceHigh) || !finite(input.divergenceLow) || !finite(input.currentPrice)) return 'insufficient'
  const closedBelowLow = input.currentIsClosed && finite(input.currentClose) && input.currentClose < input.divergenceLow
  const timedOut = (input.currentIsClosed && input.sessionsSinceDivergence >= 3)
    || (!input.currentIsClosed && input.sessionsSinceDivergence > 3)
  const closedAboveHigh = input.currentIsClosed
    && input.sessionsSinceDivergence > 0
    && finite(input.currentClose)
    && input.currentClose > input.divergenceHigh
  if (closedBelowLow) return 'failed'
  if (closedAboveHigh) return 'confirmed'
  if (timedOut) return 'failed'
  if (input.sessionsSinceDivergence <= 0) return 'divergence'
  if (!finite(metrics.repairProgressPct)) return 'insufficient'
  return 'waiting'
}

export function judgeFirstYinStock(input: FirstYinJudgmentInput): FirstYinStockJudgment {
  const metrics = calculateFirstYinMetrics(input)
  const dimensions: ScoredDimension[] = [
    identityDimension(input),
    divergenceDimension(metrics),
    turnoverDimension(input, metrics),
    repairDimension(metrics),
    themeDimension(input),
  ]
  const available = dimensions.filter((item) => item.score != null)
  const availableScore = available.reduce((sum, item) => sum + (item.score ?? 0), 0)
  const availableMax = available.reduce((sum, item) => sum + item.maxScore, 0)
  const completeness = Math.round(available.length / dimensions.length * 100)
  const totalScore = availableMax > 0 ? Math.round(availableScore / availableMax * 100) : null
  const state = deriveState(input, metrics)
  const dataStatus: FirstYinDataStatus = state === 'insufficient' || completeness < 60
    ? 'insufficient'
    : completeness === 100
      ? 'complete'
      : 'partial'
  const title = state === 'divergence' ? '首次分歧'
    : state === 'waiting' ? '修复等待'
      : state === 'confirmed' ? '修复确认'
        : state === 'failed' ? '修复失败'
          : '证据不足'
  const summary = state === 'divergence'
    ? `高标连板在${input.divergenceDate}首次中断，当前先观察分歧承接，不直接视为买点。`
    : state === 'waiting'
      ? `分歧后第${input.sessionsSinceDivergence}个交易日，价格仍在确认线与失效线之间。`
      : state === 'confirmed'
        ? `收盘已重新站上分歧日高点，修复得到价格事实确认。`
        : state === 'failed'
          ? `价格跌破失效线或修复窗口超时，本次回踩事件不再按延续观察。`
          : '高标事件、分歧日或当前价格证据不足，暂不形成状态结论。'

  const evidence = dimensions.filter((item) => item.status === 'strong').map((item) => `${item.label}：${item.detail}`)
  const risks = dimensions.filter((item) => item.status === 'weak').map((item) => `${item.label}：${item.detail}`)
  const missingFields = unique(dimensions.flatMap((item) => item.missingField ? [item.missingField] : []))
  missingFields.forEach((field) => risks.push(`${field}缺失，当前结论已降低置信度`))
  if (input.dataMode === 'realtime' && (metrics.repairProgressPct ?? -1) > 100) risks.push('盘中价格已越过确认线，但只有收盘站稳才形成修复确认')
  if (input.dataMode === 'realtime' && (metrics.repairProgressPct ?? 101) < 0) risks.push('盘中价格已触及失效线，收盘未收回则本次修复失败')
  if (metrics.isYin === false) risks.push('首次分歧日未收阴，属于断板分歧而非标准首阴')

  const confirmations = state === 'confirmed'
    ? ['后续交易日继续守住分歧日高点，且题材支撑不快速退潮']
    : state === 'failed'
      ? ['只有重新站上分歧日高点并形成新的独立事件，才重新纳入观察']
      : ['后续交易日收盘站上分歧日高点，才形成修复确认']
  const invalidations = [
    '后续收盘跌破分歧日低点，本次修复失败',
    '分歧后三个交易日仍未收复分歧日高点，修复窗口结束',
  ]

  return {
    state,
    title,
    summary,
    totalScore,
    confidence: Math.round(completeness * (dataStatus === 'complete' ? 1 : dataStatus === 'partial' ? 0.82 : 0.45)),
    completeness,
    dataStatus,
    missingFields,
    metrics,
    dimensions,
    evidence: unique(evidence),
    risks: unique(risks),
    confirmations,
    invalidations,
  }
}

export function buildFirstYinWorkbenchJudgment(judgments: FirstYinStockJudgment[]): FirstYinWorkbenchJudgment {
  const divergenceCount = judgments.filter((item) => item.state === 'divergence').length
  const waitingCount = judgments.filter((item) => item.state === 'waiting').length
  const confirmedCount = judgments.filter((item) => item.state === 'confirmed').length
  const failedCount = judgments.filter((item) => item.state === 'failed').length
  const insufficientCount = judgments.filter((item) => item.state === 'insufficient').length
  const analyzed = judgments.filter((item) => item.state !== 'insufficient')
  const completeness = judgments.length === 0 ? 0 : Math.round(judgments.reduce((sum, item) => sum + item.completeness, 0) / judgments.length)
  const dataStatus: FirstYinDataStatus = judgments.length === 0 || analyzed.length === 0 || completeness < 60
    ? 'insufficient'
    : completeness === 100
      ? 'complete'
      : 'partial'
  const stance: FirstYinStance = dataStatus === 'insufficient'
    ? 'insufficient'
    : confirmedCount > 0
      ? 'confirmed'
      : failedCount > divergenceCount + waitingCount
        ? 'defensive'
        : 'watch'
  const title = stance === 'confirmed' ? '已出现修复确认'
    : stance === 'defensive' ? '失败事件占优，保持防守'
      : stance === 'watch' ? '仍处于分歧与等待阶段'
        : '当前证据不足'
  const summary = stance === 'confirmed'
    ? `${confirmedCount}只股票以收盘事实站上确认线；继续验证能否守住，不把盘中触线当作确认。`
    : stance === 'defensive'
      ? `${failedCount}只事件已经跌破或超时，当前没有形成可延续的修复结构。`
      : stance === 'watch'
        ? `${divergenceCount}只首次分歧、${waitingCount}只修复等待；确认前只跟踪高低点边界。`
        : '近期高标事件或目标日价格覆盖不足，暂不输出修复强弱结论。'
  return {
    stance,
    title,
    summary,
    divergenceCount,
    waitingCount,
    confirmedCount,
    failedCount,
    insufficientCount,
    analyzedCount: analyzed.length,
    completeness,
    dataStatus,
    missingFields: unique(judgments.flatMap((item) => item.missingFields)),
    strategyVersion: FIRST_YIN_STRATEGY_VERSION,
  }
}
