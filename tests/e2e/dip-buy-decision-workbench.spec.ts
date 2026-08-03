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

function seedDipBuyFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const dates = []
    for (let stamp = Date.UTC(2026, 5, 8); stamp <= Date.UTC(2026, 6, 27); stamp += 86400000) {
      const date = new Date(stamp)
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10).replace(/-/g, ''))
    }
    db.exec('DELETE FROM limit_list_daily; DELETE FROM kpl_concept_members; DELETE FROM short_term_signals; DELETE FROM daily_close_cache; DELETE FROM stock_basic_cache; DELETE FROM stock_moneyflow_daily; DELETE FROM trade_cal;')
    const calInsert = db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
    dates.forEach((date, index) => calInsert.run(date, index === 0 ? null : dates[index - 1]))
    const limitInsert = db.prepare('INSERT OR REPLACE INTO limit_list_daily (trade_date, ts_code, name, close, pct_chg, amount, float_mv, total_mv, turnover_ratio, fd_amount, first_time, last_time, open_times, up_stat, limit_times, "limit", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const conceptInsert = db.prepare('INSERT OR REPLACE INTO kpl_concept_members (con_code, con_name, ts_code, name, hot_num, "desc", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const basicInsert = db.prepare('INSERT OR REPLACE INTO stock_basic_cache (ts_code, name, industry, market, list_status, circ_float, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const dailyInsert = db.prepare('INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const stocks = [
      { code: '000001.SZ', name: '趋势回踩', conceptCode: 'TREND001', concept: '上行题材' },
      { code: '000002.SZ', name: '冰点套利', conceptCode: 'RETREAT001', concept: '退潮题材' },
      { code: '600003.SH', name: '高度龙头', conceptCode: 'ROTATE001', concept: '轮动题材' },
      { code: '600004.SH', name: '低位补涨', conceptCode: 'ROTATE001', concept: '轮动题材' },
      { code: '600005.SH', name: '轮动助攻', conceptCode: 'ROTATE001', concept: '轮动题材' },
      { code: '000006.SZ', name: '趋势助攻', conceptCode: 'TREND001', concept: '上行题材' },
      { code: '000007.SZ', name: '退潮助攻一', conceptCode: 'RETREAT001', concept: '退潮题材' },
      { code: '000008.SZ', name: '退潮助攻二', conceptCode: 'RETREAT001', concept: '退潮题材' },
      { code: '000009.SZ', name: '覆盖样本', conceptCode: 'OTHER001', concept: '其他题材' },
    ]
    db.transaction(() => {
      stocks.forEach((stock, index) => {
        conceptInsert.run(stock.code, stock.name, stock.conceptCode, stock.concept, 100 - index, '', now)
        basicInsert.run(stock.code, stock.name, '电子', stock.code.endsWith('.SH') ? '主板' : '深市', 'L', 100000, now)
      })
      dates.forEach((date, dateIndex) => {
        stocks.forEach((stock, stockIndex) => {
          let close = 10 + stockIndex * 2 + dateIndex * 0.05
          let pct = 0.45
          let vol = 1000000
          if (stock.code === '000002.SZ' && dateIndex >= dates.length - 5) close = 14.9 - (dateIndex - (dates.length - 5)) * 0.08
          if (date === '20260727' && stock.code === '000002.SZ') { close = 14.2; pct = -3.2; vol = 600000 }
          if (date === '20260727' && stock.code === '600003.SH') { close = 24; pct = 4; vol = 1200000 }
          if (date === '20260727' && stock.code === '600004.SH') { close = 16; pct = 0.8; vol = 800000 }
          if (date === '20260727' && stock.code === '600005.SH') { close = 12; pct = 10; vol = 1500000 }
          dailyInsert.run(stock.code, date, close, pct, close / (1 + pct / 100), close * 1.015, close * 0.985, vol, 8 + stockIndex)
        })
      })
      dates.slice(-15).forEach((date) => {
        limitInsert.run(date, '000009.SZ', '覆盖样本', 9, 10, 90000, 500000, 700000, 6, 1800, '10:10:00', '14:30:00', 0, '1/1', 1, 'U', now)
      })
      limitInsert.run('20260717', '000001.SZ', '趋势回踩', 11.5, 10, 180000, 1200000, 1800000, 18, 9000, '09:45:00', '14:50:00', 0, '4/4', 4, 'U', now)
      limitInsert.run('20260724', '000002.SZ', '冰点套利', 14.8, 10, 160000, 900000, 1300000, 15, 7000, '10:00:00', '14:40:00', 0, '1/1', 1, 'U', now)
      limitInsert.run('20260724', '000007.SZ', '退潮助攻一', 9, 10, 80000, 400000, 600000, 8, 2000, '10:20:00', '14:20:00', 0, '1/1', 1, 'U', now)
      limitInsert.run('20260724', '000008.SZ', '退潮助攻二', 8, 10, 70000, 350000, 550000, 7, 1800, '10:30:00', '14:30:00', 0, '1/1', 1, 'U', now)
      limitInsert.run('20260724', '600003.SH', '高度龙头', 23, 10, 260000, 1600000, 2200000, 21, 12000, '09:35:00', '14:55:00', 0, '6/6', 6, 'U', now)
      limitInsert.run('20260727', '000006.SZ', '趋势助攻', 20, 10, 110000, 700000, 900000, 10, 3500, '09:50:00', '14:45:00', 0, '1/1', 1, 'U', now)
      limitInsert.run('20260727', '600005.SH', '轮动助攻', 12, 10, 130000, 800000, 1100000, 12, 4000, '09:40:00', '14:40:00', 0, '1/1', 1, 'U', now)
      db.prepare('INSERT OR REPLACE INTO stock_moneyflow_daily (ts_code, trade_date, net_mf_amount, fetched_at) VALUES (?, ?, ?, ?)').run('000002.SZ', '20260727', 32000000, now)
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

function readSignalCounts(dbPath: string): Record<string, number> {
  const electronExecutable = require('electron') as string
  const script = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB, { readonly: true })
    const rows = db.prepare("SELECT strategy, COUNT(*) AS count FROM short_term_signals WHERE trade_date = '20260727' AND strategy LIKE 'shortTerm.dipBuy.%' GROUP BY strategy").all()
    process.stdout.write(JSON.stringify(Object.fromEntries(rows.map(row => [row.strategy, row.count]))))
    db.close()
  `
  return JSON.parse(execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString()) as Record<string, number>
}

async function closeGuide(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
}

async function openDipBuy(window: Page): Promise<void> {
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-dipBuyRadar').click()
  await expect(window.getByTestId('dip-buy-workbench')).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId('dip-buy-row-000001')).toBeVisible({ timeout: 30_000 })
}

test('低吸雷达以三套独立前置条件形成候选、研判和历史闭环', async () => {
  test.setTimeout(180_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-dip-buy-'))
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()
    const dbPath = join(`${userDataDir}-dev`, 'trade-watch.db')
    seedDipBuyFixture(dbPath)

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await openDipBuy(window)

    await expect(window.getByTestId('dip-buy-conclusion')).toContainText('趋势低吸')
    await expect(window.getByTestId('dip-buy-detail')).toContainText('近期强势事件')
    await expect(window.getByTestId('dip-buy-detail')).toContainText('均线')

    await window.getByTestId('dip-buy-mode-arbitrageDip').click()
    await expect(window.getByTestId('dip-buy-row-000002')).toBeVisible()
    await expect(window.getByTestId('dip-buy-conclusion')).toContainText('市场冰点')
    await expect(window.getByTestId('dip-buy-detail')).toContainText('资金或缩量')

    await window.getByTestId('dip-buy-mode-rotationDip').click()
    await expect(window.getByTestId('dip-buy-row-600004')).toBeVisible()
    await expect(window.getByTestId('dip-buy-conclusion')).toContainText('打开高度')
    await expect(window.getByTestId('dip-buy-detail')).toContainText('前一日高标')
    await expect(window.getByTestId('dip-buy-detail')).toContainText('高度龙头')

    await window.getByTestId('dip-buy-refresh').click()
    await expect(window.getByTestId('dip-buy-refresh')).toHaveText('刷新研判')
    const counts = readSignalCounts(dbPath)
    expect(counts['shortTerm.dipBuy.trend'] ?? 0).toBeGreaterThan(0)
    expect(counts['shortTerm.dipBuy.arbitrage'] ?? 0).toBeGreaterThan(0)
    expect(counts['shortTerm.dipBuy.rotation'] ?? 0).toBeGreaterThan(0)

    await window.getByTestId('dip-buy-row-600004').dblclick()
    const drawer = window.getByTestId('stock-kline-chip-drawer')
    await expect(drawer).toBeVisible({ timeout: 20_000 })
    await drawer.getByLabel('关闭抽屉').click()

    await window.getByTestId('dip-buy-history').click()
    await expect(window.getByTestId('strategy-backtest-view-history')).toHaveAttribute('aria-selected', 'true')
    await expect(window.getByTestId('strategy-backtest-strategy')).toHaveValue('shortTerm.dipBuy.rotation')

    await openDipBuy(window)
    for (const control of [window.getByTestId('dip-buy-refresh'), window.getByTestId('dip-buy-history'), window.getByTestId('dip-buy-tier-filter-trigger'), window.getByTestId('dip-buy-open-stock-drawer')]) {
      const box = await control.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    await window.screenshot({ path: 'test-results/dip-buy-workbench-1440x900.png' })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await openDipBuy(window)
    const overflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/dip-buy-workbench-1024x768-dark.png' })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
