import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function seedTrendFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const ymd = (offset) => {
      const date = new Date(Date.now() + offset * 86400000)
      return String(date.getUTCFullYear()) + String(date.getUTCMonth() + 1).padStart(2, '0') + String(date.getUTCDate()).padStart(2, '0')
    }
    const stocks = [
      { code: '600001.SH', name: '风险样本', base: 28, step: -0.09, category: 'PCB', sub: '通信/服务器PCB', group: '持仓复核', portfolio: true, cost: 34 },
      { code: '000002.SZ', name: '稳定样本', base: 18, step: 0.08, category: '储能', sub: '储能系统集成商', group: '核心持仓', portfolio: true, cost: 17 },
      { code: '300003.SZ', name: '转强样本', base: 22, step: 0.14, category: 'CPO', sub: '光模块', group: '重点观察', portfolio: false, cost: null },
      { code: '600004.SH', name: '待补样本', base: 12, step: 0.04, category: '半导体材料', sub: '测试板', group: '数据待补', portfolio: false, cost: null },
    ]
    db.exec('DELETE FROM trend_watchlist; DELETE FROM trend_scores; DELETE FROM trend_alerts; DELETE FROM daily_close_cache; DELETE FROM portfolio_stocks;')
    const watchInsert = db.prepare('INSERT INTO trend_watchlist (ts_code, stock_name, group_tag, added_at, category, sub_category, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const portfolioInsert = db.prepare('INSERT INTO portfolio_stocks (ts_code, stock_name, added_at, cost_price) VALUES (?, ?, ?, ?)')
    const dailyInsert = db.prepare('INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const alertInsert = db.prepare('INSERT INTO trend_alerts (ts_code, stock_name, alert_type, alert_date, price, ref_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')

    const seedBars = (code, base, step, count) => {
      for (let index = 0; index < count; index += 1) {
        const date = ymd(index - count + 1)
        const close = base + step * index + Math.sin(index / 5) * 0.35
        const previous = index === 0 ? close : base + step * (index - 1) + Math.sin((index - 1) / 5) * 0.35
        const pct = (close - previous) / previous * 100
        dailyInsert.run(code, date, close, pct, close - 0.12, close + 0.28, close - 0.32, 800000 + index * 2400, 1.2 + (index % 6) * 0.11)
      }
    }

    db.transaction(() => {
      seedBars('000300.SH', 4100, 2.2, 100)
      stocks.forEach((stock) => {
        watchInsert.run(stock.code, stock.name, stock.group, now, stock.category, stock.sub, '')
        seedBars(stock.code, stock.base, stock.step, stock.name === '待补样本' ? 32 : 100)
        if (stock.portfolio) portfolioInsert.run(stock.code, stock.name, now, stock.cost)
      })
      alertInsert.run('600001.SH', '风险样本', 'BREAK_MA60', ymd(-1), 20.1, 20.5, now - 1000)
      alertInsert.run('600001.SH', '风险样本', 'STOP_LOSS_5PCT', ymd(-2), 20.3, 21.5, now - 2000)
      alertInsert.run('300003.SZ', '转强样本', 'BREAK_HIGH20', ymd(-1), 35.4, 35.1, now - 3000)
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

async function closeGuide(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
}

async function openTrendPage(window: Page, key: 'portfolio' | 'dashboard' | 'alerts' | 'manage', testId: string): Promise<void> {
  await window.getByTestId('nav-tab-trend-watcher').click()
  await window.getByTestId(`secondary-nav-trend-watcher-${key}`).click()
  await expect(window.getByTestId(testId)).toBeVisible({ timeout: 30_000 })
  await expect(window.getByRole('button', { name: '刷新数据', exact: true })).toBeEnabled({ timeout: 30_000 })
}

test('长线趋势四页形成统一的研判、事件和数据恢复工作台', async () => {
  test.setTimeout(150_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-long-trend-'))
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()
    seedTrendFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.setViewportSize({ width: 1440, height: 900 })

    await openTrendPage(window, 'portfolio', 'trend-portfolio-overview')
    await expect(window.getByRole('heading', { name: '持仓总览', exact: true })).toBeVisible()
    await expect(window.getByText('风险样本', { exact: true }).first()).toBeVisible()
    await expect(window.getByRole('button', { name: '趋势雷达', exact: true })).toHaveCount(0)
    await window.screenshot({ path: 'test-results/long-term-trend-portfolio-1440x900.png' })

    await openTrendPage(window, 'dashboard', 'trend-radar')
    await expect(window.locator('[data-testid="trend-radar"] tbody tr')).toHaveCount(4)
    await expect(window.locator('[data-testid="trend-radar"] tbody svg').first()).toBeVisible()
    const insufficientSummary = window.getByTestId('local-trend-radar-600004')
    await expect(insufficientSummary).toHaveAttribute('data-summary-status', 'insufficient')
    await expect(insufficientSummary).toHaveAttribute('data-headline', '日线覆盖 32/60，暂不形成趋势结构结论')
    await window.locator('[data-testid="trend-radar"] tbody tr').filter({ hasText: '转强样本' }).click()
    const drawer = window.getByTestId('stock-kline-chip-drawer')
    await expect(drawer).toBeVisible()
    await expect(window.getByTestId('stock-kline-chip-drawer-scrim')).toBeVisible()
    const drawerGeometry = await drawer.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottomGap: window.innerHeight - rect.bottom }
    })
    expect(drawerGeometry.top).toBeLessThanOrEqual(1)
    expect(drawerGeometry.bottomGap).toBeLessThanOrEqual(1)
    await drawer.getByLabel('关闭抽屉').click()

    await openTrendPage(window, 'alerts', 'trend-events')
    await expect(window.getByText('跌破 MA60', { exact: true })).toBeVisible()
    await expect(window.getByText('突破 MA60', { exact: true })).toHaveCount(0)
    await expect(window.locator('[data-testid="trend-events"] tbody tr')).toHaveCount(3)

    await openTrendPage(window, 'manage', 'trend-watchlist')
    await expect(window.locator('[data-testid="trend-watchlist"]').getByText('待补样本', { exact: true })).toBeVisible()
    await window.getByRole('button', { name: '执行全市场同步', exact: true }).click()
    await expect(window.getByTestId('trend-progress-strip')).toHaveCount(1)
    const progressGeometry = await window.getByTestId('trend-progress-area').evaluate((area) => {
      const strip = area.querySelector<HTMLElement>('[data-testid="trend-progress-strip"]')
      return { areaWidth: area.getBoundingClientRect().width, stripWidth: strip?.getBoundingClientRect().width ?? 0 }
    })
    expect(Math.abs(progressGeometry.areaWidth - progressGeometry.stripWidth)).toBeLessThanOrEqual(1)

    const listFilters = window.getByTestId('trend-watchlist-filters')
    await listFilters.getByRole('button', { name: /列表分类/ }).click()
    const categoryListbox = window.getByRole('listbox', { name: '列表分类' })
    await expect(categoryListbox).toHaveCSS('max-height', '288px')
    await expect(categoryListbox).toHaveCSS('overflow-y', 'auto')
    await window.getByRole('option', { name: 'CPO (1)', exact: true }).click()
    await expect(window.locator('[data-testid="trend-watchlist"] tbody tr')).toHaveCount(1)
    await expect(window.locator('[data-testid="trend-watchlist"] tbody')).toContainText('转强样本')
    await listFilters.getByRole('button', { name: /列表赛道/ }).click()
    const trackListbox = window.getByRole('listbox', { name: '列表赛道' })
    await expect(trackListbox).toHaveCSS('max-height', '288px')
    await expect(trackListbox).toHaveCSS('overflow-y', 'auto')
    await window.getByRole('option', { name: '光模块 (1)', exact: true }).click()
    await expect(window.locator('[data-testid="trend-watchlist"] tbody tr')).toHaveCount(1)
    await listFilters.getByRole('button', { name: '清除筛选', exact: true }).click()
    await expect(window.locator('[data-testid="trend-watchlist"] tbody tr')).toHaveCount(4)

    const removeRow = window.locator('[data-testid="trend-watchlist"] tbody tr').filter({ hasText: '待补样本' })
    await removeRow.getByRole('button', { name: '移除', exact: true }).click()
    const removeDialog = window.getByTestId('trend-remove-dialog-overlay')
    await expect(removeDialog).toBeVisible()
    await expect(window.getByText('待补样本 · 600004', { exact: true })).toBeVisible()
    await removeDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(removeDialog).toBeHidden()

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    for (const [key, testId] of [
      ['portfolio', 'trend-portfolio-overview'],
      ['dashboard', 'trend-radar'],
      ['alerts', 'trend-events'],
      ['manage', 'trend-watchlist'],
    ] as const) {
      await openTrendPage(window, key, testId)
      const overflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
    }
    await window.screenshot({ path: 'test-results/long-term-trend-watchlist-1024x768-dark.png' })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
