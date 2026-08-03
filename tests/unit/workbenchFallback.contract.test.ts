import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('workbench loading fallback contract', () => {
  it('keeps functional loading feedback moving when reduced motion is enabled', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')
    const start = app.indexOf('function WorkbenchFallback()')
    const end = app.indexOf('type SecondaryNavItem', start)
    const fallback = app.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(fallback).toContain('animate-spin')
    expect(fallback).toContain('motion-reduce:[animation-duration:1.8s]')
    expect(fallback).not.toContain('motion-reduce:animate-none')
    expect(fallback).toContain('aria-live="polite"')
    expect(fallback).toContain('正在加载工作台...')
  })
})
