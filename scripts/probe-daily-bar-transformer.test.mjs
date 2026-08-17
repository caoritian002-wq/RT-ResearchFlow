import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareCanonicalSeries,
  transformEastmoneyDailySeries,
  transformSinaDailySeries,
  transformSinaMarketSnapshotRows,
  transformTencentDailySeries,
  validateCanonicalDailyBar,
} from './lib/canonical-daily-bar-transformer.mjs'

const eastmoneyRows = [
  '2026-08-13,57.50,57.25,58.10,56.80,1000000,5750000000.00,2.27,-0.44,-0.25,4.07',
  '2026-08-14,58.10,62.98,62.98,57.25,3182814,19196727611.00,10.01,10.01,5.73,12.97',
]

const sinaRows = [
  { day: '2026-08-13', open: '57.500', high: '58.100', low: '56.800', close: '57.250', volume: '100000000' },
  { day: '2026-08-14', open: '58.100', high: '62.980', low: '57.250', close: '62.980', volume: '318281407' },
]

const tencentRows = [
  ['2026-08-13', '57.500', '57.250', '58.100', '56.800', '1000000.000'],
  ['2026-08-14', '58.100', '62.980', '62.980', '57.250', '3182814.000'],
]

test('Eastmoney transformer converts CNY amount to CNY thousand and preserves hands', () => {
  const result = transformEastmoneyDailySeries('600487.SH', eastmoneyRows)
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[1].vol, 3182814)
  assert.equal(result.rows[1].amount, 19196727.611)
  assert.equal(result.rows[1].pctChg, 10.01)
  assert.equal(result.rows[1].turnoverRate, 12.97)
  const validation = validateCanonicalDailyBar(result.rows[1])
  assert.equal(validation.ok, true)
  assert.equal(validation.warnings.length, 0)
  assert.ok(validation.derived.averagePrice > 57.25)
  assert.ok(validation.derived.averagePrice < 62.98)
})

test('Sina transformer converts shares to hands and derives pctChg from previous close', () => {
  const result = transformSinaDailySeries('600487', sinaRows)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rejected[0].reasons[0], 'PCTCHG_MISSING')
  assert.equal(result.rows[0].tradeDate, '20260814')
  assert.equal(result.rows[0].vol, 3182814.07)
  assert.equal(result.rows[0].pctChg, 10.008734)
  assert.equal(result.rows[0].amount, null)
  assert.equal(result.rows[0].turnoverRate, null)
})

test('Normalized Eastmoney and Sina rows align after unit conversion', () => {
  const eastmoney = transformEastmoneyDailySeries('600487.SH', eastmoneyRows).rows
  const sina = transformSinaDailySeries('600487.SH', sinaRows).rows
  const comparison = compareCanonicalSeries(eastmoney, sina)
  assert.equal(comparison.overlapTradeDays, 1)
  assert.equal(comparison.maxPriceAbsoluteDiff, 0)
  assert.ok(comparison.maxPctChgPointDiff < 0.002)
  assert.ok(Math.abs(comparison.medianNormalizedVolumeRatioRightToLeft - 1) < 0.000001)
})

test('Tencent transformer preserves hand volume and derives missing pctChg', () => {
  const result = transformTencentDailySeries('600487.SH', tencentRows)
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].tradeDate, '20260814')
  assert.equal(result.rows[0].vol, 3182814)
  assert.equal(result.rows[0].pctChg, 10.008734)
  assert.equal(result.rows[0].amount, null)
  assert.equal(result.rows[0].turnoverRate, null)
})

test('Validator detects an unconverted Eastmoney amount unit', () => {
  const row = transformEastmoneyDailySeries('600487.SH', eastmoneyRows).rows[1]
  const invalidUnit = { ...row, amount: 19196727611 }
  const validation = validateCanonicalDailyBar(invalidUnit)
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.warnings, ['AMOUNT_VOLUME_UNIT_SUSPECT'])
})

test('Transformer enforces the settled-date boundary before limiting rows', () => {
  const withIntraday = [...eastmoneyRows, '2026-08-17,63.80,64.21,65.33,63.20,2028286,13023715479.00,3.38,1.95,1.23,8.27']
  const result = transformEastmoneyDailySeries('600487.SH', withIntraday, {
    maxTradeDate: '20260814',
    limit: 1,
  })
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].tradeDate, '20260814')
  assert.deepEqual(result.rejected.at(-1).reasons, ['AFTER_MAX_TRADE_DATE'])
})

test('Sina market snapshot transformer normalizes volume, amount and turnover units', () => {
  const result = transformSinaMarketSnapshotRows([{
    symbol: 'sh600487',
    code: '600487',
    trade: '62.98',
    settlement: '57.25',
    open: '58.10',
    high: '62.98',
    low: '57.25',
    volume: '318281407',
    amount: '19196727611',
    changepercent: '10.01',
    turnoverratio: '12.97',
  }], '20260814')
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].vol, 3182814.07)
  assert.equal(result.rows[0].amount, 19196727.611)
  assert.equal(result.rows[0].turnoverRate, 12.97)
  assert.equal(validateCanonicalDailyBar(result.rows[0]).warnings.length, 0)
})
