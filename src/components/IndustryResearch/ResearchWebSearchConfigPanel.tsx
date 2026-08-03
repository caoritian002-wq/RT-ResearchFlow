import React, { useCallback, useEffect, useState } from 'react'
import { Field } from './ResearchProjectDialog'

type WebSearchProviderId = 'tavily' | 'bing' | 'custom_openai_compatible_search'

interface WebSearchConfigView {
  providerId: WebSearchProviderId
  enabled: boolean
  hasApiKey: boolean
  baseUrl: string | null
  lastValidatedAt: number | null
  lastErrorCode: string | null
}

interface IndustryResearchResponse<T> {
  ok: boolean
  data?: T
  code?: string
  message?: string
}

const PROVIDER_OPTIONS: Array<{ id: WebSearchProviderId; label: string; hint: string }> = [
  { id: 'tavily', label: 'Tavily', hint: '通用网页搜索，适合产业与公告线索' },
  { id: 'bing', label: 'Bing Web Search', hint: '微软搜索 API' },
  { id: 'custom_openai_compatible_search', label: '自定义兼容搜索', hint: 'OpenAI 兼容 /search 端点' },
]

function formatValidatedAt(value: number | null): string {
  if (!value) return '尚未校验'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '尚未校验'
  }
}

function statusMeta(config: WebSearchConfigView | null): { label: string; className: string; text: string } {
  if (!config) {
    return {
      label: '读取中',
      className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
      text: '正在读取增强搜索配置…',
    }
  }
  if (config.enabled && config.hasApiKey && !config.lastErrorCode) {
    return {
      label: '已启用',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
      text: `${PROVIDER_OPTIONS.find((item) => item.id === config.providerId)?.label || config.providerId} 已配置。最近校验：${formatValidatedAt(config.lastValidatedAt)}`,
    }
  }
  if (config.enabled && config.hasApiKey && config.lastErrorCode) {
    return {
      label: '需修复',
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
      text: `已保存密钥，但最近校验失败（${config.lastErrorCode}）。请重新测试连接。`,
    }
  }
  if (config.hasApiKey && !config.enabled) {
    return {
      label: '已保存未启用',
      className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
      text: '密钥已保存，但当前未启用增强搜索。',
    }
  }
  return {
    label: '未配置',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300',
    text: '当前使用内置弱检索。配置 Tavily/Bing 后，取证质量会明显提升。',
  }
}

interface Props {
  /** compact：新建研究弹窗内嵌；banner：弱检索提示条 */
  variant?: 'compact' | 'banner'
  className?: string
  defaultExpanded?: boolean
  onConfigured?: (config: WebSearchConfigView) => void
}

export function ResearchWebSearchConfigPanel({
  variant = 'compact',
  className = '',
  defaultExpanded = false,
  onConfigured,
}: Props): React.ReactElement {
  const [config, setConfig] = useState<WebSearchConfigView | null>(null)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [providerId, setProviderId] = useState<WebSearchProviderId>('tavily')
  const [enabled, setEnabled] = useState(true)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadConfig = useCallback(async () => {
    const response = await window.api.industryResearch.getWebSearchConfig() as IndustryResearchResponse<WebSearchConfigView>
    if (!response.ok || !response.data) {
      setError(response.message || response.code || '读取搜索配置失败')
      return
    }
    setConfig(response.data)
    setProviderId(response.data.providerId || 'tavily')
    setEnabled(response.data.enabled)
    setBaseUrl(response.data.baseUrl || '')
    setApiKey('')
    onConfigured?.(response.data)
  }, [onConfigured])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const saveConfig = useCallback(async (alsoValidate: boolean) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    const payload: {
      providerId: WebSearchProviderId
      enabled: boolean
      apiKey?: string | null
      baseUrl?: string | null
    } = {
      providerId,
      enabled,
      baseUrl: providerId === 'custom_openai_compatible_search' ? (baseUrl.trim() || null) : null,
    }
    if (apiKey.trim()) payload.apiKey = apiKey.trim()
    const saveResponse = await window.api.industryResearch.saveWebSearchConfig(payload) as IndustryResearchResponse<WebSearchConfigView>
    if (!saveResponse.ok || !saveResponse.data) {
      setBusy(false)
      setError(saveResponse.message || saveResponse.code || '保存搜索配置失败')
      return
    }
    setConfig(saveResponse.data)
    setApiKey('')
    onConfigured?.(saveResponse.data)

    if (!alsoValidate) {
      setBusy(false)
      setMessage('已保存增强搜索配置')
      return
    }

    const validateResponse = await window.api.industryResearch.validateWebSearchConfig() as IndustryResearchResponse<{ ok: true; validatedAt: number }>
    setBusy(false)
    if (!validateResponse.ok) {
      setError(validateResponse.message || validateResponse.code || '搜索配置校验失败')
      await loadConfig()
      return
    }
    setMessage('连接测试通过，增强搜索已可用')
    await loadConfig()
  }, [apiKey, baseUrl, enabled, loadConfig, onConfigured, providerId])

  const meta = statusMeta(config)
  const needsCustomBase = providerId === 'custom_openai_compatible_search'
  const canSave = !busy && (apiKey.trim().length > 0 || Boolean(config?.hasApiKey)) && (!needsCustomBase || baseUrl.trim().length > 0)

  if (variant === 'banner' && !expanded) {
    return (
      <div className={`flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300 ${className}`}>
        <div className="min-w-0">
          <span className={`mr-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}>{meta.label}</span>
          <span>{meta.text}</span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          配置增强搜索
        </button>
      </div>
    )
  }

  return (
    <section className={`rounded-md border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100">增强搜索（可选）</h4>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${meta.className}`}>{meta.label}</span>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-slate-500 dark:text-slate-400">{meta.text}</p>
        </div>
        {variant === 'banner' && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
          >
            收起
          </button>
        )}
        {variant === 'compact' && !defaultExpanded && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="text-[11px] font-semibold text-cyan-700 hover:underline dark:text-cyan-300"
          >
            {expanded ? '收起配置' : '配置增强搜索'}
          </button>
        )}
      </div>

      {(expanded || defaultExpanded || variant === 'banner') && (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <p className="text-[11px] leading-5 text-slate-400">
            不配置也能研究，系统会走内置弱检索。配置后可提升公开资料召回与详情页质量。密钥只保存在本地，界面不会回显完整 Key。
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="搜索服务">
              <select
                value={providerId}
                onChange={(event) => setProviderId(event.target.value as WebSearchProviderId)}
                className="research-input"
              >
                {PROVIDER_OPTIONS.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </Field>
            <Field label="启用状态">
              <label className="flex h-9 items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                启用增强搜索
              </label>
            </Field>
          </div>
          <Field label={config?.hasApiKey ? 'API Key（已配置，留空表示不修改）' : 'API Key'}>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              className="research-input font-mono"
              placeholder={config?.hasApiKey ? '••••••••（输入新 Key 可覆盖）' : '粘贴 Tavily / Bing / 自定义搜索 Key'}
              autoComplete="off"
            />
          </Field>
          {needsCustomBase && (
            <Field label="Base URL">
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="research-input font-mono"
                placeholder="例如 https://example.com/v1"
              />
            </Field>
          )}
          <div className="text-[11px] text-slate-400">
            {PROVIDER_OPTIONS.find((item) => item.id === providerId)?.hint}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!canSave}
              onClick={() => void saveConfig(false)}
              className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[11px] disabled:opacity-40 dark:border-slate-700"
            >
              {busy ? '处理中…' : '仅保存'}
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => void saveConfig(true)}
              className="rounded-md bg-cyan-700 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
            >
              {busy ? '处理中…' : '保存并测试连接'}
            </button>
          </div>
          {message && <div className="text-[11px] text-emerald-700 dark:text-emerald-300">{message}</div>}
          {error && <div className="text-[11px] text-red-600 dark:text-red-300">{error}</div>}
        </div>
      )}
    </section>
  )
}
