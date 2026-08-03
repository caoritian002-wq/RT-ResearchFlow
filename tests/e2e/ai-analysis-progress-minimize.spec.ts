import { expect, test, _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function sendProgress(
  app: Awaited<ReturnType<typeof electron.launch>>,
  payload: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, data) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ai:analyzeProgress', data)
  }, payload)
}

test('AI分析全局进度可最小化且不因进度更新自动展开', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-ai-progress-minimize-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible()
    const guide = window.getByTestId('cold-start-guide')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
    await window.setViewportSize({ width: 1440, height: 900 })

    await sendProgress(app, {
      step: 'fetching',
      current: 2,
      total: 5,
    })

    const panel = window.getByTestId('ai-analysis-progress-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAttribute('data-state', 'expanded')
    const minimize = window.getByTestId('ai-analysis-progress-minimize')
    expect((await minimize.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect((await minimize.boundingBox())?.width).toBeGreaterThanOrEqual(44)
    const expandedHeight = (await panel.boundingBox())?.height ?? 0

    await minimize.click()
    await expect(panel).toHaveAttribute('data-state', 'minimized')
    await expect(panel).toContainText('获取文章内容 2/5')
    const minimizedHeight = (await panel.boundingBox())?.height ?? 0
    expect(minimizedHeight).toBeLessThanOrEqual(64)
    expect(minimizedHeight).toBeLessThan(expandedHeight)

    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-chart-page')).toBeVisible()
    await expect(panel).toHaveAttribute('data-state', 'minimized')

    await sendProgress(app, {
      step: 'callingRound2',
      usages: {
        round1: {
          provider: 'chatgpt',
          model: 'gpt-5.6-sol',
          inputTokens: 4200,
          outputTokens: 1800,
          totalTokens: 6000,
          maxTokens: 4096,
          finishReason: 'stop',
        },
      },
    })
    await expect(panel).toHaveAttribute('data-state', 'minimized')
    await expect(panel).toContainText('等待第二轮 AI 返回')

    const expand = window.getByTestId('ai-analysis-progress-expand')
    expect((await expand.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    expect((await expand.boundingBox())?.width).toBeGreaterThanOrEqual(44)
    await expand.click()
    await expect(panel).toHaveAttribute('data-state', 'expanded')
    await expect(panel).toContainText('第一轮用量')

    await minimize.click()
    await sendProgress(app, { step: 'done' })
    await expect(panel).toContainText('AI 分析完成')
    await expect(panel).toBeHidden({ timeout: 5_000 })

    await sendProgress(app, { step: 'callingRound1' })
    await expect(panel).toHaveAttribute('data-state', 'expanded')
    await expect(window.getByTestId('ai-analysis-progress-minimize')).toBeVisible()

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await window.getByTestId('ai-analysis-progress-minimize').click()
    await expect(panel).toHaveAttribute('data-state', 'minimized')
    expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    const screenshotDir = process.env.AI_PROGRESS_SCREENSHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      await window.screenshot({ path: join(screenshotDir, 'ai-progress-minimized-1024x768-dark.png') })
    }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
