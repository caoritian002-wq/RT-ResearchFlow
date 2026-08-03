/**
 * browserFetch.ts
 *
 * Fallback fetcher using a hidden BrowserWindow for sites that use
 * JavaScript-based anti-bot (e.g. Wangdun/网盾 on www.gov.cn, pbc.gov.cn).
 *
 * Two-step flow:
 *   1. Load the site's HOMEPAGE first so Wangdun JS runs and sets wdcid/wdses
 *      cookies into session.defaultSession.
 *   2. Load the actual TARGET URL — cookies are now present, request succeeds.
 *   3. Extract document.documentElement.outerHTML and return it.
 *   4. Destroy the window; cookies persist in session.defaultSession so
 *      subsequent net.request({ useSessionCookies: true }) calls work too.
 */
import { BrowserWindow, session } from 'electron'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'

/** How long (ms) to let JS run after did-finish-load */
const SETTLE_MS = 2000

function getOrigin(url: string): string {
  try { return new URL(url).origin } catch { return url }
}

/** Override Sec-CH-UA on every request so Electron is not fingerprinted */
function patchClientHints(win: BrowserWindow): void {
  win.webContents.session.webRequest.onBeforeSendHeaders(
    (details, callback) => {
      const h = details.requestHeaders
      h['sec-ch-ua'] = '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"'
      h['sec-ch-ua-mobile'] = '?0'
      h['sec-ch-ua-platform'] = '"Windows"'
      callback({ requestHeaders: h })
    }
  )
}

async function loadAndWait(win: BrowserWindow, url: string): Promise<void> {
  await win.loadURL(url).catch(() => {})
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))
}

export async function fetchWithBrowser(url: string): Promise<string> {
  const origin = getOrigin(url)

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      session: session.defaultSession   // share cookie jar with net.request
    }
  })

  win.webContents.setUserAgent(UA)
  patchClientHints(win)

  try {
    // Step 1: homepage — Wangdun JS fires here and sets wdcid/wdses cookies
    if (origin !== url) {
      console.log(`[browserFetch] warming up ${origin}`)
      await loadAndWait(win, origin)
    }

    // Step 2: actual target — cookies are present now
    console.log(`[browserFetch] loading target ${url}`)
    await loadAndWait(win, url)

    const html = await win.webContents.executeJavaScript(
      'document.documentElement.outerHTML'
    ) as string

    console.log(`[browserFetch] html length: ${html.length}, starts: ${html.slice(0, 80)}`)
    return html
  } finally {
    win.destroy()
  }
}
