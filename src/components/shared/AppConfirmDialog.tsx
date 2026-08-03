import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type AppConfirmDialogTone = 'default' | 'warning' | 'danger'

interface AppConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  children?: ReactNode
  tone?: AppConfirmDialogTone
  statusLabel?: string
  confirmLabel?: string
  cancelLabel?: string
  busy?: boolean
  error?: string | null
  testId?: string
  onCancel: () => void
  onConfirm: () => void
}

const CLOSE_TRANSITION_MS = 140

const toneStyles: Record<AppConfirmDialogTone, {
  rail: string
  badge: string
  confirm: string
  focus: string
  defaultStatus: string
}> = {
  default: {
    rail: 'bg-cyan-600 dark:bg-cyan-400',
    badge: 'border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200',
    confirm: 'bg-cyan-700 hover:bg-cyan-800 disabled:bg-cyan-400 dark:bg-cyan-600 dark:hover:bg-cyan-500',
    focus: 'focus-visible:ring-cyan-500/45',
    defaultStatus: '需要确认',
  },
  warning: {
    rail: 'bg-amber-500 dark:bg-amber-400',
    badge: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    confirm: 'bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 dark:bg-amber-500 dark:hover:bg-amber-400 dark:text-slate-950',
    focus: 'focus-visible:ring-amber-500/45',
    defaultStatus: '请核对影响',
  },
  danger: {
    rail: 'bg-red-600 dark:bg-red-400',
    badge: 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
    confirm: 'bg-red-700 hover:bg-red-800 disabled:bg-red-400 dark:bg-red-600 dark:hover:bg-red-500',
    focus: 'focus-visible:ring-red-500/45',
    defaultStatus: '不可撤销',
  },
}

export function AppConfirmDialog({
  open,
  title,
  message,
  children,
  tone = 'default',
  statusLabel,
  confirmLabel = '确认',
  cancelLabel = '取消',
  busy = false,
  error,
  testId = 'app-confirm-dialog',
  onCancel,
  onConfirm,
}: AppConfirmDialogProps): JSX.Element | null {
  const titleId = useId()
  const messageId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const busyRef = useRef(busy)
  const onCancelRef = useRef(onCancel)
  const [entered, setEntered] = useState(false)
  const styles = toneStyles[tone]

  useEffect(() => {
    busyRef.current = busy
    onCancelRef.current = onCancel
  }, [busy, onCancel])

  const requestClose = useCallback(() => {
    if (closingRef.current || busyRef.current) return
    closingRef.current = true
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onCancelRef.current()
      return
    }
    setEntered(false)
    closeTimerRef.current = window.setTimeout(() => onCancelRef.current(), CLOSE_TRANSITION_MS)
  }, [])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const appRoot = document.getElementById('root')
    const rootWasInert = appRoot?.inert ?? false
    const previousBodyOverflow = document.body.style.overflow
    if (appRoot) appRoot.inert = true
    document.body.style.overflow = 'hidden'
    closingRef.current = false

    const frame = window.requestAnimationFrame(() => {
      setEntered(true)
      cancelButtonRef.current?.focus({ preventScroll: true })
    })
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown)
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current)
      if (appRoot) appRoot.inert = rootWasInert
      document.body.style.overflow = previousBodyOverflow
      setEntered(false)
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus({ preventScroll: true })
    }
  }, [open, requestClose])

  if (!open) return null

  const dialog = (
    <div
      data-testid={`${testId}-overlay`}
      className="electron-no-drag fixed inset-0 z-[10020] flex items-center justify-center overflow-y-auto p-4 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 bg-slate-950/55 backdrop-blur-[1px] transition-opacity duration-150 ease-out motion-reduce:transition-none dark:bg-black/65 ${entered ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={dialogRef}
        data-testid={testId}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        aria-busy={busy}
        tabIndex={-1}
        className={`relative w-full max-w-[460px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.34)] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none dark:border-slate-700 dark:bg-slate-900 dark:shadow-[0_24px_70px_rgba(0,0,0,0.62)] ${entered ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.985] opacity-0'}`}
      >
        <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${styles.rail}`} />
        <header className="border-b border-slate-200 px-5 py-4 pl-6 dark:border-slate-800">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">操作确认</div>
              <h2 id={titleId} className="mt-1 text-base font-semibold text-slate-950 dark:text-slate-50">{title}</h2>
            </div>
            <span className={`shrink-0 rounded border px-2 py-1 text-[11px] font-semibold ${styles.badge}`}>
              {statusLabel ?? styles.defaultStatus}
            </span>
          </div>
          <div id={messageId} className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{message}</div>
        </header>

        {(children || error) && (
          <div className="space-y-3 px-5 py-4 pl-6">
            {children}
            {error && (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm leading-5 text-red-700 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
        )}

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-950/45">
          <button
            ref={cancelButtonRef}
            type="button"
            disabled={busy}
            onClick={requestClose}
            className="h-11 min-w-20 rounded-md border border-slate-300 bg-transparent px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-600 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`flex h-11 min-w-28 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed dark:focus-visible:ring-offset-slate-900 ${styles.confirm} ${styles.focus}`}
          >
            {busy && <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/35 border-t-current motion-reduce:animate-none" />}
            {busy ? '正在处理' : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
