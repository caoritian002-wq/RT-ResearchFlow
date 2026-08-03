import { describe, expect, it } from 'vitest'
import {
  assessResearchAgentEvidence,
  RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION,
  selectResearchAgentEvidenceDocuments,
  type ResearchAgentEvidenceObservation,
} from '../../electron/main/services/researchAgentEvidenceGate'

function observation(
  toolId: string,
  options: {
    factDate?: string
    sourceId?: string
    data?: unknown
    status?: 'ready' | 'partial' | 'missing' | 'blocked'
    available?: number
  } = {},
): ResearchAgentEvidenceObservation {
  return {
    toolId,
    callStatus: 'succeeded',
    envelope: {
      schemaVersion: 1,
      toolId,
      status: options.status ?? 'ready',
      generatedAt: Date.parse('2026-07-30T08:00:00.000Z'),
      asOf: '20260730',
      sources: [{
        id: options.sourceId ?? 'local.test',
        status: 'ready',
        factDate: options.factDate ?? '20260730',
      }],
      coverage: { available: options.available ?? 1, required: 1, unit: 'items' },
      warnings: [],
      data: options.data ?? { value: 1 },
    },
  }
}

const STOCK = [{ kind: 'stock' as const, tsCode: '600519.SH', label: '贵州茅台' }]

function documentData(
  excerpt: string,
  sourceClass: 'official' | 'primary' | 'secondary',
  sourceDomain: string,
  options: { title?: string; publishedAt?: string; hash?: string } = {},
) {
  return {
    document: {
      title: options.title ?? '贵州茅台重要事项公告',
      excerpt,
      contentSha256: options.hash ?? 'a'.repeat(64),
      finalUrl: `https://${sourceDomain}/article`,
      fetchedAt: Date.parse('2026-07-30T08:00:00.000Z'),
      sourceDomain,
      sourceClass,
      primarySourceConfirmed: sourceClass !== 'secondary',
      publishedAt: options.publishedAt ?? '2026-07-29',
    },
  }
}

describe('FR-256 evidence sufficiency gate', () => {
  it('allows a pure historical market question when local market facts are usable and fresh', () => {
    const result = assessResearchAgentEvidence({
      question: '分析这只股票截至研究日的历史走势、回撤和波动',
      asOf: '20260730',
      subjects: STOCK,
      observations: [observation('stock.trend_snapshot', { factDate: '20260729' })],
    })

    expect(result).toMatchObject({
      ruleVersion: RESEARCH_AGENT_EVIDENCE_GATE_RULE_VERSION,
      decision: 'local_sufficient',
      maximumOutcome: 'complete',
      questionProfile: { marketOnly: true },
    })
    expect(result.checks).toEqual([
      expect.objectContaining({ category: 'market_history', status: 'passed', code: 'MARKET_HISTORY_READY' }),
    ])
  })

  it('requires networking for latest news when local evidence is title-only', () => {
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [observation('news.recent_briefings', {
        data: { items: [{ title: '标题线索', summary: '', originalUrl: 'https://example.com/news' }] },
      })],
    })

    expect(result).toMatchObject({ decision: 'network_required', maximumOutcome: 'blocked' })
    expect(result.checks).toEqual([
      expect.objectContaining({
        category: 'current_events',
        status: 'failed',
        code: 'CURRENT_EVENT_BODY_AND_CORROBORATION_REQUIRED',
      }),
    ])
    expect(result.requiredNetworkTools).toEqual(['web.search', 'web.fetch_page'])
  })

  it('does not let structured fundamentals replace official disclosure bodies', () => {
    const result = assessResearchAgentEvidence({
      question: '分析公司基本面、利润和现金流质量',
      asOf: '20260730',
      subjects: STOCK,
      observations: [observation('stock.fundamentals', { data: { financialHistory: [{ revenue: 100 }] } })],
    })

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'company_fundamentals', status: 'passed' }),
      expect.objectContaining({ category: 'company_disclosures', status: 'failed' }),
    ]))
    expect(result.decision).toBe('network_required')
  })

  it('requires a primary-source sample for an industry project snapshot', () => {
    const result = assessResearchAgentEvidence({
      question: '研究这个产业的供需格局与产能瓶颈',
      asOf: '20260730',
      subjects: [{ kind: 'industry_project', id: 'project-1', label: '测试产业' }],
      observations: [observation('industry.project_snapshot', {
        data: { evidenceRefs: [{ title: '证据标题', primarySourceConfirmed: false }] },
      })],
    })

    expect(result).toMatchObject({ decision: 'network_required' })
    expect(result.checks[0]).toMatchObject({
      category: 'industry_evidence',
      code: 'INDUSTRY_PRIMARY_SAMPLE_REQUIRED',
    })
  })

  it('accepts current-event evidence only after independent bodies and an official source are frozen', () => {
    const officialBody = `证券代码：600519 证券简称：贵州茅台\n${'贵州茅台公告披露本次重要事项的发生时间、决策程序、事实细节与限制条件。'.repeat(5)}`
    const mediaBody = '独立媒体对贵州茅台近期事项进行了现场核验，并列出采访对象、时间线和仍待确认的后续影响。'.repeat(5)
    const result = assessResearchAgentEvidence({
      question: '公司最近发生了什么重要事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          sourceId: 'official.exchange.cninfo',
          data: documentData(officialBody, 'official', 'cninfo.com.cn'),
        }),
        observation('web.fetch_page', {
          sourceId: 'media.authoritative',
          data: documentData(mediaBody, 'secondary', 'news.example.com', {
            title: '贵州茅台近期事项独立核验',
            hash: 'b'.repeat(64),
          }),
        }),
      ],
    })

    expect(result).toMatchObject({ decision: 'local_sufficient', maximumOutcome: 'complete' })
    expect(result.checks[0]).toMatchObject({ category: 'current_events', status: 'passed' })
  })

  it('recognizes a formal cninfo issuer report when PDF metadata truncates the title', () => {
    const reportBody = `公司代码：603618 公司简称：杭电股份
杭州电缆股份有限公司
2026年度向特定对象发行A股股票募集资金使用可行性分析报告
${'光纤预制棒、新型光纤研发制造超级工厂拟扩充产能，建设周期、技术路线和风险边界均已披露。'.repeat(5)}`
    const result = assessResearchAgentEvidence({
      question: '分析杭电股份公告披露的光纤扩产项目',
      asOf: '20260802',
      subjects: [{ kind: 'stock', tsCode: '603618.SH', label: '杭电股份' }],
      observations: [observation('official.disclosure_document', {
        data: documentData(reportBody, 'official', 'dataclouds.cninfo.com.cn', {
          title: '杭州电缆股份有限公司（Hangzhou Cable Co.,Ltd.） 2026 ...',
          publishedAt: '2026-07-20',
          hash: '8'.repeat(64),
        }),
      })],
    })

    expect(result).toMatchObject({ decision: 'local_sufficient', maximumOutcome: 'complete' })
    expect(result.checks[0]).toMatchObject({
      category: 'company_disclosures',
      status: 'passed',
      code: 'OFFICIAL_DISCLOSURE_READY',
    })
  })

  it('passes the industry 3+2+1 gate for the real cninfo plus government-repost evidence shape', () => {
    const filing = `证券代码：600498 证券简称：烽火通信
2026年度向特定对象发行A股股票预案
${'光纤扩产项目披露建设周期、行业供需影响、核心技术壁垒和产能消化风险。'.repeat(6)}`
    const industryInterview = `来源：证券日报\n${'光纤扩产项目的建设周期会影响行业供需，采访同时核验核心技术壁垒与产能消化节奏。'.repeat(6)}`
    const industryReport = `来源：长江日报\n${'报道跟踪光纤扩产、行业供需、技术壁垒和设备交付周期，并列示乐观与压力情景。'.repeat(6)}`
    const input: Parameters<typeof assessResearchAgentEvidence>[0] = {
      question: '光纤扩产多久冲击行业供需与技术壁垒？',
      asOf: '20260802',
      subjects: [{ kind: 'industry_project', id: 'fiber-project', label: '中国通信光纤光缆产业链' }],
      observations: [
        observation('official.disclosure_document', {
          data: documentData(filing, 'official', 'dataclouds.cninfo.com.cn', {
            title: '2026年度向特定对象发行A股股票预案',
            publishedAt: '2026-07-10',
            hash: '9'.repeat(64),
          }),
        }),
        observation('official.disclosure_document', {
          data: documentData(industryInterview, 'official', 'zjic.zj.gov.cn', {
            title: '浙江省经济信息中心',
            publishedAt: '2026-06-20',
            hash: 'a'.repeat(64),
          }),
        }),
        observation('official.disclosure_document', {
          data: documentData(industryReport, 'official', 'kjj.wuhan.gov.cn', {
            title: '科技新闻',
            publishedAt: '2025-11-18',
            hash: 'b'.repeat(64),
          }),
        }),
      ],
    }
    const result = assessResearchAgentEvidence(input)
    const selected = selectResearchAgentEvidenceDocuments(input, ['industry_evidence'])

    expect(result).toMatchObject({ decision: 'local_sufficient', maximumOutcome: 'complete' })
    expect(result.checks[0]).toMatchObject({
      category: 'industry_evidence',
      status: 'passed',
      code: 'INDUSTRY_EVIDENCE_READY',
    })
    expect(selected).toHaveLength(3)
    expect(selected.filter((document) => document.primary)).toEqual([
      expect.objectContaining({ sourceIdentity: 'cninfo.com.cn' }),
    ])
  })

  it('does not treat an ordinary company-site promotional article as a formal primary document', () => {
    const companyNews = '贵州茅台官网发布品牌文化活动新闻，介绍来宾、现场交流和市场传播安排。'.repeat(6)
    const independent = '媒体报道贵州茅台品牌活动和近期市场新闻，并整理采访时间线。'.repeat(6)
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          data: documentData(companyNews, 'primary', 'moutai.com.cn', {
            title: '贵州茅台品牌文化活动新闻',
            hash: 'c'.repeat(64),
          }),
        }),
        observation('web.fetch_page', {
          data: documentData(independent, 'secondary', 'news.example.com', {
            title: '贵州茅台近期品牌活动报道',
            hash: 'd'.repeat(64),
          }),
        }),
      ],
    })

    expect(result.decision).toBe('network_required')
    expect(result.checks[0].message).toContain('可确认一级来源0份')
  })

  it('deduplicates the same syndicated body across different media domains', () => {
    const body = '贵州茅台近期事项由科技日报首发，正文的时间线、采访内容和结论完全相同。'.repeat(6)
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          sourceId: 'media.cctv',
          data: documentData(body, 'secondary', 'cctv.com', { title: '转载：贵州茅台近期事项', hash: 'c'.repeat(64) }),
        }),
        observation('web.fetch_page', {
          sourceId: 'media.people',
          data: documentData(body, 'secondary', 'people.com.cn', { title: '贵州茅台近期事项', hash: 'c'.repeat(64) }),
        }),
      ],
    })

    expect(result.decision).toBe('network_required')
    expect(result.checks[0].message).toContain('有效1份')
  })

  it('deduplicates near-identical syndicated bodies even when a repost adds a prefix and changes the title', () => {
    const body = '贵州茅台近期事项发生于七月二十九日，公司说明了决策程序、涉及范围、已确认事实、限制条件以及仍待核验的后续影响。独立核验需要继续追踪正式披露与经营数据，不能把单一消息直接外推为交易结论。'
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          sourceId: 'official.exchange',
          data: documentData(body, 'official', 'cninfo.com.cn', {
            title: '贵州茅台重要事项公告',
            hash: '2'.repeat(64),
          }),
        }),
        observation('web.fetch_page', {
          sourceId: 'media.repost',
          data: documentData(`编${body}责任编辑甲`, 'secondary', 'news.example.com', {
            title: '市场快讯：公司回应近期事项',
            hash: '3'.repeat(64),
          }),
        }),
      ],
    })

    expect(result.decision).toBe('network_required')
    expect(result.checks[0].message).toContain('有效1份')
  })

  it('does not treat a government-domain repost without issuer markers as primary evidence', () => {
    const governmentRepost = '贵州茅台近期市场消息转载自行业媒体，页面没有政策、公告、通知或监管发行信息。'.repeat(5)
      .replaceAll('通知', '动态')
      .replaceAll('公告', '文章')
      .replaceAll('政策', '观点')
      .replaceAll('监管', '市场')
    const independent = '另一家媒体独立采访贵州茅台相关人员并整理事件时间线和后续未知项。'.repeat(6)
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          sourceId: 'official.gov',
          data: documentData(governmentRepost, 'official', 'example.gov.cn', {
            title: '贵州茅台市场动态转载',
            hash: 'd'.repeat(64),
          }),
        }),
        observation('web.fetch_page', {
          sourceId: 'media.independent',
          data: documentData(independent, 'secondary', 'news.example.com', {
            title: '贵州茅台近期事项采访',
            hash: 'e'.repeat(64),
          }),
        }),
      ],
    })

    expect(result.decision).toBe('network_required')
    expect(result.checks[0].message).toContain('可确认一级来源0份')
  })

  it('recognizes a formally titled central-government policy as primary evidence', () => {
    const policy = '国务院关于推进光纤网络基础设施建设的规划，明确行业供需、建设周期、技术标准和实施边界。'.repeat(6)
    const result = assessResearchAgentEvidence({
      question: '研究光纤行业供需与政策影响',
      asOf: '20260730',
      subjects: [{ kind: 'stock', tsCode: '600498.SH', label: '烽火通信' }],
      observations: [observation('official.disclosure_document', {
        data: documentData(policy, 'official', 'www.gov.cn', {
          title: '国务院关于推进光纤网络基础设施建设的规划',
          publishedAt: '2026-07-20',
          hash: 'e'.repeat(64),
        }),
      })],
    })

    expect(result.checks[0].message).toContain('可确认一级来源1份')
  })

  it('does not treat a generic research report mention on a government domain as a formal issuer marker', () => {
    const governmentRepost = '贵州茅台近期市场动态引用第三方行业研究报告，正文整理市场观点与价格表现，没有发布正式文件。'.repeat(5)
    const independent = '另一家媒体独立采访贵州茅台相关人员并整理事件时间线和后续未知项。'.repeat(6)
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          sourceId: 'official.gov',
          data: documentData(governmentRepost, 'official', 'example.gov.cn', {
            title: '贵州茅台市场动态',
            hash: '4'.repeat(64),
          }),
        }),
        observation('web.fetch_page', {
          sourceId: 'media.independent',
          data: documentData(independent, 'secondary', 'news.example.com', {
            title: '贵州茅台近期事项采访',
            hash: '5'.repeat(64),
          }),
        }),
      ],
    })

    expect(result.decision).toBe('network_required')
    expect(result.checks[0].message).toContain('可确认一级来源0份')
  })

  it('does not upgrade a government news article merely because its body mentions an announcement', () => {
    const governmentNews = '贵州茅台近期市场动态援引公司公告，并整理分析师观点、价格表现和后续采访计划。'.repeat(5)
    const independent = '另一家媒体独立采访贵州茅台相关人员并整理事件时间线和后续未知项。'.repeat(6)
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          sourceId: 'official.gov',
          data: documentData(governmentNews, 'official', 'example.gov.cn', {
            title: '贵州茅台市场动态',
            hash: '6'.repeat(64),
          }),
        }),
        observation('web.fetch_page', {
          sourceId: 'media.independent',
          data: documentData(independent, 'secondary', 'news.example.com', {
            title: '贵州茅台近期事项采访',
            hash: '7'.repeat(64),
          }),
        }),
      ],
    })

    expect(result.decision).toBe('network_required')
    expect(result.checks[0].message).toContain('可确认一级来源0份')
  })

  it('rejects stale or subject-irrelevant bodies for a current event question', () => {
    const result = assessResearchAgentEvidence({
      question: '贵州茅台最近有什么重要新闻和事件？',
      asOf: '20260730',
      subjects: STOCK,
      observations: [
        observation('web.fetch_page', {
          data: documentData('贵州茅台历史事项资料。'.repeat(20), 'official', 'cninfo.com.cn', {
            publishedAt: '2024-01-01',
            hash: 'f'.repeat(64),
          }),
        }),
        observation('web.fetch_page', {
          sourceId: 'media.unrelated',
          data: documentData('某海外芯片企业发布新品及销售预测。'.repeat(20), 'secondary', 'chips.example.com', {
            title: '海外芯片新品',
            hash: '1'.repeat(64),
          }),
        }),
      ],
    })

    expect(result.decision).toBe('network_required')
    expect(result.checks[0].message).toContain('有效0份')
  })

  it('keeps an offline request blocked when its local evidence is insufficient', () => {
    const result = assessResearchAgentEvidence({
      question: '仅基于本地资料分析公司最新公告',
      asOf: '20260730',
      subjects: STOCK,
      observations: [],
    })

    expect(result).toMatchObject({
      decision: 'network_required',
      maximumOutcome: 'blocked',
      questionProfile: { offlineRequested: true },
    })
    expect(result.summary).toContain('用户要求离线')
  })

  it('requires a timestamped quote rather than treating daily bars as intraday evidence', () => {
    const result = assessResearchAgentEvidence({
      question: '分析这只股票盘中实时走势和当前价格',
      asOf: '20260730',
      subjects: STOCK,
      observations: [observation('stock.price_history')],
    })

    expect(result).toMatchObject({
      decision: 'network_required',
      questionProfile: { marketOnly: true, intraday: true },
      requiredNetworkTools: ['market.quote_snapshot'],
    })
    expect(result.checks[0]).toMatchObject({ code: 'INTRADAY_MARKET_EVIDENCE_REQUIRED' })
  })
})
