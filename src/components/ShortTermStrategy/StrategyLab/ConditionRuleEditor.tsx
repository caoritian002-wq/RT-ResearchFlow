import { useState } from 'react'
import {
  CONDITION_BLOCK_PARAMETER_DEFS,
  isConditionBlock,
  type ConditionBlock,
  type ConditionBlockType,
  type ConditionGroup,
  type ConditionGroupOperator,
} from '../../../../electron/main/services/conditionBlocks/types'
import {
  CONDITION_CATALOG,
  addBlock,
  addGroup,
  duplicateConditionNode,
  moveConditionNode,
  removeConditionNode,
  summarizeConditionBlock,
  updateConditionBlock,
  updateConditionGroup,
} from './strategyRuleModel'

interface ConditionRuleEditorProps {
  root: ConditionGroup
  executionMode: 'strict' | 'score'
  disabled?: boolean
  onChange: (root: ConditionGroup) => void
}

const GROUP_LABELS: Record<ConditionGroupOperator, string> = {
  AND: '全部满足',
  OR: '任一满足',
  NOT: '均不满足',
}

function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
      {label}
    </label>
  )
}

function ConditionRow({ block, parentId, index, count, executionMode, disabled, root, onChange }: {
  block: ConditionBlock
  parentId: string
  index: number
  count: number
  executionMode: 'strict' | 'score'
  disabled?: boolean
  root: ConditionGroup
  onChange: (root: ConditionGroup) => void
}): JSX.Element {
  const definitions = CONDITION_BLOCK_PARAMETER_DEFS[block.type]
  const update = (patch: Partial<ConditionBlock>) => onChange(updateConditionBlock(root, block.id, patch))
  const changeType = (type: ConditionBlockType) => {
    const catalog = CONDITION_CATALOG.find(item => item.type === type) ?? CONDITION_CATALOG[0]
    update({
      type,
      name: catalog.name,
      description: catalog.description,
      params: Object.fromEntries(CONDITION_BLOCK_PARAMETER_DEFS[type].map(item => [item.key, item.defaultValue])),
    })
  }
  return (
    <article data-condition-type={block.type} className={'rounded-md border px-3 py-3 transition-colors duration-200 ' + (block.enabled ? 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900' : 'border-dashed border-slate-300 bg-slate-50/80 dark:border-slate-700 dark:bg-slate-900/50')}>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label={`${block.name}启用状态`} type="checkbox" checked={block.enabled} disabled={disabled} onChange={event => update({ enabled: event.target.checked })} className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
        <select aria-label="条件类型" value={block.type} disabled={disabled} onChange={event => changeType(event.target.value as ConditionBlockType)} className="h-9 min-w-[150px] rounded-md border border-slate-200 bg-white px-2 text-sm font-medium text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 disabled:cursor-not-allowed dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
          {CONDITION_CATALOG.map(item => <option key={item.type} value={item.type}>{item.name}</option>)}
        </select>
        <span className="min-w-0 flex-1 text-xs leading-5 text-slate-600 dark:text-slate-300">{summarizeConditionBlock(block)}</span>
        {!block.enabled && <span className="rounded bg-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">已停用</span>}
        <div className="flex items-center gap-1">
          <button type="button" title="上移条件" aria-label="上移条件" disabled={disabled || index === 0} onClick={() => onChange(moveConditionNode(root, parentId, block.id, -1))} className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">↑</button>
          <button type="button" title="下移条件" aria-label="下移条件" disabled={disabled || index === count - 1} onClick={() => onChange(moveConditionNode(root, parentId, block.id, 1))} className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">↓</button>
          <button type="button" title="复制条件" aria-label="复制条件" disabled={disabled} onClick={() => onChange(duplicateConditionNode(root, block.id))} className="flex h-9 w-9 items-center justify-center rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed disabled:opacity-35 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">⧉</button>
          <button type="button" title="删除条件" aria-label="删除条件" disabled={disabled} onClick={() => onChange(removeConditionNode(root, block.id))} className="flex h-9 w-9 items-center justify-center rounded-md border border-rose-200 text-lg text-rose-600 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500/30 disabled:cursor-not-allowed disabled:opacity-35 dark:border-rose-900/60 dark:text-rose-300 dark:hover:bg-rose-950/30">×</button>
        </div>
      </div>
      {block.enabled && <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {definitions.map(definition => (
          <label key={definition.key} className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {definition.label}
            <div className="mt-1 flex h-10 overflow-hidden rounded-md border border-slate-200 bg-white focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950">
              <input
                type="number"
                data-param-key={definition.key}
                value={String(block.params[definition.key] ?? definition.defaultValue)}
                min={definition.min}
                max={definition.max}
                step={definition.step}
                disabled={disabled || !block.enabled}
                onChange={event => update({ params: { ...block.params, [definition.key]: Number(event.target.value) } })}
                className="min-w-0 flex-1 bg-transparent px-3 text-sm tabular-nums text-slate-800 outline-none disabled:cursor-not-allowed dark:text-slate-100"
              />
              {definition.unit && <span className="flex items-center border-l border-slate-200 bg-slate-50 px-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">{definition.unit}</span>}
            </div>
            <span className="mt-1 block font-normal text-slate-400">范围 {definition.min ?? '不限'} - {definition.max ?? '不限'}</span>
          </label>
        ))}
        {executionMode === 'score' && (
          <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
            条件权重
            <div className="mt-1 flex h-10 overflow-hidden rounded-md border border-slate-200 bg-white focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950">
              <input type="number" value={block.weight} min={0} max={100} step={1} disabled={disabled || !block.enabled} onChange={event => update({ weight: Number(event.target.value) })} className="min-w-0 flex-1 bg-transparent px-3 text-sm tabular-nums text-slate-800 outline-none dark:text-slate-100" />
              <span className="flex items-center border-l border-slate-200 bg-slate-50 px-2 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">分</span>
            </div>
          </label>
        )}
      </div>}
      {block.enabled && executionMode === 'score' && (
        <div className="mt-2"><Toggle checked={block.hardRequired === true} disabled={disabled || !block.enabled} label="设为硬门槛，失败时总分达标也不命中" onChange={checked => update({ hardRequired: checked })} /></div>
      )}
    </article>
  )
}

function GroupEditor({ group, root, depth, executionMode, disabled, onChange, onRemove }: {
  group: ConditionGroup
  root: ConditionGroup
  depth: number
  executionMode: 'strict' | 'score'
  disabled?: boolean
  onChange: (root: ConditionGroup) => void
  onRemove?: () => void
}): JSX.Element {
  const [nextType, setNextType] = useState<ConditionBlockType>('minute_window_gain')
  return (
    <section className={'rounded-md border p-3 ' + (depth === 0 ? 'border-teal-200 bg-teal-50/30 dark:border-teal-900/70 dark:bg-teal-950/10' : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950/50')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{depth === 0 ? '主条件组' : `子条件组 ${depth}`}</span>
        <div className="flex rounded-md border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900" role="group" aria-label="条件组逻辑">
          {(Object.keys(GROUP_LABELS) as ConditionGroupOperator[]).map(operator => (
            <button key={operator} type="button" disabled={disabled} onClick={() => onChange(updateConditionGroup(root, group.id, { operator }))} className={'min-h-8 rounded px-2.5 text-xs font-medium transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed ' + (group.operator === operator ? 'bg-teal-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>{GROUP_LABELS[operator]}</button>
          ))}
        </div>
        <Toggle checked={group.enabled} disabled={disabled} label="启用组" onChange={checked => onChange(updateConditionGroup(root, group.id, { enabled: checked }))} />
        <span className="min-w-0 flex-1 text-right text-[11px] text-slate-400">{group.children.length} 项</span>
        {onRemove && <button type="button" disabled={disabled} onClick={onRemove} className="min-h-9 rounded-md border border-rose-200 px-2.5 text-xs text-rose-600 hover:bg-rose-50 focus:outline-none focus:ring-2 focus:ring-rose-500/30 disabled:opacity-35 dark:border-rose-900/60 dark:text-rose-300">删除组</button>}
      </div>
      <div className="mt-3 space-y-2">
        {group.children.map((child, index) => isConditionBlock(child) ? (
          <ConditionRow key={child.id} block={child} parentId={group.id} index={index} count={group.children.length} executionMode={executionMode} disabled={disabled || !group.enabled} root={root} onChange={onChange} />
        ) : (
          <GroupEditor key={child.id} group={child} root={root} depth={depth + 1} executionMode={executionMode} disabled={disabled || !group.enabled} onChange={onChange} onRemove={() => onChange(removeConditionNode(root, child.id))} />
        ))}
        {group.children.length === 0 && <div className="rounded-md border border-dashed border-slate-300 px-3 py-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">这个条件组还是空的，请添加条件或子分组。</div>}
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
        <label className="text-xs font-medium text-slate-600 dark:text-slate-300">
          添加条件
          <select value={nextType} disabled={disabled || !group.enabled} onChange={event => setNextType(event.target.value as ConditionBlockType)} className="mt-1 block h-9 min-w-[160px] rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-700 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            {CONDITION_CATALOG.map(item => <option key={item.type} value={item.type}>{item.name}</option>)}
          </select>
        </label>
        <button type="button" disabled={disabled || !group.enabled} onClick={() => onChange(addBlock(root, group.id, nextType))} className="min-h-9 rounded-md bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white">添加</button>
        {depth < 4 && <button type="button" disabled={disabled || !group.enabled} onClick={() => onChange(addGroup(root, group.id))} className="min-h-9 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">添加子分组</button>}
      </div>
    </section>
  )
}

export function ConditionRuleEditor({ root, executionMode, disabled, onChange }: ConditionRuleEditorProps): JSX.Element {
  return <GroupEditor group={root} root={root} depth={0} executionMode={executionMode} disabled={disabled} onChange={onChange} />
}
