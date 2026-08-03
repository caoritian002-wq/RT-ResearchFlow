import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FirstYinDip } from '../../src/components/ShortTermStrategy/FirstYinDip'

describe('FR-250 首阴回踩工作台静态契约', () => {
  it('首屏提供状态研判、刷新、历史表现和公共抽屉入口，不再渲染旧安全阀与伪择时', () => {
    const output = renderToStaticMarkup(createElement(FirstYinDip, {
      dataTools: createElement('button', { type: 'button' }, '题材数据'),
      onOpenHistory: () => {},
    }))

    expect(output).toContain('data-testid="first-yin-workbench"')
    expect(output).toContain('data-testid="first-yin-refresh"')
    expect(output).toContain('data-testid="first-yin-history"')
    expect(output).toContain('首阴回踩')
    expect(output).toContain('首次分歧、修复边界与失败状态')
    expect(output).not.toContain('换手 ≥ 40%')
    expect(output).not.toContain('尾盘缩量企稳')
    expect(output).not.toContain('次日竞价弱转强')
    expect(output).not.toContain('Mock 演示数据')
    expect(output).not.toContain('<select')
  })
})
