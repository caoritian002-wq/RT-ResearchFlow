import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  deferPublicMarketRequestsUntil,
  getPublicMarketGlobalRequestState,
  getPublicMarketProviderState,
} from '../../electron/main/database/publicMarketDataRepository'
import {
  DEFAULT_PUBLIC_MARKET_REQUEST_POLICY,
  PersistentPublicMarketRequestGovernor,
  PublicMarketProviderCoolingDownError,
} from '../../electron/main/services/publicMarketRequestGovernor'

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (ts_code, trade_date)
    );
  `)
  runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 137))
  return db
}

describe('PersistentPublicMarketRequestGovernor', () => {
  const databases: Database.Database[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) db.close()
  })

  it('uses the verified sub-two-hour single-concurrency policy by default', () => {
    expect(DEFAULT_PUBLIC_MARKET_REQUEST_POLICY).toEqual({
      minIntervalMs: 800,
      jitterMs: 200,
      batchSize: 10_000,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    })
  })

  it('respects a historical-job batch pause after the governor is recreated', async () => {
    const db = createDb()
    databases.push(db)
    let now = 1_000
    deferPublicMarketRequestsUntil(db, 61_000, now)
    const starts: number[] = []
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 10_000,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })

    await governor.run('sina', async () => {
      starts.push(now)
      return { status: 200 }
    })
    expect(starts).toEqual([61_000])
  })

  it('serializes complete requests and persists the request spacing gate', async () => {
    const db = createDb()
    databases.push(db)
    let now = 1_000
    let active = 0
    let maximumActive = 0
    const starts: number[] = []
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 3_000,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 60_000,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })

    await Promise.all([1, 2].map(() => governor.run('sina', async () => {
      starts.push(now)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      active -= 1
      return { status: 200 }
    })))

    expect(starts).toEqual([1_000, 4_000])
    expect(maximumActive).toBe(1)
    expect(getPublicMarketGlobalRequestState(db).totalRequests).toBe(2)
    expect(governor.snapshot().policy.automaticRetries).toBe(0)
  })

  it('persists provider cooldown across governor instances without retrying', async () => {
    const db = createDb()
    databases.push(db)
    let now = 10_000
    let calls = 0
    const dependencies = {
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      random: () => 0,
    }
    const policy = {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }
    const first = new PersistentPublicMarketRequestGovernor(db, policy, dependencies)
    await expect(first.run('sina', async () => {
      calls += 1
      return { status: 456 }
    })).rejects.toBeInstanceOf(PublicMarketProviderCoolingDownError)

    const second = new PersistentPublicMarketRequestGovernor(db, policy, dependencies)
    await expect(second.run('sina', async () => {
      calls += 1
      return { status: 200 }
    })).rejects.toBeInstanceOf(PublicMarketProviderCoolingDownError)
    expect(calls).toBe(1)
    expect(getPublicMarketProviderState(db, 'sina', now)).toMatchObject({
      rateLimitCount: 1,
      blockReason: 'HTTP_456',
    })
  })

  it('persists a mandatory pause after each bounded request batch', async () => {
    const db = createDb()
    databases.push(db)
    let now = 5_000
    const starts: number[] = []
    const governor = new PersistentPublicMarketRequestGovernor(db, {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 2,
      batchPauseMs: 60_000,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      random: () => 0,
    })

    for (let index = 0; index < 3; index += 1) {
      await governor.run('sina', async () => {
        starts.push(now)
        return { status: 200 }
      })
    }
    expect(starts).toEqual([5_000, 5_000, 65_000])
  })

  it('opens a persisted 15 minute cooldown on the third ordinary failure', async () => {
    const db = createDb()
    databases.push(db)
    let now = 20_000
    let calls = 0
    const policy = {
      minIntervalMs: 0,
      jitterMs: 0,
      batchSize: 20,
      batchPauseMs: 0,
      rateLimitCooldownMs: 30 * 60_000,
      failureCooldownMs: 15 * 60_000,
      consecutiveFailureLimit: 3,
    }
    const dependencies = {
      now: () => now,
      sleep: async (ms: number) => { now += ms },
      random: () => 0,
    }
    const governor = new PersistentPublicMarketRequestGovernor(db, policy, dependencies)

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await expect(governor.run('sina', async () => {
        calls += 1
        throw new Error(`network-${attempt}`)
      })).rejects.toThrow(`network-${attempt}`)
    }
    await expect(governor.run('sina', async () => {
      calls += 1
      throw new Error('network-3')
    })).rejects.toBeInstanceOf(PublicMarketProviderCoolingDownError)

    const restarted = new PersistentPublicMarketRequestGovernor(db, policy, dependencies)
    await expect(restarted.run('sina', async () => {
      calls += 1
      return { status: 200 }
    })).rejects.toBeInstanceOf(PublicMarketProviderCoolingDownError)
    expect(calls).toBe(3)
    expect(getPublicMarketProviderState(db, 'sina', now)).toMatchObject({
      consecutiveFailures: 3,
      blockReason: 'CONSECUTIVE_FAILURES_3',
      blockedUntil: now + 15 * 60_000,
    })
  })
})
