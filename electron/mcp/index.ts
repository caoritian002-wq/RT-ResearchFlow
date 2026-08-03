import { randomUUID } from 'crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  ResearchAccessPipeClient,
  researchAccessClientConfigFromEnv,
  type PipeToolDefinition,
} from './researchAccessPipeClient'

const command = process.argv[2] ?? 'mcp'

void main().catch((error) => {
  const code = errorCode(error)
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message: safeErrorMessage(error) } })}\n`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  if (command === 'mcp') return runMcp()
  if (command === 'doctor') return runDoctor()
  if (command === 'tools') return runTools()
  if (command === 'call') return runCall()
  throw Object.assign(new Error('仅支持mcp、doctor、tools和call命令'), { code: 'INVALID_COMMAND' })
}

async function runMcp(): Promise<void> {
  const client = await ResearchAccessPipeClient.connect(researchAccessClientConfigFromEnv('mcp'))
  const server = new Server(
    { name: 'trade-watching-local-research', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: '只读本机已有投研事实；不会联网、刷新、调用AI或执行交易。',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await client.listTools()
    return { tools: tools.map(toMcpTool) }
  })
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await client.callTool(request.params.name, request.params.arguments ?? {}, randomUUID())
      const isError = result.ok !== true
      const payload = isRecord(result.envelope)
        ? result.envelope
        : { status: 'blocked', error: result.error ?? { code: 'INTERNAL_ERROR' } }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError,
      }
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status: 'blocked', error: { code: errorCode(error), message: safeErrorMessage(error) } }),
        }],
        isError: true,
      }
    }
  })

  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 32 * 1024 })
  transport.onclose = () => client.close()
  await server.connect(transport)
}

async function runDoctor(): Promise<void> {
  const client = await ResearchAccessPipeClient.connect(researchAccessClientConfigFromEnv('cli'))
  try {
    const tools = await client.listTools()
    writeJson({
      ok: true,
      appRunning: true,
      authenticated: true,
      protocolVersion: '1',
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name),
    })
  } finally {
    client.close()
  }
}

async function runTools(): Promise<void> {
  const client = await ResearchAccessPipeClient.connect(researchAccessClientConfigFromEnv('cli'))
  try {
    writeJson({ ok: true, tools: await client.listTools() })
  } finally {
    client.close()
  }
}

async function runCall(): Promise<void> {
  const name = process.argv[3]
  if (!name) throw Object.assign(new Error('call命令需要工具名称'), { code: 'INVALID_INPUT' })
  let input: unknown = {}
  if (process.argv[4]) {
    try {
      input = JSON.parse(process.argv[4])
    } catch {
      throw Object.assign(new Error('call命令的第四个参数必须是JSON对象'), { code: 'INVALID_INPUT' })
    }
  }
  const client = await ResearchAccessPipeClient.connect(researchAccessClientConfigFromEnv('cli'))
  try {
    const result = await client.callTool(name, input)
    writeJson(result)
    if (result.ok !== true) process.exitCode = 1
  } finally {
    client.close()
  }
}

function toMcpTool(tool: PipeToolDefinition) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as {
      type: 'object'
      properties?: Record<string, object>
      required?: string[]
      additionalProperties?: boolean
    },
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '本地研究访问失败'
  return error.message.replace(/[\r\n]+/g, ' ').slice(0, 300)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
