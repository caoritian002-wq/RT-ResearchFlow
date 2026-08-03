export type DataSafetyStatusLevel = 'ok' | 'warning' | 'error'

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

export type DataExportScope = 'all' | 'portfolio' | 'forecasts' | 'decisionSignals' | 'settingsSummary'

export const DATA_SAFETY_STATUS_META: Record<DataSafetyStatusLevel, { label: string; className: string; dot: string }> = {
  ok: { label: '正常', className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300', dot: 'bg-emerald-500' },
  warning: { label: '提醒', className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300', dot: 'bg-amber-500' },
  error: { label: '异常', className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300', dot: 'bg-red-500' }
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function exportScopeLabel(scope: DataExportScope): string {
  return {
    all: '全部关键数据',
    portfolio: '持仓',
    forecasts: '预测记录',
    decisionSignals: '今日看板信号',
    settingsSummary: '非敏感配置摘要'
  }[scope]
}
