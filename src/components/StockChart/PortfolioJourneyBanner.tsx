import type { FirstPortfolioJourneyState } from '../../store/appStore'

interface PortfolioJourneyBannerProps {
  journey: FirstPortfolioJourneyState
  selectedCode: string
  stockName: string
  isInPortfolio: boolean
  onEditCostPrice: () => void
  onReturnToPortfolio: () => void
  onCancel: () => void
}

export function PortfolioJourneyBanner({
  journey,
  selectedCode,
  stockName,
  isInPortfolio,
  onEditCostPrice,
  onReturnToPortfolio,
  onCancel,
}: PortfolioJourneyBannerProps) {
  const normalizedSelected = selectedCode.includes('.') ? selectedCode.split('.')[0] : selectedCode
  const isCompletedStock = journey.step === 'complete-holding' && journey.stockCode === normalizedSelected

  return (
    <div
      data-testid="portfolio-journey-banner"
      className="mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-y border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-slate-700 dark:border-cyan-900/70 dark:bg-cyan-950/30 dark:text-slate-200"
    >
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-cyan-800 dark:text-cyan-300">
          {isCompletedStock ? '持仓已加入' : '首次持仓任务'}
        </span>
        <span className="ml-2 text-slate-600 dark:text-slate-300">
          {isCompletedStock
            ? `${journey.stockName || stockName} 已进入组合，可补充成本价后返回。`
            : isInPortfolio
              ? `${stockName} 已在持仓中，请选择另一只股票或结束任务。`
              : `已选 ${stockName}，点击右上角「+ 持仓」继续。`}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isCompletedStock && (
          <button
            type="button"
            data-testid="portfolio-journey-edit-cost"
            onClick={onEditCostPrice}
            className="rounded border border-cyan-300 bg-white px-2.5 py-1 font-medium text-cyan-800 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-slate-900 dark:text-cyan-300 dark:hover:bg-cyan-950"
          >
            补成本价
          </button>
        )}
        {journey.step === 'complete-holding' && (
          <button
            type="button"
            data-testid="portfolio-journey-return"
            onClick={onReturnToPortfolio}
            className="rounded bg-cyan-700 px-2.5 py-1 font-medium text-white hover:bg-cyan-800"
          >
            {isCompletedStock ? '暂不填写，返回组合' : '返回组合'}
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="px-1.5 py-1 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
        >
          退出任务
        </button>
      </div>
    </div>
  )
}