import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { WebsterServer } from './server.js'
import { createTools } from './tools.js'

export function buildMcpServer(wsServer: WebsterServer): Server {
  const tools = createTools(wsServer)

  const mcpServer = new Server(
    { name: 'webster', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }))

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find(t => t.name === request.params.name)
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`)

    try {
      const result = await tool.execute((request.params.arguments ?? {}) as Record<string, unknown>)
      return {
        content: [{ type: 'text', text: result == null ? 'ok' : typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      }
    }
  })

  return mcpServer
}

export class McpSessionManager {
  private sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

  constructor(private wsServer: WebsterServer) {}

  get sessionCount(): number {
    return this.sessions.size
  }

  getSessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  async handleRequest(req: Request): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id')

    if (sessionId) {
      const existing = this.sessions.get(sessionId)
      if (!existing) return Response.json({ error: 'Session not found' }, { status: 404 })
      return existing.handleRequest(req)
    }

    // No session ID — create new session
    let transport!: WebStandardStreamableHTTPServerTransport
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID() as string,
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport)
        console.error(`Webster: MCP session started id=${id} (${this.sessions.size} active)`)
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id)
        console.error(`Webster: MCP session closed id=${id} (${this.sessions.size} active)`)
      },
    })

    const server = buildMcpServer(this.wsServer)
    await server.connect(transport)
    return transport.handleRequest(req)
  }
}
