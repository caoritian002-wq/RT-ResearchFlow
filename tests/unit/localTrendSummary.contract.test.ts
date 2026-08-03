import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('FR-252 local trend summary contracts', () => {
  it('uses a pure local model without IPC, network or AI calls', () => {
    const model = source('src/components/TrendWatcher/localTrendSummary.ts')
    const panel = source('src/components/TrendWatcher/LocalTrendSummaryPanel.tsx')

    expect(model).toContain("method: 'local-rules'")
    expect(model).toContain('换手率缺失，量能质量未参与评分')
    expect(model).toContain('暂不形成趋势结构结论')
    expect(`${model}\n${panel}`).not.toMatch(/window\.api|fetch\(|ipcRenderer|ai:/)
  })

  it('reuses the same summary in portfolio detail and trend radar', () => {
    const portfolio = source('src/components/TrendWatcher/PortfolioDashboard.tsx')
    const radar = source('src/components/TrendWatcher/TrendDashboard.tsx')

    expect(portfolio).toContain('<LocalTrendSummaryPanel item={selected.trendItem} />')
    expect(portfolio).toContain('模型预测与本地事实摘要独立')
    expect(radar).toContain('buildLocalTrendSummary(item)')
    expect(radar).toContain('data-testid={`local-trend-radar-${item.stockCode}`}')
  })
})
