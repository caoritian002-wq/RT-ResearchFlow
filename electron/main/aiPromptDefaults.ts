export const LEGACY_DEFAULT_ARTICLE_ANALYSIS_PROMPT =
  '你现在是一个老道的股票交易员。如果我给到你以下这些文章URL，你试着从这些文章中分析会影响到A股中的哪些版块，并且在这些被影响的版块中，选取三支龙头股。龙头的定义是，近期交易活跃，市值排前列，主营业务在该版块占有率名列前茅。这三支龙头股，你可以查阅近期1个月的走势，结合大盘整体，给出该股的支撑位，压力位，止盈位。并以表格的形式输出给到我，最后附上你选择他们的理由。'

export const DEFAULT_ARTICLE_ANALYSIS_PROMPT = `你是A股新闻研判助手。根据随后提供的文章正文或URL，识别对A股有决策价值的新增信息，区分事实、推断与待验证项。目标不是复述新闻，也不是强行推荐股票，而是给出可复盘的影响链和下一步验证清单。

分析要求：
1. 先合并重复信息，标明关键信息来自第几篇文章；只有输入明确支持的内容才能写为事实。无法访问或未提供的网页、财报、行情不得声称已核验，也不要用记忆补齐最新数据。
2. 按“事件 → 直接影响对象 → 产业链、供需、价格或政策传导 → A股行业或公司”解释影响；区分利好、利空、混合或暂不明确，并给出时间尺度（当日、数周或中长期）。
3. 评估重要性、持续性和证据可信度，指出反向证据、主要风险和最小验证动作。证据不足时明确标记“待验证”。
4. 必须尽最大努力把行业影响映射到1至5家最相关A股研究候选，并逐个说明利好、利空、混合或方向待确认。直接证据不足时可以给出“产业映射推断”，但必须标记待验证；不得用市值大或交易活跃替代业务相关性，不得虚构市占率、财务数字、估值、目标价、支撑位、压力位或止盈位。
5. 将结论写成可供后续讨论和产业研究复用的研究线索，不输出确定性交易指令。

按以下结构输出：
- 一句话结论
- 关键事实与来源编号
- 影响传导
- A股映射（行业或公司、影响方向、关联逻辑、证据等级、可信度、待验证项）
- 风险与反证
- 后续验证清单

只有文章确实与A股没有可解释的直接或产业链关系时，才说明无有效映射；不要因为缺少直接点名就放弃产业映射。`

export const STOCK_CODES_INSTRUCTION =
  '\n\n机器读取约束：请在回答最后单独一行输出正文中实际分析的A股研究候选，1至5只，格式为 STOCK_CODES: 600036|招商银行,601088|中国神华。产业映射推断也应输出代码并在正文标记待验证；只有文章确实与A股无关时才输出 STOCK_CODES: NONE。该行之后不要再输出其他内容。'

export interface StockCodeEntry {
  code: string
  name: string | null
}

export interface CandidateRecoveryResult<T> {
  response: string
  entries: StockCodeEntry[]
  aiResult: T | null
}

export function extractStockCodeEntries(value: string): StockCodeEntry[] {
  const entries = new Map<string, StockCodeEntry>()
  for (const match of value.matchAll(/STOCK_CODES:\s*([^\n]+)/gi)) {
    for (const item of match[1].split(',')) {
      const [rawCode, rawName] = item.trim().split('|')
      const code = (rawCode ?? '').trim().replace(/\.(SH|SZ|BJ)$/i, '')
      if (!/^\d{6}$/.test(code)) continue
      const name = rawName?.trim() || null
      const existing = entries.get(code)
      entries.set(code, { code, name: name ?? existing?.name ?? null })
    }
  }
  return [...entries.values()]
}

export function buildCandidateRecoveryPrompt(previousAnalysis: string): string {
  return `上一轮新闻研判没有形成可读取的A股股票代码。请完成一次“行业影响 → A股研究候选”恢复，不要重复整篇新闻摘要。

恢复目标：
1. 如果事件对产业、供需、成本、价格、政策执行或终端需求存在影响，给出1至5家最相关A股研究候选。
2. 逐个写明6位代码、公司名、影响方向（利好/利空/混合/待确认）、业务关联、证据等级（直接/产业映射推断/未验证）和最小验证动作。
3. 产业映射候选不是已核验事实，可以使用稳定的公司业务常识帮助定位，但必须明确标注推断，不得虚构最新订单、财务数字、市占率或行情。
4. 优先选择主营业务真正暴露于该影响链的公司，不要只因为市值大、知名或交易活跃而入选。
5. 只有事件确实与A股没有可解释的直接或产业链关系时，才允许没有候选，并说明判断依据。
6. 不输出买卖、仓位、目标价、支撑位、压力位或止盈止损建议。

上一轮研判：
${previousAnalysis.slice(0, 16000)}
${STOCK_CODES_INSTRUCTION}`
}

export function appendCandidateRecoveryResponse(original: string, recovery: string): string {
  return `${original.trim()}\n\n## A股标的映射补充\n\n${recovery.trim()}`.trim()
}

export async function runCandidateRecovery<T extends { text: string }>(
  previousAnalysis: string,
  request: (prompt: string) => Promise<T>,
): Promise<CandidateRecoveryResult<T>> {
  const existing = extractStockCodeEntries(previousAnalysis)
  if (existing.length > 0) {
    return { response: previousAnalysis, entries: existing, aiResult: null }
  }
  const aiResult = await request(buildCandidateRecoveryPrompt(previousAnalysis))
  const response = appendCandidateRecoveryResponse(previousAnalysis, aiResult.text)
  return { response, entries: extractStockCodeEntries(response), aiResult }
}

export function resolveArticleAnalysisPrompt(
  providerPrompt?: string | null,
  globalPrompt?: string | null,
): string {
  return providerPrompt || globalPrompt || DEFAULT_ARTICLE_ANALYSIS_PROMPT
}

export function buildArticleRound2Prompt(previousAnalysis: string, priceData: string): string {
  const marketSection = priceData.trim()
    ? `以下是统一本地数据源实际取得的候选股票行情、趋势、基本面与公告标题索引。只能把已提供的数据作为事实，并严格保留各工具的状态、来源、事实日、覆盖和警告：\n\n${priceData}`
    : '本轮未取得候选股票行情数据。不得使用模型记忆补齐当前价格、涨跌幅、技术位或近期走势；相关判断必须标记为“行情待验证”。'

  return `请复核下面的第一轮A股新闻研判，并用新增的本地行情事实修正结论。

第一轮研判：
${previousAnalysis}

新增上下文：
${marketSection}

复核要求：
1. 区分输入事实、基于事实的推断和仍待验证的判断，不得把第一轮结论本身当成事实。
2. 重新检查事件到行业、公司之间的传导链，说明影响方向、时间尺度和关键反证是否变化。
3. 逐一说明候选应维持、降级或移除；候选数量由证据决定，可以为零，不要凑足固定数量。
4. 对每只取得有效行情的候选，必须结合最新收盘、近5/20日收益、MA5/MA10/MA20和逐日OHLC，判断近期趋势、强弱、量价特征与行情是否支持第一轮叙事。
5. 可以引用上下文已经按明确口径计算的近5/20日最低价作为“支撑观察参考”、最高价作为“压力观察参考”，并解释价格目前所处位置；不得发明上下文之外的价位，也不得把区间边界写成预测目标、止损位或买卖指令。
6. 每只股票都要写明数据截止日、样本范围和关键价位口径；行情不足的候选必须单独标记为受阻，不得使用模型记忆补齐。
7. 基本面、财务或公告工具为partial、missing或failed时必须明确写出缺口；公告标题线索不得冒充已阅读公告正文、事实影响或利好利空。
8. 明确列出相对第一轮的修正，以及下一步最小验证动作；不输出买卖、仓位、目标价或确定性交易指令。

按“一句话复核结论 / 行情数据边界 / 维持与修正 / 个股走势与支撑压力参考 / 风险与反证 / 后续验证清单”组织回答。`
}
