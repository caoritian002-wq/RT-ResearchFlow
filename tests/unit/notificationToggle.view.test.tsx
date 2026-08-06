import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { NotificationToggle } from '../../src/components/Settings/Settings'

describe('设置页通知开关', () => {
  it('使用固定左基准移动滑块且保留 44px 操作热区', () => {
    vi.stubGlobal('React', React)
    const output = renderToStaticMarkup(React.createElement(NotificationToggle, {
      label: '应用内主动提醒',
      description: '测试说明',
      checked: true,
      onChange: vi.fn(),
    }))

    expect(output).toContain('role="switch"')
    expect(output).toContain('aria-checked="true"')
    expect(output).toContain('h-11 w-14')
    expect(output).toContain('absolute left-0.5 top-0.5')
    expect(output).toContain('translate-x-5')
  })
})
