import { useEffect, useState } from 'react'
import { AppLogo } from './AppLogo'
import { quoteColor, useMarketIndexQuotes } from '../MarketContext/useMarketIndexQuotes'

function MinimizeIcon() {
  return <span className="block h-px w-3.5 rounded-full bg-current" aria-hidden="true" />
}

function MaximizeIcon({ maximized }: { maximized: boolean }) {
  if (maximized) {
    return (
      <span className="relative block h-3.5 w-3.5" aria-hidden="true">
        <span className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-[2px] border border-current" />
        <span className="absolute right-0 top-0 h-2.5 w-2.5 rounded-[2px] border border-current bg-slate-50 dark:bg-slate-950" />
      </span>
    )
  }
  return <span className="block h-3.5 w-3.5 rounded-[2px] border border-current" aria-hidden="true" />
}

function CloseIcon() {
  return (
    <span className="relative block h-4 w-4" aria-hidden="true">
      <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-full bg-current" />
      <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded-full bg-current" />
    </span>
  )
}

function formatTime(ms: number | null): string {
  if (!ms) return '待更新'
  return `${new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 已更新`
}

export function AppTitleBar({ navigationExpanded }: { navigationExpanded: boolean }) {
  const [isMaximized, setIsMaximized] = useState(false)
  const { quotes, updatedAt } = useMarketIndexQuotes()
  const visibleQuotes = quotes.filter(quote => quote.code === '000001.SH' || quote.code === '399001.SZ' || quote.code === '399006.SZ')

  useEffect(() => {
    let disposed = false
    void window.api.windowControls.isMaximized().then((value) => {
      if (!disposed) setIsMaximized(value)
    })
    const cleanup = window.api.windowControls.onMaximizedChanged(setIsMaximized)
    return () => {
      disposed = true
      cleanup()
    }
  }, [])

  return (
    <header className="electron-drag flex h-16 shrink-0 items-center border-b border-slate-200/80 bg-white/75 text-slate-500 backdrop-blur dark:border-slate-900/80 dark:bg-[#07101f]/90 dark:text-slate-400">
      <div className={`flex h-full shrink-0 items-center border-r border-slate-200/80 px-4 transition-[width] duration-200 motion-reduce:transition-none dark:border-slate-900/80 ${navigationExpanded ? 'w-56 gap-3' : 'w-16 justify-center'}`}>
        <AppLogo size={20} className="electron-no-drag drop-shadow-sm" />
        {navigationExpanded && (
          <span className="min-w-0 truncate text-sm font-semibold text-slate-950 dark:text-slate-100">RT-ResearchFlow</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 px-4">
        <span className="truncate text-sm font-semibold text-slate-950 dark:text-slate-100">{navigationExpanded ? '本地投研工作台' : 'RT-ResearchFlow'}</span>
        {!navigationExpanded && (
          <>
            <span className="h-1 w-1 rounded-full bg-slate-300 dark:bg-slate-700" aria-hidden="true" />
            <span className="truncate text-xs text-slate-400 dark:text-slate-600">本地投研工作台</span>
          </>
        )}
      </div>
      <div className="electron-no-drag ml-auto flex min-w-0 items-center gap-2 px-3">
        {visibleQuotes.map(quote => (
          <span key={quote.code} className="whitespace-nowrap rounded-full border border-slate-200 bg-white px-3 py-1 text-xs tabular-nums text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            {quote.name} <b className="font-medium text-slate-700 dark:text-slate-200">{quote.price.toFixed(2)}</b>
            <span className={`ml-1 font-medium ${quoteColor(quote.change)}`}>{quote.change > 0 ? '+' : ''}{quote.change.toFixed(2)}%</span>
          </span>
        ))}
        <span className="whitespace-nowrap rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          {formatTime(updatedAt)}
        </span>
      </div>
      <div className="electron-no-drag flex h-full items-stretch">
        <button
          type="button"
          className="flex w-10 items-center justify-center text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-inset dark:hover:bg-slate-800 dark:hover:text-slate-100 dark:focus:ring-cyan-300"
          aria-label="最小化窗口"
          title="最小化"
          onClick={() => { void window.api.windowControls.minimize() }}
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          className="flex w-10 items-center justify-center text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-inset dark:hover:bg-slate-800 dark:hover:text-slate-100 dark:focus:ring-cyan-300"
          aria-label={isMaximized ? '还原窗口' : '最大化窗口'}
          title={isMaximized ? '还原' : '最大化'}
          onClick={() => { void window.api.windowControls.toggleMaximize() }}
        >
          <MaximizeIcon maximized={isMaximized} />
        </button>
        <button
          type="button"
          className="flex w-11 items-center justify-center text-slate-500 transition-colors hover:bg-red-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-red-300 focus:ring-inset"
          aria-label="关闭窗口"
          title="关闭"
          onClick={() => { void window.api.windowControls.close() }}
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  )
}
