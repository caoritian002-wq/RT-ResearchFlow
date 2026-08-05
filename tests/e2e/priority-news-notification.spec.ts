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

function seedPriorityBriefing(dbPath: string): number {
  const electronExecutable = require('electron') as string
  const output = execFileSync(electronExecutable, ['-e', String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const bjDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(now))
    const sourceId = Number(db.prepare(
      "INSERT INTO sources (nameCN, nameEN, url, feedUrl, category, authorityWeight, isBuiltIn, isEnabled, status, successRate, parseStrategy) VALUES (?, ?, ?, ?, 'CUSTOM', 5, 0, 1, 'ACTIVE', 1, 'RSS')"
    ).run('FR-260验收来源', 'FR-260 Source', 'https://example.com', 'https://example.com/feed.xml').lastInsertRowid)
    const briefingId = Number(db.prepare(
      'INSERT INTO briefings (sourceId, sourceName, originalUrl, title, summary, fullContent, publishedAt, publishedDateBJ, publicationTimeStatus, collectedAt, impactRating, impactRatingScore, deduplicationHash, titleSimhash, isRead, readAt, scanRunId, isCatchUp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, 0)'
    ).run(
      sourceId,
      'FR-260验收来源',
      'https://example.com/fr260-priority-news',
      '高优先级资讯点击后打开对应原文',
      '这是用于验证全局资讯提醒深链的本地摘要。',
      '<p>这是用于验证全局资讯提醒深链的本地正文。</p>',
      now,
      bjDate,
      'exact',
      now,
      'CRITICAL',
      95,
      'fr260-priority-news',
      'fr260',
    ).lastInsertRowid)
    db.prepare('UPDATE app_settings SET autoAiAnalysisPrompt = 1, decision_notify_in_app_enabled = 1, decision_notify_min_priority = 3 WHERE id = 1').run()
    db.close()
    process.stdout.write(String(briefingId))
  `], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
  }).toString()
  return Number(output)
}

async function sendRendererEvent(
  app: ElectronApplication,
  channel: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(event.channel, event.payload)
  }, { channel, payload })
}

test('高优先级资讯提醒在任意模块出现并打开对应文章', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-priority-news-'))
  const screenshotDir = process.env.FR260_SCREENSHOT_DIR
  let app = await launchApp(userDataDir)

  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible({ timeout: 15_000 })
    await app.close()

    const briefingId = seedPriorityBriefing(join(`${userDataDir}-dev`, 'trade-watch.db'))
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByTestId('nav-tab-feed')).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize() ?? [])).toEqual([1680, 960])

    const guide = window.getByTestId('cold-start-guide')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-chart-page')).toBeVisible()

    await sendRendererEvent(app, 'scan:aiAnalysisAvailable', {
      scanRunId: null,
      articles: [{
        id: briefingId,
        title: '高优先级资讯点击后打开对应原文',
        originalUrl: 'https://example.com/fr260-priority-news',
        impactRating: 'CRITICAL',
        publishedAt: Date.now(),
        isExpired: false,
      }],
    })
    await sendRendererEvent(app, 'decision:signalCreated', {
      id: 260,
      sourceModule: 'news',
      strategyKey: 'news.critical',
      signalType: 'INFO',
      direction: 'NEUTRAL',
      priority: 4,
      score: 95,
      confidence: 70,
      title: '高优先级资讯点击后打开对应原文',
      summary: '这是用于验证全局资讯提醒深链的本地摘要。',
      reasonJson: null,
      sourceRefJson: JSON.stringify({ briefingId, sourceName: 'FR-260验收来源' }),
      status: 'NEW',
      dedupKey: `news:critical:${briefingId}`,
      signalTime: Date.now(),
      expireAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      occurrenceCount: 1,
      acknowledgedAt: null,
      watchedAt: null,
      dismissedAt: null,
      resolvedAt: null,
      resolution: null,
      resolutionNote: null,
    })

    const aiDialog = window.getByRole('heading', { name: 'AI 分析确认' })
    const toast = window.getByTestId('decision-signal-toast')
    await expect(aiDialog).toBeVisible()
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('FR-260验收来源')
    await expect(toast).toContainText('查看资讯原文')
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      await window.screenshot({ path: join(screenshotDir, 'priority-news-toast-1680x960.png') })
    }

    await toast.getByRole('button', { name: /查看资讯原文/ }).click()
    await window.getByRole('button', { name: '取消' }).click()
    const detail = window.getByTestId('briefing-detail')
    await expect(detail).toContainText('高优先级资讯点击后打开对应原文')
    await expect(detail).toContainText('FR-260验收来源')
    await expect(window.getByTestId('nav-tab-feed')).toHaveClass(/is-active/)
    await expect(window.getByTestId('ai-analysis-progress-panel')).toHaveCount(0)
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'priority-news-detail-1680x960.png') })
    }

    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await sendRendererEvent(app, 'decision:signalCreated', {
      id: 261,
      sourceModule: 'news',
      priority: 4,
      title: '暗色模式高优先级资讯提醒',
      summary: '保持1680×960并验证减少动态效果。',
      sourceRefJson: JSON.stringify({ briefingId, sourceName: 'FR-260验收来源' }),
      signalTime: Date.now(),
    })
    await expect(toast).toBeVisible()
    const closeButton = toast.getByRole('button', { name: '关闭主动提醒' })
    const closeBox = await closeButton.boundingBox()
    expect(closeBox?.width).toBeGreaterThanOrEqual(44)
    expect(closeBox?.height).toBeGreaterThanOrEqual(44)
    expect(await window.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true)
    expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'priority-news-toast-dark-reduced-1680x960.png') })
    }
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
