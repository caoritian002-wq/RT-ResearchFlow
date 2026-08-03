import { dialog, ipcMain } from 'electron'
import { getDb } from '../database/db'
import { exportDailyBasePackage, importDailyBasePackage, previewDailyBasePackage } from '../services/baseDataPackageService'

function messageFromError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    if (err.message === 'INSUFFICIENT_DAILY_BASE') return '本地日线底座为空, 请先执行全市场历史日线同步'
    if (err.message === 'INVALID_PACKAGE') return '基座包格式无效'
    if (err.message === 'INCOMPATIBLE_PACKAGE') return '基座包版本或内容不兼容'
    return err.message || fallback
  }
  return fallback
}

export function registerBaseDataPackageHandlers(): void {
  ipcMain.handle('baseDataPackage:exportDailyBase', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出全市场基座包',
      defaultPath: `trade-watch-daily-base-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.twbase.sqlite`,
      filters: [{ name: 'Trade Watch 基座包', extensions: ['twbase.sqlite'] }]
    })
    if (canceled || !filePath) return { ok: false as const, error: 'CANCELLED' as const, message: '导出已取消' }
    try {
      return { ok: true as const, data: exportDailyBasePackage(getDb(), filePath) }
    } catch (err) {
      console.error('[baseDataPackage:exportDailyBase] failed:', err)
      return { ok: false as const, error: 'EXPORT_FAILED' as const, message: messageFromError(err, '基座包导出失败') }
    }
  })

  ipcMain.handle('baseDataPackage:previewImport', async (_event, payload?: { filePath?: string }) => {
    let filePath = payload?.filePath
    if (!filePath) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择全市场基座包',
        properties: ['openFile'],
        filters: [{ name: 'Trade Watch 基座包', extensions: ['twbase.sqlite', 'sqlite', 'db'] }]
      })
      if (canceled || !filePaths[0]) return { ok: false as const, error: 'CANCELLED' as const, message: '导入已取消' }
      filePath = filePaths[0]
    }
    try {
      return { ok: true as const, data: previewDailyBasePackage(filePath) }
    } catch (err) {
      console.error('[baseDataPackage:previewImport] failed:', err)
      return { ok: false as const, error: 'INVALID_PACKAGE' as const, message: messageFromError(err, '基座包预览失败') }
    }
  })

  ipcMain.handle('baseDataPackage:importDailyBase', (_event, payload?: { filePath?: string }) => {
    const filePath = payload?.filePath
    if (!filePath) return { ok: false as const, error: 'INVALID_PARAM' as const, message: '缺少基座包路径' }
    try {
      return { ok: true as const, data: importDailyBasePackage(getDb(), filePath) }
    } catch (err) {
      console.error('[baseDataPackage:importDailyBase] failed:', err)
      return { ok: false as const, error: 'IMPORT_FAILED' as const, message: messageFromError(err, '基座包导入失败') }
    }
  })
}
