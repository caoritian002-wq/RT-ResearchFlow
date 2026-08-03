import { useEffect, useState } from 'react'
import { normalizeDevUserTier, readDevUserTier, writeDevUserTier, type DevUserTier } from '../../utils/devUserTier'

const OPTIONS: Array<{ tier: DevUserTier; title: string; description: string }> = [
  { tier: 'free', title: '免费用户', description: '统一分钟数据入口默认返回新浪历史 5 分钟近似能力。' },
  { tier: 'pro', title: '付费用户', description: '统一分钟数据入口优先请求 1 分钟精确能力, 当前云端未配置时按策略提示或回落。' },
]

export function UserTierDevPanel(): JSX.Element {
  const [tier, setTier] = useState<DevUserTier>(() => readDevUserTier())

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === 'tradeWatch.devUserTier') setTier(normalizeDevUserTier(event.newValue))
    }
    const handleCustom = (event: Event) => {
      const detail = (event as CustomEvent<{ tier?: unknown }>).detail
      setTier(normalizeDevUserTier(detail?.tier))
    }
    window.addEventListener('storage', handleStorage)
    window.addEventListener('trade-watch:dev-user-tier-changed', handleCustom)
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('trade-watch:dev-user-tier-changed', handleCustom)
    }
  }, [])

  const applyTier = (nextTier: DevUserTier) => {
    setTier(nextTier)
    writeDevUserTier(nextTier)
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-50 p-6 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-3xl space-y-4">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">开发环境用户层级</div>
          <p className="mt-2 text-sm leading-6 text-slate-500 dark:text-slate-400">
            该设置仅用于本地开发验证免费/付费分钟数据路由, 不代表真实登录、会员或计费状态。生产构建不会展示这个入口。
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {OPTIONS.map(option => (
            <button
              key={option.tier}
              type="button"
              onClick={() => applyTier(option.tier)}
              className={[
                'rounded-lg border p-4 text-left transition-colors',
                tier === option.tier
                  ? 'border-blue-500 bg-blue-50 text-blue-900 dark:border-blue-400 dark:bg-blue-950/40 dark:text-blue-100'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
              ].join(' ')}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{option.title}</span>
                <span className="rounded-full border border-current px-2 py-0.5 text-[11px] uppercase">{option.tier}</span>
              </div>
              <p className="mt-3 text-xs leading-5 opacity-80">{option.description}</p>
            </button>
          ))}
        </div>

        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-xs leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          当前模拟层级：<span className="font-semibold">{tier === 'pro' ? '付费用户' : '免费用户'}</span>。条件积木扫描会把该层级传给统一分钟数据入口, 由数据层 Router 决定实际 Provider。
        </div>
      </div>
    </div>
  )
}
