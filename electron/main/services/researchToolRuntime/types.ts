export type ResearchSearchProviderId = 'tavily' | 'bing' | 'custom_openai_compatible_search'

export type ResearchRetrievalMode = 'strong' | 'mixed' | 'weak' | 'offline'

export type ResearchQueryIntent =
  | 'policy'
  | 'supply_demand_price'
  | 'capacity_inventory'
  | 'company_exposure'
  | 'tech_substitution_or_shock'
  | 'general'

export type ResearchEvidenceSourceKind =
  | 'web_search'
  | 'official_detail'
  | 'local_briefing'
  | 'local_research'
  | 'user_url'

export interface ResearchSearchHit {
  title: string
  url: string
  snippet: string | null
  publishedAt?: string | null
  providerId: string
  query: string
  sourceKind?: ResearchEvidenceSourceKind
  isDetailPage?: boolean
}

export interface ResearchFetchedPage {
  url: string
  title: string
  summary: string | null
  excerpt: string | null
  publishedAt?: string | null
  status: 'fetched' | 'partial' | 'failed'
  failureReason?: string | null
  isDetailPage?: boolean
  failureCode?: string | null
}

export interface ResearchRetrievalQuery {
  id: string
  text: string
  intent: ResearchQueryIntent
  targetDomains: string[]
  rationale: string
  rewriteOfQueryId?: string | null
  hitCount: number
  detailUrlCount: number
  status: 'planned' | 'executed' | 'rewritten' | 'failed' | 'skipped'
}

export interface ResearchRetrievalPlan {
  queries: ResearchRetrievalQuery[]
  officialSeeds: string[]
}

export interface ResearchRetrievalPlanView extends ResearchRetrievalPlan {
  mode: ResearchRetrievalMode
  localHitCount: number
  webHitCount: number
  detailPageCount: number
  selectedTopN: number
  candidatePoolSize: number
  degradedCode: string | null
  message: string
  enhancedSearch: {
    providerId: ResearchSearchProviderId | null
    configured: boolean
    status: 'disabled' | 'not_configured' | 'key_unavailable' | 'succeeded' | 'empty' | 'failed'
    errorCode: string | null
  }
}
