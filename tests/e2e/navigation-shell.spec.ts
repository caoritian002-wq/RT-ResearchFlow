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
  return window
}

test('sidebar persists while the window blocks edge resizing and supports maximize/restore', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-navigation-shell-'))
  const screenshotDir = join(process.cwd(), 'test-results')
  mkdirSync(screenshotDir, { recursive: true })
  let app = await launchApp(userDataDir)

  try {
    let window = await openWindow(app)
    const shell = window.getByTestId('app-navigation-shell')
    const toggle = window.getByTestId('navigation-toggle')

    await expect(shell).toHaveAttribute('data-expanded', 'true')
    expect(Math.round((await shell.boundingBox())?.width ?? 0)).toBe(224)
    await expect(window.getByTestId('nav-label-decision-center')).toHaveText('今日看板')
    await expect(window.getByTestId('nav-label-ai-analysis')).toHaveText('AI分析')
    await expect(window.getByLabel('最大化窗口')).toBeVisible()

    const windowContract = await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      return mainWindow ? {
        size: mainWindow.getSize(),
        resizable: mainWindow.isResizable(),
        maximizable: mainWindow.isMaximizable(),
        fullscreenable: mainWindow.isFullScreenable(),
        manualResizeGuardCount: mainWindow.listenerCount('will-resize'),
      } : null
    })
    expect(windowContract).toEqual({
      size: [1680, 960],
      resizable: true,
      maximizable: true,
      fullscreenable: false,
      manualResizeGuardCount: 1,
    })

    await window.getByLabel('最大化窗口').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true)
    await expect(window.getByLabel('还原窗口')).toBeVisible()
    await window.getByLabel('还原窗口').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(false)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize() ?? [])).toEqual([1680, 960])

    const primaryButtons = window.locator('[data-testid^="nav-tab-"]')
    const primaryHeights = await primaryButtons.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
    expect(primaryHeights.every(height => height >= 44)).toBe(true)
    expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(44)

    const shortTerm = window.getByTestId('nav-tab-short-term-strategy')
    await shortTerm.click()
    await expect(shortTerm).toHaveAttribute('aria-expanded', 'true')
    const inlineGroup = window.getByRole('group', { name: '短线策略二级导航' })
    await expect(inlineGroup).toBeVisible()
    await expect(inlineGroup.getByText('早盘集合竞价')).toBeVisible()
    await expect(inlineGroup.getByText('策略评估')).toBeVisible()

    const aiAnalysis = window.getByTestId('nav-tab-ai-analysis')
    await aiAnalysis.focus()
    await aiAnalysis.press('Enter')
    await expect(shortTerm).toHaveAttribute('aria-expanded', 'false')
    await expect(inlineGroup).toHaveCount(0)
    await expect(aiAnalysis).toHaveAttribute('aria-expanded', 'true')
    await expect(window.getByRole('group', { name: 'AI分析二级导航' })).toBeVisible()

    await shortTerm.click()
    await expect(inlineGroup).toBeVisible()
    await window.screenshot({ path: join(screenshotDir, 'navigation-expanded-1680x960-light.png') })

    await toggle.click()
    await expect(shell).toHaveAttribute('data-expanded', 'false')
    await expect.poll(async () => Math.round((await shell.boundingBox())?.width ?? 0)).toBe(64)
    await expect(window.getByTestId('nav-label-decision-center')).toHaveCount(0)

    await shortTerm.click()
    const flyout = window.getByRole('menu', { name: '短线策略二级导航' })
    await expect(flyout).toBeVisible()
    await expect(flyout.getByText('策略实验室')).toBeVisible()
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await window.waitForTimeout(220)
    await window.screenshot({ path: join(screenshotDir, 'navigation-collapsed-1680x960-dark.png') })

    await app.close()
    app = await launchApp(userDataDir)
    window = await openWindow(app)
    await expect(window.getByTestId('app-navigation-shell')).toHaveAttribute('data-expanded', 'false')
    await window.getByTestId('navigation-toggle').click()
    await expect(window.getByTestId('app-navigation-shell')).toHaveAttribute('data-expanded', 'true')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
