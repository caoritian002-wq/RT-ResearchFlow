import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StrategyLabStrategyDetail } from '../../../../electron/main/services/strategyLabService'
import { StrategyResultTable } from './StrategyResultTable'
import { StrategyRuleBuilder } from './StrategyRuleBuilder'
import { StrategyTemplateLibrary } from './StrategyTemplateLibrary'
import { StrategySidePanel, type StrategySideTab } from './StrategySidePanel'
import { StrategyConfirmDialog, type StrategyConfirmAction } from './StrategyConfirmDialog'
import { RightDrawer } from '../../shared/RightDrawer'
import {
  STRATEGY_TEMPLATES,
  parseRunSummary,
  strategyToTemplate,
  viewTitle,
  type StrategyLabMatchRow,
  type StrategyLabRunRow,
  type StrategyLabView,
  type StrategyTemplateCard,
} from './strategyLabModel'

interface StrategyLabProps {
  initialView?: StrategyLabView
}

export function StrategyLab({ initialView = 'overview' }: StrategyLabProps): JSX.Element {
  const [activeView, setActiveView] = useState<StrategyLabView>(initialView)
  const [templates, setTemplates] = useState<StrategyTemplateCard[]>(STRATEGY_TEMPLATES)
  const [selectedStrategyId, setSelectedStrategyId] = useState<number | null>(null)
  const [runs, setRuns] = useState<StrategyLabRunRow[]>([])
  const [matches, setMatches] = useState<StrategyLabMatchRow[]>([])
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null)
  const [sideTab, setSideTab] = useState<StrategySideTab>('run')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyLabStrategyDetail | null>(null)
  const [runProgress, setRunProgress] = useState<{ stage: string; current: number; total: number; message: string } | null>(null)
  const [showBuilder, setShowBuilder] = useState(false)
  const [builderDirty, setBuilderDirty] = useState(false)
  const [creatingNew, setCreatingNew] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<StrategyConfirmAction | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => {
      setToast(current => current === message ? null : current)
    }, 3200)
  }, [])

  useEffect(() => {
    setActiveView(initialView)
  }, [initialView])

  const latestRun = runs[0] ?? null
  const latestSummary = useMemo(() => parseRunSummary(latestRun), [latestRun])
  const canCreateBacktest = selectedStrategy?.actions.createBacktest === true
  const selectedTemplate = useMemo(() => {
    return templates.find(template => template.strategyId && template.strategyId === selectedStrategyId)
      ?? templates.find(template => template.id === activeView)
      ?? templates[0]
  }, [activeView, selectedStrategyId, templates])

  const overviewMetrics = useMemo(() => {
    const coverage = latestSummary?.coverage ?? {}
    return [
      { label: '基础股票池', value: String(latestSummary?.totalStocks ?? '—'), note: '最近运行参与扫描的股票数', tone: 'blue' },
      { label: '日线预筛', value: String((coverage.dailyPrefilteredStocks as number | undefined) ?? (coverage.dailyCandidateStocks as number | undefined) ?? '—'), note: '条件积木运行时展示真实预筛数', tone: 'slate' },
      { label: '分钟完整', value: String((coverage.minuteCompleteStocks as number | undefined) ?? '—'), note: '分钟覆盖完整股票数', tone: 'indigo' },
      { label: '实际评估', value: String((coverage.evaluatedStocks as number | undefined) ?? latestSummary?.totalStocks ?? '—'), note: '进入策略求值的样本数', tone: 'emerald' },
      { label: '当前命中', value: String(matches.length || latestSummary?.matchedCount || '—'), note: latestRun ? `来自 run #${latestRun.id}` : '尚未运行统一策略', tone: 'rose' },
    ]
  }, [latestRun, latestSummary, matches.length])

  const loadStrategyLabData = useCallback(async (targetRunId?: number | null, preferredStrategyId?: number | null) => {
    setLoading(true)
    try {
      const strategyRes = await window.api.strategyLab.listStrategies()
      const nextTemplates = strategyRes.ok ? strategyRes.strategies.map(strategyToTemplate) : []
      const targetStrategyId = preferredStrategyId ?? (creatingNew ? null : selectedStrategyId ?? nextTemplates[0]?.strategyId ?? null)
      const [detailRes, runRes] = targetStrategyId
        ? await Promise.all([
            window.api.strategyLab.getStrategy(targetStrategyId),
            window.api.strategyLab.listRuns({ strategyId: targetStrategyId, limit: 10 }),
          ])
        : [{ ok: false as const, error: 'NO_STRATEGY', code: 'NO_STRATEGY' }, { ok: true as const, runs: [] }]
      const nextRuns = runRes.ok ? runRes.runs : []
      const displayRunId = targetRunId ?? nextRuns[0]?.id ?? null
      const matchRes = displayRunId
        ? await window.api.strategyLab.listMatches({ runId: displayRunId, limit: 100 })
        : { ok: true as const, matches: [] }
      if (strategyRes.ok) {
        setTemplates(nextTemplates.length > 0 ? nextTemplates : STRATEGY_TEMPLATES)
        if (targetStrategyId !== selectedStrategyId) setSelectedStrategyId(targetStrategyId)
      }
      setSelectedStrategy(detailRes.ok ? detailRes.strategy : null)
      if (runRes.ok) setRuns(nextRuns)
      setRunning(nextRuns[0]?.status === 'running' || nextRuns[0]?.status === 'queued')
      if (matchRes.ok) {
        const rows = matchRes.matches as StrategyLabMatchRow[]
        setMatches(rows)
        setSelectedMatchId(rows[0]?.id ?? null)
      }
      if (!strategyRes.ok) showToast(`策略模板读取失败: ${strategyRes.error}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [creatingNew, selectedStrategyId, showToast])

  useEffect(() => {
    void loadStrategyLabData()
  }, [loadStrategyLabData])

  useEffect(() => {
    const off = window.api.strategyLab.onRunProgress((progress) => {
      if (selectedStrategyId && progress.strategyId !== selectedStrategyId) return
      setRunProgress({ stage: progress.stage, current: progress.current, total: progress.total, message: progress.message })
      if (progress.stage === 'done' || progress.stage === 'failed' || progress.stage === 'cancelled') setRunning(false)
    })
    return off
  }, [selectedStrategyId])

  useEffect(() => {
    if (showBuilder || sideTab !== 'insight') return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSideTab('run')
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [showBuilder, sideTab])

  const closeBuilder = useCallback(() => {
    setShowBuilder(false)
    setCreatingNew(false)
    setBuilderDirty(false)
  }, [])

  const guardBuilderClose = useCallback(() => {
    if (!builderDirty) return true
    setConfirmAction({
      kind: 'discard',
      strategyName: creatingNew ? '未命名分钟规则' : selectedTemplate?.name ?? '当前策略',
    })
    return false
  }, [builderDirty, creatingNew, selectedTemplate?.name])

  const requestCloseBuilder = useCallback(() => {
    if (!guardBuilderClose()) return
    closeBuilder()
  }, [closeBuilder, guardBuilderClose])

  const handleSelectTemplate = useCallback((template: StrategyTemplateCard) => {
    if (showBuilder && !guardBuilderClose()) return
    setCreatingNew(false)
    setBuilderDirty(false)
    if (template.strategyId) setSelectedStrategyId(template.strategyId)
    setActiveView(template.id)
    setShowBuilder(template.id === 'newRule' || template.source === 'custom')
  }, [guardBuilderClose, showBuilder])

  const handleDuplicate = useCallback(async (template: StrategyTemplateCard) => {
    if (!template.strategyId) return
    const res = await window.api.strategyLab.duplicateStrategy(template.strategyId)
    showToast(res.ok ? '已复制策略草稿' : `复制失败: ${res.error}`)
    await loadStrategyLabData()
  }, [loadStrategyLabData, showToast])

  const handleToggleEnabled = useCallback(async (template: StrategyTemplateCard) => {
    if (!template.strategyId) return
    const res = await window.api.strategyLab.setStrategyEnabled(template.strategyId, template.enabled === false)
    showToast(res.ok ? '策略状态已更新' : `状态更新失败: ${res.error}`)
    await loadStrategyLabData()
  }, [loadStrategyLabData, showToast])

  const handleDelete = useCallback((template: StrategyTemplateCard) => {
    if (!template.strategyId) return
    setConfirmAction({ kind: 'delete', strategyId: template.strategyId, strategyName: template.name })
  }, [])

  const confirmStrategyAction = useCallback(async () => {
    if (!confirmAction) return
    if (confirmAction.kind === 'discard') {
      setConfirmAction(null)
      closeBuilder()
      return
    }
    setConfirmBusy(true)
    try {
      const res = await window.api.strategyLab.deleteStrategy(confirmAction.strategyId)
      showToast(res.ok ? '策略已删除' : `删除失败: ${res.error}`)
      if (res.ok) {
        setConfirmAction(null)
        await loadStrategyLabData()
      }
    } finally {
      setConfirmBusy(false)
    }
  }, [closeBuilder, confirmAction, loadStrategyLabData, showToast])

  const runStrategy = useCallback(async (strategyId: number) => {
    if (running) return
    setRunning(true)
    setRunProgress({ stage: 'prepare', current: 0, total: 1, message: '准备策略运行' })
    showToast('开始运行策略实验室策略')
    try {
      const res = await window.api.strategyLab.runStrategy(strategyId)
      showToast(res.ok ? `运行完成, 命中 ${res.matchedCount} 只` : `运行失败: ${res.error}`)
      await loadStrategyLabData(res.ok ? res.runId : undefined, strategyId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [loadStrategyLabData, running, showToast])

  const handleRunSelected = useCallback(async () => {
    if (!selectedStrategyId) return
    await runStrategy(selectedStrategyId)
  }, [runStrategy, selectedStrategyId])

  const handleBuilderSaved = useCallback(async (strategy: StrategyLabStrategyDetail, runAfterSave: boolean) => {
    setBuilderDirty(false)
    setCreatingNew(false)
    setSelectedStrategyId(strategy.id)
    setSelectedStrategy(strategy)
    setActiveView('conditionBlocks')
    await loadStrategyLabData(undefined, strategy.id)
    if (runAfterSave) {
      setShowBuilder(false)
      await runStrategy(strategy.id)
    }
  }, [loadStrategyLabData, runStrategy])

  const handleOpenEvidence = useCallback((matchId: number) => {
    setSelectedMatchId(matchId)
    setSideTab('insight')
  }, [])

  const handleCreateBacktest = useCallback(async () => {
    if (!latestRun) return
    const res = await window.api.strategyLab.createBacktestFromRun(latestRun.id)
    showToast(res.ok ? `已创建回测 run #${res.backtestRunId}` : `创建回测失败: ${res.error}`)
    await loadStrategyLabData()
  }, [latestRun, loadStrategyLabData, showToast])

  return (
    <div className="flex h-full min-h-0 w-full bg-slate-100 dark:bg-slate-950">
      <StrategyTemplateLibrary
        templates={templates}
        activeView={activeView}
        selectedStrategyId={selectedStrategyId}
        onSelect={handleSelectTemplate}
        onDuplicate={handleDuplicate}
        onToggleEnabled={handleToggleEnabled}
        onDelete={handleDelete}
        onCreate={() => {
          setCreatingNew(true)
          setSelectedStrategyId(null)
          setSelectedStrategy(null)
          setActiveView('newRule')
          setShowBuilder(true)
        }}
      />

      <main data-testid="strategy-lab-main" className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">策略实验室</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-50">{selectedTemplate?.name ?? viewTitle(activeView)}</h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500 dark:text-slate-400">
              {selectedTemplate?.description ?? '选择模板后在同一个控制台完成运行、命中研判和回测衔接。'}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            <span className="inline-flex min-h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {selectedStrategy ? (selectedStrategy.runConfig.scanMode === 'quick' ? '快速扫描' : selectedStrategy.runConfig.scanMode === 'complete' ? '完整扫描' : '两阶段（待实现）') : '尚未保存'}
            </span>
            <button type="button" onClick={() => setShowBuilder(true)} disabled={showBuilder} aria-expanded={showBuilder} className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-default disabled:bg-slate-100 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 dark:disabled:bg-slate-800 dark:disabled:text-slate-500">
              {showBuilder ? '配置已打开' : '配置'}
            </button>
            <button type="button" onClick={() => void loadStrategyLabData()} disabled={loading} className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">
              {loading ? '刷新中...' : '刷新结果'}
            </button>
            <button type="button" onClick={() => void handleRunSelected()} disabled={!selectedStrategyId || running || selectedStrategy?.status !== 'ready'} title={selectedStrategy?.status === 'draft' ? '草稿需要在配置区保存并运行后才能扫描' : undefined} className="min-h-9 rounded-md bg-teal-700 px-3 text-xs font-semibold text-white shadow-sm hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed disabled:bg-slate-400">
              {running ? '运行中' : '运行扫描'}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <div data-testid="strategy-lab-scroll" className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-slate-100 p-3 dark:bg-slate-950">
            {runProgress && (running || runProgress.stage === 'failed' || runProgress.stage === 'cancelled') && (
              <section aria-live="polite" className="rounded-md border border-cyan-200 bg-cyan-50 px-4 py-3 dark:border-cyan-900/60 dark:bg-cyan-950/25">
                <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium text-cyan-900 dark:text-cyan-100">{runProgress.message}</span><span className="font-mono text-cyan-700 dark:text-cyan-300">{runProgress.total > 0 ? `${runProgress.current}/${runProgress.total}` : '处理中'}</span></div>
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-cyan-100 dark:bg-cyan-950"><div className="h-full rounded bg-cyan-600 transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${runProgress.total > 0 ? Math.max(4, Math.min(100, runProgress.current / runProgress.total * 100)) : 8}%` }} /></div>
              </section>
            )}
            <section className="rounded-md border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <div className="grid gap-2 lg:grid-cols-5">
                {overviewMetrics.map(metric => (
                  <article key={metric.label} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-950/50">
                    <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">{metric.label}</p>
                    <p className={
                      'mt-1 font-mono text-2xl font-bold leading-none ' +
                      (metric.tone === 'blue'
                        ? 'text-blue-700 dark:text-blue-300'
                        : metric.tone === 'emerald'
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : metric.tone === 'rose'
                            ? 'text-rose-600 dark:text-rose-300'
                            : metric.tone === 'indigo'
                              ? 'text-indigo-700 dark:text-indigo-300'
                              : 'text-slate-700 dark:text-slate-200')
                    }>{metric.value}</p>
                    <p className="mt-1 truncate text-[11px] text-slate-500 dark:text-slate-400" title={metric.note}>{metric.note}</p>
                  </article>
                ))}
              </div>
            </section>

            <StrategyResultTable matches={matches} selectedMatchId={selectedMatchId} onSelectMatch={setSelectedMatchId} onOpenEvidence={handleOpenEvidence} onCreateBacktest={latestRun && canCreateBacktest ? handleCreateBacktest : undefined} />
          </div>
        </div>
      </main>

      <aside data-testid="strategy-evidence-sidebar" className="hidden min-h-0 w-[300px] shrink-0 flex-col border-l border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950/60 xl:flex">
          <StrategySidePanel
            activeView={selectedTemplate?.id ?? activeView}
            latestRun={latestRun}
            latestSummary={latestSummary}
            match={matches.find(item => item.id === selectedMatchId) ?? null}
            activeTab={sideTab}
            onActiveTabChange={setSideTab}
            onCreateBacktest={canCreateBacktest ? handleCreateBacktest : undefined}
          />
      </aside>

      <RightDrawer
        open={showBuilder}
        title={creatingNew ? '新建分钟规则' : `配置 · ${selectedTemplate?.name ?? '策略'}`}
        description="修改只保存在当前策略副本中，保存成功后才会参与下一次扫描"
        actions={builderDirty ? <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">有未保存修改</span> : undefined}
        onClose={closeBuilder}
        beforeClose={guardBuilderClose}
        defaultWidth={940}
        minWidth={720}
        maxWidth={1120}
        testId="strategy-config-drawer"
        bodyClassName="min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950"
        zIndex={9999}
      >
        <StrategyRuleBuilder
          strategyId={creatingNew ? null : selectedStrategyId}
          onSaved={handleBuilderSaved}
          onClose={requestCloseBuilder}
          onDirtyChange={setBuilderDirty}
          hideHeader
        />
      </RightDrawer>

      {confirmAction && (
        <StrategyConfirmDialog
          action={confirmAction}
          busy={confirmBusy}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => void confirmStrategyAction()}
        />
      )}

      {!showBuilder && sideTab === 'insight' && matches.some(item => item.id === selectedMatchId) && (
        <div
          className="fixed inset-x-0 bottom-0 top-16 z-[80] bg-slate-950/45 xl:hidden"
          role="presentation"
          onMouseDown={() => setSideTab('run')}
        >
          <aside
            data-testid="strategy-evidence-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="命中证据"
            className="ml-auto flex h-full w-[min(420px,calc(100vw-48px))] flex-col bg-slate-100 p-3 shadow-2xl dark:bg-slate-950"
            onMouseDown={event => event.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">命中证据</p>
              <button type="button" onClick={() => setSideTab('run')} className="min-h-10 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">关闭证据</button>
            </div>
            <div className="min-h-0 flex-1">
              <StrategySidePanel
                activeView={selectedTemplate?.id ?? activeView}
                latestRun={latestRun}
                latestSummary={latestSummary}
                match={matches.find(item => item.id === selectedMatchId) ?? null}
                activeTab={sideTab}
                onActiveTabChange={setSideTab}
                onCreateBacktest={canCreateBacktest ? handleCreateBacktest : undefined}
              />
            </div>
          </aside>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-[10000] max-w-sm rounded-md border border-slate-200 bg-white px-4 py-3 text-xs font-medium text-slate-800 shadow-lg shadow-slate-900/15 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
          {toast}
        </div>
      )}
    </div>
  )
}
