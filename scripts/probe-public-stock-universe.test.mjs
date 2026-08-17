import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deduplicateStockUniverse,
  transformSinaStockUniverseRows,
} from './lib/public-stock-universe-transformer.mjs'

test('Sina universe transformer keeps only normalized security identity fields', () => {
  const result = transformSinaStockUniverseRows([
    { symbol: 'sh600000', code: '600000', name: '浦发银行', trade: '10.00', amount: 123456 },
    { symbol: 'sz000001', code: '000001', name: '平安银行', trade: '11.00' },
    { symbol: 'bj920000', code: '920000', name: '安徽凤凰', turnoverratio: 1.2 },
    { symbol: 'bad', code: '123', name: '' },
  ])
  assert.deepEqual(result.rows.map((row) => row.tsCode), ['600000.SH', '000001.SZ', '920000.BJ'])
  assert.deepEqual(result.rows.map((row) => row.market), ['主板', '主板', '北交所'])
  assert.equal(result.rows[0].circFloat, null)
  assert.equal('trade' in result.rows[0], false)
  assert.equal(result.rejected.length, 1)
})

test('Sina universe transformer maps exchange identities onto project market boards', () => {
  const result = transformSinaStockUniverseRows([
    { symbol: 'sz300750', code: '300750', name: '宁德时代' },
    { symbol: 'sh688981', code: '688981', name: '中芯国际' },
    { symbol: 'sz002594', code: '002594', name: '比亚迪' },
  ])
  assert.deepEqual(result.rows.map((row) => row.market), ['创业板', '科创板', '主板'])
})

test('Universe deduplication reports conflicting names without replacing the first fact', () => {
  const base = { market: '主板', listStatus: 'L', industry: null, circFloat: null, source: 'sina-market-center-hs-a' }
  const result = deduplicateStockUniverse([
    { ...base, tsCode: '600000.SH', name: '浦发银行' },
    { ...base, tsCode: '600000.SH', name: '名称冲突' },
  ])
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].name, '浦发银行')
  assert.equal(result.conflicts.length, 1)
})
