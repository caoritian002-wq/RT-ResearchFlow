import { normalizeTsCode } from './canonical-daily-bar-transformer.mjs'

function inferMarketBoard(code, suffix) {
  if (suffix === 'BJ') return '北交所'
  if (/^(300|301)/.test(code)) return '创业板'
  if (/^(688|689)/.test(code)) return '科创板'
  if (suffix === 'SH' || suffix === 'SZ') return '主板'
  return null
}

export function transformSinaStockUniverseRows(rawRows) {
  const rows = []
  const rejected = []
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const symbol = String(raw?.symbol ?? '').trim().toLowerCase()
    const code = String(raw?.code ?? '').trim()
    const name = String(raw?.name ?? '').trim()
    const suffix = symbol.startsWith('sh') ? 'SH' : symbol.startsWith('sz') ? 'SZ' : symbol.startsWith('bj') ? 'BJ' : null
    const tsCode = suffix ? normalizeTsCode(`${code}.${suffix}`) : null
    const market = suffix ? inferMarketBoard(code, suffix) : null
    if (!tsCode || !name || !market || !/^\d{6}$/.test(code)) {
      rejected.push({ symbol, code, reason: 'INVALID_SECURITY_IDENTITY' })
      continue
    }
    rows.push({
      tsCode,
      name,
      market,
      listStatus: 'L',
      industry: null,
      circFloat: null,
      source: 'sina-market-center-hs-a',
    })
  }
  return { rows, rejected }
}

export function deduplicateStockUniverse(rows) {
  const byCode = new Map()
  const conflicts = []
  for (const row of rows) {
    const existing = byCode.get(row.tsCode)
    if (existing && existing.name !== row.name) {
      conflicts.push({ tsCode: row.tsCode, names: [existing.name, row.name] })
      continue
    }
    byCode.set(row.tsCode, row)
  }
  return {
    rows: [...byCode.values()].sort((a, b) => a.tsCode.localeCompare(b.tsCode)),
    conflicts,
  }
}
