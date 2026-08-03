import { getEnabledSources, updateSourceStatus, getSourceById } from '../database/sourceRepository'
import {
  findBriefingByUrlOrTitle,
  findSimilarSimhash,
  hashExists,
  insertBriefing,
  updateBriefingPublication,
} from '../database/briefingRepository'
import { createScanRun, completeScanRun } from '../database/scanRunRepository'
import { recordSuccessfulScan } from '../database/settingsRepository'
import { refreshArchiveForAffectedDates } from '../database/archiveRepository'
import { scrapeRss } from './scrapers/rssScraper'
import { fetchArticlePublication, scrapeHtml } from './scrapers/htmlScraper'
import { rateImpact } from './impactRater'
import { sha256, simhash } from '../utils/hashUtils'
import { utcToBjDate } from '../utils/dateUtils'
import type { Source } from '../database/types'
import type { ScrapeResult, RawArticle } from './scrapers/types'
import {
  canonicalizeArticleUrl,
  inferPublishedAtFromUrl,
  isLikelyArticleTitle,
  normalizeArticleTitle,
  validatePublicationTime,
} from './articlePublication'

export interface ScanEngineEvents {
  onScanStarted: (runId: number) => void
  onScanCompleted: (runId: number, newCount: number) => void
  onNewBriefings: (count: number) => void
  onSourceStatusChanged: (sourceId: number, status: string) => void
  onSourceProgress?: (
    sourceId: number,
    sourceName: string,
    url: string,
    status: 'PENDING' | 'SCANNING' | 'SUCCESS' | 'FAILED',
    newCount: number,
    error?: string
  ) => void
}

export type ScanRunTypeEnum = 'SCHEDULED' | 'MANUAL' | 'CATCH_UP'

let _events: ScanEngineEvents | null = null
let _isScanning = false
let _stopRequested = false

export function stopScan(): void {
  _stopRequested = true
}

export function setEventHandlers(events: ScanEngineEvents): void {
  _events = events
}

export function isScanning(): boolean {
  return _isScanning
}

export async function runScan(
  type: ScanRunTypeEnum,
  catchUpRange?: { start: number; end: number }
): Promise<{ runId: number; newBriefingsFound: number }> {
  if (_isScanning) {
    throw new Error('Scan already in progress')
  }

  _isScanning = true
  _stopRequested = false
  const runId = createScanRun(type, catchUpRange)
  _events?.onScanStarted(runId)

  const sources = getEnabledSources()
  const errors: string[] = []
  let newBriefingsFound = 0
  const affectedDates: string[] = []

  // Notify all sources as PENDING upfront
  for (const s of sources) {
    _events?.onSourceProgress?.(s.id, s.nameCN, s.url, 'PENDING', 0)
  }

  try {
    const CONCURRENCY = 5
    for (let i = 0; i < sources.length; i += CONCURRENCY) {
      if (_stopRequested) break
      const batch = sources.slice(i, i + CONCURRENCY)

      await Promise.all(
        batch.map(async (source) => {
          _events?.onSourceProgress?.(source.id, source.nameCN, source.url, 'SCANNING', 0)
          const result = await scrapeSource(source, catchUpRange)

          if (result.error) {
            console.log(`[scan] FAILED ${source.nameCN} (${source.url}): ${result.error}`)
            errors.push(`[${source.nameCN}] ${result.error}`)
            updateSourceStatus(result.sourceId, 'DEGRADED')
            _events?.onSourceStatusChanged(result.sourceId, 'DEGRADED')
            _events?.onSourceProgress?.(source.id, source.nameCN, source.url, 'FAILED', 0, result.error)
            return
          }

          console.log(`[scan] SUCCESS ${source.nameCN}: ${result.articles.length} articles`)

          updateSourceStatus(result.sourceId, 'ACTIVE', calculateSuccessRate(result))
          const inserted = await processScrapeResult(result, source, runId, type === 'CATCH_UP')
          newBriefingsFound += inserted.count
          affectedDates.push(...inserted.dates)
          _events?.onSourceProgress?.(source.id, source.nameCN, source.url, 'SUCCESS', inserted.count)
        })
      )
    }

    recordSuccessfulScan()
    refreshArchiveForAffectedDates(affectedDates)

    if (newBriefingsFound > 0) {
      _events?.onNewBriefings(newBriefingsFound)
    }
  } finally {
    completeScanRun(runId, { sourcesScanned: sources.length, newBriefingsFound, errors })
    _events?.onScanCompleted(runId, newBriefingsFound)
    _isScanning = false
    _stopRequested = false
  }

  return { runId, newBriefingsFound }
}


async function scrapeSource(
  source: Source,
  catchUpRange?: { start: number; end: number }
): Promise<ScrapeResult> {
  try {
    let result: ScrapeResult

    if (source.parseStrategy === 'RSS' || source.parseStrategy === 'ATOM') {
      result = await scrapeRss(source)
    } else {
      result = await scrapeHtml(source)
    }

    // Filter by catch-up range if provided
    if (catchUpRange && result.articles.length > 0) {
      result.articles = result.articles.filter((a) => {
        const scrapedCandidate = a.publishedAt == null
          ? null
          : {
              publishedAt: a.publishedAt,
              status: a.publicationTimeStatus ?? 'exact' as const,
            }
        const referenceTime = Date.now()
        const publication = validatePublicationTime(scrapedCandidate, referenceTime)
          ?? validatePublicationTime(inferPublishedAtFromUrl(a.url), referenceTime)
        if (publication) {
          a.publishedAt = publication.publishedAt
          a.publicationTimeStatus = publication.status
        } else {
          a.publishedAt = null
          delete a.publicationTimeStatus
        }
        if (!a.publishedAt) return true
        return a.publishedAt >= catchUpRange.start && a.publishedAt <= catchUpRange.end
      })
    }

    return result
  } catch (err) {
    return {
      sourceId: source.id,
      articles: [],
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function processScrapeResult(
  result: ScrapeResult,
  source: Source,
  scanRunId: number,
  isCatchUp: boolean
): Promise<{ count: number; dates: string[] }> {
  let count = 0
  const dates: string[] = []
  let remainingDetailTimeLookups = 12

  for (const article of result.articles) {
    if (!article.url || !isLikelyArticleTitle(article.title)) continue

    const collectedAt = Date.now()
    const title = normalizeArticleTitle(article.title)
    const originalUrl = canonicalizeArticleUrl(article.url)
    const scrapedCandidate = article.publishedAt == null
      ? null
      : {
          publishedAt: article.publishedAt,
          status: article.publicationTimeStatus ?? 'exact' as const,
        }
    let publication = validatePublicationTime(scrapedCandidate, collectedAt)
      ?? validatePublicationTime(inferPublishedAtFromUrl(originalUrl), collectedAt)
    const provisionalDate = utcToBjDate(publication?.publishedAt ?? collectedAt)
    const existing = findBriefingByUrlOrTitle(source.id, originalUrl, title, provisionalDate)

    if (existing) {
      if (existing.publicationTimeStatus === 'collected_fallback') {
        if (!publication && source.detailSelector && remainingDetailTimeLookups > 0) {
          remainingDetailTimeLookups--
          publication = validatePublicationTime(
            await fetchArticlePublication(originalUrl),
            collectedAt,
          )
        }
        if (publication) {
          const nextDate = utcToBjDate(publication.publishedAt)
          const updated = updateBriefingPublication(
            existing.id,
            publication.publishedAt,
            nextDate,
            publication.status,
          )
          if (updated.changed) dates.push(existing.publishedDateBJ, nextDate)
        }
      }
      continue
    }

    if (!publication && source.detailSelector && remainingDetailTimeLookups > 0) {
      remainingDetailTimeLookups--
      publication = validatePublicationTime(
        await fetchArticlePublication(originalUrl),
        collectedAt,
      )
    }

    const publishedAt = publication?.publishedAt ?? collectedAt
    const publishedDateBJ = utcToBjDate(publishedAt)
    const summary = buildSummary(article)
    const dedupHash = sha256(`${source.id}:${title}:${publishedDateBJ}`)
    const titleHash = simhash(title)

    // Layer 1: exact hash dedup
    if (hashExists(dedupHash)) continue

    // Layer 2: SimHash fuzzy dedup (same event across sources)
    const similar = findSimilarSimhash(titleHash, publishedAt)
    if (similar && similar.sourceId !== source.id) {
      // Keep only if this source has higher authority
      const existingSource = getSourceById(similar.sourceId)
      if (!existingSource || existingSource.authorityWeight >= source.authorityWeight) {
        continue // existing is equally or more authoritative
      }
    }

    const { rating, score } = rateImpact(article.title, summary, source.authorityWeight)

    const { inserted } = insertBriefing({
      sourceId: source.id,
      sourceName: source.nameCN,
      originalUrl,
      title,
      summary,
      fullContent: article.fullContent ?? null,
      publishedAt,
      publishedDateBJ,
      publicationTimeStatus: publication?.status ?? 'collected_fallback',
      collectedAt,
      impactRating: rating,
      impactRatingScore: score,
      deduplicationHash: dedupHash,
      titleSimhash: titleHash,
      isRead: 0,
      readAt: null,
      scanRunId,
      isCatchUp: isCatchUp ? 1 : 0
    })

    if (inserted) {
      count++
      dates.push(publishedDateBJ)
    }
  }

  return { count, dates }
}

function buildSummary(article: RawArticle): string {
  const text = article.summary ?? article.fullContent ?? article.title
  const clean = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  // Max 200 Chinese characters
  return clean.slice(0, 200)
}

function calculateSuccessRate(result: ScrapeResult): number {
  if (result.error) return 0
  return result.articles.length > 0 ? 1.0 : 0.5
}

