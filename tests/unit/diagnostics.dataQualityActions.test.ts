import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDataSourceConfig: vi.fn(),
  decryptApiKey: vi.fn(),
  syncTradeCalFull: vi.fn(),
  persistDataQualitySnapshot: vi.fn(),
}))

vi.mock('../../electron/main/database/dataSourceRepository', () => ({
  getDataSourceConfig: mocks.getDataSourceConfig,
}))
vi.mock('../../electron/main/utils/apiKeyEncryption', () => ({
  decryptApiKey: mocks.decryptApiKey,
}))
vi.mock('../../electron/main/services/tradeCalSyncService', () => ({
  syncTradeCalFull: mocks.syncTradeCalFull,
}))
vi.mock('../../electron/main/services/dataQualityService', () => ({
  CORE_BENCHMARK_CODES: ['000001.SH', '399001.SZ', '399006.SZ', '000300.SH'],
  getDataQualitySnapshot: vi.fn(),
  persistDataQualitySnapshot: mocks.persistDataQualitySnapshot,
}))

import { runDiagnosticAction } from '../../electron/main/services/diagnosticsService'

describe('diagnostics data-quality actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDataSourceConfig.mockReturnValue({ tushareEnabled: true, tushareTokenEncrypted: 'encrypted-token' })
    mocks.decryptApiKey.mockReturnValue('plain-token')
    mocks.persistDataQualitySnapshot.mockReturnValue({})
  })

  it('交易日历同步成功时返回真实写入数量并保存检查快照', async () => {
    mocks.syncTradeCalFull.mockResolvedValue({ status: 'completed', rowCount: 1323 })

    await expect(runDiagnosticAction({} as never, 'syncTradeCalendar')).resolves.toEqual({
      action: 'syncTradeCalendar',
      status: 'completed',
      message: '交易日历同步完成，写入 1323 条并重新检查',
    })
    expect(mocks.persistDataQualitySnapshot).toHaveBeenCalledOnce()
  })

  it.each([
    ['empty', 'TRADE_CAL_SYNC_EMPTY'],
    ['failed', 'TRADE_CAL_SYNC_FAILED'],
  ] as const)('交易日历同步终态为 %s 时不误报完成', async (status, errorCode) => {
    mocks.syncTradeCalFull.mockResolvedValue({ status, rowCount: 0 })

    await expect(runDiagnosticAction({} as never, 'syncTradeCalendar')).rejects.toThrow(errorCode)
    expect(mocks.persistDataQualitySnapshot).toHaveBeenCalledOnce()
  })
})
