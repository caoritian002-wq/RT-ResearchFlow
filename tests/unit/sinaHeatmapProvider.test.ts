import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  responses: [] as Array<{ status: number; body: string }>,
}))

vi.mock('https', () => ({
  request: mocks.request,
}))

function installRequestMock(): void {
  mocks.request.mockImplementation((_options: unknown, onResponse: (response: EventEmitter) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      end: () => void
      destroy: (error: Error) => void
    }
    request.end = () => {
      const next = mocks.responses.shift()
      if (!next) {
        request.emit('error', new Error('NO_MOCK_RESPONSE'))
        return
      }
      const response = new EventEmitter() as EventEmitter & { statusCode: number }
      response.statusCode = next.status
      onResponse(response)
      queueMicrotask(() => {
        response.emit('data', Buffer.from(next.body, 'utf8'))
        response.emit('end')
      })
    }
    request.destroy = (error: Error) => request.emit('error', error)
    return request
  })
}

const industryListBody = `var S_Finance_bankuai_sinaindustry = {
  "hangye_ZC39":"hangye_ZC39,计算机通信和其他电子设备,100,0,0,1.25,0,100000000000,0,0,0,0,0",
  "hangye_ZC38":"hangye_ZC38,电气机械和器材,80,0,0,-0.50,0,80000000000,0,0,0,0,0"
}`

beforeEach(() => {
  vi.resetModules()
  mocks.request.mockReset()
  mocks.responses.length = 0
  installRequestMock()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('FR-263 新浪行业云图轻量刷新与按需成分', () => {
  it('主快照只请求一次行业总表，L1不预取成分股', async () => {
    mocks.responses.push({ status: 200, body: industryListBody })
    const { fetchSinaSnapshot } = await import('../../electron/main/services/sinaHeatmapProvider')

    const snapshot = await fetchSinaSnapshot()

    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(snapshot.industries).toHaveLength(2)
    expect(snapshot.industries.every(industry => industry.stocks.length === 0)).toBe(true)
    expect(snapshot.industries.flatMap(industry => industry.subIndustries ?? [])).toHaveLength(2)
  })

  it('L2首次读取才请求成分接口并按涨跌幅排序', async () => {
    mocks.responses.push({
      status: 200,
      body: JSON.stringify([
        { symbol: 'sz000001', name: '平安银行', trade: '10.00', changepercent: '-1.20', mktcap: '100' },
        { symbol: 'sh600000', name: '浦发银行', trade: '9.00', changepercent: '2.50', mktcap: '120' },
      ]),
    })
    const { fetchSinaIndustryConstituents } = await import('../../electron/main/services/sinaHeatmapProvider')

    const stocks = await fetchSinaIndustryConstituents('hangye_ZJ66')

    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(stocks.map(stock => stock.code)).toEqual(['SH600000', 'SZ000001'])
    expect(stocks[0].marketCap).toBe(1_200_000)
  })

  it.each([403, 429, 456])('HTTP %s不快速重试并进入共享冷却', async (status) => {
    mocks.responses.push({ status, body: '' })
    const { fetchSinaSnapshot } = await import('../../electron/main/services/sinaHeatmapProvider')

    await expect(fetchSinaSnapshot()).rejects.toThrow(`SINA_RATE_LIMITED_${status}`)
    await expect(fetchSinaSnapshot()).rejects.toThrow('SINA_RATE_LIMIT_COOLDOWN')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
})
