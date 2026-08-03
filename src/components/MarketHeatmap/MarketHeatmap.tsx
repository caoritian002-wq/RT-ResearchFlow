import { MarketOverview } from '../MarketOverview/MarketOverview'

/** Legacy route kept for restored navigation state; render the trusted local workbench. */
export function MarketHeatmap() {
  return <MarketOverview activeSubTab="heatmap" />
}
