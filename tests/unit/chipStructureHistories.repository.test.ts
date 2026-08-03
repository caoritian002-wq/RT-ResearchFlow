import { describe, expect, it, vi } from 'vitest'
import { queryChipHistories } from '../../electron/main/database/cyqChipsCacheRepository'
import { listCyqPerfHistories } from '../../electron/main/database/cyqPerfCacheRepository'

describe('筹码结构批量历史仓库', () => {
  it('价格级筹码按日期合并代码别名并以带后缀记录覆盖同日旧数据', () => {
    const all = vi.fn().mockReturnValue([
      { ts_code: '600000', trade_date: '20260701', price: 9, percent: 100 },
      { ts_code: '600000', trade_date: '20260702', price: 9.5, percent: 100 },
      { ts_code: '600000.SH', trade_date: '20260702', price: 10, percent: 100 },
      { ts_code: '600000.SH', trade_date: '20260703', price: 10.5, percent: 100 },
    ])
    const db = { prepare: () => ({ all }) }

    const history = queryChipHistories(db as never, ['600000.SH']).get('600000.SH')!

    expect([...history.keys()]).toEqual(['20260701', '20260702', '20260703'])
    expect(history.get('20260702')).toEqual([{ price: 10, percent: 100 }])
  })

  it('价格级筹码显式日期查询只读取目标交易日', () => {
    let preparedSql = ''
    const all = vi.fn().mockReturnValue([{
      ts_code: '600000.SH',
      trade_date: '20260701',
      price: 10,
      percent: 100,
    }])
    const db = {
      prepare(sql: string) {
        preparedSql = sql
        return { all }
      },
    }

    const histories = queryChipHistories(db as never, ['600000.SH'], 1, '20260701')

    expect(preparedSql).toContain('trade_date = ?')
    expect(preparedSql).not.toContain('ROW_NUMBER()')
    expect(all).toHaveBeenCalledWith('600000.SH', '600000', '20260701')
    expect([...histories.get('600000.SH')!.keys()]).toEqual(['20260701'])
  })

  it('官方成本显式日期查询只读取目标交易日', () => {
    let preparedSql = ''
    const all = vi.fn().mockReturnValue([{
      ts_code: '600000.SH',
      trade_date: '20260701',
      his_low: 8,
      his_high: 12,
      cost_5pct: 8.5,
      cost_15pct: 9,
      cost_50pct: 10,
      cost_85pct: 11,
      cost_95pct: 11.5,
      weight_avg: 10,
      winner_rate: 60,
      winner_rate_unit: 'percent',
      fetched_at: 1000,
    }])
    const db = {
      prepare(sql: string) {
        preparedSql = sql
        return { all }
      },
    }

    const histories = listCyqPerfHistories(db as never, ['600000.SH'], 1, '20260701')

    expect(preparedSql).toContain('trade_date = ?')
    expect(preparedSql).not.toContain('ROW_NUMBER()')
    expect(all).toHaveBeenCalledWith('600000.SH', '600000', '20260701')
    expect(histories.get('600000.SH')?.map((row) => row.tradeDate)).toEqual(['20260701'])
  })

  it('官方成本按日期合并代码别名并以带后缀记录覆盖同日旧数据', () => {
    const makeRow = (tsCode: string, tradeDate: string, winnerRate: number) => ({
      ts_code: tsCode,
      trade_date: tradeDate,
      his_low: 8,
      his_high: 12,
      cost_5pct: 8.5,
      cost_15pct: 9,
      cost_50pct: 10,
      cost_85pct: 11,
      cost_95pct: 11.5,
      weight_avg: 10,
      winner_rate: winnerRate,
      winner_rate_unit: 'percent',
      fetched_at: 1000,
    })
    const all = vi.fn().mockReturnValue([
      makeRow('600000', '20260701', 50),
      makeRow('600000', '20260702', 55),
      makeRow('600000.SH', '20260702', 60),
      makeRow('600000.SH', '20260703', 65),
    ])
    const db = { prepare: () => ({ all }) }

    const history = listCyqPerfHistories(db as never, ['600000.SH']).get('600000.SH')!

    expect(history.map((row) => row.tradeDate)).toEqual(['20260701', '20260702', '20260703'])
    expect(history.find((row) => row.tradeDate === '20260702')?.winnerRate).toBe(60)
  })
})