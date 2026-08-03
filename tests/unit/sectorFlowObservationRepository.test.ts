import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  getLatestVerifiedObservationDateBefore,
  getPreviousVerifiedFlowMap,
  getVerifiedFlowsByBoardNames,
  listSectorFlowObservations,
  upsertSectorFlowObservations,
} from '../../electron/main/database/sectorFlowObservationRepository'
import type { SectorFlowItem } from '../../electron/main/services/sectorFlowTypes'

function flowItem(flow: number, name = '算力'): SectorFlowItem {
  return {
    boardCode: 'BK1000', boardName: name, scope: 'concept', metricMode: 'verified_flow',
    totalAmount: 10_000_000_000, turnoverDirectionStrength: null,
    mainNetInflow: flow, mainNetInflowRate: flow / 10_000_000_000 * 100,
    superLargeNetInflow: flow / 2, superLargeNetInflowRate: 2,
    largeNetInflow: flow / 2, largeNetInflowRate: 2,
    mediumNetInflow: -10, mediumNetInflowRate: -1,
    smallNetInflow: -20, smallNetInflowRate: -2,
    weightedChange: 2, totalMarketCap: 100_000_000_000,
    memberCount: 10, upCount: 8, downCount: 2, flatCount: 0,
    previousMainNetInflow: null,
    leader: { tsCode: '000001.SZ', name: '平安银行', change: 3, totalAmount: 100, mainNetInflow: 50, mainNetInflowRate: 5 },
    coreStocks: [], relatedThemes: [], sourceUpdatedAt: 1_784_792_372_000,
  }
}

describe('FR-243 板块资金观察仓库', () => {
  it('同日同板块幂等更新，并读取前一日真实主力资金', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      upsertSectorFlowObservations(db, '20260722', 'eastmoney', [flowItem(300_000_000)], 1)
      upsertSectorFlowObservations(db, '20260723', 'eastmoney', [flowItem(500_000_000)], 2)
      upsertSectorFlowObservations(db, '20260723', 'eastmoney', [flowItem(600_000_000, '算力硬件')], 3)
      upsertSectorFlowObservations(db, '20260724', 'eastmoney', [flowItem(700_000_000, '未来资金')], 4)

      expect(listSectorFlowObservations(db, '20260723')).toHaveLength(1)
      expect(listSectorFlowObservations(db, '20260723')[0]).toMatchObject({
        boardName: '算力硬件', mainNetInflow: 600_000_000,
      })
      expect(getPreviousVerifiedFlowMap(db, '20260723').get('concept:BK1000')).toBe(300_000_000)
      expect(getLatestVerifiedObservationDateBefore(db, '20260723')).toBe('20260722')
      expect(getLatestVerifiedObservationDateBefore(db, '20260724')).toBe('20260723')
      const latestFlows = getVerifiedFlowsByBoardNames(db, ['未来资金'])
      expect(latestFlows[0]).toMatchObject({
        boardName: '未来资金', mainNetInflow: 700_000_000, tradeDate: '20260724',
      })
      expect(latestFlows[0].mainNetInflowRate).toBeCloseTo(7)
    } finally {
      db.close()
    }
  })
})
