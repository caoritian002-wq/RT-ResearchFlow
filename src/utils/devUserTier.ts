export type DevUserTier = 'free' | 'pro'

export const DEV_USER_TIER_STORAGE_KEY = 'tradeWatch.devUserTier'

export function normalizeDevUserTier(value: unknown): DevUserTier {
  return value === 'pro' ? 'pro' : 'free'
}

export function readDevUserTier(): DevUserTier {
  if (typeof window === 'undefined') return 'free'
  return normalizeDevUserTier(window.localStorage.getItem(DEV_USER_TIER_STORAGE_KEY))
}

export function writeDevUserTier(tier: DevUserTier): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(DEV_USER_TIER_STORAGE_KEY, tier)
  window.dispatchEvent(new CustomEvent('trade-watch:dev-user-tier-changed', { detail: { tier } }))
}
