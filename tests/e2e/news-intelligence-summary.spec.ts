import { expect, test, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('news intelligence summary cards center their content', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'trade-watch-feed-summary-'))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...launchEnv } = process.env
  const app = await electron.launch({
    args: [join(__dirname, '../../out/main/index.js'), `--user-data-dir=${userDataDir}`],
    env: { ...launchEnv, NODE_ENV: 'test' },
  })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.setViewportSize({ width: 1536, height: 940 })

    const guide = window.locator('[data-testid="cold-start-guide"]')
    if (await guide.isVisible()) await guide.locator('button[aria-label]').click()

    await window.locator('[data-testid="nav-tab-feed"]').click()
    await expect(window.getByRole('heading', { name: '资讯情报台' })).toBeVisible()

    const metricCards = window.locator('[data-testid="feed-summary-metric"]')
    await expect(metricCards).toHaveCount(4)
    const metricAlignment = await metricCards.evaluateAll((cards) => cards.map((card) => {
      const style = getComputedStyle(card)
      const cardRect = card.getBoundingClientRect()
      const labelRect = card.children[0].getBoundingClientRect()
      const valueRect = card.children[1].getBoundingClientRect()
      return {
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        textAlign: style.textAlign,
        labelOffsetX: Math.abs((labelRect.left + labelRect.right - cardRect.left - cardRect.right) / 2),
        valueOffsetX: Math.abs((valueRect.left + valueRect.right - cardRect.left - cardRect.right) / 2),
        groupOffsetY: Math.abs((labelRect.top + valueRect.bottom - cardRect.top - cardRect.bottom) / 2),
      }
    }))

    expect(metricAlignment.every((item) => (
      item.alignItems === 'center'
      && item.justifyContent === 'center'
      && item.textAlign === 'center'
      && item.labelOffsetX <= 1
      && item.valueOffsetX <= 1
      && item.groupOffsetY <= 3
    ))).toBe(true)

    const scanCard = window.locator('[data-testid="feed-summary-scan"]')
    await expect(scanCard).toBeVisible()
    const scanAlignment = await scanCard.evaluate((card) => {
      const style = getComputedStyle(card)
      const cardRect = card.getBoundingClientRect()
      const buttonRect = card.children[0].getBoundingClientRect()
      const statusRect = card.children[1].getBoundingClientRect()
      return {
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        textAlign: style.textAlign,
        buttonOffsetX: Math.abs((buttonRect.left + buttonRect.right - cardRect.left - cardRect.right) / 2),
        statusOffsetX: Math.abs((statusRect.left + statusRect.right - cardRect.left - cardRect.right) / 2),
        groupOffsetY: Math.abs((buttonRect.top + statusRect.bottom - cardRect.top - cardRect.bottom) / 2),
      }
    })

    expect(scanAlignment).toEqual(expect.objectContaining({
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
    }))
    expect(scanAlignment.buttonOffsetX).toBeLessThanOrEqual(1)
    expect(scanAlignment.statusOffsetX).toBeLessThanOrEqual(1)
    expect(scanAlignment.groupOffsetY).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(`${userDataDir}-dev`, { recursive: true, force: true })
  }
})
