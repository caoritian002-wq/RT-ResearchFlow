import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import type { Source, ParseStrategy, SourceCategory } from '../../../electron/main/database/types'
import { AppConfirmDialog } from '../shared/AppConfirmDialog'
import { publishAppToast } from '../shared/appToastBus'

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const CATEGORY_LABELS: Record<string, string> = {
  REGULATOR: '监管机构',
  CENTRAL_BANK: '中央银行',
  GOVERNMENT: '政府部门',
  STATE_MEDIA: '官方媒体',
  FINANCIAL_PRESS: '财经媒体',
  CUSTOM: '自定义'
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: '正常', color: 'text-green-500' },
  DEGRADED: { label: '降级', color: 'text-amber-500' },
  UNREACHABLE: { label: '不可达', color: 'text-red-500' },
  PARSE_FAILED: { label: '解析失败', color: 'text-red-500' },
  DISABLED: { label: '已禁用', color: 'text-gray-400 dark:text-gray-500' }
}

function formatBjDateTime(timestamp: number | null): string {
  if (!timestamp) return '暂无历史'
  return new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

interface AddSourceForm {
  nameCN: string
  nameEN: string
  url: string
  feedUrl: string
  parseStrategy: ParseStrategy
}

interface EditSourceForm {
  nameCN: string
  nameEN: string
  url: string
  feedUrl: string
  category: SourceCategory
  authorityWeight: number
  isEnabled: boolean
  isBuiltIn: boolean
  parseStrategy: ParseStrategy
  contentSelector: string
  financeSectionFilter: string
  detailSelector: string
}

function Toggle({
  value,
  onChange,
  disabled
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className={[
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
        value ? 'bg-blue-500' : 'bg-gray-200 dark:bg-gray-600',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white dark:bg-gray-900 transition-transform shadow',
          value ? 'translate-x-4' : 'translate-x-0.5'
        ].join(' ')}
      />
    </button>
  )
}

export function SourceManager() {
  const { sources, loadSources } = useAppStore()
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingSource, setEditingSource] = useState<Source | null>(null)
  const [addForm, setAddForm] = useState<AddSourceForm>({
    nameCN: '',
    nameEN: '',
    url: '',
    feedUrl: '',
    parseStrategy: 'RSS'
  })
  const [editForm, setEditForm] = useState<EditSourceForm | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Source | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    ok: boolean
    message: string
    sampleArticles?: Array<{ title: string; url: string }>
    detailChecks?: Array<{ selector: string; matched: boolean; snippet?: string; error?: string }>
  } | null>(null)

  function openSettings(source: Source) {
    setEditingSource(source)
    setEditForm({
      nameCN: source.nameCN,
      nameEN: source.nameEN,
      url: source.url,
      feedUrl: source.feedUrl ?? '',
      category: source.category,
      authorityWeight: source.authorityWeight,
      isEnabled: source.isEnabled,
      isBuiltIn: source.isBuiltIn,
      parseStrategy: source.parseStrategy,
      contentSelector: source.contentSelector ?? '',
      financeSectionFilter: source.financeSectionFilter ?? '',
      detailSelector: source.detailSelector ?? ''
    })
    setError(null)
  }

  function closeSettings() {
    setEditingSource(null)
    setEditForm(null)
    setError(null)
  }

  async function handleToggle(id: number, isEnabled: boolean) {
    await window.api.sources.toggle(id, !isEnabled)
    loadSources()
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const deleted = await window.api.sources.delete(deleteTarget.id)
      if (!deleted) throw new Error('未找到可删除的自定义监控源，列表可能已经更新。')
      await loadSources()
      publishAppToast(`监控源“${deleteTarget.nameCN}”已删除。`, 'success')
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '删除监控源失败，请稍后重试。')
    } finally {
      setDeleteBusy(false)
    }
  }

  async function handleAddSource(e: React.FormEvent) {
    e.preventDefault()
    if (!addForm.nameCN || !addForm.url) {
      setError('名称和URL为必填项')
      return
    }
    if (!isValidHttpUrl(addForm.url)) {
      setError('主页 URL 格式无效，必须以 http:// 或 https:// 开头')
      return
    }
    if (addForm.feedUrl && !isValidHttpUrl(addForm.feedUrl)) {
      setError('Feed URL 格式无效，必须以 http:// 或 https:// 开头')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await window.api.sources.add({
        nameCN: addForm.nameCN,
        nameEN: addForm.nameEN || addForm.nameCN,
        url: addForm.url,
        feedUrl: addForm.feedUrl || undefined,
        parseStrategy: addForm.parseStrategy
      })
      loadSources()
      setShowAddForm(false)
      setAddForm({ nameCN: '', nameEN: '', url: '', feedUrl: '', parseStrategy: 'RSS' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault()
    if (!editingSource || !editForm) return
    if (!editForm.nameCN || !editForm.url) {
      setError('名称和URL为必填项')
      return
    }
    if (!isValidHttpUrl(editForm.url)) {
      setError('主页 URL 格式无效，必须以 http:// 或 https:// 开头')
      return
    }
    if (editForm.feedUrl && !isValidHttpUrl(editForm.feedUrl)) {
      setError('Feed URL 格式无效，必须以 http:// 或 https:// 开头')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await window.api.sources.update(editingSource.id, {
        nameCN: editForm.nameCN,
        nameEN: editForm.nameEN,
        url: editForm.url,
        feedUrl: editForm.feedUrl || null,
        category: editForm.category,
        authorityWeight: editForm.authorityWeight,
        isEnabled: editForm.isEnabled,
        parseStrategy: editForm.parseStrategy,
        contentSelector: editForm.contentSelector || null,
        financeSectionFilter: editForm.financeSectionFilter || null,
        detailSelector: editForm.detailSelector || null
      })
      loadSources()
      closeSettings()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleTestSource(sourceId: number) {
    setIsTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.sources.test(sourceId)
      if (result.ok) {
        setTestResult({
          ok: true,
          message: '测试成功，已抓取到样本文章。',
          sampleArticles: result.sampleArticles,
          detailChecks: result.detailChecks
        })
      } else {
        setTestResult({
          ok: false,
          message: result.error || '测试失败，请检查配置或网络情况。'
        })
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : '测试请求失败'
      })
    } finally {
      setIsTesting(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">监控源管理</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="ml-auto text-xs px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
        >
          + 添加自定义源
        </button>
      </div>

      {/* Add source form */}
      {showAddForm && (
        <form onSubmit={handleAddSource} className="px-4 py-3 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">中文名称 *</label>
              <input
                value={addForm.nameCN}
                onChange={(e) => setAddForm({ ...addForm, nameCN: e.target.value })}
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                placeholder="例：财联社"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">英文名称</label>
              <input
                value={addForm.nameEN}
                onChange={(e) => setAddForm({ ...addForm, nameEN: e.target.value })}
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                placeholder="例：Cailian Press"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">主页 URL *</label>
              <input
                value={addForm.url}
                onChange={(e) => setAddForm({ ...addForm, url: e.target.value })}
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                placeholder="https://example.com"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">RSS/Feed URL</label>
              <input
                value={addForm.feedUrl}
                onChange={(e) => setAddForm({ ...addForm, feedUrl: e.target.value })}
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                placeholder="https://example.com/feed"
              />
            </div>
          </div>
          <div className="mb-3">
            <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">解析方式</label>
            <select
              value={addForm.parseStrategy}
              onChange={(e) => setAddForm({ ...addForm, parseStrategy: e.target.value as ParseStrategy })}
              className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
            >
              <option value="RSS">RSS</option>
              <option value="ATOM">Atom</option>
              <option value="HTML_SCRAPE">HTML 抓取</option>
            </select>
          </div>
          {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="text-xs px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 transition-colors"
            >
              {submitting ? '添加中…' : '确认添加'}
            </button>
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="text-xs px-3 py-1.5 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500 rounded hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
            >
              取消
            </button>
          </div>
        </form>
      )}

      {/* Source list */}
      <div className="flex-1 overflow-y-auto">
        {sources.map((source) => {
          const statusInfo = STATUS_LABELS[source.status] ?? { label: source.status, color: 'text-gray-500 dark:text-gray-400 dark:text-gray-500' }
          return (
            <div
              key={source.id}
              data-testid={`source-row-${source.id}`}
              className="flex items-center px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{source.nameCN}</span>
                  <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                    {CATEGORY_LABELS[source.category] ?? source.category}
                  </span>
                  <span className={`text-xs shrink-0 ${statusInfo.color}`}>{statusInfo.label}</span>
                </div>
                <p className="text-xs text-gray-400 dark:text-gray-500 truncate">{source.feedUrl ?? source.url}</p>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-gray-500 dark:text-gray-400">
                  <span>{source.lastScannedAt ? formatBjDateTime(source.lastScannedAt) : '未扫描'}</span>
                  <span>成功率 {Math.round((source.successRate ?? 0) * 100)}%</span>
                </div>
              </div>

              <div className="flex items-center gap-2 ml-3 shrink-0">
                {/* Quick enable/disable toggle */}
                <Toggle
                  value={source.isEnabled}
                  onChange={() => handleToggle(source.id, source.isEnabled)}
                />

                <button
                  onClick={() => handleTestSource(source.id)}
                  className="text-xs px-2 py-1 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500 rounded hover:bg-gray-100 dark:hover:bg-gray-700 dark:bg-gray-700 transition-colors"
                  title="测试采集配置"
                  disabled={isTesting}
                >
                  {isTesting ? '测试中…' : '测试'}
                </button>

                {/* Settings button */}
                <button
                  onClick={() => openSettings(source)}
                  className="text-xs px-2 py-1 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500 rounded hover:bg-gray-100 dark:hover:bg-gray-700 dark:bg-gray-700 transition-colors"
                  title="配置"
                >
                  设置
                </button>

                {/* Delete (custom sources only) */}
                {!source.isBuiltIn && (
                  <button
                    onClick={() => {
                      setDeleteError(null)
                      setDeleteTarget(source)
                    }}
                    type="button"
                    aria-label={`删除监控源 ${source.nameCN}`}
                    className="flex h-11 w-11 items-center justify-center rounded-md text-lg leading-none text-red-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 dark:hover:bg-red-950/35"
                    title="删除"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Settings modal */}
      {editingSource && editForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-[520px] max-h-[85vh] overflow-y-auto">
            <div className="flex items-center px-5 py-3 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                配置监控源：{editingSource.nameCN}
              </h3>
              <button
                onClick={closeSettings}
                className="ml-auto text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500 transition-colors text-lg leading-none"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSaveSettings} className="px-5 py-4 space-y-4">
              {/* Basic info */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">中文名称 *</label>
                  <input
                    value={editForm.nameCN}
                    onChange={(e) => setEditForm({ ...editForm, nameCN: e.target.value })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">英文名称</label>
                  <input
                    value={editForm.nameEN}
                    onChange={(e) => setEditForm({ ...editForm, nameEN: e.target.value })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">主页 URL *</label>
                  <input
                    value={editForm.url}
                    onChange={(e) => setEditForm({ ...editForm, url: e.target.value })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">RSS/Feed URL</label>
                  <input
                    value={editForm.feedUrl}
                    onChange={(e) => setEditForm({ ...editForm, feedUrl: e.target.value })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                    placeholder="留空则使用HTML抓取"
                  />
                </div>
              </div>

              {/* Category + authority weight */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">分类</label>
                  <select
                    value={editForm.category}
                    onChange={(e) => setEditForm({ ...editForm, category: e.target.value as SourceCategory })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">权威权重（1–10）</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={editForm.authorityWeight}
                    onChange={(e) =>
                      setEditForm({ ...editForm, authorityWeight: Math.min(10, Math.max(1, parseInt(e.target.value) || 1)) })
                    }
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                  />
                </div>
              </div>

              {/* Parse strategy + content selector */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">解析方式</label>
                  <select
                    value={editForm.parseStrategy}
                    onChange={(e) => setEditForm({ ...editForm, parseStrategy: e.target.value as ParseStrategy })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                  >
                    <option value="RSS">RSS</option>
                    <option value="ATOM">Atom</option>
                    <option value="HTML_SCRAPE">HTML 抓取</option>
                    <option value="API">API</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">内容选择器（CSS）</label>
                  <input
                    value={editForm.contentSelector}
                    onChange={(e) => setEditForm({ ...editForm, contentSelector: e.target.value })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                    placeholder=".news-list li a"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">财经板块过滤路径</label>
                  <input
                    value={editForm.financeSectionFilter}
                    onChange={(e) => setEditForm({ ...editForm, financeSectionFilter: e.target.value })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                    placeholder="/finance/"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">详情页正文选择器（detailSelector）</label>
                  <input
                    value={editForm.detailSelector}
                    onChange={(e) => setEditForm({ ...editForm, detailSelector: e.target.value })}
                    className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                    placeholder=".detail-news（留空则不抓取正文）"
                  />
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    点击详情时按需抓取详情页，结果缓存本地
                  </p>
                </div>
              </div>

              {/* Boolean toggles */}
              <div className="space-y-2.5 pt-1 border-t border-gray-100 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-gray-700 dark:text-gray-300">启用状态（isEnabled）</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">关闭后不参与扫描，历史数据保留</p>
                  </div>
                  <Toggle
                    value={editForm.isEnabled}
                    onChange={(v) => setEditForm({ ...editForm, isEnabled: v })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-gray-700 dark:text-gray-300">内置来源（isBuiltIn）</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">内置来源不可删除</p>
                  </div>
                  <Toggle
                    value={editForm.isBuiltIn}
                    onChange={(v) => setEditForm({ ...editForm, isBuiltIn: v })}
                  />
                </div>
              </div>

              {error && <p className="text-xs text-red-500">{error}</p>}
              {testResult && (
                <div className={['mb-3 rounded-md border px-3 py-2 text-xs', testResult.ok ? 'border-green-200 bg-green-50 text-green-700 dark:border-green-700 dark:bg-green-900/20 dark:text-green-200' : 'border-red-200 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-200'].join(' ')}>
                  <div className="font-medium">测试结果：</div>
                  <div className="mt-1">{testResult.message}</div>
                  {testResult.sampleArticles && testResult.sampleArticles.length > 0 && (
                    <div className="mt-2">
                      <div className="font-medium">样本文章：</div>
                      <ul className="list-disc list-inside mt-1 space-y-1">
                        {testResult.sampleArticles.map((item) => (
                          <li key={item.url} className="truncate">{item.title} — {item.url}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {testResult.detailChecks && testResult.detailChecks.length > 0 && (
                    <div className="mt-2">
                      <div className="font-medium">详情页选择器测试：</div>
                      <ul className="list-disc list-inside mt-1 space-y-1 text-xs">
                        {testResult.detailChecks.map((check) => (
                          <li key={check.selector}>
                            <span className={check.matched ? 'text-green-700 dark:text-green-200' : 'text-red-700 dark:text-red-200'}>
                              {check.matched ? '匹配' : '未匹配'}
                            </span> {check.selector}{check.error ? ` — ${check.error}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2 items-center pt-1">
                <button
                  type="button"
                  onClick={() => handleTestSource(editingSource.id)}
                  disabled={isTesting}
                  className="text-xs px-4 py-1.5 bg-amber-500 text-white rounded hover:bg-amber-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 transition-colors"
                >
                  {isTesting ? '测试中…' : '测试当前配置'}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="text-xs px-4 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 transition-colors"
                >
                  {submitting ? '保存中…' : '保存配置'}
                </button>
                <button
                  type="button"
                  onClick={closeSettings}
                  className="text-xs px-4 py-1.5 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500 rounded hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
                >
                  取消
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <AppConfirmDialog
        open={deleteTarget != null}
        title="删除自定义监控源"
        message="删除后将不再扫描这个来源，已归档的历史资讯不会被移除。"
        tone="danger"
        confirmLabel="删除来源"
        busy={deleteBusy}
        error={deleteError}
        testId="source-delete-dialog"
        onCancel={() => {
          setDeleteTarget(null)
          setDeleteError(null)
        }}
        onConfirm={() => { void confirmDelete() }}
      >
        {deleteTarget && (
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-slate-500 dark:text-slate-400">来源</dt>
            <dd className="font-medium text-slate-900 dark:text-slate-100">{deleteTarget.nameCN}</dd>
            <dt className="text-slate-500 dark:text-slate-400">地址</dt>
            <dd className="min-w-0 break-all text-slate-700 dark:text-slate-200">{deleteTarget.url}</dd>
          </dl>
        )}
      </AppConfirmDialog>
    </div>
  )
}
