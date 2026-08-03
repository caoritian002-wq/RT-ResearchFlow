import type { MinuteDataCapability, MinuteDataProvider, MinuteDataResult, MinuteDataUnifiedRequest, MinuteUserTier } from './minuteDataTypes'
import type { MinuteDataRequest } from './minuteDataTypes'
import { cloudMinuteProvider, getCloudMinuteStatus } from './cloudMinuteProvider'
import { sinaHistory5mProvider } from './sinaHistory5mProvider'

const providers: MinuteDataProvider[] = [sinaHistory5mProvider, cloudMinuteProvider]

export function listMinuteDataCapabilities(): { defaultProvider: string; providers: MinuteDataCapability[] } {
  return {
    defaultProvider: sinaHistory5mProvider.capability.providerId,
    providers: providers.map(provider => provider.capability),
  }
}

export function getMinuteCloudStatus() {
  return getCloudMinuteStatus()
}

export async function fetchApproximateHistoryMinuteBars(request: MinuteDataRequest): Promise<MinuteDataResult> {
  return sinaHistory5mProvider.fetchBars(request)
}

export function resolveMinuteUserTier(value: unknown): MinuteUserTier {
  return value === 'pro' ? 'pro' : 'free'
}

function withQuality(result: MinuteDataResult): MinuteDataResult {
  return {
    ...result,
    coverageStatus: result.status === 'success' ? 'complete' : result.status === 'empty' ? 'empty' : result.status === 'unavailable' ? 'unavailable' : 'partial',
    qualityNote: result.qualityNote ?? result.message ?? result.capability.note,
  }
}

export async function fetchMinuteBarsForUserTier(request: MinuteDataUnifiedRequest): Promise<MinuteDataResult> {
  const userTier = resolveMinuteUserTier(request.userTier)
  const allowApproximate = request.allowApproximate !== false

  if (userTier === 'free') {
    if (!allowApproximate && request.preferredGranularity === '1m') {
      return {
        status: 'unavailable',
        bars: [],
        capability: sinaHistory5mProvider.capability,
        message: '免费用户当前仅提供5分钟历史近似能力, 本次请求禁止近似评估',
        coverageStatus: 'unavailable',
        qualityNote: '免费层没有可用的历史1分钟精确数据',
      }
    }
    return withQuality(await sinaHistory5mProvider.fetchBars(request))
  }

  const exact = await cloudMinuteProvider.fetchBars(request)
  if (exact.status === 'success' || !allowApproximate) return withQuality(exact)

  const fallback = await sinaHistory5mProvider.fetchBars(request)
  return withQuality({
    ...fallback,
    message: fallback.message ?? '云端1分钟能力暂不可用, 已按允许近似策略回落到免费5分钟历史数据',
    qualityNote: '云端1分钟能力暂不可用, 本次使用5分钟历史分钟线近似评估',
  })
}

export function getDefaultApproximateCapability(): MinuteDataCapability {
  return sinaHistory5mProvider.capability
}