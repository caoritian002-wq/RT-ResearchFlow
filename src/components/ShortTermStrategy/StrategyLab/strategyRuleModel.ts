import { DEFAULT_CONDITION_BLOCK_TEMPLATES } from '../../../../electron/main/services/conditionBlocks/defaultTemplates'
import {
  CONDITION_BLOCK_PARAMETER_DEFS,
  isConditionBlock,
  type BlockStrategyTemplate,
  type ConditionBlock,
  type ConditionBlockType,
  type ConditionGroup,
  type ConditionGroupOperator,
} from '../../../../electron/main/services/conditionBlocks/types'

export interface ConditionCatalogItem {
  type: ConditionBlockType
  name: string
  description: string
}

export const CONDITION_CATALOG: ConditionCatalogItem[] = [
  { type: 'minute_window_gain', name: '窗口涨幅', description: '寻找盘中任意时间窗口内的价格拉升。' },
  { type: 'minute_window_amount_ratio', name: '成交额放大', description: '比较拉升窗口与此前基准窗口的平均成交额。' },
  { type: 'minute_window_volume_ratio', name: '成交量放大', description: '比较拉升窗口与此前基准窗口的平均成交量。' },
  { type: 'pullback_after_high', name: '高点后回撤', description: '限制命中窗口高点后的最大回撤。' },
  { type: 'hold_above_gain_ratio', name: '后续站稳比例', description: '判断拉升后的价格能够保留多少涨幅。' },
  { type: 'close_retention', name: '收盘保持度', description: '判断收盘价保留拉升幅度的比例。' },
]

const CATALOG_MAP = new Map(CONDITION_CATALOG.map(item => [item.type, item]))

function makeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${random}`
}

export function createStrategyTemplateKey(): string {
  return `strategy_lab_${makeId('minute').replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

export function cloneConditionTemplate(template: BlockStrategyTemplate): BlockStrategyTemplate {
  return JSON.parse(JSON.stringify(template)) as BlockStrategyTemplate
}

export function createDefaultMinuteTemplate(): BlockStrategyTemplate {
  const template = cloneConditionTemplate(DEFAULT_CONDITION_BLOCK_TEMPLATES[0])
  return {
    ...template,
    key: createStrategyTemplateKey(),
    name: '我的分钟条件策略',
    description: '按自定义分钟条件筛选股票。',
    version: 1,
  }
}

export function createConditionBlock(type: ConditionBlockType): ConditionBlock {
  const catalog = CATALOG_MAP.get(type) ?? CONDITION_CATALOG[0]
  return {
    id: makeId('condition'),
    type,
    name: catalog.name,
    description: catalog.description,
    enabled: true,
    weight: 20,
    hardRequired: type === 'minute_window_gain',
    params: Object.fromEntries(
      CONDITION_BLOCK_PARAMETER_DEFS[type].map(definition => [definition.key, definition.defaultValue]),
    ),
  }
}

export function createConditionGroup(operator: ConditionGroupOperator = 'AND'): ConditionGroup {
  return {
    id: makeId('group'),
    operator,
    enabled: true,
    children: [],
  }
}

function updateGroup(root: ConditionGroup, groupId: string, updater: (group: ConditionGroup) => ConditionGroup): ConditionGroup {
  if (root.id === groupId) return updater(root)
  return {
    ...root,
    children: root.children.map(child => isConditionBlock(child) ? child : updateGroup(child, groupId, updater)),
  }
}

export function addBlock(root: ConditionGroup, groupId: string, type: ConditionBlockType): ConditionGroup {
  return updateGroup(root, groupId, group => ({ ...group, children: [...group.children, createConditionBlock(type)] }))
}

export function addGroup(root: ConditionGroup, groupId: string, operator: ConditionGroupOperator = 'AND'): ConditionGroup {
  return updateGroup(root, groupId, group => ({ ...group, children: [...group.children, createConditionGroup(operator)] }))
}

export function updateConditionGroup(root: ConditionGroup, groupId: string, patch: Partial<Pick<ConditionGroup, 'operator' | 'enabled'>>): ConditionGroup {
  return updateGroup(root, groupId, group => ({ ...group, ...patch }))
}

export function updateConditionBlock(root: ConditionGroup, blockId: string, patch: Partial<ConditionBlock>): ConditionGroup {
  return {
    ...root,
    children: root.children.map(child => {
      if (isConditionBlock(child)) return child.id === blockId ? { ...child, ...patch } : child
      return updateConditionBlock(child, blockId, patch)
    }),
  }
}

export function removeConditionNode(root: ConditionGroup, nodeId: string): ConditionGroup {
  return {
    ...root,
    children: root.children
      .filter(child => child.id !== nodeId)
      .map(child => isConditionBlock(child) ? child : removeConditionNode(child, nodeId)),
  }
}

function cloneNode<T extends ConditionBlock | ConditionGroup>(node: T): T {
  if (isConditionBlock(node)) return { ...node, id: makeId('condition'), params: { ...node.params } } as T
  return {
    ...node,
    id: makeId('group'),
    children: node.children.map(child => cloneNode(child)),
  } as T
}

export function duplicateConditionNode(root: ConditionGroup, nodeId: string): ConditionGroup {
  return {
    ...root,
    children: root.children.flatMap(child => {
      if (child.id === nodeId) return [child, cloneNode(child)]
      return [isConditionBlock(child) ? child : duplicateConditionNode(child, nodeId)]
    }),
  }
}

export function moveConditionNode(root: ConditionGroup, groupId: string, nodeId: string, direction: -1 | 1): ConditionGroup {
  return updateGroup(root, groupId, group => {
    const index = group.children.findIndex(child => child.id === nodeId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= group.children.length) return group
    const children = [...group.children]
    const [node] = children.splice(index, 1)
    children.splice(target, 0, node)
    return { ...group, children }
  })
}

function numericParam(block: ConditionBlock, key: string): number {
  const value = Number(block.params[key])
  return Number.isFinite(value) ? value : 0
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function summarizeConditionBlock(block: ConditionBlock): string {
  if (block.type === 'minute_window_gain') {
    return `任意 ${formatNumber(numericParam(block, 'windowMinutes'))} 分钟涨幅 ≥ ${formatNumber(numericParam(block, 'minGainPct'))}%`
  }
  if (block.type === 'minute_window_amount_ratio') {
    return `${formatNumber(numericParam(block, 'windowMinutes'))} 分钟成交额相对前 ${formatNumber(numericParam(block, 'baselineMinutes'))} 分钟 ≥ ${formatNumber(numericParam(block, 'minRatio'))} 倍`
  }
  if (block.type === 'minute_window_volume_ratio') {
    return `${formatNumber(numericParam(block, 'windowMinutes'))} 分钟成交量相对前 ${formatNumber(numericParam(block, 'baselineMinutes'))} 分钟 ≥ ${formatNumber(numericParam(block, 'minRatio'))} 倍`
  }
  if (block.type === 'pullback_after_high') {
    return `高点后 ${formatNumber(numericParam(block, 'afterMinutes'))} 分钟最大回撤 ≤ ${formatNumber(numericParam(block, 'maxPullbackPct'))}%`
  }
  if (block.type === 'hold_above_gain_ratio') {
    return `后续 ${formatNumber(numericParam(block, 'afterMinutes'))} 分钟站稳比例 ≥ ${formatNumber(numericParam(block, 'minHoldRatio'))}%`
  }
  return `收盘保持度 ≥ ${formatNumber(numericParam(block, 'minRetentionPct'))}%`
}

export function summarizeConditionGroup(group: ConditionGroup): string {
  const items = group.children
    .filter(child => child.enabled)
    .map(child => isConditionBlock(child) ? summarizeConditionBlock(child) : summarizeConditionGroup(child))
  if (items.length === 0) return '尚未添加启用条件'
  if (group.operator === 'NOT') return `以下条件均不成立：${items.join('；')}`
  return items.join(group.operator === 'AND' ? '，并且 ' : '，或者 ')
}

export function listConditionBlocks(group: ConditionGroup): ConditionBlock[] {
  return group.children.flatMap(child => isConditionBlock(child) ? [child] : listConditionBlocks(child))
}

export function validateConditionTemplate(template: BlockStrategyTemplate): string[] {
  const errors: string[] = []
  const blocks = listConditionBlocks(template.root)
  if (!blocks.some(block => block.enabled)) errors.push('至少需要一个启用的分钟条件。')
  if (template.executionMode === 'score' && blocks.filter(block => block.enabled).every(block => block.weight <= 0)) {
    errors.push('评分模式下至少有一个启用条件的权重必须大于 0。')
  }
  for (const block of blocks) {
    for (const definition of CONDITION_BLOCK_PARAMETER_DEFS[block.type]) {
      const value = Number(block.params[definition.key])
      if (!Number.isFinite(value)) {
        errors.push(`${block.name}的“${definition.label}”不是有效数字。`)
      } else if (definition.min != null && value < definition.min) {
        errors.push(`${block.name}的“${definition.label}”不能小于 ${definition.min}${definition.unit ?? ''}。`)
      } else if (definition.max != null && value > definition.max) {
        errors.push(`${block.name}的“${definition.label}”不能大于 ${definition.max}${definition.unit ?? ''}。`)
      }
    }
  }
  return errors
}

