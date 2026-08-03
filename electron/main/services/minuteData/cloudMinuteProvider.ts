import type { MinuteDataProvider, MinuteDataRequest, MinuteDataResult } from './minuteDataTypes'

const cloudMinuteCapability = {
  providerId: 'cloudPro1m',
  label: '云端Pro 1分钟',
  source: 'cloudPro' as const,
  granularity: '1m' as const,
  historyDepthDays: null,
  coverage: 'allMarket' as const,
  reliability: 'cached' as const,
  isApproximate: false,
  requiresCredential: true,
  isCloud: true,
  enabled: false,
  note: '预留能力, 服务端未配置或用户未登录时不可用',
}

export const cloudMinuteProvider: MinuteDataProvider = {
  capability: cloudMinuteCapability,
  async fetchBars(_request: MinuteDataRequest): Promise<MinuteDataResult> {
    return {
      status: 'unavailable',
      bars: [],
      capability: cloudMinuteCapability,
      message: '云端分钟数据服务尚未配置',
    }
  },
}

export function getCloudMinuteStatus() {
  return {
    configured: false,
    signedIn: false,
    plan: 'none',
    capabilities: [],
    message: '云端分钟数据服务尚未配置',
  }
}