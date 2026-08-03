import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

export function TrendConfirmDialog({
  title,
  description,
  subject,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string
  description: string
  subject: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    const rootWasInert = root?.inert ?? false
    const previousOverflow = document.body.style.overflow
    if (root) root.inert = true
    document.body.style.overflow = 'hidden'
    cancelRef.current?.focus({ preventScroll: true })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (root) root.inert = rootWasInert
      document.body.style.overflow = previousOverflow
      previousFocusRef.current?.focus({ preventScroll: true })
    }
  }, [busy, onCancel])

  const dialog = (
    <div
      data-testid="trend-remove-dialog-overlay"
      className="electron-no-drag fixed inset-0 z-[10020] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[1px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <header className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-base font-semibold text-slate-950 dark:text-slate-50">{title}</h2>
            <span className="rounded bg-rose-50 px-2 py-1 text-[11px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">移出观察池</span>
          </div>
          <p id={descriptionId} className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-300">{description}</p>
        </header>
        <div className="px-5 py-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">{subject}</div>
          <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">已缓存的行情和评分历史不会删除，之后重新加入时仍可复用。</p>
        </div>
        <footer className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-950/50">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel} className="min-h-11 min-w-20 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-45 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">取消</button>
          <button type="button" disabled={busy} onClick={onConfirm} className="flex min-h-11 min-w-28 items-center justify-center gap-2 rounded-md bg-rose-700 px-4 text-sm font-semibold text-white hover:bg-rose-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:opacity-50 dark:bg-rose-600 dark:hover:bg-rose-500">
            {busy && <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" />}
            {busy ? '正在移除' : '确认移除'}
          </button>
        </footer>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
