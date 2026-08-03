import { describe, expect, it } from 'vitest'
import { getStockFundamentalAnnouncementAttention } from '../../electron/main/services/stockFundamentalService'

describe('FR-253 announcement title attention model', () => {
  it('derives stable attention tags only from title and upstream categories', () => {
    expect(getStockFundamentalAnnouncementAttention(
      '贵州茅台重大事项公告',
      ['其他'],
    )).toEqual(['major'])
    expect(getStockFundamentalAnnouncementAttention(
      '关于调整年度利润分配方案每股分红金额的公告',
      ['分配方案调整'],
    )).toEqual(['dividend'])
    expect(getStockFundamentalAnnouncementAttention(
      '关于董事会秘书变更并收到监管处罚的公告',
      ['高管人员任职变动'],
    )).toEqual(['governance', 'risk'])
  })

  it('keeps routine titles unlabelled instead of inventing event impact', () => {
    expect(getStockFundamentalAnnouncementAttention(
      '2025年度股东会会议资料',
      ['股东大会资料'],
    )).toEqual([])
    expect(getStockFundamentalAnnouncementAttention(
      '北京市某律师事务所法律意见书',
      ['法律意见书'],
    )).toEqual([])
  })
})
