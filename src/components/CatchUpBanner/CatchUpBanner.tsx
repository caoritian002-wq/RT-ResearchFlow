import { useAppStore } from '../../store/appStore'

export function CatchUpBanner() {
  const { catchUpMessage, setCatchUpMessage } = useAppStore()

  if (!catchUpMessage) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-700 text-xs text-amber-800 dark:text-amber-200">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
      <span>{catchUpMessage}</span>
      <button
        onClick={() => setCatchUpMessage(null)}
        className="ml-auto text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:text-amber-200"
        aria-label="关闭"
      >
        ✕
      </button>
    </div>
  )
}
