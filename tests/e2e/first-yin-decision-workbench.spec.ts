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

function seedFirstYinFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const dates = ['20260714','20260715','20260716','20260717','20260720','20260721','20260722','20260723','20260724','20260727']
    db.exec('DELETE FROM limit_list_daily; DELETE FROM kpl_concept_members; DELETE FROM short_term_signals; DELETE FROM daily_close_cache; DELETE FROM stock_basic_cache; DELETE FROM trade_cal;')
    const calInsert = db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
    dates.forEach((date, index) => calInsert.run(date, index === 0 ? null : dates[index - 1]))

    const candidates = [
      { code: '000001.SZ', name: '修复确认', concept: '光模块', conceptCode: 'CPO001', peakDate: '20260721', peakBoards: 4, divergenceDate: '20260722', divergence: { open: 10.5, high: 10.6, low: 9.8, close: 10.1, turnover: 16 }, current: 10.75 },
      { code: '000002.SZ', name: '修复等待', concept: '光模块', conceptCode: 'CPO001', peakDate: '20260723', peakBoards: 3, divergenceDate: '20260724', divergence: { open: 12.2, high: 12.3, low: 11.4, close: 11.8, turnover: 12 }, current: 12.0 },
      { code: '600003.SH', name: '修复失败', concept: '机器人', conceptCode: 'ROB001', peakDate: '20260722', peakBoards: 5, divergenceDate: '20260723', divergence: { open: 18.2, high: 18.4, low: 17.0, close: 17.6, turnover: 21 }, current: 16.8 },
      { code: '600004.SH', name: '证据待补', concept: 'PCB', conceptCode: 'PCB001', peakDate: '20260724', peakBoards: 3, divergenceDate: '20260727', divergence: null, current: null },
    ]
    const helpers = [
      { code: '000005.SZ', name: '题材助攻一', concept: '光模块', conceptCode: 'CPO001' },
      { code: '000006.SZ', name: '题材助攻二', concept: '光模块', conceptCode: 'CPO001' },
      { code: '600007.SH', name: '机器人助攻', concept: '机器人', conceptCode: 'ROB001' },
    ]
    const limitInsert = db.prepare('INSERT INTO limit_list_daily (trade_date, ts_code, name, close, pct_chg, amount, float_mv, total_mv, turnover_ratio, fd_amount, first_time, last_time, open_times, up_stat, limit_times, "limit", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const conceptInsert = db.prepare('INSERT INTO kpl_concept_members (con_code, con_name, ts_code, name, hot_num, "desc", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const basicInsert = db.prepare('INSERT OR REPLACE INTO stock_basic_cache (ts_code, name, industry, market, list_status, circ_float, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const dailyInsert = db.prepare('INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    db.transaction(() => {
      candidates.forEach((stock, stockIndex) => {
        const peakClose = 10 + stockIndex * 2.5
        limitInsert.run(stock.peakDate, stock.code, stock.name, peakClose, 10, 180000, 1200000, 1800000, 18 + stockIndex, 9000, '09:45:00', '14:50:00', 0, stock.peakBoards + '/5', stock.peakBoards, 'U', now)
        conceptInsert.run(stock.code, stock.name, stock.conceptCode, stock.concept, 100 - stockIndex, '', now)
        basicInsert.run(stock.code, stock.name, '电子', stock.code.endsWith('.SH') ? '主板' : '深市', 'L', 100000, now)
        dates.forEach((date, index) => {
          if (stock.divergence == null && date === '20260727') return
          let close = 8 + stockIndex * 2 + index * 0.16
          let open = close - 0.08
          let high = close + 0.2
          let low = close - 0.2
          let turnover = 8 + stockIndex
          if (date === stock.peakDate) { close = peakClose; open = peakClose / 1.08; high = peakClose; low = open; turnover = 18 + stockIndex }
          if (stock.divergence && date === stock.divergenceDate) { ({ open, high, low, close, turnover } = stock.divergence) }
          if (date === '20260727' && stock.current != null) { close = stock.current; open = stock.current - 0.12; high = stock.current + 0.15; low = stock.current - 0.2; turnover = 11 + stockIndex }
          dailyInsert.run(stock.code, date, close, -1.2, open, high, low, 600000 + index * 5000, turnover)
        })
      })
      helpers.forEach((stock, index) => {
        limitInsert.run('20260727', stock.code, stock.name, 8 + index, 10, 90000, 500000, 700000, 6, 1800, '10:10:00', '14:30:00', 0, '1/1', 1, 'U', now)
        conceptInsert.run(stock.code, stock.name, stock.conceptCode, stock.concept, 70 - index, '', now)
      })
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
    const row = db.prepare("SELECT COUNT(*) AS count FROM short_term_signals WHERE strategy = 'shortTerm.firstYinDip' AND trade_date = '20260727'").get()
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

async function openFirstYin(window: Page): Promise<void> {
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-firstYinDip').click()
  await expect(window.getByTestId('first-yin-workbench')).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId('first-yin-row-000001')).toBeVisible({ timeout: 30_000 })
}

test('首阴回踩工作台形成状态机、边界研判与历史表现闭环', async () => {
  test.setTimeout(150_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-first-yin-'))
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()
    const dbPath = join(`${userDataDir}-dev`, 'trade-watch.db')
    seedFirstYinFixture(dbPath)

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await openFirstYin(window)

    await expect(window.getByTestId('first-yin-conclusion')).toContainText('已出现修复确认')
    await expect(window.getByTestId('first-yin-conclusion')).toContainText('确认')
    await expect(window.locator('[data-testid^="first-yin-row-"]')).toHaveCount(4)
    await expect(window.getByTestId('first-yin-detail')).toContainText('确认线')
    await expect(window.getByTestId('first-yin-detail')).toContainText('明确失效')

    await window.getByTestId('first-yin-refresh').click()
    await expect(window.getByTestId('first-yin-refresh')).toHaveText('刷新研判')
    await window.getByTestId('first-yin-refresh').click()
    await expect(window.getByTestId('first-yin-refresh')).toHaveText('刷新研判')
    expect(readSavedSignalCount(dbPath)).toBe(2)

    await window.getByTestId('first-yin-state-filter-trigger').click()
    await window.getByRole('option', { name: '修复确认', exact: true }).click()
    await expect(window.locator('[data-testid^="first-yin-row-"]')).toHaveCount(1)
    await window.getByRole('button', { name: '重置', exact: true }).click()

    await window.getByTestId('first-yin-row-600003').click()
    await expect(window.getByTestId('first-yin-detail')).toContainText('修复失败')
    await expect(window.getByTestId('first-yin-detail')).toContainText('跌破失效线')

    await window.getByTestId('first-yin-row-000001').dblclick()
    const drawer = window.getByTestId('stock-kline-chip-drawer')
    await expect(drawer).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId('stock-kline-chip-drawer-scrim')).toBeVisible()
    await drawer.getByLabel('关闭抽屉').click()

    await window.getByTestId('first-yin-history').click()
    await expect(window.getByTestId('strategy-backtest-view-history')).toHaveAttribute('aria-selected', 'true')
    await expect(window.getByTestId('strategy-backtest-strategy')).toHaveValue('shortTerm.firstYinDip')

    await openFirstYin(window)
    for (const control of [window.getByTestId('first-yin-refresh'), window.getByTestId('first-yin-history'), window.getByTestId('first-yin-state-filter-trigger'), window.getByTestId('first-yin-open-stock-drawer')]) {
      const box = await control.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    await window.screenshot({ path: 'test-results/first-yin-workbench-1440x900.png' })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await openFirstYin(window)
    const overflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/first-yin-workbench-1024x768-dark.png' })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
