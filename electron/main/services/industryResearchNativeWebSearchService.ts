import { createHash } from 'crypto'
import type Database from 'better-sqlite3'
import {
  listEvidenceCandidates,
  upsertEvidenceCandidate,
} from '../database/industryResearchGenerationRepository'
import type { ResearchEvidenceCandidateRow } from '../database/types'
import { callWithFallback, type AIFallbackResult } from './aiFallbackService'
import type { AIWebSearchTrace } from './aiProvider'
import { IndustryResearchError } from './industryResearchError'
import type { ResearchRetrievalPlanView } from './researchToolRuntime/types'

const SOURCE_LIMIT = 40
const SELECTED_LIMIT = 16

export interface NativeResearchSearchResult {
  plan: ResearchRetrievalPlanView
  candidates: ResearchEvidenceCandidateRow[]
  selectedTopNIds: string[]
  mode: 'strong' | 'mixed' | 'weak'
  degradedCode: string | null
  message: string
  memo: string
  trace: AIWebSearchTrace
  provider: string
  model: string
}

function sourceId(runId: string, url: string): string {
  return `openai_web_${createHash('sha256').update(`${runId}:${url}`).digest('hex').slice(0, 24)}`
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '网页来源'
  }
}

function sourceUrlKey(url: string): string {
  try { return new URL(url.trim()).toString() } catch { return url.trim() }
}

function nearbyExcerpt(text: string, startIndex: number, endIndex: number): string | null {
  if (!text) return null
  const start = Math.max(0, Math.min(text.length, startIndex) - 180)
  const end = Math.min(text.length, Math.max(startIndex, endIndex) + 180)
  const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return excerpt || null
}

function queryForSource(trace: AIWebSearchTrace, url: string): string {
  for (const call of trace.calls) {
    if (call.action.url === url || call.action.sources.includes(url)) {
      if (call.action.queries.length) return call.action.queries.join(' / ').slice(0, 500)
      if (call.action.pattern) return call.action.pattern.slice(0, 500)
    }
  }
  return 'GPT 原生网页搜索'
}

function buildPrompt(input: {
  researchQuestion: string
  industryName?: string | null
  productScope?: string | null
  regionScope?: string | null
  currentDate: string
  dataAsOf: string
}): string {
  return [
    '你是产业研究主分析模型。必须使用网页搜索工具完成本次研究，不得仅依赖模型记忆。',
    `当前北京时间日期：${input.currentDate}。`,
    `本次研究数据截止日：${input.dataAsOf}。不得使用其他模型知识截止日覆盖该日期。`,
    '请主动搜索多组关键词，优先打开政府、监管、交易所、公司公告、行业协会和运营商等一手页面，并用独立来源交叉验证重要判断。',
    '输出一份中文研究备忘录，至少包含：当前结论、关键事实、相互冲突的信息、产业链传导、代表公司线索、待证伪条件和资料缺口。',
    '每项关键结论必须使用工具返回的网页引用；不要要求用户逐条批准来源，不要给买卖、仓位或目标价指令。',
    `研究问题：${input.researchQuestion}`,
    `产业：${input.industryName || '待确认'}`,
    `产品：${input.productScope || '待确认'}`,
    `区域：${input.regionScope || '中国'}`,
  ].join('\n')
}

export async function runOpenAINativeResearchSearch(
  db: Database.Database,
  input: {
    projectId: string
    runId: string
    researchQuestion: string
    industryName?: string | null
    productScope?: string | null
    regionScope?: string | null
    currentDate?: string
    dataAsOf: string
  },
  callAI: typeof callWithFallback = callWithFallback,
): Promise<NativeResearchSearchResult> {
  const excludedUrls = listEvidenceCandidates(db, { projectId: input.projectId })
    .filter((item) => item.status === 'rejected')
    .map((item) => item.source_url)
    .filter(Boolean)
    .slice(0, 40)
  const excludedUrlKeys = new Set(excludedUrls.map(sourceUrlKey))
  let result: AIFallbackResult
  try {
    result = await callAI(db, {
      prompt: buildPrompt({ ...input, currentDate: input.currentDate || input.dataAsOf }),
      webSearch: { enabled: true, searchContextSize: 'high', excludedUrls },
      nativeWebSearchOnly: true,
    })
  } catch (error) {
    throw new IndustryResearchError(
      'OPENAI_NATIVE_WEB_SEARCH_FAILED',
      error instanceof Error ? error.message : 'GPT 原生网页搜索失败',
    )
  }
  const trace = result.webSearchTrace
  if (!trace || !trace.calls.length || !trace.sources.length) {
    throw new IndustryResearchError('OPENAI_NATIVE_WEB_SEARCH_EMPTY', 'GPT 未返回可审计的网页搜索来源')
  }

  const citationByUrl = new Map(trace.citations.map((citation) => [citation.url, citation]))
  const orderedSources = trace.sources
    .filter((source) => !excludedUrlKeys.has(sourceUrlKey(source.url)))
    .sort((left, right) => Number(right.cited) - Number(left.cited))
  if (!orderedSources.length) {
    throw new IndustryResearchError('OPENAI_NATIVE_WEB_SEARCH_EMPTY', 'GPT 未返回未被排除的可审计网页来源')
  }
  const candidates = orderedSources.slice(0, SOURCE_LIMIT).map((source, index) => {
    const citation = citationByUrl.get(source.url)
    const excerpt = citation ? nearbyExcerpt(result.text, citation.startIndex, citation.endIndex) : null
    return upsertEvidenceCandidate(db, {
      id: sourceId(input.runId, source.url),
      projectId: input.projectId,
      runId: input.runId,
      query: queryForSource(trace, source.url),
      sourceUrl: source.url,
      title: source.title || sourceHost(source.url),
      summary: excerpt,
      excerpt,
      providerId: 'openai_native_web_search',
      status: excerpt ? 'fetched' : 'partial',
      sourceKind: 'web_search',
      isDetailPage: source.cited,
      relevanceScore: source.cited ? 1 : 0.75,
      authorityScore: null,
      freshnessScore: null,
      rankScore: Math.max(0.1, 1 - index / 100),
    })
  })
  const selectedTopNIds = candidates.slice(0, SELECTED_LIMIT).map((item) => item.id)
  const searchCalls = trace.calls.filter((call) => call.action.type === 'search')
  const detailCalls = trace.calls.filter((call) => call.action.type === 'open_page' || call.action.type === 'find_in_page')
  const mode = trace.citations.length >= 3 && candidates.length >= 3
    ? 'strong'
    : trace.citations.length > 0 ? 'mixed' : 'weak'
  const degradedCode = mode === 'weak' ? 'OPENAI_NATIVE_WEB_SEARCH_WEAK' : null
  const message = `GPT 原生搜索完成 ${trace.calls.length} 次工具动作，形成 ${candidates.length} 条来源和 ${trace.citations.length} 条正文引用`
  return {
    plan: {
      mode,
      queries: searchCalls.flatMap((call, callIndex) => call.action.queries.map((query, queryIndex) => ({
        id: `${call.id || callIndex}-${queryIndex}`,
        text: query,
        intent: 'general',
        targetDomains: [],
        hitCount: call.action.sources.length,
        detailUrlCount: detailCalls.length,
        status: call.status === 'failed' ? 'failed' : 'executed',
        rationale: '由 GPT 在生成研究备忘录时自主提出并执行',
      }))),
      localHitCount: 0,
      webHitCount: candidates.length,
      detailPageCount: trace.citations.length,
      officialSeeds: [],
      selectedTopN: selectedTopNIds.length,
      candidatePoolSize: candidates.length,
      degradedCode,
      message,
      enhancedSearch: {
        providerId: null,
        configured: true,
        status: 'succeeded',
        errorCode: null,
      },
    },
    candidates,
    selectedTopNIds,
    mode,
    degradedCode,
    message,
    memo: result.text.slice(0, 30_000),
    trace,
    provider: result.provider,
    model: result.model,
  }
}
