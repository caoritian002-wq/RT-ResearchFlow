export interface RawArticle {
  title: string
  url: string
  publishedAt: number | null // UTC ms, null if unparseable
  publicationTimeStatus?: 'exact' | 'date_only'
  summary?: string
  fullContent?: string
}

export interface ScrapeResult {
  sourceId: number
  articles: RawArticle[]
  error?: string
}
