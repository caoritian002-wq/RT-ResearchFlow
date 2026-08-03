import type { MessageCenterItem, MessageTone } from './messageCenterModel'

interface MessageCenterDrawerProps {
  open: boolean
  messages: MessageCenterItem[]
  onClose: () => void
}

const toneClass: Record<MessageTone, string> = {
  info: 'border-blue-100 bg-blue-50 text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200',
  success: 'border-emerald-100 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200',
  warning: 'border-amber-100 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200',
  danger: 'border-red-100 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
}

export function MessageCenterDrawer({ open, messages, onClose }: MessageCenterDrawerProps) {
  if (!open) return null

  return (
    <div data-testid="message-center-drawer" className="app-overlay-below-titlebar fixed bottom-0 left-0 right-0 z-[68] flex justify-end">
      <button
        type="button"
        aria-label="关闭消息中心"
        className="absolute inset-0 bg-black/25 dark:bg-black/50"
        onClick={onClose}
      />
      <aside className="relative z-[69] flex h-full w-[min(460px,92vw)] flex-col border-l border-slate-200 bg-white shadow-2xl animate-[slideInFromRight_180ms_ease-out] dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">消息中心</div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">系统消息负责告知, 业务处置仍回到对应模块。</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-400 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            aria-label="关闭消息中心"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {messages.length === 0 ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              暂无需要关注的系统消息。
            </div>
          ) : (
            <div className="space-y-2">
              {messages.map(message => (
                <article key={message.id} className={`rounded-lg border p-3 ${toneClass[message.tone]}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{message.title}</div>
                      <div className="mt-1 text-xs leading-5 opacity-85">{message.description}</div>
                    </div>
                    <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium dark:bg-black/20">{message.source}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 text-xs opacity-80">
                    <span>{message.timeLabel ?? '刚刚'}</span>
                    {message.actionLabel && message.onAction && (
                      <button
                        type="button"
                        onClick={message.onAction}
                        className="rounded border border-current px-2 py-1 font-medium transition-colors hover:bg-white/50 focus:outline-none focus:ring-2 focus:ring-current dark:hover:bg-black/20"
                      >
                        {message.actionLabel}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}