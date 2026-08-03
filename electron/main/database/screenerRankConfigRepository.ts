import type Database from 'better-sqlite3'

export type ScreenerSignalKey = 'crossUp' | 'volAmplified' | 'bullTrend' | 'macdBull' | 'hasTurnover' | 'moneyInflow'
export type ScreenerTieBreaker = 'pctChg' | 'turnoverRate' | 'amount'

export interface ScreenerRankConfig {
  weights: Record<ScreenerSignalKey, number>
  tieBreaker: ScreenerTieBreaker
  normalizeEnabled: boolean
  normalizationCaps: {
    volAmplified: number
    macdBull: number
    hasTurnover: number
    moneyInflow: number
  }
  updatedAt: number
}

const SIGNAL_KEYS: ScreenerSignalKey[] = [
  'crossUp',
  'volAmplified',
  'bullTrend',
  'macdBull',
  'hasTurnover',
  'moneyInflow',
]

const TIE_BREAKERS: ScreenerTieBreaker[] = ['pctChg', 'turnoverRate', 'amount']

export const DEFAULT_SCREENER_RANK_CONFIG: ScreenerRankConfig = {
  weights: {
    crossUp: 1,
    volAmplified: 1,
    bullTrend: 1,
    macdBull: 1,
    hasTurnover: 1,
    moneyInflow: 0,
  },
  tieBreaker: 'pctChg',
  normalizeEnabled: false,
  normalizationCaps: {
    volAmplified: 3,
    macdBull: 0.08,
    hasTurnover: 8,
    moneyInflow: 5,
  },
  updatedAt: 0,
}

interface DbRow {
  id: number
  weights_json: string | null
  tie_breaker: string | null
  normalize_enabled: number | null
  normalization_caps_json: string | null
  updated_at: number | null
}

function safeParseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function normalizeScreenerRankConfig(input: Partial<ScreenerRankConfig> = {}): ScreenerRankConfig {
  const weightsInput = input.weights ?? {}
  const capsInput: Partial<ScreenerRankConfig['normalizationCaps']> = input.normalizationCaps ?? {}
  const weights = SIGNAL_KEYS.reduce<Record<ScreenerSignalKey, number>>((acc, key) => {
    acc[key] = nonNegativeNumber(weightsInput[key], DEFAULT_SCREENER_RANK_CONFIG.weights[key])
    return acc
  }, {} as Record<ScreenerSignalKey, number>)
  const tieBreaker = TIE_BREAKERS.includes(input.tieBreaker as ScreenerTieBreaker)
    ? input.tieBreaker as ScreenerTieBreaker
    : DEFAULT_SCREENER_RANK_CONFIG.tieBreaker
  return {
    weights,
    tieBreaker,
    normalizeEnabled: input.normalizeEnabled === true,
    normalizationCaps: {
      volAmplified: nonNegativeNumber(capsInput.volAmplified, DEFAULT_SCREENER_RANK_CONFIG.normalizationCaps.volAmplified),
      macdBull: nonNegativeNumber(capsInput.macdBull, DEFAULT_SCREENER_RANK_CONFIG.normalizationCaps.macdBull),
      hasTurnover: nonNegativeNumber(capsInput.hasTurnover, DEFAULT_SCREENER_RANK_CONFIG.normalizationCaps.hasTurnover),
      moneyInflow: nonNegativeNumber(capsInput.moneyInflow, DEFAULT_SCREENER_RANK_CONFIG.normalizationCaps.moneyInflow),
    },
    updatedAt: input.updatedAt ?? Date.now(),
  }
}

function rowToConfig(row: DbRow | undefined): ScreenerRankConfig {
  if (!row) return { ...DEFAULT_SCREENER_RANK_CONFIG }
  const rawWeights = safeParseObject(row.weights_json)
  const rawCaps = safeParseObject(row.normalization_caps_json)
  return normalizeScreenerRankConfig({
    weights: rawWeights as Partial<Record<ScreenerSignalKey, number>> as Record<ScreenerSignalKey, number>,
    tieBreaker: row.tie_breaker as ScreenerTieBreaker,
    normalizeEnabled: row.normalize_enabled === 1,
    normalizationCaps: rawCaps as Partial<ScreenerRankConfig['normalizationCaps']> as ScreenerRankConfig['normalizationCaps'],
    updatedAt: row.updated_at ?? 0,
  })
}

function ensureConfigRow(db: Database.Database): void {
  const now = Date.now()
  db.prepare(
    `INSERT OR IGNORE INTO screener_rank_config
      (id, weights_json, tie_breaker, normalize_enabled, normalization_caps_json, updated_at)
     VALUES (1, ?, ?, 0, ?, ?)`
  ).run(
    JSON.stringify(DEFAULT_SCREENER_RANK_CONFIG.weights),
    DEFAULT_SCREENER_RANK_CONFIG.tieBreaker,
    JSON.stringify(DEFAULT_SCREENER_RANK_CONFIG.normalizationCaps),
    now,
  )
}

export function getScreenerRankConfig(db: Database.Database): ScreenerRankConfig {
  ensureConfigRow(db)
  const row = db.prepare('SELECT * FROM screener_rank_config WHERE id = 1').get() as DbRow | undefined
  return rowToConfig(row)
}

export function updateScreenerRankConfig(
  db: Database.Database,
  patch: Partial<ScreenerRankConfig>,
): ScreenerRankConfig {
  const current = getScreenerRankConfig(db)
  const next = normalizeScreenerRankConfig({
    ...current,
    ...patch,
    weights: { ...current.weights, ...(patch.weights ?? {}) },
    normalizationCaps: { ...current.normalizationCaps, ...(patch.normalizationCaps ?? {}) },
    updatedAt: Date.now(),
  })
  db.prepare(
    `UPDATE screener_rank_config
     SET weights_json = ?, tie_breaker = ?, normalize_enabled = ?, normalization_caps_json = ?, updated_at = ?
     WHERE id = 1`
  ).run(
    JSON.stringify(next.weights),
    next.tieBreaker,
    next.normalizeEnabled ? 1 : 0,
    JSON.stringify(next.normalizationCaps),
    next.updatedAt,
  )
  return next
}

export function resetScreenerRankConfig(db: Database.Database): ScreenerRankConfig {
  const next = normalizeScreenerRankConfig({
    ...DEFAULT_SCREENER_RANK_CONFIG,
    updatedAt: Date.now(),
  })
  db.prepare(
    `INSERT OR REPLACE INTO screener_rank_config
      (id, weights_json, tie_breaker, normalize_enabled, normalization_caps_json, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)`
  ).run(
    JSON.stringify(next.weights),
    next.tieBreaker,
    next.normalizeEnabled ? 1 : 0,
    JSON.stringify(next.normalizationCaps),
    next.updatedAt,
  )
  return next
}
