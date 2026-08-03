import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SecondBoardLeader } from '../../src/components/ShortTermStrategy/SecondBoardLeader'

describe('FR-250 连板梯队工作台静态契约', () => {
  it('提供结论工作台、历史入口和可访问筛选，不回退到原生select', () => {
    const output = renderToStaticMarkup(createElement(SecondBoardLeader, {
      dataTools: createElement('button', { type: 'button' }, '题材数据'),
      onOpenHistory: () => {},
    }))

    expect(output).toContain('data-testid="second-board-workbench"')
    expect(output).toContain('data-testid="second-board-refresh"')
    expect(output).toContain('data-testid="second-board-history"')
    expect(output).toContain('连板梯队')
    expect(output).toContain('判断市场高度、题材梯队和高标是否拥有同方向助攻')
    expect(output).not.toContain('<select')
    expect(output).not.toContain('连板龙头（二板）')
    expect(output).not.toContain('评分阈值')
  })
})
