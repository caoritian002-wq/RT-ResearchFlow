import type { ChipProfileSummary } from '../../utils/drawChipsCanvas'

export interface StockStructureRow {
  tradeDate: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  pctChg: number | null
  amount: number | null
}

export type StockStructureTone = 'positive' | 'negative' | 'neutral'

export interface MovingAverageReading {
  value: number | null
  distancePercent: number | null
  slopePercent: number | null
}

export interface StockStructureInsight {
  activeDate: string | null
  latestDate: string | null
  isHistorical: boolean
  sampleCount: number
  totalCount: number
  visibleRange: number
  close: number | null
  trend: {
    tone: StockStructureTone
    summary: string
    ma20: MovingAverageReading
    ma60: MovingAverageReading
    rangePositionPercent: number | null
    returns: Record<5 | 20 | 60, number | null>
  }
  chips: {
    tone: StockStructureTone
    summary: string
    peakPrice: number | null
    coreLowPrice: number | null
    coreHighPrice: number | null
    coreWidthPercent: number | null
    profitPercent: number | null
    peakShiftPercent: number | null
    coreShiftPercent: number | null
    coreWidthChangePoints: number | null
    profitChangePoints: number | null
  }
  risk: {
    tone: StockStructureTone
    support: number | null
    resistance: number | null
    supportDistancePercent: number | null
    resistanceDistancePercent: number | null
    atrPercent: number | null
    maxDrawdownPercent: number | null
    amountChangePercent: number | null
    observation: string
    invalidation: string
  }
}

interface BuildStockStructureInsightInput {
  rows: StockStructureRow[]
  activeDate?: string | null
  visibleRange: number
  activeProfile: ChipProfileSummary | null
  latestProfile: ChipProfileSummary | null
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function movingAverageAt(rows: StockStructureRow[], endIndex: number, period: number): number | null {
  if (endIndex < period - 1) return null
  const closes = rows.slice(endIndex - period + 1, endIndex + 1).map((row) => row.close)
  return closes.every(Number.isFinite) ? average(closes) : null
}

function movingAverageReading(
  rows: StockStructureRow[],
  endIndex: number,
  period: number,
  close: number,
): MovingAverageReading {
  const value = movingAverageAt(rows, endIndex, period)
  const previous = movingAverageAt(rows, endIndex - 5, period)
  return {
    value,
    distancePercent: value != null && value !== 0 ? (close - value) / value * 100 : null,
    slopePercent: value != null && previous != null && previous !== 0 ? (value - previous) / previous * 100 : null,
  }
}

function returnForPeriod(rows: StockStructureRow[], endIndex: number, period: number): number | null {
  const startIndex = endIndex - period
  if (startIndex < 0) return null
  const start = rows[startIndex].close
  const end = rows[endIndex].close
  return start !== 0 ? (end - start) / start * 100 : null
}

function calculateRangePosition(rows: StockStructureRow[], close: number): number | null {
  const lows = rows.map((row) => row.low).filter(finite)
  const highs = rows.map((row) => row.high).filter(finite)
  if (lows.length === 0 || highs.length === 0) return null
  const low = Math.min(...lows)
  const high = Math.max(...highs)
  return high > low ? (close - low) / (high - low) * 100 : null
}

function calculateAtrPercent(rows: StockStructureRow[], close: number): number | null {
  const trueRanges: number[] = []
  const start = Math.max(1, rows.length - 14)
  for (let index = start; index < rows.length; index += 1) {
    const row = rows[index]
    const previousClose = rows[index - 1]?.close
    if (!finite(row.high) || !finite(row.low) || !finite(previousClose)) continue
    trueRanges.push(Math.max(
      row.high - row.low,
      Math.abs(row.high - previousClose),
      Math.abs(row.low - previousClose),
    ))
  }
  const atr = average(trueRanges)
  return atr != null && close > 0 ? atr / close * 100 : null
}

function calculateMaxDrawdown(rows: StockStructureRow[]): number | null {
  if (rows.length < 2) return null
  let peak = rows[0].close
  let drawdown = 0
  for (const row of rows) {
    peak = Math.max(peak, row.close)
    if (peak > 0) drawdown = Math.max(drawdown, (peak - row.close) / peak * 100)
  }
  return drawdown
}

function calculateAmountChange(rows: StockStructureRow[]): number | null {
  if (rows.length < 6) return null
  const latest = rows.slice(-5).map((row) => row.amount).filter(finite)
  const previous = rows.slice(-10, -5).map((row) => row.amount).filter(finite)
  if (latest.length < 3 || previous.length < 3) return null
  const latestAverage = average(latest)
  const previousAverage = average(previous)
  return latestAverage != null && previousAverage != null && previousAverage > 0
    ? (latestAverage - previousAverage) / previousAverage * 100
    : null
}

function findNearestLevels(rows: StockStructureRow[], close: number): { support: number | null; resistance: number | null } {
  const lows: number[] = []
  const highs: number[] = []
  for (let index = 2; index < rows.length - 2; index += 1) {
    const row = rows[index]
    const neighboring = rows.slice(index - 2, index + 3)
    if (finite(row.low) && neighboring.every((item) => finite(item.low))
      && row.low <= Math.min(...neighboring.map((item) => item.low!))) {
      lows.push(row.low)
    }
    if (finite(row.high) && neighboring.every((item) => finite(item.high))
      && row.high >= Math.max(...neighboring.map((item) => item.high!))) {
      highs.push(row.high)
    }
  }

  const allLows = rows.map((row) => row.low).filter(finite)
  const allHighs = rows.map((row) => row.high).filter(finite)
  const supportCandidates = lows.filter((value) => value < close)
  const resistanceCandidates = highs.filter((value) => value > close)
  const fallbackSupport = allLows.filter((value) => value < close)
  const fallbackResistance = allHighs.filter((value) => value > close)

  return {
    support: supportCandidates.length > 0
      ? Math.max(...supportCandidates)
      : fallbackSupport.length > 0 ? Math.min(...fallbackSupport) : null,
    resistance: resistanceCandidates.length > 0
      ? Math.min(...resistanceCandidates)
      : fallbackResistance.length > 0 ? Math.max(...fallbackResistance) : null,
  }
}

function buildTrendSummary(
  ma20: MovingAverageReading,
  ma60: MovingAverageReading,
): { tone: StockStructureTone; summary: string } {
  const above20 = ma20.distancePercent != null ? ma20.distancePercent >= 0 : null
  const above60 = ma60.distancePercent != null ? ma60.distancePercent >= 0 : null
  const rising20 = ma20.slopePercent != null ? ma20.slopePercent > 0 : null
  const rising60 = ma60.slopePercent != null ? ma60.slopePercent > 0 : null

  if (above20 === true && above60 === true && rising20 === true && rising60 === true) {
    return { tone: 'positive', summary: '价格位于MA20和MA60上方，两条中期均线同步上行，趋势结构保持偏强。' }
  }
  if (above20 === false && above60 === false && rising20 === false && rising60 === false) {
    return { tone: 'negative', summary: '价格位于MA20和MA60下方，两条中期均线仍在下行，趋势结构尚未企稳。' }
  }
  if (above20 === true && above60 === false) {
    return { tone: 'neutral', summary: '短线已经站回MA20，但仍在MA60下方，反弹尚未扭转中期趋势。' }
  }
  if (above20 === false && above60 === true) {
    return { tone: 'neutral', summary: '短线回落至MA20下方，但仍在MA60上方，中期结构暂未破坏。' }
  }
  if (above20 != null || above60 != null) {
    return { tone: 'neutral', summary: '均线方向尚未形成一致信号，需要结合区间位置和关键价位继续观察。' }
  }
  return { tone: 'neutral', summary: '有效日线不足，暂不能形成MA20与MA60的联合趋势判断。' }
}

function profileCoreWidthPercent(profile: ChipProfileSummary | null): number | null {
  if (!profile) return null
  const midpoint = (profile.coreLowPrice + profile.coreHighPrice) / 2
  return midpoint > 0 ? (profile.coreHighPrice - profile.coreLowPrice) / midpoint * 100 : null
}

function buildChipInsight(
  activeProfile: ChipProfileSummary | null,
  latestProfile: ChipProfileSummary | null,
  isHistorical: boolean,
  activeDate: string | null,
  latestDate: string | null,
): StockStructureInsight['chips'] {
  const activeWidth = profileCoreWidthPercent(activeProfile)
  if (!activeProfile) {
    return {
      tone: 'neutral',
      summary: isHistorical ? '所选交易日没有可用筹码分布，无法比较成本迁移。' : '当前没有可用筹码分布，价格结构仍可单独观察。',
      peakPrice: null,
      coreLowPrice: null,
      coreHighPrice: null,
      coreWidthPercent: null,
      profitPercent: null,
      peakShiftPercent: null,
      coreShiftPercent: null,
      coreWidthChangePoints: null,
      profitChangePoints: null,
    }
  }

  if (isHistorical && !latestProfile) {
    return {
      tone: 'neutral',
      summary: `所选日核心筹码位于 ${activeProfile.coreLowPrice.toFixed(2)} 至 ${activeProfile.coreHighPrice.toFixed(2)}，但最新筹码待补，暂不能判断迁移方向。`,
      peakPrice: activeProfile.peakPrice,
      coreLowPrice: activeProfile.coreLowPrice,
      coreHighPrice: activeProfile.coreHighPrice,
      coreWidthPercent: activeWidth,
      profitPercent: activeProfile.profitPercent,
      peakShiftPercent: null,
      coreShiftPercent: null,
      coreWidthChangePoints: null,
      profitChangePoints: null,
    }
  }

  if (!isHistorical || !latestProfile) {
    return {
      tone: 'neutral',
      summary: `当前70%核心筹码位于 ${activeProfile.coreLowPrice.toFixed(2)} 至 ${activeProfile.coreHighPrice.toFixed(2)}，主峰在 ${activeProfile.peakPrice.toFixed(2)}。选择历史K线可比较筹码迁移。`,
      peakPrice: activeProfile.peakPrice,
      coreLowPrice: activeProfile.coreLowPrice,
      coreHighPrice: activeProfile.coreHighPrice,
      coreWidthPercent: activeWidth,
      profitPercent: activeProfile.profitPercent,
      peakShiftPercent: null,
      coreShiftPercent: null,
      coreWidthChangePoints: null,
      profitChangePoints: null,
    }
  }

  const selectedMidpoint = (activeProfile.coreLowPrice + activeProfile.coreHighPrice) / 2
  const latestMidpoint = (latestProfile.coreLowPrice + latestProfile.coreHighPrice) / 2
  const latestWidth = profileCoreWidthPercent(latestProfile)
  const peakShiftPercent = activeProfile.peakPrice > 0
    ? (latestProfile.peakPrice - activeProfile.peakPrice) / activeProfile.peakPrice * 100
    : null
  const coreShiftPercent = selectedMidpoint > 0
    ? (latestMidpoint - selectedMidpoint) / selectedMidpoint * 100
    : null
  const coreWidthChangePoints = activeWidth != null && latestWidth != null ? latestWidth - activeWidth : null
  const profitChangePoints = activeProfile.profitPercent != null && latestProfile.profitPercent != null
    ? latestProfile.profitPercent - activeProfile.profitPercent
    : null
  const coreDirection = coreShiftPercent == null || Math.abs(coreShiftPercent) < 0.5
    ? '成本中枢基本持平'
    : coreShiftPercent > 0 ? `成本中枢上移 ${coreShiftPercent.toFixed(1)}%` : `成本中枢下移 ${Math.abs(coreShiftPercent).toFixed(1)}%`
  const widthDirection = coreWidthChangePoints == null || Math.abs(coreWidthChangePoints) < 1
    ? '核心区宽度接近'
    : coreWidthChangePoints < 0 ? `核心区收敛 ${Math.abs(coreWidthChangePoints).toFixed(1)}个百分点` : `核心区发散 ${coreWidthChangePoints.toFixed(1)}个百分点`
  const profitDirection = profitChangePoints == null || Math.abs(profitChangePoints) < 1
    ? '浮盈比例变化不大'
    : profitChangePoints > 0 ? `浮盈比例增加 ${profitChangePoints.toFixed(1)}个百分点` : `浮盈比例减少 ${Math.abs(profitChangePoints).toFixed(1)}个百分点`
  const tone: StockStructureTone = coreShiftPercent != null && coreShiftPercent > 0.5 && coreWidthChangePoints != null && coreWidthChangePoints < -1
    ? 'positive'
    : coreShiftPercent != null && coreShiftPercent < -0.5 && profitChangePoints != null && profitChangePoints < -3
      ? 'negative'
      : 'neutral'

  return {
    tone,
    summary: `${activeDate ?? '所选日'}至${latestDate ?? '最新日'}：${coreDirection}，${widthDirection}，${profitDirection}。`,
    peakPrice: latestProfile.peakPrice,
    coreLowPrice: latestProfile.coreLowPrice,
    coreHighPrice: latestProfile.coreHighPrice,
    coreWidthPercent: latestWidth,
    profitPercent: latestProfile.profitPercent,
    peakShiftPercent,
    coreShiftPercent,
    coreWidthChangePoints,
    profitChangePoints,
  }
}

export function buildStockStructureInsight({
  rows,
  activeDate = null,
  visibleRange,
  activeProfile,
  latestProfile,
}: BuildStockStructureInsightInput): StockStructureInsight {
  const orderedRows = rows
    .filter((row) => row.tradeDate && Number.isFinite(row.close))
    .slice()
    .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
  const latestDate = orderedRows.at(-1)?.tradeDate ?? null
  const eligibleRows = activeDate
    ? orderedRows.filter((row) => row.tradeDate <= activeDate)
    : orderedRows
  const endIndex = eligibleRows.length - 1
  const activeRow = endIndex >= 0 ? eligibleRows[endIndex] : null
  const activeWindow = eligibleRows.slice(Math.max(0, eligibleRows.length - visibleRange))
  const close = activeRow?.close ?? null
  const ma20 = close != null ? movingAverageReading(eligibleRows, endIndex, 20, close) : { value: null, distancePercent: null, slopePercent: null }
  const ma60 = close != null ? movingAverageReading(eligibleRows, endIndex, 60, close) : { value: null, distancePercent: null, slopePercent: null }
  const trendReading = buildTrendSummary(ma20, ma60)
  const isHistorical = activeRow != null && latestDate != null && activeRow.tradeDate !== latestDate
  const levels = close != null ? findNearestLevels(activeWindow, close) : { support: null, resistance: null }
  const supportDistancePercent = close != null && levels.support != null && close > 0
    ? (close - levels.support) / close * 100
    : null
  const resistanceDistancePercent = close != null && levels.resistance != null && close > 0
    ? (levels.resistance - close) / close * 100
    : null
  const atrPercent = close != null ? calculateAtrPercent(activeWindow, close) : null
  const maxDrawdownPercent = calculateMaxDrawdown(activeWindow)
  const amountChangePercent = calculateAmountChange(activeWindow)
  const riskTone: StockStructureTone = supportDistancePercent != null && supportDistancePercent < 2
    ? 'negative'
    : resistanceDistancePercent != null && resistanceDistancePercent < 2
      ? 'neutral'
      : 'neutral'

  return {
    activeDate: activeRow?.tradeDate ?? null,
    latestDate,
    isHistorical,
    sampleCount: activeWindow.length,
    totalCount: orderedRows.length,
    visibleRange,
    close,
    trend: {
      tone: trendReading.tone,
      summary: trendReading.summary,
      ma20,
      ma60,
      rangePositionPercent: close != null ? calculateRangePosition(activeWindow, close) : null,
      returns: {
        5: endIndex >= 0 ? returnForPeriod(eligibleRows, endIndex, 5) : null,
        20: endIndex >= 0 ? returnForPeriod(eligibleRows, endIndex, 20) : null,
        60: endIndex >= 0 ? returnForPeriod(eligibleRows, endIndex, 60) : null,
      },
    },
    chips: buildChipInsight(activeProfile, latestProfile, isHistorical, activeRow?.tradeDate ?? null, latestDate),
    risk: {
      tone: riskTone,
      support: levels.support,
      resistance: levels.resistance,
      supportDistancePercent,
      resistanceDistancePercent,
      atrPercent,
      maxDrawdownPercent,
      amountChangePercent,
      observation: levels.resistance != null
        ? `观察收盘能否有效站上 ${levels.resistance.toFixed(2)}，并由量能配合确认。`
        : '当前接近观察区间上沿，继续关注新高后的量能是否能够延续。',
      invalidation: levels.support != null
        ? `若收盘跌破 ${levels.support.toFixed(2)}，当前结构判断需要重新评估。`
        : '下方支撑样本不足，需要扩大观察区间后再确认失效位置。',
    },
  }
}
