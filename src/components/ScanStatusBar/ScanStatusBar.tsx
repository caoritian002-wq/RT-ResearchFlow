import { useAppStore } from '../../store/appStore'

export function ScanStatusBar() {
  const { isScanning, decisionUnreadHighPriorityCount } = useAppStore()

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
      <span className="font-semibold text-gray-800 dark:text-gray-200 text-sm">RT-ResearchFlow</span>
      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">投研工作台</span>
      {isScanning && (
        <span className="flex items-center gap-1 text-blue-600 dark:text-blue-300">
          <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
          资讯扫描中
        </span>
      )}
      {decisionUnreadHighPriorityCount > 0 && (
        <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
          今日看板 {decisionUnreadHighPriorityCount} 条高优先级未读
        </span>
      )}
    </div>
  )
}
