import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import * as cheerio from 'cheerio'
import { getDb } from '../database/db'
import { getAIConfig, updateAIConfig, getProviderConfig, setProviderConfig, getAllProviderConfigs, getConfiguredProviders } from '../database/aiConfigRepository'
import {
  createSession,
  updateSessionResponse,
  updateSessionRound2,
  updateSessionMessages,
  deleteSession,
  listSessions,
  getSession,
  deleteAllSessions,
  deleteSessionsOlderThan,
  type ConversationMessage
} from '../database/aiAnalysisSessionRepository'
import { getDataSourceConfig, updateDataSourceConfig } from '../database/dataSourceRepository'
import { encryptApiKey, decryptApiKey } from '../utils/apiKeyEncryption'
import { callAIProvider, PROVIDER_MODELS, PROVIDER_LABELS, PROVIDER_DEFAULT_BASE_URLS } from '../services/aiProvider'
import type { AIProviderUsage } from '../services/aiProvider'
import {
  DEFAULT_ARTICLE_ANALYSIS_PROMPT,
  STOCK_CODES_INSTRUCTION,
  buildArticleRound2Prompt,
  extractStockCodeEntries,
  resolveArticleAnalysisPrompt,
  runCandidateRecovery,
} from '../aiPromptDefaults'
import { callWithFallback, resolveProviderCredentials } from '../services/aiFallbackService'
import { CandidateRecoveryError, recoverSessionCandidates } from '../services/aiCandidateRecoveryService'
import { buildSkillsBlock } from '../services/aiSkillsPromptService'
import {
  backfillTodayDailyFromIntradayIfMissing,
  ensureTrendBenchmarkFreshness,
  fetchEastmoneyMinuteOHLCV,
  fetchEastmoneySingleStockDaily,
  fetchIndexPrices,
  fetchIntradayData,
  fetchIntradayDataBySecid,
  fetchStockMinuteDaily,
  forceFetchSingleStock,
  getBoardSecid,
  validateTushareToken,
} from '../services/tushareService'
import { inspectTrendBenchmarkHealth, type TrendBenchmarkHealth } from '../services/trendBenchmarkFreshness'
import { getCachedPricePage, getCachedPrices, getStockInfo, upsertStockInfo, upsertStockInfoIfAbsent } from '../database/stockPriceCacheRepository'
import { insertForecast, listForecasts, getForecast, deleteForecast, deleteForecasts, trimForecasts, getLatestForecasts } from '../database/trendForecastRepository'
import { getCachedDetail, setCachedDetail } from '../database/detailCacheRepository'
import { sha256 } from '../utils/hashUtils'
import { fetchHtml } from './detailHandlers'
import { getStockMinuteByDate, upsertStockMinute } from '../database/stockMinuteCacheRepository'
import { runStockBasicSyncJob, subscribeStockMinute, unsubscribeStockMinute } from '../services/schedulerService'
import { searchByNameOrCode, countAll as countStockBasic } from '../database/stockBasicCacheRepository'
import type { AIProvider, ImpactRating, BriefingRow, SourceRow, StockPriceCacheRow } from '../database/types'
// FR-163: 数据增强辅助模块
import { queryLatestFactor } from '../database/stkFactorCacheRepository'
import { getStockLimitHistory } from '../database/limitListDailyRepository'
import { getConceptsByStockRouted } from '../services/conceptRouter'
import { getThemeZtNumByDate } from '../database/kplConceptDailyRepository'
import { getSectorConceptSource } from '../database/settingsRepository'
import { emitDecisionSignal } from '../services/decisionSignalService'
import { getVerifiedFlowsByBoardNames } from '../database/sectorFlowObservationRepository'
import { queryStockOHLCV } from '../database/dailyCloseCacheRepository'
import { listStructuredStatusBySessionIds } from '../database/aiAnalysisStructuredResultRepository'
import { generateStructuredResult, getStructuredResult } from '../services/aiStructuredResultService'
import { computeSMC, type OHLCVBar } from '../utils/smcAnalysisNode'
import {
  buildRound2MarketBlockedResponse,
  prepareArticleRound2MarketContext,
} from '../services/aiRound2MarketContextService'
import { buildArticleRound2ResearchFactContext } from '../services/researchFactPromptService'
import {
  buildDiscussionAIRequest,
  deleteResearchDiscussion,
  deleteAllResearchDiscussions,
  discussionContextPreview,
  discussionSummary,
  getDiscussionResearchAuditContext,
  listResearchDiscussions,
  ResearchDiscussionError,
  refreshDiscussionOriginAvailability,
  startResearchDiscussion,
  updateDiscussionContextBeforeStart,
} from '../services/researchDiscussionContextService'
import {
  auditResearchText,
  buildBlockedResearchText,
  buildResearchAuditTraceView,
} from '../services/researchEvidenceAuditService'
import {
  countResearchDiscussionSessions,
  getResearchDiscussionContext,
} from '../database/researchDiscussionRepository'
import type { ResearchDiscussionOriginType, ResearchDiscussionStatus } from '../database/types'
import { getResearchAgentAuditContext } from '../services/researchAgentRunManager'

/** FR-055/FR-072: Inject current Beijing date+time prefix into a prompt.
 *  Prepends "今天是XXXX年XX月XX日，现在是XX:XX（北京时间）\n\n" before the prompt text.
 *  Generated at call time, never persisted to DB.
 */
function injectTimePrefix(prompt: string): string {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const y = bjNow.getUTCFullYear()
  const mo = String(bjNow.getUTCMonth() + 1).padStart(2, '0')
  const d = String(bjNow.getUTCDate()).padStart(2, '0')
  const hh = String(bjNow.getUTCHours()).padStart(2, '0')
  const mi = String(bjNow.getUTCMinutes()).padStart(2, '0')
  return `今天是${y}年${mo}月${d}日，现在是${hh}:${mi}（北京时间）\n\n${prompt}`
}

function buildForecastInputSnapshot(data: {
  stockCode: string
  type: 'today' | 'morrow'
  targetDate?: string | null
  provider: string | null
  model: string | null
  dataLabel?: string
  dataPointCount?: number
  dailyPointCount?: number
  contextText?: string
  promptText?: string
  userFeedback?: string | null
  parentForecastId?: number | null
  forecastPointCount?: number
}): string {
  return JSON.stringify({
    version: 1,
    generatedAt: Date.now(),
    stockCode: data.stockCode,
    type: data.type,
    targetDate: data.targetDate ?? null,
    provider: data.provider,
    model: data.model,
    dataLabel: data.dataLabel ?? null,
    dataPointCount: data.dataPointCount ?? null,
    dailyPointCount: data.dailyPointCount ?? null,
    contextChars: data.contextText?.length ?? 0,
    promptChars: data.promptText?.length ?? 0,
    userFeedback: data.userFeedback ?? null,
    parentForecastId: data.parentForecastId ?? null,
    forecastPointCount: data.forecastPointCount ?? null,
  })
}

/** FR-072: Default trendForecastPrompt — used when provider_configs.trendForecastPrompt is empty. */
const DEFAULT_TREND_TODAY_PROMPT =
  '我将提供给你以下信息：股票代码、今天大盘（上证指数）的分时走势数据、这支股票所属板块指数的分时走势数据，以及这支股票此时此刻的实际分时数据。' +
  '请你结合上述数据，同时利用你可访问的公开渠道（东方财富、同花顺或其他来源）收集该公司的基本面信息（含近期年报/季报要点、主营业务、行业地位），' +
  '并结合当前时政热点及该股票所属板块是否处于市场热点，综合分析并预测该股票今日剩余交易时段（至15:00收盘）的价格走势。' +
  '跳过11:30至13:00的午休时段。' +
  '当各指标出现矛盾信号时（如MACD趋势向上但RSI6或KDJ已进入超买区），必须明确指出矛盾并倾向于保守判断，不得凭借单一指标的信号主导结论。'

/** FR-072: Default trendForecastMorrowPrompt — used when provider_configs.trendForecastMorrowPrompt is empty. */
const DEFAULT_TREND_MORROW_PROMPT =
  '我将提供给你以下信息：股票代码、今日完整分时数据、今日大盘及板块分时数据、近30日日线OHLCV数据。' +
  '请你结合上述数据，同时利用你可访问的公开渠道（东方财富、同花顺或其他来源）收集该公司基本面信息（含近期年报/季报要点、主营业务、行业地位），' +
  '并结合当前时政热点及该股票所属板块是否处于市场热点，综合预测明日09:30至15:00的价格走势。' +
  '跳过11:30至13:00的午休时段。' +
  '当各指标出现矛盾信号时（如MACD趋势向上但RSI6或KDJ已进入超买区），必须明确指出矛盾并倾向于保守判断，不得凭借单一指标的信号主导结论。'

function refreshStructuredResultInBackground(db: import('better-sqlite3').Database, sessionId: number, reason: string): void {
  void generateStructuredResult(db, sessionId, { force: true }).catch((err) => {
    console.warn(`[aiStructuredResult] ${reason} failed:`, err instanceof Error ? err.message : String(err))
  })
}

/** FR-056/FR-063: Parse STOCK_CODES line from AI response.
 *  Supports new format with name: "600036|招商银行" and legacy plain code: "600036".
 *  Writes stock names to stock_info table when present (avoids Tushare stock_basic API call).
 *  Returns array of 6-digit stock codes.
 */
function parseStockCodes(db: import('better-sqlite3').Database, response: string): string[] {
  const entries = extractStockCodeEntries(response)
  if (entries.length === 0) {
    console.log('[AI Round2] STOCK_CODES line not found in response')
    return []
  }
  for (const entry of entries) {
    // FR-063: persist stock name from AI response as fallback only (INSERT OR IGNORE).
    // Tushare stock_basic is the authoritative source and can always overwrite via upsertStockInfo().
    if (entry.name) upsertStockInfoIfAbsent(db, entry.code, entry.name)
  }
  const codes = entries.map((entry) => entry.code)
  console.log('[AI Round2] Parsed stock codes:', codes)
  return codes
}

async function recoverCandidateMapping(
  db: import('better-sqlite3').Database,
  response: string,
): Promise<{
  response: string
  stockCodes: string[]
  aiResult: Awaited<ReturnType<typeof callWithFallback>> | null
}> {
  const recovery = await runCandidateRecovery(response, (prompt) => callWithFallback(db, {
    prompt: injectTimePrefix(prompt) + buildSkillsBlock(db),
  }))
  return {
    response: recovery.response,
    stockCodes: parseStockCodes(db, recovery.response),
    aiResult: recovery.aiResult,
  }
}

/**
 * FR-048: Fetch the best available content for a briefing.
 * Priority: DetailCache → live scrape (if detailSelector) → null (fallback to URL only).
 * FR-049: Caller truncates to maxContentCharsPerArticle chars.
 */
async function fetchBriefingContent(briefingId: number): Promise<{ url: string; content: string | null }> {
  const db = getDb()
  const briefing = db.prepare('SELECT * FROM briefings WHERE id = ?').get(briefingId) as BriefingRow | undefined
  if (!briefing) return { url: '', content: null }

  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(briefing.sourceId) as SourceRow | undefined
  const url = briefing.originalUrl

  const cacheKey = sha256(url)
  const cached = getCachedDetail(cacheKey)
  if (cached) return { url, content: cached.content }

  if (!source?.detailSelector) return { url, content: null }

  try {
    const html = await fetchHtml(url)
    const $ = cheerio.load(html)
    const selectors = source.detailSelector.split('|').map((s) => s.trim()).filter(Boolean)
    let extracted = ''
    for (const sel of selectors) {
      const found = $(sel).text()
      if (found && found.trim()) { extracted = found.trim(); break }
    }
    if (extracted) setCachedDetail(cacheKey, url, extracted)
    return { url, content: extracted || null }
  } catch {
    return { url, content: null }
  }
}

type AIProgressStep =
  | 'fetching'
  | 'callingRound1'
  | 'parsingStocks'
  | 'recoveringCandidates'
  | 'fetchingPrices'
  | 'callingRound2'
  | 'saving'
  | 'done'
  | 'error'

interface AIProgressUsage extends AIProviderUsage {
  provider: string
  model: string
  maxTokens?: number | null
  finishReason?: string | null
}

type AIProgressPayload = {
  step: AIProgressStep
  current?: number
  total?: number
  usages?: {
    round1?: AIProgressUsage
    candidateRecovery?: AIProgressUsage
    round2?: AIProgressUsage
  }
}

function pushProgress(
  win: BrowserWindow | null,
  payload: AIProgressPayload
): void {
  win?.webContents.send('ai:analyzeProgress', payload)
}

function toProgressUsage(result: { provider: string; model: string; usage?: AIProviderUsage; finishReason?: string | null; maxTokens?: number | null }): AIProgressUsage {
  return {
    provider: result.provider,
    model: result.model,
    maxTokens: result.maxTokens ?? null,
    finishReason: result.finishReason ?? null,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    totalTokens: result.usage?.totalTokens ?? null
  }
}

function logAIUsage(label: string, usage: AIProgressUsage): void {
  const maxTokens = usage.maxTokens ?? 4096
  const output = usage.outputTokens ?? null
  const nearLimit = typeof output === 'number' ? output >= Math.floor(maxTokens * 0.9) : false
  const truncated = usage.finishReason === 'length' || usage.finishReason === 'max_tokens'
  console.log(`[${label}] Usage provider=${usage.provider}/${usage.model} input=${usage.inputTokens ?? '-'} output=${usage.outputTokens ?? '-'} total=${usage.totalTokens ?? '-'} max=${maxTokens} finish=${usage.finishReason ?? '-'} nearLimit=${nearLimit} truncated=${truncated}`)
}

// ── FR-163: 数据增强辅助函数 ──────────────────────────────────────────────────

/** 将 6 位纯代码转换为带交易所后缀的 Tushare 格式（如 600036 → 600036.SH） */
function toTsCodeWithSuffix(code: string): string {
  if (/\.(SH|SZ|BJ)$/i.test(code)) return code.toUpperCase()
  if (/^(600|601|603|605|688|900|110|113|118|127|128|129|131|132)/.test(code)) return `${code}.SH`
  if (/^(430|830|870|871|872|873|874|875|876|877|878|879|880|881|882|883|884|885|886|887|888|889|890|891|892|893|894|895|896|897|898|899)/.test(code)) return `${code}.BJ`
  return `${code}.SZ`
}

function stripStockSuffix(code: string): string {
  return code.replace(/\.(SH|SZ|BJ)$/i, '')
}

/** 返回当前北京时间的 YYYYMMDD 格式日期字符串 */
function getBjTodayYmd(): string {
  const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, '0')}${String(bj.getUTCDate()).padStart(2, '0')}`
}

/** FR-163b: 构建技术因子摘要（MACD/KDJ/RSI6/BOLL/MA/量比/换手率/连涨跌）
 *  @param db      数据库连接
 *  @param tsCode  带后缀格式（如 600036.SH）
 *  @returns 摘要字符串，无数据时返回空字符串
 */
function buildTechnicalSummary(db: import('better-sqlite3').Database, tsCode: string): string {
  try {
    const f = queryLatestFactor(db, tsCode)
    if (!f) return ''
    const parts: string[] = [`[技术因子摘要 ${f.tradeDate}]`]
    // MACD — 使用中性描述，避免引导模型偏向看涨/看跌
    if (f.macdBfq != null && f.macdDifBfq != null && f.macdDeaBfq != null) {
      const signal = f.macdBfq > 0
        ? (f.macdDifBfq > f.macdDeaBfq ? 'DIF上穿DEA' : 'DIF在DEA上方')
        : (f.macdDifBfq < f.macdDeaBfq ? 'DIF下穿DEA' : 'DIF在DEA下方')
      parts.push(`MACD=${f.macdBfq.toFixed(3)}(DIF=${f.macdDifBfq.toFixed(3)},DEA=${f.macdDeaBfq.toFixed(3)}) [${signal}]`)
    }
    // KDJ — 中性描述，J 超买/超卖区加数值阈值
    if (f.kdjKBfq != null && f.kdjDBfq != null && f.kdjBfq != null) {
      const kdSignal = f.kdjKBfq > f.kdjDBfq ? 'K>D' : 'K<D'
      const jSignal = f.kdjBfq > 80 ? 'J超买区(>80)' : f.kdjBfq < 20 ? 'J超卖区(<20)' : 'J中性区'
      parts.push(`KDJ: K=${f.kdjKBfq.toFixed(1)},D=${f.kdjDBfq.toFixed(1)},J=${f.kdjBfq.toFixed(1)} [${kdSignal},${jSignal}]`)
    }
    // RSI — 保留数值阈值，不附加方向性结论
    if (f.rsiBfq6 != null) {
      const rsiSignal = f.rsiBfq6 > 70 ? '超买区(RSI6>70)' : f.rsiBfq6 < 30 ? '超卖区(RSI6<30)' : '中性区'
      parts.push(`RSI6=${f.rsiBfq6.toFixed(1)} [${rsiSignal}]`)
    }
    // BOLL
    if (f.bollUpperBfq != null && f.bollMidBfq != null && f.bollLowerBfq != null && f.close != null) {
      const pos = f.close > f.bollUpperBfq ? '上轨上方' : f.close < f.bollLowerBfq ? '下轨下方' : '轨道内'
      parts.push(`BOLL: 上=${f.bollUpperBfq.toFixed(2)},中=${f.bollMidBfq.toFixed(2)},下=${f.bollLowerBfq.toFixed(2)},现=${f.close.toFixed(2)} [${pos}]`)
    }
    // MA
    const maItems: string[] = []
    if (f.maBfq5 != null) maItems.push(`MA5=${f.maBfq5.toFixed(2)}`)
    if (f.maBfq10 != null) maItems.push(`MA10=${f.maBfq10.toFixed(2)}`)
    if (f.maBfq20 != null) maItems.push(`MA20=${f.maBfq20.toFixed(2)}`)
    if (f.maBfq60 != null) maItems.push(`MA60=${f.maBfq60.toFixed(2)}`)
    if (maItems.length > 0) parts.push(maItems.join(','))
    // 量比 / 换手率
    if (f.volumeRatio != null) parts.push(`量比=${f.volumeRatio.toFixed(2)}`)
    if (f.turnoverRate != null) parts.push(`换手率=${f.turnoverRate.toFixed(2)}%`)
    // 连涨跌
    if (f.updays != null && f.updays > 0) parts.push(`连涨${f.updays}日`)
    else if (f.downdays != null && f.downdays > 0) parts.push(`连跌${f.downdays}日`)
    return parts.join('；')
  } catch {
    return ''
  }
}

/** FR-163c: 构建连板历史与题材情绪摘要
 *  @param db        数据库连接
 *  @param stockCode 6位纯代码
 *  @returns 摘要字符串，无数据时返回空字符串
 */
function buildLimitConceptSummary(db: import('better-sqlite3').Database, stockCode: string): string {
  try {
    const tsCode = toTsCodeWithSuffix(stockCode)
    // 近10日涨停历史
    const history = getStockLimitHistory(db, tsCode, 10)
    const limitRows = history.filter(r => r.limit === 'U')
    if (limitRows.length === 0 && history.length === 0) return ''
    const parts: string[] = ['[连板与题材情绪]']
    if (history.length > 0) {
      const limitDates = limitRows.map(r => r.tradeDate).join(',')
      parts.push(`近10日涨停日：${limitDates || '无'}（共${limitRows.length}次）`)
      if (history.length > 0) {
        const latestLimitTimes = history[0].limitTimes
        if (latestLimitTimes != null) parts.push(`最新连板数：${latestLimitTimes}`)
      }
    }
    // 题材涨停情绪
    const conceptSource = getSectorConceptSource()
    const concepts = getConceptsByStockRouted(db, stockCode, conceptSource)
    if (concepts.length > 0) {
      const today = getBjTodayYmd()
      const ztMap = getThemeZtNumByDate(db, today)
      const conceptItems: string[] = []
      for (const c of concepts.slice(0, 5)) {
        const ztNum = ztMap.get(c.conceptName)
        if (ztNum != null) conceptItems.push(`${c.conceptName}(涨停${ztNum}只)`)
        else conceptItems.push(c.conceptName)
      }
      if (conceptItems.length > 0) parts.push(`所属题材：${conceptItems.join('、')}`)
    }
    return parts.join('；')
  } catch {
    return ''
  }
}

/** FR-163d: 构建板块资金流向摘要
 *  @param db        数据库连接
 *  @param stockCode 6位纯代码
 *  @returns 摘要字符串，无数据时返回空字符串
 */
function buildSectorFlowSummary(db: import('better-sqlite3').Database, stockCode: string): string {
  try {
    const conceptSource = getSectorConceptSource()
    const concepts = getConceptsByStockRouted(db, stockCode, conceptSource)
    if (concepts.length === 0) return ''
    const flows = getVerifiedFlowsByBoardNames(
      db,
      concepts.map((concept) => concept.conceptName).filter((name): name is string => Boolean(name)).slice(0, 12),
    ).slice(0, 5)
    const flowItems = flows.map((flow) => {
      const sign = flow.mainNetInflow >= 0 ? '+' : ''
      const rate = flow.mainNetInflowRate == null ? '' : `(${flow.mainNetInflowRate >= 0 ? '+' : ''}${flow.mainNetInflowRate.toFixed(2)}%)`
      return `${flow.boardName}${sign}${(flow.mainNetInflow / 1e8).toFixed(2)}亿${rate}`
    })
    if (flowItems.length === 0) return ''
    return `[板块主力资金 ${flows[0].tradeDate} 来源=东方财富] ${flowItems.join('、')}`
  } catch {
    return ''
  }
}

/** FR-163e: 构建 SMC 摆动结构摘要（日线）
 *  @param db        数据库连接
 *  @param stockCode 6位纯代码
 *  @returns 摘要字符串，无数据时返回空字符串
 */
function buildSMCSummary(db: import('better-sqlite3').Database, stockCode: string): string {
  try {
    const tsCode = toTsCodeWithSuffix(stockCode)
    // 取近90日历天的日线 OHLCV
    const bj = new Date(Date.now() + 8 * 60 * 60 * 1000)
    bj.setDate(bj.getDate() - 90)
    const startDate = `${bj.getUTCFullYear()}${String(bj.getUTCMonth() + 1).padStart(2, '0')}${String(bj.getUTCDate()).padStart(2, '0')}`
    const rows = queryStockOHLCV(db, tsCode, startDate)
    // 过滤掉 open/high/low 为 null 的行（旧缓存数据不完整）
    const bars: OHLCVBar[] = rows
      .filter(r => r.open != null && r.high != null && r.low != null)
      .map(r => ({
        time: r.tradeDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
        open: r.open!,
        high: r.high!,
        low: r.low!,
        close: r.close,
      }))
    if (bars.length < 20) return ''
    const result = computeSMC(bars, 3)
    const parts: string[] = ['[SMC日线结构]']
    // 最近1个 CHoCH 事件
    if (result.events.length > 0) {
      const lastEvent = result.events[result.events.length - 1]
      const dir = lastEvent.direction === 'bullish' ? '转多(CHoCH↑)' : '转空(CHoCH↓)'
      parts.push(`最近结构变换：${lastEvent.time} ${dir} 价位=${lastEvent.level.toFixed(2)}`)
    }
    // 最近摆动高低点
    if (result.swingHighs.length > 0) {
      const lh = result.swingHighs[result.swingHighs.length - 1]
      parts.push(`近期摆动高点：${lh.label} ${lh.time} =${lh.price.toFixed(2)}`)
    }
    if (result.swingLows.length > 0) {
      const ll = result.swingLows[result.swingLows.length - 1]
      parts.push(`近期摆动低点：${ll.label} ${ll.time} =${ll.price.toFixed(2)}`)
    }
    return parts.join('；')
  } catch {
    return ''
  }
}

// ── FR-168: 模块级辅助函数（供 performPredictTrendToday 使用）──────────────

function _isAShareLunchBreak(time: string): boolean {
  return time >= '11:30' && time < '13:00'
}

const _A_SHARE_TIME_GRID: string[] = (() => {
  const grid: string[] = []
  for (let m = 9 * 60 + 30; m <= 11 * 60 + 25; m += 5) {
    grid.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  for (let m = 13 * 60; m <= 15 * 60; m += 5) {
    grid.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  }
  return grid
})()

function _timeToMinutes(t: string): number {
  const parts = t.split(':')
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)
}

function _normalizeTimeStr(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.includes(':')) {
    if (trimmed.length === 3) return `0${trimmed[0]}:${trimmed.slice(1)}`
    if (trimmed.length === 4) return `${trimmed.slice(0, 2)}:${trimmed.slice(2)}`
  }
  const [h, m] = trimmed.split(':')
  return `${h.padStart(2, '0')}:${(m || '00').padStart(2, '0')}`
}

function _snapToGrid(time: string): string | null {
  const normalized = _normalizeTimeStr(time)
  const mins = _timeToMinutes(normalized)
  let best = _A_SHARE_TIME_GRID[0]
  let bestDiff = Infinity
  for (const g of _A_SHARE_TIME_GRID) {
    const diff = Math.abs(_timeToMinutes(g) - mins)
    if (diff < bestDiff) {
      bestDiff = diff
      best = g
    }
  }
  return bestDiff <= 5 ? best : null
}

function _parseForecastResponse(rawResponse: string): {
  points: { time: string; price: number }[]
  aiReason: string
  direction?: string
  confidence?: number
  keySupport?: number
  keyResistance?: number
} {
  const match = rawResponse.match(/```json\s*(\[[\s\S]*?\])\s*```/)
  let points: { time: string; price: number }[] = []
  if (match) {
    try {
      const parsed = JSON.parse(match[1])
      if (Array.isArray(parsed)) {
        const snapped = new Map<string, number>()
        for (const d of parsed) {
          if (
            typeof (d as Record<string, unknown>).time !== 'string' ||
            typeof (d as Record<string, unknown>).price !== 'number'
          ) continue
          const raw = (d as Record<string, unknown>).time as string
          const gridTime = _snapToGrid(raw)
          if (gridTime && !_isAShareLunchBreak(gridTime)) {
            snapped.set(gridTime, (d as Record<string, unknown>).price as number)
          }
        }
        points = _A_SHARE_TIME_GRID.filter(t => snapped.has(t)).map(t => ({ time: t, price: snapped.get(t)! }))
      }
    } catch { /* ignore */ }
  }
  const aiReason = match ? rawResponse.slice(0, rawResponse.indexOf(match[0])).trim() : rawResponse.trim()
  let direction: string | undefined
  let confidence: number | undefined
  let keySupport: number | undefined
  let keyResistance: number | undefined
  const analysisMatch = rawResponse.match(/```analysis\s*([\s\S]*?)```/)
  if (analysisMatch) {
    try {
      const parsed = JSON.parse(analysisMatch[1].trim()) as Record<string, unknown>
      if (typeof parsed.direction === 'string') direction = parsed.direction
      if (typeof parsed.confidence === 'number') confidence = parsed.confidence
      if (typeof parsed.key_support === 'number') keySupport = parsed.key_support
      if (typeof parsed.key_resistance === 'number') keyResistance = parsed.key_resistance
    } catch { /* ignore */ }
  }
  return { points, aiReason, direction, confidence, keySupport, keyResistance }
}

function _emitAIForecastDecisionSignal(input: {
  stockCode: string
  forecastType: 'today' | 'morrow'
  forecastId: number
  provider?: string | null
  model?: string | null
  direction?: string
  confidence?: number
  keySupport?: number
  keyResistance?: number
}): void {
  try {
    if (input.confidence == null || input.confidence < 70) return
    if (input.direction !== 'up' && input.direction !== 'down') return
    const isUp = input.direction === 'up'
    const label = input.forecastType === 'today' ? '今日走势' : '明日走势'
    emitDecisionSignal(getDb(), {
      sourceModule: 'ai',
      strategyKey: `ai.${input.forecastType}Forecast`,
      tsCode: input.stockCode,
      signalType: 'INFO',
      direction: isUp ? 'BULLISH' : 'BEARISH',
      priority: input.confidence >= 85 ? 4 : 3,
      score: input.confidence,
      confidence: input.confidence,
      title: `${input.stockCode} AI ${label}判断${isUp ? '偏多' : '偏空'}`,
      summary: `模型置信度 ${input.confidence.toFixed(0)}%, 关键支撑 ${input.keySupport ?? '—'}, 关键压力 ${input.keyResistance ?? '—'}。`,
      reason: {
        direction: input.direction,
        confidence: input.confidence,
        keySupport: input.keySupport,
        keyResistance: input.keyResistance,
        provider: input.provider,
        model: input.model,
      },
      sourceRef: { forecastId: input.forecastId, forecastType: input.forecastType },
      dedupKey: `ai:${input.forecastType}:${input.stockCode}:${input.provider ?? 'default'}:${new Date().toISOString().slice(0, 10)}`,
    })
  } catch (err) {
    console.warn('[AI] emit decision signal failed:', err)
  }
}

async function _buildBoardMarketSuffix(stockCode: string): Promise<string> {
  const boardSecid = getBoardSecid(stockCode)
  const marketSecid = '1.000001'
  const boardItems = await fetchIntradayDataBySecid(boardSecid)
  const marketItems = boardSecid === marketSecid ? boardItems : await fetchIntradayDataBySecid(marketSecid)
  const marketPart = `\n\n大盘（上证指数）分时：${JSON.stringify(marketItems.map(i => ({ time: i.time, price: i.price })))}`
  const boardPart =
    boardSecid !== marketSecid
      ? `\n\n板块分时：${JSON.stringify(boardItems.map(i => ({ time: i.time, price: i.price })))}`
      : ''
  return marketPart + boardPart
}

/**
 * FR-168: 持仓批量预测核心函数（导出供后台服务调用）.
 * 并行调用所有已配置 AI provider 预测今日走势，结果直接写入 trend_forecasts 表.
 * 不更新内存预测缓存（缓存仅供 IPC handler UI 快速响应，批量任务无需）.
 */
export async function performPredictTrendToday(
  db: import('better-sqlite3').Database,
  stockCode: string
): Promise<{ ok: boolean; successCount: number; error?: { code: string; message: string } }> {
  const aiConfig = getAIConfig(db)
  // 优先使用 multiModelProviders 列表，否则 fallback 到单个 provider
  const multiModelProviders: string[] = aiConfig.multiModelProviders
    ? (JSON.parse(aiConfig.multiModelProviders) as string[])
    : []
  const providersToUse: string[] =
    multiModelProviders.length > 0 ? multiModelProviders : aiConfig.provider ? [aiConfig.provider] : []

  if (providersToUse.length === 0) {
    return { ok: false, successCount: 0, error: { code: 'AI_NOT_CONFIGURED', message: '未配置 AI 厂商' } }
  }

  // 获取今日分时数据（优先 DB 分钟 K 线，fallback 东财）
  const bjToday = getBjTodayYmd()
  const minuteRows = getStockMinuteByDate(db, stockCode, bjToday)
  let intradayLabel: string
  let intradayJson: string
  let dataPointCount = 0
  if (minuteRows.length > 0) {
    intradayLabel = '今日1分钟K线（t=时间,o=开,h=高,l=低,c=收,v=成交量手）'
    dataPointCount = minuteRows.length
    intradayJson = JSON.stringify(minuteRows.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))
  } else {
    const stockItems = await fetchIntradayData(stockCode)
    if (stockItems.length === 0) {
      return { ok: false, successCount: 0, error: { code: 'INTRADAY_EMPTY', message: '当日暂无分时数据' } }
    }
    intradayLabel = '实际分时数据（至今）'
    dataPointCount = stockItems.length
    intradayJson = JSON.stringify(stockItems.map(i => ({ time: i.time, price: i.price })))
  }

  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const timeStr = `${bjNow.getUTCHours().toString().padStart(2, '0')}:${bjNow.getUTCMinutes().toString().padStart(2, '0')}`
  const boardSuffix = await _buildBoardMarketSuffix(stockCode)
  const tsCode = toTsCodeWithSuffix(stockCode)
  const extraContext = [
    buildTechnicalSummary(db, tsCode),
    buildLimitConceptSummary(db, stockCode),
    buildSectorFlowSummary(db, stockCode),
    buildSMCSummary(db, stockCode),
  ]
    .filter(Boolean)
    .join('\n\n')

  // 构建各 provider 调用任务
  const tasks = providersToUse
    .map(p => {
      const pc = getProviderConfig(db, p)
      if (!pc?.apiKeyEncrypted) return null
      const apiKey = decryptApiKey(pc.apiKeyEncrypted)
      if (!apiKey) return null
      const model = pc.model || (PROVIDER_MODELS as Record<string, string[]>)[p]?.[0] || ''
      if (!model) return null
      const forecastPrompt =
        injectTimePrefix(pc.trendForecastPrompt || aiConfig.trendForecastPrompt || DEFAULT_TREND_TODAY_PROMPT) +
        buildSkillsBlock(db, true)
      const prompt =
        `${forecastPrompt}\n\n股票代码：${stockCode}\n当前北京时间：${timeStr}\n\n` +
        `${intradayLabel}：${intradayJson}${boardSuffix}` +
        `${extraContext ? '\n\n' + extraContext : ''}` +
        `\n\n请在响应末尾输出如下格式的预测数据（从${timeStr}到15:00，每5分钟一条，**跳过11:30至13:00的午休时段**，仅输出上午09:30-11:25和下午13:00-15:00区间的时间点）：\n` +
        `\`\`\`json\n[{"time":"HH:mm","price":0.00}]\n\`\`\`\n\n` +
        `并另外输出结构化分析（紧跟在上方 json 块之后）：\n` +
        `\`\`\`analysis\n{"direction":"up|down|flat","confidence":0.0,"key_support":0.00,"key_resistance":0.00}\n\`\`\``
      return { provider: p, model, apiKey, baseUrl: pc.baseUrl ?? undefined, maxTokens: pc.maxTokens ?? undefined, prompt }
    })
    .filter(Boolean) as { provider: string; model: string; apiKey: string; baseUrl?: string; maxTokens?: number | null; prompt: string }[]

  if (tasks.length === 0) {
    return { ok: false, successCount: 0, error: { code: 'AI_NOT_CONFIGURED', message: '没有已配置 API Key 的 AI 厂商' } }
  }

  const settled = await Promise.allSettled(
    tasks.map(t =>
      callAIProvider({
        provider: t.provider as AIProvider,
        model: t.model,
        apiKey: t.apiKey,
        baseUrl: t.baseUrl,
        maxTokens: t.maxTokens,
        messages: [{ role: 'user', content: t.prompt }],
      }).then(r => ({ ...t, text: r.text }))
    )
  )

  const maxKeep = getAIConfig(db).maxForecastsPerStock ?? 50
  let successCount = 0

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i]
    const task = tasks[i]
    if (outcome.status === 'fulfilled') {
      const { points, aiReason, direction, confidence, keySupport, keyResistance } = _parseForecastResponse(
        outcome.value.text
      )
      if (points.length === 0) continue
      try {
        const forecastId = insertForecast(db, {
          stockCode,
          type: 'today',
          points: JSON.stringify(points),
          aiReason: aiReason || null,
          provider: task.provider,
          model: task.model,
          direction: direction ?? null,
          confidence: confidence ?? null,
          keySupport: keySupport ?? null,
          keyResistance: keyResistance ?? null,
          inputSnapshot: buildForecastInputSnapshot({
            stockCode,
            type: 'today',
            provider: task.provider,
            model: task.model,
            dataLabel: intradayLabel,
            dataPointCount,
            contextText: extraContext,
            promptText: task.prompt,
            forecastPointCount: points.length,
          }),
        })
        _emitAIForecastDecisionSignal({
          stockCode,
          forecastType: 'today',
          forecastId,
          provider: task.provider,
          model: task.model,
          direction,
          confidence,
          keySupport,
          keyResistance,
        })
        trimForecasts(db, stockCode, maxKeep)
        successCount++
      } catch (err) {
        console.warn(`[Portfolio] 写入 trend_forecasts 失败 ${stockCode}/${task.provider}:`, err)
      }
    } else {
      console.warn(`[Portfolio] provider ${task.provider} 预测 ${stockCode} 失败:`, outcome.reason)
    }
  }

  return { ok: successCount > 0, successCount }
}

type StockPriceRecord = StockPriceCacheRow & {
  pctChg?: number | null
  turnoverRate?: number | null
}

function enrichStockPriceRows(
  db: Database.Database,
  stockCode: string,
  rows: StockPriceRecord[],
): StockPriceRecord[] {
  if (rows.length === 0) return rows

  const code6 = stripStockSuffix(stockCode)
  const preferredTsCode = toTsCodeWithSuffix(stockCode)
  const startDate = rows[0].tradeDate
  const endDate = rows[rows.length - 1].tradeDate
  const dailyRows = db.prepare(`
    SELECT trade_date AS tradeDate, ts_code AS tsCode, pct_chg AS pctChg, turnover_rate AS turnoverRate
    FROM daily_close_cache
    WHERE trade_date BETWEEN ? AND ?
      AND (ts_code = ? OR ts_code = ? OR substr(ts_code, 1, 6) = ?)
    ORDER BY trade_date ASC,
      CASE
        WHEN ts_code = ? THEN 0
        WHEN ts_code = ? THEN 1
        ELSE 2
      END
  `).all(startDate, endDate, preferredTsCode, stockCode, code6, preferredTsCode, stockCode) as Array<{
    tradeDate: string
    tsCode: string
    pctChg: number | null
    turnoverRate: number | null
  }>

  const dailyByDate = new Map<string, { pctChg: number | null; turnoverRate: number | null }>()
  for (const row of dailyRows) {
    if (!dailyByDate.has(row.tradeDate)) {
      dailyByDate.set(row.tradeDate, { pctChg: row.pctChg, turnoverRate: row.turnoverRate })
    }
  }

  return rows.map((row) => {
    const daily = dailyByDate.get(row.tradeDate)
    return {
      ...row,
      pctChg: daily?.pctChg ?? null,
      turnoverRate: daily?.turnoverRate ?? null,
    }
  })
}

type StockFetchProvider = 'tushare' | 'eastmoney' | 'local-cache'
type StockFetchDataState = 'complete' | 'degraded'

interface StockFetchSummary {
  stockCode: string
  stockName: string
  provider: StockFetchProvider
  latestTradeDate: string | null
  rowsWritten: number
  totalRows: number
  dataState: StockFetchDataState
  benchmark: TrendBenchmarkHealth
  message: string
}

function isUsableStockInfoName(value: string | null | undefined, stockCode: string): value is string {
  const name = value?.trim()
  return Boolean(name && name !== stockCode && name !== '-' && name !== '--')
}

function displayTradeDate(value: string | null): string {
  if (!value || !/^\d{8}$/.test(value)) return '日期待补'
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function getCachedStockFetchSummary(
  db: Database.Database,
  stockCode: string,
  provider: StockFetchProvider,
  rowsWritten: number,
  benchmark: TrendBenchmarkHealth = inspectTrendBenchmarkHealth(db),
): StockFetchSummary | null {
  const cached = getCachedPrices(db, stockCode)
  const stockName = getStockInfo(db, stockCode)?.stockName
  if (cached.length === 0 || !isUsableStockInfoName(stockName, stockCode)) return null
  const latestTradeDate = cached.at(-1)?.tradeDate ?? null
  const dataState: StockFetchDataState = cached.length >= 60 && benchmark.state === 'current'
    ? 'complete'
    : 'degraded'
  const providerLabel = provider === 'tushare'
    ? 'Tushare 行情'
    : provider === 'eastmoney'
      ? '东方财富公开行情'
      : '本地缓存'
  return {
    stockCode,
    stockName: stockName.trim(),
    provider,
    latestTradeDate,
    rowsWritten,
    totalRows: cached.length,
    dataState,
    benchmark,
    message: `${providerLabel} · 截至 ${displayTradeDate(latestTradeDate)} · ${cached.length} 日${benchmark.state === 'current' ? '' : ` · ${benchmark.message}`}`,
  }
}

export function registerAIHandlers(getWindow: () => BrowserWindow | null): void {
  // ── FR-072 / FR-081: per-stock per-provider forecast cache (in-process memory) ──
  interface StockForecastCache {
    today?: { time: string; price: number }[]
    morrow?: { time: string; price: number }[]
    aiReason?: string
    todayCreatedAt?: string // FR-078: ISO timestamp of latest today forecast
    model?: string // FR-082: model name for display label
  }
  /** Legacy single-provider cache (backward compat for getPredictionCache) */
  const forecastCacheMap = new Map<string, StockForecastCache>()
  /** FR-081: multi-provider forecast cache — key: `stockCode:provider` */
  const multiProviderCacheMap = new Map<string, StockForecastCache>()

  // ── ai:getConfig ─────────────────────────────────────────────────────────────
  ipcMain.handle('ai:getConfig', () => {
    const db = getDb()
    const row = getAIConfig(db)
    const allConfigs = getAllProviderConfigs(db)
    const configured = getConfiguredProviders(db)
    const providerHasApiKey: Record<string, boolean> = {}
    for (const p of configured) providerHasApiKey[p] = true
    // Build providerConfigs with decrypted hasApiKey flag (never expose encrypted key)
    const providerConfigs: Record<string, {
      model: string | null
      baseUrl: string | null
      maxTokens: number | null
      presetPrompt: string | null
      trendForecastPrompt: string | null
      trendForecastMorrowPrompt: string | null
      hasApiKey: boolean
    }> = {}
    for (const [p, cfg] of Object.entries(allConfigs)) {
      providerConfigs[p] = {
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        maxTokens: cfg.maxTokens ?? null,
        presetPrompt: cfg.presetPrompt,
        trendForecastPrompt: cfg.trendForecastPrompt,
        trendForecastMorrowPrompt: cfg.trendForecastMorrowPrompt,
        hasApiKey: !!(cfg.apiKeyEncrypted && cfg.apiKeyEncrypted.length > 0)
      }
    }
    return {
      provider: row.provider,
      model: row.model,
      hasApiKey: row.provider ? !!providerHasApiKey[row.provider] : false,
      providerHasApiKey,
      providerConfigs,
      baseUrl: row.baseUrl ?? '',
      presetPrompt: row.presetPrompt ?? DEFAULT_ARTICLE_ANALYSIS_PROMPT,
      triggerRating: row.triggerRating,
      maxArticlesPerBatch: row.maxArticlesPerBatch,
      maxContentCharsPerArticle: row.maxContentCharsPerArticle,
      maxArticleAgeDays: row.maxArticleAgeDays,
      autoCleanupDays: row.autoCleanupDays,
      trendForecastPrompt: row.trendForecastPrompt ?? DEFAULT_TREND_TODAY_PROMPT,
      trendForecastMorrowPrompt: row.trendForecastMorrowPrompt ?? DEFAULT_TREND_MORROW_PROMPT,
      maxForecastsPerStock: row.maxForecastsPerStock ?? 50,
      providerPriority: (() => {
        const arr: string[] = row.providerPriority ? JSON.parse(row.providerPriority) as string[] : []
        // Auto-include any configured provider that's missing from the stored priority list
        for (const p of configured) {
          if (!arr.includes(p)) arr.push(p)
        }
        return arr
      })(),
      multiModelProviders: row.multiModelProviders ? JSON.parse(row.multiModelProviders) as string[] : [],
      maxForecastComparison: row.maxForecastComparison ?? 5,
      selectedSkills: (() => { try { return JSON.parse(row.selectedSkills || '[]') } catch { return [] } })(),
      customSkillPaths: (() => { try { return JSON.parse(row.customSkillPaths || '[]') } catch { return [] } })(),
      skillsForTrend: !!row.skillsForTrend,
      maxSkillChars: row.maxSkillChars ?? 30000,
      providerModels: PROVIDER_MODELS,
      providerLabels: PROVIDER_LABELS,
      providerDefaultBaseUrls: PROVIDER_DEFAULT_BASE_URLS
    }
  })

  // ── ai:saveConfig ─────────────────────────────────────────────────────────────
  ipcMain.handle('ai:saveConfig', (_e, data: {
    provider?: AIProvider
    model?: string
    apiKey?: string // empty string = keep existing
    baseUrl?: string
    presetPrompt?: string
    triggerRating?: ImpactRating
    maxArticlesPerBatch?: number
    maxContentCharsPerArticle?: number
    maxArticleAgeDays?: number | null
    autoCleanupDays?: number | null
    trendForecastPrompt?: string
    trendForecastMorrowPrompt?: string
    maxForecastsPerStock?: number
    providerPriority?: string[]
    multiModelProviders?: string[]
    maxForecastComparison?: number
    selectedSkills?: string[]
    skillsForTrend?: boolean
    maxSkillChars?: number
    // FR-079: per-provider config update
    providerConfig?: {
      provider: string
      model?: string
      apiKey?: string
      baseUrl?: string
      maxTokens?: number
      presetPrompt?: string
      trendForecastPrompt?: string
      trendForecastMorrowPrompt?: string
    }
  }) => {
    const db = getDb()
    const update: Parameters<typeof updateAIConfig>[1] = {}

    if (data.provider !== undefined) update.provider = data.provider
    if (data.model !== undefined) update.model = data.model
    if (data.baseUrl !== undefined) update.baseUrl = data.baseUrl || null
    if (data.presetPrompt !== undefined) update.presetPrompt = data.presetPrompt || null
    if (data.triggerRating !== undefined) update.triggerRating = data.triggerRating
    if (data.maxArticlesPerBatch !== undefined) update.maxArticlesPerBatch = data.maxArticlesPerBatch
    if (data.maxContentCharsPerArticle !== undefined) update.maxContentCharsPerArticle = data.maxContentCharsPerArticle
    if ('maxArticleAgeDays' in data) update.maxArticleAgeDays = data.maxArticleAgeDays ?? null
    if ('autoCleanupDays' in data) update.autoCleanupDays = data.autoCleanupDays ?? null
    if (data.trendForecastPrompt !== undefined) update.trendForecastPrompt = data.trendForecastPrompt || null
    if (data.trendForecastMorrowPrompt !== undefined) update.trendForecastMorrowPrompt = data.trendForecastMorrowPrompt || null
    if (data.maxForecastsPerStock !== undefined) update.maxForecastsPerStock = Math.min(100, Math.max(1, data.maxForecastsPerStock))
    if (data.providerPriority !== undefined) update.providerPriority = JSON.stringify(data.providerPriority)
    if (data.multiModelProviders !== undefined) update.multiModelProviders = JSON.stringify(data.multiModelProviders)
    if (data.maxForecastComparison !== undefined) update.maxForecastComparison = Math.min(10, Math.max(1, data.maxForecastComparison))
    if (data.selectedSkills !== undefined) update.selectedSkills = JSON.stringify(data.selectedSkills)
    if (data.skillsForTrend !== undefined) update.skillsForTrend = data.skillsForTrend ? 1 : 0
    if (data.maxSkillChars !== undefined) update.maxSkillChars = Math.min(100000, Math.max(1000, data.maxSkillChars))

    // Only update API key if a non-empty string was provided (legacy flat path)
    if (data.apiKey) {
      const encrypted = encryptApiKey(data.apiKey)
      if (encrypted) {
        const targetProvider = data.provider ?? getAIConfig(db).provider
        if (targetProvider) {
          setProviderConfig(db, targetProvider, { apiKeyEncrypted: encrypted })
        }
        update.apiKeyEncrypted = encrypted
      }
    }

    // FR-079: per-provider config upsert
    if (data.providerConfig) {
      const pc = data.providerConfig
      const pcUpdate: Record<string, unknown> = {}
      if (pc.model !== undefined) pcUpdate.model = pc.model || null
      if (pc.baseUrl !== undefined) pcUpdate.baseUrl = pc.baseUrl || null
      if (pc.maxTokens !== undefined) pcUpdate.maxTokens = Math.max(1, Math.floor(pc.maxTokens))
      if (pc.presetPrompt !== undefined) pcUpdate.presetPrompt = pc.presetPrompt || null
      if (pc.trendForecastPrompt !== undefined) pcUpdate.trendForecastPrompt = pc.trendForecastPrompt || null
      if (pc.trendForecastMorrowPrompt !== undefined) pcUpdate.trendForecastMorrowPrompt = pc.trendForecastMorrowPrompt || null
      if (pc.apiKey) {
        const encrypted = encryptApiKey(pc.apiKey)
        if (encrypted) pcUpdate.apiKeyEncrypted = encrypted
      }
      setProviderConfig(db, pc.provider, pcUpdate)

      // Auto-add provider to providerPriority when it has a valid API key
      if (pc.apiKey || getProviderConfig(db, pc.provider)?.apiKeyEncrypted) {
        const current = getAIConfig(db)
        const currentPriority: string[] = current.providerPriority
          ? JSON.parse(current.providerPriority)
          : []
        if (!currentPriority.includes(pc.provider)) {
          currentPriority.push(pc.provider)
          update.providerPriority = JSON.stringify(currentPriority)
        }
      }
    }

    updateAIConfig(db, update)
    return { ok: true }
  })

  // ── ai:analyze ────────────────────────────────────────────────────────────────
  // Accepts briefingIds (FR-048: content-first) OR articleUrls (legacy single-article fallback)
  ipcMain.handle('ai:analyze', async (_e, data: {
    briefingIds?: number[]
    articleUrls?: string[]   // legacy: used when briefingId not available
    scanRunId: number | null
    briefingId?: number
  }) => {
    const db = getDb()
    const config = getAIConfig(db)

    // FR-080: resolve first available provider from priority list
    const creds = resolveProviderCredentials(db)
    if (!creds) {
      return { error: { code: 'AI_NOT_CONFIGURED', message: '请先在AI配置页面配置AI厂商和模型' } }
    }

    const maxChars = config.maxContentCharsPerArticle ?? 2000
    // FR-055: inject today's Beijing date prefix; FR-056: append STOCK_CODES instruction
    // FR-079: use per-provider presetPrompt if available
    const presetText = resolveArticleAnalysisPrompt(creds.presetPrompt, config.presetPrompt)
    const skillsBlock = buildSkillsBlock(db)
    const preset = injectTimePrefix(presetText) + skillsBlock + STOCK_CODES_INSTRUCTION

    // --- FR-048: build article blocks ------------------------------------------
    const ids = data.briefingIds ?? []
    const legacyUrls = data.articleUrls ?? []
    const articleUrls: string[] = []
    const articleBlocks: string[] = []

    const win = getWindow()

    if (ids.length > 0) {
      // Fetch content for each briefingId sequentially to emit per-article progress (FR-051)
      const total = ids.length
      for (let i = 0; i < ids.length; i++) {
        pushProgress(win, { step: 'fetching', current: i + 1, total })
        const { url, content } = await fetchBriefingContent(ids[i]).catch(() => ({ url: '', content: null }))
        if (!url) continue
        articleUrls.push(url)
        const body = content ? content.slice(0, maxChars) : url
        articleBlocks.push(`[${i + 1}] ${url}\n${body}`)
      }
    } else {
      legacyUrls.forEach((url, i) => {
        articleUrls.push(url)
        articleBlocks.push(`[${i + 1}] ${url}`)
      })
    }

    const prompt = `${preset}\n\n${articleBlocks.join('\n\n')}`

    pushProgress(win, { step: 'callingRound1' })

    try {
      // FR-080: auto-fallback across providers
      const result = await callWithFallback(db, { prompt })
      const round1Usage = toProgressUsage(result)
      const progressUsages: AIProgressPayload['usages'] = { round1: round1Usage }
      logAIUsage('AI Round1', round1Usage)
      pushProgress(win, { step: 'callingRound1', usages: progressUsages })

      const sessionId = createSession(db, {
        provider: result.provider,
        model: result.model,
        articleUrls,
        promptSent: prompt,
        response: result.text,
        scanRunId: data.scanRunId,
        briefingId: data.briefingId ?? null,
        isError: false
      })

      // FR-056 / FR-240: auto-chain round 2 from real local OHLC, with optional Tushare refresh.
      const dsConfig = getDataSourceConfig(db)
      pushProgress(win, { step: 'parsingStocks', usages: progressUsages })
      let effectiveResponse = result.text
      let stockCodes = parseStockCodes(db, effectiveResponse)
      if (stockCodes.length === 0) {
        pushProgress(win, { step: 'recoveringCandidates', usages: progressUsages })
        try {
          const recovery = await recoverCandidateMapping(db, effectiveResponse)
          effectiveResponse = recovery.response
          stockCodes = recovery.stockCodes
          updateSessionResponse(db, sessionId, effectiveResponse)
          if (recovery.aiResult) {
            const recoveryUsage = toProgressUsage(recovery.aiResult)
            progressUsages.candidateRecovery = recoveryUsage
            logAIUsage('AI Candidate Recovery', recoveryUsage)
          }
          pushProgress(win, { step: 'recoveringCandidates', usages: progressUsages })
        } catch (error) {
          console.warn('[AI Candidate Recovery] failed:', error instanceof Error ? error.message : String(error))
        }
      }
      const tushareReady = !!(dsConfig.tushareEnabled && dsConfig.tushareTokenEncrypted?.length)
      console.log('[AI Round2] Tushare enabled:', dsConfig.tushareEnabled, '| has token:', !!(dsConfig.tushareTokenEncrypted?.length))
      let tushareToken: string | null = null
      if (tushareReady) {
        try {
          tushareToken = decryptApiKey(dsConfig.tushareTokenEncrypted!) || null
        } catch (error) {
          console.warn('[AI Round2] Tushare token decrypt failed, using local cache:', error instanceof Error ? error.message : String(error))
        }
      }
      console.log('[AI Round2] Token decrypted:', !!tushareToken, '| Stock codes:', stockCodes)
      if (stockCodes.length > 0) {
        try {
          pushProgress(win, { step: 'fetchingPrices', usages: progressUsages })
          const marketContext = await prepareArticleRound2MarketContext(db, stockCodes, tushareToken)
          console.log('[AI Round2] Market context:', marketContext.status, '| available:', marketContext.availableCodes, '| missing:', marketContext.missingCodes)
          if (marketContext.refreshAttempted) win?.webContents.send('datasource:stocksUpdated', {})

          if (marketContext.status === 'blocked') {
            updateSessionRound2(db, sessionId, buildRound2MarketBlockedResponse(marketContext))
            if (!tushareReady) win?.webContents.send('ai:tushareNotConfigured', { stockCodes })
          } else {
            const researchFacts = buildArticleRound2ResearchFactContext(db, marketContext.availableCodes)
            const localFactContext = `${marketContext.markdown}\n\n${researchFacts.markdown}`
            const round2Prompt = injectTimePrefix(buildArticleRound2Prompt(effectiveResponse, localFactContext)) + buildSkillsBlock(db)
            console.log('[AI Round2] Calling AI for round 2...')
            pushProgress(win, { step: 'callingRound2', usages: progressUsages })
            const round2Result = await callWithFallback(db, { prompt: round2Prompt })
            console.log('[AI Round2] Round 2 completed, response length:', round2Result.text.length)
            const round2Usage = toProgressUsage(round2Result)
            progressUsages.round2 = round2Usage
            logAIUsage('AI Round2', round2Usage)
            pushProgress(win, { step: 'callingRound2', usages: progressUsages })
            updateSessionRound2(db, sessionId, round2Result.text)
          }
        } catch (e) {
          console.error('[AI Round2] Failed:', e)
          // Second round failure is non-fatal; first round result is already saved.
        }
      }

      refreshStructuredResultInBackground(db, sessionId, 'round1')

      pushProgress(win, { step: 'saving', usages: progressUsages })
      pushProgress(win, { step: 'done', usages: progressUsages })

      return { sessionId, response: effectiveResponse, createdAt: new Date().toISOString() }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const isEmptyResponse = message === 'AI_RESPONSE_EMPTY'

      pushProgress(win, { step: 'saving' })
      const sessionId = createSession(db, {
        provider: creds.provider,
        model: creds.model,
        articleUrls,
        promptSent: prompt,
        response: message,
        scanRunId: data.scanRunId,
        briefingId: data.briefingId ?? null,
        isError: true
      })
      pushProgress(win, { step: 'error' })

      return {
        error: {
          code: isEmptyResponse ? 'AI_RESPONSE_EMPTY' : 'AI_REQUEST_FAILED',
          message: isEmptyResponse ? 'AI返回了空响应' : 'AI API调用失败',
          details: message
        },
        sessionId
      }
    }
  })

  // ── ai:listSessions ────────────────────────────────────────────────────────────
  ipcMain.handle('ai:listSessions', () => {
    const db = getDb()
    const rows = listSessions(db)
    const structuredStatus = listStructuredStatusBySessionIds(db, rows.map((row) => row.id))
    return {
      items: rows.map((r) => ({
        id: r.id,
        createdAt: new Date(r.createdAt).toISOString(),
        provider: r.provider,
        model: r.model,
        articleCount: JSON.parse(r.articleUrls).length,
        isError: r.isError === 1,
        hasRound2: Boolean(r.responseRound2),
        hasStructuredResult: structuredStatus.get(r.id)?.status === 'completed',
        structuredStatus: structuredStatus.get(r.id)?.status ?? null,
        discussion: (() => {
          const context = getResearchDiscussionContext(db, r.id)
          if (!context) return null
          refreshDiscussionOriginAvailability(db, r.id)
          return discussionSummary(db, getResearchDiscussionContext(db, r.id) ?? context)
        })(),
      }))
    }
  })

  // ── ai:getSession ─────────────────────────────────────────────────────────────
  ipcMain.handle('ai:getSession', (_e, data: { id: number }) => {
    const db = getDb()
    const row = getSession(db, data.id)
    if (!row) return null
    const discussion = getResearchDiscussionContext(db, row.id)
    if (discussion) refreshDiscussionOriginAvailability(db, row.id)
    const currentDiscussion = discussion ? getResearchDiscussionContext(db, row.id) ?? discussion : null
    const messages = row.messages ? (JSON.parse(row.messages) as ConversationMessage[]) : null
    const auditContext = currentDiscussion ? getDiscussionResearchAuditContext(db, row.id) : null
    return {
      id: row.id,
      createdAt: new Date(row.createdAt).toISOString(),
      provider: row.provider,
      model: row.model,
      articleUrls: JSON.parse(row.articleUrls) as string[],
      promptSent: row.promptSent,
      response: row.response,
      responseRound2: row.responseRound2 ?? null,
      messages: messages?.map((message) => ({
        ...message,
        ...(message.role === 'assistant' && message.researchAudit
          ? {
              researchTrace: buildResearchAuditTraceView(
                message.researchAudit,
                (message.researchAgentRunId
                  ? getResearchAgentAuditContext(db, message.researchAgentRunId)?.evidenceContrast
                  : null) ?? auditContext?.evidenceContrast,
                message.content,
              ),
            }
          : {}),
      })) ?? null,
      isError: row.isError === 1,
      scanRunId: row.scanRunId,
      structuredResult: getStructuredResult(db, row.id),
      discussion: currentDiscussion ? discussionSummary(db, currentDiscussion) : null,
      contextPreview: currentDiscussion ? discussionContextPreview(currentDiscussion) : [],
    }
  })

  // ── FR-239 research discussions ──────────────────────────────────────────────
  ipcMain.handle('ai:startResearchDiscussion', (_e, data: Record<string, unknown>) => {
    try {
      const requestId = typeof data?.requestId === 'string' ? data.requestId : ''
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new ResearchDiscussionError('INVALID_PARAM', 'requestId 格式无效')
      }
      const origin = data.origin && typeof data.origin === 'object' ? data.origin as Record<string, unknown> : null
      const originTypes = new Set<ResearchDiscussionOriginType>(['daily_review', 'weekly_review', 'decision_signal', 'judgment', 'industry_research', 'briefing', 'manual'])
      if (!origin || typeof origin.type !== 'string' || !originTypes.has(origin.type as ResearchDiscussionOriginType)) {
        throw new ResearchDiscussionError('INVALID_PARAM', 'origin.type 格式无效')
      }
      const returnTarget = data.returnTarget && typeof data.returnTarget === 'object'
        ? data.returnTarget as Record<string, unknown>
        : null
      if (!returnTarget || typeof returnTarget.tab !== 'string' || !returnTarget.tab.trim() || returnTarget.tab.length > 80) {
        throw new ResearchDiscussionError('INVALID_PARAM', 'returnTarget 格式无效')
      }
      const result = startResearchDiscussion(getDb(), {
        requestId,
        origin: {
          type: origin.type as ResearchDiscussionOriginType,
          id: origin.id == null ? null : String(origin.id).slice(0, 128),
        },
        projectId: data.projectId == null ? null : String(data.projectId).slice(0, 128),
        initialQuestion: typeof data.initialQuestion === 'string' ? data.initialQuestion.slice(0, 4000) : undefined,
        mode: data.mode === 'new' ? 'new' : 'continue_or_create',
        returnTarget: {
          tab: returnTarget.tab.trim(),
          subTab: typeof returnTarget.subTab === 'string' ? returnTarget.subTab.slice(0, 80) : undefined,
          entityId: typeof returnTarget.entityId === 'string' ? returnTarget.entityId.slice(0, 128) : undefined,
          stateKey: typeof returnTarget.stateKey === 'string' ? returnTarget.stateKey.slice(0, 128) : undefined,
          scrollTop: typeof returnTarget.scrollTop === 'number' && Number.isFinite(returnTarget.scrollTop) && returnTarget.scrollTop >= 0
            ? Math.min(10_000_000, Math.trunc(returnTarget.scrollTop))
            : undefined,
        },
      })
      const row = result.session
      return {
        ok: true,
        data: {
          ...result,
          session: {
            id: row.id,
            createdAt: new Date(row.createdAt).toISOString(),
            provider: row.provider,
            model: row.model,
            articleUrls: JSON.parse(row.articleUrls) as string[],
            promptSent: row.promptSent,
            response: row.response,
            responseRound2: row.responseRound2 ?? null,
            messages: row.messages ? JSON.parse(row.messages) : [],
            isError: row.isError === 1,
            scanRunId: row.scanRunId,
          },
        },
      }
    } catch (error) {
      if (error instanceof ResearchDiscussionError) return { ok: false, code: error.code, message: error.message }
      console.error('[ai:startResearchDiscussion]', error instanceof Error ? error.message : 'unknown')
      return { ok: false, code: 'DB_ERROR', message: '创建研究讨论失败' }
    }
  })

  ipcMain.handle('ai:updateResearchDiscussionContext', (_e, data: Record<string, unknown>) => {
    try {
      const requestId = typeof data?.requestId === 'string' ? data.requestId : ''
      const sessionId = Number(data?.sessionId)
      if (!/^[0-9a-f-]{36}$/i.test(requestId) || !Number.isInteger(sessionId) || sessionId <= 0) {
        throw new ResearchDiscussionError('INVALID_PARAM', '讨论上下文参数无效')
      }
      if (!Array.isArray(data.includedContextKeys) || data.includedContextKeys.length > 50
        || data.includedContextKeys.some((key) => typeof key !== 'string' || key.length > 100)) {
        throw new ResearchDiscussionError('INVALID_PARAM', 'includedContextKeys 格式无效')
      }
      return { ok: true, data: updateDiscussionContextBeforeStart(getDb(), sessionId, requestId, data.includedContextKeys as string[]) }
    } catch (error) {
      if (error instanceof ResearchDiscussionError) return { ok: false, code: error.code, message: error.message }
      return { ok: false, code: 'DB_ERROR', message: '更新讨论上下文失败' }
    }
  })

  ipcMain.handle('ai:listResearchDiscussions', (_e, data: Record<string, unknown> = {}) => {
    try {
      const origin = data.origin && typeof data.origin === 'object' ? data.origin as Record<string, unknown> : null
      const projectId = typeof data.projectId === 'string' ? data.projectId.slice(0, 128) : undefined
      if (!origin && !projectId) throw new ResearchDiscussionError('INVALID_PARAM', 'origin 和 projectId 至少提供一个')
      const originTypes = new Set<ResearchDiscussionOriginType>(['daily_review', 'weekly_review', 'decision_signal', 'judgment', 'industry_research', 'briefing', 'manual'])
      const statusValues = new Set<ResearchDiscussionStatus>(['active', 'changes_ready', 'partially_applied', 'applied', 'archived'])
      if (origin && (typeof origin.type !== 'string' || !originTypes.has(origin.type as ResearchDiscussionOriginType))) {
        throw new ResearchDiscussionError('INVALID_PARAM', 'origin.type 格式无效')
      }
      if (data.status != null && (typeof data.status !== 'string' || !statusValues.has(data.status as ResearchDiscussionStatus))) {
        throw new ResearchDiscussionError('INVALID_PARAM', 'status 格式无效')
      }
      return { ok: true, data: listResearchDiscussions(getDb(), {
        originType: origin?.type as ResearchDiscussionOriginType | undefined,
        originId: origin ? (origin.id == null ? null : String(origin.id).slice(0, 128)) : undefined,
        projectId,
        status: data.status as ResearchDiscussionStatus | undefined,
        offset: Math.max(0, Number(data.offset) || 0),
        limit: Math.min(100, Math.max(1, Number(data.limit) || 20)),
      }) }
    } catch (error) {
      if (error instanceof ResearchDiscussionError) return { ok: false, code: error.code, message: error.message }
      return { ok: false, code: 'DB_ERROR', message: '读取研究讨论失败' }
    }
  })

  // ── ai:generateStructuredResult ──────────────────────────────────────────────
  ipcMain.handle('ai:generateStructuredResult', async (_e, data: { sessionId: number; force?: boolean }) => {
    const db = getDb()
    const result = await generateStructuredResult(db, data.sessionId, { force: data.force })
    return { structuredResult: result }
  })

  // ── ai:deleteAllSessions ───────────────────────────────────────────────────────
  ipcMain.handle('ai:deleteAllSessions', (_e, data: { includeResearchDiscussions?: boolean } = {}) => {
    const db = getDb()
    const protectedResearchDiscussions = countResearchDiscussionSessions(db)
    if (data.includeResearchDiscussions) {
      deleteAllResearchDiscussions(db)
    }
    const deleted = deleteAllSessions(db, false)
    return { deleted, protectedResearchDiscussions: data.includeResearchDiscussions ? 0 : protectedResearchDiscussions }
  })

  // ── ai:cleanupOldSessions ──────────────────────────────────────────────────────
  ipcMain.handle('ai:cleanupOldSessions', (_e, data: { olderThanDays: number; dryRun: boolean }) => {
    const db = getDb()
    const olderThanMs = data.olderThanDays * 24 * 60 * 60 * 1000
    return deleteSessionsOlderThan(db, olderThanMs, data.dryRun)
  })

  // ── ai:deleteSession ──────────────────────────────────────────────────────────
  ipcMain.handle('ai:deleteSession', (_e, data: { id: number; confirmResearchDiscussion?: boolean }) => {
    const db = getDb()
    const discussion = getResearchDiscussionContext(db, data.id)
    if (discussion) {
      if (!data.confirmResearchDiscussion) {
        return { ok: false, error: 'CONFIRM_REQUIRED', message: '删除研究讨论会使未处理变更包失效，但不会删除已写入研究' }
      }
      deleteResearchDiscussion(db, data.id)
      return { ok: true }
    }
    deleteSession(db, data.id)
    return { ok: true }
  })

  // ── ai:recoverCandidates ──────────────────────────────────────────────────────
  ipcMain.handle('ai:recoverCandidates', async (_e, data: { sessionId: number }) => {
    const sessionId = Number(data?.sessionId)
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return { ok: false, code: 'INVALID_STATE', message: '会话参数无效' }
    }
    const db = getDb()
    try {
      const result = await recoverSessionCandidates(db, sessionId, async (response) => {
        if (!resolveProviderCredentials(db)) {
          throw new CandidateRecoveryError('INVALID_STATE', 'AI尚未配置')
        }
        return recoverCandidateMapping(db, response)
      })
      if (result.updated) refreshStructuredResultInBackground(db, sessionId, 'candidate recovery')
      return {
        ok: true,
        recovered: result.recovered,
        stockCodes: result.stockCodes,
        response: result.response,
      }
    } catch (error) {
      if (error instanceof CandidateRecoveryError) {
        return { ok: false, code: error.code, message: error.message }
      }
      console.warn('[AI Candidate Recovery] manual recovery failed:', error instanceof Error ? error.message : String(error))
      return {
        ok: false,
        code: 'AI_REQUEST_FAILED',
        message: 'A股标的映射失败，请稍后重试',
      }
    }
  })

  // ── ai:triggerRound2 ──────────────────────────────────────────────────────────
  // FR-060: manually trigger second-round analysis for a session
  ipcMain.handle('ai:triggerRound2', async (_e, data: { sessionId: number }) => {
    const db = getDb()
    const session = getSession(db, data.sessionId)
    if (!session) return { error: 'Session not found' }

    if (!resolveProviderCredentials(db)) return { error: 'AI not configured' }

    const codes = parseStockCodes(db, session.response ?? '')
    if (codes.length === 0) return { error: 'No stock codes in response' }

    const dsConfig = getDataSourceConfig(db)
    let tushareToken: string | null = null
    if (dsConfig.tushareEnabled && dsConfig.tushareTokenEncrypted) {
      try {
        tushareToken = decryptApiKey(dsConfig.tushareTokenEncrypted) || null
      } catch (error) {
        console.warn('[AI Round2] Tushare token decrypt failed, using local cache:', error instanceof Error ? error.message : String(error))
      }
    }

    try {
      const marketContext = await prepareArticleRound2MarketContext(db, codes, tushareToken)
      if (marketContext.refreshAttempted) getWindow()?.webContents.send('datasource:stocksUpdated', {})
      if (marketContext.status === 'blocked') {
        const responseRound2 = buildRound2MarketBlockedResponse(marketContext)
        updateSessionRound2(db, data.sessionId, responseRound2)
        return { responseRound2, marketDataStatus: 'blocked' }
      }
      const round2Prompt = injectTimePrefix(buildArticleRound2Prompt(session.response ?? '', marketContext.markdown)) + buildSkillsBlock(db)
      const result = await callWithFallback(db, { prompt: round2Prompt })
      updateSessionRound2(db, data.sessionId, result.text)
      refreshStructuredResultInBackground(db, data.sessionId, 'manual round2')
      return {
        responseRound2: result.text,
        marketDataStatus: marketContext.status,
        marketDataCutoff: marketContext.latestTradeDate,
      }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── ai:followUp ───────────────────────────────────────────────────────────────
  // FR-061: continue conversation within an existing session
  ipcMain.handle('ai:followUp', async (_e, data: { sessionId: number; message: string }) => {
    const db = getDb()
    const session = getSession(db, data.sessionId)
    if (!session) return { error: 'Session not found' }

    if (!resolveProviderCredentials(db)) return { error: 'AI not configured' }

    // Build or restore conversation history
    let messages: ConversationMessage[]
    if (session.messages) {
      messages = JSON.parse(session.messages) as ConversationMessage[]
    } else {
      // Seed context from round1 + optional round2 response
      const context =
        (session.response ?? '') +
        (session.responseRound2 ? `\n\n【第二轮深度分析】\n${session.responseRound2}` : '')
      messages = [{ role: 'assistant', content: context }]
    }

    messages.push({ role: 'user', content: injectTimePrefix(data.message) })

    try {
      const result = await callWithFallback(db, buildDiscussionAIRequest(db, data.sessionId, messages))
      const auditContext = getDiscussionResearchAuditContext(db, data.sessionId)
      const researchAudit = auditContext
        ? auditResearchText({
            text: result.text,
            documentKind: 'discussion',
            evidenceContrast: auditContext.evidenceContrast,
            asOf: auditContext.asOf,
            excludedUrls: auditContext.excludedUrls,
            webSearchTrace: result.webSearchTrace,
            allowedFactTexts: [
              ...auditContext.allowedFactTexts,
              ...messages.filter((message) => message.role === 'user').map((message) => message.content),
            ],
          })
        : null
      const persistedText = researchAudit?.status === 'blocked'
        ? buildBlockedResearchText(researchAudit)
        : result.text
      messages.push({
        role: 'assistant',
        content: persistedText,
        webSearchTrace: result.webSearchTrace,
        ...(researchAudit ? { researchAudit } : {}),
      })
      updateSessionMessages(db, data.sessionId, messages)
      refreshStructuredResultInBackground(db, data.sessionId, 'follow up')
      return { text: persistedText, messages }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ── datasource:getConfig ──────────────────────────────────────────────────────
  ipcMain.handle('datasource:getConfig', () => {
    const db = getDb()
    const row = getDataSourceConfig(db)
    return {
      tushareEnabled: row.tushareEnabled === 1,
      hasTushareToken: !!(row.tushareTokenEncrypted && row.tushareTokenEncrypted.length > 0)
    }
  })

  // ── datasource:saveConfig ─────────────────────────────────────────────────────
  ipcMain.handle('datasource:saveConfig', (_e, data: { tushareToken?: string; tushareEnabled?: boolean }) => {
    const db = getDb()
    const update: Parameters<typeof updateDataSourceConfig>[1] = {}
    if (data.tushareToken) update.tushareTokenEncrypted = encryptApiKey(data.tushareToken)
    if (data.tushareEnabled !== undefined) update.tushareEnabled = data.tushareEnabled ? 1 : 0
    updateDataSourceConfig(db, update)
    // FR-123: 关闭 Tushare 时立即取消分钟 K 订阅, 防止失效订阅继续轮询
    if (data.tushareEnabled === false) {
      unsubscribeStockMinute()
    }
    const latest = getDataSourceConfig(db)
    if (latest.tushareEnabled === 1 && latest.tushareTokenEncrypted) {
      void runStockBasicSyncJob().catch((err) => {
        console.warn('[datasource:saveConfig] stock_basic 自动同步失败:', err instanceof Error ? err.message : String(err))
      })
    }
    return { ok: true }
  })

  // ── datasource:validateTushare ────────────────────────────────────────────────
  ipcMain.handle('datasource:validateTushare', async (_e, data: { token: string }) => {
    return validateTushareToken(data.token)
  })

  // ── datasource:listStocks ──────────────────────────────────────────────────────
  // Returns distinct stock codes that have cached price data, with names from stock_info
  ipcMain.handle('datasource:listStocks', () => {
    const db = getDb()
    const rows = db
      .prepare(`
        SELECT s.stockCode, COALESCE(i.stockName, s.stockCode) AS stockName
        FROM (SELECT DISTINCT stockCode FROM stock_price_cache ORDER BY stockCode) s
        LEFT JOIN stock_info i ON i.stockCode = s.stockCode
      `)
      .all() as { stockCode: string; stockName: string }[]
    return rows
  })

  // ── datasource:getStockPrices ──────────────────────────────────────────────────
  ipcMain.handle('datasource:getStockPrices', async (_e, data: { stockCode: string }) => {
    const db = getDb()
    // FR-093: read path fallback — synthesize today's missing daily row from intraday data.
    await backfillTodayDailyFromIntradayIfMissing(db, data.stockCode)
    const rows = db
      .prepare('SELECT * FROM stock_price_cache WHERE stockCode = ? ORDER BY tradeDate ASC')
      .all(data.stockCode) as StockPriceRecord[]

    return enrichStockPriceRows(db, data.stockCode, rows)
  })

  // 股票走势图首屏与左侧历史增量读取。旧全量接口继续保留给预测等既有消费者。
  ipcMain.handle('datasource:getStockPricePage', async (_e, data: {
    stockCode?: string
    beforeTradeDate?: string
    limit?: number
  }) => {
    const stockCode = String(data?.stockCode ?? '').trim()
    const beforeTradeDate = data?.beforeTradeDate == null
      ? undefined
      : String(data.beforeTradeDate).trim()
    const requestedLimit = Number(data?.limit ?? 149)
    if (
      !/^(?:\d{6}|\d{6}\.(?:SH|SZ|BJ))$/.test(stockCode)
      || !Number.isInteger(requestedLimit)
      || requestedLimit < 1
      || requestedLimit > 240
      || (beforeTradeDate != null && !/^\d{8}$/.test(beforeTradeDate))
    ) {
      return {
        ok: false as const,
        error: { code: 'INVALID_PARAM', message: '日线分页参数无效' },
      }
    }

    const db = getDb()
    if (!beforeTradeDate) {
      await backfillTodayDailyFromIntradayIfMissing(db, stockCode)
    }
    const page = getCachedPricePage(db, stockCode, requestedLimit, beforeTradeDate)
    return {
      ok: true as const,
      rows: enrichStockPriceRows(db, stockCode, page.rows),
      hasMore: page.hasMore,
    }
  })

  // ── datasource:deleteStock ─────────────────────────────────────────────────────
  // FR-065: Remove a single stock and its cached data; preset indices are protected
  ipcMain.handle('datasource:deleteStock', (_e, data: { stockCode: string }) => {
    const PRESET_INDEX_CODES = ['000001.SH', '399001.SZ', '399006.SZ']
    if (PRESET_INDEX_CODES.includes(data.stockCode)) return { ok: false, reason: 'preset' }
    const db = getDb()
    db.prepare('DELETE FROM stock_price_cache WHERE stockCode = ?').run(data.stockCode)
    db.prepare('DELETE FROM stock_info WHERE stockCode = ?').run(data.stockCode)
    return { ok: true }
  })

  // ── datasource:clearAllStocks ─────────────────────────────────────────────────
  // FR-065: Remove all non-preset stocks and their cached data
  ipcMain.handle('datasource:clearAllStocks', () => {
    const db = getDb()
    db.prepare(
      "DELETE FROM stock_price_cache WHERE stockCode NOT IN ('000001.SH','399001.SZ','399006.SZ')"
    ).run()
    db.prepare(
      "DELETE FROM stock_info WHERE stockCode NOT IN ('000001.SH','399001.SZ','399006.SZ')"
    ).run()
    return { ok: true }
  })

  // ── datasource:refreshStock ────────────────────────────────────────────────────
  // FR-066/067/252: Re-fetch one stock or preset index.
  // Regular stocks use Tushare when configured, otherwise the explicit single-stock Eastmoney fallback.
  ipcMain.handle('datasource:refreshStock', async (_e, data: { stockCode: string; force?: boolean }) => {
    const db = getDb()
    const PRESET_INDEX_CODES = ['000001.SH', '399001.SZ', '399006.SZ']
    const rawCode = String(data?.stockCode ?? '').trim().toUpperCase()

    try {
      if (PRESET_INDEX_CODES.includes(rawCode)) {
        // FR-067: Eastmoney free API — no Tushare config check needed
        const rowsWritten = await fetchIndexPrices(db, rawCode, data.force !== false)
        const cached = getCachedPrices(db, rawCode)
        const latestTradeDate = cached.at(-1)?.tradeDate ?? null
        forecastCacheMap.delete(rawCode)
        getWindow()?.webContents.send('datasource:stocksUpdated', {})
        return {
          ok: true as const,
          provider: 'eastmoney' as const,
          latestTradeDate,
          rowsWritten,
          totalRows: cached.length,
          dataState: cached.length >= 60 ? 'complete' as const : 'degraded' as const,
          benchmark: inspectTrendBenchmarkHealth(db),
          message: `东方财富公开行情 · 截至 ${displayTradeDate(latestTradeDate)} · ${cached.length} 日`,
        }
      }

      const stockCode = rawCode.replace(/\.(SH|SZ|BJ)$/i, '')
      if (!/^\d{6}$/.test(stockCode)) return { ok: false as const, reason: 'invalid_code' as const }
      const dsConfig = getDataSourceConfig(db)
      let result: StockFetchSummary | null = null
      if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
        const fetched = await fetchEastmoneySingleStockDaily(db, stockCode)
        if (!fetched.ok) {
          return {
            ok: false as const,
            reason: fetched.code === 'STOCK_NOT_FOUND'
              ? 'not_found' as const
              : fetched.code === 'INVALID_STOCK_CODE'
                ? 'invalid_code' as const
                : 'fetch_error' as const,
          }
        }
        result = fetched
      } else {
        const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
        if (!token) return { ok: false as const, reason: 'no_token' as const }
        const rowsWritten = await forceFetchSingleStock(db, token, stockCode)
        const benchmark = await ensureTrendBenchmarkFreshness(db)
        result = getCachedStockFetchSummary(db, stockCode, 'tushare', rowsWritten, benchmark)
        if (!result) return { ok: false as const, reason: 'not_found' as const }
      }
      // FR-072: clear forecast cache for the refreshed stock
      forecastCacheMap.delete(stockCode)
      getWindow()?.webContents.send('datasource:stocksUpdated', {})
      return { ok: true as const, ...result }
    } catch {
      return { ok: false as const, reason: 'fetch_error' as const }
    }
  })

  // ── datasource:fetchStock ──────────────────────────────────────────────────
  // FR-069/252: 手动按股票代码查询行情，写入缓存并加入走势图列表
  ipcMain.handle('datasource:fetchStock', async (_e, data: { stockCode: string }) => {
    const db = getDb()
    const stockCode = String(data?.stockCode ?? '').trim()
    if (!/^\d{6}$/.test(stockCode)) {
      return { error: { code: 'INVALID_STOCK_CODE', message: '请输入六位股票代码' } }
    }

    const local = getCachedStockFetchSummary(db, stockCode, 'local-cache', 0)
    if (local && local.totalRows >= 60) {
      const benchmark = await ensureTrendBenchmarkFreshness(db)
      const refreshedLocal = getCachedStockFetchSummary(db, stockCode, 'local-cache', 0, benchmark)
      if (refreshedLocal) return { ...refreshedLocal, added: true as const }
    }

    const dsConfig = getDataSourceConfig(db)
    if (!dsConfig.tushareEnabled || !dsConfig.tushareTokenEncrypted) {
      const fetched = await fetchEastmoneySingleStockDaily(db, stockCode)
      if (!fetched.ok) {
        if (local) return { ...local, added: true as const }
        return { error: { code: fetched.code, message: fetched.message } }
      }
      getWindow()?.webContents.send('datasource:stocksUpdated', {})
      return { ...fetched, added: true as const }
    }
    const token = decryptApiKey(dsConfig.tushareTokenEncrypted)
    if (!token) {
      return { error: { code: 'FETCH_FAILED', message: 'Tushare 配置不可用，请检查数据源设置' } }
    }
    try {
      const rowsInserted = await forceFetchSingleStock(db, token, stockCode)
      const benchmark = await ensureTrendBenchmarkFreshness(db)
      // FR-069 补充：Tushare 返回空数据表示股票代码不存在
      if (rowsInserted === 0 && getCachedPrices(db, stockCode).length === 0) {
        return { error: { code: 'STOCK_NOT_FOUND', message: `未找到股票代码 ${stockCode}，请确认代码是否正确` } }
      }
      const summary = getCachedStockFetchSummary(db, stockCode, 'tushare', rowsInserted, benchmark)
      if (!summary) {
        return { error: { code: 'STOCK_NOT_FOUND', message: `未取得股票代码 ${stockCode} 的有效名称和行情` } }
      }
      getWindow()?.webContents.send('datasource:stocksUpdated', {})
      return { ...summary, added: true as const }
    } catch (err) {
      return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : '查询失败' } }
    }
  })

  // ── datasource:updateStockName ───────────────────────────────────────────
  // FR-107: 用云图传入的权威名称直接修正 stock_info，不依赖 Tushare
  ipcMain.handle('datasource:updateStockName', (_e, data: { stockCode: string; stockName: string }) => {
    const db = getDb()
    upsertStockInfo(db, data.stockCode, data.stockName)
    return { ok: true }
  })

  // ── datasource:searchStock ────────────────────────────────────────────────
  // 按股票名称或代码模糊搜索，优先从本地 stock_basic_cache 查询，无需调用 API
  ipcMain.handle('datasource:searchStock', (_e, data: { keyword: string }) => {
    const keyword = (data?.keyword ?? '').trim()
    if (!keyword) return { ok: true as const, results: [], empty: false }
    const db = getDb()
    const total = countStockBasic(db)
    if (total === 0) {
      // stock_basic 尚未同步，提示用户
      return { ok: true as const, results: [], empty: true }
    }
    const results = searchByNameOrCode(db, keyword, 10)
    return { ok: true as const, results, empty: false }
  })

  // ── datasource:getIntradayData ─────────────────────────────────────────────
  // FR-070: 获取分时图数据（不持久化，仅用于当次展示）
  ipcMain.handle('datasource:getIntradayData', async (_e, data: { stockCode: string }) => {
    try {
      const items = await fetchIntradayData(data.stockCode)
      const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const date = bjNow.toISOString().slice(0, 10)
      if (items.length === 0) {
        return { stockCode: data.stockCode, date, items: [], message: '当日暂无分时数据' }
      }
      return { stockCode: data.stockCode, date, items }
    } catch (err) {
      return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : '查询失败' } }
    }
  })

  // ── FR-123: 个股分钟级 K 线 IPC（Tushare 374 rt_min）─────────────────────────

  /** 取北京时间 YYYYMMDD */
  function bjTodayYYYYMMDD(): string {
    const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
    return bjNow.toISOString().slice(0, 10).replace(/-/g, '')
  }

  // DB-first + 今日用 Tushare 补拉 / Tushare 缺失时回退东财 push2his OHLCV 补拉并落库
  ipcMain.handle('datasource:getStockMinuteKline', async (_e, data: { tsCode?: string; tradeDate?: string }) => {
    if (!data?.tsCode) return { ok: false, code: 'INVALID_PARAM', message: '缺少 tsCode' }
    const stockCode = data.tsCode.split('.')[0]
    const todayStr = bjTodayYYYYMMDD()
    const tradeDate = data.tradeDate || todayStr

    // 先查 DB
    let rows = getStockMinuteByDate(getDb(), stockCode, tradeDate)
    if (rows.length > 0) return { ok: true, data: rows }

    if (tradeDate === todayStr) {
      // 今日模式：Tushare rt_min_daily
      const dsCfg = getDataSourceConfig(getDb())
      if (dsCfg.tushareEnabled && dsCfg.tushareTokenEncrypted) {
        try {
          const token = decryptApiKey(dsCfg.tushareTokenEncrypted)
          if (!token) throw new Error('TUSHARE_TOKEN_UNAVAILABLE')
          const fetched = await fetchStockMinuteDaily(token, data.tsCode)
          if (fetched.length > 0) {
            upsertStockMinute(getDb(), fetched)
            rows = fetched
          }
        } catch {
          // Tushare 失败静默
        }
      }
    }

    // Tushare 未取到（无权限/失败/历史日）→ 回退东财 push2his klt=1 完整 OHLCV，
    // 落库 stock_minute_cache 后由专业蜡烛路径自动渲染（复权口径 fqt=0 与日K一致）
    if (rows.length === 0) {
      try {
        const bars = await fetchEastmoneyMinuteOHLCV(data.tsCode, tradeDate)
        if (bars.length > 0) {
          const now = Date.now()
          const cacheRows = bars.map(b => ({
            stockCode,
            tradeDate: b.tradeDate || tradeDate,
            tsMinute: b.tsMinute,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            vol: b.vol,
            amount: b.amount,
            fetchedAt: now
          }))
          upsertStockMinute(getDb(), cacheRows)
          rows = getStockMinuteByDate(getDb(), stockCode, tradeDate)
        }
      } catch {
        // 东财失败静默，返回空数组
      }
    }

    return { ok: true, data: rows }
  })

  // 启动一只股票的分钟订阅（互斥, 切换股票自动 unsubscribe 旧的）
  // 不再要求 Tushare：无 Tushare 时订阅内部自动回退东财 push2his 60s 轮询
  ipcMain.handle('datasource:subscribeStockMinute', async (_e, data: { stockCode?: string }) => {
    if (!data?.stockCode) return { ok: false, code: 'INVALID_PARAM', message: '缺少 stockCode' }
    subscribeStockMinute(data.stockCode)
    return { ok: true }
  })

  // 取消当前活跃订阅
  ipcMain.handle('datasource:unsubscribeStockMinute', () => {
    unsubscribeStockMinute()
    return { ok: true }
  })

  /** A股午休过滤：剔除 11:30 <= time < 13:00 的时间点 */
  function isAShareLunchBreak(time: string): boolean {
    return time >= '11:30' && time < '13:00'
  }

  /** A股标准5分钟交易时间网格（09:30-11:25, 13:00-15:00） */
  const A_SHARE_TIME_GRID: string[] = (() => {
    const grid: string[] = []
    // 上午 09:30 ~ 11:25（每5分钟）
    for (let m = 9 * 60 + 30; m <= 11 * 60 + 25; m += 5) {
      grid.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
    }
    // 下午 13:00 ~ 15:00（每5分钟）
    for (let m = 13 * 60; m <= 15 * 60; m += 5) {
      grid.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
    }
    return grid
  })()

  /** 将时间字符串转为分钟数（用于 snap 计算） */
  function timeToMinutes(t: string): number {
    const parts = t.split(':')
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)
  }

  /** 归一化时间格式："9:30"→"09:30"，"930"→"09:30" 等 */
  function normalizeTimeStr(raw: string): string {
    const trimmed = raw.trim()
    // 处理无冒号格式："930"→"9:30"，"1305"→"13:05"
    if (!trimmed.includes(':')) {
      if (trimmed.length === 3) return `0${trimmed[0]}:${trimmed.slice(1)}`
      if (trimmed.length === 4) return `${trimmed.slice(0, 2)}:${trimmed.slice(2)}`
    }
    const [h, m] = trimmed.split(':')
    return `${h.padStart(2, '0')}:${(m || '00').padStart(2, '0')}`
  }

  /** 将时间 snap 到最近的 A 股 5 分钟网格点 */
  function snapToGrid(time: string): string | null {
    const normalized = normalizeTimeStr(time)
    const mins = timeToMinutes(normalized)
    let best = A_SHARE_TIME_GRID[0]
    let bestDiff = Infinity
    for (const g of A_SHARE_TIME_GRID) {
      const diff = Math.abs(timeToMinutes(g) - mins)
      if (diff < bestDiff) {
        bestDiff = diff
        best = g
      }
    }
    // 偏差超过 5 分钟则丢弃（说明该点本身就不属于交易时段）
    return bestDiff <= 5 ? best : null
  }

  /** Parse JSON forecast block, snap 到标准时间网格, extract AI reason text */
  function parseForecastResponse(rawResponse: string): {
    points: { time: string; price: number }[]
    aiReason: string
    direction?: string
    confidence?: number
    keySupport?: number
    keyResistance?: number
  } {
    const match = rawResponse.match(/```json\s*(\[[\s\S]*?\])\s*```/)
    let points: { time: string; price: number }[] = []
    if (match) {
      try {
        const parsed = JSON.parse(match[1])
        if (Array.isArray(parsed)) {
          // 过滤有效数据 → 归一化 snap → 去重（同一网格点取后值）
          const snapped = new Map<string, number>()
          for (const d of parsed) {
            if (
              typeof (d as Record<string, unknown>).time !== 'string' ||
              typeof (d as Record<string, unknown>).price !== 'number'
            ) continue
            const raw = (d as Record<string, unknown>).time as string
            const gridTime = snapToGrid(raw)
            if (gridTime && !isAShareLunchBreak(gridTime)) {
              snapped.set(gridTime, (d as Record<string, unknown>).price as number)
            }
          }
          // 按时间顺序输出
          points = A_SHARE_TIME_GRID
            .filter(t => snapped.has(t))
            .map(t => ({ time: t, price: snapped.get(t)! }))
        }
      } catch { /* ignore parse errors */ }
    }
    // Extract AI reason: everything before the ```json block
    const aiReason = match
      ? rawResponse.slice(0, rawResponse.indexOf(match[0])).trim()
      : rawResponse.trim()

    // FR-163f: 解析 analysis 结构化输出块
    let direction: string | undefined
    let confidence: number | undefined
    let keySupport: number | undefined
    let keyResistance: number | undefined
    const analysisMatch = rawResponse.match(/```analysis\s*([\s\S]*?)```/)
    if (analysisMatch) {
      try {
        const parsed = JSON.parse(analysisMatch[1].trim()) as Record<string, unknown>
        if (typeof parsed.direction === 'string') direction = parsed.direction
        if (typeof parsed.confidence === 'number') confidence = parsed.confidence
        if (typeof parsed.key_support === 'number') keySupport = parsed.key_support
        if (typeof parsed.key_resistance === 'number') keyResistance = parsed.key_resistance
      } catch { /* ignore parse errors */ }
    }

    return { points, aiReason, direction, confidence, keySupport, keyResistance }
  }

  function emitAIForecastDecisionSignal(input: {
    stockCode: string
    forecastType: 'today' | 'morrow'
    forecastId: number
    provider?: string | null
    model?: string | null
    direction?: string
    confidence?: number
    keySupport?: number
    keyResistance?: number
  }): void {
    try {
      if (input.confidence == null || input.confidence < 70) return
      if (input.direction !== 'up' && input.direction !== 'down') return
      const isUp = input.direction === 'up'
      const label = input.forecastType === 'today' ? '今日走势' : '明日走势'
      emitDecisionSignal(getDb(), {
        sourceModule: 'ai',
        strategyKey: `ai.${input.forecastType}Forecast`,
        tsCode: input.stockCode,
        signalType: 'INFO',
        direction: isUp ? 'BULLISH' : 'BEARISH',
        priority: input.confidence >= 85 ? 4 : 3,
        score: input.confidence,
        confidence: input.confidence,
        title: `${input.stockCode} AI ${label}判断${isUp ? '偏多' : '偏空'}`,
        summary: `模型置信度 ${input.confidence.toFixed(0)}%, 关键支撑 ${input.keySupport ?? '—'}, 关键压力 ${input.keyResistance ?? '—'}。`,
        reason: {
          direction: input.direction,
          confidence: input.confidence,
          keySupport: input.keySupport,
          keyResistance: input.keyResistance,
          provider: input.provider,
          model: input.model,
        },
        sourceRef: { forecastId: input.forecastId, forecastType: input.forecastType },
        dedupKey: `ai:${input.forecastType}:${input.stockCode}:${input.provider ?? 'default'}:${new Date().toISOString().slice(0, 10)}`,
      })
    } catch (err) {
      console.warn('[AI] emit decision signal failed:', err)
    }
  }

  /** Shared helper: fetch board/market intraday and build prompt suffix */
  async function buildBoardMarketSuffix(stockCode: string): Promise<string> {
    const boardSecid = getBoardSecid(stockCode)
    const marketSecid = '1.000001'
    const boardItems = await fetchIntradayDataBySecid(boardSecid)
    const marketItems = boardSecid === marketSecid ? boardItems : await fetchIntradayDataBySecid(marketSecid)
    const marketPart = `\n\n大盘（上证指数）分时：${JSON.stringify(marketItems.map(i => ({ time: i.time, price: i.price })))}`
    const boardPart = boardSecid !== marketSecid
      ? `\n\n板块分时：${JSON.stringify(boardItems.map(i => ({ time: i.time, price: i.price })))}`
      : ''
    return marketPart + boardPart
  }

  // ── ai:predictTrendToday ──────────────────────────────────────────────────
  // FR-072: 预测今日走势（仅当日分时数据 + 板块/大盘）
  // FR-080: auto-fallback across providers
  // FR-081: multi-model parallel prediction via Promise.allSettled
  ipcMain.handle('ai:predictTrendToday', async (_e, data: { stockCode: string; provider?: string; providers?: string[] }) => {
    const db = getDb()
    const aiConfig = getAIConfig(db)
    const requestedProviders = Array.isArray(data.providers)
      ? [...new Set(data.providers.map((p) => String(p).trim()).filter(Boolean))]
      : []

    // If a specific provider is requested, use single-provider path for that provider
    if (data.provider) {
      const pc = getProviderConfig(db, data.provider)
      if (!pc?.apiKeyEncrypted) {
        return { error: { code: 'AI_NOT_CONFIGURED', message: `厂商 ${data.provider} 未配置 API Key` } }
      }
      const apiKey = decryptApiKey(pc.apiKeyEncrypted)
      if (!apiKey) return { error: { code: 'AI_NOT_CONFIGURED', message: `厂商 ${data.provider} API Key 解密失败` } }
      const model = pc.model || (PROVIDER_MODELS as Record<string, string[]>)[data.provider]?.[0] || ''
      if (!model) return { error: { code: 'AI_NOT_CONFIGURED', message: `厂商 ${data.provider} 未选择模型` } }
      try {
        // FR-163a: 优先从 DB 读取今日 OHLCV 分钟 K 线；无数据时 fallback 东财 price-only
        const bjToday = getBjTodayYmd()
        const minuteRows = getStockMinuteByDate(db, data.stockCode, bjToday)
        let intradayLabel: string
        let intradayJson: string
        let dataPointCount = 0
        if (minuteRows.length > 0) {
          intradayLabel = '今日1分钟K线（t=时间,o=开,h=高,l=低,c=收,v=成交量手）'
          dataPointCount = minuteRows.length
          intradayJson = JSON.stringify(minuteRows.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))
        } else {
          const stockItems = await fetchIntradayData(data.stockCode)
          if (stockItems.length === 0) {
            return { error: { code: 'INTRADAY_EMPTY', message: '当日暂无分时数据，无法预测' } }
          }
          intradayLabel = '实际分时数据（至今）'
          dataPointCount = stockItems.length
          intradayJson = JSON.stringify(stockItems.map(i => ({ time: i.time, price: i.price })))
        }
        const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
        const timeStr = `${bjNow.getUTCHours().toString().padStart(2, '0')}:${bjNow.getUTCMinutes().toString().padStart(2, '0')}`
        const boardSuffix = await buildBoardMarketSuffix(data.stockCode)
        // FR-163b-e: 构建数据增强摘要
        const tsCode = toTsCodeWithSuffix(data.stockCode)
        const techSummary = buildTechnicalSummary(db, tsCode)
        const limitSummary = buildLimitConceptSummary(db, data.stockCode)
        const sectorSummary = buildSectorFlowSummary(db, data.stockCode)
        const smcSummary = buildSMCSummary(db, data.stockCode)
        const extraContext = [techSummary, limitSummary, sectorSummary, smcSummary].filter(Boolean).join('\n\n')
        const forecastPrompt = injectTimePrefix(pc.trendForecastPrompt || aiConfig.trendForecastPrompt || DEFAULT_TREND_TODAY_PROMPT) + buildSkillsBlock(db, true)
        const prompt = `${forecastPrompt}\n\n股票代码：${data.stockCode}\n当前北京时间：${timeStr}\n\n${intradayLabel}：${intradayJson}${boardSuffix}${extraContext ? '\n\n' + extraContext : ''}\n\n请在响应末尾输出如下格式的预测数据（从${timeStr}到15:00，每5分钟一条，**跳过11:30至13:00的午休时段**，仅输出上午09:30-11:25和下午13:00-15:00区间的时间点）：\n\`\`\`json\n[{"time":"HH:mm","price":0.00}]\n\`\`\`\n\n并另外输出结构化分析（紧跟在上方 json 块之后）：\n\`\`\`analysis\n{"direction":"up|down|flat","confidence":0.0,"key_support":0.00,"key_resistance":0.00}\n\`\`\``
        const aiResult = await callAIProvider({ provider: data.provider as AIProvider, model, apiKey, baseUrl: pc.baseUrl ?? undefined, maxTokens: pc.maxTokens ?? undefined, messages: [{ role: 'user', content: prompt }] })
        const { points, aiReason, direction, confidence, keySupport, keyResistance } = parseForecastResponse(aiResult.text)
        if (points.length === 0) {
          return { stockCode: data.stockCode, points: [], aiReason, message: 'AI未返回有效预测数据' }
        }
        const forecastId = insertForecast(db, { stockCode: data.stockCode, type: 'today', points: JSON.stringify(points), aiReason: aiReason || null, provider: data.provider, model, direction: direction ?? null, confidence: confidence ?? null, keySupport: keySupport ?? null, keyResistance: keyResistance ?? null, inputSnapshot: buildForecastInputSnapshot({ stockCode: data.stockCode, type: 'today', provider: data.provider, model, dataLabel: intradayLabel, dataPointCount, contextText: extraContext, promptText: prompt, forecastPointCount: points.length }) })
        emitAIForecastDecisionSignal({ stockCode: data.stockCode, forecastType: 'today', forecastId, provider: data.provider, model, direction, confidence, keySupport, keyResistance })
        const maxKeep = aiConfig.maxForecastsPerStock ?? 50
        trimForecasts(db, data.stockCode, maxKeep)
        const nowIso = new Date().toISOString()
        const cacheKey = `${data.stockCode}:${data.provider}`
        multiProviderCacheMap.set(cacheKey, { today: points, aiReason, todayCreatedAt: nowIso, model })
        const prev = forecastCacheMap.get(data.stockCode) ?? {}
        forecastCacheMap.set(data.stockCode, { ...prev, today: points, aiReason, todayCreatedAt: nowIso })
        return { stockCode: data.stockCode, points, aiReason, forecastId, provider: data.provider, model }
      } catch (err) {
        return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : '预测失败' } }
      }
    }

    // Determine which providers to call
    const multiModelProviders: string[] = requestedProviders.length > 0
      ? requestedProviders
      : (aiConfig.multiModelProviders ? JSON.parse(aiConfig.multiModelProviders) : [])

    // If providers are explicitly specified (FR-094) or multi-model is enabled, run in parallel.
    if (requestedProviders.length > 0 || multiModelProviders.length > 1) {
      try {
        // FR-163a: 优先从 DB 读取今日 OHLCV 分钟 K 线；无数据时 fallback 东财 price-only
        const bjToday = getBjTodayYmd()
        const minuteRowsMulti = getStockMinuteByDate(db, data.stockCode, bjToday)
        let intradayLabelMulti: string
        let intradayJsonMulti: string
        let dataPointCountMulti = 0
        if (minuteRowsMulti.length > 0) {
          intradayLabelMulti = '今日1分钟K线（t=时间,o=开,h=高,l=低,c=收,v=成交量手）'
          dataPointCountMulti = minuteRowsMulti.length
          intradayJsonMulti = JSON.stringify(minuteRowsMulti.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))
        } else {
          const stockItems = await fetchIntradayData(data.stockCode)
          if (stockItems.length === 0) {
            return { error: { code: 'INTRADAY_EMPTY', message: '当日暂无分时数据，无法预测' } }
          }
          intradayLabelMulti = '实际分时数据（至今）'
          dataPointCountMulti = stockItems.length
          intradayJsonMulti = JSON.stringify(stockItems.map(i => ({ time: i.time, price: i.price })))
        }
        const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
        const timeStr = `${bjNow.getUTCHours().toString().padStart(2, '0')}:${bjNow.getUTCMinutes().toString().padStart(2, '0')}`
        const boardSuffix = await buildBoardMarketSuffix(data.stockCode)
        // FR-163b-e: 构建数据增强摘要（多 provider 路径共享同一份上下文）
        const tsCodeMulti = toTsCodeWithSuffix(data.stockCode)
        const techSummaryMulti = buildTechnicalSummary(db, tsCodeMulti)
        const limitSummaryMulti = buildLimitConceptSummary(db, data.stockCode)
        const sectorSummaryMulti = buildSectorFlowSummary(db, data.stockCode)
        const smcSummaryMulti = buildSMCSummary(db, data.stockCode)
        const extraContextMulti = [techSummaryMulti, limitSummaryMulti, sectorSummaryMulti, smcSummaryMulti].filter(Boolean).join('\n\n')
        const intradayJson = intradayJsonMulti

        // Build per-provider tasks
        const tasks = multiModelProviders.map(p => {
          const pc = getProviderConfig(db, p)
          if (!pc?.apiKeyEncrypted) return null
          const apiKey = decryptApiKey(pc.apiKeyEncrypted)
          if (!apiKey) return null
          const model = pc.model || (PROVIDER_MODELS as Record<string, string[]>)[p]?.[0] || ''
          if (!model) return null
          const forecastPrompt = injectTimePrefix(pc.trendForecastPrompt || aiConfig.trendForecastPrompt || DEFAULT_TREND_TODAY_PROMPT) + buildSkillsBlock(db, true)
          const prompt = `${forecastPrompt}\n\n股票代码：${data.stockCode}\n当前北京时间：${timeStr}\n\n${intradayLabelMulti}：${intradayJson}${boardSuffix}${extraContextMulti ? '\n\n' + extraContextMulti : ''}\n\n请在响应末尾输出如下格式的预测数据（从${timeStr}到15:00，每5分钟一条，**跳过11:30至13:00的午休时段**，仅输出上午09:30-11:25和下午13:00-15:00区间的时间点）：\n\`\`\`json\n[{"time":"HH:mm","price":0.00}]\n\`\`\`\n\n并另外输出结构化分析（紧跟在上方 json 块之后）：\n\`\`\`analysis\n{"direction":"up|down|flat","confidence":0.0,"key_support":0.00,"key_resistance":0.00}\n\`\`\``
          return { provider: p, model, apiKey, baseUrl: pc.baseUrl ?? undefined, maxTokens: pc.maxTokens ?? undefined, prompt }
        }).filter(Boolean) as { provider: string; model: string; apiKey: string; baseUrl?: string; maxTokens?: number | null; prompt: string }[]

        if (tasks.length === 0) {
          return { error: { code: 'AI_NOT_CONFIGURED', message: '请先在AI配置页配置AI厂商' } }
        }

        const settled = await Promise.allSettled(
          tasks.map(async t => {
            const result = await callAIProvider({
              provider: t.provider as AIProvider,
              model: t.model,
              apiKey: t.apiKey,
              baseUrl: t.baseUrl,
              maxTokens: t.maxTokens,
              messages: [{ role: 'user', content: t.prompt }]
            })
            return { provider: t.provider, model: t.model, text: result.text }
          })
        )

        const results: { provider: string; model: string; points: { time: string; price: number }[]; aiReason: string; forecastId: number }[] = []
        const errors: { provider: string; error: string }[] = []
        const maxKeep = aiConfig.maxForecastsPerStock ?? 50
        const nowIso = new Date().toISOString()

        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i]
          const task = tasks[i]
          if (outcome.status === 'fulfilled') {
            const { points, aiReason, direction, confidence, keySupport, keyResistance } = parseForecastResponse(outcome.value.text)
            if (points.length === 0) {
              errors.push({ provider: task.provider, error: 'AI未返回有效预测数据' })
              continue
            }
            const forecastId = insertForecast(db, {
              stockCode: data.stockCode,
              type: 'today',
              points: JSON.stringify(points),
              aiReason: aiReason || null,
              provider: task.provider,
              model: task.model,
              direction: direction ?? null,
              confidence: confidence ?? null,
              keySupport: keySupport ?? null,
              keyResistance: keyResistance ?? null,
              inputSnapshot: buildForecastInputSnapshot({ stockCode: data.stockCode, type: 'today', provider: task.provider, model: task.model, dataLabel: intradayLabelMulti, dataPointCount: dataPointCountMulti, contextText: extraContextMulti, promptText: task.prompt, forecastPointCount: points.length }),
            })
            emitAIForecastDecisionSignal({ stockCode: data.stockCode, forecastType: 'today', forecastId, provider: task.provider, model: task.model, direction, confidence, keySupport, keyResistance })
            trimForecasts(db, data.stockCode, maxKeep)
            // Update multi-provider cache
            const cacheKey = `${data.stockCode}:${task.provider}`
            multiProviderCacheMap.set(cacheKey, { today: points, aiReason, todayCreatedAt: nowIso, model: task.model })
            results.push({ provider: task.provider, model: task.model, points, aiReason: aiReason || '', forecastId })
          } else {
            errors.push({ provider: task.provider, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) })
          }
        }

        // Also update legacy flat cache with first successful result for backward compat
        if (results.length > 0) {
          const first = results[0]
          const prev = forecastCacheMap.get(data.stockCode) ?? {}
          forecastCacheMap.set(data.stockCode, { ...prev, today: first.points, aiReason: first.aiReason, todayCreatedAt: nowIso })
        }

        return { stockCode: data.stockCode, results, errors }
      } catch (err) {
        return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : '预测失败' } }
      }
    }

    // Single-provider fallback path (original behavior)
    const creds = resolveProviderCredentials(db)
    if (!creds) {
      return { error: { code: 'AI_NOT_CONFIGURED', message: '请先在AI配置页配置AI厂商' } }
    }
    try {
      // FR-163a: 优先从 DB 读取今日 OHLCV 分钟 K 线；无数据时 fallback 东财 price-only
      const bjTodayFb = getBjTodayYmd()
      const minuteRowsFb = getStockMinuteByDate(db, data.stockCode, bjTodayFb)
      let intradayLabelFb: string
      let intradayJsonFb: string
      let dataPointCountFb = 0
      if (minuteRowsFb.length > 0) {
        intradayLabelFb = '今日1分钟K线（t=时间,o=开,h=高,l=低,c=收,v=成交量手）'
        dataPointCountFb = minuteRowsFb.length
        intradayJsonFb = JSON.stringify(minuteRowsFb.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))
      } else {
        const stockItems = await fetchIntradayData(data.stockCode)
        if (stockItems.length === 0) {
          return { error: { code: 'INTRADAY_EMPTY', message: '当日暂无分时数据，无法预测' } }
        }
        intradayLabelFb = '实际分时数据（至今）'
        dataPointCountFb = stockItems.length
        intradayJsonFb = JSON.stringify(stockItems.map(i => ({ time: i.time, price: i.price })))
      }
      const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const timeStr = `${bjNow.getUTCHours().toString().padStart(2, '0')}:${bjNow.getUTCMinutes().toString().padStart(2, '0')}`
      const forecastPrompt = injectTimePrefix(creds.trendForecastPrompt || aiConfig.trendForecastPrompt || DEFAULT_TREND_TODAY_PROMPT) + buildSkillsBlock(db, true)
      const boardSuffix = await buildBoardMarketSuffix(data.stockCode)
      // FR-163b-e: 构建数据增强摘要
      const tsCodeFb = toTsCodeWithSuffix(data.stockCode)
      const techSummaryFb = buildTechnicalSummary(db, tsCodeFb)
      const limitSummaryFb = buildLimitConceptSummary(db, data.stockCode)
      const sectorSummaryFb = buildSectorFlowSummary(db, data.stockCode)
      const smcSummaryFb = buildSMCSummary(db, data.stockCode)
      const extraContextFb = [techSummaryFb, limitSummaryFb, sectorSummaryFb, smcSummaryFb].filter(Boolean).join('\n\n')
      const prompt = `${forecastPrompt}\n\n股票代码：${data.stockCode}\n当前北京时间：${timeStr}\n\n${intradayLabelFb}：${intradayJsonFb}${boardSuffix}${extraContextFb ? '\n\n' + extraContextFb : ''}\n\n请在响应末尾输出如下格式的预测数据（从${timeStr}到15:00，每5分钟一条，**跳过11:30至13:00的午休时段**，仅输出上午09:30-11:25和下午13:00-15:00区间的时间点）：\n\`\`\`json\n[{"time":"HH:mm","price":0.00}]\n\`\`\`\n\n并另外输出结构化分析（紧跟在上方 json 块之后）：\n\`\`\`analysis\n{"direction":"up|down|flat","confidence":0.0,"key_support":0.00,"key_resistance":0.00}\n\`\`\``
      const aiResult = await callWithFallback(db, { messages: [{ role: 'user', content: prompt }] })
      const { points, aiReason, direction, confidence, keySupport, keyResistance } = parseForecastResponse(aiResult.text)
      if (points.length === 0) {
        return { stockCode: data.stockCode, points: [], aiReason, message: 'AI未返回有效预测数据' }
      }
      const forecastId = insertForecast(db, {
        stockCode: data.stockCode,
        type: 'today',
        points: JSON.stringify(points),
        aiReason: aiReason || null,
        provider: aiResult.provider,
        model: aiResult.model,
        direction: direction ?? null,
        confidence: confidence ?? null,
        keySupport: keySupport ?? null,
        keyResistance: keyResistance ?? null,
        inputSnapshot: buildForecastInputSnapshot({ stockCode: data.stockCode, type: 'today', provider: aiResult.provider, model: aiResult.model, dataLabel: intradayLabelFb, dataPointCount: dataPointCountFb, contextText: extraContextFb, promptText: prompt, forecastPointCount: points.length }),
      })
      emitAIForecastDecisionSignal({ stockCode: data.stockCode, forecastType: 'today', forecastId, provider: aiResult.provider, model: aiResult.model, direction, confidence, keySupport, keyResistance })
      const maxKeep = aiConfig.maxForecastsPerStock ?? 50
      trimForecasts(db, data.stockCode, maxKeep)
      const nowIso = new Date().toISOString()
      const prev = forecastCacheMap.get(data.stockCode) ?? {}
      forecastCacheMap.set(data.stockCode, { ...prev, today: points, aiReason, todayCreatedAt: nowIso })
      // Also write to multiProviderCacheMap so getPredictionCache returns provider data
      const singleCacheKey = `${data.stockCode}:${aiResult.provider}`
      multiProviderCacheMap.set(singleCacheKey, { today: points, aiReason, todayCreatedAt: nowIso, model: aiResult.model })
      return { stockCode: data.stockCode, points, aiReason, forecastId, provider: aiResult.provider, model: aiResult.model }
    } catch (err) {
      return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : '预测失败' } }
    }
  })

  // ── ai:predictTrendMorrow ─────────────────────────────────────────────────
  // FR-072: 预测明日走势（含近30日日线数据 + 当日完整分时 + 板块/大盘）
  // FR-080: auto-fallback across providers
  // FR-081: multi-model parallel prediction via Promise.allSettled
  ipcMain.handle('ai:predictTrendMorrow', async (_e, data: { stockCode: string; providers?: string[] }) => {
    const db = getDb()
    const aiConfig = getAIConfig(db)
    const requestedProviders = Array.isArray(data.providers)
      ? [...new Set(data.providers.map((p) => String(p).trim()).filter(Boolean))]
      : []

    // Determine which providers to call
    const multiModelProviders: string[] = requestedProviders.length > 0
      ? requestedProviders
      : (aiConfig.multiModelProviders ? JSON.parse(aiConfig.multiModelProviders) : [])

    // If providers are explicitly specified (FR-094) or multi-model is enabled, run in parallel.
    if (requestedProviders.length > 0 || multiModelProviders.length > 1) {
      try {
        const allPrices = getCachedPrices(db, data.stockCode)
        const recent30 = allPrices.slice(-30)
        const dailyCsv = recent30.map(r =>
          `${r.tradeDate},${r.open ?? ''},${r.high ?? ''},${r.low ?? ''},${r.close ?? ''},${r.volume ?? ''}`
        ).join('\n')
        // FR-163a: 优先从 DB 读取最新交易日 OHLCV 分钟 K 线
        const { getLatestTradeDateForStock } = await import('../database/stockMinuteCacheRepository')
        const latestMDateM = getLatestTradeDateForStock(db, data.stockCode)
        const morrowMinuteRows = latestMDateM ? getStockMinuteByDate(db, data.stockCode, latestMDateM) : []
        let intradayPart: string
        if (morrowMinuteRows.length > 0) {
          intradayPart = `\n\n最新交易日(${latestMDateM})1分钟K线（t=时间,o=开,h=高,l=低,c=收,v=成交量手）：${JSON.stringify(morrowMinuteRows.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))}`
        } else {
          const stockItems = await fetchIntradayData(data.stockCode)
          intradayPart = stockItems.length > 0
            ? `\n\n今日分时数据：${JSON.stringify(stockItems.map(i => ({ time: i.time, price: i.price })))}`
            : ''
        }
        const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
        const timeStr = `${bjNow.getUTCHours().toString().padStart(2, '0')}:${bjNow.getUTCMinutes().toString().padStart(2, '0')}`
        const boardSuffix = await buildBoardMarketSuffix(data.stockCode)
        // FR-163b-e: 构建数据增强摘要
        const tsCodeMM = toTsCodeWithSuffix(data.stockCode)
        const techSummaryMM = buildTechnicalSummary(db, tsCodeMM)
        const limitSummaryMM = buildLimitConceptSummary(db, data.stockCode)
        const sectorSummaryMM = buildSectorFlowSummary(db, data.stockCode)
        const smcSummaryMM = buildSMCSummary(db, data.stockCode)
        const extraContextMM = [techSummaryMM, limitSummaryMM, sectorSummaryMM, smcSummaryMM].filter(Boolean).join('\n\n')

        const tasks = multiModelProviders.map(p => {
          const pc = getProviderConfig(db, p)
          if (!pc?.apiKeyEncrypted) return null
          const apiKey = decryptApiKey(pc.apiKeyEncrypted)
          if (!apiKey) return null
          const model = pc.model || (PROVIDER_MODELS as Record<string, string[]>)[p]?.[0] || ''
          if (!model) return null
          const morrowPrompt = injectTimePrefix(pc.trendForecastMorrowPrompt || aiConfig.trendForecastMorrowPrompt || DEFAULT_TREND_MORROW_PROMPT) + buildSkillsBlock(db, true)
          const prompt = `${morrowPrompt}\n\n股票代码：${data.stockCode}\n当前北京时间：${timeStr}\n\n近30日日线数据（日期,开,高,低,收,量）：\n${dailyCsv}${intradayPart}${boardSuffix}${extraContextMM ? '\n\n' + extraContextMM : ''}\n\n请在响应末尾输出明日09:30至15:00的预测分时数据（每5分钟一条，**跳过11:30至13:00的午休时段**，仅输出上午09:30-11:25和下午13:00-15:00区间的时间点）：\n\`\`\`json\n[{"time":"HH:mm","price":0.00}]\n\`\`\`\n\n并另外输出结构化分析（紧跟在上方 json 块之后）：\n\`\`\`analysis\n{"direction":"up|down|flat","confidence":0.0,"key_support":0.00,"key_resistance":0.00}\n\`\`\``
          return { provider: p, model, apiKey, baseUrl: pc.baseUrl ?? undefined, maxTokens: pc.maxTokens ?? undefined, prompt }
        }).filter(Boolean) as { provider: string; model: string; apiKey: string; baseUrl?: string; maxTokens?: number | null; prompt: string }[]

        if (tasks.length === 0) {
          return { error: { code: 'AI_NOT_CONFIGURED', message: '请先在AI配置页配置AI厂商' } }
        }

        const settled = await Promise.allSettled(
          tasks.map(async t => {
            const result = await callAIProvider({
              provider: t.provider as AIProvider,
              model: t.model,
              apiKey: t.apiKey,
              baseUrl: t.baseUrl,
              maxTokens: t.maxTokens,
              messages: [{ role: 'user', content: t.prompt }]
            })
            return { provider: t.provider, model: t.model, text: result.text }
          })
        )

        const results: { provider: string; model: string; points: { time: string; price: number }[]; aiReason: string; forecastId: number }[] = []
        const errors: { provider: string; error: string }[] = []
        const maxKeep = aiConfig.maxForecastsPerStock ?? 50

        for (let i = 0; i < settled.length; i++) {
          const outcome = settled[i]
          const task = tasks[i]
          if (outcome.status === 'fulfilled') {
            const { points, aiReason, direction, confidence, keySupport, keyResistance } = parseForecastResponse(outcome.value.text)
            if (points.length === 0) {
              errors.push({ provider: task.provider, error: 'AI未返回有效预测数据' })
              continue
            }
            const forecastId = insertForecast(db, {
              stockCode: data.stockCode,
              type: 'morrow',
              points: JSON.stringify(points),
              aiReason: aiReason || null,
              provider: task.provider,
              model: task.model,
              direction: direction ?? null,
              confidence: confidence ?? null,
              keySupport: keySupport ?? null,
              keyResistance: keyResistance ?? null,
              inputSnapshot: buildForecastInputSnapshot({ stockCode: data.stockCode, type: 'morrow', provider: task.provider, model: task.model, dataLabel: '近30日日线 + 最新分时', dataPointCount: morrowMinuteRows.length, dailyPointCount: recent30.length, contextText: extraContextMM, promptText: task.prompt, forecastPointCount: points.length }),
            })
            emitAIForecastDecisionSignal({ stockCode: data.stockCode, forecastType: 'morrow', forecastId, provider: task.provider, model: task.model, direction, confidence, keySupport, keyResistance })
            trimForecasts(db, data.stockCode, maxKeep)
            const cacheKey = `${data.stockCode}:${task.provider}`
            multiProviderCacheMap.set(cacheKey, { morrow: points, aiReason, model: task.model })
            results.push({ provider: task.provider, model: task.model, points, aiReason: aiReason || '', forecastId })
          } else {
            errors.push({ provider: task.provider, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) })
          }
        }

        if (results.length > 0) {
          const first = results[0]
          const prev = forecastCacheMap.get(data.stockCode) ?? {}
          forecastCacheMap.set(data.stockCode, { ...prev, morrow: first.points, aiReason: first.aiReason })
        }

        return { stockCode: data.stockCode, results, errors }
      } catch (err) {
        return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : '预测失败' } }
      }
    }

    // Single-provider fallback path (original behavior)
    const creds = resolveProviderCredentials(db)
    if (!creds) {
      return { error: { code: 'AI_NOT_CONFIGURED', message: '请先在AI配置页配置AI厂商' } }
    }
    try {
      const allPrices = getCachedPrices(db, data.stockCode)
      const recent30 = allPrices.slice(-30)
      const dailyCsv = recent30.map(r =>
        `${r.tradeDate},${r.open ?? ''},${r.high ?? ''},${r.low ?? ''},${r.close ?? ''},${r.volume ?? ''}`
      ).join('\n')
      // FR-163a: 优先从 DB 读取最新交易日 OHLCV 分钟 K 线
      const { getLatestTradeDateForStock: getLatestDate2 } = await import('../database/stockMinuteCacheRepository')
      const latestMDateFb = getLatestDate2(db, data.stockCode)
      const morrowMinuteRowsFb = latestMDateFb ? getStockMinuteByDate(db, data.stockCode, latestMDateFb) : []
      let intradayPart: string
      if (morrowMinuteRowsFb.length > 0) {
        intradayPart = `\n\n最新交易日(${latestMDateFb})1分钟K线（t=时间,o=开,h=高,l=低,c=收,v=成交量手）：${JSON.stringify(morrowMinuteRowsFb.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))}`
      } else {
        const stockItems = await fetchIntradayData(data.stockCode)
        intradayPart = stockItems.length > 0
          ? `\n\n今日分时数据：${JSON.stringify(stockItems.map(i => ({ time: i.time, price: i.price })))}`
          : ''
      }
      const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const timeStr = `${bjNow.getUTCHours().toString().padStart(2, '0')}:${bjNow.getUTCMinutes().toString().padStart(2, '0')}`
      const morrowPrompt = injectTimePrefix(creds.trendForecastMorrowPrompt || aiConfig.trendForecastMorrowPrompt || DEFAULT_TREND_MORROW_PROMPT) + buildSkillsBlock(db, true)
      const boardSuffix = await buildBoardMarketSuffix(data.stockCode)
      // FR-163b-e: 构建数据增强摘要
      const tsCodeMF = toTsCodeWithSuffix(data.stockCode)
      const techSummaryMF = buildTechnicalSummary(db, tsCodeMF)
      const limitSummaryMF = buildLimitConceptSummary(db, data.stockCode)
      const sectorSummaryMF = buildSectorFlowSummary(db, data.stockCode)
      const smcSummaryMF = buildSMCSummary(db, data.stockCode)
      const extraContextMF = [techSummaryMF, limitSummaryMF, sectorSummaryMF, smcSummaryMF].filter(Boolean).join('\n\n')
      const prompt = `${morrowPrompt}\n\n股票代码：${data.stockCode}\n当前北京时间：${timeStr}\n\n近30日日线数据（日期,开,高,低,收,量）：\n${dailyCsv}${intradayPart}${boardSuffix}${extraContextMF ? '\n\n' + extraContextMF : ''}\n\n请在响应末尾输出明日09:30至15:00的预测分时数据（每5分钟一条，**跳过11:30至13:00的午休时段**，仅输出上午09:30-11:25和下午13:00-15:00区间的时间点）：\n\`\`\`json\n[{"time":"HH:mm","price":0.00}]\n\`\`\`\n\n并另外输出结构化分析（紧跟在上方 json 块之后）：\n\`\`\`analysis\n{"direction":"up|down|flat","confidence":0.0,"key_support":0.00,"key_resistance":0.00}\n\`\`\``
      const aiResult = await callWithFallback(db, { messages: [{ role: 'user', content: prompt }] })
      const { points, aiReason, direction, confidence, keySupport, keyResistance } = parseForecastResponse(aiResult.text)
      if (points.length === 0) {
        return { stockCode: data.stockCode, points: [], aiReason, message: 'AI未返回有效预测数据' }
      }
      const forecastId = insertForecast(db, {
        stockCode: data.stockCode,
        type: 'morrow',
        points: JSON.stringify(points),
        aiReason: aiReason || null,
        provider: aiResult.provider,
        model: aiResult.model,
        direction: direction ?? null,
        confidence: confidence ?? null,
        keySupport: keySupport ?? null,
        keyResistance: keyResistance ?? null,
        inputSnapshot: buildForecastInputSnapshot({ stockCode: data.stockCode, type: 'morrow', provider: aiResult.provider, model: aiResult.model, dataLabel: '近30日日线 + 最新分时', dataPointCount: morrowMinuteRowsFb.length, dailyPointCount: recent30.length, contextText: extraContextMF, promptText: prompt, forecastPointCount: points.length }),
      })
      emitAIForecastDecisionSignal({ stockCode: data.stockCode, forecastType: 'morrow', forecastId, provider: aiResult.provider, model: aiResult.model, direction, confidence, keySupport, keyResistance })
      const maxKeep = aiConfig.maxForecastsPerStock ?? 50
      trimForecasts(db, data.stockCode, maxKeep)
      const prev = forecastCacheMap.get(data.stockCode) ?? {}
      forecastCacheMap.set(data.stockCode, { ...prev, morrow: points, aiReason })
      // Also write to multiProviderCacheMap so getPredictionCache returns provider data
      const singleMorrowKey = `${data.stockCode}:${aiResult.provider}`
      const prevProviderCache = multiProviderCacheMap.get(singleMorrowKey) ?? {}
      multiProviderCacheMap.set(singleMorrowKey, { ...prevProviderCache, morrow: points, aiReason, model: aiResult.model })
      return { stockCode: data.stockCode, points, aiReason, forecastId, provider: aiResult.provider, model: aiResult.model }
    } catch (err) {
      return { error: { code: 'FETCH_FAILED', message: err instanceof Error ? err.message : '预测失败' } }
    }
  })

  // ── ai:clearForecast ──────────────────────────────────────────────────────
  // FR-072: 仅清除内存中的预测叠加线（不删除DB记录）
  // FR-081: also clear multi-provider cache entries
  ipcMain.handle('ai:clearForecast', (_e, data: { stockCode: string }) => {
    forecastCacheMap.delete(data.stockCode)
    // Clear all multi-provider entries for this stock
    for (const key of multiProviderCacheMap.keys()) {
      if (key.startsWith(`${data.stockCode}:`)) {
        multiProviderCacheMap.delete(key)
      }
    }
    return { ok: true }
  })

  // ── ai:getPredictionCache ─────────────────────────────────────────────────
  // FR-077: 从 DB 读取该股票最新 today + morrow 预测（重启后仍可恢复叠加线）
  // FR-078: 响应新增 todayCreatedAt 供前端判断是否已有当日预测
  // FR-081: 响应新增 providers 对象，包含各厂商独立的预测数据
  ipcMain.handle('ai:getPredictionCache', (_e, data: { stockCode: string }) => {
    // Build providers map from multi-provider cache
    const providers: Record<string, StockForecastCache> = {}
    for (const [key, val] of multiProviderCacheMap.entries()) {
      if (key.startsWith(`${data.stockCode}:`)) {
        const provider = key.slice(data.stockCode.length + 1)
        providers[provider] = val
      }
    }

    // Legacy flat cache (backward compat)
    const cached = forecastCacheMap.get(data.stockCode)
    if (cached && (cached.today || cached.morrow)) {
      return { ...cached, providers }
    }

    // Fall back to DB
    const db = getDb()
    const latest = getLatestForecasts(db, data.stockCode)
    const result: Record<string, unknown> = { providers }
    if (latest.today) {
      try { result.today = JSON.parse(latest.today.points) } catch { /* ignore */ }
      if (latest.today.aiReason) result.aiReason = latest.today.aiReason
      const todayCreatedAt = new Date(latest.today.createdAt).toISOString()
      result.todayCreatedAt = todayCreatedAt
      // Also populate providers from DB if not already in memory
      if (latest.today.provider && !providers[latest.today.provider]) {
        providers[latest.today.provider] = {
          today: result.today as { time: string; price: number }[],
          aiReason: latest.today.aiReason ?? undefined,
          todayCreatedAt,
          model: latest.today.model ?? undefined
        }
      }
    }
    if (latest.morrow) {
      try { result.morrow = JSON.parse(latest.morrow.points) } catch { /* ignore */ }
      if (latest.morrow.aiReason && !result.aiReason) result.aiReason = latest.morrow.aiReason
      if (latest.morrow.provider && !providers[latest.morrow.provider]) {
        providers[latest.morrow.provider] = {
          ...providers[latest.morrow.provider],
          morrow: result.morrow as { time: string; price: number }[],
          aiReason: latest.morrow.aiReason ?? undefined,
          model: latest.morrow.model ?? undefined
        }
      }
    }
    return result
  })

  // ── ai:listForecasts ──────────────────────────────────────────────────────
  // FR-077: 列出某只股票的所有预测记录（供预测面板下拉选择）
  ipcMain.handle('ai:listForecasts', (_e, data: { stockCode: string }) => {
    const db = getDb()
    const aiConfig = getAIConfig(db)
    const maxKeep = aiConfig.maxForecastsPerStock ?? 50
    return listForecasts(db, data.stockCode, maxKeep)
  })

  // ── ai:getForecast ────────────────────────────────────────────────────────
  // FR-077: 获取单条预测记录详情（含 points JSON）
  ipcMain.handle('ai:getForecast', (_e, data: { id: number }) => {
    const db = getDb()
    const row = getForecast(db, data.id)
    if (!row) return { error: { code: 'NOT_FOUND', message: '预测记录不存在' } }
    return { ...row, points: JSON.parse(row.points) }
  })

  // ── ai:reviseTrendForecast ───────────────────────────────────────────────
  // FR-174: 基于用户反馈再次预测，生成新记录且保留来源预测链路
  ipcMain.handle('ai:reviseTrendForecast', async (_e, data: { forecastId: number; stockCode: string; userFeedback: string; providers?: string[] }) => {
    const db = getDb()
    const forecastId = Number(data.forecastId)
    const stockCode = String(data.stockCode ?? '').trim()
    const userFeedback = String(data.userFeedback ?? '').trim()
    if (!Number.isFinite(forecastId) || forecastId <= 0 || !stockCode || !userFeedback) {
      return { ok: false, code: 'INVALID_PARAM', message: '预测记录、股票代码和补充信息不能为空' }
    }

    const source = getForecast(db, forecastId)
    if (!source) return { ok: false, code: 'NOT_FOUND', message: '预测记录不存在' }
    if (source.stockCode !== stockCode) {
      return { ok: false, code: 'INVALID_PARAM', message: '股票代码与来源预测记录不一致' }
    }
    const sourceForecast = source

    const aiConfig = getAIConfig(db)
    const requestedProviders = Array.isArray(data.providers)
      ? [...new Set(data.providers.map((p) => String(p).trim()).filter(Boolean))]
      : []
    const configuredMulti = aiConfig.multiModelProviders ? JSON.parse(aiConfig.multiModelProviders) as string[] : []
    const providerNames = requestedProviders.length > 0
      ? requestedProviders
      : source.provider
        ? [source.provider]
        : configuredMulti

    let sourcePoints: unknown[] = []
    try {
      sourcePoints = JSON.parse(source.points) as unknown[]
    } catch {
      sourcePoints = []
    }

    async function buildRevisionPrompt(basePrompt: string): Promise<string> {
      const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const timeStr = `${bjNow.getUTCHours().toString().padStart(2, '0')}:${bjNow.getUTCMinutes().toString().padStart(2, '0')}`
      const boardSuffix = await buildBoardMarketSuffix(stockCode)
      const tsCode = toTsCodeWithSuffix(stockCode)
      const extraContext = [
        buildTechnicalSummary(db, tsCode),
        buildLimitConceptSummary(db, stockCode),
        buildSectorFlowSummary(db, stockCode),
        buildSMCSummary(db, stockCode),
      ].filter(Boolean).join('\n\n')

      let marketDataPart = ''
      if (sourceForecast.type === 'today') {
        const bjToday = getBjTodayYmd()
        const minuteRows = getStockMinuteByDate(db, stockCode, bjToday)
        if (minuteRows.length > 0) {
          marketDataPart = `今日1分钟K线（t=时间,o=开,h=高,l=低,c=收,v=成交量手）：${JSON.stringify(minuteRows.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))}`
        } else {
          const items = await fetchIntradayData(stockCode)
          marketDataPart = `实际分时数据（至今）：${JSON.stringify(items.map(i => ({ time: i.time, price: i.price })))}`
        }
      } else {
        const allPrices = getCachedPrices(db, stockCode)
        const recent30 = allPrices.slice(-30)
        const dailyCsv = recent30.map(r => `${r.tradeDate},${r.open ?? ''},${r.high ?? ''},${r.low ?? ''},${r.close ?? ''},${r.volume ?? ''}`).join('\n')
        const { getLatestTradeDateForStock } = await import('../database/stockMinuteCacheRepository')
        const latestMinuteDate = getLatestTradeDateForStock(db, stockCode)
        const minuteRows = latestMinuteDate ? getStockMinuteByDate(db, stockCode, latestMinuteDate) : []
        const minutePart = minuteRows.length > 0
          ? `\n\n最新交易日(${latestMinuteDate})1分钟K线：${JSON.stringify(minuteRows.map(r => ({ t: r.tsMinute, o: r.open, h: r.high, l: r.low, c: r.close, v: r.vol })))}`
          : ''
        marketDataPart = `近30日日线数据（日期,开,高,低,收,量）：\n${dailyCsv}${minutePart}`
      }

      const timeRange = sourceForecast.type === 'today'
        ? `从${timeStr}到15:00，每5分钟一条，跳过11:30至13:00午休时段`
        : '明日09:30至15:00，每5分钟一条，跳过11:30至13:00午休时段'

      return `${basePrompt}\n\n股票代码：${stockCode}\n当前北京时间：${timeStr}\n\n来源预测记录：\n- 类型：${sourceForecast.type}\n- 厂商：${sourceForecast.provider ?? 'unknown'}\n- 模型：${sourceForecast.model ?? 'unknown'}\n- 原预测点：${JSON.stringify(sourcePoints)}\n- 原AI理由：${sourceForecast.aiReason ?? '无'}\n\n用户补充信息：${userFeedback}\n\n${marketDataPart}${boardSuffix}${extraContext ? '\n\n' + extraContext : ''}\n\n请基于用户补充信息重新评估，不要简单复述原预测。请在响应末尾输出如下格式的预测数据（${timeRange}）：\n\`\`\`json\n[{"time":"HH:mm","price":0.00}]\n\`\`\`\n\n并另外输出结构化分析（紧跟在上方 json 块之后）：\n\`\`\`analysis\n{"direction":"up|down|flat","confidence":0.0,"key_support":0.00,"key_resistance":0.00}\n\`\`\``
    }

    try {
      const tasks = providerNames.map(p => {
        const pc = getProviderConfig(db, p)
        if (!pc?.apiKeyEncrypted) return null
        const apiKey = decryptApiKey(pc.apiKeyEncrypted)
        if (!apiKey) return null
        const model = pc.model || (PROVIDER_MODELS as Record<string, string[]>)[p]?.[0] || ''
        if (!model) return null
        const basePrompt = injectTimePrefix(
          sourceForecast.type === 'today'
            ? (pc.trendForecastPrompt || aiConfig.trendForecastPrompt || DEFAULT_TREND_TODAY_PROMPT)
            : (pc.trendForecastMorrowPrompt || aiConfig.trendForecastMorrowPrompt || DEFAULT_TREND_MORROW_PROMPT)
        ) + buildSkillsBlock(db, true)
        return { provider: p, model, apiKey, baseUrl: pc.baseUrl ?? undefined, maxTokens: pc.maxTokens ?? undefined, basePrompt }
      }).filter(Boolean) as { provider: string; model: string; apiKey: string; baseUrl?: string; maxTokens?: number | null; basePrompt: string }[]

      if (tasks.length === 0) {
        const creds = resolveProviderCredentials(db)
        if (!creds) return { ok: false, code: 'AI_CONFIG_MISSING', message: '请先在AI配置页配置AI厂商' }
        const basePrompt = injectTimePrefix(sourceForecast.type === 'today'
          ? (creds.trendForecastPrompt || aiConfig.trendForecastPrompt || DEFAULT_TREND_TODAY_PROMPT)
          : (creds.trendForecastMorrowPrompt || aiConfig.trendForecastMorrowPrompt || DEFAULT_TREND_MORROW_PROMPT)
        ) + buildSkillsBlock(db, true)
        const prompt = await buildRevisionPrompt(basePrompt)
        const aiResult = await callWithFallback(db, { messages: [{ role: 'user', content: prompt }] })
        const { points, aiReason, direction, confidence, keySupport, keyResistance } = parseForecastResponse(aiResult.text)
        if (points.length === 0) return { ok: false, code: 'AI_RESPONSE_INVALID', message: 'AI未返回有效预测数据' }
        const newId = insertForecast(db, {
          stockCode,
          type: sourceForecast.type,
          points: JSON.stringify(points),
          aiReason: aiReason || null,
          provider: aiResult.provider,
          model: aiResult.model,
          direction: direction ?? null,
          confidence: confidence ?? null,
          keySupport: keySupport ?? null,
          keyResistance: keyResistance ?? null,
          targetDate: sourceForecast.targetDate,
          parentForecastId: sourceForecast.id,
          userFeedback,
          inputSnapshot: buildForecastInputSnapshot({ stockCode, type: sourceForecast.type, targetDate: sourceForecast.targetDate, provider: aiResult.provider, model: aiResult.model, dataLabel: '再次预测上下文', contextText: userFeedback, promptText: prompt, userFeedback, parentForecastId: sourceForecast.id, forecastPointCount: points.length }),
        })
        trimForecasts(db, stockCode, aiConfig.maxForecastsPerStock ?? 50)
        const saved = getForecast(db, newId)
        return { ok: true, forecasts: saved ? [{ ...saved, points }] : [] }
      }

      const settled = await Promise.allSettled(tasks.map(async task => {
        const prompt = await buildRevisionPrompt(task.basePrompt)
        const result = await callAIProvider({
          provider: task.provider as AIProvider,
          model: task.model,
          apiKey: task.apiKey,
          baseUrl: task.baseUrl,
          maxTokens: task.maxTokens,
          messages: [{ role: 'user', content: prompt }],
        })
        return { ...task, text: result.text }
      }))

      const forecasts: unknown[] = []
      const errors: { provider: string; error: string }[] = []
      for (let i = 0; i < settled.length; i++) {
        const outcome = settled[i]
        const task = tasks[i]
        if (outcome.status === 'rejected') {
          errors.push({ provider: task.provider, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) })
          continue
        }
        const { points, aiReason, direction, confidence, keySupport, keyResistance } = parseForecastResponse(outcome.value.text)
        if (points.length === 0) {
          errors.push({ provider: task.provider, error: 'AI未返回有效预测数据' })
          continue
        }
        const newId = insertForecast(db, {
          stockCode,
          type: sourceForecast.type,
          points: JSON.stringify(points),
          aiReason: aiReason || null,
          provider: task.provider,
          model: task.model,
          direction: direction ?? null,
          confidence: confidence ?? null,
          keySupport: keySupport ?? null,
          keyResistance: keyResistance ?? null,
          targetDate: sourceForecast.targetDate,
          parentForecastId: sourceForecast.id,
          userFeedback,
          inputSnapshot: buildForecastInputSnapshot({ stockCode, type: sourceForecast.type, targetDate: sourceForecast.targetDate, provider: task.provider, model: task.model, dataLabel: '再次预测上下文', contextText: userFeedback, userFeedback, parentForecastId: sourceForecast.id, forecastPointCount: points.length }),
        })
        const saved = getForecast(db, newId)
        if (saved) forecasts.push({ ...saved, points })
      }
      trimForecasts(db, stockCode, aiConfig.maxForecastsPerStock ?? 50)
      if (forecasts.length === 0) {
        return { ok: false, code: 'UPSTREAM_ERROR', message: errors.map(e => `${e.provider}: ${e.error}`).join('; ') || '再次预测失败' }
      }
      return { ok: true, forecasts, errors }
    } catch (err) {
      return { ok: false, code: 'UPSTREAM_ERROR', message: err instanceof Error ? err.message : '再次预测失败' }
    }
  })

  // ── ai:deleteForecast ─────────────────────────────────────────────────────
  // FR-077: 删除单条预测记录
  ipcMain.handle('ai:deleteForecast', (_e, data: { id: number }) => {
    const db = getDb()
    deleteForecast(db, data.id)
    return { ok: true }
  })

  // ── ai:deleteAllForecasts ─────────────────────────────────────────────────
  // FR-077: 删除某只股票的全部预测记录
  ipcMain.handle('ai:deleteAllForecasts', (_e, data: { stockCode: string }) => {
    const db = getDb()
    deleteForecasts(db, data.stockCode)
    forecastCacheMap.delete(data.stockCode)
    // FR-081: clear multi-provider cache
    for (const key of multiProviderCacheMap.keys()) {
      if (key.startsWith(`${data.stockCode}:`)) {
        multiProviderCacheMap.delete(key)
      }
    }
    return { ok: true }
  })
}
