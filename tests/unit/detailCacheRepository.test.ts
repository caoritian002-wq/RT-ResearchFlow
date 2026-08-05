import { describe, expect, it } from 'vitest'
import { hasUsableDetailContent } from '../../electron/main/database/detailCacheRepository'

describe('详情正文缓存', () => {
  it('不把历史空内容当作可复用的成功缓存', () => {
    expect(hasUsableDetailContent('')).toBe(false)
    expect(hasUsableDetailContent('   \n')).toBe(false)
    expect(hasUsableDetailContent('<p>正文</p>')).toBe(true)
  })
})
