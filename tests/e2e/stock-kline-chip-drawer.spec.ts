import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
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

function bjYmd(date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

function previousWeekday(ymd: string): string {
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
  do date.setUTCDate(date.getUTCDate() - 1)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function seedStockDrawerFixture(dbPath: string, tradeDate: string, previousTradeDate: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const tradeDate = process.env.TRADE_WATCH_TRADE_DATE
    const previousTradeDate = process.env.TRADE_WATCH_PREVIOUS_TRADE_DATE
    const now = Date.now()

    db.pragma('foreign_keys = ON')
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, ?)').run(tradeDate, previousTradeDate)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, NULL)').run(previousTradeDate)

    const stocks = [
      { tsCode: '000815.SZ', name: '美利云', base: 14.6 },
      { tsCode: '600519.SH', name: '贵州茅台', base: 1480 },
    ]
    const limitInsert = db.prepare(
      'INSERT OR REPLACE INTO limit_list_daily (trade_date, ts_code, name, close, pct_chg, amount, float_mv, total_mv, turnover_ratio, fd_amount, first_time, last_time, open_times, up_stat, limit_times, "limit", fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const dailyInsert = db.prepare(
      'INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const priceInsert = db.prepare(
      'INSERT OR REPLACE INTO stock_price_cache (stockCode, tradeDate, open, high, low, close, volume, amount, fetchedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const infoInsert = db.prepare(
      'INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)'
    )
    const chipsInsert = db.prepare(
      'INSERT OR REPLACE INTO cyq_chips_cache (ts_code, trade_date, price, percent) VALUES (?, ?, ?, ?)'
    )
    const factorInsert = db.prepare(
      'INSERT OR REPLACE INTO stk_factor_cache (ts_code, trade_date, close, macd_bfq, macd_dif_bfq, macd_dea_bfq, kdj_k_bfq, kdj_d_bfq, kdj_bfq, rsi_bfq_6, rsi_bfq_12, boll_upper_bfq, boll_mid_bfq, boll_lower_bfq, ma_bfq_5, ma_bfq_10, ma_bfq_20, ma_bfq_60, turnover_rate, volume_ratio, updays, downdays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const chipMonitorInsert = db.prepare(
      'INSERT OR REPLACE INTO chip_monitor_stocks (ts_code, source, stock_name, added_at) VALUES (?, ?, ?, ?)'
    )

    const dates = []
    const cursor = new Date(Date.UTC(Number(previousTradeDate.slice(0, 4)), Number(previousTradeDate.slice(4, 6)) - 1, Number(previousTradeDate.slice(6, 8))))
    while (dates.length < 240) {
      const weekday = cursor.getUTCDay()
      if (weekday !== 0 && weekday !== 6) dates.unshift(cursor.toISOString().slice(0, 10).replace(/-/g, ''))
      cursor.setUTCDate(cursor.getUTCDate() - 1)
    }

    db.transaction(() => {
      chipMonitorInsert.run('000815.SZ', 'morningAuction', '美利云', now)
      stocks.forEach((stock, stockIndex) => {
        infoInsert.run(stock.tsCode.slice(0, 6), stock.name, now)
        limitInsert.run(previousTradeDate, stock.tsCode, stock.name, stock.base, 9.98, 880000000, 12000000000, 18000000000, 4.8, 90000000, '093100', '142800', stockIndex, '1/1', stockIndex + 1, 'U', now)
        dates.forEach((date, index) => {
          const trend = stock.base * (0.86 + index / dates.length * 0.14)
          const close = trend * (1 + Math.sin(index / 6 + stockIndex) * 0.035)
          const open = close * (1 + Math.sin(index / 3) * 0.008)
          const high = Math.max(open, close) * 1.018
          const low = Math.min(open, close) * 0.982
          const pctChg = index === 0 ? 0 : Math.sin(index / 4) * 2.4
          dailyInsert.run(stock.tsCode, date, close, pctChg, open, high, low, 500000 + index * 3200, 1.6 + (index % 7) * 0.18)
          priceInsert.run(stock.tsCode.slice(0, 6), date, open, high, low, close, 500000 + index * 3200, 680000 + index * 5400, now)
          if (index >= dates.length - 30) {
            factorInsert.run(
              stock.tsCode, date, close, Math.sin(index / 8), 0.4, 0.2,
              55 + Math.sin(index / 7) * 18, 50, 60, 48 + Math.sin(index / 5) * 12, 52,
              close * 1.08, close, close * 0.92, close * 0.99, close * 0.985, close * 0.97, close * 0.94,
              2.1, 1.35, index % 4, 0
            )
          }
          for (let point = 0; point < 36; point += 1) {
            const offset = (point - 18) / 90
            const price = close * (1 + offset)
            const percent = Math.max(0.08, Math.exp(-Math.pow((point - 19) / 7, 2)) * 4.8)
            chipsInsert.run(stock.tsCode, date, price, percent)
          }
        })
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

test('股票双击使用可调宽右侧日K与筹码峰抽屉', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-stock-drawer-'))
  const tradeDate = bjYmd()
  const previousTradeDate = previousWeekday(tradeDate)
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible()
    await app.close()

    seedStockDrawerFixture(join(`${userDataDir}-dev`, 'trade-watch.db'), tradeDate, previousTradeDate)
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const coldStartGuide = window.getByTestId('cold-start-guide')
    if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()

    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByTestId('nav-tab-short-term-strategy').click()
    await window.getByTestId('secondary-nav-short-term-strategy-morningAuction').click()
    const auctionTable = window.locator('table').filter({ hasText: '竞价开盘' }).first()
    const meiliyunRow = auctionTable.locator('tr').filter({ hasText: '美利云' }).first()
    await expect(meiliyunRow).toBeVisible({ timeout: 15_000 })
    await meiliyunRow.getByText('美利云', { exact: true }).dblclick()

    const drawer = window.getByTestId('stock-kline-chip-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveClass(/translate-x-0/)
    await expect(drawer).toHaveAttribute('aria-modal', 'true')
    const drawerScrim = window.getByTestId('stock-kline-chip-drawer-scrim')
    await expect(drawerScrim).toBeVisible()
    await expect(drawerScrim).toHaveCSS('background-color', 'rgba(2, 6, 23, 0.5)')
    await expect(window.locator('#root')).toHaveAttribute('inert', '')
    await expect(drawer.getByText('美利云', { exact: true })).toBeVisible()
    await expect(drawer.getByText('正在读取近期日K与筹码')).toBeHidden({ timeout: 15_000 })
    await expect(drawer.getByText('当前日期暂无价格级筹码数据')).toBeHidden()
    const chipProfile = drawer.getByTestId('stock-chip-profile')
    await expect(chipProfile.getByText('筹码分布', { exact: true })).toBeVisible()
    await expect(chipProfile.getByText('浮盈筹码', { exact: true })).toBeVisible()
    await expect(chipProfile.getByText('套牢筹码', { exact: true })).toBeVisible()
    await expect(chipProfile.getByText(/核心成本区/)).toBeVisible()
    const structureInsight = drawer.getByTestId('stock-structure-insight')
    await expect(structureInsight.getByText('价格 × 筹码结构研判', { exact: true })).toBeVisible()
    await expect(structureInsight.getByText('趋势与位置', { exact: true })).toBeVisible()
    await expect(structureInsight.getByText('当前筹码结构', { exact: true })).toBeVisible()
    await expect(structureInsight.getByText('关键位置与风险', { exact: true })).toBeVisible()
    await expect(structureInsight.getByText(/日线 \d+\/60 个交易日/)).toBeVisible()
    const technicalFactors = structureInsight.getByTestId('stock-technical-factors')
    await technicalFactors.getByText('更多技术因子', { exact: true }).click()
    await expect(technicalFactors).toHaveAttribute('open', '')
    await expect(technicalFactors.getByText(/MACD/).first()).toBeVisible()
    await technicalFactors.getByText('更多技术因子', { exact: true }).click()

    const drawerBox = await drawer.boundingBox()
    const closeBox = await drawer.getByLabel('关闭抽屉').boundingBox()
    const viewport = window.viewportSize()
    expect(drawerBox?.y ?? 999).toBeLessThanOrEqual(1)
    expect(drawerBox?.height ?? 0).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 1)
    expect(closeBox?.y).toBeGreaterThanOrEqual(drawerBox?.y ?? 0)
    expect(closeBox?.height).toBeGreaterThanOrEqual(44)

    const chipsCanvas = drawer.locator('canvas.block').first()
    await expect(chipsCanvas).toBeVisible()
    const nonTransparentPixels = await chipsCanvas.evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')
      if (!context) return 0
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let index = 3; index < pixels.length; index += 64) if (pixels[index] > 0) count += 1
      return count
    })
    expect(nonTransparentPixels).toBeGreaterThan(30)

    const profileBox = await chipProfile.boundingBox()
    if (!profileBox) throw new Error('chip profile missing')
    await chipProfile.hover({ position: { x: profileBox.width * 0.42, y: profileBox.height * 0.55 } })
    const profileTooltip = chipProfile.getByTestId('chip-profile-tooltip')
    await expect(profileTooltip.getByText('筹码占比', { exact: true })).toBeVisible()
    await expect(profileTooltip.getByText('价格状态', { exact: true })).toBeVisible()
    await expect.poll(async () => profileTooltip.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe('rgb(2, 6, 23)')
    const tooltipScreenshotDir = process.env.STOCK_DRAWER_SCREENSHOT_DIR
    if (tooltipScreenshotDir) {
      mkdirSync(tooltipScreenshotDir, { recursive: true })
      await window.screenshot({ path: join(tooltipScreenshotDir, 'stock-kline-chip-drawer-tooltip.png') })
    }

    const candleChart = drawer.getByTestId('stock-kline-candle-chart')
    const candleBox = await candleChart.boundingBox()
    if (!candleBox) throw new Error('candle chart missing')
    await window.mouse.move(candleBox.x + candleBox.width * 0.55, candleBox.y + candleBox.height * 0.52)
    const candleTooltip = drawer.getByTestId('stock-kline-candle-tooltip')
    await expect(candleTooltip).toBeVisible()
    await expect.poll(async () => candleTooltip.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe('rgb(2, 6, 23)')
    if (tooltipScreenshotDir) {
      await window.screenshot({ path: join(tooltipScreenshotDir, 'stock-kline-candle-tooltip.png') })
    }
    await window.mouse.click(candleBox.x + candleBox.width * 0.42, candleBox.y + candleBox.height * 0.5)
    await expect(chipProfile.getByText(/↔/)).toBeVisible({ timeout: 15_000 })
    await expect(structureInsight.getByText('筹码变化', { exact: true })).toBeVisible()
    await expect(structureInsight.getByText(/历史快照/)).toBeVisible()
    const compareLegend = chipProfile.getByTestId('chip-profile-compare-legend')
    await expect(compareLegend.getByText(/左 · .* 所选/)).toBeVisible()
    await expect(compareLegend.getByText(/右 · .* 最新/)).toBeVisible()
    const readCompareColorCounts = () => chipsCanvas.evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext('2d')
      if (!context) return { selected: 0, latest: 0 }
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
      let selected = 0
      let latest = 0
      for (let y = 0; y < height; y += 3) {
        for (let x = 0; x < width; x += 3) {
          const offset = (y * width + x) * 4
          const red = data[offset]
          const green = data[offset + 1]
          const blue = data[offset + 2]
          const alpha = data[offset + 3]
          if (alpha < 80) continue
          if (x < width / 2 && ((red > 150 && green < 150) || (green > 110 && red < 130))) selected += 1
          if (x > width / 2 && green > 125 && blue > 160 && red < 150) latest += 1
        }
      }
      return { selected, latest }
    })
    await expect.poll(async () => (await readCompareColorCounts()).selected).toBeGreaterThan(20)
    await expect.poll(async () => (await readCompareColorCounts()).latest).toBeGreaterThan(20)
    const compareScreenshotDir = process.env.STOCK_DRAWER_SCREENSHOT_DIR
    if (compareScreenshotDir) {
      mkdirSync(compareScreenshotDir, { recursive: true })
      await window.screenshot({ path: join(compareScreenshotDir, 'stock-kline-chip-drawer-compare.png') })
    }
    await chipProfile.hover({ position: { x: profileBox.width * 0.35, y: profileBox.height * 0.58 } })
    await expect(profileTooltip.getByText('所选日占比', { exact: true })).toBeVisible()
    await expect(profileTooltip.getByText('最新日占比', { exact: true })).toBeVisible()
    await expect(profileTooltip.getByText('占比变化', { exact: true })).toBeVisible()
    if (compareScreenshotDir) {
      await window.screenshot({ path: join(compareScreenshotDir, 'stock-kline-chip-drawer-compare-tooltip.png') })
    }

    await drawer.getByRole('button', { name: '120日' }).click()
    await expect(drawer.getByRole('button', { name: '120日' })).toHaveAttribute('aria-pressed', 'true')
    await expect(structureInsight.getByText(/120日窗口/)).toBeVisible()

    const widthBefore = (await drawer.boundingBox())?.width ?? 0
    const resizeHandle = window.getByTestId('stock-kline-chip-drawer-resize-handle')
    const handleBox = await resizeHandle.boundingBox()
    if (!handleBox) throw new Error('resize handle missing')
    await window.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 120)
    await window.mouse.down()
    await window.mouse.move(handleBox.x - 120, handleBox.y + 120, { steps: 6 })
    await window.mouse.up()
    const widthAfter = (await drawer.boundingBox())?.width ?? 0
    expect(widthAfter).toBeGreaterThan(widthBefore + 80)

    await resizeHandle.focus()
    const widthBeforeKeyboard = (await drawer.boundingBox())?.width ?? 0
    await window.keyboard.press('ArrowRight')
    const widthAfterKeyboard = (await drawer.boundingBox())?.width ?? 0
    expect(widthAfterKeyboard).toBeLessThan(widthBeforeKeyboard - 12)

    await drawer.getByLabel('关闭抽屉').click()
    await expect(drawer).toBeHidden()
    await expect(window.locator('#root')).not.toHaveAttribute('inert', '')
    const maotaiRow = auctionTable.locator('tr').filter({ hasText: '贵州茅台' }).first()
    await maotaiRow.getByText('贵州茅台', { exact: true }).dblclick()
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('贵州茅台', { exact: true })).toBeVisible()
    await expect(chipProfile.getByTestId('chip-profile-core-zone')).toBeVisible()

    await window.setViewportSize({ width: 1024, height: 768 })
    const compactDrawerBox = await drawer.boundingBox()
    expect(compactDrawerBox?.x).toBeGreaterThanOrEqual(64)
    expect((compactDrawerBox?.x ?? 0) + (compactDrawerBox?.width ?? 0)).toBeLessThanOrEqual(1024.5)
    const pageWidth = await window.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client)

    const screenshotDir = process.env.STOCK_DRAWER_SCREENSHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      await window.screenshot({ path: join(screenshotDir, 'stock-kline-chip-drawer-1024x768.png') })
      await structureInsight.scrollIntoViewIfNeeded()
      await window.screenshot({ path: join(screenshotDir, 'stock-structure-insight-1024x768.png') })
      await window.setViewportSize({ width: 1440, height: 900 })
      await window.evaluate(() => document.documentElement.classList.add('dark'))
      await structureInsight.scrollIntoViewIfNeeded()
      await window.screenshot({ path: join(screenshotDir, 'stock-structure-insight-dark-1440x900.png') })
      await drawer.getByTestId('stock-kline-candle-chart').scrollIntoViewIfNeeded()
      await window.screenshot({ path: join(screenshotDir, 'stock-kline-chip-drawer-dark-1440x900.png') })
    }

    await drawer.getByLabel('关闭抽屉').click()
    await expect(drawer).toBeHidden()

    // 首次打开和抽屉内切股已验证真实指针；这里只重建状态以单独验证 Esc。
    await meiliyunRow.dispatchEvent('dblclick')
    await expect(drawer).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    await window.getByTestId('nav-tab-short-term-strategy').click()
    await window.getByTestId('secondary-nav-short-term-strategy-chipMonitor').click()
    const chipMonitorRow = window.getByTestId('chip-monitor-row-000815')
    await expect(chipMonitorRow).toBeVisible({ timeout: 15_000 })
    await chipMonitorRow.click()
    await expect(drawer).toBeHidden()
    await chipMonitorRow.dblclick()
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText('美利云', { exact: true })).toBeVisible()
    await expect(drawer.getByTestId('stock-kline-candle-chart')).toBeVisible()
    await expect(drawer.getByTestId('stock-chip-profile')).toBeVisible()
    await window.setViewportSize({ width: 1440, height: 900 })
    await drawer.getByRole('button', { name: '打开完整走势' }).click()
    await expect(drawer).toBeHidden()
    const stockChartRoot = window.getByTestId('stock-chart-root')
    await expect(stockChartRoot).toBeVisible({ timeout: 15_000 })
    await expect(stockChartRoot.getByText('美利云', { exact: true }).first()).toBeVisible()
    const fullChart = window.getByTestId('daily-chart-container')
    await expect(fullChart.locator('canvas').first()).toBeVisible({ timeout: 15_000 })
    await window.setViewportSize({ width: 1024, height: 768 })
    await expect(stockChartRoot.getByTestId('stock-chart-history-range')).toBeVisible()
    await expect(stockChartRoot).toHaveAttribute('data-history-visible-count', '30')
    expect(await stockChartRoot.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'stock-chart-history-range-1024x768.png') })
    }
    await window.setViewportSize({ width: 1440, height: 900 })
    await expect(stockChartRoot).toHaveAttribute('data-history-count', '149')
    await expect(stockChartRoot).toHaveAttribute('data-history-has-more', 'true')
    await expect(stockChartRoot).toHaveAttribute('data-history-visible-count', '30')
    await expect(stockChartRoot.getByTestId('stock-chart-history-summary')).toHaveText('当前 30 日·已加载 149 日')

    const historyRange = stockChartRoot.getByTestId('stock-chart-history-range')
    const range30 = historyRange.getByRole('button', { name: '显示最近30个交易日' })
    const range60 = historyRange.getByRole('button', { name: '显示最近60个交易日' })
    const range90 = historyRange.getByRole('button', { name: '显示最近90个交易日' })
    const rangeAll = historyRange.getByRole('button', { name: '显示全部本地日K' })
    await expect(range30).toHaveAttribute('aria-pressed', 'true')
    await range60.click()
    await expect(stockChartRoot).toHaveAttribute('data-history-visible-count', '60')
    await expect(range60).toHaveAttribute('aria-pressed', 'true')
    await range90.click()
    await expect(stockChartRoot).toHaveAttribute('data-history-visible-count', '90')
    await expect(range90).toHaveAttribute('aria-pressed', 'true')

    const readMovingAverageCoverage = () => fullChart.evaluate((container) => {
      const colors = {
        ma5: [249, 115, 22],
        ma10: [59, 130, 246],
        ma20: [139, 92, 246],
        ma60: [161, 98, 7],
      } as const
      const result = {
        left: { ma5: 0, ma10: 0, ma20: 0, ma60: 0 },
        right: { ma5: 0, ma10: 0, ma20: 0, ma60: 0 },
      }
      for (const canvas of Array.from(container.querySelectorAll('canvas'))) {
        if (canvas.width < 300 || canvas.height < 180) continue
        const context = canvas.getContext('2d')
        if (!context) continue
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const band = x >= canvas.width * 0.1 && x <= canvas.width * 0.42
              ? result.left
              : x >= canvas.width * 0.58 && x <= canvas.width * 0.9
                ? result.right
                : null
            if (!band) continue
            const offset = (y * canvas.width + x) * 4
            if (pixels[offset + 3] < 120) continue
            for (const [key, color] of Object.entries(colors) as Array<[keyof typeof colors, readonly [number, number, number]]>) {
              if (
                Math.abs(pixels[offset] - color[0]) <= 24
                && Math.abs(pixels[offset + 1] - color[1]) <= 24
                && Math.abs(pixels[offset + 2] - color[2]) <= 24
              ) band[key] += 1
            }
          }
        }
      }
      return result
    })
    await expect.poll(async () => {
      const coverage = await readMovingAverageCoverage()
      return Math.min(...Object.values(coverage.left), ...Object.values(coverage.right))
    }).toBeGreaterThan(3)

    const fullChartBox = await fullChart.boundingBox()
    if (!fullChartBox) throw new Error('full stock chart missing')
    await window.mouse.move(fullChartBox.x + fullChartBox.width * 0.58, fullChartBox.y + fullChartBox.height * 0.52)
    await expect(stockChartRoot.getByTestId('stock-chart-candle-tooltip')).toBeVisible()
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'stock-chart-full-moving-averages.png') })
    }

    await range30.click()
    await expect(stockChartRoot).toHaveAttribute('data-history-visible-count', '30')
    await expect(range30).toHaveAttribute('aria-pressed', 'true')

    // 默认只显示30根，内存保留90日窗口所需的59根MA60预热；滚轮到左边界后再补历史。
    await window.mouse.move(fullChartBox.x + fullChartBox.width * 0.5, fullChartBox.y + fullChartBox.height * 0.55)
    for (let index = 0; index < 80; index += 1) {
      await window.mouse.wheel(0, 700)
    }
    await expect.poll(async () => Number(await fullChart.getAttribute('data-visible-logical-from'))).toBeLessThanOrEqual(6)
    await expect.poll(async () => Number(await stockChartRoot.getAttribute('data-history-count'))).toBeGreaterThan(149)
    await expect(stockChartRoot).toHaveAttribute('data-history-has-more', 'false')
    await rangeAll.click()
    await expect(stockChartRoot).toHaveAttribute('data-history-count', '240')
    await expect(stockChartRoot).toHaveAttribute('data-history-visible-count', '240')
    await expect(rangeAll).toHaveAttribute('aria-pressed', 'true')
    await expect(stockChartRoot.getByTestId('stock-chart-history-summary')).toHaveText('当前 240 日·已加载 240 日')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
