import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('FR-252 explicit portfolio gap backfill contracts', () => {
  it('reuses the existing trend IPC and only falls back when Tushare is absent', () => {
    const handlers = source('electron/main/ipc/trendHandlers.ts')
    const start = handlers.indexOf("ipcMain.handle('trend:backfillStocks'")
    const handler = handlers.slice(start)

    expect(start).toBeGreaterThan(0)
    expect(handler).toContain('backfillTrendStockData(db, token, tsCodes, win)')
    expect(handler).toContain("error: 'INVALID_PARAM'")
    expect(handler).not.toContain("if (!cfg.tushareEnabled || !cfg.tushareTokenEncrypted)")
  })

  it('returns per-stock source, fact date, coverage and errors through preload', () => {
    const preload = source('electron/preload/index.ts')
    const start = preload.indexOf('backfillStocks: (tsCodes: string[])')
    const contract = preload.slice(start, preload.indexOf('onScoresUpdated:', start))

    expect(contract).toContain("provider: 'tushare' | 'eastmoney' | 'local-cache'")
    expect(contract).toContain('latestTradeDate: string | null')
    expect(contract).toContain("state: 'ready' | 'partial' | 'missing'")
    expect(contract).toContain('message: string')
    expect(contract).toContain('error: string | null')
  })

  it('keeps backfill behind explicit portfolio buttons and exposes progress', () => {
    const dashboard = source('src/components/TrendWatcher/PortfolioDashboard.tsx')

    expect(dashboard).toContain('data-testid="portfolio-backfill-all"')
    expect(dashboard).toContain('data-testid="portfolio-backfill-selected"')
    expect(dashboard).toContain('data-testid="portfolio-backfill-status"')
    expect(dashboard).toContain('window.api.trend.backfillStocks(uniqueCodes)')
    expect(dashboard).not.toMatch(/useEffect\(\(\) => \{[^}]*backfillStocks/s)
  })
})
