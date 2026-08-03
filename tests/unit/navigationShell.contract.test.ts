import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('showcase navigation shell contracts', () => {
  it('defaults to a persisted expanded sidebar and shares secondary navigation between both modes', () => {
    const app = source('src/App.tsx')

    expect(app).toContain("const NAVIGATION_EXPANDED_STORAGE_KEY = 'trade-watch:navigation:v1:expanded'")
    expect(app).toContain("localStorage.getItem(NAVIGATION_EXPANDED_STORAGE_KEY) !== '0'")
    expect(app).toContain('data-expanded={navigationExpanded')
    expect(app).toContain('secondaryNavItemsByTab')
    expect(app).toContain('role="group"')
    expect(app).toContain('role="menu"')
    expect(app).toContain('min-h-11')
  })

  it('keeps the fixed window contract aligned with the custom title bar', () => {
    const main = source('electron/main/index.ts')
    const titleBar = source('src/components/AppWindow/AppTitleBar.tsx')

    expect(main).toContain('width: 1680')
    expect(main).toContain('height: 960')
    expect(main).toContain('resizable: true')
    expect(main).toContain('maximizable: true')
    expect(main).toContain('fullscreenable: false')
    expect(main).toContain("mainWindow.on('will-resize'")
    expect(main).toContain('event.preventDefault()')
    expect(titleBar).toContain('最大化窗口')
    expect(titleBar).toContain('<MaximizeIcon')
    expect(titleBar).toContain('navigationExpanded')
  })
})
