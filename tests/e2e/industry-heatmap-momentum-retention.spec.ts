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

async function openWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.getByTestId('app-navigation-shell')).toBeVisible({ timeout: 15_000 })
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.setViewportSize({ width: 1680, height: 960 })
  return window
}

async function openIndustryHeatmap(window: Page): Promise<void> {
  await window.getByTestId('nav-tab-industry-heatmap').click()
  await window.getByTestId('secondary-nav-industry-heatmap-industry').click()
  await expect(window.getByText('今日涨跌幅', { exact: true })).toBeVisible({ timeout: 30_000 })
}

test('盘后历史恢复样本明确披露来源、边界与一级行业覆盖', async () => {
  test.setTimeout(60_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-heatmap-momentum-empty-'))
  const screenshotDir = join(process.cwd(), 'test-results')
  mkdirSync(screenshotDir, { recursive: true })
  const app = await launchApp(userDataDir)

  try {
    const window = await openWindow(app)
    await window.evaluate(async () => {
      await window.api.settings.setMarketHeatmapProvider('sina')
      localStorage.setItem('heatmapMomentumLatest_sina', JSON.stringify({
        version: 2,
        momentum: { 电子: 0.31, 煤炭: -0.18 },
        capturedAt: Date.parse('2026-08-11T07:00:00.000Z'),
        tradeDate: '2026-08-11',
        windowMinutes: 3,
        origin: 'historical-recovery',
        sourceProvider: 'eastmoney',
        scope: 'shenwan-l1',
        boundary: 'market-close',
        coverage: {
          l1: { available: 31, total: 31 },
          l2: { available: 0, total: 0 },
        },
      }))
    })
    await openIndustryHeatmap(window)
    await expect(window.getByText('3min 动量', { exact: true })).toBeVisible()
    await expect(window.getByTestId('industry-heatmap-momentum-state')).toHaveText('上个交易日收盘前回放')
    await expect(window.getByText('历史恢复 · 08-11 15:00', { exact: true })).toBeVisible()
    await expect(window.getByText('L1 31', { exact: true })).toBeVisible()
    await expect(window.getByText('+0.31%', { exact: true })).toBeVisible()
    await expect(window.getByText('-0.18%', { exact: true })).toBeVisible()
    await expect(window.getByText(/数据积累中，约 \d+ 分钟后显示动量/)).toHaveCount(0)
    await window.screenshot({ path: join(screenshotDir, 'industry-heatmap-recovered-momentum.png') })
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('盘后动量按provider披露保留样本并跨重启恢复', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-heatmap-momentum-'))
  const screenshotDir = join(process.cwd(), 'test-results')
  mkdirSync(screenshotDir, { recursive: true })
  let app: ElectronApplication | null = null

  try {
    app = await launchApp(userDataDir)
    let window = await openWindow(app)
    await window.evaluate(async () => {
      await window.api.settings.setMarketHeatmapProvider('sina')
      localStorage.setItem('heatmapMomentumLatest_sina', JSON.stringify({
        version: 1,
        momentum: {
          畜牧业: 0.42,
          研究和试验发展: -0.29,
        },
        capturedAt: Date.parse('2026-08-11T07:00:00.000Z'),
        tradeDate: '2026-08-11',
        windowMinutes: 3,
      }))
    })

    await openIndustryHeatmap(window)
    await expect(window.getByText('3min 动量', { exact: true })).toBeVisible()
    await expect(window.getByTestId('industry-heatmap-momentum-state')).toHaveText('上个交易日收盘前回放')
    await expect(window.getByText('保留样本 · 08-11 15:00', { exact: true })).toBeVisible()
    await expect(window.getByText('+0.42%', { exact: true })).toBeVisible()
    await expect(window.getByText('-0.29%', { exact: true })).toBeVisible()
    await window.screenshot({ path: join(screenshotDir, 'industry-heatmap-retained-momentum.png') })

    await app.close()
    app = await launchApp(userDataDir)
    window = await openWindow(app)
    await openIndustryHeatmap(window)
    await expect(window.getByText('3min 动量', { exact: true })).toBeVisible()
    await expect(window.getByTestId('industry-heatmap-momentum-state')).toHaveText('上个交易日收盘前回放')
    await expect(window.getByText('保留样本 · 08-11 15:00', { exact: true })).toBeVisible()
  } finally {
    await app?.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('行业云图浮层互斥且工具栏下拉可被窗口采集', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-heatmap-overlay-'))
  const screenshotDir = join(process.cwd(), 'test-results')
  mkdirSync(screenshotDir, { recursive: true })
  const app = await launchApp(userDataDir)

  try {
    const window = await openWindow(app)
    await openIndustryHeatmap(window)
    const workbench = window.getByTestId('industry-heatmap-workbench')
    await expect(workbench.locator('select')).toHaveCount(0)

    const drawRuleTrigger = window.getByTestId('industry-heatmap-draw-rule-trigger')
    await drawRuleTrigger.click()
    const drawRuleListbox = window.getByTestId('industry-heatmap-draw-rule-listbox')
    await expect(drawRuleListbox).toBeVisible()
    const listboxGeometry = await drawRuleListbox.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        position: getComputedStyle(node).position,
      }
    })
    expect(listboxGeometry.position).toBe('absolute')
    expect(listboxGeometry.left).toBeGreaterThanOrEqual(0)
    expect(listboxGeometry.top).toBeGreaterThanOrEqual(0)
    expect(listboxGeometry.right).toBeLessThanOrEqual(listboxGeometry.viewportWidth)
    expect(listboxGeometry.bottom).toBeLessThanOrEqual(listboxGeometry.viewportHeight)
    await window.screenshot({ path: join(screenshotDir, 'industry-heatmap-dom-dropdown.png') })

    await window.getByTestId('industry-heatmap-draw-rule-option-absChange').click()
    await expect(drawRuleTrigger).toContainText('涨跌幅强度')
    await window.getByTestId('industry-heatmap-provider-trigger').click()
    await expect(window.getByTestId('industry-heatmap-provider-listbox')).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(window.getByTestId('industry-heatmap-provider-listbox')).toHaveCount(0)
    await window.waitForTimeout(800)

    const rankingItem = window.getByTestId('industry-heatmap-ranking-item').first()
    await expect(rankingItem).toBeVisible({ timeout: 60_000 })
    const chartRegion = window.getByTestId('industry-heatmap-chart-region')
    const chartCanvas = chartRegion.locator('canvas:visible').first()
    await expect(chartCanvas).toBeVisible()
    const chartBox = await chartCanvas.boundingBox()
    expect(chartBox).not.toBeNull()
    if (!chartBox) throw new Error('INDUSTRY_HEATMAP_CHART_BOUNDS_UNAVAILABLE')
    await window.mouse.move(
      chartBox.x + chartBox.width * 0.4,
      chartBox.y + chartBox.height * 0.4,
    )
    await window.mouse.move(
      chartBox.x + chartBox.width * 0.5,
      chartBox.y + chartBox.height * 0.5,
    )
    const treemapTooltip = window.locator('.industry-heatmap-treemap-tooltip:visible')
    await expect(treemapTooltip).toHaveCount(1, { timeout: 10_000 })

    await rankingItem.hover()
    await expect(window.getByTestId('industry-heatmap-ranking-tooltip')).toBeVisible()
    await expect(treemapTooltip).toHaveCount(0)
    await window.screenshot({ path: join(screenshotDir, 'industry-heatmap-single-hover-overlay.png') })
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
