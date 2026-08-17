#!/usr/bin/env node

import {
  summarizeCanonicalCoverage,
  transformSinaMarketSnapshotRows,
  validateCanonicalDailyBar,
} from './lib/canonical-daily-bar-transformer.mjs'
import { PublicRequestGovernor } from './lib/public-request-governor.mjs'

const governor = new PublicRequestGovernor({
  minIntervalMs: 800,
  jitterMs: 200,
  batchSize: 400,
  batchPauseMs: 60_000,
})
const headers = {
  Referer: 'https://finance.sina.com.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121 Safari/537.36',
}

async function governedText(provider, url) {
  const result = await governor.run(provider, async () => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    return { status: response.status, text: await response.text() }
  })
  if (result.value.status !== 200) throw new Error(`${provider.toUpperCase()}_HTTP_${result.value.status}`)
  return result.value.text
}

function parseTradeClock(text) {
  const match = text.match(/,(\d{4}-\d{2}-\d{2}),(\d{2}:\d{2}:\d{2})(?:,|")/)
  return match ? { tradeDate: match[1].replaceAll('-', ''), quoteTime: match[2] } : null
}

async function main() {
  const quoteText = await governedText('sina', 'https://hq.sinajs.cn/list=sh000001')
  const clock = parseTradeClock(quoteText)
  if (!clock) throw new Error('SINA_QUOTE_CLOCK_UNAVAILABLE')

  const pageUrl = new URL('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData')
  pageUrl.searchParams.set('page', '1')
  pageUrl.searchParams.set('num', '100')
  pageUrl.searchParams.set('sort', 'symbol')
  pageUrl.searchParams.set('asc', '1')
  pageUrl.searchParams.set('node', 'hs_a')
  const pageText = await governedText('sina', pageUrl.toString())
  const rawRows = JSON.parse(pageText)
  if (!Array.isArray(rawRows)) throw new Error('SINA_SNAPSHOT_INVALID_RESPONSE')
  const transformed = transformSinaMarketSnapshotRows(rawRows, clock.tradeDate)
  const warnings = transformed.rows.flatMap((row) => validateCanonicalDailyBar(row).warnings)
  console.log(JSON.stringify({
    probe: 'RT-ResearchFlow public daily snapshot',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    writesDatabase: false,
    requestGovernor: governor.snapshot(),
    quoteClock: clock,
    settled: clock.quoteTime >= '15:00:00',
    rawRows: rawRows.length,
    canonicalRows: transformed.rows.length,
    rejectedRows: transformed.rejected.length,
    coverage: summarizeCanonicalCoverage(transformed.rows),
    unitWarnings: Object.fromEntries([...new Set(warnings)].map((warning) => [warning, warnings.filter((item) => item === warning).length])),
    samples: transformed.rows.slice(0, 3),
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
