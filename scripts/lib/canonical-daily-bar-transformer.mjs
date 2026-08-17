/**
 * Canonical daily-bar contract used by RT-ResearchFlow.
 *
 * The contract mirrors electron/main/services/tushareService.ts DailyRow:
 * - prices: CNY per share, unadjusted
 * - pctChg / turnoverRate: percentage points
 * - vol: hands (100 shares)
 * - amount: CNY thousand
 * - tradeDate: YYYYMMDD
 */

export const CANONICAL_DAILY_BAR_UNITS = Object.freeze({
  price: 'CNY_PER_SHARE_UNADJUSTED',
  pctChg: 'PERCENTAGE_POINTS',
  vol: 'HANDS_100_SHARES',
  amount: 'CNY_THOUSAND',
  turnoverRate: 'PERCENTAGE_POINTS',
  tradeDate: 'YYYYMMDD',
})

export const CANONICAL_DAILY_BAR_FIELDS = Object.freeze([
  'tsCode',
  'tradeDate',
  'open',
  'high',
  'low',
  'close',
  'pctChg',
  'vol',
  'amount',
  'turnoverRate',
])

const SHANGHAI_PREFIX = /^(600|601|603|605|688|689|900)/
const BEIJING_PREFIX = /^(4|8|920)/

function finiteNumber(value) {
  if (value == null || value === '' || value === '-') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round((value + Number.EPSILON) * scale) / scale
}

export function normalizeTsCode(value) {
  const clean = String(value ?? '').trim().toUpperCase()
  const explicit = clean.match(/^(\d{6})\.(SH|SZ|BJ)$/)
  if (explicit) return `${explicit[1]}.${explicit[2]}`
  if (!/^\d{6}$/.test(clean)) return null
  if (SHANGHAI_PREFIX.test(clean)) return `${clean}.SH`
  if (BEIJING_PREFIX.test(clean)) return `${clean}.BJ`
  return `${clean}.SZ`
}

export function eastmoneySecId(value) {
  const tsCode = normalizeTsCode(value)
  if (!tsCode) return null
  const code = tsCode.slice(0, 6)
  return `${tsCode.endsWith('.SH') ? '1' : '0'}.${code}`
}

export function sinaSymbol(value) {
  const tsCode = normalizeTsCode(value)
  if (!tsCode) return null
  const code = tsCode.slice(0, 6)
  if (tsCode.endsWith('.SH')) return `sh${code}`
  if (tsCode.endsWith('.BJ')) return `bj${code}`
  return `sz${code}`
}

export function tencentSymbol(value) {
  const tsCode = normalizeTsCode(value)
  if (!tsCode) return null
  const code = tsCode.slice(0, 6)
  if (tsCode.endsWith('.SH')) return `sh${code}`
  if (tsCode.endsWith('.BJ')) return `bj${code}`
  return `sz${code}`
}

function normalizeDate(value) {
  const compact = String(value ?? '').replaceAll('-', '').replaceAll('/', '')
  return /^\d{8}$/.test(compact) ? compact : null
}

function normalizeParsedSeries(tsCode, parsedRows, provider, options = {}) {
  const maxTradeDate = /^\d{8}$/.test(String(options.maxTradeDate ?? '')) ? String(options.maxTradeDate) : null
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null
  const sorted = parsedRows
    .filter((row) => row.tradeDate && row.close != null && row.close > 0)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
  const rows = []
  const rejected = []
  let previousClose = null

  for (const parsed of sorted) {
    if (maxTradeDate && parsed.tradeDate > maxTradeDate) {
      rejected.push({ provider, tradeDate: parsed.tradeDate, reasons: ['AFTER_MAX_TRADE_DATE'] })
      continue
    }
    const pctChg = parsed.pctChg ?? (
      previousClose != null && previousClose > 0
        ? round(((parsed.close - previousClose) / previousClose) * 100)
        : null
    )
    const row = {
      tsCode,
      tradeDate: parsed.tradeDate,
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      close: parsed.close,
      pctChg,
      vol: parsed.vol,
      amount: parsed.amount,
      turnoverRate: parsed.turnoverRate,
    }
    previousClose = parsed.close
    const validation = validateCanonicalDailyBar(row)
    if (validation.ok) rows.push(row)
    else rejected.push({ provider, tradeDate: parsed.tradeDate, reasons: validation.errors })
  }

  return { rows: limit ? rows.slice(-limit) : rows, rejected }
}

export function transformEastmoneyDailySeries(value, klines, options = {}) {
  const tsCode = normalizeTsCode(value)
  if (!tsCode) throw new TypeError(`Invalid A-share code: ${value}`)
  const parsedRows = []
  const rejected = []

  for (const raw of Array.isArray(klines) ? klines : []) {
    const parts = String(raw).split(',')
    const tradeDate = normalizeDate(parts[0])
    const close = finiteNumber(parts[2])
    if (parts.length < 7 || !tradeDate || close == null || close <= 0) {
      rejected.push({ provider: 'eastmoney', tradeDate, reasons: ['RAW_ROW_INVALID'] })
      continue
    }
    const amountYuan = finiteNumber(parts[6])
    parsedRows.push({
      tradeDate,
      open: finiteNumber(parts[1]),
      close,
      high: finiteNumber(parts[3]),
      low: finiteNumber(parts[4]),
      // Eastmoney f56 is already expressed in hands.
      vol: finiteNumber(parts[5]),
      // Eastmoney f57 is CNY; the project contract is CNY thousand.
      amount: amountYuan == null ? null : round(amountYuan / 1000),
      pctChg: finiteNumber(parts[8]),
      turnoverRate: finiteNumber(parts[10]),
    })
  }

  const normalized = normalizeParsedSeries(tsCode, parsedRows, 'eastmoney', options)
  return { rows: normalized.rows, rejected: [...rejected, ...normalized.rejected] }
}

export function transformSinaDailySeries(value, rawRows, options = {}) {
  const tsCode = normalizeTsCode(value)
  if (!tsCode) throw new TypeError(`Invalid A-share code: ${value}`)
  const parsedRows = []
  const rejected = []

  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const tradeDate = normalizeDate(raw?.day)
    const close = finiteNumber(raw?.close)
    if (!tradeDate || close == null || close <= 0) {
      rejected.push({ provider: 'sina', tradeDate, reasons: ['RAW_ROW_INVALID'] })
      continue
    }
    const volumeShares = finiteNumber(raw?.volume)
    parsedRows.push({
      tradeDate,
      open: finiteNumber(raw?.open),
      high: finiteNumber(raw?.high),
      low: finiteNumber(raw?.low),
      close,
      // Sina daily K-line volume is shares; the project contract is hands.
      vol: volumeShares == null ? null : round(volumeShares / 100),
      // This endpoint does not expose amount or turnover rate.
      amount: null,
      turnoverRate: null,
      // This endpoint does not expose pctChg; derive it from the prior raw close.
      pctChg: null,
    })
  }

  const normalized = normalizeParsedSeries(tsCode, parsedRows, 'sina', options)
  return { rows: normalized.rows, rejected: [...rejected, ...normalized.rejected] }
}

export function transformTencentDailySeries(value, rawRows, options = {}) {
  const tsCode = normalizeTsCode(value)
  if (!tsCode) throw new TypeError(`Invalid A-share code: ${value}`)
  const parsedRows = []
  const rejected = []

  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const tradeDate = normalizeDate(raw?.[0])
    const close = finiteNumber(raw?.[2])
    if (!Array.isArray(raw) || raw.length < 6 || !tradeDate || close == null || close <= 0) {
      rejected.push({ provider: 'tencent', tradeDate, reasons: ['RAW_ROW_INVALID'] })
      continue
    }
    parsedRows.push({
      tradeDate,
      open: finiteNumber(raw[1]),
      close,
      high: finiteNumber(raw[3]),
      low: finiteNumber(raw[4]),
      // Tencent daily K-line volume already matches the project hand unit.
      vol: finiteNumber(raw[5]),
      amount: null,
      turnoverRate: null,
      pctChg: null,
    })
  }

  const normalized = normalizeParsedSeries(tsCode, parsedRows, 'tencent', options)
  return { rows: normalized.rows, rejected: [...rejected, ...normalized.rejected] }
}

export function transformSinaMarketSnapshotRows(rawRows, tradeDateValue) {
  const tradeDate = normalizeDate(tradeDateValue)
  if (!tradeDate) throw new TypeError(`Invalid snapshot trade date: ${tradeDateValue}`)
  const rows = []
  const rejected = []
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const symbol = String(raw?.symbol ?? '').trim().toLowerCase()
    const code = String(raw?.code ?? '').trim()
    const suffix = symbol.startsWith('sh') ? 'SH' : symbol.startsWith('sz') ? 'SZ' : symbol.startsWith('bj') ? 'BJ' : null
    const tsCode = suffix ? normalizeTsCode(`${code}.${suffix}`) : null
    const close = finiteNumber(raw?.trade)
    const previousClose = finiteNumber(raw?.settlement)
    const pctChg = finiteNumber(raw?.changepercent) ?? (
      close != null && previousClose != null && previousClose > 0
        ? round(((close - previousClose) / previousClose) * 100)
        : null
    )
    const volumeShares = finiteNumber(raw?.volume)
    const amountYuan = finiteNumber(raw?.amount)
    const row = {
      tsCode,
      tradeDate,
      open: finiteNumber(raw?.open),
      high: finiteNumber(raw?.high),
      low: finiteNumber(raw?.low),
      close,
      pctChg,
      vol: volumeShares == null ? null : round(volumeShares / 100),
      amount: amountYuan == null ? null : round(amountYuan / 1000),
      turnoverRate: finiteNumber(raw?.turnoverratio),
    }
    const validation = validateCanonicalDailyBar(row)
    if (validation.ok) rows.push(row)
    else rejected.push({ provider: 'sina_snapshot', tsCode, reasons: validation.errors })
  }
  return { rows, rejected }
}

export function validateCanonicalDailyBar(row) {
  const errors = []
  const warnings = []
  const requiredNumbers = ['open', 'high', 'low', 'close', 'pctChg']

  if (!normalizeTsCode(row?.tsCode) || normalizeTsCode(row?.tsCode) !== row?.tsCode) errors.push('TS_CODE_INVALID')
  if (!/^\d{8}$/.test(String(row?.tradeDate ?? ''))) errors.push('TRADE_DATE_INVALID')
  for (const field of requiredNumbers) {
    if (!Number.isFinite(row?.[field])) errors.push(`${field.toUpperCase()}_MISSING`)
  }
  if (Number.isFinite(row?.close) && row.close <= 0) errors.push('CLOSE_NON_POSITIVE')
  if (Number.isFinite(row?.vol) && row.vol < 0) errors.push('VOL_NEGATIVE')
  if (Number.isFinite(row?.amount) && row.amount < 0) errors.push('AMOUNT_NEGATIVE')
  if (Number.isFinite(row?.turnoverRate) && row.turnoverRate < 0) errors.push('TURNOVER_NEGATIVE')

  if ([row?.open, row?.high, row?.low, row?.close].every(Number.isFinite)) {
    if (row.high < row.low || row.open > row.high || row.open < row.low || row.close > row.high || row.close < row.low) {
      errors.push('OHLC_RANGE_INVALID')
    }
  }

  let averagePrice = null
  if (Number.isFinite(row?.amount) && Number.isFinite(row?.vol) && row.vol > 0) {
    // amount(k CNY) * 1000 / (vol(hands) * 100 shares)
    averagePrice = round((row.amount * 10) / row.vol)
    if (Number.isFinite(row.low) && Number.isFinite(row.high)) {
      const lower = row.low * 0.98
      const upper = row.high * 1.02
      if (averagePrice < lower || averagePrice > upper) warnings.push('AMOUNT_VOLUME_UNIT_SUSPECT')
    }
  }

  return { ok: errors.length === 0, errors, warnings, derived: { averagePrice } }
}

export function summarizeCanonicalCoverage(rows) {
  const total = rows.length
  const fields = {}
  for (const field of CANONICAL_DAILY_BAR_FIELDS) {
    const populated = rows.filter((row) => row[field] != null).length
    fields[field] = { populated, total, rate: total === 0 ? 0 : round(populated / total, 4) }
  }
  const warnings = {}
  for (const row of rows) {
    for (const warning of validateCanonicalDailyBar(row).warnings) {
      warnings[warning] = (warnings[warning] ?? 0) + 1
    }
  }
  return { total, fields, warnings }
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : null
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function compareCanonicalSeries(leftRows, rightRows) {
  const rightByDate = new Map(rightRows.map((row) => [row.tradeDate, row]))
  const pairs = leftRows.flatMap((left) => {
    const right = rightByDate.get(left.tradeDate)
    return right ? [{ left, right }] : []
  })
  const priceDiffs = pairs.flatMap(({ left, right }) => ['open', 'high', 'low', 'close'].map((field) => Math.abs(left[field] - right[field])))
  const pctDiffs = pairs.map(({ left, right }) => Math.abs(left.pctChg - right.pctChg))
  const volumeRatios = pairs.flatMap(({ left, right }) => left.vol > 0 && right.vol > 0 ? [right.vol / left.vol] : [])

  return {
    overlapTradeDays: pairs.length,
    firstOverlapTradeDate: pairs[0]?.left.tradeDate ?? null,
    lastOverlapTradeDate: pairs.at(-1)?.left.tradeDate ?? null,
    maxPriceAbsoluteDiff: round(maximum(priceDiffs)),
    maxPctChgPointDiff: round(maximum(pctDiffs)),
    medianNormalizedVolumeRatioRightToLeft: round(median(volumeRatios)),
  }
}
