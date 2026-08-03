export interface Round2MarketSourceRow {
  tradeDate: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  pctChg?: number | null
  amount?: number | null
}

export interface Round2InlineCandidate {
  code: string
  name?: string | null
}

export type Round2MarkdownSegment =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'visual'; code: string; fallbackMarkdown: string }

export interface Round2MarketBar {
  tradeDate: string
  open: number
  high: number
  low: number
  close: number
  pctChg: number | null
}

export type Round2TrendTone = 'strong' | 'recovering' | 'range' | 'weakening' | 'weak'

export interface Round2MarketVisualModel {
  status: 'ready' | 'insufficient'
  cutoffDate: string
  rows: Round2MarketBar[]
  latestTradeDate: string | null
  latestClose: number | null
  latestPctChg: number | null
  return5: number | null
  return20: number | null
  ma5: number | null
  ma20: number | null
  ma5Series: Array<{ tradeDate: string; value: number }>
  ma20Series: Array<{ tradeDate: string; value: number }>
  support5: number | null
  support20: number | null
  pressure5: number | null
  pressure20: number | null
  trendTone: Round2TrendTone | null
  trendLabel: string
  reason: 'invalid_cutoff' | 'insufficient_rows' | null
}

const MAX_ROWS = 30
const MIN_ROWS = 10
const INLINE_VISUAL_MARKER_PREFIX = '<!-- trade-watch-round2-market:'
const INLINE_VISUAL_MARKER_PATTERN = /^\s*<!--\s*trade-watch-round2-market:(\d{6})\s*-->\s*$/
const SUPPORT_PRESSURE_REFERENCE_PATTERN = /^(?:\*\*|__)?(?:支撑(?:观察)?参考|支撑位|压力(?:观察)?参考|压力位|阻力(?:观察)?参考|阻力位)/

interface MarkdownHeading {
  level: number
  text: string
}

function normalizeStockCode(value: string): string | null {
  const code = value.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
  return /^\d{6}$/.test(code) ? code : null
}

function parseMarkdownHeading(line: string): MarkdownHeading | null {
  const match = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/)
  return match ? { level: match[1].length, text: match[2] } : null
}

function buildFenceMask(lines: string[]): boolean[] {
  let fence: '`' | '~' | null = null
  return lines.map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]?.[0] as '`' | '~' | undefined
    const insideBefore = fence != null
    if (marker) {
      if (fence === marker) fence = null
      else if (fence == null) fence = marker
      return true
    }
    return insideBefore
  })
}

function containsCandidate(line: string, candidate: { code: string; name: string | null }): boolean {
  if (new RegExp(`(^|\\D)${candidate.code}(?:\\.(?:SH|SZ|BJ))?(?!\\d)`, 'i').test(line)) return true
  return Boolean(candidate.name && candidate.name.length >= 2 && line.includes(candidate.name))
}

function isMarkdownTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)
}

function isSupportPressureReferenceLine(line: string): boolean {
  const withoutMarkdownPrefix = line.replace(/^\s*(?:(?:[-*+]\s+|\d+[.)]\s+))?(?:\|\s*)?/, '')
  return SUPPORT_PRESSURE_REFERENCE_PATTERN.test(withoutMarkdownPrefix)
}

function findRound2SectionRange(lines: string[], fenceMask: boolean[]): { start: number; end: number } {
  for (let index = 0; index < lines.length; index += 1) {
    if (fenceMask[index]) continue
    const heading = parseMarkdownHeading(lines[index])
    if (!heading || !/个股.*(?:走势|支撑|压力)|(?:支撑|压力).*个股/.test(heading.text)) continue
    let end = lines.length
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (fenceMask[cursor]) continue
      const nextHeading = parseMarkdownHeading(lines[cursor])
      if (nextHeading && nextHeading.level <= heading.level) {
        end = cursor
        break
      }
    }
    return { start: index + 1, end }
  }
  return { start: 0, end: lines.length }
}

/**
 * 将第二轮文本拆为 Markdown 与受控行情图段落。模型不能直接写入图表标记；
 * 只有本地候选股票会在各自的支撑/压力位置生成标记。
 */
export function prepareRound2MarketMarkdown(
  sourceMarkdown: string,
  sourceCandidates: Round2InlineCandidate[],
): Round2MarkdownSegment[] {
  const candidates = sourceCandidates
    .map((candidate) => ({
      code: normalizeStockCode(candidate.code),
      name: candidate.name?.trim() || null,
    }))
    .filter((candidate): candidate is { code: string; name: string | null } => candidate.code != null)
    .filter((candidate, index, all) => all.findIndex((item) => item.code === candidate.code) === index)
    .slice(0, 5)

  const sanitized = sourceMarkdown
    .split(/\r?\n/)
    .filter((line) => !INLINE_VISUAL_MARKER_PATTERN.test(line))
    .join('\n')
  if (candidates.length === 0) return [{ kind: 'markdown', markdown: sanitized }]

  const lines = sanitized.split('\n')
  const fenceMask = buildFenceMask(lines)
  const section = findRound2SectionRange(lines, fenceMask)
  const anchors = candidates
    .map((candidate) => {
      let fallbackIndex = -1
      for (let index = section.start; index < section.end; index += 1) {
        if (fenceMask[index] || !containsCandidate(lines[index], candidate)) continue
        if (parseMarkdownHeading(lines[index])) return { candidate, index }
        if (fallbackIndex < 0) fallbackIndex = index
      }
      return fallbackIndex >= 0 ? { candidate, index: fallbackIndex } : null
    })
    .filter((item): item is { candidate: { code: string; name: string | null }; index: number } => item != null)
    .sort((left, right) => left.index - right.index)

  if (anchors.length === 0) return [{ kind: 'markdown', markdown: sanitized }]

  const removedLines = new Set<number>()
  const markersBeforeLine = new Map<number, Array<{ code: string; fallbackMarkdown: string }>>()
  anchors.forEach((anchor, anchorIndex) => {
    const nextDistinctAnchor = anchors.slice(anchorIndex + 1).find((item) => item.index > anchor.index)
    const end = nextDistinctAnchor?.index ?? section.end
    const references: number[] = []
    for (let index = anchor.index; index < end; index += 1) {
      if (fenceMask[index] || parseMarkdownHeading(lines[index])) continue
      if (isSupportPressureReferenceLine(lines[index])) references.push(index)
    }
    const candidateRemovedLines = new Set(references)
    for (const referenceIndex of references) {
      if (!isMarkdownTableRow(lines[referenceIndex])) continue
      let tableStart = referenceIndex
      let tableEnd = referenceIndex + 1
      while (tableStart > anchor.index && isMarkdownTableRow(lines[tableStart - 1])) tableStart -= 1
      while (tableEnd < end && isMarkdownTableRow(lines[tableEnd])) tableEnd += 1
      const separatorIndex = Array.from({ length: tableEnd - tableStart }, (_, offset) => tableStart + offset)
        .find((index) => isMarkdownTableSeparator(lines[index]))
      if (separatorIndex == null) continue
      const remainingDataRows = Array.from({ length: tableEnd - separatorIndex - 1 }, (_, offset) => separatorIndex + offset + 1)
        .filter((index) => !references.includes(index))
      if (remainingDataRows.length === 0) {
        for (let index = tableStart; index < tableEnd; index += 1) candidateRemovedLines.add(index)
      }
    }
    const removedIndexes = [...candidateRemovedLines].sort((left, right) => left - right)
    const insertionIndex = removedIndexes[0] ?? end
    removedIndexes.forEach((index) => removedLines.add(index))
    const marker = {
      code: anchor.candidate.code,
      fallbackMarkdown: removedIndexes.map((index) => lines[index]).join('\n'),
    }
    markersBeforeLine.set(insertionIndex, [...(markersBeforeLine.get(insertionIndex) ?? []), marker])
  })

  const outputLines: string[] = []
  const fallbackByCode = new Map<string, string>()
  for (let index = 0; index <= lines.length; index += 1) {
    for (const marker of markersBeforeLine.get(index) ?? []) {
      outputLines.push(`${INLINE_VISUAL_MARKER_PREFIX}${marker.code} -->`)
      fallbackByCode.set(marker.code, marker.fallbackMarkdown)
    }
    if (index < lines.length && !removedLines.has(index)) outputLines.push(lines[index])
  }

  const segments: Round2MarkdownSegment[] = []
  let markdownBuffer: string[] = []
  const flushMarkdown = () => {
    const markdown = markdownBuffer.join('\n').trim()
    if (markdown) segments.push({ kind: 'markdown', markdown })
    markdownBuffer = []
  }
  for (const line of outputLines) {
    const marker = line.match(INLINE_VISUAL_MARKER_PATTERN)
    if (!marker) {
      markdownBuffer.push(line)
      continue
    }
    flushMarkdown()
    segments.push({ kind: 'visual', code: marker[1], fallbackMarkdown: fallbackByCode.get(marker[1]) ?? '' })
  }
  flushMarkdown()
  return segments.length > 0 ? segments : [{ kind: 'markdown', markdown: sanitized }]
}

function finitePositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function movingAverage(rows: Round2MarketBar[], count: number): number | null {
  if (rows.length < count) return null
  return rows.slice(-count).reduce((sum, row) => sum + row.close, 0) / count
}

function movingAverageSeries(rows: Round2MarketBar[], count: number): Array<{ tradeDate: string; value: number }> {
  if (rows.length < count) return []
  return rows.slice(count - 1).map((row, offset) => ({
    tradeDate: row.tradeDate,
    value: rows.slice(offset, offset + count).reduce((sum, item) => sum + item.close, 0) / count,
  }))
}

function closeReturn(rows: Round2MarketBar[], interval: number): number | null {
  if (rows.length <= interval) return null
  const start = rows[rows.length - interval - 1].close
  return start > 0 ? ((rows[rows.length - 1].close / start) - 1) * 100 : null
}

function priceRange(rows: Round2MarketBar[], count: number): { low: number; high: number } | null {
  if (rows.length < count) return null
  const rangeRows = rows.slice(-count)
  return {
    low: Math.min(...rangeRows.map((row) => row.low)),
    high: Math.max(...rangeRows.map((row) => row.high)),
  }
}

function classifyTrend(
  latestClose: number,
  ma5: number,
  ma20: number | null,
  return5: number | null,
): { tone: Round2TrendTone; label: string } {
  if (ma20 != null && latestClose > ma5 && ma5 > ma20 && (return5 ?? 0) > 0) {
    return { tone: 'strong', label: '偏强' }
  }
  if (ma20 != null && latestClose < ma5 && ma5 < ma20 && (return5 ?? 0) < 0) {
    return { tone: 'weak', label: '偏弱' }
  }
  if (latestClose >= ma5 && (return5 ?? 0) > 0 && (ma20 == null || latestClose < ma20 || ma5 <= ma20)) {
    return { tone: 'recovering', label: '修复' }
  }
  if (latestClose < ma5 && (return5 ?? 0) < 0 && (ma20 == null || latestClose >= ma20 || ma5 >= ma20)) {
    return { tone: 'weakening', label: '转弱' }
  }
  return { tone: 'range', label: '震荡' }
}

export function toBeijingTradeDate(value: string): string | null {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

export function toAshareTsCode(value: string): string | null {
  const normalized = value.trim().toUpperCase()
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) return normalized
  if (!/^\d{6}$/.test(normalized)) return null
  if (/^[48]/.test(normalized)) return `${normalized}.BJ`
  if (normalized.startsWith('6')) return `${normalized}.SH`
  return `${normalized}.SZ`
}

export function buildRound2MarketVisualModel(
  sourceRows: Round2MarketSourceRow[],
  cutoffDate: string,
): Round2MarketVisualModel {
  const validCutoff = /^\d{8}$/.test(cutoffDate)
  const rowsByDate = new Map<string, Round2MarketBar>()
  if (validCutoff) {
    for (const row of sourceRows) {
      if (!/^\d{8}$/.test(row.tradeDate) || row.tradeDate > cutoffDate) continue
      if (!finitePositive(row.open) || !finitePositive(row.high) || !finitePositive(row.low) || !finitePositive(row.close)) continue
      if (row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || row.low > row.high) continue
      rowsByDate.set(row.tradeDate, {
        tradeDate: row.tradeDate,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        pctChg: typeof row.pctChg === 'number' && Number.isFinite(row.pctChg) ? row.pctChg : null,
      })
    }
  }
  const rows = [...rowsByDate.values()]
    .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate))
    .slice(-MAX_ROWS)

  const base: Round2MarketVisualModel = {
    status: 'insufficient',
    cutoffDate,
    rows,
    latestTradeDate: rows.at(-1)?.tradeDate ?? null,
    latestClose: rows.at(-1)?.close ?? null,
    latestPctChg: null,
    return5: null,
    return20: null,
    ma5: null,
    ma20: null,
    ma5Series: [],
    ma20Series: [],
    support5: null,
    support20: null,
    pressure5: null,
    pressure20: null,
    trendTone: null,
    trendLabel: '样本不足',
    reason: validCutoff ? 'insufficient_rows' : 'invalid_cutoff',
  }
  if (rows.length < MIN_ROWS) return base

  const latest = rows[rows.length - 1]
  const previous = rows.at(-2)
  const latestPctChg = latest.pctChg ?? (previous ? ((latest.close / previous.close) - 1) * 100 : null)
  const ma5 = movingAverage(rows, 5)!
  const ma20 = movingAverage(rows, 20)
  const return5 = closeReturn(rows, 5)
  const range5 = priceRange(rows, 5)!
  const range20 = priceRange(rows, 20)
  const trend = classifyTrend(latest.close, ma5, ma20, return5)

  return {
    ...base,
    status: 'ready',
    latestClose: latest.close,
    latestPctChg,
    return5,
    return20: closeReturn(rows, 20),
    ma5,
    ma20,
    ma5Series: movingAverageSeries(rows, 5),
    ma20Series: movingAverageSeries(rows, 20),
    support5: range5.low,
    support20: range20?.low ?? null,
    pressure5: range5.high,
    pressure20: range20?.high ?? null,
    trendTone: trend.tone,
    trendLabel: trend.label,
    reason: null,
  }
}
