import { describe, expect, it } from 'vitest'
import {
  PRIORITY_NEWS_PREVIEW_INTERVAL_MS,
  selectPriorityNewsPreviewSignals,
} from '../../src/components/DecisionSignalToast/useDecisionSignalToastPreview'
import type { DecisionSignalToastSignal } from '../../src/components/DecisionSignalToast/decisionSignalToastModel'

function signal(overrides: Partial<DecisionSignalToastSignal> = {}): DecisionSignalToastSignal {
  return {
    id: 1,
    sourceModule: 'news',
    priority: 4,
    title: '本地重大资讯',
    summary: '已有摘要',
    sourceRefJson: JSON.stringify({ briefingId: 42, sourceName: '证券时报' }),
    signalTime: 100,
    ...overrides,
  }
}

describe('FR-260 开发环境主动提醒验收模型', () => {
  it('固定每60秒轮播且只选择带本地原文的P4/P5资讯', () => {
    expect(PRIORITY_NEWS_PREVIEW_INTERVAL_MS).toBe(60_000)

    const selected = selectPriorityNewsPreviewSignals([
      signal({ id: 1, priority: 4, signalTime: 200 }),
      signal({
        id: 2,
        priority: 5,
        signalTime: 100,
        sourceRefJson: JSON.stringify({ briefingId: 43, sourceName: '证券时报' }),
      }),
      signal({ id: 3, priority: 3 }),
      signal({ id: 4, sourceModule: 'trend', priority: 5 }),
      signal({ id: 5, sourceRefJson: null }),
    ])

    expect(selected.map((item) => item.id)).toEqual([2, 1])
  })

  it('按资讯原文去重并保留同一篇资讯的最新信号', () => {
    const selected = selectPriorityNewsPreviewSignals([
      signal({ id: 8, title: '旧标题', signalTime: 100 }),
      signal({ id: 9, title: '新标题', signalTime: 200 }),
    ])

    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ id: 9, title: '新标题' })
  })
})
