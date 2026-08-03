import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('production window keeps navigation and external links inside the security boundary', async () => {
  test.setTimeout(60_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-release-security-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible({ timeout: 15_000 })

    await window.emulateMedia({ reducedMotion: 'reduce' })
    const reducedMotionLoadingStyle = await window.evaluate(() => {
      const spinner = document.createElement('span')
      spinner.className = 'h-7 w-7 animate-spin motion-reduce:[animation-duration:1.8s]'
      document.body.append(spinner)
      const style = window.getComputedStyle(spinner)
      const result = {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationPlayState: style.animationPlayState,
      }
      spinner.remove()
      return result
    })
    expect(reducedMotionLoadingStyle.animationName).not.toBe('none')
    expect(reducedMotionLoadingStyle.animationDuration).toBe('1.8s')
    expect(reducedMotionLoadingStyle.animationPlayState).toBe('running')

    const guide = window.getByTestId('cold-start-guide')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()

    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const mainWindow = BrowserWindow.getAllWindows()[0]
      return mainWindow?.webContents.getLastWebPreferences()
    })
    expect(preferences?.sandbox).toBe(true)
    expect(preferences?.contextIsolation).toBe(true)
    expect(preferences?.nodeIntegration).toBe(false)
    expect(preferences?.webviewTag).toBe(false)

    await app.evaluate(({ shell }) => {
      const releaseGlobal = globalThis as typeof globalThis & { __releaseSecurityOpenedUrls?: string[] }
      releaseGlobal.__releaseSecurityOpenedUrls = []
      Object.defineProperty(shell, 'openExternal', {
        configurable: true,
        value: async (url: string) => {
          releaseGlobal.__releaseSecurityOpenedUrls?.push(url)
        },
      })
    })

    const externalResults = await window.evaluate(async () => {
      const valid = await window.api.openExternal('https://example.com/research?q=release')
      const invalid = await window.api.openExternal('javascript:alert(1)')
      window.open('https://example.com/window-request')
      return { valid, invalid }
    })
    expect(externalResults.valid).toEqual({ ok: true })
    expect(externalResults.invalid).toEqual({ ok: false, error: 'INVALID_URL' })

    await expect.poll(() => app.evaluate(() => {
      const releaseGlobal = globalThis as typeof globalThis & { __releaseSecurityOpenedUrls?: string[] }
      return releaseGlobal.__releaseSecurityOpenedUrls ?? []
    })).toEqual([
      'https://example.com/research?q=release',
      'https://example.com/window-request',
    ])
    expect(app.windows()).toHaveLength(1)

    await window.getByTestId('nav-tab-feed').click()
    await expect(window.getByTestId('feed-summary-panel')).toBeVisible()

    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-chart-page')).toBeVisible()

    await window.getByTestId('nav-tab-industry-heatmap').click()
    await window.getByTestId('secondary-nav-industry-heatmap-heatmap').click()
    await expect(window.getByTestId('market-resonance-workbench')).toBeVisible()

    await window.getByTestId('nav-tab-decision-center').click()
    await expect(window.getByTestId('decision-center-page')).toBeVisible()

    const rendererUrl = window.url()
    await window.evaluate(() => {
      const link = document.createElement('a')
      link.href = 'https://example.com/navigation-escape'
      link.target = '_self'
      document.body.append(link)
      link.click()
    })
    await window.waitForTimeout(300)
    expect(window.url()).toBe(rendererUrl)
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
