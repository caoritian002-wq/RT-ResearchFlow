import { expect, test, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

type TestElectronApp = Awaited<ReturnType<typeof electron.launch>>

async function seedSectorFlowHistory(app: TestElectronApp): Promise<void> {
  await app.evaluate(async ({ app }, fixture) => {
    const mainModule = process.mainModule
    if (!mainModule) throw new Error('E2E_MAIN_MODULE_UNAVAILABLE')
    const { join } = mainModule.require('node:path') as typeof import('node:path')
    const { createRequire } = mainModule.require('node:module') as typeof import('node:module')
    const appRequire = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = appRequire('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'trade-watch.db'))
    const insert = db.prepare(`
      INSERT OR REPLACE INTO sector_flow_observations (
        trade_date, provider, scope, board_code, board_name, metric_kind,
        total_amount, main_net_inflow, main_net_inflow_rate, weighted_change,
        member_count, up_count, down_count, flat_count,
        source_updated_at, captured_at
      ) VALUES (
        @tradeDate, 'eastmoney', @scope, @boardCode, @boardName, 'verified_flow',
        10000000000, @mainNetInflow, @mainNetInflowRate, @weightedChange,
        100, @upCount, @downCount, 10,
        @capturedAt, @capturedAt
      )
    `)
    db.transaction(() => {
      fixture.dates.forEach((date, dateIndex) => {
        fixture.boards.forEach((board, boardIndex) => {
          const positive = boardIndex < 2
          const mainNetInflow = (positive ? 1 : -1) * (300_000_000 + dateIndex * 10_000_000 + boardIndex)
          insert.run({
            tradeDate: date.tradeDate,
            scope: board.scope,
            boardCode: board.boardCode,
            boardName: `${date.label}${board.name}`,
            mainNetInflow,
            mainNetInflowRate: mainNetInflow / 10_000_000_000 * 100,
            weightedChange: positive ? 2.5 : -2.1,
            upCount: positive ? 70 : 20,
            downCount: positive ? 20 : 70,
            capturedAt: date.capturedAt,
          })
        })
      })
    })()
    db.close()
  }, {
    dates: [
      { tradeDate: '20260807', label: '八月七日', capturedAt: Date.parse('2026-08-07T15:05:00+08:00') },
      { tradeDate: '20260810', label: '八月十日', capturedAt: Date.parse('2026-08-10T15:05:00+08:00') },
      { tradeDate: '20260811', label: '八月十一日', capturedAt: Date.parse('2026-08-11T15:05:00+08:00') },
    ],
    boards: [
      { scope: 'concept', boardCode: 'BK9101', name: '算力概念' },
      { scope: 'industry', boardCode: 'BK9102', name: '电子行业' },
      { scope: 'concept', boardCode: 'BK9103', name: '风险概念' },
      { scope: 'industry', boardCode: 'BK9104', name: '风险行业' },
    ],
  })
}

async function openSectorFlow(window: Page): Promise<void> {
  const guide = window.locator('[data-testid="cold-start-guide"]')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
  await window.locator('[data-testid="nav-tab-industry-heatmap"]').click()
  await window.locator('[data-testid="secondary-nav-industry-heatmap-sectorFlow"]').click()
  await expect(window.locator('[data-testid="sector-flow-workbench"]')).toBeVisible()
  await expect(window.locator('[data-testid="sector-flow-date-navigation"]')).toBeVisible({ timeout: 90_000 })
}

test('板块资金按真实存档日期回看并保持同日隔离', async () => {
  test.setTimeout(180_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-sector-flow-history-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await seedSectorFlowHistory(app)
    await openSectorFlow(window)

    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize() ?? [])).toEqual([1680, 960])
    const datePicker = window.locator('[data-testid="sector-flow-date-picker"]')
    const latestTradeDate = await datePicker.inputValue()
    if (latestTradeDate !== '2026-08-11') {
      await datePicker.fill('2026-08-11')
      await datePicker.press('Enter')
      await expect(datePicker).toHaveValue('2026-08-11')
    }

    await window.getByRole('button', { name: '板块资金前一交易日' }).click()
    await expect(datePicker).toHaveValue('2026-08-10')
    await expect(window.getByText('真实资金 · 历史复盘', { exact: true })).toBeVisible()
    await expect(window.getByRole('heading', { name: '板块资金与次日竞价', exact: true })).toBeVisible()
    await expect(window.getByRole('heading', { name: '次日竞价观察', exact: true })).toBeVisible()
    await expect(window.getByText('八月十日算力概念', { exact: true }).first()).toBeVisible()
    await expect(window.getByText('八月十一日算力概念', { exact: true })).toHaveCount(0)
    await expect(window.getByRole('button', { name: '重新读取', exact: true })).toBeEnabled()
    await expect(window.getByRole('button', { name: '回到最新', exact: true })).toBeVisible()

    await datePicker.fill('2026-08-09')
    await datePicker.press('Enter')
    await expect(window.getByText('该交易日没有已核验的本地板块资金存档，请选择其他交易日。', { exact: true })).toBeVisible()
    await expect(datePicker).toHaveValue('2026-08-10')
    await expect(window.getByText('八月十日算力概念', { exact: true }).first()).toBeVisible()

    await window.getByRole('button', { name: '板块资金前一交易日' }).click()
    await expect(datePicker).toHaveValue('2026-08-07')
    await expect(window.getByRole('button', { name: '板块资金前一交易日' })).toBeDisabled()
    await window.getByRole('button', { name: '板块资金后一交易日' }).click()
    await expect(datePicker).toHaveValue('2026-08-10')

    await window.getByLabel('最大化窗口').click()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMaximized() ?? false)).toBe(true)
    const geometry = await window.locator('[data-testid="sector-flow-workbench"]').evaluate((node) => ({
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workbenchOverflow: node.scrollWidth - node.clientWidth,
      actionHeights: Array.from(node.querySelectorAll('[data-testid="sector-flow-date-navigation"] > button'))
        .map((button) => button.getBoundingClientRect().height),
      dateControlHeight: node.querySelector('[data-testid="sector-flow-date-picker"]')
        ?.parentElement?.getBoundingClientRect().height ?? 0,
    }))
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1)
    expect(geometry.workbenchOverflow).toBeLessThanOrEqual(1)
    expect(geometry.actionHeights.every((height) => height >= 44)).toBe(true)
    expect(geometry.dateControlHeight).toBeGreaterThanOrEqual(44)
    await window.screenshot({ path: 'test-results/sector-flow-history-maximized.png' })

    await window.getByRole('button', { name: '回到最新', exact: true }).click()
    await expect(datePicker).toHaveValue(latestTradeDate)
    await expect(window.getByText('真实资金 · 历史复盘', { exact: true })).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
