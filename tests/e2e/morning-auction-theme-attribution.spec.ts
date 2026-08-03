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

function latestWeekdayYmd(): string {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function previousWeekday(ymd: string): string {
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
  do date.setUTCDate(date.getUTCDate() - 1)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function seedThemeFixture(dbPath: string, tradeDate: string, previousTradeDate: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const tradeDate = process.env.TRADE_WATCH_TRADE_DATE
    const previousTradeDate = process.env.TRADE_WATCH_PREVIOUS_TRADE_DATE
    const now = Date.now()
    const stocks = [
      { tsCode: '600101.SH', name: '算力主股', price: 21.2, preClose: 20, amount: 36000000, turnover: 0.82, concepts: ['算力', '液冷服务器', 'CPO', '融资融券', '沪股通'] },
      { tsCode: '600102.SH', name: '算力共振甲', price: 16.68, preClose: 16, amount: 24000000, turnover: 0.65, concepts: ['算力', '融资融券'] },
      { tsCode: '600103.SH', name: '算力共振乙', price: 12.48, preClose: 12, amount: 18000000, turnover: 0.58, concepts: ['算力', '液冷服务器', '融资融券'] },
      { tsCode: '600104.SH', name: '属性候选', price: 10.3, preClose: 10, amount: 12000000, turnover: 0.41, concepts: ['融资融券', '沪股通'] },
    ]

    db.pragma('foreign_keys = ON')
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)').run(tradeDate, previousTradeDate)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, NULL)').run(previousTradeDate)
    const limitInsert = db.prepare(
      'INSERT OR REPLACE INTO limit_list_daily (trade_date, ts_code, name, close, pct_chg, amount, float_mv, total_mv, turnover_ratio, fd_amount, first_time, last_time, open_times, up_stat, limit_times, "limit", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const auctionInsert = db.prepare(
      'INSERT OR REPLACE INTO stk_auction_cache (ts_code, trade_date, price, vol, amount, pre_close, turnover_rate, volume_ratio, float_share, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const conceptInsert = db.prepare(
      'INSERT OR REPLACE INTO kpl_concept_members (con_code, con_name, ts_code, name, hot_num, "desc", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const directInsert = db.prepare(
      'INSERT OR REPLACE INTO kpl_concept_daily (trade_date, ts_code, name, lu_time, lu_desc, tag, theme, bid_amount, status, bid_turnover, bid_pct_chg, pct_chg, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const flowInsert = db.prepare(
      "INSERT OR REPLACE INTO sector_flow_observations (trade_date, provider, scope, board_code, board_name, metric_kind, total_amount, main_net_inflow, main_net_inflow_rate, weighted_change, total_market_cap, member_count, up_count, down_count, flat_count, leader_json, core_stocks_json, related_themes_json, source_updated_at, captured_at, quality_json) VALUES (@tradeDate, 'eastmoney', 'concept', @boardCode, @boardName, 'verified_flow', @totalAmount, @mainNetInflow, @mainNetInflowRate, @weightedChange, @totalMarketCap, @memberCount, @upCount, @downCount, @flatCount, @leaderJson, @coreStocksJson, '[]', @sourceUpdatedAt, @capturedAt, @qualityJson)"
    )

    db.transaction(() => {
      stocks.forEach((stock, stockIndex) => {
        limitInsert.run(previousTradeDate, stock.tsCode, stock.name, stock.preClose, 9.98, 880000000, 12000000000, 18000000000, 4.8, 90000000, '093100', '142800', 0, '1/1', 1, 'U', now)
        auctionInsert.run(stock.tsCode, tradeDate, stock.price, 1800000, stock.amount, stock.preClose, stock.turnover, 1.6, 800000000, now)
        stock.concepts.forEach((concept, conceptIndex) => {
          conceptInsert.run(stock.tsCode, stock.name, 'C' + stockIndex + conceptIndex, concept, 100 - conceptIndex, null, now)
        })
      })
      directInsert.run(previousTradeDate, '600101.SH', '算力主股', '093100', '算力基础设施订单预期增强', '涨停', '算力+液冷服务器', 90000000, '封板', 4.8, 9.8, 10, now)
      const coreStocksJson = JSON.stringify(stocks.slice(0, 3).map((stock, index) => ({
        tsCode: stock.tsCode,
        name: stock.name,
        change: 6 - index,
        totalAmount: 1200000000 - index * 100000000,
        mainNetInflow: 180000000 - index * 30000000,
        mainNetInflowRate: 5 - index,
      })))
      flowInsert.run({
        tradeDate: previousTradeDate,
        boardCode: 'BK0910',
        boardName: '算力',
        totalAmount: 12800000000,
        mainNetInflow: 500000000,
        mainNetInflowRate: 3.91,
        weightedChange: 2.4,
        totalMarketCap: 980000000000,
        memberCount: 30,
        upCount: 24,
        downCount: 5,
        flatCount: 1,
        leaderJson: JSON.stringify({ tsCode: '600101.SH', name: '算力主股', change: 6, totalAmount: 1200000000, mainNetInflow: 180000000, mainNetInflowRate: 5 }),
        coreStocksJson,
        sourceUpdatedAt: now - 86400000,
        capturedAt: now - 86400000,
        qualityJson: JSON.stringify({ verified: true }),
      })
      flowInsert.run({
        tradeDate,
        boardCode: 'BK9999',
        boardName: '未来误导板块',
        totalAmount: 36000000000,
        mainNetInflow: 9900000000,
        mainNetInflowRate: 27.5,
        weightedChange: 9.9,
        totalMarketCap: 1200000000000,
        memberCount: 30,
        upCount: 30,
        downCount: 0,
        flatCount: 0,
        leaderJson: JSON.stringify({ tsCode: '600101.SH', name: '算力主股', change: 9.9, totalAmount: 5000000000, mainNetInflow: 2000000000, mainNetInflowRate: 40 }),
        coreStocksJson,
        sourceUpdatedAt: now,
        capturedAt: now,
        qualityJson: JSON.stringify({ verified: true }),
      })
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
      TRADE_WATCH_TRADE_DATE: tradeDate,
      TRADE_WATCH_PREVIOUS_TRADE_DATE: previousTradeDate,
    },
    stdio: 'pipe',
  })
}

async function openMorningAuction(window: Page, tradeDate: string): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-morningAuction').click()
  const dateInput = window.locator('input[type="date"]').first()
  await dateInput.fill(`${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`)
  await expect(window.getByTestId('morning-auction-theme-trigger-600101')).toBeVisible({ timeout: 20_000 })
}

test('早盘主题材归因可展开全部题材并保持视口与键盘闭环', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-auction-theme-'))
  const tradeDate = latestWeekdayYmd()
  const previousTradeDate = previousWeekday(tradeDate)
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible()
    await app.close()

    seedThemeFixture(join(`${userDataDir}-dev`, 'trade-watch.db'), tradeDate, previousTradeDate)
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    await openMorningAuction(window, tradeDate)

    const marketThemes = window.getByTestId('morning-auction-market-themes')
    await expect(marketThemes).toContainText('今日竞价主线')
    await expect(marketThemes).toContainText('延续确认')
    await expect(marketThemes).toContainText('昨日 +5.00亿')
    await expect(marketThemes).toContainText(`${previousTradeDate.slice(0, 4)}-${previousTradeDate.slice(4, 6)}-${previousTradeDate.slice(6, 8)}`)
    await expect(marketThemes).not.toContainText('未来误导板块')

    const leadingTheme = window.getByTestId('morning-auction-market-theme-1')
    await expect(leadingTheme).toContainText('算力')
    await leadingTheme.click()
    await expect(leadingTheme).toHaveAttribute('aria-pressed', 'true')
    const candidateArea = window.getByTestId('morning-auction-candidate-area')
    await expect(candidateArea).toContainText('竞价主线 · 算力')
    await expect(candidateArea).toContainText('3 只股票')
    await expect(candidateArea).not.toContainText('属性候选')
    await expect(window.getByTestId('morning-auction-stock-market-confirmation')).toContainText('延续确认')
    await expect(window.getByTestId('morning-auction-stock-market-confirmation')).toContainText('昨日资金流入得到今日多股竞价确认')
    await leadingTheme.click()
    await expect(leadingTheme).toHaveAttribute('aria-pressed', 'false')
    await expect(candidateArea).toContainText('4 只股票')
    await expect(candidateArea).toContainText('属性候选')
    await window.screenshot({ path: 'test-results/morning-auction-market-theme-1440x900.png' })

    const trigger = window.getByTestId('morning-auction-theme-trigger-600101')
    await expect(trigger).toContainText('主炒·算力')
    await expect(trigger).toContainText('共振·液冷服务器')
    await expect(trigger).toContainText('+3')
    await trigger.click()

    const popover = window.getByTestId('morning-auction-theme-popover')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText('算力基础设施订单预期增强')
    await expect(popover).toContainText('算力共振甲')
    await expect(popover).toContainText('CPO')
    await expect(popover).toContainText('融资融券')
    const geometry = await popover.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, maxHeight: getComputedStyle(node).maxHeight }
    })
    expect(geometry.top).toBeGreaterThanOrEqual(0)
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(1440)
    expect(geometry.bottom).toBeLessThanOrEqual(900)
    expect(Number.parseFloat(geometry.maxHeight)).toBeLessThanOrEqual(440)
    await expect(popover.getByRole('button', { name: '关闭' })).toBeFocused()
    await expect(window.getByTestId('morning-auction-theme-driver')).toContainText('主炒 · 算力')
    await window.screenshot({ path: 'test-results/morning-auction-theme-1440x900.png' })

    const popoverBox = await popover.boundingBox()
    if (!popoverBox) throw new Error('题材归因弹层缺少可见几何信息')
    await window.mouse.move(popoverBox.x + popoverBox.width / 2, popoverBox.y + popoverBox.height - 40)
    await window.mouse.wheel(0, 500)
    await expect(popover).toBeVisible()
    expect(await popover.evaluate(node => node.scrollTop)).toBeGreaterThan(0)

    await window.locator('h1').filter({ hasText: '早盘集合竞价战情台' }).click()
    await expect(popover).toBeVisible()
    await window.mouse.move(90, 300)
    await window.mouse.wheel(0, 400)
    await expect(popover).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(popover).toBeHidden()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(popover).toBeVisible()
    await window.locator('h1').filter({ hasText: '早盘集合竞价战情台' }).click()
    await expect(popover).toBeVisible()
    await popover.getByRole('button', { name: '关闭' }).click()
    await expect(popover).toBeHidden()
    await expect(trigger).toBeFocused()

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await trigger.scrollIntoViewIfNeeded()
    const compactLayout = await window.evaluate(() => {
      const triggerRect = document.querySelector('[data-testid="morning-auction-theme-trigger-600101"]')?.getBoundingClientRect()
      const candidateRect = document.querySelector('[data-testid="morning-auction-candidate-area"]')?.getBoundingClientRect()
      const insightRect = document.querySelector('[data-testid="morning-auction-insight-panel"]')?.getBoundingClientRect()
      return {
        triggerBottom: triggerRect?.bottom ?? 0,
        candidateBottom: candidateRect?.bottom ?? 0,
        insightTop: insightRect?.top ?? 0,
      }
    })
    expect(compactLayout.insightTop).toBeGreaterThanOrEqual(compactLayout.candidateBottom - 1)
    expect(compactLayout.insightTop).toBeGreaterThan(compactLayout.triggerBottom)
    await trigger.click()
    await expect(popover).toBeVisible()
    const compactGeometry = await popover.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { left: rect.left, right: rect.right, bottom: rect.bottom }
    })
    expect(compactGeometry.left).toBeGreaterThanOrEqual(0)
    expect(compactGeometry.right).toBeLessThanOrEqual(1024)
    expect(compactGeometry.bottom).toBeLessThanOrEqual(768)
    expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/morning-auction-theme-1024x768-dark.png' })
    await window.keyboard.press('Escape')
    await marketThemes.scrollIntoViewIfNeeded()
    await window.screenshot({ path: 'test-results/morning-auction-market-theme-1024x768-dark.png' })
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
