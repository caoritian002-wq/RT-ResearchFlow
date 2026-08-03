import type {
  PremarketScenarioBranch,
  PremarketScenarioView,
} from '../../../electron/main/services/premarketRehearsalTypes'

export type PremarketConclusionTone = 'constructive' | 'caution' | 'defensive' | 'blocked'

export interface PremarketUserConclusion {
  tone: PremarketConclusionTone
  stance: string
  headline: string
  summary: string
  confirmation: string
  invalidation: string
  basis: string[]
}

function formatNames(names: string[]): string {
  if (names.length === 0) return '当前持仓'
  if (names.length <= 2) return names.join('、')
  return `${names.slice(0, 2).join('、')}等${names.length}只持仓`
}

function selectBranch(
  version: PremarketScenarioView,
  riskCount: number,
  alignedCount: number,
): PremarketScenarioBranch | undefined {
  const key = riskCount > 0 || version.scenario.marketState === 'defensive'
    ? 'risk'
    : version.scenario.marketState === 'constructive' && alignedCount > 0
      ? 'reinforced'
      : 'base'
  return version.scenario.branches.find((item) => item.key === key)
}

function firstOr(items: string[] | undefined, fallback: string): string {
  return items?.find((item) => item.trim().length > 0) ?? fallback
}

export function buildPremarketUserConclusion(
  version: PremarketScenarioView,
): PremarketUserConclusion {
  const riskHoldings = version.scenario.holdings.filter((item) => item.state === 'risk')
  const alignedHoldings = version.scenario.holdings.filter((item) => item.state === 'aligned')
  const watchingHoldings = version.scenario.holdings.filter((item) => item.state === 'watching')
  const holdingCount = version.scenario.holdings.length
  const riskNames = formatNames(riskHoldings.map((item) => item.stockName))
  const alignedNames = formatNames(alignedHoldings.map((item) => item.stockName))
  const branch = selectBranch(version, riskHoldings.length, alignedHoldings.length)
  const basis = [
    version.scenario.marketState === 'constructive'
      ? '外盘环境偏暖'
      : version.scenario.marketState === 'defensive'
        ? '外盘环境偏弱'
        : version.scenario.marketState === 'mixed'
          ? '外盘方向分化'
          : '外盘证据不足',
    riskHoldings.length > 0
      ? `${riskHoldings.length}/${holdingCount}只持仓存在反向证据`
      : alignedHoldings.length > 0
        ? `${alignedHoldings.length}/${holdingCount}只持仓结构未见冲突`
        : `${watchingHoldings.length}/${holdingCount}只持仓仍待确认`,
    version.stage === 'auction_confirmed'
      ? `竞价覆盖 ${version.evidence.auctionMatchedCount}/${holdingCount}只`
      : '竞价尚待09:28确认',
  ]

  if (version.status === 'blocked' || version.scenario.marketState === 'insufficient') {
    return {
      tone: 'blocked',
      stance: '暂不判断',
      headline: '关键盘前事实仍不完整，当前不能判断方向',
      summary: '现有信息只能用于列出观察条件，不能据此判断高开、低开或日内强弱。先完成补采，再看外盘、竞价与持仓自身结构是否形成一致证据。',
      confirmation: firstOr(branch?.confirmConditions, '补齐外盘与竞价后，再检查持仓和行业方向是否一致'),
      invalidation: '当前没有方向性判断，因此不存在需要维护的看强或看弱结论',
      basis,
    }
  }

  if (riskHoldings.length > 0) {
    if (version.scenario.marketState === 'constructive') {
      return {
        tone: 'caution',
        stance: '外暖内弱 · 偏谨慎',
        headline: `外盘偏暖，但${riskNames}自身结构仍偏弱`,
        summary: '盘前基准判断：优先防范冲高后承接不足，不能把外盘上涨直接视为个股已经反转。个股自身趋势、筹码与竞价证据的优先级高于外盘映射。',
        confirmation: firstOr(branch?.confirmConditions, '风险持仓开盘后继续弱于竞价参考价'),
        invalidation: firstOr(branch?.invalidationConditions, '风险持仓收复竞价参考价且行业同步修复'),
        basis,
      }
    }
    if (version.scenario.marketState === 'defensive') {
      return {
        tone: 'defensive',
        stance: '外弱内弱 · 风险优先',
        headline: `外盘走弱，${riskNames}的反向证据同时存在`,
        summary: '盘前基准判断：弱势延续风险更高，先观察开盘后能否快速修复，而不是预设外盘或个股会自然反弹。',
        confirmation: firstOr(branch?.confirmConditions, '风险持仓开盘后继续弱于竞价参考价'),
        invalidation: firstOr(branch?.invalidationConditions, '风险持仓收复竞价参考价且行业同步修复'),
        basis,
      }
    }
    return {
      tone: 'caution',
      stance: '内外分化 · 偏谨慎',
      headline: `外盘没有一致方向，${riskNames}自身风险更值得优先关注`,
      summary: '盘前基准判断：暂不依赖外盘给出方向，先以持仓自身结构和开盘承接作为判断主线。',
      confirmation: firstOr(branch?.confirmConditions, '风险持仓开盘后继续弱于竞价参考价'),
      invalidation: firstOr(branch?.invalidationConditions, '风险持仓收复竞价参考价且行业同步修复'),
      basis,
    }
  }

  if (alignedHoldings.length > 0 && version.scenario.marketState === 'constructive') {
    return {
      tone: 'constructive',
      stance: '条件偏强 · 等待确认',
      headline: `外盘偏暖，${alignedNames}自身结构暂未形成冲突`,
      summary: '盘前基准判断：具备偏强开局条件，但是否能够延续仍取决于竞价承接和行业共振，这不等于趋势已经反转。',
      confirmation: firstOr(branch?.confirmConditions, '竞价与外部风险方向未明显冲突'),
      invalidation: firstOr(branch?.invalidationConditions, '竞价高开后迅速失去承接'),
      basis,
    }
  }

  if (alignedHoldings.length > 0 && version.scenario.marketState === 'defensive') {
    return {
      tone: 'caution',
      stance: '外弱内稳 · 观察承接',
      headline: `${alignedNames}自身结构尚稳，但外部环境偏弱`,
      summary: '盘前基准判断：个股具备相对抗压基础，仍需通过竞价和开盘承接确认，不能仅凭历史趋势推断当日强势。',
      confirmation: firstOr(branch?.confirmConditions, '开盘后持仓未快速跌破竞价参考价'),
      invalidation: firstOr(branch?.invalidationConditions, '组合风险项数量继续增加'),
      basis,
    }
  }

  return {
    tone: 'caution',
    stance: '方向分化 · 等待确认',
    headline: '外盘与持仓证据尚未形成一致方向',
    summary: '盘前基准判断：当前不预设高开或低开，优先观察竞价、行业强弱与个股自身结构是否出现同向确认。',
    confirmation: firstOr(branch?.confirmConditions, '开盘后行业与持仓方向形成一致'),
    invalidation: firstOr(branch?.invalidationConditions, '组合风险项数量继续增加'),
    basis,
  }
}
