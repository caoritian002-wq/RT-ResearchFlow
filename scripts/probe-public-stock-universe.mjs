#!/usr/bin/env node

import { PublicRequestGovernor } from './lib/public-request-governor.mjs'
import {
  deduplicateStockUniverse,
  transformSinaStockUniverseRows,
} from './lib/public-stock-universe-transformer.mjs'

const args = parseArgs(process.argv.slice(2))
// Sina silently caps this endpoint at 100 rows even when a larger num is sent.
// Keep the real page contract explicit so a capped first page is not mistaken
// for the end of the A-share universe.
const pageSize = boundedInteger(args['page-size'], 100, 50, 100)
const maxPages = boundedInteger(args['max-pages'], 80, 1, 100)
const sampleSize = boundedInteger(args['sample-size'], 0, 0, 5_000)
const timeoutMs = boundedInteger(args.timeout, 15_000, 1000, 30_000)
const governor = new PublicRequestGovernor({
  minIntervalMs: boundedInteger(args['min-interval'], 800, 0, 60_000),
  jitterMs: boundedInteger(args.jitter, 200, 0, 10_000),
  batchSize: boundedInteger(args['batch-size'], 400, 1, 10_000),
  batchPauseMs: boundedInteger(args['batch-pause'], 60_000, 0, 60 * 60_000),
})

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) result[key] = true
    else {
      result[key] = next
      index += 1
    }
  }
  return result
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(minimum, Math.min(maximum, parsed))
}

function pageUrl(page) {
  const url = new URL('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData')
  url.searchParams.set('page', String(page))
  url.searchParams.set('num', String(pageSize))
  url.searchParams.set('sort', 'symbol')
  url.searchParams.set('asc', '1')
  url.searchParams.set('node', 'hs_a')
  return url.toString()
}

async function fetchPage(page) {
  const scheduled = await governor.run('sina-universe', async () => {
    const startedAt = Date.now()
    const response = await fetch(pageUrl(page), {
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121 Safari/537.36',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    return { status: response.status, text, networkLatencyMs: Date.now() - startedAt }
  })
  if (scheduled.value.status !== 200) throw new Error(`SINA_UNIVERSE_HTTP_${scheduled.value.status}`)
  const body = JSON.parse(scheduled.value.text)
  if (!Array.isArray(body)) throw new Error('SINA_UNIVERSE_INVALID_RESPONSE')
  return {
    page,
    rawRows: body,
    networkLatencyMs: scheduled.value.networkLatencyMs,
    queueWaitMs: scheduled.queueWaitMs,
  }
}

function segmentCounts(rows) {
  const counts = { SH: 0, SZ: 0, BJ: 0, STAR: 0, CHINEXT: 0 }
  for (const row of rows) {
    if (row.tsCode.endsWith('.BJ')) counts.BJ += 1
    else if (row.tsCode.startsWith('688')) counts.STAR += 1
    else if (/^(300|301)/.test(row.tsCode)) counts.CHINEXT += 1
    else if (row.tsCode.endsWith('.SH')) counts.SH += 1
    else if (row.tsCode.endsWith('.SZ')) counts.SZ += 1
  }
  return counts
}

function segmentKey(row) {
  if (row.tsCode.endsWith('.BJ')) return 'BJ'
  if (row.tsCode.startsWith('688')) return 'STAR'
  if (/^(300|301)/.test(row.tsCode)) return 'CHINEXT'
  if (row.tsCode.endsWith('.SH')) return 'SH'
  return 'SZ'
}

function stratifiedSampleCodes(rows, requestedSize) {
  if (requestedSize <= 0) return []
  const groups = new Map(['SH', 'SZ', 'CHINEXT', 'STAR', 'BJ'].map(key => [key, []]))
  for (const row of rows) groups.get(segmentKey(row))?.push(row.tsCode)
  const result = []
  const perGroup = Math.floor(requestedSize / groups.size)
  for (const values of groups.values()) result.push(...values.slice(0, perGroup))
  if (result.length < requestedSize) {
    const selected = new Set(result)
    for (const row of rows) {
      if (result.length >= requestedSize) break
      if (!selected.has(row.tsCode)) {
        selected.add(row.tsCode)
        result.push(row.tsCode)
      }
    }
  }
  return result
}

async function main() {
  const startedAt = Date.now()
  const pages = []
  const transformedRows = []
  const rejected = []
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage(page)
    const transformed = transformSinaStockUniverseRows(result.rawRows)
    pages.push({
      page,
      rawRows: result.rawRows.length,
      canonicalRows: transformed.rows.length,
      networkLatencyMs: result.networkLatencyMs,
      queueWaitMs: result.queueWaitMs,
    })
    transformedRows.push(...transformed.rows)
    rejected.push(...transformed.rejected)
    if (result.rawRows.length < pageSize) break
  }
  const deduplicated = deduplicateStockUniverse(transformedRows)
  console.log(JSON.stringify({
    probe: 'RT-ResearchFlow public stock universe',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    writesDatabase: false,
    parameters: { pageSize, maxPages, sampleSize, timeoutMs },
    durationMs: Date.now() - startedAt,
    requestGovernor: governor.snapshot(),
    pages,
    coverage: {
      rawRows: transformedRows.length + rejected.length,
      canonicalRowsBeforeDeduplication: transformedRows.length,
      uniqueStocks: deduplicated.rows.length,
      rejectedRows: rejected.length,
      identityConflicts: deduplicated.conflicts.length,
      segments: segmentCounts(deduplicated.rows),
      earliestCode: deduplicated.rows[0]?.tsCode ?? null,
      latestCode: deduplicated.rows.at(-1)?.tsCode ?? null,
    },
    sampleCodes: stratifiedSampleCodes(deduplicated.rows, sampleSize),
    rejected: rejected.slice(0, 20),
    conflicts: deduplicated.conflicts.slice(0, 20),
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
