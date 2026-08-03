import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type AppToastTone = 'info' | 'success' | 'warning' | 'error'

interface AppToastProps {
  message: string | null
  tone?: AppToastTone
  duration?: number
  testId?: string
  onClose: () => void
}

const toneStyles: Record<AppToastTone, { dot: string; surface: string; label: string }> = {
  info: {
    dot: 'bg-cyan-500',
    surface: 'border-cyan-200 bg-white text-slate-700 dark:border-cyan-900 dark:bg-slate-900 dark:text-slate-100',
    label: '信息',
  },
  success: {
    dot: 'bg-emerald-500',
    surface: 'border-emerald-200 bg-white text-slate-700 dark:border-emerald-900 dark:bg-slate-900 dark:text-slate-100',
    label: '已完成',
  },
  warning: {
    dot: 'bg-amber-500',
    surface: 'border-amber-200 bg-white text-slate-700 dark:border-amber-900 dark:bg-slate-900 dark:text-slate-100',
    label: '请注意',
  },
  error: {
    dot: 'bg-red-500',
    surface: 'border-red-200 bg-white text-slate-700 dark:border-red-900 dark:bg-slate-900 dark:text-slate-100',
    label: '操作失败',
  },
}

export function AppToast({
  message,
  tone = 'info',
  duration = 4500,
  testId = 'app-toast',
  onClose,
}: AppToastProps): JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const onCloseRef = useRef(onClose)
  const closeTimerRef = useRef<number | null>(null)
  const styles = toneStyles[tone]

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!message) return
    const frame = window.requestAnimationFrame(() => setVisible(true))
    const timer = window.setTimeout(() => {
      setVisible(false)
      closeTimerRef.current = window.setTimeout(
        () => onCloseRef.current(),
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 140,
      )
    }, duration)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current)
      setVisible(false)
    }
  }, [duration, message])

  if (!message) return null
  const toast = (
    <div className="electron-no-drag pointer-events-none fixed inset-x-0 top-12 z-[10030] flex justify-center px-4" aria-live={tone === 'error' ? 'assertive' : 'polite'}>
      <div
        data-testid={testId}
        role={tone === 'error' ? 'alert' : 'status'}
        className={`pointer-events-auto flex w-full max-w-[520px] items-start gap-3 rounded-lg border px-4 py-3 shadow-[0_16px_45px_rgba(15,23,42,0.24)] transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${styles.surface} ${visible ? 'translate-y-0 opacity-100' : '-translate-y-2 opacity-0'}`}
      >
        <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{styles.label}</div>
          <div className="mt-0.5 text-sm leading-5">{message}</div>
        </div>
        <button
          type="button"
          aria-label="关闭提示"
          onClick={onClose}
          className="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-lg leading-none text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          ×
        </button>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? toast : createPortal(toast, document.body)
}
