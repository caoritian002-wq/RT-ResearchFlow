import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RightDrawer } from '../../src/components/shared/RightDrawer'
import { StockKlineChipDrawer } from '../../src/components/shared/StockMiniChart'

describe('股票日K与筹码峰通用抽屉', () => {
  it('使用覆盖整个应用的模态抽屉、蒙层和可访问的宽度调整与关闭入口', () => {
    const output = renderToStaticMarkup(createElement(RightDrawer, {
      title: '股票详情',
      description: '600000.SH',
      onClose: vi.fn(),
      actions: createElement('button', { type: 'button' }, '查看完整走势'),
      testId: 'drawer-contract',
      children: createElement('div', null, '内容'),
    }))

    expect(output).toContain('data-testid="drawer-contract"')
    expect(output).toContain('data-testid="drawer-contract-overlay"')
    expect(output).toContain('data-testid="drawer-contract-scrim"')
    expect(output).toContain('fixed inset-0')
    expect(output).toContain('bg-slate-950/50')
    expect(output).toContain('role="dialog"')
    expect(output).toContain('aria-modal="true"')
    expect(output).toContain('aria-label="调整抽屉宽度"')
    expect(output).toContain('aria-label="关闭抽屉"')
    expect(output).toContain('h-11 w-11')
    expect(output).not.toContain('app-overlay-below-titlebar')
  })

  it('股票内容以日K和筹码峰为主并保留完整走势图入口', () => {
    const output = renderToStaticMarkup(createElement(StockKlineChipDrawer, {
      tsCode: '000815.SZ',
      stockName: '美利云',
      onClose: vi.fn(),
      onNavigate: vi.fn(),
    }))

    expect(output).toContain('data-testid="stock-kline-chip-drawer"')
    expect(output).toContain('data-testid="stock-chip-profile"')
    expect(output).toContain('data-testid="stock-kline-candle-chart"')
    expect(output).toContain('data-testid="stock-structure-insight"')
    expect(output).toContain('价格 × 筹码结构研判')
    expect(output).toContain('趋势与位置')
    expect(output).toContain('当前筹码结构')
    expect(output).toContain('关键位置与风险')
    expect(output).toContain('更多技术因子')
    expect(output).toContain('近期日K与筹码峰')
    expect(output).toContain('筹码分布')
    expect(output).toContain('浮盈筹码')
    expect(output).toContain('套牢筹码')
    expect(output).toContain('距主峰')
    expect(output).toContain('现价')
    expect(output).toContain('30日')
    expect(output).toContain('60日')
    expect(output).toContain('120日')
    expect(output).toContain('打开完整走势')
    expect(output).toContain('正在读取近期日K与筹码')
    expect(output).not.toContain('今日分时')
  })
})
