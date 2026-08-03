/**
 * FR-171: 产业链传导分析服务
 *
 * 核心函数 analyzeText(db, text) 执行5步骤：
 *   1. 本地关键词匹配
 *   2. LLM 兜底（可选，需设置 supply_chain_llm_fallback=1）
 *   3. 图谱 BFS 展开（上游2层/下游3层）
 *   4. 成员股标的填充
 *   5. 结果组装返回
 */

import type Database from 'better-sqlite3'
import type { SupplyChainEdgeRow } from '../database/types'
import { getEnabledEdges } from '../database/supplyChainRepository'
import { getMembersByConceptRouted, type ConceptSource } from './conceptRouter'
import { getRtKCache } from './sharedRtKCache'
import { getStockInfo } from '../database/stockPriceCacheRepository'
import { getAIConfig, getProviderConfig } from '../database/aiConfigRepository'
import { decryptApiKey } from '../utils/apiKeyEncryption'
import { callAIProvider, PROVIDER_MODELS } from './aiProvider'
import type { AIProvider } from '../database/types'
import {
  DEFAULT_SUPPLY_CHAIN_ALIASES,
  type SupplyChainDirection,
  type SupplyChainEventType,
} from '../database/defaultSupplyChainAliases'
import { DEFAULT_SUPPLY_CHAIN_STOCKS } from '../database/defaultSupplyChainStocks'

// ──── 公开接口类型 ──────────────────────────────────────────────────────────

export interface MemberStock {
  stockCode: string
  stockName: string
  hotNum: number | null
  /** 今日涨跌幅（来自 sharedRtKCache，无数据时为 null） */
  todayChange: number | null
}

export interface SupplyChainNode {
  concept: string
  chainGroup: string
  /** 0=命中节点，负=上游（-1=上游1层），正=下游（+1=下游1层） */
  distance: number
  isHit: boolean
  stocks: MemberStock[]
}

export interface SupplyChainAnalysisResult {
  /** 命中的概念名列表（步骤1/2的输出） */
  hitConcepts: string[]
  /** 最相关的产业链组名 */
  chainGroup: string
  /** BFS 展开的子图节点 */
  nodes: SupplyChainNode[]
  /** 参与子图的边集合 */
  edges: SupplyChainEdgeRow[]
  /** 匹配方式 */
  matchedBy: 'local' | 'alias' | 'llm' | 'mixed' | 'none'
  /** FR-173: 资讯产业归因摘要 */
  attribution?: SupplyChainAttribution
  /** FR-173: 龙头候选股票 */
  recommendedStocks?: SupplyChainRecommendedStock[]
}

export interface SupplyChainAttribution {
  chainGroups: Array<{
    chainGroup: string
    confidence: number
    direction: SupplyChainDirection
    reason: string
  }>
  affectedNodes: Array<{
    concept: string
    chainGroup: string
    role: 'direct' | 'upstream' | 'downstream' | 'related'
    confidence: number
    reason: string
  }>
  eventType: SupplyChainEventType
  matchedBy: 'local' | 'alias' | 'llm' | 'mixed' | 'none'
}

export interface SupplyChainRecommendedStock {
  tsCode: string
  stockName: string
  chainGroup: string
  concepts: string[]
  rankScore: number
  leaderScore: number | null
  relevanceScore: number
  signalBoost: number
  todayChange: number | null
  amount: number | null
  reasons: string[]
  source: Array<'default' | 'kpl' | 'ths' | 'dc' | 'watchlist' | 'trend' | 'portfolio' | 'decision'>
}

// ──── 模块级内存缓存（30s TTL） ────────────────────────────────────────────

interface CacheEntry {
  result: SupplyChainAnalysisResult
  cachedAt: number
}
const _cache = new Map<string, CacheEntry>()
const CACHE_TTL = 30_000
const ATTRIBUTION_VERSION = 'fr173-v1'

function getCacheKey(text: string, llmEnabled: boolean): string {
  return `${ATTRIBUTION_VERSION}:${llmEnabled ? 1 : 0}:${text.slice(0, 200)}`
}

function clearExpiredCache(): void {
  const now = Date.now()
  for (const [k, v] of _cache) {
    if (now - v.cachedAt > CACHE_TTL) _cache.delete(k)
  }
}

// ──── 内部辅助 ──────────────────────────────────────────────────────────────

/**
 * 步骤1：本地关键词匹配
 * 提取 edges 中所有概念名，查找哪些出现在 text 中
 */
function localMatch(text: string, edges: SupplyChainEdgeRow[]): string[] {
  const allConcepts = new Set<string>()
  for (const e of edges) {
    allConcepts.add(e.upstreamConcept)
    allConcepts.add(e.downstreamConcept)
  }
  const hits: string[] = []
  for (const c of allConcepts) {
    if (text.includes(c)) hits.push(c)
  }
  return hits
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function buildConceptIndexes(edges: SupplyChainEdgeRow[]): {
  allConcepts: Set<string>
  conceptToGroup: Map<string, string>
  groupToConcepts: Map<string, string[]>
} {
  const allConcepts = new Set<string>()
  const conceptToGroup = new Map<string, string>()
  const groupToConcepts = new Map<string, string[]>()

  for (const e of edges) {
    for (const concept of [e.upstreamConcept, e.downstreamConcept]) {
      allConcepts.add(concept)
      if (!conceptToGroup.has(concept)) conceptToGroup.set(concept, e.chainGroup)
      const arr = groupToConcepts.get(e.chainGroup) ?? []
      if (!arr.includes(concept)) arr.push(concept)
      groupToConcepts.set(e.chainGroup, arr)
    }
  }

  return { allConcepts, conceptToGroup, groupToConcepts }
}

function inferMatchedBy(sources: Set<'local' | 'alias' | 'llm'>): SupplyChainAnalysisResult['matchedBy'] {
  if (sources.size === 0) return 'none'
  if (sources.size > 1) return 'mixed'
  return [...sources][0]
}

function coreConceptsForGroup(chainGroup: string, groupToConcepts: Map<string, string[]>): string[] {
  const alias = DEFAULT_SUPPLY_CHAIN_ALIASES.find(r => r.chainGroup === chainGroup)
  const concepts = groupToConcepts.get(chainGroup) ?? []
  if (!alias) return concepts.slice(0, 3)
  return alias.concepts.filter(c => concepts.includes(c)).slice(0, 5)
}

interface LlmAttributionPick {
  chainGroups?: Array<{ chainGroup?: string; confidence?: number; direction?: SupplyChainDirection; reason?: string }>
  affectedNodes?: Array<{ concept?: string; role?: 'direct' | 'upstream' | 'downstream' | 'related'; confidence?: number; reason?: string }>
  eventType?: SupplyChainEventType
}

function parseJsonObject(text: string): LlmAttributionPick | null {
  const raw = text.trim()
  const jsonText = raw.startsWith('{') ? raw : raw.match(/\{[\s\S]*\}/)?.[0]
  if (!jsonText) return null
  try {
    return JSON.parse(jsonText) as LlmAttributionPick
  } catch {
    return null
  }
}

function getProviderPriority(db: Database.Database): string[] {
  const aiConfig = getAIConfig(db)
  try {
    const parsed = aiConfig.providerPriority ? JSON.parse(aiConfig.providerPriority) : null
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string')
  } catch {
    // Ignore invalid legacy config and fall back to single provider below.
  }
  return aiConfig.provider ? [aiConfig.provider] : []
}

/**
 * FR-173：LLM 兜底只做候选内归因，禁止自由生成不可落地概念。
 */
async function llmConstrainedAttribution(
  db: Database.Database,
  text: string,
  edges: SupplyChainEdgeRow[],
): Promise<LlmAttributionPick | null> {
  const { groupToConcepts } = buildConceptIndexes(edges)
  const candidateText = [...groupToConcepts.entries()]
    .map(([group, concepts]) => `${group}: ${concepts.join('、')}`)
    .join('\n')

  const priority = getProviderPriority(db)

  for (const p of priority) {
    const pc = getProviderConfig(db, p)
    if (!pc?.apiKeyEncrypted) continue
    const apiKey = decryptApiKey(pc.apiKeyEncrypted)
    if (!apiKey) continue
    const model = pc.model || (PROVIDER_MODELS as Record<string, string[]>)[p]?.[0] || ''
    if (!model) continue
    try {
      const prompt = `你是A股产业链归因助手。请只从给定候选产业链组和候选节点中选择，不要创造候选外概念或股票。\n\n候选产业链与节点：\n${candidateText}\n\n待分析文本：\n${text.slice(0, 800)}\n\n请返回严格JSON，格式如下：\n{\n  "chainGroups": [{"chainGroup":"候选产业链组名", "confidence": 0-100, "direction":"positive|negative|neutral|mixed", "reason":"中文理由"}],\n  "affectedNodes": [{"concept":"候选节点名", "role":"direct|upstream|downstream|related", "confidence": 0-100, "reason":"中文理由"}],\n  "eventType":"policy|price|supply_demand|order|tech|export_control|earnings|market|other"\n}\n只返回JSON。`
      const res = await callAIProvider({ provider: p as AIProvider, model, apiKey, baseUrl: pc.baseUrl ?? undefined, prompt })
      return parseJsonObject(res.text)
    } catch (err) {
      console.warn('[supplyChainService] LLM fallback failed:', err)
    }
  }
  return null
}

async function resolveChainAttribution(
  db: Database.Database,
  text: string,
  edges: SupplyChainEdgeRow[],
  llmEnabled: boolean,
): Promise<{ hitConcepts: string[]; matchedBy: SupplyChainAnalysisResult['matchedBy']; attribution: SupplyChainAttribution }> {
  const { allConcepts, conceptToGroup, groupToConcepts } = buildConceptIndexes(edges)
  const sources = new Set<'local' | 'alias' | 'llm'>()
  const affected = new Map<string, SupplyChainAttribution['affectedNodes'][number]>()
  const groups = new Map<string, SupplyChainAttribution['chainGroups'][number]>()
  let eventType: SupplyChainEventType = 'other'

  function upsertGroup(
    chainGroup: string,
    confidence: number,
    direction: SupplyChainDirection,
    reason: string,
  ): void {
    const existing = groups.get(chainGroup)
    if (!existing || confidence > existing.confidence) {
      groups.set(chainGroup, { chainGroup, confidence, direction, reason })
    }
  }

  function upsertNode(
    concept: string,
    role: SupplyChainAttribution['affectedNodes'][number]['role'],
    confidence: number,
    reason: string,
  ): void {
    if (!allConcepts.has(concept)) return
    const chainGroup = conceptToGroup.get(concept) ?? '通用'
    const existing = affected.get(concept)
    if (!existing || confidence > existing.confidence) {
      affected.set(concept, { concept, chainGroup, role, confidence, reason })
    }
    upsertGroup(chainGroup, Math.max(60, confidence - 5), 'mixed', `文本涉及 ${concept}，归入 ${chainGroup}。`)
  }

  for (const concept of localMatch(text, edges)) {
    sources.add('local')
    upsertNode(concept, 'direct', 96, `文本直接提及“${concept}”。`)
  }

  for (const rule of DEFAULT_SUPPLY_CHAIN_ALIASES) {
    const matchedKeyword = rule.keywords.find(keyword =>
      text.includes(keyword) || text.toLowerCase().includes(keyword.toLowerCase()),
    )
    if (!matchedKeyword) continue
    sources.add('alias')
    eventType = rule.eventType ?? eventType
    upsertGroup(rule.chainGroup, 88, rule.direction ?? 'mixed', `${rule.reason}（命中关键词：${matchedKeyword}）`)
    const validConcepts = rule.concepts.filter(c => allConcepts.has(c))
    const fallbackConcepts = validConcepts.length > 0 ? validConcepts : coreConceptsForGroup(rule.chainGroup, groupToConcepts)
    for (const concept of fallbackConcepts) {
      upsertNode(concept, 'direct', 86, `${rule.reason}（命中关键词：${matchedKeyword}）`)
    }
  }

  if (affected.size === 0 && llmEnabled) {
    const pick = await llmConstrainedAttribution(db, text, edges)
    if (pick) {
      sources.add('llm')
      eventType = pick.eventType ?? eventType
      for (const group of pick.chainGroups ?? []) {
        const chainGroup = group.chainGroup ?? ''
        if (!groupToConcepts.has(chainGroup)) continue
        upsertGroup(
          chainGroup,
          Math.max(0, Math.min(100, group.confidence ?? 70)),
          group.direction ?? 'mixed',
          group.reason || `AI 归因到 ${chainGroup}`,
        )
      }
      for (const node of pick.affectedNodes ?? []) {
        const concept = node.concept ?? ''
        upsertNode(
          concept,
          node.role ?? 'direct',
          Math.max(0, Math.min(100, node.confidence ?? 70)),
          node.reason || `AI 归因到 ${concept}`,
        )
      }
      // LLM 只返回链组时，自动回填该链组核心节点，避免有归因但无图谱节点。
      if (affected.size === 0) {
        for (const group of groups.keys()) {
          for (const concept of coreConceptsForGroup(group, groupToConcepts)) {
            upsertNode(concept, 'direct', 68, `AI 归因到 ${group}，自动选择核心环节 ${concept}。`)
          }
        }
      }
    }
  }

  const matchedBy = inferMatchedBy(sources)
  const affectedNodes = [...affected.values()].sort((a, b) => b.confidence - a.confidence)
  const chainGroups = [...groups.values()].sort((a, b) => b.confidence - a.confidence)
  return {
    hitConcepts: uniqueStrings(affectedNodes.map(n => n.concept)),
    matchedBy,
    attribution: {
      chainGroups,
      affectedNodes,
      eventType,
      matchedBy: matchedBy === 'none' ? 'none' : matchedBy,
    },
  }
}

/**
 * 步骤3：BFS 图谱展开
 * 上游最多2层，下游最多3层
 */
function bfsExpand(
  hitConcepts: string[],
  edges: SupplyChainEdgeRow[],
): { nodes: Map<string, { distance: number; chainGroup: string; isHit: boolean }>; subEdges: SupplyChainEdgeRow[] } {
  const nodes = new Map<string, { distance: number; chainGroup: string; isHit: boolean }>()
  const subEdges: SupplyChainEdgeRow[] = []

  // 建索引
  const upMap = new Map<string, SupplyChainEdgeRow[]>()   // concept → 以该 concept 为 downstream 的边
  const downMap = new Map<string, SupplyChainEdgeRow[]>()  // concept → 以该 concept 为 upstream 的边
  for (const e of edges) {
    if (!upMap.has(e.downstreamConcept)) upMap.set(e.downstreamConcept, [])
    upMap.get(e.downstreamConcept)!.push(e)
    if (!downMap.has(e.upstreamConcept)) downMap.set(e.upstreamConcept, [])
    downMap.get(e.upstreamConcept)!.push(e)
  }

  // 确定命中节点的 chainGroup（取第一个命中概念所在链组）
  function findChainGroup(concept: string): string {
    for (const e of edges) {
      if (e.upstreamConcept === concept || e.downstreamConcept === concept) return e.chainGroup
    }
    return '通用'
  }

  const queue: { concept: string; distance: number }[] = []
  for (const c of hitConcepts) {
    if (!nodes.has(c)) {
      nodes.set(c, { distance: 0, chainGroup: findChainGroup(c), isHit: true })
      queue.push({ concept: c, distance: 0 })
    }
  }

  const edgeIdsSeen = new Set<number>()

  let head = 0
  while (head < queue.length) {
    const { concept, distance } = queue[head++]
    // 向上游扩展（最多2层）
    if (distance > -2) {
      for (const e of (upMap.get(concept) ?? [])) {
        if (!edgeIdsSeen.has(e.id)) {
          edgeIdsSeen.add(e.id)
          subEdges.push(e)
        }
        if (!nodes.has(e.upstreamConcept)) {
          nodes.set(e.upstreamConcept, { distance: distance - 1, chainGroup: e.chainGroup, isHit: false })
          queue.push({ concept: e.upstreamConcept, distance: distance - 1 })
        }
      }
    }
    // 向下游扩展（最多3层）
    if (distance < 3) {
      for (const e of (downMap.get(concept) ?? [])) {
        if (!edgeIdsSeen.has(e.id)) {
          edgeIdsSeen.add(e.id)
          subEdges.push(e)
        }
        if (!nodes.has(e.downstreamConcept)) {
          nodes.set(e.downstreamConcept, { distance: distance + 1, chainGroup: e.chainGroup, isHit: false })
          queue.push({ concept: e.downstreamConcept, distance: distance + 1 })
        }
      }
    }
  }

  return { nodes, subEdges }
}

/**
 * 股票名称三级兜底：
 *   1. rtKCache.name（实时行情已含股票名）
 *   2. m.stockName（KPL/DC 成员表字段，可能为空）
 *   3. stock_info 表持久化名称
 *   4. 最终 fallback 股票代码本身
 */
function resolveStockName(
  db: Database.Database,
  stockCode: string,
  fallbackName: string,
  rtCache: ReturnType<typeof getRtKCache>,
): string {
  const rtName = rtCache?.get(stockCode)?.name
  if (rtName) return rtName
  if (fallbackName) return fallbackName
  const info = getStockInfo(db, stockCode)
  return info?.stockName ?? stockCode
}

/**
 * 步骤4：成员股标的填充
 *
 * 产业链"代表个股"需要精确的核心标的，因此采用固定优先级策略，与用户选择的题材源无关：
 *
 * 1. 【优先】KPL 开盘啦（精确→模糊兜底）：游资实际交易认可的核心成员，成员少且精准；
 *    命中 → 按 hotNum 降序取前 15 只。
 *
 * 2. 【兜底】用户选择的源（THS / DC）（精确→模糊兜底）：研究视角，成员多但包含泛相关股；
 *    仅在 KPL 无此概念时使用，限取前 10 只（精度较低，数量要少）。
 *
 * 不采用 THS/DC 优先或按成交额排序方案——THS"风电"有 430 只，含玻璃纤维、光缆等
 * 泛相关行业，与产业链核心标的需求不符。
 */
async function fillStocks(
  db: Database.Database,
  conceptNames: string[],
  source: ConceptSource,
): Promise<Map<string, MemberStock[]>> {
  const rtCache = getRtKCache()
  const result = new Map<string, MemberStock[]>()

  /**
   * 在指定表中按概念名精确匹配，失败后按最短模糊匹配，返回概念代码。
   * extra: 额外 SQL 片段（如 ORDER BY / GROUP BY），可为空字符串。
   */
  function lookupConceptCode(
    table: string,
    nameCol: string,
    codeCol: string,
    extra: string,
    name: string,
  ): string | undefined {
    const exact = db
      .prepare(`SELECT ${codeCol} FROM ${table} WHERE ${nameCol} = ? ${extra} LIMIT 1`)
      .get(name) as Record<string, string> | undefined
    if (exact) return exact[codeCol]

    const fuzzy = db
      .prepare(
        `SELECT ${codeCol} FROM ${table} WHERE ${nameCol} LIKE ? ORDER BY LENGTH(${nameCol}) ASC LIMIT 1`,
      )
      .get(`%${name}%`) as Record<string, string> | undefined
    return fuzzy?.[codeCol]
  }

  for (const name of conceptNames) {
    try {
      // ── 1. 优先尝试 KPL ────────────────────────────────────────────────
      // 注意：kpl_concept_members 中 ts_code=概念代码、name=概念名称
      // kpl_concept_daily 的 ts_code 是股票代码，不可用于此处
      const kplCode = lookupConceptCode(
        'kpl_concept_members', 'name', 'ts_code',
        'GROUP BY ts_code', name,
      )

      if (kplCode) {
        const members = getMembersByConceptRouted(db, kplCode, 'kpl')
        // 优先按当日成交额降序（盘中 rtCache 有数据时），盘后 rtCache 为空则降级用 hotNum
        const sorted = members.slice().sort((a, b) => {
          const amtA = rtCache?.get(a.stockCode)?.amount ?? 0
          const amtB = rtCache?.get(b.stockCode)?.amount ?? 0
          if (amtA !== amtB) return amtB - amtA
          return (b.hotNum ?? 0) - (a.hotNum ?? 0)
        })
        result.set(name, sorted.slice(0, 15).map(m => ({
          stockCode: m.stockCode,
          stockName: resolveStockName(db, m.stockCode, m.stockName, rtCache),
          hotNum: m.hotNum,
          todayChange: rtCache?.get(m.stockCode)?.change ?? null,
        })))
        continue
      }

      // ── 2. KPL 无此概念，按 source 选择兜底 ──────────────────────────────
      let fallbackCode: string | undefined
      let fallbackSource: ConceptSource = 'ths'

      if (source === 'dc') {
        fallbackCode = lookupConceptCode(
          'dc_concept_members', 'theme_name', 'theme_code',
          '', name,
        )
        if (fallbackCode) fallbackSource = 'dc'
      }
      // THS 最终保底（source=kpl 或 dc 未命中时均走此分支）
      if (!fallbackCode) {
        fallbackCode = lookupConceptCode(
          'ths_concept_index', 'name', 'ts_code',
          'ORDER BY synced_at DESC', name,
        )
        fallbackSource = 'ths'
      }

      if (!fallbackCode) continue

      const members = getMembersByConceptRouted(db, fallbackCode, fallbackSource)
      // THS/DC 成员多（如"风电"有 430 只），按当日成交额降序取前 10
      const sorted = members.slice().sort((a, b) => {
        const amtA = rtCache?.get(a.stockCode)?.amount ?? 0
        const amtB = rtCache?.get(b.stockCode)?.amount ?? 0
        return amtB - amtA
      })
      result.set(name, sorted.slice(0, 10).map(m => ({
        stockCode: m.stockCode,
        stockName: resolveStockName(db, m.stockCode, m.stockName, rtCache),
        hotNum: m.hotNum,
        todayChange: rtCache?.get(m.stockCode)?.change ?? null,
      })))
    } catch (err) {
      console.warn(`[supplyChainService] fillStocks failed for ${name}:`, err)
    }
  }

  // FR-173：内置代表股作为高置信基础层，优先展示，题材源成员作为补充。
  for (const concept of conceptNames) {
    const defaultStocks = DEFAULT_SUPPLY_CHAIN_STOCKS
      .filter(s => s.concept === concept)
      .map(s => ({
        stockCode: s.tsCode,
        stockName: resolveStockName(db, s.tsCode, s.stockName, rtCache),
        hotNum: null,
        todayChange: rtCache?.get(s.tsCode)?.change ?? null,
      }))
    if (defaultStocks.length === 0) continue
    const seen = new Set<string>()
    const merged: MemberStock[] = []
    for (const item of [...defaultStocks, ...(result.get(concept) ?? [])]) {
      if (seen.has(item.stockCode)) continue
      seen.add(item.stockCode)
      merged.push(item)
    }
    result.set(concept, merged.slice(0, 15))
  }

  return result
}

// ──── 读取 LLM 兜底设置 ─────────────────────────────────────────────────────

function getLlmFallbackEnabled(db: Database.Database): boolean {
  const row = db
    .prepare('SELECT supply_chain_llm_fallback FROM app_settings WHERE id = 1')
    .get() as { supply_chain_llm_fallback: number | null } | undefined
  return (row?.supply_chain_llm_fallback ?? 0) === 1
}

// ──── 读取题材源设置 ─────────────────────────────────────────────────────────

function getConceptSourceFromDb(db: Database.Database): ConceptSource {
  const row = db
    .prepare('SELECT concept_source FROM app_settings WHERE id = 1')
    .get() as { concept_source: string | null } | undefined
  const val = row?.concept_source
  if (val === 'ths') return 'ths'
  if (val === 'dc') return 'dc'
  return 'kpl'
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(tableName) as { name: string } | undefined
  return !!row
}

function localSignalBoost(
  db: Database.Database,
  tsCode: string,
): { boost: number; sources: SupplyChainRecommendedStock['source']; reasons: string[] } {
  const sources = new Set<SupplyChainRecommendedStock['source'][number]>()
  const reasons: string[] = []
  let boost = 0

  try {
    if (tableExists(db, 'trend_watchlist')) {
      const hit = db.prepare('SELECT 1 FROM trend_watchlist WHERE ts_code = ? LIMIT 1').get(tsCode)
      if (hit) {
        boost += 8
        sources.add('trend')
        reasons.push('已在长线趋势池中')
      }
    }
    if (tableExists(db, 'portfolio_stocks')) {
      const hit = db.prepare('SELECT 1 FROM portfolio_stocks WHERE ts_code = ? LIMIT 1').get(tsCode)
      if (hit) {
        boost += 10
        sources.add('portfolio')
        reasons.push('已在持仓池中')
      }
    }
    if (tableExists(db, 'decision_signals')) {
      const hit = db
        .prepare("SELECT 1 FROM decision_signals WHERE ts_code = ? AND status != 'DISMISSED' LIMIT 1")
        .get(tsCode)
      if (hit) {
        boost += 8
        sources.add('decision')
        reasons.push('近期已出现在今日看板信号中')
      }
    }
  } catch (err) {
    console.warn('[supplyChainService] localSignalBoost failed:', err)
  }

  return { boost: Math.min(boost, 25), sources: [...sources], reasons }
}

function liquidityScore(amount: number | null): number {
  if (amount === null) return 50
  if (amount >= 5_000_000_000) return 100
  if (amount >= 2_000_000_000) return 90
  if (amount >= 1_000_000_000) return 80
  if (amount >= 500_000_000) return 68
  if (amount >= 200_000_000) return 55
  return 42
}

function rankRecommendedStocks(
  db: Database.Database,
  attribution: SupplyChainAttribution,
  nodes: SupplyChainNode[],
  stocksMap: Map<string, MemberStock[]>,
  source: ConceptSource,
): SupplyChainRecommendedStock[] {
  const rtCache = getRtKCache()
  const candidateMap = new Map<string, {
    tsCode: string
    stockName: string
    chainGroup: string
    concepts: Set<string>
    leaderScore: number | null
    relevanceScore: number
    reasons: string[]
    source: Set<SupplyChainRecommendedStock['source'][number]>
  }>()

  const affectedScore = new Map<string, number>()
  for (const n of attribution.affectedNodes) {
    const score = n.role === 'direct' ? 100 : n.role === 'related' ? 65 : 80
    affectedScore.set(n.concept, Math.max(affectedScore.get(n.concept) ?? 0, score))
  }

  function addCandidate(params: {
    tsCode: string
    stockName: string
    chainGroup: string
    concept: string
    leaderScore: number | null
    relevanceScore: number
    reason: string
    source: SupplyChainRecommendedStock['source'][number]
  }): void {
    const existing = candidateMap.get(params.tsCode)
    if (!existing) {
      candidateMap.set(params.tsCode, {
        tsCode: params.tsCode,
        stockName: params.stockName,
        chainGroup: params.chainGroup,
        concepts: new Set([params.concept]),
        leaderScore: params.leaderScore,
        relevanceScore: params.relevanceScore,
        reasons: [params.reason],
        source: new Set([params.source]),
      })
      return
    }
    existing.concepts.add(params.concept)
    existing.leaderScore = Math.max(existing.leaderScore ?? 0, params.leaderScore ?? 0) || existing.leaderScore
    existing.relevanceScore = Math.max(existing.relevanceScore, params.relevanceScore)
    if (!existing.reasons.includes(params.reason)) existing.reasons.push(params.reason)
    existing.source.add(params.source)
  }

  const nodeByConcept = new Map(nodes.map(n => [n.concept, n]))
  const activeGroups = new Set(attribution.chainGroups.map(g => g.chainGroup))

  for (const stock of DEFAULT_SUPPLY_CHAIN_STOCKS) {
    const node = nodeByConcept.get(stock.concept)
    if (!node && !activeGroups.has(stock.chainGroup)) continue
    addCandidate({
      tsCode: stock.tsCode,
      stockName: resolveStockName(db, stock.tsCode, stock.stockName, rtCache),
      chainGroup: stock.chainGroup,
      concept: stock.concept,
      leaderScore: stock.leaderScore,
      relevanceScore: affectedScore.get(stock.concept) ?? (node ? Math.max(58, 78 - Math.abs(node.distance) * 8) : 62),
      reason: stock.reason,
      source: 'default',
    })
  }

  for (const node of nodes) {
    const members = stocksMap.get(node.concept) ?? []
    const relevanceScore = affectedScore.get(node.concept) ?? Math.max(45, 72 - Math.abs(node.distance) * 8)
    for (const member of members.slice(0, 8)) {
      addCandidate({
        tsCode: member.stockCode,
        stockName: member.stockName,
        chainGroup: node.chainGroup,
        concept: node.concept,
        leaderScore: null,
        relevanceScore,
        reason: `${node.concept} 环节成员股`,
        source,
      })
    }
  }

  return [...candidateMap.values()]
    .map(c => {
      const rt = rtCache?.get(c.tsCode)
      const amount = rt?.amount ?? null
      const todayChange = rt?.change ?? null
      const local = localSignalBoost(db, c.tsCode)
      for (const s of local.sources) c.source.add(s)
      const reasons = uniqueStrings([...c.reasons, ...local.reasons]).slice(0, 4)
      const leaderScore = c.leaderScore ?? 50
      const signalBoost = local.boost
      const rankScore = Math.round(
        c.relevanceScore * 0.35 +
        leaderScore * 0.25 +
        signalBoost * 0.2 +
        liquidityScore(amount) * 0.1 +
        (local.sources.length > 0 ? 85 : 50) * 0.1,
      )
      return {
        tsCode: c.tsCode,
        stockName: c.stockName,
        chainGroup: c.chainGroup,
        concepts: [...c.concepts],
        rankScore,
        leaderScore: c.leaderScore,
        relevanceScore: c.relevanceScore,
        signalBoost,
        todayChange,
        amount,
        reasons,
        source: [...c.source],
      }
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 20)
}

// ──── 公开核心函数 ──────────────────────────────────────────────────────────

/**
 * 产业链传导分析主函数
 *
 * @param db    数据库实例
 * @param text  待分析文本（资讯标题 + 摘要）
 */
export async function analyzeText(
  db: Database.Database,
  text: string,
): Promise<SupplyChainAnalysisResult> {
  clearExpiredCache()
  const llmEnabled = getLlmFallbackEnabled(db)
  const key = getCacheKey(text, llmEnabled)
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    console.log('[supplyChainService] cache hit, matchedBy=', cached.result.matchedBy, 'hitConcepts=', cached.result.hitConcepts)
    return cached.result
  }

  const edges = getEnabledEdges(db)
  const source = getConceptSourceFromDb(db)

  console.log('[supplyChainService] analyzeText START')
  console.log('  edges.length =', edges.length)
  console.log('  source =', source)
  console.log('  text (前150字) =', text.slice(0, 150).replace(/\n/g, ' '))

  const { hitConcepts, matchedBy, attribution } = await resolveChainAttribution(db, text, edges, llmEnabled)
  console.log('  [attribution] matchedBy =', matchedBy, 'hitConcepts =', hitConcepts)

  if (hitConcepts.length === 0) {
    console.warn('[supplyChainService] NO_MATCH — 文本未能归因到本地产业链候选。edges=', edges.length, '，text前80字=', text.slice(0, 80))
    const emptyResult: SupplyChainAnalysisResult = {
      hitConcepts: [],
      chainGroup: '',
      nodes: [],
      edges: [],
      matchedBy: 'none',
      attribution,
      recommendedStocks: [],
    }
    // 空结果不缓存：用户开启 LLM 或调整文本后应立即重新归因。
    return emptyResult
  }

  // 步骤3：BFS 图谱展开
  const { nodes: nodeMap, subEdges } = bfsExpand(hitConcepts, edges)

  // 确定最相关的 chainGroup（命中节点所属链组出现次数最多）
  const groupCount = new Map<string, number>()
  for (const info of nodeMap.values()) {
    if (info.isHit) groupCount.set(info.chainGroup, (groupCount.get(info.chainGroup) ?? 0) + 1)
  }
  const chainGroup = [...groupCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

  // 步骤4：成员股填充
  const conceptNames = [...nodeMap.keys()]
  const stocksMap = await fillStocks(db, conceptNames, source)

  // 步骤5：结果组装
  const nodes: SupplyChainNode[] = conceptNames
    .map(concept => {
      const info = nodeMap.get(concept)!
      return {
        concept,
        chainGroup: info.chainGroup,
        distance: info.distance,
        isHit: info.isHit,
        stocks: stocksMap.get(concept) ?? [],
      }
    })
    .sort((a, b) => a.distance - b.distance)

  const recommendedStocks = rankRecommendedStocks(db, attribution, nodes, stocksMap, source)

  const result: SupplyChainAnalysisResult = {
    hitConcepts,
    chainGroup,
    nodes,
    edges: subEdges,
    matchedBy,
    attribution,
    recommendedStocks,
  }

  _cache.set(key, { result, cachedAt: Date.now() })
  return result
}
