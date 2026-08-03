import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '../../src/store/appStore'

describe('firstPortfolioJourney', () => {
  beforeEach(() => {
    useAppStore.setState({
      activeTab: 'decision-center',
      firstPortfolioJourney: null,
      pendingStockCode: null,
      pendingDisplay: null,
      pendingStockContext: null,
      decisionCenterRefresh: null,
      decisionCenterFilters: {
        status: 'active',
        type: 'all',
        source: 'all',
        portfolioOnly: false,
        minPriority: 3,
        viewMode: 'market',
      },
    })
  })

  it('starts in stock selection and advances only through the explicit action', () => {
    useAppStore.getState().startFirstPortfolioJourney()
    expect(useAppStore.getState().activeTab).toBe('stock-chart')
    expect(useAppStore.getState().firstPortfolioJourney).toEqual({
      step: 'select-stock',
      stockCode: null,
      stockName: null,
    })

    useAppStore.getState().advanceFirstPortfolioJourney('600000.SH', '浦发银行')
    expect(useAppStore.getState().firstPortfolioJourney).toEqual({
      step: 'complete-holding',
      stockCode: '600000',
      stockName: '浦发银行',
    })
  })

  it('ignores advancement outside the journey', () => {
    useAppStore.getState().advanceFirstPortfolioJourney('600000.SH', '浦发银行')
    expect(useAppStore.getState().firstPortfolioJourney).toBeNull()
  })

  it('returns to portfolio mode, requests refresh, and clears navigation context', () => {
    useAppStore.getState().startFirstPortfolioJourney()
    useAppStore.setState({
      pendingStockCode: '600000',
      pendingDisplay: { code: '600000', name: '浦发银行' },
    })
    useAppStore.getState().finishFirstPortfolioJourney()

    const state = useAppStore.getState()
    expect(state.activeTab).toBe('decision-center')
    expect(state.decisionCenterFilters.viewMode).toBe('portfolio')
    expect(state.decisionCenterFilters.portfolioOnly).toBe(true)
    expect(state.decisionCenterRefresh?.reason).toBe('portfolio-updated')
    expect(state.firstPortfolioJourney).toBeNull()
    expect(state.pendingStockCode).toBeNull()
    expect(state.pendingDisplay).toBeNull()
  })
})