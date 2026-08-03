import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import { quoteColor, useMarketIndexQuotes, type IndexQuote } from './useMarketIndexQuotes'

type MarketContextVariant = 'card' | 'panel' | 'floating'

interface MarketContextWidgetProps {
  variant?: MarketContextVariant
}

function marketToneClass(change: number): string {
  if (change > 0.15) return 'border-red-300 bg-red-50 text-red-700 shadow-red-950/10 dark:border-red-800 dark:bg-red-950/90 dark:text-red-200'
  if (change < -0.15) return 'border-emerald-300 bg-emerald-50 text-emerald-700 shadow-emerald-950/10 dark:border-emerald-800 dark:bg-emerald-950/90 dark:text-emerald-200'
  return 'border-slate-300 bg-white text-slate-700 shadow-slate-950/10 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
}

export function MarketContextWidget({ variant = 'card' }: MarketContextWidgetProps) {
  const heatmapSnapshot = useAppStore(s => s.heatmapSnapshot)
  const initHeatmapPolling = useAppStore(s => s.initHeatmapPolling)
  const heatmapPollingStarted = useAppStore(s => s.heatmapPollingStarted)
  const { quotes } = useMarketIndexQuotes()
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!heatmapPollingStarted) initHeatmapPolling()
  }, [heatmapPollingStarted, initHeatmapPolling])

  const marketStats = useMemo(() => {
    const industries = heatmapSnapshot?.industries ?? []
    const upIndustries = industries.filter(item => item.weightedChange > 0).length
    const downIndustries = industries.filter(item => item.weightedChange < 0).length
    const leader = [...industries].sort((a, b) => b.weightedChange - a.weightedChange)[0]
    const laggard = [...industries].sort((a, b) => a.weightedChange - b.weightedChange)[0]
    return { total: industries.length, upIndustries, downIndustries, leader, laggard }
  }, [heatmapSnapshot])

  const averageIndexChange = quotes.length > 0
    ? quotes.reduce((sum, quote) => sum + quote.change, 0) / quotes.length
    : 0

  if (variant === 'floating') {
    return (
      <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-2">
        {expanded && (
          <div className="w-[340px] origin-bottom-right rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-2xl shadow-slate-950/15 backdrop-blur animate-[marketContextPop_180ms_ease-out] dark:border-slate-800 dark:bg-slate-950/95">
            <MarketContextContent quotes={quotes} marketStats={marketStats} compact={false} floating onClose={() => setExpanded(false)} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded(value => !value)}
          className={`group relative flex h-14 w-14 items-center justify-center rounded-full border shadow-xl transition-all duration-200 hover:-translate-y-0.5 hover:shadow-2xl focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 focus:ring-offset-slate-50 dark:focus:ring-offset-slate-950 ${marketToneClass(averageIndexChange)}`}
          aria-label={expanded ? '收起市场环境' : '展开市场环境'}
          aria-expanded={expanded}
        >
          <span className="absolute inset-1 rounded-full border border-white/70 dark:border-white/10" />
          <svg className="relative h-7 w-7" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 20h18" className="opacity-30" />
            <path d="M6 17l4-4 4 2 5-7 3 3" />
            <path d="M19 8h3v3" />
          </svg>
          <span className={`absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white dark:border-slate-950 ${averageIndexChange > 0.15 ? 'bg-red-500' : averageIndexChange < -0.15 ? 'bg-emerald-500' : 'bg-slate-400'}`} />
        </button>
      </div>
    )
  }

  const containerClass = variant === 'panel'
    ? 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900'
    : 'rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/50'

  return (
    <section data-testid={`market-context-${variant}`} className={containerClass}>
      <MarketContextContent quotes={quotes} marketStats={marketStats} compact={variant === 'card'} />
    </section>
  )
}

function MarketContextContent({ quotes, marketStats, compact, floating, onClose }: { quotes: IndexQuote[]; marketStats: { total: number; upIndustries: number; downIndustries: number; leader?: { name: string; weightedChange: number }; laggard?: { name: string; weightedChange: number } }; compact?: boolean; floating?: boolean; onClose?: () => void }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">市场环境</div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{floating ? '这里只看指数背景, 不占用主工作区。' : '指数和行业热度只作为今日信号背景。'}</div>
        </div>
        <div className="flex items-center gap-2">
          {marketStats.total > 0 && (
            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
              {marketStats.total} 行业
            </span>
          )}
          {floating && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="关闭市场环境"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div className={floating ? 'mt-3 space-y-1.5' : 'mt-3 grid gap-2 sm:grid-cols-3'}>
        {quotes.length === 0 ? (
          <div className="col-span-full rounded-md border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">指数数据加载中</div>
        ) : quotes.map(quote => floating ? (
          <div key={quote.code} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/80">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{quote.name}</span>
            <span className="flex items-baseline gap-2 tabular-nums">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{quote.price.toFixed(2)}</span>
              <span className={`text-xs font-medium ${quoteColor(quote.change)}`}>{quote.change > 0 ? '+' : ''}{quote.change.toFixed(2)}%</span>
            </span>
          </div>
        ) : (
          <div key={quote.code} className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-xs text-slate-500 dark:text-slate-400">{quote.name}</div>
            <div className={`mt-1 text-sm font-semibold tabular-nums ${quoteColor(quote.change)}`}>{quote.price.toFixed(2)}</div>
            <div className={`text-xs tabular-nums ${quoteColor(quote.change)}`}>{quote.change > 0 ? '+' : ''}{quote.change.toFixed(2)}%</div>
          </div>
        ))}
      </div>
      {!compact && !floating && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-xs text-slate-500 dark:text-slate-400">行业涨跌</div>
            <div className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-100">上涨 {marketStats.upIndustries} / 下跌 {marketStats.downIndustries}</div>
          </div>
          <div className="rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
            <div className="text-xs text-slate-500 dark:text-slate-400">强弱线索</div>
            <div className="mt-1 text-sm text-slate-800 dark:text-slate-100">
              {marketStats.leader ? `${marketStats.leader.name} ${marketStats.leader.weightedChange.toFixed(2)}%` : '暂无行业数据'}
              {marketStats.laggard ? ` / ${marketStats.laggard.name} ${marketStats.laggard.weightedChange.toFixed(2)}%` : ''}
            </div>
          </div>
        </div>
      )}
      {floating && (
        <div className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          <div>行业上涨 {marketStats.upIndustries} / 下跌 {marketStats.downIndustries}</div>
          <div className="mt-1 truncate">
            强弱线索: {marketStats.leader ? `${marketStats.leader.name} ${marketStats.leader.weightedChange.toFixed(2)}%` : '暂无行业数据'}
            {marketStats.laggard ? ` / ${marketStats.laggard.name} ${marketStats.laggard.weightedChange.toFixed(2)}%` : ''}
          </div>
        </div>
      )}
    </div>
  )
}