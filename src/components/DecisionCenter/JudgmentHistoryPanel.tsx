import { useCallback, useEffect, useState } from 'react'
import type { StockJudgmentTag } from './stockJudgmentModel'

export interface DecisionJudgmentSummaryItem {
  id: string
  judgmentGroupId: string
  versionNumber: number
  tsCode: string
  stockName: string | null
  tag: StockJudgmentTag
  note: string
  sourceSignalId: number | null
  reviewDueAt: number | null
  createdAt: number
  schemaVersion: number
  versionCount: number
  sourceSignalAvailable: boolean
}

interface JudgmentHistoryPanelProps {
  open: boolean
  onClose: () => void
  initialJudgmentId?: string | null
  onDiscuss?: (judgment: DecisionJudgmentSummaryItem) => void
}

const PAGE_SIZE = 12
const TAG_LABELS: Record<StockJudgmentTag, string> = {
  watch: '继续观察',
  risk_off: '风险规避',
  noise: '噪音/忽略',
  insufficient: '信息不足',
  done: '已处理有效',
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms))
}

function reviewStatus(reviewDueAt: number | null): string | null {
  if (reviewDueAt == null) return null
  return reviewDueAt <= Date.now() ? `已到期 · ${formatTime(reviewDueAt)}` : `计划回访 · ${formatTime(reviewDueAt)}`
}

export function JudgmentHistoryPanel({ open, onClose, initialJudgmentId = null, onDiscuss }: JudgmentHistoryPanelProps) {
  const [tag, setTag] = useState<'all' | StockJudgmentTag>('all')
  const [items, setItems] = useState<DecisionJudgmentSummaryItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [correctionTag, setCorrectionTag] = useState<StockJudgmentTag>('watch')
  const [correctionNote, setCorrectionNote] = useState('')
  const [correctionSaving, setCorrectionSaving] = useState(false)
  const [detail, setDetail] = useState<(DecisionJudgmentSummaryItem & {
    relatedSignalIds: number[]
    evidenceSnapshot: {
      primaryTitle: string
      primarySummary: string
      sourceCount: number
      maxPriority: number
      trustHint: string
      evidence: Array<{ key: string; label: string; status: 'ready' | 'missing' | 'blocked'; detail: string }>
    }
    versions: DecisionJudgmentSummaryItem[]
  }) | null>(null)

  const loadList = useCallback(async (nextOffset: number) => {
    setLoading(true)
    setError(null)
    try {
      const response = await window.api.decision.listJudgments({
        tags: tag === 'all' ? undefined : [tag],
        offset: nextOffset,
        limit: PAGE_SIZE,
      })
      if (!response.ok || !response.data) throw new Error(response.message || response.error || '加载判断记录失败')
      setItems(response.data.items as DecisionJudgmentSummaryItem[])
      setTotal(response.data.total)
      setOffset(response.data.offset)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [tag])

  useEffect(() => {
    if (!open) return
    setDetail(null)
    void loadList(0)
  }, [loadList, open])

  const openDetail = async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const response = await window.api.decision.getJudgment(id)
      if (!response.ok || !response.data) throw new Error(response.message || response.error || '打开判断详情失败')
      setDetail(response.data as typeof detail)
      setCorrectionOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && initialJudgmentId) void openDetail(initialJudgmentId)
  }, [initialJudgmentId, open])

  const saveCorrection = async () => {
    if (!detail) return
    setCorrectionSaving(true)
    setError(null)
    try {
      const response = await window.api.decision.saveJudgment({
        requestId: crypto.randomUUID(),
        judgmentGroupId: detail.judgmentGroupId,
        tsCode: detail.tsCode,
        stockName: detail.stockName ?? undefined,
        tag: correctionTag,
        note: correctionNote.trim(),
        sourceSignalId: detail.sourceSignalAvailable ? detail.sourceSignalId ?? undefined : undefined,
        relatedSignalIds: detail.relatedSignalIds,
        evidenceSnapshot: detail.evidenceSnapshot,
        reviewDueAt: detail.reviewDueAt,
      })
      if (!response.ok || !response.data) throw new Error(response.message || response.error || '修正判断失败')
      setCorrectionNote('')
      await openDetail(response.data.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCorrectionSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[9985] flex justify-end" data-testid="judgment-history-panel">
      <button type="button" aria-label="关闭判断记录" className="absolute inset-0 bg-slate-950/40" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-[500px] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
        <header className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">Judgment Ledger</div>
              <h2 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">{detail ? `${detail.stockName || detail.tsCode} · v${detail.versionNumber}` : '判断记录'}</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail ? `共 ${detail.versionCount} 个不可变版本` : `共 ${total} 组判断`}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md border border-slate-200 px-2.5 py-1 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">关闭</button>
          </div>
          {!detail && (
            <select value={tag} onChange={(event) => setTag(event.target.value as typeof tag)} className="mt-3 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-900">
              <option value="all">全部标签</option>
              {(Object.keys(TAG_LABELS) as StockJudgmentTag[]).map((value) => <option key={value} value={value}>{TAG_LABELS[value]}</option>)}
            </select>
          )}
        </header>
        <div data-testid="judgment-history-scroll" className="min-h-0 flex-1 overflow-y-auto p-4">
          {detail && <button type="button" onClick={() => setDetail(null)} className="mb-3 text-xs font-semibold text-cyan-700 dark:text-cyan-300">返回判断列表</button>}
          {error && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
          {loading && <div className="py-8 text-center text-sm text-slate-500">正在加载判断记录…</div>}
          {!loading && detail && (
            <div className="space-y-3">
              <section className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex items-center justify-between text-xs text-slate-500"><span>{TAG_LABELS[detail.tag]}</span><span>{formatTime(detail.createdAt)}</span></div>
                <h3 className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{detail.evidenceSnapshot.primaryTitle}</h3>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{detail.note || '无备注'}</p>
                {reviewStatus(detail.reviewDueAt) && <p className={`mt-2 text-xs font-semibold ${detail.reviewDueAt! <= Date.now() ? 'text-amber-700 dark:text-amber-300' : 'text-cyan-700 dark:text-cyan-300'}`}>{reviewStatus(detail.reviewDueAt)}</p>}
                <p className="mt-2 text-[11px] text-slate-400">{detail.sourceSignalAvailable ? '来源信号可用' : '来源信号已不可用或未绑定'} · {detail.evidenceSnapshot.trustHint}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" data-testid="judgment-correct-button" onClick={() => { setCorrectionTag(detail.tag); setCorrectionNote(''); setCorrectionOpen((value) => !value) }} className="rounded-md border border-cyan-200 px-2.5 py-1.5 text-xs font-semibold text-cyan-700 dark:border-cyan-900/60 dark:text-cyan-300">修正判断</button>
                  {onDiscuss && <button type="button" data-testid="judgment-discuss-button" onClick={() => onDiscuss(detail)} className="rounded-md bg-cyan-700 px-2.5 py-1.5 text-xs font-semibold text-white">讨论此判断</button>}
                </div>
                {correctionOpen && <div className="mt-3 space-y-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <select value={correctionTag} onChange={(event) => setCorrectionTag(event.target.value as StockJudgmentTag)} className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-900">{(Object.keys(TAG_LABELS) as StockJudgmentTag[]).map((value) => <option key={value} value={value}>{TAG_LABELS[value]}</option>)}</select>
                  <textarea data-testid="judgment-correction-note" value={correctionNote} onChange={(event) => setCorrectionNote(event.target.value)} rows={3} placeholder="记录本次修正依据" className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm dark:border-slate-700 dark:bg-slate-900" />
                  <button type="button" data-testid="judgment-correction-submit" disabled={correctionSaving} onClick={() => { void saveCorrection() }} className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{correctionSaving ? '保存中…' : '追加修正版'}</button>
                </div>}
              </section>
              <section className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                <div className="text-sm font-semibold">版本记录</div>
                <div className="mt-2 space-y-1.5">{detail.versions.map((version) => (
                  <button key={version.id} type="button" onClick={() => { void openDetail(version.id) }} className="flex w-full items-center justify-between rounded border border-slate-100 px-2.5 py-2 text-left text-xs dark:border-slate-800">
                    <span>v{version.versionNumber} · {TAG_LABELS[version.tag]}</span><span className="text-slate-400">{formatTime(version.createdAt)}</span>
                  </button>
                ))}</div>
              </section>
            </div>
          )}
          {!loading && !detail && items.length === 0 && <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500 dark:border-slate-700">暂无判断记录，请从组合待办完成首个研判。</div>}
          {!loading && !detail && items.length > 0 && <div className="space-y-2">{items.map((item) => (
            <article key={item.id} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="text-xs text-slate-500">{item.stockName || item.tsCode} · {TAG_LABELS[item.tag]} · v{item.versionNumber}/{item.versionCount}</div><p className="mt-1 line-clamp-2 text-sm text-slate-800 dark:text-slate-200">{item.note || '无备注'}</p>{reviewStatus(item.reviewDueAt) && <p className={`mt-1 text-[11px] font-semibold ${item.reviewDueAt! <= Date.now() ? 'text-amber-700 dark:text-amber-300' : 'text-cyan-700 dark:text-cyan-300'}`}>{reviewStatus(item.reviewDueAt)}</p>}<p className="mt-1 text-[11px] text-slate-400">{formatTime(item.createdAt)}</p></div>
                <button type="button" onClick={() => { void openDetail(item.id) }} className="shrink-0 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white dark:bg-slate-100 dark:text-slate-900">详情</button>
              </div>
            </article>
          ))}</div>}
        </div>
        {!detail && total > PAGE_SIZE && <footer className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs dark:border-slate-800"><span>{offset + 1}-{Math.min(offset + PAGE_SIZE, total)} / {total}</span><div className="flex gap-2"><button type="button" disabled={offset === 0} onClick={() => { void loadList(Math.max(0, offset - PAGE_SIZE)) }} className="rounded border px-2.5 py-1 disabled:opacity-40">上一页</button><button type="button" disabled={offset + PAGE_SIZE >= total} onClick={() => { void loadList(offset + PAGE_SIZE) }} className="rounded border px-2.5 py-1 disabled:opacity-40">下一页</button></div></footer>}
      </aside>
    </div>
  )
}
