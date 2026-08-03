import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AssistantWebSearchTrace } from '../../src/components/AIAnalysis/AssistantWebSearchTrace'
import { ResearchGenerationStatus } from '../../src/components/IndustryResearch/ResearchGenerationStatus'
import { ReportView, ReviewQueueView } from '../../src/components/IndustryResearch/ResearchWorkspace'

const trace = {
  responseId: 'resp-ui',
  calls: [{
    id: 'call-ui',
    status: 'completed',
    action: {
      type: 'search' as const,
      queries: ['2026 光纤供需'],
      url: null,
      pattern: null,
      sources: ['https://example.com/report'],
    },
  }],
  citations: [{ url: 'https://example.com/report', title: '供需报告', startIndex: 0, endIndex: 4 }],
  sources: [{ url: 'https://example.com/report', title: '供需报告', cited: true }],
}

describe('产业研究网页搜索审计视图', () => {
  it('把项目级搜索轨迹放在辅助审计区，并明确无需人工放行', () => {
    const output = renderToStaticMarkup(createElement(ReviewQueueView, {
      evidenceCandidates: [],
      companyCandidates: [],
      selectedTopNIds: [],
      nativeWebSearch: {
        status: 'succeeded' as const,
        provider: 'chatgpt',
        model: 'gpt-5.6-sol',
        ...trace,
      },
      onGoCompanies: vi.fn(),
    }))

    expect(output).toContain('industry-research-native-web-search')
    expect(output).toContain('系统已经完成检索、分析和结论生成')
    expect(output).toContain('GPT 原生网页搜索已完成')
    expect(output).toContain('本次结论来源')
    expect(output).toContain('2026 光纤供需')
  })

  it('把每轮讨论引用默认折叠在 assistant 回复下方', () => {
    const output = renderToStaticMarkup(createElement(AssistantWebSearchTrace, { trace }))

    expect(output).toContain('ai-discussion-web-search-trace')
    expect(output).toContain('本轮引用来源 1 条')
    expect(output).toContain('供需报告')
    expect(output).toContain('查看工具调用')
  })

  it('增强搜索已配置但凭据不可用时展示运行故障而不是重复要求配置', () => {
    const output = renderToStaticMarkup(createElement(ResearchGenerationStatus, {
      run: {
        id: 'run-search-key',
        projectId: 'project-search-key',
        researchQuestion: 'PCB 原材料涨价传导',
        status: 'failed' as const,
        currentStage: 'scope',
        lastSuccessfulStage: 'retrieve',
        progressCurrent: 2,
        progressTotal: 7,
        progressMessage: '增强搜索密钥暂不可用，已自动回退',
        cancelRequested: false,
        provider: null,
        model: null,
        errorCode: 'AI_CREDENTIALS_UNAVAILABLE',
        errorMessage: 'AI 模型已配置，但保存的凭据当前无法解密',
        retryable: true,
        retrievalMode: 'weak',
        retrievalPlan: {
          enhancedSearch: {
            providerId: 'tavily',
            configured: true,
            status: 'key_unavailable' as const,
            errorCode: 'WEB_SEARCH_KEY_UNAVAILABLE',
          },
        },
      },
    }))

    expect(output).toContain('Tavily 已配置')
    expect(output).toContain('无需重新填写密钥')
    expect(output).toContain('检查搜索连接')
    expect(output).not.toContain('配置 Tavily 或 Bing 后')
  })

  it('增强搜索成功但召回不足时只说明质量降级，不再展示配置入口', () => {
    const output = renderToStaticMarkup(createElement(ResearchGenerationStatus, {
      run: {
        id: 'run-search-weak',
        projectId: 'project-search-weak',
        researchQuestion: '稀缺产业资料',
        status: 'succeeded' as const,
        currentStage: 'report',
        lastSuccessfulStage: 'report',
        progressCurrent: 7,
        progressTotal: 7,
        progressMessage: '报告已生成',
        cancelRequested: false,
        provider: 'qwen',
        model: 'qwen-max-latest',
        errorCode: null,
        errorMessage: null,
        retryable: false,
        retrievalMode: 'weak',
        retrievalPlan: {
          enhancedSearch: {
            providerId: 'tavily',
            configured: true,
            status: 'succeeded' as const,
            errorCode: null,
          },
        },
      },
    }))

    expect(output).toContain('Tavily 本轮调用成功')
    expect(output).not.toContain('配置增强搜索')
    expect(output).not.toContain('检查搜索连接')
  })

  it('完整报告已生成但项目未写回时展示零 Token 恢复动作和临时标识', () => {
    const status = renderToStaticMarkup(createElement(ResearchGenerationStatus, {
      run: {
        id: 'run-persist-failed',
        projectId: 'project-persist-failed',
        researchQuestion: 'PCB 原材料涨价传导',
        status: 'failed' as const,
        currentStage: 'report',
        lastSuccessfulStage: 'companies',
        progressCurrent: 7,
        progressTotal: 7,
        progressMessage: '报告与图谱已经生成，但写入项目失败',
        cancelRequested: false,
        provider: 'chatgpt',
        model: 'gpt-5.6-sol',
        errorCode: 'GENERATION_PERSIST_FAILED',
        errorMessage: '报告与图谱已经生成，但写入项目失败',
        retryable: true,
        reportDocument: {
          title: 'PCB 产业研究报告',
          summary: '摘要',
          markdown: '# PCB 产业研究报告\n\n完整正文',
          missingSections: [],
          conflicts: [],
        },
      },
      onRetry: vi.fn(),
    }))
    const report = renderToStaticMarkup(createElement(ReportView, {
      report: null,
      generated: {
        title: 'PCB 产业研究报告',
        summary: '摘要',
        markdown: '# PCB 产业研究报告\n\n完整正文',
        missingSections: [],
        conflicts: [],
      },
      provisional: true,
    }))

    expect(status).toContain('待写回')
    expect(status).toContain('写回项目')
    expect(status).toContain('不会重新搜索或调用模型')
    expect(report).toContain('industry-research-provisional-report')
    expect(report).toContain('报告正文已生成，但尚未写入项目')
  })

  it('财务部分覆盖时在完成态提供继续收集并更新报告入口', () => {
    const output = renderToStaticMarkup(createElement(ResearchGenerationStatus, {
      run: {
        id: 'run-financial-partial',
        projectId: 'project-financial-partial',
        researchQuestion: 'PCB 公司财务验证',
        status: 'succeeded' as const,
        currentStage: 'report',
        lastSuccessfulStage: 'report',
        progressCurrent: 7,
        progressTotal: 7,
        progressMessage: '报告已生成',
        cancelRequested: false,
        provider: 'chatgpt',
        model: 'gpt-5.6-sol',
        errorCode: null,
        errorMessage: null,
        retryable: false,
        financialCollection: {
          status: 'partial' as const,
          source: 'tushare' as const,
          totalCompanies: 2,
          completedCompanies: 1,
          totalDatasets: 18,
          coveredDatasets: 16,
          failedDatasets: 2,
          pendingDatasets: 2,
          attemptedDatasets: 18,
          skippedDatasets: 0,
          currentCompanyId: null,
          currentCompanyName: null,
          currentTsCode: null,
          currentDataset: null,
          errorCode: 'FINANCIAL_COLLECTION_INCOMPLETE',
          message: '财务采集部分完成',
          startedAt: 1,
          updatedAt: 2,
          completedAt: 2,
          companies: [],
        },
      },
      onContinueFinancials: vi.fn(),
    }))

    expect(output).toContain('财务 16/18')
    expect(output).toContain('继续收集并更新报告')
  })

  it('财务采集运行时同时展示研究阶段和公司数据项真实进度', () => {
    const output = renderToStaticMarkup(createElement(ResearchGenerationStatus, {
      run: {
        id: 'run-financial-running',
        projectId: 'project-financial-running',
        researchQuestion: 'PCB 公司财务验证',
        status: 'running' as const,
        currentStage: 'companies',
        lastSuccessfulStage: 'companies',
        progressCurrent: 6,
        progressTotal: 7,
        progressMessage: '正在采集沪电股份的利润表',
        cancelRequested: false,
        provider: 'chatgpt',
        model: 'gpt-5.6-sol',
        errorCode: null,
        errorMessage: null,
        retryable: false,
        financialCollection: {
          status: 'running' as const,
          source: 'tushare' as const,
          totalCompanies: 11,
          completedCompanies: 1,
          totalDatasets: 99,
          coveredDatasets: 18,
          failedDatasets: 0,
          pendingDatasets: 81,
          attemptedDatasets: 19,
          skippedDatasets: 0,
          processedDatasets: 18,
          currentCompanyId: 'company-hudian',
          currentCompanyName: '沪电股份',
          currentTsCode: '002463.SZ',
          currentCompanyIndex: 3,
          currentDataset: 'income',
          currentDatasetIndex: 1,
          errorCode: null,
          message: '正在采集沪电股份的利润表',
          startedAt: 1,
          updatedAt: 2,
          completedAt: null,
          companies: [],
        },
      },
    }))

    expect(output).toContain('industry-research-stage-progress')
    expect(output).toContain('industry-research-financial-progress')
    expect(output).toContain('阶段 6/7')
    expect(output).toContain('公司业务与财务采集')
    expect(output).toContain('公司 3/11')
    expect(output).toContain('沪电股份')
    expect(output).toContain('利润表')
    expect(output).toContain('已处理 18/99')
  })

  it('最终报告阶段明确标记尚未完成并用已完成阶段解释86%口径', () => {
    const output = renderToStaticMarkup(createElement(ResearchGenerationStatus, {
      run: {
        id: 'run-report-waiting',
        projectId: 'project-report-waiting',
        researchQuestion: 'PCB 公司财务验证',
        status: 'running' as const,
        currentStage: 'report',
        lastSuccessfulStage: 'companies',
        progressCurrent: 7,
        progressTotal: 7,
        progressMessage: '正在生成完整 Markdown 研究报告',
        cancelRequested: false,
        provider: 'chatgpt',
        model: 'gpt-5.6-sol',
        errorCode: null,
        errorMessage: null,
        retryable: false,
        startedAt: Date.now() - 180_000,
        updatedAt: Date.now() - 130_000,
      },
      onCancel: vi.fn(),
    }))

    expect(output).toContain('industry-research-report-waiting')
    expect(output).toContain('研究报告生成中（尚未完成）')
    expect(output).toContain('报告生成中，尚未完成')
    expect(output).toContain('已完成 6/7 个阶段')
    expect(output).toContain('模型返回时间较长')
    expect(output).toContain('已等待 2分10秒')
    expect(output).toContain('aria-valuetext="已完成 6/7 个阶段，研究报告生成中，尚未完成"')
    expect(output).not.toContain('>86%<')
  })
})
