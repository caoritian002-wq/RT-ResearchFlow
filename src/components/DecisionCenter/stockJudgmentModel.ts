import type { DecisionSignalItem } from './SignalCard'
import type { DecisionActionItem } from './decisionActionQueue'
import type { PortfolioHoldingRow } from './portfolioCommandModel'
import { isPortfolioSignal, isRiskSignal } from './decisionSections'

export type StockJudgmentTag = 'watch' | 'risk_off' | 'noise' | 'insufficient' | 'done'

export interface StockEvidenceItem {
  key: string
  label: string
  status: 'ready' | 'missing' | 'blocked'
  detail: string
}

export interface StockJudgmentModel {
  tsCode: string
  stockName: string
  isPortfolio: boolean
  primarySignal: DecisionSignalItem
  relatedSignals: DecisionSignalItem[]
  sourceCount: number
  maxPriority: number
  whyTitle: string
  whySummary: string
  whyReasons: string[]
  trustHint: string
  evidence: StockEvidenceItem[]
  costPrice: number | null
  profitPct: number | null
  holding: PortfolioHoldingRow | null
}

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function normalizeCode(code: string): string {
  return code.includes('.') ? code.split('.')[0]! : code
}

function readNum(context: Record<string, unknown>, key: string): number | null {
  const value = context[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 从组合待办项或单信号构建按股研判视图模型。
 * 阶段 B 批 1/2 共用; 不请求新 IPC。
 */
export function buildStockJudgmentModel(
  primary: DecisionSignalItem,
  options?: {
    relatedSignals?: DecisionSignalItem[]
    holdings?: PortfolioHoldingRow[] | null
    actionItem?: DecisionActionItem | null
  },
): StockJudgmentModel | null {
  if (!primary.tsCode) return null
  const code = normalizeCode(primary.tsCode)
  const related = (options?.relatedSignals ?? [primary]).filter((signal) => {
    if (!signal.tsCode) return signal.id === primary.id
    return normalizeCode(signal.tsCode) === code
  })
  const pool = related.length > 0 ? related : [primary]
  const ranked = [...pool].sort((a, b) => {
    const score = (s: DecisionSignalItem) =>
      s.priority * 1000 + (isRiskSignal(s) ? 500 : 0) + (s.status === 'NEW' ? 300 : 0) + s.signalTime / 1e11
    return score(b) - score(a) || b.id - a.id
  })
  const main = ranked[0] ?? primary
  const reason = parseJson(main.reasonJson) ?? {}
  const sourceRef = parseJson(main.sourceRefJson) ?? {}
  const context = { ...sourceRef, ...reason }
  const holding = (options?.holdings ?? []).find((row) => normalizeCode(row.tsCode) === code) ?? null
  const costPrice = holding?.costPrice ?? readNum(context, 'costPrice')
  const profitPct = readNum(context, 'profitPct')
  const triggerPrice = readNum(context, 'triggerPrice')

  const evidence: StockEvidenceItem[] = [
    {
      key: 'cost',
      label: '持仓成本',
      status: costPrice != null ? 'ready' : (holding || isPortfolioSignal(main) ? 'missing' : 'blocked'),
      detail: costPrice != null ? `成本价 ${costPrice}` : (holding || isPortfolioSignal(main) ? '缺少成本价' : '非持仓或未映射'),
    },
    {
      key: 'profit',
      label: '浮盈亏',
      status: profitPct != null ? 'ready' : (costPrice != null ? 'blocked' : 'missing'),
      detail: profitPct != null
        ? `${profitPct > 0 ? '+' : ''}${profitPct.toFixed(2)}%`
        : (costPrice != null ? '有成本但暂无浮盈字段' : '需成本与现价'),
    },
    {
      key: 'trend',
      label: '趋势/预警',
      status: main.sourceModule === 'trend' || triggerPrice != null ? 'ready' : 'blocked',
      detail: triggerPrice != null
        ? `触发价 ${triggerPrice}`
        : (main.sourceModule === 'trend' ? main.title : '当前主线索非趋势预警'),
    },
    {
      key: 'news',
      label: '资讯/AI 线索',
      status: pool.some((s) => s.sourceModule === 'news' || s.sourceModule === 'ai') ? 'ready' : 'blocked',
      detail: (() => {
        const n = pool.filter((s) => s.sourceModule === 'news' || s.sourceModule === 'ai').length
        return n > 0 ? `${n} 条相关线索` : '无资讯/AI 子线索'
      })(),
    },
    {
      key: 'short',
      label: '短线/其它线索',
      status: pool.some((s) => s.sourceModule === 'short_term' || s.sourceModule === 'sector_flow' || s.sourceModule === 'market') ? 'ready' : 'blocked',
      detail: (() => {
        const n = pool.filter((s) => ['short_term', 'sector_flow', 'market', 'manual'].includes(s.sourceModule)).length
        return n > 0 ? `${n} 条相关线索` : '无短线/市场子线索'
      })(),
    },
  ]

  const action = options?.actionItem
  return {
    tsCode: main.tsCode ?? code,
    stockName: main.stockName || holding?.stockName || code,
    isPortfolio: !!holding || isPortfolioSignal(main),
    primarySignal: main,
    relatedSignals: pool,
    sourceCount: action?.sourceCount ?? pool.length,
    maxPriority: Math.max(...pool.map((s) => s.priority)),
    whyTitle: action?.displayTitle ?? main.title,
    whySummary: action?.displaySummary ?? main.summary,
    whyReasons: action?.reasons ?? [],
    trustHint: action?.trustHint ?? '该研判仅作辅助复核, 不构成交易指令。',
    evidence,
    costPrice,
    profitPct,
    holding,
  }
}

export const JUDGMENT_TAG_OPTIONS: Array<{ value: StockJudgmentTag; label: string; hint: string }> = [
  { value: 'watch', label: '继续观察', hint: '保持关注, 不结案' },
  { value: 'risk_off', label: '风险规避', hint: '持仓风险优先跟踪' },
  { value: 'noise', label: '噪音/忽略', hint: '移出开放待办' },
  { value: 'insufficient', label: '信息不足', hint: '缺证据, 先补齐' },
  { value: 'done', label: '已处理有效', hint: '结案并标记已读' },
]

export interface ApplyStockJudgmentResult {
  ok: boolean
  message?: string
  error?: string
  data?: DecisionSignalItem
}

/**
 * 将按股结论保存为独立判断事实，并由主进程原子投影来源信号。
 */
export async function applyStockJudgment(payload: {
  requestId: string
  tsCode: string
  stockName: string
  tag: StockJudgmentTag
  note?: string
  sourceSignalId: number
  relatedSignalIds: number[]
  evidenceSnapshot: {
    primaryTitle: string
    primarySummary: string
    sourceCount: number
    maxPriority: number
    trustHint: string
    evidence: StockEvidenceItem[]
  }
}): Promise<ApplyStockJudgmentResult> {
  const res = await window.api.decision.saveJudgment(payload)
  if (!res.ok) {
    return { ok: false, message: res.message, error: res.error }
  }
  return { ok: true, data: res.data?.projectedSignal ?? undefined }
}
