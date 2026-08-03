import type Database from 'better-sqlite3'
import type { TopListDailyRow } from './types'

function mapRow(r: Record<string, unknown>): TopListDailyRow {
  return {
    tradeDate: r.trade_date as string,
    tsCode: r.ts_code as string,
    name: (r.name as string | null) ?? null,
    close: (r.close as number | null) ?? null,
    pctChange: (r.pct_change as number | null) ?? null,
    turnoverRate: (r.turnover_rate as number | null) ?? null,
    amount: (r.amount as number | null) ?? null,
    lSell: (r.l_sell as number | null) ?? null,
    lBuy: (r.l_buy as number | null) ?? null,
    lAmount: (r.l_amount as number | null) ?? null,
    netAmount: (r.net_amount as number | null) ?? null,
    netRate: (r.net_rate as number | null) ?? null,
    amountRate: (r.amount_rate as number | null) ?? null,
    floatValues: (r.float_values as number | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    fetchedAt: (r.fetched_at as number) ?? 0
  }
}

export function upsertTopList(db: Database.Database, rows: TopListDailyRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO top_list_daily (
      trade_date, ts_code, name, close, pct_change, turnover_rate, amount,
      l_sell, l_buy, l_amount, net_amount, net_rate, amount_rate, float_values,
      reason, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction((items: TopListDailyRow[]) => {
    for (const r of items) {
      stmt.run(
        r.tradeDate, r.tsCode, r.name, r.close, r.pctChange, r.turnoverRate, r.amount,
        r.lSell, r.lBuy, r.lAmount, r.netAmount, r.netRate, r.amountRate, r.floatValues,
        r.reason, r.fetchedAt
      )
    }
  })
  tx(rows)
}

export function getTopListByDate(db: Database.Database, tradeDate: string): TopListDailyRow[] {
  const rows = db
    .prepare('SELECT * FROM top_list_daily WHERE trade_date = ? ORDER BY net_amount DESC')
    .all(tradeDate) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export function getStockTopHistory(
  db: Database.Database,
  tsCode: string,
  days = 30
): TopListDailyRow[] {
  const rows = db
    .prepare('SELECT * FROM top_list_daily WHERE ts_code = ? ORDER BY trade_date DESC LIMIT ?')
    .all(tsCode, days) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export function cleanupOlderThan(db: Database.Database, days = 180): number {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const threshold = new Date(bjNow.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  const info = db.prepare('DELETE FROM top_list_daily WHERE trade_date < ?').run(threshold)
  return info.changes
}
