import { describe, expect, it } from 'vitest'
import {
  addBlock,
  addGroup,
  createDefaultMinuteTemplate,
  duplicateConditionNode,
  listConditionBlocks,
  summarizeConditionGroup,
  updateConditionBlock,
  updateConditionGroup,
  validateConditionTemplate,
} from '../../src/components/ShortTermStrategy/StrategyLab/strategyRuleModel'

describe('strategy rule model', () => {
  it('参数变化会同步进入自然语言摘要', () => {
    const template = createDefaultMinuteTemplate()
    const gain = listConditionBlocks(template.root).find(item => item.type === 'minute_window_gain')!
    template.root = updateConditionBlock(template.root, gain.id, {
      params: { ...gain.params, minGainPct: 5 },
    })

    expect(summarizeConditionGroup(template.root)).toContain('涨幅 ≥ 5%')
    expect(validateConditionTemplate(template)).toEqual([])
  })

  it('支持嵌套 OR/NOT 分组和条件添加', () => {
    const template = createDefaultMinuteTemplate()
    template.root = addGroup(template.root, template.root.id, 'OR')
    const nested = template.root.children.find(item => !('type' in item))!
    template.root = updateConditionGroup(template.root, nested.id, { operator: 'NOT' })
    template.root = addBlock(template.root, nested.id, 'minute_window_amount_ratio')

    const summary = summarizeConditionGroup(template.root)
    expect(summary).toContain('以下条件均不成立')
    expect(listConditionBlocks(template.root).some(item => item.type === 'minute_window_amount_ratio')).toBe(true)
  })

  it('复制条件会生成新 ID，越界参数会被拦截', () => {
    const template = createDefaultMinuteTemplate()
    const first = listConditionBlocks(template.root)[0]
    template.root = duplicateConditionNode(template.root, first.id)
    const ids = listConditionBlocks(template.root).map(item => item.id)
    expect(new Set(ids).size).toBe(ids.length)

    const duplicated = listConditionBlocks(template.root)[1]
    template.root = updateConditionBlock(template.root, duplicated.id, {
      params: { ...duplicated.params, minGainPct: 31 },
    })
    expect(validateConditionTemplate(template).join(' ')).toContain('不能大于 30%')
  })
})

