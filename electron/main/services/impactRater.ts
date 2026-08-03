import type { ImpactRating } from '../database/types'

interface RatingResult {
  rating: ImpactRating
  score: number
}

// ──────────────────────────────────────────────────────────
// Keyword weight tables
// ──────────────────────────────────────────────────────────

const CRITICAL_KEYWORDS: [string, number][] = [
  // Monetary policy
  ['降息', 25], ['加息', 25], ['降准', 25], ['存款准备金率', 20],
  ['基准利率', 20], ['量化宽松', 20], ['紧缩货币', 20],
  // Financial stability
  ['系统性风险', 25], ['金融危机', 25], ['流动性危机', 25],
  ['银行破产', 25], ['股市熔断', 20], ['汇率崩溃', 20],
  // Major regulatory
  ['紧急通知', 20], ['全面暂停', 20], ['立即执行', 18],
  ['重大违规', 18], ['强制退市', 20], ['吊销牌照', 20],
  // Macro policy
  ['财政赤字', 15], ['国债发行', 15], ['人民币汇率', 15],
  ['外汇储备', 15], ['金融开放', 15]
]

const IMPORTANT_KEYWORDS: [string, number][] = [
  // Regulatory actions
  ['监管措施', 12], ['行政处罚', 12], ['责令整改', 12],
  ['检查通报', 10], ['风险提示', 10], ['合规要求', 10],
  // Capital markets
  ['IPO审核', 12], ['再融资', 10], ['并购重组', 12],
  ['信息披露', 10], ['退市风险', 12], ['停牌复牌', 10],
  // Macro data
  ['GDP增速', 12], ['CPI', 10], ['PPI', 10], ['PMI', 10],
  ['贸易顺差', 10], ['贸易逆差', 10], ['外商投资', 10],
  // Policy
  ['政策调整', 10], ['改革方案', 10], ['试点方案', 8],
  ['指导意见', 8], ['管理办法', 8], ['实施细则', 8]
]

const GENERAL_KEYWORDS: [string, number][] = [
  ['发布公告', 4], ['例行发布', 3], ['数据公布', 4],
  ['统计数据', 3], ['会议纪要', 4], ['工作部署', 3],
  ['人事变动', 3], ['调研报告', 3], ['研究报告', 3],
  ['市场分析', 2], ['行业动态', 2], ['企业动态', 2]
]

// Authority weight bonus: higher authority = higher score multiplier
const AUTHORITY_BONUS: Record<number, number> = {
  10: 15,
  9: 10,
  8: 6,
  7: 3,
  6: 1,
  5: 0
}

export function rateImpact(title: string, summary: string, authorityWeight: number): RatingResult {
  const text = title + ' ' + summary
  let score = 0

  for (const [kw, weight] of CRITICAL_KEYWORDS) {
    if (text.includes(kw)) score += weight
  }
  for (const [kw, weight] of IMPORTANT_KEYWORDS) {
    if (text.includes(kw)) score += weight
  }
  for (const [kw, weight] of GENERAL_KEYWORDS) {
    if (text.includes(kw)) score += weight
  }

  // Authority bonus
  const bonus = AUTHORITY_BONUS[Math.min(authorityWeight, 10)] ?? 0
  score += bonus

  const rating: ImpactRating =
    score >= 30 ? 'CRITICAL' : score >= 15 ? 'IMPORTANT' : 'GENERAL'

  return { rating, score: Math.min(score, 100) }
}
