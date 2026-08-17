import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimatePublicRequestDurationMs,
  ProviderCoolingDownError,
  PublicRequestGovernor,
} from './lib/public-request-governor.mjs'

function fakeRuntime() {
  let now = 1_000_000
  return {
    clock: () => now,
    sleep: async (ms) => { now += ms },
    advance: (ms) => { now += ms },
  }
}

test('Governor serializes complete requests and spaces request starts', async () => {
  const runtime = fakeRuntime()
  const governor = new PublicRequestGovernor({
    minIntervalMs: 1200,
    jitterMs: 0,
    batchSize: 100,
    batchPauseMs: 0,
    clock: runtime.clock,
    sleep: runtime.sleep,
    random: () => 0,
  })
  const starts = []
  let active = 0
  const task = async () => {
    starts.push(runtime.clock())
    active += 1
    assert.equal(active, 1)
    runtime.advance(200)
    active -= 1
    return { status: 200 }
  }
  await Promise.all([
    governor.run('eastmoney', task),
    governor.run('sina', task),
    governor.run('eastmoney', task),
  ])
  assert.deepEqual(starts, [1_000_000, 1_001_200, 1_002_400])
  assert.equal(governor.snapshot().maximumActiveRequests, 1)
})

test('Rate-limit response opens a long provider-specific cooldown without retry', async () => {
  const runtime = fakeRuntime()
  const governor = new PublicRequestGovernor({
    minIntervalMs: 0,
    jitterMs: 0,
    batchSize: 100,
    batchPauseMs: 0,
    rateLimitCooldownMs: 900_000,
    clock: runtime.clock,
    sleep: runtime.sleep,
  })
  await governor.run('eastmoney', async () => ({ status: 429 }))
  await assert.rejects(
    () => governor.run('eastmoney', async () => ({ status: 200 })),
    (error) => error instanceof ProviderCoolingDownError && error.resumeAt === 1_900_000,
  )
  const snapshot = governor.snapshot()
  assert.equal(snapshot.totalRequests, 1)
  assert.equal(snapshot.providers.eastmoney.rateLimits, 1)
  assert.equal(snapshot.policy.automaticRetries, 0)
})

test('Ordinary failures open the short circuit after the configured threshold', async () => {
  const runtime = fakeRuntime()
  const governor = new PublicRequestGovernor({
    minIntervalMs: 0,
    jitterMs: 0,
    batchSize: 100,
    batchPauseMs: 0,
    consecutiveFailureLimit: 3,
    failureCooldownMs: 120_000,
    clock: runtime.clock,
    sleep: runtime.sleep,
  })
  await governor.run('sina', async () => ({ status: 500 }))
  await governor.run('sina', async () => ({ status: 500 }))
  await governor.run('sina', async () => ({ status: 500 }))
  await assert.rejects(
    () => governor.run('sina', async () => ({ status: 200 })),
    (error) => error instanceof ProviderCoolingDownError && error.reason === 'CONSECUTIVE_FAILURES_3',
  )
  assert.equal(governor.snapshot().providers.sina.failures, 3)
})

test('Governor inserts a long pause after each bounded request batch', async () => {
  const runtime = fakeRuntime()
  const governor = new PublicRequestGovernor({
    minIntervalMs: 0,
    jitterMs: 0,
    batchSize: 2,
    batchPauseMs: 60_000,
    clock: runtime.clock,
    sleep: runtime.sleep,
  })
  const starts = []
  for (let index = 0; index < 3; index += 1) {
    await governor.run('eastmoney', async () => {
      starts.push(runtime.clock())
      return { status: 200 }
    })
  }
  assert.deepEqual(starts, [1_000_000, 1_000_000, 1_060_000])
  assert.equal(governor.snapshot().totalWaitMs, 60_000)
})

test('Full-market duration estimate stays below two hours with bounded batch pauses', () => {
  const duration = estimatePublicRequestDurationMs(5500, {
    minIntervalMs: 800,
    jitterMs: 200,
    batchSize: 400,
    batchPauseMs: 60_000,
  })
  assert.equal(duration, 5_729_100)
  assert.ok(duration > 90 * 60_000)
  assert.ok(duration < 2 * 60 * 60_000)
})
