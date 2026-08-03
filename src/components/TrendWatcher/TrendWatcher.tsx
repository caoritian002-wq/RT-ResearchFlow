import { useCallback, useEffect, useState } from 'react'
import { TrendDashboard } from './TrendDashboard'
import { TrendAlerts } from './TrendAlerts'
import { TrendManager } from './TrendManager'
import { PortfolioDashboard } from './PortfolioDashboard'
import type { TrendWorkbenchSnapshot } from './trendWorkbenchTypes'
import type { TrendWatcherSubTab } from './trendWatcherNavigation'

export { TREND_WATCHER_SUB_TABS, type TrendWatcherSubTab } from './trendWatcherNavigation'

interface TrendWatcherProps {
  activeSubTab?: TrendWatcherSubTab
  onSubTabChange?: (tab: TrendWatcherSubTab) => void
}

export function TrendWatcher({ activeSubTab: controlledSubTab }: TrendWatcherProps = {}) {
  const [internalSubTab] = useState<TrendWatcherSubTab>('portfolio')
  const subTab = controlledSubTab ?? internalSubTab
  const [visited, setVisited] = useState<Set<TrendWatcherSubTab>>(() => new Set([subTab]))
  const [snapshot, setSnapshot] = useState<TrendWorkbenchSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const loadWorkbench = useCallback(async () => {
    setLoading(true)
    try {
      const response = await window.api.trend.getWorkbench()
      if (!response.ok || !response.data) {
        setErrorMessage(response.message ?? response.error ?? '长线趋势数据加载失败')
        return
      }
      setSnapshot(response.data as TrendWorkbenchSnapshot)
      setErrorMessage('')
    } catch {
      setErrorMessage('长线趋势数据加载失败，请稍后重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setVisited((current) => current.has(subTab) ? current : new Set([...current, subTab]))
  }, [subTab])

  useEffect(() => {
    void loadWorkbench()
    const offScores = window.api.trend.onScoresUpdated(() => { void loadWorkbench() })
    const offAlert = window.api.trend.onAlert(() => { void loadWorkbench() })
    const offBackfill = window.api.trend.onBackfillDone(() => { void loadWorkbench() })
    return () => {
      offScores()
      offAlert()
      offBackfill()
    }
  }, [loadWorkbench])

  const refreshWorkbench = useCallback(() => { void loadWorkbench() }, [loadWorkbench])
  const pageProps = { snapshot, loading, errorMessage, onRefresh: refreshWorkbench }

  return (
    <div data-testid="trend-workbench" className="relative h-full min-h-0 overflow-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {visited.has('portfolio') && (
        <section className={subTab === 'portfolio' ? 'h-full' : 'hidden'} aria-hidden={subTab !== 'portfolio'}>
          <PortfolioDashboard {...pageProps} />
        </section>
      )}
      {visited.has('dashboard') && (
        <section className={subTab === 'dashboard' ? 'h-full' : 'hidden'} aria-hidden={subTab !== 'dashboard'}>
          <TrendDashboard {...pageProps} />
        </section>
      )}
      {visited.has('alerts') && (
        <section className={subTab === 'alerts' ? 'h-full' : 'hidden'} aria-hidden={subTab !== 'alerts'}>
          <TrendAlerts {...pageProps} />
        </section>
      )}
      {visited.has('manage') && (
        <section className={subTab === 'manage' ? 'h-full' : 'hidden'} aria-hidden={subTab !== 'manage'}>
          <TrendManager {...pageProps} />
        </section>
      )}
    </div>
  )
}
