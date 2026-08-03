import { useCallback, useEffect, useState } from 'react'
import type {
  PremarketCaptureStatusView,
  PremarketStageStatusView,
} from '../../../electron/main/services/premarketCaptureCoordinator'

const STAGE_LABELS: Record<PremarketStageStatusView['stage'], string> = {
  overnight: '隔夜外部事实',
  asia_open: '亚洲开盘确认',
}

const STATUS_LABELS: Record<string, string> = {
  ready: '可用',
  partial: '部分可用',
  blocked: '受阻',
  failed: '失败',
}

const TONE_LABELS: Record<string, string> = {
  broad_risk_on: '外部风险偏好广泛改善',
  broad_risk_off: '外部风险偏好广泛走弱',
  mixed: '外部证据分化',
  insufficient: '外部证据不足',
}

const ERROR_LABELS: Record<string, string> = {
  CAPTURE_WINDOW_MISSED: '已错过采集窗口',
  PREMARKET_CAPTURE_WINDOW_MISSED: '已错过采集窗口',
  NETWORK_ERROR: '网络请求失败',
  REQUEST_TIMEOUT: '来源响应超时',
  NO_USABLE_OBSERVATIONS: '没有可用观测',
  PREMARKET_SNAPSHOT_HASH_MISMATCH: '本地快照校验失败',
  PREMARKET_SNAPSHOT_FACTS_INVALID: '本地快照正文损坏',
  PREMARKET_STATUS_READ_FAILED: '本地状态读取失败',
}

function formatTradeDate(value: string): string {
  return value.length === 8
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : value
}

function formatBeijingTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value)
}

function getErrorLabel(code: string | null): string | null {
  if (!code) return null
  return ERROR_LABELS[code] ?? `错误码：${code}`
}

function statusColor(status: string): string {
  if (status === 'ready') return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'partial') return 'text-amber-700 dark:text-amber-300'
  if (status === 'failed' || status === 'blocked') return 'text-red-600 dark:text-red-400'
  return 'text-gray-500 dark:text-gray-400'
}

function StageStatusRow({ stage }: { stage: PremarketStageStatusView }) {
  const latest = stage.latest
  const errorLabel = getErrorLabel(stage.readError ?? latest?.errorCode ?? null)
  return (
    <div className="grid min-h-20 gap-2 py-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-center">
      <div>
        <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{STAGE_LABELS[stage.stage]}</p>
        <p className="mt-0.5 text-xs tabular-nums text-gray-500 dark:text-gray-400">北京时间 {stage.scheduledTime}</p>
      </div>
      <div className="min-w-0 text-xs text-gray-500 dark:text-gray-400">
        {stage.inProgress ? (
          <p className="font-medium text-blue-600 dark:text-blue-400" aria-live="polite">采集中…</p>
        ) : latest ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={`font-medium ${statusColor(latest.status)}`}>
                {STATUS_LABELS[latest.status] ?? latest.status}
              </span>
              <span>{formatTradeDate(latest.tradeDate)}</span>
              <span className="tabular-nums">{latest.observationCount}/{latest.expectedCount} 项</span>
              <span>{TONE_LABELS[latest.externalRiskTone] ?? latest.externalRiskTone}</span>
              {latest.warningCount > 0 && <span>{latest.warningCount} 项警告</span>}
            </div>
            <p className="mt-1">
              来源：东方财富全球行情 · {STATUS_LABELS[latest.sourceStatus] ?? latest.sourceStatus}
              {latest.sourceCompletedAt ? ` · ${formatBeijingTime(latest.sourceCompletedAt)}` : ''}
            </p>
            {errorLabel && <p className="mt-1 text-red-600 dark:text-red-400">{errorLabel}</p>}
          </>
        ) : (
          <p>{errorLabel ?? '尚无快照'}</p>
        )}
      </div>
    </div>
  )
}

function getWindowLabel(status: PremarketCaptureStatusView): string {
  if (!status.enabled) return '已关闭，不会发起盘前外部请求'
  if (!status.tradingDay) return '今日休市，不执行盘前采集'
  if (status.currentWindow) {
    const stageLabel = STAGE_LABELS[status.currentWindow.stage]
    if (status.currentWindow.snapshotExists) return `${stageLabel}快照已固定`
    return `${stageLabel}采集窗口开放至 ${formatBeijingTime(status.currentWindow.closesAt)}`
  }
  return status.schedulerActive ? '调度已就绪' : '调度未注册'
}

export function PremarketCaptureSettings() {
  const [status, setStatus] = useState<PremarketCaptureStatusView | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const loadStatus = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      setStatus(await window.api.premarket.getStatus())
      setError(null)
    } catch {
      setError('盘前采集状态读取失败')
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus(true)
    const timer = window.setInterval(() => void loadStatus(), 30_000)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  async function handleToggle() {
    if (!status || saving) return
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      const next = await window.api.premarket.setEnabled(!status.enabled)
      setStatus(next)
      setMessage(next.enabled ? '盘前采集已开启' : '盘前采集已关闭')
    } catch {
      setError('盘前采集设置保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleCaptureCurrent() {
    if (!status?.currentWindow?.canCapture || capturing) return
    setCapturing(true)
    setMessage(null)
    setError(null)
    try {
      const result = await window.api.premarket.captureCurrent()
      setStatus(result.status)
      if (result.ok) {
        setMessage(
          result.reused
            ? '已读取本阶段固定快照'
            : result.code === 'CAPTURED_PARTIAL'
              ? '当前窗口部分事实可用'
              : '当前窗口采集完成',
        )
      } else {
        const labels: Record<string, string> = {
          PREMARKET_NETWORK_DISABLED: '盘前采集已关闭',
          PREMARKET_NOT_TRADING_DAY: '今日休市，不能补采',
          PREMARKET_NO_ACTIVE_WINDOW: '当前不在采集窗口',
          PREMARKET_CAPTURE_BLOCKED: '当前窗口没有可用事实',
          PREMARKET_CAPTURE_FAILED: '当前窗口采集失败',
        }
        setError(labels[result.code] ?? `采集失败：${result.code}`)
      }
    } catch {
      setError('当前窗口采集失败')
    } finally {
      setCapturing(false)
    }
  }

  return (
    <section
      className="mb-6 border-t border-gray-100 pt-6 dark:border-gray-700"
      aria-labelledby="premarket-capture-title"
      data-testid="premarket-capture-settings"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="premarket-capture-title" tabIndex={-1} className="text-sm font-semibold text-gray-800 outline-none dark:text-gray-200">
            盘前外部事实采集
          </h2>
          <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
            07:30 隔夜事实 · 08:45 亚洲开盘确认 · 仅作为A股外生证据
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={status?.enabled ?? false}
          aria-label="盘前外部事实采集"
          disabled={!status || saving}
          onClick={handleToggle}
          className={[
            'relative h-11 w-14 shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-gray-900',
          ].join(' ')}
        >
          <span
            aria-hidden="true"
            className={[
              'absolute left-1 top-1/2 h-6 w-12 -translate-y-1/2 rounded-full border transition-colors motion-reduce:transition-none',
              status?.enabled
                ? 'border-blue-600 bg-blue-600'
                : 'border-gray-300 bg-gray-200 dark:border-gray-600 dark:bg-gray-700',
            ].join(' ')}
          />
          <span
            aria-hidden="true"
            className={[
              'absolute left-1.5 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
              status?.enabled ? 'translate-x-6' : 'translate-x-0',
            ].join(' ')}
          />
        </button>
      </div>

      <div className="mt-4 border-y border-gray-100 dark:border-gray-700">
        {loading && !status ? (
          <div className="flex min-h-24 items-center text-sm text-gray-500 dark:text-gray-400" aria-live="polite">
            正在读取盘前采集状态…
          </div>
        ) : status ? (
          <>
            <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-gray-100 py-2 text-xs dark:border-gray-700">
              <span className={status.enabled ? 'text-gray-700 dark:text-gray-300' : 'text-gray-500 dark:text-gray-400'}>
                {getWindowLabel(status)}
              </span>
              {status.nextRun && (
                <span className="tabular-nums text-gray-500 dark:text-gray-400">
                  {status.enabled ? '下次' : '启用后'}：{formatTradeDate(status.nextRun.tradeDate)} {status.nextRun.stage === 'overnight' ? '07:30' : '08:45'}
                </span>
              )}
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {status.stages.map((stage) => <StageStatusRow key={stage.stage} stage={stage} />)}
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleCaptureCurrent}
          disabled={!status?.currentWindow?.canCapture || capturing}
          className="h-11 rounded-md border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:border-blue-300 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-45 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-blue-600 dark:hover:text-blue-300"
        >
          {capturing ? '采集中…' : '补采当前窗口'}
        </button>
        <div className="min-h-5 text-xs" aria-live="polite">
          {message && <span className="text-emerald-600 dark:text-emerald-400">{message}</span>}
          {error && <span className="text-red-600 dark:text-red-400" role="alert">{error}</span>}
        </div>
      </div>
    </section>
  )
}
