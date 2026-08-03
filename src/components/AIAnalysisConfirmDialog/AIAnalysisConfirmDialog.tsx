import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../store/appStore'

const RATING_LABELS: Record<string, { label: string; color: string }> = {
  CRITICAL: { label: '重大', color: 'bg-red-100 text-red-700 dark:text-red-400' },
  IMPORTANT: { label: '重要', color: 'bg-orange-100 text-orange-700' },
  GENERAL: { label: '一般', color: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500' }
}

export function AIAnalysisConfirmDialog() {
  const { aiPendingAnalysis, setAIPendingAnalysis, runAIAnalysis, setActiveTab } = useAppStore()
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [showTushareWarning, setShowTushareWarning] = useState(false)
  const headerCheckboxRef = useRef<HTMLInputElement>(null)

  const articles = aiPendingAnalysis?.articles ?? []
  const scanRunId = aiPendingAnalysis?.scanRunId ?? null
  const selectableIds = articles.filter((a) => !a.isExpired).map((a) => a.id)

  // Re-initialize selected IDs whenever dialog opens or articles change
  useEffect(() => {
    setSelectedIds(new Set(articles.filter((a) => !a.isExpired).map((a) => a.id)))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiPendingAnalysis])

  // Sync the header checkbox indeterminate state after every render
  useEffect(() => {
    const el = headerCheckboxRef.current
    if (!el) return
    const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id))
    const someSelected = selectableIds.some((id) => selectedIds.has(id))
    el.checked = allSelected
    el.indeterminate = someSelected && !allSelected
  })

  if (!aiPendingAnalysis) return null

  const expiredCount = articles.length - selectableIds.length

  function handleCancel() {
    setAIPendingAnalysis(null)
  }

  async function handleConfirm() {
    // FR-071: Check if Tushare is configured before proceeding
    try {
      const dsConfig = await window.api.datasource.getConfig() as { tushareEnabled: boolean; hasTushareToken: boolean }
      if (!dsConfig.tushareEnabled || !dsConfig.hasTushareToken) {
        setShowTushareWarning(true)
        return
      }
    } catch {
      // If check fails, proceed anyway
    }
    const selectedArticles = articles.filter((a) => selectedIds.has(a.id))
    runAIAnalysis({ scanRunId, articles: selectedArticles })
  }

  function handleGoToDataSource() {
    setAIPendingAnalysis(null)
    setActiveTab('datasource')
  }

  function handleIgnoreAndAnalyze() {
    setShowTushareWarning(false)
    const selectedArticles = articles.filter((a) => selectedIds.has(a.id))
    runAIAnalysis({ scanRunId, articles: selectedArticles })
  }

  function handleToggleAll() {
    if (selectableIds.every((id) => selectedIds.has(id))) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(selectableIds))
    }
  }

  function handleToggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  if (showTushareWarning) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl p-6 w-full max-w-sm mx-4">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">未配置数据源</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-5">
            当前未启用 Tushare，系统仍会优先使用本地已有日线完成第二轮复核，但无法主动补拉候选股票的最新数据。本地行情不足时会明确标记复核受阻。
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={handleIgnoreAndAnalyze}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
            >
              使用本地行情继续
            </button>
            <button
              onClick={handleGoToDataSource}
              className="px-4 py-2 text-sm text-white bg-blue-500 rounded hover:bg-blue-600 transition-colors"
            >
              去配置
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl p-6 w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">AI 分析确认</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500 mb-3">
          共 <span className="font-medium text-blue-600">{selectedIds.size}</span> 条资讯将发送给 AI 分析
          {expiredCount > 0 && (
            <span className="ml-1 text-gray-400 dark:text-gray-500">（已排除 {expiredCount} 条超期）</span>
          )}
        </p>

        {/* Article list with checkbox column */}
        <div className="flex-1 overflow-y-auto border border-gray-100 dark:border-gray-700 rounded mb-4">
          {/* Select-all header row */}
          <div className="flex items-center px-3 py-1.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 gap-2 shrink-0">
            <input
              ref={headerCheckboxRef}
              type="checkbox"
              onChange={handleToggleAll}
              className="rounded cursor-pointer"
              title="全选/取消全选"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 select-none">全选</span>
          </div>

          {/* Individual rows */}
          <div className="divide-y divide-gray-50 dark:divide-gray-700">
            {articles.map((article) => {
              const rating = RATING_LABELS[article.impactRating] ?? { label: article.impactRating, color: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 dark:text-gray-500' }
              return (
                <div
                  key={article.id}
                  className={['px-3 py-2 flex items-start gap-2', article.isExpired ? 'opacity-40' : ''].join(' ')}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(article.id)}
                    onChange={() => handleToggleOne(article.id)}
                    disabled={article.isExpired}
                    className="rounded mt-0.5 shrink-0 cursor-pointer disabled:cursor-default"
                  />
                  <span className={['text-xs px-1.5 py-0.5 rounded font-medium shrink-0 mt-0.5', rating.color].join(' ')}>
                    {rating.label}
                  </span>
                  <div className="min-w-0">
                    <a
                      href={article.originalUrl}
                      onClick={(e) => { e.preventDefault(); window.api.openExternal(article.originalUrl) }}
                      className="text-sm text-blue-600 hover:underline line-clamp-2 cursor-pointer"
                    >
                      {article.title}
                    </a>
                    <p className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">{article.originalUrl}</p>
                  </div>
                  {article.isExpired && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0 ml-auto">超期</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={selectedIds.size === 0}
            className="px-4 py-2 text-sm text-white bg-blue-500 rounded hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            发送给 AI（{selectedIds.size} 条）
          </button>
        </div>
      </div>
    </div>
  )
}
