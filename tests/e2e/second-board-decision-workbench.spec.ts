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

function seedSecondBoardFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const tradeDate = '20260724'
    const previousDate = '20260723'
    db.exec('DELETE FROM limit_list_daily; DELETE FROM top_list_daily; DELETE FROM kpl_concept_members; DELETE FROM short_term_signals; DELETE FROM daily_close_cache; DELETE FROM stock_basic_cache;')
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)').run('20260727', tradeDate)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)').run(tradeDate, previousDate)

    const stocks = [
      { code: '000001.SZ', name: '梯队科技', close: 28.62, fund: 15000, first: '09:42:00', opens: 0, times: 4, turnover: 8.0, prevTurnover: 7.0, concept: '光模块', conceptCode: 'CPO001' },
      { code: '000002.SZ', name: '助攻科技', close: 16.48, fund: 8000, first: '10:02:00', opens: 0, times: 2, turnover: 6.2, prevTurnover: 6.0, concept: '光模块', conceptCode: 'CPO001' },
      { code: '600003.SH', name: '独立高标', close: 22.36, fund: 2500, first: '10:25:00', opens: 1, times: 3, turnover: 11.0, prevTurnover: 8.5, concept: 'PCB', conceptCode: 'PCB001' },
      { code: '600004.SH', name: '脆弱样本', close: 9.82, fund: 300, first: '13:45:00', opens: 4, times: 2, turnover: 22.0, prevTurnover: 7.0, concept: '机器人', conceptCode: 'ROB001' },
      { code: '000005.SZ', name: '题材助攻', close: 12.20, fund: 1800, first: '10:18:00', opens: 1, times: 1, turnover: 5.0, prevTurnover: 4.8, concept: '光模块', conceptCode: 'CPO001' },
    ]
    const limitInsert = db.prepare('INSERT INTO limit_list_daily (trade_date, ts_code, name, close, pct_chg, amount, float_mv, total_mv, turnover_ratio, fd_amount, first_time, last_time, open_times, up_stat, limit_times, "limit", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const conceptInsert = db.prepare('INSERT INTO kpl_concept_members (con_code, con_name, ts_code, name, hot_num, "desc", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const basicInsert = db.prepare('INSERT OR REPLACE INTO stock_basic_cache (ts_code, name, industry, market, list_status, circ_float, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const dailyInsert = db.prepare('INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    db.transaction(() => {
      stocks.forEach((stock, stockIndex) => {
        limitInsert.run(previousDate, stock.code, stock.name, stock.close / 1.1, 10, 150000, 1200000, 1800000, stock.prevTurnover, Math.max(500, stock.fund * 0.7), '09:55:00', '14:45:00', Math.min(stock.opens, 1), Math.max(1, stock.times - 1) + '/5', Math.max(1, stock.times - 1), 'U', now)
        limitInsert.run(tradeDate, stock.code, stock.name, stock.close, 10, 180000, 1200000, 1800000, stock.turnover, stock.fund, stock.first, '14:55:00', stock.opens, stock.times + '/5', stock.times, 'U', now)
        conceptInsert.run(stock.code, stock.name, stock.conceptCode, stock.concept, 100 - stockIndex, '', now)
        basicInsert.run(stock.code, stock.name, '电子', stock.code.endsWith('.SH') ? '主板' : '深市', 'L', 100000, now)
        for (let index = 0; index < 90; index += 1) {
          const date = new Date(Date.UTC(2026, 3, 1 + index))
          const ymd = String(date.getUTCFullYear()) + String(date.getUTCMonth() + 1).padStart(2, '0') + String(date.getUTCDate()).padStart(2, '0')
          const close = stock.close * (0.72 + index * 0.0032) + Math.sin(index / 6) * 0.18
          const previous = stock.close * (0.72 + Math.max(0, index - 1) * 0.0032) + Math.sin(Math.max(0, index - 1) / 6) * 0.18
          dailyInsert.run(stock.code, ymd, close, index === 0 ? 0 : (close - previous) / previous * 100, close - 0.12, close + 0.24, close - 0.28, 600000 + index * 5000, 1.2 + index % 5 * 0.2)
        }
      })
      db.prepare('INSERT INTO top_list_daily (trade_date, ts_code, name, close, pct_change, turnover_rate, amount, l_sell, l_buy, l_amount, net_amount, net_rate, amount_rate, float_values, reason, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(tradeDate, '600004.SH', '脆弱样本', 9.82, 10, 22, 220000, 3200, 1000, 4200, -2200, -3, 10, 1200000, '机构卖出', now)
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

function readSavedSignalCount(dbPath: string): number {
  const electronExecutable = require('electron') as string
  const script = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB, { readonly: true })
    const row = db.prepare("SELECT COUNT(*) AS count FROM short_term_signals WHERE strategy = 'shortTerm.secondBoardLeader' AND trade_date = '20260724'").get()
    process.stdout.write(String(row.count))
    db.close()
  `
  return Number(execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString())
}

async function closeGuide(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
}

async function openSecondBoard(window: Page): Promise<void> {
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-secondBoardLeader').click()
  await expect(window.getByTestId('second-board-workbench')).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId('second-board-row-000001')).toBeVisible({ timeout: 30_000 })
}

test('连板梯队工作台形成题材竞争、个股研判与历史表现闭环', async () => {
  test.setTimeout(150_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-second-board-'))
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()
    seedSecondBoardFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await openSecondBoard(window)

    await expect(window.getByTestId('second-board-conclusion')).toContainText('连板梯队已形成')
    await expect(window.getByTestId('second-board-conclusion')).toContainText('最高4板')
    await expect(window.getByTestId('second-board-conclusion')).toContainText('光模块')
    await expect(window.locator('[data-testid^="second-board-row-"]')).toHaveCount(4)
    await expect(window.getByTestId('second-board-detail')).toContainText('梯队科技')
    await expect(window.getByTestId('second-board-detail')).toContainText('继续确认')
    await expect(window.getByTestId('second-board-detail')).toContainText('明确失效')

    const actionButtonStyles = await Promise.all([
      window.getByTestId('second-board-refresh'),
      window.getByTestId('second-board-history'),
      window.getByTestId('concept-data-tools-workbench'),
    ].map((control) => control.evaluate((node) => {
      const style = window.getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        height: rect.height,
        borderRadius: style.borderRadius,
        borderColor: style.borderTopColor,
        backgroundColor: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
      }
    })))
    expect(actionButtonStyles.every((style) => style.height >= 44)).toBe(true)
    expect(new Set(actionButtonStyles.map((style) => JSON.stringify(style))).size).toBe(1)

    await window.getByTestId('second-board-refresh').click()
    await expect(window.getByTestId('second-board-refresh')).toHaveText('刷新快照')
    await window.getByTestId('second-board-refresh').click()
    await expect(window.getByTestId('second-board-refresh')).toHaveText('刷新快照')
    expect(readSavedSignalCount(join(`${userDataDir}-dev`, 'trade-watch.db'))).toBe(3)

    await window.getByTestId('second-board-height-filter-trigger').click()
    await window.getByRole('option', { name: /^4板/ }).click()
    await expect(window.locator('[data-testid^="second-board-row-"]')).toHaveCount(1)
    await window.getByRole('button', { name: '重置', exact: true }).click()

    await window.getByTestId('second-board-row-600004').click()
    await expect(window.getByTestId('second-board-detail')).toContainText('硬风险已触发降级')
    await expect(window.getByTestId('second-board-detail')).toContainText('机构卖出/买入比')

    await window.getByTestId('second-board-row-000001').dblclick()
    const drawer = window.getByTestId('stock-kline-chip-drawer')
    await expect(drawer).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId('stock-kline-chip-drawer-scrim')).toBeVisible()
    const drawerGeometry = await drawer.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, bottomGap: window.innerHeight - rect.bottom }
    })
    expect(drawerGeometry.top).toBeLessThanOrEqual(1)
    expect(drawerGeometry.bottomGap).toBeLessThanOrEqual(1)
    await drawer.getByLabel('关闭抽屉').click()

    await window.getByTestId('second-board-history').click()
    await expect(window.getByTestId('strategy-backtest-view-history')).toHaveAttribute('aria-selected', 'true')
    await expect(window.getByTestId('strategy-backtest-strategy')).toHaveValue('shortTerm.secondBoardLeader')

    await openSecondBoard(window)
    for (const control of [
      window.getByTestId('second-board-refresh'),
      window.getByTestId('second-board-history'),
      window.getByTestId('concept-data-tools-workbench'),
      window.getByTestId('second-board-tier-filter-trigger'),
      window.getByTestId('second-board-open-stock-drawer'),
    ]) {
      const box = await control.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    await window.screenshot({ path: 'test-results/second-board-workbench-1440x900.png' })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await openSecondBoard(window)
    const darkActionStyles = await Promise.all([
      window.getByTestId('second-board-refresh'),
      window.getByTestId('second-board-history'),
      window.getByTestId('concept-data-tools-workbench'),
    ].map((control) => control.evaluate((node) => {
      const style = window.getComputedStyle(node)
      return `${style.backgroundColor}|${style.borderTopColor}|${style.color}|${style.borderRadius}`
    })))
    expect(new Set(darkActionStyles).size).toBe(1)
    const overflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/second-board-workbench-1024x768-dark.png' })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
