import React from 'react'
import type { PriorityNewsPreviewState } from '../DecisionSignalToast/useDecisionSignalToastPreview'

interface PriorityNewsPreviewDevPanelProps {
  state: PriorityNewsPreviewState
  onStart: () => Promise<void>
  onShowNext: () => Promise<void>
  onStop: () => void
}

const STATUS_LABELS: Record<PriorityNewsPreviewState['status'], string> = {
  idle: '尚未启动',
  loading: '正在读取本地重大资讯',
  ready: '已就绪',
  running: '每分钟轮播中',
  empty: '没有可用样本',
  error: '读取失败',
}

export function PriorityNewsPreviewDevPanel({
  state,
  onStart,
  onShowNext,
  onStop,
}: PriorityNewsPreviewDevPanelProps): JSX.Element {
  const busy = state.status === 'loading'
  const running = state.status === 'running'

  return (
    <div className="h-full overflow-y-auto bg-slate-50 p-6 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">FR-260 主动提醒验收</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            轮播本地账本中今日及最近 180 天已经存在的 P4/P5 重大资讯。首条立即显示，后续每 60 秒显示下一条。
          </p>
        </header>

        <section className="border-y border-slate-200 py-4 dark:border-slate-800" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{STATUS_LABELS[state.status]}</div>
              <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                可用样本 {state.candidateCount} 条 · 本次已展示 {state.shownCount} 条
              </p>
            </div>
            <span className={`rounded border px-2.5 py-1 text-xs font-semibold ${running
              ? 'border-cyan-300 bg-cyan-50 text-cyan-800 dark:border-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-200'
              : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}
            >
              {running ? '60 秒间隔' : '开发环境'}
            </span>
          </div>
          {state.lastTitle && (
            <p className="mt-3 break-words text-xs leading-5 text-slate-600 dark:text-slate-300">
              最近展示：{state.lastTitle}
            </p>
          )}
          {state.message && (
            <p className="mt-3 text-xs leading-5 text-red-600 dark:text-red-300" role="alert">{state.message}</p>
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="priority-news-preview-start"
            onClick={() => { void onStart() }}
            disabled={busy || running}
            className="h-11 rounded-md border border-cyan-600 bg-cyan-600 px-4 text-sm font-semibold text-white outline-none transition-colors hover:bg-cyan-700 focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:border-cyan-400 dark:bg-cyan-400 dark:text-slate-950 dark:hover:bg-cyan-300"
          >
            {busy ? '读取中…' : running ? '轮播运行中' : '开始每分钟轮播'}
          </button>
          <button
            type="button"
            data-testid="priority-news-preview-next"
            onClick={() => { void onShowNext() }}
            disabled={busy}
            className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 outline-none transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            立即显示下一条
          </button>
          <button
            type="button"
            data-testid="priority-news-preview-stop"
            onClick={onStop}
            disabled={!running}
            className="h-11 rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-600 outline-none transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-cyan-500/40 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            停止轮播
          </button>
        </div>

        <p className="text-xs leading-6 text-slate-500 dark:text-slate-400">
          该模式只在 renderer 中重放既有信号，不新增决策信号、不修改去重状态、不发送 Windows 通知，也不会触发 AI 分析。点击提醒仍会打开对应的本地资讯原文。
        </p>
      </div>
    </div>
  )
}
