export const TREND_WATCHER_SUB_TABS = [
  { key: 'portfolio', label: '持仓总览' },
  { key: 'dashboard', label: '趋势雷达' },
  { key: 'alerts', label: '趋势事件' },
  { key: 'manage', label: '观察池' },
] as const

export type TrendWatcherSubTab = typeof TREND_WATCHER_SUB_TABS[number]['key']
