import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PrimaryNavigationIcon } from '../AppWindow/PrimaryNavigationIcon'
import {
  decisionSignalSourceLabel,
  type DecisionSignalToastBatch,
  type DecisionSignalToastSignal,
} from './decisionSignalToastModel'

interface DecisionSignalToastProps {
  notice: DecisionSignalToastBatch | null
  noticeKey: number
  duration?: number
  raised?: boolean
  onOpen: (signal: DecisionSignalToastSignal) => void
  onClose: () => void
}

const priorityStyles: Record<number, { label: string; rail: string; badge: string; icon: string }> = {
  5: {
    label: '重大影响',
    rail: 'bg-red-500',
    badge: 'border-red-200 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-200',
    icon: 'border-red-200 bg-red-50 text-red-600 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-200',
  },
  4: {
    label: '重大影响',
    rail: 'bg-red-500',
    badge: 'border-red-200 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-200',
    icon: 'border-red-200 bg-red-50 text-red-600 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-200',
  },
  3: {
    label: '重要影响',
    rail: 'bg-amber-500',
    badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200',
    icon: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200',
  },
}

export function DecisionSignalToast({
  notice,
  noticeKey,
  duration = 5000,
  raised = false,
  onOpen,
  onClose,
}: DecisionSignalToastProps): JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const onCloseRef = useRef(onClose)
  const closeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!notice) return
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
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
      setVisible(false)
    }
  }, [duration, notice, noticeKey])

  if (!notice) return null
  const signal = notice.primary
  const styles = priorityStyles[Math.max(3, Math.min(5, signal.priority))] ?? priorityStyles[4]
  const sourceLabel = decisionSignalSourceLabel(signal)
  const toast = (
    <div
      className={`electron-no-drag pointer-events-none fixed right-5 z-[10020] max-w-[calc(100vw-2rem)] transition-[bottom] duration-200 motion-reduce:transition-none ${raised ? 'bottom-[28rem]' : 'bottom-5'}`}
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        data-testid="decision-signal-toast"
        role="status"
        className={`pointer-events-auto relative w-[420px] max-w-full overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-900 shadow-[0_18px_48px_rgba(15,23,42,0.28)] transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 ${visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}`}
      >
        <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${styles.rail}`} />
        <button
          type="button"
          onClick={() => onOpen(signal)}
          aria-label={`${styles.label}，${signal.title}，查看资讯原文`}
          className="flex min-h-[132px] w-full cursor-pointer items-start gap-3 py-4 pl-5 pr-14 text-left outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 motion-reduce:transition-none dark:hover:bg-slate-800/70"
        >
          <span className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-md border ${styles.icon}`}>
            <span className="h-5 w-5" aria-hidden="true">
              <PrimaryNavigationIcon name="news" />
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${styles.badge}`}>
                P{signal.priority} · {styles.label}
              </span>
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{sourceLabel} · 主动提醒</span>
            </span>
            <span title={signal.title} className="mt-2 block break-words text-sm font-semibold leading-5 text-slate-950 dark:text-white">
              {signal.title}
            </span>
            {signal.summary.trim() && (
              <span className="mt-1 line-clamp-2 block text-xs font-normal leading-5 text-slate-500 dark:text-slate-400">
                {signal.summary}
              </span>
            )}
            <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-cyan-700 dark:text-cyan-300">
              <span>查看资讯原文 →</span>
              {notice.additionalCount > 0 && (
                <span className="text-slate-500 dark:text-slate-400">另有 {notice.additionalCount} 条高优先级消息</span>
              )}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label="关闭主动提醒"
          onClick={() => onCloseRef.current()}
          className="absolute right-1.5 top-1.5 flex h-11 w-11 cursor-pointer items-center justify-center rounded-md text-xl leading-none text-slate-400 outline-none transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-cyan-500 motion-reduce:transition-none dark:hover:bg-slate-800 dark:hover:text-slate-100"
        >
          ×
        </button>
      </div>
    </div>
  )

  return typeof document === 'undefined' ? toast : createPortal(toast, document.body)
}
