import React, { useMemo, useState } from 'react'
import { DialogActions, DialogFrame, Field } from './ResearchProjectDialog'
import type {
  ResearchMarketContext,
  ResearchScenarioSet,
  ResearchValuationInput,
  ResearchValuationMethod,
} from './industryResearchTypes'

type ScenarioName = 'bear' | 'base' | 'bull'

export interface ResearchScenarioSaveDraft {
  scenarioSetId: string
  expectedVersion: number
  dataAsOf: string
  valuationDate: string
  valuationMethod: ResearchValuationMethod
  methodologyVersion: string
  scenarios: Array<{
    name: ScenarioName
    weightPct: number | null
    assumptions: Record<string, number | string | null>
    valuationInputs: Record<string, ResearchValuationInput>
    factIds: string[]
  }>
}

export interface ResearchValuationFactOption {
  factId: string
  label: string
  value: number
  unit: string
  currency: string | null
}

const METHOD_LABELS: Record<ResearchValuationMethod, string> = {
  pe: 'PE', pb_roe: 'PB-ROE', ev_ebitda: 'EV/EBITDA', dcf: 'DCF', sotp: 'SOTP', nav: 'NAV',
}

const FIELDS: Record<ResearchValuationMethod, Array<{ key: string; label: string; unit: string; unitLabel: string }>> = {
  pe: [
    { key: 'netProfit', label: '归母净利润', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'totalShares', label: '总股本', unit: 'ten_thousand_shares', unitLabel: '万股' },
    { key: 'multiple', label: 'PE倍数', unit: 'multiple', unitLabel: '倍' },
  ],
  pb_roe: [
    { key: 'netAssets', label: '归母净资产', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'totalShares', label: '总股本', unit: 'ten_thousand_shares', unitLabel: '万股' },
    { key: 'multiple', label: 'PB倍数', unit: 'multiple', unitLabel: '倍' },
    { key: 'roe', label: 'ROE校验', unit: 'percent', unitLabel: '%' },
  ],
  ev_ebitda: [
    { key: 'ebitda', label: 'EBITDA', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'netDebt', label: '净债务', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'totalShares', label: '总股本', unit: 'ten_thousand_shares', unitLabel: '万股' },
    { key: 'reverseMin', label: '反推增长率下界', unit: 'percent', unitLabel: '%' },
    { key: 'reverseMax', label: '反推增长率上界', unit: 'percent', unitLabel: '%' },
    { key: 'multiple', label: 'EV/EBITDA倍数', unit: 'multiple', unitLabel: '倍' },
  ],
  dcf: [
    { key: 'baseFcf', label: '基期自由现金流', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'growthRate', label: '预测期增长率', unit: 'percent', unitLabel: '%' },
    { key: 'discountRate', label: '折现率', unit: 'percent', unitLabel: '%' },
    { key: 'terminalGrowth', label: '终值增长率', unit: 'percent', unitLabel: '%' },
    { key: 'years', label: '预测年数', unit: 'count', unitLabel: '年' },
    { key: 'netDebt', label: '净债务', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'totalShares', label: '总股本', unit: 'ten_thousand_shares', unitLabel: '万股' },
  ],
  sotp: [
    { key: 'segment.core', label: '核心分部权益价值', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'netDebt', label: '净债务', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'totalShares', label: '总股本', unit: 'ten_thousand_shares', unitLabel: '万股' },
  ],
  nav: [
    { key: 'adjustedAssets', label: '调整后资产', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'liabilities', label: '负债', unit: 'ten_thousand_yuan', unitLabel: '万元' },
    { key: 'totalShares', label: '总股本', unit: 'ten_thousand_shares', unitLabel: '万股' },
  ],
}

function today(): string { return new Date().toISOString().slice(0, 10) }

function initialInputs(method: ResearchValuationMethod, current: ResearchScenarioSet | null): Record<ScenarioName, Record<string, ResearchValuationInput>> {
  return Object.fromEntries((['bear', 'base', 'bull'] as ScenarioName[]).map((name) => {
    const saved = current?.scenarios.find((scenario) => scenario.name === name)?.valuationInputs ?? {}
    const inputs = Object.fromEntries(FIELDS[method].map((field) => [field.key, saved[field.key] ?? {
      value: null, unit: field.unit, sourceKind: 'assumption' as const, factId: null, note: '用户透明假设',
    }]))
    if (method === 'sotp' && !inputs.reverseSegmentKey) {
      inputs.reverseSegmentKey = {
        value: null, unit: 'text', sourceKind: 'assumption' as const, factId: null, note: 'core',
      }
    }
    return [name, inputs]
  })) as Record<ScenarioName, Record<string, ResearchValuationInput>>
}

export function ResearchScenarioValuationDialog({
  current,
  market,
  facts,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  current: ResearchScenarioSet | null
  market: ResearchMarketContext
  facts: ResearchValuationFactOption[]
  saving: boolean
  error: string | null
  onClose: () => void
  onSubmit: (draft: ResearchScenarioSaveDraft) => void
}): React.ReactElement {
  const [method, setMethod] = useState<ResearchValuationMethod>(current?.valuationMethod ?? 'pe')
  const [active, setActive] = useState<ScenarioName>('base')
  const [valuationDate, setValuationDate] = useState(current?.valuationDate ?? market.requestedValuationDate ?? today())
  const [dataAsOf, setDataAsOf] = useState(current?.dataAsOf ?? today())
  const [weights, setWeights] = useState<Record<ScenarioName, string>>(Object.fromEntries((['bear', 'base', 'bull'] as ScenarioName[]).map((name) => [name, String(current?.scenarios.find((scenario) => scenario.name === name)?.weightPct ?? '')])) as Record<ScenarioName, string>)
  const [inputsByMethod, setInputsByMethod] = useState<Record<string, Record<ScenarioName, Record<string, ResearchValuationInput>>>>({
    [method]: initialInputs(method, current),
  })
  const inputs = inputsByMethod[method] ?? initialInputs(method, null)
  const fields = FIELDS[method]
  const setInput = (key: string, patch: Partial<ResearchValuationInput>) => setInputsByMethod((state) => ({
    ...state,
    [method]: {
      ...(state[method] ?? initialInputs(method, null)),
      [active]: { ...(state[method] ?? initialInputs(method, null))[active], [key]: { ...inputs[active][key], ...patch } },
    },
  }))
  const scenarioComplete = useMemo(() => Object.fromEntries((['bear', 'base', 'bull'] as ScenarioName[]).map((name) => [
    name,
    fields.every((field) => {
      const input = inputs[name][field.key]
      return input?.value != null && Number.isFinite(input.value)
        && (input.sourceKind !== 'assumption' || Boolean(input.note?.trim()))
    }),
  ])) as Record<ScenarioName, boolean>, [fields, inputs])
  const weightValues = (['bear', 'base', 'bull'] as ScenarioName[]).map((name) => weights[name] === '' ? null : Number(weights[name]))
  const weightsValid = weightValues.every((value) => value == null)
    || (weightValues.every((value) => value != null && Number.isFinite(value) && value >= 0 && value <= 100)
      && Math.abs(weightValues.reduce<number>((sum, value) => sum + (value ?? 0), 0) - 100) < 0.000001)
  const valid = Boolean(valuationDate && dataAsOf && weightsValid && Object.values(scenarioComplete).every(Boolean))
  const submit = () => onSubmit({
    scenarioSetId: current?.id ?? crypto.randomUUID(),
    expectedVersion: current?.version ?? 0,
    dataAsOf,
    valuationDate,
    valuationMethod: method,
    methodologyVersion: 'valuation-formulas-v1',
    scenarios: (['bear', 'base', 'bull'] as ScenarioName[]).map((name) => ({
      name,
      weightPct: weights[name] === '' ? null : Number(weights[name]),
      assumptions: {},
      valuationInputs: inputs[name],
      factIds: Object.values(inputs[name]).flatMap((input) => input.factId ? [input.factId] : []),
    })),
  })
  return <DialogFrame title={current ? '追加情景估值版本' : '建立情景估值'} onClose={saving ? () => undefined : onClose}>
    <form onSubmit={(event) => { event.preventDefault(); if (valid) submit() }} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="估值方法"><select value={method} onChange={(event) => {
          const next = event.target.value as ResearchValuationMethod
          setMethod(next)
          setInputsByMethod((state) => state[next] ? state : { ...state, [next]: initialInputs(next, null) })
        }} className="research-input">{Object.entries(METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        <Field label="数据截至"><input type="date" value={dataAsOf} onChange={(event) => setDataAsOf(event.target.value)} className="research-input" /></Field>
        <Field label="估值基准"><input type="date" value={valuationDate} onChange={(event) => setValuationDate(event.target.value)} className="research-input" /></Field>
      </div>
      <div className="grid grid-cols-3 gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-800" role="tablist">
        {(['bear', 'base', 'bull'] as ScenarioName[]).map((name) => <button key={name} type="button" role="tab" aria-selected={active === name} onClick={() => setActive(name)} className={`min-h-9 rounded px-3 text-xs ${active === name ? 'bg-white font-semibold text-slate-900 shadow-sm dark:bg-slate-950 dark:text-white' : 'text-slate-500'}`}>{name === 'bear' ? '悲观' : name === 'base' ? '基准' : '乐观'}<span className={`ml-1 ${scenarioComplete[name] ? 'text-emerald-600' : 'text-amber-600'}`}>{scenarioComplete[name] ? '已填' : '待填'}</span></button>)}
      </div>
      <Field label="情景权重（可全部留空）"><input type="number" min="0" max="100" step="0.1" value={weights[active]} onChange={(event) => setWeights((state) => ({ ...state, [active]: event.target.value }))} className="research-input" placeholder="%" /></Field>
      {method === 'sotp' && <Field label="当前价格反推分部"><select value={inputs[active].reverseSegmentKey?.note ?? 'core'} onChange={(event) => setInput('reverseSegmentKey', { value: null, unit: 'text', sourceKind: 'assumption', note: event.target.value })} className="research-input"><option value="core">核心分部</option></select></Field>}
      <div className="divide-y divide-slate-100 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {fields.map((field) => <div key={field.key} className="grid gap-2 py-3 sm:grid-cols-[180px_1fr_1.4fr] sm:items-end">
          <div className="text-xs font-medium">{field.label}<span className="ml-1 text-slate-400">{field.unitLabel}</span></div>
          <div className="grid gap-2 sm:grid-cols-2"><Field label="来源"><select value={inputs[active][field.key]?.sourceKind === 'fact' ? inputs[active][field.key]?.factId ?? 'assumption' : 'assumption'} onChange={(event) => {
            const selected = facts.find((fact) => fact.factId === event.target.value)
            setInput(field.key, selected
              ? { value: selected.value, unit: field.unit, sourceKind: 'fact', factId: selected.factId, note: selected.label }
              : { sourceKind: 'assumption', factId: null, note: '用户透明假设' })
          }} className="research-input"><option value="assumption">人工假设</option>{facts.filter((fact) => fact.unit === field.unit && (!fact.currency || ['CNY', 'RMB', '人民币'].includes(fact.currency.toUpperCase()))).map((fact) => <option key={fact.factId} value={fact.factId}>{fact.label}</option>)}</select></Field><Field label="数值"><input type="number" step="any" readOnly={inputs[active][field.key]?.sourceKind === 'fact'} value={inputs[active][field.key]?.value ?? ''} onChange={(event) => setInput(field.key, { value: event.target.value === '' ? null : Number(event.target.value), unit: field.unit })} className="research-input font-mono read-only:cursor-not-allowed read-only:opacity-70" /></Field></div>
          <Field label={inputs[active][field.key]?.sourceKind === 'fact' ? '本地事实' : '假设依据'}><input readOnly={inputs[active][field.key]?.sourceKind === 'fact'} value={inputs[active][field.key]?.note ?? ''} onChange={(event) => setInput(field.key, { note: event.target.value, sourceKind: 'assumption' })} className="research-input read-only:cursor-not-allowed read-only:opacity-70" maxLength={1000} /></Field>
        </div>)}
      </div>
      {!weightsValid && <div role="alert" className="border-l-2 border-amber-500 pl-3 text-xs text-amber-700 dark:text-amber-300">情景权重需要全部留空，或三项合计为100。</div>}
      {!Object.values(scenarioComplete).every(Boolean) && <div role="status" className="border-l-2 border-slate-300 pl-3 text-xs text-slate-500">请依次完成悲观、基准和乐观三项输入；未完成的页签已标记为“待填”。</div>}
      {error && <div role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</div>}
      <DialogActions saving={saving} valid={Boolean(valid)} onClose={onClose} submitLabel="保存情景版本" />
    </form>
  </DialogFrame>
}
