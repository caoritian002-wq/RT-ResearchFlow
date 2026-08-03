import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function seedFixture(dbPath: string): { sessionId: number; sourceId: number } {
  const electronExecutable = require('electron') as string
  const output = execFileSync(electronExecutable, ['-e', String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const sessionId = Number(db.prepare(
      'INSERT INTO ai_analysis_sessions (createdAt, provider, model, articleUrls, promptSent, response, scanRunId, briefingId, isError, messages) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL)'
    ).run(now, 'chatgpt', 'gpt-5.6-sol', '[]', '弹窗回归测试', '测试分析记录').lastInsertRowid)
    const sourceId = Number(db.prepare(
      "INSERT INTO sources (nameCN, nameEN, url, feedUrl, category, authorityWeight, isBuiltIn, isEnabled, status, successRate, parseStrategy) VALUES (?, ?, ?, ?, 'CUSTOM', 5, 0, 1, 'ACTIVE', 1, 'RSS')"
    ).run('弹窗回归监控源', 'Dialog Regression Source', 'https://example.com', 'https://example.com/feed.xml').lastInsertRowid)
    db.close()
    process.stdout.write(JSON.stringify({ sessionId, sourceId }))
  `], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
  }).toString()
  return JSON.parse(output) as { sessionId: number; sourceId: number }
}

test.describe('项目内确认与反馈', () => {
  test('AI记录和监控源删除不再打开原生弹窗', async () => {
    test.setTimeout(120000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-dialogs-'))
    const screenshotDir = process.env.APP_DIALOG_SCREENSHOT_DIR
    let app = await launchApp(userDataDir)
    try {
      let window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      await app.close()

      const fixture = seedFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await window.setViewportSize({ width: 1024, height: 768 })
      let nativeDialogCount = 0
      window.on('dialog', (dialog) => {
        nativeDialogCount += 1
        void dialog.dismiss()
      })
      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()

      await window.locator('[data-testid="nav-tab-ai-analysis"]').click()
      await window.locator('[data-testid="secondary-nav-ai-analysis-records"]').click()
      const session = window.locator(`[data-testid="ai-session-${fixture.sessionId}"]`)
      await expect(session).toBeVisible({ timeout: 15000 })
      const deleteSessionButton = window.getByRole('button', { name: `删除记录 ${fixture.sessionId}` })
      await deleteSessionButton.click()
      const aiDialog = window.getByTestId('ai-analysis-delete-dialog')
      await expect(aiDialog).toBeVisible()
      await expect(aiDialog).toContainText('删除分析记录')
      await expect(aiDialog.getByRole('button', { name: '取消' })).toBeFocused()
      expect(await window.locator('#root').evaluate((element) => (element as HTMLElement).inert)).toBe(true)
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true })
        await window.screenshot({ path: join(screenshotDir, 'ai-delete-dialog-light-1024x768.png') })
      }
      await window.keyboard.press('Escape')
      await expect(aiDialog).toBeHidden()
      await expect(deleteSessionButton).toBeFocused()

      await deleteSessionButton.click()
      await aiDialog.getByRole('button', { name: '确认删除' }).click()
      await expect(window.getByTestId('app-global-toast')).toContainText('分析记录已删除')
      await expect(session).toHaveCount(0)
      await expect(window.getByTestId('ai-analysis-page')).toBeVisible()
      await expect(aiDialog).toBeHidden()

      await window.setViewportSize({ width: 1440, height: 900 })
      await window.getByTestId('open-config-drawer-btn').click()
      await window.getByTestId('config-tab-sources').click()
      const source = window.getByTestId(`source-row-${fixture.sourceId}`)
      await expect(source).toContainText('弹窗回归监控源')
      await source.getByRole('button', { name: '删除监控源 弹窗回归监控源' }).click()
      const sourceDialog = window.getByTestId('source-delete-dialog')
      await expect(sourceDialog).toContainText('https://example.com')
      await expect(sourceDialog.getByRole('button', { name: '取消' })).toBeFocused()
      await window.evaluate(() => document.documentElement.classList.add('dark'))
      await window.emulateMedia({ reducedMotion: 'reduce' })
      if (screenshotDir) await window.screenshot({ path: join(screenshotDir, 'source-delete-dialog-dark-reduced-1440x900.png') })
      await sourceDialog.getByRole('button', { name: '删除来源' }).click()
      await expect(source).toHaveCount(0)
      await expect(window.getByTestId('app-global-toast')).toContainText('监控源“弹窗回归监控源”已删除')
      expect(nativeDialogCount).toBe(0)
    } finally {
      await app.close().catch(() => undefined)
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })
})
