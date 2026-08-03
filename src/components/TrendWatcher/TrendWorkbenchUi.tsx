import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import InfoTip from '../shared/InfoTip'
import type { TrendBenchmarkHealth, TrendState } from './trendWorkbenchTypes'

const STATE_META: Record<TrendState, { label: string; className: string }> = {
  strengthening: { label: '正在转强', className: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300' },
  strong: { label: '保持强势', className: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300' },
  stable: { label: '结构稳定', className: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200' },
  weakening: { label: '趋势走弱', className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300' },
  broken: { label: '结构破坏', className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' },
  insufficient: { label: '数据不足', className: 'border-slate-200 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400' },
}

export function TrendPageHeader({
  title,
  subtitle,
  meta,
  loading,
  onRefresh,
  actions,
}: {
  title: string
  subtitle: string
  meta?: ReactNode
  loading: boolean
  onRefresh: () => void
  actions?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
            {meta}
          </div>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition-colors motion-reduce:transition-none hover:border-cyan-400 hover:text-cyan-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-wait disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600 dark:hover:text-cyan-300"
          >
            {loading ? '刷新中…' : '刷新数据'}
          </button>
        </div>
      </div>
    </header>
  )
}

export function TrendStateBadge({ state }: { state: TrendState }) {
  const meta = STATE_META[state]
  return <span className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
}

export function TrendBenchmarkMeta({ health }: { health: TrendBenchmarkHealth }) {
  const label = health.state === 'current'
    ? '基准已对齐'
    : health.state === 'stale'
      ? '基准陈旧'
      : health.state === 'missing'
        ? '基准缺失'
        : health.state === 'insufficient'
          ? '基准历史不足'
          : '基准日期待确认'
  const tone = health.state === 'current'
    ? 'border-cyan-200 text-cyan-700 dark:border-cyan-800 dark:text-cyan-300'
    : health.state === 'stale' || health.state === 'missing'
      ? 'border-rose-200 text-rose-700 dark:border-rose-800 dark:text-rose-300'
      : 'border-amber-200 text-amber-700 dark:border-amber-800 dark:text-amber-300'
  return (
    <span
      data-testid="trend-benchmark-health"
      data-state={health.state}
      data-calendar-source={health.calendarSource}
      title={health.message}
      className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-medium ${tone}`}
    >
      {label} · 实际 {formatTrendDate(health.latestTradeDate)} · 应有 {formatTrendDate(health.expectedTradeDate)}
    </span>
  )
}

export function ScoreSparkline({ points, label }: { points: Array<{ totalScore: number }>; label: string }) {
  if (points.length < 2) return <span className="text-xs text-slate-400">样本不足</span>
  const values = points.slice(-60).map((point) => point.totalScore)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(1, max - min)
  const path = values.map((value, index) => {
    const x = values.length === 1 ? 0 : index / (values.length - 1) * 116
    const y = 30 - (value - min) / span * 26
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox="0 0 116 34" className="h-9 w-[116px]" role="img" aria-label={label}>
      <path d="M0,30 H116" stroke="currentColor" className="text-slate-200 dark:text-slate-700" strokeWidth="1" />
      <path d={path} fill="none" stroke="currentColor" className="text-cyan-600 dark:text-cyan-300" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      <circle cx="116" cy={(30 - (values.at(-1)! - min) / span * 26).toFixed(1)} r="2.2" fill="currentColor" className="text-cyan-600 dark:text-cyan-300" />
    </svg>
  )
}

export function WorkbenchError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="m-4 flex items-center justify-between gap-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300" role="alert">
      <span>{message}</span>
      <button type="button" onClick={onRetry} className="min-h-11 shrink-0 rounded-md border border-rose-300 px-3 font-medium hover:bg-rose-100 dark:border-rose-800 dark:hover:bg-rose-900/40">重试</button>
    </div>
  )
}

export function MetricCell({ label, value, tip }: { label: string; value: ReactNode; tip?: string }) {
  const content = (
    <div className="min-w-0 border-l border-slate-200 pl-3 first:border-l-0 first:pl-0 dark:border-slate-800">
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 truncate text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  )
  return tip ? <InfoTip content={tip}>{content}</InfoTip> : content
}

export function OptionMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string; description?: string }>
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const selected = options.find((option) => option.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full min-w-32 items-center justify-between gap-3 rounded-md border border-slate-300 bg-white px-3 text-left text-sm text-slate-700 transition-colors motion-reduce:transition-none hover:border-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-cyan-600"
      >
        <span className="min-w-0">
          <span className="block text-[10px] leading-none text-slate-400">{label}</span>
          <span className="mt-1 block truncate font-medium">{selected?.label ?? '未选择'}</span>
        </span>
        <span aria-hidden="true" className={`text-slate-400 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute left-0 z-40 mt-1 max-h-72 min-w-full overflow-y-auto overscroll-contain rounded-md border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
              className={`flex min-h-11 w-full items-center justify-between gap-4 px-3 text-left text-sm outline-none transition-colors motion-reduce:transition-none hover:bg-cyan-50 focus:bg-cyan-50 dark:hover:bg-cyan-950/30 dark:focus:bg-cyan-950/30 ${
                option.value === value ? 'text-cyan-700 dark:text-cyan-300' : 'text-slate-700 dark:text-slate-200'
              }`}
            >
              <span>
                <span className="block whitespace-nowrap font-medium">{option.label}</span>
                {option.description && <span className="mt-0.5 block whitespace-nowrap text-[10px] text-slate-400">{option.description}</span>}
              </span>
              {option.value === value && <span aria-hidden="true" className="text-cyan-600">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function formatTrendDate(value: string | null | undefined): string {
  if (!value) return '未知日期'
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

export function formatSigned(value: number | null | undefined, suffix = '', digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`
}

export function valueTone(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-slate-500 dark:text-slate-400'
  return value > 0 ? 'text-rose-600 dark:text-rose-300' : 'text-emerald-600 dark:text-emerald-300'
}
