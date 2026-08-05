import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/store/appStore'

const originalLoadBriefings = useAppStore.getState().loadBriefings
const originalMarkRead = useAppStore.getState().markRead

describe('FR-260 资讯提醒定向导航', () => {
  const loadBriefings = vi.fn(async () => undefined)
  const markRead = vi.fn(async () => undefined)

  beforeEach(() => {
    loadBriefings.mockClear()
    markRead.mockClear()
    useAppStore.setState({
      activeTab: 'decision-center',
      selectedBriefingId: 7,
      briefingDeepLinkId: null,
      selectedDate: '2026-08-01',
      selectedRating: 'GENERAL',
      selectedSourceId: 3,
      publicationTimeScope: 'uncertain',
      searchQuery: '旧筛选',
      loadBriefings,
      markRead,
    })
  })

  afterEach(() => {
    useAppStore.setState({ loadBriefings: originalLoadBriefings, markRead: originalMarkRead })
  })

  it('进入资讯台、清除排除性筛选并稳定选择对应文章', () => {
    useAppStore.getState().navigateToBriefing(42)

    expect(useAppStore.getState()).toMatchObject({
      activeTab: 'feed',
      selectedBriefingId: 42,
      briefingDeepLinkId: 42,
      selectedDate: null,
      selectedRating: null,
      selectedSourceId: null,
      publicationTimeScope: 'all',
      searchQuery: '',
    })
    expect(loadBriefings).toHaveBeenCalledTimes(1)
    expect(markRead).toHaveBeenCalledWith(42)
  })

  it('拒绝无效文章ID，用户改筛选时清空旧文章选择与深链锁', () => {
    useAppStore.getState().navigateToBriefing(0)
    expect(useAppStore.getState()).toMatchObject({
      activeTab: 'decision-center',
      selectedBriefingId: 7,
      briefingDeepLinkId: null,
    })
    expect(markRead).not.toHaveBeenCalled()

    useAppStore.setState({ selectedBriefingId: 42, briefingDeepLinkId: 42 })
    useAppStore.getState().setFilter({ selectedRating: 'IMPORTANT' })
    expect(useAppStore.getState()).toMatchObject({
      selectedBriefingId: null,
      briefingDeepLinkId: null,
      selectedRating: 'IMPORTANT',
    })
  })
})
