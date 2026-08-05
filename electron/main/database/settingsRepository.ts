import { getDb } from './db'
import type Database from 'better-sqlite3'
import type { AppSettingsRow, DecisionCenterFiltersPreference } from './types'

const DEFAULT_DECISION_CENTER_FILTERS: DecisionCenterFiltersPreference = {
  status: 'active',
  type: 'all',
  source: 'all',
  portfolioOnly: true,
  minPriority: 1,
  viewMode: 'portfolio',
}

const UPDATABLE_APP_SETTING_KEYS = new Set<string>([
  'scanIntervalMinutes',
  'retentionDays',
  'catchUpMaxDays',
  'lastSuccessfulScanAt',
  'uiLanguage',
  'defaultGroupExpanded',
  'autoAiAnalysisPrompt',
  'momentumWindowMinutes',
  'short_term_active_sub_tab',
  'concept_source',
  'sector_concept_source',
  'decision_notify_windows_enabled',
  'decision_notify_min_priority',
  'decision_notify_in_app_enabled',
  'supply_chain_llm_fallback',
  'decision_center_filters_json',
])

function preferenceText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : fallback
}

export function normalizeDecisionCenterFiltersPreference(value: unknown): DecisionCenterFiltersPreference {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawPriority = typeof input.minPriority === 'number' ? input.minPriority : Number(input.minPriority)
  const minPriority = Number.isFinite(rawPriority)
    ? Math.max(1, Math.min(5, Math.round(rawPriority)))
    : DEFAULT_DECISION_CENTER_FILTERS.minPriority
  const viewMode = input.viewMode === 'market' ? 'market' : 'portfolio'
  return {
    status: preferenceText(input.status, DEFAULT_DECISION_CENTER_FILTERS.status),
    type: preferenceText(input.type, DEFAULT_DECISION_CENTER_FILTERS.type),
    source: preferenceText(input.source, DEFAULT_DECISION_CENTER_FILTERS.source),
    portfolioOnly: viewMode === 'portfolio' ? true : input.portfolioOnly === true,
    minPriority,
    viewMode,
  }
}

export function getSettings(): AppSettingsRow {
  return getDb().prepare('SELECT * FROM app_settings WHERE id = 1').get() as AppSettingsRow
}

export function updateSettings(data: Partial<Omit<AppSettingsRow, 'id'>>): AppSettingsRow {
  const db = getDb()
  const keys = Object.keys(data) as (keyof typeof data)[]
  if (keys.length === 0) return getSettings()
  if (keys.some((key) => !UPDATABLE_APP_SETTING_KEYS.has(String(key)))) {
    throw new Error('SETTINGS_FIELD_NOT_ALLOWED')
  }
  if (
    data.decision_notify_in_app_enabled !== undefined
    && data.decision_notify_in_app_enabled !== 0
    && data.decision_notify_in_app_enabled !== 1
  ) {
    throw new Error('SETTINGS_VALUE_INVALID')
  }

  const setClauses = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE app_settings SET ${setClauses} WHERE id = 1`).run(data)
  return getSettings()
}

export function getDecisionCenterFilters(
  db: Database.Database = getDb(),
): DecisionCenterFiltersPreference | null {
  const row = db.prepare('SELECT decision_center_filters_json FROM app_settings WHERE id = 1')
    .get() as { decision_center_filters_json: string | null } | undefined
  if (!row?.decision_center_filters_json) return null
  try {
    return normalizeDecisionCenterFiltersPreference(JSON.parse(row.decision_center_filters_json))
  } catch {
    return null
  }
}

export function setDecisionCenterFilters(
  value: unknown,
  db: Database.Database = getDb(),
): DecisionCenterFiltersPreference {
  const normalized = normalizeDecisionCenterFiltersPreference(value)
  db.prepare('UPDATE app_settings SET decision_center_filters_json = ? WHERE id = 1')
    .run(JSON.stringify(normalized))
  return normalized
}

export function getTheme(): string {
  const row = getDb().prepare('SELECT theme FROM app_settings WHERE id = 1').get() as { theme: string } | undefined
  return row?.theme ?? 'light'
}

export function setTheme(theme: 'light' | 'dark'): void {
  getDb().prepare('UPDATE app_settings SET theme = ? WHERE id = 1').run(theme)
}

export function getMarketHeatmapProvider(): 'sina' | 'eastmoney' | 'tushare' {
  const row = getDb().prepare('SELECT market_heatmap_provider FROM app_settings WHERE id = 1').get() as { market_heatmap_provider: string | null } | undefined
  const val = row?.market_heatmap_provider
  if (val === 'eastmoney') return 'eastmoney'
  if (val === 'tushare') return 'tushare'
  return 'sina'
}

export function setMarketHeatmapProvider(provider: 'sina' | 'eastmoney' | 'tushare'): void {
  getDb().prepare('UPDATE app_settings SET market_heatmap_provider = ? WHERE id = 1').run(provider)
}

export function getPremarketNetworkEnabled(
  db: Database.Database = getDb(),
): boolean {
  const row = db.prepare('SELECT premarket_network_enabled FROM app_settings WHERE id = 1')
    .get() as { premarket_network_enabled: number } | undefined
  return row?.premarket_network_enabled === 1
}

export function setPremarketNetworkEnabled(
  enabled: unknown,
  db: Database.Database = getDb(),
): boolean {
  if (typeof enabled !== 'boolean') throw new Error('PREMARKET_ENABLED_INVALID')
  db.prepare('UPDATE app_settings SET premarket_network_enabled = ? WHERE id = 1')
    .run(enabled ? 1 : 0)
  return enabled
}

import type { ShortTermSubTab } from './types'

export function getShortTermActiveSubTab(): ShortTermSubTab {
  const row = getDb()
    .prepare('SELECT short_term_active_sub_tab FROM app_settings WHERE id = 1')
    .get() as { short_term_active_sub_tab: string | null } | undefined
  const val = row?.short_term_active_sub_tab
  const allowed: ShortTermSubTab[] = [
    'morningAuction',
    'closingHalfHour',
    'limitBoardMonitor',
    'secondBoardLeader',
    'firstYinDip',
    'dipBuyRadar',
    'strategyLab',
    'personalScreener',
    'chipMonitor',
    'conditionBlocks',
    'strategyBacktest'
  ]
  return (allowed as string[]).includes(val ?? '') ? (val as ShortTermSubTab) : 'morningAuction'
}

export function setShortTermActiveSubTab(subTab: ShortTermSubTab): void {
  getDb()
    .prepare('UPDATE app_settings SET short_term_active_sub_tab = ? WHERE id = 1')
    .run(subTab)
}

export function recordSuccessfulScan(): void {
  getDb()
    .prepare('UPDATE app_settings SET lastSuccessfulScanAt = ? WHERE id = 1')
    .run(Date.now())
}

// FR-153: 题材数据源选择
export function getConceptSource(): 'kpl' | 'ths' | 'dc' {
  const row = getDb()
    .prepare('SELECT concept_source FROM app_settings WHERE id = 1')
    .get() as { concept_source: string | null } | undefined
  const val = row?.concept_source
  if (val === 'ths') return 'ths'
  if (val === 'dc') return 'dc'
  return 'kpl'
}

export function setConceptSource(source: 'kpl' | 'ths' | 'dc'): void {
  getDb()
    .prepare('UPDATE app_settings SET concept_source = ? WHERE id = 1')
    .run(source)
}

// FR-157: 板块资金流向题材源
export function getSectorConceptSource(): 'kpl' | 'ths' | 'dc' {
  const row = getDb()
    .prepare('SELECT sector_concept_source FROM app_settings WHERE id = 1')
    .get() as { sector_concept_source: string | null } | undefined
  const val = row?.sector_concept_source
  if (val === 'kpl') return 'kpl'
  if (val === 'dc') return 'dc'
  return 'ths'
}

export function setSectorConceptSource(source: 'kpl' | 'ths' | 'dc'): void {
  getDb()
    .prepare('UPDATE app_settings SET sector_concept_source = ? WHERE id = 1')
    .run(source)
}

