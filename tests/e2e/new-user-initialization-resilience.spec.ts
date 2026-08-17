import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

test('新用户快速初始化不被 Tushare 受限和全市场日线阻塞', async () => {
  test.setTimeout(90_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-new-user-resilience-'))
  const app = await launchApp(userDataDir)
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect(window.getByText('RT-ResearchFlow')).toBeVisible({ timeout: 15_000 })

    await app.evaluate(({ ipcMain }) => {
      const fixture = globalThis as typeof globalThis & { __newUserInitializationActions?: string[] }
      fixture.__newUserInitializationActions = []
      const now = Date.now()
      const item = (
        key: string,
        title: string,
        status: 'ok' | 'warning',
        recordCount?: number,
      ) => ({ key, title, status, message: status === 'ok' ? '已配置' : '暂无本地数据', recordCount, checkedAt: now })
      const snapshot = {
        status: 'warning' as const,
        checkedAt: now,
        summary: { ok: 1, warning: 5, error: 0 },
        groups: [
          {
            key: 'config' as const,
            title: '配置',
            items: [
              item('config.tushare', 'Tushare 数据源', 'ok'),
              item('config.ai', 'AI 模型', 'warning'),
            ],
          },
          {
            key: 'freshness' as const,
            title: '数据新鲜度',
            items: [
              item('freshness.stockBasic', '股票基础数据', 'warning', 0),
              item('freshness.dailyClose', '全市场历史日线', 'warning', 0),
              item('freshness.kplConcept', '题材成分', 'warning', 0),
              item('freshness.decisionSignals', '今日看板信号', 'warning', 0),
            ],
          },
        ],
      }

      ipcMain.removeHandler('diagnostics:getHealth')
      ipcMain.handle('diagnostics:getHealth', () => ({ ok: true as const, data: snapshot }))
      ipcMain.removeHandler('diagnostics:runCheck')
      ipcMain.handle('diagnostics:runCheck', (_event, payload?: { action?: string }) => {
        const action = payload?.action ?? ''
        fixture.__newUserInitializationActions?.push(action)
        if (action === 'syncHistoricalDaily') {
          return {
            ok: false as const,
            error: 'TUSHARE_RATE_LIMITED',
            message: 'Tushare 触发访问频率限制。任务已停止，不会继续重复请求；已完成日期已保留，请稍后重试。',
          }
        }
        if (action === 'syncStockBasic' || action === 'syncConceptMembers') {
          return {
            ok: false as const,
            error: 'TUSHARE_QUOTA_INSUFFICIENT',
            message: 'Tushare 权限或积分不足。该任务可稍后重试。',
          }
        }
        return {
          ok: true as const,
          data: { action, status: 'completed' as const, message: `${action} 已完成` },
        }
      })
    })

    await window.evaluate(() => localStorage.removeItem('trade-watch:onboarding:v1:dismissed'))
    await window.reload()
    await window.waitForLoadState('domcontentloaded')

    const guide = window.getByTestId('cold-start-guide')
    await expect(guide).toBeVisible({ timeout: 15_000 })
    await guide.getByTestId('start-initialization-flow-btn').click()

    await expect(guide).toContainText('基础入口已开放，3 项数据增强任务待处理。', { timeout: 15_000 })
    const historicalTask = guide.getByTestId('initialization-task-sync-historical-daily')
    await expect(historicalTask).toContainText('稍后同步')
    await expect(historicalTask).toContainText('完整两年全市场日线属于增强能力')

    const quickStartActions = await app.evaluate(() => {
      const fixture = globalThis as typeof globalThis & { __newUserInitializationActions?: string[] }
      return [...(fixture.__newUserInitializationActions ?? [])]
    })
    expect(quickStartActions).toEqual([
      'refreshHealth',
      'syncStockBasic',
      'backfillDecisionSignals',
      'refreshHealth',
    ])

    await historicalTask.getByRole('button', { name: '立即同步' }).click()
    await expect(historicalTask).toContainText('Tushare 触发访问频率限制', { timeout: 5_000 })
    await expect(historicalTask).toContainText('可重试')

    const actionsAfterRetry = await app.evaluate(() => {
      const fixture = globalThis as typeof globalThis & { __newUserInitializationActions?: string[] }
      return [...(fixture.__newUserInitializationActions ?? [])]
    })
    expect(actionsAfterRetry.filter(action => action === 'syncHistoricalDaily')).toHaveLength(1)

    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize())
    expect(size).toEqual([1680, 960])
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
