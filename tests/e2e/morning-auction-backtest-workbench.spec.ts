import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function recentWeekdays(count: number): string[] {
  const dates: string[] = []
  const cursor = new Date(Date.now() + 8 * 60 * 60 * 1000)
  while (dates.length < count) {
    const weekday = cursor.getUTCDay()
    if (weekday !== 0 && weekday !== 6) dates.unshift(cursor.toISOString().slice(0, 10).replace(/-/g, ''))
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return dates
}

function seedBacktestFixture(dbPath: string, dates: string[]): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const dates = JSON.parse(process.env.TRADE_WATCH_DATES)
    const now = Date.now()
    const signalDate = dates.at(-7)
    const missingDate = dates.at(-8)
    const latestDate = dates.at(-1)
    const dailyInsert = db.prepare(
      'INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const detailInsert = db.prepare(
      'INSERT OR REPLACE INTO stk_auction_backtest_detail (trade_date, ts_code, pool, buy_price, ret_1d, ret_2d, ret_3d, ret_5d, computed_at, is_one_word, idx_today_pct, idx_ret1d, idx_ret2d, idx_ret3d, idx_ret5d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const stockInsert = db.prepare(
      'INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)'
    )

    db.transaction(() => {
      dates.forEach((date, index) => {
        db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
          .run(date, index > 0 ? dates[index - 1] : null)
      })

      const indexCodes = ['000001.SH', '399001.SZ', '399006.SZ', '000688.SH']
      indexCodes.forEach((tsCode, codeIndex) => {
        dates.forEach((date, dateIndex) => {
          const close = 3000 + codeIndex * 200 + dateIndex * 4
          dailyInsert.run(tsCode, date, close, 0.15, close - 2, close + 8, close - 8, 9000000, 1.1)
        })
      })

      for (let index = 1; index <= 12; index += 1) {
        const code = String(index).padStart(6, '0')
        const tsCode = code + '.SZ'
        const name = '回测样本' + index
        const buyPrice = 10 + index
        const returnStep = index % 3 === 0 ? -0.006 : 0.012
        stockInsert.run(code, name, now)
        dates.forEach((date, dateIndex) => {
          const signalIndex = dates.indexOf(signalDate)
          const elapsed = dateIndex - signalIndex
          const close = buyPrice * (1 + Math.max(0, elapsed) * returnStep)
          dailyInsert.run(tsCode, date, close, returnStep * 100, close * 0.995, close * 1.012, close * 0.988, 800000 + index * 1000, 1.4)
        })
        detailInsert.run(
          signalDate,
          tsCode,
          index <= 3 ? 'brokenBoard' : 'allMarket',
          buyPrice,
          null,
          null,
          null,
          null,
          now,
          0,
          index % 2 === 0 ? 0.8 : -0.6,
          null,
          null,
          null,
          null
        )
      }

      stockInsert.run('000088', '待到期样本', now)
      dailyInsert.run('000088.SZ', latestDate, 18, 2, 17.7, 18.2, 17.6, 600000, 1.2)
      detailInsert.run(latestDate, '000088.SZ', 'allMarket', 17.8, null, null, null, null, now, 0, 0.4, null, null, null, null)

      stockInsert.run('000099', '缺日线样本', now)
      detailInsert.run(missingDate, '000099.SZ', 'allMarket', 20, null, null, null, null, now, 0, -1.2, null, null, null, null)

      stockInsert.run('000077', '一字板样本', now)
      dates.forEach((date) => dailyInsert.run('000077.SZ', date, 15.2, 0.2, 15.1, 15.3, 15, 500000, 0.9))
      detailInsert.run(signalDate, '000077.SZ', 'firstBoard', 15, 1.33, 1.33, 1.33, 1.33, now, 1, 0.5, 0.1, 0.2, 0.3, 0.5)
    })()
    db.close()
  `

  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
      TRADE_WATCH_DATES: JSON.stringify(dates),
    },
    stdio: 'pipe',
  })
}

async function openBacktestDrawer(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-morningAuction').click()
  const trigger = window.getByTestId('morning-auction-backtest-trigger')
  await expect(trigger).toBeVisible({ timeout: 15_000 })
  await trigger.click()
  await expect(window.getByTestId('auction-backtest-drawer')).toBeVisible()
}

test('竞价历史表现抽屉区分成熟、待到期和缺日线并适配双视口', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-auction-backtest-'))
  const dates = recentWeekdays(36)
  const signalDate = dates.at(-7)!
  const missingDate = dates.at(-8)!
  const latestDate = dates.at(-1)!
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible()
    await app.close()

    seedBacktestFixture(join(`${userDataDir}-dev`, 'trade-watch.db'), dates)
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    await openBacktestDrawer(window)

    const drawer = window.getByTestId('auction-backtest-drawer')
    await expect(drawer).toHaveClass(/translate-x-0/)
    await expect(drawer).toHaveAttribute('aria-modal', 'true')
    await expect(drawer).toContainText('信号日 9:25 竞价撮合价')
    await expect(window.locator('#root')).toHaveAttribute('inert', '')
    await expect(drawer.getByLabel('关闭抽屉')).toBeFocused()
    await expect(window.getByTestId('auction-backtest-conclusion')).toContainText('成熟样本')

    const repairedRow = window.getByTestId(`auction-backtest-sample-${signalDate}-000004-allMarket`)
    await expect(repairedRow).toContainText('已成熟')
    await expect(repairedRow.locator('td').nth(4)).not.toHaveText('--')
    await expect(window.getByTestId(`auction-backtest-sample-${latestDate}-000088-allMarket`)).toContainText('待到期')
    await expect(window.getByTestId(`auction-backtest-sample-${missingDate}-000099-allMarket`)).toContainText('缺日线')
    await expect(window.getByTestId('auction-backtest-exclude-one-word')).toHaveAttribute('aria-checked', 'true')
    await expect(drawer).toContainText('待到期 1 · 缺日线 1')

    const sampleScroll = window.getByTestId('auction-backtest-sample-scroll')
    const sampleHeader = window.getByTestId('auction-backtest-sample-header')
    await sampleScroll.scrollIntoViewIfNeeded()
    await sampleScroll.evaluate((element) => { element.scrollTop = 160 })
    const tableGeometry = await sampleScroll.evaluate((element) => {
      const container = element.getBoundingClientRect()
      const header = element.querySelector('thead')?.getBoundingClientRect()
      const topLayer = document.elementFromPoint(container.left + 24, (header?.top ?? container.top) + 8)
      return {
        containerTop: container.top,
        headerTop: header?.top ?? -1,
        headerOwnsTopLayer: Boolean(topLayer?.closest('[data-testid="auction-backtest-sample-header"]')),
      }
    })
    expect(tableGeometry.headerTop).toBeGreaterThanOrEqual(tableGeometry.containerTop - 1)
    expect(tableGeometry.headerOwnsTopLayer).toBe(true)
    await expect(sampleHeader).toBeVisible()
    mkdirSync('test-results', { recursive: true })
    await window.screenshot({ path: 'test-results/morning-auction-backtest-table-sticky-1440x900.png' })

    await repairedRow.dblclick()
    const stockDrawer = window.getByTestId('stock-kline-chip-drawer')
    await expect(stockDrawer).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(stockDrawer).toBeHidden()
    await expect(drawer).toBeVisible()

    await window.getByTestId('auction-backtest-pool-summary-brokenBoard').click()
    await expect(window.getByTestId('auction-backtest-pool-summary-brokenBoard')).toHaveAttribute('aria-pressed', 'true')
    await expect(drawer).toContainText('炸板回封')
    await window.getByTestId('auction-backtest-horizon-5').click()
    await expect(window.getByTestId('auction-backtest-horizon-5')).toHaveAttribute('aria-pressed', 'true')
    await window.getByTestId('auction-backtest-tab-environment').click()
    await expect(drawer.getByText('强势市场', { exact: true })).toBeVisible()
    await expect(drawer.getByText('弱势市场', { exact: true })).toBeVisible()

    await window.screenshot({ path: 'test-results/morning-auction-backtest-1440x900.png' })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await drawer.locator(':scope > div').last().evaluate((element) => { element.scrollTop = 0 })
    const geometry = await drawer.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(70)
    expect(geometry.right).toBeLessThanOrEqual(1024)
    expect(geometry.top).toBe(0)
    expect(geometry.bottom).toBe(768)
    expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/morning-auction-backtest-1024x768-dark.png' })

    await window.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(window.getByTestId('morning-auction-backtest-trigger')).toBeFocused()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
