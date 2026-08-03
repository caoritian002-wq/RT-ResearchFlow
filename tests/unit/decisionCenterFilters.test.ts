import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('今日看板筛选持久化', () => {
  let storage: MemoryStorage
  let persistedPreference: Record<string, unknown> | null
  let readPersistedPreference: () => Promise<Record<string, unknown> | null>

  beforeEach(() => {
    vi.resetModules()
    storage = new MemoryStorage()
    persistedPreference = null
    readPersistedPreference = async () => persistedPreference
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: storage,
        api: {
          settings: {
            getDecisionCenterFilters: vi.fn(() => readPersistedPreference()),
            setDecisionCenterFilters: vi.fn(async (filters: Record<string, unknown>) => {
              persistedPreference = { ...filters }
              return persistedPreference
            }),
          },
        },
      },
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window')
    vi.resetModules()
  })

  it('保存 P4 后即使 renderer origin 没有 localStorage，重新初始化仍从 SQLite 偏好恢复', async () => {
    const firstModule = await import('../../src/store/appStore')
    firstModule.useAppStore.getState().setDecisionCenterFilters({ minPriority: 4 })

    expect(JSON.parse(storage.getItem('decisionCenterFilters') ?? '{}')).toMatchObject({ minPriority: 4 })
    await vi.waitFor(() => expect(persistedPreference).toMatchObject({ minPriority: 4 }))
    firstModule.useAppStore.getState().setActiveTab('feed')
    firstModule.useAppStore.getState().setActiveTab('decision-center')
    expect(firstModule.useAppStore.getState().decisionCenterFilters.minPriority).toBe(4)

    storage.removeItem('decisionCenterFilters')
    vi.resetModules()
    const restartedModule = await import('../../src/store/appStore')
    expect(restartedModule.useAppStore.getState().decisionCenterFilters.minPriority).toBe(1)
    await restartedModule.useAppStore.getState().initDecisionCenterFilters()
    expect(restartedModule.useAppStore.getState().decisionCenterFilters.minPriority).toBe(4)
    expect(JSON.parse(storage.getItem('decisionCenterFilters') ?? '{}')).toMatchObject({ minPriority: 4 })
  })

  it('SQLite 的 P4 覆盖当前 renderer origin 中陈旧的 P1 影子', async () => {
    storage.setItem('decisionCenterFilters', JSON.stringify({ minPriority: 1 }))
    persistedPreference = { minPriority: 4, viewMode: 'portfolio' }

    const module = await import('../../src/store/appStore')
    expect(module.useAppStore.getState().decisionCenterFilters.minPriority).toBe(1)

    await module.useAppStore.getState().initDecisionCenterFilters()

    expect(module.useAppStore.getState().decisionCenterFilters.minPriority).toBe(4)
    expect(JSON.parse(storage.getItem('decisionCenterFilters') ?? '{}')).toMatchObject({ minPriority: 4 })
  })

  it('启动读取尚未返回时用户改成 P4，迟到的旧 P1 不得覆盖', async () => {
    let releaseRead!: (value: Record<string, unknown> | null) => void
    readPersistedPreference = () => new Promise((resolve) => {
      releaseRead = resolve
    })

    const module = await import('../../src/store/appStore')
    const initPromise = module.useAppStore.getState().initDecisionCenterFilters()
    module.useAppStore.getState().setDecisionCenterFilters({ minPriority: 4 })
    releaseRead({ minPriority: 1, viewMode: 'portfolio' })
    await initPromise

    expect(module.useAppStore.getState().decisionCenterFilters.minPriority).toBe(4)
    await vi.waitFor(() => expect(persistedPreference).toMatchObject({ minPriority: 4 }))
  })
})
