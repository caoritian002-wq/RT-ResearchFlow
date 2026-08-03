import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LimitBoardMonitor } from '../../src/components/ShortTermStrategy/LimitBoardMonitor'
import { ShortTermCombobox } from '../../src/components/ShortTermStrategy/ShortTermDecisionControls'

describe('FR-250 涨停质量工作台静态契约', () => {
  it('使用44px可访问组合框，不回退到原生select', () => {
    const output = renderToStaticMarkup(createElement(ShortTermCombobox, {
      value: 'all',
      options: [{ value: 'all', label: '全部' }],
      ariaLabel: '质量层级',
      testId: 'quality-filter',
      onChange: () => {},
    }))

    expect(output).toContain('role="combobox"')
    expect(output).toContain('aria-label="质量层级"')
    expect(output).toContain('h-11')
    expect(output).not.toContain('<select')
  })

  it('页面首屏提供刷新、历史表现和工作台语义，不再挂载旧竞价回测弹层', () => {
    const output = renderToStaticMarkup(createElement(LimitBoardMonitor, {
      dataTools: createElement('button', { type: 'button' }, '题材数据'),
      onOpenHistory: () => {},
    }))

    expect(output).toContain('data-testid="limit-board-workbench"')
    expect(output).toContain('data-testid="limit-board-refresh"')
    expect(output).toContain('data-testid="limit-board-history"')
    expect(output).toContain('涨停质量')
    expect(output).not.toContain('历史回测胜率')
  })
})
