import type Database from 'better-sqlite3'
import type {
  DecisionSignalEventRow,
  DecisionSignalEventType,
  DecisionSignalResolution,
  DecisionSignalRow,
  DecisionSignalStatus,
  DecisionSignalType,
  DecisionSignalSourceModule,
} from './types'

export interface DecisionSignalFilters {
  sourceModules?: DecisionSignalSourceModule[]
  statuses?: DecisionSignalStatus[]
  types?: DecisionSignalType[]
  minPriority?: number
  tsCode?: string
  conceptCode?: string
  limit?: number
}

export type DecisionSignalUpsert = Omit<DecisionSignalRow, 'id'>

function mapRow(r: Record<string, unknown>): DecisionSignalRow {
  return {
    id: r.id as number,
    sourceModule: r.source_module as DecisionSignalSourceModule,
    strategyKey: r.strategy_key as string,
    tsCode: (r.ts_code as string | null) ?? null,
    stockName: (r.stock_name as string | null) ?? null,
    conceptCode: (r.concept_code as string | null) ?? null,
    conceptName: (r.concept_name as string | null) ?? null,
    signalType: r.signal_type as DecisionSignalType,
    direction: r.direction as DecisionSignalRow['direction'],
    priority: r.priority as number,
    score: r.score as number | null,
    confidence: r.confidence as number | null,
    title: r.title as string,
    summary: r.summary as string,
    reasonJson: r.reason_json as string | null,
    sourceRefJson: r.source_ref_json as string | null,
    status: r.status as DecisionSignalStatus,
    dedupKey: r.dedup_key as string,
    signalTime: r.signal_time as number,
    expireAt: r.expire_at as number | null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    firstSeenAt: (r.first_seen_at as number | null | undefined) ?? (r.created_at as number),
    lastSeenAt: (r.last_seen_at as number | null | undefined) ?? (r.signal_time as number),
    occurrenceCount: (r.occurrence_count as number | undefined) ?? 1,
    acknowledgedAt: (r.acknowledged_at as number | null | undefined) ?? null,
    watchedAt: (r.watched_at as number | null | undefined) ?? null,
    dismissedAt: (r.dismissed_at as number | null | undefined) ?? null,
    resolvedAt: (r.resolved_at as number | null | undefined) ?? null,
    resolution: (r.resolution as DecisionSignalResolution | null | undefined) ?? null,
    resolutionNote: (r.resolution_note as string | null | undefined) ?? null,
  }
}

function mapEventRow(r: Record<string, unknown>): DecisionSignalEventRow {
  return {
    id: r.id as number,
    signalId: r.signal_id as number,
    eventType: r.event_type as DecisionSignalEventType,
    fromStatus: (r.from_status as DecisionSignalStatus | null) ?? null,
    toStatus: (r.to_status as DecisionSignalStatus | null) ?? null,
    resolution: (r.resolution as DecisionSignalResolution | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as number,
  }
}

export function upsertDecisionSignal(
  db: Database.Database,
  row: DecisionSignalUpsert
): { signal: DecisionSignalRow; inserted: boolean } {
  const existing = getDecisionSignalByDedupKey(db, row.dedupKey)

  if (existing == null) {
    db.prepare(`
      INSERT INTO decision_signals (
        source_module, strategy_key, ts_code, stock_name, concept_code, concept_name,
        signal_type, direction, priority, score, confidence, title, summary,
        reason_json, source_ref_json, status, dedup_key, signal_time, expire_at, created_at, updated_at,
        first_seen_at, last_seen_at, occurrence_count
      ) VALUES (
        @sourceModule, @strategyKey, @tsCode, @stockName, @conceptCode, @conceptName,
        @signalType, @direction, @priority, @score, @confidence, @title, @summary,
        @reasonJson, @sourceRefJson, @status, @dedupKey, @signalTime, @expireAt, @createdAt, @updatedAt,
        @createdAt, @signalTime, 1
      )
    `).run(row)
  } else {
    const nextStatus = existing.status === 'WATCHING' || existing.status === 'DISMISSED'
      ? existing.status
      : existing.status === 'EXPIRED'
        ? row.status
        : existing.status
    const nextPriority = Math.max(existing.priority, row.priority)
    if (!hasMaterialSignalChange(existing, row, nextStatus, nextPriority)) {
      return { signal: existing, inserted: false }
    }
    db.prepare(`
      UPDATE decision_signals
      SET source_module = @sourceModule,
          strategy_key = @strategyKey,
          ts_code = @tsCode,
          stock_name = @stockName,
          concept_code = @conceptCode,
          concept_name = @conceptName,
          signal_type = @signalType,
          direction = @direction,
          priority = @nextPriority,
          score = @score,
          confidence = @confidence,
          title = @title,
          summary = @summary,
          reason_json = @reasonJson,
          source_ref_json = @sourceRefJson,
          status = @nextStatus,
          signal_time = @signalTime,
          last_seen_at = @signalTime,
          occurrence_count = occurrence_count + 1,
          expire_at = @expireAt,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({ ...row, id: existing.id, nextStatus, nextPriority })
  }

  const signal = getDecisionSignalByDedupKey(db, row.dedupKey)
  if (!signal) throw new Error(`decision signal not found after upsert: ${row.dedupKey}`)
  if (existing == null) {
    insertDecisionSignalEvent(db, {
      signalId: signal.id,
      eventType: 'CREATED',
      toStatus: signal.status,
      createdAt: row.createdAt,
    })
  } else {
    insertDecisionSignalEvent(db, {
      signalId: signal.id,
      eventType: 'UPDATED',
      fromStatus: existing.status,
      toStatus: signal.status,
      createdAt: row.updatedAt,
    })
  }
  return { signal, inserted: existing == null }
}

function hasMaterialSignalChange(
  existing: DecisionSignalRow,
  row: DecisionSignalUpsert,
  nextStatus: DecisionSignalStatus,
  nextPriority: number
): boolean {
  return existing.sourceModule !== row.sourceModule
    || existing.strategyKey !== row.strategyKey
    || existing.tsCode !== row.tsCode
    || existing.stockName !== row.stockName
    || existing.conceptCode !== row.conceptCode
    || existing.conceptName !== row.conceptName
    || existing.signalType !== row.signalType
    || existing.direction !== row.direction
    || existing.priority !== nextPriority
    || existing.score !== row.score
    || existing.confidence !== row.confidence
    || existing.title !== row.title
    || existing.summary !== row.summary
    || existing.reasonJson !== row.reasonJson
    || existing.sourceRefJson !== row.sourceRefJson
    || existing.status !== nextStatus
    || existing.signalTime !== row.signalTime
    || existing.expireAt !== row.expireAt
}

export function upsertDecisionSignals(db: Database.Database, rows: DecisionSignalUpsert[]): DecisionSignalRow[] {
  if (rows.length === 0) return []
  const result: DecisionSignalRow[] = []
  const tx = db.transaction((items: DecisionSignalUpsert[]) => {
    for (const item of items) {
      result.push(upsertDecisionSignal(db, item).signal)
    }
  })
  tx(rows)
  return result
}

export function getDecisionSignalById(db: Database.Database, id: number): DecisionSignalRow | null {
  const row = db.prepare('SELECT * FROM decision_signals WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

export function getDecisionSignalByDedupKey(db: Database.Database, dedupKey: string): DecisionSignalRow | null {
  const row = db.prepare('SELECT * FROM decision_signals WHERE dedup_key = ?').get(dedupKey) as Record<string, unknown> | undefined
  return row ? mapRow(row) : null
}

export function queryDecisionSignalsByTimeRange(
  db: Database.Database,
  startMs: number,
  endMs: number,
  filters: DecisionSignalFilters = {}
): DecisionSignalRow[] {
  const params: unknown[] = [startMs, endMs]
  const where = ['signal_time >= ?', 'signal_time < ?']

  if (filters.sourceModules?.length) {
    where.push(`source_module IN (${filters.sourceModules.map(() => '?').join(',')})`)
    params.push(...filters.sourceModules)
  }
  if (filters.statuses?.length) {
    where.push(`status IN (${filters.statuses.map(() => '?').join(',')})`)
    params.push(...filters.statuses)
  }
  if (filters.types?.length) {
    where.push(`signal_type IN (${filters.types.map(() => '?').join(',')})`)
    params.push(...filters.types)
  }
  if (filters.minPriority != null) {
    where.push('priority >= ?')
    params.push(filters.minPriority)
  }
  if (filters.tsCode) {
    where.push('ts_code = ?')
    params.push(filters.tsCode)
  }
  if (filters.conceptCode) {
    where.push('concept_code = ?')
    params.push(filters.conceptCode)
  }

  let sql = `SELECT * FROM decision_signals WHERE ${where.join(' AND ')} ORDER BY priority DESC, signal_time DESC, id DESC`
  if (filters.limit && filters.limit > 0) {
    sql += ' LIMIT ?'
    params.push(filters.limit)
  }
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(mapRow)
}

export function updateDecisionSignalStatus(
  db: Database.Database,
  id: number,
  status: DecisionSignalStatus,
  updatedAt = Date.now(),
  detail: { eventType?: DecisionSignalEventType; reason?: string | null; note?: string | null } = {}
): boolean {
  const before = getDecisionSignalById(db, id)
  const info = db
    .prepare(`
      UPDATE decision_signals
      SET status = ?,
          updated_at = ?,
          acknowledged_at = CASE WHEN ? = 'READ' THEN ? ELSE acknowledged_at END,
          watched_at = CASE WHEN ? = 'WATCHING' THEN ? ELSE watched_at END,
          dismissed_at = CASE WHEN ? = 'DISMISSED' THEN ? ELSE dismissed_at END
      WHERE id = ?
    `)
    .run(status, updatedAt, status, updatedAt, status, updatedAt, status, updatedAt, id)
  if (info.changes > 0) {
    insertDecisionSignalEvent(db, {
      signalId: id,
      eventType: detail.eventType ?? statusToEventType(status),
      fromStatus: before?.status ?? null,
      toStatus: status,
      reason: detail.reason ?? null,
      note: detail.note ?? null,
      createdAt: updatedAt,
    })
  }
  return info.changes > 0
}

export function expireDecisionSignals(db: Database.Database, now = Date.now()): number {
  const rows = db
    .prepare(`
      SELECT id, status FROM decision_signals
      WHERE expire_at IS NOT NULL
        AND expire_at <= ?
        AND status IN ('NEW', 'READ')
    `)
    .all(now) as { id: number; status: DecisionSignalStatus }[]
  const info = db
    .prepare(`
      UPDATE decision_signals
      SET status = 'EXPIRED', updated_at = ?
      WHERE expire_at IS NOT NULL
        AND expire_at <= ?
        AND status IN ('NEW', 'READ')
    `)
    .run(now, now)
  for (const row of rows) {
    insertDecisionSignalEvent(db, {
      signalId: row.id,
      eventType: 'EXPIRED',
      fromStatus: row.status,
      toStatus: 'EXPIRED',
      createdAt: now,
    })
  }
  return info.changes
}

export interface DecisionSignalEventInsert {
  signalId: number
  eventType: DecisionSignalEventType
  fromStatus?: DecisionSignalStatus | null
  toStatus?: DecisionSignalStatus | null
  resolution?: DecisionSignalResolution | null
  reason?: string | null
  note?: string | null
  createdAt?: number
}

export function insertDecisionSignalEvent(db: Database.Database, event: DecisionSignalEventInsert): DecisionSignalEventRow {
  const createdAt = event.createdAt ?? Date.now()
  const info = db.prepare(`
    INSERT INTO decision_signal_events (
      signal_id, event_type, from_status, to_status, resolution, reason, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.signalId,
    event.eventType,
    event.fromStatus ?? null,
    event.toStatus ?? null,
    event.resolution ?? null,
    event.reason ?? null,
    event.note ?? null,
    createdAt
  )
  const row = db.prepare('SELECT * FROM decision_signal_events WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>
  return mapEventRow(row)
}

export function getDecisionSignalEvents(db: Database.Database, signalId: number): DecisionSignalEventRow[] {
  const rows = db
    .prepare('SELECT * FROM decision_signal_events WHERE signal_id = ? ORDER BY created_at ASC, id ASC')
    .all(signalId) as Record<string, unknown>[]
  return rows.map(mapEventRow)
}

export function resolveDecisionSignalStatus(
  db: Database.Database,
  id: number,
  resolution: DecisionSignalResolution,
  note: string | null,
  updatedAt = Date.now()
): boolean {
  const before = getDecisionSignalById(db, id)
  const info = db
    .prepare('UPDATE decision_signals SET resolution = ?, resolution_note = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
    .run(resolution, note, updatedAt, updatedAt, id)
  if (info.changes > 0) {
    insertDecisionSignalEvent(db, {
      signalId: id,
      eventType: 'RESOLVED',
      fromStatus: before?.status ?? null,
      toStatus: before?.status ?? null,
      resolution,
      note,
      createdAt: updatedAt,
    })
  }
  return info.changes > 0
}

function statusToEventType(status: DecisionSignalStatus): DecisionSignalEventType {
  if (status === 'READ') return 'READ'
  if (status === 'WATCHING') return 'WATCHED'
  if (status === 'DISMISSED') return 'DISMISSED'
  if (status === 'EXPIRED') return 'EXPIRED'
  return 'UPDATED'
}

export function cleanupDecisionSignals(db: Database.Database, keepDays = 180, now = Date.now()): number {
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000
  const info = db.prepare("DELETE FROM decision_signals WHERE created_at < ? AND status != 'WATCHING'").run(cutoff)
  return info.changes
}
