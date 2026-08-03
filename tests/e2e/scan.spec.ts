import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'

/**
 * E2E: Scan flow
 * Verifies that triggering a manual scan writes briefings to the feed.
 */
test.describe('scan flow', () => {
  test('manual scan completes and feed updates', async () => {
    const app = await electron.launch({
      args: [join(__dirname, '../../out/main/index.js')],
      env: { ...process.env, NODE_ENV: 'test' }
    })

    const window = await app.firstWindow()
    await window.waitForSelector('[data-testid="scan-status-bar"]', { timeout: 15000 })

    // Trigger manual scan
    await window.click('[data-testid="trigger-scan-btn"]')

    // Wait for scan:completed event to propagate (up to 30 s)
    await window.waitForFunction(
      () => document.querySelector('[data-testid="briefing-total-count"]')?.textContent !== '共 0 条',
      { timeout: 30000 }
    )

    const countText = await window.textContent('[data-testid="briefing-total-count"]')
    expect(countText).toMatch(/共 \d+ 条/)

    await app.close()
  })
})
