import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('FR-253 public fundamentals contracts', () => {
  it('uses two fixed HTTPS sources behind narrow IPC channels', () => {
    const service = source('electron/main/services/stockFundamentalService.ts')
    const handlers = source('electron/main/ipc/stockFundamentalHandlers.ts')
    const preload = source('electron/preload/index.ts')

    expect(service).toContain("const COMPANY_SURVEY_URL = 'https://emweb.securities.eastmoney.com/")
    expect(service).toContain("const MAIN_FINANCE_URL = 'https://datacenter.eastmoney.com/")
    expect(service).toContain("const ANNOUNCEMENT_INDEX_URL = 'https://np-anotice-stock.eastmoney.com/")
    expect(service).toContain('Promise.allSettled')
    expect(service).toContain('const inflightByDb = new WeakMap')
    expect(service).toContain('noticeDate != null && noticeDate > today')
    expect(service).toContain("url.searchParams.set('page_size', '30')")
    expect(service).toContain("url.searchParams.set('stock_list', normalized.stockCode)")
    expect(service).toContain('displayAt != null && displayAt > fetchedAt')
    expect(service).toContain('getStockFundamentalAnnouncementAttention')
    expect(service).not.toContain('openai')
    expect(service).not.toContain('tushare')
    expect(handlers).toContain("ipcMain.handle('stockFundamentals:get'")
    expect(handlers).toContain("ipcMain.handle('stockFundamentals:refresh'")
    expect(preload).toContain('stockFundamentals: {')
    expect(preload).toContain("ipcRenderer.invoke('stockFundamentals:get', { stockCode })")
    expect(preload).toContain("ipcRenderer.invoke('stockFundamentals:refresh', { stockCode })")
  })

  it('keeps drawer opening local and makes refresh an explicit accessible command', () => {
    const chart = source('src/components/StockChart/StockChart.tsx')
    const drawer = source('src/components/StockChart/StockFundamentalDrawer.tsx')
    const buttonStart = chart.indexOf('data-testid="stock-fundamental-open"')
    const buttonEnd = chart.indexOf('</button>', buttonStart)
    const fundamentalButton = chart.slice(buttonStart, buttonEnd)

    expect(chart).toContain('data-testid="stock-fundamental-open"')
    expect(fundamentalButton).toContain('h-7')
    expect(fundamentalButton).toContain('after:-inset-y-2')
    expect(fundamentalButton).not.toContain('h-11')
    expect(chart).toContain('!PRESET_CODES.includes(selected)')
    expect(drawer).toContain('await api.get(stockCode)')
    expect(drawer).toContain('await api.refresh(stockCode)')
    expect(drawer).toContain('aria-live="polite"')
    expect(drawer).toContain('disabled={refreshing}')
    expect(drawer).toContain('来源未提供资料更新日')
    expect(drawer).toContain("profile.businessScope ?? '来源未提供'")
    expect(drawer).toContain("if (value == null || !Number.isFinite(value)) return '—'")
    expect(drawer).toContain('testId="stock-fundamental-drawer"')
    expect(drawer).toContain('role="tablist"')
    expect(drawer).toContain('role="tab"')
    expect(drawer).toContain('stock-fundamental-tab-announcements')
    expect(drawer).toContain('stock-fundamental-tab-${value}-visual')
    expect(drawer).toContain('h-7 min-w-28')
    expect(drawer).toContain('data-testid="stock-fundamental-refresh-visual"')
    expect(drawer).toContain('stock-fundamental-source-summary')
    expect(drawer).toContain("tone: 'bg-slate-300 dark:bg-slate-600'")
    expect(drawer).toContain('重点标签仅由公告标题和上游分类匹配')
    expect(drawer).toContain('window.api.openExternal(url)')
    expect(drawer).not.toContain('fetch(')
  })
})
