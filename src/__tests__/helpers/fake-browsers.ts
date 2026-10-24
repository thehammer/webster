/**
 * Test helpers for BP0 (per-session browser selection): real WebSocket fake
 * extensions and fake Nostromo (webkit) peers, a real MCP-over-HTTP client,
 * a raw-TCP HTTP client (for Host / Origin control) and a console recorder.
 *
 * Nothing here mocks the server. Every helper that opens a socket registers
 * itself so `Rig.close()` can tear everything down.
 */
import { createHash } from 'crypto'
import { WebsterServer } from '../../server.js'
import { McpSessionManager } from '../../mcp.js'

// ─── Small utilities ─────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = server.port as number
    server.stop(true)
    setTimeout(() => resolve(port), 10)
  })
}

/** Poll `fn` until it returns a truthy value; throws on timeout. */
export async function eventually<T>(
  fn: () => T | Promise<T>,
  { timeout = 2000, interval = 10, what = 'condition' }: { timeout?: number; interval?: number; what?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const v = await fn()
      if (v) return v as NonNullable<T>
    } catch (e) {
      last = e
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`)
    }
    await sleep(interval)
  }
}

/** A valid owner token (D1 format) made of one repeated character. */
export const token = (ch = 'T', len = 32) => ch.repeat(len)

/** A random valid owner token. */
export const randomToken = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex')

let instanceCounter = 0
/** A valid, unique webkit instanceId. */
export const newInstanceId = () => `inst-${Date.now().toString(36)}-${++instanceCounter}-${Math.random().toString(36).slice(2, 8)}`

// ─── Rig: one server + MCP manager on a random port ──────────────────────────

const liveClosers = new Set<() => void>()

export interface Rig {
  server: WebsterServer
  mgr: McpSessionManager
  port: number
  close(): void
}

export async function startRig(commandTimeoutMs = 2000): Promise<Rig> {
  const port = await findFreePort()
  const server = new WebsterServer(port, commandTimeoutMs)
  const mgr = new McpSessionManager(server)
  server.setMcpHandler((req) => mgr.handleRequest(req))
  return {
    server,
    mgr,
    port,
    close() {
      for (const c of [...liveClosers]) {
        try { c() } catch { /* already closed */ }
      }
      liveClosers.clear()
      try { server.getCaptureSession()?.cleanup() } catch { /* best effort */ }
      server.close()
    },
  }
}

// ─── HTTP status helpers (black-box registration probes) ─────────────────────

export interface StatusBody {
  extensions: Array<{ id: string; browser: string; version: string; transport: string; active: boolean; kind?: string; engine?: string }>
  ownedBrowserCount?: number
  [k: string]: unknown
}

export async function getStatus(port: number): Promise<StatusBody> {
  const res = await fetch(`http://localhost:${port}/api/status`)
  return (await res.json()) as StatusBody
}

async function counts(port: number): Promise<{ ext: number; owned: number }> {
  const s = await getStatus(port)
  return { ext: s.extensions.length, owned: s.ownedBrowserCount ?? 0 }
}

// ─── Fake extension ──────────────────────────────────────────────────────────

export interface FakeExtensionOptions {
  version?: string
  /** Extra handshake fields merged over the default handshake (undefined values are omitted). */
  handshake?: Record<string, unknown>
  /** Upgrade headers (Origin, Host, ...). */
  headers?: Record<string, string>
  /** Never reply to any command. */
  hang?: boolean
  /** Don't wait for the server to list this browser. */
  skipRegistrationWait?: boolean
}

export interface CloseInfo { code: number; reason: string }

export interface FakeBrowser {
  ws: WebSocket
  browser: string
  /** Every command the server sent to this socket, in order. */
  received: any[]
  /** Resolves when the client socket has closed. */
  closed: Promise<CloseInfo>
  actions(): string[]
  send(msg: unknown): void
  /** Hang (never auto-reply) for one action, or all actions if omitted. */
  setHang(action?: string, hang?: boolean): void
  /** Auto-reply to `action` with this data. */
  setReply(action: string, data: unknown): void
  /** Auto-reply to `action` with an error. */
  setFailure(action: string, error: string): void
  /** Manually answer a (hung) command. */
  reply(cmd: { id: string }, result?: { success?: boolean; data?: unknown; error?: string }): void
  waitForCommand(action: string, timeout?: number): Promise<any>
  /** Close the socket and wait until the server no longer lists it. */
  close(): Promise<void>
}

function openSocket(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}`
  const ws = headers
    ? new (WebSocket as any)(url, { headers }) as WebSocket
    : new WebSocket(url)
  return new Promise<WebSocket>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 3000)
    ws.onopen = () => { clearTimeout(t); resolve(ws) }
    ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket connection failed')) }
  })
}

function makeCloseTracker(ws: WebSocket): Promise<CloseInfo> {
  return new Promise<CloseInfo>((resolve) => {
    ws.onclose = (ev: any) => resolve({ code: ev.code, reason: ev.reason })
  })
}

interface CommandDriver {
  received: any[]
  setHang(action?: string, hang?: boolean): void
  setReply(action: string, data: unknown): void
  setFailure(action: string, error: string): void
  reply(cmd: { id: string }, result?: { success?: boolean; data?: unknown; error?: string }): void
  waitForCommand(action: string, timeout?: number): Promise<any>
  actions(): string[]
}

/** Shared command handling for fake extensions and fake peers. */
function driveCommands(ws: WebSocket, by: string, hangAll: boolean): CommandDriver {
  const received: any[] = []
  const hangs = new Set<string>()
  const replies = new Map<string, unknown>()
  const failures = new Map<string, string>()
  let hangEverything = hangAll
  const waiters: Array<{ action: string; resolve: (c: any) => void }> = []

  ws.addEventListener('message', (ev: MessageEvent) => {
    let cmd: any
    try { cmd = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
    if (!cmd || typeof cmd !== 'object' || typeof cmd.id !== 'string' || typeof cmd.action !== 'string') return
    received.push(cmd)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].action === cmd.action) { waiters[i].resolve(cmd); waiters.splice(i, 1) }
    }
    if (hangEverything || hangs.has(cmd.action)) return
    if (ws.readyState !== WebSocket.OPEN) return
    if (failures.has(cmd.action)) {
      ws.send(JSON.stringify({ id: cmd.id, success: false, error: failures.get(cmd.action) }))
      return
    }
    const data = replies.has(cmd.action) ? replies.get(cmd.action) : { echo: cmd.action, by }
    ws.send(JSON.stringify({ id: cmd.id, success: true, data }))
  })

  return {
    received,
    actions: () => received.map((c) => c.action),
    setHang(action, hang = true) {
      if (action === undefined) { hangEverything = hang; return }
      if (hang) hangs.add(action); else hangs.delete(action)
    },
    setReply(action, data) { replies.set(action, data); failures.delete(action) },
    setFailure(action, error) { failures.set(action, error) },
    reply(cmd, result = {}) {
      ws.send(JSON.stringify({ id: cmd.id, success: result.success ?? true, data: result.data ?? { echo: (cmd as any).action, by }, error: result.error }))
    },
    waitForCommand(action, timeout = 2000) {
      const existing = received.find((c) => c.action === action)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`Timed out waiting for command '${action}' at ${by}`)), timeout)
        waiters.push({ action, resolve: (c) => { clearTimeout(t); resolve(c) } })
      })
    },
  }
}

export async function connectFakeExtension(
  port: number,
  browser: string,
  opts: FakeExtensionOptions = {},
): Promise<FakeBrowser> {
  const before = opts.skipRegistrationWait ? null : await counts(port)
  const ws = await openSocket(port, opts.headers)
  const closed = makeCloseTracker(ws)
  const driver = driveCommands(ws, browser, opts.hang === true)

  ws.send(JSON.stringify({ type: 'connected', version: opts.version ?? '1.0', browser, ...(opts.handshake ?? {}) }))

  if (before) {
    await eventually(async () => (await counts(port)).ext > before.ext, { what: `${browser} extension to be listed` })
  }
  // Keep connectedAt strictly increasing between consecutive fakes.
  await sleep(3)

  let didClose = false
  const closer = () => { didClose = true; try { ws.close() } catch { /* ignore */ } }
  liveClosers.add(closer)

  return {
    ws,
    browser,
    ...driver,
    closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    async close() {
      const c0 = await counts(port).catch(() => null)
      closer()
      await closed
      liveClosers.delete(closer)
      if (c0 && !opts.skipRegistrationWait) {
        await eventually(async () => (await counts(port)).ext < c0.ext, { what: `${browser} extension to be dropped` })
      }
      void didClose
    },
  }
}

// ─── Fake webkit (Nostromo) peer ─────────────────────────────────────────────

export interface FakePeerOptions {
  owner?: string
  instanceId?: string
  focus?: { tag: string; name: string }
  profile?: string
  driver?: string
  limitations?: unknown
  toolSupport?: Record<string, { level: string; note?: string }>
  browser?: string
  version?: string
  headers?: Record<string, string>
  /** Merged over the handshake last. Keys whose value is `undefined` are omitted from the wire. */
  overrides?: Record<string, unknown>
  hang?: boolean
  /** Wait until the server lists this peer (default true). Set false to test refusals. */
  awaitRegistration?: boolean
}

export interface FakePeer extends Omit<FakeBrowser, 'browser'> {
  browser: string
  instanceId: string
  owner: string | undefined
  focus: { tag: string; name: string }
  handshake: Record<string, unknown>
  peerState(patch: Record<string, unknown>): void
  selectForOwner(): void
  unregister(reason?: string): void
}

export async function connectFakePeer(port: number, opts: FakePeerOptions = {}): Promise<FakePeer> {
  const awaitRegistration = opts.awaitRegistration !== false
  const before = awaitRegistration ? await counts(port) : null
  const ws = await openSocket(port, opts.headers)
  const closed = makeCloseTracker(ws)
  const browser = opts.browser ?? 'nostromo'
  const driver = driveCommands(ws, browser, opts.hang === true)
  const instanceId = opts.instanceId ?? newInstanceId()
  const focus = opts.focus ?? { tag: 'tab-1', name: 'Pane One' }

  const handshake: Record<string, unknown> = {
    type: 'connected',
    kind: 'webkit',
    version: opts.version ?? '1.0',
    browser,
    instanceId,
    owner: 'owner' in opts ? opts.owner : token('T'),
    engine: 'webkit',
    focus,
    profile: opts.profile ?? 'default',
    driver: opts.driver ?? 'agent',
    limitations: opts.limitations ?? [],
    ...(opts.toolSupport ? { toolSupport: opts.toolSupport } : {}),
    ...(opts.overrides ?? {}),
  }
  ws.send(JSON.stringify(handshake))

  if (before) {
    await eventually(async () => (await counts(port)).owned > before.owned, { what: 'webkit peer to be registered' })
  }
  await sleep(3)

  let unregistered = false
  const closer = () => { try { ws.close() } catch { /* ignore */ } }
  liveClosers.add(closer)

  return {
    ws,
    browser,
    instanceId,
    owner: handshake.owner as string | undefined,
    focus,
    handshake,
    ...driver,
    closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    peerState: (patch) => ws.send(JSON.stringify({ type: 'peer_state', ...patch })),
    selectForOwner: () => ws.send(JSON.stringify({ type: 'select_for_owner' })),
    unregister: (reason) => {
      unregistered = true
      ws.send(JSON.stringify(reason === undefined ? { type: 'unregister' } : { type: 'unregister', reason }))
    },
    async close() {
      const c0 = awaitRegistration && !unregistered ? await counts(port).catch(() => null) : null
      closer()
      await closed
      liveClosers.delete(closer)
      if (c0 && c0.owned > 0 && !unregistered) {
        await eventually(async () => (await counts(port)).owned < c0.owned, { what: 'webkit peer to be dropped' })
      }
    },
  }
}

/** A bare WebSocket with no automatic handshake, for protocol edge cases. */
export interface RawSocket {
  ws: WebSocket
  closed: Promise<CloseInfo>
  received: any[]
  send(msg: unknown): void
  close(): void
}

export async function rawSocket(port: number, headers?: Record<string, string>): Promise<RawSocket> {
  const ws = await openSocket(port, headers)
  const closed = makeCloseTracker(ws)
  const received: any[] = []
  ws.addEventListener('message', (ev: MessageEvent) => {
    try { received.push(JSON.parse(String(ev.data))) } catch { received.push(ev.data) }
  })
  const closer = () => { try { ws.close() } catch { /* ignore */ } }
  liveClosers.add(closer)
  return { ws, closed, received, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)), close: closer }
}

/** Resolve with the close info, or null if the socket stays open for `ms`. */
export async function closedWithin(p: { closed: Promise<CloseInfo> }, ms: number): Promise<CloseInfo | null> {
  return Promise.race([p.closed, sleep(ms).then(() => null)])
}

// ─── MCP client ──────────────────────────────────────────────────────────────

const MCP_ACCEPT = 'application/json, text/event-stream'

function initBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'redd-test', version: '1.0' } },
  }
}

/** Parse an MCP HTTP response body (SSE or JSON) into the JSON-RPC messages it carries. */
async function readRpcMessages(res: Response): Promise<any[]> {
  const text = await res.text()
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream')) {
    const out: any[] = []
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim()
        if (payload) { try { out.push(JSON.parse(payload)) } catch { /* ignore non-JSON data */ } }
      }
    }
    return out
  }
  if (!text) return []
  try {
    const j = JSON.parse(text)
    return Array.isArray(j) ? j : [j]
  } catch {
    return []
  }
}

/** POST initialize without finishing the handshake. Header `X-Webster-Owner` is sent iff `owner !== undefined` (even ''). */
export function rawInitialize(port: number, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT, ...headers },
    body: JSON.stringify(initBody()),
  })
}

export interface ToolResult {
  text: string
  isError: boolean
  /** `text` with the server's leading "Error: " stripped when isError. */
  message: string
  /** `JSON.parse(text)`, or undefined if the text is not JSON. */
  json: any
}

export interface McpClient {
  sessionId: string
  owner: string | undefined
  callTool(name: string, args?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<ToolResult>
  /** Send an arbitrary JSON-RPC body on this session, optionally with extra headers. */
  request(body: unknown, extraHeaders?: Record<string, string>): Promise<Response>
  browsers(extraHeaders?: Record<string, string>): Promise<any[]>
}

let rpcId = 100

export async function mcpSession(port: number, owner?: string): Promise<McpClient> {
  const initHeaders: Record<string, string> = {}
  if (owner !== undefined) initHeaders['X-Webster-Owner'] = owner
  const res = await rawInitialize(port, initHeaders)
  if (res.status !== 200) throw new Error(`MCP initialize failed with HTTP ${res.status}: ${await res.text()}`)
  const sessionId = res.headers.get('mcp-session-id')
  if (!sessionId) throw new Error('MCP initialize returned no mcp-session-id')
  await readRpcMessages(res)

  const post = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT, 'mcp-session-id': sessionId, ...extra },
      body: JSON.stringify(body),
    })

  const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await ack.text()

  async function callTool(name: string, args: Record<string, unknown> = {}, extra: Record<string, string> = {}): Promise<ToolResult> {
    const id = ++rpcId
    const r = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, extra)
    const msgs = await readRpcMessages(r)
    const msg = msgs.find((m) => m.id === id)
    if (!msg) throw new Error(`No JSON-RPC response for ${name} (HTTP ${r.status})`)
    if (msg.error) throw new Error(`JSON-RPC error from ${name}: ${JSON.stringify(msg.error)}`)
    const text: string = msg.result?.content?.[0]?.text ?? ''
    const isError = msg.result?.isError === true
    let json: any
    try { json = JSON.parse(text) } catch { json = undefined }
    return { text, isError, message: isError ? text.replace(/^Error: /, '') : text, json }
  }

  const client: McpClient = {
    sessionId,
    owner,
    callTool,
    request: (body, extra) => post(body, extra),
    async browsers(extra) {
      const r = await callTool('get_browsers', {}, extra)
      if (r.isError || !Array.isArray(r.json)) throw new Error(`get_browsers failed: ${r.text}`)
      return r.json
    },
  }
  return client
}

/** The browsers entry flagged active for a session's next command, if any. */
export const activeEntry = (list: any[]) => list.find((b) => b.active === true)

// ─── Raw HTTP over TCP (full control of Host / Origin / Upgrade) ─────────────

export interface RawHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export function rawHttp(
  port: number,
  req: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<RawHttpResponse> {
  const method = req.method ?? 'GET'
  const path = req.path ?? '/'
  const headers: Record<string, string> = { Host: `localhost:${port}`, Connection: 'close', ...(req.headers ?? {}) }
  // Case-insensitive de-dupe: caller-supplied Host/Connection win.
  const seen = new Set<string>()
  const lines: string[] = []
  for (const [k, v] of Object.entries(headers).reverse()) {
    if (seen.has(k.toLowerCase())) continue
    seen.add(k.toLowerCase())
    lines.unshift(`${k}: ${v}`)
  }
  if (req.body !== undefined && !seen.has('content-length')) lines.push(`Content-Length: ${Buffer.byteLength(req.body)}`)
  const wire = `${method} ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${req.body ?? ''}`

  return new Promise<RawHttpResponse>((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let done = false
    const finish = (sock: { end(): void }) => {
      if (done) return
      const parsed = parse(buf, true)
      if (!parsed) return
      done = true
      try { sock.end() } catch { /* ignore */ }
      resolve(parsed)
    }
    function parse(b: Buffer, final: boolean): RawHttpResponse | null {
      const text = b.toString('utf8')
      const idx = text.indexOf('\r\n\r\n')
      if (idx < 0) return null
      const head = text.slice(0, idx).split('\r\n')
      const status = Number(head[0].split(' ')[1])
      const hdrs: Record<string, string> = {}
      for (const l of head.slice(1)) {
        const i = l.indexOf(':')
        if (i > 0) hdrs[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
      }
      const bodyText = Buffer.from(text.slice(idx + 4), 'utf8')
      if (status === 101 || status === 204 || status === 304) return { status, headers: hdrs, body: '' }
      const cl = hdrs['content-length'] !== undefined ? Number(hdrs['content-length']) : null
      if (cl !== null && bodyText.length >= cl) return { status, headers: hdrs, body: bodyText.subarray(0, cl).toString('utf8') }
      if (final && cl === null) return { status, headers: hdrs, body: bodyText.toString('utf8') }
      return null
    }
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error(`rawHttp timeout for ${method} ${path}`)) } }, 4000)
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(sock) { sock.write(wire) },
        data(sock, data) {
          buf = Buffer.concat([buf, Buffer.from(data)])
          const p = parse(buf, false)
          if (p && !done) { done = true; clearTimeout(timer); try { sock.end() } catch { /* ignore */ } resolve(p) }
        },
        close(sock) {
          clearTimeout(timer)
          finish(sock)
          if (!done) { done = true; reject(new Error(`connection closed before a response for ${method} ${path}`)) }
        },
        error(_sock, err) { if (!done) { done = true; clearTimeout(timer); reject(err) } },
      },
    }).catch((e) => { if (!done) { done = true; clearTimeout(timer); reject(e) } })
  })
}

/** Headers for a raw WebSocket upgrade request. */
export const upgradeHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version': '13',
  ...extra,
})

// ─── Console recorder ────────────────────────────────────────────────────────

export interface ConsoleRecorder {
  lines: string[]
  text(): string
  restore(): void
}

export function recordConsole(): ConsoleRecorder {
  const lines: string[] = []
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug }
  const fmt = (args: unknown[]) =>
    args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' ')
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) {
    ;(console as any)[k] = (...args: unknown[]) => { lines.push(fmt(args)) }
  }
  return {
    lines,
    text: () => lines.join('\n'),
    restore() { Object.assign(console, orig) },
  }
}

// ─── Misc assertions shared by tests ─────────────────────────────────────────

/** Exact D4 "gone" text. */
export const goneText = (label: string, reason?: string) =>
  `The selected browser is gone (${reason ? `${label}: ${reason}` : label}): call get_browsers and set_browser`

export const peerLabel = (focusName: string) => `nostromo, focus "${focusName}"`
