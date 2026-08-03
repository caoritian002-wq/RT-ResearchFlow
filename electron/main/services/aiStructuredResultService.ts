import type Database from 'better-sqlite3'
import type { AIAnalysisSessionRow, AIAnalysisStructuredResultRow } from '../database/types'
import { getSession } from '../database/aiAnalysisSessionRepository'
import { getStructuredResultBySessionId, upsertStructuredResult } from '../database/aiAnalysisStructuredResultRepository'
import { searchByNameOrCode } from '../database/stockBasicCacheRepository'
import { listPortfolioStocks } from '../database/portfolioRepository'
import type { PortfolioStockRow } from '../database/types'
import { callWithFallback } from './aiFallbackService'
import { emitDecisionSignals, type DecisionSignalInput } from './decisionSignalService'

export interface StructuredTheme {
  name: string
  direction: 'positive' | 'negative' | 'neutral' | 'mixed'
  confidence: number
  evidence: string
}

export interface StructuredCandidateStock {
  code: string
  name?: string | null
  direction: 'positive' | 'negative' | 'mixed' | 'unclear'
  evidenceLevel: 'direct' | 'inferred' | 'unverified'
  reason: string
  confidence: number
  evidence: string[]
  riskNotes: string[]
}

export interface StructuredVerificationItem {
  title: string
  status: 'todo' | 'done' | 'blocked'
  reason: string
}

export interface StructuredSourceRef {
  type: 'article' | 'round1' | 'round2' | 'followUp'
  title: string
  excerpt: string
}

export interface AIAnalysisStructuredResult {
  status: 'completed' | 'parse_failed'
  schemaVersion: number
  summary: string | null
  confidence: number | null
  primaryTheme: string | null
  themes: StructuredTheme[]
  candidateStocks: StructuredCandidateStock[]
  riskFactors: string[]
  verificationItems: StructuredVerificationItem[]
  sourceRefs: StructuredSourceRef[]
  errorMessage: string | null
  generatedAt: number | null
}

interface RawStructuredPayload {
  summary?: unknown
  confidence?: unknown
  primaryTheme?: unknown
  themes?: unknown
  candidateStocks?: unknown
  riskFactors?: unknown
  verificationItems?: unknown
  sourceRefs?: unknown
}

const SCHEMA_VERSION = 2
const BANNED_TERMS = ['买入', '卖出', '目标价', '仓位', '止盈', '止损', '必涨', '确定性机会', '满仓', '清仓']

function clampConfidence(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0.5
  if (numeric > 1) return Math.max(0, Math.min(1, numeric / 100))
  return Math.max(0, Math.min(1, numeric))
}

function text(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim()
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function candidateDirection(value: unknown): StructuredCandidateStock['direction'] {
  const normalized = text(value).toLowerCase()
  return ['positive', 'negative', 'mixed', 'unclear'].includes(normalized)
    ? normalized as StructuredCandidateStock['direction']
    : 'unclear'
}

function candidateEvidenceLevel(value: unknown): StructuredCandidateStock['evidenceLevel'] {
  const normalized = text(value).toLowerCase()
  return ['direct', 'inferred', 'unverified'].includes(normalized)
    ? normalized as StructuredCandidateStock['evidenceLevel']
    : 'unverified'
}

function extractJsonObject(raw: string): RawStructuredPayload {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] ?? raw
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first < 0 || last < first) throw new Error('AI_STRUCTURED_JSON_NOT_FOUND')
  return JSON.parse(candidate.slice(first, last + 1)) as RawStructuredPayload
}

function normalizeStockCode(raw: string): string | null {
  const code = raw.trim().replace(/\.(SH|SZ|BJ)$/i, '')
  return /^\d{6}$/.test(code) ? code : null
}

function enrichStockName(db: Database.Database, code: string, rawName: unknown): string | null {
  const name = text(rawName)
  if (name) return name
  const matched = searchByNameOrCode(db, code, 1)[0]
  return matched?.name ?? null
}

function containsBannedTerms(result: Omit<AIAnalysisStructuredResult, 'status' | 'schemaVersion' | 'errorMessage' | 'generatedAt'>): boolean {
  const body = JSON.stringify(result)
  return BANNED_TERMS.some((term) => body.includes(term))
}

function normalizePayload(db: Database.Database, payload: RawStructuredPayload): Omit<AIAnalysisStructuredResult, 'status' | 'schemaVersion' | 'errorMessage' | 'generatedAt'> {
  const themes: StructuredTheme[] = safeArray(payload.themes).slice(0, 8).map((item) => {
    const record = item as Record<string, unknown>
    const direction = text(record.direction) as StructuredTheme['direction']
    return {
      name: text(record.name, '未命名主题').slice(0, 40),
      direction: ['positive', 'negative', 'neutral', 'mixed'].includes(direction) ? direction : 'mixed',
      confidence: clampConfidence(record.confidence),
      evidence: text(record.evidence).slice(0, 220)
    }
  }).filter((item) => item.name.length > 0)

  const candidateStocks: StructuredCandidateStock[] = []
  for (const item of safeArray(payload.candidateStocks).slice(0, 12)) {
    const record = item as Record<string, unknown>
    const code = normalizeStockCode(text(record.code))
    if (!code) continue
    candidateStocks.push({
      code,
      name: enrichStockName(db, code, record.name),
      direction: candidateDirection(record.direction),
      evidenceLevel: candidateEvidenceLevel(record.evidenceLevel),
      reason: text(record.reason).slice(0, 220),
      confidence: clampConfidence(record.confidence),
      evidence: safeArray(record.evidence).map((entry) => text(entry).slice(0, 140)).filter(Boolean).slice(0, 4),
      riskNotes: safeArray(record.riskNotes).map((entry) => text(entry).slice(0, 140)).filter(Boolean).slice(0, 4)
    })
  }

  const verificationItems: StructuredVerificationItem[] = safeArray(payload.verificationItems).slice(0, 8).map((item) => {
    const record = item as Record<string, unknown>
    const status = text(record.status) as StructuredVerificationItem['status']
    return {
      title: text(record.title, '待验证事项').slice(0, 60),
      status: ['todo', 'done', 'blocked'].includes(status) ? status : 'todo',
      reason: text(record.reason).slice(0, 180)
    }
  }).filter((item) => item.title.length > 0)

  const sourceRefs: StructuredSourceRef[] = safeArray(payload.sourceRefs).slice(0, 8).map((item) => {
    const record = item as Record<string, unknown>
    const type = text(record.type) as StructuredSourceRef['type']
    return {
      type: ['article', 'round1', 'round2', 'followUp'].includes(type) ? type : 'round1',
      title: text(record.title, '来源片段').slice(0, 80),
      excerpt: text(record.excerpt).slice(0, 220)
    }
  }).filter((item) => item.excerpt.length > 0)

  const result = {
    summary: text(payload.summary).slice(0, 360) || null,
    confidence: clampConfidence(payload.confidence),
    primaryTheme: text(payload.primaryTheme).slice(0, 60) || themes[0]?.name || null,
    themes,
    candidateStocks,
    riskFactors: safeArray(payload.riskFactors).map((item) => text(item).slice(0, 160)).filter(Boolean).slice(0, 8),
    verificationItems,
    sourceRefs
  }
  if (!result.summary) throw new Error('AI_STRUCTURED_SUMMARY_EMPTY')
  if (containsBannedTerms(result)) throw new Error('AI_STRUCTURED_COMPLIANCE_BLOCKED')
  return result
}

function buildSourceText(session: AIAnalysisSessionRow): string {
  const messages = session.messages ? JSON.parse(session.messages) as Array<{ role: string; content: string }> : []
  return [
    '首轮研判:',
    session.response ?? '',
    '第二轮行情复核:',
    session.responseRound2 ?? '',
    '追问记录:',
    ...messages.map((message) => `${message.role}: ${message.content}`)
  ].filter(Boolean).join('\n')
}

function buildPrompt(session: AIAnalysisSessionRow): string {
  const sourceText = buildSourceText(session)
  return `你是 A 股个人投研工作台的结构化研判整理器。请把下面 AI 分析会话整理成严格 JSON, 只做文本结构化, 不新增事实, 不给交易指令。

严格要求:
1. 只能输出 JSON, 不要 Markdown, 不要解释。
2. confidence 使用 0 到 1 的数字。
3. 股票代码必须是 6 位数字。优先整理会话中已有的研究候选；产业映射推断可以保留，但必须使用 evidenceLevel=inferred 或 unverified。
4. 禁止输出买入、卖出、目标价、仓位、止盈、止损、必涨、确定性机会等交易指令或收益承诺。
5. verificationItems 用于复核事实和证据, 不是操作建议。
6. 每个 candidateStocks 项必须单独判断 direction。negative 表示该新闻可能对该公司构成利空，不能用主题整体方向替代公司级方向。

JSON 结构:
{
  "summary": "一句到三句话总结本轮研判",
  "confidence": 0.5,
  "primaryTheme": "主线主题或 null",
  "themes": [{"name":"主题","direction":"positive|negative|neutral|mixed","confidence":0.5,"evidence":"证据"}],
  "candidateStocks": [{"code":"000001","name":"股票名或 null","direction":"positive|negative|mixed|unclear","evidenceLevel":"direct|inferred|unverified","reason":"入选原因","confidence":0.5,"evidence":["证据"],"riskNotes":["风险"]}],
  "riskFactors": ["风险因素"],
  "verificationItems": [{"title":"复核项","status":"todo|done|blocked","reason":"原因"}],
  "sourceRefs": [{"type":"article|round1|round2|followUp","title":"来源标题","excerpt":"来源摘录"}]
}

会话文本:
${sourceText.slice(0, 24000)}`
}

function rowToStructuredResult(row: AIAnalysisStructuredResultRow): AIAnalysisStructuredResult {
  const candidateStocks = (JSON.parse(row.candidateStocksJson) as Array<Partial<StructuredCandidateStock>>)
    .map((stock) => ({
      code: text(stock.code),
      name: stock.name == null ? null : text(stock.name),
      direction: candidateDirection(stock.direction),
      evidenceLevel: candidateEvidenceLevel(stock.evidenceLevel),
      reason: text(stock.reason),
      confidence: clampConfidence(stock.confidence),
      evidence: safeArray(stock.evidence).map((item) => text(item)).filter(Boolean),
      riskNotes: safeArray(stock.riskNotes).map((item) => text(item)).filter(Boolean),
    }))
    .filter((stock) => /^\d{6}$/.test(stock.code))
  return {
    status: row.status,
    schemaVersion: row.schemaVersion,
    summary: row.summary,
    confidence: row.confidence,
    primaryTheme: row.primaryTheme,
    themes: JSON.parse(row.themesJson) as StructuredTheme[],
    candidateStocks,
    riskFactors: JSON.parse(row.riskFactorsJson) as string[],
    verificationItems: JSON.parse(row.verificationItemsJson) as StructuredVerificationItem[],
    sourceRefs: JSON.parse(row.sourceRefsJson) as StructuredSourceRef[],
    errorMessage: row.errorMessage,
    generatedAt: row.generatedAt
  }
}

function stockKey(value: string): string {
  return value.trim().toUpperCase().replace(/\.(SH|SZ|BJ)$/i, '')
}

export function buildPortfolioRiskSignalInputs(
  session: AIAnalysisSessionRow,
  candidates: StructuredCandidateStock[],
  portfolio: PortfolioStockRow[],
): DecisionSignalInput[] {
  const portfolioByCode = new Map(portfolio.map((item) => [stockKey(item.tsCode), item]))
  const articleUrls = (() => {
    try { return JSON.parse(session.articleUrls) as string[] } catch { return [] }
  })()
  return candidates
    .filter((candidate) => candidate.direction === 'negative' && portfolioByCode.has(stockKey(candidate.code)))
    .map((candidate) => {
      const holding = portfolioByCode.get(stockKey(candidate.code))!
      const priority = candidate.evidenceLevel === 'direct' && candidate.confidence >= 0.75 ? 5 : 4
      const evidenceLabel = candidate.evidenceLevel === 'direct'
        ? '直接证据'
        : candidate.evidenceLevel === 'inferred' ? '产业映射推断' : '尚未验证'
      return {
        sourceModule: 'ai' as const,
        strategyKey: 'news_portfolio_negative',
        tsCode: holding.tsCode,
        stockName: holding.stockName || candidate.name || null,
        signalType: 'RISK' as const,
        direction: 'BEARISH' as const,
        priority,
        score: candidate.confidence * 100,
        confidence: candidate.confidence * 100,
        title: '新闻研判可能利空持仓，需复核',
        summary: `${candidate.reason || '本轮新闻研判识别到潜在利空影响。'} 证据等级：${evidenceLabel}。`,
        reason: {
          isPortfolio: true,
          aiSessionId: session.id,
          candidateDirection: candidate.direction,
          evidenceLevel: candidate.evidenceLevel,
          evidence: candidate.evidence,
          riskNotes: candidate.riskNotes,
        },
        sourceRef: {
          isPortfolio: true,
          aiSessionId: session.id,
          articleUrls,
        },
        dedupKey: `ai:news_portfolio_negative:${session.id}:${stockKey(candidate.code)}`,
        signalTime: session.createdAt,
      }
    })
}

export function emitPortfolioRiskSignals(
  db: Database.Database,
  session: AIAnalysisSessionRow,
  candidates: StructuredCandidateStock[],
): void {
  const inputs = buildPortfolioRiskSignalInputs(session, candidates, listPortfolioStocks(db))
  if (inputs.length > 0) emitDecisionSignals(db, inputs)
}

export function getStructuredResult(db: Database.Database, sessionId: number): AIAnalysisStructuredResult | null {
  const row = getStructuredResultBySessionId(db, sessionId)
  return row ? rowToStructuredResult(row) : null
}

export async function generateStructuredResult(
  db: Database.Database,
  sessionId: number,
  options: { force?: boolean } = {}
): Promise<AIAnalysisStructuredResult | null> {
  if (!options.force) {
    const cached = getStructuredResult(db, sessionId)
    if (cached?.status === 'completed') return cached
  }
  const session = getSession(db, sessionId)
  if (!session || session.isError) return null

  try {
    const aiResult = await callWithFallback(db, { prompt: buildPrompt(session) })
    const payload = extractJsonObject(aiResult.text)
    const normalized = normalizePayload(db, payload)
    const now = Date.now()
    upsertStructuredResult(db, {
      sessionId,
      schemaVersion: SCHEMA_VERSION,
      status: 'completed',
      summary: normalized.summary,
      confidence: normalized.confidence,
      primaryTheme: normalized.primaryTheme,
      themesJson: JSON.stringify(normalized.themes),
      candidateStocksJson: JSON.stringify(normalized.candidateStocks),
      riskFactorsJson: JSON.stringify(normalized.riskFactors),
      verificationItemsJson: JSON.stringify(normalized.verificationItems),
      sourceRefsJson: JSON.stringify(normalized.sourceRefs),
      rawJson: JSON.stringify(payload),
      errorMessage: null,
      generatedAt: now
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    upsertStructuredResult(db, {
      sessionId,
      schemaVersion: SCHEMA_VERSION,
      status: 'parse_failed',
      summary: null,
      confidence: null,
      primaryTheme: null,
      themesJson: '[]',
      candidateStocksJson: '[]',
      riskFactorsJson: '[]',
      verificationItemsJson: '[]',
      sourceRefsJson: '[]',
      rawJson: null,
      errorMessage: message,
      generatedAt: Date.now()
    })
  }

  const stored = getStructuredResult(db, sessionId)
  if (stored?.status === 'completed') {
    try {
      emitPortfolioRiskSignals(db, session, stored.candidateStocks)
    } catch (error) {
      console.warn('[aiStructuredResult] portfolio risk signal failed:', error instanceof Error ? error.message : String(error))
    }
  }
  return stored
}
