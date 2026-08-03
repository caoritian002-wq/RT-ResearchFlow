import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createGenerationRun,
  listEvidenceCandidates,
  upsertEvidenceCandidate,
} from '../../electron/main/database/industryResearchGenerationRepository'
import { createResearchProject } from '../../electron/main/database/industryResearchRepository'
import type { AIFallbackResult, callWithFallback } from '../../electron/main/services/aiFallbackService'
import { runOpenAINativeResearchSearch } from '../../electron/main/services/industryResearchNativeWebSearchService'

describe('产业研究 GPT 原生网页搜索适配', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    createResearchProject(db, {
      id: 'project-native',
      title: '光纤产业研究',
      industryName: '光通信',
      productScope: '光纤光缆',
      regionScope: '中国',
      timeScope: '2026-2028',
      purpose: 'investment',
      depth: 'deep',
      sourceType: 'manual',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    createGenerationRun(db, {
      id: 'run-old',
      projectId: 'project-native',
      researchQuestion: '旧研究',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
    upsertEvidenceCandidate(db, {
      id: 'excluded-source',
      projectId: 'project-native',
      runId: 'run-old',
      query: '旧检索',
      sourceUrl: 'https://excluded.example.com/article',
      title: '已排除材料',
      providerId: 'builtin_web',
      status: 'rejected',
      sourceKind: 'web_search',
      isDetailPage: true,
    })
    createGenerationRun(db, {
      id: 'run-native',
      projectId: 'project-native',
      researchQuestion: '光纤行业供需和价格传导如何？',
      skillId: 'builtin:industry-chain-research',
      skillContentHash: 'a'.repeat(64),
    })
  })

  it('把工具来源转换成候选证据并把历史排除 URL 传给 GPT', async () => {
    const memo = '运营商集采数据显示有效需求回升，仍需关注价格传导。'
    const fakeCall = vi.fn(async (_db: Database.Database, params: Parameters<typeof callWithFallback>[1]): Promise<AIFallbackResult> => ({
      provider: 'chatgpt',
      model: 'gpt-5.6-sol',
      text: memo,
      webSearchTrace: {
        responseId: 'resp-native',
        calls: [{
          id: 'search-1',
          status: 'completed',
          action: {
            type: 'search',
            queries: ['2026 光纤 集采 需求'],
            url: null,
            pattern: null,
            sources: ['https://excluded.example.com/article', 'https://official.example.cn/tender'],
          },
        }],
        citations: [{
          url: 'https://official.example.cn/tender',
          title: '运营商集采公告',
          startIndex: 0,
          endIndex: 18,
        }],
        sources: [
          { url: 'https://excluded.example.com/article', title: '已排除材料', cited: false },
          { url: 'https://official.example.cn/tender', title: '运营商集采公告', cited: true },
        ],
      },
    }))

    const result = await runOpenAINativeResearchSearch(db, {
      projectId: 'project-native',
      runId: 'run-native',
      researchQuestion: '光纤行业供需和价格传导如何？',
      industryName: '光通信',
      productScope: '光纤光缆',
      regionScope: '中国',
      currentDate: '2026-07-19',
      dataAsOf: '2024-12-31',
    }, fakeCall as typeof callWithFallback)

    expect(fakeCall).toHaveBeenCalledWith(db, expect.objectContaining({
      nativeWebSearchOnly: true,
      webSearch: expect.objectContaining({
        enabled: true,
        excludedUrls: ['https://excluded.example.com/article'],
      }),
    }))
    const request = fakeCall.mock.calls[0][1]
    expect(request.prompt).toContain('当前北京时间日期：2026-07-19')
    expect(request.prompt).toContain('本次研究数据截止日：2024-12-31')
    expect(result).toMatchObject({ mode: 'mixed', provider: 'chatgpt', model: 'gpt-5.6-sol', memo })
    expect(result.selectedTopNIds).toHaveLength(1)
    expect(listEvidenceCandidates(db, { projectId: 'project-native', runId: 'run-native' })[0]).toMatchObject({
      source_url: 'https://official.example.cn/tender',
      title: '运营商集采公告',
      provider_id: 'openai_native_web_search',
      status: 'fetched',
    })
  })

  it('没有工具轨迹或来源时稳定失败，不伪装为已联网', async () => {
    const fakeCall = vi.fn(async (): Promise<AIFallbackResult> => ({
      provider: 'chatgpt',
      model: 'gpt-5.6-sol',
      text: '只有模型文本，没有工具来源。',
    }))

    await expect(runOpenAINativeResearchSearch(db, {
      projectId: 'project-native',
      runId: 'run-native',
      researchQuestion: '继续研究',
      dataAsOf: '2026-07-19',
    }, fakeCall as typeof callWithFallback)).rejects.toMatchObject({ code: 'OPENAI_NATIVE_WEB_SEARCH_EMPTY' })
  })
})
