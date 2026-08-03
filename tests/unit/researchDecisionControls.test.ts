import { describe, expect, it } from 'vitest'
import { buildResearchCalendarDays, getBeijingDateValue } from '../../src/components/IndustryResearch/ResearchDecisionControls'

describe('ResearchDecisionControls', () => {
  it('日期面板始终生成稳定的六周网格', () => {
    const days = buildResearchCalendarDays(2026, 6)
    expect(days).toHaveLength(42)
    expect(days[0]).toEqual({ value: '2026-06-28', day: 28, currentMonth: false })
    expect(days.at(-1)).toEqual({ value: '2026-08-08', day: 8, currentMonth: false })
    expect(days.filter((day) => day.currentMonth)).toHaveLength(31)
  })

  it('默认日期按北京时间而不是UTC日期计算', () => {
    expect(getBeijingDateValue(Date.UTC(2026, 6, 19, 16, 30))).toBe('2026-07-20')
  })
})
