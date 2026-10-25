import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import { homedir } from 'os'
import {
  isResult, isCaptureEvent, isCaptureDone, isCaptureBody, isCapturePush,
  isConnectedEvent, isPeerState, isSelectForOwner, isUnregister,
  type WsCommand, type WsMessage, type WsEvent, type WsCaptureEvent, type WsCaptureDone, type WsCaptureBody,
} from './protocol.js'
import { isLoopbackAddress, isAllowedHost, isWebPageOrigin, isExtensionOrigin, ownerFingerprint } from './net-guard.js'
import { INSTANCE_ID_RE, validateWebkitHandshake, validatePeerState, sanitizeReason } from './peer-validation.js'
import { CaptureSession, cleanOldSessions, CAPTURES_DIR, parseCaptureConfig, type CaptureConfig, type CaptureEvent, type RetentionOptions } from './capture.js'
import { buildStartCaptureResult, startCaptureDispatchFailureMessage } from './capture-result.js'
import {
  BrowserRegistry, engineForExtension, goneMessage, labelOf,
  type BrowserInfo, type ConnectedBrowser, type SessionContext,
} from './browser-registry.js'
import { handleReplayRequest } from './replay.js'
import { buildDashboardHtml } from './dashboard.js'
import { FAVICON_SVG } from './favicon.js'

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

/** How often the server re-runs the capture retention sweep. */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000 // hourly

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
  /** The browser the command was sent to — a disconnect only fails its own commands. */
  browserId: string
}

/** Per-connection data attached at WebSocket upgrade (D6). */
interface WsConnectionData {
  remoteAddress: string | undefined
  origin: string | null
  host: string | null
}

export type { Binding, SessionContext, BrowserInfo } from './browser-registry.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtServer = Bun.Server<any>

/** A WebSocket that has not registered as a browser within this long is closed. */
const HANDSHAKE_TIMEOUT_MS = 10_000

/** The name native peers must use; extensions may not claim it. */
const RESERVED_PEER_NAME = 'nostromo'

/** Header carrying the per-registration secret an HTTP extension must present on /poll, /result and DELETE /connect. */
const HTTP_TOKEN_HEADER = 'x-webster-token'

/**
 * The only browser that may register over HTTP without an extension-scheme
 * Origin. Safari's service worker long-polls (WebSockets are blocked there) and
 * may send no Origin; Chrome, Edge and Firefox use the WebSocket door, which
 * does require one. Any other name over HTTP needs an extension Origin.
 */
const HTTP_NO_ORIGIN_BROWSERS: ReadonlySet<string> = new Set(['safari'])

/** An HTTP registration that has not connected, polled or posted for this long no longer holds its name. */
const HTTP_LIVE_MS = 60_000

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class WebsterServer {
  private registry = new BrowserRegistry()
  // Sockets that have completed a handshake. A socket gets exactly one — even
  // after it unregisters — so a peer can never re-handshake as an extension.
  private handshaken = new WeakSet<object>()
  private pending = new Map<string, PendingCommand>()
  private server: ExtServer
  private commandTimeout: number

  // MCP HTTP handler — set by index.ts after session manager is created
  private mcpHandler: ((req: Request) => Promise<Response>) | null = null

  // Tab ownership — soft advisory locking for concurrent Claude sessions
  private tabOwnership = new Map<number, string>() // tabId → 'port:pid'

  // Active capture session — receives push events from extension
  private captureSession: CaptureSession | null = null
  // Owner of the browser the capture was started on (null = extensions). Pushes
  // from a connection with a different owner are ignored (D7).
  private captureOwner: string | null = null
  private startedAt = Date.now()

  // Retention sweep — opt-in only. Constructing a server must never start a
  // destructive timer by default: the test suite builds a dozen servers, and a
  // default-on sweep would point them all at the operator's real captures.
  private retentionTimer: ReturnType<typeof setInterval> | null = null
  private retentionOptions: RetentionOptions | null = null
  private handshakeTimeoutMs: number
  private httpLiveMs: number
  // Pending handshake timers per socket, cleared when the socket closes or the server does.
  private handshakeTimers = new Map<unknown, ReturnType<typeof setTimeout>>()

  constructor(port: number, commandTimeout = 30000, options?: { retention?: boolean | RetentionOptions; handshakeTimeoutMs?: number; httpLiveMs?: number }) {
    this.commandTimeout = commandTimeout
    this.handshakeTimeoutMs = options?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
    this.httpLiveMs = options?.httpLiveMs ?? HTTP_LIVE_MS

    if (options?.retention) {
      this.retentionOptions = options.retention === true ? {} : options.retention
      this.sweepRetention() // sweep once at startup, as the old constructor did
      this.retentionTimer = setInterval(() => this.sweepRetention(), RETENTION_SWEEP_INTERVAL_MS)
      // Never let the sweep timer hold the process open.
      this.retentionTimer.unref?.()
    }

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

  // ─── Per-session selection (see browser-registry.ts) ─────────────────────

  createSessionContext(owner: string | null): SessionContext {
    return this.registry.createSessionContext(owner)
  }

  registerSession(ctx: SessionContext): void {
    this.registry.registerSession(ctx)
  }

  forgetSession(id: string): void {
    this.registry.forgetSession(id)
  }

  peek(ctx: SessionContext): ConnectedBrowser | null {
    return this.registry.peek(ctx)
  }

  getBrowsers(ctx?: SessionContext): BrowserInfo[] {
    return this.registry.list(ctx)
  }

  setBrowser(idOrBrowserName: string, ctx: SessionContext): BrowserInfo {
    return this.registry.select(idOrBrowserName, ctx)
  }

  /**
   * Send a command to a browser. With a session context the target is that
   * session's binding; without one (the HTTP API and legacy callers) it is the
   * server default, re-evaluated each time.
   */
  dispatch(command: Omit<WsCommand, 'id'>, timeoutMs?: number, ctx?: SessionContext): Promise<unknown> {
    let target: ConnectedBrowser
    try {
      target = ctx ? this.registry.resolve(ctx) : this.defaultBrowser()
    } catch (err) {
      return Promise.reject(err)
    }
    return this.sendTo(target, command, timeoutMs)
  }
  isConnected(): boolean {
    return this.registry.serverDefault() !== null
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

  // ─── Capture session management ───────────────────────────────────────

  startCaptureSession(config: CaptureConfig, ctx?: SessionContext): CaptureSession {
    // Stop any existing session
    if (this.captureSession?.active) {
      this.captureSession.finalize()
    }
    // The capture belongs to whichever browser the start command will reach.
    this.captureOwner = (ctx ? this.peek(ctx)?.owner : null) ?? null
    const id = crypto.randomUUID() as string
    this.captureSession = new CaptureSession(id, config)
    return this.captureSession
  }

  getCaptureSession(): CaptureSession | null {
    return this.captureSession
  }

  stopCaptureSession(): CaptureSession | null {
    const session = this.captureSession
    if (session?.active) {
      session.finalize()
    }
    return session
  }

  // ─── Retention ────────────────────────────────────────────────────────

  /** True while a retention sweep timer is armed. Off unless opted in. */
  get retentionEnabled(): boolean {
    return this.retentionTimer !== null
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  close(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer)
      this.retentionTimer = null
    }
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer)
    this.handshakeTimers.clear()
    if (this.captureSession?.active) {
      this.captureSession.finalize()
    }
    this.deregisterSelf()
    this.server.stop(true)
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleFetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url)

    // D6: loopback + Host on every route. Rejecting by peer address (not by
    // bind address) avoids IPv4/IPv6 `localhost` resolution surprises.
    if (process.env.WEBSTER_ALLOW_NON_LOOPBACK !== '1') {
      if (!isLoopbackAddress(server.requestIP(req)?.address)) {
        return new Response('Webster accepts loopback connections only', { status: 403 })
      }
      if (!isAllowedHost(req.headers.get('host'))) {
        return new Response('Webster: unexpected Host header', { status: 403 })
      }
    }

    // D6: web pages must not reach the extension and MCP endpoints.
    const webPageOrigin = isWebPageOrigin(req.headers.get('origin'))
    const originRefused = (): Response => new Response('Webster: web page origins are not allowed', { status: 403 })
    const guardedPath =
      url.pathname === '/mcp' || url.pathname === '/connect' || url.pathname === '/poll' || url.pathname === '/result'
    if (webPageOrigin && guardedPath) return originRefused()

    // State-changing /api calls (capture start/stop, session edits) must not be
    // drivable cross-origin from a web page — a text/plain POST needs no preflight.
    // The dashboard's own fetches are same-origin, so those stay allowed.
    if (webPageOrigin && url.pathname.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD') {
      let sameOrigin = false
      try { sameOrigin = new URL(req.headers.get('origin')!).host === req.headers.get('host') } catch { /* opaque origin */ }
      if (!sameOrigin) return originRefused()
    }

    if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
      return new Response(FAVICON_SVG, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
      })
    }

    if (url.pathname === '/mcp') {
      if (this.mcpHandler) return this.mcpHandler(req)
      return new Response('MCP not configured', { status: 503 })
    }

    if (req.method === 'POST' && url.pathname === '/connect') {
      let body: { kind?: unknown; browser?: unknown; version?: unknown; instanceId?: unknown } = {}
      try {
        body = await req.json() as typeof body
      } catch {
        // ignore — body is optional for backward compat
      }
      // Native peers register over WebSocket only.
      if (body.kind !== undefined && body.kind !== 'extension') {
        return Response.json({ error: 'Only extensions can register over HTTP' }, { status: 400 })
      }
      const browserName = typeof body.browser === 'string' ? body.browser : 'unknown'
      if (browserName === RESERVED_PEER_NAME) return Response.json({ error: `'${RESERVED_PEER_NAME}' is reserved for native peers` }, { status: 400 })

      const extOrigin = isExtensionOrigin(req.headers.get('origin'))
      const presented = req.headers.get(HTTP_TOKEN_HEADER)
      const own = presented ? this.httpBrowserByToken(presented) : undefined
      if (own && own.browser === browserName) {
        // The same extension reconnecting with its own token (service-worker restart): replace it.
        this.removeBrowser(own)
      } else if (extOrigin) {
        // Old builds hold no token; their extension-scheme Origin is the credential. They replace
        // stale or Origin-credentialed HTTP connections for the same browser (SW restart without
        // clean disconnect), but an Origin header alone never displaces a live registration that
        // is held by a token.
        const holders = this.registry.all().filter((b) => b.transport === 'http' && b.browser === browserName)
        if (holders.some((b) => !b.originAuth && this.isLive(b))) {
          return Response.json({ error: `'${browserName}' is already connected` }, { status: 409 })
        }
        for (const existing of holders) this.removeBrowser(existing)
      } else {
        // No Origin and no matching token: this is the only way a stranger can look like Safari, so it
        // may only be Safari, and it may never displace or share the name with a live registration.
        if (!HTTP_NO_ORIGIN_BROWSERS.has(browserName)) {
          return Response.json({ error: `Registering as '${browserName}' over HTTP needs an extension Origin` }, { status: 403 })
        }
        const holders = this.registry.all().filter((b) => b.kind === 'extension' && b.browser === browserName)
        if (holders.some((b) => this.isLive(b))) {
          return Response.json({ error: `'${browserName}' is already connected` }, { status: 409 })
        }
        for (const stale of holders) {
          if (stale.transport === 'http') this.removeBrowser(stale)
        }
      }

      const id = crypto.randomUUID() as string
      const httpToken = randomBytes(32).toString('base64url')
      const ext: ConnectedBrowser = {
        id,
        browser: browserName,
        version: typeof body.version === 'string' ? body.version : 'unknown',
        transport: 'http',
        kind: 'extension',
        owner: null,
        instanceId: typeof body.instanceId === 'string' && INSTANCE_ID_RE.test(body.instanceId) ? body.instanceId : undefined,
        connectedAt: this.registry.nextConnectedAt(),
        engine: engineForExtension(browserName),
        pollResolve: null,
        httpToken,
        originAuth: extOrigin && !own,
        lastSeen: Date.now(),
      }
      this.registry.add(ext)
      console.error(`Webster: extension v${ext.version} (${ext.browser}) connected (HTTP), id=${id}`)
      return Response.json({ id, token: httpToken })
    }

    if (req.method === 'DELETE' && url.pathname === '/connect') {
      const id = url.searchParams.get('id') ?? null
      const ext = id ? this.registry.get(id) : undefined
      if (ext && ext.transport === 'http') {
        if (!this.httpAuthorized(ext, req)) return new Response('Missing or wrong token', { status: 403 })
        this.removeBrowser(ext)
        console.error(`Webster: extension disconnected (HTTP), id=${id}`)
      }
      return new Response(null, { status: 204 })
    }

    if (req.method === 'GET' && url.pathname === '/poll') {
      const id = url.searchParams.get('id') ?? null
      const ext = id ? this.registry.get(id) : null
      if (!ext || ext.transport !== 'http') {
        return new Response('Unknown extension id', { status: 404 })
      }
      // The id is listed in /api/status, so it is not a credential: without the token a stranger
      // could poll the registration and steal its commands.
      if (!this.httpAuthorized(ext, req)) return new Response('Missing or wrong token', { status: 403 })
      ext.lastSeen = Date.now()

      // Long-poll: hold the connection open until a command arrives or timeout
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          ext.pollResolve = null
          ext.lastSeen = Date.now()
          resolve(Response.json({ type: 'keepalive' }))
        }, 25000)

        ext.pollResolve = (cmd: WsCommand) => {
          clearTimeout(timer)
          ext.pollResolve = null
          ext.lastSeen = Date.now()
          resolve(Response.json(cmd))
        }
      })
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      // Only a registered HTTP extension may post: results and capture pushes alike.
      const sender = this.httpSender(req)
      if (!sender) return new Response('Missing or wrong token', { status: 403 })
      let body: WsMessage
      try {
        body = await req.json() as WsMessage
      } catch {
        return new Response('Bad JSON', { status: 400 })
      }
      sender.lastSeen = Date.now()
      this.handleHttpResult(body, sender)
      return new Response(null, { status: 204 })
    }

    if (req.method === 'GET' && url.pathname === '/registry') {
      const entries = readRegistry().filter(e => isProcessAlive(e.pid))
      return Response.json(entries)
    }

    // ─── Dashboard & API ──────────────────────────────────────────────────

    if (req.method === 'GET' && url.pathname === '/dashboard') {
      return new Response(buildDashboardHtml(this.port), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const uptime = Date.now() - this.startedAt
      const sec = Math.round(uptime / 1000)
      const uptimeStr = sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
      const snap = this.captureSession?.active ? this.captureSession.getSnapshot() : null
      return Response.json({
        running: true,
        uptime: uptimeStr,
        pid: process.pid,
        port: this.port,
        extensions: this.getBrowsers(),
        ownedBrowserCount: this.registry.all().filter((b) => b.owner !== null).length,
        capture: snap ? { active: true, sessionId: snap.sessionId, duration: snap.duration, eventCount: snap.eventCount, frameCount: snap.frameCount } : { active: false },
        sessionCount: this.countSessions(),
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return Response.json(this.listSessions())
    }

    if (req.method === 'POST' && url.pathname === '/api/capture/start') {
      let body: Record<string, unknown> = {}
      try { body = await req.json() as Record<string, unknown> } catch { /* empty config */ }
      const session = this.startCaptureSession(parseCaptureConfig(body))
      let reply: Record<string, unknown> | undefined
      try {
        reply = await this.dispatch({
          ...body,
          action: 'startCapture', // after the spread: the request body must not choose the action
          streamToServer: true,
        }, 60000) as Record<string, unknown>
      } catch (e) {
        // Don't leave an orphaned "active" session behind if the extension
        // never confirmed the start.
        this.stopCaptureSession()
        return Response.json({ error: startCaptureDispatchFailureMessage(e) }, { status: 500 })
      }
      return Response.json(buildStartCaptureResult(session, reply))
    }

    if (req.method === 'POST' && url.pathname === '/api/capture/annotate') {
      const session = this.captureSession
      if (!session?.active) return Response.json({ error: 'No active capture' }, { status: 400 })
      let body: Record<string, unknown> = {}
      try { body = await req.json() as Record<string, unknown> } catch { /* empty body ok */ }
      const text = typeof body.text === 'string' ? body.text : ''
      if (!text) return Response.json({ error: 'text is required' }, { status: 400 })
      const tag = typeof body.tag === 'string' ? body.tag : undefined
      const color = typeof body.color === 'string' ? body.color : undefined
      session.appendAnnotation(text, tag, color)
      return Response.json({ success: true, sessionId: session.id, eventCount: session.getSnapshot().eventCount })
    }

    if (req.method === 'POST' && url.pathname === '/api/capture/stop') {
      try {
        await this.dispatch({ action: 'stopCapture' }, 60000)
      } catch { /* extension may be gone — finalize anyway */ }
      const session = this.stopCaptureSession()
      if (!session) return Response.json({ error: 'No active capture' }, { status: 400 })
      return Response.json(session.getSnapshot())
    }

    if (req.method === 'GET' && url.pathname === '/api/capture/current') {
      const snap = this.captureSession?.active ? this.captureSession.getSnapshot() : null
      if (!snap) return Response.json({ active: false })
      return Response.json(snap)
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/sessions/')) {
      const id = url.pathname.slice('/api/sessions/'.length)
      if (!id || /[\/\\.]/.test(id)) return new Response('Invalid ID', { status: 400 })
      const metaPath = join(CAPTURES_DIR, id, 'meta.json')
      if (!existsSync(metaPath)) return new Response('Not found', { status: 404 })
      let body: Record<string, unknown> = {}
      try { body = await req.json() as Record<string, unknown> } catch { return new Response('Bad JSON', { status: 400 }) }
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      if (body.name !== undefined) meta.name = body.name || null
      writeFileSync(metaPath, JSON.stringify(meta, null, 2))
      return Response.json(meta)
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
      const id = url.pathname.slice('/api/sessions/'.length)
      if (!id || /[\/\\.]/.test(id)) return new Response('Invalid ID', { status: 400 })
      const dir = join(CAPTURES_DIR, id)
      if (!existsSync(dir)) return new Response('Not found', { status: 404 })
      const { rmSync } = await import('fs')
      rmSync(dir, { recursive: true, force: true })
      return new Response(null, { status: 204 })
    }

    // Replay viewer
    if (url.pathname.startsWith('/replay/')) {
      return handleReplayRequest(req, CAPTURES_DIR)
    }

    // Attempt WebSocket upgrade for all other requests
    if (webPageOrigin) return originRefused()
    const data: WsConnectionData = {
      remoteAddress: server.requestIP(req)?.address,
      origin: req.headers.get('origin'),
      host: req.headers.get('host'),
    }
    if (server.upgrade(req, { data })) return undefined as unknown as Response
    return new Response('Webster MCP server', { status: 200 })
  }

  private handleHttpResult(msg: WsMessage, sender: ConnectedBrowser) {
    // Capture push events via HTTP (Safari path)
    if (isCapturePush(msg)) {
      this.handleCaptureEvent(msg, sender.owner) // HTTP senders are extensions, hence unowned
      return
    }
    if (isResult(msg)) this.handleResult(msg, sender)
  }

  /** The HTTP registration holding this token, if any. */
  private httpBrowserByToken(token: string): ConnectedBrowser | undefined {
    return this.registry.all().find((b) => b.transport === 'http' && b.httpToken !== undefined && tokensEqual(b.httpToken, token))
  }

  /**
   * The HTTP registration a /result request speaks for: the token's owner, or — only for an
   * old-build registration that holds no token — the one an extension-scheme Origin vouches for.
   */
  private httpSender(req: Request): ConnectedBrowser | undefined {
    const token = req.headers.get(HTTP_TOKEN_HEADER)
    if (token) return this.httpBrowserByToken(token)
    if (!isExtensionOrigin(req.headers.get('origin'))) return undefined
    return this.registry.all().find((b) => b.transport === 'http' && b.originAuth)
  }

  private httpAuthorized(ext: ConnectedBrowser, req: Request): boolean {
    const token = req.headers.get(HTTP_TOKEN_HEADER)
    if (token) return ext.httpToken !== undefined && tokensEqual(ext.httpToken, token)
    return ext.originAuth === true && isExtensionOrigin(req.headers.get('origin'))
  }

  /** Whether a registration still holds its name: a socket is live while open; an HTTP one while it keeps polling or has a command out. */
  private isLive(b: ConnectedBrowser): boolean {
    if (b.transport === 'ws') return true
    for (const p of this.pending.values()) if (p.browserId === b.id) return true
    return Date.now() - (b.lastSeen ?? b.connectedAt) < this.httpLiveMs
  }

  // ─── Connections ─────────────────────────────────────────────────────────

  /** Drop a connection and fail only the commands that were sent to it. */
  private removeBrowser(browser: ConnectedBrowser, reason?: string): void {
    this.registry.remove(browser)
    this.rejectPendingFor(browser, reason)
  }

  private rejectPendingFor(browser: ConnectedBrowser, reason?: string): void {
    const message = `Extension disconnected. ${goneMessage(labelOf(browser), reason)}`
    for (const [id, pending] of this.pending) {
      if (pending.browserId !== browser.id) continue
      clearTimeout(pending.timeoutHandle)
      this.pending.delete(id)
      pending.reject(new Error(message))
    }
  }

  private handleOpen(ws: unknown) {
    // Don't track yet — wait for the { type: 'connected' } handshake message.
    // This prevents test clients or stray connections from hijacking the slot.
    // A socket that never registers is closed after a short bound.
    const timer = setTimeout(() => {
      this.handshakeTimers.delete(ws)
      if (this.registry.findByWs(ws)) return
      try { (ws as { close(code?: number, reason?: string): void }).close(1008, 'handshake timeout') } catch { /* already closed */ }
    }, this.handshakeTimeoutMs)
    timer.unref?.()
    this.handshakeTimers.set(ws, timer)
  }

  private handleMessage(ws: unknown, data: string | Buffer) {
    let msg: WsMessage
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString())
    } catch {
      console.error('Webster: failed to parse message') // never echo the payload: a handshake carries the owner token
      return
    }
    if (typeof msg !== 'object' || msg === null) return

    // Capture push events — a browser streaming data to the server
    // Only a currently registered browser may push (an un-handshaken socket, or
    // a peer that unregistered, has no owner and must not read as unowned).
    if (isCapturePush(msg)) {
      const sender = this.registry.findByWs(ws)
      if (sender) this.handleCaptureEvent(msg, sender.owner)
      return
    }

    if (isResult(msg)) {
      this.handleResult(msg, this.registry.findByWs(ws))
      return
    }

    // Everything else is keyed on `type`. Unknown types are never a handshake.
    if (isConnectedEvent(msg)) {
      this.handleHandshake(ws, msg)
    } else if (isPeerState(msg)) {
      this.handlePeerState(ws, msg)
    } else if (isSelectForOwner(msg)) {
      this.handleSelectForOwner(ws)
    } else if (isUnregister(msg)) {
      this.handleUnregister(ws, msg.reason)
    } else {
      console.error(`Webster: ignoring message with unknown type '${String((msg as { type?: unknown }).type).slice(0, 40)}'`)
    }
  }

  private handleResult(msg: { id: string; success: boolean; data?: unknown; error?: string }, sender: ConnectedBrowser | undefined) {
    const pending = this.pending.get(msg.id)
    if (!pending) return
    // A result only counts when it comes from the browser the command went to.
    if (!sender || sender.id !== pending.browserId) return

    clearTimeout(pending.timeoutHandle)
    this.pending.delete(msg.id)

    if (msg.success) {
      pending.resolve(msg.data)
    } else {
      pending.reject(new Error(msg.error ?? 'Command failed'))
    }
  }

  private handleHandshake(ws: unknown, msg: WsEvent) {
    const socket = ws as { close(code?: number, reason?: string): void }
    const refuse = (reason: string) => {
      console.error(`Webster: refused handshake (${reason})`)
      socket.close(1008, reason)
    }

    // One handshake per socket: once registered (as anything) or unregistered,
    // a socket may not register again, least of all under another kind or name.
    if (this.handshaken.has(ws as object)) return refuse('one handshake per connection')

    const kind = msg.kind ?? 'extension'
    if (kind === 'webkit') {
      this.registerWebkitPeer(ws, msg)
      return
    }
    if (kind !== 'extension') {
      console.error('Webster: ignoring handshake with unknown kind')
      return
    }

    if (msg.browser === RESERVED_PEER_NAME) return refuse('reserved browser name')

    // A real extension's WebSocket carries an extension-scheme Origin. A socket
    // with none (a native peer, a script) may only register as a webkit peer.
    const conn = (ws as { data?: WsConnectionData }).data
    if (!isExtensionOrigin(conn?.origin)) return refuse('extension origin required')

    const id = crypto.randomUUID() as string
    const browserName = typeof msg.browser === 'string' ? msg.browser : 'unknown'
    const ext: ConnectedBrowser = {
      id,
      browser: browserName,
      version: typeof msg.version === 'string' ? msg.version : 'unknown',
      transport: 'ws',
      kind: 'extension',
      owner: null, // extensions are always unowned: any `owner` they send is ignored
      instanceId: typeof msg.instanceId === 'string' && INSTANCE_ID_RE.test(msg.instanceId) ? msg.instanceId : undefined,
      connectedAt: this.registry.nextConnectedAt(),
      engine: engineForExtension(browserName),
      ws,
    }
    this.registry.add(ext)
    this.handshaken.add(ws as object)
    console.error(`Webster: extension v${ext.version} (${ext.browser}) connected, id=${id}`)
  }

  /** Register a native peer, or refuse it by closing the socket with 1008 (D5). */
  private registerWebkitPeer(ws: unknown, msg: WsEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const socket = ws as any
    const refuse = (reason: string) => {
      console.error(`Webster: refused webkit peer registration (${reason})`)
      socket.close(1008, reason)
    }

    // Always loopback-only and Origin-free, even with WEBSTER_ALLOW_NON_LOOPBACK.
    const conn = socket.data as WsConnectionData | undefined
    if (!conn || !isLoopbackAddress(conn.remoteAddress)) return refuse('not loopback')
    if (conn.origin !== null) return refuse('Origin header present')

    const parsed = validateWebkitHandshake(msg)
    if (!parsed.ok) return refuse(parsed.reason)
    const peer = parsed.value

    if (this.registry.hasWebkitInstance(peer.instanceId)) return refuse('instanceId already registered')

    const id = crypto.randomUUID() as string
    this.registry.add({
      id,
      browser: peer.browser,
      version: peer.version,
      transport: 'ws',
      kind: 'webkit',
      owner: peer.owner,
      instanceId: peer.instanceId,
      connectedAt: this.registry.nextConnectedAt(),
      engine: peer.engine,
      focus: peer.focus,
      profile: peer.profile,
      driver: peer.driver,
      limitations: peer.limitations,
      toolSupport: peer.toolSupport,
      ws,
    })
    this.handshaken.add(ws as object)
    console.error(`Webster: webkit peer v${peer.version} (${peer.browser}) connected, id=${id}, ownerFp=${ownerFingerprint(peer.owner)}`)
  }

  /** The registered webkit peer on this connection, or undefined for anything else. */
  private peerOn(ws: unknown): ConnectedBrowser | undefined {
    const b = this.registry.findByWs(ws)
    return b?.kind === 'webkit' ? b : undefined
  }

  private handlePeerState(ws: unknown, msg: Parameters<typeof validatePeerState>[0]) {
    const peer = this.peerOn(ws)
    if (!peer) return
    const parsed = validatePeerState(msg)
    if (!parsed.ok) {
      console.error(`Webster: ignored invalid peer_state (${parsed.reason})`)
      return
    }
    Object.assign(peer, parsed.value)
  }

  private handleSelectForOwner(ws: unknown) {
    const peer = this.peerOn(ws)
    if (peer) this.registry.pinPeerForOwner(peer)
  }

  private handleUnregister(ws: unknown, rawReason: unknown) {
    const peer = this.peerOn(ws)
    if (!peer) return
    const reason = sanitizeReason(rawReason)

    this.registry.unregisterPeer(peer, reason)
    this.rejectPendingFor(peer, reason)
    console.error(`Webster: webkit peer unregistered, id=${peer.id}`)
  }

  private handleClose(ws: unknown) {
    clearTimeout(this.handshakeTimers.get(ws))
    this.handshakeTimers.delete(ws)
    const ext = this.registry.findByWs(ws)
    if (!ext) return

    this.removeBrowser(ext)
    console.error(`Webster: ${ext.kind === 'webkit' ? 'webkit peer' : 'extension'} disconnected (${ext.browser}), id=${ext.id}`)
  }

  private defaultBrowser(): ConnectedBrowser {
    const def = this.registry.serverDefault()
    if (!def) throw new Error('Extension not connected')
    return def
  }

  private sendTo(ext: ConnectedBrowser, command: Omit<WsCommand, 'id'>, timeoutMs?: number): Promise<unknown> {
    const id = crypto.randomUUID() as string
    const msg: WsCommand = { id, ...command } as WsCommand
    const timeout = timeoutMs ?? this.commandTimeout

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Command timed out after ${Math.round(timeout / 1000)}s`))
      }, timeout)

      this.pending.set(id, { resolve, reject, timeoutHandle, browserId: ext.id })

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

  private handleCaptureEvent(msg: WsCaptureEvent | WsCaptureDone | WsCaptureBody, senderOwner: string | null): void {
    if (!this.captureSession?.active) return
    if (senderOwner !== this.captureOwner) return

    if (isCaptureEvent(msg)) {
      if (msg.kind === 'frame') {
        // Frame data arrives as base64 JPEG — decode and write to disk
        const base64 = (msg.data.jpeg as string) || ''
        if (base64) {
          const buffer = Buffer.from(base64, 'base64')
          this.captureSession.appendFrame(buffer)
        }
      } else {
        // Network, input, websocket, dom, storage, annotation, console, page, meta — append as-is
        const event: CaptureEvent = {
          kind: msg.kind,
          timestamp: (msg.data.timestamp as number) || Date.now(),
          ...msg.data,
        }
        this.captureSession.appendEvent(event)
      }
    } else if (isCaptureBody(msg)) {
      // Binary response body — write to bodies/ and rewrite the matching
      // network event so the large payload is referenced, not inlined.
      const buffer = Buffer.from(msg.data ?? '', 'base64')
      const ref = this.captureSession.appendBody(msg.requestId, buffer, msg.mimeType)
      if (ref) {
        this.captureSession.attachBodyReference(msg.requestId, ref, msg.mimeType)
      }
    } else if (isCaptureDone(msg)) {
      this.captureSession.finalize()
    }
  }

  /**
   * Run one retention sweep, always excluding the live capture — its
   * CaptureSession holds absolute paths and appends as it goes, so removing
   * the directory underneath it corrupts the session.
   */
  private sweepRetention(): void {
    if (!this.retentionOptions) return
    const excludeIds = [...(this.retentionOptions.excludeIds ?? [])]
    // `?.active` is load-bearing: captureSession is never nulled on stop, so
    // an unguarded read would exempt the most recently *finished* capture from
    // retention forever — silently, since only warnings and deletions log.
    // Note the exclusion is per-process; two servers sharing CAPTURES_DIR
    // don't know about each other's live captures.
    if (this.captureSession?.active) excludeIds.push(this.captureSession.id)
    cleanOldSessions({ ...this.retentionOptions, excludeIds })
  }

  // ─── Session listing ──────────────────────────────────────────────────

  private countSessions(): number {
    if (!existsSync(CAPTURES_DIR)) return 0
    return readdirSync(CAPTURES_DIR).filter(e => existsSync(join(CAPTURES_DIR, e, 'meta.json'))).length
  }

  private listSessions(): Array<Record<string, unknown>> {
    if (!existsSync(CAPTURES_DIR)) return []
    const entries = readdirSync(CAPTURES_DIR)
    const sessions: Array<Record<string, unknown>> = []
    for (const entry of entries) {
      const metaPath = join(CAPTURES_DIR, entry, 'meta.json')
      if (!existsSync(metaPath)) continue
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
        const port = Number(process.env.WEBSTER_PORT ?? 3456)
        meta.replayUrl = `http://localhost:${port}/replay/${entry}`
        // Mark stale "active" sessions — if it's not the current live capture, it's abandoned
        if (meta.status === 'active' && meta.id !== this.captureSession?.id) {
          meta.status = 'abandoned'
        }
        sessions.push(meta)
      } catch { /* skip corrupt sessions */ }
    }
    sessions.sort((a, b) => {
      const ta = new Date(a.startedAt as string).getTime() || 0
      const tb = new Date(b.startedAt as string).getTime() || 0
      return tb - ta
    })
    return sessions
  }
}
