import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATABASE_MIGRATIONS, runMigrations } from '../../electron/main/database/db'
import {
  getMarketResonanceSnapshotRecord,
  listMarketResonanceSnapshotDates,
  saveMarketResonanceSnapshot,
} from '../../electron/main/database/marketResonanceSnapshotRepository'

function snapshotJson(
  tradeDate: string,
  dataMode: 'archive' | 'partial',
  coverageAvailable: number,
  sectorCount = 31,
  coverage = {
    benchmarkTrends: { available: 3, total: 3 },
    sectorTrends: { available: 31, total: 31 },
    boardFacts: { available: coverageAvailable, total: 31 },
  },
): string {
  return JSON.stringify({
    tradeDate,
    dataMode,
    sourceMode: 'network_backfill',
    sourceLabel: '测试存档',
    generatedAt: 1_786_093_200_000,
    coverage: { available: coverageAvailable, total: 31, ...coverage },
    benchmarks: [{ tradeDate }],
    sectors: Array.from({ length: sectorCount }, () => ({ tradeDate })),
  })
}

describe('FR-261 市场共振日快照仓储', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db, DATABASE_MIGRATIONS.filter((migration) => migration.version === 136))
  })

  afterEach(() => db.close())

  it('保存完整快照并校验SHA-256', () => {
    const saved = saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807',
      dataMode: 'archive',
      sourceLabel: '测试存档',
      coverageAvailable: 31,
      coverageTotal: 31,
      snapshotJson: snapshotJson('20260807', 'archive', 31),
      capturedAt: 1_786_093_200_000,
    })

    expect(saved.snapshotSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(getMarketResonanceSnapshotRecord(db, '20260807')).toEqual(saved)

    db.prepare(`
      UPDATE market_resonance_daily_snapshots
      SET snapshot_json = '{"tampered":true}'
      WHERE trade_date = '20260807'
    `).run()
    expect(() => getMarketResonanceSnapshotRecord(db, '20260807'))
      .toThrow('MARKET_RESONANCE_ARCHIVE_CORRUPTED')
  })

  it('低覆盖旧数据不能覆盖高覆盖存档', () => {
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'archive', sourceLabel: '完整',
      coverageAvailable: 31, coverageTotal: 31,
      snapshotJson: snapshotJson('20260807', 'archive', 31), capturedAt: 20,
    })
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'partial', sourceLabel: '降级',
      coverageAvailable: 10, coverageTotal: 31,
      snapshotJson: snapshotJson('20260807', 'partial', 10), capturedAt: 30,
    })

    expect(getMarketResonanceSnapshotRecord(db, '20260807')).toMatchObject({
      dataMode: 'archive',
      sourceLabel: '完整',
      coverageAvailable: 31,
      snapshotJson: snapshotJson('20260807', 'archive', 31),
    })
  })

  it('部分补采不能替换完整存档', () => {
    const completeJson = snapshotJson('20260807', 'archive', 31)
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'archive', sourceLabel: '完整',
      coverageAvailable: 31, coverageTotal: 31, snapshotJson: completeJson, capturedAt: 20,
    })
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'partial', sourceLabel: '部分',
      coverageAvailable: 30, coverageTotal: 31,
      snapshotJson: snapshotJson('20260807', 'partial', 30), capturedAt: 30,
    })

    expect(getMarketResonanceSnapshotRecord(db, '20260807')).toMatchObject({
      dataMode: 'archive',
      sourceLabel: '完整',
      snapshotJson: completeJson,
    })
  })

  it('部分快照任一覆盖维度下降时不替换旧快照', () => {
    const retainedJson = snapshotJson('20260807', 'partial', 20, 31, {
      benchmarkTrends: { available: 3, total: 3 },
      sectorTrends: { available: 31, total: 31 },
      boardFacts: { available: 20, total: 31 },
    })
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'partial', sourceLabel: '旧快照',
      coverageAvailable: 20, coverageTotal: 31, snapshotJson: retainedJson, capturedAt: 20,
    })
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'partial', sourceLabel: '新但退化',
      coverageAvailable: 30, coverageTotal: 31,
      snapshotJson: snapshotJson('20260807', 'partial', 30, 31, {
        benchmarkTrends: { available: 3, total: 3 },
        sectorTrends: { available: 30, total: 31 },
        boardFacts: { available: 30, total: 31 },
      }),
      capturedAt: 30,
    })

    expect(getMarketResonanceSnapshotRecord(db, '20260807')).toMatchObject({
      sourceLabel: '旧快照',
      snapshotJson: retainedJson,
    })
  })

  it('部分快照所有覆盖维度不下降且至少一项提升时允许替换', () => {
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'partial', sourceLabel: '旧快照',
      coverageAvailable: 20, coverageTotal: 31,
      snapshotJson: snapshotJson('20260807', 'partial', 20), capturedAt: 20,
    })
    const improvedJson = snapshotJson('20260807', 'partial', 25)
    saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'partial', sourceLabel: '覆盖提升',
      coverageAvailable: 25, coverageTotal: 31, snapshotJson: improvedJson, capturedAt: 21,
    })

    expect(getMarketResonanceSnapshotRecord(db, '20260807')).toMatchObject({
      sourceLabel: '覆盖提升',
      coverageAvailable: 25,
      snapshotJson: improvedJson,
    })
  })

  it('拒绝写入日期或结构不一致的快照', () => {
    expect(() => saveMarketResonanceSnapshot(db, {
      tradeDate: '20260807', dataMode: 'archive', sourceLabel: '错误',
      coverageAvailable: 31, coverageTotal: 31,
      snapshotJson: snapshotJson('20260806', 'archive', 31), capturedAt: 20,
    })).toThrow('INVALID_MARKET_RESONANCE_SNAPSHOT')
  })

  it('按交易日倒序列出本地存档', () => {
    for (const [index, tradeDate] of ['20260806', '20260807'].entries()) {
      saveMarketResonanceSnapshot(db, {
        tradeDate, dataMode: 'archive', sourceLabel: '存档',
        coverageAvailable: 31, coverageTotal: 31,
        snapshotJson: snapshotJson(tradeDate, 'archive', 31), capturedAt: index + 1,
      })
    }
    expect(listMarketResonanceSnapshotDates(db)).toEqual(['20260807', '20260806'])
  })
})
