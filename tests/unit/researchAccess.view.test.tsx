import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ResearchAccessSettings } from '../../src/components/Settings/ResearchAccessSettings'

vi.mock('../../src/store/appStore', () => ({ useAppStore: () => ({}) }))

describe('FR-255 research access settings view', () => {
  it('keeps the management surface responsive, accessible and free of renderer tool execution', () => {
    const output = renderToStaticMarkup(createElement(ResearchAccessSettings))
    expect(output).toContain('research-access-settings')
    expect(output).toContain('本机研究访问')
    expect(output).toContain('创建访问配置')
    expect(output).toContain('min-h-11')
    expect(output).toContain('focus:ring-2')
    expect(output).not.toContain('callTool')
    expect(output).not.toContain('databasePath')
  })
})
