import type { ResearchDecisionAction, ResearchDecisionView, ResearchReviewQueueItem } from './industryResearchTypes'

export const DECISION_ACTION_LABELS: Record<ResearchDecisionAction, string> = {
  continue_research: '继续研究',
  wait_financial_validation: '等待财报验证',
  wait_price: '等待价格',
  monitor: '仅跟踪',
  exclude: '排除',
}

export const REVIEW_KIND_LABELS: Record<string, string> = {
  skill_adoption: '规则变化',
  trigger: '触发命中',
  project_boundary: '项目边界',
  hypothesis_due: '假设到期',
  financial_validation: '财报验证',
  monitoring_stale: '监控过期',
  decision_expiry: '决策到期',
  work_item: '研究工作项',
}

export function formatDecisionNumber(value: number | null | undefined, suffix = '', digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '不可用'
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: digits })}${suffix}`
}

export function groupReviewQueue(items: ResearchReviewQueueItem[]): Array<{ kind: string; label: string; items: ResearchReviewQueueItem[] }> {
  const grouped = new Map<string, ResearchReviewQueueItem[]>()
  for (const item of items) grouped.set(item.kind, [...(grouped.get(item.kind) ?? []), item])
  return [...grouped.entries()].map(([kind, group]) => ({ kind, label: REVIEW_KIND_LABELS[kind] ?? kind, items: group }))
}

export function reviewAgenda(items: ResearchReviewQueueItem[], now = Date.now()): Array<{ key: string; label: string; items: ResearchReviewQueueItem[] }> {
  const day = 24 * 60 * 60 * 1000
  const buckets = [
    { key: 'overdue', label: '已逾期', test: (due: number) => due < now },
    { key: 'today', label: '今日', test: (due: number) => due >= now && due < now + day },
    { key: 'week', label: '本周', test: (due: number) => due >= now + day && due < now + 7 * day },
    { key: 'later', label: '更晚', test: (due: number) => due >= now + 7 * day },
  ]
  return buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    items: items.filter((item) => item.dueAt != null && bucket.test(item.dueAt)),
  }))
}

export function encodeDecisionReturnState(view: string, companyId: string | null, securityId: string | null): string {
  const params = new URLSearchParams({ view })
  if (companyId) params.set('company', companyId)
  if (securityId) params.set('security', securityId)
  return `industry-research:decision?${params.toString()}`.slice(0, 128)
}

export function decodeDecisionReturnState(stateKey: string | null | undefined): {
  view: ResearchDecisionView
  companyId: string | null
  securityId: string | null
} | null {
  if (!stateKey || stateKey.length > 128 || !stateKey.startsWith('industry-research:decision?')) return null
  const params = new URLSearchParams(stateKey.slice('industry-research:decision?'.length))
  const view = params.get('view')
  if (!view || !['current', 'review', 'monitoring', 'history'].includes(view)) return null
  const validId = (value: string | null) => value == null || /^[A-Za-z0-9:_-]{1,128}$/.test(value)
  const companyId = params.get('company')
  const securityId = params.get('security')
  if (!validId(companyId) || !validId(securityId)) return null
  return { view: view as ResearchDecisionView, companyId, securityId }
}
