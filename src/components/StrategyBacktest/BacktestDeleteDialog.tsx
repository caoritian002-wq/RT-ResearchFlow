import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface BacktestDeleteTarget {
  id: number
  strategyLabel: string
  dateRange: string
  holdDays: number
}

interface BacktestDeleteDialogProps {
  target: BacktestDeleteTarget
  deleting: boolean
  runtimeUpdateRequired?: boolean
  onCancel: () => void
  onConfirm: () => void
  onRestart?: () => void
}

const CLOSE_TRANSITION_MS = 140

export function BacktestDeleteDialog({
  target,
  deleting,
  runtimeUpdateRequired = false,
  onCancel,
  onConfirm,
  onRestart,
}: BacktestDeleteDialogProps): JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const onCancelRef = useRef(onCancel)
  const deletingRef = useRef(deleting)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    onCancelRef.current = onCancel
    deletingRef.current = deleting
  }, [deleting, onCancel])

  const requestClose = useCallback(() => {
    if (closingRef.current || deletingRef.current) return
    closingRef.current = true
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      onCancelRef.current()
      return
    }
    setEntered(false)
    closeTimerRef.current = window.setTimeout(() => onCancelRef.current(), CLOSE_TRANSITION_MS)
  }, [])

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
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
      )).filter(element => element.offsetParent !== null)
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
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus({ preventScroll: true })
      }
    }
  }, [requestClose])

  const dialog = (
    <div
      data-testid="strategy-backtest-delete-dialog-overlay"
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
        data-testid="strategy-backtest-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={`relative w-full max-w-[440px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.32)] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none dark:border-slate-700 dark:bg-slate-900 dark:shadow-[0_24px_70px_rgba(0,0,0,0.58)] ${entered ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-2 scale-[0.985] opacity-0'}`}
      >
        <header className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-4">
            <h2 id={titleId} className="text-base font-semibold text-slate-950 dark:text-slate-50">
              {runtimeUpdateRequired ? '需要重启应用' : '删除回测记录'}
            </h2>
            <span className={runtimeUpdateRequired
              ? 'shrink-0 rounded bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
              : 'shrink-0 rounded bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300'}>
              {runtimeUpdateRequired ? '运行组件未更新' : '不可撤销'}
            </span>
          </div>
          <p id={descriptionId} className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {runtimeUpdateRequired
              ? '当前窗口仍在使用旧运行组件，重启后才能安全删除记录。'
              : '确认移除这次回测报告及其交易明细？'}
          </p>
        </header>

        <div className="px-5 py-4">
          <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-3 border-y border-slate-200 py-4 text-sm dark:border-slate-800">
            <dt className="text-slate-500 dark:text-slate-400">策略</dt>
            <dd className="min-w-0 font-medium text-slate-900 dark:text-slate-100">{target.strategyLabel}</dd>
            <dt className="text-slate-500 dark:text-slate-400">信号日期</dt>
            <dd className="font-mono tabular-nums text-slate-800 dark:text-slate-200">{target.dateRange}</dd>
            <dt className="text-slate-500 dark:text-slate-400">持有期</dt>
            <dd className="tabular-nums text-slate-800 dark:text-slate-200">{target.holdDays} 个交易日</dd>
            <dt className="text-slate-500 dark:text-slate-400">记录编号</dt>
            <dd className="font-mono tabular-nums text-slate-800 dark:text-slate-200">#{target.id}</dd>
          </dl>
          <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {runtimeUpdateRequired
              ? '本次不会删除记录。重启会关闭当前窗口，未保存的编辑不会保留。'
              : '策略配置、原始信号和行情缓存不会被删除。'}
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-950/45">
          <button
            ref={cancelButtonRef}
            type="button"
            disabled={deleting}
            onClick={requestClose}
            className="h-11 min-w-20 rounded-md border border-slate-300 bg-transparent px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-600 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={runtimeUpdateRequired ? onRestart : onConfirm}
            className={runtimeUpdateRequired
              ? 'flex h-11 min-w-28 items-center justify-center rounded-md bg-cyan-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-cyan-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 focus-visible:ring-offset-2 dark:bg-cyan-600 dark:hover:bg-cyan-500 dark:focus-visible:ring-offset-slate-900'
              : 'flex h-11 min-w-28 items-center justify-center gap-2 rounded-md bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-red-400 dark:bg-red-600 dark:hover:bg-red-500 dark:focus-visible:ring-offset-slate-900'}
          >
            {!runtimeUpdateRequired && deleting && <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/45 border-t-white motion-reduce:animate-none" />}
            {runtimeUpdateRequired ? '重启应用' : deleting ? '正在删除' : '删除记录'}
          </button>
        </footer>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
