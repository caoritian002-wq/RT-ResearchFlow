export type MorningAuctionRecoveryAction =
  | 'relaunch'
  | 'switchTradeDate'
  | 'refreshSnapshot'
  | 'regenerateInsights'
  | 'syncChips'
  | 'openDataTools'
  | 'openStock'
  | 'openBacktest'

export interface MorningAuctionTradeDateStatus {
  isTradeDay: boolean
  previousTradeDate: string | null
  nextTradeDate: string | null
  recommendedTradeDate: string | null
}

export interface MorningAuctionRecoveryError {
  code?: string
  message: string
  details?: string
  recommendedTradeDate?: string | null
}

export interface MorningAuctionRecoveryInsight {
  verificationItems: Array<{
    key: string
    label: string
    source: string
    status: 'pending' | 'checked' | 'blocked' | 'not_applicable'
  }>
}

export interface MorningAuctionRecoveryIssue {
  key: string
  kind: 'application' | 'calendar' | 'snapshot' | 'evidence'
  title: string
  description: string
  impact: string
  count?: number
  actions: MorningAuctionRecoveryAction[]
}

export interface MorningAuctionRecoveryStats {
  uniqueStockCount: number
  candidateRecordCount: number
  generatedInsightCount: number
  missingInsightCount: number
  blockedEvidenceCount: number
}

interface BuildRecoveryStateInput {
  loadError: string | null
  insightError: MorningAuctionRecoveryError | null
  tradeDateStatus: MorningAuctionTradeDateStatus | null
  uniqueStockCount: number
  candidateRecordCount: number
  generatedInsightCount: number
  missingInsightCount: number
  blockedEvidenceCount: number
  insights: MorningAuctionRecoveryInsight[]
}

export interface MorningAuctionRecoveryState {
  issues: MorningAuctionRecoveryIssue[]
  stats: MorningAuctionRecoveryStats
  recommendedTradeDate: string | null
}

const EVIDENCE_RECOVERY: Record<string, Omit<MorningAuctionRecoveryIssue, 'key' | 'kind' | 'count'>> = {
  intradayAcceptance: {
    title: '分时承接证据缺失',
    description: '候选股票在所选交易日没有可用分钟行情。',
    impact: '不影响候选浏览, 盘中承接判断保持受阻。',
    actions: ['openStock'],
  },
  conceptResonance: {
    title: '题材归因证据缺失',
    description: '当前题材源没有匹配到候选股票的本地题材成分。',
    impact: '题材共振不参与当前研判确认。',
    actions: ['openDataTools'],
  },
  chipConsistency: {
    title: '同日筹码证据缺失',
    description: '候选股票缺少与竞价日期一致的本地筹码结构摘要。',
    impact: '筹码项不参与当日评分, 历史摘要仅作事实展示。',
    actions: ['syncChips'],
  },
  priceHistory: {
    title: '日线历史证据缺失',
    description: '本地日线不足以计算近期涨跌和持续性。',
    impact: '近期价格持续性判断保持受阻。',
    actions: ['openDataTools'],
  },
  historicalPerformance: {
    title: '历史回测证据缺失',
    description: '当前股票与信号池没有可用回测样本。',
    impact: '历史表现不参与当前研判确认。',
    actions: ['openBacktest'],
  },
}

function isApplicationFailure(error: MorningAuctionRecoveryError): boolean {
  return error.code === 'INSIGHT_GENERATION_FAILED'
    || /not defined|No handler registered|IPC|destroyed|旧主进程/i.test(`${error.message} ${error.details ?? ''}`)
}

export function buildMorningAuctionRecoveryState(input: BuildRecoveryStateInput): MorningAuctionRecoveryState {
  const issues: MorningAuctionRecoveryIssue[] = []
  const recommendedTradeDate = input.tradeDateStatus?.recommendedTradeDate
    ?? input.insightError?.recommendedTradeDate
    ?? null

  if (input.tradeDateStatus && !input.tradeDateStatus.isTradeDay) {
    issues.push({
      key: 'nonTradingDay',
      kind: 'calendar',
      title: '所选日期不是交易日',
      description: recommendedTradeDate
        ? `当天没有集合竞价事实, 可切换到最近交易日 ${recommendedTradeDate}。`
        : '当天没有集合竞价事实, 且本地交易日历暂未找到最近交易日。',
      impact: '页面不会使用上一交易日涨停池拼出当天候选。',
      actions: recommendedTradeDate ? ['switchTradeDate'] : ['openDataTools'],
    })
  }

  if (input.loadError) {
    issues.push({
      key: 'snapshotLoad',
      kind: 'snapshot',
      title: '竞价快照加载失败',
      description: input.loadError,
      impact: '当前无法建立候选队列, 已有本地数据不会被删除。',
      actions: ['refreshSnapshot', 'openDataTools'],
    })
  }

  if (input.insightError && input.insightError.code !== 'NON_TRADING_DAY') {
    const applicationFailure = isApplicationFailure(input.insightError)
    issues.push({
      key: 'insightFailure',
      kind: applicationFailure ? 'application' : 'snapshot',
      title: applicationFailure ? 'P2 结构化研判运行失败' : 'P2 结构化研判尚未生成',
      description: input.insightError.message,
      impact: '候选队列和 P1 白盒研判仍可使用, 仅 P2 持久化证据暂不可用。',
      actions: applicationFailure
        ? ['relaunch', 'regenerateInsights']
        : ['refreshSnapshot', 'regenerateInsights'],
    })
  }

  const blockedByKey = new Map<string, number>()
  for (const insight of input.insights) {
    for (const item of insight.verificationItems) {
      if (item.status !== 'blocked') continue
      blockedByKey.set(item.key, (blockedByKey.get(item.key) ?? 0) + 1)
    }
  }
  for (const [key, count] of blockedByKey) {
    const definition = EVIDENCE_RECOVERY[key]
    if (!definition) continue
    issues.push({ key, kind: 'evidence', count, ...definition })
  }

  return {
    issues,
    recommendedTradeDate,
    stats: {
      uniqueStockCount: input.uniqueStockCount,
      candidateRecordCount: input.candidateRecordCount,
      generatedInsightCount: input.generatedInsightCount,
      missingInsightCount: input.missingInsightCount,
      blockedEvidenceCount: input.blockedEvidenceCount,
    },
  }
}