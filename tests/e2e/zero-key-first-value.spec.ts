import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  return electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), '--user-data-dir=' + userDataDir],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })
}

async function closeGuide(window: Page): Promise<void> {
  const guide = window.getByTestId('cold-start-guide')
  if (await guide.isVisible()) await guide.getByLabel('关闭引导').click()
}

async function installEastmoneyFixture(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const originalFetch = globalThis.fetch
    const fixtureState = globalThis as typeof globalThis & { __zeroKeyBackfillRequests?: string[] }
    fixtureState.__zeroKeyBackfillRequests = []
    globalThis.fetch = async (input, init) => {
      const requestUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      if (!requestUrl.includes('push2his.eastmoney.com/api/qt/stock/kline/get')) {
        return originalFetch(input, init)
      }
      fixtureState.__zeroKeyBackfillRequests?.push(requestUrl)

      const url = new URL(requestUrl)
      const secid = url.searchParams.get('secid') ?? ''
      const names: Record<string, string> = {
        '1.600519': '贵州茅台',
        '1.000300': '沪深300',
        '1.000001': '上证指数',
        '0.399001': '深成指',
        '0.399006': '创业板指',
      }
      const end = new Date(Date.now() + 8 * 60 * 60 * 1000)
      const cursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()))
      const klines: string[] = []
      while (klines.length < 149) {
        const weekday = cursor.getUTCDay()
        if (weekday !== 0 && weekday !== 6) {
          const index = klines.length
          const base = secid === '1.000300' ? 3800 : secid === '1.600519' ? 1400 : 3000
          const close = base + index * 1.2 + Math.sin(index / 6) * 3
          const date = cursor.toISOString().slice(0, 10)
          klines.unshift([
            date,
            (close - 1).toFixed(2),
            close.toFixed(2),
            (close + 3).toFixed(2),
            (close - 3).toFixed(2),
            String(100000 + index * 100),
            String(200000000 + index * 100000),
          ].join(','))
        }
        cursor.setUTCDate(cursor.getUTCDate() - 1)
      }
      return new Response(JSON.stringify({
        rc: 0,
        data: { name: names[secid] ?? '公开指数', klines },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  })
}

async function installStockFundamentalFixture(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const originalFetch = globalThis.fetch
    const fixtureState = globalThis as typeof globalThis & { __stockFundamentalRequests?: string[] }
    fixtureState.__stockFundamentalRequests = []
    globalThis.fetch = async (input, init) => {
      const requestUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      const url = new URL(requestUrl)
      if (
        url.hostname === 'emweb.securities.eastmoney.com'
        && url.pathname === '/PC_HSF10/CompanySurvey/PageAjax'
      ) {
        fixtureState.__stockFundamentalRequests?.push(requestUrl)
        return new Response(JSON.stringify({
          jbzl: [{
            SECUCODE: '600519.SH',
            SECURITY_CODE: '600519',
            SECURITY_NAME_ABBR: '贵州茅台',
            ORG_NAME: '贵州茅台酒股份有限公司',
            SECURITY_TYPE: 'A股',
            TRADE_MARKET: '上海证券交易所',
            EM2016: '白酒',
            CHAIRMAN: '测试董事长',
            LEGAL_PERSON: '测试代表',
            ORG_WEB: 'https://www.moutaichina.com/',
            ADDRESS: '贵州省仁怀市茅台镇',
            REG_CAPITAL: 125619.78,
            EMP_NUM: 32000,
            BUSINESS_SCOPE: '茅台酒系列产品的生产与销售。',
            ORG_PROFILE: '公司专注于酒类产品。',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (
        url.hostname === 'datacenter.eastmoney.com'
        && url.searchParams.get('reportName') === 'RPT_F10_FINANCE_MAINFINADATA'
      ) {
        fixtureState.__stockFundamentalRequests?.push(requestUrl)
        return new Response(JSON.stringify({
          success: true,
          code: 0,
          result: {
            data: [{
              SECUCODE: '600519.SH',
              SECURITY_NAME_ABBR: '贵州茅台',
              REPORT_DATE: '2026-06-30 00:00:00',
              REPORT_TYPE: '中报',
              NOTICE_DATE: '2026-07-20 00:00:00',
              UPDATE_DATE: '2026-07-20 00:00:00',
              CURRENCY: 'CNY',
              TOTALOPERATEREVE: 91000000000,
              PARENTNETPROFIT: 47000000000,
              KCFJCXSYJLR: 46800000000,
              TOTALOPERATEREVETZ: 9.8,
              PARENTNETPROFITTZ: 11.2,
              KCFJCXSYJLRTZ: 10.9,
              ROEJQ: 18.6,
              XSMLL: 91.2,
              XSJLL: 51.6,
              ZCFZL: 17.3,
              NETCASH_OPERATE_PK: 52000000000,
              EPSJB: 37.4,
              BPS: 182.5,
            }],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.hostname === 'np-anotice-stock.eastmoney.com') {
        fixtureState.__stockFundamentalRequests?.push(requestUrl)
        return new Response(JSON.stringify({
          success: 1,
          error: '',
          data: {
            page_index: 1,
            page_size: 30,
            list: [
              {
                art_code: 'AN202607171827064564',
                codes: [{ stock_code: '600519', short_name: '贵州茅台' }],
                columns: [{ column_code: '001002008', column_name: '其他' }],
                display_time: '2026-07-17 21:26:22:243',
                notice_date: '2026-07-18 00:00:00',
                title_ch: '贵州茅台:贵州茅台重大事项公告',
              },
              {
                art_code: 'AN202607101800000002',
                codes: [{ stock_code: '600519', short_name: '贵州茅台' }],
                columns: [{ column_code: '001002002001005', column_name: '分配方案实施' }],
                display_time: '2026-07-09 19:30:00:000',
                notice_date: '2026-07-10 00:00:00',
                title_ch: '贵州茅台:2025年年度权益分派实施公告',
              },
              {
                art_code: 'AN202607011800000003',
                codes: [{ stock_code: '600519', short_name: '贵州茅台' }],
                columns: [{ column_code: '001003002002', column_name: '法律意见书' }],
                display_time: '2026-06-30 18:00:00:000',
                notice_date: '2026-07-01 00:00:00',
                title_ch: '贵州茅台:2025年度股东会法律意见书',
              },
            ],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }
  })
}

async function getStockFundamentalRequestCounts(
  app: ElectronApplication,
): Promise<{ profile: number; financial: number; announcement: number }> {
  return app.evaluate(() => {
    const fixtureState = globalThis as typeof globalThis & { __stockFundamentalRequests?: string[] }
    const requests = fixtureState.__stockFundamentalRequests ?? []
    return {
      profile: requests.filter((url) => url.includes('/CompanySurvey/PageAjax')).length,
      financial: requests.filter((url) => url.includes('RPT_F10_FINANCE_MAINFINADATA')).length,
      announcement: requests.filter((url) => url.includes('np-anotice-stock.eastmoney.com')).length,
    }
  })
}

test('全新 profile 无 Key 也能形成单股事实、趋势与持仓，并在重启后恢复', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-zero-key-'))
  let app: ElectronApplication | null = null

  try {
    app = await launchApp(userDataDir)
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await installEastmoneyFixture(app)

    const config = await window.evaluate(() => window.api.datasource.getConfig())
    expect(config.tushareEnabled).toBe(false)
    expect(config.hasTushareToken).toBe(false)

    await window.getByTestId('nav-tab-decision-center').click()
    await window.getByTestId('decision-view-mode-portfolio').click()
    await expect(window.getByTestId('decision-portfolio-no-holding-empty')).toBeVisible({ timeout: 20_000 })
    await window.getByTestId('decision-start-portfolio-journey').click()
    await expect(window.getByTestId('stock-chart-root')).toBeVisible({ timeout: 20_000 })

    const search = window.getByPlaceholder('输入公司名或股票代码')
    await search.fill('600519')
    await search.press('Enter')

    const sourceStatus = window.getByTestId('stock-data-source-status')
    await expect(sourceStatus).toBeVisible({ timeout: 30_000 })
    await expect(sourceStatus).toHaveAttribute('data-provider', 'eastmoney')
    await expect(sourceStatus).toHaveAttribute('data-state', 'complete')
    await expect(sourceStatus).toHaveAttribute('data-benchmark-state', 'current')
    await expect(sourceStatus).toContainText('东方财富公开行情')
    await expect(sourceStatus).toContainText('149 日')
    await expect(window.getByTestId('stock-list-item-600519')).toContainText('贵州茅台')
    await expect.poll(async () => Number(
      await window.getByTestId('stock-chart-root').getAttribute('data-history-count'),
    )).toBeGreaterThanOrEqual(149)

    await expect(window.getByTestId('portfolio-journey-banner')).toBeVisible()
    await window.getByTestId('portfolio-toggle-btn').click()
    await expect(window.getByTestId('portfolio-journey-banner')).toContainText('持仓已加入')

    const firstValue = await window.evaluate(async () => {
      const holdings = await window.api.portfolio.list()
      const workbench = await window.api.trend.getWorkbench()
      const item = workbench.data?.items.find((candidate) => candidate.stockCode === '600519')
      return {
        holding: holdings.data?.find((candidate) => candidate.tsCode === '600519') ?? null,
        coverage: item?.dataCoverage ?? null,
        totalScore: item?.totalScore ?? null,
        turnoverQuality: item?.dimensions?.turnoverQuality ?? null,
        benchmark: workbench.data?.dataHealth.benchmark ?? null,
      }
    })
    expect(firstValue.holding?.stockName).toBe('贵州茅台')
    expect(firstValue.coverage).toMatchObject({ state: 'ready', requiredBars: 60 })
    expect(firstValue.coverage?.bars).toBeGreaterThanOrEqual(149)
    expect(firstValue.totalScore).not.toBeNull()
    expect(firstValue.turnoverQuality).toBeNull()
    expect(firstValue.benchmark).toMatchObject({ state: 'current', calendarSource: 'weekday-fallback', bars: 149 })

    await window.getByTestId('portfolio-journey-return').click()
    await expect(window.getByTestId('decision-center-root')).toBeVisible({ timeout: 20_000 })
    await expect(window.getByTestId('decision-portfolio-no-holding-empty')).toBeHidden()

    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-list-item-600519')).toContainText('贵州茅台', { timeout: 20_000 })
    await window.getByTestId('stock-list-item-600519').locator('button').first().click()
    await expect.poll(async () => Number(
      await window.getByTestId('stock-chart-root').getAttribute('data-history-count'),
    )).toBeGreaterThanOrEqual(149)

    const restored = await window.evaluate(async () => {
      const fetched = await window.api.datasource.fetchStock('600519')
      const holdings = await window.api.portfolio.list()
      return { fetched, holdings }
    })
    expect('error' in restored.fetched).toBe(false)
    if (!('error' in restored.fetched)) {
      expect(restored.fetched.provider).toBe('local-cache')
      expect(restored.fetched.stockName).toBe('贵州茅台')
      expect(restored.fetched.totalRows).toBeGreaterThanOrEqual(149)
    }
    expect(restored.holdings.data?.[0]?.stockName).toBe('贵州茅台')
  } finally {
    if (app) await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('无 Key 持仓缺口只在用户点击后逐股补齐，并跨重启复用本地事实', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-zero-key-portfolio-'))
  let app: ElectronApplication | null = null

  try {
    app = await launchApp(userDataDir)
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await installEastmoneyFixture(app)

    const aiConfig = await window.evaluate(() => window.api.ai.getConfig())
    expect(aiConfig.hasApiKey).toBe(false)

    const added = await window.evaluate(() => window.api.portfolio.add('600519', '贵州茅台'))
    expect(added.ok).toBe(true)

    await window.getByTestId('nav-tab-trend-watcher').click()
    await window.getByTestId('secondary-nav-trend-watcher-portfolio').click()
    await expect(window.getByTestId('trend-portfolio-overview')).toBeVisible({ timeout: 30_000 })
    await expect(window.getByTestId('portfolio-backfill-all')).toContainText('补齐数据缺口 1')
    await expect(window.getByTestId('portfolio-backfill-selected')).toBeVisible()

    const beforeBars = await window.evaluate(async () => {
      const workbench = await window.api.trend.getWorkbench()
      const item = workbench.data?.items.find((candidate) => candidate.stockCode === '600519')
      return item?.dataCoverage.bars ?? 0
    })
    const beforeRequests = await app.evaluate(() => {
      const fixtureState = globalThis as typeof globalThis & { __zeroKeyBackfillRequests?: string[] }
      return fixtureState.__zeroKeyBackfillRequests?.filter((url) => url.includes('secid=1.600519')).length ?? 0
    })
    expect(beforeBars).toBe(0)
    expect(beforeRequests).toBe(0)

    await window.getByTestId('portfolio-backfill-all').click()
    const status = window.getByTestId('portfolio-backfill-status')
    await expect(status).toContainText('更新1只', { timeout: 30_000 })
    await expect(status).toContainText('未完成0只')
    await expect(window.getByTestId('portfolio-backfill-benchmark')).toHaveAttribute('data-state', 'current')
    await expect(window.getByTestId('portfolio-backfill-all')).toHaveCount(0)
    await expect(window.getByTestId('portfolio-backfill-selected')).toHaveCount(0)
    await expect(window.getByTestId('trend-portfolio-overview')).toContainText('东方财富公开行情')
    await expect(window.getByTestId('trend-portfolio-overview')).toContainText('日线 149')

    const completed = await window.evaluate(async () => {
      const workbench = await window.api.trend.getWorkbench()
      const item = workbench.data?.items.find((candidate) => candidate.stockCode === '600519')
      return {
        coverage: item?.dataCoverage ?? null,
        score: item?.totalScore ?? null,
      }
    })
    const completedRequests = await app.evaluate(() => {
      const fixtureState = globalThis as typeof globalThis & { __zeroKeyBackfillRequests?: string[] }
      return fixtureState.__zeroKeyBackfillRequests?.filter((url) => url.includes('secid=1.600519')).length ?? 0
    })
    const benchmarkRequests = await app.evaluate(() => {
      const fixtureState = globalThis as typeof globalThis & { __zeroKeyBackfillRequests?: string[] }
      return fixtureState.__zeroKeyBackfillRequests?.filter((url) => url.includes('secid=1.000300')).length ?? 0
    })
    expect(completed.coverage).toMatchObject({ bars: 149, state: 'ready', requiredBars: 60 })
    expect(completed.score).not.toBeNull()
    expect(completedRequests).toBe(1)
    expect(benchmarkRequests).toBe(1)
    await expect(window.getByTestId('trend-portfolio-overview').getByTestId('trend-benchmark-health')).toHaveAttribute('data-state', 'current')

    const portfolioSummary = window.getByTestId('local-trend-summary-600519')
    await expect(portfolioSummary).toBeVisible()
    await expect(portfolioSummary).toHaveAttribute('data-summary-status', 'degraded')
    await expect(portfolioSummary).toContainText('本地规则')
    await expect(portfolioSummary).toContainText('换手率缺失，量能质量未参与评分')
    await expect(portfolioSummary).toContainText('个股20日')
    await expect(portfolioSummary).toContainText('沪深300同期')
    await expect(portfolioSummary).toContainText('20日超额')
    const portfolioHeadline = await portfolioSummary.getAttribute('data-headline')

    await window.getByTestId('nav-tab-trend-watcher').click()
    await window.getByTestId('secondary-nav-trend-watcher-dashboard').click()
    const radarSummary = window.getByTestId('local-trend-radar-600519')
    await expect(radarSummary).toBeVisible({ timeout: 30_000 })
    await expect(radarSummary).toHaveAttribute('data-headline', portfolioHeadline ?? '')
    await expect(radarSummary).toHaveAttribute('data-summary-status', 'degraded')
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.screenshot({ path: 'test-results/zero-key-local-summary-radar-1440x900.png' })
    await window.getByTestId('nav-tab-trend-watcher').click()
    await window.getByTestId('secondary-nav-trend-watcher-portfolio').click()
    await expect(portfolioSummary).toBeVisible()

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await window.screenshot({ path: 'test-results/zero-key-portfolio-backfill-1024x768-dark.png' })

    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await window.getByTestId('nav-tab-trend-watcher').click()
    await window.getByTestId('secondary-nav-trend-watcher-portfolio').click()
    await expect(window.getByTestId('trend-portfolio-overview')).toContainText('贵州茅台', { timeout: 30_000 })
    await expect(window.getByTestId('trend-portfolio-overview')).toContainText('日线 149')
    await expect(window.getByTestId('portfolio-backfill-all')).toHaveCount(0)
  } finally {
    if (app) await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('公开基本面只在用户显式请求后补齐，并跨抽屉和重启复用SQLite', async () => {
  test.setTimeout(150_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-stock-fundamentals-'))
  let app: ElectronApplication | null = null

  try {
    app = await launchApp(userDataDir)
    let window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await installEastmoneyFixture(app)
    await installStockFundamentalFixture(app)

    await window.setViewportSize({ width: 1440, height: 900 })
    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-chart-root')).toBeVisible({ timeout: 20_000 })
    const search = window.getByPlaceholder('输入公司名或股票代码')
    await search.fill('600519')
    await search.press('Enter')
    await expect(window.getByTestId('stock-list-item-600519')).toContainText('贵州茅台', { timeout: 30_000 })
    const fundamentalOpen = window.getByTestId('stock-fundamental-open')
    await expect(fundamentalOpen).toBeVisible()
    await expect(fundamentalOpen).toHaveCSS('height', '28px')
    await window.screenshot({ path: 'test-results/stock-fundamental-trigger-1440x900-light.png' })
    expect(await getStockFundamentalRequestCounts(app)).toEqual({ profile: 0, financial: 0, announcement: 0 })

    await fundamentalOpen.click()
    const drawer = window.getByTestId('stock-fundamental-drawer')
    const content = window.getByTestId('stock-fundamental-content')
    await expect(drawer).toBeVisible()
    await expect(content).toHaveAttribute('data-state', 'missing')
    await expect(drawer).toContainText('本地尚无基本面事实')
    await expect(window.getByTestId('stock-fundamental-source-summary')).toBeVisible()
    await expect(window.getByTestId('stock-fundamental-refresh')).toHaveCSS('height', '44px')
    await expect(window.getByTestId('stock-fundamental-refresh-visual')).toHaveCSS('height', '32px')
    expect(await getStockFundamentalRequestCounts(app)).toEqual({ profile: 0, financial: 0, announcement: 0 })

    await window.getByTestId('stock-fundamental-refresh').click()
    await expect(content).toHaveAttribute('data-state', 'complete', { timeout: 30_000 })
    await expect(drawer).toContainText('公司概况可用')
    await expect(drawer).toContainText('主要财务可用')
    await expect(drawer).toContainText('公告索引可用')
    await expect(window.getByTestId('stock-fundamental-profile')).toContainText('贵州茅台酒股份有限公司')
    await expect(window.getByTestId('stock-fundamental-profile')).toContainText('茅台酒系列产品的生产与销售')
    await expect(window.getByTestId('stock-fundamental-profile')).toContainText('来源未提供资料更新日')
    await expect(window.getByTestId('stock-fundamental-financial')).toContainText('2026-06-30')
    await expect(window.getByTestId('stock-fundamental-financial')).toContainText('公告 2026-07-20')
    await expect(window.getByTestId('stock-fundamental-financial')).toContainText('910.00亿元')
    await expect(window.getByTestId('stock-fundamental-financial')).toContainText('470.00亿元')
    expect(await getStockFundamentalRequestCounts(app)).toEqual({ profile: 1, financial: 1, announcement: 1 })
    await window.screenshot({ path: 'test-results/stock-fundamentals-1440x900-light.png' })

    const announcementTab = window.getByTestId('stock-fundamental-tab-announcements')
    await expect(announcementTab).toHaveCSS('height', '44px')
    await expect(window.getByTestId('stock-fundamental-tab-announcements-visual')).toHaveCSS('height', '28px')
    await announcementTab.click()
    const announcements = window.getByTestId('stock-fundamental-announcements')
    await expect(announcements).toBeVisible()
    await expect(announcements).toContainText('共 3 条')
    await expect(announcements).toContainText('重点线索 2 条')
    await expect(announcements).toContainText('贵州茅台:贵州茅台重大事项公告')
    await expect(announcements).toContainText('来源分类：其他')
    await expect(announcements).toContainText('重大事项线索')
    await expect(announcements).toContainText('2025年年度权益分派实施公告')
    await expect(announcements).toContainText('分红线索')
    await expect(announcements).toContainText('2025年度股东会法律意见书')
    await window.screenshot({ path: 'test-results/stock-fundamental-announcements-1440x900-light.png' })
    const attentionFilter = window.getByTestId('stock-fundamental-announcement-filter-attention')
    await expect(attentionFilter).toHaveCSS('height', '44px')
    await expect(window.getByTestId('stock-fundamental-announcement-filter-attention-visual')).toHaveCSS('height', '28px')
    await attentionFilter.click()
    await expect(window.getByTestId('stock-fundamental-announcement-AN202607011800000003')).toHaveCount(0)
    await expect(window.getByTestId('stock-fundamental-announcement-AN202607171827064564')).toBeVisible()

    await drawer.getByLabel('关闭抽屉').click()
    await expect(drawer).toBeHidden()
    await window.getByTestId('stock-fundamental-open').click()
    await expect(content).toHaveAttribute('data-state', 'complete')
    expect(await getStockFundamentalRequestCounts(app)).toEqual({ profile: 1, financial: 1, announcement: 1 })
    await window.getByTestId('stock-fundamental-tab-announcements').click()
    await expect(window.getByTestId('stock-fundamental-announcements')).toContainText('共 3 条')

    await window.setViewportSize({ width: 1024, height: 768 })
    await window.emulateMedia({ reducedMotion: 'reduce' })
    await window.evaluate(() => document.documentElement.classList.add('dark'))
    expect(await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    const drawerBox = await drawer.boundingBox()
    expect(drawerBox?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0)).toBeLessThanOrEqual(1024)
    await window.screenshot({ path: 'test-results/stock-fundamentals-1024x768-dark.png' })
    await drawer.getByLabel('关闭抽屉').click()
    await expect(drawer).toBeHidden()
    await window.screenshot({ path: 'test-results/stock-fundamental-trigger-1024x768-dark.png' })

    await app.close()
    app = await launchApp(userDataDir)
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await closeGuide(window)
    await installEastmoneyFixture(app)
    await installStockFundamentalFixture(app)
    await window.getByTestId('nav-tab-stock-chart').click()
    await expect(window.getByTestId('stock-list-item-600519')).toContainText('贵州茅台', { timeout: 20_000 })
    await window.getByTestId('stock-list-item-600519').locator('button').first().click()
    await expect(window.getByTestId('stock-fundamental-open')).toBeVisible({ timeout: 20_000 })
    expect(await getStockFundamentalRequestCounts(app)).toEqual({ profile: 0, financial: 0, announcement: 0 })
    await window.getByTestId('stock-fundamental-open').click()
    await expect(window.getByTestId('stock-fundamental-content')).toHaveAttribute('data-state', 'complete')
    await expect(window.getByTestId('stock-fundamental-profile')).toContainText('贵州茅台酒股份有限公司')
    await expect(window.getByTestId('stock-fundamental-financial')).toContainText('2026-06-30')
    await window.getByTestId('stock-fundamental-tab-announcements').click()
    await expect(window.getByTestId('stock-fundamental-announcements')).toContainText('共 3 条')
    await expect(window.getByTestId('stock-fundamental-announcements')).toContainText('贵州茅台重大事项公告')
    expect(await getStockFundamentalRequestCounts(app)).toEqual({ profile: 0, financial: 0, announcement: 0 })
  } finally {
    if (app) await app.close().catch(() => {})
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
