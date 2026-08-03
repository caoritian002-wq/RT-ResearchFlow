import { describe, it, expect } from 'vitest'
import { rateImpact } from '../../electron/main/services/impactRater'

describe('rateImpact', () => {
  it('rates CRITICAL for high-weight keywords', () => {
    const result = rateImpact('央行宣布降息25个基点', '中国人民银行宣布降低基准利率', 10)
    expect(result.rating).toBe('CRITICAL')
    expect(result.score).toBeGreaterThanOrEqual(30)
  })

  it('rates CRITICAL for 系统性风险', () => {
    const result = rateImpact('监管部门警告系统性风险上升', '金融体系面临系统性风险', 8)
    expect(result.rating).toBe('CRITICAL')
  })

  it('rates at least IMPORTANT for regulatory actions', () => {
    const result = rateImpact('证监会对某券商采取监管措施', '行政处罚决定书', 8)
    expect(['IMPORTANT', 'CRITICAL']).toContain(result.rating)
    expect(result.score).toBeGreaterThanOrEqual(15)
  })

  it('rates GENERAL for routine announcements', () => {
    const result = rateImpact('统计局发布例行数据公布', '月度统计数据已发布', 5)
    expect(result.rating).toBe('GENERAL')
  })

  it('authority weight increases score', () => {
    const lowAuth = rateImpact('行业动态报告', '市场分析', 3)
    const highAuth = rateImpact('行业动态报告', '市场分析', 10)
    expect(highAuth.score).toBeGreaterThan(lowAuth.score)
  })

  it('caps score at 100', () => {
    const result = rateImpact(
      '系统性风险降息加息降准量化宽松金融危机股市熔断',
      '紧急通知全面暂停立即执行重大违规强制退市',
      10
    )
    expect(result.score).toBeLessThanOrEqual(100)
  })
})
