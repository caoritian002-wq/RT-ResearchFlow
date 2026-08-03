export const CLOSING_HALF_HOUR_STRATEGY_KEY = 'shortTerm.closingHalfHour'
export const CLOSING_HALF_HOUR_STRATEGY_VERSION = '2.0.0'

export type ClosingHalfHourDataMode = 'realtime' | 'eod' | 'history'
export type ClosingHalfHourTier = 'active' | 'confirm' | 'retreat' | 'insufficient'
export type ClosingHalfHourDataStatus = 'complete' | 'partial' | 'insufficient'
export type ClosingHalfHourStance = 'active' | 'selective' | 'defensive' | 'insufficient'
export type ClosingHalfHourDimensionStatus = 'strong' | 'neutral' | 'weak' | 'unknown'
export type ClosingHalfHourLegacyForm =
  | 'spikeBreakOpen'
  | 'dipReboundNotBreakOpen'
  | 'mildPullAboveBaseline'
  | 'riseFallHoldBaseline'
  | 'flatNoMove'
  | 'lastTenSharpDrop'

export interface ClosingMinutePoint {
  time: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  vol: number | null
  amount: number | null
}

export interface ClosingHalfHourJudgmentInput {
  tsCode: string
  stockCode: string
  stockName: string
  dataMode: ClosingHalfHourDataMode
  dayOpen: number | null
  previousClose: number | null
  pctChg: number | null
  dayAmount: number | null
  minutePoints: ClosingMinutePoint[]
}

export interface ClosingHalfHourMetrics {
  baseline1430: number | null
  latestPrice: number | null
  latestTime: string | null
  tailReturnPct: number | null
  tailHighPct: number | null
  tailLowPct: number | null
  lateReturnPct: number | null
  closePositionPct: number | null
  maxDrawdownPct: number | null
  pathEfficiencyPct: number | null
  tailVolumeSharePct: number | null
  tailVolumePace: number | null
  pointCount: number
}

export interface ClosingHalfHourDimension {
  key: 'direction' | 'closePosition' | 'participation' | 'stability' | 'keyLevel'
  label: string
  score: number | null
  maxScore: number
  status: ClosingHalfHourDimensionStatus
  value: string
  detail: string
}

export interface ClosingHalfHourStockJudgment {
  tier: ClosingHalfHourTier
  title: string
  summary: string
  totalScore: number | null
  confidence: number
  completeness: number
  dataStatus: ClosingHalfHourDataStatus
  missingFields: string[]
  metrics: ClosingHalfHourMetrics
  dimensions: ClosingHalfHourDimension[]
  evidence: string[]
  risks: string[]
  confirmations: string[]
  invalidations: string[]
  legacyForms: ClosingHalfHourLegacyForm[]
}

export interface ClosingHalfHourWorkbenchJudgment {
  stance: ClosingHalfHourStance
  title: string
  summary: string
  activeCount: number
  confirmCount: number
  retreatCount: number
  insufficientCount: number
  analyzedCount: number
  completeness: number
  dataStatus: ClosingHalfHourDataStatus
  missingFields: string[]
  strategyVersion: string
}

interface ScoredDimension extends ClosingHalfHourDimension {
  missingField?: string
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number, digits = 2): number {
  const base = 10 ** digits
  return Math.round(value * base) / base
}

function pct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function normalizePoints(points: ClosingMinutePoint[]): ClosingMinutePoint[] {
  const byTime = new Map<string, ClosingMinutePoint>()
  points
    .filter((point) => /^\d{2}:\d{2}$/.test(point.time))
    .forEach((point) => byTime.set(point.time, point))
  return Array.from(byTime.values()).sort((left, right) => left.time.localeCompare(right.time))
}

function calculateMaxDrawdown(closes: number[]): number | null {
  if (closes.length < 2) return null
  let peak = closes[0]
  let drawdown = 0
  for (const close of closes) {
    peak = Math.max(peak, close)
    if (peak > 0) drawdown = Math.max(drawdown, (peak - close) / peak * 100)
  }
  return round(drawdown)
}

function calculatePathEfficiency(closes: number[]): number | null {
  if (closes.length < 2) return null
  const distance = closes.slice(1).reduce((sum, close, index) => sum + Math.abs(close - closes[index]), 0)
  if (distance <= 0) return null
  return round(Math.abs(closes[closes.length - 1] - closes[0]) / distance * 100, 1)
}

export function calculateClosingHalfHourMetrics(input: ClosingHalfHourJudgmentInput): ClosingHalfHourMetrics {
  const points = normalizePoints(input.minutePoints)
  const baselinePoint = points.find((point) => point.time === '14:30' && finite(point.close))
  const tailPoints = points.filter((point) => point.time >= '14:30' && point.time <= '15:00' && finite(point.close))
  const baseline1430 = baselinePoint?.close ?? null
  const latestPoint = tailPoints.at(-1)
  const latestPrice = latestPoint?.close ?? null
  const closes = tailPoints.flatMap((point) => finite(point.close) ? [point.close] : [])

  let tailReturnPct: number | null = null
  let tailHighPct: number | null = null
  let tailLowPct: number | null = null
  let closePositionPct: number | null = null
  if (finite(baseline1430) && baseline1430 > 0 && finite(latestPrice)) {
    const highs = tailPoints.flatMap((point) => finite(point.high) ? [point.high] : finite(point.close) ? [point.close] : [])
    const lows = tailPoints.flatMap((point) => finite(point.low) ? [point.low] : finite(point.close) ? [point.close] : [])
    const high = highs.length > 0 ? Math.max(...highs) : latestPrice
    const low = lows.length > 0 ? Math.min(...lows) : latestPrice
    tailReturnPct = round((latestPrice - baseline1430) / baseline1430 * 100)
    tailHighPct = round((high - baseline1430) / baseline1430 * 100)
    tailLowPct = round((low - baseline1430) / baseline1430 * 100)
    if (high > low && (high - low) / baseline1430 >= 0.001) {
      closePositionPct = round((latestPrice - low) / (high - low) * 100, 1)
    }
  }

  const lateStart = tailPoints.find((point) => point.time >= '14:50' && finite(point.close))
  const lateReturnPct = finite(lateStart?.close) && lateStart.close > 0 && finite(latestPrice)
    ? round((latestPrice - lateStart.close) / lateStart.close * 100)
    : null

  const preTailVolumePoints = points.filter((point) => point.time < '14:30' && finite(point.vol) && point.vol > 0)
  const hasDayVolumeCoverage = preTailVolumePoints.length >= 60
  const totalVolume = points.reduce((sum, point) => sum + (finite(point.vol) && point.vol > 0 ? point.vol : 0), 0)
  const tailVolume = tailPoints.reduce((sum, point) => sum + (finite(point.vol) && point.vol > 0 ? point.vol : 0), 0)
  const tailVolumeSharePct = hasDayVolumeCoverage && totalVolume > 0 ? round(tailVolume / totalVolume * 100, 1) : null
  const latestTime = tailPoints.at(-1)?.time
  const [latestHour, latestMinute] = latestTime?.split(':').map(Number) ?? []
  const elapsedMinutes = Number.isFinite(latestHour) && Number.isFinite(latestMinute)
    ? Math.max(1, Math.min(30, latestHour * 60 + latestMinute - (14 * 60 + 30)))
    : 0
  const expectedShare = elapsedMinutes > 0 ? elapsedMinutes / 240 * 100 : 0
  const tailVolumePace = finite(tailVolumeSharePct) && expectedShare > 0
    ? round(tailVolumeSharePct / expectedShare, 2)
    : null

  return {
    baseline1430,
    latestPrice,
    latestTime: latestPoint?.time ?? null,
    tailReturnPct,
    tailHighPct,
    tailLowPct,
    lateReturnPct,
    closePositionPct,
    maxDrawdownPct: calculateMaxDrawdown(closes),
    pathEfficiencyPct: calculatePathEfficiency(closes),
    tailVolumeSharePct,
    tailVolumePace,
    pointCount: tailPoints.length,
  }
}

function directionDimension(metrics: ClosingHalfHourMetrics): ScoredDimension {
  if (!finite(metrics.tailReturnPct)) {
    return { key: 'direction', label: '尾盘方向', score: null, maxScore: 30, status: 'unknown', value: '待补', detail: '缺少精确14:30基准价，不能计算尾盘涨跌', missingField: '精确14:30价格' }
  }
  if (metrics.tailReturnPct >= 1.5) return { key: 'direction', label: '尾盘方向', score: 30, maxScore: 30, status: 'strong', value: pct(metrics.tailReturnPct), detail: '14:30后价格明显主动抬升' }
  if (metrics.tailReturnPct >= 0.5) return { key: 'direction', label: '尾盘方向', score: 23, maxScore: 30, status: 'strong', value: pct(metrics.tailReturnPct), detail: '14:30后价格温和增强' }
  if (metrics.tailReturnPct > -0.5) return { key: 'direction', label: '尾盘方向', score: 15, maxScore: 30, status: 'neutral', value: pct(metrics.tailReturnPct), detail: '尾盘方向尚未拉开差异' }
  if (metrics.tailReturnPct > -1.5) return { key: 'direction', label: '尾盘方向', score: 7, maxScore: 30, status: 'weak', value: pct(metrics.tailReturnPct), detail: '14:30后价格走弱' }
  return { key: 'direction', label: '尾盘方向', score: 0, maxScore: 30, status: 'weak', value: pct(metrics.tailReturnPct), detail: '14:30后出现明显撤退' }
}

function closePositionDimension(metrics: ClosingHalfHourMetrics): ScoredDimension {
  if (!finite(metrics.closePositionPct)) {
    return { key: 'closePosition', label: '收盘位置', score: null, maxScore: 20, status: 'unknown', value: '待补', detail: '尾盘波幅过窄或高低点缺失，收盘位置不参与评分', missingField: '尾盘高低点' }
  }
  if (metrics.closePositionPct >= 80) return { key: 'closePosition', label: '收盘位置', score: 20, maxScore: 20, status: 'strong', value: `区间${metrics.closePositionPct.toFixed(0)}%`, detail: '价格收在尾盘区间高位' }
  if (metrics.closePositionPct >= 60) return { key: 'closePosition', label: '收盘位置', score: 15, maxScore: 20, status: 'strong', value: `区间${metrics.closePositionPct.toFixed(0)}%`, detail: '价格守住尾盘区间上半部' }
  if (metrics.closePositionPct >= 35) return { key: 'closePosition', label: '收盘位置', score: 10, maxScore: 20, status: 'neutral', value: `区间${metrics.closePositionPct.toFixed(0)}%`, detail: '收盘位置居中，方向仍待确认' }
  return { key: 'closePosition', label: '收盘位置', score: 3, maxScore: 20, status: 'weak', value: `区间${metrics.closePositionPct.toFixed(0)}%`, detail: '价格回落至尾盘区间低位' }
}

function participationDimension(metrics: ClosingHalfHourMetrics): ScoredDimension {
  if (!finite(metrics.tailVolumePace)) {
    return { key: 'participation', label: '成交参与', score: null, maxScore: 20, status: 'unknown', value: '待补', detail: '分钟成交量不完整，不能判断尾盘参与度', missingField: '分钟成交量' }
  }
  const value = `${metrics.tailVolumePace.toFixed(2)}倍时段均值`
  if (metrics.tailVolumePace >= 1.5) return { key: 'participation', label: '成交参与', score: 20, maxScore: 20, status: 'strong', value, detail: '尾盘成交显著放大，行为具有资金参与' }
  if (metrics.tailVolumePace >= 1) return { key: 'participation', label: '成交参与', score: 15, maxScore: 20, status: 'strong', value, detail: '尾盘成交参与不弱于全天时段均值' }
  if (metrics.tailVolumePace >= 0.6) return { key: 'participation', label: '成交参与', score: 10, maxScore: 20, status: 'neutral', value, detail: '尾盘成交中性，仍需次日确认' }
  return { key: 'participation', label: '成交参与', score: 4, maxScore: 20, status: 'weak', value, detail: '尾盘成交偏弱，价格变化可能只是低量脉冲' }
}

function stabilityDimension(metrics: ClosingHalfHourMetrics): ScoredDimension {
  if (!finite(metrics.maxDrawdownPct) || !finite(metrics.pathEfficiencyPct)) {
    return { key: 'stability', label: '路径稳定性', score: null, maxScore: 15, status: 'unknown', value: '待补', detail: '连续分钟收盘点不足，不能判断路径稳定性', missingField: '连续分钟路径' }
  }
  const value = `回撤${metrics.maxDrawdownPct.toFixed(2)}% · 效率${metrics.pathEfficiencyPct.toFixed(0)}%`
  if (metrics.maxDrawdownPct <= 0.5 && metrics.pathEfficiencyPct >= 55) return { key: 'stability', label: '路径稳定性', score: 15, maxScore: 15, status: 'strong', value, detail: '回撤受控且路径方向明确' }
  if (metrics.maxDrawdownPct <= 1 && metrics.pathEfficiencyPct >= 35) return { key: 'stability', label: '路径稳定性', score: 11, maxScore: 15, status: 'neutral', value, detail: '路径基本稳定，仍有一定反复' }
  if (metrics.maxDrawdownPct <= 1.5) return { key: 'stability', label: '路径稳定性', score: 7, maxScore: 15, status: 'neutral', value, detail: '路径反复，方向可信度一般' }
  return { key: 'stability', label: '路径稳定性', score: 2, maxScore: 15, status: 'weak', value, detail: '尾盘回撤明显，存在冲高回落' }
}

function keyLevelDimension(input: ClosingHalfHourJudgmentInput, metrics: ClosingHalfHourMetrics): ScoredDimension {
  if (!finite(metrics.latestPrice)) {
    return { key: 'keyLevel', label: '关键价位', score: null, maxScore: 15, status: 'unknown', value: '待补', detail: '缺少最新价格，不能判断开盘价与昨收得失', missingField: '最新价格' }
  }
  const levels = [
    finite(input.dayOpen) && input.dayOpen > 0 ? { label: '开盘价', held: metrics.latestPrice >= input.dayOpen } : null,
    finite(input.previousClose) && input.previousClose > 0 ? { label: '昨收', held: metrics.latestPrice >= input.previousClose } : null,
  ].filter((item): item is { label: string; held: boolean } => item !== null)
  if (levels.length === 0) {
    return { key: 'keyLevel', label: '关键价位', score: null, maxScore: 15, status: 'unknown', value: '待补', detail: '开盘价与昨收均缺失，关键位不参与评分', missingField: '开盘价/昨收' }
  }
  const held = levels.filter((item) => item.held).length
  const value = levels.map((item) => `${item.label}${item.held ? '上方' : '下方'}`).join(' · ')
  if (held === levels.length) return { key: 'keyLevel', label: '关键价位', score: 15, maxScore: 15, status: 'strong', value, detail: '收盘价守住当前可用关键价位' }
  if (held === 0) return { key: 'keyLevel', label: '关键价位', score: 2, maxScore: 15, status: 'weak', value, detail: '收盘价跌破当前可用关键价位' }
  return { key: 'keyLevel', label: '关键价位', score: 8, maxScore: 15, status: 'neutral', value, detail: '关键价位得失不一致，次日仍需确认' }
}

function detectLegacyForms(input: ClosingHalfHourJudgmentInput, metrics: ClosingHalfHourMetrics): ClosingHalfHourLegacyForm[] {
  const forms: ClosingHalfHourLegacyForm[] = []
  if (finite(metrics.tailHighPct) && metrics.tailHighPct >= 2 && finite(metrics.latestPrice) && finite(input.dayOpen) && metrics.latestPrice < input.dayOpen) forms.push('spikeBreakOpen')
  if (finite(metrics.tailLowPct) && metrics.tailLowPct <= -3 && finite(metrics.latestPrice) && finite(input.dayOpen) && metrics.latestPrice >= input.dayOpen * 0.995) forms.push('dipReboundNotBreakOpen')
  if (finite(metrics.tailReturnPct) && metrics.tailReturnPct >= 0 && finite(metrics.maxDrawdownPct) && metrics.maxDrawdownPct <= 0.8) forms.push('mildPullAboveBaseline')
  if (finite(metrics.tailHighPct) && metrics.tailHighPct >= 1 && finite(metrics.tailReturnPct) && metrics.tailReturnPct < 0 && metrics.tailReturnPct >= -0.8) forms.push('riseFallHoldBaseline')
  if (finite(metrics.tailHighPct) && finite(metrics.tailLowPct) && metrics.tailHighPct - metrics.tailLowPct < 0.5) forms.push('flatNoMove')
  if (finite(metrics.lateReturnPct) && metrics.lateReturnPct <= -2) forms.push('lastTenSharpDrop')
  return unique(forms) as ClosingHalfHourLegacyForm[]
}

function dataStatusFor(completeness: number, pointCount: number, baseline: number | null): ClosingHalfHourDataStatus {
  if (!finite(baseline) || pointCount < 5 || completeness < 60) return 'insufficient'
  if (completeness >= 100 && pointCount >= 20) return 'complete'
  return 'partial'
}

export function judgeClosingHalfHourStock(input: ClosingHalfHourJudgmentInput): ClosingHalfHourStockJudgment {
  const metrics = calculateClosingHalfHourMetrics(input)
  const dimensions: ScoredDimension[] = [
    directionDimension(metrics),
    closePositionDimension(metrics),
    participationDimension(metrics),
    stabilityDimension(metrics),
    keyLevelDimension(input, metrics),
  ]
  const available = dimensions.filter((item) => item.score != null)
  const availableScore = available.reduce((sum, item) => sum + (item.score ?? 0), 0)
  const availableMax = available.reduce((sum, item) => sum + item.maxScore, 0)
  const completeness = Math.round(available.length / dimensions.length * 100)
  const totalScore = availableMax > 0 ? Math.round(availableScore / availableMax * 100) : null
  const dataStatus = dataStatusFor(completeness, metrics.pointCount, metrics.baseline1430)
  const hardRetreat = (metrics.tailReturnPct ?? 0) <= -1.5
    || (metrics.lateReturnPct ?? 0) <= -1.5
    || ((metrics.maxDrawdownPct ?? 0) >= 1.5 && (metrics.closePositionPct ?? 100) < 35)
  const activeStructure = (metrics.tailReturnPct ?? -99) >= 0.5
    && (metrics.closePositionPct ?? -1) >= 60
    && (metrics.maxDrawdownPct ?? 99) <= 1

  let tier: ClosingHalfHourTier
  if (dataStatus === 'insufficient') tier = 'insufficient'
  else if (hardRetreat || (totalScore != null && totalScore < 40)) tier = 'retreat'
  else if (activeStructure && totalScore != null && totalScore >= 68) tier = 'active'
  else tier = 'confirm'

  const title = tier === 'active' ? '主动增强'
    : tier === 'retreat' ? '冲高回落或撤退'
      : tier === 'confirm' ? '等待次日确认'
        : '数据不足'
  const summary = tier === 'active'
    ? `14:30后${pct(metrics.tailReturnPct ?? 0)}，收在尾盘区间较高位置，当前路径具备主动性。`
    : tier === 'retreat'
      ? `尾盘回撤或关键价位失守，当前行为更接近撤退而非主动抢筹。`
      : tier === 'confirm'
        ? `尾盘出现方向线索，但成交、收盘位置或路径稳定性尚未形成一致确认。`
        : '分钟路径不足，当前不生成尾盘形态结论。'

  const evidence = dimensions.filter((item) => item.status === 'strong').map((item) => `${item.label}：${item.detail}`)
  const risks = dimensions.filter((item) => item.status === 'weak').map((item) => `${item.label}：${item.detail}`)
  const missingFields = unique(dimensions.flatMap((item) => item.missingField ? [item.missingField] : []))
  missingFields.forEach((field) => risks.push(`${field}缺失，当前结论已降低置信度`))

  const confirmations: string[] = []
  if (tier === 'active') confirmations.push('次日竞价不明显低开，且开盘后能守住尾盘收盘区间上沿')
  if (tier === 'confirm') confirmations.push('次日竞价与开盘成交继续放大，并重新站上尾盘高点')
  if (tier === 'retreat') confirmations.push('只有次日快速收复尾盘高点并出现放量承接，才视为风险解除')
  if (tier === 'insufficient') confirmations.push('补齐14:30至收盘的连续分钟价格与成交量后重新研判')

  const invalidations = [
    '次日竞价或开盘跌破尾盘低点，且成交放大',
    '次日无法守住14:30基准价，尾盘增强线索失效',
  ]
  if (tier === 'retreat') invalidations.unshift('尾盘最后10分钟继续放量走弱，撤退风险维持')

  return {
    tier,
    title,
    summary,
    totalScore,
    confidence: Math.round(completeness * (dataStatus === 'complete' ? 1 : dataStatus === 'partial' ? 0.82 : 0.45)),
    completeness,
    dataStatus,
    missingFields,
    metrics,
    dimensions,
    evidence,
    risks: unique(risks),
    confirmations: unique(confirmations),
    invalidations: unique(invalidations),
    legacyForms: detectLegacyForms(input, metrics),
  }
}

export function buildClosingHalfHourWorkbenchJudgment(
  judgments: ClosingHalfHourStockJudgment[]
): ClosingHalfHourWorkbenchJudgment {
  const activeCount = judgments.filter((item) => item.tier === 'active').length
  const confirmCount = judgments.filter((item) => item.tier === 'confirm').length
  const retreatCount = judgments.filter((item) => item.tier === 'retreat').length
  const insufficientCount = judgments.filter((item) => item.tier === 'insufficient').length
  const completeness = judgments.length > 0
    ? Math.round(judgments.reduce((sum, item) => sum + item.completeness, 0) / judgments.length)
    : 0
  const dataStatus = dataStatusFor(completeness, judgments.length > 0 ? 20 : 0, judgments.length > 0 ? 1 : null)
  const missingFields = unique(judgments.flatMap((item) => item.missingFields))

  let stance: ClosingHalfHourStance
  if (judgments.length === 0 || judgments.length === insufficientCount) stance = 'insufficient'
  else if (retreatCount > activeCount && retreatCount >= 2) stance = 'defensive'
  else if (activeCount >= 2 && activeCount > retreatCount) stance = 'active'
  else stance = 'selective'

  const title = stance === 'active' ? '尾盘主动行为占优'
    : stance === 'defensive' ? '尾盘撤退风险占优'
      : stance === 'selective' ? '尾盘分化，按个股确认'
        : '尾盘数据不足'
  const summary = stance === 'insufficient'
    ? '当前没有足够的14:30至收盘分钟路径，不能判断尾盘是否具备延续性。'
    : `主动增强${activeCount}只，等待确认${confirmCount}只，撤退风险${retreatCount}只；次日只跟踪确认条件，不把尾盘脉冲直接当作延续。`

  return {
    stance,
    title,
    summary,
    activeCount,
    confirmCount,
    retreatCount,
    insufficientCount,
    analyzedCount: judgments.length,
    completeness,
    dataStatus,
    missingFields,
    strategyVersion: CLOSING_HALF_HOUR_STRATEGY_VERSION,
  }
}
