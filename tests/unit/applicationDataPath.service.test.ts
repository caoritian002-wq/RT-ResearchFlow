import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  APP_DATA_MARKER_FILE,
  SESSION_PROFILE_MIGRATION_MARKER_FILE,
  ApplicationDataPathError,
  configureApplicationDataPaths,
  prepareApplicationDataRoot,
  prepareSessionDataRoot,
} from '../../electron/main/services/applicationDataPathService'

const cleanupDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'trade-watch-data-path-'))
  cleanupDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of cleanupDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function appHost(input: { packaged: boolean; userData: string; exe: string }) {
  const paths = new Map<string, string>([
    ['userData', input.userData],
    ['exe', input.exe],
  ])
  let logsPath: string | null = null
  return {
    isPackaged: input.packaged,
    getPath: (name: 'exe' | 'userData') => paths.get(name)!,
    setPath: (name: 'userData' | 'sessionData', path: string) => { paths.set(name, path) },
    setAppLogsPath: (path?: string) => { logsPath = path ?? null },
    paths,
    get logsPath() { return logsPath },
  }
}

describe('应用数据路径服务', () => {
  it('让打包后的 Windows 应用使用安装目录 data 子目录', () => {
    const root = temporaryDirectory()
    const installDirectory = join(root, 'installed')
    mkdirSync(installDirectory)
    const host = appHost({ packaged: true, userData: join(root, 'legacy'), exe: join(installDirectory, 'trade-watch.exe') })

    const result = configureApplicationDataPaths(host, 'win32')

    expect(result.mode).toBe('installed-windows')
    expect(result.dataRoot).toBe(join(installDirectory, 'data'))
    expect(host.paths.get('userData')).toBe(result.dataRoot)
    expect(host.paths.get('sessionData')).toBe(join(result.dataRoot, 'session'))
    expect(host.logsPath).toBe(join(result.dataRoot, 'logs'))
    expect(readFileSync(join(result.dataRoot, APP_DATA_MARKER_FILE), 'utf8')).toContain('"version": 1')
  })

  it('首次启动复制旧数据库、配置和备份后原子发布新目录', () => {
    const root = temporaryDirectory()
    const legacy = join(root, 'legacy')
    const target = join(root, 'installed', 'data')
    mkdirSync(join(legacy, 'backups'), { recursive: true })
    writeFileSync(join(legacy, 'trade-watch.db'), 'database-v1')
    writeFileSync(join(legacy, 'config.json'), '{"lastHeartbeat":1}')
    writeFileSync(join(legacy, 'backups', 'backup.db'), 'backup-v1')

    const result = prepareApplicationDataRoot({ legacyUserDataPath: legacy, dataRoot: target, now: () => 100, pid: 7 })

    expect(result).toEqual({ migrated: true, reusedExisting: false })
    expect(readFileSync(join(target, 'trade-watch.db'), 'utf8')).toBe('database-v1')
    expect(readFileSync(join(target, 'backups', 'backup.db'), 'utf8')).toBe('backup-v1')
    expect(readFileSync(join(legacy, 'trade-watch.db'), 'utf8')).toBe('database-v1')
    expect(readFileSync(join(target, APP_DATA_MARKER_FILE), 'utf8')).toContain(legacy.replace(/\\/g, '\\\\'))
  })

  it('目标已有应用数据时以目标为准且不覆盖', () => {
    const root = temporaryDirectory()
    const legacy = join(root, 'legacy')
    const target = join(root, 'installed', 'data')
    mkdirSync(legacy, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, 'trade-watch.db'), 'old')
    writeFileSync(join(target, 'trade-watch.db'), 'current')

    const result = prepareApplicationDataRoot({ legacyUserDataPath: legacy, dataRoot: target })

    expect(result).toEqual({ migrated: false, reusedExisting: true })
    expect(readFileSync(join(target, 'trade-watch.db'), 'utf8')).toBe('current')
  })

  it('目标含未知文件时阻断且不删除任一侧内容', () => {
    const root = temporaryDirectory()
    const legacy = join(root, 'legacy')
    const target = join(root, 'installed', 'data')
    mkdirSync(legacy, { recursive: true })
    mkdirSync(target, { recursive: true })
    writeFileSync(join(legacy, 'trade-watch.db'), 'old')
    writeFileSync(join(target, 'unrelated.txt'), 'keep')

    expect(() => prepareApplicationDataRoot({ legacyUserDataPath: legacy, dataRoot: target }))
      .toThrowError(expect.objectContaining<ApplicationDataPathError>({ code: 'DATA_DIRECTORY_CONFLICT' }))
    expect(readFileSync(join(legacy, 'trade-watch.db'), 'utf8')).toBe('old')
    expect(readFileSync(join(target, 'unrelated.txt'), 'utf8')).toBe('keep')
  })

  it('复制失败时回滚 staging 并保留旧目录', () => {
    const root = temporaryDirectory()
    const legacy = join(root, 'legacy')
    const target = join(root, 'installed', 'data')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'trade-watch.db'), 'old')

    expect(() => prepareApplicationDataRoot({
      legacyUserDataPath: legacy,
      dataRoot: target,
      now: () => 200,
      pid: 9,
      copyDirectory: (_source, destination) => {
        mkdirSync(destination, { recursive: true })
        writeFileSync(join(destination, 'partial'), 'partial')
        throw new Error('COPY_FAILED')
      },
    })).toThrowError(expect.objectContaining<ApplicationDataPathError>({ code: 'DATA_MIGRATION_FAILED' }))
    expect(readFileSync(join(legacy, 'trade-watch.db'), 'utf8')).toBe('old')
    expect(() => readFileSync(`${target}.migrating-9-200`)).toThrow()
  })

  it('开发环境继续使用隔离的 dev 数据目录', () => {
    const root = temporaryDirectory()
    const userData = join(root, 'user-data')
    const host = appHost({ packaged: false, userData, exe: join(root, 'electron.exe') })

    const result = configureApplicationDataPaths(host, 'win32')

    expect(result.mode).toBe('development')
    expect(result.dataRoot).toBe(`${userData}-dev`)
    expect(host.paths.get('userData')).toBe(`${userData}-dev`)
  })

  it('首次启用 session 子目录时迁移旧 Local Storage 中的看板筛选', () => {
    const root = temporaryDirectory()
    const source = join(root, 'Local Storage', 'leveldb')
    const destination = join(root, 'session', 'Local Storage', 'leveldb')
    mkdirSync(source, { recursive: true })
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(source, '000003.log'), '\0decisionCenterFilters\0{"minPriority":4}')
    writeFileSync(join(destination, '000003.log'), 'empty-new-profile')

    const result = prepareSessionDataRoot(root, { now: () => 300, pid: 11 })

    expect(result.migratedLegacyLocalStorage).toBe(true)
    expect(readFileSync(join(destination, '000003.log'), 'utf8')).toContain('"minPriority":4')
    expect(readFileSync(join(source, '000003.log'), 'utf8')).toContain('"minPriority":4')
    expect(readFileSync(join(root, 'session', SESSION_PROFILE_MIGRATION_MARKER_FILE), 'utf8'))
      .toContain('"migratedLegacyLocalStorage": true')
  })

  it('session 已有看板筛选时保留较新的目标值', () => {
    const root = temporaryDirectory()
    const source = join(root, 'Local Storage', 'leveldb')
    const destination = join(root, 'session', 'Local Storage', 'leveldb')
    mkdirSync(source, { recursive: true })
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(source, '000003.log'), '\0decisionCenterFilters\0{"minPriority":2}')
    writeFileSync(join(destination, '000003.log'), '\0decisionCenterFilters\0{"minPriority":4}')

    const result = prepareSessionDataRoot(root)

    expect(result.migratedLegacyLocalStorage).toBe(false)
    expect(readFileSync(join(destination, '000003.log'), 'utf8')).toContain('"minPriority":4')
  })

  it('v1 session 迁移后补迁 Chromium Local State 以恢复已保存凭据', () => {
    const root = temporaryDirectory()
    const session = join(root, 'session')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(root, 'Local State'), '{"os_crypt":{"encrypted_key":"legacy-key"}}')
    writeFileSync(join(session, 'Local State'), '{"os_crypt":{"encrypted_key":"new-empty-profile-key"}}')
    writeFileSync(
      join(session, '.trade-watch-session-profile-v1.json'),
      '{"version":1,"createdAt":100,"migratedLegacyLocalStorage":true}',
    )

    const result = prepareSessionDataRoot(root, { now: () => 400, pid: 12 })

    expect(result.migratedLegacyLocalState).toBe(true)
    expect(readFileSync(join(session, 'Local State'), 'utf8')).toContain('legacy-key')
    const marker = readFileSync(join(session, SESSION_PROFILE_MIGRATION_MARKER_FILE), 'utf8')
    expect(marker).toContain('"version": 2')
    expect(marker).toContain('"upgradedFromV1": true')
  })

  it('v2 session 标记防止后续启动覆盖当前 Local State', () => {
    const root = temporaryDirectory()
    const session = join(root, 'session')
    mkdirSync(session, { recursive: true })
    writeFileSync(join(root, 'Local State'), 'legacy-key-v1')

    const first = prepareSessionDataRoot(root, { now: () => 500, pid: 13 })
    expect(first.migratedLegacyLocalState).toBe(true)
    writeFileSync(join(session, 'Local State'), 'active-session-key')

    const second = prepareSessionDataRoot(root, { now: () => 600, pid: 13 })

    expect(second.migratedLegacyLocalState).toBe(false)
    expect(readFileSync(join(session, 'Local State'), 'utf8')).toBe('active-session-key')
  })

  it('打包后的非 Windows 平台保持系统默认 userData', () => {
    const root = temporaryDirectory()
    const userData = join(root, 'user-data')
    const host = appHost({ packaged: true, userData, exe: join(root, 'App.app', 'MacOS', 'trade-watch') })

    const result = configureApplicationDataPaths(host, 'darwin')

    expect(result.mode).toBe('platform-default')
    expect(host.paths.get('userData')).toBe(userData)
    expect(host.logsPath).toBeNull()
  })
})
