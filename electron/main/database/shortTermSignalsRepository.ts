import type Database from 'better-sqlite3'
import type { ShortTermSignalRow } from './types'

function mapRow(r: Record<string, unknown>): ShortTermSignalRow {
  return {
    id: r.id as number,
    strategy: r.strategy as string,
    tsCode: (r.ts_code as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    triggerAt: (r.trigger_at as number | null) ?? null,
    tradeDate: (r.trade_date as string | null) ?? null,
    signalStrength: (r.signal_strength as number | null) ?? null,
    signalMeta: (r.signal_meta as string | null) ?? null,
    createdAt: (r.created_at as number) ?? 0
  }
}

export type ShortTermSignalInsert = Omit<ShortTermSignalRow, 'id' | 'createdAt'>

export function insertSignal(db: Database.Database, row: ShortTermSignalInsert): number {
  const info = db
    .prepare(
      `INSERT INTO short_term_signals (
        strategy, ts_code, name, trigger_at, trade_date, signal_strength, signal_meta, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.strategy, row.tsCode, row.name, row.triggerAt, row.tradeDate,
      row.signalStrength, row.signalMeta, Date.now()
    )
  return info.lastInsertRowid as number
}

export function insertSignalsBatch(db: Database.Database, rows: ShortTermSignalInsert[]): number {
  if (rows.length === 0) return 0
  const stmt = db.prepare(`
    INSERT INTO short_term_signals (
      strategy, ts_code, name, trigger_at, trade_date, signal_strength, signal_meta, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const now = Date.now()
  let count = 0
  const tx = db.transaction((items: ShortTermSignalInsert[]) => {
    for (const r of items) {
      stmt.run(
        r.strategy, r.tsCode, r.name, r.triggerAt, r.tradeDate,
        r.signalStrength, r.signalMeta, now
      )
      count++
    }
  })
  tx(rows)
  return count
}

/** 同一策略、同一事实日只保留最后一次完整快照，避免刷新产生重复信号。 */
export function replaceSignalsByStrategyAndDate(
  db: Database.Database,
  strategy: string,
  tradeDate: string,
  rows: ShortTermSignalInsert[]
): number {
  const deleteStmt = db.prepare('DELETE FROM short_term_signals WHERE strategy = ? AND trade_date = ?')
  const insertStmt = db.prepare(`
    INSERT INTO short_term_signals (
      strategy, ts_code, name, trigger_at, trade_date, signal_strength, signal_meta, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const replace = db.transaction(() => {
    deleteStmt.run(strategy, tradeDate)
    const now = Date.now()
    for (const row of rows) {
      insertStmt.run(
        strategy,
        row.tsCode,
        row.name,
        row.triggerAt,
        tradeDate,
        row.signalStrength,
        row.signalMeta,
        now
      )
    }
    return rows.length
  })
  return replace()
}

export function getSignalsByStrategy(
  db: Database.Database,
  strategy: string,
  tradeDate?: string,
  limit?: number
): ShortTermSignalRow[] {
  const params: unknown[] = []
  let sql = 'SELECT * FROM short_term_signals WHERE strategy = ?'
  params.push(strategy)
  if (tradeDate) {
    sql += ' AND trade_date = ?'
    params.push(tradeDate)
  }
  sql += ' ORDER BY trigger_at DESC, id DESC'
  if (limit && limit > 0) {
    sql += ' LIMIT ?'
    params.push(limit)
  }
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(mapRow)
}

/** Match strategy by exact value or LIKE prefix when caller passes 'foo.*' wildcard form. */
export function deleteSignalsByStrategyAndDate(
  db: Database.Database,
  strategy: string,
  tradeDate: string
): number {
  const usesPrefix = strategy.endsWith('.*')
  if (usesPrefix) {
    const prefix = strategy.slice(0, -1) // 'foo.*' → 'foo.'
    const info = db
      .prepare('DELETE FROM short_term_signals WHERE strategy LIKE ? AND trade_date = ?')
      .run(prefix + '%', tradeDate)
    return info.changes
  }
  const info = db
    .prepare('DELETE FROM short_term_signals WHERE strategy = ? AND trade_date = ?')
    .run(strategy, tradeDate)
  return info.changes
}

export function cleanupOlderThan(db: Database.Database, days = 30): number {
  const bjNow = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const threshold = new Date(bjNow.getTime() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
  const info = db.prepare('DELETE FROM short_term_signals WHERE trade_date < ? OR trade_date IS NULL').run(threshold)
  return info.changes
}
