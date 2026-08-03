import { useEffect, useState } from 'react'

type ValidateStatus = 'idle' | 'validating' | 'valid' | 'invalid'

export function DataSource() {
  const [tushareToken, setTushareToken] = useState('')
  const [tushareEnabled, setTushareEnabled] = useState(false)
  const [hasSavedToken, setHasSavedToken] = useState(false)
  const [validateStatus, setValidateStatus] = useState<ValidateStatus>('idle')
  const [validateMsg, setValidateMsg] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    window.api.datasource.getConfig().then((cfg: { tushareEnabled: boolean; hasTushareToken: boolean }) => {
      setTushareEnabled(cfg.tushareEnabled)
      setHasSavedToken(cfg.hasTushareToken)
    })
  }, [])

  async function handleValidate() {
    if (!tushareToken.trim()) return
    setValidateStatus('validating')
    setValidateMsg('')
    const result = await window.api.datasource.validateTushare(tushareToken.trim())
    setValidateStatus(result.valid ? 'valid' : 'invalid')
    setValidateMsg(result.message)
  }

  async function handleSave() {
    setSaving(true)
    setSaveMsg('')
    await window.api.datasource.saveConfig({
      tushareToken: tushareToken.trim() || undefined,
      tushareEnabled
    })
    setSaving(false)
    setSaveMsg('已保存')
    if (tushareToken.trim()) setHasSavedToken(true)
    setTimeout(() => setSaveMsg(''), 2000)
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">数据源配置</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-500 mb-6">配置金融行情数据源，用于 AI 二轮深度分析中获取真实股票走势数据。</p>

      {/* Tushare */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">📈 Tushare Pro</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-500 mt-0.5">专业中国金融数据源，提供A股日线行情</div>
          </div>
          <button
            onClick={() => setTushareEnabled((v) => !v)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${tushareEnabled ? 'bg-blue-600' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white dark:bg-gray-900 shadow transition-transform ${tushareEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>

        <div className="text-xs text-gray-400 dark:text-gray-500 bg-gray-50 dark:bg-gray-800 rounded p-3 leading-relaxed">
          获取步骤：①&nbsp;注册 Tushare 账号并完成邮箱验证 &nbsp;②&nbsp;登录后进入个人中心获取 Token &nbsp;③&nbsp;粘贴至下方输入框&nbsp;
          <span className="text-gray-500 dark:text-gray-400 dark:text-gray-500">（免费用户有调用频率限制，积分升级可获更高权限）</span>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            API Token {hasSavedToken && !tushareToken && <span className="text-green-600 ml-1">（已保存）</span>}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={tushareToken}
              onChange={(e) => { setTushareToken(e.target.value); setValidateStatus('idle') }}
              placeholder={hasSavedToken ? '已有保存的 Token，输入新值可覆盖' : '粘贴你的 Tushare Token'}
              className="flex-1 text-xs border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleValidate}
              disabled={!tushareToken.trim() || validateStatus === 'validating'}
              className="text-xs px-3 py-2 rounded border border-gray-300 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 dark:bg-gray-800 disabled:opacity-40"
            >
              {validateStatus === 'validating' ? '验证中…' : '验证'}
            </button>
          </div>
          {validateMsg && (
            <p className={`text-xs mt-1 ${validateStatus === 'valid' ? 'text-green-600' : 'text-red-500'}`}>
              {validateStatus === 'valid' ? '✓ ' : '✗ '}{validateMsg}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-xs px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
          {saveMsg && <span className="text-xs text-green-600">{saveMsg}</span>}
        </div>
      </div>
    </div>
  )
}
