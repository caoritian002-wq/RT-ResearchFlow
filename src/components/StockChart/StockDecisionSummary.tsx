import { useState } from 'react'
import type { StockDecisionContextModel } from './stockDecisionContextModel'
import { StockDecisionActions } from './StockDecisionActions'
import { StockDecisionEvidence } from './StockDecisionEvidence'

interface StockDecisionSummaryProps {
  model: StockDecisionContextModel
  savingAction: string | null
  actionMessage: string | null
  actionError: string | null
  onOpenForecast: () => void
  onBackToDecisionCenter: () => void
  onMarkRead: () => void
  onWatch: () => void
  onDismiss: () => void
  onOpenLifecycle: () => void
  onEditCostPrice: () => void
}

function badgeClass(tone: StockDecisionContextModel['badges'][number]['tone']): string {
  if (tone === 'red') return 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
  if (tone === 'green') return 'border-green-200 bg-green-50 text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300'
  if (tone === 'amber') return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
  if (tone === 'blue') return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300'
  return 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300'
}

export function StockDecisionSummary({
  model,
  savingAction,
  actionMessage,
  actionError,
  onOpenForecast,
  onBackToDecisionCenter,
  onMarkRead,
  onWatch,
  onDismiss,
  onOpenLifecycle,
  onEditCostPrice
}: StockDecisionSummaryProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <section data-testid="stock-decision-summary" className="mb-1.5 shrink-0 rounded-md border border-gray-200 bg-white px-3 py-2 shadow-sm shadow-gray-100/50 dark:border-gray-700 dark:bg-gray-900 dark:shadow-none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1">
            {model.badges.map((badge) => (
              <span key={`${badge.label}-${badge.tone}`} className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${badgeClass(badge.tone)}`}>
                {badge.label}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h2 className="max-w-full truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{model.title}</h2>
            <span className="truncate text-xs text-gray-500 dark:text-gray-400">{model.subtitle}</span>
          </div>
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-gray-600 dark:text-gray-300">{model.reason}</p>
        </div>
        <StockDecisionActions
          model={model}
          savingAction={savingAction}
          actionMessage={actionMessage}
          actionError={actionError}
          onOpenForecast={onOpenForecast}
          onBackToDecisionCenter={onBackToDecisionCenter}
          onMarkRead={onMarkRead}
          onWatch={onWatch}
          onDismiss={onDismiss}
          onOpenLifecycle={onOpenLifecycle}
          onEditCostPrice={onEditCostPrice}
        />
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-[11px] text-slate-500 dark:text-slate-400">{model.trustHint}</div>
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          className="shrink-0 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
        >
          {expanded ? '收起证据' : '展开证据'}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)]">
          <StockDecisionEvidence evidence={model.evidence} />
          <div className="rounded bg-slate-50 px-2 py-1.5 text-xs leading-5 text-slate-600 dark:bg-slate-950/40 dark:text-slate-300">
            {model.trustHint}
            {model.gaps.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {model.gaps.map((gap) => (
                  <span key={gap} className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                    {gap}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
