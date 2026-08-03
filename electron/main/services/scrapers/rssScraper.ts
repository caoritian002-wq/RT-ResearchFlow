import Parser from 'rss-parser'
import { parsePublishedDate } from '../../utils/dateUtils'
import type { Source } from '../../database/types'
import type { RawArticle, ScrapeResult } from './types'

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (compatible; TradeWatcher/1.0; +https://github.com/trade-watcher)'
  }
})

export async function scrapeRss(source: Source): Promise<ScrapeResult> {
  const feedUrl = source.feedUrl ?? source.url
  try {
    const feed = await parser.parseURL(feedUrl)
    const articles: RawArticle[] = (feed.items ?? []).map((item) => {
      const publishedAt = parsePublishedDate(item.pubDate ?? item.isoDate ?? null)
      return {
        title: (item.title ?? '').trim(),
        url: item.link ?? item.guid ?? '',
        publishedAt,
        publicationTimeStatus: publishedAt == null ? undefined : 'exact',
        summary: stripHtml(item.contentSnippet ?? item.summary ?? item.content ?? '').slice(0, 500),
        fullContent: item.content ?? item['content:encoded'] ?? undefined
      }
    })
    return { sourceId: source.id, articles: articles.filter((a) => a.title && a.url) }
  } catch (err) {
    return {
      sourceId: source.id,
      articles: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()
}
