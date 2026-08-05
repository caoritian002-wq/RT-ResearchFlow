import { describe, expect, it } from 'vitest'
import { BUILT_IN_SOURCES } from '../../electron/main/database/seeds'

describe('内置监控源默认配置', () => {
  it('为已复核来源提供开箱即用的正文选择器', () => {
    const detailSelectors = Object.fromEntries(
      BUILT_IN_SOURCES.map((source) => [source.seedKey, source.detailSelector])
    )

    expect(detailSelectors).toMatchObject({
      ndrc: '.article_l',
      nbs: '#detail',
      'xinhua-finance': '#detail',
      'people-finance': '.col.col-1.fl',
      stcn: '.detail-content|.detail-content-wrapper|.video-content-left',
      caixin: '#the_content',
    })
  })
})
