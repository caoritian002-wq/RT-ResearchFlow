import type Database from 'better-sqlite3'
import { createHash } from 'crypto'
import type {
  ConditionBlockMatchRow,
  ConditionBlockScanRunRow,
  ConditionBlockTemplateRow,
  ConditionBlockDataStatus,
  ConditionBlockScanRunStatus,
} from './types'
import type { BlockStrategyTemplate, ConditionScanMatch } from '../services/conditionBlocks/types'
import { DEFAULT_CONDITION_BLOCK_TEMPLATES } from '../services/conditionBlocks/defaultTemplates'

const DEFAULT_SCAN_SCOPE_LIMITS = {
  dailyPrefilterLimit: 200,
  autoFetchMinuteLimit: 80,
  minuteFetchConcurrency: 1,
  minuteFetchIntervalMs: 1200,
  minuteFetchStopAfterFailures: 8,
}

function nowMs(): number {
  return Date.now()
}

function mapTemplateRow(row: any): ConditionBlockTemplateRow {
  return {
    id: row.id,
    templateKey: row.template_key,
    name: row.name,
    description: row.description,
    version: row.version,
    enabled: row.enabled,
    templateJson: row.template_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRunRow(row: any): ConditionBlockScanRunRow {
  return {
    id: row.id,
    templateId: row.template_id,
    templateKey: row.template_key,
    templateVersion: row.template_version,
    dateStart: row.date_start,
    dateEnd: row.date_end,
    scopeJson: row.scope_json,
    paramHash: row.param_hash,
    status: row.status,
    errorMessage: row.error_message,
    totalStocks: row.total_stocks,
    matchedCount: row.matched_count,
    summaryJson: row.summary_json,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function mapMatchRow(row: any): ConditionBlockMatchRow {
  return {
    id: row.id,
    runId: row.run_id,
    templateKey: row.template_key,
    templateVersion: row.template_version,
    tsCode: row.ts_code,
    stockName: row.stock_name,
    tradeDate: row.trade_date,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    totalScore: row.total_score,
    dataStatus: row.data_status,
    evidenceJson: row.evidence_json,
    createdAt: row.created_at,
  }
}

export function computeConditionParamHash(template: BlockStrategyTemplate): string {
  return createHash('sha256').update(JSON.stringify(template)).digest('hex')
}

function withDefaultScanScope(template: BlockStrategyTemplate): BlockStrategyTemplate {
  return {
    ...template,
    scope: {
      ...template.scope,
      dailyPrefilterLimit: template.scope.dailyPrefilterLimit ?? DEFAULT_SCAN_SCOPE_LIMITS.dailyPrefilterLimit,
      autoFetchMinuteLimit: template.scope.autoFetchMinuteLimit ?? DEFAULT_SCAN_SCOPE_LIMITS.autoFetchMinuteLimit,
      minuteFetchConcurrency: template.scope.minuteFetchConcurrency ?? DEFAULT_SCAN_SCOPE_LIMITS.minuteFetchConcurrency,
      minuteFetchIntervalMs: template.scope.minuteFetchIntervalMs ?? DEFAULT_SCAN_SCOPE_LIMITS.minuteFetchIntervalMs,
      minuteFetchStopAfterFailures: template.scope.minuteFetchStopAfterFailures ?? DEFAULT_SCAN_SCOPE_LIMITS.minuteFetchStopAfterFailures,
    },
  }
}

export function ensureDefaultConditionTemplates(db: Database.Database): void {
  const existing = db.prepare('SELECT COUNT(1) AS count FROM condition_block_templates').get() as { count: number }
  const insert = db.prepare(`
    INSERT INTO condition_block_templates
      (template_key, name, description, version, enabled, template_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const ts = nowMs()
  if (existing.count === 0) {
    const tx = db.transaction(() => {
      for (const template of DEFAULT_CONDITION_BLOCK_TEMPLATES) {
        insert.run(
          template.key,
          template.name,
          template.description,
          template.version,
          template.enabled ? 1 : 0,
          JSON.stringify(template),
          ts,
          ts,
        )
      }
    })
    tx()
    return
  }

  const update = db.prepare(`
    UPDATE condition_block_templates
    SET version = ?, template_json = ?, updated_at = ?
    WHERE id = ?
  `)
  const tx = db.transaction(() => {
    for (const defaultTemplate of DEFAULT_CONDITION_BLOCK_TEMPLATES) {
      const row = db.prepare('SELECT id, version, template_json FROM condition_block_templates WHERE template_key = ?').get(defaultTemplate.key) as { id: number; version: number; template_json: string } | undefined
      if (!row) {
        insert.run(
          defaultTemplate.key,
          defaultTemplate.name,
          defaultTemplate.description,
          defaultTemplate.version,
          defaultTemplate.enabled ? 1 : 0,
          JSON.stringify(defaultTemplate),
          ts,
          ts,
        )
        continue
      }
      try {
        const parsed = JSON.parse(row.template_json) as BlockStrategyTemplate
        const sources = parsed.scope?.stockPoolSources ?? []
        const needsAllMarket = !sources.includes('allMarket')
        const needsVersion = (row.version ?? 0) < defaultTemplate.version || (parsed.version ?? 0) < defaultTemplate.version
        const withLimits = withDefaultScanScope(parsed)
        const needsLimits = JSON.stringify(withLimits.scope) !== JSON.stringify(parsed.scope)
        if (!needsAllMarket && !needsVersion && !needsLimits) continue
        const baseTemplate = needsVersion ? defaultTemplate : withLimits
        const nextTemplate: BlockStrategyTemplate = {
          ...baseTemplate,
          version: Math.max(baseTemplate.version ?? 1, defaultTemplate.version),
          scope: {
            ...baseTemplate.scope,
            ...withLimits.scope,
            stockPoolSources: needsAllMarket ? ['allMarket', ...sources] : sources,
          },
        }
        update.run(nextTemplate.version, JSON.stringify(nextTemplate), ts, row.id)
      } catch {
        update.run(defaultTemplate.version, JSON.stringify(defaultTemplate), ts, row.id)
      }
    }
  })
  tx()
}

export function listConditionTemplates(db: Database.Database): ConditionBlockTemplateRow[] {
  ensureDefaultConditionTemplates(db)
  const rows = db.prepare(`
    SELECT * FROM condition_block_templates
    ORDER BY enabled DESC, updated_at DESC, id DESC
  `).all()
  return rows.map(mapTemplateRow)
}

export function getConditionTemplate(db: Database.Database, id: number): ConditionBlockTemplateRow | null {
  ensureDefaultConditionTemplates(db)
  const row = db.prepare('SELECT * FROM condition_block_templates WHERE id = ?').get(id)
  return row ? mapTemplateRow(row) : null
}

export function saveConditionTemplate(db: Database.Database, template: BlockStrategyTemplate, id?: number): ConditionBlockTemplateRow {
  const ts = nowMs()
  if (id) {
    db.prepare(`
      UPDATE condition_block_templates
      SET template_key = ?, name = ?, description = ?, version = ?, enabled = ?, template_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      template.key,
      template.name,
      template.description,
      template.version,
      template.enabled ? 1 : 0,
      JSON.stringify(template),
      ts,
      id,
    )
    const saved = getConditionTemplate(db, id)
    if (!saved) throw new Error('CONDITION_TEMPLATE_NOT_FOUND')
    return saved
  }

  const info = db.prepare(`
    INSERT INTO condition_block_templates
      (template_key, name, description, version, enabled, template_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    template.key,
    template.name,
    template.description,
    template.version,
    template.enabled ? 1 : 0,
    JSON.stringify(template),
    ts,
    ts,
  )
  const saved = getConditionTemplate(db, Number(info.lastInsertRowid))
  if (!saved) throw new Error('CONDITION_TEMPLATE_SAVE_FAILED')
  return saved
}

export function findCompletedConditionRun(db: Database.Database, paramHash: string): ConditionBlockScanRunRow | null {
  const row = db.prepare(`
    SELECT * FROM condition_block_scan_runs
    WHERE param_hash = ? AND status = 'completed'
    ORDER BY id DESC LIMIT 1
  `).get(paramHash)
  return row ? mapRunRow(row) : null
}

export function findConditionRunByParamHash(db: Database.Database, paramHash: string): ConditionBlockScanRunRow | null {
  const row = db.prepare(`
    SELECT * FROM condition_block_scan_runs
    WHERE param_hash = ?
    ORDER BY id DESC LIMIT 1
  `).get(paramHash)
  return row ? mapRunRow(row) : null
}

export function createConditionScanRun(db: Database.Database, params: {
  templateId: number
  templateKey: string
  templateVersion: number
  dateStart: string
  dateEnd: string
  scopeJson: string
  paramHash: string
}): number {
  const info = db.prepare(`
    INSERT INTO condition_block_scan_runs
      (template_id, template_key, template_version, date_start, date_end, scope_json, param_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(
    params.templateId,
    params.templateKey,
    params.templateVersion,
    params.dateStart,
    params.dateEnd,
    params.scopeJson,
    params.paramHash,
    nowMs(),
  )
  return Number(info.lastInsertRowid)
}

export function resetConditionScanRun(db: Database.Database, runId: number): void {
  const ts = nowMs()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM condition_block_matches WHERE run_id = ?').run(runId)
    db.prepare(`
      UPDATE condition_block_scan_runs
      SET status = 'running', error_message = NULL, total_stocks = 0, matched_count = 0,
          summary_json = NULL, created_at = ?, completed_at = NULL
      WHERE id = ?
    `).run(ts, runId)
  })
  tx()
}

export function completeConditionScanRun(db: Database.Database, params: {
  runId: number
  totalStocks: number
  matchedCount: number
  summaryJson: string
  matches: ConditionScanMatch[]
}): void {
  const insert = db.prepare(`
    INSERT INTO condition_block_matches
      (run_id, template_key, template_version, ts_code, stock_name, trade_date, window_start, window_end,
       total_score, data_status, evidence_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM condition_block_matches WHERE run_id = ?').run(params.runId)
    const ts = nowMs()
    for (const match of params.matches) {
      insert.run(
        params.runId,
        match.templateKey,
        match.templateVersion,
        match.tsCode,
        match.stockName,
        match.tradeDate,
        match.windowStart,
        match.windowEnd,
        match.totalScore,
        match.dataStatus,
        JSON.stringify(match.evidence),
        ts,
      )
    }
    db.prepare(`
      UPDATE condition_block_scan_runs
      SET status = 'completed', total_stocks = ?, matched_count = ?, summary_json = ?, completed_at = ?
      WHERE id = ?
    `).run(params.totalStocks, params.matchedCount, params.summaryJson, ts, params.runId)
  })
  tx()
}

export function failConditionScanRun(db: Database.Database, runId: number, errorMessage: string): void {
  db.prepare(`
    UPDATE condition_block_scan_runs
    SET status = 'failed', error_message = ?, completed_at = ?
    WHERE id = ?
  `).run(errorMessage, nowMs(), runId)
}

export function listConditionMatches(db: Database.Database, params: {
  templateKey?: string
  runId?: number
  limit?: number
  offset?: number
} = {}): ConditionBlockMatchRow[] {
  const clauses: string[] = []
  const args: unknown[] = []
  if (params.templateKey) { clauses.push('template_key = ?'); args.push(params.templateKey) }
  if (params.runId) { clauses.push('run_id = ?'); args.push(params.runId) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.max(1, Math.min(500, params.limit ?? 100))
  const offset = Math.max(0, params.offset ?? 0)
  const rows = db.prepare(`
    SELECT * FROM condition_block_matches
    ${where}
    ORDER BY trade_date DESC, total_score DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset)
  return rows.map(mapMatchRow)
}

export function getConditionMatch(db: Database.Database, id: number): ConditionBlockMatchRow | null {
  const row = db.prepare('SELECT * FROM condition_block_matches WHERE id = ?').get(id)
  return row ? mapMatchRow(row) : null
}

export function getConditionScanRun(db: Database.Database, runId: number): ConditionBlockScanRunRow | null {
  const row = db.prepare('SELECT * FROM condition_block_scan_runs WHERE id = ?').get(runId)
  return row ? mapRunRow(row) : null
}

export function latestConditionRunStats(db: Database.Database, templateKey: string): { lastRunAt: number | null; lastMatchCount: number | null } {
  const row = db.prepare(`
    SELECT created_at, matched_count FROM condition_block_scan_runs
    WHERE template_key = ? AND status = 'completed'
    ORDER BY id DESC LIMIT 1
  `).get(templateKey) as { created_at: number; matched_count: number | null } | undefined
  return { lastRunAt: row?.created_at ?? null, lastMatchCount: row?.matched_count ?? null }
}

export function normalizeConditionDataStatus(status: string | null | undefined): ConditionBlockDataStatus {
  if (status === 'complete' || status === 'partial' || status === 'data_insufficient') return status
  return 'partial'
}

export function normalizeConditionRunStatus(status: string | null | undefined): ConditionBlockScanRunStatus {
  if (status === 'running' || status === 'completed' || status === 'failed') return status
  return 'failed'
}
