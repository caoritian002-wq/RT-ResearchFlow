export interface CanonicalStockIdentity {
  tsCode: string
  name: string
  market: '主板' | '创业板' | '科创板' | '北交所'
  listStatus: 'L'
  industry: null
  circFloat: null
  source: 'sina-market-center-hs-a'
}

export function transformSinaStockUniverseRows(rawRows: unknown[]): {
  rows: CanonicalStockIdentity[]
  rejected: Array<{ symbol: string; code: string; reason: string }>
}

export function deduplicateStockUniverse(rows: CanonicalStockIdentity[]): {
  rows: CanonicalStockIdentity[]
  conflicts: Array<{ tsCode: string; names: string[] }>
}
