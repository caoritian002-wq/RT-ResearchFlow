import { ipcMain, net } from 'electron'
import { fetchWithBrowser } from '../services/scrapers/browserFetch'
import * as cheerio from 'cheerio'
import { sha256 } from '../utils/hashUtils'
import {
  getCachedDetail,
  setCachedDetail,
  getCacheStats,
  clearDetailCache
} from '../database/detailCacheRepository'
import { getDb } from '../database/db'
import type { BriefingRow, SourceRow } from '../database/types'

/**
 * Fetch a URL using Electron's net module (respects proxy settings).
 * Handles GBK/GB2312 encoding common on Chinese government sites.
 */
const DETAIL_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Cache-Control': 'max-age=0',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"'
}

function netGetRaw(url: string): Promise<{ buffer: Buffer; contentType: string; statusCode: number }> {
  const origin = (() => { try { return new URL(url).origin + '/' } catch { return url } })()
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', useSessionCookies: true })
    Object.entries({ ...DETAIL_HEADERS, Referer: origin }).forEach(([k, v]) => req.setHeader(k, v))

    const chunks: Buffer[] = []
    let contentType = ''
    let statusCode = 0

    req.on('response', (resp) => {
      statusCode = resp.statusCode
      contentType = (resp.headers['content-type'] as string) ?? ''
      resp.on('data', (chunk) => chunks.push(chunk as Buffer))
      resp.on('end', () =>
        resolve({ buffer: Buffer.concat(chunks), contentType, statusCode })
      )
      resp.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

export async function fetchHtml(url: string): Promise<string> {
  const result = await netGetRaw(url)

  if (result.statusCode === 403) {
    console.log(`[detail] 403 on ${url}, falling back to BrowserWindow fetch`)
    return fetchWithBrowser(url)
  }

  if (result.statusCode >= 400) {
    throw new Error(`Request failed with status code ${result.statusCode}`)
  }

  return decodeChineseBuffer(result.buffer, result.contentType)
}

function decodeChineseBuffer(buffer: Buffer, contentType: string): string {
  const ctMatch = contentType.match(/charset=([^\s;]+)/i)
  if (ctMatch) {
    const charset = ctMatch[1].toLowerCase()
    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
      return new TextDecoder('gbk').decode(buffer)
    }
  }
  const peek = buffer.slice(0, 1000).toString('latin1')
  const metaMatch = peek.match(/charset=["']?([^"'\s>]+)/i)
  if (metaMatch) {
    const charset = metaMatch[1].toLowerCase()
    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
      return new TextDecoder('gbk').decode(buffer)
    }
  }
  return buffer.toString('utf-8')
}

function resolveDetailAssetUrl(rawValue: string | undefined, baseUrl: string): string | null {
  const value = rawValue?.trim()
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return null
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return null
  }
}

function normalizeSrcset(srcset: string | undefined, baseUrl: string): string | null {
  const value = srcset?.trim()
  if (!value) return null

  const normalized = value
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return ''
      const [urlPart, ...descriptorParts] = trimmed.split(/\s+/)
      const resolved = resolveDetailAssetUrl(urlPart, baseUrl)
      return resolved ? [resolved, ...descriptorParts].join(' ') : trimmed
    })
    .filter(Boolean)
    .join(', ')

  return normalized || null
}

function normalizeDetailHtml(content: string, baseUrl: string): string {
  const $ = cheerio.load(content)
  $('img').each((_idx, img) => {
    const el = $(img)
    const src = el.attr('src')
    const lazySrc = el.attr('data-src') ?? el.attr('data-original') ?? el.attr('data-lazy-src') ?? el.attr('data-url')
    const resolvedSrc = resolveDetailAssetUrl(src, baseUrl) ?? resolveDetailAssetUrl(lazySrc, baseUrl)
    if (resolvedSrc) el.attr('src', resolvedSrc)

    const resolvedSrcset = normalizeSrcset(el.attr('srcset') ?? el.attr('data-srcset'), baseUrl)
    if (resolvedSrcset) el.attr('srcset', resolvedSrcset)

    el.attr('referrerpolicy', 'no-referrer')
    el.attr('loading', 'lazy')
    el.attr('decoding', 'async')
  })
  return $.root().html() ?? content
}

export type DetailContentResult = {
  content: string | null
  status: 'OK' | 'NO_DETAIL_SELECTOR' | 'FETCH_ERROR' | 'PARSER_ERROR' | 'NO_MATCH'
  error?: string
}

export function registerDetailHandlers(): void {
  /**
   * detail:getContent — returns cached or freshly fetched detail page content.
   * Returns a structured result with detailed status and error information.
   */
  ipcMain.handle('detail:getContent', async (_e, briefingId: number): Promise<DetailContentResult> => {
    const db = getDb()
    const briefing = db
      .prepare('SELECT * FROM briefings WHERE id = ?')
      .get(briefingId) as BriefingRow | undefined
    if (!briefing) {
      return { content: null, status: 'FETCH_ERROR', error: '未找到该简报' }
    }

    const source = db
      .prepare('SELECT * FROM sources WHERE id = ?')
      .get(briefing.sourceId) as SourceRow | undefined
    if (!source?.detailSelector) {
      return { content: null, status: 'NO_DETAIL_SELECTOR' }
    }

    const cacheKey = sha256(briefing.originalUrl)
    const cached = getCachedDetail(cacheKey)
    if (cached) {
      console.log('[detail] cache hit for', briefing.originalUrl)
      return { content: normalizeDetailHtml(cached.content, briefing.originalUrl), status: 'OK' }
    }

    // Fetch fresh
    try {
      console.log('[detail] fetchHtml....', briefing.originalUrl)
      const html = await fetchHtml(briefing.originalUrl)
      const $ = cheerio.load(html)

      // detailSelector may be "|"-delimited; try each in order, return first match
      const selectors = source.detailSelector.split('|').map((s) => s.trim()).filter(Boolean)
      console.log('[detail] selectors...', selectors)
      let extracted = ''
      let matchedSelector: string | null = null
      for (const sel of selectors) {
        const found = $(sel).html()
        if (found && found.trim()) {
          extracted = found
          matchedSelector = sel
          break
        }
      }

      if (!extracted) {
        console.warn('[detail] no matching selector for', briefing.originalUrl, source.detailSelector)
        setCachedDetail(cacheKey, briefing.originalUrl, '')
        return { content: null, status: 'NO_MATCH', error: `未能匹配选择器：${source.detailSelector}` }
      }

      const normalized = normalizeDetailHtml(extracted, briefing.originalUrl)
      console.log('[detail] extracted length:', normalized.length, 'chars, selector:', matchedSelector)
      setCachedDetail(cacheKey, briefing.originalUrl, normalized)
      return { content: normalized, status: 'OK' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[detail] fetch failed:', briefing.originalUrl, message)
      return { content: null, status: 'FETCH_ERROR', error: message }
    }
  })

  /** cache:getStats — returns count + estimated byte size */
  ipcMain.handle('cache:getStats', () => {
    return getCacheStats()
  })

  /** cache:clear — clears cache by range, returns deleted count */
  ipcMain.handle('cache:clear', (_e, range: 'all' | '1month' | '3months' | '1year') => {
    return clearDetailCache(range)
  })
}
