import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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

async function openPremarketSettings(window: Page): Promise<void> {
  await window.waitForLoadState('domcontentloaded')
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.getByTestId('open-config-drawer-btn').click()
  await window.getByTestId('config-tab-settings').click()
  await window.getByTestId('premarket-capture-settings').scrollIntoViewIfNeeded()
}

test('盘前事实采集默认关闭、动态启停并跨重启恢复', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-premarket-settings-'))
  const screenshotDir = join(process.cwd(), 'test-results', 'premarket-capture-settings')
  mkdirSync(screenshotDir, { recursive: true })
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await openPremarketSettings(window)

    const section = window.getByTestId('premarket-capture-settings')
    const toggle = section.getByRole('switch', { name: '盘前外部事实采集' })
    const capture = section.getByRole('button', { name: '补采当前窗口' })
    await expect(section).toContainText('已关闭，不会发起盘前外部请求')
    await expect(section.getByText('尚无快照')).toHaveCount(2)
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect((await capture.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await expect(capture).toBeDisabled()

    const initial = await window.evaluate(() => window.api.premarket.getStatus())
    expect(initial).toMatchObject({ enabled: false, schedulerActive: false })
    expect(initial.stages.every((stage) => stage.latest === null)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'disabled-1440x900-light.png') })

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
    const enabled = await window.evaluate(() => window.api.premarket.getStatus())
    expect(enabled.enabled).toBe(true)
    expect(enabled.schedulerActive).toBe(true)
    await expect(capture).toBeDisabled()

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await section.scrollIntoViewIfNeeded()
    expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    expect(await window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'enabled-1024x768-dark.png') })

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await app.close()

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await openPremarketSettings(window)
    await expect(window.getByTestId('premarket-capture-settings').getByRole('switch'))
      .toHaveAttribute('aria-checked', 'false')
    const restarted = await window.evaluate(() => window.api.premarket.getStatus())
    expect(restarted.enabled).toBe(false)
    expect(restarted.schedulerActive).toBe(false)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
