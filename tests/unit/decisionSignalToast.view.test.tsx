import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DecisionSignalToast } from '../../src/components/DecisionSignalToast/DecisionSignalToast'

describe('FR-260 主动提醒视图', () => {
  it('提供真实来源、明确资讯动作、ARIA、44px热区和减少动态效果', () => {
    const output = renderToStaticMarkup(createElement(DecisionSignalToast, {
      noticeKey: 1,
      notice: {
        primary: {
          id: 9,
          sourceModule: 'news',
          priority: 5,
          title: '韩国股市熔断，两大存储芯片龙头开盘爆发',
          summary: '测试摘要',
          sourceRefJson: JSON.stringify({ briefingId: 42, sourceName: '财联社' }),
          signalTime: 100,
        },
        additionalCount: 2,
        total: 3,
      },
      raised: true,
      onOpen: vi.fn(),
      onClose: vi.fn(),
    }))

    expect(output).toContain('role="status"')
    expect(output).toContain('aria-live="polite"')
    expect(output).toContain('韩国股市熔断')
    expect(output).toContain('财联社 · 主动提醒')
    expect(output).toContain('测试摘要')
    expect(output).toContain('查看资讯原文')
    expect(output).toContain('另有 2 条高优先级消息')
    expect(output).toContain('h-11 w-11')
    expect(output).toContain('bottom-[28rem]')
    expect(output).toContain('motion-reduce:transition-none')
  })
})
