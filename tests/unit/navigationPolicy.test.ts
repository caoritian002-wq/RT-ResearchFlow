import { describe, expect, it } from 'vitest'
import {
  isAllowedApplicationNavigation,
  normalizeExternalHttpUrl,
  shouldAllowRendererPermission,
} from '../../electron/main/security/navigationPolicy'

describe('navigationPolicy', () => {
  it('accepts only absolute HTTP and HTTPS external links', () => {
    expect(normalizeExternalHttpUrl('https://example.com/research?q=1')).toBe('https://example.com/research?q=1')
    expect(normalizeExternalHttpUrl('http://example.com')).toBe('http://example.com/')
    expect(normalizeExternalHttpUrl('/relative')).toBeNull()
    expect(normalizeExternalHttpUrl('not a url')).toBeNull()
  })

  it('rejects dangerous schemes, credentials, and padded input', () => {
    expect(normalizeExternalHttpUrl('file:///C:/Windows/System32/calc.exe')).toBeNull()
    expect(normalizeExternalHttpUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeExternalHttpUrl('data:text/html,hello')).toBeNull()
    expect(normalizeExternalHttpUrl('https://user:secret@example.com')).toBeNull()
    expect(normalizeExternalHttpUrl(' https://example.com')).toBeNull()
  })

  it('allows only the packaged renderer file itself', () => {
    const entry = 'file:///C:/app/out/renderer/index.html'
    expect(isAllowedApplicationNavigation(`${entry}#/portfolio`, entry)).toBe(true)
    expect(isAllowedApplicationNavigation('file:///C:/app/out/renderer/other.html', entry)).toBe(false)
    expect(isAllowedApplicationNavigation('https://example.com', entry)).toBe(false)
  })

  it('allows only the configured development origin', () => {
    const entry = 'http://127.0.0.1:5173/'
    expect(isAllowedApplicationNavigation('http://127.0.0.1:5173/research', entry)).toBe(true)
    expect(isAllowedApplicationNavigation('http://localhost:5173/', entry)).toBe(false)
    expect(isAllowedApplicationNavigation('https://127.0.0.1:5173/', entry)).toBe(false)
  })

  it('denies renderer permissions by default', () => {
    expect(shouldAllowRendererPermission()).toBe(false)
  })
})
