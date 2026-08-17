export const PUBLIC_REQUEST_RATE_LIMIT_STATUSES = Object.freeze([403, 429, 456])

const RATE_LIMIT_STATUS_SET = new Set(PUBLIC_REQUEST_RATE_LIMIT_STATUSES)

export function estimatePublicRequestDurationMs(requestCount, policy = {}) {
  const count = boundedInteger(requestCount, 0, 0, 10_000_000)
  if (count <= 1) return 0
  const minIntervalMs = boundedInteger(policy.minIntervalMs, 800, 0, 60_000)
  const jitterMs = boundedInteger(policy.jitterMs, 200, 0, 10_000)
  const batchSize = boundedInteger(policy.batchSize, 400, 1, 10_000)
  const batchPauseMs = boundedInteger(policy.batchPauseMs, 60_000, 0, 60 * 60_000)
  const averageStartSpacing = minIntervalMs + jitterMs / 2
  const completedBatchPauses = Math.floor((count - 1) / batchSize)
  return Math.round((count - 1) * averageStartSpacing + completedBatchPauses * batchPauseMs)
}

export class ProviderCoolingDownError extends Error {
  constructor(provider, resumeAt, reason) {
    super(`${provider} is cooling down until ${new Date(resumeAt).toISOString()}: ${reason}`)
    this.name = 'ProviderCoolingDownError'
    this.code = 'PUBLIC_PROVIDER_COOLDOWN'
    this.provider = provider
    this.resumeAt = resumeAt
    this.reason = reason
  }
}

/**
 * A conservative, global single-concurrency governor for low-priority public data.
 * It spaces request starts, adds jitter, avoids automatic retries and opens a
 * provider-specific circuit on rate limits or repeated ordinary failures.
 */
export class PublicRequestGovernor {
  constructor(options = {}) {
    this.minIntervalMs = boundedInteger(options.minIntervalMs, 800, 0, 60_000)
    this.jitterMs = boundedInteger(options.jitterMs, 200, 0, 10_000)
    this.batchSize = boundedInteger(options.batchSize, 400, 1, 10_000)
    this.batchPauseMs = boundedInteger(options.batchPauseMs, 60_000, 0, 60 * 60_000)
    this.rateLimitCooldownMs = boundedInteger(options.rateLimitCooldownMs, 30 * 60_000, 1, 24 * 60 * 60_000)
    this.failureCooldownMs = boundedInteger(options.failureCooldownMs, 15 * 60_000, 1, 24 * 60 * 60_000)
    this.consecutiveFailureLimit = boundedInteger(options.consecutiveFailureLimit, 3, 1, 100)
    this.clock = options.clock ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
    this.nextAllowedAt = 0
    this.queueTail = Promise.resolve()
    this.providers = new Map()
    this.totalRequests = 0
    this.totalWaitMs = 0
    this.maximumActiveRequests = 0
    this.activeRequests = 0
    this.lastBatchPauseRequestCount = 0
  }

  providerState(provider) {
    const current = this.providers.get(provider)
    if (current) return current
    const created = {
      provider,
      requests: 0,
      successes: 0,
      failures: 0,
      rateLimits: 0,
      consecutiveFailures: 0,
      blockedUntil: 0,
      blockReason: null,
    }
    this.providers.set(provider, created)
    return created
  }

  assertProviderAvailable(provider) {
    const state = this.providerState(provider)
    const now = this.clock()
    if (state.blockedUntil > now) {
      throw new ProviderCoolingDownError(provider, state.blockedUntil, state.blockReason ?? 'COOLDOWN')
    }
    if (state.blockedUntil > 0) {
      state.blockedUntil = 0
      state.blockReason = null
      state.consecutiveFailures = 0
    }
  }

  recordStatus(provider, status) {
    const state = this.providerState(provider)
    state.requests += 1
    this.totalRequests += 1
    if (Number.isInteger(status) && status >= 200 && status < 400) {
      state.successes += 1
      state.consecutiveFailures = 0
      return
    }
    state.failures += 1
    state.consecutiveFailures += 1
    if (RATE_LIMIT_STATUS_SET.has(status)) {
      state.rateLimits += 1
      state.blockedUntil = this.clock() + this.rateLimitCooldownMs
      state.blockReason = `HTTP_${status}`
      return
    }
    if (state.consecutiveFailures >= this.consecutiveFailureLimit) {
      state.blockedUntil = this.clock() + this.failureCooldownMs
      state.blockReason = `CONSECUTIVE_FAILURES_${state.consecutiveFailures}`
    }
  }

  recordThrownFailure(provider) {
    this.recordStatus(provider, 0)
  }

  async run(provider, task) {
    let releaseQueue
    const previous = this.queueTail
    this.queueTail = new Promise((resolve) => { releaseQueue = resolve })
    await previous

    const queuedAt = this.clock()
    try {
      this.assertProviderAvailable(provider)
      if (
        this.batchPauseMs > 0
        && this.totalRequests > 0
        && this.totalRequests % this.batchSize === 0
        && this.lastBatchPauseRequestCount !== this.totalRequests
      ) {
        this.totalWaitMs += this.batchPauseMs
        await this.sleep(this.batchPauseMs)
        this.lastBatchPauseRequestCount = this.totalRequests
      }
      const waitMs = Math.max(0, this.nextAllowedAt - this.clock())
      if (waitMs > 0) {
        this.totalWaitMs += waitMs
        await this.sleep(waitMs)
      }
      this.assertProviderAvailable(provider)
      const startedAt = this.clock()
      const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * (this.jitterMs + 1))
      this.nextAllowedAt = startedAt + this.minIntervalMs + jitter
      this.activeRequests += 1
      this.maximumActiveRequests = Math.max(this.maximumActiveRequests, this.activeRequests)
      try {
        const value = await task()
        this.recordStatus(provider, Number(value?.status ?? 0))
        return {
          value,
          queueWaitMs: Math.max(0, startedAt - queuedAt),
          requestStartedAt: startedAt,
        }
      } catch (error) {
        this.recordThrownFailure(provider)
        throw error
      } finally {
        this.activeRequests -= 1
      }
    } finally {
      releaseQueue()
    }
  }

  snapshot() {
    return {
      policy: {
        concurrency: 1,
        minIntervalMs: this.minIntervalMs,
        jitterMs: this.jitterMs,
        batchSize: this.batchSize,
        batchPauseMs: this.batchPauseMs,
        rateLimitCooldownMs: this.rateLimitCooldownMs,
        failureCooldownMs: this.failureCooldownMs,
        consecutiveFailureLimit: this.consecutiveFailureLimit,
        automaticRetries: 0,
      },
      totalRequests: this.totalRequests,
      totalWaitMs: this.totalWaitMs,
      maximumActiveRequests: this.maximumActiveRequests,
      providers: Object.fromEntries([...this.providers.entries()].map(([provider, state]) => [provider, { ...state }])),
    }
  }
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}
