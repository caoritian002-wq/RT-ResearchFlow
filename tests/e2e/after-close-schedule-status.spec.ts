import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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

async function closeGuide(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
}

function seedAfterCloseRun(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const script = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const today = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
    const tasks = {
      short_term_daily: { status: 'completed', startedAt: now - 5000, completedAt: now - 4000, message: null },
      market_daily: { status: 'failed', startedAt: now - 4000, completedAt: now - 3000, message: 'MARKET_DAILY_INCOMPLETE' },
      chip_structure: { status: 'partial', startedAt: now - 3000, completedAt: now - 2000, message: '成功 1，部分 1，失败 0' },
      sector_snapshot: { status: 'completed', startedAt: now - 2000, completedAt: now - 1000, message: null },
      trend_scores: { status: 'completed', startedAt: now - 1000, completedAt: now, message: null },
    }
    db.prepare(
      "INSERT OR REPLACE INTO after_close_sync_runs (trade_date, trigger, status, started_at, completed_at, updated_at, attempt_count, tasks_json, error_summary) VALUES (?, 'scheduled', 'partial', ?, ?, ?, 1, ?, ?)"
    ).run(
      today,
      now - 5000,
      now,
      now,
      JSON.stringify(tasks),
      'market_daily:MARKET_DAILY_INCOMPLETE; chip_structure:成功 1，部分 1，失败 0；这是用于验证长错误摘要在紧凑状态带内截断且不会撑破页面布局的附加说明',
    )
    db.close()
  `
  execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
    },
    stdio: 'pipe',
  })
}

test('筹码工作台展示18点统一盘后状态且双视口无溢出', async () => {
  test.setTimeout(60_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-after-close-'))
  const screenshotDir = join(process.cwd(), 'test-results', 'after-close-schedule-status')
  mkdirSync(screenshotDir, { recursive: true })
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()

    seedAfterCloseRun(join(`${userDataDir}-dev`, 'trade-watch.db'))
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)

    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByTestId('nav-tab-short-term-strategy').click()
    await window.getByTestId('secondary-nav-short-term-strategy-chipMonitor').click()

    const status = window.getByTestId('after-close-schedule-status')
    await expect(status).toContainText('统一盘后同步 · 18:00')
    await expect(status).toContainText('调度已注册')
    await expect(status).toContainText('上次')
    await expect(status).toContainText('部分完成')
    await expect(status).toContainText('下次')
    await expect(status.locator('[title*="MARKET_DAILY_INCOMPLETE"]')).toBeVisible()
    expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'light-1440x900.png') })

    const schedule = await window.evaluate(() => window.api.chipStructure.getSyncStatus())
    expect(schedule.schedule).toMatchObject({ scheduledTime: '18:00', active: true })
    expect(schedule.schedule.nextRunAt).toBeGreaterThan(Date.now())
    expect(schedule.schedule.lastRun).toMatchObject({ status: 'partial', attemptCount: 1 })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await expect.poll(() => window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await window.screenshot({ path: join(screenshotDir, 'dark-1024x768.png') })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
