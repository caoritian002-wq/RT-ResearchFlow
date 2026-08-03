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

function seedBacktestFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const plan = { entryRule: 'nextOpen', holdDays: 3, stopProfit: null, stopLoss: null, feeBps: 13, signalSource: 'shortTerm' }
    const credibility = {
      version: 1,
      assessedAt: Date.now(),
      conclusion: 'exploratory',
      summary: '当前样本可用于观察方向，但尚不足以形成稳定比较。',
      dataQualityFingerprint: 'fixture-quality-fingerprint-20260724',
      gates: [
        { key: 'dataFoundation', title: '数据底座', status: 'degraded', summary: '核心基准覆盖仍需注意', details: ['日线可用，核心基准覆盖仍需补齐。'] },
        { key: 'temporalIntegrity', title: '时间完整性', status: 'reliable', summary: '未发现时间顺序违规', details: ['入场晚于信号日，出场不早于入场日。'] },
        { key: 'executionRealism', title: '成交可执行性', status: 'degraded', summary: '尚未模拟逐笔成交约束', details: ['未模拟涨跌停、停牌、容量和滑点。'] },
        { key: 'sampleAdequacy', title: '样本充分性', status: 'degraded', summary: '有效样本少于30笔', details: ['当前只有1笔有效样本。'] },
        { key: 'stabilityValidation', title: '稳健性验证', status: 'degraded', summary: '尚未完成样本外验证', details: ['当前仅提供前后半区间观察。'] }
      ],
      sample: { totalSignals: 1, validSignals: 1, signalDayCount: 1, missingRate: 0 },
      periodSlices: [
        { label: '前半区间', sampleCount: 1, avgReturn: -19.56, winRate: 0 },
        { label: '后半区间', sampleCount: 0, avgReturn: null, winRate: null }
      ]
    }
    const report = {
      schemaVersion: 4,
      generatedAt: Date.now(),
      trust: {
        status: 'degraded',
        reasons: ['UNADJUSTED_PRICES', 'REALIZED_EQUITY_ONLY'],
        engineVersion: '4.0.0',
        factFingerprint: 'fixture-fingerprint-20260721',
        credibility
      },
      strategyKey: 'shortTerm.*',
      signalSource: 'shortTerm',
      dateRange: { start: '20260621', end: '20260721' },
      plan: { entryRule: 'nextOpen', holdDays: 3, stopProfit: null, stopLoss: null, feeBps: 13 },
      totalSignals: 1,
      validTrades: 1,
      dropRate: 0,
      winRate: 0,
      avgReturn: -19.56,
      medianReturn: -19.56,
      profitFactor: 0.12,
      expectancy: -19.56,
      equityModel: 'equal_weighted_exit_day_compound',
      totalReturn: -19.56,
      equityCurve: [
        { date: '20260717', realizedReturnPct: -19.56, tradeCount: 1, equity: 0.8044, drawdownPct: 19.56 }
      ],
      maxDrawdown: 19.56,
      sharpeLike: 1.42,
      byStrengthDecile: [
        { bucket: 1, minStrength: 88, maxStrength: 88, count: 1, winRate: 0, avgReturn: -19.56, medianReturn: -19.56, profitFactor: 0, expectancy: -19.56 }
      ],
      benchmarkReturn: -6.83,
      excessReturn: -12.73,
      benchmarkNote: null
    }
    const info = db.prepare(
      "INSERT INTO strategy_backtest_runs (strategy_key, date_start, date_end, plan_json, param_hash, report_json, status, error_message, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', NULL, ?, ?)"
    ).run('shortTerm.*', '20260621', '20260721', JSON.stringify(plan), 'e2e-backtest-workbench-fixture', JSON.stringify(report), Date.now(), Date.now())
    const runId = Number(info.lastInsertRowid)
    db.prepare('INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)').run('000001', '平安银行', Date.now())
    db.prepare(
      "INSERT INTO strategy_backtest_trades (run_id, strategy_key, ts_code, signal_date, entry_date, entry_price, exit_date, exit_price, gross_return_pct, net_return_pct, return_pct, exit_reason, status, strength, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(runId, 'shortTerm.*', '000001.SZ', '20260620', '20260621', 10, '20260625', 10.22, 2.2, 2.1, 2.1, 'hold_expired', 'executed', 88, JSON.stringify({ stockName: '平安银行' }))

    const insertAuction = db.prepare(
      "INSERT OR REPLACE INTO stk_auction_backtest_detail (trade_date, ts_code, pool, buy_price, ret_1d, ret_2d, ret_3d, ret_5d, computed_at, is_one_word, idx_ret1d, idx_ret2d, idx_ret3d, idx_ret5d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)"
    )
    insertAuction.run('20260710', '000001.SZ', 'firstBoard', 10, 1, 2, 3, 5, Date.now(), 0.5, 1, 1.5, 2)
    insertAuction.run('20260711', '000002.SZ', 'firstBoard', 20, -1, -2, -3, -5, Date.now(), 0.5, 1, 1.5, 2)
    db.prepare('INSERT OR REPLACE INTO stock_info (stockCode, stockName, fetchedAt) VALUES (?, ?, ?)').run('000002', '万科A', Date.now())

    const now = Date.now()
    const strategyInfo = db.prepare(
      "INSERT INTO strategy_lab_strategies (strategy_key, name, description, source, status, enabled, is_builtin, version, rule_draft_json, run_config_json, actions_json, last_run_at, created_at, updated_at) VALUES ('e2e-alpha', '测试强势策略', '真实命中后的多周期收益样本', 'screener', 'ready', 1, 0, 2, '{}', '{}', '{}', ?, ?, ?)"
    ).run(now, now, now)
    const strategyId = Number(strategyInfo.lastInsertRowid)
    const runInfo = db.prepare(
      "INSERT INTO strategy_lab_runs (strategy_id, strategy_key, strategy_name, source, status, date_start, date_end, run_config_json, summary_json, created_at, started_at, completed_at) VALUES (?, 'e2e-alpha', '测试强势策略', 'screener', 'completed', '20260710', '20260710', ?, '{}', ?, ?, ?)"
    ).run(strategyId, JSON.stringify({ strategyVersion: 2 }), now, now, now)
    const strategyRunId = Number(runInfo.lastInsertRowid)
    db.prepare(
      "INSERT INTO strategy_lab_matches (run_id, strategy_id, strategy_key, source, ts_code, stock_name, trade_date, score, signal_strength, matched_from, evidence_json, action_json, created_at) VALUES (?, ?, 'e2e-alpha', 'screener', '600000.SH', '浦发银行', '20260710', 88, 88, 'screener', '{}', '{}', ?)"
    ).run(strategyRunId, strategyId, now)
    const insertDaily = db.prepare(
      "INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, open, high, low, close, pct_chg, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, 0, 1000, 1)"
    )
    const stockRows = [
      ['20260713', 10, 10.5],
      ['20260714', 10.5, 11],
      ['20260715', 11, 12],
      ['20260716', 12, 11],
      ['20260717', 11, 13]
    ]
    const auctionStockRows = [
      ['20260710', 10, 10.1],
      ['20260711', 10.2, 10.5],
      ['20260714', 10.5, 10.8],
      ['20260715', 10.8, 11],
      ['20260716', 11, 11.2],
      ['20260717', 11.2, 11.4]
    ]
    const indexRows = [
      ['20260713', 100, 101],
      ['20260714', 101, 102],
      ['20260715', 102, 103],
      ['20260716', 103, 104],
      ['20260717', 104, 105]
    ]
    for (const [date, open, close] of stockRows) insertDaily.run('600000.SH', date, open, Math.max(open, close), Math.min(open, close), close)
    for (const [date, open, close] of auctionStockRows) {
      insertDaily.run('000001.SZ', date, open, Math.max(open, close), Math.min(open, close), close)
      insertDaily.run('000002.SZ', date, open * 2, Math.max(open, close) * 2, Math.min(open, close) * 2, close * 2)
    }
    for (const [date, open, close] of indexRows) insertDaily.run('000001.SH', date, open, Math.max(open, close), Math.min(open, close), close)
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

async function enterBacktest(app: ElectronApplication) {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-strategyBacktest').click()
  await expect(window.getByRole('heading', { name: '策略效果评估', exact: true })).toBeVisible()
  return window
}

test('策略评估默认比较真实信号并保留历史报告闭环', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-backtest-workbench-'))
  let app = await launchApp(userDataDir)
  try {
    await app.firstWindow()
    await app.close()
    seedBacktestFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))

    app = await launchApp(userDataDir)
    const window = await enterBacktest(app)
    await window.setViewportSize({ width: 1440, height: 900 })

    await expect(window.getByText('板票竞价双第一', { exact: true }).first()).toBeVisible()
    await expect(window.getByText('测试强势策略', { exact: true }).first()).toBeVisible()
    await expect(window.getByText('收益路径', { exact: true })).toBeVisible()
    await expect(window.getByText('稳定性对照 · 次日收盘', { exact: true })).toBeVisible()
    await expect(window.getByTestId('strategy-effectiveness-credibility')).toBeVisible()
    await expect(window.getByTestId('strategy-effectiveness-credibility')).toContainText('数据底座')
    await expect(window.locator('.strategy-effectiveness-chart .recharts-wrapper')).toHaveCount(2)
    await expect(window.locator('.strategy-effectiveness-chart .recharts-line-curve').first()).toHaveAttribute('d', /[LC]/)
    await expect(window.locator('.strategy-effectiveness-chart .recharts-bar-rectangle').first()).toBeVisible()

    const shortTermNav = window.getByTestId('nav-tab-short-term-strategy')
    await shortTermNav.click()
    const secondaryFlyout = window.getByRole('menu', { name: '短线策略二级导航' })
    await expect(secondaryFlyout).toBeVisible()
    const firstSecondaryItem = window.getByTestId('secondary-nav-short-term-strategy-morningAuction')
    await expect(firstSecondaryItem).toBeVisible()
    const firstItemReceivesPointer = await firstSecondaryItem.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === node || (hit !== null && node.contains(hit))
    })
    expect(firstItemReceivesPointer).toBe(true)
    const shellAndPageLayers = await window.evaluate(() => ({
      shell: Number.parseInt(getComputedStyle(document.querySelector('[data-testid="app-navigation-shell"]')!).zIndex, 10),
      page: Number.parseInt(getComputedStyle(document.querySelector('[data-testid="strategy-effectiveness-scroll"]')!.parentElement!).zIndex || '0', 10) || 0,
    }))
    expect(shellAndPageLayers.shell).toBeGreaterThan(shellAndPageLayers.page)
    const screenshotDir = process.env.STRATEGY_BACKTEST_SCREENSHOT_DIR
    if (screenshotDir) {
      mkdirSync(screenshotDir, { recursive: true })
      await window.screenshot({ path: join(screenshotDir, 'strategy-effectiveness-secondary-nav-layer-1440.png'), fullPage: true })
    }
    await window.keyboard.press('Escape')
    await expect(secondaryFlyout).toBeHidden()
    await expect.poll(() => shortTermNav.evaluate(node => getComputedStyle(node.closest('[data-testid="app-navigation-shell"]')!).zIndex)).toBe('30')

    await window.getByRole('button', { name: '第5日', exact: true }).click()
    await expect(window.getByText('策略排名 · 第5交易日', { exact: true })).toBeVisible()

    const effectivenessStartDate = window.getByTestId('strategy-effectiveness-date-start')
    const effectivenessEndDate = window.getByTestId('strategy-effectiveness-date-end')
    await expect(effectivenessStartDate).toHaveAttribute('inputmode', 'numeric')
    const defaultRangeDays = await window.evaluate(() => {
      const startValue = (document.querySelector('[data-testid="strategy-effectiveness-date-start"]') as HTMLInputElement | null)?.value ?? ''
      const endValue = (document.querySelector('[data-testid="strategy-effectiveness-date-end"]') as HTMLInputElement | null)?.value ?? ''
      const toUtc = (value: string): number => {
        const [year, month, day] = value.split('-').map(Number)
        return Date.UTC(year, month - 1, day)
      }
      return Math.round((toUtc(endValue) - toUtc(startValue)) / 86_400_000)
    })
    expect(defaultRangeDays).toBe(30)
    await window.getByRole('button', { name: '打开策略评估开始日期选择器' }).click()
    await expect(window.getByRole('dialog', { name: '选择策略评估开始日期' })).toBeVisible()
    await window.keyboard.press('Escape')
    await window.getByTestId('strategy-effectiveness-selector').click()
    await expect(window.getByRole('dialog', { name: '选择要比较的策略' })).toBeVisible()
    await expect(window.getByText('真实命中后的多周期收益样本', { exact: true })).toBeVisible()
    await window.keyboard.press('Escape')

    const effectivenessOverflow1440 = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(effectivenessOverflow1440).toBeLessThanOrEqual(1)
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-effectiveness-1440.png'), fullPage: true })
      await window.locator('.strategy-effectiveness-chart').screenshot({ path: join(screenshotDir, 'strategy-effectiveness-charts-1440.png') })
      await window.getByTestId('strategy-effectiveness-scroll').evaluate(element => { element.scrollTop = 0 })
    }

    await window.getByTestId('strategy-effectiveness-selector').click()
    const strategyDialog = window.getByRole('dialog', { name: '选择要比较的策略' })
    await strategyDialog.locator('label').filter({ hasText: '测试强势策略' }).locator('input[type="checkbox"]').uncheck()
    await window.keyboard.press('Escape')
    await effectivenessStartDate.fill('2026-07-20')
    await effectivenessStartDate.press('Enter')
    await window.getByRole('button', { name: '重新评估' }).click()
    const dataGap = window.getByTestId('strategy-effectiveness-data-gap')
    await expect(dataGap).toContainText('板票竞价双第一 2026-07-10 至 2026-07-11')
    await expect(dataGap.getByRole('button', { name: '补齐当前区间' })).toBeVisible()
    if (screenshotDir) await window.screenshot({ path: join(screenshotDir, 'strategy-effectiveness-data-gap-1440.png'), fullPage: true })
    await dataGap.getByRole('button', { name: '查看已有区间结果' }).click()
    await expect(effectivenessStartDate).toHaveValue('2026-07-10')
    await expect(effectivenessEndDate).toHaveValue('2026-07-11')
    await expect(dataGap).toBeHidden()
    await expect(window.getByRole('cell', { name: '2 / 2', exact: true })).toBeVisible()
    await expect(window.locator('.strategy-effectiveness-chart .recharts-line-curve').first()).toHaveAttribute('d', /[LC]/)
    if (screenshotDir) await window.screenshot({ path: join(screenshotDir, 'strategy-effectiveness-single-strategy-1440.png'), fullPage: true })

    await window.setViewportSize({ width: 1024, height: 768 })
    const effectivenessOverflow1024 = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(effectivenessOverflow1024).toBeLessThanOrEqual(1)
    await expect(window.getByRole('button', { name: '重新评估' })).toBeVisible()
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await expect(window.getByTestId('strategy-effectiveness-selector')).toHaveCSS('background-color', 'rgb(2, 6, 23)')
    if (screenshotDir) await window.screenshot({ path: join(screenshotDir, 'strategy-effectiveness-dark-1024.png'), fullPage: true })
    await window.evaluate(() => document.documentElement.classList.remove('dark'))
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await expect(window.getByTestId('strategy-effectiveness-selector').locator('svg')).toHaveCSS('transition-property', 'none')
    if (screenshotDir) await window.screenshot({ path: join(screenshotDir, 'strategy-effectiveness-reduced-motion-1024.png'), fullPage: true })
    await window.emulateMedia({ reducedMotion: 'no-preference' })

    await window.getByRole('tab', { name: '历史报告' }).click()
    await expect(window.getByRole('heading', { name: '策略回测', exact: true })).toBeVisible()
    await window.setViewportSize({ width: 1440, height: 900 })

    const startDate = window.getByTestId('strategy-backtest-date-start')
    await expect(startDate).toHaveAttribute('inputmode', 'numeric')
    await expect(startDate).toHaveValue('2026-06-21')
    await window.getByRole('button', { name: '打开回测开始日期选择器' }).click()
    await expect(window.getByRole('dialog', { name: '选择回测开始日期' })).toBeVisible()
    await window.keyboard.press('Escape')

    await expect(window.getByText('短线模块全部信号', { exact: true }).first()).toBeVisible()
    await expect(window.getByText('累计实现收益', { exact: true }).first()).toBeVisible()
    const chart = window.getByTestId('backtest-equity-chart')
    await expect(chart).toBeVisible()
    await expect(chart.locator('svg')).toBeVisible()
    await expect(window.getByTestId('backtest-equity-single-day-note')).toContainText('1 笔交易集中在 07/17 出场')
    await expect(chart.locator('.recharts-area-curve')).toHaveAttribute('d', /L/)
    await expect(window.getByTestId('strategy-backtest-report').getByText('平安银行', { exact: true })).toBeVisible()
    await expect(window.getByTestId('strategy-backtest-credibility')).toBeVisible()
    await expect(window.getByTestId('strategy-backtest-credibility')).toContainText('数据底座')
    await expect(window.getByText('shortTerm.*', { exact: true })).toHaveCount(0)
    const fixtureStrengthSummary = window.getByTestId('strategy-backtest-uniform-strength')
    await expect(fixtureStrengthSummary).toContainText('没有可区分的原始评分')
    const fixtureSamples = fixtureStrengthSummary.getByRole('button', { name: '查看同一强度的 1 笔样本' })
    await fixtureSamples.hover()
    await expect(window.getByRole('tooltip')).toContainText('平安银行（000001） · 06/20')
    if (screenshotDir) await window.screenshot({ path: join(screenshotDir, 'strategy-backtest-uniform-strength-tooltip-1440.png'), fullPage: true })

    await window.getByTestId('strategy-backtest-strategy-trigger').click()
    await window.getByRole('option', { name: '板票竞价双第一', exact: true }).click()
    await startDate.fill('2026-07-10')
    await startDate.press('Enter')
    const endDate = window.getByTestId('strategy-backtest-date-end')
    await endDate.fill('2026-07-11')
    await endDate.press('Enter')
    await window.getByLabel('持有交易日').fill('1')
    await window.getByRole('button', { name: '运行回测' }).click()
    await expect(window.getByRole('status')).toContainText('回测完成')
    const auctionReport = window.getByTestId('strategy-backtest-report')
    await expect(auctionReport.getByText('板票竞价双第一', { exact: true })).toBeVisible()
    await expect(auctionReport.getByText('2 / 2', { exact: true })).toBeVisible()
    await expect(auctionReport.getByText('万科A', { exact: true })).toBeVisible()
    await expect(auctionReport.getByTestId('backtest-equity-chart').locator('.recharts-area-curve')).toHaveAttribute('d', /L/)
    const auctionStrengthSummary = auctionReport.getByTestId('strategy-backtest-uniform-strength')
    await expect(auctionStrengthSummary).toContainText('均为 1.00')
    const auctionSamples = auctionStrengthSummary.getByRole('button', { name: '查看同一强度的 2 笔样本' })
    await auctionSamples.hover()
    await expect(window.getByRole('tooltip')).toContainText('平安银行（000001） · 07/10')
    await expect(window.getByRole('tooltip')).toContainText('万科A（000002） · 07/11')
    if (screenshotDir) await window.screenshot({ path: join(screenshotDir, 'strategy-backtest-auction-samples-tooltip-1440.png'), fullPage: true })

    await window.getByTestId('strategy-backtest-strategy-trigger').click()
    await window.getByRole('option', { name: '短线模块全部信号', exact: true }).click()
    await expect(window.getByTestId('strategy-backtest-date-start')).toHaveValue('2026-06-21')
    await expect(window.getByTestId('strategy-backtest-report').getByText('平安银行', { exact: true })).toBeVisible()

    const overflow1440 = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow1440).toBeLessThanOrEqual(1)
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-backtest-1440.png'), fullPage: true })
    }

    await window.setViewportSize({ width: 1024, height: 768 })
    const overflow1024 = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow1024).toBeLessThanOrEqual(1)
    await expect(window.getByRole('button', { name: '运行回测' })).toBeVisible()
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-backtest-1024.png'), fullPage: true })
    }
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await expect(window.getByTestId('strategy-backtest-signal-source-trigger')).toHaveCSS('background-color', 'rgb(2, 6, 23)')
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-backtest-dark-1024.png'), fullPage: true })
    }
    await window.evaluate(() => document.documentElement.classList.remove('dark'))

    const deleteButton = window.getByTestId('strategy-backtest-delete-1')
    await expect(deleteButton).toBeVisible()
    await deleteButton.click()
    const deleteDialog = window.getByRole('dialog', { name: '删除回测记录' })
    await expect(deleteDialog).toBeVisible()
    await expect(deleteDialog.getByText('短线模块全部信号', { exact: true })).toBeVisible()
    await expect(deleteDialog.getByText('#1', { exact: true })).toBeVisible()
    const cancelDeleteButton = deleteDialog.getByRole('button', { name: '取消' })
    await expect(cancelDeleteButton).toBeEnabled()
    await expect(cancelDeleteButton).toBeFocused()
    if (screenshotDir) {
      await window.screenshot({ path: join(screenshotDir, 'strategy-backtest-delete-dialog-1024.png'), fullPage: true })
      await window.evaluate(() => document.documentElement.classList.add('dark'))
      await expect(deleteDialog).toHaveCSS('background-color', 'rgb(15, 23, 42)')
      await window.screenshot({ path: join(screenshotDir, 'strategy-backtest-delete-dialog-dark-1024.png'), fullPage: true })
      await window.evaluate(() => document.documentElement.classList.remove('dark'))
    }

    await cancelDeleteButton.click()
    await expect(deleteDialog).toBeHidden()
    await expect(deleteButton).toBeVisible()

    await deleteButton.click()
    await expect(deleteDialog).toBeVisible()
    await deleteDialog.getByRole('button', { name: '删除记录' }).click()
    await expect(window.getByTestId('strategy-backtest-history-empty')).toBeVisible()
    await expect(window.getByTestId('strategy-backtest-report-empty')).toBeVisible()
    await expect(window.getByText('已删除回测记录 #1', { exact: true })).toBeVisible()
  } finally {
    await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
