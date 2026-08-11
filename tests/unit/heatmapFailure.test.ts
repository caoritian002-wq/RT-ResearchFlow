import { describe, expect, it } from 'vitest'
import { buildHeatmapFailureMessage } from '../../src/utils/heatmapFailure'

describe('FR-263 行业云图刷新失败表达', () => {
  it('已有快照时保留缓存并隐藏底层错误', () => {
    const message = buildHeatmapFailureMessage(
      'sina',
      { code: 'UPSTREAM_RATE_LIMITED', message: 'HTTP 456 at upstream' },
      true,
    )

    expect(message).toBe('新浪财经触发临时限频，继续展示现有缓存')
    expect(message).not.toContain('456')
    expect(message).not.toContain('HTTP')
  })

  it('没有快照时给出可操作的重试提示', () => {
    expect(buildHeatmapFailureMessage('eastmoney', { code: 'UPSTREAM_TIMEOUT' }, false))
      .toBe('东方财富刷新超时，请稍后重试')
  })

  it('保留Tushare权限不足的专用识别语义', () => {
    expect(buildHeatmapFailureMessage(
      'tushare',
      { code: 'UPSTREAM_ERROR', message: 'TUSHARE_QUOTA_INSUFFICIENT' },
      false,
    )).toBe('Tushare 申万实时行情权限不足')
  })
})
