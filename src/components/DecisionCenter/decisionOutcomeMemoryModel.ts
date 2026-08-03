/** FR-234 前端展示模型: 消费 decision:getOutcomeMemory */

export type OutcomeLabel = 'aligned' | 'mixed' | 'misaligned' | 'blocked'

export interface DecisionOutcomeSampleView {
  tsCode: string
  stockName: string | null
  tag: string
  judgmentAt: number
  signalId: number
  title: string
  note: string
  forwardReturnPct: number | null
  outcomeLabel: OutcomeLabel
  outcomeReason: string
}

export interface DecisionOutcomeMemoryData {
  rangeDays: number
  horizonDays: number
  generatedAt: number
  sampleSize: number
  evaluableSize: number
  samples: DecisionOutcomeSampleView[]
  bias: {
    byTag: Array<{
      tag: string
      total: number
      evaluable: number
      aligned: number
      misaligned: number
      mixed: number
      blocked: number
    }>
    insufficientSample: boolean
    hint: string
  }
}

const TAG_LABEL: Record<string, string> = {
  watch: '继续观察',
  risk_off: '风险规避',
  noise: '噪音/忽略',
  insufficient: '信息不足',
  done: '已处理有效',
}

const OUTCOME_LABEL: Record<OutcomeLabel, string> = {
  aligned: '方向一致',
  mixed: '混合',
  misaligned: '方向相反',
  blocked: '不可评估',
}

export function judgmentTagLabel(tag: string): string {
  return TAG_LABEL[tag] ?? tag
}

export function outcomeLabelText(label: OutcomeLabel): string {
  return OUTCOME_LABEL[label] ?? label
}

export function formatOutcomeReturn(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value).toFixed(2)
  if (value > 0) return `+${abs}%`
  if (value < 0) return `-${abs}%`
  return `${abs}%`
}

export function formatJudgmentTime(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${m}-${day}`
}
