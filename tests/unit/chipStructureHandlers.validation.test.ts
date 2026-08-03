import { beforeAll, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
}))

import {
  dedupeChipStructureMonitorStocks,
  registerChipStructureHandlers,
  validChipStructureDate,
  validateChipStructureTsCodes,
} from '../../electron/main/ipc/chipStructureHandlers'

type IpcHandler = (event: unknown, payload?: unknown) => unknown

function getHandler(channel: string): IpcHandler {
  const registration = handleMock.mock.calls.find(([registeredChannel]) => registeredChannel === channel)
  if (!registration) throw new Error(`未注册 IPC: ${channel}`)
  return registration[1] as IpcHandler
}

beforeAll(() => {
  registerChipStructureHandlers()
})

describe('chipStructureHandlers 参数校验', () => {
  it('拒绝格式正确但日历中不存在的日期', () => {
    expect(validChipStructureDate('20260228')).toBe(true)
    expect(validChipStructureDate('20260229')).toBe(false)
    expect(validChipStructureDate('20261301')).toBe(false)
  })

  it('显式股票列表必须包含 1 到 500 只有效股票', () => {
    expect(validateChipStructureTsCodes([])).toEqual({ ok: false, errorCode: 'INVALID_PARAM' })
    expect(validateChipStructureTsCodes(Array.from({ length: 501 }, () => '600000.SH'))).toEqual({
      ok: false,
      errorCode: 'TOO_MANY_STOCKS',
    })
    expect(validateChipStructureTsCodes(['600000', '920001.BJ', 'bad'])).toEqual({
      ok: false,
      errorCode: 'INVALID_PARAM',
    })
    expect(validateChipStructureTsCodes(['600000', '600000.SH', '920001'])).toEqual({
      ok: true,
      tsCodes: ['600000.SH', '920001.BJ'],
    })
  })

  it('refresh 拒绝非法 force、显式空列表和超限列表', () => {
    const handler = getHandler('chipStructure:refresh')
    expect(handler({}, { force: null })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAM' },
    })
    expect(handler({}, { tsCodes: null })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAM' },
    })
    expect(handler({}, { tsCodes: [] })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAM' },
    })
    expect(handler({}, { tsCodes: Array.from({ length: 501 }, () => '600000.SH') })).toMatchObject({
      ok: false,
      error: { code: 'TOO_MANY_STOCKS' },
    })
  })

  it('批量摘要分别校验事实日期和业务参考日期', () => {
    const handler = getHandler('chipStructure:getSummaries')
    expect(handler({}, { tsCodes: ['600000.SH'], tradeDate: '20260229' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAM', message: '交易日期无效' },
    })
    expect(handler({}, { tsCodes: ['600000.SH'], referenceTradeDate: '20261301' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAM', message: '业务参考日期无效' },
    })
    expect(handler({}, { tsCodes: ['600000.SH'], selectionPolicy: 'oldest_complete' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAM', message: '筹码摘要选择策略无效' },
    })
  })

  it('规范化重复代码并按来源优先级保留监控记录', () => {
    const uniqueRows = Array.from({ length: 121 }, (_, index) => ({
      tsCode: `${String(600000 + index).padStart(6, '0')}.SH`,
      source: 'watchlist' as const,
      stockName: `股票${index}`,
      addedAt: index,
    }))
    const rows = [
      ...uniqueRows,
      { ...uniqueRows[0], tsCode: '600000', source: 'screener' as const, addedAt: 200 },
      { ...uniqueRows[1], tsCode: '600001.SH', source: 'portfolio' as const, addedAt: 1 },
    ]

    const deduped = dedupeChipStructureMonitorStocks(rows)

    expect(rows).toHaveLength(123)
    expect(deduped).toHaveLength(121)
    expect(deduped.find((row) => row.tsCode === '600000.SH')?.source).toBe('screener')
    expect(deduped.find((row) => row.tsCode === '600001.SH')?.source).toBe('portfolio')
  })
})
