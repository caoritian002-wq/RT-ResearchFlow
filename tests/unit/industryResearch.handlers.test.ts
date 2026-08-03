import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  confirmEvidence: vi.fn(),
  discoverSkills: vi.fn(),
  getAIConfig: vi.fn(),
  getDataSourceConfig: vi.fn(),
  getDb: vi.fn(),
  getLatestProfitBridge: vi.fn(),
  handle: vi.fn(),
  listDisclosureEvidence: vi.fn(),
  listProfitBridgeItems: vi.fn(),
  loadVerifiedSkillBundle: vi.fn(),
  prepare: vi.fn(),
  saveEvidence: vi.fn(),
  saveDisclosureEvidence: vi.fn(),
  saveGraph: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\test-project\\rt-research-flow' },
  ipcMain: { handle: mocks.handle },
}))
vi.mock('../../electron/main/database/db', () => ({ getDb: mocks.getDb }))
vi.mock('../../electron/main/database/aiConfigRepository', () => ({ getAIConfig: mocks.getAIConfig }))
vi.mock('../../electron/main/database/dataSourceRepository', () => ({ getDataSourceConfig: mocks.getDataSourceConfig }))
vi.mock('../../electron/main/database/industryResearchFinancialRepository', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../electron/main/database/industryResearchFinancialRepository')>()
  return {
    ...original,
    getLatestResearchProfitBridge: mocks.getLatestProfitBridge,
    listResearchDisclosureEvidence: mocks.listDisclosureEvidence,
    listResearchProfitBridgeItems: mocks.listProfitBridgeItems,
    saveResearchDisclosureEvidence: mocks.saveDisclosureEvidence,
  }
})
vi.mock('../../electron/main/database/industryResearchRepository', () => ({
  getResearchProject: vi.fn(), listResearchEvidence: vi.fn(), listResearchHypotheses: vi.fn(),
  listResearchProjects: vi.fn(), updateResearchProject: vi.fn(),
}))
vi.mock('../../electron/main/services/skillService', () => ({
  discoverSkills: mocks.discoverSkills,
  loadVerifiedSkillBundle: mocks.loadVerifiedSkillBundle,
}))
vi.mock('../../electron/main/services/industryResearchService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../electron/main/services/industryResearchService')>()
  return {
    ...original,
    createIndustryResearchProject: mocks.createProject,
    getIndustryResearchGraph: vi.fn(), getIndustryResearchReport: vi.fn(),
    saveIndustryResearchEvidence: mocks.saveEvidence, saveIndustryResearchGraph: mocks.saveGraph,
    saveIndustryResearchHypothesis: vi.fn(), changeIndustryResearchHypothesisStatus: vi.fn(),
    updateIndustryResearchProject: vi.fn(),
  }
})
vi.mock('../../electron/main/services/industryResearchGenerationService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../electron/main/services/industryResearchGenerationService')>()
  return { ...original, confirmProjectEvidenceCandidate: mocks.confirmEvidence }
})

import { IndustryResearchError } from '../../electron/main/services/industryResearchService'
import { rankResearchProjectCompanies, registerIndustryResearchHandlers } from '../../electron/main/ipc/industryResearchHandlers'

type Handler = (event: unknown, payload?: Record<string, unknown>) => unknown

function handler(channel: string): Handler {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) throw new Error(`未注册 IPC: ${channel}`)
  return registration[1] as Handler
}

beforeAll(() => registerIndustryResearchHandlers())

beforeEach(() => {
  mocks.prepare.mockReturnValue({ get: vi.fn(() => ({ found: 1 })) })
  mocks.getDb.mockReturnValue({ name: 'test-db', prepare: mocks.prepare })
  mocks.getAIConfig.mockReturnValue({ customSkillPaths: '[]' })
  mocks.getDataSourceConfig.mockReturnValue({ tushareEnabled: false, tushareTokenEncrypted: null })
  mocks.discoverSkills.mockReturnValue([])
  mocks.loadVerifiedSkillBundle.mockImplementation((skill) => ({
    meta: skill,
    content: '# 产业研究规则',
    contentHash: skill.contentHash,
    contentBytes: 20,
    sourceDisplayName: 'industry-chain-research',
  }))
  mocks.createProject.mockReset()
  mocks.confirmEvidence.mockReset()
  mocks.getLatestProfitBridge.mockReset()
  mocks.listDisclosureEvidence.mockReset()
  mocks.listProfitBridgeItems.mockReset()
  mocks.saveEvidence.mockReset()
  mocks.saveDisclosureEvidence.mockReset()
  mocks.saveGraph.mockReset()
})

describe('产业研究 IPC', () => {
  it('决策项目公司按趋势综合分降序排列并把未评分及已排除公司置后', () => {
    const companies = [
      { id: 'unknown', status: 'candidate' as const, trend_score: null },
      { id: 'low', status: 'watching' as const, trend_score: 35 },
      { id: 'excluded-high', status: 'excluded' as const, trend_score: 99 },
      { id: 'high', status: 'candidate' as const, trend_score: 82 },
      { id: 'tie', status: 'core' as const, trend_score: 35 },
    ]

    expect(rankResearchProjectCompanies(companies).map((company) => company.id))
      .toEqual(['high', 'low', 'tie', 'unknown', 'excluded-high'])
    expect(companies.map((company) => company.id))
      .toEqual(['unknown', 'low', 'excluded-high', 'high', 'tie'])
  })

  it('正式纳入候选时把项目归属交给服务校验', async () => {
    mocks.confirmEvidence.mockReturnValue({
      id: 'candidate-1', project_id: 'project-1', run_id: 'run-1', query: '光通信',
      source_url: 'https://example.com/source', title: '来源', summary: null, excerpt: null,
      provider_id: 'builtin_web', published_at: null, fetched_at: 1, status: 'confirmed',
      failure_reason: null, confirmed_at: 2, source_kind: 'web_search', is_detail_page: 1,
      relevance_score: 0.8, authority_score: 0.7, freshness_score: 0.6, rank_score: 0.75,
      created_at: 1, updated_at: 2,
    })

    const result = await handler('industryResearch:confirmEvidenceCandidate')({}, {
      projectId: 'project-1', candidateId: 'candidate-1', action: 'confirm',
    })

    expect(mocks.confirmEvidence).toHaveBeenCalledWith(expect.anything(), 'project-1', 'candidate-1', 'confirm')
    expect(result).toEqual({ ok: true, data: expect.objectContaining({ id: 'candidate-1', status: 'confirmed' }) })
  })

  it('注册T1381公司与财务九个通道', () => {
    expect([
      'industryResearch:listCompanies',
      'industryResearch:saveCompany',
      'industryResearch:listBusinessExposure',
      'industryResearch:saveBusinessExposure',
      'industryResearch:syncCompanyFinancials',
      'industryResearch:continueFinancialCollection',
      'industryResearch:getFinancialTimeline',
      'industryResearch:getFinancialValidation',
      'industryResearch:saveProfitBridge',
      'industryResearch:getFinancialSyncStatus',
    ].every((channel) => mocks.handle.mock.calls.some(([name]) => name === channel))).toBe(true)
  })

  it('注册第181B规则采用、决策、监控、触发与回放通道', () => {
    expect([
      'industryResearch:getSkillAdoption',
      'industryResearch:adoptSkillVersion',
      'industryResearch:listWorkItems',
      'industryResearch:saveWorkItem',
      'industryResearch:listScenarios',
      'industryResearch:saveScenarioSet',
      'industryResearch:listDecisions',
      'industryResearch:appendDecisionEvent',
      'industryResearch:listMonitoringItems',
      'industryResearch:saveMonitoringItem',
      'industryResearch:appendMonitoringObservation',
      'industryResearch:listDecisionTriggers',
      'industryResearch:saveDecisionTrigger',
      'industryResearch:evaluateDecisionTriggers',
      'industryResearch:resolveTriggerReview',
      'industryResearch:getReviewQueue',
      'industryResearch:resolveReviewItem',
      'industryResearch:getDecisionReplay',
    ].every((channel) => mocks.handle.mock.calls.some(([registered]) => registered === channel))).toBe(true)
  })

  it('注册T1390本地工作台、显式同步、估值预览和快照通道', () => {
    expect([
      'industryResearch:getDecisionWorkbench',
      'industryResearch:syncMarketData',
      'industryResearch:previewValuation',
      'industryResearch:captureValuationSnapshot',
    ].every((channel) => mocks.handle.mock.calls.some(([registered]) => registered === channel))).toBe(true)
  })

  it('市场同步在数据源禁用时不进入联网服务', async () => {
    const result = await handler('industryResearch:syncMarketData')({}, {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      requestId: crypto.randomUUID(), valuationDate: '2026-07-17',
    })

    expect(result).toEqual({ ok: false, code: 'TOKEN_REQUIRED', message: 'Tushare 行情数据源未启用' })
  })

  it('估值预览拒绝未知单位及伪装成事实但没有事实ID的输入', async () => {
    const base = {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      valuationDate: '2026-07-17', valuationMethod: 'pe', marketFingerprint: 'a'.repeat(64),
    }
    const invalidUnit = await handler('industryResearch:previewValuation')({}, {
      ...base,
      scenarios: [{
        name: 'base', weightPct: null, factIds: [],
        inputs: { totalShares: { value: 100, unit: 'lots', sourceKind: 'assumption', note: '人工假设' } },
      }],
    })
    expect(invalidUnit).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'scenario.inputs.totalShares.unit 格式无效' })

    const missingFactId = await handler('industryResearch:previewValuation')({}, {
      ...base,
      scenarios: [{
        name: 'base', weightPct: null, factIds: [],
        inputs: { netProfit: { value: 100, unit: 'yuan', sourceKind: 'fact' } },
      }],
    })
    expect(missingFactId).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'scenario.inputs.netProfit.factId 格式无效' })
  })

  it('快照接口在进入服务前拒绝非法请求ID和日期', async () => {
    const result = await handler('industryResearch:captureValuationSnapshot')({}, {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1',
      requestId: 'not-a-uuid', scenarioSetVersionId: 'scenario-v1', valuationDate: '2026/07/17',
      marketFingerprint: 'a'.repeat(64),
    })
    expect(result).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'requestId 格式无效' })
  })

  it('第181B写接口在进入服务前拒绝非UUID请求ID', async () => {
    const result = await handler('industryResearch:saveWorkItem')({}, {
      projectId: 'project-1', requestId: 'not-a-uuid', workItemId: crypto.randomUUID(), expectedVersion: 0,
      question: '验证需求', effort: 'quick_pass', conclusionSensitivity: 'low', evidenceUncertainty: 'low',
      changeVelocity: 'low', affectedObjectIds: [], status: 'open',
    })

    expect(result).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'requestId 格式无效' })
  })

  it('注册T1382公告证据和利润桥读取通道', () => {
    expect([
      'industryResearch:listDisclosureEvidence',
      'industryResearch:saveDisclosureEvidence',
      'industryResearch:getProfitBridge',
    ].every((channel) => mocks.handle.mock.calls.some(([name]) => name === channel))).toBe(true)
  })

  it('注册FR-239讨论增量、档案与研究版本通道', () => {
    expect([
      'industryResearch:prepareDiscussionChanges',
      'industryResearch:listChangeSets',
      'industryResearch:listChangeCandidates',
      'industryResearch:resolveChangeSets',
      'industryResearch:importCandidateArchive',
      'industryResearch:listSnapshots',
      'industryResearch:getSnapshot',
    ].every((channel) => mocks.handle.mock.calls.some(([name]) => name === channel))).toBe(true)
  })

  it('研究增量列表必须明确会话、项目或批次作用域', async () => {
    const result = await handler('industryResearch:listChangeSets')({}, {})
    expect(result).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'sessionId、projectId 或 batchId 至少提供一个' })
  })

  it('事实确认拒绝非HTTP原始来源且不进入合并事务', async () => {
    const result = await handler('industryResearch:resolveChangeSets')({}, {
      requestId: '00000000-0000-4000-8000-000000000040', batchId: 'batch-1', changeSetIds: ['set-1'],
      action: 'accept', target: { mode: 'existing', projectId: 'project-1' },
      factConfirmations: [{ candidateId: 'candidate-1', primarySourceConfirmed: true, confirmedBy: 'human', originalSourceUrl: 'file:///C:/announcement.pdf' }],
    })
    expect(result).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'factConfirmations.originalSourceUrl 格式无效' })
  })

  it('公告证据保存拒绝非HTTP地址且不写入仓库', async () => {
    const result = await handler('industryResearch:saveDisclosureEvidence')({}, {
      projectId: 'project-1', companyId: 'company-1',
      evidence: {
        id: 'evidence-1', title: '年度报告', sourceUrl: 'file:///C:/report.pdf',
        primarySourceConfirmed: true,
      },
    })

    expect(result).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'evidence.sourceUrl 格式无效' })
    expect(mocks.saveDisclosureEvidence).not.toHaveBeenCalled()
  })

  it('公告证据保存固定为人工来源并返回camelCase投影', async () => {
    mocks.saveDisclosureEvidence.mockReturnValue({
      id: 'evidence-1', company_id: 'company-1', project_id: 'project-1', title: '年度报告',
      source_url: 'https://example.com/report.pdf', published_date: '2024-03-01',
      actual_published_date: '2024-03-02', excerpt: '主营业务说明', created_by: 'human',
      primary_source_confirmed: 1, created_at: 100, updated_at: 100,
    })

    const result = await handler('industryResearch:saveDisclosureEvidence')({}, {
      projectId: 'project-1', companyId: 'company-1',
      evidence: {
        id: 'evidence-1', title: '年度报告', sourceUrl: 'https://example.com/report.pdf',
        publishedDate: '2024-03-01', actualPublishedDate: '2024-03-02', excerpt: '主营业务说明',
        primarySourceConfirmed: true, createdBy: 'import',
      },
    })

    expect(mocks.saveDisclosureEvidence).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      projectId: 'project-1', companyId: 'company-1', createdBy: 'human', primarySourceConfirmed: true,
    }))
    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        id: 'evidence-1', companyId: 'company-1', sourceUrl: 'https://example.com/report.pdf',
        primarySourceConfirmed: true,
      }),
    })
  })

  it('公司不属于项目时公告列表返回NOT_FOUND且不读取证据', async () => {
    mocks.prepare.mockReturnValueOnce({ get: vi.fn(() => undefined) })

    const result = await handler('industryResearch:listDisclosureEvidence')({}, {
      projectId: 'project-1', companyId: 'company-1',
    })

    expect(result).toEqual({ ok: false, code: 'NOT_FOUND', message: '项目公司不存在' })
    expect(mocks.listDisclosureEvidence).not.toHaveBeenCalled()
  })

  it('读取最新利润桥并组合有序明细和安全JSON字段', async () => {
    mocks.getLatestProfitBridge.mockReturnValue({
      id: 'bridge-v2', project_id: 'project-1', company_id: 'company-1', bridge_key: 'annual-profit',
      base_period: '20231231', target_period: '20241231', status: 'estimate', formula: '销量 + 价格',
      input_fact_ids_json: '["fact-1"]', evidence_ids_json: 'invalid-json', created_by: 'human', version: 2,
      previous_version_id: 'bridge-v1', created_at: 100, updated_at: 200,
    })
    mocks.listProfitBridgeItems.mockReturnValue([
      {
        id: 'item-1', profit_bridge_id: 'bridge-v2', item_key: 'volume', label: '销量', amount: 12,
        unit: '万元', methodology: '销量变化', sort_order: 0,
      },
    ])

    const result = await handler('industryResearch:getProfitBridge')({}, {
      projectId: 'project-1', companyId: 'company-1', bridgeKey: 'annual-profit',
    })

    expect(result).toEqual({
      ok: true,
      data: expect.objectContaining({
        id: 'bridge-v2', bridgeKey: 'annual-profit', projectId: 'project-1', companyId: 'company-1',
        previousVersionId: 'bridge-v1', inputFactIds: ['fact-1'], evidenceIds: [], version: 2,
        items: [{ key: 'volume', label: '销量', amount: 12, unit: '万元', methodology: '销量变化' }],
      }),
    })
  })

  it('显式财务同步在数据源禁用时返回稳定错误', async () => {
    const result = await handler('industryResearch:syncCompanyFinancials')({}, {
      projectId: 'project-1', companyId: 'company-1', securityId: 'security-1', tsCode: '600001.SH',
      datasets: ['income'],
    })

    expect(result).toEqual({ ok: false, code: 'FINANCIAL_SOURCE_DISABLED', message: 'Tushare 财务数据源未启用' })
  })

  it('非法参数返回稳定错误且不调用服务', async () => {
    const result = await handler('industryResearch:createProject')({}, { title: '' })

    expect(result).toEqual({ ok: false, code: 'INVALID_PARAM', message: 'title 格式无效' })
    expect(mocks.createProject).not.toHaveBeenCalled()
  })

  it('目标 Skill 缺失时返回稳定错误码', async () => {
    mocks.createProject.mockImplementation((_db, _input, resolveSkill) => {
      if (!resolveSkill()) throw new IndustryResearchError('SKILL_NOT_FOUND', '未找到产业研究 Skill')
    })

    const result = await handler('industryResearch:createProject')({}, {
      title: '光伏研究', industryName: '光伏', productScope: '组件', regionScope: '中国', timeScope: '2024-2026',
      purpose: 'investment', depth: 'standard', sourceType: 'manual',
    })

    expect(result).toEqual({ ok: false, code: 'SKILL_NOT_FOUND', message: '未找到产业研究 Skill' })
    expect(mocks.discoverSkills).toHaveBeenCalledWith('C:\\test-project\\rt-research-flow\\skills', [])
  })

  it('未配置自定义路径时使用项目内置产业研究 Skill 创建项目', async () => {
    const builtinSkill = {
      skillId: 'builtin:industry-chain-research', name: 'industry-chain-research', description: '产业研究规则',
      version: '', source: 'builtin', dirPath: 'C:\\test-project\\rt-research-flow\\skills\\industry-chain-research',
      contentLength: 20_000, contentHash: 'a'.repeat(64), ruleVersion: 'sha256:aaaaaaaaaaaa', integrity: 'complete',
    }
    mocks.discoverSkills.mockReturnValue([builtinSkill])
    mocks.createProject.mockImplementation((_db, _input, resolveSkill) => ({
      id: 'project-1', skill: resolveSkill(),
    }))

    const result = await handler('industryResearch:createProject')({}, {
      title: '光伏研究', industryName: '光伏', productScope: '组件', regionScope: '中国', timeScope: '2024-2026',
      purpose: 'investment', depth: 'standard', sourceType: 'manual',
    })

    expect(result).toEqual({
      ok: true,
      data: {
        id: 'project-1',
        skill: expect.objectContaining({ meta: builtinSkill, contentHash: builtinSkill.contentHash }),
      },
    })
    expect(mocks.discoverSkills).toHaveBeenCalledWith('C:\\test-project\\rt-research-flow\\skills', [])
  })

  it('事实来源门禁错误保持稳定语义', async () => {
    mocks.saveEvidence.mockImplementation(() => {
      throw new IndustryResearchError('FACT_REQUIRES_SOURCE', '事实必须绑定人工确认的原始来源')
    })

    const result = await handler('industryResearch:saveEvidence')({}, {
      projectId: 'project-1',
      evidence: {
        id: 'evidence-1', title: '产能数据', sourceType: 'ai', sourceName: '模型输出', statementKind: 'fact',
        direction: 'support', reliability: 'unknown', createdBy: 'ai', primarySourceConfirmed: false,
      },
    })

    expect(result).toEqual({ ok: false, code: 'FACT_REQUIRES_SOURCE', message: '事实必须绑定人工确认的原始来源' })
  })

  it('图谱版本冲突返回稳定错误码', async () => {
    mocks.saveGraph.mockImplementation(() => { throw new IndustryResearchError('VERSION_CONFLICT', '图谱已被其他操作更新') })

    const result = await handler('industryResearch:saveGraph')({}, {
      projectId: 'project-1', nodes: [], edges: [], expectedUpdatedAt: 1,
    })

    expect(result).toEqual({ ok: false, code: 'VERSION_CONFLICT', message: '图谱已被其他操作更新' })
  })

  it('未知内部错误不泄露 SQL、路径、堆栈或凭据', async () => {
    mocks.saveGraph.mockImplementation(() => {
      throw new Error('SQLITE_ERROR at C:\\secret\\trade.db token=abc123 SELECT * FROM secrets')
    })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await handler('industryResearch:saveGraph')({}, {
      projectId: 'project-1', nodes: [], edges: [], expectedUpdatedAt: 1,
    })

    expect(result).toEqual({ ok: false, code: 'DB_ERROR', message: '产业研究数据操作失败' })
    expect(JSON.stringify(result)).not.toMatch(/SQLITE|secret|token|SELECT/i)
    consoleSpy.mockRestore()
  })
})
