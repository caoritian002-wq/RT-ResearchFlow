import type { StockDecisionContextModel } from './stockDecisionContextModel'

interface StockDecisionActionsProps {
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

function actionButtonClass(tone: 'blue' | 'amber' | 'slate' | 'red'): string {
  if (tone === 'blue') return 'border-blue-200 text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-950/30'
  if (tone === 'amber') return 'border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30'
  if (tone === 'red') return 'border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/30'
  return 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800'
}

export function StockDecisionActions({
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
}: StockDecisionActionsProps) {
  const disabled = savingAction != null

  const renderButton = (key: string, label: string, tone: 'blue' | 'amber' | 'slate' | 'red', onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${actionButtonClass(tone)}`}
    >
      {savingAction === key ? '处理中...' : label}
    </button>
  )

  return (
    <div data-testid="stock-decision-actions" className="flex min-w-[220px] shrink-0 flex-col items-end gap-1.5">
      <div className="flex flex-wrap justify-end gap-1.5">
        {model.hasSignalContext && model.canHandleSignal && (
          <>
            {model.signalStatus !== 'READ' && renderButton('read', '标记已读', 'blue', onMarkRead)}
            {model.signalStatus !== 'WATCHING' && renderButton('watch', '关注', 'amber', onWatch)}
            {renderButton('dismiss', '忽略', 'slate', onDismiss)}
            {renderButton('lifecycle', '按股研判', 'red', onOpenLifecycle)}
          </>
        )}
        {model.hasSignalContext && !model.canHandleSignal && renderButton('lifecycle', '事件明细', 'slate', onOpenLifecycle)}
        {model.canEditCostPrice && renderButton('cost', model.costPrice == null ? '补充成本价' : '调整成本价', 'amber', onEditCostPrice)}
        {renderButton('forecast', model.primaryActionLabel, 'slate', onOpenForecast)}
        {renderButton('back', '回到今日看板', 'blue', onBackToDecisionCenter)}
      </div>
      {actionMessage && <div className="text-right text-[11px] text-green-600 dark:text-green-400">{actionMessage}</div>}
      {actionError && <div className="max-w-xs text-right text-[11px] text-red-600 dark:text-red-400">{actionError}</div>}
    </div>
  )
}
