import type Database from 'better-sqlite3'
import type { AIProviderUsage } from './aiProvider'
import type { AIProvider } from '../database/types'
import type { ScreenerInsightRow } from '../database/types'
import { getScreenerInsight as getCachedScreenerInsight, upsertScreenerInsight } from '../database/screenerInsightsRepository'
import { callWithFallback } from './aiFallbackService'
import { buildScreenerInsightEvidence, type ScreenerInsightEvidence } from './screenerInsightEvidenceService'

export interface ScreenerInsightSections {
  hitReason: string
  catalyst: string
  technicalContext: string
  risks: string
}

export interface ScreenerInsightResponse {
  tradeDate: string
  tsCode: string
  stockName: string | null
  sections: ScreenerInsightSections
  confidenceBoundary: string
  evidenceSummary: string[]
  evidenceHash: string
  fromCache: boolean
  provider: string | null
  model: string | null
  usage?: AIProviderUsage
  finishReason?: string | null
  complianceBlocked: boolean
  updatedAt: number
}

const inFlight = new Map<string, Promise<ScreenerInsightResponse>>()

const BANNED_TERMS = ['买入', '卖出', '目标价', '仓位', '止盈', '止损', '必涨', '确定性机会', '满仓', '清仓']

function parseInsightJson(raw: string): ScreenerInsightSections | null {
  try {
    const parsed = JSON.parse(raw) as { sections?: Partial<ScreenerInsightSections> }
    const sections = parsed.sections ?? (parsed as Partial<ScreenerInsightSections>)
    if (!sections || typeof sections !== 'object') return null
    return {
      hitReason: String((sections as Partial<ScreenerInsightSections>).hitReason ?? '').trim(),
      catalyst: String((sections as Partial<ScreenerInsightSections>).catalyst ?? '').trim(),
      technicalContext: String((sections as Partial<ScreenerInsightSections>).technicalContext ?? '').trim(),
      risks: String((sections as Partial<ScreenerInsightSections>).risks ?? '').trim(),
    }
  } catch {
    return null
  }
}

function fallbackSections(evidence: ScreenerInsightEvidence): ScreenerInsightSections {
  const conditions = evidence.screener.conditionsMet.length > 0 ? evidence.screener.conditionsMet.join('、') : '本地条件命中但明细缺失'
  const concepts = evidence.screener.concepts.length > 0 ? evidence.screener.concepts.slice(0, 5).join('、') : '暂无明确题材标签'
  const trend = evidence.trend?.totalScore != null ? `趋势评分 ${evidence.trend.totalScore.toFixed(1)}` : '趋势评分暂缺'
  const chip = evidence.chip?.bottomPct != null ? `底部筹码占比 ${evidence.chip.bottomPct.toFixed(2)}%` : '筹码摘要暂缺'
  return {
    hitReason: `该股进入个性选股结果, 主要来自 ${conditions}, 信号强度为 ${evidence.screener.signalScore.toFixed(1)}。`,
    catalyst: `题材侧可参考 ${concepts}; 当前解读仅基于本地题材映射和当日信号, 不代表事件已经兑现。`,
    technicalContext: `${trend}; ${chip}; ${evidence.portfolio.isPortfolio ? '该股属于用户持仓范围, 需要结合成本价和持仓周期复盘。' : '该股不在当前持仓列表。'}`,
    risks: `需要关注 ${evidence.evidenceGaps.length > 0 ? evidence.evidenceGaps.join('、') : '成交连续性、题材持续性和盘中波动'}。以上仅解释筛选证据, 不构成交易指令。`,
  }
}

function buildEvidenceSummary(evidence: ScreenerInsightEvidence): string[] {
  const summary = [
    `信号强度 ${evidence.screener.signalScore.toFixed(1)}`,
    `命中条件 ${evidence.screener.conditionsMet.length} 项`,
  ]
  if (evidence.screener.pctChg != null) summary.push(`涨跌幅 ${evidence.screener.pctChg.toFixed(2)}%`)
  if (evidence.screener.turnoverRate != null) summary.push(`换手率 ${evidence.screener.turnoverRate.toFixed(2)}%`)
  if (evidence.trend?.totalScore != null) summary.push(`趋势评分 ${evidence.trend.totalScore.toFixed(1)}`)
  if (evidence.chip?.bottomPct != null) summary.push(`底部筹码 ${evidence.chip.bottomPct.toFixed(2)}%`)
  if (evidence.portfolio.isPortfolio) summary.push('我的持仓')
  if (evidence.todaySignals.length > 0) summary.push(`今日看板同股信号 ${evidence.todaySignals.length} 条`)
  return summary
}

function buildPrompt(evidence: ScreenerInsightEvidence): string {
  return `你是 A 股个人投研工作台里的证据解释助手。请只解释下面本地证据为什么让该股票进入“个性选股”结果, 不要选股、排序、调参或给交易指令。

严格要求:
1. 只能输出 JSON, 不要 Markdown。
2. JSON 结构为 {"sections":{"hitReason":"...","catalyst":"...","technicalContext":"...","risks":"..."}}。
3. 四段都用简体中文, 每段 1-3 句。
4. 禁止使用“买入、卖出、目标价、仓位、止盈、止损、必涨、确定性机会”等指令性表达。
5. 必须说明这是对本地筛选证据的解释, 不是交易建议。

本地证据 JSON:
${JSON.stringify(evidence, null, 2)}`
}

function hasComplianceRisk(sections: ScreenerInsightSections): boolean {
  const text = Object.values(sections).join('\n')
  return BANNED_TERMS.some(term => text.includes(term))
}

function rowToResponse(row: ScreenerInsightRow, fromCache: boolean): ScreenerInsightResponse {
  const evidence = JSON.parse(row.evidenceJson) as ScreenerInsightEvidence
  const sections = parseInsightJson(row.insightJson) ?? fallbackSections(evidence)
  return {
    tradeDate: row.tradeDate,
    tsCode: row.tsCode,
    stockName: row.stockName,
    sections,
    confidenceBoundary: 'AI 只解释本地证据包, 不参与选股、排序、调参或交易决策。',
    evidenceSummary: buildEvidenceSummary(evidence),
    evidenceHash: row.evidenceHash,
    fromCache,
    provider: row.provider,
    model: row.model,
    usage: row.usageJson ? JSON.parse(row.usageJson) as AIProviderUsage : undefined,
    finishReason: row.finishReason,
    complianceBlocked: row.complianceBlocked === 1,
    updatedAt: row.updatedAt,
  }
}

export async function getScreenerInsight(
  db: Database.Database,
  tradeDate: string,
  tsCode: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ScreenerInsightResponse | null> {
  const built = buildScreenerInsightEvidence(db, tradeDate, tsCode)
  if (!built) return null
  const cacheKey = `${tradeDate}:${built.evidence.tsCode}:${built.evidenceHash}`
  if (!options.forceRefresh) {
    const cached = getCachedScreenerInsight(db, tradeDate, built.evidence.tsCode, built.evidenceHash)
    if (cached) return rowToResponse(cached, true)
  }
  const existing = inFlight.get(cacheKey)
  if (existing) return existing

  const promise = (async () => {
    const prompt = buildPrompt(built.evidence)
    let sections: ScreenerInsightSections
    let provider: string | null = null
    let model: string | null = null
    let usage: AIProviderUsage | undefined
    let finishReason: string | null | undefined
    let complianceBlocked = false

    try {
      const result = await callWithFallback(db, { prompt })
      provider = result.provider
      model = result.model
      usage = result.usage
      finishReason = result.finishReason
      sections = parseInsightJson(result.text) ?? fallbackSections(built.evidence)
      complianceBlocked = parseInsightJson(result.text) == null || hasComplianceRisk(sections)
      if (complianceBlocked) sections = fallbackSections(built.evidence)
    } catch (err) {
      console.warn('[screenerInsightService] AI insight failed:', err instanceof Error ? err.message : err)
      sections = fallbackSections(built.evidence)
      complianceBlocked = true
    }

    const row = upsertScreenerInsight(db, {
      tradeDate,
      tsCode: built.evidence.tsCode,
      stockName: built.evidence.stockName,
      evidenceHash: built.evidenceHash,
      evidenceJson: JSON.stringify(built.evidence),
      insightJson: JSON.stringify({ sections }),
      provider: provider as AIProvider | null,
      model,
      usageJson: usage ? JSON.stringify(usage) : null,
      finishReason: finishReason ?? null,
      complianceBlocked,
    })
    return rowToResponse(row, false)
  })()

  inFlight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    inFlight.delete(cacheKey)
  }
}