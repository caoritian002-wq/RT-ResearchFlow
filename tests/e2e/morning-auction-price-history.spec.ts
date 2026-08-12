import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type TestElectronApp = Awaited<ReturnType<typeof electron.launch>>

async function seedMorningAuctionPriceHistory(app: TestElectronApp): Promise<void> {
  await app.evaluate(async ({ app }, fixture) => {
    const mainModule = process.mainModule
    if (!mainModule) throw new Error('E2E_MAIN_MODULE_UNAVAILABLE')
    const { join } = mainModule.require('node:path') as typeof import('node:path')
    const { createRequire } = mainModule.require('node:module') as typeof import('node:module')
    const appRequire = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = appRequire('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'trade-watch.db'))
    const now = Date.now()
    const limitInsert = db.prepare(`
      INSERT OR REPLACE INTO limit_list_daily (
        trade_date, ts_code, name, close, pct_chg, amount, float_mv, total_mv,
        turnover_ratio, fd_amount, first_time, last_time, open_times, up_stat,
        limit_times, "limit", fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const auctionInsert = db.prepare(`
      INSERT OR REPLACE INTO stk_auction_cache (
        ts_code, trade_date, price, vol, amount, pre_close, turnover_rate,
        volume_ratio, float_share, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const closeInsert = db.prepare(`
      INSERT OR REPLACE INTO daily_close_cache (
        ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const stockInsert = db.prepare(
      'INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)',
    )

    db.transaction(() => {
      fixture.closeDates.forEach((tradeDate, index) => {
        db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
          .run(tradeDate, index > 0 ? fixture.closeDates[index - 1] : null)
      })
      db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)')
        .run(fixture.tradeDate, fixture.previousTradeDate)

      fixture.stocks.forEach((stock, stockIndex) => {
        stockInsert.run(stock.tsCode.slice(0, 6), stock.name, now)
        if (stockIndex === 0) {
          limitInsert.run(
            fixture.previousTradeDate,
            stock.tsCode,
            stock.name,
            stock.preClose,
            9.98,
            880_000_000,
            12_000_000_000,
            18_000_000_000,
            4.8,
            90_000_000,
            '093100',
            '142800',
            0,
            '1/1',
            1,
            'U',
            now,
          )
          auctionInsert.run(
            stock.tsCode,
            fixture.tradeDate,
            stock.auctionPrice,
            1_800_000,
            36_000_000,
            stock.preClose,
            0.82,
            1.6,
            800_000_000,
            now,
          )
        }
        fixture.closeDates.forEach((tradeDate, index) => {
          const close = stock.closes[index]
          closeInsert.run(
            stock.tsCode,
            tradeDate,
            close,
            0,
            close,
            close,
            close,
            800_000,
            1.2,
          )
        })
      })
    })()
    db.close()
  }, {
    tradeDate: '20260812',
    previousTradeDate: '20260811',
    closeDates: ['20260804', '20260805', '20260806', '20260807', '20260810', '20260811'],
    stocks: [
      {
        tsCode: '600101.SH',
        name: '历史样本甲',
        preClose: 15,
        auctionPrice: 15.75,
        closes: [10, 11, 12, 13, 14, 15],
      },
      {
        tsCode: '600102.SH',
        name: '历史样本乙',
        preClose: 15,
        auctionPrice: 15.6,
        closes: [20, 19, 18, 17, 16, 15],
      },
    ],
  })
}

async function seedLateAuctionCandidate(app: TestElectronApp): Promise<void> {
  await app.evaluate(async ({ app }) => {
    const mainModule = process.mainModule
    if (!mainModule) throw new Error('E2E_MAIN_MODULE_UNAVAILABLE')
    const { join } = mainModule.require('node:path') as typeof import('node:path')
    const { createRequire } = mainModule.require('node:module') as typeof import('node:module')
    const appRequire = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = appRequire('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'trade-watch.db'))
    db.prepare(`
      INSERT OR REPLACE INTO stk_auction_cache (
        ts_code, trade_date, price, vol, amount, pre_close, turnover_rate,
        volume_ratio, float_share, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('600102.SH', '20260812', 15.6, 1_800_000, 36_000_000, 15, 0.82, 1.6, 800_000_000, Date.now())
    db.close()
  })
}

async function openMorningAuction(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-morningAuction').click()
  await expect(window.getByTestId('morning-auction-price-history-coverage')).toBeVisible({ timeout: 30_000 })
}

async function expectRisingPriceHistoryValue(window: Page): Promise<void> {
  const risingRow = window.locator('tbody tr').filter({ hasText: '历史样本甲' }).first()
  await expect(risingRow).toBeVisible()
  await expect(risingRow.locator('td').nth(6)).toHaveText('+25.00%')
  await expect(risingRow.locator('td').nth(7)).toHaveText('+50.00%')
}

async function expectFallingPriceHistoryValue(window: Page): Promise<void> {
  await expect(window.getByTestId('morning-auction-price-history-coverage')).toHaveText('历史涨跌 3日 2/2 · 5日 2/2')
  const fallingRow = window.locator('tbody tr').filter({ hasText: '历史样本乙' }).first()
  await expect(fallingRow).toBeVisible()
  await expect(fallingRow.locator('td').nth(6)).toHaveText('-16.67%')
  await expect(fallingRow.locator('td').nth(7)).toHaveText('-25.00%')

  const candidateArea = window.getByTestId('morning-auction-candidate-area')
  await expect(candidateArea).not.toContainText('待补齐')
  await expect(candidateArea).not.toContainText('样本不足')
  await expect(candidateArea).not.toContainText('暂无数据')
  await expect(candidateArea).not.toContainText('读取失败')
  await expect(candidateArea).not.toContainText('补采失败')
}

test('早盘竞价使用本地六日收盘完整展示三日和五日涨跌', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-auction-price-history-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await seedMorningAuctionPriceHistory(app)

    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize() ?? []))
      .toEqual([1680, 960])
    await openMorningAuction(window)
    await expect(window.getByTestId('morning-auction-price-history-coverage')).toHaveText('历史涨跌 3日 1/1 · 5日 1/1')
    await expect(window.locator('tbody tr').filter({ hasText: '历史样本乙' })).toHaveCount(0)

    await seedLateAuctionCandidate(app)
    await window.getByRole('button', { name: '立即刷新' }).click()
    await expect(window.getByTestId('morning-auction-price-history-coverage')).toHaveText('历史涨跌 3日 2/2 · 5日 2/2')
    await expectRisingPriceHistoryValue(window)
    await window.getByRole('button', { name: /^全市场异动/ }).click()
    await expect(window.getByRole('heading', { name: '全市场异动', exact: true })).toBeVisible()
    await expectFallingPriceHistoryValue(window)
    await window.screenshot({ path: 'test-results/morning-auction-price-history-1680x960.png' })

    await window.getByLabel('最大化窗口').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false))
      .toBe(true)
    await expectFallingPriceHistoryValue(window)
    const geometry = await window.getByTestId('morning-auction-candidate-area').evaluate((node) => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      candidateOverflow: node.scrollWidth - node.clientWidth,
      coverageHeight: document.querySelector('[data-testid="morning-auction-price-history-coverage"]')
        ?.getBoundingClientRect().height ?? 0,
    }))
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
    expect(geometry.candidateOverflow).toBeLessThanOrEqual(1)
    expect(geometry.coverageHeight).toBeGreaterThan(0)
    await window.screenshot({ path: 'test-results/morning-auction-price-history-maximized.png' })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
