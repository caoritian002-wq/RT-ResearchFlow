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

function seedFixture(dbPath: string): { sourceA: number; sourceB: number } {
  const electronExecutable = require('electron') as string
  const output = execFileSync(electronExecutable, ['-e', String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const bjDate = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const sourceInsert = db.prepare(
      "INSERT INTO sources (nameCN, nameEN, url, feedUrl, category, authorityWeight, isBuiltIn, isEnabled, status, successRate, parseStrategy) VALUES (?, ?, ?, ?, 'CUSTOM', 8, 0, 1, 'ACTIVE', 1, 'RSS')"
    )
    const sourceA = Number(sourceInsert.run('来源筛选甲', 'Source Filter A', 'https://source-a.example.com', 'https://source-a.example.com/feed').lastInsertRowid)
    const sourceB = Number(sourceInsert.run('来源筛选乙', 'Source Filter B', 'https://source-b.example.com', 'https://source-b.example.com/feed').lastInsertRowid)
    const briefingInsert = db.prepare(
      'INSERT INTO briefings (sourceId, sourceName, originalUrl, title, summary, fullContent, publishedAt, publishedDateBJ, publicationTimeStatus, collectedAt, impactRating, impactRatingScore, deduplicationHash, titleSimhash, isRead, readAt, scanRunId, isCatchUp) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)'
    )
    briefingInsert.run(sourceA, '来源筛选甲', 'https://source-a.example.com/a1', '甲来源重大文章', '用于验证来源甲的第一篇文章', now - 1000, bjDate, 'exact', now, 'CRITICAL', 95, 'source-filter-a1', 'a1', 0)
    briefingInsert.run(sourceA, '来源筛选甲', 'https://source-a.example.com/a2', '甲来源普通文章', '用于验证来源甲的第二篇文章', now - 2000, bjDate, 'exact', now, 'GENERAL', 20, 'source-filter-a2', 'a2', 1)
    briefingInsert.run(sourceA, '来源筛选甲', 'https://source-a.example.com/a3', '甲来源待校时文章', '用于验证发布时间待校时的文章', now - 2500, bjDate, 'collected_fallback', now, 'GENERAL', 20, 'source-filter-a3', 'a3', 0)
    briefingInsert.run(sourceB, '来源筛选乙', 'https://source-b.example.com/b1', '乙来源重要文章', '用于验证来源乙的文章', now - 3000, bjDate, 'exact', now, 'IMPORTANT', 80, 'source-filter-b1', 'b1', 0)
    db.prepare('INSERT OR REPLACE INTO daily_archive (date, totalCount, unreadCount, criticalCount, uncertainTimeCount, updatedAt) VALUES (?, 3, 2, 1, 1, ?)').run(bjDate, now)
    db.close()
    process.stdout.write(JSON.stringify({ sourceA, sourceB }))
  `], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
    },
    stdio: 'pipe',
  }).toString()
  return JSON.parse(output) as { sourceA: number; sourceB: number }
}

test('来源分组筛选文章并同步右侧详情', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-news-source-filter-'))
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible()
    await app.close()

    const ids = seedFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1440, height: 900 })
    const guide = window.getByTestId('cold-start-guide')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
    await window.getByTestId('nav-tab-feed').click()

    const sourceA = window.getByTestId(`briefing-source-filter-${ids.sourceA}`)
    const sourceB = window.getByTestId(`briefing-source-filter-${ids.sourceB}`)
    const allSources = window.getByTestId('briefing-source-filter-all')
    const feedList = window.getByTestId('briefing-feed-list')
    await expect(sourceA).toBeVisible()
    await expect(sourceB).toBeVisible()
    expect((await sourceA.boundingBox())?.height).toBeGreaterThanOrEqual(44)

    await sourceA.focus()
    await window.keyboard.press('Enter')
    await expect(sourceA).toHaveAttribute('aria-pressed', 'true')
    await expect(sourceB).toBeVisible()
    await expect(window.getByTestId('briefing-feed-active-source')).toContainText('来源筛选甲')
    await expect(window.getByTestId('briefing-feed-total')).toHaveText('共 3 条')
    await expect(feedList.getByText('甲来源重大文章', { exact: true })).toBeVisible()
    await expect(feedList.getByText('甲来源普通文章', { exact: true })).toBeVisible()
    await expect(feedList.getByText('乙来源重要文章', { exact: true })).toHaveCount(0)
    await expect(window.getByTestId('briefing-detail').getByText('甲来源重大文章', { exact: true })).toBeVisible()

    await window.getByTestId('briefing-side-tab-archive').click()
    await expect(window.getByTestId('briefing-feed-active-source')).toHaveCount(0)
    await expect(window.getByTestId('briefing-feed-time-scope')).toHaveText('发布时间已确认')
    await expect(window.getByTestId('archive-time-scope-confirmed')).toHaveAttribute('aria-pressed', 'true')
    const screenshotDir = process.env.NEWS_SOURCE_SCREENSHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      await window.screenshot({ path: join(screenshotDir, 'news-time-archive-confirmed-light-1440x900.png') })
    }
    await window.getByTestId('archive-time-scope-uncertain').click()
    await expect(window.getByTestId('briefing-feed-time-scope')).toHaveText('发布时间待校时')
    await expect(window.getByTestId('briefing-feed-total')).toHaveText('共 1 条')
    await expect(feedList.getByText('甲来源待校时文章', { exact: true })).toBeVisible()
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'news-time-archive-uncertain-light-1440x900.png') })
    }
    await window.getByTestId('briefing-side-tab-sources').click()
    await expect(window.getByTestId('briefing-feed-time-scope')).toHaveCount(0)
    await sourceA.click()
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'news-source-filter-light-1440x900.png') })
    }

    await sourceB.click()
    await expect(sourceB).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByTestId('briefing-feed-total')).toHaveText('共 1 条')
    await expect(feedList.getByText('乙来源重要文章', { exact: true })).toBeVisible()
    await expect(feedList.getByText('甲来源重大文章', { exact: true })).toHaveCount(0)
    await expect(window.getByTestId('briefing-detail').getByText('乙来源重要文章', { exact: true })).toBeVisible()

    await window.getByTestId('briefing-feed-active-source').click()
    await expect(allSources).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByTestId('briefing-feed-active-source')).toHaveCount(0)
    await expect(window.getByTestId('briefing-feed-total')).toHaveText('共 4 条')
    await expect(feedList.getByText('甲来源重大文章', { exact: true })).toBeVisible()
    await expect(feedList.getByText('乙来源重要文章', { exact: true })).toBeVisible()

    await window.evaluate(() => window.api.settings.setTheme('dark'))
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(() => window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    await window.getByTestId('nav-tab-feed').click()
    await expect(sourceA).toBeVisible()
    await sourceA.click()
    await expect(sourceA).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByTestId('briefing-feed-active-source')).toContainText('来源筛选甲')
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'news-source-filter-dark-1440x900.png') })
    }
    await window.setViewportSize({ width: 1024, height: 768 })
    await expect(sourceA).toBeVisible()
    const pageWidth = await window.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }))
    expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.client)
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
