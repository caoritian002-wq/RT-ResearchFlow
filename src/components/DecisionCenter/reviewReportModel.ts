import type { DecisionSignalItem } from './SignalCard'
import type { DecisionPortfolioRiskReviewData } from './decisionReviewStatsModel'
import {
  buildPortfolioCommandSummary,
  type PortfolioHoldingRow,
} from './portfolioCommandModel'
import { isPortfolioSignal, isRiskSignal } from './decisionSections'
import type { StockJudgmentTag } from './stockJudgmentModel'
import { JUDGMENT_TAG_OPTIONS } from './stockJudgmentModel'
import type { DecisionJudgmentSummaryItem } from './JudgmentHistoryPanel'

/** 周报告固定为近 7 个自然日 (含今日), 规格二选一写死 */
export const WEEKLY_REVIEW_RANGE_DAYS = 7

export type ReviewReportKind = 'daily' | 'weekly'

export interface ParsedJudgmentNote {
  tag: StockJudgmentTag | null
  tagLabel: string | null
  note: string
  raw: string
}

export interface ReviewReportProcessedItem {
  tsCode: string | null
  stockName: string
  tag: StockJudgmentTag | null
  tagLabel: string
  note: string
  title: string
  signalId: number
  resolvedAt: number | null
}

export interface ReviewReportOpenRiskItem {
  tsCode: string | null
  stockName: string
  title: string
  priority: number
  status: string
  signalId: number
}

export interface ReviewReportEvidenceGapItem {
  tsCode: string
  stockName: string
  reason: string
}

export interface ReviewReportFollowUpItem {
  tsCode: string | null
  stockName: string
  tagLabel: string
  note: string
  title: string
  signalId: number
}

export interface ReviewReportJudgmentFollowUpTask {
  judgmentId: string
  tsCode: string
  stockName: string | null
  tag: StockJudgmentTag
  note: string
  reviewDueAt: number
}

export interface ReviewReportSummaryBar {
  holdingCount: number
  portfolioSignalCount: number
  processedCount: number
  openRiskCount: number
  evidenceGapCount: number
  followUpCount: number
}

export interface ReviewReport {
  kind: ReviewReportKind
  rangeDays: number
  generatedAt: number
  title: string
  headline: string
  summary: ReviewReportSummaryBar
  processed: ReviewReportProcessedItem[]
  openRisks: ReviewReportOpenRiskItem[]
  evidenceGaps: ReviewReportEvidenceGapItem[]
  followUps: ReviewReportFollowUpItem[]
  disclaimer: string
  emptyDay: boolean
}

/** @deprecated 使用 ReviewReport; 保留别名兼容 P1 调用 */
export type DailyReviewReport = ReviewReport

const JUDGMENT_TAG_SET = new Set<StockJudgmentTag>(
  JUDGMENT_TAG_OPTIONS.map((item) => item.value),
)

const TAG_LABEL_MAP = Object.fromEntries(
  JUDGMENT_TAG_OPTIONS.map((item) => [item.value, item.label]),
) as Record<StockJudgmentTag, string>

function normalizeCode(code: string): string {
  return code.includes('.') ? code.split('.')[0]! : code
}

function stockLabel(signal: Pick<DecisionSignalItem, 'stockName' | 'tsCode'>): string {
  if (signal.stockName) return signal.stockName
  if (signal.tsCode) return normalizeCode(signal.tsCode)
  return '未命名'
}

/**
 * 从 resolutionNote 解析 [judgment:tag] 前缀。
 * 解析失败时 tag 为 null, 正文保留原文本。
 */
export function parseJudgmentNote(raw: string | null | undefined): ParsedJudgmentNote {
  const text = (raw ?? '').trim()
  if (!text) {
    return { tag: null, tagLabel: null, note: '', raw: '' }
  }
  const match = text.match(/^\[judgment:([a-z_]+)\]\s*(.*)$/i)
  if (!match) {
    return { tag: null, tagLabel: null, note: text, raw: text }
  }
  const candidate = match[1]!.toLowerCase() as StockJudgmentTag
  if (!JUDGMENT_TAG_SET.has(candidate)) {
    return { tag: null, tagLabel: null, note: text, raw: text }
  }
  return {
    tag: candidate,
    tagLabel: TAG_LABEL_MAP[candidate],
    note: (match[2] ?? '').trim(),
    raw: text,
  }
}

function isOpenRiskSignal(signal: DecisionSignalItem): boolean {
  if (signal.status === 'DISMISSED' || signal.status === 'EXPIRED') return false
  if (signal.resolvedAt && signal.status !== 'WATCHING') return false
  if (!isRiskSignal(signal)) return false
  return isPortfolioSignal(signal) || !!signal.tsCode
}

function isProcessedSignal(signal: DecisionSignalItem): boolean {
  if (signal.resolvedAt || signal.resolution) return true
  if (signal.status === 'DISMISSED') return true
  return false
}

function isFollowUpSignal(signal: DecisionSignalItem): boolean {
  if (!isProcessedSignal(signal)) return false
  const parsed = parseJudgmentNote(signal.resolutionNote)
  if (parsed.tag === 'insufficient' || parsed.tag === 'watch') return true
  if (signal.resolution === 'RESOLVED_DATA_ISSUE') return true
  if (signal.status === 'WATCHING' && parsed.tag === 'risk_off') return true
  return false
}

function filterPortfolioSignals(
  signals: DecisionSignalItem[],
  holdings: PortfolioHoldingRow[] | null,
): DecisionSignalItem[] {
  return signals.filter((signal) => {
    if (isPortfolioSignal(signal)) return true
    if (!holdings || !signal.tsCode) return false
    const code = normalizeCode(signal.tsCode)
    return holdings.some((row) => normalizeCode(row.tsCode) === code)
  })
}

function buildEvidenceGaps(
  holdings: PortfolioHoldingRow[] | null,
  portfolioRiskData: DecisionPortfolioRiskReviewData | null,
  signals: DecisionSignalItem[],
): ReviewReportEvidenceGapItem[] {
  const map = new Map<string, ReviewReportEvidenceGapItem>()

  if (holdings) {
    for (const row of holdings) {
      if (row.costPrice != null) continue
      const code = normalizeCode(row.tsCode)
      map.set(code, {
        tsCode: row.tsCode,
        stockName: row.stockName || code,
        reason: '缺少持仓成本价',
      })
    }
  } else if (portfolioRiskData) {
    for (const item of portfolioRiskData.items) {
      if (item.costPrice != null) continue
      const code = normalizeCode(item.tsCode)
      map.set(code, {
        tsCode: item.tsCode,
        stockName: item.stockName || code,
        reason: '缺少持仓成本价',
      })
    }
  }

  for (const signal of signals.filter(isPortfolioSignal)) {
    if (!signal.tsCode) continue
    const code = normalizeCode(signal.tsCode)
    if (map.has(code)) continue
    try {
      const reason = signal.reasonJson ? JSON.parse(signal.reasonJson) as Record<string, unknown> : null
      const sourceRef = signal.sourceRefJson ? JSON.parse(signal.sourceRefJson) as Record<string, unknown> : null
      const hasCost = typeof reason?.costPrice === 'number' || typeof sourceRef?.costPrice === 'number'
      if (!hasCost) {
        map.set(code, {
          tsCode: signal.tsCode,
          stockName: stockLabel(signal),
          reason: '持仓信号缺少成本上下文',
        })
      }
    } catch {
      // 解析失败不伪造缺口
    }
  }

  return Array.from(map.values()).slice(0, 20)
}

function buildProcessedItems(
  portfolioSignals: DecisionSignalItem[],
  judgments: DecisionJudgmentSummaryItem[] = [],
): ReviewReportProcessedItem[] {
  const signalById = new Map(portfolioSignals.map((signal) => [signal.id, signal]))
  const latestJudgmentByCode = new Map<string, DecisionJudgmentSummaryItem>()
  for (const judgment of [...judgments].sort((a, b) => b.createdAt - a.createdAt || b.versionNumber - a.versionNumber)) {
    const code = normalizeCode(judgment.tsCode)
    if (!latestJudgmentByCode.has(code)) latestJudgmentByCode.set(code, judgment)
  }
  const processedPool = portfolioSignals.filter(isProcessedSignal)
  const processedByCode = new Map<string, ReviewReportProcessedItem>()
  for (const judgment of latestJudgmentByCode.values()) {
    const source = judgment.sourceSignalId == null ? null : signalById.get(judgment.sourceSignalId) ?? null
    processedByCode.set(`code:${normalizeCode(judgment.tsCode)}`, {
      tsCode: judgment.tsCode,
      stockName: judgment.stockName || normalizeCode(judgment.tsCode),
      tag: judgment.tag,
      tagLabel: TAG_LABEL_MAP[judgment.tag],
      note: judgment.note || '无备注',
      title: source?.title || '独立判断记录',
      signalId: judgment.sourceSignalId ?? -1,
      resolvedAt: judgment.createdAt,
    })
  }
  for (const signal of processedPool) {
    const key = signal.tsCode ? `code:${normalizeCode(signal.tsCode)}` : `id:${signal.id}`
    if (signal.tsCode && latestJudgmentByCode.has(normalizeCode(signal.tsCode))) continue
    const parsed = parseJudgmentNote(signal.resolutionNote)
    const item: ReviewReportProcessedItem = {
      tsCode: signal.tsCode,
      stockName: stockLabel(signal),
      tag: parsed.tag,
      tagLabel: parsed.tagLabel ?? (signal.status === 'DISMISSED' ? '已忽略' : (signal.resolution ? '已结案' : '已处理')),
      note: parsed.note || (signal.resolutionNote ?? '').trim() || '无备注',
      title: signal.title,
      signalId: signal.id,
      resolvedAt: signal.resolvedAt ?? signal.dismissedAt ?? null,
    }
    const prev = processedByCode.get(key)
    if (!prev) {
      processedByCode.set(key, item)
      continue
    }
    const prevScore = (prev.resolvedAt ?? 0) + (prev.tag ? 1e15 : 0)
    const nextScore = (item.resolvedAt ?? 0) + (item.tag ? 1e15 : 0)
    if (nextScore >= prevScore) processedByCode.set(key, item)
  }
  return Array.from(processedByCode.values())
    .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0) || b.signalId - a.signalId)
    .slice(0, 30)
}

function buildOpenRiskItems(portfolioSignals: DecisionSignalItem[]): ReviewReportOpenRiskItem[] {
  return portfolioSignals
    .filter(isOpenRiskSignal)
    .sort((a, b) => b.priority - a.priority || b.signalTime - a.signalTime)
    .slice(0, 20)
    .map((signal): ReviewReportOpenRiskItem => ({
      tsCode: signal.tsCode,
      stockName: stockLabel(signal),
      title: signal.title,
      priority: signal.priority,
      status: signal.status,
      signalId: signal.id,
    }))
}

function buildFollowUpItems(
  portfolioSignals: DecisionSignalItem[],
  judgments: DecisionJudgmentSummaryItem[] = [],
  judgmentFollowUps: ReviewReportJudgmentFollowUpTask[] = [],
): ReviewReportFollowUpItem[] {
  const latestByCode = new Map<string, DecisionJudgmentSummaryItem>()
  for (const judgment of [...judgments].sort((a, b) => b.createdAt - a.createdAt || b.versionNumber - a.versionNumber)) {
    const code = normalizeCode(judgment.tsCode)
    if (!latestByCode.has(code)) latestByCode.set(code, judgment)
  }
  const fromLedger = judgmentFollowUps
    .map((task): ReviewReportFollowUpItem => ({
      tsCode: task.tsCode,
      stockName: task.stockName || normalizeCode(task.tsCode),
      tagLabel: TAG_LABEL_MAP[task.tag],
      note: task.note || '无备注',
      title: '到期判断待回访',
      signalId: latestByCode.get(normalizeCode(task.tsCode))?.sourceSignalId ?? -1,
    }))
  const legacy = portfolioSignals
    .filter((signal) => !signal.tsCode || !latestByCode.has(normalizeCode(signal.tsCode)))
    .filter(isFollowUpSignal)
    .map((signal): ReviewReportFollowUpItem => {
      const parsed = parseJudgmentNote(signal.resolutionNote)
      return {
        tsCode: signal.tsCode,
        stockName: stockLabel(signal),
        tagLabel: parsed.tagLabel ?? (signal.resolution === 'RESOLVED_DATA_ISSUE' ? '信息不足' : '继续观察'),
        note: parsed.note || (signal.resolutionNote ?? '').trim() || signal.summary,
        title: signal.title,
        signalId: signal.id,
      }
    })
  return [...fromLedger, ...legacy].slice(0, 20)
}

function buildHeadline(input: {
  kind: ReviewReportKind
  rangeDays: number
  holdingCount: number
  pendingCount: number
  emptyDay: boolean
  processedCount: number
  openRiskCount: number
  evidenceGapCount: number
}): string {
  const { kind, rangeDays, holdingCount, pendingCount, emptyDay, processedCount, openRiskCount, evidenceGapCount } = input
  const period = kind === 'weekly' ? `近 ${rangeDays} 日` : '今日'

  if (holdingCount === 0) {
    return kind === 'weekly'
      ? '尚未添加持仓。近一周无组合风险待办; 添加持仓后可生成持仓向周复盘。'
      : '尚未添加持仓。今日无组合风险待办; 添加持仓后可生成持仓向复盘。'
  }
  if (emptyDay) {
    return kind === 'weekly'
      ? `持仓 ${holdingCount} 只, 近 ${rangeDays} 日无持仓相关处理记录, 组合风险整体平稳。`
      : `持仓 ${holdingCount} 只, 今日无新的持仓相关信号, 组合风险平稳。`
  }
  if (openRiskCount > 0) {
    return `${period}已处理 ${processedCount} 只, 仍有 ${openRiskCount} 条未处理持仓风险, 证据缺口 ${evidenceGapCount} 项。`
  }
  if (processedCount > 0) {
    return `${period}已处理 ${processedCount} 只持仓相关线索, 当前无开放持仓风险。`
  }
  return `持仓 ${holdingCount} 只, 组合待办 ${pendingCount} 条, 可继续按股研判后生成更完整复盘。`
}

/**
 * 通用复盘报告派生。
 * - periodSignals: 周期内信号 (日=今日, 周=近 N 日历史)
 * - openRiskSignals: 当前仍开放风险, 默认用 periodSignals; 周报可传入今日开放集
 */
export function buildReviewReport(input: {
  kind: ReviewReportKind
  rangeDays?: number
  signals: DecisionSignalItem[]
  holdings: PortfolioHoldingRow[] | null
  portfolioRiskData?: DecisionPortfolioRiskReviewData | null
  openRiskSignals?: DecisionSignalItem[]
  generatedAt?: number
  judgments?: DecisionJudgmentSummaryItem[]
  judgmentFollowUps?: ReviewReportJudgmentFollowUpTask[]
}): ReviewReport {
  const kind = input.kind
  const rangeDays = input.rangeDays ?? (kind === 'weekly' ? WEEKLY_REVIEW_RANGE_DAYS : 1)
  const generatedAt = input.generatedAt ?? Date.now()
  const holdings = input.holdings
  const portfolioRiskData = input.portfolioRiskData ?? null
  const command = buildPortfolioCommandSummary(input.signals, holdings, portfolioRiskData)

  const portfolioSignals = filterPortfolioSignals(input.signals, holdings)
  const openSource = input.openRiskSignals ?? input.signals
  const openPortfolioSignals = filterPortfolioSignals(openSource, holdings)

  const processed = buildProcessedItems(portfolioSignals, input.judgments)
  const openRisks = buildOpenRiskItems(openPortfolioSignals)
  const evidenceGaps = buildEvidenceGaps(holdings, portfolioRiskData, openSource)
  const followUps = buildFollowUpItems(portfolioSignals, input.judgments, input.judgmentFollowUps)

  const emptyDay = portfolioSignals.length === 0 && openRisks.length === 0 && processed.length === 0
  const holdingCount = command.holdingCount
  const headline = buildHeadline({
    kind,
    rangeDays,
    holdingCount,
    pendingCount: command.pendingCount,
    emptyDay,
    processedCount: processed.length,
    openRiskCount: openRisks.length,
    evidenceGapCount: evidenceGaps.length,
  })

  return {
    kind,
    rangeDays,
    generatedAt,
    title: kind === 'weekly' ? '本周复盘报告' : '今日复盘报告',
    headline,
    summary: {
      holdingCount,
      portfolioSignalCount: portfolioSignals.length,
      processedCount: processed.length,
      openRiskCount: openRisks.length,
      evidenceGapCount: evidenceGaps.length,
      followUpCount: followUps.length,
    },
    processed,
    openRisks,
    evidenceGaps,
    followUps,
    disclaimer: '本报告仅作个人投研辅助复盘, 不构成买卖、仓位或目标价建议。',
    emptyDay,
  }
}

/**
 * 从前端已有 signals/holdings/风险复盘即时派生日复盘报告。
 * 无信号日也返回完整短报告, 不抛错。
 */
export function buildDailyReviewReport(input: {
  signals: DecisionSignalItem[]
  holdings: PortfolioHoldingRow[] | null
  portfolioRiskData?: DecisionPortfolioRiskReviewData | null
  generatedAt?: number
  judgments?: DecisionJudgmentSummaryItem[]
  judgmentFollowUps?: ReviewReportJudgmentFollowUpTask[]
}): ReviewReport {
  return buildReviewReport({
    kind: 'daily',
    rangeDays: 1,
    signals: input.signals,
    holdings: input.holdings,
    portfolioRiskData: input.portfolioRiskData,
    generatedAt: input.generatedAt,
    judgments: input.judgments,
    judgmentFollowUps: input.judgmentFollowUps,
  })
}

/**
 * 周复盘: 近 WEEKLY_REVIEW_RANGE_DAYS 自然日持仓相关历史信号。
 * openRiskSignals 建议传今日开放信号, 避免历史已结案项冒充当前风险。
 */
export function buildWeeklyReviewReport(input: {
  historySignals: DecisionSignalItem[]
  holdings: PortfolioHoldingRow[] | null
  portfolioRiskData?: DecisionPortfolioRiskReviewData | null
  openRiskSignals?: DecisionSignalItem[]
  rangeDays?: number
  generatedAt?: number
  judgments?: DecisionJudgmentSummaryItem[]
  judgmentFollowUps?: ReviewReportJudgmentFollowUpTask[]
}): ReviewReport {
  const rangeDays = input.rangeDays ?? WEEKLY_REVIEW_RANGE_DAYS
  return buildReviewReport({
    kind: 'weekly',
    rangeDays,
    signals: input.historySignals,
    holdings: input.holdings,
    portfolioRiskData: input.portfolioRiskData,
    openRiskSignals: input.openRiskSignals,
    generatedAt: input.generatedAt,
    judgments: input.judgments,
    judgmentFollowUps: input.judgmentFollowUps,
  })
}

/** 将复盘报告转为可复制的纯文本 */
export function formatDailyReviewReportText(report: ReviewReport): string {
  return formatReviewReportText(report)
}

export function formatReviewReportText(report: ReviewReport): string {
  const lines: string[] = []
  lines.push(report.title)
  if (report.kind === 'weekly') {
    lines.push(`范围: 近 ${report.rangeDays} 个自然日 (含今日)`)
  }
  lines.push(report.headline)
  lines.push('')
  lines.push(
    `摘要: 持仓 ${report.summary.holdingCount} · 持仓相关信号 ${report.summary.portfolioSignalCount} · 已处理 ${report.summary.processedCount} · 未处理风险 ${report.summary.openRiskCount} · 证据缺口 ${report.summary.evidenceGapCount} · 待验证 ${report.summary.followUpCount}`,
  )
  lines.push('')
  lines.push('## 已处理')
  if (report.processed.length === 0) {
    lines.push('- 暂无已结案/已忽略的持仓相关处理记录')
  } else {
    for (const item of report.processed) {
      lines.push(`- ${item.stockName} · ${item.tagLabel} · ${item.title}${item.note ? ` · ${item.note}` : ''}`)
    }
  }
  lines.push('')
  lines.push('## 未处理风险')
  if (report.openRisks.length === 0) {
    lines.push('- 当前无开放持仓风险')
  } else {
    for (const item of report.openRisks) {
      lines.push(`- ${item.stockName} · P${item.priority} · ${item.title} · ${item.status}`)
    }
  }
  lines.push('')
  lines.push('## 证据缺口')
  if (report.evidenceGaps.length === 0) {
    lines.push('- 暂无成本等证据缺口')
  } else {
    for (const item of report.evidenceGaps) {
      lines.push(`- ${item.stockName} · ${item.reason}`)
    }
  }
  lines.push('')
  lines.push('## 待验证清单')
  if (report.followUps.length === 0) {
    lines.push('- 暂无信息不足/继续观察类回访点')
  } else {
    for (const item of report.followUps) {
      lines.push(`- ${item.stockName} · ${item.tagLabel} · ${item.title}${item.note ? ` · ${item.note}` : ''}`)
    }
  }
  lines.push('')
  lines.push(report.disclaimer)
  return lines.join('\n')
}
