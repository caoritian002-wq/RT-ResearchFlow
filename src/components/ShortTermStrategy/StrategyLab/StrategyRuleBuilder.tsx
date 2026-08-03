import { useEffect, useMemo, useState } from 'react'
import type {
  StrategyLabActionsConfig,
  StrategyLabScanMode,
  StrategyLabStockPoolSource,
  StrategyLabStrategyDetail,
} from '../../../../electron/main/services/strategyLabService'
import type { BlockStrategyTemplate } from '../../../../electron/main/services/conditionBlocks/types'
import { ConditionRuleEditor } from './ConditionRuleEditor'
import {
  cloneConditionTemplate,
  createDefaultMinuteTemplate,
  createStrategyTemplateKey,
  summarizeConditionGroup,
  validateConditionTemplate,
} from './strategyRuleModel'

interface StrategyRuleBuilderProps {
  strategyId?: number | null
  onSaved?: (strategy: StrategyLabStrategyDetail, runAfterSave: boolean) => void | Promise<void>
  onClose?: () => void
  onDirtyChange?: (dirty: boolean) => void
  hideHeader?: boolean
}

const POOL_OPTIONS: Array<{ key: StrategyLabStockPoolSource; label: string; description: string }> = [
  { key: 'allMarket', label: '全市场', description: '从本地日线底座预筛' },
  { key: 'portfolio', label: '我的持仓', description: '当前持仓股票' },
  { key: 'trendWatchlist', label: '趋势池', description: '趋势观察名单' },
  { key: 'chipMonitor', label: '筹码监控', description: '筹码结构股池' },
  { key: 'manual', label: '手动代码', description: '输入指定股票' },
]

function newBuilderState(): {
  name: string
  description: string
  template: BlockStrategyTemplate
  sources: StrategyLabStockPoolSource[]
  manualStocks: string
  excludeST: boolean
  excludeBJ: boolean
  scanMode: 'complete' | 'quick'
  lookbackDays: number
  dailyPrefilterLimit: number
  autoFetchMinuteLimit: number
  dateStart: string
  dateEnd: string
  actions: StrategyLabActionsConfig
} {
  const template = createDefaultMinuteTemplate()
  return {
    name: template.name,
    description: template.description,
    template,
    sources: ['allMarket'],
    manualStocks: '',
    excludeST: true,
    excludeBJ: false,
    scanMode: 'complete',
    lookbackDays: 5,
    dailyPrefilterLimit: 200,
    autoFetchMinuteLimit: 80,
    dateStart: '',
    dateEnd: '',
    actions: {
      aiInsight: true,
      addToTrendWatchlist: true,
      monitorChips: true,
      createBacktest: true,
    },
  }
}

function parseManualStocks(value: string): string[] {
  return Array.from(new Set(value
    .split(/[\s,，;；]+/)
    .map(item => item.trim().toUpperCase())
    .filter(Boolean)))
}

function formatError(error: string): string {
  const known: Record<string, string> = {
    STRATEGY_NAME_REQUIRED: '请填写策略名称。',
    STOCK_POOL_REQUIRED: '至少选择一个股票池。',
    MANUAL_STOCK_POOL_REQUIRED: '选择手动代码后，请至少输入一只股票。',
    CONDITION_TEMPLATE_SNAPSHOT_REQUIRED: '规则快照缺失，请重新打开配置后再保存。',
    ENABLED_CONDITION_REQUIRED: '至少需要一个启用的分钟条件。',
    INVALID_DATE_RANGE: '开始日期不能晚于结束日期。',
    BUILTIN_STRATEGY_READ_ONLY: '内置模板不能直接修改，请保存为用户副本。',
  }
  return known[error] ?? error
}

export function StrategyRuleBuilder({ strategyId, onSaved, onClose, onDirtyChange, hideHeader = false }: StrategyRuleBuilderProps): JSX.Element {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [isBuiltinSource, setIsBuiltinSource] = useState(false)
  const [unsupportedScreener, setUnsupportedScreener] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [state, setState] = useState(newBuilderState)

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setMessage(null)
      setDirty(false)
      setUnsupportedScreener(false)
      if (!strategyId) {
        setEditingId(null)
        setIsBuiltinSource(false)
        setState(newBuilderState())
        return
      }
      setLoading(true)
      try {
        const res = await window.api.strategyLab.getStrategy(strategyId)
        if (cancelled) return
        if (!res.ok) {
          setMessage(`读取策略失败：${formatError(res.error)}`)
          return
        }
        const detail = res.strategy
        if (detail.source === 'screener') {
          setUnsupportedScreener(true)
          setEditingId(null)
          setIsBuiltinSource(detail.isBuiltin)
          return
        }
        const template = detail.ruleDraft.conditionBlocksProfile?.templateSnapshot
          ? cloneConditionTemplate(detail.ruleDraft.conditionBlocksProfile.templateSnapshot)
          : createDefaultMinuteTemplate()
        const useAsNew = detail.isBuiltin || detail.source === 'custom'
        if (useAsNew || !template.key.startsWith('strategy_lab_')) {
          template.key = createStrategyTemplateKey()
          template.version = 1
        }
        setEditingId(useAsNew ? null : detail.id)
        setIsBuiltinSource(useAsNew)
        setState({
          name: useAsNew ? `${detail.name} 副本` : detail.name,
          description: detail.description ?? template.description,
          template,
          sources: detail.ruleDraft.stockPool.sources,
          manualStocks: detail.ruleDraft.stockPool.manualTsCodes.join(' '),
          excludeST: detail.ruleDraft.stockPool.excludeST,
          excludeBJ: detail.ruleDraft.stockPool.excludeBJ,
          scanMode: detail.runConfig.scanMode === 'quick' ? 'quick' : 'complete',
          lookbackDays: detail.runConfig.lookbackDays,
          dailyPrefilterLimit: detail.runConfig.dailyPrefilterLimit,
          autoFetchMinuteLimit: detail.runConfig.autoFetchMinuteLimit,
          dateStart: detail.runConfig.dateStart ?? '',
          dateEnd: detail.runConfig.dateEnd ?? '',
          actions: detail.actions,
        })
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [strategyId])

  const updateState = <K extends keyof typeof state>(key: K, value: (typeof state)[K]) => {
    setState(current => ({ ...current, [key]: value }))
    setDirty(true)
    setMessage(null)
  }

  const toggleStockPoolSource = (source: StrategyLabStockPoolSource, nextChecked: boolean) => {
    setState(current => ({
      ...current,
      sources: nextChecked
        ? Array.from(new Set([...current.sources, source]))
        : current.sources.filter(item => item !== source),
    }))
    setDirty(true)
    setMessage(null)
  }

  const validationErrors = useMemo(() => {
    const errors = validateConditionTemplate(state.template)
    if (!state.name.trim()) errors.unshift('请填写策略名称。')
    if (state.sources.length === 0) errors.push('至少选择一个股票池。')
    const manualCodes = parseManualStocks(state.manualStocks)
    if (state.sources.includes('manual') && manualCodes.length === 0) errors.push('手动股票池至少需要一个代码。')
    if (manualCodes.some(code => !/^\d{6}(?:\.(?:SH|SZ|BJ))?$/.test(code))) errors.push('手动股票代码必须是6位代码，可附带 .SH、.SZ 或 .BJ。')
    if (state.dateStart && !/^\d{8}$/.test(state.dateStart)) errors.push('开始日期必须使用 YYYYMMDD 格式。')
    if (state.dateEnd && !/^\d{8}$/.test(state.dateEnd)) errors.push('结束日期必须使用 YYYYMMDD 格式。')
    if (state.dateStart && state.dateEnd && state.dateStart > state.dateEnd) errors.push('开始日期不能晚于结束日期。')
    return errors
  }, [state])

  const handleSave = async (runAfterSave: boolean): Promise<void> => {
    if (saving || validationErrors.length > 0) return
    setSaving(true)
    setMessage(null)
    try {
      const template = cloneConditionTemplate(state.template)
      template.name = state.name.trim()
      template.description = state.description.trim()
      template.scope = {
        ...template.scope,
        stockPoolSources: state.sources,
        manualStocks: parseManualStocks(state.manualStocks).map(tsCode => ({ tsCode })),
        excludeST: state.excludeST,
        excludeBJ: state.excludeBJ,
        lookbackDays: state.lookbackDays,
        dateStart: state.dateStart,
        dateEnd: state.dateEnd,
        dailyPrefilterLimit: state.dailyPrefilterLimit,
        autoFetchMinuteLimit: state.autoFetchMinuteLimit,
      }
      const scanMode: StrategyLabScanMode = state.scanMode
      const res = await window.api.strategyLab.saveStrategy({
        id: editingId ?? undefined,
        name: state.name.trim(),
        description: state.description.trim(),
        source: 'conditionBlocks',
        status: runAfterSave ? 'ready' : 'draft',
        enabled: true,
        ruleDraft: {
          schemaVersion: 1,
          source: 'conditionBlocks',
          stockPool: {
            sources: state.sources,
            manualTsCodes: parseManualStocks(state.manualStocks),
            excludeST: state.excludeST,
            excludeBJ: state.excludeBJ,
          },
          conditionBlocksProfile: {
            enabled: true,
            templateKey: template.key,
            templateId: null,
            templateVersion: template.version,
            templateSnapshot: template,
          },
          scoring: {
            minScore: template.scoreThreshold,
            weights: { conditionScore: 100 },
          },
        },
        runConfig: {
          scanMode,
          lookbackDays: state.lookbackDays,
          dailyPrefilterLimit: state.dailyPrefilterLimit,
          autoFetchMinuteLimit: state.autoFetchMinuteLimit,
          userTier: 'free',
          dateStart: state.dateStart || null,
          dateEnd: state.dateEnd || null,
        },
        actions: state.actions,
      })
      if (!res.ok) {
        setMessage(`保存失败：${formatError(res.error)}`)
        return
      }
      setEditingId(res.strategy.id)
      setIsBuiltinSource(false)
      setDirty(false)
      setMessage(runAfterSave ? '策略已保存，正在启动扫描。' : '策略草稿已保存。')
      await onSaved?.(res.strategy, runAfterSave)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (unsupportedScreener) {
    return (
      <div className="p-5">
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
          <h3 className="font-semibold">个性选股仍是固定日线白盒</h3>
          <p className="mt-2 leading-6">当前引擎只支持少量全局参数，尚不能可靠表达可组合日线条件。本阶段不会把它伪装成自由规则；请新建分钟条件策略，日线信号参数化和真正两阶段组合将在下一批实现。</p>
        </div>
        <div className="mt-4 flex justify-end"><button type="button" onClick={onClose} className="min-h-11 rounded-md border border-slate-200 px-4 text-sm text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">关闭配置</button></div>
      </div>
    )
  }

  if (loading) return <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">正在读取策略配置...</div>

  return (
    <div data-testid="strategy-rule-builder" className="bg-white dark:bg-slate-900">
      {!hideHeader && <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
        <div>
          <p className="text-xs font-semibold text-teal-700 dark:text-teal-300">分钟规则编排</p>
          <h3 className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100">配置真正参与筛选的条件与阈值</h3>
          {isBuiltinSource && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">当前来自内置模板，保存时会创建独立用户副本。</p>}
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs font-medium text-amber-600 dark:text-amber-300">有未保存修改</span>}
          {onClose && <button type="button" onClick={onClose} className="min-h-10 rounded-md border border-slate-200 px-3 text-xs text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">收起</button>}
        </div>
      </header>}

      <div className="space-y-5 p-5">
        <section aria-labelledby="strategy-basic-heading">
          <div className="mb-3 flex items-center justify-between"><h4 id="strategy-basic-heading" className="text-sm font-semibold text-slate-900 dark:text-slate-100">策略信息</h4><span className="text-xs text-slate-400">保存后进入左侧策略资产库</span></div>
          <div className="grid gap-3 lg:grid-cols-[minmax(220px,0.8fr)_minmax(320px,1.5fr)]">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">策略名称<input value={state.name} onChange={event => updateState('name', event.target.value)} className="mt-1 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" /></label>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">策略说明<input value={state.description} onChange={event => updateState('description', event.target.value)} className="mt-1 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" /></label>
          </div>
        </section>

        <section aria-labelledby="strategy-pool-heading" className="border-t border-slate-200 pt-5 dark:border-slate-700">
          <div className="mb-3"><h4 id="strategy-pool-heading" className="text-sm font-semibold text-slate-900 dark:text-slate-100">1. 筛选范围</h4><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">多个股票池取并集，扫描仍优先消费本地缓存。</p></div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {POOL_OPTIONS.map(option => {
              const checked = state.sources.includes(option.key)
              return (
                <label key={option.key} data-pool-source={option.key} className={'flex min-h-16 cursor-pointer items-start gap-2 rounded-md border px-3 py-2.5 transition-colors duration-200 ' + (checked ? 'border-teal-500 bg-teal-50 dark:border-teal-500 dark:bg-teal-950/25' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800')}>
                  <input type="checkbox" checked={checked} onChange={event => toggleStockPoolSource(option.key, event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
                  <span><span className="block text-xs font-semibold text-slate-800 dark:text-slate-100">{option.label}</span><span className="mt-1 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">{option.description}</span></span>
                </label>
              )
            })}
          </div>
          {state.sources.includes('manual') && <label className="mt-3 block text-xs font-medium text-slate-600 dark:text-slate-300">手动股票代码<input data-testid="strategy-manual-stocks" value={state.manualStocks} onChange={event => updateState('manualStocks', event.target.value)} placeholder="例如 600519 000001.SZ，空格或逗号分隔" className="mt-1 h-11 w-full rounded-md border border-slate-200 bg-white px-3 font-mono text-sm text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" /></label>}
          <div className="mt-2 flex flex-wrap gap-5 text-xs text-slate-600 dark:text-slate-300">
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2"><input type="checkbox" checked={state.excludeST} onChange={event => updateState('excludeST', event.target.checked)} className="h-4 w-4 rounded text-teal-600 focus:ring-teal-500" />排除 ST</label>
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2"><input type="checkbox" checked={state.excludeBJ} onChange={event => updateState('excludeBJ', event.target.checked)} className="h-4 w-4 rounded text-teal-600 focus:ring-teal-500" />排除北交所</label>
          </div>
        </section>

        <section aria-labelledby="strategy-rule-heading" className="border-t border-slate-200 pt-5 dark:border-slate-700">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div><h4 id="strategy-rule-heading" className="text-sm font-semibold text-slate-900 dark:text-slate-100">2. 分钟条件</h4><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">条件行只编辑规则 JSON，所有判断由主进程条件引擎完成。</p></div>
            <div className="flex rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-950" role="group" aria-label="执行模式">
              <button type="button" onClick={() => updateState('template', { ...state.template, executionMode: 'strict' })} className={'min-h-9 rounded px-3 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-teal-500/30 ' + (state.template.executionMode === 'strict' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100')}>严格模式</button>
              <button type="button" onClick={() => updateState('template', { ...state.template, executionMode: 'score' })} className={'min-h-9 rounded px-3 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-teal-500/30 ' + (state.template.executionMode === 'score' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100')}>评分模式</button>
            </div>
          </div>
          {state.template.executionMode === 'score' && <label className="mb-3 block max-w-xs text-xs font-medium text-slate-600 dark:text-slate-300">总分命中阈值<div className="mt-1 flex h-10 overflow-hidden rounded-md border border-slate-200 bg-white focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950"><input type="number" min={0} max={100} step={1} value={state.template.scoreThreshold} onChange={event => updateState('template', { ...state.template, scoreThreshold: Number(event.target.value) })} className="min-w-0 flex-1 bg-transparent px-3 text-sm tabular-nums text-slate-800 outline-none dark:text-slate-100" /><span className="flex items-center border-l border-slate-200 bg-slate-50 px-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900">分</span></div></label>}
          <ConditionRuleEditor root={state.template.root} executionMode={state.template.executionMode} onChange={root => updateState('template', { ...state.template, root })} />
          <div className="mt-3 rounded-md border border-cyan-200 bg-cyan-50 px-3 py-3 text-xs leading-6 text-cyan-900 dark:border-cyan-900/60 dark:bg-cyan-950/25 dark:text-cyan-100"><span className="font-semibold">当前规则：</span>{summarizeConditionGroup(state.template.root)}</div>
        </section>

        <section aria-labelledby="strategy-run-heading" className="border-t border-slate-200 pt-5 dark:border-slate-700">
          <div className="mb-3"><h4 id="strategy-run-heading" className="text-sm font-semibold text-slate-900 dark:text-slate-100">3. 执行计划</h4><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">完整扫描会继续补齐候选的分钟缺口；快速扫描受补拉上限控制。</p></div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300">扫描模式<select value={state.scanMode} onChange={event => updateState('scanMode', event.target.value as 'complete' | 'quick')} className="mt-1 h-11 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"><option value="complete">完整扫描</option><option value="quick">快速扫描</option></select></label>
            <NumberField label="回看交易日" value={state.lookbackDays} min={1} max={60} unit="日" onChange={value => updateState('lookbackDays', value)} />
            <NumberField label="日线预筛上限" value={state.dailyPrefilterLimit} min={1} max={1000} unit="只" onChange={value => updateState('dailyPrefilterLimit', value)} />
            <NumberField label="分钟补拉上限" value={state.autoFetchMinuteLimit} min={0} max={500} unit="缺口" onChange={value => updateState('autoFetchMinuteLimit', value)} />
            <TextField label="开始日期" value={state.dateStart} placeholder="YYYYMMDD" onChange={value => updateState('dateStart', value.replace(/\D/g, '').slice(0, 8))} />
            <TextField label="结束日期" value={state.dateEnd} placeholder="YYYYMMDD" onChange={value => updateState('dateEnd', value.replace(/\D/g, '').slice(0, 8))} />
          </div>
        </section>

        {validationErrors.length > 0 && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-100"><p className="font-semibold">还有 {validationErrors.length} 项需要修正</p><ul className="mt-2 space-y-1">{validationErrors.map(error => <li key={error}>- {error}</li>)}</ul></div>}
        {message && <p aria-live="polite" className="text-xs font-medium text-slate-600 dark:text-slate-300">{message}</p>}
      </div>

      <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white/95 py-3 pl-5 pr-28 backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
        <p className="text-xs text-slate-500 dark:text-slate-400">保存并运行会先持久化规则，保存失败时不会启动扫描。</p>
        <div className="flex items-center gap-2">
          <button type="button" disabled={saving || validationErrors.length > 0} onClick={() => void handleSave(false)} className="min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed disabled:opacity-45 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">{saving ? '保存中...' : '保存草稿'}</button>
          <button type="button" disabled={saving || validationErrors.length > 0} onClick={() => void handleSave(true)} className="min-h-11 rounded-md bg-teal-700 px-4 text-sm font-semibold text-white shadow-sm hover:bg-teal-800 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed disabled:bg-slate-400">{saving ? '处理中...' : '保存并运行'}</button>
        </div>
      </footer>
    </div>
  )
}

function NumberField({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }): JSX.Element {
  return <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}<div className="mt-1 flex h-11 overflow-hidden rounded-md border border-slate-200 bg-white focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950"><input type="number" value={value} min={min} max={max} onChange={event => onChange(Number(event.target.value))} className="min-w-0 flex-1 bg-transparent px-3 text-sm tabular-nums text-slate-800 outline-none dark:text-slate-100" /><span className="flex items-center border-l border-slate-200 bg-slate-50 px-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900">{unit}</span></div></label>
}

function TextField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }): JSX.Element {
  return <label className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}<input value={value} placeholder={placeholder} inputMode="numeric" onChange={event => onChange(event.target.value)} className="mt-1 h-11 w-full rounded-md border border-slate-200 bg-white px-3 font-mono text-sm tabular-nums text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" /></label>
}
