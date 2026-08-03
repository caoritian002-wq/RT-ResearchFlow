import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
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

function seedClosingFixture(dbPath: string): void {
  const electronExecutable = require('electron') as string
  const seedScript = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const now = Date.now()
    const tradeDate = '20260724'
    db.exec('DELETE FROM short_term_signals; DELETE FROM daily_close_cache; DELETE FROM stock_basic_cache;')

    const dimension = (key, label, score, maxScore, status, value, detail) => ({ key, label, score, maxScore, status, value, detail })
    const stock = (code, name, tier, title, tailReturnPct, score) => ({
      tsCode: code,
      stockCode: code.slice(0, 6),
      stockName: name,
      open: 10,
      previousClose: 9.8,
      closeFinal: 10 + tailReturnPct / 10,
      pctChg: 4.2,
      amountYuan: 680000000,
      judgment: {
        tier,
        title,
        summary: tier === 'active' ? '尾盘价格、收盘位置和成交参与形成一致增强。' : '尾盘存在方向线索，但成交参与仍需次日确认。',
        totalScore: score,
        confidence: 86,
        completeness: 100,
        dataStatus: 'complete',
        missingFields: [],
        metrics: {
          baseline1430: 10,
          latestPrice: 10 + tailReturnPct / 10,
          latestTime: '14:59',
          tailReturnPct,
          tailHighPct: tailReturnPct + 0.3,
          tailLowPct: -0.1,
          lateReturnPct: 0.6,
          closePositionPct: tier === 'active' ? 88 : 62,
          maxDrawdownPct: tier === 'active' ? 0.35 : 0.85,
          pathEfficiencyPct: tier === 'active' ? 72 : 44,
          tailVolumeSharePct: 18.4,
          tailVolumePace: tier === 'active' ? 1.48 : 0.82,
          pointCount: 30
        },
        dimensions: [
          dimension('direction', '尾盘方向', 30, 30, 'strong', '+' + tailReturnPct.toFixed(2) + '%', '14:30后价格明显主动抬升'),
          dimension('closePosition', '收盘位置', tier === 'active' ? 20 : 15, 20, 'strong', '区间高位', '价格守住尾盘区间上半部'),
          dimension('participation', '成交参与', tier === 'active' ? 20 : 10, 20, tier === 'active' ? 'strong' : 'neutral', '1.48倍时段均值', '尾盘成交参与可见'),
          dimension('stability', '路径稳定性', 13, 15, 'strong', '回撤0.35%', '回撤受控且路径方向明确'),
          dimension('keyLevel', '关键价位', 15, 15, 'strong', '开盘价上方', '收盘价守住当前可用关键价位')
        ],
        evidence: ['尾盘方向：14:30后价格明显主动抬升', '收盘位置：价格守住尾盘区间上半部'],
        risks: tier === 'active' ? ['次日竞价仍需确认，不能把尾盘增强直接等同延续'] : ['成交参与尚未形成强确认'],
        confirmations: ['次日竞价不明显低开，且开盘后守住尾盘高点'],
        invalidations: ['次日跌破尾盘低点且成交放大'],
        legacyForms: ['mildPullAboveBaseline']
      }
    })
    const stocks = [
      stock('000001.SZ', '尾盘主动', 'active', '主动增强', 2.4, 91),
      stock('600002.SH', '等待确认', 'confirm', '等待次日确认', 0.8, 66)
    ]
    const workbench = {
      stance: 'selective',
      title: '尾盘分化，按个股确认',
      summary: '主动增强1只，等待确认1只，撤退风险1只；次日只跟踪确认条件，不把尾盘脉冲直接当作延续。',
      activeCount: 1,
      confirmCount: 1,
      retreatCount: 1,
      insufficientCount: 0,
      analyzedCount: 3,
      completeness: 94,
      dataStatus: 'partial',
      missingFields: [],
      strategyVersion: '2.0.0'
    }
    const signalInsert = db.prepare('INSERT INTO short_term_signals (strategy, ts_code, name, trigger_at, trade_date, signal_strength, signal_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const basicInsert = db.prepare('INSERT OR REPLACE INTO stock_basic_cache (ts_code, name, industry, market, list_status, circ_float, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const dailyInsert = db.prepare('INSERT OR REPLACE INTO daily_close_cache (ts_code, trade_date, close, pct_chg, open, high, low, vol, turnover_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    db.transaction(() => {
      stocks.forEach((item, stockIndex) => {
        const meta = JSON.stringify({ schemaVersion: '2.0.0', generatedAt: now - 3600000, dataMode: 'eod', candidateSource: 'localMinuteCache', stock: item, workbench })
        signalInsert.run('shortTerm.closingHalfHour', item.tsCode, item.stockName, now - 3600000, tradeDate, item.judgment.totalScore, meta, now - 3600000)
        basicInsert.run(item.tsCode, item.stockName, '电子', item.tsCode.endsWith('.SH') ? '主板' : '深市', 'L', 100000, now)
        for (let index = 0; index < 90; index += 1) {
          const date = new Date(Date.UTC(2026, 3, 1 + index))
          const ymd = String(date.getUTCFullYear()) + String(date.getUTCMonth() + 1).padStart(2, '0') + String(date.getUTCDate()).padStart(2, '0')
          const close = 8.5 + stockIndex + index * 0.025 + Math.sin(index / 7) * 0.15
          dailyInsert.run(item.tsCode, ymd, close, 0.4, close - 0.08, close + 0.18, close - 0.16, 500000 + index * 3000, 1.4)
        }
      })
    })()
    db.close()
  `
  execFileSync(electronExecutable, ['-e', seedScript], {
    cwd: join(__dirname, '../..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRADE_WATCH_SEED_DB: dbPath },
    stdio: 'pipe',
  })
}

async function closeGuide(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
}

async function openClosingWorkbench(window: Page): Promise<void> {
  await window.getByTestId('nav-tab-short-term-strategy').click()
  await window.getByTestId('secondary-nav-short-term-strategy-closingHalfHour').click()
  await expect(window.getByTestId('closing-half-hour-workbench')).toBeVisible({ timeout: 30_000 })
  await expect(window.getByTestId('closing-half-hour-row-000001')).toBeVisible({ timeout: 30_000 })
}

test('尾盘行为工作台恢复最近事实、形成研判并接通个股复核与历史表现', async () => {
  test.setTimeout(150_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-closing-workbench-'))
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()
    seedClosingFixture(join(`${userDataDir}-dev`, 'trade-watch.db'))

    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await openClosingWorkbench(window)

    await expect(window.getByTestId('closing-half-hour-conclusion')).toContainText('尾盘分化')
    await expect(window.getByTestId('closing-half-hour-conclusion')).toContainText('撤退风险1只')
    await expect(window.locator('[data-testid^="closing-half-hour-row-"]')).toHaveCount(2)
    await expect(window.getByTestId('closing-half-hour-detail')).toContainText('次日继续确认')
    await expect(window.getByTestId('closing-half-hour-detail')).toContainText('明确失效')

    await window.getByTestId('closing-tier-filter-trigger').click()
    await window.getByRole('option', { name: '主动增强', exact: true }).click()
    await expect(window.locator('[data-testid^="closing-half-hour-row-"]')).toHaveCount(1)
    await window.getByRole('button', { name: '重置', exact: true }).click()

    await window.getByTestId('closing-half-hour-row-000001').dblclick()
    const drawer = window.getByTestId('stock-kline-chip-drawer')
    await expect(drawer).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId('stock-kline-chip-drawer-scrim')).toBeVisible()
    await drawer.getByLabel('关闭抽屉').click()

    await window.getByTestId('closing-half-hour-history').click()
    await expect(window.getByTestId('strategy-backtest-view-history')).toHaveAttribute('aria-selected', 'true')
    await expect(window.getByTestId('strategy-backtest-strategy')).toHaveValue('shortTerm.closingHalfHour')

    await openClosingWorkbench(window)
    for (const control of [
      window.getByTestId('closing-half-hour-refresh'),
      window.getByTestId('closing-half-hour-history'),
      window.getByTestId('closing-tier-filter-trigger'),
      window.getByTestId('closing-half-hour-open-stock-drawer'),
    ]) {
      const box = await control.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    await window.screenshot({ path: 'test-results/closing-half-hour-workbench-1440x900.png' })

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    await openClosingWorkbench(window)
    const overflow = await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/closing-half-hour-workbench-1024x768-dark.png' })
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
