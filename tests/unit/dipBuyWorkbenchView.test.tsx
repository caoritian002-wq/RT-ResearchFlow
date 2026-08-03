import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../..')

describe('DipBuyRadar V2 static contract', () => {
  it('使用三模式结论、可访问筛选、选中研判和公共股票抽屉', () => {
    const source = readFileSync(join(root, 'src/components/ShortTermStrategy/DipBuyRadar.tsx'), 'utf8')
    expect(source).toContain('data-testid="dip-buy-workbench"')
    expect(source).toContain('data-testid="dip-buy-conclusion"')
    expect(source).toContain('ShortTermCombobox')
    expect(source).toContain('前置条件')
    expect(source).toContain('明确失效')
    expect(source).toContain('StockKlineChipDrawer')
    expect(source).toContain('onOpenHistory')
    expect(source).not.toContain('📈')
    expect(source).not.toContain('🎯')
    expect(source).not.toContain('🔄')
    expect(source).not.toContain('mock 数据')
  })

  it('服务不再使用全历史最高连板、跌停即套利和缺失行情补零', () => {
    const source = readFileSync(join(root, 'electron/main/services/dipBuyRadarService.ts'), 'utf8')
    expect(source).toContain('DIP_BUY_STRATEGY_KEYS')
    expect(source).toContain('getMoneyFlowMapByDate')
    expect(source).toContain('trade_date <= ?')
    expect(source).not.toContain('getMaxLimitTimesByStock')
    expect(source).not.toContain('当日跌停股（超跌候选）')
    expect(source).not.toContain('pctChg: 0')
    expect(source).not.toContain('close: 0')
  })
})
