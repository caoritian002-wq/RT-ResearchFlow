import { describe, expect, it } from 'vitest'
import {
  buildMorningAuctionThemeAttributions,
  splitMorningAuctionThemeNames,
  type MorningAuctionThemeStockInput,
} from '../../electron/main/services/morningAuctionThemeAttributionModel'

function stock(
  tsCode: string,
  stockName: string,
  conceptNames: string[],
  pctChg: number,
  auctionAmount: number,
): MorningAuctionThemeStockInput {
  return { tsCode, stockName, conceptNames, pctChg, auctionAmount }
}

describe('morningAuctionThemeAttributionModel', () => {
  it('拆分并去重直接题材文本', () => {
    expect(splitMorningAuctionThemeNames('算力+液冷服务器, 算力；融资融券')).toEqual([
      '算力',
      '液冷服务器',
      '融资融券',
    ])
  })

  it('直接原因优先成为主驱动并保留竞价共振证据', () => {
    const result = buildMorningAuctionThemeAttributions([
      stock('600001.SH', '主股', ['融资融券', '算力'], 6, 2600),
      stock('600002.SH', '共振甲', ['算力'], 4.5, 1800),
      stock('600003.SH', '共振乙', ['算力', '液冷服务器'], 3.2, 900),
    ], new Map([['600001.SH', {
      tradeDate: '20260723',
      themes: ['算力'],
      reason: '算力基础设施订单预期增强',
    }]]))

    const attribution = result.get('600001.SH')
    expect(attribution).toMatchObject({
      state: 'direct',
      confidence: 'high',
      sourceTradeDate: '20260723',
      directReason: '算力基础设施订单预期增强',
    })
    expect(attribution?.primary).toMatchObject({
      name: '算力',
      direct: true,
      activePeerCount: 2,
    })
    expect(attribution?.primary?.peers.map(peer => peer.stockName)).toEqual(['共振甲', '共振乙'])
    expect(attribution?.staticThemes).toContain('融资融券')
  })

  it('没有直接原因时以多股竞价共振生成线索而不冒充直接事实', () => {
    const result = buildMorningAuctionThemeAttributions([
      stock('000001.SZ', '候选甲', ['智能电网', '融资融券'], 5.1, 1600),
      stock('000002.SZ', '候选乙', ['智能电网'], 4.2, 1200),
      stock('000003.SZ', '候选丙', ['智能电网'], 3.4, 800),
    ], new Map())

    const attribution = result.get('000001.SZ')
    expect(attribution?.state).toBe('resonance')
    expect(attribution?.primary?.name).toBe('智能电网')
    expect(attribution?.primary?.direct).toBe(false)
    expect(attribution?.summary).toContain('尚无直接原因记录')
  })

  it('单只股票的静态属性题材保持主线待确认', () => {
    const result = buildMorningAuctionThemeAttributions([
      stock('300001.SZ', '孤立候选', ['融资融券', '深股通'], 5, 1500),
    ], new Map())

    expect(result.get('300001.SZ')).toMatchObject({
      state: 'unresolved',
      confidence: 'none',
      primary: null,
    })
  })

  it('多个候选共享基础属性也不能晋升为早盘主驱动', () => {
    const result = buildMorningAuctionThemeAttributions([
      stock('300001.SZ', '属性候选甲', ['融资融券', '深股通'], 5, 1500),
      stock('300002.SZ', '属性候选乙', ['融资融券', '深股通'], 4, 1200),
      stock('300003.SZ', '属性候选丙', ['融资融券'], 3, 900),
    ], new Map())

    const attribution = result.get('300001.SZ')
    expect(attribution).toMatchObject({ state: 'unresolved', confidence: 'none', primary: null })
    expect(attribution?.resonance).toEqual([])
    expect(attribution?.staticThemes).toEqual(['融资融券', '深股通'])
  })

  it('题材字段为空时保留直接原因但不从原因文本猜主题材', () => {
    const result = buildMorningAuctionThemeAttributions([
      stock('600001.SH', '原因待映射', [], 5, 1500),
    ], new Map([['600001.SH', {
      tradeDate: '20260723',
      themes: [],
      reason: '公司公告签订重要算力设备订单',
    }]]))

    expect(result.get('600001.SH')).toMatchObject({
      state: 'unresolved',
      confidence: 'none',
      primary: null,
      directReason: '公司公告签订重要算力设备订单',
      sourceTradeDate: '20260723',
    })
  })
})
