import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const navItems = [
  ['decision-center', 'dashboard'],
  ['stock-chart', 'stock'],
  ['trend-watcher', 'trend'],
  ['industry-heatmap', 'heatmap'],
  ['short-term-strategy', 'strategy'],
  ['feed', 'news'],
  ['ai-analysis', 'ai'],
] as const

test('一级导航使用科技终端图标并保留交互与减少动态效果', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-primary-nav-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const guide = window.locator('[data-testid="cold-start-guide"]')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()

    for (const [tab, icon] of navItems) {
      await expect(window.locator(`[data-testid="nav-tab-${tab}"] [data-nav-icon="${icon}"]`)).toHaveCount(1)
    }
    await expect(window.locator('[data-testid="open-message-center-btn"] [data-nav-icon="messages"]')).toHaveCount(1)
    await expect(window.locator('[data-testid="open-config-drawer-btn"] [data-nav-icon="settings"]')).toHaveCount(1)

    const iconSizes = await window.locator('[data-nav-icon]').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return [Math.round(rect.width), Math.round(rect.height)]
    }))
    expect(iconSizes).toHaveLength(9)
    expect(iconSizes.every(([width, height]) => width === 23 && height === 23)).toBe(true)

    const activeButton = window.locator('[data-testid="nav-tab-decision-center"]')
    await expect(activeButton).toHaveClass(/is-active/)
    expect(await activeButton.evaluate((node) => getComputedStyle(node, '::before').opacity)).toBe('1')

    const dashboardTelemetry = await window.locator('[data-nav-icon="dashboard"] .nav-tech-telemetry').getAttribute('d')
    const heatmapTelemetry = await window.locator('[data-nav-icon="heatmap"] .nav-tech-telemetry').getAttribute('d')
    const settingsTelemetry = await window.locator('[data-nav-icon="settings"] .nav-tech-telemetry').getAttribute('d')
    expect(heatmapTelemetry).not.toBe(dashboardTelemetry)
    expect(settingsTelemetry).not.toBe(dashboardTelemetry)
    await expect(window.locator('[data-nav-icon="settings"] [class^="nav-tech-settings-control-"]')).toHaveCount(3)

    const heatmapButton = window.locator('[data-testid="nav-tab-industry-heatmap"]')
    await heatmapButton.hover()
    await window.waitForTimeout(180)
    const heatmapState = await heatmapButton.evaluate((node) => ({
      fieldTransform: getComputedStyle(node.querySelector('.nav-tech-heatmap-field')!).transform,
      coreTransform: getComputedStyle(node.querySelector('.nav-tech-heatmap-core')!).transform,
    }))
    expect(heatmapState.fieldTransform).not.toBe('none')
    expect(heatmapState.coreTransform).not.toBe('none')

    const strategyButton = window.locator('[data-testid="nav-tab-short-term-strategy"]')
    await strategyButton.hover()
    await window.waitForTimeout(180)
    const hoverState = await strategyButton.evaluate((node) => ({
      scanAnimation: getComputedStyle(node, '::after').animationName,
      iconTransform: getComputedStyle(node.querySelector('[data-nav-icon]')!).transform,
      sweepTransform: getComputedStyle(node.querySelector('.nav-tech-strategy-sweep')!).transform,
    }))
    expect(hoverState.scanAnimation).toContain('app-primary-nav-scan')
    expect(hoverState.iconTransform).not.toBe('none')
    expect(hoverState.sweepTransform).not.toBe('none')

    const settingsButton = window.locator('[data-testid="open-config-drawer-btn"]')
    await settingsButton.hover()
    await window.waitForTimeout(180)
    const settingsState = await settingsButton.evaluate((node) => ({
      firstControlTransform: getComputedStyle(node.querySelector('.nav-tech-settings-control-a')!).transform,
      secondControlTransform: getComputedStyle(node.querySelector('.nav-tech-settings-control-b')!).transform,
      thirdControlTransform: getComputedStyle(node.querySelector('.nav-tech-settings-control-c')!).transform,
    }))
    expect(settingsState.firstControlTransform).not.toBe('none')
    expect(settingsState.secondControlTransform).not.toBe('none')
    expect(settingsState.thirdControlTransform).not.toBe('none')

    await window.emulateMedia({ reducedMotion: 'reduce' })
    expect(await strategyButton.evaluate((node) => getComputedStyle(node, '::after').display)).toBe('none')
    expect(await settingsButton.evaluate((node) => getComputedStyle(node.querySelector('.nav-tech-settings-control-a')!).transform)).toBe('none')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
