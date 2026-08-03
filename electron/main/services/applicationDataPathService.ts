import { createHash } from 'crypto'
import {
  cpSync,
  copyFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join, relative, resolve } from 'path'
import type { App } from 'electron'

export const APP_DATA_DIRECTORY_NAME = 'data'
export const APP_DATA_MARKER_FILE = '.trade-watch-data-root.json'
export const SESSION_PROFILE_MIGRATION_MARKER_FILE = '.trade-watch-session-profile-v2.json'

const LEGACY_SESSION_PROFILE_MIGRATION_MARKER_FILE = '.trade-watch-session-profile-v1.json'

const DECISION_CENTER_FILTERS_STORAGE_KEY = 'decisionCenterFilters'

const KNOWN_ROOT_ENTRIES = new Set([
  APP_DATA_MARKER_FILE,
  'backups',
  'config.json',
  'trade-watch.db',
  'trade-watch.db-shm',
  'trade-watch.db-wal',
  'trade-watch.db.bak',
])

const TRANSIENT_NAMES = new Set(['LOCK', 'SingletonCookie', 'SingletonLock', 'SingletonSocket'])

export type ApplicationDataMode = 'development' | 'installed-windows' | 'platform-default'

export interface ApplicationDataPathResult {
  mode: ApplicationDataMode
  dataRoot: string
  legacyUserDataPath: string
  migrated: boolean
  reusedExisting: boolean
}

interface PathAppHost {
  isPackaged: boolean
  getPath(name: 'exe' | 'userData'): string
  setPath(name: 'userData' | 'sessionData', path: string): void
  setAppLogsPath(path?: string): void
}

export interface PrepareApplicationDataRootOptions {
  legacyUserDataPath: string
  dataRoot: string
  copyDirectory?: (source: string, destination: string) => void
  now?: () => number
  pid?: number
}

export class ApplicationDataPathError extends Error {
  constructor(
    public readonly code: 'DATA_DIRECTORY_NOT_WRITABLE' | 'DATA_DIRECTORY_CONFLICT' | 'DATA_MIGRATION_FAILED',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ApplicationDataPathError'
  }
}

function isTransientName(name: string): boolean {
  return TRANSIENT_NAMES.has(name) || name.startsWith('Singleton')
}

function listMeaningfulEntries(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => !isTransientName(name))
}

function hasApplicationData(directory: string): boolean {
  return listMeaningfulEntries(directory).some((name) =>
    KNOWN_ROOT_ENTRIES.has(name) || name.startsWith('trade-watch.db'),
  )
}

function ensureWritableDirectory(directory: string): void {
  try {
    mkdirSync(directory, { recursive: true })
    const probe = join(directory, `.trade-watch-write-${process.pid}-${Date.now()}`)
    writeFileSync(probe, 'ok', { encoding: 'utf8', flag: 'wx' })
    unlinkSync(probe)
  } catch (error) {
    throw new ApplicationDataPathError(
      'DATA_DIRECTORY_NOT_WRITABLE',
      `本地数据目录不可写：${directory}`,
      { cause: error },
    )
  }
}

function markerPayload(migratedFrom: string | null, createdAt: number): string {
  return `${JSON.stringify({ version: 1, createdAt, migratedFrom }, null, 2)}\n`
}

function writeMarker(directory: string, migratedFrom: string | null, createdAt: number): void {
  const marker = join(directory, APP_DATA_MARKER_FILE)
  if (existsSync(marker)) return
  writeFileSync(marker, markerPayload(migratedFrom, createdAt), { encoding: 'utf8', flag: 'wx' })
}

function shouldCopyPath(sourceRoot: string, sourcePath: string): boolean {
  const relativePath = relative(sourceRoot, sourcePath)
  if (!relativePath) return true
  return relativePath.split(/[\\/]/).every((part) => !isTransientName(part))
}

function defaultCopyDirectory(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (sourcePath) => shouldCopyPath(source, sourcePath),
  })
}

function fileContainsStorageKey(path: string, storageKey: string): boolean {
  const needle = Buffer.from(storageKey, 'utf8')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let tail = Buffer.alloc(0)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    let bytesRead = 0
    do {
      bytesRead = readSync(fd, chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      const current = tail.length > 0
        ? Buffer.concat([tail, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead)
      if (current.includes(needle)) return true
      const tailLength = Math.min(needle.length - 1, current.length)
      tail = Buffer.from(current.subarray(current.length - tailLength))
    } while (bytesRead > 0)
    return false
  } catch {
    return false
  } finally {
    if (fd != null) closeSync(fd)
  }
}

function directoryContainsStorageKey(directory: string, storageKey: string): boolean {
  if (!existsSync(directory)) return false
  try {
    for (const name of readdirSync(directory)) {
      if (isTransientName(name)) continue
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        if (directoryContainsStorageKey(path, storageKey)) return true
      } else if (stat.isFile() && fileContainsStorageKey(path, storageKey)) {
        return true
      }
    }
  } catch {
    return false
  }
  return false
}

/**
 * FR-241 originally moved sessionData into data/session without relocating the
 * existing Chromium Local Storage directory. Migrate it once before Electron
 * opens the profile, while preserving a destination that already owns app state.
 */
export function prepareSessionDataRoot(
  dataRoot: string,
  options: { now?: () => number; pid?: number } = {},
): { sessionData: string; migratedLegacyLocalStorage: boolean; migratedLegacyLocalState: boolean } {
  const resolvedDataRoot = resolve(dataRoot)
  const sessionData = join(resolvedDataRoot, 'session')
  const marker = join(sessionData, SESSION_PROFILE_MIGRATION_MARKER_FILE)
  const now = options.now ?? Date.now
  mkdirSync(sessionData, { recursive: true })

  if (existsSync(marker)) {
    return { sessionData, migratedLegacyLocalStorage: false, migratedLegacyLocalState: false }
  }

  const source = join(resolvedDataRoot, 'Local Storage')
  const destination = join(sessionData, 'Local Storage')
  const sourceOwnsAppState = directoryContainsStorageKey(source, DECISION_CENTER_FILTERS_STORAGE_KEY)
  const destinationOwnsAppState = directoryContainsStorageKey(destination, DECISION_CENTER_FILTERS_STORAGE_KEY)
  let migratedLegacyLocalStorage = false
  let migratedLegacyLocalState = false

  if (sourceOwnsAppState && !destinationOwnsAppState) {
    const pid = options.pid ?? process.pid
    const suffix = `${pid}-${now()}`
    const staging = join(sessionData, `.local-storage-migrating-${suffix}`)
    const backup = join(sessionData, `.local-storage-before-migration-${suffix}`)
    try {
      if (existsSync(staging) || existsSync(backup)) {
        throw new Error('SESSION_PROFILE_STAGING_CONFLICT')
      }
      defaultCopyDirectory(source, staging)
      if (!directoryContainsStorageKey(staging, DECISION_CENTER_FILTERS_STORAGE_KEY)) {
        throw new Error('SESSION_PROFILE_COPY_VERIFICATION_FAILED')
      }
      if (existsSync(destination)) renameSync(destination, backup)
      renameSync(staging, destination)
      if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
      migratedLegacyLocalStorage = true
    } catch (error) {
      removeStagingDirectory(staging)
      if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination)
      throw new ApplicationDataPathError(
        'DATA_MIGRATION_FAILED',
        `持久筛选偏好迁移失败，原数据保持不变：${source}`,
        { cause: error },
      )
    }
  }

  // safeStorage resolves its encryption key from sessionData/Local State. The
  // v1 profile migration moved sessionData but left this key behind, making all
  // previously saved provider credentials unreadable after the next restart.
  const legacyLocalState = join(resolvedDataRoot, 'Local State')
  const sessionLocalState = join(sessionData, 'Local State')
  if (existsSync(legacyLocalState)
    && (!existsSync(sessionLocalState) || fileDigest(legacyLocalState) !== fileDigest(sessionLocalState))) {
    const pid = options.pid ?? process.pid
    const suffix = `${pid}-${now()}`
    const staging = join(sessionData, `.local-state-migrating-${suffix}`)
    const backup = join(sessionData, `.local-state-before-migration-${suffix}`)
    try {
      if (existsSync(staging) || existsSync(backup)) throw new Error('SESSION_LOCAL_STATE_STAGING_CONFLICT')
      copyFileSync(legacyLocalState, staging)
      if (fileDigest(legacyLocalState) !== fileDigest(staging)) {
        throw new Error('SESSION_LOCAL_STATE_COPY_VERIFICATION_FAILED')
      }
      if (existsSync(sessionLocalState)) renameSync(sessionLocalState, backup)
      renameSync(staging, sessionLocalState)
      if (existsSync(backup)) unlinkSync(backup)
      migratedLegacyLocalState = true
    } catch (error) {
      if (existsSync(staging)) unlinkSync(staging)
      if (!existsSync(sessionLocalState) && existsSync(backup)) renameSync(backup, sessionLocalState)
      throw new ApplicationDataPathError(
        'DATA_MIGRATION_FAILED',
        `AI 与搜索凭据迁移失败，原数据保持不变：${legacyLocalState}`,
        { cause: error },
      )
    }
  }

  writeFileSync(
    marker,
    `${JSON.stringify({
      version: 2,
      createdAt: now(),
      migratedLegacyLocalStorage,
      migratedLegacyLocalState,
      upgradedFromV1: existsSync(join(sessionData, LEGACY_SESSION_PROFILE_MIGRATION_MARKER_FILE)),
    }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  return { sessionData, migratedLegacyLocalStorage, migratedLegacyLocalState }
}

interface FileSnapshot {
  size: number
  digest: string | null
}

function requiresDigest(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase()
  return normalized === 'config.json' || normalized.endsWith('.db') || normalized.endsWith('.db.bak')
}

function fileDigest(path: string): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    let bytesRead = 0
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function collectFileSnapshot(root: string): Map<string, FileSnapshot> {
  const snapshot = new Map<string, FileSnapshot>()
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (isTransientName(name)) continue
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        visit(path)
      } else if (stat.isFile()) {
        const relativePath = relative(root, path)
        snapshot.set(relativePath, {
          size: stat.size,
          digest: requiresDigest(relativePath) ? fileDigest(path) : null,
        })
      }
    }
  }
  visit(root)
  return snapshot
}

function verifyCopy(source: string, destination: string): void {
  const sourceFiles = collectFileSnapshot(source)
  const destinationFiles = collectFileSnapshot(destination)
  for (const [relativePath, expected] of sourceFiles) {
    const actual = destinationFiles.get(relativePath)
    if (!actual || actual.size !== expected.size || actual.digest !== expected.digest) {
      throw new Error(`COPY_VERIFICATION_FAILED:${relativePath}`)
    }
  }
}

function removeStagingDirectory(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  } catch {
    // A failed cleanup must not hide the migration failure. The staging path remains outside dataRoot.
  }
}

export function prepareApplicationDataRoot(options: PrepareApplicationDataRootOptions): {
  migrated: boolean
  reusedExisting: boolean
} {
  const legacyUserDataPath = resolve(options.legacyUserDataPath)
  const dataRoot = resolve(options.dataRoot)
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid

  if (legacyUserDataPath === dataRoot) {
    ensureWritableDirectory(dataRoot)
    writeMarker(dataRoot, null, now())
    return { migrated: false, reusedExisting: true }
  }

  if (hasApplicationData(dataRoot)) {
    ensureWritableDirectory(dataRoot)
    writeMarker(dataRoot, null, now())
    return { migrated: false, reusedExisting: true }
  }

  const targetEntries = listMeaningfulEntries(dataRoot)
  if (targetEntries.length > 0) {
    throw new ApplicationDataPathError(
      'DATA_DIRECTORY_CONFLICT',
      `目标数据目录包含未知文件，已停止以避免覆盖：${dataRoot}`,
    )
  }

  ensureWritableDirectory(dirname(dataRoot))
  const hasLegacyData = hasApplicationData(legacyUserDataPath)
  if (!hasLegacyData) {
    ensureWritableDirectory(dataRoot)
    writeMarker(dataRoot, null, now())
    return { migrated: false, reusedExisting: false }
  }

  const staging = `${dataRoot}.migrating-${pid}-${now()}`
  if (existsSync(staging)) {
    throw new ApplicationDataPathError(
      'DATA_DIRECTORY_CONFLICT',
      `检测到未处理的数据迁移目录：${staging}`,
    )
  }

  try {
    if (existsSync(dataRoot)) rmdirSync(dataRoot)
    const copyDirectory = options.copyDirectory ?? defaultCopyDirectory
    copyDirectory(legacyUserDataPath, staging)
    verifyCopy(legacyUserDataPath, staging)
    writeMarker(staging, legacyUserDataPath, now())
    renameSync(staging, dataRoot)
    ensureWritableDirectory(dataRoot)
    return { migrated: true, reusedExisting: false }
  } catch (error) {
    removeStagingDirectory(staging)
    throw new ApplicationDataPathError(
      'DATA_MIGRATION_FAILED',
      `旧数据迁移失败，原目录保持不变：${legacyUserDataPath}`,
      { cause: error },
    )
  }
}

export function configureApplicationDataPaths(
  app: Pick<App, 'isPackaged' | 'getPath' | 'setPath' | 'setAppLogsPath'> | PathAppHost,
  platform: NodeJS.Platform = process.platform,
): ApplicationDataPathResult {
  const legacyUserDataPath = app.getPath('userData')

  if (!app.isPackaged) {
    const dataRoot = legacyUserDataPath.endsWith('-dev') ? legacyUserDataPath : `${legacyUserDataPath}-dev`
    ensureWritableDirectory(dataRoot)
    const { sessionData } = prepareSessionDataRoot(dataRoot)
    const logs = join(dataRoot, 'logs')
    mkdirSync(logs, { recursive: true })
    app.setPath('userData', dataRoot)
    app.setPath('sessionData', sessionData)
    app.setAppLogsPath(logs)
    return { mode: 'development', dataRoot, legacyUserDataPath, migrated: false, reusedExisting: true }
  }

  if (platform !== 'win32') {
    return {
      mode: 'platform-default',
      dataRoot: legacyUserDataPath,
      legacyUserDataPath,
      migrated: false,
      reusedExisting: true,
    }
  }

  const installDirectory = dirname(app.getPath('exe'))
  const dataRoot = join(installDirectory, APP_DATA_DIRECTORY_NAME)
  const prepared = prepareApplicationDataRoot({ legacyUserDataPath, dataRoot })
  const { sessionData } = prepareSessionDataRoot(dataRoot)
  const logs = join(dataRoot, 'logs')
  mkdirSync(logs, { recursive: true })
  app.setPath('userData', dataRoot)
  app.setPath('sessionData', sessionData)
  app.setAppLogsPath(logs)
  return { mode: 'installed-windows', dataRoot, legacyUserDataPath, ...prepared }
}

export function applicationDataPathErrorMessage(error: unknown): string {
  if (error instanceof ApplicationDataPathError) return error.message
  return `本地数据目录初始化失败：${error instanceof Error ? error.message : String(error)}`
}
