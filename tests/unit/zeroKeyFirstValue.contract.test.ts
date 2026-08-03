import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('FR-252 zero-key first-value contracts', () => {
  it('keeps the fallback inside existing narrow IPC channels', () => {
    const handlers = source('electron/main/ipc/aiHandlers.ts')
    const fetchStart = handlers.indexOf("ipcMain.handle('datasource:fetchStock'")
    const fetchEnd = handlers.indexOf("ipcMain.handle('datasource:updateStockName'", fetchStart)
    const refreshStart = handlers.indexOf("ipcMain.handle('datasource:refreshStock'")
    const refreshEnd = handlers.indexOf("ipcMain.handle('datasource:fetchStock'", refreshStart)
    const fetchHandler = handlers.slice(fetchStart, fetchEnd)
    const refreshHandler = handlers.slice(refreshStart, refreshEnd)

    expect(fetchStart).toBeGreaterThan(0)
    expect(refreshStart).toBeGreaterThan(0)
    expect(fetchHandler).toContain("getCachedStockFetchSummary(db, stockCode, 'local-cache', 0)")
    expect(fetchHandler).toContain('fetchEastmoneySingleStockDaily(db, stockCode)')
    expect(fetchHandler).not.toContain('TUSHARE_NOT_CONFIGURED')
    expect(refreshHandler).toContain('fetchEastmoneySingleStockDaily(db, stockCode)')
    expect(refreshHandler).toContain("reason: 'invalid_code'")
  })

  it('exposes source, fact date and coverage without adding a preload namespace', () => {
    const preload = source('electron/preload/index.ts')
    const chart = source('src/components/StockChart/StockChart.tsx')

    expect(preload).toContain("provider: 'tushare' | 'eastmoney' | 'local-cache'")
    expect(preload).toContain("dataState: 'complete' | 'degraded'")
    expect(preload).toContain('latestTradeDate: string | null')
    expect(preload).toContain('totalRows: number')
    expect(chart).toContain('data-testid="stock-data-source-status"')
    expect(chart).toContain('data-provider={stockDataStatus.provider}')
    expect(chart).toContain('aria-live="polite"')
    expect(chart).toContain('await reloadStocks();')
  })

  it('uses one fixed benchmark and does not put it into the stock-list cache', () => {
    const service = source('electron/main/services/tushareService.ts')

    expect(service).toContain('const benchmark = await ensureTrendBenchmarkFreshness(db)')
    expect(service).toContain("const dailyOnly = tsCode === '000300.SH'")
    expect(service).toContain('if (!dailyOnly) insertPrices(db, sortedRows)')
    expect(service).toContain('upsertDailyClose(db, dailyRows)')
  })
})
