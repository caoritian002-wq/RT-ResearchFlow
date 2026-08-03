import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
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

test('题材数据使用可滚动抽屉且不干扰策略实验室', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-data-tools-'))
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1024, height: 600 })
    const guide = window.getByTestId('cold-start-guide')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()

    await window.getByTestId('nav-tab-short-term-strategy').click()
    await window.getByTestId('secondary-nav-short-term-strategy-morningAuction').click()

    const entry = window.getByRole('button', { name: /题材数据/ })
    await expect(entry).toBeVisible()
    await expect(entry).toContainText('开盘啦')
    await entry.click()

    const drawer = window.getByTestId('short-term-data-tools-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveAttribute('aria-modal', 'true')
    const drawerBox = await drawer.boundingBox()
    expect(drawerBox?.y ?? 999).toBeLessThanOrEqual(1)
    expect(drawerBox?.height ?? 0).toBeGreaterThanOrEqual(599)
    await expect(drawer.getByText('题材归因与共振验证', { exact: true })).toBeVisible()
    await expect(drawer.getByText('不是股票行情源', { exact: false })).toBeVisible()

    const content = drawer.getByTestId('short-term-data-tools-content')
    const scrollContainer = content.locator('..')
    const scrollMetrics = await scrollContainer.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }))
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight)
    const baseSyncButton = drawer.getByRole('button', { name: '同步盘后基础数据' })
    await baseSyncButton.scrollIntoViewIfNeeded()
    await expect(baseSyncButton).toBeVisible()

    await drawer.getByRole('button', { name: /同花顺/ }).click()
    await window.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(window.getByRole('button', { name: '题材数据 · 同花顺' })).toBeVisible()

    await window.getByTestId('nav-tab-short-term-strategy').click()
    await window.getByTestId('secondary-nav-short-term-strategy-limitBoardMonitor').click()
    await expect(window.getByRole('button', { name: '题材数据 · 同花顺' })).toBeVisible()

    await window.getByTestId('nav-tab-short-term-strategy').click()
    await window.getByTestId('secondary-nav-short-term-strategy-strategyLab').click()
    await expect(window.getByText('策略实验室', { exact: true }).first()).toBeVisible()
    await expect(window.getByRole('button', { name: /题材数据/ })).toHaveCount(0)
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
