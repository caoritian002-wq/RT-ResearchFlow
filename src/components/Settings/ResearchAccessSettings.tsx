import React, { useCallback, useEffect, useState } from 'react'
import type { ResearchAccessCredentialDelivery, ResearchAccessWorkbench } from '../../../electron/main/ipc/researchAccessHandlers'
import type { ResearchAccessScope } from '../../../electron/main/database/researchAccessRepository'

const BUTTON = 'min-h-11 rounded border px-3 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-45'
const SECONDARY = `${BUTTON} border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800`
const PRIMARY = `${BUTTON} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`
const DANGER = `${BUTTON} border-red-200 bg-white text-red-600 hover:bg-red-50 dark:border-red-800 dark:bg-gray-900 dark:text-red-300 dark:hover:bg-red-950/40`
type PendingAction = { profileId: string; profileName: string; kind: 'rotate' | 'revoke' }

export function ResearchAccessSettings() {
  const [workbench, setWorkbench] = useState<ResearchAccessWorkbench | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('本机研究助手')
  const [createScopes, setCreateScopes] = useState<ResearchAccessScope[]>(['market.read'])
  const [delivery, setDelivery] = useState<ResearchAccessCredentialDelivery | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const result = await window.api.researchAccess.getWorkbench()
    if (result.ok) {
      setWorkbench(result.data)
      setError('')
    } else setError(result.message)
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  async function createProfile() {
    if (!name.trim() || createScopes.length === 0) return
    setBusy('create')
    setError('')
    setNotice('')
    const result = await window.api.researchAccess.createProfile({
      requestId: crypto.randomUUID(), name: name.trim(), scopes: createScopes,
    })
    setBusy(null)
    if (!result.ok) return setError(result.message)
    setDelivery(result.data)
    setNotice('访问配置已创建')
    await load()
  }

  async function updateProfile(profileId: string, patch: { scopes?: ResearchAccessScope[]; enabled?: boolean }) {
    setBusy(profileId)
    setError('')
    const result = await window.api.researchAccess.updateProfile({ requestId: crypto.randomUUID(), profileId, ...patch })
    setBusy(null)
    if (!result.ok) setError(result.message)
    else await load()
  }

  async function rotateCredential(profileId: string) {
    setBusy(profileId)
    setError('')
    setNotice('')
    const result = await window.api.researchAccess.rotateCredential({ requestId: crypto.randomUUID(), profileId })
    setBusy(null)
    if (!result.ok) return setError(result.message)
    setPendingAction(null)
    setDelivery(result.data)
    setNotice('凭据已轮换')
    await load()
  }

  async function revokeProfile(profileId: string) {
    setBusy(profileId)
    setError('')
    const result = await window.api.researchAccess.revokeProfile({ requestId: crypto.randomUUID(), profileId })
    setBusy(null)
    if (!result.ok) setError(result.message)
    else {
      setPendingAction(null)
      if (delivery?.profile.id === profileId) setDelivery(null)
      await load()
    }
  }

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(message)
      setError('')
    } catch {
      setError('复制失败，请检查系统剪贴板权限')
    }
  }

  function toggleCreateScope(scope: ResearchAccessScope) {
    setCreateScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope])
  }

  const endpointReady = workbench?.endpoint.state === 'ready' && workbench.endpoint.adapterAvailable

  return (
    <section data-testid="research-access-settings" className="mb-6 border-t border-gray-200 pt-6 dark:border-gray-700">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">本机研究访问</h2>
          <div className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span className={`h-2 w-2 rounded-full ${endpointReady ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            <span>{loading ? '检查中' : endpointReady ? `服务可用 · v${workbench?.endpoint.serviceVersion}` : '服务不可用'}</span>
          </div>
        </div>
        <button type="button" className={SECONDARY} onClick={() => void load()} disabled={loading}>刷新状态</button>
      </div>

      {error && <div role="alert" className="mb-4 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/35 dark:text-red-200">{error}</div>}
      {notice && <div role="status" className="mb-4 border-l-2 border-emerald-500 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">{notice}</div>}

      {delivery && (
        <div data-testid="research-access-credential-delivery" className="mb-5 border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">一次性访问材料</p>
              <p className="mt-1 break-all font-mono text-xs text-amber-800 dark:text-amber-200">{delivery.credential}</p>
            </div>
            <button type="button" className={SECONDARY} onClick={() => setDelivery(null)}>我已保存</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={PRIMARY} onClick={() => void copy(delivery.mcpConfig, 'MCP 配置已复制')}>复制 MCP 配置</button>
            <button type="button" className={SECONDARY} onClick={() => void copy(delivery.credential, '凭据已复制')}>复制凭据</button>
            <button type="button" className={SECONDARY} onClick={() => void copy(delivery.cliExamples.doctor, '诊断命令已复制')}>复制诊断命令</button>
          </div>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <label htmlFor="research-access-name" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">配置名称</label>
          <input id="research-access-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className="min-h-11 w-full rounded border border-gray-200 bg-white px-3 text-sm text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
        </div>
        <button type="button" data-testid="research-access-create" className={`${PRIMARY} self-end`} disabled={busy != null || !endpointReady || !name.trim() || createScopes.length === 0} onClick={() => void createProfile()}>
          {busy === 'create' ? '创建中…' : '创建访问配置'}
        </button>
      </div>

      <div className="mb-5 grid gap-2 sm:grid-cols-3">
        {workbench?.scopes.map((scope) => (
          <label key={scope.id} className="flex min-h-11 cursor-pointer items-start gap-2 rounded border border-gray-200 px-3 py-2 dark:border-gray-700">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-blue-600" checked={createScopes.includes(scope.id)} onChange={() => toggleCreateScope(scope.id)} />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-gray-700 dark:text-gray-200">{scope.label}</span>
              <span className="block text-[11px] leading-4 text-gray-400 dark:text-gray-500">{scope.id}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="divide-y divide-gray-200 border-y border-gray-200 dark:divide-gray-700 dark:border-gray-700">
        {workbench?.profiles.length === 0 && <p className="py-5 text-sm text-gray-400">暂无访问配置</p>}
        {workbench?.profiles.map((profile) => {
          const revoked = profile.revokedAt != null
          return (
            <div key={profile.id} data-testid="research-access-profile" className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{profile.name}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] ${revoked ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : profile.enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>
                      {revoked ? '已撤销' : profile.enabled ? '已启用' : '已停用'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-400">凭据 v{profile.credentialVersion} · 权限 v{profile.scopeVersion}{profile.lastUsedAt ? ` · 最近调用 ${formatDate(profile.lastUsedAt)}` : ''}</p>
                </div>
                {!revoked && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={SECONDARY} disabled={busy === profile.id} onClick={() => void updateProfile(profile.id, { enabled: !profile.enabled })}>{profile.enabled ? '停用' : '启用'}</button>
                    <button type="button" className={SECONDARY} disabled={busy === profile.id} onClick={() => setPendingAction({ profileId: profile.id, profileName: profile.name, kind: 'rotate' })}>轮换</button>
                    <button type="button" className={DANGER} disabled={busy === profile.id} onClick={() => setPendingAction({ profileId: profile.id, profileName: profile.name, kind: 'revoke' })}>撤销</button>
                  </div>
                )}
              </div>
              {pendingAction?.profileId === profile.id && (
                <div role="alertdialog" aria-labelledby={`research-access-confirm-${profile.id}`} className="mt-3 flex flex-wrap items-center justify-between gap-3 border-l-2 border-amber-500 bg-amber-50 px-3 py-2 dark:bg-amber-950/25">
                  <div className="min-w-0">
                    <p id={`research-access-confirm-${profile.id}`} className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      {pendingAction.kind === 'rotate' ? `轮换“${pendingAction.profileName}”的凭据？` : `撤销“${pendingAction.profileName}”？`}
                    </p>
                    <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
                      {pendingAction.kind === 'rotate' ? '旧凭据会立即失效，随后只显示一次新凭据。' : '撤销不可恢复，现有 MCP 和 CLI 连接会立即失效。'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={SECONDARY} disabled={busy === profile.id} onClick={() => setPendingAction(null)}>取消</button>
                    <button type="button" className={pendingAction.kind === 'revoke' ? DANGER : PRIMARY} disabled={busy === profile.id} onClick={() => void (pendingAction.kind === 'rotate' ? rotateCredential(profile.id) : revokeProfile(profile.id))}>
                      {busy === profile.id ? '处理中…' : pendingAction.kind === 'rotate' ? '确认轮换' : '确认撤销'}
                    </button>
                  </div>
                </div>
              )}
              {!revoked && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                  {workbench.scopes.map((scope) => (
                    <label key={scope.id} className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                      <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={profile.scopes.includes(scope.id)} disabled={busy === profile.id} onChange={() => void updateProfile(profile.id, {
                        scopes: profile.scopes.includes(scope.id) ? profile.scopes.filter((item) => item !== scope.id) : [...profile.scopes, scope.id],
                      })} />
                      {scope.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">最近调用</h3>
        <div className="divide-y divide-gray-100 dark:divide-gray-800">
          {workbench?.audit.items.length === 0 && <p className="py-3 text-sm text-gray-400">暂无调用记录</p>}
          {workbench?.audit.items.map((entry) => (
            <div key={entry.id} data-testid="research-access-audit" className="grid gap-1 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <p className="truncate font-medium text-gray-700 dark:text-gray-200">{entry.externalToolName ?? '未识别调用'}</p>
                <p className="truncate text-gray-400">{entry.profileName ?? '未知配置'} · {entry.surface.toUpperCase()} · {formatDate(entry.createdAt)}</p>
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-gray-400">
                  <span>截点 {entry.asOf ?? '未指定'}</span>
                  <span>耗时 {entry.durationMs} ms</span>
                  <span>结果 {entry.resultBytes} B</span>
                </p>
              </div>
              <div className={`self-center font-medium ${entry.decision === 'allowed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {entry.decision === 'allowed' ? entry.toolStatus ?? '允许' : entry.errorCode ?? '已阻断'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}
