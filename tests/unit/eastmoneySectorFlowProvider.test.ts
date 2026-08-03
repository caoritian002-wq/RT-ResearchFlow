import { describe, expect, it } from 'vitest'
import {
  parseEastmoneySectorBoard,
  parseEastmoneySectorMember,
} from '../../electron/main/services/eastmoneySectorFlowProvider'

describe('FR-243 东方财富板块资金解析', () => {
  it('保留主力资金、大小单、广度、领涨股和来源时间', () => {
    const parsed = parseEastmoneySectorBoard({
      f12: 'BK1648', f14: '电池技术', f3: 2.81, f6: 335_458_568_116,
      f20: 9_000_000_000_000, f62: 10_951_472_128, f184: 3.26,
      f66: 4_000_000_000, f69: 1.2, f72: 6_951_472_128, f75: 2.06,
      f78: -2_000_000_000, f81: -0.6, f84: -8_951_472_128, f87: -2.66,
      f104: 496, f105: 81, f106: 4, f124: 1_784_792_372,
      f128: '宁德时代', f140: '300750', f136: 4.5,
    }, 'concept')

    expect(parsed).toMatchObject({
      boardCode: 'BK1648', boardName: '电池技术', scope: 'concept',
      metricMode: 'verified_flow', mainNetInflow: 10_951_472_128,
      mainNetInflowRate: 3.26, upCount: 496, downCount: 81, flatCount: 4,
      memberCount: 581, sourceUpdatedAt: 1_784_792_372_000,
      leader: { tsCode: '300750.SZ', name: '宁德时代', change: 4.5 },
    })
  })

  it('拒绝缺少真实资金或非法板块代码的响应', () => {
    expect(parseEastmoneySectorBoard({ f12: 'BK1648', f14: '电池技术', f3: 1, f6: 100 }, 'concept')).toBeNull()
    expect(parseEastmoneySectorBoard({ f12: 'BAD', f14: '错误', f3: 1, f6: 100, f62: 10 }, 'industry')).toBeNull()
  })

  it('成分只接受可映射的A股代码，不把B股误标为深市A股', () => {
    expect(parseEastmoneySectorMember({
      f12: '300750', f14: '宁德时代', f3: 3.2, f6: 100, f62: 10, f184: 10,
    })).toMatchObject({ tsCode: '300750.SZ', name: '宁德时代' })
    expect(parseEastmoneySectorMember({
      f12: '200625', f14: '长安B', f3: 2.1, f6: 100, f62: 10, f184: 10,
    })).toBeNull()
    expect(parseEastmoneySectorMember({
      f12: '900901', f14: '云赛B股', f3: 1.1, f6: 100, f62: 10, f184: 10,
    })).toBeNull()
  })
})
