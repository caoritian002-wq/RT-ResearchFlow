import React, { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface ResearchComboboxOption {
  value: string
  label: string
  meta?: string
}

interface ResearchComboboxProps {
  value: string
  options: ResearchComboboxOption[]
  placeholder: string
  searchPlaceholder: string
  testId: string
  disabled?: boolean
  onChange: (value: string) => void
}

export interface ResearchDatePickerProps {
  value: string
  testId?: string
  disabled?: boolean
  min?: string
  max?: string
  ariaLabel?: string
  triggerAriaLabel?: string
  dialogLabel?: string
  footerHint?: string
  quickSelectLabel?: string
  onChange: (value: string) => void
  onCommit?: (value: string) => void
}

export interface ResearchCalendarDay {
  value: string
  day: number
  currentMonth: boolean
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dateValue(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

function parseDateValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(year, month - 1, day)
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null
  return parsed
}

export function getBeijingDateValue(now = Date.now()): string {
  const date = new Date(now + 8 * 60 * 60 * 1000)
  return dateValue(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function buildResearchCalendarDays(year: number, month: number): ResearchCalendarDay[] {
  const firstWeekday = new Date(year, month, 1).getDay()
  const gridStart = new Date(year, month, 1 - firstWeekday)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
    return {
      value: dateValue(date.getFullYear(), date.getMonth(), date.getDate()),
      day: date.getDate(),
      currentMonth: date.getMonth() === month,
    }
  })
}

function ChevronIcon({ open = false }: { open?: boolean }): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} fill="none">
      <path d="m6 8 4 4 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <circle cx="8.5" cy="8.5" r="4.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="m12 12 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CalendarIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <rect x="3" y="4.5" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 2.75v3.5M13.5 2.75v3.5M3 8h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ArrowIcon({ direction }: { direction: 'left' | 'right' }): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path d={direction === 'left' ? 'm12 5-5 5 5 5' : 'm8 5 5 5-5 5'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ResearchCombobox({
  value,
  options,
  placeholder,
  searchPlaceholder,
  testId,
  disabled = false,
  onChange,
}: ResearchComboboxProps): React.ReactElement {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const selected = options.find((option) => option.value === value) ?? null
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (!normalized) return options
    return options.filter((option) => `${option.label} ${option.meta ?? ''}`.toLocaleLowerCase('zh-CN').includes(normalized))
  }, [options, query])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown, true)
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
  }, [query, open])

  const choose = (nextValue: string) => {
    onChange(nextValue)
    setQuery('')
    setOpen(false)
  }

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(filtered.length - 1, current + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(0, current - 1))
    } else if (event.key === 'Enter' && filtered[activeIndex]) {
      event.preventDefault()
      choose(filtered[activeIndex].value)
    }
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <input data-testid={testId} tabIndex={-1} aria-hidden="true" className="hidden" value={value} readOnly />
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className="group flex h-10 w-full items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-3 text-left text-sm text-slate-900 shadow-sm shadow-slate-200/30 outline-none transition-colors duration-150 hover:border-cyan-400 focus-visible:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:shadow-none dark:hover:border-cyan-600"
      >
        <span className="min-w-0">
          <span className={`block truncate ${selected ? 'font-medium' : 'text-slate-400'}`}>{selected?.label ?? placeholder}</span>
          {selected?.meta && <span className="block truncate text-[10px] leading-3 text-slate-400">{selected.meta}</span>}
        </span>
        <span className="shrink-0 text-slate-400 group-hover:text-cyan-700 dark:group-hover:text-cyan-300"><ChevronIcon open={open} /></span>
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-40 w-full min-w-[220px] overflow-hidden rounded-md border border-slate-200 bg-white shadow-xl shadow-slate-950/10 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/35">
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 dark:border-slate-800">
            <span className="text-slate-400"><SearchIcon /></span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleListKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              aria-activedescendant={filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
              className="h-10 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none placeholder:text-slate-400 dark:bg-transparent"
            />
          </div>
          <div id={listboxId} role="listbox" className="max-h-64 overflow-y-auto p-1.5">
            {filtered.map((option, index) => (
              <button
                id={`${listboxId}-${index}`}
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option.value)}
                className={`flex min-h-10 w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-sm transition-colors ${index === activeIndex ? 'bg-cyan-50 text-cyan-900 dark:bg-cyan-950/35 dark:text-cyan-100' : 'hover:bg-slate-50 dark:hover:bg-slate-800'} ${option.value === value ? 'font-semibold' : ''}`}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {option.meta && <span className="shrink-0 font-mono text-[10px] text-slate-400">{option.meta}</span>}
              </button>
            ))}
            {!filtered.length && <div className="px-3 py-8 text-center text-xs text-slate-400">没有匹配项</div>}
          </div>
        </div>
      )}
    </div>
  )
}

export function ResearchDatePicker({
  value,
  testId = 'industry-research-decision-date',
  disabled = false,
  min,
  max,
  ariaLabel = '估值请求日，格式为年-月-日',
  triggerAriaLabel = '打开日期选择器',
  dialogLabel = '选择估值请求日',
  footerHint = '数据按该日及此前可用交易日计算',
  quickSelectLabel = '今天',
  onChange,
  onCommit,
}: ResearchDatePickerProps): React.ReactElement {
  const dialogId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const selectedDate = parseDateValue(value)
  const fallbackDate = selectedDate ?? parseDateValue(getBeijingDateValue())!
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [visibleMonth, setVisibleMonth] = useState(() => new Date(fallbackDate.getFullYear(), fallbackDate.getMonth(), 1))
  const days = useMemo(() => buildResearchCalendarDays(visibleMonth.getFullYear(), visibleMonth.getMonth()), [visibleMonth])
  const today = getBeijingDateValue()
  const invalidMessage = !parseDateValue(draft)
    ? '请输入 YYYY-MM-DD'
    : min && draft < min
      ? `不得早于 ${min}`
      : max && draft > max
        ? `不得晚于 ${max}`
        : null

  useEffect(() => setDraft(value), [value])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const commit = (next: string) => {
    if (!parseDateValue(next) || (min && next < min) || (max && next > max)) {
      setDraft(value)
      return
    }
    onChange(next)
    onCommit?.(next)
  }

  const selectDay = (next: string) => {
    if ((min && next < min) || (max && next > max)) return
    setDraft(next)
    commit(next)
    setOpen(false)
  }

  const changeMonth = (offset: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1))
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div className="flex h-10 items-center rounded-md border border-slate-300 bg-white shadow-sm shadow-slate-200/30 transition-colors duration-150 focus-within:border-cyan-500 focus-within:ring-2 focus-within:ring-cyan-500/20 hover:border-cyan-400 dark:border-slate-700 dark:bg-slate-950 dark:shadow-none dark:hover:border-cyan-600">
        <input
          data-testid={testId}
          value={draft}
          disabled={disabled}
          inputMode="numeric"
          aria-label={ariaLabel}
          aria-invalid={Boolean(invalidMessage)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); commit(draft) }
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) }
          }}
          className="h-full min-w-0 flex-1 border-0 bg-transparent px-3 font-mono text-sm tabular-nums text-slate-900 outline-none dark:bg-transparent dark:text-slate-100"
        />
        <button
          type="button"
          disabled={disabled}
          aria-label={triggerAriaLabel}
          aria-expanded={open}
          aria-controls={dialogId}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const date = parseDateValue(draft) ?? fallbackDate
            setVisibleMonth(new Date(date.getFullYear(), date.getMonth(), 1))
            setOpen((current) => !current)
          }}
          className="flex h-full w-10 shrink-0 items-center justify-center border-l border-slate-200 text-slate-400 outline-none transition-colors hover:bg-cyan-50 hover:text-cyan-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-800 dark:hover:bg-cyan-950/30 dark:hover:text-cyan-300"
        >
          <CalendarIcon />
        </button>
      </div>
      {invalidMessage && <div className="mt-1 text-[10px] text-red-600 dark:text-red-300">{invalidMessage}</div>}
      {open && (
        <div id={dialogId} role="dialog" aria-label={dialogLabel} className="absolute right-0 top-[calc(100%+6px)] z-40 w-[304px] rounded-md border border-slate-200 bg-white p-3 shadow-xl shadow-slate-950/10 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/35">
          <div className="flex h-9 items-center justify-between">
            <button type="button" aria-label="上个月" onClick={() => changeMonth(-1)} className="flex h-9 w-9 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:bg-slate-800"><ArrowIcon direction="left" /></button>
            <div className="text-sm font-semibold tabular-nums">{visibleMonth.getFullYear()} 年 {visibleMonth.getMonth() + 1} 月</div>
            <button type="button" aria-label="下个月" onClick={() => changeMonth(1)} className="flex h-9 w-9 items-center justify-center rounded text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:bg-slate-800"><ArrowIcon direction="right" /></button>
          </div>
          <div className="mt-2 grid grid-cols-7 text-center text-[10px] font-medium text-slate-400">
            {['日', '一', '二', '三', '四', '五', '六'].map((label) => <span key={label} className="py-1">{label}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {days.map((day) => {
              const selected = day.value === value
              const isToday = day.value === today
              const unavailable = Boolean((min && day.value < min) || (max && day.value > max))
              return (
                <button
                  key={day.value}
                  type="button"
                  disabled={unavailable}
                  aria-label={day.value}
                  aria-pressed={selected}
                  onClick={() => selectDay(day.value)}
                  className={`relative flex h-9 items-center justify-center rounded text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan-500 ${selected ? 'bg-cyan-700 font-semibold text-white hover:bg-cyan-800' : day.currentMonth ? 'text-slate-700 hover:bg-cyan-50 hover:text-cyan-800 dark:text-slate-200 dark:hover:bg-cyan-950/35 dark:hover:text-cyan-200' : 'text-slate-300 hover:bg-slate-50 dark:text-slate-600 dark:hover:bg-slate-800'} disabled:cursor-not-allowed disabled:opacity-25`}
                >
                  {day.day}
                  {isToday && !selected && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-cyan-600" />}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 dark:border-slate-800">
            <span className="text-[10px] text-slate-400">{footerHint}</span>
            <button type="button" disabled={Boolean((min && today < min) || (max && today > max))} onClick={() => selectDay(today)} className="rounded px-2 py-1 text-xs font-medium text-cyan-700 hover:bg-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:cursor-not-allowed disabled:opacity-35 dark:text-cyan-300 dark:hover:bg-cyan-950/30">{quickSelectLabel}</button>
          </div>
        </div>
      )}
    </div>
  )
}
