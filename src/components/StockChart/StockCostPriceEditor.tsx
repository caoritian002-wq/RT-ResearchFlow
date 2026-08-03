import { useEffect, useState } from 'react'

interface StockCostPriceEditorProps {
  open: boolean
  stockName: string
  costPrice: number | null
  saving: boolean
  error: string | null
  onSave: (costPrice: number | null) => void
  onClose: () => void
}

export function StockCostPriceEditor({ open, stockName, costPrice, saving, error, onSave, onClose }: StockCostPriceEditorProps) {
  const [value, setValue] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValue(costPrice == null ? '' : String(costPrice))
    setLocalError(null)
  }, [costPrice, open])

  if (!open) return null

  const handleSave = () => {
    const trimmed = value.trim()
    if (trimmed === '') {
      onSave(null)
      return
    }
    const next = Number(trimmed)
    if (!Number.isFinite(next) || next <= 0) {
      setLocalError('成本价必须为正数')
      return
    }
    onSave(next)
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 px-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">补充持仓成本价</h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{stockName} 的成本价仅作为本地辅助复盘信息, 不代表券商真实持仓。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >关闭</button>
        </div>

        <label className="mt-4 block text-xs font-medium text-gray-600 dark:text-gray-300">
          成本价
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              setLocalError(null)
            }}
            placeholder="留空可清空成本价"
            inputMode="decimal"
            className="mt-1 w-full rounded border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
          />
        </label>

        {(localError || error) && (
          <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
            {localError || error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onSave(null)}
            disabled={saving}
            className="rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >清空</button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>
    </div>
  )
}
