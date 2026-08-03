import React from 'react'

export interface ConversationWebSearchTrace {
  responseId: string
  calls: Array<{
    id: string
    status: string
    action: {
      type: 'search' | 'open_page' | 'find_in_page'
      queries: string[]
      url: string | null
      pattern: string | null
      sources: string[]
    }
  }>
  citations: Array<{ url: string; title: string; startIndex: number; endIndex: number }>
  sources: Array<{ url: string; title: string | null; cited: boolean }>
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return '网页来源'
  }
}

function actionLabel(type: ConversationWebSearchTrace['calls'][number]['action']['type']): string {
  if (type === 'open_page') return '打开页面'
  if (type === 'find_in_page') return '页内查找'
  return '网页搜索'
}

export function AssistantWebSearchTrace({ trace }: { trace?: ConversationWebSearchTrace }): React.ReactElement | null {
  if (!trace || (!trace.sources.length && !trace.calls.length)) return null
  const citedCount = trace.sources.filter((source) => source.cited).length
  const sources = [...trace.sources].sort((left, right) => Number(right.cited) - Number(left.cited))
  return (
    <details data-testid="ai-discussion-web-search-trace" className="mt-3 border-t border-slate-200 pt-2 text-[11px] dark:border-slate-700">
      <summary className="cursor-pointer select-none font-medium text-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-cyan-300">
        本轮引用来源 {citedCount || trace.sources.length} 条 · 搜索动作 {trace.calls.length} 次
      </summary>
      <div className="mt-2 space-y-3">
        <div className="max-h-52 divide-y divide-slate-200 overflow-y-auto border-y border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {sources.map((source) => (
            <button
              key={source.url}
              type="button"
              onClick={() => void window.api.openExternal(source.url)}
              className="flex min-h-10 w-full items-center justify-between gap-3 px-1.5 py-2 text-left hover:bg-white/70 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 dark:hover:bg-slate-900/60"
            >
              <span className="min-w-0">
                <span className="block break-words font-medium text-slate-700 dark:text-slate-200">{source.title || sourceHost(source.url)}</span>
                <span className="block truncate text-slate-400">{sourceHost(source.url)}</span>
              </span>
              <span className="shrink-0 text-slate-400">{source.cited ? '已引用' : '检索来源'}</span>
            </button>
          ))}
        </div>
        <details>
          <summary className="cursor-pointer select-none text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-slate-400">查看工具调用</summary>
          <div className="mt-1 space-y-1 border-l-2 border-slate-200 pl-2 dark:border-slate-700">
            {trace.calls.map((call, index) => {
              const parameter = call.action.queries.length
                ? call.action.queries.join(' / ')
                : call.action.pattern || call.action.url || '未记录参数'
              return (
                <div key={call.id || `${call.action.type}-${index}`} className="grid gap-0.5 py-1 sm:grid-cols-[64px_minmax(0,1fr)]">
                  <span className="font-medium text-slate-600 dark:text-slate-300">{actionLabel(call.action.type)}</span>
                  <span className="break-all text-slate-400">{parameter}</span>
                </div>
              )
            })}
          </div>
        </details>
      </div>
    </details>
  )
}
