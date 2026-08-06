import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const scheduler = readFileSync(
  new URL('../../electron/main/services/schedulerService.ts', import.meta.url),
  'utf8',
)
const chipMonitor = readFileSync(
  new URL('../../src/components/ShortTermStrategy/ChipMonitor.tsx', import.meta.url),
  'utf8',
)

describe('18:00统一盘后调度契约', () => {
  it('只注册一个盘后协调器且不保留17点计时器', () => {
    expect(scheduler).toContain('runUnifiedAfterCloseSyncJob')
    expect(scheduler).toContain('delayUntilBjTime(AFTER_CLOSE_SYNC_HOUR_BJ, AFTER_CLOSE_SYNC_MINUTE_BJ)')
    expect(scheduler).not.toContain('delayUntilBjTime(17, 0)')
    expect(scheduler).not.toContain('scheduleChipMonitorCron')
    expect(scheduler).not.toContain('scheduleTopListSync')
  })

  it('修改资讯扫描频率只重排资讯计时器', () => {
    const start = scheduler.indexOf('export function reschedule(): void')
    const end = scheduler.indexOf('\nfunction scheduleNext()', start)
    const body = scheduler.slice(start, end)
    expect(body).not.toContain('stopScheduler()')
    expect(body).toContain('clearTimeout(_timer)')
    expect(body).toContain('scheduleNext()')
  })

  it('启动补漏不依赖Tushare配置且市场任务等待个性选股收敛', () => {
    const startScheduler = scheduler.slice(
      scheduler.indexOf('export function startScheduler(): void'),
      scheduler.indexOf('export function stopScheduler(): void'),
    )
    expect(startScheduler).toContain('} else {')
    expect(startScheduler.match(/runStartupAfterCloseCatchUp\(\)/g)).toHaveLength(2)

    const marketTask = scheduler.slice(
      scheduler.indexOf('export async function runTopListSyncJob'),
      scheduler.indexOf('export async function runDailyOHLCVSyncJob'),
    )
    expect(marketTask).toContain("const { runScreener } = await import('./stockScreenerService')")
    expect(marketTask).toContain('screenerCompleted = true')
    expect(marketTask).not.toContain(';(async () =>')
  })

  it('盘前验证作为独立子任务接入18点协调器且晚于市场日线任务', () => {
    const coordinator = scheduler.slice(
      scheduler.indexOf('export function runUnifiedAfterCloseSyncJob'),
      scheduler.indexOf('function scheduleAfterCloseDailySync'),
    )
    expect(coordinator).toContain("runTrackedAfterCloseTask(tradeDate, 'premarket_validation'")
    expect(coordinator.indexOf("'premarket_validation'")).toBeGreaterThan(coordinator.indexOf("'market_daily'"))
    expect(coordinator).toContain('runPremarketOutcomeValidation(db, tradeDate)')
  })

  it('证券主数据独立于题材源接入18点协调器并提供启动过期补偿', () => {
    const coordinator = scheduler.slice(
      scheduler.indexOf('export function runUnifiedAfterCloseSyncJob'),
      scheduler.indexOf('export function scheduleAfterCloseDailySync'),
    )
    expect(coordinator).toContain("runTrackedAfterCloseTask(tradeDate, 'security_master'")
    expect(coordinator.indexOf("'security_master'")).toBeLessThan(coordinator.indexOf("'market_daily'"))

    const conceptSync = scheduler.slice(
      scheduler.indexOf('export async function runConceptMembersSyncForSource'),
      scheduler.indexOf('export interface StockBasicSyncResult'),
    )
    expect(conceptSync).not.toContain('runStockBasicSyncJob()')
    expect(scheduler).toContain('runStartupStockBasicSyncIfStale()')
    expect(scheduler).toContain('if (_stockBasicSyncPromise) return _stockBasicSyncPromise')
    expect(scheduler).toContain("remapUnmatchedIndustryResearchCompanyCandidates(getDb())")
    expect(scheduler).toContain('.sort((left, right) => right.localeCompare(left))[0] ?? null')
    expect(scheduler).not.toContain("reverse().find(r => r.isOpen === 1)?.calDate")
  })

  it('盘前通知在09:28确认版之后于09:29执行并只允许五分钟启动收敛', () => {
    expect(scheduler).toContain('PREMARKET_NOTIFICATION_HOUR_BJ = 9')
    expect(scheduler).toContain('PREMARKET_NOTIFICATION_MINUTE_BJ = 29')
    expect(scheduler).toContain('PREMARKET_NOTIFICATION_GRACE_MS = 5 * 60 * 1000')
    expect(scheduler).toContain('reconcilePremarketNotificationForToday()')
  })

  it('筹码工作台以紧凑状态带展示18点、上次和下次运行', () => {
    expect(chipMonitor).toContain('data-testid="after-close-schedule-status"')
    expect(chipMonitor).toContain('统一盘后同步 · 18:00')
    expect(chipMonitor).toContain('scheduleStatus.lastRun')
    expect(chipMonitor).toContain('scheduleStatus.nextRunAt')
  })
})
