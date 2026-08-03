import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

async function closeGuide(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
}

function seedChipStructureFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const script = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const priceInsert = db.prepare(
      'INSERT OR REPLACE INTO stock_price_cache (stockCode, tradeDate, open, high, low, close, volume, amount, fetchedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const dailyInsert = db.prepare(
      'INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const infoInsert = db.prepare(
      'INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)'
    )
    const perfInsert = db.prepare(
      'INSERT OR REPLACE INTO cyq_perf_cache (ts_code, trade_date, his_low, his_high, cost_5pct, cost_15pct, cost_50pct, cost_85pct, cost_95pct, weight_avg, winner_rate, winner_rate_unit, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const chipsInsert = db.prepare(
      'INSERT OR REPLACE INTO cyq_chips_cache (ts_code, trade_date, price, percent) VALUES (?, ?, ?, ?)'
    )

    const dates = []
    const cursor = new Date(Date.UTC(2026, 6, 1))
    while (cursor <= new Date(Date.UTC(2026, 6, 30))) {
      if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
        dates.push(cursor.toISOString().slice(0, 10).replace(/-/g, ''))
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }

    db.transaction(() => {
      infoInsert.run('600487', '亨通光电', now)
      dates.forEach((date, index) => {
        const close = date === '20260710' ? 10 : 9.7 + index * 0.03
        dailyInsert.run('600487.SH', date, close, index === 0 ? 0 : 0.3, close - 0.05, close + 0.12, close - 0.14, 500000 + index * 1000, 1.8)
        priceInsert.run('600487', date, close - 0.05, close + 0.12, close - 0.14, close, 500000 + index * 1000, 800000 + index * 2000, now)
      })
      perfInsert.run('600487.SH', '20260710', 7, 13, 8, 8.8, 10, 11.2, 12, 10, 58, 'percent', now)
      ;[[8, 5], [9, 15], [10, 38], [11, 25], [12, 17]].forEach(([price, percent]) => {
        chipsInsert.run('600487.SH', '20260710', price, percent)
      })
      ;[[9, 10], [10, 45], [11, 30], [12, 15]].forEach(([price, percent]) => {
        chipsInsert.run('600487.SH', '20260724', price, percent)
      })
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
    },
    stdio: 'pipe',
  })
}

test('完整走势图展示最近同日归一筹码并允许显式补齐最新事实', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-chart-chip-'))
  const screenshotDir = join(process.cwd(), 'test-results', 'stock-chart-chip-structure')
  mkdirSync(screenshotDir, { recursive: true })
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()

    seedChipStructureFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-list-item-600487')).toContainText('亨通光电', { timeout: 20_000 })
    await window.getByTestId('stock-list-item-600487').locator('button').first().click()

    const policyResult = await window.evaluate(async () => {
      const latestFact = await window.api.chipStructure.getSummaries({
        tsCodes: ['600487.SH'],
        referenceTradeDate: '20260730',
      })
      const latestComplete = await window.api.chipStructure.getSummaries({
        tsCodes: ['600487.SH'],
        referenceTradeDate: '20260730',
        selectionPolicy: 'latest_complete',
      })
      return { latestFact, latestComplete }
    })
    expect(policyResult.latestFact).toMatchObject({
      ok: true,
      summaries: [{ tradeDate: '20260724', completenessStatus: 'partial' }],
    })
    expect(policyResult.latestComplete).toMatchObject({
      ok: true,
      summaries: [{
        tradeDate: '20260710',
        dateRelation: 'history',
        winnerRate: 58,
        thickProfitPct: 20,
        trappedPct: 42,
        completenessStatus: 'complete',
        consistencyStatus: 'matched',
      }],
    })
    if (policyResult.latestComplete.ok) {
      expect(policyResult.latestComplete.summaries[0]?.concentration).toBeCloseTo(24, 8)
    }

    const summary = window.getByTestId('stock-chip-structure-summary')
    await expect(summary).toContainText('筹码结构 截至 2026-07-10')
    await expect(summary).toContainText('获利 58.00%')
    await expect(summary).toContainText('厚浮盈 20.00%')
    await expect(summary).toContainText('套牢 42.00%')
    await expect(summary).toContainText('集中 24.00%')
    await expect(summary).toContainText('同日归一')
    await expect(summary).toContainText('口径一致')
    await expect(summary).toContainText('历史参考')
    await expect(window.getByTestId('stock-chip-structure-refresh')).toContainText('补齐最新')
    await window.screenshot({ path: join(screenshotDir, 'light-1440x900.png') })

    await window.getByTestId('stock-chip-structure-refresh').click()
    const refreshFeedback = window.getByTestId('stock-chip-structure-refresh-feedback')
    await expect(refreshFeedback).toContainText('需配置 Tushare')
    await expect(refreshFeedback).toHaveAttribute('aria-label', 'Tushare 数据源未启用')
    await expect(summary).toContainText('获利 58.00%')

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect.poll(() => summary.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'dark-1024x768.png') })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
