import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('FR-260 decision signal订阅契约', () => {
  it('只移除当前listener，不清空其他订阅者', () => {
    const preload = readFileSync(resolve(process.cwd(), 'electron/preload/index.ts'), 'utf8')
    const start = preload.indexOf('onSignalCreated:')
    const block = preload.slice(start, start + 500)

    expect(start).toBeGreaterThan(-1)
    expect(block).toContain("removeListener('decision:signalCreated', listener)")
    expect(block).not.toContain("removeAllListeners('decision:signalCreated')")
  })
})
