import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

interface RightDrawerProps {
  open?: boolean
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  onClose: () => void
  beforeClose?: () => boolean
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  resizable?: boolean
  testId?: string
  bodyClassName?: string
  zIndex?: number
}

const DRAWER_TRANSITION_MS = 180
const VIEWPORT_GUTTER = 72

interface ActiveDrawer {
  token: symbol
  zIndex: number
}

const activeDrawers: ActiveDrawer[] = []
let rootInertBeforeFirstDrawer = false
let bodyOverflowBeforeFirstDrawer = ''

function registerDrawer(token: symbol, zIndex: number): void {
  if (activeDrawers.some((entry) => entry.token === token)) return
  if (activeDrawers.length === 0) {
    const appRoot = document.getElementById('root')
    rootInertBeforeFirstDrawer = appRoot?.inert ?? false
    bodyOverflowBeforeFirstDrawer = document.body.style.overflow
  }
  activeDrawers.push({ token, zIndex })
  const appRoot = document.getElementById('root')
  if (appRoot) appRoot.inert = true
  document.body.style.overflow = 'hidden'
}

function unregisterDrawer(token: symbol): void {
  const index = activeDrawers.findIndex((entry) => entry.token === token)
  if (index >= 0) activeDrawers.splice(index, 1)
  if (activeDrawers.length > 0) return
  const appRoot = document.getElementById('root')
  if (appRoot) appRoot.inert = rootInertBeforeFirstDrawer
  document.body.style.overflow = bodyOverflowBeforeFirstDrawer
}

function isTopDrawer(token: symbol): boolean {
  const top = activeDrawers.reduce<ActiveDrawer | null>((current, entry) => {
    if (!current || entry.zIndex >= current.zIndex) return entry
    return current
  }, null)
  return top?.token === token
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function RightDrawer({
  open = true,
  title,
  description,
  actions,
  children,
  onClose,
  beforeClose,
  defaultWidth = 820,
  minWidth = 680,
  maxWidth = 1040,
  resizable = true,
  testId = 'right-drawer',
  bodyClassName = 'min-h-0 flex-1 overflow-y-auto p-4',
  zIndex = 9999,
}: RightDrawerProps) {
  const titleId = useId()
  const descriptionId = useId()
  const stackTokenRef = useRef(Symbol('right-drawer'))
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const beforeCloseRef = useRef(beforeClose)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const resizeStartRef = useRef<{ pointerId: number; x: number; width: number } | null>(null)
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1440 : window.innerWidth)
  const initialMax = Math.max(320, Math.min(maxWidth, viewportWidth - VIEWPORT_GUTTER))
  const initialMin = Math.min(minWidth, initialMax)
  const [width, setWidth] = useState(() => clamp(defaultWidth, initialMin, initialMax))
  const [entered, setEntered] = useState(false)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    onCloseRef.current = onClose
    beforeCloseRef.current = beforeClose
  }, [beforeClose, onClose])

  const effectiveMax = Math.max(320, Math.min(maxWidth, viewportWidth - VIEWPORT_GUTTER))
  const effectiveMin = Math.min(minWidth, effectiveMax)

  const requestClose = useCallback(() => {
    if (closingRef.current) return
    if (beforeCloseRef.current && !beforeCloseRef.current()) return
    closingRef.current = true
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      onCloseRef.current()
      return
    }
    setEntered(false)
    closeTimerRef.current = window.setTimeout(() => onCloseRef.current(), DRAWER_TRANSITION_MS)
  }, [])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const stackToken = stackTokenRef.current
    registerDrawer(stackToken, zIndex)
    closingRef.current = false
    const frame = window.requestAnimationFrame(() => {
      setEntered(true)
      closeButtonRef.current?.focus({ preventScroll: true })
    })
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!isTopDrawer(stackToken)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        requestClose()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current)
      unregisterDrawer(stackToken)
      previousFocusRef.current?.focus({ preventScroll: true })
    }
  }, [open, requestClose, zIndex])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    setWidth((current) => clamp(current, effectiveMin, effectiveMax))
  }, [effectiveMax, effectiveMin])

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizable) return
    event.preventDefault()
    resizeStartRef.current = { pointerId: event.pointerId, x: event.clientX, width }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }

  const handleResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    setWidth(clamp(start.width + start.x - event.clientX, effectiveMin, effectiveMax))
  }

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resizeStartRef.current = null
    setResizing(false)
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!resizable) return
    const step = event.shiftKey ? 64 : 24
    if (event.key === 'ArrowLeft') setWidth((current) => clamp(current + step, effectiveMin, effectiveMax))
    else if (event.key === 'ArrowRight') setWidth((current) => clamp(current - step, effectiveMin, effectiveMax))
    else if (event.key === 'Home') setWidth(effectiveMin)
    else if (event.key === 'End') setWidth(effectiveMax)
    else return
    event.preventDefault()
  }

  if (!open) return null

  const drawer = (
    <div data-testid={`${testId}-overlay`} className="electron-no-drag fixed inset-0 overflow-hidden" style={{ zIndex }}>
      <div
        data-testid={`${testId}-scrim`}
        aria-hidden="true"
        className={`absolute inset-0 bg-slate-950/50 transition-opacity duration-200 ease-out motion-reduce:transition-none dark:bg-black/60 ${entered ? 'opacity-100' : 'opacity-0'}`}
      />
      <aside
        ref={dialogRef}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`electron-no-drag absolute inset-y-0 right-0 flex h-full flex-col border-l border-slate-200 bg-white shadow-[-24px_0_56px_rgba(15,23,42,0.28)] transition-transform duration-200 ease-out motion-reduce:transition-none dark:border-slate-700 dark:bg-slate-950 dark:shadow-[-24px_0_56px_rgba(0,0,0,0.5)] ${entered ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width, maxWidth: `max(320px, calc(100vw - ${VIEWPORT_GUTTER}px))` }}
      >
        {resizable && (
          <div
            data-testid={`${testId}-resize-handle`}
            role="separator"
            aria-label="调整抽屉宽度"
            aria-orientation="vertical"
            aria-valuemin={effectiveMin}
            aria-valuemax={effectiveMax}
            aria-valuenow={Math.round(width)}
            tabIndex={0}
            title="拖动调整宽度"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onKeyDown={handleResizeKeyDown}
            className="group absolute inset-y-0 -left-2 z-20 flex w-4 cursor-col-resize touch-none items-center justify-center focus:outline-none"
          >
            <span className={`h-16 w-1 rounded-full transition-colors group-hover:bg-cyan-500 group-focus:bg-cyan-500 dark:group-hover:bg-cyan-300 dark:group-focus:bg-cyan-300 ${resizing ? 'bg-cyan-500 dark:bg-cyan-300' : 'bg-slate-300 dark:bg-slate-700'}`} />
          </div>
        )}

        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-slate-200 px-4 py-2 dark:border-slate-800">
          <div className="min-w-0 flex-1">
            <div id={titleId} className="text-base font-semibold leading-6 text-slate-950 dark:text-slate-100">{title}</div>
            {description && <div id={descriptionId} className="mt-0.5 line-clamp-2 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</div>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={requestClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-950 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-1 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white dark:focus:ring-offset-slate-950"
            aria-label="关闭抽屉"
            title="关闭"
          >
            <span className="relative block h-4 w-4" aria-hidden="true">
              <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
              <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
            </span>
          </button>
        </header>

        <div data-testid={`${testId}-body`} className={bodyClassName}>{children}</div>
      </aside>
    </div>
  )

  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body)
}
