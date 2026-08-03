import { fetchHtml } from '../../ipc/detailHandlers'
import type { ResearchFetchedPage } from './types'

const SEARCH_SHELL_HINTS = [
  '/search',
  'fulltextsearch',
  'notautosubmit',
  'keywords=',
  'qt=',
  'query=',
]

const NON_ARTICLE_EXTENSIONS = /\.(?:css|js|mjs|map|woff2?|ttf|eot|ico|png|jpe?g|gif|webp|svg)(?:$|[?#])/i

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!match?.[1]) return fallback
  return stripHtml(match[1]).slice(0, 300) || fallback
}

function extractMetaDescription(html: string): string | null {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i)
  if (!match?.[1]) return null
  return stripHtml(match[1]).slice(0, 500) || null
}

function extractPublishedAt(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']publish(?:date|ed_time|time)?["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i,
    /(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})/,
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (!match) continue
    if (match.length >= 4 && match[1] && match[2] && match[3]) {
      const y = match[1]
      const m = String(match[2]).padStart(2, '0')
      const d = String(match[3]).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
    const raw = match[1]?.trim()
    if (!raw) continue
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) {
      const date = new Date(parsed)
      const y = date.getUTCFullYear()
      const m = String(date.getUTCMonth() + 1).padStart(2, '0')
      const d = String(date.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
  }
  return null
}

function extractMainText(html: string): string {
  const blocks: string[] = []
  const selectors = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<div[^>]+(?:id|class)=["'][^"']*(?:content|article|main|detail|zw|news_content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
    /<section\b[^>]*>([\s\S]*?)<\/section>/gi,
  ]
  for (const re of selectors) {
    let match: RegExpExecArray | null
    while ((match = re.exec(html)) !== null) {
      const text = stripHtml(match[1] || '')
      if (text.length >= 80) blocks.push(text)
    }
  }
  if (blocks.length) {
    blocks.sort((a, b) => b.length - a.length)
    return blocks[0]
  }
  return stripHtml(html)
}

export function isLikelySearchResultPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hay = `${parsed.pathname}${parsed.search}`.toLowerCase()
    if (SEARCH_SHELL_HINTS.some((hint) => hay.includes(hint))) return true
    if (parsed.hostname.includes('cninfo.com.cn') && hay.includes('fulltext')) return true
    if (parsed.hostname.includes('stats.gov.cn') && hay.includes('/search')) return true
    if (parsed.hostname.includes('miit.gov.cn') && hay.includes('/search')) return true
    if (parsed.hostname.includes('gov.cn') && hay.includes('/search')) return true
    return false
  } catch {
    return false
  }
}

export function classifyFetchFailure(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('timeout') || lower.includes('etimedout') || lower.includes('超时')) return 'timeout'
  if (lower.includes('403') || lower.includes('401') || lower.includes('denied') || lower.includes('forbidden')) return 'access_denied'
  if (lower.includes('404') || lower.includes('not found')) return 'not_found'
  if (lower.includes('empty') || lower.includes('空')) return 'empty_body'
  if (lower.includes('search') || lower.includes('非详情')) return 'not_detail_page'
  return 'parse_or_network_failed'
}

export function isLikelyNonArticleDocument(url: string, html: string): boolean {
  if (NON_ARTICLE_EXTENSIONS.test(url)) return true
  const sample = html.trim().slice(0, 6000)
  if (!sample) return false
  if (/^@(?:charset|import|font-face|keyframes)\b/i.test(sample)) return true
  if (/^(?:var|let|const|function)\s+[\w$]+|^\(function\s*\(/i.test(sample)) return true

  const documentTags = sample.match(/<(?:html|head|body|title|meta|article|main|section|div|p|h[1-6])\b/gi)?.length ?? 0
  const cssSignals = sample.match(/(?:font-family|font-face|src\s*:\s*url|@media|display\s*:|\.\w[\w-]*\s*\{)/gi)?.length ?? 0
  return documentTags < 2 && cssSignals >= 2
}

export async function fetchResearchPage(url: string): Promise<ResearchFetchedPage> {
  if (isLikelySearchResultPage(url)) {
    return {
      url,
      title: url,
      summary: null,
      excerpt: null,
      status: 'failed',
      failureReason: '搜索结果页不能作为证据正文',
      failureCode: 'WEB_SEARCH_RESULT_PAGE_REJECTED',
      isDetailPage: false,
    }
  }

  try {
    const html = await fetchHtml(url)
    if (isLikelyNonArticleDocument(url, html)) {
      return {
        url,
        title: url,
        summary: null,
        excerpt: null,
        status: 'failed',
        failureReason: '静态样式、脚本或字体资源不能作为研究证据',
        failureCode: 'WEB_NON_ARTICLE_ASSET_REJECTED',
        isDetailPage: false,
      }
    }
    const text = extractMainText(html)
    if (!text) {
      return {
        url,
        title: url,
        summary: null,
        excerpt: null,
        status: 'failed',
        failureReason: '页面正文为空',
        failureCode: 'empty_body',
        isDetailPage: true,
      }
    }
    const title = extractTitle(html, url)
    const summary = extractMetaDescription(html) || text.slice(0, 280)
    const excerpt = text.slice(0, 1200)
    const publishedAt = extractPublishedAt(html)
    return {
      url,
      title,
      summary,
      excerpt,
      publishedAt,
      status: excerpt.length < 80 ? 'partial' : 'fetched',
      failureReason: excerpt.length < 80 ? '正文过短，仅保存有限摘录' : null,
      failureCode: excerpt.length < 80 ? 'short_body' : null,
      isDetailPage: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : '页面抓取失败'
    return {
      url,
      title: url,
      summary: null,
      excerpt: null,
      status: 'failed',
      failureReason: message,
      failureCode: classifyFetchFailure(message),
      isDetailPage: !isLikelySearchResultPage(url),
    }
  }
}
