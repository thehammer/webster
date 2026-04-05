import { isResult, type WsCommand, type WsMessage } from './protocol.js'

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtServer = Bun.Server<any>

export class WebsterServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extension: any = null
  private pending = new Map<string, PendingCommand>()
  private server: ExtServer
  private commandTimeout: number

  // HTTP long-poll transport (Safari)
  private httpConnected = false
  private pollResolve: ((cmd: WsCommand) => void) | null = null
  private httpResultHandlers = new Map<string, (result: WsMessage) => void>()

  constructor(port: number, commandTimeout = 30000) {
    this.commandTimeout = commandTimeout

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.server = (Bun.serve as any)({
      port,
      idleTimeout: 0, // disable idle timeout — long-poll connections must stay open for up to 25s
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (req: Request, server: any) => this.handleFetch(req, server),
      websocket: {
        open: (ws: unknown) => this.handleOpen(ws),
        message: (ws: unknown, data: string | Buffer) => this.handleMessage(ws, data),
        close: (ws: unknown) => this.handleClose(ws),
      },
    })
  }

  get port(): number {
    return this.server.port as number
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleFetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/connect') {
      this.httpConnected = true
      console.error('Webster: extension connected (HTTP)')
      return new Response(null, { status: 204 })
    }

    if (req.method === 'DELETE' && url.pathname === '/connect') {
      this.httpConnected = false
      this.pollResolve = null
      console.error('Webster: extension disconnected (HTTP)')
      this.rejectPendingOnDisconnect()
      return new Response(null, { status: 204 })
    }

    if (req.method === 'GET' && url.pathname === '/poll') {
      // Long-poll: hold the connection open until a command arrives or timeout
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          this.pollResolve = null
          resolve(Response.json({ type: 'keepalive' }))
        }, 25000)

        this.pollResolve = (cmd: WsCommand) => {
          clearTimeout(timer)
          this.pollResolve = null
          resolve(Response.json(cmd))
        }
      })
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      let body: WsMessage
      try {
        body = await req.json() as WsMessage
      } catch {
        return new Response('Bad JSON', { status: 400 })
      }
      this.handleHttpResult(body)
      return new Response(null, { status: 204 })
    }

    // Attempt WebSocket upgrade for all other requests
    if (server.upgrade(req)) return undefined as unknown as Response
    return new Response('Webster MCP server', { status: 200 })
  }

  private handleHttpResult(msg: WsMessage) {
    if (!isResult(msg)) return

    const handler = this.httpResultHandlers.get(msg.id)
    if (handler) {
      this.httpResultHandlers.delete(msg.id)
      handler(msg)
      return
    }

    // Fall through to the shared pending map (resolves/rejects the dispatch promise)
    const pending = this.pending.get(msg.id)
    if (!pending) return

    clearTimeout(pending.timeoutHandle)
    this.pending.delete(msg.id)

    if (msg.success) {
      pending.resolve(msg.data)
    } else {
      pending.reject(new Error(msg.error ?? 'Command failed'))
    }
  }

  private rejectPendingOnDisconnect() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle)
      pending.reject(new Error('Extension disconnected'))
      this.pending.delete(id)
    }
  }

  private handleOpen(_ws: unknown) {
    // Don't track yet — wait for the { type: 'connected' } handshake message.
    // This prevents test clients or stray connections from hijacking the slot.
  }

  private handleMessage(ws: unknown, data: string | Buffer) {
    let msg: WsMessage
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString())
    } catch {
      console.error('Webster: failed to parse message', data)
      return
    }

    if (!isResult(msg)) {
      // It's a WsEvent — the extension identifying itself
      if (this.extension && this.extension !== ws) {
        // Close the previously tracked connection cleanly
        try { (this.extension as { close(): void }).close() } catch { /* ignore */ }
      }
      this.extension = ws
      console.error(`Webster: extension v${msg.version} connected`)
      return
    }

    const pending = this.pending.get(msg.id)
    if (!pending) return

    clearTimeout(pending.timeoutHandle)
    this.pending.delete(msg.id)

    if (msg.success) {
      pending.resolve(msg.data)
    } else {
      pending.reject(new Error(msg.error ?? 'Command failed'))
    }
  }

  private handleClose(ws: unknown) {
    // Only clear extension if it was the tracked WS extension (not an HTTP client)
    if (this.extension === ws) {
      this.extension = null
      console.error('Extension disconnected')
      this.rejectPendingOnDisconnect()
    }
  }

  dispatch(command: Omit<WsCommand, 'id'>): Promise<unknown> {
    if (!this.extension && !this.httpConnected) {
      return Promise.reject(new Error('Extension not connected'))
    }

    const id = crypto.randomUUID() as string
    const msg: WsCommand = { id, ...command } as WsCommand

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id)
        this.httpResultHandlers.delete(id)
        reject(new Error('Command timed out after 30s'))
      }, this.commandTimeout)

      this.pending.set(id, { resolve, reject, timeoutHandle })

      if (this.extension) {
        // WebSocket path (Chrome/Firefox)
        this.extension!.send(JSON.stringify(msg))
      } else {
        // HTTP long-poll path (Safari)
        if (this.pollResolve) {
          this.pollResolve(msg)
        } else {
          // No active poll — reject immediately
          clearTimeout(timeoutHandle)
          this.pending.delete(id)
          reject(new Error('Extension not polling'))
        }
      }
    })
  }

  isConnected(): boolean {
    return this.extension !== null || this.httpConnected
  }

  close(): void {
    this.server.stop(true)
  }
}
