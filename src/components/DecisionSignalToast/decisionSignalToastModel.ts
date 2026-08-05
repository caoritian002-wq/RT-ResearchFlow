export interface DecisionSignalToastSignal {
  id: number
  sourceModule: string
  priority: number
  title: string
  summary: string
  sourceRefJson: string | null
  signalTime: number
}

export interface DecisionSignalToastSettings {
  decision_notify_in_app_enabled?: number
  decision_notify_min_priority?: number
}

export interface DecisionSignalToastBatch {
  primary: DecisionSignalToastSignal
  additionalCount: number
  total: number
}

interface DecisionSignalNewsReference {
  briefingId: number | null
  sourceName: string | null
}

const SOURCE_LABELS: Record<string, string> = {
  news: '资讯情报',
  ai: 'AI 分析',
  short_term: '短线策略',
  trend: '长线趋势',
  market: '市场监测',
  sector_flow: '板块资金',
  manual: '手动记录',
}

function notificationPriority(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 4
  return Math.max(3, Math.min(5, Math.round(parsed)))
}

export function shouldShowDecisionSignalToast(
  signal: DecisionSignalToastSignal,
  settings: DecisionSignalToastSettings | null,
): boolean {
  if ((settings?.decision_notify_in_app_enabled ?? 1) !== 1) return false
  if (signal.sourceModule !== 'news') return false
  if (parseDecisionSignalBriefingId(signal) === null) return false
  return signal.priority >= notificationPriority(settings?.decision_notify_min_priority ?? 4)
}

function parseDecisionSignalNewsReference(signal: DecisionSignalToastSignal): DecisionSignalNewsReference | null {
  if (signal.sourceModule !== 'news' || !signal.sourceRefJson) return null
  try {
    const parsed = JSON.parse(signal.sourceRefJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const briefingId = typeof record.briefingId === 'number'
      && Number.isSafeInteger(record.briefingId)
      && record.briefingId > 0
      ? record.briefingId
      : null
    const sourceName = typeof record.sourceName === 'string'
      && record.sourceName.trim().length > 0
      && record.sourceName.trim().length <= 80
      ? record.sourceName.trim()
      : null
    return { briefingId, sourceName }
  } catch {
    return null
  }
}

export function parseDecisionSignalBriefingId(signal: DecisionSignalToastSignal): number | null {
  return parseDecisionSignalNewsReference(signal)?.briefingId ?? null
}

export function parseDecisionSignalSourceName(signal: DecisionSignalToastSignal): string | null {
  if (!signal.sourceRefJson) return null
  try {
    const parsed = JSON.parse(signal.sourceRefJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const sourceName = (parsed as Record<string, unknown>).sourceName
    if (typeof sourceName !== 'string') return null
    const normalized = sourceName.replace(/\s+/g, ' ').trim()
    return normalized ? normalized.slice(0, 60) : null
  } catch {
    return null
  }
}

export function decisionSignalSourceLabel(signal: DecisionSignalToastSignal): string {
  return parseDecisionSignalNewsReference(signal)?.sourceName
    ?? SOURCE_LABELS[signal.sourceModule]
    ?? '决策信号'
}

export function buildDecisionSignalToastBatch(
  signals: DecisionSignalToastSignal[],
): DecisionSignalToastBatch | null {
  const unique = new Map<number, DecisionSignalToastSignal>()
  for (const signal of signals) {
    const previous = unique.get(signal.id)
    if (
      !previous
      || signal.priority > previous.priority
      || (signal.priority === previous.priority && signal.signalTime > previous.signalTime)
    ) {
      unique.set(signal.id, signal)
    }
  }

  const ordered = [...unique.values()].sort((left, right) => (
    right.priority - left.priority
    || right.signalTime - left.signalTime
    || right.id - left.id
  ))
  if (ordered.length === 0) return null
  return {
    primary: ordered[0],
    additionalCount: ordered.length - 1,
    total: ordered.length,
  }
}
