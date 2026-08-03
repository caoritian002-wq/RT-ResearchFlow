import { utcToBjDate } from '../utils/dateUtils'

export type PublicationTimeStatus = 'exact' | 'date_only' | 'collected_fallback'

export interface InferredPublicationTime {
  publishedAt: number
  status: Exclude<PublicationTimeStatus, 'collected_fallback'>
}

const MAX_PUBLICATION_CLOCK_SKEW_MS = 15 * 60 * 1000

export function validatePublicationTime(
  publication: InferredPublicationTime | null | undefined,
  collectedAt: number,
): InferredPublicationTime | null {
  if (!publication || !Number.isFinite(publication.publishedAt) || !Number.isFinite(collectedAt)) {
    return null
  }

  // A collected article cannot have been published on a later Beijing date. A small
  // same-day tolerance only covers source/server clock drift for exact timestamps.
  if (utcToBjDate(publication.publishedAt) > utcToBjDate(collectedAt)) return null
  if (publication.publishedAt > collectedAt + MAX_PUBLICATION_CLOCK_SKEW_MS) return null
  return publication
}

const TRACKING_PARAMS = new Set([
  'from',
  'source',
  'spm',
  'track',
  'tracking',
  'ref',
  'referrer',
])

export function canonicalizeArticleUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = ''
    }

    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase()
      if (normalized.startsWith('utm_') || TRACKING_PARAMS.has(normalized)) {
        url.searchParams.delete(key)
      }
    }
    url.searchParams.sort()
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
    return url.href
  } catch {
    return rawUrl.trim()
  }
}

export function normalizeArticleTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim()
}

export function isLikelyArticleTitle(title: string): boolean {
  const normalized = normalizeArticleTitle(title)
  if (normalized.length < 5 || normalized.length > 200) return false
  if (/^评论\s*[（(]?\d*[)）]?$/.test(normalized)) return false
  if (/^(更多|查看更多|点击查看|返回首页|加载更多|下一页|上一页)$/.test(normalized)) return false
  return true
}

export function inferPublishedAtFromUrl(rawUrl: string): InferredPublicationTime | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  const path = decodeURIComponent(url.pathname)
  const candidates: RegExp[] = []

  if (host.includes('21jingji.com')) candidates.push(/\/article\/(\d{4})(\d{2})(\d{2})(?:\/|$)/)
  if (host.includes('financialnews.com.cn')) candidates.push(/\/(\d{4})-(\d{2})\/(\d{2})(?:\/|$)/)
  if (host.includes('caixin.com')) candidates.push(/\/(\d{4})-(\d{2})-(\d{2})(?:\/|$)/)
  if (host.includes('people.com.cn')) candidates.push(/\/n1\/(\d{4})\/(\d{2})(\d{2})(?:\/|$)/)
  if (host.includes('xinhuanet.com')) candidates.push(/\/(\d{4})(\d{2})(\d{2})(?:\/|$)/)
  if (host.includes('gov.cn')) candidates.push(/\/(\d{4})(\d{2})\/(\d{2})(?:\/|$)/)

  candidates.push(
    /\/(\d{4})-(\d{2})-(\d{2})(?:\/|$)/,
    /\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/,
  )

  for (const pattern of candidates) {
    const match = path.match(pattern)
    if (!match) continue
    const timestamp = beijingTimestamp(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      0,
      0,
      0,
    )
    if (timestamp != null) return { publishedAt: timestamp, status: 'date_only' }
  }
  return null
}

export function extractPublishedAtFromText(text: string): InferredPublicationTime | null {
  const normalized = text.replace(/\s+/g, ' ')
  const dateTimeMatch = normalized.match(
    /(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  )
  if (dateTimeMatch) {
    const timestamp = beijingTimestamp(
      Number(dateTimeMatch[1]),
      Number(dateTimeMatch[2]),
      Number(dateTimeMatch[3]),
      Number(dateTimeMatch[4]),
      Number(dateTimeMatch[5]),
      Number(dateTimeMatch[6] ?? 0),
    )
    if (timestamp != null) return { publishedAt: timestamp, status: 'exact' }
  }

  const compactDateTimeMatch = normalized.match(
    /(20\d{2})(\d{2})(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  )
  if (compactDateTimeMatch) {
    const timestamp = beijingTimestamp(
      Number(compactDateTimeMatch[1]),
      Number(compactDateTimeMatch[2]),
      Number(compactDateTimeMatch[3]),
      Number(compactDateTimeMatch[4]),
      Number(compactDateTimeMatch[5]),
      Number(compactDateTimeMatch[6] ?? 0),
    )
    if (timestamp != null) return { publishedAt: timestamp, status: 'exact' }
  }

  const dateMatch = normalized.match(/(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/)
    ?? normalized.match(/(20\d{2})(\d{2})(\d{2})/)
  if (dateMatch) {
    const timestamp = beijingTimestamp(
      Number(dateMatch[1]),
      Number(dateMatch[2]),
      Number(dateMatch[3]),
      0,
      0,
      0,
    )
    if (timestamp != null) return { publishedAt: timestamp, status: 'date_only' }
  }
  return null
}

function beijingTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null

  const timestamp = Date.UTC(year, month - 1, day, hour - 8, minute, second)
  const check = new Date(timestamp + 8 * 60 * 60 * 1000)
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() + 1 !== month
    || check.getUTCDate() !== day
    || check.getUTCHours() !== hour
    || check.getUTCMinutes() !== minute
  ) return null
  return timestamp
}
