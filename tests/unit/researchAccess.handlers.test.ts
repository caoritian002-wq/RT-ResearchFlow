import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  auditMock,
  createMock,
  existsMock,
  getDbMock,
  handleMock,
  profilesMock,
  revokeMock,
  rotateMock,
  statusMock,
  updateMock,
} = vi.hoisted(() => ({
  auditMock: vi.fn(),
  createMock: vi.fn(),
  existsMock: vi.fn(),
  getDbMock: vi.fn(),
  handleMock: vi.fn(),
  profilesMock: vi.fn(),
  revokeMock: vi.fn(),
  rotateMock: vi.fn(),
  statusMock: vi.fn(),
  updateMock: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\test-project\\rt-research-flow' },
  ipcMain: { handle: handleMock },
}))
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: existsMock }
})
vi.mock('../../electron/main/database/db', () => ({ getDb: getDbMock }))
vi.mock('../../electron/main/database/researchAccessRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/database/researchAccessRepository')>()
  return {
    ...actual,
    createResearchAccessProfile: createMock,
    listResearchAccessAudit: auditMock,
    listResearchAccessProfiles: profilesMock,
    revokeResearchAccessProfile: revokeMock,
    rotateResearchAccessCredential: rotateMock,
    updateResearchAccessProfile: updateMock,
  }
})
vi.mock('../../electron/main/services/researchAccessTransport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/services/researchAccessTransport')>()
  return { ...actual, getResearchAccessTransportStatus: statusMock }
})

import { registerResearchAccessHandlers } from '../../electron/main/ipc/researchAccessHandlers'

const REQUEST_ID = '8a8a40cd-e6b8-414f-b218-72a6bd3f6464'
const PROFILE_ID = '4bde73f8-2a61-4f35-95a2-42cf85a9909e'
const profile = {
  id: PROFILE_ID,
  name: 'Local Agent',
  scopes: ['market.read'] as const,
  enabled: true,
  credentialVersion: 1,
  scopeVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  revokedAt: null,
}

type IpcHandler = (event: unknown, payload?: unknown) => unknown

function handler(channel: string): IpcHandler {
  const registration = handleMock.mock.calls.find(([name]) => name === channel)
  if (!registration) throw new Error(`Missing IPC handler: ${channel}`)
  return registration[1] as IpcHandler
}

beforeEach(() => {
  vi.clearAllMocks()
  getDbMock.mockReturnValue({ name: 'db' })
  existsMock.mockReturnValue(true)
  statusMock.mockReturnValue({
    state: 'ready',
    pipePath: '\\\\.\\pipe\\trade-watch-research-test',
    protocolVersion: '1',
    serviceVersion: '1.0.0',
    errorCode: null,
  })
  profilesMock.mockReturnValue([profile])
  auditMock.mockReturnValue({ items: [], nextCursor: null })
  registerResearchAccessHandlers()
})

describe('FR-255 research access IPC', () => {
  it('registers only profile management and bounded audit channels', () => {
    expect(handleMock.mock.calls.map(([channel]) => channel)).toEqual([
      'researchAccess:getWorkbench',
      'researchAccess:createProfile',
      'researchAccess:updateProfile',
      'researchAccess:rotateCredential',
      'researchAccess:revokeProfile',
      'researchAccess:listAudit',
    ])
    expect(handleMock.mock.calls.map(([channel]) => channel)).not.toContain('researchAccess:callTool')

    expect(handler('researchAccess:getWorkbench')({})).toMatchObject({ ok: true })
    expect(auditMock).toHaveBeenCalledWith(getDbMock(), { limit: 50 })
  })

  it('returns credential-bearing MCP configuration once without exposing database paths or hashes', () => {
    createMock.mockReturnValue({ profile, credential: 'twr_secret', replayed: false })
    const result = handler('researchAccess:createProfile')({}, {
      requestId: REQUEST_ID,
      name: ' Local Agent ',
      scopes: ['market.read'],
    }) as { ok: boolean; data: { credential: string; mcpConfig: string } }

    expect(result.ok).toBe(true)
    expect(result.data.credential).toBe('twr_secret')
    expect(JSON.parse(result.data.mcpConfig)).toMatchObject({
      mcpServers: {
        'trade-watching': {
          args: [expect.stringContaining('research-mcp.cjs'), 'mcp'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            TRADE_WATCH_PROFILE_ID: PROFILE_ID,
            TRADE_WATCH_CREDENTIAL: 'twr_secret',
          },
        },
      },
    })
    expect(result.data.mcpConfig).not.toMatch(/credential_hash|trade-watch\.db|better-sqlite3/)
    expect(createMock).toHaveBeenCalledWith(getDbMock(), {
      requestId: REQUEST_ID,
      name: 'Local Agent',
      scopes: ['market.read'],
    })
  })

  it('uses stable one-time replay errors and validates exact input before repository calls', () => {
    createMock.mockReturnValue({ profile, credential: null, replayed: true })
    expect(handler('researchAccess:createProfile')({}, {
      requestId: REQUEST_ID,
      name: 'Local Agent',
      scopes: ['market.read'],
    })).toMatchObject({ ok: false, error: 'CREDENTIAL_ALREADY_DELIVERED' })

    createMock.mockClear()
    expect(handler('researchAccess:createProfile')({}, {
      requestId: REQUEST_ID,
      name: 'Local Agent',
      scopes: ['market.read'],
      databasePath: 'C:\\private\\trade-watch.db',
    })).toMatchObject({ ok: false, error: 'INVALID_REQUEST' })
    expect(createMock).not.toHaveBeenCalled()

    expect(handler('researchAccess:createProfile')({}, {
      requestId: REQUEST_ID,
      name: 'Local Agent',
      scopes: [],
    })).toMatchObject({ ok: false, error: 'INVALID_REQUEST' })
    expect(createMock).not.toHaveBeenCalled()
  })

  it('passes exact scope updates and bounded audit filters', () => {
    updateMock.mockReturnValue({ ...profile, scopes: [], enabled: false })
    auditMock.mockReturnValue({ items: [], nextCursor: null })
    expect(handler('researchAccess:updateProfile')({}, {
      requestId: REQUEST_ID,
      profileId: PROFILE_ID,
      scopes: [],
    })).toMatchObject({ ok: true, data: { enabled: false } })
    expect(updateMock).toHaveBeenCalledWith(getDbMock(), {
      requestId: REQUEST_ID,
      profileId: PROFILE_ID,
      scopes: [],
    })

    expect(handler('researchAccess:listAudit')({}, {
      profileId: PROFILE_ID,
      surface: 'mcp',
      status: 'blocked',
      limit: 20,
    })).toMatchObject({ ok: true, data: { items: [] } })
    expect(auditMock).toHaveBeenCalledWith(getDbMock(), {
      profileId: PROFILE_ID,
      surface: 'mcp',
      toolStatus: 'blocked',
      cursor: undefined,
      limit: 20,
    })
  })
})
