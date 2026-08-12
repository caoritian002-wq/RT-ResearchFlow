import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('FR-262 市场共振二级行业renderer契约', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/components/MarketOverview/MarketHeatmapPanel.tsx'), 'utf8')

  it('一级选择与展开动作分离且只通过窄IPC取数', () => {
    expect(source).toContain('aria-expanded={expanded}')
    expect(source).toContain('market.getMarketResonanceChildren')
    expect(source).toContain('parentIndustryCode: sector.boardCode')
    expect(source).not.toContain('getAllMarketResonanceChildren')
  })

  it('二级详情同时提供二级、父级和基准三条序列', () => {
    expect(source).toContain('dataKey="child"')
    expect(source).toContain('dataKey="sector"')
    expect(source).toContain('dataKey="benchmark"')
    expect(source).toContain('strokeDasharray="2 3"')
    expect(source).toContain("strokeDasharray={child ? '6 3' : undefined}")
    expect(source).toContain('二级行业分钟曲线暂不可恢复')
  })

  it('默认展示全部一级行业并明确区分总覆盖与筛选结果', () => {
    expect(source).toContain("useState<ViewFilter>('all')")
    expect(source).toContain("{ key: 'all', label: '全部行业', count: allSectors.length }")
    expect(source).toContain("label: '共振/同步'")
    expect(source).toContain('当前展示 {orderedSectors.length}/{allSectors.length} 个一级行业')
    expect(source).toContain('data-testid="market-resonance-visible-count"')
    expect(source).toContain('aria-label={`${label}，${count} 个一级行业`}')
    expect(source).not.toContain("['focus', '共振走强']")
  })
})
