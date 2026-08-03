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

test.describe('关键数据质量中心', () => {
  test('六类数据集可读、正式检查可持久化且双视口不溢出', async ({}, testInfo) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-data-quality-'))
    const app = await launchApp(userDataDir)
    try {
      const window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await window.setViewportSize({ width: 1440, height: 900 })
      const guide = window.locator('[data-testid="cold-start-guide"]')
      if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()

      await window.locator('[data-testid="open-config-drawer-btn"]').click()
      await window.locator('[data-testid="config-tab-diagnostics"]').click()
      const center = window.locator('[data-testid="diagnostics-data-quality"]')
      await expect(center).toBeVisible({ timeout: 15_000 })
      await expect(center.locator('[data-testid^="data-quality-"]')).toHaveCount(6)
      await expect(center).toContainText('股票基础资料')
      await expect(center).toContainText('产业研究财务')

      await window.locator('[data-testid="diagnostics-run-data-quality"]').click()
      await expect(window.locator('[data-testid="diagnostics-panel"]')).toContainText('完整检查已保存')
      await expect.poll(async () => {
        const response = await window.evaluate(() => window.api.diagnostics.getHealth())
        return response.ok ? response.data.dataQuality?.persistedRunId ?? null : null
      }).toBeGreaterThan(0)

      const desktopGeometry = await window.evaluate(() => ({
        innerWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        drawer: (() => {
          const element = document.querySelector('[data-testid="config-drawer"] aside')
          if (!element) return null
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width }
        })(),
      }))
      expect(desktopGeometry.documentWidth).toBeLessThanOrEqual(desktopGeometry.innerWidth)
      expect(desktopGeometry.drawer?.left).toBeGreaterThanOrEqual(0)
      expect(desktopGeometry.drawer?.right).toBeLessThanOrEqual(desktopGeometry.innerWidth)
      await window.screenshot({ path: testInfo.outputPath('data-quality-1440-light.png') })

      await window.locator('[data-testid="config-tab-appearance"]').click()
      await window.getByRole('button', { name: '暗色模式' }).click()
      await window.locator('[data-testid="config-tab-diagnostics"]').click()
      await window.setViewportSize({ width: 1024, height: 768 })
      await expect(center).toBeVisible()
      await center.scrollIntoViewIfNeeded()
      const compactGeometry = await window.evaluate(() => {
        const panel = document.querySelector('[data-testid="diagnostics-panel"]')
        return {
          innerWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          panelScrollable: panel ? panel.scrollHeight > panel.clientHeight : false,
          panelWidth: panel?.getBoundingClientRect().width ?? 0,
        }
      })
      expect(compactGeometry.documentWidth).toBeLessThanOrEqual(compactGeometry.innerWidth)
      expect(compactGeometry.panelWidth).toBeLessThanOrEqual(compactGeometry.innerWidth)
      expect(compactGeometry.panelScrollable).toBe(true)
      await window.screenshot({ path: testInfo.outputPath('data-quality-1024-dark.png') })
    } finally {
      await app.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })
})
