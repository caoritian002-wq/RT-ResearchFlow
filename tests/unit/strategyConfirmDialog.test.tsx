import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { StrategyConfirmDialog } from '../../src/components/ShortTermStrategy/StrategyLab/StrategyConfirmDialog'

describe('策略实验室项目内确认模态', () => {
  it('未保存配置默认保留编辑，并提供明确的放弃动作', () => {
    const output = renderToStaticMarkup(createElement(StrategyConfirmDialog, {
      action: { kind: 'discard', strategyName: '盘中强势规则' },
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }))

    expect(output).toContain('data-testid="strategy-confirm-dialog"')
    expect(output).toContain('role="dialog"')
    expect(output).toContain('aria-modal="true"')
    expect(output).toContain('放弃未保存修改？')
    expect(output).toContain('继续编辑')
    expect(output).toContain('放弃修改')
    expect(output).toContain('h-11')
    expect(output).not.toContain('window.confirm')
  })

  it('删除策略使用同一套项目内危险操作语义', () => {
    const output = renderToStaticMarkup(createElement(StrategyConfirmDialog, {
      action: { kind: 'delete', strategyId: 7, strategyName: '我的策略' },
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }))

    expect(output).toContain('删除策略？')
    expect(output).toContain('不可撤销')
    expect(output).toContain('我的策略')
    expect(output).toContain('原始信号、行情缓存和其他策略不会被删除。')
  })
})
