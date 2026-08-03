import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('FR-259 phase 267 narrow channel and scheduling contracts', () => {
  it('schedules the notification after the 09:28 confirmation with a five-minute startup convergence window', () => {
    const scheduler = source('electron/main/services/schedulerService.ts')
    const cutoffPolicy = source('electron/main/services/premarketCutoffPolicy.ts')
    expect(scheduler).toContain('PREMARKET_NOTIFICATION_HOUR_BJ = 9')
    expect(scheduler).toContain('PREMARKET_NOTIFICATION_MINUTE_BJ = 29')
    expect(scheduler).toContain('PREMARKET_NOTIFICATION_GRACE_MS = 5 * 60 * 1000')
    expect(scheduler).toContain('schedulePremarketNotification929()')
    expect(scheduler).toContain('reconcilePremarketNotificationForToday()')
    expect(scheduler).toContain('PREMARKET_AUCTION_CONFIRM_MINUTE_BJ')
    expect(cutoffPolicy).toContain('PREMARKET_AUCTION_CONFIRM_MINUTE_BJ = 28')
    expect(cutoffPolicy).toContain('PREMARKET_AUCTION_EVIDENCE_DEADLINE_MINUTE_BJ = 30')
  })

  it('runs validation inside the single 18:00 coordinator after market daily work', () => {
    const scheduler = source('electron/main/services/schedulerService.ts')
    const coordinator = scheduler.slice(
      scheduler.indexOf('export function runUnifiedAfterCloseSyncJob'),
      scheduler.indexOf('function scheduleAfterCloseDailySync'),
    )
    expect(coordinator).toContain("runTrackedAfterCloseTask(tradeDate, 'premarket_validation'")
    expect(coordinator.indexOf("'premarket_validation'")).toBeGreaterThan(coordinator.indexOf("'market_daily'"))
    expect(source('electron/main/database/afterCloseSyncRepository.ts')).toContain("| 'premarket_validation'")
  })

  it('exposes no-input current/retry actions, UUID-bound revision reads and explanations, and fixed events', () => {
    const handlers = source('electron/main/ipc/premarketHandlers.ts')
    const preload = source('electron/preload/index.ts')
    const notification = source('electron/main/services/premarketNotificationService.ts')
    expect(handlers).toContain("ipcMain.handle('premarket:getScenario', () =>")
    expect(handlers).toContain("ipcMain.handle('premarket:getScenarioRevision', (_event, data: { versionId?: string })")
    expect(handlers).toContain("ipcMain.handle('premarket:retryScenario', (event) =>")
    expect(handlers).toContain("ipcMain.handle('premarket:explainScenario', (_event, data: { versionId?: string } | undefined)")
    expect(handlers).toContain("event.sender.send('premarket:retryProgress', progress)")
    expect(preload).toContain("ipcRenderer.invoke('premarket:getScenario')")
    expect(preload).toContain("ipcRenderer.invoke('premarket:getScenarioRevision', { versionId })")
    expect(preload).toContain("ipcRenderer.invoke('premarket:retryScenario')")
    expect(preload).not.toContain("ipcRenderer.invoke('premarket:retryScenario',")
    expect(preload).toContain("ipcRenderer.invoke('premarket:explainScenario', { versionId })")
    expect(preload).toContain("ipcRenderer.on('premarket:retryProgress', handler)")
    expect(preload).toContain("ipcRenderer.on('premarket:openScenario', handler)")
    expect(notification).toContain("win.webContents.send('premarket:openScenario')")
    expect(notification).not.toContain("win.webContents.send('premarket:openScenario',")
  })

  it('keeps the visible entry in Today dashboard and exposes three accessible drawer views', () => {
    const decision = source('src/components/DecisionCenter/DecisionCenter.tsx')
    const drawer = source('src/components/DecisionCenter/PremarketScenarioDrawer.tsx')
    expect(decision).toContain('data-testid="decision-open-premarket-scenario"')
    expect(decision).toContain('盘前推演')
    expect(decision.indexOf('data-testid="decision-open-premarket-scenario"')).toBeLessThan(
      decision.indexOf('data-testid="decision-command-footer"'),
    )
    expect(drawer).toContain('role="tablist"')
    expect(drawer).toContain("['scenario', '盘前推演']")
    expect(drawer).toContain("'盘后验证'")
    expect(drawer).toContain("['calibration', '历史校准']")
    expect(drawer).toContain('生成AI解释')
    expect(drawer).toContain('h-11')
    expect(drawer).toContain("COMPACT_DRAWER_ACTION_CLASS = 'inline-flex h-8 min-w-[68px]")
    expect(drawer).toContain('data-testid="premarket-scenario-retry"')
    expect(drawer).toContain('data-testid="premarket-scenario-reload"')
    expect(drawer).toContain('data-testid="premarket-retry-feedback"')
    expect(drawer).toContain('data-testid="premarket-revision-history"')
    expect(drawer).toContain('data-testid={`premarket-revision-${item.revision}`}')
    expect(drawer).toContain('事实边界')
    expect(drawer).toContain('09:25定稿 · 采集 {formatTime(holding.auction.fetchedAt)}')
    expect(drawer).toContain('每次补采都追加新修订')
    expect(drawer).toContain('data-testid="premarket-open-capture-settings"')
    expect(drawer).not.toContain('className="h-10 shrink-0 rounded-md border border-amber-300')
    expect(drawer).toContain('data-testid="premarket-scenario-branches"')
    expect(drawer).toContain('data-testid="premarket-evidence-diagnosis"')
    expect(drawer).toContain("repeat(auto-fit, minmax(min(100%, 22rem), 1fr))")
    expect(source('src/components/shared/RightDrawer.tsx')).toContain('data-testid={`${testId}-body`}')
  })

  it('uses the fixed 1680x960 window contract instead of synthetic 1440 or 1024 acceptance viewports', () => {
    const main = source('electron/main/index.ts')
    const journey = source('tests/e2e/premarket-scenario-drawer.spec.ts')
    expect(main).toContain('width: 1680')
    expect(main).toContain('height: 960')
    expect(main).toContain("mainWindow.on('will-resize'")
    expect(main).toContain('event.preventDefault()')
    expect(main).toContain('maximizable: true')
    expect(journey).not.toContain('setViewportSize')
    expect(journey).not.toContain('1440')
    expect(journey).not.toContain('1024')
  })
})
