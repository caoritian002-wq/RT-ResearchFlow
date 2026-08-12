export type HeatmapProviderId = 'sina' | 'eastmoney' | 'tushare'

interface HeatmapFailure {
  code?: string
  message?: string
}

const PROVIDER_LABELS: Record<HeatmapProviderId, string> = {
  sina: '新浪财经',
  eastmoney: '东方财富',
  tushare: 'Tushare 申万',
}

export function buildHeatmapFailureMessage(
  provider: HeatmapProviderId,
  failure: HeatmapFailure,
  hasSnapshot: boolean,
): string {
  const label = PROVIDER_LABELS[provider]
  const detail = `${failure.code ?? ''} ${failure.message ?? ''}`.toLowerCase()

  if (
    provider === 'tushare' &&
    /权限|套餐|积分|quota|tushare_quota_insufficient/.test(detail)
  ) {
    return 'Tushare 申万实时行情权限不足'
  }

  let reason = '暂时无法刷新'
  if (failure.code === 'UPSTREAM_TIMEOUT') reason = '刷新超时'
  if (failure.code === 'UPSTREAM_RATE_LIMITED') reason = '触发临时限频'
  if (failure.code === 'EMPTY_DATA') reason = '本次未返回有效数据'

  return hasSnapshot
    ? `${label}${reason}，继续展示现有缓存`
    : `${label}${reason}，请稍后重试`
}
