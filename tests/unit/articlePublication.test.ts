import { describe, expect, it } from 'vitest'
import {
  canonicalizeArticleUrl,
  extractPublishedAtFromText,
  inferPublishedAtFromUrl,
  isLikelyArticleTitle,
  validatePublicationTime,
} from '../../electron/main/services/articlePublication'

describe('资讯发布时间与链接规范化', () => {
  it('移除锚点和常见跟踪参数，同时保留业务参数', () => {
    expect(canonicalizeArticleUrl(
      'https://Example.com/news/item/?utm_source=feed&id=42&from=home#comments'
    )).toBe('https://example.com/news/item?id=42')
  })

  it('从主要资讯来源URL恢复北京时间日期', () => {
    expect(inferPublishedAtFromUrl('https://www.21jingji.com/article/20260720/herald/abc.html')).toEqual({
      publishedAt: Date.parse('2026-07-20T00:00:00+08:00'),
      status: 'date_only',
    })
    expect(inferPublishedAtFromUrl('https://finance.caixin.com/2026-07-21/102000.html')).toEqual({
      publishedAt: Date.parse('2026-07-21T00:00:00+08:00'),
      status: 'date_only',
    })
    expect(inferPublishedAtFromUrl('http://finance.people.com.cn/n1/2026/0721/c1004-1.html')).toEqual({
      publishedAt: Date.parse('2026-07-21T00:00:00+08:00'),
      status: 'date_only',
    })
  })

  it('区分精确时间和只有日期的文本', () => {
    expect(extractPublishedAtFromText('发布时间：2026-07-25 12:54')).toEqual({
      publishedAt: Date.parse('2026-07-25T12:54:00+08:00'),
      status: 'exact',
    })
    expect(extractPublishedAtFromText('2026年7月21日')).toEqual({
      publishedAt: Date.parse('2026-07-21T00:00:00+08:00'),
      status: 'date_only',
    })
  })

  it('拒绝晚于采集时间的业务事件日期', () => {
    const collectedAt = Date.parse('2026-07-17T20:22:00+08:00')
    const eventDate = extractPublishedAtFromText('2026-09-01')
    const futureUrlDate = inferPublishedAtFromUrl(
      'https://example.com/2027/01/01/policy.html',
    )

    expect(validatePublicationTime(eventDate, collectedAt)).toBeNull()
    expect(validatePublicationTime(futureUrlDate, collectedAt)).toBeNull()
  })

  it('业务日期无效时仍可接受来源URL中的真实发布日期', () => {
    const collectedAt = Date.parse('2026-04-30T10:56:47+08:00')
    const eventDate = extractPublishedAtFromText('2026-07-01')
    const urlDate = inferPublishedAtFromUrl(
      'https://www.21jingji.com/article/20260430/herald/example.html',
    )

    expect(validatePublicationTime(eventDate, collectedAt)).toBeNull()
    expect(validatePublicationTime(urlDate, collectedAt)).toEqual({
      publishedAt: Date.parse('2026-04-30T00:00:00+08:00'),
      status: 'date_only',
    })
  })

  it('同一日期只容忍小幅源站时钟偏差', () => {
    const collectedAt = Date.parse('2026-07-25T12:00:00+08:00')
    const fiveMinutesAhead = extractPublishedAtFromText('2026-07-25 12:05')
    const twoHoursAhead = extractPublishedAtFromText('2026-07-25 14:00')

    expect(validatePublicationTime(fiveMinutesAhead, collectedAt)).toEqual(fiveMinutesAhead)
    expect(validatePublicationTime(twoHoursAhead, collectedAt)).toBeNull()
  })

  it('过滤评论计数和导航文本', () => {
    expect(isLikelyArticleTitle('评论(0)')).toBe(false)
    expect(isLikelyArticleTitle('查看更多')).toBe(false)
    expect(isLikelyArticleTitle('工信部发布新一轮行业规范')).toBe(true)
  })
})
