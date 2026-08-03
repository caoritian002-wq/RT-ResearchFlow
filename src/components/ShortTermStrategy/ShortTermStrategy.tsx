import { useEffect, useRef, useState } from 'react'
import { useAppStore, type ShortTermSubTab } from '../../store/appStore'
import { MorningAuction } from './MorningAuction'
import { ClosingHalfHour } from './ClosingHalfHour'
import { LimitBoardMonitor } from './LimitBoardMonitor'
import { SecondBoardLeader } from './SecondBoardLeader'
import { FirstYinDip } from './FirstYinDip'
import { DipBuyRadar } from './DipBuyRadar'
import { ChipMonitor } from './ChipMonitor'
import { StrategyLab } from './StrategyLab/StrategyLab'
import { StrategyBacktestPanel } from '../StrategyBacktest/StrategyBacktestPanel'
import {
  ConceptDataToolsButton,
  ShortTermDataToolsDrawer,
  conceptSourceName,
  type ConceptDataSource,
} from './ShortTermDataToolsDrawer'

export { SHORT_TERM_SUB_TABS } from './shortTermNavigation'

function isStrategyLabSubTab(subTab: ShortTermSubTab): boolean {
  return subTab === 'strategyLab' || subTab === 'personalScreener' || subTab === 'conditionBlocks'
}

export function ShortTermStrategy(): JSX.Element {
  const subTab = useAppStore((s) => s.shortTermActiveSubTab)
  const setShortTermActiveSubTab = useAppStore((s) => s.setShortTermActiveSubTab)
  const [backtestEntry, setBacktestEntry] = useState<{ initialView: 'history'; strategyKey: string } | null>(null)
  const [tushareReady, setTushareReady] = useState<boolean | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)
  const [syncMenuOpen, setSyncMenuOpen] = useState(false)
  const [syncingConcepts, setSyncingConcepts] = useState(false)
  const [conceptsProgress, setConceptsProgress] = useState<{ done: number; total: number } | null>(null)
  const [conceptSource, setConceptSourceState] = useState<ConceptDataSource>('kpl')
  // null=未检查, true=数据充足, false=没有本地数据
  const [thsOrDcReady, setThsOrDcReady] = useState<boolean | null>(null)
  // THS 最近一次同步时间戳（ms）
  const [thsSyncedAt, setThsSyncedAt] = useState<number | null>(null)
  // THS/DC 题材成分同步进度
  const [thsSyncProgress, setThsSyncProgress] = useState<{ current: number; total: number; message: string } | null>(null)
  const conceptsCleanupRef = useRef<Array<() => void>>([])

  // FR-124: 检查 Tushare 是否启用 + token 是否配置；未配置时全 Tab 显示黄色横幅
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.api.datasource.getConfig()
        if (!cancelled) {
          setTushareReady(!!(cfg?.tushareEnabled && cfg?.hasTushareToken))
        }
      } catch {
        if (!cancelled) setTushareReady(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // 进入短线策略 Tab 时立即触发 rt_k 缓存刷新（30s 防抖由 handler 控制）
  useEffect(() => {
    void window.api.shortTerm.refreshRtKNow()
  }, [])

  // FR-153: 检查指定数据源的本地数据量
  const checkConceptDataStatus = async (source: ConceptDataSource): Promise<void> => {
    if (source === 'kpl') { setThsOrDcReady(true); setThsSyncedAt(null); return }
    try {
      const r = await window.api.shortTerm.getConceptDataStatus()
      // 存储 THS 的同步时间（DC 暂不需要）
      setThsSyncedAt(r.thsSyncedAt)
      if (source === 'ths') {
        const ready = r.thsCount > 0
        console.log(`[ShortTermStrategy] THS 数据检查: thsCount=${r.thsCount}, syncedAt=${r.thsSyncedAt}, ready=${ready}`)
        setThsOrDcReady(ready)
      } else {
        const ready = r.dcHasData
        console.log(`[ShortTermStrategy] DC 数据检查: dcHasData=${r.dcHasData}, ready=${ready}`)
        setThsOrDcReady(ready)
      }
    } catch (err) {
      console.warn('[ShortTermStrategy] getConceptDataStatus 失败:', err)
      setThsOrDcReady(false)
    }
  }

  // FR-153: 读取题材数据源初始值
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await window.api.shortTerm.getConceptSource()
        if (!cancelled && r.ok) {
          setConceptSourceState(r.source)
          await checkConceptDataStatus(r.source)
        }
      } catch { /* 静默 */ }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleConceptSourceChange = async (val: ConceptDataSource): Promise<void> => {
    setConceptSourceState(val)
    setThsOrDcReady(null)  // 切换时先设 null，等待检查完成
    await window.api.shortTerm.setConceptSource(val)
    await checkConceptDataStatus(val)
  }

  const handleSyncConceptMembers = async (): Promise<void> => {
    setSyncMsg(null)
    setThsSyncProgress(null)
    try {
      const r = await window.api.shortTerm.syncConceptMembers(conceptSource)
      if (r.ok) {
        setSyncMsg(`「${conceptSourceName(conceptSource)}」题材成分同步已触发，后台写入中（约 1~5 分钟完成）。`)
        // 同步完成后 10s 再次检查数据状态
        setTimeout(() => { void checkConceptDataStatus(conceptSource) }, 10000)
      } else {
        const err = (r as { error: string }).error
        setSyncMsg(err === 'TUSHARE_DISABLED' ? 'Tushare 未配置，无法同步' : `同步失败：${err}`)
      }
    } catch (err) {
      setSyncMsg(`同步失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleSync = async (): Promise<void> => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      await window.api.shortTerm.syncDataNow('afterCloseDaily')
      await window.api.shortTerm.syncDataNow('topList')
      setSyncMsg('同步已触发，数据将在后台写入（约 30~60 秒完成），请稍后刷新各页签')
    } catch (err) {
      setSyncMsg(`同步失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncAllConcepts = async (): Promise<void> => {
    // 清理上次的事件监听
    conceptsCleanupRef.current.forEach(fn => fn())
    conceptsCleanupRef.current = []
    setSyncingConcepts(true)
    setConceptsProgress(null)
    setSyncMsg(null)
    const cleanProgress = window.api.shortTerm.screener.onSyncConceptsProgress(p => {
      setConceptsProgress(p)
    })
    const cleanDone = window.api.shortTerm.screener.onSyncConceptsDone(r => {
      setSyncingConcepts(false)
      setConceptsProgress(null)
      conceptsCleanupRef.current.forEach(fn => fn())
      conceptsCleanupRef.current = []
      setSyncMsg(`题材同步完成：扫描 ${r.total} 只股票，写入 ${r.inserted} 条新记录`)
    })
    conceptsCleanupRef.current = [cleanProgress, cleanDone]

    try {
      const r = await window.api.shortTerm.screener.syncAllConcepts()
      if (!r.ok) {
        const code = (r as { code?: string }).code
        setSyncMsg(
          code === 'TUSHARE_DISABLED'
            ? 'Tushare 未配置，无法同步题材'
            : code === 'STOCK_BASIC_NOT_READY'
              ? 'stock_basic 尚未初始化，请先同步盘后数据'
              : `题材同步失败：${(r as { error: string }).error}`
        )
        setSyncingConcepts(false)
        conceptsCleanupRef.current.forEach(fn => fn())
        conceptsCleanupRef.current = []
      }
    } catch (err) {
      setSyncMsg(`题材同步失败：${err instanceof Error ? err.message : String(err)}`)
      setSyncingConcepts(false)
      conceptsCleanupRef.current.forEach(fn => fn())
      conceptsCleanupRef.current = []
    }
  }

  // FR-153: 订阅题材成分同步进度事件（THS/DC 时激活）
  useEffect(() => {
    if (conceptSource === 'kpl') { setThsSyncProgress(null); return }
    const cleanup = window.api.shortTerm.onConceptSyncProgress((p) => {
      setThsSyncProgress({ current: p.current, total: p.total, message: p.message })
      // 同步完成后重新查询数据状态
      if (p.total > 0 && p.current >= p.total) {
        setTimeout(() => {
          void checkConceptDataStatus(conceptSource)
          setThsSyncProgress(null)
        }, 3000)
      }
    })
    return cleanup
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conceptSource])

  useEffect(() => {
    if (!syncMsg) return
    const timer = window.setTimeout(() => setSyncMsg(null), 6000)
    return () => window.clearTimeout(timer)
  }, [syncMsg])

  // 组件卸载时清理事件监听
  useEffect(() => {
    return () => {
      conceptsCleanupRef.current.forEach(fn => fn())
      conceptsCleanupRef.current = []
    }
  }, [])

  const compactDataTools = (
    <ConceptDataToolsButton
      source={conceptSource}
      onClick={() => setSyncMenuOpen(true)}
    />
  )
  const workbenchDataTools = (
    <ConceptDataToolsButton
      source={conceptSource}
      onClick={() => setSyncMenuOpen(true)}
      variant="workbench"
    />
  )

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-white dark:bg-slate-900">
      {syncMsg && (
        <div className="absolute right-3 top-3 z-40 max-w-md rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 shadow-lg dark:border-blue-700 dark:bg-blue-950 dark:text-blue-200">
          {syncMsg}
        </div>
      )}

      {/* 子 Tab 内容区 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {subTab === 'morningAuction' && (
          <MorningAuction dataTools={compactDataTools} onOpenDataTools={() => setSyncMenuOpen(true)} />
        )}
        {subTab === 'closingHalfHour' && (
          <ClosingHalfHour
            dataTools={workbenchDataTools}
            onOpenHistory={() => {
              setBacktestEntry({ initialView: 'history', strategyKey: 'shortTerm.closingHalfHour' })
              void setShortTermActiveSubTab('strategyBacktest')
            }}
          />
        )}
        {subTab === 'limitBoardMonitor' && (
          <LimitBoardMonitor
            dataTools={workbenchDataTools}
            onOpenHistory={() => {
              setBacktestEntry({ initialView: 'history', strategyKey: 'shortTerm.limitBoardMonitor' })
              void setShortTermActiveSubTab('strategyBacktest')
            }}
          />
        )}
        {subTab === 'secondBoardLeader' && (
          <SecondBoardLeader
            dataTools={workbenchDataTools}
            onOpenHistory={() => {
              setBacktestEntry({ initialView: 'history', strategyKey: 'shortTerm.secondBoardLeader' })
              void setShortTermActiveSubTab('strategyBacktest')
            }}
          />
        )}
        {subTab === 'firstYinDip' && (
          <FirstYinDip
            dataTools={workbenchDataTools}
            onOpenHistory={() => {
              setBacktestEntry({ initialView: 'history', strategyKey: 'shortTerm.firstYinDip' })
              void setShortTermActiveSubTab('strategyBacktest')
            }}
          />
        )}
        {subTab === 'dipBuyRadar' && (
          <DipBuyRadar
            dataTools={workbenchDataTools}
            onOpenHistory={(strategyKey) => {
              setBacktestEntry({ initialView: 'history', strategyKey })
              void setShortTermActiveSubTab('strategyBacktest')
            }}
          />
        )}
        {isStrategyLabSubTab(subTab) && (
          <StrategyLab
            initialView={
              subTab === 'personalScreener'
                ? 'personalScreener'
                : subTab === 'conditionBlocks'
                  ? 'conditionBlocks'
                  : 'overview'
            }
          />
        )}
        {subTab === 'chipMonitor' && <ChipMonitor />}
        {subTab === 'strategyBacktest' && (
          <StrategyBacktestPanel
            initialView={backtestEntry?.initialView}
            initialStrategyKey={backtestEntry?.strategyKey}
            onInitialEntryApplied={() => setBacktestEntry(null)}
          />
        )}
      </div>

      <ShortTermDataToolsDrawer
        open={syncMenuOpen}
        source={conceptSource}
        sourceReady={thsOrDcReady}
        sourceSyncedAt={thsSyncedAt}
        sourceSyncProgress={thsSyncProgress}
        fullSyncProgress={conceptsProgress}
        tushareReady={tushareReady}
        syncingBaseData={syncing}
        syncingAllConcepts={syncingConcepts}
        message={syncMsg}
        onSourceChange={(source) => void handleConceptSourceChange(source)}
        onSyncCurrentSource={() => void handleSyncConceptMembers()}
        onSyncBaseData={() => void handleSync()}
        onSyncAllConcepts={() => void handleSyncAllConcepts()}
        onClose={() => setSyncMenuOpen(false)}
      />
    </div>
  )
}
