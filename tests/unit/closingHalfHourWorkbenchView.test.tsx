import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ClosingHalfHour } from '../../src/components/ShortTermStrategy/ClosingHalfHour'

describe('FR-250 尾盘行为工作台静态契约', () => {
  it('首屏提供研判、刷新、历史表现和公共抽屉入口，不再渲染六张旧形态卡', () => {
    const output = renderToStaticMarkup(createElement(ClosingHalfHour, {
      dataTools: createElement('button', { type: 'button' }, '题材数据'),
      onOpenHistory: () => {},
    }))

    expect(output).toContain('data-testid="closing-half-hour-workbench"')
    expect(output).toContain('data-testid="closing-half-hour-refresh"')
    expect(output).toContain('data-testid="closing-half-hour-history"')
    expect(output).toContain('尾盘行为')
    expect(output).toContain('14:30后是否出现可延续的主动行为')
    expect(output).not.toContain('冲高回落破开盘')
    expect(output).not.toContain('小拉 3 点均线上')
    expect(output).not.toContain('Mock 演示数据')
    expect(output).not.toContain('<select')
  })
})
