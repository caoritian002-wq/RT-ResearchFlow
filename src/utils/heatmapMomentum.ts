export interface HeatmapMomentumSnapshot {
  industries: Array<{
    name: string
    weightedChange: number
    subIndustries?: Array<{ name: string; change: number }>
  }>
}

export interface HeatmapHistoryEntry {
  snapshot: HeatmapMomentumSnapshot
  fetchedAt: number
}

export interface IndustryMomentumMeta {
  mode: 'live' | 'last-session'
  origin: 'live-capture' | 'historical-recovery'
  sourceProvider: 'sina' | 'eastmoney' | 'tushare'
  scope: 'provider-snapshot' | 'shenwan-l1' | 'shenwan-l1-l2'
  boundary: 'live' | 'lunch-close' | 'market-close'
  capturedAt: number
  tradeDate: string
  windowMinutes: number
  coverage?: {
    l1: { available: number; total: number }
    l2: { available: number; total: number }
  }
}

export interface PersistedIndustryMomentum {
  version: 2
  momentum: Record<string, number>
  capturedAt: number
  tradeDate: string
  windowMinutes: number
  origin: IndustryMomentumMeta['origin']
  sourceProvider: IndustryMomentumMeta['sourceProvider']
  scope: IndustryMomentumMeta['scope']
  boundary: IndustryMomentumMeta['boundary']
  coverage?: IndustryMomentumMeta['coverage']
}

interface LegacyPersistedIndustryMomentum {
  version: 1
  momentum: Record<string, number>
  capturedAt: number
  tradeDate: string
  windowMinutes: number
}

export type IndustryMomentumPersistenceOptions = Pick<
  IndustryMomentumMeta,
  'origin' | 'sourceProvider' | 'scope' | 'boundary' | 'coverage'
>

const MAX_BASELINE_LAG_MS = 90_000
const MAX_PERSISTED_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60_000
const MAX_MOMENTUM_ITEMS = 500

export function getBeijingDate(timestamp: number): string {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getBeijingMinuteKey(timestamp: number): string {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  const hour = String(date.getUTCHours()).padStart(2, '0')
  const minute = String(date.getUTCMinutes()).padStart(2, '0')
  return `${getBeijingDate(timestamp)}T${hour}:${minute}`
}

export function isInClosingMomentumCaptureWindow(
  timestamp: number,
  windowMinutes: number,
): boolean {
  const date = new Date(timestamp + 8 * 60 * 60 * 1000)
  const day = date.getUTCDay()
  if (day < 1 || day > 5) return false
  const totalMinutes = date.getUTCHours() * 60 + date.getUTCMinutes()
  const normalizedWindow = Math.max(1, Math.min(30, Math.round(windowMinutes)))
  const captureStart = 15 * 60 - normalizedWindow - 2
  return totalMinutes >= captureStart && totalMinutes < 15 * 60
}

function buildChangeMap(snapshot: HeatmapMomentumSnapshot): Map<string, number> {
  const changes = new Map<string, number>()
  for (const industry of snapshot.industries) {
    changes.set(industry.name, industry.weightedChange)
    for (const subIndustry of industry.subIndustries ?? []) {
      changes.set(subIndustry.name, subIndustry.change)
    }
  }
  return changes
}

export function computeIndustryMomentum(
  history: HeatmapHistoryEntry[],
  windowMinutes: number,
  maxBaselineLagMs = MAX_BASELINE_LAG_MS,
): Record<string, number> {
  if (history.length < 2) return {}

  const current = history[history.length - 1]
  const windowMs = Math.max(1, Math.round(windowMinutes)) * 60_000
  const targetTime = current.fetchedAt - windowMs
  let baseline: HeatmapHistoryEntry | undefined

  for (let index = history.length - 2; index >= 0; index -= 1) {
    const candidate = history[index]
    if (candidate.fetchedAt <= targetTime) {
      baseline = candidate
      break
    }
  }

  if (!baseline || targetTime - baseline.fetchedAt > maxBaselineLagMs) return {}

  const baselineChanges = buildChangeMap(baseline.snapshot)
  const currentChanges = buildChangeMap(current.snapshot)
  const momentum: Record<string, number> = {}
  for (const [name, currentChange] of currentChanges) {
    const baselineChange = baselineChanges.get(name)
    if (baselineChange === undefined) continue
    momentum[name] = Number((currentChange - baselineChange).toFixed(3))
  }
  return momentum
}

export function hasMeaningfulIndustryMomentum(momentum: Record<string, number>): boolean {
  return Object.values(momentum).some((delta) => Math.abs(delta) >= 0.001)
}

export function createPersistedIndustryMomentum(
  momentum: Record<string, number>,
  capturedAt: number,
  windowMinutes: number,
  options: IndustryMomentumPersistenceOptions,
): PersistedIndustryMomentum {
  return {
    version: 2,
    momentum: { ...momentum },
    capturedAt,
    tradeDate: getBeijingDate(capturedAt),
    windowMinutes: Math.max(1, Math.min(30, Math.round(windowMinutes))),
    origin: options.origin,
    sourceProvider: options.sourceProvider,
    scope: options.scope,
    boundary: options.boundary,
    ...(options.coverage ? { coverage: options.coverage } : {}),
  }
}

export function parsePersistedIndustryMomentum(
  value: unknown,
  now = Date.now(),
): PersistedIndustryMomentum | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PersistedIndustryMomentum | LegacyPersistedIndustryMomentum>
  if (candidate.version !== 1 && candidate.version !== 2) return null
  const capturedAt = candidate.capturedAt
  const windowMinutes = candidate.windowMinutes
  const tradeDate = candidate.tradeDate
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null
  if (
    capturedAt > now + MAX_CLOCK_SKEW_MS
    || now - capturedAt > MAX_PERSISTED_AGE_MS
  ) return null
  if (typeof tradeDate !== 'string' || tradeDate !== getBeijingDate(capturedAt)) return null
  if (typeof windowMinutes !== 'number' || !Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 30) {
    return null
  }
  if (!candidate.momentum || typeof candidate.momentum !== 'object' || Array.isArray(candidate.momentum)) {
    return null
  }

  const entries = Object.entries(candidate.momentum)
  if (entries.length === 0 || entries.length > MAX_MOMENTUM_ITEMS) return null
  const momentum: Record<string, number> = {}
  for (const [name, delta] of entries) {
    if (!name.trim() || name.length > 100 || !Number.isFinite(delta)) return null
    momentum[name] = delta
  }

  const metadata = candidate.version === 2
    ? parsePersistenceMetadata(candidate)
    : {
        origin: 'live-capture' as const,
        sourceProvider: 'sina' as const,
        scope: 'provider-snapshot' as const,
        boundary: 'live' as const,
      }
  if (!metadata) return null

  return {
    version: 2,
    momentum,
    capturedAt,
    tradeDate,
    windowMinutes,
    ...metadata,
  }
}

function parsePersistenceMetadata(
  candidate: Partial<PersistedIndustryMomentum | LegacyPersistedIndustryMomentum>,
): IndustryMomentumPersistenceOptions | null {
  const value = candidate as Partial<PersistedIndustryMomentum>
  if (value.origin !== 'live-capture' && value.origin !== 'historical-recovery') return null
  if (!['sina', 'eastmoney', 'tushare'].includes(value.sourceProvider ?? '')) return null
  if (!['provider-snapshot', 'shenwan-l1', 'shenwan-l1-l2'].includes(value.scope ?? '')) return null
  if (!['live', 'lunch-close', 'market-close'].includes(value.boundary ?? '')) return null
  if (value.coverage) {
    const counts = [
      value.coverage.l1?.available,
      value.coverage.l1?.total,
      value.coverage.l2?.available,
      value.coverage.l2?.total,
    ]
    if (counts.some((count) => !Number.isInteger(count) || (count as number) < 0)) return null
    if (
      value.coverage.l1.available > value.coverage.l1.total
      || value.coverage.l2.available > value.coverage.l2.total
    ) return null
  }
  return {
    origin: value.origin,
    sourceProvider: value.sourceProvider as IndustryMomentumMeta['sourceProvider'],
    scope: value.scope as IndustryMomentumMeta['scope'],
    boundary: value.boundary as IndustryMomentumMeta['boundary'],
    ...(value.coverage ? { coverage: value.coverage } : {}),
  }
}
