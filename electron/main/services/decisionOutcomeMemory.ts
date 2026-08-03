/**
 * FR-234: 决策结果回填与偏差画像。
 * 只读聚合 judgment 历史 + 本地日线窗口收益, 不改历史结论, 不触发全市场同步。
 */

import type Database from 'better-sqlite3'
import { queryDecisionSignalsByTimeRange } from '../database/decisionSignalsRepository'
import { listDecisionJudgments } from '../database/decisionJudgmentRepository'
import { queryDailyClose } from '../database/dailyCloseCacheRepository'
import { listPortfolioStocks } from '../database/portfolioRepository'
import type { DecisionSignalRow } from '../database/types'

export const DEFAULT_OUTCOME_HORIZON_DAYS = 5
export const OUTCOME_MIXED_BAND_PCT = 2
export const OUTCOME_MIN_SAMPLE_FOR_BIAS = 5

export type OutcomeJudgmentTag = 'watch' | 'risk_off' | 'noise' | 'insufficient' | 'done'
export type OutcomeLabel = 'aligned' | 'mixed' | 'misaligned' | 'blocked'

export interface DecisionOutcomeMemoryQuery {
  rangeDays?: number
  horizonDays?: number
  portfolioOnly?: boolean
  limit?: number
}

export interface DecisionOutcomeSample {
  tsCode: string
  stockName: string | null
  tag: OutcomeJudgmentTag
  judgmentAt: number
  signalId: number
  title: string
  note: string
  direction: DecisionSignalRow['direction']
  forwardReturnPct: number | null
  outcomeLabel: OutcomeLabel
  outcomeReason: string
  baseTradeDate: string | null
  endTradeDate: string | null
}

export interface DecisionOutcomeBiasTagRow {
  tag: OutcomeJudgmentTag
  total: number
  evaluable: number
  aligned: number
  misaligned: number
  mixed: number
  blocked: number
}

export interface DecisionOutcomeMemoryResult {
  rangeDays: number
  horizonDays: number
  generatedAt: number
  sampleSize: number
  evaluableSize: number
  samples: DecisionOutcomeSample[]
  bias: {
    byTag: DecisionOutcomeBiasTagRow[]
    insufficientSample: boolean
    hint: string
  }
}

const TAG_SET = new Set<OutcomeJudgmentTag>(['watch', 'risk_off', 'noise', 'insufficient', 'done'])

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function normalizeStockCode(code: string | null | undefined): string {
  if (!code) return ''
  return code.includes('.') ? code.split('.')[0]! : code
}

/** 北京时间 YYYYMMDD */
export function bjYmdFromMs(ms: number): string {
  const d = new Date(ms + 8 * 60 * 60 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

export function parseJudgmentTagFromNote(raw: string | null | undefined): {
  tag: OutcomeJudgmentTag | null
  note: string
} {
  const text = (raw ?? '').trim()
  if (!text) return { tag: null, note: '' }
  const match = text.match(/^\[judgment:([a-z_]+)\]\s*(.*)$/i)
  if (!match) return { tag: null, note: text }
  const candidate = match[1]!.toLowerCase() as OutcomeJudgmentTag
  if (!TAG_SET.has(candidate)) return { tag: null, note: text }
  return { tag: candidate, note: (match[2] ?? '').trim() }
}

export function resolveJudgmentAt(signal: Pick<DecisionSignalRow, 'resolvedAt' | 'dismissedAt' | 'lastSeenAt' | 'signalTime'>): number {
  return signal.resolvedAt ?? signal.dismissedAt ?? signal.lastSeenAt ?? signal.signalTime
}

/**
 * 计算结论后第 horizonDays 个交易日相对基准收盘的收益。
 * rows 须按 tradeDate 升序。
 */
export function computeForwardReturnPct(
  rows: Array<{ tradeDate: string; close: number }>,
  judgmentAtMs: number,
  horizonDays: number,
): {
  forwardReturnPct: number | null
  reason: string | null
  baseTradeDate: string | null
  endTradeDate: string | null
} {
  if (!rows.length) {
    return { forwardReturnPct: null, reason: '本地无日线', baseTradeDate: null, endTradeDate: null }
  }
  const judgmentYmd = bjYmdFromMs(judgmentAtMs)
  let baseIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.tradeDate <= judgmentYmd) baseIdx = i
    else break
  }
  if (baseIdx < 0) {
    return { forwardReturnPct: null, reason: '结论日前无收盘价', baseTradeDate: null, endTradeDate: null }
  }
  const endIdx = baseIdx + horizonDays
  if (endIdx >= rows.length) {
    return {
      forwardReturnPct: null,
      reason: `窗口未满 ${horizonDays} 个交易日`,
      baseTradeDate: rows[baseIdx]!.tradeDate,
      endTradeDate: null,
    }
  }
  const baseClose = rows[baseIdx]!.close
  const endClose = rows[endIdx]!.close
  if (!(baseClose > 0) || !Number.isFinite(baseClose) || !Number.isFinite(endClose)) {
    return {
      forwardReturnPct: null,
      reason: '收盘价无效',
      baseTradeDate: rows[baseIdx]!.tradeDate,
      endTradeDate: rows[endIdx]!.tradeDate,
    }
  }
  const forwardReturnPct = ((endClose - baseClose) / baseClose) * 100
  return {
    forwardReturnPct,
    reason: null,
    baseTradeDate: rows[baseIdx]!.tradeDate,
    endTradeDate: rows[endIdx]!.tradeDate,
  }
}

/**
 * 白盒事后标签。noise/insufficient 不参与方向评估。
 */
export function classifyOutcome(input: {
  tag: OutcomeJudgmentTag
  direction: DecisionSignalRow['direction']
  forwardReturnPct: number | null
  blockedReason?: string | null
}): { label: OutcomeLabel; reason: string } {
  const { tag, direction, forwardReturnPct, blockedReason } = input
  if (tag === 'noise') {
    return { label: 'blocked', reason: '噪音标签不参与方向评估' }
  }
  if (tag === 'insufficient') {
    return { label: 'blocked', reason: '信息不足结论不评估方向' }
  }
  if (forwardReturnPct == null) {
    return { label: 'blocked', reason: blockedReason || '收益不可计算' }
  }

  const band = OUTCOME_MIXED_BAND_PCT
  const bearishRule = (): { label: OutcomeLabel; reason: string } => {
    if (forwardReturnPct <= 0) return { label: 'aligned', reason: `窗口收益 ${formatPct(forwardReturnPct)}, 与规避/看空方向一致` }
    if (forwardReturnPct > band) return { label: 'misaligned', reason: `窗口收益 ${formatPct(forwardReturnPct)}, 与规避/看空方向相反` }
    return { label: 'mixed', reason: `窗口收益 ${formatPct(forwardReturnPct)}, 落在 ±${band}% 混合带` }
  }
  const bullishRule = (): { label: OutcomeLabel; reason: string } => {
    if (forwardReturnPct >= 0) return { label: 'aligned', reason: `窗口收益 ${formatPct(forwardReturnPct)}, 与看多方向一致` }
    if (forwardReturnPct < -band) return { label: 'misaligned', reason: `窗口收益 ${formatPct(forwardReturnPct)}, 与看多方向相反` }
    return { label: 'mixed', reason: `窗口收益 ${formatPct(forwardReturnPct)}, 落在 ±${band}% 混合带` }
  }

  if (tag === 'risk_off') return bearishRule()
  if (direction === 'BEARISH') return bearishRule()
  if (direction === 'BULLISH') return bullishRule()
  return { label: 'mixed', reason: `窗口收益 ${formatPct(forwardReturnPct)}, 无明确方向仅作对照` }
}

function formatPct(value: number): string {
  const abs = Math.abs(value).toFixed(2)
  if (value > 0) return `+${abs}%`
  if (value < 0) return `-${abs}%`
  return `${abs}%`
}

function isJudgmentCandidate(signal: DecisionSignalRow): boolean {
  if (!signal.tsCode) return false
  const parsed = parseJudgmentTagFromNote(signal.resolutionNote)
  if (parsed.tag) return true
  // 无 judgment 前缀但已结案/忽略的, 不纳入首版样本, 避免噪声
  return false
}

export interface DecisionOutcomeCandidate {
  tsCode: string
  stockName: string | null
  tag: OutcomeJudgmentTag
  judgmentAt: number
  signalId: number
  title: string
  note: string
  direction: DecisionSignalRow['direction']
}

export function mergeDecisionOutcomeCandidates(input: {
  judgments: Array<{
    tsCode: string
    stockName: string | null
    tag: OutcomeJudgmentTag
    note: string
    createdAt: number
    sourceSignalId: number | null
  }>
  signals: DecisionSignalRow[]
}): DecisionOutcomeCandidate[] {
  const signalById = new Map(input.signals.map((signal) => [signal.id, signal]))
  const ledgerKeys = new Set<string>()
  const candidates: DecisionOutcomeCandidate[] = []

  for (const judgment of input.judgments) {
    const source = judgment.sourceSignalId == null ? null : signalById.get(judgment.sourceSignalId) ?? null
    const key = `${normalizeStockCode(judgment.tsCode)}:${judgment.tag}`
    ledgerKeys.add(key)
    candidates.push({
      tsCode: judgment.tsCode,
      stockName: judgment.stockName,
      tag: judgment.tag,
      judgmentAt: judgment.createdAt,
      signalId: judgment.sourceSignalId ?? -1,
      title: source?.title ?? '独立判断记录',
      note: judgment.note,
      direction: source?.direction ?? 'NEUTRAL',
    })
  }

  for (const signal of input.signals.filter(isJudgmentCandidate)) {
    const parsed = parseJudgmentTagFromNote(signal.resolutionNote)
    const key = `${normalizeStockCode(signal.tsCode)}:${parsed.tag}`
    if (ledgerKeys.has(key)) continue
    candidates.push({
      tsCode: signal.tsCode!,
      stockName: signal.stockName,
      tag: parsed.tag!,
      judgmentAt: resolveJudgmentAt(signal),
      signalId: signal.id,
      title: signal.title,
      note: parsed.note,
      direction: signal.direction,
    })
  }

  return candidates.sort((a, b) => b.judgmentAt - a.judgmentAt || b.signalId - a.signalId)
}

function buildBias(
  samples: DecisionOutcomeSample[],
): DecisionOutcomeMemoryResult['bias'] {
  const tags: OutcomeJudgmentTag[] = ['watch', 'risk_off', 'noise', 'insufficient', 'done']
  const byTag: DecisionOutcomeBiasTagRow[] = tags.map((tag) => {
    const list = samples.filter((item) => item.tag === tag)
    const evaluable = list.filter((item) => item.outcomeLabel !== 'blocked')
    return {
      tag,
      total: list.length,
      evaluable: evaluable.length,
      aligned: list.filter((item) => item.outcomeLabel === 'aligned').length,
      misaligned: list.filter((item) => item.outcomeLabel === 'misaligned').length,
      mixed: list.filter((item) => item.outcomeLabel === 'mixed').length,
      blocked: list.filter((item) => item.outcomeLabel === 'blocked').length,
    }
  }).filter((row) => row.total > 0)

  const evaluableSize = samples.filter((item) => item.outcomeLabel !== 'blocked').length
  const insufficientSample = evaluableSize < OUTCOME_MIN_SAMPLE_FOR_BIAS
  const hint = insufficientSample
    ? `可评估样本仅 ${evaluableSize} 条, 不足 ${OUTCOME_MIN_SAMPLE_FOR_BIAS} 条, 只适合个人回看, 不构成胜率结论。`
    : `可评估样本 ${evaluableSize} 条, 仅作个人判断对照, 不构成投资建议或策略胜率。`

  return { byTag, insufficientSample, hint }
}

/**
 * 聚合决策事后对照。
 */
export function getDecisionOutcomeMemory(
  db: Database.Database,
  query: DecisionOutcomeMemoryQuery = {},
): DecisionOutcomeMemoryResult {
  const rangeDays = clampInt(query.rangeDays ?? 30, 7, 90)
  const horizonRaw = query.horizonDays ?? DEFAULT_OUTCOME_HORIZON_DAYS
  const horizonDays = horizonRaw === 3 ? 3 : DEFAULT_OUTCOME_HORIZON_DAYS
  const limit = clampInt(query.limit ?? 50, 1, 100)
  const portfolioOnly = query.portfolioOnly !== false
  const generatedAt = Date.now()
  const startTime = generatedAt - rangeDays * 24 * 60 * 60 * 1000

  const signals = queryDecisionSignalsByTimeRange(db, startTime, generatedAt + 1, { limit: 5000 })
  const judgments = listDecisionJudgments(db, {
    from: startTime,
    to: generatedAt,
    latestPerGroup: false,
    limit: 100,
  }).items
  const portfolioCodes = portfolioOnly
    ? new Set(listPortfolioStocks(db).map((item) => normalizeStockCode(item.tsCode)).filter(Boolean))
    : null
  const candidates = mergeDecisionOutcomeCandidates({ judgments, signals })
    .filter((candidate) => !portfolioCodes || portfolioCodes.has(normalizeStockCode(candidate.tsCode)))

  const dedup = new Map<string, typeof candidates[number]>()
  for (const item of candidates) {
    const key = `${normalizeStockCode(item.tsCode)}:${item.tag}`
    if (!dedup.has(key)) dedup.set(key, item)
  }
  const unique = [...dedup.values()].slice(0, limit)

  const tsCodes = [...new Set(unique.map((item) => item.tsCode).filter(Boolean))]
  // 多取一些历史日线, 覆盖 range + horizon
  const lookbackStart = bjYmdFromMs(startTime - 40 * 24 * 60 * 60 * 1000)
  const dailyMap = queryDailyClose(db, tsCodes, lookbackStart)

  const samples: DecisionOutcomeSample[] = unique.map((item) => {
    const code = item.tsCode
    const rows = (dailyMap.get(code) ?? dailyMap.get(normalizeStockCode(code)) ?? [])
      .filter((row) => Number.isFinite(row.close))
      .map((row) => ({ tradeDate: row.tradeDate, close: row.close as number }))

    if (item.tag === 'noise' || item.tag === 'insufficient') {
      const classified = classifyOutcome({
        tag: item.tag,
        direction: item.direction,
        forwardReturnPct: null,
      })
      return {
        tsCode: code,
        stockName: item.stockName,
        tag: item.tag,
        judgmentAt: item.judgmentAt,
        signalId: item.signalId,
        title: item.title,
        note: item.note,
        direction: item.direction,
        forwardReturnPct: null,
        outcomeLabel: classified.label,
        outcomeReason: classified.reason,
        baseTradeDate: null,
        endTradeDate: null,
      }
    }

    const ret = computeForwardReturnPct(rows, item.judgmentAt, horizonDays)
    const classified = classifyOutcome({
      tag: item.tag,
      direction: item.direction,
      forwardReturnPct: ret.forwardReturnPct,
      blockedReason: ret.reason,
    })
    return {
      tsCode: code,
      stockName: item.stockName,
      tag: item.tag,
      judgmentAt: item.judgmentAt,
      signalId: item.signalId,
      title: item.title,
      note: item.note,
      direction: item.direction,
      forwardReturnPct: ret.forwardReturnPct,
      outcomeLabel: classified.label,
      outcomeReason: classified.reason,
      baseTradeDate: ret.baseTradeDate,
      endTradeDate: ret.endTradeDate,
    }
  })

  const evaluableSize = samples.filter((item) => item.outcomeLabel !== 'blocked').length
  return {
    rangeDays,
    horizonDays,
    generatedAt,
    sampleSize: samples.length,
    evaluableSize,
    samples,
    bias: buildBias(samples),
  }
}
