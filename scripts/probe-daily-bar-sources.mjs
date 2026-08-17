#!/usr/bin/env node
/**
 * Read-only public daily-bar provider probe.
 *
 * It verifies whether Eastmoney, Sina and Tencent responses can be transformed into the
 * existing RT-ResearchFlow DailyRow contract. It never reads API keys or writes
 * SQLite. The JSON report includes field coverage, unit checks, freshness,
 * cross-provider consistency and repeat-request stability.
 *
 * Usage:
 *   node scripts/probe-daily-bar-sources.mjs
 *   node scripts/probe-daily-bar-sources.mjs --codes 600487.SH,000001.SZ --bars 80 --rounds 3
 */

import crypto from 'node:crypto'
import {
  CANONICAL_DAILY_BAR_UNITS,
  compareCanonicalSeries,
  eastmoneySecId,
  normalizeTsCode,
  sinaSymbol,
  summarizeCanonicalCoverage,
  tencentSymbol,
  transformEastmoneyDailySeries,
  transformSinaDailySeries,
  transformTencentDailySeries,
  validateCanonicalDailyBar,
} from './lib/canonical-daily-bar-transformer.mjs'
import {
  estimatePublicRequestDurationMs,
  ProviderCoolingDownError,
  PublicRequestGovernor,
} from './lib/public-request-governor.mjs'

const args = parseArgs(process.argv.slice(2))
const codes = String(args.codes ?? '600487.SH,000001.SZ,300750.SZ,688981.SH,601318.SH,002594.SZ,830799.BJ,920799.BJ')
  .split(',')
  .map(normalizeTsCode)
  .filter(Boolean)
const bars = boundedInteger(args.bars, 80, 10, 1023)
const rounds = boundedInteger(args.rounds, 2, 1, 5)
const minIntervalMs = boundedInteger(args['min-interval'] ?? args.interval, 800, 0, 60_000)
const jitterMs = boundedInteger(args.jitter, 200, 0, 10_000)
const batchSize = boundedInteger(args['batch-size'], 400, 1, 10_000)
const batchPauseMs = boundedInteger(args['batch-pause'], 60_000, 0, 60 * 60_000)
const rateLimitCooldownMs = boundedInteger(args['rate-cooldown'], 30 * 60_000, 1, 24 * 60 * 60_000)
const failureCooldownMs = boundedInteger(args['failure-cooldown'], 15 * 60_000, 1, 24 * 60 * 60_000)
const consecutiveFailureLimit = boundedInteger(args['failure-limit'], 3, 1, 100)
const timeoutMs = boundedInteger(args.timeout, 15000, 1000, 30000)
const maxTradeDate = normalizeTradeDate(args.end ?? defaultMaxSettledDate())
const mode = normalizeMode(args.mode ?? 'fallback')
const governor = new PublicRequestGovernor({
  minIntervalMs,
  jitterMs,
  batchSize,
  batchPauseMs,
  rateLimitCooldownMs,
  failureCooldownMs,
  consecutiveFailureLimit,
})
const disabledProviders = new Map()

const HEADERS = {
  Accept: 'application/json,text/plain,*/*',
  Referer: 'https://finance.sina.com.cn/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36',
}

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

function normalizeTradeDate(value) {
  const compact = String(value ?? '').replaceAll('-', '')
  if (!/^\d{8}$/.test(compact)) throw new Error(`Invalid --end date: ${value}`)
  return compact
}

function normalizeMode(value) {
  const normalized = String(value).trim().toLowerCase()
  if (!['compare', 'fallback', 'eastmoney', 'sina', 'tencent'].includes(normalized)) {
    throw new Error(`Invalid --mode: ${value}`)
  }
  return normalized
}

function errorText(error) {
  if (!(error instanceof Error)) return String(error)
  const causeCode = typeof error.cause === 'object' && error.cause !== null && 'code' in error.cause
    ? String(error.cause.code)
    : null
  return causeCode ? `${error.name}:${causeCode}:${error.message}` : `${error.name}:${error.message}`
}

function defaultMaxSettledDate(now = Date.now()) {
  const beijing = new Date(now + 8 * 60 * 60 * 1000)
  if (beijing.getUTCHours() < 18) beijing.setUTCDate(beijing.getUTCDate() - 1)
  return beijing.toISOString().slice(0, 10).replaceAll('-', '')
}

function hashRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function eastmoneyUrl(tsCode) {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get')
  url.searchParams.set('secid', eastmoneySecId(tsCode))
  url.searchParams.set('klt', '101')
  url.searchParams.set('fqt', '0')
  url.searchParams.set('end', maxTradeDate)
  url.searchParams.set('lmt', String(bars))
  url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
  url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61')
  return url.toString()
}

function sinaUrl(tsCode) {
  const url = new URL('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData')
  url.searchParams.set('symbol', sinaSymbol(tsCode))
  url.searchParams.set('scale', '240')
  url.searchParams.set('ma', 'no')
  // One extra row is required because Sina does not expose pctChg directly.
  url.searchParams.set('datalen', String(Math.min(1023, bars + 1)))
  return url.toString()
}

function tencentUrl(tsCode) {
  const url = new URL('https://web.ifzq.gtimg.cn/appstock/app/kline/kline')
  url.searchParams.set('param', `${tencentSymbol(tsCode)},day,,,${Math.min(1023, bars + 1)}`)
  return url.toString()
}

async function fetchJson(provider, url) {
  const disabled = disabledProviders.get(provider)
  if (disabled) {
    return {
      ok: false,
      skipped: true,
      provider,
      status: 0,
      latencyMs: 0,
      queueWaitMs: 0,
      error: disabled,
    }
  }
  const startedAt = Date.now()
  try {
    const scheduled = await governor.run(provider, async () => {
      const requestStartedAt = Date.now()
      const response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const text = await response.text()
      return {
        status: response.status,
        ok: response.ok,
        text,
        networkLatencyMs: Date.now() - requestStartedAt,
      }
    })
    const response = scheduled.value
    let body = null
    try {
      body = JSON.parse(response.text)
    } catch {
      return {
        ok: false,
        provider,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        networkLatencyMs: response.networkLatencyMs,
        queueWaitMs: scheduled.queueWaitMs,
        error: 'RESPONSE_NOT_JSON',
        bodyPrefix: response.text.slice(0, 80),
      }
    }
    if ([403, 429, 456].includes(response.status)) disabledProviders.set(provider, `RATE_LIMITED_HTTP_${response.status}`)
    return {
      ok: response.ok,
      provider,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      networkLatencyMs: response.networkLatencyMs,
      queueWaitMs: scheduled.queueWaitMs,
      body,
      error: response.ok ? null : `HTTP_${response.status}`,
    }
  } catch (error) {
    if (error instanceof ProviderCoolingDownError) disabledProviders.set(provider, `${error.code}:${error.reason}`)
    return {
      ok: false,
      provider,
      status: 0,
      latencyMs: Date.now() - startedAt,
      networkLatencyMs: null,
      queueWaitMs: null,
      skipped: error instanceof ProviderCoolingDownError,
      error: errorText(error),
    }
  }
}

function skippedResponse(provider, reason) {
  return {
    ok: false,
    skipped: true,
    provider,
    status: 0,
    latencyMs: 0,
    networkLatencyMs: null,
    queueWaitMs: 0,
    error: reason,
  }
}

function rawUnitEvidence(eastmoneyKlines, sinaRows) {
  const eastByDate = new Map((eastmoneyKlines ?? []).flatMap((raw) => {
    const parts = String(raw).split(',')
    return parts.length >= 7 ? [[parts[0].replaceAll('-', ''), parts]] : []
  }))
  const volumeRatios = []
  const eastmoneyAmountRatios = []
  for (const row of Array.isArray(sinaRows) ? sinaRows : []) {
    const date = String(row?.day ?? '').replaceAll('-', '')
    if (date > maxTradeDate) continue
    const east = eastByDate.get(date)
    const eastVol = Number(east?.[5])
    const sinaVol = Number(row?.volume)
    if (eastVol > 0 && sinaVol > 0) volumeRatios.push(sinaVol / eastVol)
    const rawAmountYuan = Number(east?.[6])
    if (rawAmountYuan > 0) eastmoneyAmountRatios.push(rawAmountYuan / (rawAmountYuan / 1000))
  }
  const median = (values) => {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  }
  return {
    overlapRawVolumeDays: volumeRatios.length,
    medianRawVolumeRatioSinaSharesToEastmoneyHands: median(volumeRatios),
    expectedVolumeRatioBeforeTransform: 100,
    eastmoneyRawAmountYuanToCanonicalThousandRatio: median(eastmoneyAmountRatios),
    expectedAmountRatioBeforeTransform: 1000,
  }
}

function calendarLagDays(tradeDate) {
  if (!/^\d{8}$/.test(String(tradeDate ?? ''))) return null
  const parse = (value) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)))
  return Math.max(0, Math.round((parse(maxTradeDate) - parse(tradeDate)) / 86_400_000))
}

function providerResult(provider, response, transformed, rawRowCount) {
  const validations = transformed.rows.map(validateCanonicalDailyBar)
  return {
    provider,
    request: {
      ok: response.ok,
      skipped: response.skipped === true,
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      networkLatencyMs: response.networkLatencyMs ?? null,
      queueWaitMs: response.queueWaitMs ?? null,
      error: response.error,
    },
    rawRows: rawRowCount,
    canonicalRows: transformed.rows.length,
    rejectedRows: transformed.rejected.length,
    rejectionReasons: transformed.rejected.reduce((summary, row) => {
      for (const reason of row.reasons) summary[reason] = (summary[reason] ?? 0) + 1
      return summary
    }, {}),
    earliestTradeDate: transformed.rows[0]?.tradeDate ?? null,
    latestTradeDate: transformed.rows.at(-1)?.tradeDate ?? null,
    lagFromMaxTradeDateCalendarDays: calendarLagDays(transformed.rows.at(-1)?.tradeDate),
    fieldCoverage: summarizeCanonicalCoverage(transformed.rows),
    validationErrors: validations.reduce((count, item) => count + item.errors.length, 0),
    validationWarnings: validations.reduce((summary, item) => {
      for (const warning of item.warnings) summary[warning] = (summary[warning] ?? 0) + 1
      return summary
    }, {}),
    canonicalHash: hashRows(transformed.rows),
  }
}

async function probeCode(tsCode, round) {
  const shouldFetchEastmoney = mode !== 'sina' && mode !== 'tencent'
  const eastResponse = shouldFetchEastmoney
    ? await fetchJson('eastmoney', eastmoneyUrl(tsCode))
    : skippedResponse('eastmoney', 'MODE_SKIPPED')
  const eastKlines = eastResponse.ok && Array.isArray(eastResponse.body?.data?.klines)
    ? eastResponse.body.data.klines
    : []
  const east = transformEastmoneyDailySeries(tsCode, eastKlines, { maxTradeDate, limit: bars })
  const shouldFetchSina = mode === 'compare'
    || mode === 'sina'
    || (mode === 'fallback' && (!eastResponse.ok || east.rows.length === 0))
  const sinaResponse = shouldFetchSina
    ? await fetchJson('sina', sinaUrl(tsCode))
    : skippedResponse('sina', mode === 'fallback' ? 'PRIMARY_AVAILABLE' : 'MODE_SKIPPED')
  const sinaRows = sinaResponse.ok && Array.isArray(sinaResponse.body)
    ? sinaResponse.body
    : []
  const sina = transformSinaDailySeries(tsCode, sinaRows, { maxTradeDate, limit: bars })
  const shouldFetchTencent = mode === 'compare'
    || mode === 'tencent'
    || (mode === 'fallback'
      && (!eastResponse.ok || east.rows.length === 0)
      && (!sinaResponse.ok || sina.rows.length === 0))
  const tencentResponse = shouldFetchTencent
    ? await fetchJson('tencent', tencentUrl(tsCode))
    : skippedResponse('tencent', mode === 'fallback' ? 'EARLIER_PROVIDER_AVAILABLE' : 'MODE_SKIPPED')
  const symbol = tencentSymbol(tsCode)
  const tencentRows = tencentResponse.ok && Array.isArray(tencentResponse.body?.data?.[symbol]?.day)
    ? tencentResponse.body.data[symbol].day
    : []
  const tencent = transformTencentDailySeries(tsCode, tencentRows, { maxTradeDate, limit: bars })
  return {
    round,
    tsCode,
    eastmoney: providerResult('eastmoney', eastResponse, east, eastKlines.length),
    sina: providerResult('sina', sinaResponse, sina, sinaRows.length),
    tencent: providerResult('tencent', tencentResponse, tencent, tencentRows.length),
    unitEvidence: rawUnitEvidence(eastKlines, sinaRows),
    comparison: compareCanonicalSeries(east.rows, sina.rows),
    sinaTencentComparison: compareCanonicalSeries(sina.rows, tencent.rows),
  }
}

function summarize(results) {
  const latestRound = results.filter((item) => item.round === rounds)
  const stable = (provider, tsCode) => {
    const attempted = results.filter((item) => (
      item.tsCode === tsCode
      && !item[provider].request.skipped
      && item[provider].request.ok
      && item[provider].canonicalRows > 0
    ))
    const hashes = attempted.map((item) => item[provider].canonicalHash)
    return hashes.length === rounds && new Set(hashes).size === 1
  }
  const providerSummary = (provider) => {
    const rows = latestRound.map((item) => item[provider])
    const attempted = rows.filter((item) => !item.request.skipped)
    return {
      requests: attempted.length,
      skipped: rows.length - attempted.length,
      successfulRequests: attempted.filter((item) => item.request.ok).length,
      stocksWithCanonicalRows: attempted.filter((item) => item.canonicalRows > 0).length,
      amountCoverageStocks: attempted.filter((item) => item.fieldCoverage.fields.amount.rate > 0).length,
      turnoverCoverageStocks: attempted.filter((item) => item.fieldCoverage.fields.turnoverRate.rate > 0).length,
      stableAcrossRounds: codes.filter((code) => stable(provider, code)).length,
      averageNetworkLatencyMs: attempted.length > 0
        ? Math.round(attempted.reduce((sum, item) => sum + (item.request.networkLatencyMs ?? 0), 0) / attempted.length)
        : null,
    }
  }
  return {
    eastmoney: providerSummary('eastmoney'),
    sina: providerSummary('sina'),
    tencent: providerSummary('tencent'),
    compatibility: {
      eastmoney: {
        ohlcv: 'compatible',
        pctChg: 'direct_percent',
        amount: 'compatible_after_yuan_to_thousand',
        turnoverRate: 'direct_percent',
      },
      sina: {
        ohlcv: 'compatible_after_shares_to_hands',
        pctChg: 'derived_from_previous_close',
        amount: 'unavailable',
        turnoverRate: 'unavailable',
      },
      tencent: {
        ohlcv: 'compatible_with_hand_volume',
        pctChg: 'derived_from_previous_close',
        amount: 'unavailable',
        turnoverRate: 'unavailable',
      },
    },
  }
}

async function main() {
  if (codes.length === 0) throw new Error('No valid A-share codes')
  const startedAt = Date.now()
  const results = []
  for (let round = 1; round <= rounds; round += 1) {
    for (const code of codes) {
      results.push(await probeCode(code, round))
    }
  }
  const report = {
    probe: 'RT-ResearchFlow public daily-bar source compatibility',
    generatedAt: new Date().toISOString(),
    readOnly: true,
    writesDatabase: false,
    canonicalUnits: CANONICAL_DAILY_BAR_UNITS,
    parameters: {
      codes,
      bars,
      rounds,
      mode,
      minIntervalMs,
      jitterMs,
      batchSize,
      batchPauseMs,
      rateLimitCooldownMs,
      failureCooldownMs,
      consecutiveFailureLimit,
      timeoutMs,
      maxTradeDate,
    },
    durationMs: Date.now() - startedAt,
    requestGovernor: governor.snapshot(),
    projectedDuration: {
      fullMarketStocks: 5500,
      primaryOnlyMs: estimatePublicRequestDurationMs(5500, governor.snapshot().policy),
      dualSourceComparisonMs: estimatePublicRequestDurationMs(11_000, governor.snapshot().policy),
    },
    disabledProviders: Object.fromEntries(disabledProviders),
    summary: summarize(results),
    latestRound: results.filter((item) => item.round === rounds),
  }
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
