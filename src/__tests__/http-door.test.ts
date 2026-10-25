/**
 * BP0 follow-up WR-2: the HTTP door (POST /connect, GET /poll, POST /result,
 * DELETE /connect, the Safari long-poll transport) cannot be used to
 * impersonate a real browser extension, evict one, or feed a capture.
 *
 * Safari's service worker may send NO Origin header, so an HTTP registration is
 * bound to its caller by a per-registration secret instead, `X-Webster-Token`,
 * returned by `POST /connect`:
 *
 *  - Without an extension-scheme Origin a client may register over HTTP only as
 *    `safari` (anything else is 403). With one, any name but `nostromo` is allowed.
 *  - A no-Origin, no-token `/connect` for a name a live extension already holds is 409.
 *    A registration is live if it connected/polled/posted within `httpLiveMs`
 *    (default 60s) or has a command in flight.
 *  - /poll, DELETE /connect and POST /result need the registration's token. A
 *    registration made with an extension Origin and no token (an old build) is
 *    authenticated by any extension-scheme Origin instead.
 *  - A result or capture push is accepted only from an identified registration,
 *    and a command result only from the registration the command was sent to.
 *
 * Everything here goes over real HTTP/WebSocket against a real WebsterServer, with
 * the request headers a real client would send. The Safari-shaped client sends
 * nothing but Content-Type and X-Webster-Token (rawHttp adds Host/Connection).
 *
 * Not tested: that `server.close()` clears pending WebSocket handshake timers.
 * Nothing observable from outside distinguishes a cleared timer from one that
 * fires on a dead server, and asserting on private fields is off the table.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebsterServer } from '../server.js'
import { McpSessionManager } from '../mcp.js'
import {
  connectFakeExtension, connectFakePeer, mcpSession, sleep, eventually, getStatus, token as ownerToken,
  rawHttp, findFreePort,
  type Rig, type FakeBrowser, type McpClient, type RawHttpResponse,
} from './helpers/fake-browsers.js'

const T = ownerToken('T')
const SAFARI_ORIGIN = 'safari-web-extension://abc'
const CHROME_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const FIREFOX_ORIGIN = 'moz-extension://11111111-2222-3333-4444-555555555555'

// ─── Rig (the shared startRig cannot pass server options) ────────────────────

type ServerOptions = NonNullable<ConstructorParameters<typeof WebsterServer>[2]>
interface DoorOptions { httpLiveMs?: number }

async function startRigWith(commandTimeoutMs: number, options: DoorOptions = {}): Promise<Rig> {
  let port = await findFreePort()
  let server: WebsterServer | undefined
  for (let attempt = 0; !server; attempt++) {
    try {
      // `httpLiveMs` is a constructor option of the server under test; the cast keeps this file
      // compiling against the options type either way.
      server = new WebsterServer(port, commandTimeoutMs, options as unknown as ServerOptions)
    } catch (err) {
      if (attempt >= 4) throw err
      port = await findFreePort()
    }
  }
  const mgr = new McpSessionManager(server)
  server.setMcpHandler((req) => mgr.handleRequest(req))
  const srv = server
  return {
    server: srv,
    mgr,
    port,
    close() {
      try { srv.getCaptureSession()?.cleanup() } catch { /* best effort */ }
      srv.close()
    },
  }
}

let rig: Rig
beforeEach(async () => { rig = await startRigWith(3000) })
afterEach(() => rig.close())

/** Replace the default rig with one built with these options. */
async function restart(options: DoorOptions, commandTimeoutMs = 3000) {
  rig.close()
  rig = await startRigWith(commandTimeoutMs, options)
}

// ─── Raw HTTP helpers: explicit headers, nothing added behind our back ───────

interface Auth { token?: string; origin?: string }
const none: Auth = {}
interface Reg { id: string; token: string }
const by = (reg: Reg): Auth => ({ token: reg.token })
const WRONG_TOKEN = 'wrong-token-'.repeat(4)

const headersFor = (auth: Auth, json: boolean): Record<string, string> => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(auth.token !== undefined ? { 'X-Webster-Token': auth.token } : {}),
  ...(auth.origin !== undefined ? { Origin: auth.origin } : {}),
})

const parse = (s: string): any => { try { return JSON.parse(s) } catch { return undefined } }

interface Conn { status: number; json: any; raw: string }

/** POST /connect with a raw body (so malformed and missing bodies can be sent). */
async function connectRaw(rawBody: string, auth: Auth = none): Promise<Conn> {
  const res = await rawHttp(rig.port, { method: 'POST', path: '/connect', headers: headersFor(auth, true), body: rawBody })
  return { status: res.status, json: parse(res.body), raw: res.body }
}
const connect = (body: unknown, auth: Auth = none) => connectRaw(JSON.stringify(body), auth)

/** Register over HTTP and return the id and token. Fails if the server issues no token. */
async function register(browser = 'safari', auth: Auth = none, { requireToken = true, version = '17.1' } = {}): Promise<Reg> {
  const c = await connect({ browser, version }, auth)
  expect(c.status, `POST /connect as ${browser}: ${c.raw}`).toBe(200)
  expect(typeof c.json?.id, 'POST /connect must return an id').toBe('string')
  if (requireToken) expect(typeof c.json?.token, 'POST /connect must return a token').toBe('string')
  return { id: c.json.id as string, token: c.json.token as string }
}

const del = (id: string, auth: Auth = none) =>
  rawHttp(rig.port, { method: 'DELETE', path: `/connect?id=${encodeURIComponent(id)}`, headers: headersFor(auth, false) })

/** A long-poll. Resolves null (never rejects) if nothing comes back within rawHttp's timeout. */
const startPoll = (id: string, auth: Auth = none): Promise<RawHttpResponse | null> =>
  rawHttp(rig.port, { method: 'GET', path: `/poll?id=${encodeURIComponent(id)}`, headers: headersFor(auth, false) }).catch(() => null)

const postResult = (msg: unknown, auth: Auth = none) =>
  rawHttp(rig.port, { method: 'POST', path: '/result', headers: headersFor(auth, true), body: JSON.stringify(msg) })

const networkPush = (url: string) => ({
  type: 'capture_event',
  kind: 'network',
  data: { url, method: 'GET', status: 200, timestamp: Date.now() },
})
const captureDone = { type: 'capture_done' }

const urls = () => (rig.server.getCaptureSession()?.readEvents({ kind: 'network' }) ?? []).map((e) => e.url)

const entriesNamed = async (name: string) => (await getStatus(rig.port)).extensions.filter((e) => e.browser === name)
const listed = async (id: string) => (await getStatus(rig.port)).extensions.find((e) => e.id === id)

/** An MCP tool call that retries while the target HTTP browser has no poll open yet. */
async function callWhenPolling(s: McpClient, name: string, args: Record<string, unknown> = {}) {
  const deadline = Date.now() + 2500
  for (;;) {
    const r = await s.callTool(name, args)
    if (!(r.isError && /not polling/i.test(r.text)) || Date.now() > deadline) return r
    await sleep(15)
  }
}

/**
 * One full command exchange with an HTTP browser: open a poll (or use `poll`),
 * issue the tool call, read the command off the poll, post the result, and
 * return the tool result.
 */
async function roundTrip(
  s: McpClient,
  reg: Reg,
  auth: Auth,
  { tool = 'get_tabs', action = 'getTabs', data = [{ id: 7, title: 'safari tab' }] as unknown, poll, wrapsData = false }: { tool?: string; action?: string; data?: unknown; poll?: Promise<RawHttpResponse | null>; wrapsData?: boolean } = {},
) {
  const polling = poll ?? startPoll(reg.id, auth)
  const call = callWhenPolling(s, tool)
  const res = await polling
  expect(res?.status, `poll for ${reg.id} should deliver the command`).toBe(200)
  const cmd = parse(res!.body)
  expect(cmd?.action).toBe(action)
  const posted = await postResult({ id: cmd.id, success: true, data }, auth)
  expect(posted.status, 'result post').toBe(204)
  const r = await call
  expect(r.isError, r.text).toBe(false)
  if (!wrapsData) expect(r.json).toEqual(data)
  return cmd
}

type Order = 'stranger first' | 'real browser first'
const ORDERS: Order[] = ['stranger first', 'real browser first']

// ═════════════════════════════════════════════════════════════════════════════
// (a) WR2-1: a no-Origin stranger cannot register as chrome (or anything but safari)
// ═════════════════════════════════════════════════════════════════════════════

describe.each(ORDERS)('a no-Origin client registering over HTTP as chrome (%s)', (order) => {
  async function scenario() {
    let chrome!: FakeBrowser
    let attempt!: Conn
    const attack = async () => { attempt = await connect({ browser: 'chrome', version: '66.6' }) }
    if (order === 'real browser first') {
      chrome = await connectFakeExtension(rig.port, 'chrome')
      await attack()
    } else {
      await attack()
      chrome = await connectFakeExtension(rig.port, 'chrome')
    }
    return { chrome, attempt }
  }

  test('is refused with 403 and is issued neither an id nor a token', async () => {
    const { attempt } = await scenario()
    expect(attempt.status, attempt.raw).toBe(403)
    expect(attempt.json?.id).toBeUndefined()
    expect(attempt.json?.token).toBeUndefined()
  })

  test('is never listed, and the real Chrome stays the only entry, the default and active', async () => {
    const { chrome } = await scenario()
    const status = await getStatus(rig.port)
    expect(status.extensions.map((e) => [e.browser, e.transport, e.active])).toEqual([['chrome', 'ws', true]])
    expect(status.extensions.some((e) => e.version === '66.6')).toBe(false)

    const s = await mcpSession(rig.port)
    const list = await s.browsers()
    expect(list.map((b) => [b.browser, b.transport, b.active])).toEqual([['chrome', 'ws', true]])
    void chrome
  })

  test('a default MCP session reaches the real Chrome', async () => {
    const { chrome } = await scenario()
    const s = await mcpSession(rig.port)
    const r = await s.callTool('get_tabs')
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual({ echo: 'getTabs', by: 'chrome' })
    expect(chrome.actions()).toEqual(['getTabs'])
  })

  test('an owner session that selects "chrome" by name reaches the real Chrome', async () => {
    const own = await connectFakePeer(rig.port, { owner: T })
    let chrome!: FakeBrowser
    if (order === 'real browser first') {
      chrome = await connectFakeExtension(rig.port, 'chrome')
      expect((await connect({ browser: 'chrome' })).status).toBe(403)
    } else {
      expect((await connect({ browser: 'chrome' })).status).toBe(403)
      chrome = await connectFakeExtension(rig.port, 'chrome')
    }

    const owner = await mcpSession(rig.port, T)
    const sel = await owner.callTool('set_browser', { browser: 'chrome' })
    expect(sel.isError, sel.text).toBe(false)
    const r = await owner.callTool('get_tabs')
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual({ echo: 'getTabs', by: 'chrome' })
    expect(chrome.actions()).toEqual(['getTabs'])
    expect(own.actions()).toEqual([])
    // Nothing but the real Chrome (and the owned pane, which /api/status hides) exists to receive commands.
    expect((await getStatus(rig.port)).extensions.map((e) => e.browser)).toEqual(['chrome'])
  })

  test('any name other than safari is refused 403, however the body is shaped', async () => {
    const { chrome } = await scenario()
    for (const body of [
      JSON.stringify({ browser: 'edge', version: '1' }),
      JSON.stringify({ browser: 'firefox', version: '1' }),
      JSON.stringify({ browser: 'unknown' }),
      JSON.stringify({ browser: 'chrome', kind: 'extension' }),
      JSON.stringify({ browser: 42 }),
      JSON.stringify({}),
      'not json at all',
      '', // no body: the server's own default name is "unknown"
    ]) {
      const c = await connectRaw(body)
      expect(c.status, `body ${JSON.stringify(body)}: ${c.raw}`).toBe(403)
      expect(c.json?.token).toBeUndefined()
    }
    // A token that matches nothing is no token: the name rule still applies.
    expect((await connect({ browser: 'chrome' }, { token: WRONG_TOKEN })).status).toBe(403)

    expect((await getStatus(rig.port)).extensions.map((e) => e.browser)).toEqual(['chrome'])
    const s = await mcpSession(rig.port)
    expect((await s.callTool('get_tabs')).isError).toBe(false)
    expect(chrome.actions()).toEqual(['getTabs'])
  })
})

describe('registering over HTTP with an extension-scheme Origin (legacy behaviour)', () => {
  test.each([
    ['chrome', CHROME_ORIGIN],
    ['edge', CHROME_ORIGIN],
    ['firefox', FIREFOX_ORIGIN],
    ['safari', SAFARI_ORIGIN],
    ['unknown', SAFARI_ORIGIN],
  ])('%s is allowed from %s', async (name, origin) => {
    const c = await connect({ browser: name, version: '3.0' }, { origin })
    expect(c.status, c.raw).toBe(200)
    expect(await listed(c.json.id)).toMatchObject({ browser: name, version: '3.0', transport: 'http' })
  })

  test('the name nostromo stays reserved: 400, nothing registered', async () => {
    const c = await connect({ browser: 'nostromo' }, { origin: SAFARI_ORIGIN })
    expect(c.status).toBe(400)
    expect((await getStatus(rig.port)).extensions).toEqual([])
  })

  test('is never turned away with 409, even when a live Chrome holds the name, and the live Chrome stays the default', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const c = await connect({ browser: 'chrome', version: '2.0' }, { origin: CHROME_ORIGIN })
    expect(c.status, c.raw).toBe(200)

    const status = await getStatus(rig.port)
    expect(status.extensions.filter((e) => e.browser === 'chrome')).toHaveLength(2)
    const s = await mcpSession(rig.port)
    expect((await s.callTool('get_tabs')).isError).toBe(false)
    expect(chrome.actions()).toEqual(['getTabs'])
  })

  test('an Origin header alone does not displace a live registration held by a token (409, holder untouched)', async () => {
    const real = await register('safari') // no Origin: credentialed by its token only
    const c = await connect({ browser: 'safari' }, { origin: SAFARI_ORIGIN })
    expect(c.status, c.raw).toBe(409)
    expect(await listed(real.id)).toBeDefined()
    expect((await del(real.id, { origin: SAFARI_ORIGIN })).status).toBe(403)
    expect(await listed(real.id)).toBeDefined()
    expect((await entriesNamed('safari')).map((e) => e.id)).toEqual([real.id])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (b) WR2-1: a stranger cannot squat or displace safari
// ═════════════════════════════════════════════════════════════════════════════

describe('a no-Origin stranger registering as safari', () => {
  test('(real browser first) gets 409 while the real Safari is live; the real one keeps its id, token and commands', async () => {
    const real = await register('safari')
    const poll = startPoll(real.id, by(real))

    const stranger = await connect({ browser: 'safari', version: '6.6' })
    expect(stranger.status, stranger.raw).toBe(409)
    expect(stranger.json?.id).toBeUndefined()
    expect(stranger.json?.token).toBeUndefined()
    // A token that matches nothing is no token.
    expect((await connect({ browser: 'safari' }, { token: WRONG_TOKEN })).status).toBe(409)

    const safaris = await entriesNamed('safari')
    expect(safaris.map((e) => [e.id, e.version, e.active])).toEqual([[real.id, '17.1', true]])

    // The poll opened before the attack is still the one the command arrives on.
    await roundTrip(await mcpSession(rig.port), real, by(real), { poll })
  })

  test('(stranger first) a no-Origin first arrival cannot be told apart from Safari, but the real Safari is then told 409 while it is live, and may register once it is stale', async () => {
    // Without an Origin there is nothing to tell a squatter from the real Safari at the
    // moment of the first /connect: that case cannot be prevented, only bounded. What must
    // hold is that the squatter's registration cannot be taken over while live, and does
    // not hold the name forever once it stops being used.
    await restart({ httpLiveMs: 500 })
    const stranger = await register('safari', none, { version: '6.6' })

    const real = await connect({ browser: 'safari', version: '17.1' })
    expect(real.status, real.raw).toBe(409)
    expect((await entriesNamed('safari')).map((e) => e.id)).toEqual([stranger.id])

    // The rejected attempts are not activity of the stranger's: staleness is measured from its own use.
    const registered = await eventually(async () => {
      const c = await connect({ browser: 'safari', version: '17.1' })
      if (c.status === 200) return c
      expect(c.status).toBe(409)
      return null
    }, { timeout: 3000, interval: 40, what: 'the stale registration to be replaceable' })

    expect(registered.json.id).not.toBe(stranger.id)
    expect((await entriesNamed('safari')).map((e) => [e.id, e.version])).toEqual([[registered.json.id, '17.1']])
    // The squatter's old id is gone and its token buys nothing.
    expect((await startPoll(stranger.id, by(stranger)))?.status).toBe(404)
    // The real Safari works end to end.
    await roundTrip(await mcpSession(rig.port), { id: registered.json.id, token: registered.json.token }, { token: registered.json.token })
  })

  test('a registration with a command in flight is live however long ago it connected', async () => {
    await restart({ httpLiveMs: 300 })
    const real = await register('safari')
    const poll = startPoll(real.id, by(real))
    const s = await mcpSession(rig.port)
    const call = callWhenPolling(s, 'get_tabs')
    const res = await poll
    const cmd = parse(res!.body)
    expect(cmd.action).toBe('getTabs')

    await sleep(450) // well past the liveness window, command still unanswered
    const stranger = await connect({ browser: 'safari', version: '6.6' })
    expect(stranger.status, stranger.raw).toBe(409)
    expect((await entriesNamed('safari')).map((e) => e.id)).toEqual([real.id])

    expect((await postResult({ id: cmd.id, success: true, data: ['late'] }, by(real))).status).toBe(204)
    const r = await call
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual(['late'])
  })

  test('also gets 409 when a live WebSocket extension already holds the name safari', async () => {
    const ws = await connectFakeExtension(rig.port, 'safari', { headers: { Origin: SAFARI_ORIGIN } })
    const stranger = await connect({ browser: 'safari', version: '6.6' })
    expect(stranger.status, stranger.raw).toBe(409)

    const safaris = await entriesNamed('safari')
    expect(safaris.map((e) => [e.transport, e.active])).toEqual([['ws', true]])
    const s = await mcpSession(rig.port)
    expect((await s.callTool('get_tabs')).isError).toBe(false)
    expect(ws.actions()).toEqual(['getTabs'])
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (c) S2: a stranger cannot evict, steal polls from, or delete the real Safari
// ═════════════════════════════════════════════════════════════════════════════

describe('a stranger against a live, polling Safari', () => {
  test('cannot evict it with /connect, delete it, or take over its poll; its command still arrives', async () => {
    const real = await register('safari')
    const poll = startPoll(real.id, by(real))

    // Eviction by re-registering.
    expect((await connect({ browser: 'safari' })).status).toBe(409)
    // Deletion without or with the wrong token.
    expect((await del(real.id)).status).toBe(403)
    expect((await del(real.id, { token: WRONG_TOKEN })).status).toBe(403)
    expect((await listed(real.id))?.browser).toBe('safari')
    // Poll theft without or with the wrong token.
    expect((await startPoll(real.id))?.status).toBe(403)
    expect((await startPoll(real.id, { token: WRONG_TOKEN }))?.status).toBe(403)

    expect((await entriesNamed('safari')).map((e) => [e.id, e.active])).toEqual([[real.id, true]])
    // The command, issued after all of that, is delivered on the real Safari's own poll.
    await roundTrip(await mcpSession(rig.port), real, by(real), { poll })
  })

  test('an extension-scheme Origin alone does not open a token-registered Safari (poll, delete, result)', async () => {
    const real = await register('safari')
    const poll = startPoll(real.id, by(real))
    const forged: Auth = { origin: SAFARI_ORIGIN }

    expect((await startPoll(real.id, forged))?.status).toBe(403)
    expect((await del(real.id, forged)).status).toBe(403)
    expect((await postResult({ id: 'whatever', success: true }, forged)).status).toBe(403)
    expect((await listed(real.id))?.browser).toBe('safari')

    await roundTrip(await mcpSession(rig.port), real, by(real), { poll })
  })

  test('an unknown id is still 404 on poll and 204 on delete, with or without a token', async () => {
    expect((await startPoll('no-such-id'))?.status).toBe(404)
    expect((await startPoll('no-such-id', { token: WRONG_TOKEN }))?.status).toBe(404)
    expect((await del('no-such-id')).status).toBe(204)
    expect((await del('no-such-id', { token: WRONG_TOKEN })).status).toBe(204)
  })

  test('a token belongs to its registration: another registration\'s token cannot poll or delete it', async () => {
    const safari = await register('safari')
    const other = await register('firefox', { origin: FIREFOX_ORIGIN })
    expect((await startPoll(safari.id, by(other)))?.status).toBe(403)
    expect((await del(safari.id, by(other))).status).toBe(403)
    expect((await listed(safari.id))?.browser).toBe('safari')
    expect((await listed(other.id))?.browser).toBe('firefox')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (d) WR2-1: nobody unidentified can feed or finalize a capture over POST /result
// ═════════════════════════════════════════════════════════════════════════════

describe('POST /result from an unidentified sender', () => {
  test('with no browser connected at all is 403, never 204, for pushes and for results alike', async () => {
    expect((await postResult(networkPush('https://forged.example/none'))).status).toBe(403)
    expect((await postResult(captureDone)).status).toBe(403)
    expect((await postResult({ id: 'a-command-id', success: true, data: 1 })).status).toBe(403)
    expect((await postResult(networkPush('https://forged.example/none'), { token: WRONG_TOKEN })).status).toBe(403)
  })
})

const CAPTURE_ORDERS = ['Safari registered before the capture starts', 'Safari registered after the capture starts'] as const
type CaptureOrder = (typeof CAPTURE_ORDERS)[number]

/** A real WS Chrome starts an unowned capture; an HTTP browser registers before or after it. */
async function captureWithHttpBrowser(order: CaptureOrder, mk: () => Promise<Reg>) {
  const chrome = await connectFakeExtension(rig.port, 'chrome') // earliest, so the default target
  chrome.setReply('startCapture', { tabsAttached: 1 })
  let reg: Reg | undefined
  if (order === CAPTURE_ORDERS[0]) reg = await mk()
  const s = await mcpSession(rig.port)
  const started = await s.callTool('start_capture', {})
  expect(started.isError, started.text).toBe(false)
  expect(chrome.actions()).toEqual(['startCapture'])
  expect(rig.server.getCaptureSession()?.active).toBe(true)
  if (order === CAPTURE_ORDERS[1]) reg = await mk()
  return { chrome, reg: reg! }
}

/** Every one of these must be refused 403 and leave the capture untouched. */
async function expectForgeriesRefused(cases: Array<[string, Auth]>) {
  for (const [label, auth] of cases) {
    const push = await postResult(networkPush(`https://forged.example/${encodeURIComponent(label)}`), auth)
    expect(push.status, `${label}: capture_event`).toBe(403)
    const done = await postResult(captureDone, auth)
    expect(done.status, `${label}: capture_done`).toBe(403)
  }
  expect(urls(), 'nothing forged may be recorded').toEqual([])
  expect(rig.server.getCaptureSession()?.active, 'a forged capture_done must not finalize').toBe(true)
}

describe.each([...CAPTURE_ORDERS])('capture pushes over HTTP (%s)', (order) => {
  test('forgeries without a registration, with a wrong token, or with no token are refused; the registered Safari\'s token feeds the capture', async () => {
    const { reg } = await captureWithHttpBrowser(order, () => register('safari'))

    await expectForgeriesRefused([
      ['no token', none],
      ['wrong token', { token: WRONG_TOKEN }],
      ['empty token', { token: '' }],
      ['extension origin without token', { origin: SAFARI_ORIGIN }],
    ])

    const ok = await postResult(networkPush('https://safari.example/real'), by(reg))
    expect(ok.status).toBe(204)
    await eventually(() => urls().includes('https://safari.example/real'), { what: 'safari event to be recorded' })
    expect(urls()).toEqual(['https://safari.example/real'])
  })

  test('the token of a deleted registration no longer feeds or finalizes the capture', async () => {
    const { reg } = await captureWithHttpBrowser(order, () => register('safari'))
    expect((await postResult(networkPush('https://safari.example/before-delete'), by(reg))).status).toBe(204)
    await eventually(() => urls().length === 1, { what: 'event before delete' })

    expect((await del(reg.id, by(reg))).status).toBe(204)
    expect(await listed(reg.id)).toBeUndefined()

    expect((await postResult(networkPush('https://safari.example/after-delete'), by(reg))).status).toBe(403)
    expect((await postResult(captureDone, by(reg))).status).toBe(403)
    expect(urls()).toEqual(['https://safari.example/before-delete'])
    expect(rig.server.getCaptureSession()?.active).toBe(true)
  })

  test('the token of a replaced registration no longer feeds the capture; the new one does', async () => {
    const { reg } = await captureWithHttpBrowser(order, () => register('safari'))
    const again = await connect({ browser: 'safari', version: '17.2' }, by(reg))
    expect(again.status, again.raw).toBe(200)
    const fresh: Reg = { id: again.json.id, token: again.json.token }
    expect(fresh.token).not.toBe(reg.token)

    expect((await postResult(networkPush('https://safari.example/stale-token'), by(reg))).status).toBe(403)
    expect((await postResult(captureDone, by(reg))).status).toBe(403)
    expect(urls()).toEqual([])
    expect(rig.server.getCaptureSession()?.active).toBe(true)

    expect((await postResult(networkPush('https://safari.example/fresh-token'), by(fresh))).status).toBe(204)
    await eventually(() => urls().includes('https://safari.example/fresh-token'), { what: 'fresh-token event' })
    expect(urls()).toEqual(['https://safari.example/fresh-token'])
  })

  test('a legacy (extension-Origin, never sends a token) registration feeds the capture; a no-Origin stranger cannot ride on it', async () => {
    const { reg } = await captureWithHttpBrowser(order, () => register('safari', { origin: SAFARI_ORIGIN }, { requireToken: false }))

    await expectForgeriesRefused([
      ['no origin no token', none],
      ['no origin wrong token', { token: WRONG_TOKEN }],
    ])

    expect(reg.id).toBeTruthy()
    const ok = await postResult(networkPush('https://legacy.example/real'), { origin: SAFARI_ORIGIN })
    expect(ok.status).toBe(204)
    await eventually(() => urls().includes('https://legacy.example/real'), { what: 'legacy event to be recorded' })
    expect(urls()).toEqual(['https://legacy.example/real'])
  })
})

describe('capture_done over HTTP', () => {
  test('finalizes the capture when sent with a registered Safari\'s token', async () => {
    const { reg } = await captureWithHttpBrowser(CAPTURE_ORDERS[0], () => register('safari'))
    expect((await postResult(captureDone, by(reg))).status).toBe(204)
    await eventually(() => rig.server.getCaptureSession()?.active === false, { what: 'capture to be finalized' })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (e) WR2-2: the real clients keep working end to end
// ═════════════════════════════════════════════════════════════════════════════

describe('a Safari-shaped client (no Origin; only Content-Type and X-Webster-Token)', () => {
  test('registers, polls, answers a command and is listed as an http safari', async () => {
    const real = await register('safari')
    expect(await listed(real.id)).toMatchObject({ browser: 'safari', version: '17.1', transport: 'http', active: true })
    await roundTrip(await mcpSession(rig.port), real, by(real))
  })

  test('reconnecting with its token replaces its own registration: new id and token, the old ones are dead', async () => {
    const first = await register('safari')
    const again = await connect({ browser: 'safari', version: '17.2' }, by(first))
    expect(again.status, again.raw).toBe(200)
    const second: Reg = { id: again.json.id, token: again.json.token }
    expect(second.id).not.toBe(first.id)
    expect(second.token).not.toBe(first.token)

    expect((await entriesNamed('safari')).map((e) => [e.id, e.version])).toEqual([[second.id, '17.2']])
    expect((await startPoll(first.id, by(first)))?.status).toBe(404)
    expect((await startPoll(second.id, by(first)))?.status).toBe(403)
    expect((await postResult({ id: 'x', success: true }, by(first))).status).toBe(403)

    await roundTrip(await mcpSession(rig.port), second, by(second))
  })

  test('reconnecting with its token works even after the old registration went stale, and replaces it', async () => {
    await restart({ httpLiveMs: 150 })
    const first = await register('safari')
    await sleep(250)
    const again = await connect({ browser: 'safari' }, by(first))
    expect(again.status, again.raw).toBe(200)
    expect((await entriesNamed('safari')).map((e) => e.id)).toEqual([again.json.id])
  })

  test('deleting its registration with its token removes it; the token is then dead', async () => {
    const real = await register('safari')
    expect((await del(real.id, by(real))).status).toBe(204)
    expect(await listed(real.id)).toBeUndefined()
    expect((await startPoll(real.id, by(real)))?.status).toBe(404)
    // The name is free again for the next Safari.
    expect((await connect({ browser: 'safari' })).status).toBe(200)
  })

  test('starts a capture on itself and feeds it: the start result, pushes and capture_done all go through its token', async () => {
    const real = await register('safari')
    const s = await mcpSession(rig.port)
    // start_capture wraps the browser's reply, so only the exchange itself is checked, not the tool's JSON.
    await roundTrip(s, real, by(real), { tool: 'start_capture', action: 'startCapture', data: { tabsAttached: 1 }, wrapsData: true })
    expect(rig.server.getCaptureSession()?.active).toBe(true)

    expect((await postResult(networkPush('https://safari.example/own-capture'), by(real))).status).toBe(204)
    await eventually(() => urls().includes('https://safari.example/own-capture'), { what: 'own capture event' })
    expect((await postResult(captureDone, by(real))).status).toBe(204)
    await eventually(() => rig.server.getCaptureSession()?.active === false, { what: 'capture to finalize' })
  })
})

describe('a legacy old-build client (extension-scheme Origin, never sends a token)', () => {
  const origin: Auth = { origin: SAFARI_ORIGIN }

  test('registers, polls, answers a command and deletes itself by Origin alone', async () => {
    const reg = await register('safari', origin, { requireToken: false })
    expect(await listed(reg.id)).toMatchObject({ browser: 'safari', transport: 'http', active: true })

    await roundTrip(await mcpSession(rig.port), reg, origin)

    expect((await del(reg.id, origin)).status).toBe(204)
    expect(await listed(reg.id)).toBeUndefined()
  })

  test('re-registering replaces its previous registration instead of being refused', async () => {
    const first = await register('safari', origin, { requireToken: false })
    const second = await register('safari', origin, { requireToken: false })
    expect(second.id).not.toBe(first.id)
    expect((await entriesNamed('safari')).map((e) => e.id)).toEqual([second.id])
    expect((await startPoll(first.id, origin))?.status).toBe(404)
    await roundTrip(await mcpSession(rig.port), second, origin)
  })

  test('is not usable by a no-Origin client without its token', async () => {
    const reg = await register('safari', origin, { requireToken: false })
    expect((await startPoll(reg.id))?.status).toBe(403)
    expect((await del(reg.id)).status).toBe(403)
    expect((await postResult({ id: 'x', success: true })).status).toBe(403)
    expect((await listed(reg.id))?.browser).toBe('safari')
  })
})

describe('command results are bound to the registration the command was sent to', () => {
  test('an HTTP Safari with a valid token cannot answer a command sent to a different browser', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome', { hang: true }) // earliest: the default target
    const safari = await register('safari')
    const poll = startPoll(safari.id, by(safari))
    const s = await mcpSession(rig.port)

    const call = s.callTool('get_tabs')
    const cmd = await chrome.waitForCommand('getTabs')
    let settled = false
    void call.then(() => { settled = true })

    await postResult({ id: cmd.id, success: true, data: { spoofed: true } }, by(safari))
    await sleep(120)
    expect(settled, 'the spoofed result must not resolve the command').toBe(false)

    chrome.reply(cmd, { data: { genuine: true } })
    const r = await call
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual({ genuine: true })
    void poll
  })

  test('an unidentified HTTP client cannot answer Safari\'s command; Safari\'s own token still can', async () => {
    const safari = await register('safari')
    const poll = startPoll(safari.id, by(safari))
    const s = await mcpSession(rig.port)
    const call = callWhenPolling(s, 'get_tabs')
    const cmd = parse((await poll)!.body)
    expect(cmd.action).toBe('getTabs')
    let settled = false
    void call.then(() => { settled = true })

    for (const auth of [none, { token: WRONG_TOKEN }]) {
      const spoof = await postResult({ id: cmd.id, success: true, data: { spoofed: true } }, auth)
      expect(spoof.status).toBe(403)
    }
    await sleep(100)
    expect(settled).toBe(false)

    expect((await postResult({ id: cmd.id, success: true, data: { genuine: true } }, by(safari))).status).toBe(204)
    const r = await call
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual({ genuine: true })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// (f) token hygiene
// ═════════════════════════════════════════════════════════════════════════════

describe('registration tokens', () => {
  test('are unguessable header-safe strings, different from the id and from every other registration\'s', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const reg = await register('safari')
      expect(reg.token.length).toBeGreaterThanOrEqual(16)
      expect(reg.token).toMatch(/^[\x21-\x7e]+$/)
      expect(reg.token).not.toBe(reg.id)
      seen.add(reg.token)
      expect((await del(reg.id, by(reg))).status).toBe(204)
    }
    const a = await register('safari')
    const b = await connect({ browser: 'safari' }, by(a)) // reconnect issues a fresh token too
    seen.add(a.token)
    seen.add(b.json.token)
    expect(seen.size).toBe(5)
  })

  test('never appear in /api/status or in get_browsers output', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const safari = await register('safari')
    const legacy = await register('firefox', { origin: FIREFOX_ORIGIN })

    const statusText = await (await fetch(`http://localhost:${rig.port}/api/status`)).text()
    const s = await mcpSession(rig.port)
    const browsersText = (await s.callTool('get_browsers')).text
    const ownerSession = await mcpSession(rig.port, T)
    const ownerBrowsersText = (await ownerSession.callTool('get_browsers')).text

    for (const secret of [safari.token, legacy.token]) {
      expect(secret).toBeTruthy()
      expect(statusText).not.toContain(secret)
      expect(browsersText).not.toContain(secret)
      expect(ownerBrowsersText).not.toContain(secret)
    }
    expect(statusText).not.toMatch(/token/i)
    expect(browsersText).not.toMatch(/token/i)
    // The browsers are still listed; only the secret is hidden.
    expect((await getStatus(rig.port)).extensions.map((e) => e.browser).sort()).toEqual(['chrome', 'firefox', 'safari'])
    void chrome
  })
})
