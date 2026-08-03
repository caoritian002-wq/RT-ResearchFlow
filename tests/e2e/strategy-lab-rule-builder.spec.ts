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

function seedStrategyFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const tradeDate = '20260721'
    db.prepare('INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('000001.SZ', tradeDate, 10.6, 6, 10, 10.6, 10, 1000000, 2.1)
    db.prepare('INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)').run('000001', '平安银行', Date.now())
    const insertMinute = db.prepare('INSERT OR REPLACE INTO stock_minute_cache (stock_code, trade_date, ts_minute, open, high, low, close, vol, amount, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (let index = 0; index < 16; index += 1) {
      const close = 10 + index * 0.04
      const minute = '09:' + String(30 + index).padStart(2, '0')
      insertMinute.run('000001.SZ', tradeDate, minute, close, close, close, close, 1000 + index * 10, 10000 + index * 100, Date.now())
    }
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

async function enterStrategyLab(app: ElectronApplication) {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-strategyLab').click()
  await expect(window.getByText('策略实验室', { exact: true }).first()).toBeVisible()
  return window
}

test('策略实验室自由配置分钟条件并使用保存快照运行', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-strategy-lab-'))
  let app = await launchApp(userDataDir)
  try {
    await app.firstWindow()
    await app.close()
    seedStrategyFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))

    app = await launchApp(userDataDir)
    let window = await enterStrategyLab(app)
    await window.setViewportSize({ width: 1440, height: 900 })
    const strategyMain = window.getByTestId('strategy-lab-main')
    const strategyScroll = window.getByTestId('strategy-lab-scroll')
    const mainBefore = await strategyMain.boundingBox()
    const scrollBefore = await strategyScroll.evaluate(element => element.scrollTop)
    await window.getByRole('button', { name: '新建', exact: true }).click()
    const configDrawer = window.getByTestId('strategy-config-drawer')
    await expect(configDrawer).toBeVisible()
    await expect(configDrawer).toHaveAttribute('aria-modal', 'true')
    const configScrim = window.getByTestId('strategy-config-drawer-scrim')
    await expect(configScrim).toBeVisible()
    await expect(configScrim).toHaveCSS('background-color', 'rgba(2, 6, 23, 0.5)')
    const configDrawerBox = await configDrawer.boundingBox()
    expect(configDrawerBox?.y ?? 999).toBeLessThanOrEqual(1)
    expect(configDrawerBox?.height ?? 0).toBeGreaterThanOrEqual(899)
    const mainAfter = await strategyMain.boundingBox()
    const scrollAfter = await strategyScroll.evaluate(element => element.scrollTop)
    expect(mainAfter?.width).toBeCloseTo(mainBefore?.width ?? 0, 0)
    expect(mainAfter?.x).toBeCloseTo(mainBefore?.x ?? 0, 0)
    expect(scrollAfter).toBe(scrollBefore)
    const builder = window.getByTestId('strategy-rule-builder')
    await expect(builder).toBeVisible()
    await builder.getByLabel('策略名称').fill('5%窗口策略')
    await builder.locator('[data-pool-source="allMarket"] input').uncheck()
    await builder.locator('[data-pool-source="manual"] input').check()
    await builder.getByTestId('strategy-manual-stocks').fill('000001.SZ')

    const gainRow = builder.locator('[data-condition-type="minute_window_gain"]').first()
    await gainRow.locator('[data-param-key="minGainPct"]').fill('5')
    for (const type of ['minute_window_volume_ratio', 'pullback_after_high', 'hold_above_gain_ratio', 'close_retention']) {
      await builder.locator(`[data-condition-type="${type}"]`).first().locator('input[type="checkbox"]').first().uncheck()
    }
    let nativeDialogSeen = false
    window.once('dialog', dialog => {
      nativeDialogSeen = true
      void dialog.dismiss()
    })
    await window.keyboard.press('Escape')
    const discardDialog = window.getByTestId('strategy-confirm-dialog')
    await expect(discardDialog).toBeVisible()
    await expect(discardDialog.getByText('放弃未保存修改？', { exact: true })).toBeVisible()
    await expect(discardDialog.getByRole('button', { name: '继续编辑' })).toBeFocused()
    await expect(configDrawer).toBeVisible()
    expect(nativeDialogSeen).toBe(false)
    const screenshotDir = process.env.STRATEGY_LAB_SCREENSHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      await window.screenshot({ path: join(screenshotDir, 'strategy-lab-discard-dialog-1440.png') })
      await window.setViewportSize({ width: 1024, height: 768 })
      await window.emulateMedia({ reducedMotion: 'reduce' })
      await window.evaluate(() => document.documentElement.classList.add('dark'))
      await expect(discardDialog).toHaveCSS('background-color', 'rgb(15, 23, 42)')
      await window.screenshot({ path: join(screenshotDir, 'strategy-lab-discard-dialog-dark-1024.png') })
      await window.evaluate(() => document.documentElement.classList.remove('dark'))
      await window.emulateMedia({ reducedMotion: 'no-preference' })
      await window.setViewportSize({ width: 1440, height: 900 })
    }
    await window.keyboard.press('Escape')
    await expect(discardDialog).toBeHidden()
    await expect(configDrawer).toBeVisible()
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      await builder.scrollIntoViewIfNeeded()
      await window.screenshot({ path: join(screenshotDir, 'strategy-lab-builder-1440.png'), fullPage: true })
      await window.setViewportSize({ width: 1024, height: 768 })
      await expect(builder).toBeVisible()
      const builderOverflow1024 = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(builderOverflow1024).toBeLessThanOrEqual(1)
      await window.screenshot({ path: join(screenshotDir, 'strategy-lab-builder-1024.png'), fullPage: true })
      await window.setViewportSize({ width: 1440, height: 900 })
    }
    await builder.getByRole('button', { name: '保存并运行' }).click()

    await expect(window.getByText('平安银行', { exact: true })).toBeVisible({ timeout: 30_000 })
    const resultRow = window.locator('tbody tr').filter({ hasText: '平安银行' }).first()
    await resultRow.getByRole('button', { name: '证据' }).click()
    const evidenceSidebar = window.getByTestId('strategy-evidence-sidebar')
    await expect(evidenceSidebar.getByText(/配置：任意 15 分钟涨幅 ≥ 5%/)).toBeVisible()
    await expect(evidenceSidebar.getByText(/实际窗口涨幅/)).toBeVisible()

    const overflow1440 = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow1440).toBeLessThanOrEqual(1)
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-lab-1440.png'), fullPage: true })
    }

    await window.setViewportSize({ width: 1024, height: 768 })
    const overflow1024 = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow1024).toBeLessThanOrEqual(1)
    const evidenceDrawer = window.getByTestId('strategy-evidence-drawer')
    await expect(evidenceDrawer).toBeVisible()
    await expect(evidenceDrawer.getByText(/配置：任意 15 分钟涨幅 ≥ 5%/)).toBeVisible()
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-lab-1024.png'), fullPage: true })
    }
    await window.keyboard.press('Escape')
    await expect(evidenceDrawer).toBeHidden()

    await window.emulateMedia({ reducedMotion: 'reduce' })
    expect(await window.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await resultRow.getByRole('button', { name: '证据' }).click()
    await expect(evidenceDrawer).toHaveCSS('background-color', 'rgb(2, 6, 23)')
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-lab-dark-1024.png'), fullPage: true })
    }
    await evidenceDrawer.getByRole('button', { name: '关闭证据' }).click()
    await window.evaluate(() => document.documentElement.classList.remove('dark'))

    await app.close()
    app = await launchApp(userDataDir)
    window = await enterStrategyLab(app)
    await window.getByText('5%窗口策略', { exact: true }).click()
    const restoredDrawer = window.getByTestId('strategy-config-drawer')
    if (!await restoredDrawer.isVisible()) {
      await window.getByRole('button', { name: '配置', exact: true }).click()
    }
    await expect(restoredDrawer).toBeVisible()
    const restoredBuilder = window.getByTestId('strategy-rule-builder')
    await expect(restoredBuilder.locator('[data-condition-type="minute_window_gain"] [data-param-key="minGainPct"]')).toHaveValue('5')
    await expect(restoredBuilder.getByTestId('strategy-manual-stocks')).toHaveValue('000001.SZ')
    await window.keyboard.press('Escape')
    await expect(restoredDrawer).toBeHidden()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
