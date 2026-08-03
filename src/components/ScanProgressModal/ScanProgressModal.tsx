import { useState } from 'react'
import { useAppStore } from '../../store/appStore'
import type { ScanProgressRow } from '../../store/appStore'

const STATUS_LABEL: Record<ScanProgressRow['status'], string> = {
  PENDING: '等待中',
  SCANNING: '扫描中',
  SUCCESS: '成功',
  FAILED: '失败'
}

const STATUS_STYLE: Record<ScanProgressRow['status'], string> = {
  PENDING: 'text-gray-400 dark:text-gray-500',
  SCANNING: 'text-blue-500',
  SUCCESS: 'text-green-600',
  FAILED: 'text-red-500 cursor-pointer hover:underline decoration-dotted'
}

export function ScanProgressModal() {
  const { scanProgressModal, closeScanProgressModal, isScanning } = useAppStore()
  const { isOpen, rows } = scanProgressModal

  const [errorRow, setErrorRow] = useState<ScanProgressRow | null>(null)
  // copiedUrl: which URL cell is showing "已复制"
  const [copiedSourceId, setCopiedSourceId] = useState<number | null>(null)

  if (!isOpen) return null

  const done = rows.filter((r) => r.status === 'SUCCESS' || r.status === 'FAILED').length
  const total = rows.length
  const newTotal = rows.reduce((sum, r) => sum + r.newCount, 0)

  function handleCopyUrl(e: React.MouseEvent, row: ScanProgressRow) {
    e.stopPropagation()
    navigator.clipboard.writeText(row.url).then(() => {
      setCopiedSourceId(row.sourceId)
      setTimeout(() => setCopiedSourceId(null), 2000)
    })
  }

  function handleStatusClick(e: React.MouseEvent, row: ScanProgressRow) {
    e.stopPropagation()
    if (row.status === 'FAILED') setErrorRow(row)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-[680px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold text-gray-800 dark:text-gray-200">扫描进度</h2>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {isScanning
                ? `已完成 ${done} / ${total} 个监控源`
                : `扫描完成 — 共新增 ${newTotal} 条简报`}
            </p>
          </div>
          <button
            onClick={closeScanProgressModal}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500 text-lg leading-none px-1"
            title="关闭（不影响扫描）"
          >
            ✕
          </button>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700">
              <tr>
                <th className="text-left px-6 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400 dark:text-gray-500 w-32">监控源</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400 dark:text-gray-500">
                  扫描 URL
                  <span className="ml-1 text-gray-300 font-normal">（点击复制）</span>
                </th>
                <th className="text-center px-4 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400 dark:text-gray-500 w-20">状态</th>
                <th className="text-center px-4 py-2.5 text-xs font-medium text-gray-500 dark:text-gray-400 dark:text-gray-500 w-20">新增条目</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
              {rows.map((row) => (
                <tr key={row.sourceId} className="hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800/60">
                  <td className="px-6 py-2.5 font-medium text-gray-800 dark:text-gray-200 truncate max-w-[120px]">
                    {row.sourceName}
                  </td>

                  {/* URL cell — click to copy */}
                  <td
                    className="px-4 py-2.5 text-xs truncate max-w-[260px] cursor-pointer select-none"
                    onClick={(e) => handleCopyUrl(e, row)}
                    title="点击复制"
                  >
                    {copiedSourceId === row.sourceId ? (
                      <span className="text-green-500 font-medium">已复制 ✓</span>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500">{row.url}</span>
                    )}
                  </td>

                  {/* Status cell — click to show error (FAILED only) */}
                  <td
                    className={[
                      'px-4 py-2.5 text-center text-xs font-medium',
                      STATUS_STYLE[row.status]
                    ].join(' ')}
                    onClick={(e) => handleStatusClick(e, row)}
                    title={row.status === 'FAILED' ? '点击查看错误详情' : undefined}
                  >
                    {row.status === 'SCANNING' && (
                      <span className="mr-1 inline-block w-2 h-2 rounded-full bg-blue-400 animate-ping" />
                    )}
                    {STATUS_LABEL[row.status]}
                  </td>

                  <td className="px-4 py-2.5 text-center text-gray-700 dark:text-gray-300">
                    {row.status === 'SUCCESS' ? row.newCount : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-3 border-t border-gray-100 dark:border-gray-700">
          <button
            onClick={closeScanProgressModal}
            className="px-4 py-1.5 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 dark:bg-gray-700"
          >
            关闭
          </button>
          {isScanning && (
            <button
              onClick={() => window.api.scan.stop()}
              className="px-4 py-1.5 text-sm text-white bg-red-500 hover:bg-red-600 rounded-lg"
            >
              停止扫描
            </button>
          )}
        </div>
      </div>

      {/* Error detail overlay */}
      {errorRow && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/30"
          onClick={() => setErrorRow(null)}
        >
          <div
            className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-[560px] max-h-[60vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 dark:border-gray-700">
              <div>
                <h3 className="text-sm font-semibold text-red-600">扫描失败详情</h3>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{errorRow.sourceName}</p>
              </div>
              <button
                onClick={() => setErrorRow(null)}
                className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500 text-lg leading-none px-1"
              >
                ✕
              </button>
            </div>
            <div className="px-5 py-4 overflow-y-auto flex-1">
              <pre className="text-xs text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/30 rounded-lg p-3 whitespace-pre-wrap break-all font-mono leading-relaxed">
                {errorRow.error ?? '未知错误'}
              </pre>
            </div>
            <div className="flex justify-end px-5 py-3 border-t border-gray-100 dark:border-gray-700">
              <button
                onClick={() => setErrorRow(null)}
                className="px-4 py-1.5 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 dark:bg-gray-700"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
