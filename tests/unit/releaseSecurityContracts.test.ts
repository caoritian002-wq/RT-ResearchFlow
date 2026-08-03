import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('release security contracts', () => {
  it('hardens the main renderer window and denies permissions', () => {
    const main = source('electron/main/index.ts')
    expect(main).toContain('sandbox: true')
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    expect(main).toContain('webviewTag: false')
    expect(main).toContain('setPermissionRequestHandler')
    expect(main).toContain('setPermissionCheckHandler')
    expect(main).toContain('setDevicePermissionHandler')
    expect(main).toContain("ipcMain.handle('system:openExternal'")
  })

  it('keeps Electron shell access out of preload', () => {
    const preload = source('electron/preload/index.ts')
    expect(preload).not.toMatch(/\bshell\s*\./)
    expect(preload).toContain("ipcRenderer.invoke('system:openExternal', url)")
  })

  it('removes remote webview and script injection from the renderer', () => {
    const marketHeatmap = source('src/components/MarketHeatmap/MarketHeatmap.tsx')
    expect(marketHeatmap).not.toContain('<webview')
    expect(marketHeatmap).not.toContain('executeJavaScript')
    expect(marketHeatmap).not.toContain('allowpopups')
  })

  it('ships a production CSP without unsafe eval or frames', () => {
    const html = source('src/index.html')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'self'")
    expect(html).toContain("frame-src 'none'")
    expect(html).not.toContain("'unsafe-eval'")
    expect(html).not.toMatch(/<script>(.|\n)*?<\/script>/)
  })

  it('runs the reproducible build size report as part of every production build', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      scripts?: Record<string, string>
    }
    const sizeReport = source('scripts/report-build-sizes.mjs')
    expect(packageJson.scripts?.build).toContain('node scripts/report-build-sizes.mjs')
    expect(packageJson.scripts?.['report:size']).toBe('node scripts/report-build-sizes.mjs')
    expect(packageJson.scripts?.['test:unit']).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(sizeReport).toContain('RENDERER_ENTRY_BUDGET_BYTES = 4.5 * MEBIBYTE')
    expect(sizeReport).toContain("resolve(rendererRoot, 'index.html')")
    expect(sizeReport).toContain('process.exitCode = 1')
  })
})
