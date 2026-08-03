import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConfigDrawerTab } from '../ConfigDrawer/ConfigDrawer'
import { getFlowProgress, type InitializationFlowState } from '../Onboarding/initializationTaskModel'
import { AIQualityEvaluation } from './AIQualityEvaluation'
import { DATA_SAFETY_STATUS_META, exportScopeLabel, formatBytes, formatDateTime, type DataBackupResult, type DataExportResult, type DataExportScope, type DataSafetyStatus } from './dataSafetyModel'

type DiagnosticStatus = 'ok' | 'warning' | 'error'
type DiagnosticRunAction = 'refreshHealth' | 'refreshDataQuality' | 'syncStockBasic' | 'syncTradeCalendar' | 'syncHistoricalDaily' | 'syncMarketBenchmarks' | 'syncConceptMembers' | 'backfillDecisionSignals'
type DataTrustStatus = 'reliable' | 'degraded' | 'blocked'

interface DiagnosticAction {
  key: 'open-datasource' | 'open-ai-config' | DiagnosticRunAction
  label: string
  kind: 'navigate' | 'run'
}

interface DiagnosticItem {
  key: string
  title: string
  status: DiagnosticStatus
  message: string
  detail?: string
  recordCount?: number | null
  latestDate?: string | null
  checkedAt: number
  actions?: DiagnosticAction[]
}

interface DiagnosticGroup {
  key: 'config' | 'freshness' | 'sync' | 'database'
  title: string
  items: DiagnosticItem[]
}

interface DailyCloseFieldQuality {
  missingRows: number
  missingRate: number | null
}

interface DailyCloseQuality {
  targetTradeDays: number
  retentionTradeDays: number
  actualTradeDays: number
  totalRows: number
  earliestTradeDate: string | null
  latestTradeDate: string | null
  fields: Record<'open' | 'high' | 'low' | 'close' | 'pctChg' | 'vol' | 'turnoverRate', DailyCloseFieldQuality>
  cleanup: {
    status: 'never' | 'running' | 'success' | 'failed'
    startedAt: number | null
    completedAt: number | null
    retainTradeDays: number | null
    removedRows: number | null
    remainingTradeDays: number | null
    message: string | null
  }
}

interface DiagnosticsHealthSnapshot {
  status: DiagnosticStatus
  checkedAt: number
  summary: Record<DiagnosticStatus, number>
  groups: DiagnosticGroup[]
  dailyCloseQuality?: DailyCloseQuality
  dataQuality?: DataQualitySnapshot
}

interface DataQualityDataset {
  key: 'stockBasic' | 'tradeCalendar' | 'dailyMarket' | 'auction' | 'benchmarks' | 'financials'
  title: string
  status: DataTrustStatus
  summary: string
  recordCount: number
  earliestDate: string | null
  latestDate: string | null
  sourceLabel: string
  affectedModules: string[]
  reasons: Array<{ code: string; message: string; severity: 'warning' | 'error' }>
  action: null | {
    key: 'syncStockBasic' | 'syncTradeCalendar' | 'syncHistoricalDaily' | 'syncMarketBenchmarks'
    label: string
  }
}

interface DataQualitySnapshot {
  status: DataTrustStatus
  checkedAt: number
  fingerprint: string
  persistedRunId: number | null
  persistedAt: number | null
  summary: Record<DataTrustStatus, number>
  datasets: DataQualityDataset[]
}

interface BaseDataPackageManifest {
  formatVersion: number
  app: string
  exportedAt: number
  tradeDateStart: string | null
  tradeDateEnd: string | null
  recordCounts: Record<string, number>
  tables: string[]
}

interface BaseDataPackagePreview {
  filePath: string
  compatible: boolean
  warnings: string[]
  manifest: BaseDataPackageManifest
}

interface DiagnosticsPanelProps {
  onNavigateConfig?: (tab: ConfigDrawerTab) => void
  onOpenGuide?: () => void
  initializationFlow?: InitializationFlowState
  onStartInitialization?: () => void
}

const STATUS_META: Record<DiagnosticStatus, { label: string; className: string; dot: string }> = {
  ok: { label: '正常', className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300', dot: 'bg-emerald-500' },
  warning: { label: '提醒', className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300', dot: 'bg-amber-500' },
  error: { label: '异常', className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300', dot: 'bg-red-500' }
}

const DATA_TRUST_META: Record<DataTrustStatus, { label: string; className: string; dot: string; summary: string }> = {
  reliable: {
    label: '可用',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    summary: '关键数据满足当前使用门槛',
  },
  degraded: {
    label: '需注意',
    className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
    dot: 'bg-amber-500',
    summary: '部分结论可用，但需要保留质量限制',
  },
  blocked: {
    label: '有阻断',
    className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
    dot: 'bg-red-500',
    summary: '部分工作台缺少形成结论所需的数据',
  },
}

const DAILY_FIELD_LABELS: Array<[keyof DailyCloseQuality['fields'], string]> = [
  ['open', '开盘'],
  ['high', '最高'],
  ['low', '最低'],
  ['close', '收盘'],
  ['pctChg', '涨跌幅'],
  ['vol', '成交量'],
  ['turnoverRate', '换手率'],
]

const CLEANUP_STATUS_META: Record<DailyCloseQuality['cleanup']['status'], { label: string; className: string }> = {
  never: { label: '尚未运行', className: 'text-gray-500 dark:text-gray-400' },
  running: { label: '清理中', className: 'text-blue-600 dark:text-blue-300' },
  success: { label: '最近成功', className: 'text-emerald-600 dark:text-emerald-300' },
  failed: { label: '最近失败', className: 'text-red-600 dark:text-red-300' },
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatMissingRate(value: number | null): string {
  if (value === null) return '—'
  return `${(value * 100).toFixed(value > 0 && value < 0.001 ? 2 : 1)}%`
}

function runActionFromKey(key: DiagnosticAction['key']): DiagnosticRunAction | null {
  if (
    key === 'refreshDataQuality'
    || key === 'syncStockBasic'
    || key === 'syncTradeCalendar'
    || key === 'syncHistoricalDaily'
    || key === 'syncMarketBenchmarks'
    || key === 'syncConceptMembers'
    || key === 'backfillDecisionSignals'
  ) return key
  return null
}

function formatFactDate(value: string | null): string {
  if (!value) return '—'
  const normalized = value.replace(/-/g, '')
  if (!/^\d{8}$/.test(normalized)) return value
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`
}

export function DiagnosticsPanel({ onNavigateConfig, onOpenGuide, initializationFlow, onStartInitialization }: DiagnosticsPanelProps) {
  const [snapshot, setSnapshot] = useState<DiagnosticsHealthSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [runningAction, setRunningAction] = useState<DiagnosticRunAction | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const [dataSafety, setDataSafety] = useState<DataSafetyStatus | null>(null)
  const [dataSafetyLoading, setDataSafetyLoading] = useState(false)
  const [dataSafetyAction, setDataSafetyAction] = useState<'backup' | 'open' | 'export' | 'baseExport' | 'basePreview' | 'baseImport' | null>(null)
  const [dataSafetyMessage, setDataSafetyMessage] = useState('')
  const [dataSafetyError, setDataSafetyError] = useState('')
  const [exportScope, setExportScope] = useState<DataExportScope>('all')
  const [basePreview, setBasePreview] = useState<BaseDataPackagePreview | null>(null)

  const loadHealth = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.api.diagnostics.getHealth()
      if (res.ok) {
        setSnapshot(res.data)
      } else {
        setError(res.message || '诊断快照生成失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '诊断快照生成失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  const loadDataSafety = useCallback(async () => {
    setDataSafetyLoading(true)
    setDataSafetyError('')
    try {
      const res = await window.api.dataSafety.getStatus()
      if (res.ok) {
        setDataSafety(res.data)
      } else {
        setDataSafetyError(res.message || '数据安全状态读取失败')
      }
    } catch (err) {
      setDataSafetyError(err instanceof Error ? err.message : '数据安全状态读取失败')
    } finally {
      setDataSafetyLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDataSafety()
  }, [loadDataSafety])

  const blockers = useMemo(() => {
    if (!snapshot) return []
    return snapshot.groups.flatMap(group => group.items).filter(item => item.status !== 'ok').slice(0, 4)
  }, [snapshot])

  async function handleRun(action: DiagnosticRunAction) {
    setRunningAction(action)
    setActionMessage('')
    setError('')
    try {
      const res = await window.api.diagnostics.runCheck(action)
      if (res.ok) {
        setActionMessage(res.data.message)
        await loadHealth()
      } else {
        setError(res.message || '诊断动作执行失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '诊断动作执行失败')
    } finally {
      setRunningAction(null)
    }
  }

  function handleAction(action: DiagnosticAction) {
    if (action.kind === 'navigate') {
      if (action.key === 'open-datasource') onNavigateConfig?.('datasource')
      if (action.key === 'open-ai-config') onNavigateConfig?.('ai-config')
      return
    }
    const runAction = runActionFromKey(action.key)
    if (runAction) void handleRun(runAction)
  }

  async function handleCreateBackup() {
    setDataSafetyAction('backup')
    setDataSafetyMessage('')
    setDataSafetyError('')
    try {
      const res = await window.api.dataSafety.createBackup()
      if (res.ok) {
        const data = res.data as DataBackupResult
        setDataSafetyMessage(`${data.message}：${data.backupPath}`)
        await loadDataSafety()
      } else {
        setDataSafetyError(res.message || '数据库备份失败')
      }
    } catch (err) {
      setDataSafetyError(err instanceof Error ? err.message : '数据库备份失败')
    } finally {
      setDataSafetyAction(null)
    }
  }

  async function handleOpenBackupDirectory() {
    setDataSafetyAction('open')
    setDataSafetyMessage('')
    setDataSafetyError('')
    try {
      const res = await window.api.dataSafety.openBackupDirectory()
      if (res.ok) setDataSafetyMessage(`已打开备份目录：${res.data.backupDirectory}`)
      else setDataSafetyError(res.message || '无法打开备份目录')
    } catch (err) {
      setDataSafetyError(err instanceof Error ? err.message : '无法打开备份目录')
    } finally {
      setDataSafetyAction(null)
    }
  }

  async function handleExportData() {
    setDataSafetyAction('export')
    setDataSafetyMessage('')
    setDataSafetyError('')
    try {
      const res = await window.api.dataSafety.exportData(exportScope)
      if (res.ok) {
        const data = res.data as DataExportResult
        setDataSafetyMessage(`${data.message}：${data.exportPath}`)
      } else {
        setDataSafetyError(res.message || '数据导出失败')
      }
    } catch (err) {
      setDataSafetyError(err instanceof Error ? err.message : '数据导出失败')
    } finally {
      setDataSafetyAction(null)
    }
  }

  async function handleExportBasePackage() {
    setDataSafetyAction('baseExport')
    setDataSafetyMessage('')
    setDataSafetyError('')
    setBasePreview(null)
    try {
      const res = await window.api.baseDataPackage.exportDailyBase()
      if (res.ok) {
        const count = res.data.manifest.recordCounts.daily_close_cache ?? 0
        const start = res.data.manifest.tradeDateStart ?? '—'
        const end = res.data.manifest.tradeDateEnd ?? '—'
        setDataSafetyMessage(`${res.data.message}：${res.data.filePath}（日线 ${count.toLocaleString('zh-CN')} 行, ${start}~${end}, ${formatBytes(res.data.fileSizeBytes)}）`)
      } else if (res.error !== 'CANCELLED') {
        setDataSafetyError(res.message || '基座包导出失败')
      }
    } catch (err) {
      setDataSafetyError(err instanceof Error ? err.message : '基座包导出失败')
    } finally {
      setDataSafetyAction(null)
    }
  }

  async function handlePreviewBasePackage() {
    setDataSafetyAction('basePreview')
    setDataSafetyMessage('')
    setDataSafetyError('')
    setBasePreview(null)
    try {
      const res = await window.api.baseDataPackage.previewImport()
      if (res.ok) setBasePreview(res.data)
      else if (res.error !== 'CANCELLED') setDataSafetyError(res.message || '基座包预览失败')
    } catch (err) {
      setDataSafetyError(err instanceof Error ? err.message : '基座包预览失败')
    } finally {
      setDataSafetyAction(null)
    }
  }

  async function handleImportBasePackage() {
    if (!basePreview) return
    setDataSafetyAction('baseImport')
    setDataSafetyMessage('')
    setDataSafetyError('')
    try {
      const res = await window.api.baseDataPackage.importDailyBase(basePreview.filePath)
      if (res.ok) {
        const count = res.data.recordCounts.daily_close_cache ?? 0
        setDataSafetyMessage(`${res.data.message}：导入日线 ${count.toLocaleString('zh-CN')} 行`)
        setBasePreview(null)
        await Promise.all([loadHealth(), loadDataSafety()])
      } else {
        setDataSafetyError(res.message || '基座包导入失败')
      }
    } catch (err) {
      setDataSafetyError(err instanceof Error ? err.message : '基座包导入失败')
    } finally {
      setDataSafetyAction(null)
    }
  }

  const overall = snapshot ? STATUS_META[snapshot.status] : STATUS_META.warning
  const flowProgress = initializationFlow ? getFlowProgress(initializationFlow) : null
  const dataSafetyMeta = dataSafety ? DATA_SAFETY_STATUS_META[dataSafety.status] : DATA_SAFETY_STATUS_META.warning

  return (
    <div data-testid="diagnostics-panel" className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-950 p-5">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${overall.dot}`} />
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">数据健康诊断</h2>
              <span className={`rounded border px-2 py-0.5 text-xs ${overall.className}`}>{overall.label}</span>
            </div>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">最近检查：{formatTime(snapshot?.checkedAt)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {onStartInitialization && (
              <button
                type="button"
                data-testid="diagnostics-start-initialization"
                onClick={onStartInitialization}
                disabled={initializationFlow?.running}
                className="rounded border border-emerald-200 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900/60 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                {initializationFlow?.running ? '初始化中…' : '一键初始化'}
              </button>
            )}
            {onOpenGuide && (
              <button
                type="button"
                data-testid="open-onboarding-from-diagnostics"
                onClick={onOpenGuide}
                className="rounded border border-blue-200 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-900/60 dark:text-blue-300 dark:hover:bg-blue-950/40"
              >
                打开新用户引导
              </button>
            )}
            <button
              type="button"
              onClick={() => void loadHealth()}
              disabled={loading}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {loading ? '检查中…' : '重新检查'}
            </button>
          </div>
        </div>

        {snapshot && (
          <div data-testid="diagnostics-summary" className="grid grid-cols-3 gap-3">
            {(['ok', 'warning', 'error'] as DiagnosticStatus[]).map(status => (
              <div key={status} className={`rounded-lg border p-3 ${STATUS_META[status].className}`}>
                <div className="text-xs">{STATUS_META[status].label}</div>
                <div className="mt-1 text-xl font-semibold">{snapshot.summary[status]}</div>
              </div>
            ))}
          </div>
        )}

        {snapshot?.dataQuality && (() => {
          const quality = snapshot.dataQuality
          const qualityMeta = DATA_TRUST_META[quality.status]
          return (
            <section data-testid="diagnostics-data-quality" className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${qualityMeta.dot}`} />
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">关键数据质量</h3>
                    <span className={`rounded border px-1.5 py-0.5 text-[11px] ${qualityMeta.className}`}>{qualityMeta.label}</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{qualityMeta.summary}</p>
                  <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
                    当前检查 {formatTime(quality.checkedAt)}
                    {quality.persistedAt ? ` · 最近正式检查 ${formatTime(quality.persistedAt)}` : ' · 尚未保存正式检查'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className="hidden text-right text-[11px] text-gray-500 dark:text-gray-400 sm:block">
                    <div>{quality.summary.reliable} 项可用 · {quality.summary.degraded} 项需注意</div>
                    <div>{quality.summary.blocked} 项阻断</div>
                  </div>
                  <button
                    type="button"
                    data-testid="diagnostics-run-data-quality"
                    onClick={() => void handleRun('refreshDataQuality')}
                    disabled={runningAction !== null}
                    className="min-h-9 rounded border border-cyan-200 px-3 py-1.5 text-xs font-medium text-cyan-700 hover:bg-cyan-50 disabled:opacity-50 dark:border-cyan-900/60 dark:text-cyan-300 dark:hover:bg-cyan-950/40"
                  >
                    {runningAction === 'refreshDataQuality' ? '检查中…' : '运行完整检查'}
                  </button>
                </div>
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-800">
                {quality.datasets.map(dataset => {
                  const meta = DATA_TRUST_META[dataset.status]
                  const range = dataset.earliestDate || dataset.latestDate
                    ? `${formatFactDate(dataset.earliestDate)} ~ ${formatFactDate(dataset.latestDate)}`
                    : '暂无事实范围'
                  return (
                    <div key={dataset.key} data-testid={`data-quality-${dataset.key}`} className="px-4 py-3">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{dataset.title}</div>
                            <span className={`rounded border px-1.5 py-0.5 text-[11px] ${meta.className}`}>{meta.label}</span>
                          </div>
                          <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">{dataset.summary}</div>
                          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400 dark:text-gray-500">
                            <span>{range}</span>
                            <span>{dataset.recordCount.toLocaleString('zh-CN')} 条</span>
                            <span>{dataset.sourceLabel}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
                            <span>影响：</span>
                            {dataset.affectedModules.map(module => (
                              <span key={module} className="rounded bg-gray-100 px-1.5 py-0.5 dark:bg-gray-800">{module}</span>
                            ))}
                          </div>
                          {dataset.reasons.length > 0 && (
                            <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                              <summary className="w-fit cursor-pointer select-none rounded py-1 pr-2 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:hover:text-gray-200">查看 {dataset.reasons.length} 项质量说明</summary>
                              <ul className="mt-1 space-y-1 border-l border-gray-200 pl-3 dark:border-gray-700">
                                {dataset.reasons.map(item => <li key={item.code}>{item.message}</li>)}
                              </ul>
                            </details>
                          )}
                        </div>
                        {dataset.action && (
                          <button
                            type="button"
                            onClick={() => handleAction({ key: dataset.action!.key, label: dataset.action!.label, kind: 'run' })}
                            disabled={runningAction !== null}
                            className="min-h-9 shrink-0 self-start rounded border border-blue-200 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900/60 dark:text-blue-300 dark:hover:bg-blue-950/40"
                          >
                            {runningAction === dataset.action.key ? '执行中…' : dataset.action.label}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })()}

        <AIQualityEvaluation onOpenAiConfig={() => onNavigateConfig?.('ai-config')} />

        {snapshot?.dailyCloseQuality && (() => {
          const quality = snapshot.dailyCloseQuality
          const cleanupMeta = CLEANUP_STATUS_META[quality.cleanup.status]
          return (
            <section data-testid="diagnostics-daily-close-quality" className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">历史日线质量</h3>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">事实范围 {quality.earliestTradeDate ?? '—'} ~ {quality.latestTradeDate ?? '—'} · {quality.totalRows.toLocaleString('zh-CN')} 行</p>
                </div>
                <div className={`text-xs font-medium ${cleanupMeta.className}`}>{cleanupMeta.label}</div>
              </div>
              <div className="grid gap-px bg-gray-100 dark:bg-gray-800 lg:grid-cols-[220px_minmax(0,1fr)_240px]">
                <div className="bg-white p-4 dark:bg-gray-900">
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">交易日覆盖</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-xl font-semibold text-gray-900 dark:text-gray-100">{quality.actualTradeDays}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">/ 目标 {quality.targetTradeDays}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">保留窗口 {quality.retentionTradeDays} 个有效交易日</div>
                </div>
                <div className="bg-white p-4 dark:bg-gray-900">
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">关键字段缺失率</div>
                  <div className="mt-2 grid grid-cols-4 gap-x-3 gap-y-2 sm:grid-cols-7">
                    {DAILY_FIELD_LABELS.map(([key, label]) => {
                      const field = quality.fields[key]
                      const hasMissing = field.missingRows > 0
                      return (
                        <div key={key} className="min-w-0">
                          <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">{label}</div>
                          <div className={`mt-0.5 text-xs font-medium ${hasMissing ? 'text-amber-600 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300'}`} title={`缺失 ${field.missingRows.toLocaleString('zh-CN')} 行`}>
                            {formatMissingRate(field.missingRate)}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="bg-white p-4 text-xs dark:bg-gray-900">
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">最近清理</div>
                  <div className={`mt-1 font-medium ${cleanupMeta.className}`}>{cleanupMeta.label}</div>
                  <div className="mt-1 text-gray-500 dark:text-gray-400">
                    {quality.cleanup.status === 'success'
                      ? `删除 ${(quality.cleanup.removedRows ?? 0).toLocaleString('zh-CN')} 行 · 剩余 ${quality.cleanup.remainingTradeDays ?? '—'} 日`
                      : quality.cleanup.message ?? `完成时间 ${formatTime(quality.cleanup.completedAt)}`}
                  </div>
                  {quality.cleanup.status !== 'never' && <div className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">{formatTime(quality.cleanup.completedAt ?? quality.cleanup.startedAt)}</div>}
                </div>
              </div>
            </section>
          )
        })()}

        {initializationFlow && (
          <div data-testid="diagnostics-initialization-flow" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
            <div className="font-semibold">初始化任务</div>
            <div className="mt-1 text-xs opacity-80">{flowProgress?.done ?? 0}/{flowProgress?.total ?? 0} 完成 · {initializationFlow.running ? '正在执行' : initializationFlow.error ? '需要处理' : '空闲'}</div>
            {(initializationFlow.message || initializationFlow.error) && <div className="mt-2 text-xs">{initializationFlow.error ?? initializationFlow.message}</div>}
          </div>
        )}

        {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
        {actionMessage && <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">{actionMessage}</div>}

        <section data-testid="diagnostics-data-safety" className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${dataSafetyMeta.dot}`} />
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">数据安全</h3>
                <span className={`rounded border px-1.5 py-0.5 text-[11px] ${dataSafetyMeta.className}`}>{dataSafetyMeta.label}</span>
              </div>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">数据库备份、导出和恢复入口。恢复首版只打开备份目录, 不自动覆盖当前数据库。</p>
            </div>
            <button type="button" onClick={() => void loadDataSafety()} disabled={dataSafetyLoading} className="rounded border border-gray-300 px-2.5 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
              {dataSafetyLoading ? '读取中…' : '刷新状态'}
            </button>
          </div>
          <div className="space-y-3 p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded border border-gray-100 p-3 text-xs dark:border-gray-800">
                <div className="text-gray-400 dark:text-gray-500">数据库大小</div>
                <div className="mt-1 font-semibold text-gray-900 dark:text-gray-100">{formatBytes(dataSafety?.databaseSizeBytes)}</div>
              </div>
              <div className="rounded border border-gray-100 p-3 text-xs dark:border-gray-800">
                <div className="text-gray-400 dark:text-gray-500">最近备份</div>
                <div className="mt-1 font-semibold text-gray-900 dark:text-gray-100">{formatDateTime(dataSafety?.latestBackupAt)}</div>
              </div>
              <div className="rounded border border-gray-100 p-3 text-xs dark:border-gray-800">
                <div className="text-gray-400 dark:text-gray-500">迁移版本</div>
                <div className="mt-1 font-semibold text-gray-900 dark:text-gray-100">{dataSafety?.migrationVersion ?? '—'}</div>
              </div>
            </div>
            <div className="grid gap-2 text-xs text-gray-500 dark:text-gray-400 md:grid-cols-2">
              <div className="min-w-0 break-all">数据库：{dataSafety?.databasePath ?? '—'}</div>
              <div className="min-w-0 break-all">备份目录：{dataSafety?.backupDirectory ?? '—'} · {dataSafety?.backupCount ?? 0} 个备份</div>
            </div>
            {dataSafety?.issues && dataSafety.issues.length > 0 && (
              <div className="space-y-1">
                {dataSafety.issues.map((issue, index) => {
                  const issueMeta = DATA_SAFETY_STATUS_META[issue.level]
                  return <div key={`${issue.message}-${index}`} className={`rounded border px-2 py-1 text-xs ${issueMeta.className}`}>{issue.message}</div>
                })}
              </div>
            )}
            {dataSafetyError && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">{dataSafetyError}</div>}
            {dataSafetyMessage && <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">{dataSafetyMessage}</div>}
            {basePreview && (
              <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                <div className="font-semibold">基座包预览</div>
                <div className="mt-1 break-all">文件：{basePreview.filePath}</div>
                <div className="mt-1 grid gap-1 md:grid-cols-3">
                  <span>日线：{(basePreview.manifest.recordCounts.daily_close_cache ?? 0).toLocaleString('zh-CN')} 行</span>
                  <span>股票基础：{(basePreview.manifest.recordCounts.stock_basic_cache ?? 0).toLocaleString('zh-CN')} 行</span>
                  <span>交易日历：{(basePreview.manifest.recordCounts.trade_cal ?? 0).toLocaleString('zh-CN')} 行</span>
                </div>
                <div className="mt-1">范围：{basePreview.manifest.tradeDateStart ?? '—'} ~ {basePreview.manifest.tradeDateEnd ?? '—'} · 导出时间：{formatDateTime(basePreview.manifest.exportedAt)}</div>
                {basePreview.warnings.length > 0 && <div className="mt-1 text-amber-700 dark:text-amber-300">提示：{basePreview.warnings.join('；')}</div>}
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => void handleImportBasePackage()} disabled={dataSafetyAction !== null || !basePreview.compatible} className="rounded border border-blue-300 px-2.5 py-1 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-800 dark:text-blue-200 dark:hover:bg-blue-900/40">
                    {dataSafetyAction === 'baseImport' ? '导入中…' : '确认导入'}
                  </button>
                  <button type="button" onClick={() => setBasePreview(null)} disabled={dataSafetyAction !== null} className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
                    取消
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" data-testid="data-safety-create-backup" onClick={() => void handleCreateBackup()} disabled={dataSafetyAction !== null} className="rounded border border-emerald-200 px-3 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-900/60 dark:text-emerald-300 dark:hover:bg-emerald-950/40">
                {dataSafetyAction === 'backup' ? '备份中…' : '立即备份'}
              </button>
              <button type="button" data-testid="data-safety-open-backup-dir" onClick={() => void handleOpenBackupDirectory()} disabled={dataSafetyAction !== null} className="rounded border border-blue-200 px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900/60 dark:text-blue-300 dark:hover:bg-blue-950/40">
                {dataSafetyAction === 'open' ? '打开中…' : '打开备份目录'}
              </button>
              <select value={exportScope} onChange={event => setExportScope(event.target.value as DataExportScope)} className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-200">
                {(['all', 'portfolio', 'forecasts', 'decisionSignals', 'settingsSummary'] as DataExportScope[]).map(scope => <option key={scope} value={scope}>{exportScopeLabel(scope)}</option>)}
              </select>
              <button type="button" data-testid="data-safety-export-data" onClick={() => void handleExportData()} disabled={dataSafetyAction !== null} className="rounded border border-purple-200 px-3 py-1.5 text-xs text-purple-700 hover:bg-purple-50 disabled:opacity-50 dark:border-purple-900/60 dark:text-purple-300 dark:hover:bg-purple-950/40">
                {dataSafetyAction === 'export' ? '导出中…' : '导出数据'}
              </button>
              <button type="button" data-testid="data-safety-export-base-package" onClick={() => void handleExportBasePackage()} disabled={dataSafetyAction !== null} className="rounded border border-cyan-200 px-3 py-1.5 text-xs text-cyan-700 hover:bg-cyan-50 disabled:opacity-50 dark:border-cyan-900/60 dark:text-cyan-300 dark:hover:bg-cyan-950/40">
                {dataSafetyAction === 'baseExport' ? '导出中…' : '导出全市场基座包'}
              </button>
              <button type="button" data-testid="data-safety-import-base-package" onClick={() => void handlePreviewBasePackage()} disabled={dataSafetyAction !== null} className="rounded border border-cyan-200 px-3 py-1.5 text-xs text-cyan-700 hover:bg-cyan-50 disabled:opacity-50 dark:border-cyan-900/60 dark:text-cyan-300 dark:hover:bg-cyan-950/40">
                {dataSafetyAction === 'basePreview' ? '读取中…' : '导入基座包'}
              </button>
            </div>
          </div>
        </section>

        {blockers.length > 0 && (
          <div data-testid="diagnostics-blockers" className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
            <div className="text-sm font-semibold text-amber-800 dark:text-amber-200">优先处理</div>
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {blockers.map(item => (
                <div key={item.key} className="rounded border border-amber-200 bg-white/70 p-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-gray-900/70 dark:text-amber-100">
                  <div className="font-medium">{item.title}</div>
                  <div className="mt-0.5 opacity-80">{item.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {snapshot?.groups.map(group => (
          <section key={group.key} data-testid={`diagnostics-group-${group.key}`} className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
            <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{group.title}</h3>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {group.items.map(item => (
                <div key={item.key} className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${STATUS_META[item.status].dot}`} />
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{item.title}</div>
                      <span className={`rounded border px-1.5 py-0.5 text-[11px] ${STATUS_META[item.status].className}`}>{STATUS_META[item.status].label}</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">{item.message}</div>
                    {item.detail && <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">{item.detail}</div>}
                    <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-gray-400 dark:text-gray-500">
                      {item.recordCount !== undefined && <span>记录数：{item.recordCount ?? '—'}</span>}
                      {item.latestDate !== undefined && <span>最近日期：{item.latestDate ?? '—'}</span>}
                    </div>
                  </div>
                  {item.actions && item.actions.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {item.actions.map(action => {
                        const runAction = runActionFromKey(action.key)
                        const isRunning = runAction !== null && runningAction === runAction
                        return (
                          <button
                            key={`${item.key}-${action.key}`}
                            type="button"
                            onClick={() => handleAction(action)}
                            disabled={isRunning || runningAction !== null}
                            className="rounded border border-blue-200 px-2.5 py-1.5 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900/60 dark:text-blue-300 dark:hover:bg-blue-950/40"
                          >
                            {isRunning ? '执行中…' : action.label}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
