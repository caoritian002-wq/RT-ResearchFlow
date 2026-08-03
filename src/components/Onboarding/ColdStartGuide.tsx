import { useMemo, useState } from 'react'
import type { ConfigDrawerTab } from '../ConfigDrawer/ConfigDrawer'
import type { Tab } from '../../store/appStore'
import { buildOnboardingModel, type DiagnosticRunAction, type DiagnosticsHealthSnapshot, type OnboardingAction } from './onboardingModel'
import { buildInitializationModel } from './initializationModel'
import { formatTaskDuration, getFlowProgress, type InitializationFlowState, type InitializationTaskKey } from './initializationTaskModel'

type ActionRunState = 'idle' | 'running' | 'success' | 'error'

interface ColdStartGuideProps {
  snapshot: DiagnosticsHealthSnapshot | null
  loading?: boolean
  flow: InitializationFlowState
  onRefresh: () => Promise<void> | void
  onOpenConfig: (tab: ConfigDrawerTab) => void
  onNavigate: (tab: Tab) => void
  onStartInitialization: () => void
  onRetryTask: (taskKey: InitializationTaskKey) => void
  onClose: () => void
}

const STATUS_META = {
  ok: { label: '已完成', dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-900/60' },
  warning: { label: '待处理', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300', border: 'border-amber-200 dark:border-amber-900/60' },
  error: { label: '需处理', dot: 'bg-red-500', text: 'text-red-700 dark:text-red-300', border: 'border-red-200 dark:border-red-900/60' }
} as const

function actionLabel(action: OnboardingAction | undefined): string {
  return action?.label ?? '继续'
}

const TASK_STATUS_META: Record<string, { label: string; className: string }> = {
  pending: { label: '等待', className: 'text-gray-500 dark:text-gray-400' },
  running: { label: '执行中', className: 'text-blue-600 dark:text-blue-300' },
  success: { label: '成功', className: 'text-emerald-700 dark:text-emerald-300' },
  failed: { label: '失败', className: 'text-red-700 dark:text-red-300' },
  skipped: { label: '跳过', className: 'text-gray-500 dark:text-gray-400' },
  retryable: { label: '可重试', className: 'text-amber-700 dark:text-amber-300' }
}

export function ColdStartGuide({ snapshot, loading = false, flow, onRefresh, onOpenConfig, onNavigate, onStartInitialization, onRetryTask, onClose }: ColdStartGuideProps) {
  const model = useMemo(() => buildOnboardingModel(snapshot), [snapshot])
  const [runningAction, setRunningAction] = useState<DiagnosticRunAction | null>(null)
  const [actionStates, setActionStates] = useState<Partial<Record<DiagnosticRunAction, ActionRunState>>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const initialization = useMemo(() => buildInitializationModel(snapshot, model.nextStep?.action, runningAction !== null || loading), [snapshot, model.nextStep?.action, runningAction, loading])

  async function runDiagnosticAction(action: DiagnosticRunAction) {
    setRunningAction(action)
    setActionStates(prev => ({ ...prev, [action]: 'running' }))
    setMessage('')
    setError('')
    try {
      const res = await window.api.diagnostics.runCheck(action)
      if (res.ok) {
        setActionStates(prev => ({ ...prev, [action]: 'success' }))
        setMessage(res.data.message)
        await onRefresh()
      } else {
        setActionStates(prev => ({ ...prev, [action]: 'error' }))
        setError(res.message || '引导动作执行失败')
      }
    } catch (err) {
      setActionStates(prev => ({ ...prev, [action]: 'error' }))
      setError(err instanceof Error ? err.message : '引导动作执行失败')
    } finally {
      setRunningAction(null)
    }
  }

  function handleAction(action: OnboardingAction | undefined) {
    if (!action) return
    if (action.type === 'config') {
      onOpenConfig(action.tab)
      return
    }
    if (action.type === 'nav') {
      onNavigate(action.tab)
      onClose()
      return
    }
    void runDiagnosticAction(action.action)
  }

  const primaryStep = model.nextStep
  const flowProgress = getFlowProgress(flow)
  const statusText = {
    blocked: '阻塞',
    actionRequired: '需处理',
    syncing: '执行中',
    usable: '可使用',
    complete: '已完成'
  }[initialization.status]

  return (
    <section data-testid="cold-start-guide" className="fixed bottom-4 right-4 z-[80] flex max-h-[calc(100vh-2rem)] w-[min(440px,calc(100vw-2rem))] flex-col rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
      <div className="shrink-0 flex items-start gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex h-9 w-9 items-center justify-center rounded bg-blue-600 text-sm font-semibold text-white">启</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">首次启动引导</h2>
            <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">{model.progressPct}%</span>
            <span className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[11px] text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">{statusText}</span>
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{initialization.description}</p>
        </div>
        <button type="button" onClick={onClose} className="h-7 w-7 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-100" aria-label="关闭引导">×</button>
      </div>

      <div className="min-h-0 space-y-3 overflow-y-auto p-4">
        <div className="h-1.5 overflow-hidden rounded bg-gray-100 dark:bg-gray-800">
          <div className="h-full rounded bg-blue-600 transition-all" style={{ width: `${model.progressPct}%` }} />
        </div>

        {error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
        {message && <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">{message}</div>}
        {flow.error && <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">{flow.error}</div>}
        {flow.message && <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">{flow.message}</div>}

        <div data-testid="initialization-flow-panel" className="rounded border border-blue-100 bg-blue-50/50 p-3 dark:border-blue-900/50 dark:bg-blue-950/20">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">一键初始化</div>
              <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{flowProgress.done}/{flowProgress.total} 完成 · {flowProgress.failed} 个需处理</div>
            </div>
            <button
              type="button"
              data-testid="start-initialization-flow-btn"
              onClick={onStartInitialization}
              disabled={flow.running || loading || runningAction !== null}
              className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {flow.running ? '初始化中…' : '开始初始化'}
            </button>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-white dark:bg-gray-900">
            <div className="h-full rounded bg-blue-600 transition-all" style={{ width: `${flowProgress.pct}%` }} />
          </div>
          <div className="mt-2 space-y-1.5">
            {flow.tasks.map(task => {
              const meta = TASK_STATUS_META[task.status]
              return (
                <div key={task.key} data-testid={`initialization-task-${task.key}`} className="flex items-start gap-2 rounded bg-white/70 px-2 py-1.5 text-xs dark:bg-gray-900/70">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">{task.title}</span>
                      <span className={meta.className}>{meta.label}</span>
                      <span className="text-gray-400 dark:text-gray-500">{formatTaskDuration(task)}</span>
                    </div>
                    {(task.message || task.error) && <div className="mt-0.5 text-gray-500 dark:text-gray-400">{task.error ?? task.message}</div>}
                  </div>
                  {(task.status === 'failed' || task.status === 'retryable') && (
                    <button type="button" onClick={() => onRetryTask(task.key)} disabled={flow.running} className="rounded border border-amber-200 px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-900/60 dark:text-amber-300 dark:hover:bg-amber-950/40">
                      重试
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-2">
          {model.steps.map((step, index) => {
            const meta = STATUS_META[step.status]
            const isPrimary = primaryStep?.key === step.key
            const isRunning = step.action?.type === 'run' && runningAction === step.action.action
            const runState = step.action?.type === 'run' ? (actionStates[step.action.action] ?? 'idle') : 'idle'
            const actionStateLabel = runState === 'success' ? '成功' : runState === 'error' ? '可重试' : runState === 'running' ? '执行中' : null
            return (
              <div key={step.key} className={`rounded border p-3 ${isPrimary ? meta.border : 'border-gray-100 dark:border-gray-800'} bg-gray-50/60 dark:bg-gray-950/30`}>
                <div className="flex items-start gap-2">
                  <span className={`mt-1 h-2 w-2 rounded-full ${meta.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-gray-400 dark:text-gray-500">{index + 1}</span>
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{step.title}</div>
                      <span className={`text-[11px] ${meta.text}`}>{meta.label}</span>
                      {actionStateLabel && <span className="text-[11px] text-blue-600 dark:text-blue-300">{actionStateLabel}</span>}
                    </div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{step.description}</div>
                  </div>
                  {step.action && (isPrimary || step.status !== 'ok') && (
                    <button
                      type="button"
                      data-testid={step.key === 'enter-home' ? 'onboarding-step-action-enter-home' : undefined}
                      onClick={() => handleAction(step.action)}
                      disabled={runningAction !== null || loading}
                      className="shrink-0 rounded border border-blue-200 px-2.5 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900/60 dark:text-blue-300 dark:hover:bg-blue-950/40"
                    >
                      {isRunning ? '执行中…' : actionLabel(step.action)}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
          <button type="button" onClick={() => void onRefresh()} disabled={loading || runningAction !== null} className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
            {loading ? '检查中…' : '重新检查'}
          </button>
          {primaryStep?.action && (
            <button type="button" data-testid="onboarding-primary-action" onClick={() => handleAction(primaryStep.action)} disabled={loading || runningAction !== null} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {primaryStep.action.type === 'run' && runningAction === primaryStep.action.action ? '执行中…' : actionLabel(primaryStep.action)}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
