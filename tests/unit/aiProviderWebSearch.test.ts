import { describe, expect, it } from 'vitest'
import {
  findExcludedWebSearchCitations,
  normalizeOpenAIWebSearchTrace,
} from '../../electron/main/services/aiProvider'

describe('OpenAI Responses 网页搜索轨迹', () => {
  it('保留搜索、打开页面、页内查找和正文引用，并去重来源 URL', () => {
    const trace = normalizeOpenAIWebSearchTrace({
      id: 'resp-search-1',
      output: [
        {
          id: 'call-search',
          type: 'web_search_call',
          status: 'completed',
          action: {
            type: 'search',
            query: '光纤供需 2026',
            queries: ['光纤供需 2026', '运营商集采 光缆'],
            sources: [
              { type: 'url', url: 'https://example.com/report' },
              { type: 'url', url: 'https://example.com/report' },
              { type: 'url', url: 'javascript:alert(1)' },
            ],
          },
        },
        {
          id: 'call-open',
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'open_page', url: 'https://official.example.cn/notice' },
        },
        {
          id: 'call-find',
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'find_in_page', url: 'https://official.example.cn/notice', pattern: '中标数量' },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: '供需正在改善。',
            annotations: [{
              type: 'url_citation',
              url: 'https://example.com/report',
              title: '2026 光纤供需报告',
              start_index: 0,
              end_index: 8,
            }],
          }],
        },
      ],
    })

    expect(trace.responseId).toBe('resp-search-1')
    expect(trace.calls.map((call) => call.action.type)).toEqual(['search', 'open_page', 'find_in_page'])
    expect(trace.calls[0].action.queries).toEqual(['光纤供需 2026', '运营商集采 光缆'])
    expect(trace.calls[2].action.pattern).toBe('中标数量')
    expect(trace.citations).toEqual([{
      url: 'https://example.com/report',
      title: '2026 光纤供需报告',
      startIndex: 0,
      endIndex: 8,
    }])
    expect(trace.sources).toEqual([
      { url: 'https://example.com/report', title: '2026 光纤供需报告', cited: true },
      { url: 'https://official.example.cn/notice', title: null, cited: false },
    ])
    expect(findExcludedWebSearchCitations(trace, ['https://example.com/report'])).toEqual([
      'https://example.com/report',
    ])
    expect(findExcludedWebSearchCitations(trace, ['https://unrelated.example.com'])).toEqual([])
  })
})
