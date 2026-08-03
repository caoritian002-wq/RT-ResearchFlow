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

async function openDecisionCenter(app: ElectronApplication) {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const guide = window.locator('[data-testid="cold-start-guide"]')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.locator('[data-testid="nav-tab-decision-center"]').click()
  await expect(window.locator('[data-testid="decision-center-root"]')).toBeVisible({ timeout: 15_000 })
  return window
}

test.describe('今日看板布局与筛选偏好', () => {
  test('四项指标整体居中，P4 可跨 Tab 和重启保留', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-decision-preferences-'))
    let app = await launchApp(userDataDir)
    try {
      let window = await openDecisionCenter(app)
      const metrics = window.locator('[data-testid="decision-command-metric"]')
      await expect(metrics).toHaveCount(4)
      const alignments = await metrics.evaluateAll((nodes) => nodes.map((node) => {
        const style = getComputedStyle(node)
        return { alignItems: style.alignItems, justifyContent: style.justifyContent, textAlign: style.textAlign }
      }))
      expect(alignments).toEqual(Array.from({ length: 4 }, () => ({
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
      })))

      const priority = window.locator('[data-testid="decision-min-priority-filter"]')
      await priority.fill('4')
      await expect(priority).toHaveValue('4')
      await expect(window.locator('[data-testid="decision-filter-panel"]')).toContainText('P4+')
      await expect.poll(() => window.evaluate(() => {
        const raw = localStorage.getItem('decisionCenterFilters')
        return raw ? JSON.parse(raw).minPriority : null
      })).toBe(4)
      await expect.poll(() => window.evaluate(() => window.api.settings.getDecisionCenterFilters()))
        .toMatchObject({ minPriority: 4 })

      await window.locator('[data-testid="nav-tab-feed"]').click()
      await window.locator('[data-testid="nav-tab-decision-center"]').click()
      await expect(priority).toHaveValue('4')

      await window.evaluate(() => localStorage.removeItem('decisionCenterFilters'))
      await app.close()
      app = await launchApp(userDataDir)
      window = await openDecisionCenter(app)
      await expect(window.locator('[data-testid="decision-min-priority-filter"]')).toHaveValue('4')
      await expect.poll(() => window.evaluate(() => {
        const raw = localStorage.getItem('decisionCenterFilters')
        return raw ? JSON.parse(raw).minPriority : null
      })).toBe(4)
    } finally {
      await app.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })
})
