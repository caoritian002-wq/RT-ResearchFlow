import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createGenerationRun,
  getResearchWebSearchConfig,
  saveResearchWebSearchConfig,
  upsertEvidenceCandidate,
} from '../../electron/main/database/industryResearchGenerationRepository'
import {
  createResearchProject,
  saveResearchEvidence,
} from '../../electron/main/database/industryResearchRepository'
import {
  buildResearchRetrievalPlan,
  retrieveResearchEvidenceCandidates,
} from '../../electron/main/services/researchToolRuntime'
import { isLikelySearchResultPage } from '../../electron/main/services/researchToolRuntime/pageFetch'

describe('researchToolRuntime retrieval plan', () => {
  it('generates 8-15 auditable queries with required intents and site filters', () => {
    const plan = buildResearchRetrievalPlan({
      researchQuestion: '光纤预制棒产业链供需与龙头公司业务暴露如何验证？',
      industryName: '光纤',
      productScope: '预制棒',
      regionScope: '中国',
    })
    expect(plan.queries.length).toBeGreaterThanOrEqual(8)
    expect(plan.queries.length).toBeLessThanOrEqual(15)
    const intents = new Set(plan.queries.map((item) => item.intent))
    expect(intents.has('policy')).toBe(true)
    expect(intents.has('supply_demand_price')).toBe(true)
    expect(intents.has('capacity_inventory')).toBe(true)
    expect(intents.has('company_exposure')).toBe(true)
    expect(intents.has('tech_substitution_or_shock')).toBe(true)
    const joined = plan.queries.map((item) => item.text).join('\n')
    expect(joined).toContain('site:cninfo.com.cn')
    expect(joined).toContain('site:stats.gov.cn')
    expect(joined).toContain('site:miit.gov.cn')
    expect(joined).toContain('site:gov.cn')
    for (const query of plan.queries) {
      expect(query.id).toBeTruthy()
      expect(query.rationale).toBeTruthy()
      expect(query.status).toBe('planned')
    }
  })

  it('rejects official search shells as detail pages', () => {
    expect(isLikelySearchResultPage('https://www.cninfo.com.cn/new/fulltextSearch?notautosubmit=&keyWord=光纤')).toBe(true)
    expect(isLikelySearchResultPage('https://www.stats.gov.cn/search/s?qt=光纤')).toBe(true)
    expect(isLikelySearchResultPage('https://www.cninfo.com.cn/new/disclosure/detail?stockCode=600000')).toBe(false)
  })

  it('成功运行后可以清除增强搜索的历史错误状态', () => {
    const db = new Database(':memory:')
    runMigrations(db)
    saveResearchWebSearchConfig(db, {
      providerId: 'tavily',
      enabled: true,
      apiKeyEncrypted: Buffer.from('encrypted-placeholder'),
      lastErrorCode: 'WEB_SEARCH_PROVIDER_FAILED',
    })

    saveResearchWebSearchConfig(db, {
      providerId: 'tavily',
      enabled: true,
      lastErrorCode: null,
    })

    expect(getResearchWebSearchConfig(db)?.last_error_code).toBeNull()
    db.close()
  })

  it('受控检索回退不会重新采用项目中已排除的 URL', async () => {
    const db = new Database(':memory:')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-exclusion',
      title: '来源排除测试',
      industryName: '光通信',
      productScope: '光纤',
      regionScope: '中国',
      timeScope: '近三年',
      purpose: 'investment',
      depth: 'standard',
      sourceType: 'manual',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    createGenerationRun(db, {
      id: 'run-excluded-old', projectId: 'project-exclusion', researchQuestion: '旧研究',
      skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })
    upsertEvidenceCandidate(db, {
      id: 'candidate-excluded', projectId: 'project-exclusion', runId: 'run-excluded-old', query: '旧检索',
      sourceUrl: 'https://example.com/excluded', title: '已排除来源', providerId: 'builtin_web',
      status: 'rejected', sourceKind: 'web_search', isDetailPage: true,
    })
    saveResearchEvidence(db, 'project-exclusion', {
      id: 'formal-source-same-url',
      title: '同 URL 的本地材料',
      sourceType: 'web',
      sourceName: '测试来源',
      sourceUrl: 'https://example.com/excluded',
      statementKind: 'estimate',
      direction: 'support',
      reliability: 'secondary',
      createdBy: 'human',
      excerpt: '这是一段长度足够的本地研究材料，用于证明受控检索降级后也必须遵守项目级来源排除约束。',
    })
    createGenerationRun(db, {
      id: 'run-excluded-new', projectId: 'project-exclusion', researchQuestion: '继续研究',
      skillId: 'builtin:industry-chain-research', skillContentHash: 'a'.repeat(64),
    })

    const result = await retrieveResearchEvidenceCandidates(db, {
      projectId: 'project-exclusion',
      runId: 'run-excluded-new',
      researchQuestion: '继续研究光纤供需',
      enableWebRetrieval: false,
    })

    expect(result.candidates).toEqual([])
    expect(result.selectedTopNIds).toEqual([])
  })
})
