import { useEffect } from 'react'
import { SourceManager } from '../SourceManager/SourceManager'
import { Settings } from '../Settings/Settings'
import { AIConfig } from '../AIConfig/AIConfig'
import { DataSource } from '../DataSource/DataSource'
import { DiagnosticsPanel } from '../Diagnostics/DiagnosticsPanel'
import { UserTierDevPanel } from './UserTierDevPanel'
import { PriorityNewsPreviewDevPanel } from './PriorityNewsPreviewDevPanel'
import type { InitializationFlowState } from '../Onboarding/initializationTaskModel'
import type { PriorityNewsPreviewState } from '../DecisionSignalToast/useDecisionSignalToastPreview'

export type ConfigDrawerTab = 'sources' | 'settings' | 'appearance' | 'ai-config' | 'datasource' | 'diagnostics' | 'user-tier-dev' | 'notification-preview-dev'

interface ConfigDrawerProps {
  open: boolean
  activeTab: ConfigDrawerTab
  onTabChange: (tab: ConfigDrawerTab) => void
  onClose: () => void
  onOpenGuide?: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  initializationFlow?: InitializationFlowState
  onStartInitialization?: () => void
  priorityNewsPreview?: PriorityNewsPreviewState
  onStartPriorityNewsPreview?: () => Promise<void>
  onShowNextPriorityNewsPreview?: () => Promise<void>
  onStopPriorityNewsPreview?: () => void
}

const CONFIG_TABS: Array<{ key: ConfigDrawerTab; label: string }> = [
  { key: 'sources', label: '监控源' },
  { key: 'settings', label: '设置' },
  { key: 'appearance', label: '外观' },
  { key: 'ai-config', label: 'AI配置' },
  { key: 'datasource', label: '数据源' },
  { key: 'diagnostics', label: '诊断' },
  ...(import.meta.env.DEV ? [
    { key: 'user-tier-dev' as const, label: '用户层级' },
    { key: 'notification-preview-dev' as const, label: '通知验收' },
  ] : [])
]

export function ConfigDrawer({ open, activeTab, onTabChange, onClose, onOpenGuide, theme, onToggleTheme, initializationFlow, onStartInitialization, priorityNewsPreview, onStartPriorityNewsPreview, onShowNextPriorityNewsPreview, onStopPriorityNewsPreview }: ConfigDrawerProps) {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div data-testid="config-drawer" className="electron-no-drag fixed inset-0 z-[9999] flex justify-end">
      <button
        type="button"
        aria-label="关闭配置抽屉"
        className="electron-no-drag absolute inset-0 bg-black/30 dark:bg-black/50"
        onClick={onClose}
      />
      <aside className="electron-no-drag relative z-[71] flex h-full w-[min(920px,92vw)] flex-col border-l border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-2xl animate-[slideInFromRight_180ms_ease-out]">
        <div className="electron-no-drag flex items-center gap-3 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
          <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">配置中心</div>
          <div className="electron-no-drag flex rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
            {CONFIG_TABS.map(tab => (
              <button
                key={tab.key}
                type="button"
                data-testid={`config-tab-${tab.key}`}
                onClick={() => onTabChange(tab.key)}
                className={[
                  'electron-no-drag px-3 py-1.5 text-xs transition-colors',
                  activeTab === tab.key
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                ].join(' ')}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {onOpenGuide && (
            <button
              type="button"
              data-testid="config-open-onboarding-guide-btn"
              onClick={onOpenGuide}
              className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-medium text-cyan-800 shadow-sm transition-colors hover:border-cyan-300 hover:bg-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 dark:border-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-100 dark:hover:bg-cyan-900/70 dark:focus:ring-offset-gray-900"
              aria-label="打开新用户引导"
            >
              新用户引导
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-100"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-white dark:bg-gray-900">
          {activeTab === 'sources' && (
            <div className="h-full overflow-hidden">
              <SourceManager />
            </div>
          )}
          {activeTab === 'settings' && (
            <div className="h-full overflow-y-auto">
              <Settings />
            </div>
          )}
          {activeTab === 'appearance' && (
            <div data-testid="config-panel-appearance" className="h-full overflow-y-auto bg-slate-50 p-5 dark:bg-gray-950">
              <section className="mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                <div className="flex flex-col gap-2 border-b border-slate-100 pb-4 dark:border-gray-800">
                  <h2 className="text-base font-semibold text-slate-900 dark:text-gray-100">外观</h2>
                  <p className="text-sm leading-6 text-slate-500 dark:text-gray-400">
                    主题设置已收纳到配置中心。切换后会立即应用到全局界面, 并复用现有主题持久化能力。
                  </p>
                </div>
                <div className="mt-5 flex flex-col gap-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-gray-800 dark:bg-gray-950">
                  <div>
                    <div className="text-sm font-medium text-slate-800 dark:text-gray-100">当前主题</div>
                    <div className="mt-1 text-sm text-slate-500 dark:text-gray-400">{theme === 'dark' ? '暗色模式' : '亮色模式'}</div>
                  </div>
                  <div className="flex flex-wrap gap-2" role="group" aria-label="主题模式">
                    <button
                      type="button"
                      onClick={() => { if (theme !== 'light') onToggleTheme() }}
                      className={[
                        'min-h-11 rounded-md border px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 dark:focus:ring-offset-gray-950',
                        theme === 'light'
                          ? 'border-cyan-500 bg-cyan-50 text-cyan-800 dark:border-cyan-600 dark:bg-cyan-950 dark:text-cyan-100'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                      ].join(' ')}
                      aria-pressed={theme === 'light'}
                    >
                      亮色模式
                    </button>
                    <button
                      type="button"
                      onClick={() => { if (theme !== 'dark') onToggleTheme() }}
                      className={[
                        'min-h-11 rounded-md border px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:ring-offset-2 dark:focus:ring-offset-gray-950',
                        theme === 'dark'
                          ? 'border-cyan-500 bg-cyan-50 text-cyan-800 dark:border-cyan-600 dark:bg-cyan-950 dark:text-cyan-100'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
                      ].join(' ')}
                      aria-pressed={theme === 'dark'}
                    >
                      暗色模式
                    </button>
                  </div>
                </div>
              </section>
            </div>
          )}
          {activeTab === 'ai-config' && (
            <div data-testid="config-panel-ai-config" className="h-full overflow-hidden">
              <AIConfig />
            </div>
          )}
          {activeTab === 'datasource' && (
            <div data-testid="config-panel-datasource" className="h-full overflow-y-auto">
              <DataSource />
            </div>
          )}
          {activeTab === 'diagnostics' && (
            <div data-testid="config-panel-diagnostics" className="h-full overflow-hidden">
              <DiagnosticsPanel onNavigateConfig={onTabChange} onOpenGuide={onOpenGuide} initializationFlow={initializationFlow} onStartInitialization={onStartInitialization} />
            </div>
          )}
          {import.meta.env.DEV && activeTab === 'user-tier-dev' && (
            <div data-testid="config-panel-user-tier-dev" className="h-full overflow-hidden">
              <UserTierDevPanel />
            </div>
          )}
          {import.meta.env.DEV
            && activeTab === 'notification-preview-dev'
            && priorityNewsPreview
            && onStartPriorityNewsPreview
            && onShowNextPriorityNewsPreview
            && onStopPriorityNewsPreview
            && (
              <div data-testid="config-panel-notification-preview-dev" className="h-full overflow-hidden">
                <PriorityNewsPreviewDevPanel
                  state={priorityNewsPreview}
                  onStart={onStartPriorityNewsPreview}
                  onShowNext={onShowNextPriorityNewsPreview}
                  onStop={onStopPriorityNewsPreview}
                />
              </div>
            )}
        </div>
      </aside>
    </div>
  )
}
