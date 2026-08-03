import { net } from 'electron'
import * as cheerio from 'cheerio'
import { fetchWithBrowser } from './browserFetch'
import {
  extractPublishedAtFromText,
  isLikelyArticleTitle,
} from '../articlePublication'
import type { Source } from '../../database/types'
import type { RawArticle, ScrapeResult } from './types'

const BROWSER_HEADERS: Record<string, string> = {
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
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"'
}

interface NetGetResult {
  buffer: Buffer
  contentType: string
  statusCode: number
}

/**
 * Single GET using Electron's net module with Chromium session cookies.
 * useSessionCookies: true means Set-Cookie responses are persisted in the
 * default session and automatically re-sent on subsequent requests.
 */
function netGet(url: string): Promise<NetGetResult> {
  return new Promise((resolve, reject) => {
    const origin = (() => { try { return new URL(url).origin + '/' } catch { return url } })()
    const req = net.request({ url, method: 'GET', useSessionCookies: true })

    Object.entries({ ...BROWSER_HEADERS, Referer: origin }).forEach(([k, v]) =>
      req.setHeader(k, v)
    )

    const chunks: Buffer[] = []
    let contentType = ''
    let statusCode = 0

    req.on('response', (resp) => {
      statusCode = resp.statusCode
      contentType = (resp.headers['content-type'] as string) ?? ''
      resp.on('data', (chunk) => chunks.push(chunk as Buffer))
      resp.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType, statusCode }))
      resp.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Fetch a URL. Falls back to a hidden BrowserWindow on 403 so that
 * JavaScript-based anti-bot systems (e.g. Wangdun on gov.cn / pbc.gov.cn)
 * can execute and write their session cookies into session.defaultSession.
 * Subsequent net.request(useSessionCookies:true) calls to the same domain
 * will then carry those cookies automatically.
 */
async function fetchUrl(url: string): Promise<string> {
  const result = await netGet(url)

  if (result.statusCode === 403) {
    console.log(`[html] 403 on ${url}, falling back to BrowserWindow fetch`)
    return fetchWithBrowser(url)
  }

  if (result.statusCode >= 400) {
    throw new Error(`Request failed with status code ${result.statusCode}`)
  }

  return decodeChineseHtml(result.buffer, result.contentType)
}

export async function scrapeHtml(source: Source): Promise<ScrapeResult> {
  try {
    const targetUrl = source.financeSectionFilter
      ? resolveUrl(source.url, source.financeSectionFilter)
      : source.url

    const html = await fetchUrl(targetUrl)
    const $ = cheerio.load(html)

    const selector = source.contentSelector ?? 'a'
    const articles: RawArticle[] = []
    const seen = new Set<string>()

    $(selector).each((_i, el) => {
      const $el = $(el)
      const title = $el.text().trim()
      const href = $el.attr('href')

      if (!href || !isLikelyArticleTitle(title)) return

      const url = resolveUrl(targetUrl, href)
      // Discard non-HTTP URLs (javascript:, #anchors, mailto:, etc.)
      if (!url || seen.has(url)) return
      if (!url.startsWith('http://') && !url.startsWith('https://')) return
      seen.add(url)

      // Try to extract date from surrounding context
      const parentText = $el.parent().text()
      const titleOffset = parentText.indexOf(title)
      const surroundingText = titleOffset >= 0
        ? `${parentText.slice(0, titleOffset)} ${parentText.slice(titleOffset + title.length)}`
        : parentText
      const timeText = [
        $el.attr('datetime'),
        $el.attr('data-time'),
        $el.parent().find('time').first().attr('datetime'),
        surroundingText,
      ].filter(Boolean).join(' ')
      const publication = extractPublishedAtFromText(timeText)

      articles.push({
        title,
        url,
        publishedAt: publication?.publishedAt ?? null,
        publicationTimeStatus: publication?.status,
        summary: '',
      })
    })

    return { sourceId: source.id, articles: articles.slice(0, 50) }
  } catch (err) {
    return {
      sourceId: source.id,
      articles: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).href
  } catch {
    return ''
  }
}

function decodeChineseHtml(buffer: Buffer, contentType: string): string {
  // Detect charset: try content-type header, then meta charset tag
  const ctMatch = contentType.match(/charset=([^\s;]+)/i)
  if (ctMatch) {
    const charset = ctMatch[1].toLowerCase()
    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb18030') {
      return new TextDecoder('gbk').decode(buffer)
    }
  }

  // Peek at the raw bytes for meta charset
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

export async function fetchArticlePublication(url: string): Promise<ReturnType<typeof extractPublishedAtFromText>> {
  try {
    const html = await fetchUrl(url)
    const $ = cheerio.load(html)
    const candidates = [
      $('meta[property="article:published_time"]').attr('content'),
      $('meta[name="pubdate"]').attr('content'),
      $('meta[name="publishdate"]').attr('content'),
      $('meta[name="publish-date"]').attr('content'),
      $('meta[name="date"]').attr('content'),
      $('time[datetime]').first().attr('datetime'),
      $('[class*="time"], [class*="date"], [id*="time"], [id*="date"]').first().text(),
    ].filter((candidate): candidate is string => Boolean(candidate?.trim()))
    for (const candidate of candidates) {
      const publication = extractPublishedAtFromText(candidate)
      if (publication) return publication
    }
    return null
  } catch {
    return null
  }
}
