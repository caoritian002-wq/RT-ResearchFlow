/**
 * 筹码分布 Canvas 绘制工具
 * 从 StockMiniChart 提取为独立模块，供 StockMiniChart 和 StockChart 共用。
 */

export type ChipPoint = { price: number; percent: number }
export type ChipsLayout = {
  minPrice: number
  maxPrice: number
  priceRange: number
  padTop: number
  chartH: number
}

export type ChipProfileSummary = {
  totalPercent: number
  profitPercent: number | null
  trappedPercent: number | null
  peakPrice: number
  peakPercent: number
  distanceToPeakPercent: number | null
  coreLowPrice: number
  coreHighPrice: number
}

function normalizeChipPoints(chips: ChipPoint[]): ChipPoint[] {
  return chips
    .filter((chip) => Number.isFinite(chip.price) && chip.price > 0 && Number.isFinite(chip.percent) && chip.percent > 0)
    .sort((a, b) => a.price - b.price)
}

/**
 * 以价格级筹码事实计算抽屉顶部摘要。
 * 核心成本区使用累计筹码的 15%-85% 分位，不推断账户身份或未来方向。
 */
export function calculateChipProfileSummary(
  chips: ChipPoint[],
  currentPrice: number | null,
): ChipProfileSummary | null {
  const rows = normalizeChipPoints(chips)
  if (rows.length === 0) return null
  const totalPercent = rows.reduce((sum, chip) => sum + chip.percent, 0)
  if (!(totalPercent > 0)) return null

  const profitRaw = currentPrice == null
    ? null
    : rows.reduce((sum, chip) => sum + (chip.price <= currentPrice ? chip.percent : 0), 0)
  const profitPercent = profitRaw == null ? null : profitRaw / totalPercent * 100
  const trappedPercent = profitPercent == null ? null : Math.max(0, 100 - profitPercent)
  const peak = rows.reduce((best, chip) => chip.percent > best.percent ? chip : best)

  const lowTarget = totalPercent * 0.15
  const highTarget = totalPercent * 0.85
  let cumulative = 0
  let coreLowPrice = rows[0].price
  let coreHighPrice = rows[rows.length - 1].price
  let lowResolved = false
  for (const chip of rows) {
    cumulative += chip.percent
    if (!lowResolved && cumulative >= lowTarget) {
      coreLowPrice = chip.price
      lowResolved = true
    }
    if (cumulative >= highTarget) {
      coreHighPrice = chip.price
      break
    }
  }

  return {
    totalPercent,
    profitPercent,
    trappedPercent,
    peakPrice: peak.price,
    peakPercent: peak.percent,
    distanceToPeakPercent: currentPrice != null && peak.price > 0
      ? (currentPrice - peak.price) / peak.price * 100
      : null,
    coreLowPrice,
    coreHighPrice,
  }
}

function fillLeftRoundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string | CanvasGradient,
): void {
  const safeWidth = Math.max(1, width)
  const radius = Math.min(height / 2, safeWidth / 2)
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + safeWidth, y)
  ctx.lineTo(x + safeWidth, y + height)
  ctx.lineTo(x + radius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
  ctx.fill()
}

function fillRightRoundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string | CanvasGradient,
): void {
  const safeWidth = Math.max(1, width)
  const radius = Math.min(height / 2, safeWidth / 2)
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + safeWidth - radius, y)
  ctx.quadraticCurveTo(x + safeWidth, y, x + safeWidth, y + radius)
  ctx.lineTo(x + safeWidth, y + height - radius)
  ctx.quadraticCurveTo(x + safeWidth, y + height, x + safeWidth - radius, y + height)
  ctx.lineTo(x, y + height)
  ctx.closePath()
  ctx.fill()
}

/**
 * 快捷抽屉专用的终端价格剖面。
 * 最新模式从右向左展开；历史模式切换为左侧所选日、右侧最新日的蝴蝶对比。
 * 两侧共享价格范围和最大占比尺度，红/绿仅表达所选日浮盈与套牢。
 */
export function drawTerminalChipProfile(
  canvas: HTMLCanvasElement,
  chips: ChipPoint[],
  currentPrice: number | null,
  w: number,
  h: number,
  compareChips?: ChipPoint[],
  progress = 1,
  comparePrice: number | null = null,
): ChipsLayout | null {
  const ctx = canvas.getContext('2d')
  const mainRows = normalizeChipPoints(chips)
  const compareRows = compareChips ? normalizeChipPoints(compareChips) : []
  if (!ctx || mainRows.length === 0 || w <= 0 || h <= 0) return null

  const dpr = window.devicePixelRatio || 1
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const allRows = compareRows.length > 0 ? [...mainRows, ...compareRows] : mainRows
  const minPrice = Math.min(...allRows.map((chip) => chip.price))
  const maxPrice = Math.max(...allRows.map((chip) => chip.price))
  const priceRange = maxPrice - minPrice
  const maxPercent = Math.max(...allRows.map((chip) => chip.percent))
  if (!(priceRange > 0) || !(maxPercent > 0)) return null

  const padTop = 82
  const padBottom = 32
  const padLeft = 8
  const padRight = 4
  const chartH = h - padTop - padBottom
  const chartW = w - padLeft - padRight
  const normalizedProgress = Math.max(0, Math.min(1, progress))
  const priceToY = (price: number) => padTop + chartH - (price - minPrice) / priceRange * chartH
  const isComparison = compareRows.length > 0
  const midX = w / 2
  const centerGap = 3

  ctx.lineWidth = 1
  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const y = padTop + chartH * ratio
    ctx.strokeStyle = ratio === 0 || ratio === 1 ? 'rgba(71, 85, 105, 0.24)' : 'rgba(51, 65, 85, 0.30)'
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(w, y + 0.5)
    ctx.stroke()
  }

  const summary = calculateChipProfileSummary(mainRows, currentPrice)
  const compareSummary = isComparison ? calculateChipProfileSummary(compareRows, comparePrice) : null
  const drawCoreZone = (
    targetSummary: ChipProfileSummary,
    x: number,
    width: number,
    fill: string,
    stroke: string,
  ) => {
    if (width <= 0) return
    const coreTop = priceToY(targetSummary.coreHighPrice)
    const coreBottom = priceToY(targetSummary.coreLowPrice)
    ctx.fillStyle = fill
    ctx.fillRect(x, coreTop, width, Math.max(1, coreBottom - coreTop))
    ctx.strokeStyle = stroke
    ctx.strokeRect(x + 0.5, coreTop + 0.5, Math.max(1, width - 1), Math.max(1, coreBottom - coreTop - 1))
  }
  if (summary && isComparison) {
    drawCoreZone(summary, 0, midX - centerGap, 'rgba(244, 200, 106, 0.055)', 'rgba(244, 200, 106, 0.28)')
  } else if (summary) {
    const coreTop = priceToY(summary.coreHighPrice)
    const coreBottom = priceToY(summary.coreLowPrice)
    ctx.fillStyle = 'rgba(244, 200, 106, 0.055)'
    ctx.fillRect(0, coreTop, w, Math.max(1, coreBottom - coreTop))
    ctx.strokeStyle = 'rgba(244, 200, 106, 0.28)'
    ctx.strokeRect(0.5, coreTop + 0.5, w - 1, Math.max(1, coreBottom - coreTop - 1))
  }
  if (compareSummary) {
    drawCoreZone(compareSummary, midX + centerGap, w - midX - centerGap, 'rgba(89, 217, 232, 0.035)', 'rgba(89, 217, 232, 0.20)')
  }

  const totalBars = Math.max(mainRows.length, compareRows.length)
  const barHeight = Math.max(2, Math.min(6, chartH / totalBars * 0.72))
  const rightEdge = w - padRight

  if (isComparison) {
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.48)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(midX + 0.5, padTop)
    ctx.lineTo(midX + 0.5, padTop + chartH)
    ctx.stroke()

    const leftWidth = midX - centerGap - padLeft
    for (const chip of mainRows) {
      const barWidth = chip.percent / maxPercent * leftWidth * normalizedProgress
      const x = midX - centerGap - barWidth
      const y = priceToY(chip.price) - barHeight / 2
      const trapped = currentPrice != null && chip.price > currentPrice
      const gradient = ctx.createLinearGradient(x, 0, midX - centerGap, 0)
      if (currentPrice == null) {
        gradient.addColorStop(0, 'rgba(100, 116, 139, 0.28)')
        gradient.addColorStop(1, 'rgba(148, 163, 184, 0.78)')
      } else if (trapped) {
        gradient.addColorStop(0, 'rgba(45, 212, 165, 0.24)')
        gradient.addColorStop(1, 'rgba(45, 212, 165, 0.92)')
      } else {
        gradient.addColorStop(0, 'rgba(255, 102, 125, 0.26)')
        gradient.addColorStop(1, 'rgba(255, 102, 125, 0.94)')
      }
      fillLeftRoundedBar(ctx, x, y, barWidth, barHeight, gradient)
    }

    const rightWidth = w - padRight - midX - centerGap
    for (const chip of compareRows) {
      const barWidth = chip.percent / maxPercent * rightWidth * normalizedProgress
      const x = midX + centerGap
      const y = priceToY(chip.price) - barHeight / 2
      const gradient = ctx.createLinearGradient(x, 0, x + barWidth, 0)
      gradient.addColorStop(0, 'rgba(89, 217, 232, 0.94)')
      gradient.addColorStop(1, 'rgba(56, 189, 248, 0.34)')
      fillRightRoundedBar(ctx, x, y, barWidth, barHeight, gradient)
    }
  } else {
    for (const chip of mainRows) {
      const barWidth = chip.percent / maxPercent * chartW * normalizedProgress
      const x = rightEdge - barWidth
      const y = priceToY(chip.price) - barHeight / 2
      const trapped = currentPrice != null && chip.price > currentPrice
      const gradient = ctx.createLinearGradient(x, 0, rightEdge, 0)
      if (currentPrice == null) {
        gradient.addColorStop(0, 'rgba(100, 116, 139, 0.12)')
        gradient.addColorStop(1, 'rgba(148, 163, 184, 0.72)')
      } else if (trapped) {
        gradient.addColorStop(0, 'rgba(45, 212, 165, 0.14)')
        gradient.addColorStop(1, 'rgba(45, 212, 165, 0.88)')
      } else {
        gradient.addColorStop(0, 'rgba(255, 102, 125, 0.16)')
        gradient.addColorStop(1, 'rgba(255, 102, 125, 0.90)')
      }
      fillLeftRoundedBar(ctx, x, y, barWidth, barHeight, gradient)
    }
  }

  const drawReferenceLine = (price: number | null, fromX: number, toX: number, color: string, markerX: number) => {
    if (price == null || price < minPrice || price > maxPrice) return
    const y = priceToY(price)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(fromX, y)
    ctx.lineTo(toX, y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(markerX, y, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  if (isComparison) {
    drawReferenceLine(currentPrice, 0, midX - centerGap, '#f4c86a', 4)
    drawReferenceLine(comparePrice, midX + centerGap, w, '#59d9e8', w - 4)
  } else {
    drawReferenceLine(currentPrice, 0, w, '#59d9e8', w - 4)
  }

  return { minPrice, maxPrice, priceRange, padTop, chartH }
}

// 左侧留给价格标签的空间
const CHIPS_CANVAS_PADDING_LEFT = 46

/**
 * 绘制筹码分布横向柱状图到指定 canvas。
 *
 * - 单侧模式（compareChips 为空）：浮盈红 / 套牢绿，从左向右展开
 * - 蝴蝶模式（compareChips 有值）：左侧今日（蓝色）| 右侧历史（彩色），共享同一价格轴
 *
 * @param canvas        目标 canvas 元素
 * @param chips         主筹码数据（历史模式的选中日，或单侧模式的今日）
 * @param currentPrice  当前价格，用于绘制浮盈/套牢分界虚线
 * @param w             画布逻辑宽度（px）
 * @param h             画布逻辑高度（px）
 * @param compareChips  对比筹码（今日），存在时进入蝴蝶模式
 * @returns 返回布局元数据（用于坐标换算），canvas 为空或数据无效时返回 null
 */
export function drawChipsCanvas(
  canvas: HTMLCanvasElement,
  chips: ChipPoint[],
  currentPrice: number | null,
  w: number,
  h: number,
  compareChips?: ChipPoint[]
): ChipsLayout | null {
  const ctx = canvas.getContext('2d')
  if (!ctx || chips.length === 0 || w === 0 || h === 0) return null
  const dpr = window.devicePixelRatio || 1
  canvas.width = w * dpr
  canvas.height = h * dpr
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)

  const isButterflyMode = compareChips != null && compareChips.length > 0

  // 两组数据共享同一 maxPct 基准，柱宽比例可直接对比
  const mainMaxPct = Math.max(...chips.map((c) => c.percent))
  const compareMaxPct = isButterflyMode
    ? Math.max(...compareChips!.map((c) => c.percent))
    : 0
  const maxPct = Math.max(mainMaxPct, compareMaxPct)

  // 蝴蝶模式：价格轴取两组数据的并集，确保两侧对齐同一坐标轴
  const allPrices = isButterflyMode
    ? [...chips.map((c) => c.price), ...compareChips!.map((c) => c.price)]
    : chips.map((c) => c.price)
  const minPrice = Math.min(...allPrices)
  const maxPrice = Math.max(...allPrices)
  const priceRange = maxPrice - minPrice
  if (priceRange === 0 || maxPct === 0) return null

  const padLeft = CHIPS_CANVAS_PADDING_LEFT
  const padRight = 4
  // 蝴蝶模式顶部留 18px 给图例，单侧模式 4px
  const padTop = isButterflyMode ? 18 : 4
  const padBottom = 4
  const chartW = w - padLeft - padRight
  const chartH = h - padTop - padBottom

  // 价格 → y 坐标（低价在底部，高价在顶部）
  const priceToY = (p: number) =>
    padTop + chartH - ((p - minPrice) / priceRange) * chartH

  // 柱高按两组数据中行数较多的一组均分
  const totalBars = Math.max(chips.length, isButterflyMode ? compareChips!.length : 0)
  const barH = Math.max(1, (chartH / totalBars) * 0.85)

  if (isButterflyMode) {
    // ── 蝴蝶图：左侧今日 | 右侧历史 ────────────────────────────
    const halfW = chartW / 2
    const midX = padLeft + halfW

    // 中轴分隔线
    ctx.globalAlpha = 0.5
    ctx.strokeStyle = '#4b5563'
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(midX, padTop)
    ctx.lineTo(midX, padTop + chartH)
    ctx.stroke()

    // 顶部图例
    ctx.globalAlpha = 0.9
    ctx.font = '9px sans-serif'
    ctx.fillStyle = '#60a5fa'
    ctx.textAlign = 'right'
    ctx.fillText('今日 ←', midX - 3, 12)
    ctx.fillStyle = '#fb923c'
    ctx.textAlign = 'left'
    ctx.fillText('→ 历史', midX + 3, 12)
    ctx.globalAlpha = 1

    // 左半：今日筹码，从中轴向左展开，蓝色
    ctx.fillStyle = '#60a5fa'
    ctx.globalAlpha = 0.8
    for (const chip of compareChips!) {
      const y = priceToY(chip.price)
      const barW = (chip.percent / maxPct) * halfW
      ctx.fillRect(midX - barW, y - barH / 2, Math.max(1, barW), barH)
    }

    // 右半：历史筹码，从中轴向右展开，浮盈红/套牢绿
    ctx.globalAlpha = 0.85
    for (const chip of chips) {
      if (currentPrice != null && chip.price >= currentPrice) {
        ctx.fillStyle = '#22c55e' // 套牢（绿）
      } else {
        ctx.fillStyle = '#ef4444' // 浮盈（红）
      }
      const y = priceToY(chip.price)
      const barW = (chip.percent / maxPct) * halfW
      ctx.fillRect(midX, y - barH / 2, Math.max(1, barW), barH)
    }
    ctx.globalAlpha = 1
  } else {
    // ── 单侧模式（向右展开）────────────────────────────
    for (const chip of chips) {
      const y = priceToY(chip.price)
      const barW = (chip.percent / maxPct) * chartW
      ctx.globalAlpha = 0.75
      if (currentPrice != null && chip.price >= currentPrice) {
        ctx.fillStyle = '#22c55e' // 套牢（绿）
      } else {
        ctx.fillStyle = '#ef4444' // 浮盈（红）
      }
      ctx.fillRect(padLeft, y - barH / 2, Math.max(1, barW), barH)
    }
    ctx.globalAlpha = 1
  }

  // 当前价格虚线（横跨全宽）
  if (currentPrice != null && currentPrice >= minPrice && currentPrice <= maxPrice) {
    const y = priceToY(currentPrice)
    ctx.strokeStyle = '#ef4444'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.beginPath()
    ctx.moveTo(padLeft, y)
    ctx.lineTo(w - padRight, y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#ef4444'
    ctx.font = '10px monospace'
    ctx.textAlign = 'right'
    ctx.fillText(currentPrice.toFixed(2), padLeft - 2, y + 3)
  }

  // 边界价格标签（最高/中间/最低）
  ctx.fillStyle = '#6b7280'
  ctx.font = '9px monospace'
  ctx.textAlign = 'right'
  for (const lp of [minPrice, (minPrice + maxPrice) / 2, maxPrice]) {
    if (currentPrice != null && Math.abs(lp - currentPrice) < priceRange * 0.06) continue
    const y = priceToY(lp)
    ctx.fillText(lp.toFixed(2), padLeft - 2, y + 3)
  }

  return { minPrice, maxPrice, priceRange, padTop, chartH }
}
