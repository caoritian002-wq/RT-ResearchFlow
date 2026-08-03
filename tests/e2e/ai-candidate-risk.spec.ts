import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

async function launchApp(userDataDir: string) {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

function seedJourney(dbPath: string): { emptySessionId: number; riskSessionId: number } {
  const electronExecutable = require('electron') as string
  const output = execFileSync(electronExecutable, ['-e', String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const insertSession = db.prepare(
      'INSERT INTO ai_analysis_sessions (createdAt, provider, model, articleUrls, promptSent, response, scanRunId, briefingId, isError, messages) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL)'
    )
    const empty = insertSession.run(
      now - 1000,
      'chatgpt',
      'e2e-empty-model',
      JSON.stringify(['https://example.com/empty']),
      'e2e empty prompt',
      '行业新闻与A股映射仍待补充。\nSTOCK_CODES: NONE'
    ).lastInsertRowid
    const riskResponse = [
      '监管变化可能增加银行合规成本，影响仍需公司公告验证。',
      'STOCK_CODES: NONE',
      '',
      '## A股标的映射补充',
      '',
      '浦发银行可能面临合规成本上升，属于直接证据线索。',
      'STOCK_CODES: 600000|浦发银行'
    ].join('\n')
    const risk = insertSession.run(
      now,
      'chatgpt',
      'gpt-5.6-sol',
      JSON.stringify(['https://example.com/risk']),
      'e2e risk prompt',
      riskResponse
    ).lastInsertRowid
    db.prepare('UPDATE ai_analysis_sessions SET responseRound2 = ? WHERE id = ?').run(
      '## 行情数据边界\n\n- **当前时间：**2026年7月21日16:54\n- **行情截止：**2026年7月17日收盘\n\n## 个股走势与支撑压力参考\n\n### 浦发银行（600000）\n\n近期行情已完成复核。\n\n- 支撑观察参考：模型纯文本支撑 9.99\n- 压力观察参考：模型纯文本压力 12.88\n\n## 风险与反证\n\n政策执行口径仍待确认。',
      risk
    )
    const insertDaily = db.prepare(
      'INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    let barIndex = 0
    for (let cursor = Date.UTC(2026, 5, 8); cursor <= Date.UTC(2026, 6, 17); cursor += 86400000) {
      const day = new Date(cursor).getUTCDay()
      if (day === 0 || day === 6) continue
      const close = 10 + barIndex * 0.08 + Math.sin(barIndex / 3) * 0.12
      const previous = barIndex === 0 ? close : 10 + (barIndex - 1) * 0.08 + Math.sin((barIndex - 1) / 3) * 0.12
      const tradeDate = new Date(cursor).toISOString().slice(0, 10).replace(/-/g, '')
      insertDaily.run('600000.SH', tradeDate, close, (close / previous - 1) * 100, close - 0.05, close + 0.18, close - 0.2, 1000000 + barIndex * 12000, 1.2)
      barIndex += 1
    }
    const candidate = [{
      code: '600000', name: '浦发银行', direction: 'negative', evidenceLevel: 'direct',
      reason: '监管变化可能增加合规成本', confidence: 0.82,
      evidence: ['文章明确描述成本上升'], riskNotes: ['实际影响仍需公告验证']
    }]
    db.prepare(
      'INSERT INTO ai_analysis_structured_results (session_id, schema_version, status, summary, confidence, primary_theme, themes_json, candidate_stocks_json, risk_factors_json, verification_items_json, source_refs_json, raw_json, error_message, generated_at, updated_at) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)'
    ).run(
      risk, 'completed', '监管变化可能对持仓银行构成成本压力。', 0.82, '银行监管', '[]', JSON.stringify(candidate),
      JSON.stringify(['政策执行口径仍待确认']), JSON.stringify([{ title: '核验公司公告', status: 'todo', reason: '确认业务影响' }]),
      JSON.stringify([{ type: 'article', title: '监管新闻', excerpt: '合规成本可能上升' }]), now, now
    )
    db.prepare('INSERT OR REPLACE INTO portfolio_stocks (ts_code, stock_name, added_at, cost_price) VALUES (?, ?, ?, ?)')
      .run('600000.SH', '浦发银行', now, 10.5)
    db.prepare(
      'INSERT INTO decision_signals (source_module, strategy_key, ts_code, stock_name, signal_type, direction, priority, score, confidence, title, summary, reason_json, source_ref_json, status, dedup_key, signal_time, expire_at, created_at, updated_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'ai', 'news_portfolio_negative', '600000.SH', '浦发银行', 'RISK', 'BEARISH', 5, 82, 82,
      '新闻研判可能利空持仓，需复核', '监管变化可能增加合规成本。证据等级：直接证据。',
      JSON.stringify({ isPortfolio: true, aiSessionId: Number(risk), evidenceLevel: 'direct' }),
      JSON.stringify({ isPortfolio: true, aiSessionId: Number(risk), articleUrls: ['https://example.com/risk'] }),
      'NEW', 'ai:news_portfolio_negative:' + risk + ':600000', now, now + 86400000, now, now, now, now
    )
    db.close()
    process.stdout.write(JSON.stringify({ emptySessionId: Number(empty), riskSessionId: Number(risk) }))
  `], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
  }).toString()
  return JSON.parse(output) as { emptySessionId: number; riskSessionId: number }
}

test.describe('FR-240 A股候选恢复与持仓风险', () => {
  test('无候选可恢复，利空持仓可识别并进入今日看板', async () => {
    test.setTimeout(120000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-fr240-'))
    const screenshotDir = process.env.FR240_SCREENSHOT_DIR
    let app = await launchApp(userDataDir)
    try {
      let window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15000 })
      await app.close()

      const ids = seedJourney(join(`${userDataDir}-dev`, 'trade-watch.db'))
      app = await launchApp(userDataDir)
      window = await app.firstWindow()
      await window.waitForLoadState('domcontentloaded')
      const coldStartGuide = window.locator('[data-testid="cold-start-guide"]')
      if (await coldStartGuide.isVisible()) await coldStartGuide.getByLabel('关闭引导').click()
      await window.locator('[data-testid="nav-tab-ai-analysis"]').click()
      await window.locator('[data-testid="secondary-nav-ai-analysis-records"]').click()
      await expect(window.locator('[data-testid="ai-analysis-page"]')).toBeVisible({ timeout: 15000 })

      await window.locator(`[data-testid="ai-session-${ids.emptySessionId}"]`).click()
      await expect(window.locator('[data-testid="ai-candidate-recovery-state"]')).toContainText('尚未映射到A股公司')
      await expect(window.getByRole('button', { name: '重新映射A股标的' }).first()).toBeVisible()
      await window.setViewportSize({ width: 1024, height: 768 })
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true })
        await window.screenshot({ path: join(screenshotDir, 'ai-candidate-empty-1024x768.png') })
      }

      await window.locator(`[data-testid="ai-session-${ids.riskSessionId}"]`).click()
      await expect(window.locator(`[data-testid="ai-session-${ids.riskSessionId}"]`)).toContainText('已复核')
      await expect(window.getByRole('heading', { name: '第二轮真实行情复核' })).toBeVisible()
      await expect(window.locator('[data-testid="ai-portfolio-risk-alert"]')).toContainText('可能利空的持仓公司')
      await expect(window.locator('[data-testid="ai-candidate-600000"]')).toContainText('利空风险')
      await expect(window.locator('[data-testid="ai-candidate-600000"]')).toContainText('直接证据')
      await expect(window.locator('[data-testid="ai-candidate-600000"]')).toContainText('我的持仓')
      await expect(window.getByText(/STOCK_CODES:/)).toHaveCount(0)
      await expect(window.getByRole('button', { name: '重新用近期行情复核' }).first()).toBeVisible()
      await expect(window.getByTestId('ai-round2-market-visuals')).toHaveCount(0)
      const round2Report = window.getByTestId('ai-round2-report-body')
      await expect(round2Report.locator('strong').filter({ hasText: '当前时间：' })).toBeVisible()
      await expect(round2Report.locator('strong').filter({ hasText: '行情截止：' })).toBeVisible()
      await expect(round2Report).not.toContainText('**当前时间：**')
      await expect(round2Report.getByText(/模型纯文本支撑/)).toHaveCount(0)
      await expect(round2Report.getByText(/模型纯文本压力/)).toHaveCount(0)
      const inlineVisual = round2Report.getByTestId('ai-round2-inline-600000')
      await expect(inlineVisual).toBeVisible()
      const marketCard = inlineVisual.getByTestId('ai-round2-visual-600000')
      await expect(marketCard).toContainText('趋势')
      await expect(marketCard).toContainText('支撑观察')
      await expect(marketCard).toContainText('压力观察')
      expect(await marketCard.locator('canvas').count()).toBeGreaterThan(0)
      const chartBounds = await marketCard.getByTestId('ai-round2-kline-canvas').boundingBox()
      expect(chartBounds?.width ?? 0).toBeGreaterThan(240)
      expect(chartBounds?.height ?? 0).toBeGreaterThan(150)
      const round2Bounds = await window.locator('[data-testid="ai-analysis-page"]').evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))
      expect(round2Bounds.scrollWidth).toBeLessThanOrEqual(round2Bounds.clientWidth + 1)
      await window.evaluate(() => document.documentElement.classList.add('dark'))
      await expect(marketCard).toHaveCSS('background-color', 'rgb(15, 23, 42)')
      if (screenshotDir) {
        await window.screenshot({ path: join(screenshotDir, 'ai-round2-dark-1024x768.png') })
      }
      await window.evaluate(() => document.documentElement.classList.remove('dark'))
      if (screenshotDir) {
        await window.setViewportSize({ width: 1024, height: 768 })
        mkdirSync(screenshotDir, { recursive: true })
        await window.screenshot({ path: join(screenshotDir, 'ai-round2-rerun-1024x768.png') })
      }
      await window.getByRole('button', { name: '本次研判', exact: true }).click()

      for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
        await window.setViewportSize(viewport)
        if (viewport.width === 1024) {
          await expect(window.locator('[data-testid="ai-compact-candidate-600000"]')).toContainText('利空风险')
          await expect(window.locator('[data-testid="ai-compact-candidate-600000"]')).toContainText('我的持仓')
        }
        const bounds = await window.locator('[data-testid="ai-analysis-page"]').evaluate((element) => ({
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        }))
        expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth + 1)
        if (screenshotDir) {
          mkdirSync(screenshotDir, { recursive: true })
          await window.screenshot({ path: join(screenshotDir, `ai-candidate-risk-${viewport.width}x${viewport.height}.png`) })
        }
      }

      await window.locator('[data-testid="nav-tab-decision-center"]').click()
      await expect(window.getByText('新闻研判可能利空持仓，需复核').first()).toBeVisible({ timeout: 15000 })
      await expect(window.getByText('P5').first()).toBeVisible()
    } finally {
      await app.close().catch(() => {})
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
    }
  })
})
