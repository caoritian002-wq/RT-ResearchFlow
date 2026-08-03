import { useState, useEffect } from 'react'
import { IndustryHeatmap } from '../IndustryHeatmap/IndustryHeatmap'
import { MarketHeatmapPanel } from './MarketHeatmapPanel'
import { SectorFlow } from './SectorFlow'
import type { MarketOverviewSubTab } from './marketOverviewNavigation'

export { MARKET_OVERVIEW_SUB_TABS, type MarketOverviewSubTab } from './marketOverviewNavigation'

interface MarketOverviewProps {
  activeSubTab?: MarketOverviewSubTab
  onSubTabChange?: (tab: MarketOverviewSubTab) => void
}

export function MarketOverview({ activeSubTab: controlledSubTab, onSubTabChange }: MarketOverviewProps = {}) {
  const [internalSubTab] = useState<MarketOverviewSubTab>(() => {
    const saved = localStorage.getItem('marketOverviewSubTab')
    return (saved === 'industry' || saved === 'heatmap' || saved === 'sectorFlow') ? saved : 'industry'
  })
  const activeSubTab = controlledSubTab ?? internalSubTab

  useEffect(() => {
    localStorage.setItem('marketOverviewSubTab', activeSubTab)
  }, [activeSubTab])

  // 子页面切换已统一由 App 左侧二级导航负责；保留受控回调契约以兼容现有调用方。
  void onSubTabChange

  return (
    <div className="flex flex-col w-full h-full">
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeSubTab === 'industry' && <IndustryHeatmap />}
        {activeSubTab === 'heatmap' && <MarketHeatmapPanel />}
        {activeSubTab === 'sectorFlow' && <SectorFlow />}
      </div>
    </div>
  )
}
