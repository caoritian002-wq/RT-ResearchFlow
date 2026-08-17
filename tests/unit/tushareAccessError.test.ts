import { describe, expect, it } from 'vitest'
import { getTushareAccessErrorCode } from '../../electron/main/services/tushareService'

describe('Tushare access error classification', () => {
  it('限频文案优先于其中包含的权限字样', () => {
    expect(getTushareAccessErrorCode(new Error('抱歉，您每分钟最多访问该接口 2 次，当前权限请稍后再试')))
      .toBe('TUSHARE_RATE_LIMITED')
    expect(getTushareAccessErrorCode(new Error('HTTP_429'))).toBe('TUSHARE_RATE_LIMITED')
  })

  it('区分积分、认证和超时', () => {
    expect(getTushareAccessErrorCode(new Error('抱歉，积分不足，您没有访问该接口的权限')))
      .toBe('TUSHARE_QUOTA_INSUFFICIENT')
    expect(getTushareAccessErrorCode(new Error('您输入的 token 无效'))).toBe('TUSHARE_AUTH_FAILED')
    expect(getTushareAccessErrorCode(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      .toBe('TUSHARE_REQUEST_TIMEOUT')
  })
})
