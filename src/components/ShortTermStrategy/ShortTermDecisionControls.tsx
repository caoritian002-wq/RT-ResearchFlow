import React, { useEffect, useId, useMemo, useRef, useState } from 'react'

export const SHORT_TERM_WORKBENCH_ACTION_CLASS = 'inline-flex h-11 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 outline-none transition-colors hover:border-cyan-500 hover:bg-slate-50 hover:text-cyan-800 active:bg-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200 dark:hover:border-cyan-500 dark:hover:bg-slate-900 dark:hover:text-cyan-200 dark:active:bg-slate-800'

export interface ShortTermComboboxOption {
  value: string
  label: string
  meta?: string
}

interface ShortTermComboboxProps {
  value: string
  options: ShortTermComboboxOption[]
  ariaLabel: string
  testId: string
  searchPlaceholder?: string
  onChange: (value: string) => void
}

export function ShortTermCombobox({
  value,
  options,
  ariaLabel,
  testId,
  searchPlaceholder = '搜索选项',
  onChange,
}: ShortTermComboboxProps): JSX.Element {
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const selected = options.find((option) => option.value === value) ?? options[0] ?? null
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
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setOpen(false)
      triggerRef.current?.focus()
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

  useEffect(() => setActiveIndex(0), [open, query])

  const choose = (next: string): void => {
    onChange(next)
    setOpen(false)
    setQuery('')
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className="group flex h-11 w-full items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-3 text-left text-xs text-slate-800 outline-none transition-colors hover:border-cyan-500 focus-visible:border-cyan-500 focus-visible:ring-2 focus-visible:ring-cyan-500/25 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:hover:border-cyan-500"
      >
        <span className="min-w-0 truncate font-medium">{selected?.label ?? '请选择'}</span>
        <span aria-hidden="true" className={`mr-0.5 h-2 w-2 shrink-0 border-b border-r border-slate-400 transition-transform motion-reduce:transition-none ${open ? '-rotate-[135deg] translate-y-0.5' : 'rotate-45 -translate-y-0.5'}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-full min-w-[220px] overflow-hidden rounded-md border border-slate-200 bg-white shadow-xl shadow-slate-950/15 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/40">
          <div className="border-b border-slate-100 p-2 dark:border-slate-800">
            <input
              ref={searchRef}
              value={query}
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              aria-activedescendant={filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
              placeholder={searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
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
              }}
              className="h-11 w-full rounded border border-slate-200 bg-slate-50 px-3 text-xs text-slate-900 outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          <div id={listboxId} role="listbox" className="max-h-60 overflow-y-auto p-1.5">
            {filtered.map((option, index) => (
              <button
                id={`${listboxId}-${index}`}
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option.value)}
                className={`flex min-h-11 w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-cyan-500/30 ${index === activeIndex ? 'bg-cyan-50 text-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-100' : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'} ${option.value === value ? 'font-semibold' : ''}`}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {option.meta && <span className="shrink-0 text-[10px] text-slate-400">{option.meta}</span>}
              </button>
            ))}
            {filtered.length === 0 && <div className="px-3 py-8 text-center text-xs text-slate-400">没有匹配项</div>}
          </div>
        </div>
      )}
    </div>
  )
}
