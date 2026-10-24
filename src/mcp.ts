import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { WebsterServer, SessionContext } from './server.js'
import { createTools } from './tools.js'
import { OWNER_TOKEN_RE, ownerFingerprint } from './net-guard.js'

/** Tools that never dispatch to a browser (or must finish their own cleanup), so toolSupport doesn't apply. */
const NON_BROWSER_TOOLS = new Set([
  'get_browsers', 'set_browser', 'claim_tab', 'release_tab',
  'get_capture', 'stop_capture', 'annotate', 'export_har', 'redact_capture', 'export_video',
])

export function buildMcpServer(wsServer: WebsterServer, ctx?: SessionContext): Server {
  const tools = createTools(wsServer, ctx)

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

    // A native peer can declare tools it can't do; refuse before it receives anything.
    if (ctx && !NON_BROWSER_TOOLS.has(tool.name)) {
      const target = wsServer.peek(ctx)
      const support = target?.kind === 'webkit' ? target.toolSupport?.[tool.name] : undefined
      if (support?.level === 'unsupported') {
        const reason = support.note ?? 'not available'
        return {
          content: [{ type: 'text', text: `Error: Not supported in the Nostromo browser (WebKit): ${reason}. Use set_browser("chrome") for this.` }],
          isError: true
        }
      }
    }

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

    // No session ID — create new session. The owner is read once, from this
    // initialize request, and bound for the session's life (D1).
    const rawOwner = req.headers.get('x-webster-owner')
    let owner: string | null = null
    if (rawOwner !== null && rawOwner !== '') {
      if (!OWNER_TOKEN_RE.test(rawOwner)) {
        return Response.json({ error: 'Invalid X-Webster-Owner header' }, { status: 400 })
      }
      owner = rawOwner
    }
    const ctx = this.wsServer.createSessionContext(owner)

    let transport!: WebStandardStreamableHTTPServerTransport
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID() as string,
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport)
        ctx.id = id
        this.wsServer.registerSession(ctx)
        const ownerNote = owner ? ` ownerFp=${ownerFingerprint(owner)}` : ''
        console.error(`Webster: MCP session started id=${id}${ownerNote} (${this.sessions.size} active)`)
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id)
        this.wsServer.forgetSession(id)
        console.error(`Webster: MCP session closed id=${id} (${this.sessions.size} active)`)
      },
    })

    // Sessions that die without a DELETE (transport closed) must not leak their context.
    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId)
        this.wsServer.forgetSession(transport.sessionId)
      }
    }

    const server = buildMcpServer(this.wsServer, ctx)
    await server.connect(transport)
    return transport.handleRequest(req)
  }
}
