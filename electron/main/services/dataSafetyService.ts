import type { Database } from 'better-sqlite3'
import { app, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

export type DataSafetyStatusLevel = 'ok' | 'warning' | 'error'
export type DataExportScope = 'all' | 'portfolio' | 'forecasts' | 'decisionSignals' | 'settingsSummary'

export interface DataSafetyIssue {
  level: DataSafetyStatusLevel
  message: string
}

export interface DataSafetyStatus {
  status: DataSafetyStatusLevel
  checkedAt: number
  databasePath: string
  databaseSizeBytes: number | null
  backupDirectory: string
  latestBackupAt: number | null
  backupCount: number
  migrationVersion: number | null
  issues: DataSafetyIssue[]
}

export interface DataBackupResult {
  backupPath: string
  backupSizeBytes: number
  createdAt: number
  deletedOldBackups: number
  message: string
}

export interface DataExportResult {
  exportPath: string
  scope: DataExportScope
  recordCounts: Record<string, number>
  createdAt: number
  message: string
}

const BACKUP_PREFIX = 'trade-watch-backup-'
const EXPORT_PREFIX = 'trade-watch-export-'
const MAX_BACKUP_FILES = 10
const BACKUP_STALE_MS = 24 * 60 * 60 * 1000

function getUserDataPath(): string {
  return app.getPath('userData')
}

export function getDatabasePath(): string {
  return join(getUserDataPath(), 'trade-watch.db')
}

export function getBackupDirectory(): string {
  return join(getUserDataPath(), 'backups')
}

function ensureBackupDirectory(): string {
  const dir = getBackupDirectory()
  mkdirSync(dir, { recursive: true })
  return dir
}

function formatBjTimestamp(ts = Date.now()): string {
  const bj = new Date(ts + 8 * 60 * 60 * 1000)
  const yyyy = bj.getUTCFullYear()
  const mm = String(bj.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(bj.getUTCDate()).padStart(2, '0')
  const hh = String(bj.getUTCHours()).padStart(2, '0')
  const mi = String(bj.getUTCMinutes()).padStart(2, '0')
  const ss = String(bj.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

function listBackupFiles(): Array<{ path: string; mtimeMs: number; size: number; name: string }> {
  const dir = ensureBackupDirectory()
  return readdirSync(dir)
    .filter(name => name.startsWith(BACKUP_PREFIX) && name.endsWith('.db'))
    .map(name => {
      const path = join(dir, name)
      const stat = statSync(path)
      return { path, name, mtimeMs: stat.mtimeMs, size: stat.size }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function getMigrationVersion(db: Database): number | null {
  try {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null } | undefined
    return row?.version ?? null
  } catch {
    return null
  }
}

function hasTable(db: Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name: string } | undefined
  return !!row
}

export function getDataSafetyStatus(db: Database): DataSafetyStatus {
  const checkedAt = Date.now()
  const databasePath = getDatabasePath()
  const backupDirectory = ensureBackupDirectory()
  const issues: DataSafetyIssue[] = []
  let databaseSizeBytes: number | null = null

  try {
    if (!existsSync(databasePath)) {
      issues.push({ level: 'error', message: '数据库文件不存在' })
    } else {
      databaseSizeBytes = statSync(databasePath).size
    }
  } catch {
    issues.push({ level: 'error', message: '数据库文件不可读' })
  }

  try {
    mkdirSync(backupDirectory, { recursive: true })
  } catch {
    issues.push({ level: 'error', message: '备份目录不可写' })
  }

  const backups = listBackupFiles()
  const latestBackupAt = backups[0]?.mtimeMs ? Math.round(backups[0].mtimeMs) : null
  if (!latestBackupAt) {
    issues.push({ level: 'warning', message: '尚未创建数据库备份' })
  } else if (checkedAt - latestBackupAt > BACKUP_STALE_MS) {
    issues.push({ level: 'warning', message: '最近一次备份已超过 24 小时' })
  }

  const hasError = issues.some(issue => issue.level === 'error')
  const hasWarning = issues.some(issue => issue.level === 'warning')
  return {
    status: hasError ? 'error' : hasWarning ? 'warning' : 'ok',
    checkedAt,
    databasePath,
    databaseSizeBytes,
    backupDirectory,
    latestBackupAt,
    backupCount: backups.length,
    migrationVersion: getMigrationVersion(db),
    issues
  }
}

export async function createDatabaseBackup(db: Database): Promise<DataBackupResult> {
  const databasePath = getDatabasePath()
  if (!existsSync(databasePath)) throw new Error('DATABASE_NOT_FOUND')
  const dir = ensureBackupDirectory()
  const createdAt = Date.now()
  const backupPath = join(dir, `${BACKUP_PREFIX}${formatBjTimestamp(createdAt)}.db`)
  await db.backup(backupPath)
  const backupSizeBytes = statSync(backupPath).size
  const deletedOldBackups = cleanupOldBackups()
  return { backupPath, backupSizeBytes, createdAt, deletedOldBackups, message: '备份已创建' }
}

function cleanupOldBackups(): number {
  const backups = listBackupFiles()
  const stale = backups.slice(MAX_BACKUP_FILES)
  let deleted = 0
  for (const file of stale) {
    try {
      unlinkSync(file.path)
      deleted += 1
    } catch {
      // 清理失败不影响本次备份结果。
    }
  }
  return deleted
}

export async function openBackupDirectory(): Promise<string> {
  const dir = ensureBackupDirectory()
  await shell.openPath(dir)
  return dir
}

function safeJsonParse(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function exportPortfolio(db: Database): unknown[] {
  if (!hasTable(db, 'portfolio_stocks')) return []
  return db.prepare('SELECT ts_code AS tsCode, stock_name AS stockName, added_at AS addedAt, cost_price AS costPrice FROM portfolio_stocks ORDER BY added_at DESC').all() as unknown[]
}

function exportForecasts(db: Database): unknown[] {
  if (!hasTable(db, 'trend_forecasts')) return []
  const rows = db.prepare('SELECT * FROM trend_forecasts ORDER BY createdAt DESC LIMIT 1000').all() as Record<string, unknown>[]
  return rows.map(row => ({ ...row, points: safeJsonParse(row.points as string | null), inputSnapshot: safeJsonParse(row.inputSnapshot as string | null), errorAnalysis: safeJsonParse(row.errorAnalysis as string | null) }))
}

function exportDecisionSignals(db: Database): unknown[] {
  if (!hasTable(db, 'decision_signals')) return []
  const rows = db.prepare('SELECT * FROM decision_signals ORDER BY signal_time DESC LIMIT 2000').all() as Record<string, unknown>[]
  return rows.map(row => ({ ...row, reason_json: safeJsonParse(row.reason_json as string | null), source_ref_json: safeJsonParse(row.source_ref_json as string | null) }))
}

function exportSettingsSummary(db: Database): Record<string, unknown> {
  const appSettings = hasTable(db, 'app_settings') ? db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as Record<string, unknown> | undefined : undefined
  const aiConfig = hasTable(db, 'ai_config') ? db.prepare('SELECT provider, model, triggerRating, maxArticlesPerBatch, maxContentCharsPerArticle, maxArticleAgeDays, maxForecastsPerStock, providerPriority, multiModelProviders, maxForecastComparison, selectedSkills, skillsForTrend, maxSkillChars FROM ai_config WHERE id = 1').get() as Record<string, unknown> | undefined : undefined
  const providers = hasTable(db, 'provider_configs') ? db.prepare('SELECT provider, model, maxTokens, CASE WHEN apiKeyEncrypted IS NOT NULL AND LENGTH(apiKeyEncrypted) > 0 THEN 1 ELSE 0 END AS hasApiKey FROM provider_configs ORDER BY provider').all() as unknown[] : []
  const dataSource = hasTable(db, 'data_source_config') ? db.prepare('SELECT tushareEnabled, CASE WHEN tushareTokenEncrypted IS NOT NULL AND LENGTH(tushareTokenEncrypted) > 0 THEN 1 ELSE 0 END AS hasTushareToken FROM data_source_config WHERE id = 1').get() as Record<string, unknown> | undefined : undefined
  return { appSettings: appSettings ?? null, aiConfig: aiConfig ?? null, providers, dataSource: dataSource ?? null }
}

export function exportData(db: Database, scope: DataExportScope): DataExportResult {
  const dir = ensureBackupDirectory()
  const createdAt = Date.now()
  const normalizedScope = scope || 'all'
  const payload: Record<string, unknown> = {
    exportedAt: createdAt,
    scope: normalizedScope,
    app: 'trade-watch'
  }
  const recordCounts: Record<string, number> = {}

  if (normalizedScope === 'all' || normalizedScope === 'portfolio') {
    const rows = exportPortfolio(db)
    payload.portfolio = rows
    recordCounts.portfolio = rows.length
  }
  if (normalizedScope === 'all' || normalizedScope === 'forecasts') {
    const rows = exportForecasts(db)
    payload.forecasts = rows
    recordCounts.forecasts = rows.length
  }
  if (normalizedScope === 'all' || normalizedScope === 'decisionSignals') {
    const rows = exportDecisionSignals(db)
    payload.decisionSignals = rows
    recordCounts.decisionSignals = rows.length
  }
  if (normalizedScope === 'all' || normalizedScope === 'settingsSummary') {
    payload.settingsSummary = exportSettingsSummary(db)
    recordCounts.settingsSummary = 1
  }

  const exportPath = join(dir, `${EXPORT_PREFIX}${normalizedScope}-${formatBjTimestamp(createdAt)}.json`)
  writeFileSync(exportPath, JSON.stringify(payload, null, 2), 'utf8')
  return { exportPath, scope: normalizedScope, recordCounts, createdAt, message: '数据已导出' }
}
