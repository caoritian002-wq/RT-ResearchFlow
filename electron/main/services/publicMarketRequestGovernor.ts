import type Database from 'better-sqlite3'
import {
  getPublicMarketGlobalRequestState,
  getPublicMarketProviderState,
  markPublicMarketRequestStarted,
  recordPublicMarketRequestOutcome,
} from '../database/publicMarketDataRepository'

export const PUBLIC_MARKET_RATE_LIMIT_STATUSES = new Set([403, 429, 456])

export interface PublicMarketRequestPolicy {
  minIntervalMs: number
  jitterMs: number
  batchSize: number
  batchPauseMs: number
  rateLimitCooldownMs: number
  failureCooldownMs: number
  consecutiveFailureLimit: number
}

export const DEFAULT_PUBLIC_MARKET_REQUEST_POLICY: Readonly<PublicMarketRequestPolicy> = Object.freeze({
  minIntervalMs: 800,
  jitterMs: 200,
  batchSize: 10_000,
  batchPauseMs: 0,
  rateLimitCooldownMs: 30 * 60_000,
  failureCooldownMs: 15 * 60_000,
  consecutiveFailureLimit: 3,
})

export class PublicMarketProviderCoolingDownError extends Error {
  readonly code = 'PUBLIC_PROVIDER_COOLDOWN'

  constructor(
    readonly provider: string,
    readonly resumeAt: number,
    readonly reason: string,
  ) {
    super(`${provider} cooling down until ${new Date(resumeAt).toISOString()}: ${reason}`)
    this.name = 'PublicMarketProviderCoolingDownError'
  }
}

interface GovernorDependencies {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export interface GovernedPublicResponse {
  status: number
}

export interface GovernedPublicResult<T extends GovernedPublicResponse> {
  value: T
  queueWaitMs: number
  requestStartedAt: number
}

export class PersistentPublicMarketRequestGovernor {
  private queueTail: Promise<void> = Promise.resolve()
  private activeRequests = 0
  private maximumActiveRequests = 0
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(
    private readonly db: Database.Database,
    readonly policy: Readonly<PublicMarketRequestPolicy> = DEFAULT_PUBLIC_MARKET_REQUEST_POLICY,
    dependencies: GovernorDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = dependencies.random ?? Math.random
  }

  private assertProviderAvailable(provider: string): void {
    const now = this.now()
    const state = getPublicMarketProviderState(this.db, provider, now)
    if (state.blockedUntil > now) {
      throw new PublicMarketProviderCoolingDownError(
        provider,
        state.blockedUntil,
        state.blockReason ?? 'COOLDOWN',
      )
    }
  }

  async run<T extends GovernedPublicResponse>(
    provider: string,
    task: () => Promise<T>,
  ): Promise<GovernedPublicResult<T>> {
    let releaseQueue!: () => void
    const previous = this.queueTail
    this.queueTail = new Promise<void>((resolve) => { releaseQueue = resolve })
    const queuedAt = this.now()
    await previous

    try {
      this.assertProviderAvailable(provider)
      const global = getPublicMarketGlobalRequestState(this.db)
      const waitUntil = Math.max(global.nextAllowedAt, global.batchBlockedUntil)
      const waitMs = Math.max(0, waitUntil - this.now())
      if (waitMs > 0) await this.sleep(waitMs)
      this.assertProviderAvailable(provider)

      const startedAt = this.now()
      const jitterRatio = Math.max(0, Math.min(1, this.random()))
      const jitter = Math.floor(jitterRatio * (this.policy.jitterMs + 1))
      markPublicMarketRequestStarted(
        this.db,
        provider,
        startedAt,
        startedAt + this.policy.minIntervalMs + jitter,
      )

      this.activeRequests += 1
      this.maximumActiveRequests = Math.max(this.maximumActiveRequests, this.activeRequests)
      try {
        let value: T
        try {
          value = await task()
        } catch (error) {
          const completedAt = this.now()
          recordPublicMarketRequestOutcome(this.db, {
            provider,
            status: 0,
            completedAt,
            ...this.policy,
          })
          const state = getPublicMarketProviderState(this.db, provider, completedAt)
          if (state.blockedUntil > completedAt) {
            throw new PublicMarketProviderCoolingDownError(
              provider,
              state.blockedUntil,
              state.blockReason ?? 'CONSECUTIVE_FAILURES',
            )
          }
          throw error
        }

        const completedAt = this.now()
        recordPublicMarketRequestOutcome(this.db, {
          provider,
          status: value.status,
          completedAt,
          ...this.policy,
        })
        if (PUBLIC_MARKET_RATE_LIMIT_STATUSES.has(value.status)) {
          const state = getPublicMarketProviderState(this.db, provider, completedAt)
          throw new PublicMarketProviderCoolingDownError(
            provider,
            state.blockedUntil,
            state.blockReason ?? `HTTP_${value.status}`,
          )
        }
        return {
          value,
          queueWaitMs: Math.max(0, startedAt - queuedAt),
          requestStartedAt: startedAt,
        }
      } finally {
        this.activeRequests -= 1
      }
    } finally {
      releaseQueue()
    }
  }

  snapshot(): {
    policy: Readonly<PublicMarketRequestPolicy> & { concurrency: 1; automaticRetries: 0 }
    maximumActiveRequests: number
  } {
    return {
      policy: { ...this.policy, concurrency: 1, automaticRetries: 0 },
      maximumActiveRequests: this.maximumActiveRequests,
    }
  }
}

const governors = new WeakMap<Database.Database, PersistentPublicMarketRequestGovernor>()

export function getPersistentPublicMarketRequestGovernor(
  db: Database.Database,
): PersistentPublicMarketRequestGovernor {
  const existing = governors.get(db)
  if (existing) return existing
  const created = new PersistentPublicMarketRequestGovernor(db)
  governors.set(db, created)
  return created
}
