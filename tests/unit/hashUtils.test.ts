import { describe, it, expect } from 'vitest'
import { sha256, simhash, hammingDistance } from '../../electron/main/utils/hashUtils'

describe('sha256', () => {
  it('produces consistent 64-char hex output', () => {
    const hash = sha256('hello world')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic', () => {
    expect(sha256('test')).toBe(sha256('test'))
  })

  it('produces different hashes for different inputs', () => {
    expect(sha256('aaa')).not.toBe(sha256('bbb'))
  })
})

describe('simhash', () => {
  it('produces a 16-char hex string', () => {
    const h = simhash('降息25基点货币政策调整')
    expect(h).toHaveLength(16)
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  it('is deterministic', () => {
    expect(simhash('测试文本')).toBe(simhash('测试文本'))
  })

  it('similar texts have smaller Hamming distance than unrelated texts', () => {
    const h1 = simhash('央行宣布降息货币政策调整')
    const h2 = simhash('央行宣布降息货币政策宽松')
    const h3 = simhash('今日天气晴朗适合出游放风筝')
    const distSimilar = hammingDistance(h1, h2)
    const distDifferent = hammingDistance(h1, h3)
    expect(distSimilar).toBeLessThan(distDifferent)
  })

  it('different texts have large Hamming distance', () => {
    const h1 = simhash('央行货币政策降息')
    const h2 = simhash('股市今日大涨科技板块领涨')
    const dist = hammingDistance(h1, h2)
    expect(dist).toBeGreaterThan(3)
  })
})

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    const h = simhash('any text')
    expect(hammingDistance(h, h)).toBe(0)
  })

  it('returns a number between 0 and 64', () => {
    const h1 = simhash('aaa')
    const h2 = simhash('zzz')
    const dist = hammingDistance(h1, h2)
    expect(dist).toBeGreaterThanOrEqual(0)
    expect(dist).toBeLessThanOrEqual(64)
  })
})
