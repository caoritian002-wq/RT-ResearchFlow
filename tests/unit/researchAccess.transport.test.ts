import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { connect, type Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../electron/main/database/db'
import {
  createResearchAccessProfile,
  revokeResearchAccessProfile,
  updateResearchAccessProfile,
} from '../../electron/main/database/researchAccessRepository'
import {
  RESEARCH_ACCESS_PIPE_MAX_REQUEST_BYTES,
  startResearchAccessTransport,
  stopResearchAccessTransport,
} from '../../electron/main/services/researchAccessTransport'
import { ResearchAccessPipeClient } from '../../electron/mcp/researchAccessPipeClient'

describe('FR-255 research access local transport', () => {
  let db: Database.Database
  let userDataPath: string

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    userDataPath = mkdtempSync(join(tmpdir(), 'trade-watch-research-access-'))
  })

  afterEach(async () => {
    await stopResearchAccessTransport()
    db.close()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('lists and calls only current scopes, then applies scope changes and revocation without reconnecting', async () => {
    const created = createResearchAccessProfile(db, {
      requestId: randomUUID(),
      name: 'Local CLI',
      scopes: ['market.read'],
    })
    const status = await startResearchAccessTransport(db, userDataPath)
    expect(status).toMatchObject({ state: 'ready', protocolVersion: '1', serviceVersion: '1.0.0' })

    const client = await ResearchAccessPipeClient.connect({
      pipePath: status.pipePath!,
      profileId: created.profile.id,
      credential: created.credential!,
      surface: 'cli',
    })
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      'stock_price_history',
      'stock_trend_snapshot',
      'stock_fundamentals',
      'stock_announcements',
      'news_recent_briefings',
    ])
    await expect(client.callTool('stock_price_history', {
      stockCode: '600519',
      limit: 10,
    })).resolves.toMatchObject({
      ok: true,
      envelope: { toolId: 'stock.price_history', status: 'missing' },
    })

    updateResearchAccessProfile(db, {
      requestId: randomUUID(),
      profileId: created.profile.id,
      scopes: ['market.read', 'portfolio.read'],
    })
    expect((await client.listTools()).map((tool) => tool.name)).toContain('portfolio_holdings')

    revokeResearchAccessProfile(db, { requestId: randomUUID(), profileId: created.profile.id })
    await expect(client.listTools()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    client.close()
  })

  it('rejects a mismatched protocol and oversized frames with stable transport errors', async () => {
    const status = await startResearchAccessTransport(db, userDataPath)
    const socket = await openSocket(status.pipePath!)
    const mismatch = await sendFrame(socket, {
      id: randomUUID(),
      type: 'handshake',
      protocolVersion: '999',
      surface: 'cli',
      profileId: randomUUID(),
      credential: 'twr_invalid',
      sessionId: randomUUID(),
    })
    expect(mismatch).toMatchObject({ ok: false, error: { code: 'PROTOCOL_MISMATCH' } })

    socket.write(`${JSON.stringify({
      id: randomUUID(),
      type: 'tools.call',
      padding: 'x'.repeat(RESEARCH_ACCESS_PIPE_MAX_REQUEST_BYTES),
    })}\n`)
    const response = await readFrame(socket)
    expect(response).toMatchObject({ ok: false, error: { code: 'INPUT_TOO_LARGE' } })
    socket.destroy()
  })

  it('keeps the external adapter free of direct database imports', async () => {
    const { readFile } = await import('fs/promises')
    const source = await Promise.all([
      readFile(join(process.cwd(), 'electron/mcp/index.ts'), 'utf8'),
      readFile(join(process.cwd(), 'electron/mcp/researchAccessPipeClient.ts'), 'utf8'),
    ])
    expect(source.join('\n')).not.toMatch(/better-sqlite3|database\/|getDb\(|SQLite/)
  })
})

function openSocket(pipePath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipePath, () => resolve(socket))
    socket.once('error', reject)
  })
}

function sendFrame(socket: Socket, payload: unknown): Promise<Record<string, unknown>> {
  socket.write(`${JSON.stringify(payload)}\n`)
  return readFrame(socket)
}

function readFrame(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(0x0a)
      if (newline < 0) return
      socket.off('data', onData)
      try {
        resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}
