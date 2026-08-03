import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('FR-252 benchmark freshness contracts', () => {
  it('keeps workbench reads local while explicit data paths use the shared refresh guard', () => {
    const workbench = source('electron/main/services/trendWorkbenchService.ts')
    const datasource = source('electron/main/services/tushareService.ts')
    const backfill = source('electron/main/services/trendSyncService.ts')

    expect(workbench).toContain('inspectTrendBenchmarkHealth(db, now)')
    expect(workbench).not.toContain('ensureTrendBenchmarkFreshness')
    expect(datasource).toContain('const benchmarkInFlight = new WeakMap')
    expect(datasource).toContain('const benchmarkAttempts = new WeakMap')
    expect(datasource).toContain('ensureTrendBenchmarkFreshness(db)')
    expect(backfill).toContain('result.benchmark = await ensureTrendBenchmarkFreshness(db)')
  })

  it('exposes benchmark state and suppresses unconfirmed relative facts in both views', () => {
    const model = source('src/components/TrendWatcher/localTrendSummary.ts')
    const portfolio = source('src/components/TrendWatcher/PortfolioDashboard.tsx')
    const radar = source('src/components/TrendWatcher/TrendDashboard.tsx')

    expect(model).toContain("const benchmarkCurrent = item.benchmarkHealth?.state === 'current'")
    expect(model).toContain("if (benchmarkCurrent)")
    expect(portfolio).toContain('<TrendBenchmarkMeta health={snapshot.dataHealth.benchmark} />')
    expect(radar).toContain("item.benchmarkHealth?.state === 'current' ? item.facts?.excessReturn20d : null")
  })
})
