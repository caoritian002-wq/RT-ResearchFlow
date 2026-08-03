import { describe, expect, it } from 'vitest'
import {
  auditResearchText,
  buildBlockedResearchText,
  buildContextResearchEvidenceContrast,
  buildResearchAuditTraceView,
  buildStockResearchEvidenceContrast,
  hashResearchEvidenceContrast,
  mergeResearchEvidenceContrasts,
  validatedResearchEvidenceReferenceIds,
} from '../../electron/main/services/researchEvidenceAuditService'
import type {
  ResearchFactToolDataMap,
  ResearchFactToolEnvelope,
  ResearchFactToolId,
} from '../../electron/main/services/researchFactToolRegistry'

function envelope<K extends ResearchFactToolId>(
  toolId: K,
  data: ResearchFactToolDataMap[K],
  options: {
    status?: ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]>['status']
    warnings?: string[]
    available?: number
    required?: number | null
  } = {},
): ResearchFactToolEnvelope<K, ResearchFactToolDataMap[K]> {
  return {
    schemaVersion: 1,
    toolId,
    status: options.status ?? 'ready',
    generatedAt: Date.parse('2026-07-29T02:00:00.000Z'),
    asOf: '20260728',
    sources: [{ id: `local.${toolId}`, status: 'ready', factDate: '20260728' }],
    coverage: {
      available: options.available ?? 1,
      required: options.required === undefined ? 1 : options.required,
      unit: 'items',
    },
    warnings: options.warnings ?? [],
    data,
  }
}

function stockContrast() {
  const trend = envelope('stock.trend_snapshot', {
    stockCode: '600000',
    tsCode: '600000.SH',
    stockName: '浦发银行',
    tradeDate: '20260728',
    bars: 80,
    requiredBars: 60,
    totalScore: 72,
    validWeight: 1,
    trendState: 'strong',
    dimensions: null,
    facts: {
      stockReturn20d: 6.25,
      benchmarkReturn20d: 8.5,
      excessReturn20d: -2.25,
      maxDrawdown20d: -4.1,
      maAbove60: 1,
      maAlignment: 1,
      macdState: 1,
      bollPosition: 1,
      volumeQuality: null,
    },
    benchmark: { tsCode: '000300.SH', tradeDate: '20260728', bars: 80, status: 'ready' },
  })
  const fundamentals = envelope('stock.fundamentals', {
    stockCode: '600000',
    tsCode: '600000.SH',
    profile: null,
    latestFinancial: {
      tsCode: '600000.SH',
      shortName: '浦发银行',
      reportDate: '20260630',
      noticeDate: '20260720',
      reportType: 'interim',
      reportTypeLabel: '中报',
      totalRevenue: 100,
      parentNetProfit: 10,
      revenueYoy: 5.5,
      parentNetProfitYoy: -3.25,
      grossMargin: null,
      weightedRoe: 4,
      debtRatio: null,
      sourceUrl: 'https://example.com/finance',
      sourceFetchedAt: Date.parse('2026-07-20T02:00:00.000Z'),
    },
    financialHistory: [],
    diagnostics: null,
  }, { status: 'partial', warnings: ['公司概况不可历史还原'], available: 1, required: 2 })
  const announcements = envelope('stock.announcements', {
    stockCode: '600000',
    tsCode: '600000.SH',
    announcements: [],
    diagnostics: null,
  })
  return buildStockResearchEvidenceContrast([{
    stockCode: '600000',
    trend,
    fundamentals,
    announcements,
  }], {
    generatedAt: Date.parse('2026-07-29T02:00:00.000Z'),
    asOf: '20260728',
  })
}

describe('research evidence contrast', () => {
  it('从结构化工具结果并列生成支持、反证与未知项', () => {
    const contrast = stockContrast()
    const subject = contrast.subjects[0]

    expect(subject.supporting.map((item) => item.code)).toEqual(expect.arrayContaining([
      'trend_state_positive',
      'stock_return_20d',
      'revenue_yoy',
    ]))
    expect(subject.challenging.map((item) => item.code)).toEqual(expect.arrayContaining([
      'excess_return_20d',
      'profit_yoy',
    ]))
    expect(subject.unknowns.map((item) => item.code)).toEqual(expect.arrayContaining([
      'tool_status_stock_fundamentals',
      'announcement_index_empty',
    ]))
    expect(contrast.markdown).toContain('确定性证据对照')
    expect(contrast.markdown).toContain('支持证据')
    expect(contrast.markdown).toContain('反证与风险')
    expect(contrast.markdown).toContain('未知与待核验')
    expect(subject.supporting.every((item) => /^E-[A-F0-9]{10}$/.test(item.referenceId || ''))).toBe(true)
    expect(contrast.markdown).toContain(`[${subject.supporting[0].referenceId}]`)
  })

  it('产业快照仅把已确认一手证据列为支持，并保留开放假设的反证条件', () => {
    const project = envelope('industry.project_snapshot', {
      projectId: 'project-1',
      snapshot: {
        id: 'snapshot-1', previousSnapshotId: null, reason: 'baseline', title: '光纤研究',
        schemaVersion: 1, createdAt: Date.parse('2026-07-28T02:00:00.000Z'),
      },
      project: {
        title: '光纤研究', industryName: '光通信', productScope: '光纤', regionScope: '中国',
        timeScope: '2026', purpose: 'investment', depth: 'standard', status: 'active',
        dataAsOf: '20260728', valuationDate: null, nextReviewAt: null, stopCondition: null,
      },
      graph: {
        nodeCount: 2,
        edgeCount: 1,
        nodes: [],
        edges: [{ sourceNodeId: 'a', targetNodeId: 'b', relation: '制约', statementKind: 'hypothesis', bottleneck: true }],
      },
      evidenceRefs: [
        { id: 'e1', title: '协会原始数据', statementKind: 'fact', sourceUrl: 'https://example.com/1', primarySourceConfirmed: true },
        { id: 'e2', title: '媒体转述', statementKind: 'estimate', sourceUrl: 'https://example.com/2', primarySourceConfirmed: false },
      ],
      evidenceRefCount: 2,
      hypotheses: [{
        id: 'h1', statement: '供给形成瓶颈', importance: 3, status: 'open',
        cheapestDisproof: '开工率持续上升', verificationMetric: '开工率', threshold: '>90%', dueAt: null,
      }],
      hypothesisCount: 1,
      companies: [],
      companyCount: 0,
      followUps: [],
      followUpCount: 0,
    })
    const contrast = buildContextResearchEvidenceContrast('industry_project', 'project-1', project, {
      generatedAt: project.generatedAt,
      asOf: '20260728',
    })

    expect(contrast.subjects[0].supporting).toEqual([
      expect.objectContaining({ code: 'industry_evidence_e1' }),
    ])
    expect(contrast.subjects[0].challenging).toEqual([
      expect.objectContaining({ code: 'industry_bottleneck_a_b' }),
    ])
    expect(contrast.subjects[0].unknowns).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'industry_evidence_e2' }),
      expect.objectContaining({ code: 'industry_hypothesis_h1' }),
    ]))
  })
})

describe('research text audit', () => {
  it('阻断肯定式交易指令但不误伤明确禁止交易建议的表述', () => {
    const contrast = stockContrast()
    const blocked = auditResearchText({
      text: '建议买入并将仓位设为30%，风险可忽略。',
      documentKind: 'discussion',
      evidenceContrast: contrast,
      now: 1,
    })
    const negated = auditResearchText({
      text: '本研究不提供买入建议、目标价或仓位安排；仍需披露风险与未知项。',
      documentKind: 'discussion',
      evidenceContrast: contrast,
      now: 1,
    })

    expect(blocked.status).toBe('blocked')
    expect(blocked.checks.find((item) => item.code === 'PROHIBITED_TRANSACTION_INSTRUCTION')?.excerpts.length).toBeGreaterThan(0)
    expect(buildBlockedResearchText(blocked)).not.toContain('建议买入')
    expect(negated.checks.find((item) => item.code === 'PROHIBITED_TRANSACTION_INSTRUCTION')?.status).toBe('passed')
  })

  it('对证据夸大、公告标题升级、未来事实和不可追溯精确数字留警告而不阻断', () => {
    const audit = auditResearchText({
      text: [
        '所有数据已经完整核验。',
        '公告显示利润已经兑现。',
        '截至2026-08-10，公司已经实现增长。',
        '毛利率达到12.345%。',
      ].join('\n'),
      documentKind: 'discussion',
      evidenceContrast: stockContrast(),
      asOf: '20260728',
      allowedFactTexts: ['毛利率未知'],
      now: 1,
    })

    expect(audit.status).toBe('warning')
    expect(audit.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EVIDENCE_COMPLETENESS_OVERCLAIM', status: 'warning' }),
      expect.objectContaining({ code: 'ANNOUNCEMENT_TITLE_OVERCLAIM', status: 'warning' }),
      expect.objectContaining({ code: 'FUTURE_FACT_AFTER_CUTOFF', status: 'warning' }),
      expect.objectContaining({ code: 'PRECISE_NUMBER_TRACEABILITY', status: 'warning' }),
    ]))
  })

  it('阻断文本或搜索轨迹中出现的用户排除来源', () => {
    const audit = auditResearchText({
      text: '风险与未知项见来源 https://excluded.example.com/report?from=ai',
      documentKind: 'discussion',
      evidenceContrast: stockContrast(),
      excludedUrls: ['https://excluded.example.com/report'],
      webSearchTrace: {
        responseId: 'response-1',
        calls: [],
        citations: [],
        sources: [{ url: 'https://excluded.example.com/report', title: null, cited: true }],
      },
      now: 1,
    })

    expect(audit.status).toBe('blocked')
    expect(audit.checks.find((item) => item.code === 'EXCLUDED_SOURCE_REFERENCE')?.status).toBe('blocked')
  })

  it('合并股票与实体证据并审计产业报告必需章节', () => {
    const merged = mergeResearchEvidenceContrasts([stockContrast()], { generatedAt: 1, asOf: '20260728' })
    const malformed = mergeResearchEvidenceContrasts([{
      schemaVersion: 1,
      generatedAt: 1,
      asOf: '20260728',
      subjects: [{ subjectKind: 'stock', subjectId: '600000' }],
      warnings: [],
      markdown: '损坏对象',
    } as never], { generatedAt: 1, asOf: '20260728' })
    const audit = auditResearchText({
      text: '# 简报\n\n## 一、核心结论\n风险与未知项仍待核验。',
      documentKind: 'industry_report',
      evidenceContrast: merged,
      now: 1,
    })

    expect(merged.generatedAt).toBe(1)
    expect(malformed.subjects).toEqual([])
    expect(audit.status).toBe('warning')
    expect(audit.checks.find((item) => item.code === 'REQUIRED_REPORT_SECTIONS')).toMatchObject({
      status: 'warning',
    })
  })

  it('只接受当前证据快照中的稳定引用编号，并生成可回放投影', () => {
    const contrast = stockContrast()
    const referenceId = contrast.subjects[0].supporting[0].referenceId!
    const audit = auditResearchText({
      text: `趋势结构保持积极，但仍需关注相对弱势与未知项。[${referenceId}] [E-FFFFFFFFFF]`,
      documentKind: 'discussion',
      evidenceContrast: contrast,
      now: 1,
    })
    const trace = buildResearchAuditTraceView(audit, contrast)

    expect(audit.citationSummary).toMatchObject({
      evidenceSnapshotSha256: hashResearchEvidenceContrast(contrast),
      referencedIds: [referenceId],
      unresolvedIds: ['E-FFFFFFFFFF'],
    })
    expect(audit.checks.find((item) => item.code === 'EVIDENCE_REFERENCE_REQUIRED')?.status).toBe('passed')
    expect(audit.checks.find((item) => item.code === 'EVIDENCE_REFERENCE_UNKNOWN')?.status).toBe('warning')
    expect(trace).toMatchObject({
      replayStatus: 'ready',
      citationSummary: { referencedReferences: 1, unresolvedReferences: 1 },
    })
    expect(trace?.subjects[0].items.find((item) => item.referenceId === referenceId)?.referenced).toBe(true)
  })

  it('旧审计明确标记为历史兼容，快照不一致时停止关联具体证据', () => {
    const contrast = stockContrast()
    const current = auditResearchText({
      text: `风险与未知项仍需核验。[${contrast.subjects[0].supporting[0].referenceId}]`,
      documentKind: 'discussion',
      evidenceContrast: contrast,
      now: 1,
    })
    const legacy = { ...current, citationSummary: undefined }
    const tampered = structuredClone(contrast)
    tampered.subjects[0].supporting[0].detail = '被改写的证据详情'

    expect(buildResearchAuditTraceView(legacy, contrast)).toMatchObject({ replayStatus: 'legacy' })
    expect(buildResearchAuditTraceView(current, tampered)).toMatchObject({
      replayStatus: 'snapshot_mismatch',
      subjects: [],
    })
    expect(buildResearchAuditTraceView(current, contrast, '被改写的正文')).toMatchObject({
      replayStatus: 'document_mismatch',
      subjects: [],
    })
  })

  it('重算稳定引用并拒绝不改变规范化证据哈希的伪造编号', () => {
    const contrast = stockContrast()
    const expected = contrast.subjects.flatMap((subject) => [
      ...subject.supporting,
      ...subject.challenging,
      ...subject.unknowns,
    ]).map((item) => item.referenceId)
    expect(validatedResearchEvidenceReferenceIds(contrast)).toEqual([...new Set(expected)])

    const tampered = structuredClone(contrast)
    tampered.subjects[0].supporting[0].referenceId = 'E-FFFFFFFFFF'
    expect(hashResearchEvidenceContrast(tampered)).toBe(hashResearchEvidenceContrast(contrast))
    expect(validatedResearchEvidenceReferenceIds(tampered)).toBeNull()
  })
})
