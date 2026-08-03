import type Database from 'better-sqlite3'
import type { KplListRow } from './types'

function mapRow(r: Record<string, unknown>): KplListRow {
  return {
    tradeDate: r.trade_date as string,
    tsCode: r.ts_code as string,
    name: (r.name as string | null) ?? null,
    luTime: (r.lu_time as string | null) ?? null,
    luDesc: (r.lu_desc as string | null) ?? null,
    tag: (r.tag as string | null) ?? null,
    theme: (r.theme as string | null) ?? null,
    bidAmount: (r.bid_amount as number | null) ?? null,
    status: (r.status as string | null) ?? null,
    bidTurnover: (r.bid_turnover as number | null) ?? null,
    bidPctChg: (r.bid_pct_chg as number | null) ?? null,
    pctChg: (r.pct_chg as number | null) ?? null,
    fetchedAt: (r.fetched_at as number) ?? 0
  }
}

export function upsertConceptDaily(db: Database.Database, rows: KplListRow[]): void {
  if (rows.length === 0) return
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO kpl_concept_daily (
      trade_date, ts_code, name, lu_time, lu_desc, tag, theme,
      bid_amount, status, bid_turnover, bid_pct_chg, pct_chg, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction((items: KplListRow[]) => {
    for (const r of items) {
      stmt.run(
        r.tradeDate, r.tsCode, r.name, r.luTime, r.luDesc, r.tag, r.theme,
        r.bidAmount, r.status, r.bidTurnover, r.bidPctChg, r.pctChg, r.fetchedAt
      )
    }
  })
  tx(rows)
}

/** 按交易日期返回全部 kpl_list 行 */
export function getKplListByDate(db: Database.Database, tradeDate: string): KplListRow[] {
  const rows = db
    .prepare('SELECT * FROM kpl_concept_daily WHERE trade_date = ?')
    .all(tradeDate) as Record<string, unknown>[]
  return rows.map(mapRow)
}

/** 按交易日期 + tag 过滤（如 tag='涨停'） */
export function getKplListByDateAndTag(
  db: Database.Database,
  tradeDate: string,
  tag: string
): KplListRow[] {
  const rows = db
    .prepare('SELECT * FROM kpl_concept_daily WHERE trade_date = ? AND tag = ?')
    .all(tradeDate, tag) as Record<string, unknown>[]
  return rows.map(mapRow)
}

/**
 * 按 theme 聚合涨停数，用于计算题材热度（z_t_num）
 * 返回 Map<theme名称, 当日涨停数量>
 */
export function getThemeZtNumByDate(
  db: Database.Database,
  tradeDate: string
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT theme, COUNT(*) AS cnt
       FROM kpl_concept_daily
       WHERE trade_date = ? AND tag = '涨停' AND theme IS NOT NULL
       GROUP BY theme`
    )
    .all(tradeDate) as { theme: string; cnt: number }[]
  const map = new Map<string, number>()
  for (const r of rows) {
    map.set(r.theme, r.cnt)
  }
  return map
}

/** 返回 kpl_concept_daily 中最近有涨停数据的交易日，用于热点题材 fallback；无数据返回 null */
export function getLatestKplTradeDate(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT MAX(trade_date) AS latest FROM kpl_concept_daily WHERE tag = '涨停'`)
    .get() as { latest: string | null }
  return row?.latest ?? null
}

export function cleanupOlderThan(db: Database.Database, days = 90): number {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const threshold = new Date(bjNow.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  const info = db.prepare('DELETE FROM kpl_concept_daily WHERE trade_date < ?').run(threshold)
  return info.changes
}
