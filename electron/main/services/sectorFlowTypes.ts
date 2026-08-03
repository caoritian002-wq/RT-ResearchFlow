export type SectorFlowMetricMode = 'verified_flow' | 'turnover_strength'
export type SectorFlowProvider = 'eastmoney' | 'local_estimate'
export type SectorFlowScope = 'concept' | 'industry'
export type SectorFlowDataMode = 'realtime' | 'archive' | 'degraded' | 'empty'
export type SectorFlowThemeState = 'continuation' | 'rotation' | 'divergence' | 'retreat' | 'insufficient'

export interface SectorFlowStock {
  tsCode: string
  name: string
  change: number
  totalAmount: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
}

export interface SectorFlowItem {
  boardCode: string
  boardName: string
  scope: SectorFlowScope
  metricMode: SectorFlowMetricMode
  totalAmount: number
  turnoverDirectionStrength: number | null
  mainNetInflow: number | null
  mainNetInflowRate: number | null
  superLargeNetInflow: number | null
  superLargeNetInflowRate: number | null
  largeNetInflow: number | null
  largeNetInflowRate: number | null
  mediumNetInflow: number | null
  mediumNetInflowRate: number | null
  smallNetInflow: number | null
  smallNetInflowRate: number | null
  weightedChange: number
  totalMarketCap: number | null
  memberCount: number
  upCount: number
  downCount: number
  flatCount: number
  previousMainNetInflow: number | null
  leader: SectorFlowStock | null
  coreStocks: SectorFlowStock[]
  relatedThemes: Array<{ boardCode: string; boardName: string }>
  sourceUpdatedAt: number | null
}

export interface SectorFlowThemeGuidance {
  boardCode: string
  boardName: string
  scope: SectorFlowScope
  state: SectorFlowThemeState
  score: number
  confidence: number
  mainNetInflow: number
  mainNetInflowRate: number | null
  previousMainNetInflow: number | null
  weightedChange: number
  breadthRate: number | null
  reason: string
  coreStocks: SectorFlowStock[]
  relatedThemes: Array<{ boardCode: string; boardName: string }>
  confirmations: string[]
  invalidations: string[]
}

export interface SectorFlowAuctionGuidance {
  stance: 'focus' | 'selective' | 'defensive' | 'insufficient'
  confidence: number
  summary: string
  focusThemes: SectorFlowThemeGuidance[]
  riskThemes: SectorFlowThemeGuidance[]
}

export interface SectorFlowSnapshot {
  items: SectorFlowItem[]
  guidance: SectorFlowAuctionGuidance
  tradeDate: string | null
  updatedAt: string
  capturedAt: number
  dataMode: SectorFlowDataMode
  metricMode: SectorFlowMetricMode
  provider: SectorFlowProvider
  sourceLabel: string
  quality: {
    isVerified: boolean
    partialScopes: SectorFlowScope[]
    archived: boolean
    message: string
  }
}
