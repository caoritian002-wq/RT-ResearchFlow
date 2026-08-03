import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ARTICLE_ANALYSIS_PROMPT,
  STOCK_CODES_INSTRUCTION,
  appendCandidateRecoveryResponse,
  buildCandidateRecoveryPrompt,
  buildArticleRound2Prompt,
  extractStockCodeEntries,
  resolveArticleAnalysisPrompt,
  runCandidateRecovery,
} from '../../electron/main/aiPromptDefaults'
import {
  PROVIDER_MODELS,
  buildOpenAICompatibleExtra,
} from '../../electron/main/services/aiProvider'

describe('FR-240 模型与文章分析提示词', () => {
  it('将gpt-5.6-sol置于ChatGPT模型列表首位且不猜测专属参数', () => {
    expect(PROVIDER_MODELS.chatgpt[0]).toBe('gpt-5.6-sol')
    expect(PROVIDER_MODELS.chatgpt).toContain('gpt-5.5')
    expect(buildOpenAICompatibleExtra('chatgpt', 'gpt-5.6-sol')).toEqual({})
    expect(buildOpenAICompatibleExtra('chatgpt', 'gpt-5.5')).toEqual({ reasoning_effort: 'high' })
    expect(buildOpenAICompatibleExtra('qwen', 'qwen-max-latest')).toEqual({ enable_search: true })
  })

  it('默认提示词以证据和传导为主线并要求完成A股映射', () => {
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).toContain('区分事实、推断与待验证项')
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).toContain('影响传导')
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).toContain('风险与反证')
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).toContain('必须尽最大努力把行业影响映射到1至5家')
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).toContain('产业映射推断')
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).toContain('不得虚构市占率、财务数字、估值、目标价')
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).not.toContain('老道的股票交易员')
    expect(DEFAULT_ARTICLE_ANALYSIS_PROMPT).not.toContain('选取三支龙头股')
    expect(STOCK_CODES_INSTRUCTION).toContain('1至5只')
    expect(STOCK_CODES_INSTRUCTION).toContain('STOCK_CODES: NONE')
  })

  it('厂商和用户自定义提示词继续优先于系统默认值', () => {
    expect(resolveArticleAnalysisPrompt('厂商提示词', '全局提示词')).toBe('厂商提示词')
    expect(resolveArticleAnalysisPrompt(null, '全局提示词')).toBe('全局提示词')
    expect(resolveArticleAnalysisPrompt(null, null)).toBe(DEFAULT_ARTICLE_ANALYSIS_PROMPT)
  })

  it('第二轮按实际行情逐股复核趋势和透明口径技术位', () => {
    const withMarketData = buildArticleRound2Prompt('第一轮内容', '600000.SH close=10')
    expect(withMarketData).toContain('本地数据源实际取得')
    expect(withMarketData).toContain('600000.SH close=10')
    expect(withMarketData).toContain('候选数量由证据决定，可以为零')
    expect(withMarketData).toContain('MA5/MA10/MA20')
    expect(withMarketData).toContain('支撑观察参考')
    expect(withMarketData).toContain('压力观察参考')
    expect(withMarketData).toContain('数据截止日、样本范围和关键价位口径')
    expect(withMarketData).not.toContain('这三只股票')
    expect(withMarketData).not.toContain('止盈位')

    const withoutMarketData = buildArticleRound2Prompt('第一轮内容', '')
    expect(withoutMarketData).toContain('行情待验证')
    expect(withoutMarketData).toContain('不得使用模型记忆补齐当前价格')
  })

  it('候选恢复读取全部机器行且NONE不会遮蔽后续代码', () => {
    const recovered = appendCandidateRecoveryResponse(
      '首轮结论\nSTOCK_CODES: NONE',
      '补充候选\nSTOCK_CODES: 600000|浦发银行,000001.SZ|平安银行',
    )
    expect(extractStockCodeEntries(recovered)).toEqual([
      { code: '600000', name: '浦发银行' },
      { code: '000001', name: '平安银行' },
    ])
    const prompt = buildCandidateRecoveryPrompt('消费电子监管影响供应链')
    expect(prompt).toContain('行业影响 → A股研究候选')
    expect(prompt).toContain('影响方向（利好/利空/混合/待确认）')
    expect(prompt).toContain('产业映射推断')
  })

  it('候选恢复成功时追加结果，已有代码时不重复花费Token', async () => {
    const request = vi.fn(async () => ({ text: '利空映射：浦发银行\nSTOCK_CODES: 600000|浦发银行' }))
    const recovered = await runCandidateRecovery('首轮结论\nSTOCK_CODES: NONE', request)
    expect(request).toHaveBeenCalledOnce()
    expect(recovered.response).toContain('## A股标的映射补充')
    expect(recovered.entries).toEqual([{ code: '600000', name: '浦发银行' }])

    const skipped = await runCandidateRecovery(recovered.response, request)
    expect(request).toHaveBeenCalledOnce()
    expect(skipped.aiResult).toBeNull()
    expect(skipped.entries).toEqual([{ code: '600000', name: '浦发银行' }])
  })

  it('候选恢复调用失败时不生成伪补充结果', async () => {
    const original = '首轮结果仍应保留\nSTOCK_CODES: NONE'
    await expect(runCandidateRecovery(original, async () => {
      throw new Error('upstream timeout')
    })).rejects.toThrow('upstream timeout')
    expect(original).toBe('首轮结果仍应保留\nSTOCK_CODES: NONE')
  })
})
