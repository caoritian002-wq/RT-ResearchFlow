import { useMemo, useState } from 'react'
import type { DecisionSignalItem } from './SignalCard'
import type { DecisionActionItem } from './decisionActionQueue'
import type { PortfolioHoldingRow } from './portfolioCommandModel'
import {
  buildStockJudgmentModel,
  JUDGMENT_TAG_OPTIONS,
  type StockEvidenceItem,
  type StockJudgmentTag,
} from './stockJudgmentModel'

interface StockJudgmentPanelProps {
  open: boolean
  signal: DecisionSignalItem | null
  actionItem?: DecisionActionItem | null
  relatedSignals?: DecisionSignalItem[]
  holdings?: PortfolioHoldingRow[] | null
  saving?: boolean
  error?: string | null
  onClose: () => void
  onOpenEventDetail: (signal: DecisionSignalItem) => void
  onNavigateStock: (signal: DecisionSignalItem) => void
  onDiscussSignal?: (signal: DecisionSignalItem) => void
  onSubmitJudgment: (payload: {
    signal: DecisionSignalItem
    tag: StockJudgmentTag
    note: string
    tsCode: string
    stockName: string
    relatedSignalIds: number[]
    evidenceSnapshot: {
      primaryTitle: string
      primarySummary: string
      sourceCount: number
      maxPriority: number
      trustHint: string
      evidence: StockEvidenceItem[]
    }
  }) => void
}

function evidenceClass(status: 'ready' | 'missing' | 'blocked'): string {
  if (status === 'ready') return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-200'
  if (status === 'missing') return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'
  return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300'
}

function evidenceLabel(status: 'ready' | 'missing' | 'blocked'): string {
  if (status === 'ready') return '有'
  if (status === 'missing') return '缺'
  return '受阻'
}

export function StockJudgmentPanel({
  open,
  signal,
  actionItem,
  relatedSignals,
  holdings,
  saving = false,
  error = null,
  onClose,
  onOpenEventDetail,
  onNavigateStock,
  onDiscussSignal,
  onSubmitJudgment,
}: StockJudgmentPanelProps) {
  const [tag, setTag] = useState<StockJudgmentTag>('watch')
  const [note, setNote] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const model = useMemo(() => {
    if (!signal) return null
    return buildStockJudgmentModel(signal, {
      relatedSignals,
      holdings,
      actionItem,
    })
  }, [actionItem, holdings, relatedSignals, signal])

  if (!open || !signal || !model) return null

  const canJudge = signal.id > 0

  return (
    <div className="fixed inset-0 z-[9999] flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
        data-testid="stock-judgment-panel"
      >
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-cyan-700 dark:text-cyan-300">Stock Judgment</div>
              <h2 className="mt-1 truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                {model.stockName}
                <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">{model.tsCode}</span>
              </h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {model.isPortfolio ? '持仓' : '观察'} · P{model.maxPriority} · {model.sourceCount} 条线索
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-200 px-2 py-1 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >关闭</button>
          </div>
        </div>

        <div data-testid="stock-judgment-scroll" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </div>
          )}

          <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">为何出现</div>
            <div className="mt-2 text-sm font-medium text-slate-900 dark:text-slate-100">{model.whyTitle}</div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{model.whySummary}</p>
            {model.whyReasons.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {model.whyReasons.map((reason) => (
                  <span key={reason} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{reason}</span>
                ))}
              </div>
            )}
            <div className="mt-2 rounded-md bg-slate-50 px-2 py-1.5 text-xs leading-5 text-slate-600 dark:bg-slate-950/40 dark:text-slate-300">
              {model.trustHint}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">证据与缺口</div>
            <div className="mt-2 space-y-2">
              {model.evidence.map((item) => (
                <div key={item.key} className={`rounded-md border px-2.5 py-2 text-xs ${evidenceClass(item.status)}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{item.label}</span>
                    <span>{evidenceLabel(item.status)}</span>
                  </div>
                  <div className="mt-0.5 opacity-90">{item.detail}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">我的结论</div>
            {!canJudge && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">合成待办仅支持去走势图补证据, 不能直接写处置结论。</p>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {JUDGMENT_TAG_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  disabled={!canJudge || saving}
                  onClick={() => setTag(option.value)}
                  className={`rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    tag === option.value
                      ? 'border-cyan-700 bg-cyan-700 text-white dark:border-cyan-400 dark:bg-cyan-400 dark:text-slate-950'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300'
                  }`}
                >{option.label}</button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              {JUDGMENT_TAG_OPTIONS.find((item) => item.value === tag)?.hint}
            </p>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={!canJudge || saving}
              rows={3}
              placeholder="可选: 记录依据、回访点或仍缺的证据"
              className="mt-2 w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-700 outline-none focus:border-cyan-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canJudge || saving}
                onClick={() => onSubmitJudgment({
                  signal: model.primarySignal,
                  tag,
                  note: note.trim(),
                  tsCode: model.tsCode,
                  stockName: model.stockName,
                  relatedSignalIds: model.relatedSignals.filter((item) => item.id > 0).map((item) => item.id),
                  evidenceSnapshot: {
                    primaryTitle: model.whyTitle,
                    primarySummary: model.whySummary,
                    sourceCount: model.sourceCount,
                    maxPriority: model.maxPriority,
                    trustHint: model.trustHint,
                    evidence: model.evidence,
                  },
                })}
                className="rounded-md bg-cyan-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
              >{saving ? '保存中…' : '保存结论'}</button>
              <button
                type="button"
                onClick={() => onNavigateStock(model.primarySignal)}
                className="rounded-md border border-slate-900 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
              >看走势</button>
              {onDiscussSignal && <button type="button" data-testid="stock-judgment-discuss" onClick={() => onDiscussSignal(model.primarySignal)} className="rounded-md border border-cyan-200 px-3 py-1.5 text-xs font-semibold text-cyan-700 hover:bg-cyan-50 dark:border-cyan-800 dark:text-cyan-300">讨论此信号</button>}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <button
              type="button"
              onClick={() => setAdvancedOpen((value) => !value)}
              className="flex w-full items-center justify-between text-sm font-semibold text-slate-900 dark:text-slate-100"
            >
              <span>高级</span>
              <span className="text-xs font-normal text-slate-500">{advancedOpen ? '收起' : '展开'}</span>
            </button>
            {advancedOpen && (
              <div className="mt-3 space-y-2">
                <button
                  type="button"
                  onClick={() => onOpenEventDetail(model.primarySignal)}
                  className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  事件明细（原信号生命周期流水, 非总结）
                </button>
                <div className="text-xs text-slate-500 dark:text-slate-400">子线索</div>
                <ul className="space-y-1.5">
                  {model.relatedSignals.map((item) => (
                    <li key={item.id} className="rounded border border-slate-100 px-2 py-1.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
                      <span className="font-medium text-slate-800 dark:text-slate-100">P{item.priority}</span>
                      <span className="mx-1 text-slate-400">·</span>
                      {item.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
