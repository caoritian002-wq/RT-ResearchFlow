import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
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

function bjYmd(date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
}

function previousDay(ymd: string): string {
  const date = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))))
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10).replace(/-/g, '')
}

function seedDecisionFixture(dbPath: string, today: string, displayDate: string): void {
  const electronExecutable = require('electron') as string
  const script = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.TRADE_WATCH_SEED_DB)
    const today = process.env.TRADE_WATCH_TODAY
    const displayDate = process.env.TRADE_WATCH_DISPLAY_DATE
    const signalTime = Date.parse(displayDate.slice(0, 4) + '-' + displayDate.slice(4, 6) + '-' + displayDate.slice(6, 8) + 'T10:00:00+08:00')
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 0, ?)').run(today, displayDate)
    db.prepare('INSERT OR REPLACE INTO trade_cal (cal_date, is_open, pretrade_date) VALUES (?, 1, NULL)').run(displayDate)
    db.prepare(
      'INSERT INTO decision_signals (source_module, strategy_key, ts_code, stock_name, concept_code, concept_name, signal_type, direction, priority, score, confidence, title, summary, reason_json, source_ref_json, status, dedup_key, signal_time, expire_at, created_at, updated_at, first_seen_at, last_seen_at, occurrence_count) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'trend', 'trend.breakHigh20', '600487.SH', '亨通光电', 'OPPORTUNITY', 'BULLISH', 3, 82, 74,
      '亨通光电突破近期高点', '最近交易日保留的趋势信号', '{}', '{}', 'NEW', 'e2e:decision:previous-day',
      signalTime, signalTime + 7 * 24 * 60 * 60 * 1000, signalTime, signalTime, signalTime, signalTime, 1
    )
    db.close()
  `
  execFileSync(electronExecutable, ['-e', script], {
    cwd: join(__dirname, '../..'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TRADE_WATCH_SEED_DB: dbPath,
      TRADE_WATCH_TODAY: today,
      TRADE_WATCH_DISPLAY_DATE: displayDate,
    },
    stdio: 'pipe',
  })
}

test('休市日展示最近交易日并保留精确历史回看', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-decision-date-'))
  const today = bjYmd()
  const displayDate = previousDay(today)
  const displayDateText = `${displayDate.slice(0, 4)}-${displayDate.slice(4, 6)}-${displayDate.slice(6, 8)}`
  let app = await launchApp(userDataDir)
  try {
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await app.close()

    seedDecisionFixture(join(`${userDataDir}-dev`, 'trade-watch.db'), today, displayDate)
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const guide = window.getByTestId('cold-start-guide')
    if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
    await window.getByTestId('nav-tab-decision-center').click()
    await window.getByTestId('decision-view-mode-market').click()

    await expect(window.getByTestId('decision-signal-date-context')).toContainText(`当前展示最近交易日 ${displayDateText}`)
    await expect(window.getByText('亨通光电突破近期高点').first()).toBeVisible()
    await window.getByRole('button', { name: /历史回看/ }).first().click()
    await expect(window.getByTestId('decision-history-trade-date')).toHaveValue(displayDateText)
    await expect(window.getByTestId('decision-history-review')).toContainText('最近交易日保留的趋势信号')
  } finally {
    await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
