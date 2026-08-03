import type { Database } from 'better-sqlite3'
import type { AIConfigRow, ImpactRating, ProviderConfigRow } from './types'

export interface AIConfigUpdate {
  provider?: string
  model?: string
  apiKeyEncrypted?: Buffer | null
  baseUrl?: string | null
  presetPrompt?: string | null
  triggerRating?: ImpactRating
  maxArticlesPerBatch?: number
  maxContentCharsPerArticle?: number
  maxArticleAgeDays?: number | null
  autoCleanupDays?: number | null
  trendForecastPrompt?: string | null
  trendForecastMorrowPrompt?: string | null
  maxForecastsPerStock?: number
  providerPriority?: string | null
  multiModelProviders?: string | null
  maxForecastComparison?: number
  selectedSkills?: string | null
  customSkillPaths?: string | null
  skillsForTrend?: number
  maxSkillChars?: number
}

export function getAIConfig(db: Database): AIConfigRow {
  return db.prepare('SELECT * FROM ai_config WHERE id = 1').get() as AIConfigRow
}

export function updateAIConfig(db: Database, update: AIConfigUpdate): void {
  const fields = Object.keys(update)
  if (fields.length === 0) return

  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE ai_config SET ${setClause} WHERE id = 1`).run(update)
}

// ── provider_configs table operations ─────────────────────────────────────────

/** Get config for a specific provider */
export function getProviderConfig(db: Database, provider: string): ProviderConfigRow | null {
  return (db.prepare('SELECT * FROM provider_configs WHERE provider = ?').get(provider) as ProviderConfigRow | undefined) ?? null
}

/** Upsert a provider's config (model, apiKey, baseUrl, prompts) */
export function setProviderConfig(
  db: Database,
  provider: string,
  data: Partial<Omit<ProviderConfigRow, 'provider'>>
): void {
  const existing = getProviderConfig(db, provider)
  if (!existing) {
    // Insert with whatever fields are provided
    db.prepare(
      `INSERT INTO provider_configs (provider, apiKeyEncrypted, model, baseUrl, maxTokens, presetPrompt, trendForecastPrompt, trendForecastMorrowPrompt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      provider,
      data.apiKeyEncrypted ?? null,
      data.model ?? null,
      data.baseUrl ?? null,
      data.maxTokens ?? null,
      data.presetPrompt ?? null,
      data.trendForecastPrompt ?? null,
      data.trendForecastMorrowPrompt ?? null
    )
  } else {
    const updates: string[] = []
    const params: Record<string, unknown> = { provider }
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        updates.push(`${key} = @${key}`)
        params[key] = value
      }
    }
    if (updates.length > 0) {
      db.prepare(`UPDATE provider_configs SET ${updates.join(', ')} WHERE provider = @provider`).run(params)
    }
  }
}

/** Get all provider configs as a map */
export function getAllProviderConfigs(db: Database): Record<string, ProviderConfigRow> {
  const rows = db.prepare('SELECT * FROM provider_configs').all() as ProviderConfigRow[]
  const result: Record<string, ProviderConfigRow> = {}
  for (const r of rows) result[r.provider] = r
  return result
}

/** Get list of providers that have API keys configured */
export function getConfiguredProviders(db: Database): string[] {
  const rows = db.prepare(
    'SELECT provider FROM provider_configs WHERE apiKeyEncrypted IS NOT NULL AND LENGTH(apiKeyEncrypted) > 0'
  ).all() as { provider: string }[]
  return rows.map((r) => r.provider)
}

// ── Legacy compat aliases ─────────────────────────────────────────────────────

/** Get the encrypted API key for a specific provider from provider_configs table */
export function getProviderApiKey(db: Database, provider: string): Buffer | null {
  const row = db.prepare('SELECT apiKeyEncrypted FROM provider_configs WHERE provider = ?').get(provider) as { apiKeyEncrypted: Buffer } | undefined
  return row?.apiKeyEncrypted ?? null
}

/** Set (upsert) the encrypted API key for a specific provider */
export function setProviderApiKey(db: Database, provider: string, apiKeyEncrypted: Buffer): void {
  setProviderConfig(db, provider, { apiKeyEncrypted })
}

/** Get a map of which providers have API keys configured */
export function getProvidersWithApiKeys(db: Database): Record<string, boolean> {
  const providers = getConfiguredProviders(db)
  const result: Record<string, boolean> = {}
  for (const p of providers) result[p] = true
  return result
}
