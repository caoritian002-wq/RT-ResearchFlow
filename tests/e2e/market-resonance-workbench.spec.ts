import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SHENWAN_L1_INDUSTRIES } from '../../electron/main/services/eastmoneyIndustryHierarchy'
import { getShenwanL2Names } from '../../electron/main/services/marketResonanceIndustryModel'

type TestElectronApp = Awaited<ReturnType<typeof electron.launch>>

const HISTORICAL_FIXTURE_DATE = '20260731'
const HISTORICAL_FIXTURE_PREVIOUS_DATE = '20260730'

async function seedHistoricalSectorFacts(app: TestElectronApp): Promise<void> {
  await app.evaluate(async ({ app }, fixture) => {
    const mainModule = process.mainModule
    if (!mainModule) throw new Error('E2E_MAIN_MODULE_UNAVAILABLE')
    const { join } = mainModule.require('node:path') as typeof import('node:path')
    const { createRequire } = mainModule.require('node:module') as typeof import('node:module')
    const appRequire = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = appRequire('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'trade-watch.db'))
    const insert = db.prepare(`
      INSERT OR REPLACE INTO sector_flow_observations (
        trade_date, provider, scope, board_code, board_name, metric_kind,
        total_amount, main_net_inflow, main_net_inflow_rate, weighted_change,
        member_count, up_count, down_count, flat_count, captured_at
      ) VALUES (?, 'eastmoney', 'industry', ?, ?, 'verified_flow', ?, ?, ?, ?, 100, 55, 35, 10, ?)
    `)
    const capturedAt = Date.now()
    const transaction = db.transaction(() => {
      fixture.tradeDates.forEach((tradeDate) => {
        fixture.industries.forEach((industry, index) => {
          const weightedChange = Number((1.5 - index * 0.05).toFixed(2))
          insert.run(
            tradeDate,
            industry.code,
            industry.name,
            100_000_000 + index,
            5_000_000 - index * 10_000,
            1.2,
            weightedChange,
            capturedAt,
          )
        })
      })
    })
    transaction()
    db.close()
  }, {
    tradeDates: [HISTORICAL_FIXTURE_PREVIOUS_DATE, HISTORICAL_FIXTURE_DATE],
    industries: [
      ...SHENWAN_L1_INDUSTRIES.map(({ code, name }) => ({ code, name })),
      ...getShenwanL2Names('电子').map((name, index) => ({
        code: `BK99${String(index).padStart(4, '0')}`,
        name,
      })),
      ...getShenwanL2Names('通信').map((name, index) => ({
        code: `BK98${String(index).padStart(4, '0')}`,
        name,
      })),
    ],
  })
}

async function openMarketResonance(window: Page): Promise<void> {
  const guide = window.locator('[data-testid="cold-start-guide"]')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.locator('[data-testid="nav-tab-industry-heatmap"]').click()
  await window.locator('[data-testid="secondary-nav-industry-heatmap-heatmap"]').click()
  await expect(window.locator('[data-testid="market-resonance-workbench"]')).toBeVisible()
  await expect(window.locator('[data-testid="market-resonance-summary"]')).toBeVisible({ timeout: 90_000 })
  await expect(window.locator('[data-testid="market-resonance-date-navigation"]')).toBeVisible()
  // 实时视图显示“刷新数据”, 历史/存档视图显示“重新补采”
  await expect(
    window.getByRole('button', { name: /^(刷新数据|重新补采)$/ }),
  ).toBeEnabled({ timeout: 90_000 })
}

test('市场共振页移除重复导航并输出真实行业指数对比', async () => {
  test.setTimeout(180_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-market-resonance-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await seedHistoricalSectorFacts(app)
    await window.setViewportSize({ width: 1680, height: 960 })
    await openMarketResonance(window)

    await expect(window.getByRole('heading', { name: '市场共振', exact: true })).toBeVisible()
    // 页面内不得再出现第二套大盘云图子导航; 左侧二级入口可保留
    await expect(
      window.locator('[data-testid="market-resonance-workbench"]').getByRole('button', { name: '行业云图', exact: true }),
    ).toHaveCount(0)
    const allIndustriesFilter = window.getByRole('button', { name: /全部行业，\d+ 个一级行业/ })
    await expect(allIndustriesFilter).toHaveAttribute('aria-pressed', 'true')
    const initialIndustryCount = await window.locator('[data-testid="market-resonance-row"]').count()
    expect(initialIndustryCount).toBeGreaterThanOrEqual(28)
    await expect(window.getByTestId('market-resonance-visible-count')).toHaveText(`当前展示 ${initialIndustryCount}/${initialIndustryCount} 个一级行业`)
    const resonanceFilter = window.getByRole('button', { name: /共振\/同步，\d+ 个一级行业/ })
    await resonanceFilter.click()
    const filteredIndustryCount = await window.locator('[data-testid="market-resonance-row"]').count()
    await expect(window.getByTestId('market-resonance-visible-count')).toHaveText(`当前展示 ${filteredIndustryCount}/${initialIndustryCount} 个一级行业`)
    await allIndustriesFilter.click()
    await expect(window.locator('[data-testid="market-resonance-row"]')).toHaveCount(initialIndustryCount)
    const resonanceDetail = window.locator('[data-testid="market-resonance-detail"]')
    await expect(resonanceDetail).toBeVisible()
    await expect.poll(async () => (
      await resonanceDetail.locator('svg').count()
      + await resonanceDetail.getByText(/分钟曲线暂不可恢复/).count()
    )).toBeGreaterThan(0)

    const expandElectronic = window.getByRole('button', { name: '展开电子二级行业', exact: true })
    await expect(expandElectronic).toHaveAttribute('aria-expanded', 'false')
    await expandElectronic.click()
    await expect(window.locator('#market-resonance-children-BK1201')).toBeVisible()
    await expect(window.locator('[data-testid="market-resonance-child-row"]')).toHaveCount(6, { timeout: 60_000 })
    await expect(window.locator('#market-resonance-children-BK1201')).toContainText('本地同日事实')
    const firstChildName = (await window.locator('[data-testid="market-resonance-child-row"] button').first().innerText()).trim()
    await window.locator('[data-testid="market-resonance-child-row"] button').first().click()
    await expect(window.locator('[data-testid="market-resonance-detail"]')).toContainText(firstChildName)
    await expect(window.locator('[data-testid="market-resonance-detail"]')).toContainText('二级行业')
    await window.screenshot({ path: 'test-results/market-resonance-child-detail-1680x960.png' })

    await window.getByRole('button', { name: '展开通信二级行业', exact: true }).click()
    await expect(window.locator('#market-resonance-children-BK1201')).toHaveCount(0)
    await expect(window.locator('[data-testid="market-resonance-child-row"]')).toHaveCount(2, { timeout: 60_000 })
    const expandedGeometry = await window.locator('[data-testid="market-resonance-workbench"]').evaluate((node) => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workbenchOverflow: node.scrollWidth - node.clientWidth,
    }))
    expect(expandedGeometry.documentOverflow).toBeLessThanOrEqual(1)
    expect(expandedGeometry.workbenchOverflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/market-resonance-children-1680x960.png' })

    const datePicker = window.locator('[data-testid="market-resonance-date-picker"]')
    await expect(datePicker).toBeVisible()
    const currentDate = (await datePicker.inputValue()).trim()
    expect(currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const previousButton = window.getByRole('button', { name: '前一交易日' })
    const nextButton = window.getByRole('button', { name: '后一交易日' })
    await expect(previousButton).toBeVisible()
    await expect(previousButton).toBeEnabled({ timeout: 90_000 })
    await expect(nextButton).toBeVisible()

    const previousDate = await previousButton.getAttribute('title')
    const expectedPreviousDate = previousDate?.match(/\d{4}-\d{2}-\d{2}/)?.[0]
    expect(expectedPreviousDate).toBeTruthy()
    await previousButton.click()
    await expect(window.locator('[data-testid="market-resonance-summary"]')).toBeVisible({ timeout: 90_000 })
    await expect
      .poll(async () => (await datePicker.inputValue()).trim(), { timeout: 90_000 })
      .toBe(expectedPreviousDate)
    await expect(window.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()

    await expect(nextButton).toBeEnabled()
    await nextButton.click()
    await expect
      .poll(async () => (await datePicker.inputValue()).trim(), { timeout: 90_000 })
      .toBe(currentDate)

    await previousButton.click()
    await window.getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(window.locator('[data-testid="market-resonance-summary"]')).toBeVisible({ timeout: 90_000 })
    await expect(window.getByRole('button', { name: '回到最新', exact: true })).toHaveCount(0)
    const returnedLatestDate = (await datePicker.inputValue()).trim()
    expect(returnedLatestDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(returnedLatestDate.localeCompare(currentDate)).toBeGreaterThanOrEqual(0)

    const geometry = await window.locator('[data-testid="market-resonance-workbench"]').evaluate((node) => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workbenchOverflow: node.scrollWidth - node.clientWidth,
      actionHeight: Array.from(node.querySelectorAll('header button'))
        .map((button) => (button as HTMLElement).getBoundingClientRect().height)
        .find((height) => height >= 40) ?? 0,
    }))
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
    expect(geometry.workbenchOverflow).toBeLessThanOrEqual(1)
    expect(geometry.actionHeight).toBeGreaterThanOrEqual(44)
    await window.screenshot({ path: 'test-results/market-resonance-1680x960.png' })

    await window.getByLabel('最大化窗口').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true)
    await expect(window.getByRole('button', { name: /^(刷新数据|重新补采)$/ })).toBeEnabled()
    await expect(window.locator('[data-testid="market-resonance-summary"]')).toBeVisible()
    const maximizedOverflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(maximizedOverflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/market-resonance-maximized.png' })

    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['*://*.eastmoney.com/*'] },
        (_details, callback) => callback({ cancel: true }),
      )
    })
    const refreshButton = window.getByRole('button', { name: /^(刷新数据|重新补采)$/ })
    await refreshButton.click()
    await expect(refreshButton).toBeEnabled({ timeout: 30_000 })
    await expect(window.getByRole('alert')).toHaveCount(0)
    await expect(window.locator('[data-testid="market-resonance-summary"]')).toBeVisible()
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})

test('历史市场共振快照可跨重启断网读取', async () => {
  test.setTimeout(240_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-market-resonance-restart-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  let firstApp: Awaited<ReturnType<typeof electron.launch>> | null = null
  let secondApp: Awaited<ReturnType<typeof electron.launch>> | null = null

  try {
    firstApp = await electron.launch({
      args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
      env: { ...launchEnv, NODE_ENV: 'test' },
    })
    const firstWindow = await firstApp.firstWindow()
    await firstWindow.waitForLoadState('domcontentloaded')
    await seedHistoricalSectorFacts(firstApp)
    const archiveDate = HISTORICAL_FIXTURE_DATE
    const firstResult = await firstWindow.evaluate(async (tradeDate) => (
      window.api.market.getMarketOverview({ tradeDate, forceRefresh: true })
    ), archiveDate)
    expect(firstResult.ok).toBe(true)
    if (!firstResult.ok) throw new Error(firstResult.error)
    expect(firstResult.snapshot.resonance.sourceMode).toBe('network_backfill')
    const firstSignature = {
      tradeDate: firstResult.snapshot.resonance.tradeDate,
      generatedAt: firstResult.snapshot.resonance.generatedAt,
      coverage: firstResult.snapshot.resonance.coverage,
      sectorCount: firstResult.snapshot.resonance.sectors.length,
    }
    await firstApp.close()
    firstApp = null

    secondApp = await electron.launch({
      args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
      env: { ...launchEnv, NODE_ENV: 'test' },
    })
    await secondApp.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['*://*.eastmoney.com/*'] },
        (_details, callback) => callback({ cancel: true }),
      )
    })
    const secondWindow = await secondApp.firstWindow()
    await secondWindow.waitForLoadState('domcontentloaded')
    const secondResult = await secondWindow.evaluate(async (tradeDate) => (
      window.api.market.getMarketOverview({ tradeDate })
    ), archiveDate)

    expect(secondResult.ok).toBe(true)
    if (!secondResult.ok) throw new Error(secondResult.error)
    expect(secondResult.snapshot.resonance.sourceMode).toBe('local_archive')
    expect({
      tradeDate: secondResult.snapshot.resonance.tradeDate,
      generatedAt: secondResult.snapshot.resonance.generatedAt,
      coverage: secondResult.snapshot.resonance.coverage,
      sectorCount: secondResult.snapshot.resonance.sectors.length,
    }).toEqual(firstSignature)
  } finally {
    if (firstApp) await firstApp.close()
    if (secondApp) await secondApp.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
