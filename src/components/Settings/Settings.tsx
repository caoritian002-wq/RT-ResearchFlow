import { useEffect, useState } from 'react'
import { useAppStore } from '../../store/appStore'
import type { AppSettingsRow } from '../../../electron/main/database/types'
import { SupplyChainSettingsPanel } from '../SupplyChain/SupplyChainSettingsPanel'
import { ResearchAccessSettings } from './ResearchAccessSettings'
import { PremarketCaptureSettings } from './PremarketCaptureSettings'

const INTERVALS: { value: AppSettingsRow['scanIntervalMinutes']; label: string }[] = [
  { value: 5, label: '5 分钟' },
  { value: 10, label: '10 分钟' },
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '60 分钟' }
]

const CACHE_RANGES: { value: 'all' | '1month' | '3months' | '1year'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: '1month', label: '最近 1 个月' },
  { value: '3months', label: '最近 3 个月' },
  { value: '1year', label: '最近 1 年' }
]

const DECISION_NOTIFY_PRIORITIES = [3, 4, 5] as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function Settings() {
  const { settings, updateSettings } = useAppStore()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Cache management state
  const [cacheStats, setCacheStats] = useState<{ count: number; estimatedBytes: number } | null>(null)
  const [selectedRange, setSelectedRange] = useState<'all' | '1month' | '3months' | '1year'>('3months')
  const [clearing, setClearing] = useState(false)
  const [clearResult, setClearResult] = useState<string | null>(null)

  useEffect(() => {
    loadCacheStats()
  }, [])

  function loadCacheStats() {
    window.api.cache.getStats().then(setCacheStats)
  }

  if (!settings) return <div className="p-6 text-sm text-gray-400 dark:text-gray-500">加载中…</div>

  async function handleIntervalChange(value: AppSettingsRow['scanIntervalMinutes']) {
    setSaving(true)
    await updateSettings({ scanIntervalMinutes: value })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleRetentionChange(e: React.FocusEvent<HTMLInputElement>) {
    const val = parseInt(e.target.value)
    if (!val || val < 1) return
    await updateSettings({ retentionDays: val })
  }

  async function handleCatchUpDaysChange(e: React.FocusEvent<HTMLInputElement>) {
    const val = parseInt(e.target.value)
    if (!val || val < 1 || val > 30) return
    await updateSettings({ catchUpMaxDays: val })
  }

  async function handleClearCache() {
    setClearing(true)
    setClearResult(null)
    const deleted = await window.api.cache.clear(selectedRange)
    setClearing(false)
    setClearResult(`已清理 ${deleted} 条缓存`)
    loadCacheStats()
    setTimeout(() => setClearResult(null), 4000)
  }

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-5">应用设置</h2>

      {/* Scan interval */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">扫描频率</label>
        <div className="flex gap-2 flex-wrap">
          {INTERVALS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => handleIntervalChange(value)}
              disabled={saving}
              className={[
                'px-3 py-1.5 rounded border text-sm transition-colors',
                settings.scanIntervalMinutes === value
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        {saved && <p className="text-xs text-green-500 mt-1">已保存</p>}
      </section>

      {/* Data retention */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          数据保留天数
        </label>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">超过此天数的资讯将自动清理</p>
        <input
          type="number"
          defaultValue={settings.retentionDays}
          min={1}
          max={365}
          onBlur={handleRetentionChange}
          className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
        />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">天</span>
      </section>

      {/* Catch-up max days */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          启动补漏最大天数
        </label>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">程序关闭后重启时最多向前追溯的天数</p>
        <input
          type="number"
          defaultValue={settings.catchUpMaxDays}
          min={1}
          max={30}
          onBlur={handleCatchUpDaysChange}
          className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
        />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">天 (最大 30)</span>
      </section>

      {/* Default group expand */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">资讯分组默认展开</label>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">进入应用时，资讯列表按消息源分组的初始状态</p>
        <div className="flex gap-2">
          {([{ value: 1, label: '默认展开' }, { value: 0, label: '默认收起' }] as const).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => updateSettings({ defaultGroupExpanded: value })}
              className={[
                'px-3 py-1.5 rounded border text-sm transition-colors',
                settings.defaultGroupExpanded === value
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* AI auto-analysis prompt */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">扫描后自动AI分析</label>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">扫描完成后，若有达到触发等级的新资讯，弹出确认框询问是否发送AI分析</p>
        <div className="flex gap-2">
          {([{ value: 1, label: '开启' }, { value: 0, label: '关闭' }] as const).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => updateSettings({ autoAiAnalysisPrompt: value })}
              className={[
                'px-3 py-1.5 rounded border text-sm transition-colors',
                settings.autoAiAnalysisPrompt === value
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* FR-102: 行业动量窗口 */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          行业动量时间窗口
        </label>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">行业云图侧边榜单「动量 Top5」的对比时间长度（1–30 分钟）</p>
        <input
          type="number"
          defaultValue={settings.momentumWindowMinutes ?? 3}
          min={1}
          max={30}
          step={1}
          onBlur={async (e) => {
            const val = parseInt(e.target.value)
            if (!val || val < 1 || val > 30) { e.target.value = String(settings.momentumWindowMinutes ?? 3); return }
            await updateSettings({ momentumWindowMinutes: val })
          }}
          className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">分钟</span>
      </section>

      {/* FR-167: 今日看板 Windows 原生通知 */}
      <section className="mb-6 border-t border-gray-100 dark:border-gray-700 pt-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">今日看板系统通知</label>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
          新增高优先级信号时弹出 Windows 原生通知；同一信号去重更新不会重复弹出。
        </p>
        <div className="flex gap-2 mb-3">
          {([{ value: 1, label: '开启' }, { value: 0, label: '关闭' }] as const).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => updateSettings({ decision_notify_windows_enabled: value })}
              className={[
                'px-3 py-1.5 rounded border text-sm transition-colors',
                (settings.decision_notify_windows_enabled ?? 0) === value
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-gray-600 dark:text-gray-400">最低优先级</span>
          {DECISION_NOTIFY_PRIORITIES.map((priority) => (
            <button
              key={priority}
              onClick={() => updateSettings({ decision_notify_min_priority: priority })}
              disabled={(settings.decision_notify_windows_enabled ?? 0) !== 1}
              className={[
                'px-3 py-1.5 rounded border text-sm transition-colors disabled:opacity-40',
                (settings.decision_notify_min_priority ?? 4) === priority
                  ? 'bg-orange-500 text-white border-orange-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
              ].join(' ')}
            >
              P{priority}+
            </button>
          ))}
        </div>
      </section>

      <PremarketCaptureSettings />

      {/* Cache management */}
      <section className="mb-6 border-t border-gray-100 dark:border-gray-700 pt-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">详情缓存管理</label>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
          点击查看资讯正文时会缓存到本地，避免重复请求。
        </p>

        {/* Stats */}
        <div className="flex items-center gap-3 mb-4 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">
          <span>
            缓存条目：<strong className="text-gray-700 dark:text-gray-300">{cacheStats?.count ?? '—'}</strong>
          </span>
          <span>
            占用空间：<strong className="text-gray-700 dark:text-gray-300">
              {cacheStats ? formatBytes(cacheStats.estimatedBytes) : '—'}
            </strong>
          </span>
        </div>

        {/* Range selector */}
        <div className="flex gap-2 flex-wrap mb-3">
          {CACHE_RANGES.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setSelectedRange(value)}
              className={[
                'px-3 py-1.5 rounded border text-xs transition-colors',
                selectedRange === value
                  ? 'bg-orange-500 text-white border-orange-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500 hover:border-gray-300 dark:hover:border-gray-500'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={handleClearCache}
          disabled={clearing || (cacheStats?.count ?? 0) === 0}
          className="px-4 py-1.5 rounded border border-red-200 dark:border-red-700 text-red-600 text-sm hover:bg-red-50 dark:hover:bg-red-900/30 dark:bg-red-900/30 transition-colors disabled:opacity-40"
        >
          {clearing ? '清理中…' : '清理缓存'}
        </button>

        {clearResult && (
          <p className="text-xs text-green-600 mt-2">{clearResult}</p>
        )}
      </section>

      <ResearchAccessSettings />

      {/* ── 产业链传导分析 ──────────────────────────────────── */}
      <section className="border-t border-gray-200 dark:border-gray-700 pt-5">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">产业链传导分析</h2>
        <SupplyChainSettingsPanel />
      </section>
    </div>
  )
}
