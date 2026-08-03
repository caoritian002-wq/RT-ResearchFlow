import React from 'react'
import { DialogFrame } from './ResearchProjectDialog'

export type ResearchConfirmTone = 'danger' | 'warning' | 'default'

export interface ResearchConfirmRequest {
  title: string
  description: string
  details?: string[]
  confirmLabel?: string
  cancelLabel?: string
  tone?: ResearchConfirmTone
}

interface Props {
  open: boolean
  request: ResearchConfirmRequest | null
  saving?: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: () => void
}

const TONE_BUTTON: Record<ResearchConfirmTone, string> = {
  danger: 'bg-red-600 hover:bg-red-500 text-white',
  warning: 'bg-amber-600 hover:bg-amber-500 text-white',
  default: 'bg-cyan-700 hover:bg-cyan-600 text-white',
}

export function ResearchConfirmDialog({
  open,
  request,
  saving = false,
  error = null,
  onCancel,
  onConfirm,
}: Props): React.ReactElement | null {
  if (!open || !request) return null
  const tone = request.tone || 'default'
  return (
    <DialogFrame title={request.title} onClose={saving ? () => undefined : onCancel}>
      <div className="space-y-3">
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">{request.description}</p>
        {request.details && request.details.length > 0 && (
          <ul className="space-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
            {request.details.map((item) => (
              <li key={item}>• {item}</li>
            ))}
          </ul>
        )}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <button
            type="button"
            disabled={saving}
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-40 dark:border-slate-700"
          >
            {request.cancelLabel || '取消'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={onConfirm}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${TONE_BUTTON[tone]}`}
          >
            {saving ? '处理中…' : (request.confirmLabel || '确认')}
          </button>
        </div>
      </div>
    </DialogFrame>
  )
}