import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  beginAfterCloseSyncRun,
  completeAfterCloseSyncRun,
  getAfterCloseSyncRun,
  getLatestAfterCloseSyncRun,
  shouldStartAfterCloseSyncRun,
  updateAfterCloseSyncTask,
} from '../../electron/main/database/afterCloseSyncRepository'

describe('afterCloseSyncRepository', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 124))
  })

  afterEach(() => db.close())

  it('按交易日幂等保存任务明细和最终状态', () => {
    const started = beginAfterCloseSyncRun(db, '20260730', 'scheduled', 1_000)
    expect(started).toMatchObject({ tradeDate: '20260730', status: 'running', attemptCount: 1 })

    updateAfterCloseSyncTask(db, '20260730', 'security_master', 'completed', '5532只', 1_050)
    updateAfterCloseSyncTask(db, '20260730', 'market_daily', 'running', null, 1_100)
    updateAfterCloseSyncTask(db, '20260730', 'market_daily', 'completed', '5532只', 1_200)
    const completed = completeAfterCloseSyncRun(db, '20260730', 'completed', null, 1_300)

    expect(completed.tasks.market_daily).toEqual({
      status: 'completed',
      startedAt: 1_100,
      completedAt: 1_200,
      message: '5532只',
    })
    expect(completed.tasks.security_master?.status).toBe('completed')
    expect(getLatestAfterCloseSyncRun(db)?.status).toBe('completed')
    expect(shouldStartAfterCloseSyncRun(completed, 99_999_999)).toBe(false)
  })

  it('运行中30分钟内不重放，失败批次冷却后允许重试并增加attempt', () => {
    const running = beginAfterCloseSyncRun(db, '20260730', 'startup_catch_up', 1_000)
    expect(shouldStartAfterCloseSyncRun(running, 1_000 + 29 * 60_000)).toBe(false)
    expect(shouldStartAfterCloseSyncRun(running, 1_000 + 30 * 60_000)).toBe(true)

    const failed = completeAfterCloseSyncRun(db, '20260730', 'failed', 'NETWORK_ERROR', 2_000_000)
    expect(shouldStartAfterCloseSyncRun(failed, 2_000_000 + 59 * 60_000)).toBe(false)
    expect(shouldStartAfterCloseSyncRun(failed, 2_000_000 + 60 * 60_000)).toBe(true)

    const retried = beginAfterCloseSyncRun(db, '20260730', 'scheduled', 6_000_000)
    expect(retried.attemptCount).toBe(2)
    expect(retried.tasks).toEqual({})
    expect(getAfterCloseSyncRun(db, '20260730')?.trigger).toBe('scheduled')
  })
})
