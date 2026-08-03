import { ipcMain } from 'electron'
import { getDb } from '../database/db'
import { createDatabaseBackup, exportData, getDataSafetyStatus, openBackupDirectory, type DataExportScope } from '../services/dataSafetyService'

const EXPORT_SCOPES: DataExportScope[] = ['all', 'portfolio', 'forecasts', 'decisionSignals', 'settingsSummary']

function messageFromError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    if (err.message === 'DATABASE_NOT_FOUND') return '数据库文件不存在, 无法创建备份'
    return err.message || fallback
  }
  return fallback
}

export function registerDataSafetyHandlers(): void {
  ipcMain.handle('dataSafety:getStatus', () => {
    try {
      return { ok: true as const, data: getDataSafetyStatus(getDb()) }
    } catch (err) {
      console.error('[dataSafety:getStatus] failed:', err)
      return { ok: false as const, error: 'DATA_SAFETY_ERROR' as const, message: '数据安全状态读取失败' }
    }
  })

  ipcMain.handle('dataSafety:createBackup', async () => {
    try {
      return { ok: true as const, data: await createDatabaseBackup(getDb()) }
    } catch (err) {
      console.error('[dataSafety:createBackup] failed:', err)
      return { ok: false as const, error: 'BACKUP_FAILED' as const, message: messageFromError(err, '数据库备份失败') }
    }
  })

  ipcMain.handle('dataSafety:openBackupDirectory', async () => {
    try {
      const backupDirectory = await openBackupDirectory()
      return { ok: true as const, data: { backupDirectory } }
    } catch (err) {
      console.error('[dataSafety:openBackupDirectory] failed:', err)
      return { ok: false as const, error: 'OPEN_DIRECTORY_FAILED' as const, message: '无法打开备份目录' }
    }
  })

  ipcMain.handle('dataSafety:exportData', (_event, payload?: { scope?: DataExportScope }) => {
    const scope = payload?.scope ?? 'all'
    if (!EXPORT_SCOPES.includes(scope)) return { ok: false as const, error: 'INVALID_PARAM' as const, message: '导出范围无效' }
    try {
      return { ok: true as const, data: exportData(getDb(), scope) }
    } catch (err) {
      console.error('[dataSafety:exportData] failed:', err)
      return { ok: false as const, error: 'EXPORT_FAILED' as const, message: messageFromError(err, '数据导出失败') }
    }
  })
}
