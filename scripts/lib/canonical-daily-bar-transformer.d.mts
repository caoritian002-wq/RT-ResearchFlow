export interface CanonicalDailyBar {
  tsCode: string
  tradeDate: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  pctChg: number | null
  vol: number | null
  amount: number | null
  turnoverRate: number | null
}

export function normalizeTsCode(value: unknown): string | null
export function sinaSymbol(value: unknown): string | null
export function tencentSymbol(value: unknown): string | null
export function transformSinaDailySeries(
  value: unknown,
  rawRows: unknown[],
  options?: { maxTradeDate?: string; limit?: number },
): { rows: CanonicalDailyBar[]; rejected: Array<{ provider: string; tradeDate: string | null; reasons: string[] }> }
export function transformTencentDailySeries(
  value: unknown,
  rawRows: unknown[],
  options?: { maxTradeDate?: string; limit?: number },
): { rows: CanonicalDailyBar[]; rejected: Array<{ provider: string; tradeDate: string | null; reasons: string[] }> }
export function transformSinaMarketSnapshotRows(
  rawRows: unknown[],
  tradeDate: string,
): { rows: CanonicalDailyBar[]; rejected: Array<{ provider: string; tsCode: string | null; reasons: string[] }> }
