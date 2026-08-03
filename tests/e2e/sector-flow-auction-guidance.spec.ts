import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function openSectorFlow(window: Page): Promise<void> {
  const guide = window.locator('[data-testid="cold-start-guide"]')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.locator('[data-testid="nav-tab-industry-heatmap"]').click()
  await window.locator('[data-testid="secondary-nav-industry-heatmap-sectorFlow"]').click()
  await expect(window.locator('[data-testid="sector-flow-workbench"]')).toBeVisible()
  await expect(window.locator('[data-testid="sector-flow-guidance"]')).toBeVisible({ timeout: 90_000 })
  await expect(window.getByText('真实资金', { exact: false }).first()).toBeVisible({ timeout: 90_000 })
}

test('板块资金首屏输出真实资金与去重竞价指引并适配双视口', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-sector-flow-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    await openSectorFlow(window)

    await expect(window.getByText('明早竞价观察', { exact: true })).toBeVisible()
    await expect(window.getByText('完整板块明细', { exact: true })).toBeVisible()
    await expect(window.getByText('全市场净流入合计', { exact: false })).toHaveCount(0)
    expect(await window.locator('[data-testid="sector-flow-focus-theme"]').count()).toBeLessThanOrEqual(3)
    expect(await window.locator('[data-testid="sector-flow-risk-theme"]').count()).toBeLessThanOrEqual(3)

    const geometry = await window.locator('[data-testid="sector-flow-workbench"]').evaluate((node) => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workbenchOverflow: node.scrollWidth - node.clientWidth,
      refreshHeight: (node.querySelector('header button') as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
    }))
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
    expect(geometry.workbenchOverflow).toBeLessThanOrEqual(1)
    expect(geometry.refreshHeight).toBeGreaterThanOrEqual(44)
    await window.screenshot({ path: 'test-results/sector-flow-1440x900.png' })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await expect(window.locator('[data-testid="sector-flow-guidance"]')).toBeVisible()
    const compactOverflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(compactOverflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/sector-flow-1024x768-dark.png' })
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
