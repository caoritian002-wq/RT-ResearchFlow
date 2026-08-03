import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatResearchDate } from './industryResearchModel'
import type { ResearchEvidence, ResearchHypothesis } from './industryResearchTypes'

interface Props {
  evidence: ResearchEvidence[]
  hypotheses: ResearchHypothesis[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddEvidence: () => void
  onAddHypothesis: () => void
  onChangeHypothesisStatus: (hypothesis: ResearchHypothesis) => void
}

type LedgerSection = 'evidence' | 'hypotheses'

interface DrawerBounds {
  top: number
  right: number
  height: number
}

export function ResearchSidePanel({ evidence, hypotheses, open, onOpenChange, onAddEvidence, onAddHypothesis, onChangeHypothesisStatus }: Props): React.ReactElement {
  const [section, setSection] = useState<LedgerSection>('evidence')
  const [drawerBounds, setDrawerBounds] = useState<DrawerBounds | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onOpenChange, open])

  useEffect(() => {
    if (!open) {
      setDrawerBounds(null)
      return
    }
    const rail = railRef.current
    if (!rail) return
    const updateBounds = () => {
      const rect = rail.getBoundingClientRect()
      setDrawerBounds({
        top: Math.max(0, Math.round(rect.top)),
        right: Math.max(0, Math.round(window.innerWidth - rect.left)),
        height: Math.max(1, Math.round(rect.height)),
      })
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(rail)
    window.addEventListener('resize', updateBounds)
    window.addEventListener('scroll', updateBounds, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
      window.removeEventListener('scroll', updateBounds, true)
    }
  }, [open])

  const selectSection = (next: LedgerSection) => {
    if (open && section === next) {
      onOpenChange(false)
      return
    }
    setSection(next)
    onOpenChange(true)
  }

  const drawer = open ? (
    <aside
      id="industry-research-ledger-drawer"
      data-testid="industry-research-ledger-drawer"
      data-section={section}
      aria-label="研究账本抽屉"
      style={drawerBounds ? { top: drawerBounds.top, right: drawerBounds.right, height: drawerBounds.height } : undefined}
      className="fixed z-[120] flex w-[min(380px,calc(100vw-7rem))] flex-col border-l border-r border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
    >
      <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <h3 className="text-sm font-semibold">研究账本</h3>
        <button type="button" onClick={() => onOpenChange(false)} aria-label="收起研究账本" className="flex h-9 w-9 cursor-pointer items-center justify-center text-xl text-slate-400 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:hover:bg-slate-800 dark:hover:text-slate-100">×</button>
      </header>
      <div role="tablist" aria-label="账本内容" className="grid shrink-0 grid-cols-2 border-b border-slate-200 bg-slate-50 p-1 dark:border-slate-800 dark:bg-slate-950">
        <button type="button" role="tab" aria-selected={section === 'evidence'} onClick={() => setSection('evidence')} className={`cursor-pointer px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 ${section === 'evidence' ? 'bg-white font-semibold text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400'}`}>证据账本 <span className="ml-1 tabular-nums opacity-60">{evidence.length}</span></button>
        <button type="button" role="tab" aria-selected={section === 'hypotheses'} onClick={() => setSection('hypotheses')} className={`cursor-pointer px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 ${section === 'hypotheses' ? 'bg-white font-semibold text-slate-900 shadow-sm dark:bg-slate-800 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400'}`}>待证伪假设 <span className="ml-1 tabular-nums opacity-60">{hypotheses.length}</span></button>
      </div>

      {section === 'evidence' ? (
        <section role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <span className="text-[11px] text-slate-400">正式事实与支持材料</span>
            <button type="button" onClick={onAddEvidence} className="cursor-pointer text-xs font-semibold text-cyan-700 hover:text-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-cyan-300">添加证据</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {!evidence.length && <div className="border-l-2 border-slate-200 py-3 pl-3 text-xs leading-5 text-slate-400 dark:border-slate-700">事实必须绑定人工确认的原始来源。</div>}
            {evidence.slice(0, 40).map((item) => (
              <article key={item.id} className="border-b border-slate-100 py-3 dark:border-slate-800">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-xs font-medium leading-5">{item.title}</span>
                  <span className="shrink-0 border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 dark:border-slate-700 dark:text-slate-400">{item.statement_kind === 'fact' ? '事实' : item.statement_kind === 'estimate' ? '估算' : '假设'}</span>
                </div>
                <div className="mt-1 text-[10px] text-slate-500">{item.source_name} · {formatResearchDate(item.fact_date)}</div>
                {item.excerpt && <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-slate-500 dark:text-slate-400">{item.excerpt}</p>}
                {item.conflict_note && <div className="mt-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300">冲突：{item.conflict_note}</div>}
                {item.source_url && <button type="button" onClick={() => void window.api.openExternal(item.source_url!)} className="mt-2 cursor-pointer text-[10px] font-medium text-cyan-700 hover:underline focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-cyan-300">打开原文</button>}
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
            <span className="text-[11px] text-slate-400">待验证与最低成本反证</span>
            <button type="button" onClick={onAddHypothesis} className="cursor-pointer text-xs font-semibold text-cyan-700 hover:text-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-cyan-300">新增假设</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {!hypotheses.length && <div className="border-l-2 border-slate-200 py-3 pl-3 text-xs leading-5 text-slate-400 dark:border-slate-700">假设必须填写最低成本反证。</div>}
            {hypotheses.slice(0, 40).map((item) => (
              <article key={item.id} className="border-b border-slate-100 py-3 dark:border-slate-800">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-xs font-medium leading-5">{item.statement}</span>
                  <span className="shrink-0 text-[10px] font-semibold text-amber-700 dark:text-amber-300">P{item.importance}</span>
                </div>
                <p className="mt-1.5 line-clamp-3 text-[10px] leading-4 text-slate-500 dark:text-slate-400">反证：{item.cheapest_disproof}</p>
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">{item.status}</span>
                  <button type="button" onClick={() => onChangeHypothesisStatus(item)} className="cursor-pointer text-[10px] font-semibold text-cyan-700 focus:outline-none focus:ring-2 focus:ring-cyan-500 dark:text-cyan-300">更新状态</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </aside>
  ) : null

  return (
    <div ref={railRef} data-testid="industry-research-ledger-rail" className="relative z-30 flex w-11 shrink-0 border-l border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950">
      <nav aria-label="研究账本" className="flex w-full flex-col items-stretch">
        <button
          type="button"
          aria-controls="industry-research-ledger-drawer"
          aria-label={`证据账本，共 ${evidence.length} 条`}
          aria-expanded={open && section === 'evidence'}
          onClick={() => selectSection('evidence')}
          className={`flex h-24 w-full cursor-pointer flex-col items-center justify-center gap-1 border-b border-slate-200 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 dark:border-slate-800 ${open && section === 'evidence' ? 'bg-cyan-50 font-semibold text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-200' : 'text-slate-500 hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100'}`}
        >
          <span aria-hidden="true" className="leading-3">证<br />据</span>
          <span className="tabular-nums text-[10px] text-slate-400">{evidence.length}</span>
        </button>
        <button
          type="button"
          aria-controls="industry-research-ledger-drawer"
          aria-label={`待证伪假设，共 ${hypotheses.length} 条`}
          aria-expanded={open && section === 'hypotheses'}
          onClick={() => selectSection('hypotheses')}
          className={`flex h-24 w-full cursor-pointer flex-col items-center justify-center gap-1 border-b border-slate-200 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500 dark:border-slate-800 ${open && section === 'hypotheses' ? 'bg-amber-50 font-semibold text-amber-800 dark:bg-amber-950/30 dark:text-amber-200' : 'text-slate-500 hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-100'}`}
        >
          <span aria-hidden="true" className="leading-3">假<br />设</span>
          <span className="tabular-nums text-[10px] text-slate-400">{hypotheses.length}</span>
        </button>
      </nav>

      {drawer && (typeof document === 'undefined' ? drawer : drawerBounds ? createPortal(drawer, document.body) : null)}
    </div>
  )
}
