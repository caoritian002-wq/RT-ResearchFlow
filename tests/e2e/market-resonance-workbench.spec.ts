import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function openMarketResonance(window: Page): Promise<void> {
  const guide = window.locator('[data-testid="cold-start-guide"]')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.locator('[data-testid="nav-tab-industry-heatmap"]').click()
  await window.locator('[data-testid="secondary-nav-industry-heatmap-heatmap"]').click()
  await expect(window.locator('[data-testid="market-resonance-workbench"]')).toBeVisible()
  await expect(window.locator('[data-testid="market-resonance-summary"]')).toBeVisible({ timeout: 90_000 })
  await expect(window.getByRole('button', { name: '刷新数据', exact: true })).toBeEnabled()
}

test('市场共振页移除重复导航并输出真实行业指数对比', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-market-resonance-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    await openMarketResonance(window)

    await expect(window.getByRole('heading', { name: '市场共振', exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: '行业云图', exact: true })).toHaveCount(0)
    await window.getByRole('button', { name: '全部行业', exact: true }).click()
    expect(await window.locator('[data-testid="market-resonance-row"]').count()).toBeGreaterThanOrEqual(28)
    await expect(window.locator('[data-testid="market-resonance-detail"] svg')).toBeVisible()

    const geometry = await window.locator('[data-testid="market-resonance-workbench"]').evaluate((node) => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workbenchOverflow: node.scrollWidth - node.clientWidth,
      refreshHeight: (node.querySelector('header > div button') as HTMLElement | null)?.getBoundingClientRect().height ?? 0,
    }))
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
    expect(geometry.workbenchOverflow).toBeLessThanOrEqual(1)
    expect(geometry.refreshHeight).toBeGreaterThanOrEqual(44)
    await window.screenshot({ path: 'test-results/market-resonance-1440x900.png' })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await expect(window.getByRole('button', { name: '刷新数据', exact: true })).toBeEnabled()
    await expect(window.locator('[data-testid="market-resonance-summary"]')).toBeVisible()
    await expect.poll(
      () => window.locator('[data-testid="market-resonance-row"]').first().evaluate((node) => getComputedStyle(node).backgroundColor),
    ).toContain('8, 51, 68')
    const compactOverflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(compactOverflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/market-resonance-1024x768-dark.png' })
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
