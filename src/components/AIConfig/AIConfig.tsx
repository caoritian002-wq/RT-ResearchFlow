import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '../../store/appStore'

type AIProvider = 'claude' | 'chatgpt' | 'qwen' | 'deepseek'
type TriggerRating = 'CRITICAL' | 'IMPORTANT' | 'GENERAL'

interface ProviderConfigData {
  model: string | null
  baseUrl: string | null
  maxTokens: number | null
  presetPrompt: string | null
  trendForecastPrompt: string | null
  trendForecastMorrowPrompt: string | null
  hasApiKey: boolean
}

interface SkillMeta {
  skillId: string
  name: string
  description: string
  version: string
  source: 'builtin' | 'custom'
  dirPath: string
  contentLength: number
  contentHash: string
  ruleVersion: string
  integrity: 'complete' | 'invalid' | 'conflict'
  conflictPaths?: string[]
}

interface AIConfigData {
  provider: AIProvider | null
  model: string | null
  hasApiKey: boolean
  providerHasApiKey: Record<string, boolean>
  providerConfigs: Record<string, ProviderConfigData>
  baseUrl: string
  presetPrompt: string
  triggerRating: TriggerRating
  maxArticlesPerBatch: number
  maxContentCharsPerArticle: number
  maxArticleAgeDays: number | null
  autoCleanupDays: number | null
  trendForecastPrompt: string | null
  trendForecastMorrowPrompt: string | null
  maxForecastsPerStock: number
  providerPriority: string[]
  multiModelProviders: string[]
  maxForecastComparison: number
  selectedSkills: string[]
  customSkillPaths: string[]
  skillsForTrend: boolean
  maxSkillChars: number
  providerModels: Record<AIProvider, string[]>
  providerLabels: Record<AIProvider, string>
  providerDefaultBaseUrls: Record<AIProvider, string>
}

const PROVIDERS: AIProvider[] = ['claude', 'chatgpt', 'qwen', 'deepseek']

const RATING_OPTIONS: { value: TriggerRating; label: string; desc: string }[] = [
  { value: 'CRITICAL', label: '重大', desc: '仅重大级别' },
  { value: 'IMPORTANT', label: '重要及以上', desc: '重要 + 重大' },
  { value: 'GENERAL', label: '全部', desc: '所有级别' }
]

/** Per-provider row form state */
interface ProviderRowForm {
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number
  showApiKey: boolean
}

export function AIConfig() {
  const { loadAIConfig } = useAppStore()
  const [config, setConfig] = useState<AIConfigData | null>(null)
  // Per-provider row forms
  const [rowForms, setRowForms] = useState<Record<string, ProviderRowForm>>({})
  // Global settings form
  const [form, setForm] = useState({
    triggerRating: 'IMPORTANT' as TriggerRating,
    maxArticlesPerBatch: 20,
    maxContentCharsPerArticle: 2000,
    maxArticleAgeDays: '90' as string,
    autoCleanupDays: '' as string,
    maxForecastsPerStock: 50,
    maxForecastComparison: 5
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Prompt modal state
  const [promptProvider, setPromptProvider] = useState<AIProvider | null>(null)
  const [promptForm, setPromptForm] = useState({ presetPrompt: '', trendForecastPrompt: '', trendForecastMorrowPrompt: '' })
  // FR-080: provider priority + FR-081: multi-model providers
  const [priority, setPriority] = useState<string[]>([])
  const [multiModel, setMultiModel] = useState<string[]>([])
  // FR-084/085: Skills
  const [skills, setSkills] = useState<SkillMeta[]>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [skillsForTrend, setSkillsForTrend] = useState(false)
  const [maxSkillChars, setMaxSkillChars] = useState(30000)
  const [customPathInput, setCustomPathInput] = useState('')
  const [skillError, setSkillError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const loadConfig = useCallback(async () => {
    const data: AIConfigData = await window.api.ai.getConfig()
    setConfig(data)
    // Initialize row forms from providerConfigs
    const rows: Record<string, ProviderRowForm> = {}
    for (const p of PROVIDERS) {
      const pc = data.providerConfigs[p]
      rows[p] = {
        model: pc?.model ?? '',
        apiKey: '',
        baseUrl: pc?.baseUrl ?? data.providerDefaultBaseUrls[p] ?? '',
        maxTokens: pc?.maxTokens ?? 4096,
        showApiKey: false
      }
    }
    setRowForms(rows)
    setForm({
      triggerRating: data.triggerRating,
      maxArticlesPerBatch: data.maxArticlesPerBatch,
      maxContentCharsPerArticle: data.maxContentCharsPerArticle ?? 2000,
      maxArticleAgeDays: data.maxArticleAgeDays != null ? String(data.maxArticleAgeDays) : '90',
      autoCleanupDays: data.autoCleanupDays != null ? String(data.autoCleanupDays) : '',
      maxForecastsPerStock: data.maxForecastsPerStock ?? 50,
      maxForecastComparison: data.maxForecastComparison ?? 5
    })
    setPriority(data.providerPriority ?? [])
    setMultiModel(data.multiModelProviders ?? [])
    setSelectedSkills(data.selectedSkills ?? [])
    setSkillsForTrend(data.skillsForTrend ?? false)
    setMaxSkillChars(data.maxSkillChars ?? 30000)
    // Load skills list
    try {
      const list: SkillMeta[] = await window.api.skill.list()
      setSkills(list)
    } catch {
      setSkills([])
    }
  }, [])

  useEffect(() => { loadConfig() }, [loadConfig])

  function updateRow(provider: string, patch: Partial<ProviderRowForm>) {
    setRowForms((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }))
  }

  function openPromptModal(provider: AIProvider) {
    const pc = config?.providerConfigs[provider]
    setPromptProvider(provider)
    // Fall back to global config defaults when provider-specific prompts are not set
    setPromptForm({
      presetPrompt: pc?.presetPrompt ?? config?.presetPrompt ?? '',
      trendForecastPrompt: pc?.trendForecastPrompt ?? config?.trendForecastPrompt ?? '',
      trendForecastMorrowPrompt: pc?.trendForecastMorrowPrompt ?? config?.trendForecastMorrowPrompt ?? ''
    })
  }

  async function savePrompts() {
    if (!promptProvider) return
    setSaving(true)
    setError(null)
    try {
      await window.api.ai.saveConfig({
        providerConfig: {
          provider: promptProvider,
          presetPrompt: promptForm.presetPrompt,
          trendForecastPrompt: promptForm.trendForecastPrompt,
          trendForecastMorrowPrompt: promptForm.trendForecastMorrowPrompt
        }
      })
      setPromptProvider(null)
      await loadConfig()
      loadAIConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveRow(provider: AIProvider) {
    const row = rowForms[provider]
    if (!row) return
    setSaving(true)
    setError(null)
    try {
      await window.api.ai.saveConfig({
        providerConfig: {
          provider,
          model: row.model || undefined,
          apiKey: row.apiKey || undefined,
          baseUrl: row.baseUrl || undefined,
          maxTokens: row.maxTokens || 4096
        }
      })
      await loadConfig()
      loadAIConfig()
      updateRow(provider, { apiKey: '' })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  // FR-080: priority move helpers
  function movePriority(index: number, direction: -1 | 1) {
    setPriority((prev) => {
      const arr = [...prev]
      const target = index + direction
      if (target < 0 || target >= arr.length) return prev
      ;[arr[index], arr[target]] = [arr[target], arr[index]]
      return arr
    })
  }

  function toggleMultiModel(provider: string) {
    setMultiModel((prev) =>
      prev.includes(provider) ? prev.filter((p) => p !== provider) : [...prev, provider]
    )
  }

  async function handleSaveGlobal() {
    setSaving(true)
    setError(null)
    try {
      await window.api.ai.saveConfig({
        triggerRating: form.triggerRating,
        maxArticlesPerBatch: form.maxArticlesPerBatch,
        maxContentCharsPerArticle: form.maxContentCharsPerArticle,
        maxArticleAgeDays: form.maxArticleAgeDays ? parseInt(form.maxArticleAgeDays) : null,
        autoCleanupDays: form.autoCleanupDays ? parseInt(form.autoCleanupDays) : null,
        maxForecastsPerStock: form.maxForecastsPerStock,
        maxForecastComparison: form.maxForecastComparison,
        providerPriority: priority,
        multiModelProviders: multiModel,
        selectedSkills,
        skillsForTrend,
        maxSkillChars
      })
      await loadConfig()
      loadAIConfig()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!config) return <div className="p-6 text-sm text-gray-400 dark:text-gray-500">加载中…</div>

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-5">AI 配置</h2>
      <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300">
        {config.hasApiKey ? (
          <div>已检测到至少一个已配置的 API Key。请先保存基础厂商设置，再执行 AI 分析功能。</div>
        ) : (
          <div className="text-amber-700 dark:text-amber-200">当前未检测到已配置的 API Key。AI 分析功能将无法启动，请先配置并保存厂商 API 密钥。</div>
        )}
      </div>

      {/* FR-079: Provider config table */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">AI 厂商配置</label>
        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
          ChatGPT 行支持 OpenAI 兼容接口，可选择 gpt-5.6-sol 或 gpt-5.5，并填写自定义 Base URL。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 dark:text-gray-500">
                <th className="text-left px-3 py-2 font-medium border-b">厂商</th>
                <th className="text-left px-3 py-2 font-medium border-b">模型</th>
                <th className="text-left px-3 py-2 font-medium border-b">API Key</th>
                <th className="text-left px-3 py-2 font-medium border-b">Base URL</th>
                <th className="text-left px-3 py-2 font-medium border-b">最大输出</th>
                <th className="text-left px-3 py-2 font-medium border-b">提示词</th>
                <th className="text-left px-3 py-2 font-medium border-b">操作</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((p) => {
                const row = rowForms[p]
                const pc = config.providerConfigs[p]
                const models = config.providerModels[p] ?? []
                if (!row) return null
                return (
                  <tr key={p} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800/50">
                    <td className="px-3 py-2.5 font-medium text-gray-800 dark:text-gray-200 whitespace-nowrap">
                      {config.providerLabels[p]}
                    </td>
                    <td className="px-3 py-2.5">
                      <select
                        value={row.model}
                        onChange={(e) => updateRow(p, { model: e.target.value })}
                        className="w-full min-w-[160px] border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                      >
                        <option value="">请选择模型</option>
                        {models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        {pc?.hasApiKey ? (
                          <span className="text-xs text-green-600 whitespace-nowrap">✓ 已配置</span>
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-gray-500 whitespace-nowrap">未配置</span>
                        )}
                        <div className="relative flex-1 min-w-[120px]">
                          <input
                            type={row.showApiKey ? 'text' : 'password'}
                            value={row.apiKey}
                            onChange={(e) => updateRow(p, { apiKey: e.target.value })}
                            placeholder={pc?.hasApiKey ? '留空不修改' : '输入Key'}
                            className="w-full border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm pr-10 focus:outline-none focus:border-blue-300"
                          />
                          <button
                            type="button"
                            onClick={() => updateRow(p, { showApiKey: !row.showApiKey })}
                            className="absolute right-1 top-1/2 -translate-y-1/2 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 dark:text-gray-400 dark:text-gray-500"
                          >
                            {row.showApiKey ? '隐' : '显'}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <input
                        type="url"
                        value={row.baseUrl}
                        onChange={(e) => updateRow(p, { baseUrl: e.target.value })}
                        placeholder="Base URL"
                        className="w-full min-w-[150px] border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <input
                        type="number"
                        min={1}
                        value={row.maxTokens}
                        onChange={(e) => updateRow(p, { maxTokens: parseInt(e.target.value) || 4096 })}
                        className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => openPromptModal(p)}
                        className="text-xs text-blue-500 hover:text-blue-700 whitespace-nowrap"
                      >
                        {(pc?.presetPrompt || pc?.trendForecastPrompt || pc?.trendForecastMorrowPrompt) ? '已配置 ✎' : '配置'}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        onClick={() => handleSaveRow(p)}
                        disabled={saving}
                        className="px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600 transition-colors disabled:opacity-50 whitespace-nowrap"
                      >
                        保存
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* FR-080/081: Advanced AI provider options */}
      {priority.length > 0 && (
        <section className="mb-5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/80">
          <div className="flex items-start justify-between gap-4 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">高级设置</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">隐藏复杂的 AI 调度选项，常规场景无需修改。</p>
            </div>
            <button
              type="button"
              onClick={() => setShowAdvanced((prev) => !prev)}
              className="text-sm text-blue-600 dark:text-blue-300 hover:underline"
            >
              {showAdvanced ? '收起' : '展开'}
            </button>
          </div>
          {showAdvanced && (
            <div className="space-y-5 border-t border-gray-200 dark:border-gray-700 px-4 py-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  使用优先级 <span className="text-xs text-gray-400 dark:text-gray-500 font-normal">（仅已配置Key的厂商，失败时自动降级到下一个）</span>
                </label>
                <div className="space-y-1">
                  {priority.map((p, i) => (
                    <div key={p} className="flex items-center gap-2 bg-white dark:bg-gray-800 rounded px-3 py-1.5 border border-gray-100 dark:border-gray-700">
                      <span className="text-xs text-gray-400 dark:text-gray-500 w-4">{i + 1}</span>
                      <span className="text-sm text-gray-800 dark:text-gray-200 flex-1">{config.providerLabels[p as AIProvider] ?? p}</span>
                      <button
                        onClick={() => movePriority(i, -1)}
                        disabled={i === 0}
                        className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
                      >▲</button>
                      <button
                        onClick={() => movePriority(i, 1)}
                        disabled={i === priority.length - 1}
                        className="text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
                      >▼</button>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  多模型预测 <span className="text-xs text-gray-400 dark:text-gray-500 font-normal">（勾选多个厂商则并行预测）</span>
                </label>
                <div className="flex flex-wrap gap-3">
                  {priority.map((p) => (
                    <label key={p} className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={multiModel.includes(p)}
                        onChange={() => toggleMultiModel(p)}
                        className="rounded border-gray-300"
                      />
                      {config.providerLabels[p as AIProvider] ?? p}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Trigger rating */}
      <section className="mb-5">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">触发分析的最低重要程度</label>
        <div className="flex gap-2 flex-wrap">
          {RATING_OPTIONS.map(({ value, label, desc }) => (
            <button
              key={value}
              onClick={() => setForm((f) => ({ ...f, triggerRating: value }))}
              title={desc}
              className={[
                'px-3 py-1.5 rounded border text-sm transition-colors',
                form.triggerRating === value
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-500'
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {/* Max articles per batch */}
      <section className="mb-5">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">每次最多分析条数</label>
        <input
          type="number"
          value={form.maxArticlesPerBatch}
          min={1}
          onChange={(e) => setForm((f) => ({ ...f, maxArticlesPerBatch: parseInt(e.target.value) || 20 }))}
          className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
        />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">条</span>
      </section>

      {/* Max content chars per article */}
      <section className="mb-5">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">每篇正文最大字符数</label>
        <input
          type="number"
          value={form.maxContentCharsPerArticle}
          min={100}
          onChange={(e) => setForm((f) => ({ ...f, maxContentCharsPerArticle: parseInt(e.target.value) || 2000 }))}
          className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
        />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">字</span>
      </section>

      {/* Max article age */}
      <section className="mb-5">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          文章最大时效 <span className="text-xs text-gray-400 dark:text-gray-500 font-normal">（选填，默认90天）</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={form.maxArticleAgeDays}
            min={1}
            onChange={(e) => setForm((f) => ({ ...f, maxArticleAgeDays: e.target.value }))}
            placeholder="不过滤"
            className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
          />
          <span className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">天内发布的文章才纳入分析</span>
        </div>
      </section>

      {/* Auto cleanup */}
      <section className="mb-5">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          自动清理历史记录 <span className="text-xs text-gray-400 dark:text-gray-500 font-normal">（选填）</span>
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={form.autoCleanupDays}
            min={1}
            onChange={(e) => setForm((f) => ({ ...f, autoCleanupDays: e.target.value }))}
            placeholder="不自动清理"
            className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
          />
          <span className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">天后自动清理</span>
        </div>
      </section>

      {/* Max forecasts per stock */}
      <section className="mb-5">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">每只股票最大预测记录数</label>
        <input
          type="number"
          value={form.maxForecastsPerStock}
          min={1}
          max={100}
          onChange={(e) => setForm((f) => ({ ...f, maxForecastsPerStock: Math.min(100, Math.max(1, parseInt(e.target.value) || 50)) }))}
          className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
        />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">条</span>
      </section>

      {/* FR-083: Max forecast comparison */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">最大预测对比数</label>
        <input
          type="number"
          value={form.maxForecastComparison}
          min={1}
          max={10}
          onChange={(e) => setForm((f) => ({ ...f, maxForecastComparison: Math.min(10, Math.max(1, parseInt(e.target.value) || 5)) }))}
          className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
        />
        <span className="ml-2 text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500">条</span>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">预测面板中同时选中对比的最大记录数（1-10）</p>
      </section>

      {/* FR-084/085: Skills (Analysis Frameworks) */}
      <section className="mb-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          分析框架（Skills）
          <span className="text-xs text-gray-400 dark:text-gray-500 font-normal ml-1">选中的框架会注入 AI 分析提示词</span>
        </label>

        {/* Skills list */}
        {skills.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">暂无可用的分析框架</p>
        ) : (
          <div className="space-y-1.5 mb-3">
            {skills.map((s) => (
              <label key={s.skillId} className="flex items-start gap-2 bg-gray-50 dark:bg-gray-800 rounded px-3 py-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700">
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(s.skillId)}
                  onChange={() =>
                    setSelectedSkills((prev) =>
                      prev.includes(s.skillId)
                        ? prev.filter((id) => id !== s.skillId)
                        : [...prev, s.skillId]
                    )
                  }
                  className="mt-0.5 rounded border-gray-300"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{s.name}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      s.source === 'builtin'
                        ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600'
                        : 'bg-green-50 dark:bg-green-900/30 text-green-600'
                    }`}>
                      {s.source === 'builtin' ? '内置' : '自定义'}
                    </span>
                    {s.version && <span className="text-xs text-gray-400 dark:text-gray-500">v{s.version}</span>}
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      s.integrity === 'conflict'
                        ? 'bg-orange-50 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
                        : s.integrity === 'invalid'
                          ? 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400'
                          : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                    }`} title={s.conflictPaths?.join('\n')}>
                      {s.integrity === 'conflict' ? '路径冲突' : s.integrity === 'invalid' ? '内容无效' : '完整'}
                    </span>
                    <span className="text-xs font-mono text-gray-400 dark:text-gray-500" title={`规则版本: ${s.ruleVersion}\nSHA-256: ${s.contentHash}`}>
                      {s.contentHash.slice(0, 8)}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto shrink-0">
                      {s.contentLength >= 1000 ? `${(s.contentLength / 1000).toFixed(1)}k 字符` : `${s.contentLength} 字符`}
                    </span>
                  </div>
                  {s.description && <p className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-0.5 truncate">{s.description}</p>}
                </div>
              </label>
            ))}
          </div>
        )}

        {/* FR-090: Skills 已选字符数汇总 */}
        {skills.length > 0 && (() => {
          const totalChars = skills
            .filter((s) => selectedSkills.includes(s.skillId))
            .reduce((sum, s) => sum + s.contentLength, 0)
          const limit = maxSkillChars || 30000
          const ratio = totalChars / limit
          const colorClass = ratio >= 1
            ? 'text-red-600 dark:text-red-400'
            : ratio >= 0.8
              ? 'text-orange-500 dark:text-orange-400'
              : 'text-gray-500 dark:text-gray-400'
          return (
            <p className={`text-xs mb-3 ${colorClass}`}>
              已选：{totalChars.toLocaleString()} / {limit.toLocaleString()} 字符
              <span className="ml-1">
                {totalChars === 0 ? '未参与' : ratio > 1 ? '部分截断' : '完整纳入'}
              </span>
            </p>
          )
        })()}

        {/* Custom skill paths */}
        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">自定义框架目录</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={customPathInput}
              onChange={(e) => { setCustomPathInput(e.target.value); setSkillError(null) }}
              placeholder="输入 Skill 父目录或包含 SKILL.md 的单个目录"
              className="flex-1 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
            />
            <button
              onClick={async () => {
                if (!customPathInput.trim()) return
                setSkillError(null)
                try {
                  const res = await window.api.skill.addCustomPath(customPathInput.trim())
                  if (res.error) {
                    setSkillError(res.error.message)
                    return
                  }
                  setCustomPathInput('')
                  // Reload
                  const list = await window.api.skill.list()
                  setSkills(list)
                  await loadConfig()
                } catch (err) {
                  setSkillError(err instanceof Error ? err.message : '添加失败')
                }
              }}
              className="px-3 py-1 bg-blue-500 text-white text-xs rounded hover:bg-blue-600 transition-colors whitespace-nowrap"
            >
              添加
            </button>
          </div>
          {skillError && <p className="text-xs text-red-500 mt-1">{skillError}</p>}

          {/* Show existing custom paths */}
          {config && (config as AIConfigData).customSkillPaths?.length > 0 && (
            <div className="mt-2 space-y-1">
              {(config as AIConfigData).customSkillPaths.map((p) => (
                <div key={p} className="flex items-center gap-2 text-xs bg-gray-50 dark:bg-gray-800 rounded px-2 py-1">
                  <span className="flex-1 text-gray-600 dark:text-gray-400 truncate" title={p}>{p}</span>
                  <button
                    onClick={async () => {
                      await window.api.skill.removeCustomPath(p)
                      const list = await window.api.skill.list()
                      setSkills(list)
                      // Remove selected skills that no longer exist
                      const validIds = new Set(list.map((s: SkillMeta) => s.skillId))
                      setSelectedSkills((prev) => prev.filter((id) => validIds.has(id)))
                      await loadConfig()
                    }}
                    className="text-red-400 hover:text-red-600"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Skills for trend */}
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 mb-2 cursor-pointer">
          <input
            type="checkbox"
            checked={skillsForTrend}
            onChange={(e) => setSkillsForTrend(e.target.checked)}
            className="rounded border-gray-300"
          />
          走势预测也注入分析框架
        </label>

        {/* Max skill chars */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600 dark:text-gray-400">框架内容最大字符数</label>
          <input
            type="number"
            value={maxSkillChars}
            min={1000}
            max={100000}
            onChange={(e) => setMaxSkillChars(Math.min(100000, Math.max(1000, parseInt(e.target.value) || 30000)))}
            className="w-24 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-300"
          />
          <span className="text-xs text-gray-400 dark:text-gray-500">超出时自动截断并提示</span>
        </div>
      </section>
      </div>{/* end scrollable area */}

      {/* Sticky bottom save bar */}
      <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-6 py-3 flex items-center gap-3">
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          onClick={handleSaveGlobal}
          disabled={saving}
          className="px-5 py-2 bg-blue-500 text-white text-sm rounded hover:bg-blue-600 transition-colors disabled:opacity-50"
        >
          {saving ? '保存中…' : saved ? '已保存 ✓' : '保存全局设置'}
        </button>
      </div>

      {/* Prompt Modal */}
      {promptProvider && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-lg mx-4 p-6">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {config.providerLabels[promptProvider]} — 提示词配置
            </h3>
            {/* Preset prompt */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">预设提示词（文章分析）</label>
              <textarea
                value={promptForm.presetPrompt}
                onChange={(e) => setPromptForm((f) => ({ ...f, presetPrompt: e.target.value }))}
                rows={4}
                placeholder="识别文章中的新增事实，解释影响传导、A股映射、风险反证与后续验证项。"
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-300 resize-y"
              />
            </div>
            {/* Trend forecast prompt */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">预测今日走势提示词</label>
              <textarea
                value={promptForm.trendForecastPrompt}
                onChange={(e) => setPromptForm((f) => ({ ...f, trendForecastPrompt: e.target.value }))}
                rows={4}
                placeholder="我将会提供给你股票代码和今天大盘、这支股票的版块走势，以及这支股票此时此刻的数据……"
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-300 resize-y"
              />
            </div>
            {/* Trend forecast morrow prompt */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 dark:text-gray-500 mb-1">预测明日走势提示词</label>
              <textarea
                value={promptForm.trendForecastMorrowPrompt}
                onChange={(e) => setPromptForm((f) => ({ ...f, trendForecastMorrowPrompt: e.target.value }))}
                rows={4}
                placeholder="我将会提供给你股票代码、今天大盘与板块分时走势，以及该股票近30天日线数据……"
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-300 resize-y"
              />
            </div>
            {/* Modal actions */}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setPromptProvider(null)}
                className="px-4 py-1.5 text-sm text-gray-600 dark:text-gray-400 dark:text-gray-500 border border-gray-200 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800"
              >
                取消
              </button>
              <button
                onClick={savePrompts}
                disabled={saving}
                className="px-4 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存提示词'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
