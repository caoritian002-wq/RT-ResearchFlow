import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const scheduler = readFileSync(
  new URL('../../electron/main/services/schedulerService.ts', import.meta.url),
  'utf8',
)
const handlers = readFileSync(
  new URL('../../electron/main/ipc/premarketHandlers.ts', import.meta.url),
  'utf8',
)
const preload = readFileSync(
  new URL('../../electron/preload/index.ts', import.meta.url),
  'utf8',
)
const settingsView = readFileSync(
  new URL('../../src/components/Settings/PremarketCaptureSettings.tsx', import.meta.url),
  'utf8',
)
const scenarioView = readFileSync(
  new URL('../../src/components/DecisionCenter/PremarketScenarioDrawer.tsx', import.meta.url),
  'utf8',
)
const decisionCenter = readFileSync(
  new URL('../../src/components/DecisionCenter/DecisionCenter.tsx', import.meta.url),
  'utf8',
)

describe('盘前外部事实采集产品契约', () => {
  it('只增加07:30/08:45两个专用计时器且启停不重排其他调度', () => {
    expect(scheduler).toContain('_premarketOvernightTimer')
    expect(scheduler).toContain('_premarketAsiaOpenTimer')
    expect(scheduler).toContain('reconfigurePremarketCaptures')
    const start = scheduler.indexOf('export async function reconfigurePremarketCaptures')
    const end = scheduler.indexOf('\nexport function getPremarketCaptureScheduleStatus', start)
    const body = scheduler.slice(start, end)
    expect(body).not.toContain('stopScheduler()')
    expect(body).not.toContain('scheduleMorningAuctionTimers')
    expect(body).not.toContain('scheduleAfterCloseDailySync')
  })

  it('renderer采集面保持三个入口，情景与准备面只开放无输入窄入口', () => {
    expect(handlers).toContain("ipcMain.handle('premarket:getStatus'")
    expect(handlers).toContain("ipcMain.handle('premarket:setEnabled'")
    expect(handlers).toContain("ipcMain.handle('premarket:captureCurrent'")
    expect(preload).toContain('setEnabled: (enabled: boolean)')
    expect(preload).toContain("ipcRenderer.invoke('premarket:captureCurrent')")
    expect(preload).not.toContain("premarket:captureCurrent', ")
    expect(handlers).toContain("ipcMain.handle('premarket:getScenario', () =>")
    expect(preload).toContain("ipcRenderer.invoke('premarket:getScenario')")
    expect(preload).not.toContain("premarket:getScenario', ")
    expect(handlers).toContain("ipcMain.handle('premarket:getScenarioRevision'")
    expect(preload).toContain("ipcRenderer.invoke('premarket:getScenarioRevision', { versionId })")
    expect(handlers).toContain("ipcMain.handle('premarket:retryScenario', (event) =>")
    expect(preload).toContain("ipcRenderer.invoke('premarket:retryScenario')")
    expect(preload).not.toContain("ipcRenderer.invoke('premarket:retryScenario',")
    expect(preload).toContain("ipcRenderer.on('premarket:retryProgress', handler)")
    expect(handlers).toContain("ipcMain.handle('premarket:getPreparation', () =>")
    expect(handlers).toContain("ipcMain.handle('premarket:refreshPreparation', () =>")
    expect(preload).toContain("ipcRenderer.invoke('premarket:getPreparation')")
    expect(preload).toContain("ipcRenderer.invoke('premarket:refreshPreparation')")
    expect(preload).not.toContain("premarket:getPreparation', ")
    expect(preload).not.toContain("premarket:refreshPreparation', ")
  })

  it('设置页使用标准开关、44px补采按钮和双阶段状态而不生成情景', () => {
    expect(settingsView).toContain('role="switch"')
    expect(settingsView).toContain('aria-checked=')
    expect(settingsView).toContain('h-11')
    expect(settingsView).toContain('补采当前窗口')
    expect(settingsView).toContain('隔夜外部事实')
    expect(settingsView).toContain('亚洲开盘确认')
    expect(settingsView).not.toContain('目标价')
    expect(settingsView).not.toContain('买入')
  })

  it('今日看板使用独立紧凑入口且抽屉解释证据缺口，不出现交易动作或精确概率', () => {
    expect(decisionCenter).toContain('decision-open-premarket-scenario')
    const entryStart = decisionCenter.indexOf('data-testid="decision-open-premarket-scenario"')
    const entryEnd = decisionCenter.indexOf('</button>', entryStart)
    const entryMarkup = decisionCenter.slice(entryStart, entryEnd)
    const footerStart = decisionCenter.indexOf('data-testid="decision-command-footer"')
    const footerEnd = decisionCenter.indexOf('</div>', footerStart)
    expect(entryMarkup).toContain('h-8')
    expect(entryMarkup).toContain('rounded-full')
    expect(entryMarkup).not.toContain('h-11')
    expect(entryStart).toBeLessThan(footerStart)
    expect(decisionCenter.slice(footerStart, footerEnd)).not.toContain('decision-open-premarket-scenario')
    expect(scenarioView).toContain('<RightDrawer')
    expect(scenarioView).toContain('premarket-scenario-loading')
    expect(scenarioView).toContain('motion-reduce:animate-none')
    expect(scenarioView).toContain('premarket-user-conclusion')
    expect(scenarioView).toContain('开盘如何确认')
    expect(scenarioView).toContain('什么情况下判断失效')
    expect(scenarioView).toContain('premarket-evidence-diagnosis')
    expect(scenarioView).toContain('为什么当前推演受阻')
    expect(scenarioView).toContain('COMPACT_DRAWER_ACTION_CLASS')
    expect(scenarioView).toContain('data-testid="premarket-scenario-retry"')
    expect(scenarioView).toContain('data-testid="premarket-scenario-reload"')
    expect(scenarioView).toContain('data-testid="premarket-retry-feedback"')
    expect(scenarioView).toContain('data-testid="premarket-revision-history"')
    expect(scenarioView).toContain('aria-label="打开盘前采集设置"')
    expect(scenarioView).toContain('采集设置')
    expect(scenarioView).toContain('未在截点命中')
    expect(scenarioView).not.toContain("version.warnings.join('；')")
    expect(scenarioView).toContain('证据置信不代表收益概率')
    expect(scenarioView).toContain('premarket-scenario-fallback')
    expect(scenarioView).toContain('下一交易日准备')
    expect(scenarioView).toContain('premarket-refresh-preparation')
    expect(scenarioView).not.toMatch(/目标价|买入|卖出|仓位/)
  })
})
