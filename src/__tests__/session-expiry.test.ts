/**
 * BP0 follow-up WR-3: MCP sessions that die without a DELETE do not live (and
 * leak their registry context) forever. `McpSessionManager.sweepIdle()` expires
 * sessions idle past `idleTimeoutMs` — judged by an injectable clock — unless
 * they have a request in flight or an open SSE stream.
 *
 * Each test builds its own server + manager (the clock is injected, so nothing
 * here sleeps through the idle bound) and drives the real /mcp endpoint over HTTP.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { WebsterServer } from '../server.js'
import { McpSessionManager } from '../mcp.js'
import {
  connectFakeExtension, connectFakePeer, mcpSession, findFreePort, eventually, sleep, token,
  type FakeBrowser,
} from './helpers/fake-browsers.js'

const IDLE = 10 * 60_000 // 10 minutes of (fake) idleness expires a session
const HOUR = 3_600_000
const T = token('T')

interface World {
  server: WebsterServer
  mgr: McpSessionManager
  port: number
  /** Move the injected clock forward. */
  advance(ms: number): void
  /** Session ids the registry was told to forget, in order. */
  forgotten: string[]
}

const worlds: Array<() => void> = []
afterEach(() => {
  for (const close of worlds.splice(0)) {
    try { close() } catch { /* already closed */ }
  }
})

async function startWorld(opts: { idleTimeoutMs?: number | 'default' } = {}): Promise<World> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? IDLE
  let port = await findFreePort()
  let server: WebsterServer | undefined
  for (let attempt = 0; !server; attempt++) {
    try {
      server = new WebsterServer(port, 3000)
    } catch (err) {
      if (attempt >= 4) throw err
      port = await findFreePort()
    }
  }
  const clock = { t: 1_700_000_000_000 }
  const now = () => clock.t
  const mgr = new McpSessionManager(server, idleTimeoutMs === 'default' ? { now } : { idleTimeoutMs, now })
  server.setMcpHandler((req) => mgr.handleRequest(req))

  const forgotten: string[] = []
  const realForget = server.forgetSession.bind(server)
  server.forgetSession = (id: string) => { forgotten.push(id); realForget(id) }

  worlds.push(() => server!.close())
  return { server, mgr, port, advance: (ms) => { clock.t += ms }, forgotten }
}

const mcpUrl = (w: World) => `http://localhost:${w.port}/mcp`
const ACCEPT = 'application/json, text/event-stream'

/** A request on an existing session, outside the McpClient helper. */
const rawOnSession = (w: World, sessionId: string, body: unknown) =>
  fetch(mcpUrl(w), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: ACCEPT, 'mcp-session-id': sessionId },
    body: JSON.stringify(body),
  })

const listTools = (w: World, sessionId: string) =>
  rawOnSession(w, sessionId, { jsonrpc: '2.0', id: 4242, method: 'tools/list' })

const sseHeaders = (sessionId: string) => ({ Accept: 'text/event-stream', 'mcp-session-id': sessionId })

/**
 * Hold a standalone SSE stream (GET /mcp) open for a session. The response
 * only resolves once the server writes a first chunk, so it is deliberately not
 * awaited; abort the returned controller to drop the stream like a client that
 * went away without a DELETE.
 */
function openSseStream(w: World, sessionId: string): AbortController {
  const ac = new AbortController()
  fetch(mcpUrl(w), { headers: sseHeaders(sessionId), signal: ac.signal })
    .then((res) => res.body?.cancel())
    .catch(() => { /* aborted by the test */ })
  return ac
}

/** A session accepts only one standalone stream, so a second GET answering 409 proves the first is open. */
async function streamIsOpen(w: World, sessionId: string) {
  await sleep(50) // let the stream's own request reach the server before probing
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 1500) // a probe that hangs opened a stream itself: there was none
  try {
    const probe = await fetch(mcpUrl(w), { headers: sseHeaders(sessionId), signal: ac.signal })
    await probe.text()
    expect(probe.status, 'a second SSE GET must be refused while the first is open').toBe(409)
  } finally {
    clearTimeout(timer)
  }
}

async function expectSessionGone(w: World, sessionId: string) {
  const res = await listTools(w, sessionId)
  expect(res.status).toBe(404)
  expect(await res.json()).toEqual({ error: 'Session not found' })
}

async function expectSessionAlive(w: World, sessionId: string) {
  const res = await listTools(w, sessionId)
  expect(res.status).toBe(200)
  await res.text()
}

describe('idle sessions are expired', () => {
  test('a session idle past the bound is removed, forgotten by the registry, and answers 404 afterwards', async () => {
    const w = await startWorld()
    const a = await mcpSession(w.port)
    const b = await mcpSession(w.port)
    expect(w.mgr.sessionCount).toBe(2)

    w.advance(IDLE + 1)
    const swept = w.mgr.sweepIdle()

    expect([...swept].sort()).toEqual([a.sessionId, b.sessionId].sort())
    expect(w.mgr.sessionCount).toBe(0)
    expect(w.mgr.getSessionIds()).toEqual([])
    expect([...new Set(w.forgotten)].sort()).toEqual([a.sessionId, b.sessionId].sort())
    await expectSessionGone(w, a.sessionId)
    await expectSessionGone(w, b.sessionId)
  })

  test('a session idle for less than the bound is kept', async () => {
    const w = await startWorld()
    const a = await mcpSession(w.port)

    w.advance(IDLE - 1)

    expect(w.mgr.sweepIdle()).toEqual([])
    expect(w.mgr.sessionCount).toBe(1)
    expect(w.mgr.getSessionIds()).toEqual([a.sessionId])
    await expectSessionAlive(w, a.sessionId)
  })

  test('sweeping is idempotent: a second sweep expires nothing more', async () => {
    const w = await startWorld()
    await mcpSession(w.port)
    w.advance(IDLE + 1)

    expect(w.mgr.sweepIdle()).toHaveLength(1)
    expect(w.mgr.sweepIdle()).toEqual([])
    expect(w.mgr.sessionCount).toBe(0)
    expect(new Set(w.forgotten).size).toBe(1)
  })

  test('sweeping with no sessions is a no-op', async () => {
    const w = await startWorld()
    w.advance(10 * IDLE)
    expect(w.mgr.sweepIdle()).toEqual([])
    expect(w.mgr.sessionCount).toBe(0)
  })

  test('a session closed with DELETE is gone already and is not reported as swept', async () => {
    const w = await startWorld()
    const a = await mcpSession(w.port)
    const del = await fetch(mcpUrl(w), { method: 'DELETE', headers: { 'mcp-session-id': a.sessionId, Accept: ACCEPT } })
    expect(del.status).toBeLessThan(300)
    expect(w.mgr.sessionCount).toBe(0)

    w.advance(IDLE + 1)
    expect(w.mgr.sweepIdle()).toEqual([])
    await expectSessionGone(w, a.sessionId)
  })
})

describe('activity keeps a session alive', () => {
  test('a tool call refreshes the idle clock', async () => {
    const w = await startWorld()
    const busy = await mcpSession(w.port)
    const quiet = await mcpSession(w.port)

    w.advance(IDLE - 100)
    expect((await busy.callTool('get_browsers')).isError).toBe(false)
    w.advance(200) // busy: 200ms idle; quiet: IDLE + 100ms idle

    expect(w.mgr.sweepIdle()).toEqual([quiet.sessionId])
    expect(w.mgr.getSessionIds()).toEqual([busy.sessionId])
    await expectSessionAlive(w, busy.sessionId)
    await expectSessionGone(w, quiet.sessionId)

    // ... and once busy goes quiet for a full window it follows.
    w.advance(IDLE + 1)
    expect(w.mgr.sweepIdle()).toEqual([busy.sessionId])
  })

  test('any request carrying the session id counts, not just tool calls', async () => {
    const w = await startWorld()
    const a = await mcpSession(w.port)

    w.advance(IDLE - 100)
    await expectSessionAlive(w, a.sessionId) // tools/list
    w.advance(200)

    expect(w.mgr.sweepIdle()).toEqual([])
    expect(w.mgr.sessionCount).toBe(1)
  })

  test('requests made again and again keep a session alive across many windows', async () => {
    const w = await startWorld()
    const a = await mcpSession(w.port)
    for (let i = 0; i < 5; i++) {
      w.advance(IDLE - 1)
      expect(w.mgr.sweepIdle()).toEqual([])
      expect((await a.callTool('get_browsers')).isError).toBe(false)
    }
    expect(w.mgr.getSessionIds()).toEqual([a.sessionId])
  })
})

describe('in-flight requests and open streams are never swept', () => {
  test('a tool call whose browser command is hung keeps its session; idle neighbours are still swept', async () => {
    const w = await startWorld()
    const chrome: FakeBrowser = await connectFakeExtension(w.port, 'chrome')
    chrome.setHang('getTabs')
    const busy = await mcpSession(w.port)
    const idle = await mcpSession(w.port)

    const call = busy.callTool('get_tabs')
    const cmd = await chrome.waitForCommand('getTabs')

    w.advance(IDLE + 1)
    expect(w.mgr.sweepIdle()).toEqual([idle.sessionId])
    expect(w.mgr.getSessionIds()).toEqual([busy.sessionId])

    // The call still completes on its own session.
    chrome.reply(cmd, { data: [{ id: 1 }] })
    const r = await call
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual([{ id: 1 }])
    await expectSessionAlive(w, busy.sessionId)

    // Once nothing is in flight the session is an ordinary idle one.
    w.advance(IDLE + 1)
    expect(w.mgr.sweepIdle()).toEqual([busy.sessionId])
  })

  test('a session with an open SSE stream is not swept; once the client drops it, the session becomes sweepable', async () => {
    const w = await startWorld()
    const streaming = await mcpSession(w.port)
    const idle = await mcpSession(w.port)

    const ac = openSseStream(w, streaming.sessionId)
    await streamIsOpen(w, streaming.sessionId)

    w.advance(IDLE + 1)
    expect(w.mgr.sweepIdle()).toEqual([idle.sessionId])
    w.advance(10 * IDLE)
    expect(w.mgr.sweepIdle()).toEqual([])
    expect(w.mgr.getSessionIds()).toEqual([streaming.sessionId])

    // The client drops the stream without a DELETE.
    ac.abort()
    await eventually(() => {
      w.advance(IDLE + 1)
      return w.mgr.sweepIdle().includes(streaming.sessionId)
    }, { what: 'dropped-stream session to become sweepable' })
    expect(w.mgr.sessionCount).toBe(0)
    await expectSessionGone(w, streaming.sessionId)
  })
})

describe('sweeping other sessions leaves a live session alone', () => {
  test('a live owner session keeps its owner, its explicit selection and its view of the owner peer', async () => {
    const w = await startWorld()
    const chrome = await connectFakeExtension(w.port, 'chrome')
    const edge = await connectFakeExtension(w.port, 'edge')
    const peer = await connectFakePeer(w.port, { owner: T })

    const live = await mcpSession(w.port, T)
    expect((await live.callTool('set_browser', { browser: 'edge' })).isError).toBe(false)
    const abandoned = [await mcpSession(w.port), await mcpSession(w.port, T), await mcpSession(w.port)]

    w.advance(IDLE - 10)
    expect((await live.callTool('get_browsers')).isError).toBe(false)
    w.advance(20)

    const swept = w.mgr.sweepIdle()
    expect([...swept].sort()).toEqual(abandoned.map((a) => a.sessionId).sort())
    expect(w.mgr.getSessionIds()).toEqual([live.sessionId])

    const list = await live.browsers()
    expect(list.map((b) => b.browser).sort()).toEqual(['chrome', 'edge', 'nostromo'])
    expect(list.find((b) => b.active === true).browser).toBe('edge')
    expect((await live.callTool('get_tabs')).json).toEqual({ echo: 'getTabs', by: 'edge' })
    expect(edge.actions()).toEqual(['getTabs'])
    expect(chrome.actions()).toEqual([])
    expect(peer.actions()).toEqual([])

    // The owner can still pick its own peer: ownership was not disturbed.
    expect((await live.callTool('set_browser', { browser: 'nostromo' })).isError).toBe(false)
    await live.callTool('get_tabs')
    expect(peer.actions()).toEqual(['getTabs'])
  })

  test('an expired owner session can be replaced by a fresh one that sees the same peer', async () => {
    const w = await startWorld()
    const peer = await connectFakePeer(w.port, { owner: T })
    const old = await mcpSession(w.port, T)
    w.advance(IDLE + 1)
    expect(w.mgr.sweepIdle()).toEqual([old.sessionId])

    const fresh = await mcpSession(w.port, T)
    expect((await fresh.browsers()).map((b) => b.browser)).toEqual(['nostromo'])
    expect((await fresh.callTool('set_browser', { browser: 'nostromo' })).isError).toBe(false)
    await fresh.callTool('get_tabs')
    expect(peer.actions()).toEqual(['getTabs'])
  })
})

describe('the idle bound', () => {
  test('0 disables expiry entirely', async () => {
    const w = await startWorld({ idleTimeoutMs: 0 })
    const a = await mcpSession(w.port)
    w.advance(1000 * HOUR)
    expect(w.mgr.sweepIdle()).toEqual([])
    expect(w.mgr.getSessionIds()).toEqual([a.sessionId])
    await expectSessionAlive(w, a.sessionId)
  })

  test('defaults to 6 hours', async () => {
    const saved = process.env.WEBSTER_SESSION_IDLE_HOURS
    delete process.env.WEBSTER_SESSION_IDLE_HOURS
    try {
      const w = await startWorld({ idleTimeoutMs: 'default' })
      const a = await mcpSession(w.port)
      w.advance(6 * HOUR - 1000)
      expect(w.mgr.sweepIdle()).toEqual([])
      w.advance(2000)
      expect(w.mgr.sweepIdle()).toEqual([a.sessionId])
    } finally {
      if (saved !== undefined) process.env.WEBSTER_SESSION_IDLE_HOURS = saved
    }
  })

  test('WEBSTER_SESSION_IDLE_HOURS sets the default bound', async () => {
    const saved = process.env.WEBSTER_SESSION_IDLE_HOURS
    process.env.WEBSTER_SESSION_IDLE_HOURS = '1'
    try {
      const w = await startWorld({ idleTimeoutMs: 'default' })
      const a = await mcpSession(w.port)
      w.advance(HOUR - 1000)
      expect(w.mgr.sweepIdle()).toEqual([])
      w.advance(2000)
      expect(w.mgr.sweepIdle()).toEqual([a.sessionId])
    } finally {
      if (saved === undefined) delete process.env.WEBSTER_SESSION_IDLE_HOURS
      else process.env.WEBSTER_SESSION_IDLE_HOURS = saved
    }
  })

  test('WEBSTER_SESSION_IDLE_HOURS=0 disables expiry', async () => {
    const saved = process.env.WEBSTER_SESSION_IDLE_HOURS
    process.env.WEBSTER_SESSION_IDLE_HOURS = '0'
    try {
      const w = await startWorld({ idleTimeoutMs: 'default' })
      await mcpSession(w.port)
      w.advance(1000 * HOUR)
      expect(w.mgr.sweepIdle()).toEqual([])
      expect(w.mgr.sessionCount).toBe(1)
    } finally {
      if (saved === undefined) delete process.env.WEBSTER_SESSION_IDLE_HOURS
      else process.env.WEBSTER_SESSION_IDLE_HOURS = saved
    }
  })
})
