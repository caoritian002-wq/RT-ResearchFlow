import { createHash, randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import { upsertDailyClose } from '../../electron/main/database/dailyCloseCacheRepository'
import {
  upsertSecurityAdjustmentFactors,
  upsertSecurityValuationDaily,
} from '../../electron/main/database/industryResearchMarketRepository'
import {
  saveResearchCompany,
  saveResearchProjectCompany,
  saveResearchSecurity,
} from '../../electron/main/database/industryResearchFinancialRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import {
  adoptIndustryResearchSkillVersion,
  appendIndustryResearchDecisionEvent,
  appendIndustryResearchMonitoringObservation,
  evaluateIndustryResearchDecisionTriggers,
  getIndustryResearchDecisionReplay,
  getIndustryResearchReviewQueue,
  getIndustryResearchSkillAdoption,
  IndustryResearchDecisionError,
  resolveIndustryResearchTriggerReview,
  saveIndustryResearchDecisionTrigger,
  saveIndustryResearchMonitoringItem,
  saveIndustryResearchScenarioSet,
  saveIndustryResearchWorkItem,
} from '../../electron/main/services/industryResearchDecisionService'
import {
  createIndustryResearchProject,
  saveIndustryResearchEvidence,
  saveIndustryResearchHypothesis,
} from '../../electron/main/services/industryResearchService'
import type { VerifiedSkillBundle } from '../../electron/main/services/skillService'
import { buildIndustryResearchMarketContext } from '../../electron/main/services/industryResearchMarketService'
import { captureIndustryResearchValuationSnapshot } from '../../electron/main/services/industryResearchValuationService'

function bundle(content: string, version: string): VerifiedSkillBundle {
  const contentHash = createHash('sha256').update(content).digest('hex')
  return {
    meta: {
      skillId: 'builtin:industry-chain-research',
      name: 'industry-chain-research',
      description: '产业研究规则',
      version,
      source: 'builtin',
      dirPath: 'C:\\safe-test\\industry-chain-research',
      contentLength: content.length,
      contentHash,
      ruleVersion: version,
      integrity: 'complete',
    },
    content,
    contentHash,
    contentBytes: Buffer.byteLength(content),
    sourceDisplayName: 'industry-chain-research',
  }
}

const v1 = bundle('# 范围\n\n验证供需。\n\n# 决策\n\n记录条件。', 'v1')
const v2 = bundle('# 范围\n\n验证供需与价格。\n\n# 决策\n\n记录条件。\n\n# 监控\n\n保存观测。', 'v2')

function createInput() {
  return {
    title: '光通信产业研究', industryName: '光通信', productScope: '光模块', regionScope: '中国',
    timeScope: '2026', purpose: 'investment' as const, depth: 'standard' as const,
    sourceType: 'manual' as const, sourceRef: null, sourceText: null, nextReviewAt: null, stopCondition: null,
  }
}

describe('产业研究决策服务', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  it('新项目原子保存Skill正文、初始采用与共享研究基线', () => {
    const project = createIndustryResearchProject(db, createInput(), () => v1)
    const adoption = getIndustryResearchSkillAdoption(db, project.id, v1)

    expect(adoption).toEqual(expect.objectContaining({ status: 'current' }))
    expect(adoption.adopted).toEqual(expect.objectContaining({ eventType: 'initial' }))
    expect(db.prepare('SELECT snapshot_reason, skill_snapshot_id FROM industry_research_snapshots WHERE project_id = ?').get(project.id))
      .toEqual(expect.objectContaining({ snapshot_reason: 'project_baseline', skill_snapshot_id: expect.any(String) }))
  })

  it('旧项目只有显式采用才建立正文快照且只生成分组待复核', () => {
    const project = createResearchProject(db, {
      id: 'legacy-project', ...createInput(),
      skillId: v1.meta.skillId, skillContentHash: v1.contentHash, skillRuleVersion: v1.meta.ruleVersion,
    })
    saveIndustryResearchHypothesis(db, project.id, {
      id: 'legacy-hypothesis', statement: '需求持续增长', importance: 4, cheapestDisproof: '季度出货下降',
    })

    expect(getIndustryResearchSkillAdoption(db, project.id, v1).status).toBe('legacy_hash_only')
    const result = adoptIndustryResearchSkillVersion(db, {
      projectId: project.id,
      requestId: randomUUID(),
      targetContentHash: v1.contentHash,
      migrationNote: '确认旧项目继续采用当前规则。',
      expectedUpdatedAt: project.updated_at,
    }, v1)

    expect(result.adopted).toEqual(expect.objectContaining({ eventType: 'legacy_verified' }))
    expect(db.prepare('SELECT status FROM industry_research_hypotheses WHERE id = ?').get('legacy-hypothesis')).toEqual({ status: 'open' })
    expect(getIndustryResearchReviewQueue(db, project.id).filter((item) => item.kind === 'skill_adoption')).toHaveLength(1)
    expect(db.prepare('SELECT source_locator FROM industry_research_skill_snapshots LIMIT 1').get()).toEqual({ source_locator: 'industry-chain-research' })
  })

  it('拒绝伪精确情景权重并保持请求幂等', () => {
    const project = createIndustryResearchProject(db, createInput(), () => v1)
    const requestId = randomUUID()
    expect(() => saveIndustryResearchScenarioSet(db, {
      projectId: project.id, requestId, scenarioSetId: randomUUID(), expectedVersion: 0,
      dataAsOf: '2026-07-17', scenarios: [
        { name: 'bear', weightPct: 20, assumptions: {}, factIds: [] },
        { name: 'base', weightPct: 50, assumptions: {}, factIds: [] },
        { name: 'bull', weightPct: 20, assumptions: {}, factIds: [] },
      ],
    })).toThrowError(expect.objectContaining({ code: 'SCENARIO_WEIGHT_INVALID' }))

    const validRequestId = randomUUID()
    const scenarioSetId = randomUUID()
    const valid = saveIndustryResearchScenarioSet(db, {
      projectId: project.id, requestId: validRequestId, scenarioSetId, expectedVersion: 0,
      dataAsOf: '2026-07-17', scenarios: [
        { name: 'bear', weightPct: null, assumptions: { demand: 'weak' }, factIds: [] },
        { name: 'base', weightPct: null, assumptions: { demand: 'stable' }, factIds: [] },
        { name: 'bull', weightPct: null, assumptions: { demand: 'strong' }, factIds: [] },
      ],
    })
    const retry = saveIndustryResearchScenarioSet(db, {
      projectId: project.id, requestId: validRequestId, scenarioSetId, expectedVersion: 0,
      dataAsOf: '2026-07-17', scenarios: valid.scenarios,
    })
    expect(retry.versionId).toBe(valid.versionId)
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_scenario_set_versions').get()).toEqual({ count: 1 })
  })

  it('触发命中只创建待复核，人工确认才原子追加决策事件', () => {
    const project = createIndustryResearchProject(db, createInput(), () => v1)
    saveIndustryResearchHypothesis(db, project.id, {
      id: 'hypothesis-demand', statement: '需求景气', importance: 5, cheapestDisproof: '出货量跌破阈值',
    })
    const work = saveIndustryResearchWorkItem(db, {
      projectId: project.id, requestId: randomUUID(), workItemId: randomUUID(), expectedVersion: 0,
      question: '验证季度出货', effort: 'standard_validation', conclusionSensitivity: 'high',
      evidenceUncertainty: 'medium', changeVelocity: 'high', stopReason: null, nextTriggerMetric: '出货指数',
      affectedObjectIds: ['hypothesis-demand'], status: 'open',
    })
    const decisionId = randomUUID()
    const initial = appendIndustryResearchDecisionEvent(db, {
      projectId: project.id, requestId: randomUUID(), decisionId, expectedLastEventId: null,
      eventType: 'created', action: 'continue_research', rationale: '先验证季度出货。', dataAsOf: '2026-07-17',
      validUntil: Date.now() + 7 * 86400000, invalidationCondition: '出货指数持续低于5',
      workItemVersionIds: [work.versionId], factIds: [], evidenceIds: [], hypothesisIds: ['hypothesis-demand'],
    })
    const monitoringItemId = randomUUID()
    saveIndustryResearchMonitoringItem(db, {
      projectId: project.id, requestId: randomUUID(), monitoringItemId, expectedVersion: 0,
      name: '季度出货指数', valueKind: 'number', frequency: 'quarterly', sourceName: '人工录入', unit: '点',
      timingType: 'leading', staleAfterMs: 86400000, hypothesisIds: ['hypothesis-demand'],
      scenarioSetVersionIds: [], decisionIds: [decisionId], status: 'active',
    })
    const now = Date.now()
    appendIndustryResearchMonitoringObservation(db, {
      projectId: project.id, requestId: randomUUID(), monitoringItemId, expectedVersion: 1,
      value: 10, unit: '点', observedAt: now - 1000, availableAt: now - 1000,
      dataAsOf: '2026-07-17', methodologyVersion: 'manual-v1',
    })
    const triggerId = randomUUID()
    saveIndustryResearchDecisionTrigger(db, {
      projectId: project.id, requestId: randomUUID(), triggerId, expectedVersion: 0,
      decisionId, monitoringItemId, metricName: '季度出货指数', operator: 'gte', threshold: 8,
      validationWindowMs: 86400000, actionIfNotTriggered: 'continue_research', proposedActionIfTriggered: 'monitor',
      expiresAt: now + 86400000, status: 'active',
    })
    const [evaluation] = evaluateIndustryResearchDecisionTriggers(db, {
      projectId: project.id, requestId: randomUUID(), triggerIds: [triggerId], evaluatedAt: now,
    })

    expect(evaluation.result).toBe('pending_review')
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_decision_events').get()).toEqual({ count: 1 })

    const nextRequestId = randomUUID()
    const resolutionRequestId = randomUUID()
    const resolution = resolveIndustryResearchTriggerReview(db, {
      projectId: project.id, evaluationId: evaluation.id, requestId: resolutionRequestId, resolution: 'confirm',
      reason: '确认指标命中，转为持续监控。',
      decisionEvent: {
        projectId: project.id, requestId: nextRequestId, decisionId, expectedLastEventId: initial.id,
        eventType: 'downgraded', action: 'monitor', rationale: '指标已验证，后续只监控。', dataAsOf: '2026-07-17',
        validUntil: Date.now() + 14 * 86400000, invalidationCondition: '指数跌破5',
        workItemVersionIds: [work.versionId], factIds: [], evidenceIds: [], hypothesisIds: ['hypothesis-demand'],
        sourceTriggerEvaluationId: evaluation.id,
      },
    })

    expect(resolution.review.state).toBe('confirmed')
    expect(resolution.decisionEvent).toEqual(expect.objectContaining({ action: 'monitor', sourceTriggerEvaluationId: evaluation.id }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_decision_events').get()).toEqual({ count: 2 })
    const resolutionRetry = resolveIndustryResearchTriggerReview(db, {
      projectId: project.id, evaluationId: evaluation.id, requestId: resolutionRequestId,
      resolution: 'confirm', reason: '幂等重试无需重复提交决策载荷。',
    })
    expect(resolutionRetry.decisionEvent).toEqual(expect.objectContaining({ id: resolution.decisionEvent!.id }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_decision_events').get()).toEqual({ count: 2 })
    const replay = getIndustryResearchDecisionReplay(db, project.id, decisionId)
    expect(replay.history).toHaveLength(2)
    expect(replay.skillSnapshot.content).toContain('验证供需')
    expect(replay.marketContext).toEqual(expect.objectContaining({ status: 'blocked', price: null }))

    const missingMonitoringId = randomUUID()
    saveIndustryResearchMonitoringItem(db, {
      projectId: project.id, requestId: randomUUID(), monitoringItemId: missingMonitoringId, expectedVersion: 0,
      name: '库存指数', valueKind: 'number', frequency: 'weekly', sourceName: '人工录入', unit: '点',
      timingType: 'leading', staleAfterMs: 86400000, hypothesisIds: ['hypothesis-demand'],
      scenarioSetVersionIds: [], decisionIds: [decisionId], status: 'active',
    })
    const missingTriggerId = randomUUID()
    saveIndustryResearchDecisionTrigger(db, {
      projectId: project.id, requestId: randomUUID(), triggerId: missingTriggerId, expectedVersion: 0,
      decisionId, monitoringItemId: missingMonitoringId, metricName: '库存指数', operator: 'gte', threshold: 8,
      validationWindowMs: 86400000, actionIfNotTriggered: 'monitor', proposedActionIfTriggered: 'exclude',
      expiresAt: Date.now() + 86400000, status: 'active',
    })
    const [blocked] = evaluateIndustryResearchDecisionTriggers(db, {
      projectId: project.id, requestId: randomUUID(), triggerIds: [missingTriggerId],
    })
    expect(blocked).toEqual(expect.objectContaining({ result: 'blocked', observationId: null }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_decision_events').get()).toEqual({ count: 2 })
  })

  it('Skill变化只在显式采用后写入且不会自动修改假设', () => {
    const project = createIndustryResearchProject(db, createInput(), () => v1)
    saveIndustryResearchHypothesis(db, project.id, {
      id: 'hypothesis-rule', statement: '供需紧平衡', importance: 5, cheapestDisproof: '库存显著上升',
    })
    for (let index = 0; index < 40; index += 1) {
      saveIndustryResearchEvidence(db, project.id, {
        id: `evidence-rule-${index}`, title: `候选证据${index}`, sourceType: 'web', sourceName: '公开资料',
        sourceUrl: `https://example.com/${index}`, statementKind: 'estimate', direction: 'support',
        reliability: 'secondary', createdBy: 'ai', primarySourceConfirmed: false,
      })
    }
    expect(getIndustryResearchSkillAdoption(db, project.id, v2).status).toBe('changed')
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_skill_adoption_events').get()).toEqual({ count: 1 })
    const requestId = randomUUID()
    const adopted = adoptIndustryResearchSkillVersion(db, {
      projectId: project.id, requestId, targetContentHash: v2.contentHash,
      migrationNote: '采用监控规则，但不自动改写既有假设。', expectedUpdatedAt: project.updated_at,
    }, v2)
    expect(adopted.status).toBe('current')
    expect(db.prepare('SELECT status FROM industry_research_hypotheses WHERE id = ?').get('hypothesis-rule')).toEqual({ status: 'open' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_skill_adoption_events').get()).toEqual({ count: 2 })
    expect(getIndustryResearchReviewQueue(db, project.id).filter((item) => item.kind === 'skill_adoption')).toHaveLength(2)
    adoptIndustryResearchSkillVersion(db, {
      projectId: project.id, requestId, targetContentHash: v2.contentHash,
      migrationNote: '采用监控规则，但不自动改写既有假设。', expectedUpdatedAt: project.updated_at,
    }, v2)
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_skill_adoption_events').get()).toEqual({ count: 2 })
  })

  it('拒绝引用数据截至日之后公开的证据', () => {
    const project = createIndustryResearchProject(db, createInput(), () => v1)
    saveIndustryResearchEvidence(db, project.id, {
      id: 'future-evidence', title: '未来公告', sourceType: 'official', sourceName: '公告',
      sourceUrl: 'https://example.com/future', publishedDate: '2026-07-18', factDate: '2026-07-18',
      statementKind: 'estimate', direction: 'support', reliability: 'primary', createdBy: 'human',
      primarySourceConfirmed: true,
    })
    expect(() => appendIndustryResearchDecisionEvent(db, {
      projectId: project.id, requestId: randomUUID(), decisionId: randomUUID(), expectedLastEventId: null,
      eventType: 'created', action: 'monitor', rationale: '测试未来信息隔离', dataAsOf: '2026-07-17',
      validUntil: Date.now() + 86400000, invalidationCondition: '证据失效', workItemVersionIds: [],
      factIds: [], evidenceIds: ['future-evidence'], hypothesisIds: [],
    })).toThrowError(expect.objectContaining({ code: 'DECISION_REPLAY_INCOMPLETE' }))
  })

  it('停止工作项必须提供理由或下一触发指标', () => {
    const project = createIndustryResearchProject(db, createInput(), () => v1)
    expect(() => saveIndustryResearchWorkItem(db, {
      projectId: project.id, requestId: randomUUID(), workItemId: randomUUID(), expectedVersion: 0,
      question: '是否继续扩展研究', effort: 'quick_pass', conclusionSensitivity: 'low', evidenceUncertainty: 'low',
      changeVelocity: 'low', affectedObjectIds: [], status: 'stopped',
    })).toThrowError(IndustryResearchDecisionError)
  })

  it('拒绝跨项目复用写入请求ID返回其他项目事实', () => {
    const firstProject = createIndustryResearchProject(db, createInput(), () => v1)
    const secondProject = createIndustryResearchProject(db, {
      ...createInput(), title: '第二个产业研究', industryName: '算力基础设施',
    }, () => v1)
    const requestId = randomUUID()
    saveIndustryResearchWorkItem(db, {
      projectId: firstProject.id, requestId, workItemId: randomUUID(), expectedVersion: 0,
      question: '验证第一项目需求', effort: 'quick_pass', conclusionSensitivity: 'low',
      evidenceUncertainty: 'low', changeVelocity: 'low', affectedObjectIds: [], status: 'open',
    })

    expect(() => saveIndustryResearchWorkItem(db, {
      projectId: secondProject.id, requestId, workItemId: randomUUID(), expectedVersion: 0,
      question: '验证第二项目需求', effort: 'quick_pass', conclusionSensitivity: 'low',
      evidenceUncertainty: 'low', changeVelocity: 'low', affectedObjectIds: [], status: 'open',
    })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(db.prepare('SELECT COUNT(*) AS count FROM industry_research_work_item_versions').get()).toEqual({ count: 1 })
  })

  it('等待价格必须绑定同公司非阻断快照且当前缓存变化不改历史回放', () => {
    const project = createIndustryResearchProject(db, createInput(), () => v1)
    saveResearchCompany(db, { id: 'decision-company', legalName: '示例光通信股份有限公司', sourceType: 'manual' }, 1)
    saveResearchSecurity(db, {
      id: 'decision-security', companyId: 'decision-company', tsCode: '600001.SH', exchange: 'SSE',
      securityType: 'A_SHARE', mappingSource: 'manual',
    }, 2)
    saveResearchProjectCompany(db, { projectId: project.id, companyId: 'decision-company', status: 'core' }, 3)
    upsertDailyClose(db, [
      { tsCode: '600001.SH', tradeDate: '20260717', open: 10, high: 10, low: 10, close: 10, pctChg: 0, vol: 1, turnoverRate: null },
      { tsCode: '000001.SH', tradeDate: '20260717', open: 100, high: 100, low: 100, close: 100, pctChg: 0, vol: 1, turnoverRate: null },
    ])
    upsertSecurityAdjustmentFactors(db, [
      { ts_code: '600001.SH', trade_date: '20260717', adj_factor: 1, source: 'seed', fetched_at: 1 },
    ])
    upsertSecurityValuationDaily(db, [{
      ts_code: '600001.SH', trade_date: '20260717', total_share: 10000, float_share: 8000,
      total_mv: 100000, circ_mv: 80000, pe_ttm: 10, pb: 1, ps_ttm: 2, dv_ttm: 1,
      source: 'seed', fetched_at: 1,
    }])
    saveIndustryResearchHypothesis(db, project.id, {
      id: 'price-hypothesis', statement: '价格回撤后风险收益改善', importance: 5,
      cheapestDisproof: '合理价值区间下修至现价以下',
    })
    const valuationInputs = {
      netProfit: { value: 10000, unit: 'ten_thousand_yuan', sourceKind: 'assumption' as const, note: '用户透明假设' },
      totalShares: { value: 10000, unit: 'ten_thousand_shares', sourceKind: 'assumption' as const, note: '用户透明假设' },
      multiple: { value: 20, unit: 'multiple', sourceKind: 'assumption' as const, note: '用户透明假设' },
    }
    const scenario = saveIndustryResearchScenarioSet(db, {
      projectId: project.id, companyId: 'decision-company', requestId: randomUUID(), scenarioSetId: randomUUID(),
      expectedVersion: 0, dataAsOf: '2026-07-17', valuationDate: '2026-07-17',
      valuationMethod: 'pe', methodologyVersion: 'valuation-formulas-v1',
      scenarios: (['bear', 'base', 'bull'] as const).map((name) => ({
        name, weightPct: null, assumptions: {}, valuationInputs, factIds: [],
      })),
    })
    const market = buildIndustryResearchMarketContext(db, {
      projectId: project.id, companyId: 'decision-company', securityId: 'decision-security',
      valuationDate: '2026-07-17',
    })
    const snapshots = captureIndustryResearchValuationSnapshot(db, {
      projectId: project.id, companyId: 'decision-company', securityId: 'decision-security',
      requestId: randomUUID(), scenarioSetVersionId: scenario.versionId,
      valuationDate: '2026-07-17', marketFingerprint: market.factFingerprint,
    })

    expect(() => appendIndustryResearchDecisionEvent(db, {
      projectId: project.id, companyId: 'decision-company', requestId: randomUUID(),
      decisionId: randomUUID(), expectedLastEventId: null, eventType: 'created', action: 'wait_price',
      rationale: '等待更好的价格条件。', dataAsOf: '2026-07-17', valuationDate: '2026-07-17',
      validUntil: Date.now() + 86400000, invalidationCondition: '估值假设失效', scenarioSetVersionId: scenario.versionId,
      workItemVersionIds: [], factIds: [], evidenceIds: [], hypothesisIds: ['price-hypothesis'],
    })).toThrowError(expect.objectContaining({ code: 'MARKET_DATA_BLOCKED' }))

    const decisionId = randomUUID()
    const event = appendIndustryResearchDecisionEvent(db, {
      projectId: project.id, companyId: 'decision-company', requestId: randomUUID(), decisionId,
      expectedLastEventId: null, eventType: 'created', action: 'wait_price',
      rationale: '当前价格高于悲观情景，等待回撤。', dataAsOf: '2026-07-17', valuationDate: '2026-07-17',
      validUntil: Date.now() + 86400000, invalidationCondition: '盈利假设或估值区间失效',
      scenarioSetVersionId: scenario.versionId, workItemVersionIds: [], factIds: [], evidenceIds: [],
      hypothesisIds: ['price-hypothesis'], marketSnapshotId: snapshots.marketSnapshotId,
      valuationSnapshotId: snapshots.valuationSnapshotId,
    })
    expect(event).toEqual(expect.objectContaining({
      action: 'wait_price', marketSnapshotId: snapshots.marketSnapshotId,
      valuationSnapshotId: snapshots.valuationSnapshotId,
    }))

    upsertDailyClose(db, [
      { tsCode: '600001.SH', tradeDate: '20260717', open: 20, high: 20, low: 20, close: 20, pctChg: 100, vol: 1, turnoverRate: null },
    ])
    const replay = getIndustryResearchDecisionReplay(db, project.id, decisionId)
    expect(replay.marketContext).toEqual(expect.objectContaining({
      status: 'degraded', price: 10, marketSnapshotId: snapshots.marketSnapshotId,
      valuationSnapshotId: snapshots.valuationSnapshotId,
    }))
    expect((replay.marketContext.valuation as { currentPrice: number }).currentPrice).toBe(10)
  })
})
