import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { isResult, type WsCommand, type WsMessage } from './protocol.js'

// ─── Registry ─────────────────────────────────────────────────────────────────
// Each Webster server process registers itself so concurrent sessions can
// discover each other and avoid stomping on the same tabs.

interface RegistryEntry {
  port: number
  pid: number
  started: string
}

const REGISTRY_DIR = join(homedir(), '.webster')
const REGISTRY_FILE = join(REGISTRY_DIR, 'registry.json')

function readRegistry(): RegistryEntry[] {
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8')) as RegistryEntry[]
  } catch {
    return []
  }
}

function writeRegistry(entries: RegistryEntry[]): void {
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true })
    writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2))
  } catch { /* ignore — registry is best-effort */ }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

interface ConnectedExtension {
  id: string
  browser: string
  version: string
  transport: 'ws' | 'http'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws?: any
  pollResolve?: ((cmd: WsCommand) => void) | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtServer = Bun.Server<any>

export class WebsterServer {
  private extensions = new Map<string, ConnectedExtension>()
  private activeExtensionId: string | null = null
  private pending = new Map<string, PendingCommand>()
  private server: ExtServer
  private commandTimeout: number

  // HTTP long-poll transport — result handlers indexed by command id
  private httpResultHandlers = new Map<string, (result: WsMessage) => void>()

  // MCP HTTP handler — set by index.ts after session manager is created
  private mcpHandler: ((req: Request) => Promise<Response>) | null = null

  // Tab ownership — soft advisory locking for concurrent Claude sessions
  private tabOwnership = new Map<number, string>() // tabId → 'port:pid'

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

  setMcpHandler(handler: (req: Request) => Promise<Response>): void {
    this.mcpHandler = handler
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleFetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/mcp') {
      if (this.mcpHandler) return this.mcpHandler(req)
      return new Response('MCP not configured', { status: 503 })
    }

    if (req.method === 'POST' && url.pathname === '/connect') {
      let body: { browser?: string; version?: string } = {}
      try {
        body = await req.json() as { browser?: string; version?: string }
      } catch {
        // ignore — body is optional for backward compat
      }
      // Evict any stale HTTP connections for the same browser (SW restart without clean disconnect)
      const browserName = body.browser ?? 'unknown'
      for (const [existingId, existing] of this.extensions) {
        if (existing.transport === 'http' && existing.browser === browserName) {
          this.extensions.delete(existingId)
          if (this.activeExtensionId === existingId) this.activeExtensionId = null
        }
      }

      const id = crypto.randomUUID() as string
      const ext: ConnectedExtension = {
        id,
        browser: browserName,
        version: body.version ?? 'unknown',
        transport: 'http',
        pollResolve: null,
      }
      this.extensions.set(id, ext)
      if (this.activeExtensionId === null) {
        this.activeExtensionId = id
      }
      console.error(`Webster: extension v${ext.version} (${ext.browser}) connected (HTTP), id=${id}`)
      return Response.json({ id })
    }

    if (req.method === 'DELETE' && url.pathname === '/connect') {
      const id = url.searchParams.get('id') ?? null
      if (id) {
        const ext = this.extensions.get(id)
        if (ext) {
          this.extensions.delete(id)
          if (this.activeExtensionId === id) {
            this.activeExtensionId = this.extensions.size > 0 ? this.extensions.keys().next().value! : null
          }
          console.error(`Webster: extension disconnected (HTTP), id=${id}`)
          this.rejectPendingOnDisconnect()
        }
      }
      return new Response(null, { status: 204 })
    }

    if (req.method === 'GET' && url.pathname === '/poll') {
      const id = url.searchParams.get('id') ?? null
      const ext = id ? this.extensions.get(id) : null
      if (!ext || ext.transport !== 'http') {
        return new Response('Unknown extension id', { status: 404 })
      }

      // Long-poll: hold the connection open until a command arrives or timeout
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          ext.pollResolve = null
          resolve(Response.json({ type: 'keepalive' }))
        }, 25000)

        ext.pollResolve = (cmd: WsCommand) => {
          clearTimeout(timer)
          ext.pollResolve = null
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

    if (req.method === 'GET' && url.pathname === '/registry') {
      const entries = readRegistry().filter(e => isProcessAlive(e.pid))
      return Response.json(entries)
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
      // Check if this ws is already tracked (re-handshake)
      const existing = [...this.extensions.values()].find((e) => e.ws === ws)
      if (existing) {
        existing.browser = msg.browser ?? existing.browser
        existing.version = msg.version
        console.error(`Webster: extension v${existing.version} (${existing.browser}) re-connected`)
        return
      }

      const id = crypto.randomUUID() as string
      const ext: ConnectedExtension = {
        id,
        browser: msg.browser ?? 'unknown',
        version: msg.version,
        transport: 'ws',
        ws,
      }
      this.extensions.set(id, ext)
      if (this.activeExtensionId === null) {
        this.activeExtensionId = id
      }
      console.error(`Webster: extension v${ext.version} (${ext.browser}) connected, id=${id}`)
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
    const ext = [...this.extensions.values()].find((e) => e.ws === ws)
    if (!ext) return

    this.extensions.delete(ext.id)
    if (this.activeExtensionId === ext.id) {
      this.activeExtensionId = this.extensions.size > 0 ? this.extensions.keys().next().value! : null
    }
    console.error(`Webster: extension disconnected (${ext.browser}), id=${ext.id}`)
    this.rejectPendingOnDisconnect()
  }

  private getActiveExtension(): ConnectedExtension {
    if (this.extensions.size === 0) {
      throw new Error('Extension not connected')
    }
    if (this.activeExtensionId !== null) {
      const ext = this.extensions.get(this.activeExtensionId)
      if (ext) return ext
    }
    if (this.extensions.size === 1) {
      return this.extensions.values().next().value!
    }
    throw new Error('Multiple browsers connected — use set_browser to choose')
  }

  getBrowsers(): Array<{ id: string; browser: string; version: string; transport: string; active: boolean }> {
    return [...this.extensions.values()].map((ext) => ({
      id: ext.id,
      browser: ext.browser,
      version: ext.version,
      transport: ext.transport,
      active: ext.id === this.activeExtensionId,
    }))
  }

  setBrowser(idOrBrowserName: string): { id: string; browser: string; version: string; transport: string; active: boolean } {
    // Try exact id match first, then browser name match
    let found: ConnectedExtension | undefined =
      this.extensions.get(idOrBrowserName) ??
      [...this.extensions.values()].find((e) => e.browser === idOrBrowserName)

    if (!found) {
      throw new Error(`No connected extension matching '${idOrBrowserName}'`)
    }

    this.activeExtensionId = found.id
    return {
      id: found.id,
      browser: found.browser,
      version: found.version,
      transport: found.transport,
      active: true,
    }
  }

  dispatch(command: Omit<WsCommand, 'id'>, timeoutMs?: number): Promise<unknown> {
    let ext: ConnectedExtension
    try {
      ext = this.getActiveExtension()
    } catch (err) {
      return Promise.reject(err)
    }

    const id = crypto.randomUUID() as string
    const msg: WsCommand = { id, ...command } as WsCommand
    const timeout = timeoutMs ?? this.commandTimeout

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id)
        this.httpResultHandlers.delete(id)
        reject(new Error(`Command timed out after ${Math.round(timeout / 1000)}s`))
      }, timeout)

      this.pending.set(id, { resolve, reject, timeoutHandle })

      if (ext.transport === 'ws') {
        ext.ws!.send(JSON.stringify(msg))
      } else {
        // HTTP long-poll path (Safari)
        if (ext.pollResolve) {
          ext.pollResolve(msg)
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
    return this.extensions.size > 0
  }

  // ─── Registry ────────────────────────────────────────────────────────────

  registerSelf(): void {
    const alive = readRegistry().filter(e => isProcessAlive(e.pid))
    alive.push({ port: this.port, pid: process.pid, started: new Date().toISOString() })
    writeRegistry(alive)
  }

  deregisterSelf(): void {
    const remaining = readRegistry().filter(e => !(e.port === this.port && e.pid === process.pid))
    writeRegistry(remaining)
  }

  // ─── Tab ownership ───────────────────────────────────────────────────────

  claimTab(tabId: number | undefined): { claimed: boolean; tabId: number | null; owner: string } {
    if (tabId == null) {
      return { claimed: false, tabId: null, owner: '', }
    }
    const owner = `${this.port}:${process.pid}`
    this.tabOwnership.set(tabId, owner)
    return { claimed: true, tabId, owner }
  }

  releaseTab(tabId: number | undefined): void {
    if (tabId != null) this.tabOwnership.delete(tabId)
  }

  getClaimedTabs(): Array<{ tabId: number; owner: string }> {
    return [...this.tabOwnership.entries()].map(([tabId, owner]) => ({ tabId, owner }))
  }

  close(): void {
    this.deregisterSelf()
    this.server.stop(true)
  }
}
