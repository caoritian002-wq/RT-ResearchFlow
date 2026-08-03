import { describe, expect, it } from 'vitest'
import {
  AI_EVALUATION_CASES,
  AI_EVALUATION_SUITE_FINGERPRINT,
  aggregateAiEvaluationScores,
  buildAiEvaluationPrompt,
  evaluateAiEvaluationCase,
} from '../../electron/main/services/aiEvaluationSuite'

const GOOD_RESPONSES: Record<string, string> = {
  'direct-positive-mapping': `一句话结论：沪电股份通过新增产品认证，构成直接正面线索，但订单与财务影响待验证。
关键事实与来源编号：[1]只确认认证通过；订单、收入、利润和行情均未提供。
影响传导：事实是认证通过，后续商业化属于推断。
风险与反证：客户后续未下单将削弱该线索。
STOCK_CODES: 002463|沪电股份`,
  'portfolio-negative-risk': `一句话结论：生益科技面临成本上升而售价未变的潜在利空，盈利能力可能承压。
关键事实与来源编号：[1]只给出成本与售价方向，没有财务数字。
影响传导：成本压力是事实，利润影响幅度仍待验证。
风险与反证：后续提价可能缓解负面影响。
STOCK_CODES: 600183|生益科技`,
  'irrelevant-no-mapping': `一句话结论：该社区活动没有可解释的A股或产业链关系，因此无有效映射。
关键事实与来源编号：[1]不涉及商业、政策、采购或上市公司。
STOCK_CODES: NONE`,
  'round2-market-grounding': `一句话复核结论：维持沪电股份（002463）的观察候选，业务兑现仍待验证。
行情数据边界：本地数据截止2026-07-18，最近30个交易日。
维持与修正：维持候选，但认证到订单仍有反证风险。
个股走势与支撑压力参考：MA5 49.20，MA20 47.30；近5/20日支撑观察为46.80和43.20，压力观察为51.60和54.80。
后续验证：核验订单和财务兑现。`,
}

describe('AI evaluation suite', () => {
  it('套件身份稳定且四个样本分别覆盖首轮和第二轮', () => {
    expect(AI_EVALUATION_SUITE_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/)
    expect(AI_EVALUATION_CASES).toHaveLength(4)
    expect(AI_EVALUATION_CASES.filter((item) => item.kind === 'round1')).toHaveLength(3)
    expect(AI_EVALUATION_CASES.filter((item) => item.kind === 'round2')).toHaveLength(1)
  })

  it('提示词装配复用业务提示词和第二轮真实行情契约', () => {
    const round1 = buildAiEvaluationPrompt(AI_EVALUATION_CASES[0], '业务提示词', '\n技能块')
    expect(round1).toContain('业务提示词')
    expect(round1).toContain('STOCK_CODES:')
    expect(round1).toContain('技能块')
    const round2 = buildAiEvaluationPrompt(AI_EVALUATION_CASES[3], '业务提示词')
    expect(round2).toContain('请复核下面的第一轮A股新闻研判')
    expect(round2).toContain('2026-07-18')
    expect(round2).not.toContain('业务提示词')
  })

  it('正确回答通过四个样本并形成五维高分', () => {
    const results = AI_EVALUATION_CASES.map((item) => evaluateAiEvaluationCase(item.id, GOOD_RESPONSES[item.id]))
    expect(results.every((item) => item.conclusion === 'passed')).toBe(true)
    const aggregate = aggregateAiEvaluationScores(results)
    expect(aggregate).toMatchObject({ conclusion: 'passed', blockingFailures: 0 })
    expect(aggregate.score).toBe(100)
    expect(Object.values(aggregate.dimensionScores).every((score) => score === 100)).toBe(true)
  })

  it('候选代码错误和公司方向错误触发阻断', () => {
    const result = evaluateAiEvaluationCase('portfolio-negative-risk', `这是利好，建议买入并加仓。\nSTOCK_CODES: 000001|平安银行`)
    expect(result.conclusion).toBe('failed')
    expect(result.rules.filter((item) => item.blocking && !item.passed).map((item) => item.id)).toEqual(expect.arrayContaining([
      'expected-600183',
      'negative-direction',
      'no-trading-instruction',
    ]))
  })

  it('无关样本必须显式NONE而不是静默漏掉尾部', () => {
    const result = evaluateAiEvaluationCase('irrelevant-no-mapping', '这件事和A股没有可解释关系。')
    expect(result.conclusion).toBe('failed')
    expect(result.rules.find((item) => item.id === 'none-footer')?.passed).toBe(false)
  })

  it('第二轮发明支撑位或遗漏截止日时触发阻断', () => {
    const response = GOOD_RESPONSES['round2-market-grounding']
      .replace('数据截止2026-07-18', '数据截止未知')
      .replace('支撑观察为46.80和43.20', '支撑观察为48.00和43.20')
    const result = evaluateAiEvaluationCase('round2-market-grounding', response)
    expect(result.conclusion).toBe('failed')
    expect(result.rules.find((item) => item.id === 'market-cutoff')?.passed).toBe(false)
    expect(result.rules.find((item) => item.id === 'no-unsupported-key-level')?.passed).toBe(false)
  })
})
