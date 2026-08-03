import type Database from 'better-sqlite3'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'

export const RESEARCH_ACCESS_AUDIT_LIMIT = 10_000
export const RESEARCH_ACCESS_SCOPES = ['market.read', 'research.read', 'portfolio.read'] as const

export type ResearchAccessScope = typeof RESEARCH_ACCESS_SCOPES[number]
export type ResearchAccessSurface = 'mcp' | 'cli'
export type ResearchAccessOperation = 'create' | 'update' | 'rotate' | 'revoke'

export interface ResearchAccessProfile {
  id: string
  name: string
  scopes: ResearchAccessScope[]
  enabled: boolean
  credentialVersion: number
  scopeVersion: number
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

interface ResearchAccessProfileRow {
  id: string
  name: string
  credential_hash: string
  credential_version: number
  scopes_json: string
  scope_version: number
  enabled: number
  created_at: number
  updated_at: number
  last_used_at: number | null
  revoked_at: number | null
}

interface OperationReceiptRow {
  request_id: string
  operation: ResearchAccessOperation
  profile_id: string
  created_at: number
}

export interface ResearchAccessAuditInput {
  requestId: string
  sessionId?: string | null
  profileId?: string | null
  profileNameSnapshot?: string | null
  surface: ResearchAccessSurface
  externalToolName?: string | null
  toolId?: string | null
  inputSha256?: string | null
  inputSummaryJson?: string | null
  asOf?: string | null
  decision: 'allowed' | 'blocked'
  scopeVersion?: number | null
  toolStatus?: string | null
  errorCode?: string | null
  durationMs: number
  resultBytes: number
  resultSha256?: string | null
  createdAt: number
}

export interface ResearchAccessAuditEntry extends ResearchAccessAuditInput {
  id: number
}

interface ResearchAccessAuditRow {
  id: number
  request_id: string
  session_id: string | null
  profile_id: string | null
  profile_name_snapshot: string | null
  surface: ResearchAccessSurface
  external_tool_name: string | null
  tool_id: string | null
  input_sha256: string | null
  input_summary_json: string | null
  as_of: string | null
  decision: 'allowed' | 'blocked'
  scope_version: number | null
  tool_status: string | null
  error_code: string | null
  duration_ms: number
  result_bytes: number
  result_sha256: string | null
  created_at: number
}

export class ResearchAccessRepositoryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'ResearchAccessRepositoryError'
  }
}

export interface ResearchAccessCredentialResult {
  profile: ResearchAccessProfile
  credential: string | null
  replayed: boolean
}

export function createResearchAccessProfile(
  db: Database.Database,
  input: {
    requestId: string
    name: string
    scopes: ResearchAccessScope[]
    now?: number
    id?: string
  },
): ResearchAccessCredentialResult {
  const now = input.now ?? Date.now()
  const existing = getOperationReceipt(db, input.requestId)
  if (existing) return replayCredentialOperation(db, existing, 'create')

  const id = input.id ?? randomUUID()
  const credential = generateResearchAccessCredential()
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO research_access_profiles (
        id, name, credential_hash, credential_version, scopes_json,
        scope_version, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, 1, 1, ?, ?)
    `).run(id, input.name, hashResearchAccessCredential(credential), serializeScopes(input.scopes), now, now)
    insertOperationReceipt(db, input.requestId, 'create', id, now)
  })
  transaction()
  return { profile: requireResearchAccessProfile(db, id), credential, replayed: false }
}

export function updateResearchAccessProfile(
  db: Database.Database,
  input: {
    requestId: string
    profileId: string
    name?: string
    scopes?: ResearchAccessScope[]
    enabled?: boolean
    now?: number
  },
): ResearchAccessProfile {
  const now = input.now ?? Date.now()
  const existing = getOperationReceipt(db, input.requestId)
  if (existing) return replayProfileOperation(db, existing, 'update')
  const current = requireMutableResearchAccessProfileRow(db, input.profileId)
  const nextName = input.name ?? current.name
  const nextScopes = input.scopes ?? parseScopes(current.scopes_json)
  const nextEnabled = input.scopes?.length === 0
    ? 0
    : input.enabled == null ? current.enabled : Number(input.enabled)
  const nextScopeVersion = input.scopes == null ? current.scope_version : current.scope_version + 1

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE research_access_profiles
      SET name = ?, scopes_json = ?, scope_version = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(nextName, serializeScopes(nextScopes), nextScopeVersion, nextEnabled, now, input.profileId)
    insertOperationReceipt(db, input.requestId, 'update', input.profileId, now)
  })
  transaction()
  return requireResearchAccessProfile(db, input.profileId)
}

export function rotateResearchAccessCredential(
  db: Database.Database,
  input: { requestId: string; profileId: string; now?: number },
): ResearchAccessCredentialResult {
  const now = input.now ?? Date.now()
  const existing = getOperationReceipt(db, input.requestId)
  if (existing) return replayCredentialOperation(db, existing, 'rotate')
  requireMutableResearchAccessProfileRow(db, input.profileId)
  const credential = generateResearchAccessCredential()
  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE research_access_profiles
      SET credential_hash = ?, credential_version = credential_version + 1, updated_at = ?
      WHERE id = ?
    `).run(hashResearchAccessCredential(credential), now, input.profileId)
    insertOperationReceipt(db, input.requestId, 'rotate', input.profileId, now)
  })
  transaction()
  return { profile: requireResearchAccessProfile(db, input.profileId), credential, replayed: false }
}

export function revokeResearchAccessProfile(
  db: Database.Database,
  input: { requestId: string; profileId: string; now?: number },
): ResearchAccessProfile {
  const now = input.now ?? Date.now()
  const existing = getOperationReceipt(db, input.requestId)
  if (existing) return replayProfileOperation(db, existing, 'revoke')
  const current = requireResearchAccessProfileRow(db, input.profileId)
  if (current.revoked_at == null) {
    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE research_access_profiles
        SET enabled = 0, revoked_at = ?, updated_at = ?,
            credential_version = credential_version + 1,
            scope_version = scope_version + 1
        WHERE id = ?
      `).run(now, now, input.profileId)
      insertOperationReceipt(db, input.requestId, 'revoke', input.profileId, now)
    })
    transaction()
  } else {
    insertOperationReceipt(db, input.requestId, 'revoke', input.profileId, now)
  }
  return requireResearchAccessProfile(db, input.profileId)
}

export function listResearchAccessProfiles(db: Database.Database): ResearchAccessProfile[] {
  const rows = db.prepare(`
    SELECT * FROM research_access_profiles
    ORDER BY CASE WHEN revoked_at IS NULL THEN 0 ELSE 1 END, updated_at DESC, id
  `).all() as ResearchAccessProfileRow[]
  return rows.map(mapProfile)
}

export function getResearchAccessProfile(
  db: Database.Database,
  profileId: string,
): ResearchAccessProfile | null {
  const row = getResearchAccessProfileRow(db, profileId)
  return row ? mapProfile(row) : null
}

export function authenticateResearchAccessProfile(
  db: Database.Database,
  profileId: string,
  credential: string,
): ResearchAccessProfile | null {
  const row = getResearchAccessProfileRow(db, profileId)
  if (!row || row.revoked_at != null || row.enabled !== 1) return null
  return credentialMatches(row.credential_hash, credential) ? mapProfile(row) : null
}

export function markResearchAccessProfileUsed(
  db: Database.Database,
  profileId: string,
  usedAt: number,
): void {
  db.prepare(`
    UPDATE research_access_profiles
    SET last_used_at = CASE
      WHEN last_used_at IS NULL OR last_used_at < ? THEN ?
      ELSE last_used_at
    END
    WHERE id = ? AND revoked_at IS NULL
  `).run(usedAt, usedAt, profileId)
}

export function appendResearchAccessAudit(
  db: Database.Database,
  input: ResearchAccessAuditInput,
): ResearchAccessAuditEntry {
  const transaction = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO research_access_audit (
        request_id, session_id, profile_id, profile_name_snapshot, surface,
        external_tool_name, tool_id, input_sha256, input_summary_json, as_of,
        decision, scope_version, tool_status, error_code, duration_ms,
        result_bytes, result_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.requestId,
      input.sessionId ?? null,
      input.profileId ?? null,
      input.profileNameSnapshot ?? null,
      input.surface,
      input.externalToolName ?? null,
      input.toolId ?? null,
      input.inputSha256 ?? null,
      input.inputSummaryJson ?? null,
      input.asOf ?? null,
      input.decision,
      input.scopeVersion ?? null,
      input.toolStatus ?? null,
      input.errorCode ?? null,
      Math.max(0, Math.trunc(input.durationMs)),
      Math.max(0, Math.trunc(input.resultBytes)),
      input.resultSha256 ?? null,
      input.createdAt,
    )
    db.prepare(`
      DELETE FROM research_access_audit
      WHERE id < COALESCE((
        SELECT id FROM research_access_audit
        ORDER BY id DESC
        LIMIT 1 OFFSET ?
      ), 0)
    `).run(RESEARCH_ACCESS_AUDIT_LIMIT - 1)
    return Number(result.lastInsertRowid)
  })
  return requireResearchAccessAudit(db, transaction())
}

export function listResearchAccessAudit(
  db: Database.Database,
  input: {
    profileId?: string | null
    surface?: ResearchAccessSurface | null
    toolStatus?: string | null
    cursor?: number | null
    limit?: number
  } = {},
): { items: ResearchAccessAuditEntry[]; nextCursor: number | null } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (input.profileId) {
    conditions.push('profile_id = ?')
    params.push(input.profileId)
  }
  if (input.surface) {
    conditions.push('surface = ?')
    params.push(input.surface)
  }
  if (input.toolStatus) {
    conditions.push('tool_status = ?')
    params.push(input.toolStatus)
  }
  if (input.cursor != null) {
    conditions.push('id < ?')
    params.push(input.cursor)
  }
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 100))
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT * FROM research_access_audit
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, limit + 1) as ResearchAccessAuditRow[]
  const hasMore = rows.length > limit
  const visible = hasMore ? rows.slice(0, limit) : rows
  return {
    items: visible.map(mapAudit),
    nextCursor: hasMore ? visible.at(-1)?.id ?? null : null,
  }
}

export function countResearchAccessAuditsSince(
  db: Database.Database,
  profileId: string,
  since: number,
): number {
  return (db.prepare(`
    SELECT COUNT(*) AS count
    FROM research_access_audit
    WHERE profile_id = ? AND created_at >= ?
  `).get(profileId, since) as { count: number }).count
}

export function hasResearchAccessAuditRequest(
  db: Database.Database,
  requestId: string,
): boolean {
  return db.prepare('SELECT 1 FROM research_access_audit WHERE request_id = ?').get(requestId) !== undefined
}

export function generateResearchAccessCredential(): string {
  return `twr_${randomBytes(32).toString('base64url')}`
}

export function hashResearchAccessCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex')
}

function credentialMatches(expectedHash: string, credential: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false
  const actual = Buffer.from(hashResearchAccessCredential(credential), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function getResearchAccessProfileRow(
  db: Database.Database,
  profileId: string,
): ResearchAccessProfileRow | null {
  return (db.prepare('SELECT * FROM research_access_profiles WHERE id = ?').get(profileId) as ResearchAccessProfileRow | undefined) ?? null
}

function requireResearchAccessProfileRow(
  db: Database.Database,
  profileId: string,
): ResearchAccessProfileRow {
  const row = getResearchAccessProfileRow(db, profileId)
  if (!row) throw new ResearchAccessRepositoryError('PROFILE_NOT_FOUND', '访问配置不存在')
  return row
}

function requireMutableResearchAccessProfileRow(
  db: Database.Database,
  profileId: string,
): ResearchAccessProfileRow {
  const row = requireResearchAccessProfileRow(db, profileId)
  if (row.revoked_at != null) throw new ResearchAccessRepositoryError('PROFILE_REVOKED', '访问配置已撤销')
  return row
}

function requireResearchAccessProfile(db: Database.Database, profileId: string): ResearchAccessProfile {
  return mapProfile(requireResearchAccessProfileRow(db, profileId))
}

function mapProfile(row: ResearchAccessProfileRow): ResearchAccessProfile {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes_json),
    enabled: row.enabled === 1,
    credentialVersion: row.credential_version,
    scopeVersion: row.scope_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

function parseScopes(value: string): ResearchAccessScope[] {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return normalizeScopes(parsed.filter((scope): scope is ResearchAccessScope => (
      typeof scope === 'string' && RESEARCH_ACCESS_SCOPES.includes(scope as ResearchAccessScope)
    )))
  } catch {
    return []
  }
}

function serializeScopes(scopes: ResearchAccessScope[]): string {
  return JSON.stringify(normalizeScopes(scopes))
}

function normalizeScopes(scopes: ResearchAccessScope[]): ResearchAccessScope[] {
  return RESEARCH_ACCESS_SCOPES.filter((scope) => scopes.includes(scope))
}

function getOperationReceipt(db: Database.Database, requestId: string): OperationReceiptRow | null {
  return (db.prepare(`
    SELECT request_id, operation, profile_id, created_at
    FROM research_access_operation_receipts
    WHERE request_id = ?
  `).get(requestId) as OperationReceiptRow | undefined) ?? null
}

function insertOperationReceipt(
  db: Database.Database,
  requestId: string,
  operation: ResearchAccessOperation,
  profileId: string,
  createdAt: number,
): void {
  db.prepare(`
    INSERT INTO research_access_operation_receipts (request_id, operation, profile_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(requestId, operation, profileId, createdAt)
}

function replayProfileOperation(
  db: Database.Database,
  receipt: OperationReceiptRow,
  expected: ResearchAccessOperation,
): ResearchAccessProfile {
  assertReceiptOperation(receipt, expected)
  return requireResearchAccessProfile(db, receipt.profile_id)
}

function replayCredentialOperation(
  db: Database.Database,
  receipt: OperationReceiptRow,
  expected: ResearchAccessOperation,
): ResearchAccessCredentialResult {
  assertReceiptOperation(receipt, expected)
  return {
    profile: requireResearchAccessProfile(db, receipt.profile_id),
    credential: null,
    replayed: true,
  }
}

function assertReceiptOperation(receipt: OperationReceiptRow, expected: ResearchAccessOperation): void {
  if (receipt.operation !== expected) {
    throw new ResearchAccessRepositoryError('REQUEST_ID_CONFLICT', 'requestId已用于其他操作')
  }
}

function requireResearchAccessAudit(db: Database.Database, id: number): ResearchAccessAuditEntry {
  const row = db.prepare('SELECT * FROM research_access_audit WHERE id = ?').get(id) as ResearchAccessAuditRow | undefined
  if (!row) throw new ResearchAccessRepositoryError('AUDIT_NOT_FOUND', '调用审计不存在')
  return mapAudit(row)
}

function mapAudit(row: ResearchAccessAuditRow): ResearchAccessAuditEntry {
  return {
    id: row.id,
    requestId: row.request_id,
    sessionId: row.session_id,
    profileId: row.profile_id,
    profileNameSnapshot: row.profile_name_snapshot,
    surface: row.surface,
    externalToolName: row.external_tool_name,
    toolId: row.tool_id,
    inputSha256: row.input_sha256,
    inputSummaryJson: row.input_summary_json,
    asOf: row.as_of,
    decision: row.decision,
    scopeVersion: row.scope_version,
    toolStatus: row.tool_status,
    errorCode: row.error_code,
    durationMs: row.duration_ms,
    resultBytes: row.result_bytes,
    resultSha256: row.result_sha256,
    createdAt: row.created_at,
  }
}
