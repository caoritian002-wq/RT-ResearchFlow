import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PriorityNewsPreviewDevPanel } from '../../src/components/ConfigDrawer/PriorityNewsPreviewDevPanel'

describe('FR-260 开发环境主动提醒验收面板', () => {
  it('明确真实数据边界、60秒间隔和完整启停动作', () => {
    const output = renderToStaticMarkup(createElement(PriorityNewsPreviewDevPanel, {
      state: {
        status: 'running',
        candidateCount: 20,
        shownCount: 2,
        lastTitle: '美联储，加息突传变数！美国财长最新发声',
        message: null,
      },
      onStart: vi.fn(),
      onShowNext: vi.fn(),
      onStop: vi.fn(),
    }))

    expect(output).toContain('FR-260 主动提醒验收')
    expect(output).toContain('最近 180 天已经存在的 P4/P5')
    expect(output).toContain('60 秒')
    expect(output).toContain('立即显示下一条')
    expect(output).toContain('停止轮播')
    expect(output).toContain('不新增决策信号')
    expect(output).toContain('h-11')
    expect(output).toContain('aria-live="polite"')
  })
})
