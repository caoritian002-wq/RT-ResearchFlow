import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../src/store/appStore'

describe('研究讨论跨页导航', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeTab: 'decision-center', aiAnalysisSubTab: 'records',
      pendingResearchDiscussionSessionId: null, pendingResearchDiscussionReturnTarget: null,
      researchDiscussionDrafts: {},
      pendingIndustryResearchProjectId: null,
      decisionCenterFilters: { status: 'active', type: 'all', source: 'news', portfolioOnly: true, minPriority: 4, viewMode: 'portfolio' },
    })
  })

  it('打开讨论时复用AI分析记录页并保存会话定位', () => {
    useAppStore.getState().navigateToResearchDiscussion(42, '先验证价格上涨是否来自有效供给偏紧')
    expect(useAppStore.getState()).toMatchObject({ activeTab: 'ai-analysis', aiAnalysisSubTab: 'records', pendingResearchDiscussionSessionId: 42 })
    expect(useAppStore.getState().researchDiscussionDrafts[42]).toBe('先验证价格上涨是否来自有效供给偏紧')
  })

  it('跨页返回不丢失未发送草稿，发送成功后可显式清理', () => {
    useAppStore.getState().setResearchDiscussionDraft(42, '尚未发送的反证问题')
    useAppStore.getState().returnFromResearchDiscussion({ tab: 'decision-center', entityId: '17', stateKey: 'signal-detail', scrollTop: 128 })
    expect(useAppStore.getState().researchDiscussionDrafts[42]).toBe('尚未发送的反证问题')
    useAppStore.getState().clearResearchDiscussionDraft(42)
    expect(useAppStore.getState().researchDiscussionDrafts[42]).toBeUndefined()
  })

  it('返回信号详情时保留决策中心筛选并记录来源对象', () => {
    useAppStore.getState().navigateToResearchDiscussion(42)
    useAppStore.getState().returnFromResearchDiscussion({ tab: 'decision-center', entityId: '17', stateKey: 'signal-detail', scrollTop: 128 })
    const state = useAppStore.getState()
    expect(state.activeTab).toBe('decision-center')
    expect(state.pendingResearchDiscussionSessionId).toBeNull()
    expect(state.pendingResearchDiscussionReturnTarget).toEqual({ tab: 'decision-center', entityId: '17', stateKey: 'signal-detail', scrollTop: 128 })
    expect(state.decisionCenterFilters).toMatchObject({ source: 'news', portfolioOnly: true, minPriority: 4, viewMode: 'portfolio' })
  })

  it('返回产业研究时恢复项目与局部视图定位', () => {
    useAppStore.getState().returnFromResearchDiscussion({ tab: 'ai-analysis', subTab: 'industryResearch', entityId: 'project-1', stateKey: 'industry-research:changes' })
    expect(useAppStore.getState()).toMatchObject({
      activeTab: 'ai-analysis', aiAnalysisSubTab: 'industryResearch', pendingIndustryResearchProjectId: 'project-1',
      pendingResearchDiscussionReturnTarget: { tab: 'ai-analysis', subTab: 'industryResearch', entityId: 'project-1', stateKey: 'industry-research:changes' },
    })
  })

  it('直接深度研究创建的讨论可以返回全局运行工作台', () => {
    useAppStore.getState().returnFromResearchDiscussion({ tab: 'ai-analysis', subTab: 'deepResearch', stateKey: 'deep-research' })
    expect(useAppStore.getState()).toMatchObject({
      activeTab: 'ai-analysis',
      aiAnalysisSubTab: 'deepResearch',
      pendingResearchDiscussionSessionId: null,
      pendingResearchDiscussionReturnTarget: { tab: 'ai-analysis', subTab: 'deepResearch', stateKey: 'deep-research' },
    })
  })
})
