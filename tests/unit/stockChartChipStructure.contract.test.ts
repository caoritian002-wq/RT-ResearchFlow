import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('stock chart chip structure contracts', () => {
  it('uses the latest complete same-day snapshot only for the normal latest view', () => {
    const chart = source('src/components/StockChart/StockChart.tsx')
    const preload = source('electron/preload/index.ts')
    const service = source('electron/main/services/chipStructureService.ts')

    expect(preload).toContain("selectionPolicy?: 'latest_fact' | 'latest_complete'")
    expect(service).toContain("selectionPolicy: ChipStructureSummarySelectionPolicy = 'latest_fact'")
    expect(chart).toContain('{ selectionPolicy: "latest_complete" as const }')
    expect(chart).toContain('{ tradeDate: explicitChipTradeDate }')
    expect(chart).toContain('referenceTradeDate: activeChipTradeDate')
  })

  it('keeps loading local-only and exposes a forced manual refresh with task completion reload', () => {
    const chart = source('src/components/StockChart/StockChart.tsx')
    const summaryLoadStart = chart.indexOf('void window.api.chipStructure.getSummaries({')
    const summaryLoadEnd = chart.indexOf('}).then((response)', summaryLoadStart)
    const summaryLoad = chart.slice(summaryLoadStart, summaryLoadEnd)

    expect(summaryLoad).not.toContain('chipStructure.refresh')
    expect(chart).toContain('data-testid="stock-chip-structure-refresh"')
    expect(chart).toContain('scope: "structure"')
    expect(chart).toContain('force: true')
    expect(chart).toContain('window.api.chipStructure.onDone')
    expect(chart).toContain('setChipStructureReloadKey((value) => value + 1)')
    expect(chart).toContain('同日归一')
    expect(chart).toContain('口径一致')
    expect(chart).toContain('暂无可归一化筹码事实')
    expect(chart).not.toContain('? "完整" : chipStructureSummary.completenessStatus === "partial" ? "部分" : "受阻"')
  })
})
