import { describe, expect, it } from 'vitest'
import { normalizeAIResponseMarkdown } from '../../src/components/AIAnalysis/aiMarkdownModel'

describe('AI Markdown展示兼容', () => {
  it('为全角或半角冒号结尾的加粗标签补齐CommonMark所需空格', () => {
    expect(normalizeAIResponseMarkdown([
      '- **当前时间：**2026年7月21日16:54',
      '- **数据来源:**用户提供的本地缓存',
      '- __样本范围：__两只股票',
    ].join('\n'))).toBe([
      '- **当前时间：** 2026年7月21日16:54',
      '- **数据来源:** 用户提供的本地缓存',
      '- __样本范围：__ 两只股票',
    ].join('\n'))
  })

  it('不改动已经合法的Markdown、代码围栏、行内代码或转义星号', () => {
    const source = [
      '- **当前时间：** 2026年7月21日16:54',
      '- `**数据来源：**用户提供`',
      '- \\*\\*字面标签：\\*\\*用户提供',
      '```text',
      '**行情截止：**2026年7月21日',
      '```',
    ].join('\n')
    expect(normalizeAIResponseMarkdown(source)).toBe(source)
  })

  it('保留普通加粗正文和包含标签词的解释句', () => {
    const source = '**事件逻辑仍在**，但价格已部分反映。\n当前位置位于**支撑观察参考**与压力之间。'
    expect(normalizeAIResponseMarkdown(source)).toBe(source)
  })
})
