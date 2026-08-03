import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'

const FORMAT_VERSION = 1
const APP_ID = 'trade-watch'
const REQUIRED_TABLES = ['daily_close_cache', 'stock_basic_cache', 'trade_cal'] as const

type BaseTableName = typeof REQUIRED_TABLES[number]

export interface BaseDataPackageManifest {
  formatVersion: number
  app: string
  exportedAt: number
  tradeDateStart: string | null
  tradeDateEnd: string | null
  recordCounts: Record<BaseTableName, number>
  tables: BaseTableName[]
}

export interface BaseDataPackageExportResult {
  filePath: string
  createdAt: number
  fileSizeBytes: number
  manifest: BaseDataPackageManifest
  message: string
}

export interface BaseDataPackagePreviewResult {
  filePath: string
  compatible: boolean
  warnings: string[]
  manifest: BaseDataPackageManifest
}

export interface BaseDataPackageImportResult {
  importedAt: number
  filePath: string
  recordCounts: Record<BaseTableName, number>
  message: string
}

function hasTable(db: DatabaseType, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name: string } | undefined
  return !!row
}

function countRows(db: DatabaseType, tableName: BaseTableName): number {
  if (!hasTable(db, tableName)) return 0
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number } | undefined
  return Number(row?.count ?? 0)
}

function readDailyRange(db: DatabaseType): { start: string | null; end: string | null } {
  if (!hasTable(db, 'daily_close_cache')) return { start: null, end: null }
  const row = db.prepare('SELECT MIN(trade_date) AS start, MAX(trade_date) AS end FROM daily_close_cache').get() as { start: string | null; end: string | null } | undefined
  return { start: row?.start ?? null, end: row?.end ?? null }
}

function createManifest(db: DatabaseType, exportedAt = Date.now()): BaseDataPackageManifest {
  const range = readDailyRange(db)
  const recordCounts = Object.fromEntries(REQUIRED_TABLES.map(table => [table, countRows(db, table)])) as Record<BaseTableName, number>
  return {
    formatVersion: FORMAT_VERSION,
    app: APP_ID,
    exportedAt,
    tradeDateStart: range.start,
    tradeDateEnd: range.end,
    recordCounts,
    tables: [...REQUIRED_TABLES]
  }
}

function createPackageSchema(packageDb: DatabaseType): void {
  packageDb.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS _base_package_manifest (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_close_cache (
      ts_code TEXT NOT NULL,
      trade_date TEXT NOT NULL,
      close REAL NOT NULL,
      pct_chg REAL,
      open REAL,
      high REAL,
      low REAL,
      vol REAL,
      turnover_rate REAL,
      PRIMARY KEY (ts_code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_close_ts_code ON daily_close_cache (ts_code);

    CREATE TABLE IF NOT EXISTS stock_basic_cache (
      ts_code TEXT NOT NULL PRIMARY KEY,
      name TEXT,
      industry TEXT,
      market TEXT,
      list_status TEXT,
      circ_float REAL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_cal (
      cal_date TEXT NOT NULL PRIMARY KEY,
      is_open INTEGER NOT NULL,
      pretrade_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trade_cal_is_open ON trade_cal (is_open, cal_date);
  `)
}

function attachPathLiteral(filePath: string): string {
  return filePath.replace(/'/g, "''")
}

function copyOutTable(sourceDb: DatabaseType, packageDb: DatabaseType, tableName: BaseTableName): void {
  if (!hasTable(sourceDb, tableName)) return
  packageDb.exec(`ATTACH DATABASE '${attachPathLiteral(sourceDb.name)}' AS source_db`)
  try {
    packageDb.exec(`INSERT OR REPLACE INTO ${tableName} SELECT * FROM source_db.${tableName}`)
  } finally {
    packageDb.exec('DETACH DATABASE source_db')
  }
}

function normalizePackagePath(filePath: string): string {
  if (!filePath.toLowerCase().endsWith('.twbase.sqlite')) return `${filePath}.twbase.sqlite`
  return filePath
}

function tempPackagePath(): string {
  const dir = join(app.getPath('temp'), 'trade-watch-base-packages')
  mkdirSync(dir, { recursive: true })
  return join(dir, `base-${Date.now()}-${Math.random().toString(16).slice(2)}.twbase.sqlite`)
}

function writeManifest(packageDb: DatabaseType, manifest: BaseDataPackageManifest): void {
  packageDb.prepare('INSERT OR REPLACE INTO _base_package_manifest (key, value) VALUES (?, ?)').run('manifest', JSON.stringify(manifest))
}

function readManifest(packageDb: DatabaseType): BaseDataPackageManifest {
  if (!hasTable(packageDb, '_base_package_manifest')) throw new Error('INVALID_PACKAGE')
  const row = packageDb.prepare("SELECT value FROM _base_package_manifest WHERE key = 'manifest'").get() as { value: string } | undefined
  if (!row?.value) throw new Error('INVALID_PACKAGE')
  const parsed = JSON.parse(row.value) as BaseDataPackageManifest
  if (parsed.app !== APP_ID || parsed.formatVersion !== FORMAT_VERSION) throw new Error('INCOMPATIBLE_PACKAGE')
  for (const table of REQUIRED_TABLES) {
    if (!parsed.tables?.includes(table) || !hasTable(packageDb, table)) throw new Error('INVALID_PACKAGE')
  }
  return parsed
}

export function exportDailyBasePackage(db: DatabaseType, outputPath: string): BaseDataPackageExportResult {
  const filePath = normalizePackagePath(outputPath)
  mkdirSync(dirname(filePath), { recursive: true })

  const manifest = createManifest(db)
  if (manifest.recordCounts.daily_close_cache <= 0) throw new Error('INSUFFICIENT_DAILY_BASE')

  const tempPath = tempPackagePath()
  const packageDb = new Database(tempPath)
  try {
    createPackageSchema(packageDb)
    for (const table of REQUIRED_TABLES) copyOutTable(db, packageDb, table)
    writeManifest(packageDb, manifest)
    packageDb.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    packageDb.close()
  }

  copyFileSync(tempPath, filePath)
  rmSync(tempPath, { force: true })
  rmSync(`${tempPath}-wal`, { force: true })
  rmSync(`${tempPath}-shm`, { force: true })

  return {
    filePath,
    createdAt: manifest.exportedAt,
    fileSizeBytes: statSync(filePath).size,
    manifest,
    message: '全市场基座包已导出'
  }
}

export function previewDailyBasePackage(filePath: string): BaseDataPackagePreviewResult {
  if (!existsSync(filePath)) throw new Error('INVALID_PACKAGE')
  const packageDb = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const manifest = readManifest(packageDb)
    const warnings: string[] = []
    if ((manifest.recordCounts.daily_close_cache ?? 0) <= 0) warnings.push('基座包不包含日线记录')
    if ((manifest.recordCounts.stock_basic_cache ?? 0) <= 0) warnings.push('基座包不包含股票基础信息')
    if ((manifest.recordCounts.trade_cal ?? 0) <= 0) warnings.push('基座包不包含交易日历')
    return { filePath, compatible: warnings.length === 0, warnings, manifest }
  } finally {
    packageDb.close()
  }
}

function mergeAttachedTable(targetDb: DatabaseType, tableName: BaseTableName): void {
  targetDb.exec(`INSERT OR REPLACE INTO ${tableName} SELECT * FROM package_db.${tableName}`)
}

export function importDailyBasePackage(db: DatabaseType, filePath: string): BaseDataPackageImportResult {
  const preview = previewDailyBasePackage(filePath)
  if (!preview.compatible) throw new Error('INCOMPATIBLE_PACKAGE')

  const packageDb = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const importedAt = Date.now()
    const recordCounts = { ...preview.manifest.recordCounts }
    db.exec(`ATTACH DATABASE '${attachPathLiteral(packageDb.name)}' AS package_db`)
    const merge = db.transaction(() => {
      for (const table of REQUIRED_TABLES) mergeAttachedTable(db, table)
    })
    try {
      merge()
      return { importedAt, filePath, recordCounts, message: '基座数据已导入' }
    } finally {
      db.exec('DETACH DATABASE package_db')
    }
  } finally {
    packageDb.close()
  }
}
