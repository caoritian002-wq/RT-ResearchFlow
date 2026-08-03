export function normalizeExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > 4096) {
    return null
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname || parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

export function isAllowedApplicationNavigation(targetUrl: string, entryUrl: string): boolean {
  try {
    const target = new URL(targetUrl)
    const entry = new URL(entryUrl)
    if (target.username || target.password) return false

    if (entry.protocol === 'file:') {
      return target.protocol === 'file:'
        && target.host === entry.host
        && target.pathname === entry.pathname
    }

    if (entry.protocol !== 'http:' && entry.protocol !== 'https:') return false
    return target.protocol === entry.protocol && target.origin === entry.origin
  } catch {
    return false
  }
}

export function shouldAllowRendererPermission(): false {
  return false
}
