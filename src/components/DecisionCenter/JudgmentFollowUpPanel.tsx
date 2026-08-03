import { useState } from 'react'
import type { StockJudgmentTag } from './stockJudgmentModel'

export interface DecisionJudgmentFollowUpTaskItem {
  judgmentId: string
  judgmentGroupId: string
  tsCode: string
  stockName: string | null
  tag: StockJudgmentTag
  note: string
  reviewDueAt: number
  createdAt: number
  overdueMs: number
  status: 'due'
}

type FollowUpAction = 'maintain' | 'revise' | 'close'

interface JudgmentFollowUpPanelProps {
  items: DecisionJudgmentFollowUpTaskItem[]
  loading: boolean
  error: string | null
  onCompleted: () => void
}

const TAG_LABELS: Record<StockJudgmentTag, string> = {
  watch: '继续观察',
  risk_off: '风险规避',
  noise: '噪音/忽略',
  insufficient: '信息不足',
  done: '结束观察',
}

function overdueLabel(overdueMs: number): string {
  const days = Math.floor(overdueMs / 86_400_000)
  if (days > 0) return `逾期 ${days} 天`
  const hours = Math.max(1, Math.floor(overdueMs / 3_600_000))
  return `逾期 ${hours} 小时`
}

export function JudgmentFollowUpPanel({ items, loading, error, onCompleted }: JudgmentFollowUpPanelProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [action, setAction] = useState<FollowUpAction>('maintain')
  const [tag, setTag] = useState<StockJudgmentTag>('watch')
  const [note, setNote] = useState('')
  const [nextDays, setNextDays] = useState(7)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  if (!loading && items.length === 0 && !error) return null

  const openTask = (item: DecisionJudgmentFollowUpTaskItem) => {
    setActiveId(activeId === item.judgmentId ? null : item.judgmentId)
    setAction('maintain')
    setTag(item.tag)
    setNote('')
    setNextDays(7)
    setSubmitError(null)
  }

  const complete = async (item: DecisionJudgmentFollowUpTaskItem) => {
    setSaving(true)
    setSubmitError(null)
    try {
      const response = await window.api.decision.completeJudgmentFollowUp({
        requestId: crypto.randomUUID(),
        judgmentId: item.judgmentId,
        action,
        tag: action === 'revise' ? tag : undefined,
        note: note.trim() || undefined,
        nextReviewDueAt: action === 'close' ? null : Date.now() + nextDays * 86_400_000,
      })
      if (!response.ok) throw new Error(response.message || response.error || '完成回访失败')
      setActiveId(null)
      onCompleted()
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section data-testid="judgment-follow-up-panel" className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/20">
      <header className="flex items-center justify-between gap-3 border-b border-amber-200/70 px-3 py-2 dark:border-amber-900/50">
        <div>
          <h2 className="text-sm font-extrabold text-slate-900 dark:text-slate-100">待回访 ({items.length})</h2>
          <p className="text-[11px] text-slate-500 dark:text-slate-400">到期判断 · 最早优先</p>
        </div>
        {loading && <span className="text-xs text-slate-500">刷新中...</span>}
      </header>
      {error && <div className="px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>}
      <div className="max-h-[360px] space-y-2 overflow-y-auto p-2">
        {items.map((item) => (
          <article key={item.judgmentId} className="rounded-md border border-amber-200 bg-white p-2.5 dark:border-amber-900/50 dark:bg-slate-900">
            <button type="button" onClick={() => openTask(item)} className="w-full text-left">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-bold text-slate-900 dark:text-slate-100">{item.stockName || item.tsCode}</span>
                <span className="shrink-0 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{overdueLabel(item.overdueMs)}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{TAG_LABELS[item.tag]} · {item.note || '无备注'}</div>
            </button>
            {activeId === item.judgmentId && (
              <div className="mt-2 space-y-2 border-t border-slate-100 pt-2 dark:border-slate-800">
                <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-800">
                  {([['maintain', '维持判断'], ['revise', '修正判断'], ['close', '结束观察']] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setAction(value)} className={`rounded px-1.5 py-1 text-[11px] font-semibold ${action === value ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 dark:text-slate-400'}`}>{label}</button>
                  ))}
                </div>
                {action === 'revise' && <select value={tag} onChange={(event) => setTag(event.target.value as StockJudgmentTag)} className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950">{(Object.keys(TAG_LABELS) as StockJudgmentTag[]).filter((value) => value !== 'done').map((value) => <option key={value} value={value}>{TAG_LABELS[value]}</option>)}</select>}
                {action !== 'close' && <select value={nextDays} onChange={(event) => setNextDays(Number(event.target.value))} className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"><option value={3}>3 天后再回访</option><option value={7}>7 天后再回访</option><option value={14}>14 天后再回访</option></select>}
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} placeholder="记录本次回访依据" className="w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950" />
                {submitError && <p className="text-xs text-red-600 dark:text-red-300">{submitError}</p>}
                <button type="button" disabled={saving} onClick={() => { void complete(item) }} className="w-full rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">{saving ? '提交中...' : '完成回访'}</button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}