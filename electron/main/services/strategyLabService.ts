import type Database from 'better-sqlite3'
import {
  duplicateStrategy,
  getStrategy,
  getStrategyByKey,
  listStrategies,
  setStrategyEnabled,
  upsertStrategy,
  deleteStrategy,
  type StrategyLabStrategyInput,
} from '../database/strategyLabRepository'
import type { StrategyLabStrategyRow, StrategyLabStrategySource, StrategyLabStrategyStatus } from '../database/types'
import { getConditionTemplate, listConditionTemplates } from '../database/conditionBlockRepository'
import { DEFAULT_CONDITION_BLOCK_TEMPLATES } from './conditionBlocks/defaultTemplates'
import {
  CONDITION_BLOCK_PARAMETER_DEFS,
  isConditionBlock,
  type BlockStrategyTemplate,
  type ConditionBlock,
  type ConditionBlockType,
  type ConditionGroup,
} from './conditionBlocks/types'

export type StrategyLabStockPoolSource = 'allMarket' | 'portfolio' | 'trendWatchlist' | 'chipMonitor' | 'manual'
export type StrategyLabScanMode = 'quick' | 'complete' | 'twoPhase'

export interface StrategyLabRuleDraft {
  schemaVersion: 1
  source: StrategyLabStrategySource
  stockPool: {
    sources: StrategyLabStockPoolSource[]
    manualTsCodes: string[]
    excludeST: boolean
    excludeBJ: boolean
  }
  screenerProfile?: {
    enabled: boolean
    signals: string[]
    tieBreaker: 'pctChg' | 'turnoverRate' | 'amount'
  }
  conditionBlocksProfile?: {
    enabled: boolean
    templateKey: string
    templateId?: number | null
    templateVersion?: number | null
    templateSnapshot?: BlockStrategyTemplate | null
  }
  scoring: {
    minScore: number
    weights: Record<string, number>
  }
}

export interface StrategyLabRunConfig {
  scanMode: StrategyLabScanMode
  lookbackDays: number
  dailyPrefilterLimit: number
  autoFetchMinuteLimit: number
  userTier: 'free' | 'pro'
  dateStart?: string | null
  dateEnd?: string | null
}

export interface StrategyLabActionsConfig {
  aiInsight: boolean
  addToTrendWatchlist: boolean
  monitorChips: boolean
  createBacktest: boolean
}

export interface StrategyLabStrategySummary {
  id: number
  strategyKey: string
  name: string
  description: string | null
  source: StrategyLabStrategySource
  status: StrategyLabStrategyStatus
  enabled: boolean
  isBuiltin: boolean
  version: number
  lastRunAt: number | null
  updatedAt: number
}

export interface StrategyLabStrategyDetail extends StrategyLabStrategySummary {
  ruleDraft: StrategyLabRuleDraft
  runConfig: StrategyLabRunConfig
  actions: StrategyLabActionsConfig
}

export interface SaveStrategyLabStrategyRequest {
  id?: number
  name: string
  description?: string | null
  source: StrategyLabStrategySource
  status?: StrategyLabStrategyStatus
  enabled?: boolean
  ruleDraft: StrategyLabRuleDraft
  runConfig: StrategyLabRunConfig
  actions: StrategyLabActionsConfig
}

function defaultStockPool(): StrategyLabRuleDraft['stockPool'] {
  return {
    sources: ['allMarket', 'portfolio', 'trendWatchlist', 'chipMonitor'],
    manualTsCodes: [],
    excludeST: true,
    excludeBJ: false,
  }
}

function cloneTemplate(template: BlockStrategyTemplate): BlockStrategyTemplate {
  return JSON.parse(JSON.stringify(template)) as BlockStrategyTemplate
}

export function createScreenerDraft(): StrategyLabRuleDraft {
  return {
    schemaVersion: 1,
    source: 'screener',
    stockPool: defaultStockPool(),
    screenerProfile: {
      enabled: true,
      signals: ['crossUp', 'volAmplified', 'bullTrend', 'macdBull', 'hasTurnover', 'moneyInflow'],
      tieBreaker: 'pctChg',
    },
    scoring: {
      minScore: 1,
      weights: { rankScore: 70, signalScore: 30 },
    },
  }
}

export function createConditionBlocksDraft(): StrategyLabRuleDraft {
  return {
    schemaVersion: 1,
    source: 'conditionBlocks',
    stockPool: defaultStockPool(),
    conditionBlocksProfile: {
      enabled: true,
      templateKey: 'intraday_amount_surge_hold',
      templateId: null,
      templateVersion: DEFAULT_CONDITION_BLOCK_TEMPLATES[0].version,
      templateSnapshot: cloneTemplate(DEFAULT_CONDITION_BLOCK_TEMPLATES[0]),
    },
    scoring: {
      minScore: 70,
      weights: { conditionScore: 100 },
    },
  }
}

export function createCustomDraft(): StrategyLabRuleDraft {
  return {
    schemaVersion: 1,
    source: 'custom',
    stockPool: defaultStockPool(),
    screenerProfile: {
      enabled: true,
      signals: ['crossUp', 'volAmplified'],
      tieBreaker: 'pctChg',
    },
    conditionBlocksProfile: {
      enabled: false,
      templateKey: 'intraday_amount_surge_hold',
      templateId: null,
    },
    scoring: {
      minScore: 70,
      weights: { rankScore: 40, conditionScore: 60 },
    },
  }
}

export function createDefaultRunConfig(): StrategyLabRunConfig {
  return {
    scanMode: 'complete',
    lookbackDays: 5,
    dailyPrefilterLimit: 200,
    autoFetchMinuteLimit: 80,
    userTier: 'free',
    dateStart: null,
    dateEnd: null,
  }
}

export function createDefaultActions(): StrategyLabActionsConfig {
  return {
    aiInsight: true,
    addToTrendWatchlist: true,
    monitorChips: true,
    createBacktest: true,
  }
}

const BUILTIN_STRATEGIES: StrategyLabStrategyInput[] = [
  {
    name: '个性选股白盒模板',
    description: '沿用天使魔鬼金叉、量能、MACD、换手和资金维度, 适合快速扫描今日强势候选。',
    source: 'screener',
    status: 'ready',
    enabled: true,
    isBuiltin: true,
    ruleDraftJson: JSON.stringify(createScreenerDraft()),
    runConfigJson: JSON.stringify({ ...createDefaultRunConfig(), scanMode: 'quick' }),
    actionsJson: JSON.stringify(createDefaultActions()),
  },
  {
    name: '条件积木分钟模板',
    description: '沿用盘中放量拉升后站稳模板, 通过日线预筛、分钟覆盖和条件证据验证形态。',
    source: 'conditionBlocks',
    status: 'ready',
    enabled: true,
    isBuiltin: true,
    ruleDraftJson: JSON.stringify(createConditionBlocksDraft()),
    runConfigJson: JSON.stringify(createDefaultRunConfig()),
    actionsJson: JSON.stringify(createDefaultActions()),
  },
  {
    name: '新建规则草稿',
    description: '从空白、个性选股或条件积木复制, 按股票池、截面条件、分钟条件、排序评分和执行计划继续搭建。',
    source: 'custom',
    status: 'draft',
    enabled: true,
    isBuiltin: true,
    ruleDraftJson: JSON.stringify(createCustomDraft()),
    runConfigJson: JSON.stringify(createDefaultRunConfig()),
    actionsJson: JSON.stringify(createDefaultActions()),
  },
]

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function normalizeRunConfig(value: StrategyLabRunConfig): StrategyLabRunConfig {
  const normalized: StrategyLabRunConfig = {
    scanMode: value.scanMode === 'quick' || value.scanMode === 'twoPhase' ? value.scanMode : 'complete',
    lookbackDays: Math.max(1, Math.min(60, Math.round(Number(value.lookbackDays) || 5))),
    dailyPrefilterLimit: Math.max(1, Math.min(1000, Math.round(Number(value.dailyPrefilterLimit) || 200))),
    autoFetchMinuteLimit: Math.max(0, Math.min(500, Math.round(Number(value.autoFetchMinuteLimit) || 80))),
    userTier: value.userTier === 'pro' ? 'pro' : 'free',
    dateStart: typeof value.dateStart === 'string' && /^\d{8}$/.test(value.dateStart) ? value.dateStart : null,
    dateEnd: typeof value.dateEnd === 'string' && /^\d{8}$/.test(value.dateEnd) ? value.dateEnd : null,
  }
  if (normalized.dateStart && normalized.dateEnd && normalized.dateStart > normalized.dateEnd) {
    throw new Error('INVALID_DATE_RANGE')
  }
  return normalized
}

const VALID_POOL_SOURCES = new Set<StrategyLabStockPoolSource>(['allMarket', 'portfolio', 'trendWatchlist', 'chipMonitor', 'manual'])
const VALID_BLOCK_TYPES = new Set<ConditionBlockType>(Object.keys(CONDITION_BLOCK_PARAMETER_DEFS) as ConditionBlockType[])

function normalizeTsCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toUpperCase()
  const match = trimmed.match(/^(\d{6})(?:\.(SH|SZ|BJ))?$/)
  if (!match) return null
  if (match[2]) return `${match[1]}.${match[2]}`
  if (match[1].startsWith('6') || match[1].startsWith('9')) return `${match[1]}.SH`
  if (match[1].startsWith('8') || match[1].startsWith('4')) return `${match[1]}.BJ`
  return `${match[1]}.SZ`
}

function normalizeConditionBlock(block: ConditionBlock, ids: Set<string>): ConditionBlock {
  if (!block || typeof block.id !== 'string' || !block.id.trim()) throw new Error('CONDITION_BLOCK_ID_REQUIRED')
  if (ids.has(block.id)) throw new Error('CONDITION_NODE_ID_DUPLICATED')
  ids.add(block.id)
  if (!VALID_BLOCK_TYPES.has(block.type)) throw new Error(`UNKNOWN_CONDITION_BLOCK:${String(block.type)}`)
  const params: Record<string, number | string | boolean> = {}
  for (const definition of CONDITION_BLOCK_PARAMETER_DEFS[block.type]) {
    const raw = block.params?.[definition.key] ?? definition.defaultValue
    if (typeof definition.defaultValue === 'number') {
      const numeric = Number(raw)
      if (!Number.isFinite(numeric)) throw new Error(`INVALID_CONDITION_PARAM:${block.id}:${definition.key}`)
      if (definition.min != null && numeric < definition.min) throw new Error(`CONDITION_PARAM_TOO_SMALL:${block.id}:${definition.key}`)
      if (definition.max != null && numeric > definition.max) throw new Error(`CONDITION_PARAM_TOO_LARGE:${block.id}:${definition.key}`)
      params[definition.key] = numeric
    } else if (typeof definition.defaultValue === 'boolean') {
      params[definition.key] = raw === true
    } else {
      params[definition.key] = String(raw)
    }
  }
  return {
    id: block.id.trim(),
    type: block.type,
    name: typeof block.name === 'string' && block.name.trim() ? block.name.trim() : block.type,
    description: typeof block.description === 'string' ? block.description.trim() : '',
    enabled: block.enabled !== false,
    weight: Math.max(0, Math.min(100, Number(block.weight) || 0)),
    hardRequired: block.hardRequired === true,
    params,
  }
}

function normalizeConditionGroup(group: ConditionGroup, ids: Set<string>, depth = 0): ConditionGroup {
  if (!group || typeof group.id !== 'string' || !group.id.trim()) throw new Error('CONDITION_GROUP_ID_REQUIRED')
  if (depth > 5) throw new Error('CONDITION_GROUP_TOO_DEEP')
  if (ids.has(group.id)) throw new Error('CONDITION_NODE_ID_DUPLICATED')
  ids.add(group.id)
  if (group.operator !== 'AND' && group.operator !== 'OR' && group.operator !== 'NOT') throw new Error('INVALID_CONDITION_GROUP_OPERATOR')
  if (!Array.isArray(group.children) || group.children.length > 64) throw new Error('INVALID_CONDITION_GROUP_CHILDREN')
  return {
    id: group.id.trim(),
    operator: group.operator,
    enabled: group.enabled !== false,
    children: group.children.map(child => isConditionBlock(child)
      ? normalizeConditionBlock(child, ids)
      : normalizeConditionGroup(child, ids, depth + 1)),
  }
}

function normalizeTemplateSnapshot(value: BlockStrategyTemplate): BlockStrategyTemplate {
  if (!value || typeof value.key !== 'string' || !value.key.trim()) throw new Error('CONDITION_TEMPLATE_KEY_REQUIRED')
  if (!value.name?.trim()) throw new Error('CONDITION_TEMPLATE_NAME_REQUIRED')
  if (value.executionMode !== 'strict' && value.executionMode !== 'score') throw new Error('INVALID_CONDITION_EXECUTION_MODE')
  const root = normalizeConditionGroup(value.root, new Set<string>())
  return {
    ...value,
    key: value.key.trim().slice(0, 160),
    name: value.name.trim().slice(0, 120),
    description: typeof value.description === 'string' ? value.description.trim().slice(0, 500) : '',
    version: Math.max(1, Math.round(Number(value.version) || 1)),
    enabled: value.enabled !== false,
    scoreThreshold: Math.max(0, Math.min(100, Number(value.scoreThreshold) || 0)),
    scope: {
      ...value.scope,
      dateStart: typeof value.scope?.dateStart === 'string' ? value.scope.dateStart : '',
      dateEnd: typeof value.scope?.dateEnd === 'string' ? value.scope.dateEnd : '',
      lookbackDays: Math.max(1, Math.min(60, Math.round(Number(value.scope?.lookbackDays) || 5))),
      stockPoolSources: Array.isArray(value.scope?.stockPoolSources)
        ? value.scope.stockPoolSources.filter(source => VALID_POOL_SOURCES.has(source))
        : ['allMarket'],
      manualStocks: Array.isArray(value.scope?.manualStocks)
        ? value.scope.manualStocks.flatMap(item => {
            const tsCode = normalizeTsCode(item?.tsCode)
            return tsCode ? [{ tsCode, stockName: item?.stockName ?? null }] : []
          })
        : [],
      excludeST: value.scope?.excludeST !== false,
      excludeBJ: value.scope?.excludeBJ === true,
    },
    root,
  }
}

export function validateStrategyLabRuleDraft(value: StrategyLabRuleDraft, source: StrategyLabStrategySource): StrategyLabRuleDraft {
  if (!value || value.schemaVersion !== 1) throw new Error('INVALID_RULE_DRAFT')
  if (value.source !== source) throw new Error('RULE_SOURCE_MISMATCH')
  const sources = Array.isArray(value.stockPool?.sources)
    ? Array.from(new Set(value.stockPool.sources.filter(item => VALID_POOL_SOURCES.has(item))))
    : []
  if (sources.length === 0) throw new Error('STOCK_POOL_REQUIRED')
  const rawManualTsCodes = Array.isArray(value.stockPool?.manualTsCodes) ? value.stockPool.manualTsCodes : []
  const normalizedManualTsCodes = rawManualTsCodes.map(normalizeTsCode)
  if (normalizedManualTsCodes.some(item => item === null)) throw new Error('INVALID_STOCK_CODE')
  const manualTsCodes = Array.from(new Set(normalizedManualTsCodes as string[]))
  if (sources.includes('manual') && manualTsCodes.length === 0) throw new Error('MANUAL_STOCK_POOL_REQUIRED')
  if (source === 'screener' && !value.screenerProfile?.enabled) throw new Error('SCREENER_PROFILE_REQUIRED')
  if (source === 'conditionBlocks' && !value.conditionBlocksProfile?.enabled) throw new Error('CONDITION_BLOCKS_PROFILE_REQUIRED')
  if (source === 'custom' && !value.screenerProfile && !value.conditionBlocksProfile) throw new Error('CUSTOM_PROFILE_REQUIRED')
  const profile = value.conditionBlocksProfile
    ? {
        enabled: value.conditionBlocksProfile.enabled === true,
        templateKey: String(value.conditionBlocksProfile.templateKey || '').trim(),
        templateId: Number.isInteger(value.conditionBlocksProfile.templateId) && Number(value.conditionBlocksProfile.templateId) > 0
          ? Number(value.conditionBlocksProfile.templateId)
          : null,
        templateVersion: Number.isInteger(value.conditionBlocksProfile.templateVersion) && Number(value.conditionBlocksProfile.templateVersion) > 0
          ? Number(value.conditionBlocksProfile.templateVersion)
          : null,
        templateSnapshot: value.conditionBlocksProfile.templateSnapshot
          ? normalizeTemplateSnapshot(value.conditionBlocksProfile.templateSnapshot)
          : null,
      }
    : undefined
  return {
    ...value,
    stockPool: {
      sources,
      manualTsCodes,
      excludeST: value.stockPool.excludeST !== false,
      excludeBJ: value.stockPool.excludeBJ === true,
    },
    conditionBlocksProfile: profile,
    scoring: {
      minScore: Math.max(0, Math.min(100, Math.round(Number(value.scoring?.minScore) || 0))),
      weights: value.scoring?.weights ?? {},
    },
  }
}

function resolveTemplateSnapshot(db: Database.Database, draft: StrategyLabRuleDraft): BlockStrategyTemplate | null {
  const profile = draft.conditionBlocksProfile
  if (!profile?.enabled) return null
  if (profile.templateSnapshot) return normalizeTemplateSnapshot(profile.templateSnapshot)
  const row = profile.templateId ? getConditionTemplate(db, profile.templateId) : null
  const byKey = row ?? listConditionTemplates(db).find(item => item.templateKey === profile.templateKey) ?? null
  if (!byKey) return null
  return normalizeTemplateSnapshot(JSON.parse(byKey.templateJson) as BlockStrategyTemplate)
}

function hydrateTemplateSnapshot(db: Database.Database, draft: StrategyLabRuleDraft): StrategyLabRuleDraft {
  const snapshot = resolveTemplateSnapshot(db, draft)
  if (!snapshot || !draft.conditionBlocksProfile) return draft
  return {
    ...draft,
    conditionBlocksProfile: {
      ...draft.conditionBlocksProfile,
      templateKey: snapshot.key,
      templateVersion: snapshot.version,
      templateSnapshot: snapshot,
    },
  }
}

function countEnabledConditions(group: ConditionGroup): number {
  if (!group.enabled) return 0
  return group.children.reduce((count, child) => count + (isConditionBlock(child)
    ? child.enabled ? 1 : 0
    : countEnabledConditions(child)), 0)
}

function alignTemplateWithStrategy(
  draft: StrategyLabRuleDraft,
  runConfig: StrategyLabRunConfig,
  name: string,
  description: string | null | undefined,
  previous?: BlockStrategyTemplate | null,
): StrategyLabRuleDraft {
  const profile = draft.conditionBlocksProfile
  if (!profile?.enabled || !profile.templateSnapshot) return draft
  const incoming = profile.templateSnapshot
  const candidate: BlockStrategyTemplate = normalizeTemplateSnapshot({
    ...incoming,
    name,
    description: description ?? '',
    scoreThreshold: draft.scoring.minScore,
    scope: {
      ...incoming.scope,
      dateStart: runConfig.dateStart ?? '',
      dateEnd: runConfig.dateEnd ?? '',
      lookbackDays: runConfig.lookbackDays,
      stockPoolSources: draft.stockPool.sources,
      manualStocks: draft.stockPool.manualTsCodes.map(tsCode => ({ tsCode })),
      excludeST: draft.stockPool.excludeST,
      excludeBJ: draft.stockPool.excludeBJ,
      dailyPrefilterLimit: runConfig.dailyPrefilterLimit,
      autoFetchMinuteLimit: runConfig.autoFetchMinuteLimit,
    },
  })
  const previousComparable = previous ? JSON.stringify({ ...previous, version: candidate.version }) : null
  const candidateComparable = JSON.stringify(candidate)
  const version = previous && previousComparable !== candidateComparable
    ? Math.max(previous.version + 1, candidate.version)
    : previous?.version ?? candidate.version
  const snapshot = { ...candidate, version }
  return {
    ...draft,
    conditionBlocksProfile: {
      ...profile,
      templateKey: snapshot.key,
      templateVersion: snapshot.version,
      templateSnapshot: snapshot,
    },
  }
}

function normalizeActions(value: StrategyLabActionsConfig | undefined): StrategyLabActionsConfig {
  const fallback = createDefaultActions()
  return {
    aiInsight: value?.aiInsight ?? fallback.aiInsight,
    addToTrendWatchlist: value?.addToTrendWatchlist ?? fallback.addToTrendWatchlist,
    monitorChips: value?.monitorChips ?? fallback.monitorChips,
    createBacktest: value?.createBacktest ?? fallback.createBacktest,
  }
}

function toSummary(row: StrategyLabStrategyRow): StrategyLabStrategySummary {
  return {
    id: row.id,
    strategyKey: row.strategyKey,
    name: row.name,
    description: row.description,
    source: row.source,
    status: row.status,
    enabled: row.enabled === 1,
    isBuiltin: row.isBuiltin === 1,
    version: row.version,
    lastRunAt: row.lastRunAt,
    updatedAt: row.updatedAt,
  }
}

export function toDetail(row: StrategyLabStrategyRow, db?: Database.Database): StrategyLabStrategyDetail {
  const defaultDraft = row.source === 'screener'
    ? createScreenerDraft()
    : row.source === 'conditionBlocks'
      ? createConditionBlocksDraft()
      : createCustomDraft()
  const parsedDraft = validateStrategyLabRuleDraft(parseJson(row.ruleDraftJson, defaultDraft), row.source)
  return {
    ...toSummary(row),
    ruleDraft: db ? hydrateTemplateSnapshot(db, parsedDraft) : parsedDraft,
    runConfig: normalizeRunConfig(parseJson(row.runConfigJson, createDefaultRunConfig())),
    actions: normalizeActions(parseJson(row.actionsJson, createDefaultActions())),
  }
}

export function ensureDefaultStrategyLabStrategies(db: Database.Database): void {
  for (const strategy of BUILTIN_STRATEGIES) {
    const key = strategy.name === '个性选股白盒模板'
      ? 'builtin-screener'
      : strategy.name === '条件积木分钟模板'
        ? 'builtin-condition-blocks'
        : 'builtin-new-rule'
    const existing = getStrategyByKey(db, key)
    if (existing) {
      if (key === 'builtin-screener') {
        const draft = parseJson(existing.ruleDraftJson, createScreenerDraft())
        if (draft.source === 'screener' && Number(draft.scoring?.minScore) > 6) {
          const nextDraft = {
            ...draft,
            scoring: {
              ...draft.scoring,
              minScore: createScreenerDraft().scoring.minScore,
            },
          }
          db.prepare(`
            UPDATE strategy_lab_strategies
            SET rule_draft_json = ?, version = version + 1, updated_at = ?
            WHERE id = ?
          `).run(JSON.stringify(nextDraft), Date.now(), existing.id)
        }
      }
      continue
    }
    const saved = upsertStrategy(db, strategy)
    db.prepare('UPDATE strategy_lab_strategies SET strategy_key = ? WHERE id = ?').run(key, saved.id)
  }
}

export function listStrategyLabStrategies(db: Database.Database): StrategyLabStrategySummary[] {
  ensureDefaultStrategyLabStrategies(db)
  return listStrategies(db).map(toSummary)
}

export function getStrategyLabStrategy(db: Database.Database, id: number): StrategyLabStrategyDetail | null {
  ensureDefaultStrategyLabStrategies(db)
  const row = getStrategy(db, id)
  return row ? toDetail(row, db) : null
}

export function saveStrategyLabStrategy(db: Database.Database, request: SaveStrategyLabStrategyRequest): StrategyLabStrategyDetail {
  const existing = request.id ? getStrategy(db, request.id) : null
  if (request.id && !existing) throw new Error('STRATEGY_NOT_FOUND')
  if (existing?.isBuiltin === 1) throw new Error('BUILTIN_STRATEGY_READ_ONLY')
  const runConfig = normalizeRunConfig(request.runConfig)
  let draft = validateStrategyLabRuleDraft(request.ruleDraft, request.source)
  const previousDraft = existing ? toDetail(existing, db).ruleDraft : null
  const previousSnapshot = previousDraft?.conditionBlocksProfile?.templateSnapshot ?? null
  draft = hydrateTemplateSnapshot(db, draft)
  draft = alignTemplateWithStrategy(draft, runConfig, request.name.trim(), request.description, previousSnapshot)
  if (request.status === 'ready' && request.source === 'conditionBlocks') {
    const snapshot = draft.conditionBlocksProfile?.templateSnapshot
    if (!snapshot) throw new Error('CONDITION_TEMPLATE_SNAPSHOT_REQUIRED')
    if (countEnabledConditions(snapshot.root) === 0) throw new Error('ENABLED_CONDITION_REQUIRED')
  }
  const saved = upsertStrategy(db, {
    id: request.id,
    name: request.name,
    description: request.description ?? null,
    source: request.source,
    status: request.status ?? 'draft',
    enabled: request.enabled !== false,
    ruleDraftJson: JSON.stringify(draft),
    runConfigJson: JSON.stringify(runConfig),
    actionsJson: JSON.stringify(normalizeActions(request.actions)),
  })
  return toDetail(saved, db)
}

export function duplicateStrategyLabStrategy(db: Database.Database, id: number, name?: string): StrategyLabStrategyDetail {
  const saved = duplicateStrategy(db, id, name)
  return toDetail(saved, db)
}

export function deleteStrategyLabStrategy(db: Database.Database, id: number): void {
  deleteStrategy(db, id)
}

export function setStrategyLabStrategyEnabled(db: Database.Database, id: number, enabled: boolean): StrategyLabStrategyDetail {
  const saved = setStrategyEnabled(db, id, enabled)
  return toDetail(saved, db)
}
