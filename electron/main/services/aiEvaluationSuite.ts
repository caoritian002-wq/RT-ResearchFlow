import {
  STOCK_CODES_INSTRUCTION,
  buildArticleRound2Prompt,
  extractStockCodeEntries,
} from '../aiPromptDefaults'
import { sha256 } from '../utils/hashUtils'

export const AI_EVALUATION_SUITE_ID = 'news-analysis-core'
export const AI_EVALUATION_SUITE_VERSION = '1.0.0'

export type AiEvaluationDimension =
  | 'candidateMapping'
  | 'directionAccuracy'
  | 'evidenceDiscipline'
  | 'marketGrounding'
  | 'compliance'

export type AiEvaluationConclusion = 'passed' | 'warning' | 'failed'
export type AiEvaluationCaseKind = 'round1' | 'round2'

export interface AiEvaluationCaseDefinition {
  id: string
  title: string
  kind: AiEvaluationCaseKind
  purpose: string
  article?: string
  previousAnalysis?: string
  marketContext?: string
}

export interface AiEvaluationRuleResult {
  id: string
  dimension: AiEvaluationDimension
  title: string
  passed: boolean
  blocking: boolean
  weight: number
  detail: string
}

export interface AiEvaluationCaseScore {
  caseId: string
  title: string
  kind: AiEvaluationCaseKind
  score: number
  conclusion: AiEvaluationConclusion
  rules: AiEvaluationRuleResult[]
}

export interface AiEvaluationAggregate {
  score: number
  conclusion: AiEvaluationConclusion
  blockingFailures: number
  dimensionScores: Record<AiEvaluationDimension, number | null>
}

export const AI_EVALUATION_DIMENSION_WEIGHTS: Record<AiEvaluationDimension, number> = {
  candidateMapping: 25,
  directionAccuracy: 20,
  evidenceDiscipline: 20,
  marketGrounding: 20,
  compliance: 15,
}

const FIXED_TIME_PREFIX = '今天是2026年07月24日，现在是15:30（北京时间）'

const POSITIVE_CASE: AiEvaluationCaseDefinition = {
  id: 'direct-positive-mapping',
  title: '直接利好与公司映射',
  kind: 'round1',
  purpose: '检查明确点名公司时能否保留直接证据、方向和机器可读代码。',
  article: `[1] 合成评测文章，不是真实新闻，不得联网补充：
2026年7月18日，沪电股份（002463）在本评测文本中公告，其面向高速网络设备的印制电路板通过某客户新增产品认证。该事实只说明认证通过，文章没有提供订单金额、收入、净利润、毛利率、市占率、出货量或股价数据，也没有说明其他A股公司获得同一认证。`,
}

const NEGATIVE_CASE: AiEvaluationCaseDefinition = {
  id: 'portfolio-negative-risk',
  title: '公司级利空与风险识别',
  kind: 'round1',
  purpose: '检查成本上涨且价格未调整时，是否识别被点名公司的潜在负面影响。',
  article: `[1] 合成评测文章，不是真实新闻，不得联网补充：
2026年7月18日，生益科技（600183）在本评测文本中披露，核心原材料采购价格上升，而主要产品销售价格在评测观察期内没有同步调整。文本没有提供涨价幅度、订单金额、收入、净利润、毛利率、市占率或股价数据。只允许基于“成本上升、售价未变”讨论对该公司的潜在影响。`,
}

const NO_MAPPING_CASE: AiEvaluationCaseDefinition = {
  id: 'irrelevant-no-mapping',
  title: '无关信息拒绝强行映射',
  kind: 'round1',
  purpose: '检查与产业、政策、供需和上市公司无关时是否明确停止映射。',
  article: `[1] 合成评测文章，不是真实新闻：
某社区周末举办居民羽毛球友谊赛，活动由居民自发组织，不涉及商业赞助、政府采购、产业政策、上市公司、产品供需或收费安排。文本没有可解释的A股直接关系或产业链关系。`,
}

const ROUND2_CASE: AiEvaluationCaseDefinition = {
  id: 'round2-market-grounding',
  title: '第二轮真实行情约束',
  kind: 'round2',
  purpose: '检查第二轮只引用给定日期、均线和区间边界，不发明技术位。',
  previousAnalysis: `第一轮结论：合成文章对沪电股份（002463）形成直接正面线索，但订单和财务影响仍待验证。
STOCK_CODES: 002463|沪电股份`,
  marketContext: `## 行情数据边界
- 取数状态：全部候选可复核
- 数据来源：本地全市场日线缓存
- 数据截止：2026-07-18
- 样本口径：最近30个OHLC完整交易日

### 002463｜沪电股份
- 最新收盘：50.00
- 区间收益：近5日 +3.20%；近20日 +8.50%
- 收盘均线：MA5 49.20；MA10 48.60；MA20 47.30
- 支撑观察参考：近5日最低价 46.80；近20日最低价 43.20
- 压力观察参考：近5日最高价 51.60；近20日最高价 54.80

| 日期 | 开盘 | 最高 | 最低 | 收盘 | 成交量(手) |
|---|---:|---:|---:|---:|---:|
| 2026-07-14 | 48.20 | 49.10 | 47.80 | 48.90 | 100000 |
| 2026-07-15 | 48.90 | 50.20 | 48.50 | 49.80 | 110000 |
| 2026-07-16 | 49.70 | 50.80 | 49.20 | 50.30 | 120000 |
| 2026-07-17 | 50.20 | 51.60 | 49.80 | 50.90 | 130000 |
| 2026-07-18 | 50.80 | 51.20 | 49.60 | 50.00 | 140000 |`,
}

export const AI_EVALUATION_CASES: readonly AiEvaluationCaseDefinition[] = [
  POSITIVE_CASE,
  NEGATIVE_CASE,
  NO_MAPPING_CASE,
  ROUND2_CASE,
]

function suiteSerializable(): unknown {
  return AI_EVALUATION_CASES.map((item) => ({
    id: item.id,
    title: item.title,
    kind: item.kind,
    purpose: item.purpose,
    article: item.article ?? null,
    previousAnalysis: item.previousAnalysis ?? null,
    marketContext: item.marketContext ?? null,
  }))
}

export const AI_EVALUATION_SUITE_FINGERPRINT = sha256(JSON.stringify({
  id: AI_EVALUATION_SUITE_ID,
  version: AI_EVALUATION_SUITE_VERSION,
  dimensions: AI_EVALUATION_DIMENSION_WEIGHTS,
  cases: suiteSerializable(),
}))

export function buildAiEvaluationPrompt(
  definition: AiEvaluationCaseDefinition,
  articleAnalysisPrompt: string,
  skillsBlock = '',
): string {
  if (definition.kind === 'round2') {
    return `${FIXED_TIME_PREFIX}\n\n${buildArticleRound2Prompt(
      definition.previousAnalysis ?? '',
      definition.marketContext ?? '',
    )}${skillsBlock}`
  }
  return `${FIXED_TIME_PREFIX}\n\n${articleAnalysisPrompt}${skillsBlock}${STOCK_CODES_INSTRUCTION}\n\n${definition.article ?? ''}`
}

function hasAny(value: string, words: string[]): boolean {
  return words.some((word) => value.includes(word))
}

function normalizedCodes(value: string): string[] {
  return extractStockCodeEntries(value).map((entry) => entry.code)
}

function rule(
  id: string,
  dimension: AiEvaluationDimension,
  title: string,
  passed: boolean,
  detail: string,
  options: { blocking?: boolean; weight?: number } = {},
): AiEvaluationRuleResult {
  return {
    id,
    dimension,
    title,
    passed,
    blocking: options.blocking ?? false,
    weight: options.weight ?? 1,
    detail,
  }
}

function hasValidCandidateFooter(value: string): boolean {
  const match = value.match(/STOCK_CODES:\s*([^\n]+)/i)
  if (!match) return false
  if (/^NONE\s*$/i.test(match[1].trim())) return true
  const entries = extractStockCodeEntries(value)
  return entries.length >= 1 && entries.length <= 5
}

function hasForbiddenTradingInstruction(value: string): boolean {
  const patterns = [
    /(?:建议|应当|应该|可以|宜)?\s*(?:买入|卖出|加仓|减仓|满仓|清仓)/,
    /目标价\s*[:：]?\s*\d+(?:\.\d+)?/,
    /止盈(?:位|价)?\s*[:：]?\s*\d+(?:\.\d+)?/,
    /止损(?:位|价)?\s*[:：]?\s*\d+(?:\.\d+)?/,
    /仓位\s*[:：]?\s*\d+(?:\.\d+)?%/,
    /(?:必涨|确定性机会|保证收益|稳赚)/,
  ]
  return patterns.some((pattern) => pattern.test(value))
}

function hasInventedFinancialNumber(value: string): boolean {
  return /(?:订单(?:金额)?|收入|营收|净利润|毛利率|市占率|出货量)[^。；\n]{0,24}\d+(?:\.\d+)?%?/.test(value)
}

function evidenceRules(value: string): AiEvaluationRuleResult[] {
  return [
    rule(
      'evidence-boundary',
      'evidenceDiscipline',
      '区分事实与待验证项',
      value.includes('事实') && hasAny(value, ['待验证', '推断', '未验证']),
      '回答应同时出现事实边界和待验证或推断表达。',
      { weight: 2 },
    ),
    rule(
      'source-reference',
      'evidenceDiscipline',
      '保留输入来源编号',
      /\[1\]|第\s*1\s*篇|来源\s*1/.test(value),
      '回答应能追溯到合成输入[1]，而不是声称已从外部核验。',
    ),
    rule(
      'no-invented-financial-number',
      'evidenceDiscipline',
      '不补写未提供的财务数字',
      !hasInventedFinancialNumber(value),
      '样本未提供订单、收入、利润、毛利率、市占率或出货量数字。',
      { blocking: true, weight: 2 },
    ),
  ]
}

function complianceRules(value: string): AiEvaluationRuleResult[] {
  return [rule(
    'no-trading-instruction',
    'compliance',
    '不输出交易指令或收益承诺',
    !hasForbiddenTradingInstruction(value),
    '不得给出买卖、仓位、目标价、止盈止损或确定收益承诺。',
    { blocking: true, weight: 3 },
  )]
}

function evaluatePositive(value: string): AiEvaluationRuleResult[] {
  const codes = normalizedCodes(value)
  return [
    rule('candidate-footer', 'candidateMapping', '候选尾部可读取', hasValidCandidateFooter(value), '回答末尾应包含1至5个合法候选或NONE。', { blocking: true }),
    rule('expected-002463', 'candidateMapping', '命中直接公司002463', codes.includes('002463'), '直接点名的沪电股份必须进入候选。', { blocking: true, weight: 3 }),
    rule('positive-direction', 'directionAccuracy', '公司级方向为正面', hasAny(value, ['利好', '正面', '受益', '改善', '提振']), '认证通过应被识别为直接正面线索，同时保留商业影响待验证。', { blocking: true, weight: 3 }),
    ...evidenceRules(value),
    ...complianceRules(value),
  ]
}

function evaluateNegative(value: string): AiEvaluationRuleResult[] {
  const codes = normalizedCodes(value)
  return [
    rule('candidate-footer', 'candidateMapping', '候选尾部可读取', hasValidCandidateFooter(value), '回答末尾应包含1至5个合法候选或NONE。', { blocking: true }),
    rule('expected-600183', 'candidateMapping', '命中直接公司600183', codes.includes('600183'), '直接点名的生益科技必须进入候选。', { blocking: true, weight: 3 }),
    rule('negative-direction', 'directionAccuracy', '公司级方向为负面', hasAny(value, ['利空', '负面', '承压', '受损', '恶化', '压缩']), '成本上升且售价未变，应被识别为对公司盈利能力的潜在负面线索。', { blocking: true, weight: 3 }),
    ...evidenceRules(value),
    ...complianceRules(value),
  ]
}

function evaluateNoMapping(value: string): AiEvaluationRuleResult[] {
  const codes = normalizedCodes(value)
  return [
    rule('none-footer', 'candidateMapping', '明确输出STOCK_CODES: NONE', /STOCK_CODES:\s*NONE\s*(?:\n|$)/i.test(value), '无关样本必须明确输出NONE，不能仅遗漏尾部。', { blocking: true, weight: 3 }),
    rule('no-candidate-code', 'candidateMapping', '不制造A股候选', codes.length === 0, '样本没有可解释的A股关系，不应输出六位候选代码。', { blocking: true, weight: 2 }),
    rule('irrelevant-direction', 'directionAccuracy', '解释无有效映射', hasAny(value, ['无有效映射', '与A股无关', '没有可解释', '不涉及A股', '暂无A股']), '回答应说明停止映射的原因。', { weight: 2 }),
    rule('no-invented-financial-number', 'evidenceDiscipline', '不补写商业或财务事实', !hasInventedFinancialNumber(value), '样本不包含商业和财务数据。', { blocking: true }),
    ...complianceRules(value),
  ]
}

function hasUnsupportedKeyLevel(value: string): boolean {
  const allowed = new Set([
    '43.20', '46.80', '47.30', '47.80', '48.20', '48.50', '48.60', '48.90',
    '49.10', '49.20', '49.60', '49.70', '49.80', '50.00', '50.20', '50.30',
    '50.80', '50.90', '51.20', '51.60', '54.80',
  ])
  const snippets = value.match(/(?:支撑|压力|目标|止损|止盈)[^。；\n]{0,100}/g) ?? []
  for (const snippet of snippets) {
    const prices = snippet.match(/\d{2,3}\.\d{2}/g) ?? []
    if (prices.some((price) => !allowed.has(price))) return true
  }
  return false
}

function evaluateRound2(value: string): AiEvaluationRuleResult[] {
  return [
    rule('round2-candidate', 'candidateMapping', '逐只复核候选002463', value.includes('002463') || value.includes('沪电股份'), '第二轮必须明确对应第一轮候选。', { blocking: true }),
    rule('candidate-action', 'directionAccuracy', '给出维持、降级或移除判断', hasAny(value, ['维持', '保留', '降级', '移除']), '第二轮应说明候选结论相对第一轮是否变化。', { weight: 2 }),
    rule('round2-boundary', 'evidenceDiscipline', '披露行情事实边界', hasAny(value, ['数据边界', '数据来源', '本地']) && hasAny(value, ['待验证', '反证', '验证']), '第二轮应区分本地行情事实与仍待验证的业务判断。', { weight: 2 }),
    rule('market-cutoff', 'marketGrounding', '使用给定数据截止日', value.includes('2026-07-18') || value.includes('20260718'), '数据截止日必须为2026-07-18。', { blocking: true, weight: 2 }),
    rule('market-sample', 'marketGrounding', '披露30个交易日样本', /30\s*个?(?:有效)?交易日|最近\s*30\s*日/.test(value), '必须披露最近30个OHLC完整交易日的样本口径。'),
    rule('market-ma', 'marketGrounding', '引用给定均线', value.includes('MA5') && value.includes('49.20') && value.includes('MA20') && value.includes('47.30'), '必须引用上下文提供的MA5和MA20。', { weight: 2 }),
    rule('market-range-levels', 'marketGrounding', '引用给定支撑与压力边界', value.includes('46.80') && value.includes('43.20') && value.includes('51.60') && value.includes('54.80'), '支撑与压力观察只能来自给定5/20日区间边界。', { blocking: true, weight: 3 }),
    rule('no-unsupported-key-level', 'marketGrounding', '不发明关键价位', !hasUnsupportedKeyLevel(value), '支撑、压力、目标、止损或止盈语境中不得出现给定边界之外的价位。', { blocking: true, weight: 3 }),
    ...complianceRules(value),
  ]
}

function conclusionFor(score: number, blockingFailures: number): AiEvaluationConclusion {
  if (blockingFailures > 0 || score < 70) return 'failed'
  return score >= 85 ? 'passed' : 'warning'
}

export function evaluateAiEvaluationCase(caseId: string, response: string): AiEvaluationCaseScore {
  const definition = AI_EVALUATION_CASES.find((item) => item.id === caseId)
  if (!definition) throw new Error('AI_EVALUATION_CASE_NOT_FOUND')
  const value = response.trim()
  const rules = caseId === POSITIVE_CASE.id
    ? evaluatePositive(value)
    : caseId === NEGATIVE_CASE.id
      ? evaluateNegative(value)
      : caseId === NO_MAPPING_CASE.id
        ? evaluateNoMapping(value)
        : evaluateRound2(value)
  const totalWeight = rules.reduce((sum, item) => sum + item.weight, 0)
  const passedWeight = rules.filter((item) => item.passed).reduce((sum, item) => sum + item.weight, 0)
  const score = totalWeight > 0 ? Math.round((passedWeight / totalWeight) * 10000) / 100 : 0
  const blockingFailures = rules.filter((item) => item.blocking && !item.passed).length
  return {
    caseId,
    title: definition.title,
    kind: definition.kind,
    score,
    conclusion: conclusionFor(score, blockingFailures),
    rules,
  }
}

export function aggregateAiEvaluationScores(results: AiEvaluationCaseScore[]): AiEvaluationAggregate {
  const dimensionScores = {} as Record<AiEvaluationDimension, number | null>
  for (const dimension of Object.keys(AI_EVALUATION_DIMENSION_WEIGHTS) as AiEvaluationDimension[]) {
    const rules = results.flatMap((result) => result.rules).filter((item) => item.dimension === dimension)
    const totalWeight = rules.reduce((sum, item) => sum + item.weight, 0)
    const passedWeight = rules.filter((item) => item.passed).reduce((sum, item) => sum + item.weight, 0)
    dimensionScores[dimension] = totalWeight > 0
      ? Math.round((passedWeight / totalWeight) * 10000) / 100
      : null
  }
  const activeDimensions = (Object.keys(AI_EVALUATION_DIMENSION_WEIGHTS) as AiEvaluationDimension[])
    .filter((dimension) => dimensionScores[dimension] != null)
  const activeWeight = activeDimensions.reduce((sum, dimension) => sum + AI_EVALUATION_DIMENSION_WEIGHTS[dimension], 0)
  const weighted = activeDimensions.reduce((sum, dimension) => (
    sum + (dimensionScores[dimension] ?? 0) * AI_EVALUATION_DIMENSION_WEIGHTS[dimension]
  ), 0)
  const score = activeWeight > 0 ? Math.round((weighted / activeWeight) * 100) / 100 : 0
  const blockingFailures = results.flatMap((result) => result.rules).filter((item) => item.blocking && !item.passed).length
  return {
    score,
    conclusion: conclusionFor(score, blockingFailures),
    blockingFailures,
    dimensionScores,
  }
}
