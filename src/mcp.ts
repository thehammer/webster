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

/** Sessions idle longer than this (no request, no open stream) are expired. */
const DEFAULT_SESSION_IDLE_HOURS = 6
/** How often the manager looks for expired sessions once started. */
const SESSION_SWEEP_INTERVAL_MS = 10 * 60 * 1000

export interface McpSessionManagerOptions {
  /** Idle bound in ms; 0 disables expiry. Default: WEBSTER_SESSION_IDLE_HOURS (6). */
  idleTimeoutMs?: number
  /** Clock, for tests. */
  now?: () => number
}

function defaultIdleTimeoutMs(): number {
  const raw = process.env.WEBSTER_SESSION_IDLE_HOURS
  const hours = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_SESSION_IDLE_HOURS) * 60 * 60 * 1000
}

export class McpSessionManager {
  private sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()
  // Per-session liveness. `busy` counts in-flight requests plus open SSE streams.
  private activity = new Map<string, { lastSeen: number; busy: number }>()
  private idleTimeoutMs: number
  private now: () => number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private wsServer: WebsterServer, options: McpSessionManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs()
    this.now = options.now ?? Date.now
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  getSessionIds(): string[] {
    return [...this.sessions.keys()]
  }

  /** Begin the periodic idle sweep. Opt-in, like the capture retention sweep; never holds the process open. */
  start(): void {
    if (this.sweepTimer || this.idleTimeoutMs <= 0) return
    this.sweepTimer = setInterval(() => this.sweepIdle(), SESSION_SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /**
   * Expire sessions that have been idle past the bound. A client that crashes
   * without a DELETE never closes its transport, so nothing else would ever
   * release its context. A session with an in-flight request or an open SSE
   * stream is never expired. Returns the ids it expired.
   */
  sweepIdle(): string[] {
    if (this.idleTimeoutMs <= 0) return []
    const cutoff = this.now() - this.idleTimeoutMs
    const expired: string[] = []
    for (const [id, transport] of [...this.sessions]) {
      const a = this.activity.get(id)
      if (a && (a.busy > 0 || a.lastSeen > cutoff)) continue
      this.forget(id)
      expired.push(id)
      console.error(`Webster: MCP session expired after idling id=${id} (${this.sessions.size} active)`)
      transport.close().catch(() => { /* already closed */ })
    }
    return expired
  }

  async handleRequest(req: Request): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id')

    if (sessionId) {
      const existing = this.sessions.get(sessionId)
      if (!existing) return Response.json({ error: 'Session not found' }, { status: 404 })
      return this.track(sessionId, () => existing.handleRequest(req))
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
        this.activity.set(id, { lastSeen: this.now(), busy: 0 })
        ctx.id = id
        this.wsServer.registerSession(ctx)
        const ownerNote = owner ? ` ownerFp=${ownerFingerprint(owner)}` : ''
        console.error(`Webster: MCP session started id=${id}${ownerNote} (${this.sessions.size} active)`)
      },
      onsessionclosed: (id) => {
        this.forget(id)
        console.error(`Webster: MCP session closed id=${id} (${this.sessions.size} active)`)
      },
    })

    // Sessions whose transport is closed without a DELETE must not leak their context.
    transport.onclose = () => {
      if (transport.sessionId) this.forget(transport.sessionId)
    }

    const server = buildMcpServer(this.wsServer, ctx)
    await server.connect(transport)
    return transport.handleRequest(req)
  }

  private forget(id: string): void {
    this.sessions.delete(id)
    this.activity.delete(id)
    this.wsServer.forgetSession(id)
  }

  /**
   * Run one request for a session. The session counts as busy until the whole
   * response is delivered: an SSE body outlives handleRequest(), so a streamed
   * reply (or an idle GET stream) keeps the session alive until it ends.
   */
  private async track(id: string, run: () => Promise<Response>): Promise<Response> {
    const a = this.activity.get(id)
    if (!a) return run()
    a.busy++
    a.lastSeen = this.now()
    let handedOff = false
    try {
      const res = await run()
      const streamed = this.trackStream(a, res)
      handedOff = streamed !== res
      return streamed
    } finally {
      if (!handedOff) this.release(a)
    }
  }

  /** Wrap an SSE response so its busy count is held until the stream ends or the client drops it. */
  private trackStream(a: { lastSeen: number; busy: number }, res: Response): Response {
    if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) return res
    const reader = res.body.getReader()
    const now = this.now
    let released = false
    const finish = () => {
      if (released) return
      released = true
      this.release(a)
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            finish()
            controller.close()
            return
          }
          a.lastSeen = now() // SSE activity keeps the session alive
          controller.enqueue(value)
        } catch (err) {
          finish()
          controller.error(err)
        }
      },
      cancel(reason) {
        finish()
        return reader.cancel(reason)
      },
    })
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  private release(a: { lastSeen: number; busy: number }): void {
    a.busy--
    a.lastSeen = this.now()
  }
}
