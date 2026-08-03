import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type StrategyConfirmAction =
  | { kind: 'discard'; strategyName: string }
  | { kind: 'delete'; strategyId: number; strategyName: string }

interface StrategyConfirmDialogProps {
  action: StrategyConfirmAction
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

const CLOSE_TRANSITION_MS = 140

export function StrategyConfirmDialog({
  action,
  busy = false,
  onCancel,
  onConfirm,
}: StrategyConfirmDialogProps): JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCancelRef = useRef(onCancel)
  const busyRef = useRef(busy)
  const closeTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    onCancelRef.current = onCancel
    busyRef.current = busy
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        requestClose()
        return
      }
      if (event.key !== 'Tab') return
      event.stopPropagation()
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
    window.addEventListener('keydown', handleKeyDown, true)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKeyDown, true)
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current)
      if (appRoot) appRoot.inert = rootWasInert
      document.body.style.overflow = previousBodyOverflow
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus({ preventScroll: true })
      }
    }
  }, [requestClose])

  const isDiscard = action.kind === 'discard'
  const dialog = (
    <div
      data-testid="strategy-confirm-dialog-overlay"
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
        data-testid="strategy-confirm-dialog"
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
              {isDiscard ? '放弃未保存修改？' : '删除策略？'}
            </h2>
            <span className="shrink-0 rounded bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
              {isDiscard ? '修改未保存' : '不可撤销'}
            </span>
          </div>
          <p id={descriptionId} className="mt-1.5 text-sm leading-6 text-slate-600 dark:text-slate-300">
            {isDiscard
              ? '放弃后，本次配置不会写入策略，也不会参与下一次扫描。'
              : '此操作会移除这份自定义策略配置。'}
          </p>
        </header>

        <div className="px-5 py-4">
          <div className="border-y border-slate-200 py-4 dark:border-slate-800">
            <div className="text-xs text-slate-500 dark:text-slate-400">当前策略</div>
            <div className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{action.strategyName}</div>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {isDiscard
              ? '已保存版本和历史运行结果不受影响。'
              : '原始信号、行情缓存和其他策略不会被删除。'}
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-950/45">
          <button
            ref={cancelButtonRef}
            type="button"
            disabled={busy}
            onClick={requestClose}
            className="h-11 min-w-24 rounded-md border border-slate-300 bg-transparent px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-600 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            {isDiscard ? '继续编辑' : '取消'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="flex h-11 min-w-28 items-center justify-center gap-2 rounded-md bg-red-700 px-4 text-sm font-semibold text-white transition-colors hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-red-400 dark:bg-red-600 dark:hover:bg-red-500 dark:focus-visible:ring-offset-slate-900"
          >
            {busy && <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/45 border-t-white motion-reduce:animate-none" />}
            {busy ? '正在删除' : isDiscard ? '放弃修改' : '删除策略'}
          </button>
        </footer>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
