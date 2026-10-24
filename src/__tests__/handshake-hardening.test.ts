/**
 * BP0 follow-ups WR-1 / WR-2: the WebSocket handshake cannot be used to
 * impersonate a real browser extension.
 *
 *  - One handshake per socket: once a socket has registered (extension or
 *    webkit peer) or unregistered, any further `connected` is refused (1008).
 *  - A WS handshake as an extension must carry an extension-scheme Origin.
 *    No-Origin sockets may still be webkit peers; Safari's HTTP `POST /connect`
 *    is unchanged.
 *  - A name shared by two visible extensions is never silently routed.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  startRig, connectFakeExtension, connectFakePeer, mcpSession, sleep, eventually, getStatus, token,
  rawSocket, rawHttp, upgradeHeaders, closedWithin,
  CHROME_EXTENSION_ORIGIN, FIREFOX_EXTENSION_ORIGIN,
  type Rig, type CloseInfo, type FakeBrowser,
} from './helpers/fake-browsers.js'

const T = token('T')
const SAFARI_EXTENSION_ORIGIN = 'safari-web-extension://AAAA-BBBB-CCCC'

let rig: Rig
beforeEach(async () => { rig = await startRig(3000) })
afterEach(() => rig.close())

/** The handshake an extension (or an impostor) sends: default kind is extension. */
const asChrome = (extra: Record<string, unknown> = {}) => ({ type: 'connected', version: '1.0', browser: 'chrome', ...extra })

const networkPush = (url: string) => ({
  type: 'capture_event',
  kind: 'network',
  data: { url, method: 'GET', status: 200, timestamp: Date.now() },
})

const urls = () => (rig.server.getCaptureSession()?.readEvents({ kind: 'network' }) ?? []).map((e) => e.url)

/** Anything with a close promise and a record of commands received (or none for raw sockets). */
interface Squatter {
  closed: Promise<CloseInfo>
  actions(): string[]
}

const expectRefused = async (s: { closed: Promise<CloseInfo> }, what = 'socket') => {
  const info = await closedWithin(s, 1500)
  expect(info, `${what} should have been closed by the server`).not.toBeNull()
  expect(info!.code, `${what} close code`).toBe(1008)
}

const extensionsNamed = async (name: string) =>
  (await getStatus(rig.port)).extensions.filter((e) => e.browser === name)

/** Run `attack` before or after the real Chrome connects. */
type Order = 'attacker first' | 'real chrome first'
const ORDERS: Order[] = ['attacker first', 'real chrome first']

async function inOrder(order: Order, attack: () => Promise<Squatter>) {
  let chrome: FakeBrowser
  let squatter: Squatter
  if (order === 'real chrome first') {
    chrome = await connectFakeExtension(rig.port, 'chrome')
    squatter = await attack()
  } else {
    squatter = await attack()
    chrome = await connectFakeExtension(rig.port, 'chrome')
  }
  return { chrome, squatter }
}

/** A peer socket that registered, then immediately re-handshakes as an extension named chrome. */
const peerRehandshakesAsChrome = async (): Promise<Squatter> => {
  const peer = await connectFakePeer(rig.port, { owner: T })
  peer.send(asChrome())
  return peer
}

/** A peer socket that unregistered (so it is no longer tracked), then handshakes as chrome. */
const peerUnregistersThenHandshakesAsChrome = async (): Promise<Squatter> => {
  const peer = await connectFakePeer(rig.port, { owner: T })
  peer.unregister()
  peer.send(asChrome())
  return peer
}

/** An extension socket that renames itself to chrome with a second handshake. */
const extensionRenamesItselfToChrome = async (): Promise<Squatter> => {
  const ext = await connectFakeExtension(rig.port, 'edge')
  ext.send(asChrome({ version: '9.9' }))
  return ext
}

/** A fresh WebSocket with no Origin handshaking as extension chrome. */
const noOriginExtensionAsChrome = async (): Promise<Squatter> =>
  connectFakeExtension(rig.port, 'chrome', { headers: {}, skipRegistrationWait: true })

const noOriginExtensionAsChromeExplicitKind = async (): Promise<Squatter> =>
  connectFakeExtension(rig.port, 'chrome', { headers: {}, skipRegistrationWait: true, handshake: { kind: 'extension' } })

/** After an attack, exactly the real Chrome is listed and it alone receives commands. */
async function expectOnlyRealChromeReachable(chrome: FakeBrowser, squatter: Squatter) {
  await eventually(async () => (await extensionsNamed('chrome')).length === 1, { what: 'exactly one chrome listed' })
  const status = await getStatus(rig.port)
  expect(status.extensions.map((e) => e.browser)).toEqual(['chrome'])

  const s = await mcpSession(rig.port)
  const r = await s.callTool('get_tabs')
  expect(r.isError, r.text).toBe(false)
  expect(chrome.actions()).toEqual(['getTabs'])
  expect(squatter.actions()).toEqual([])
}

// ─── (a)-(d): attacks, in both connect orders ────────────────────────────────

describe.each(ORDERS)('handshake attacks (%s)', (order) => {
  test('a registered peer socket re-handshaking as chrome is closed 1008 and no extension chrome appears for it', async () => {
    const { chrome, squatter } = await inOrder(order, peerRehandshakesAsChrome)
    await expectRefused(squatter, 'peer socket')
    await expectOnlyRealChromeReachable(chrome, squatter)
  })

  test('a peer socket handshaking as chrome right after unregister is closed 1008 and never becomes an extension', async () => {
    const { chrome, squatter } = await inOrder(order, peerUnregistersThenHandshakesAsChrome)
    await expectRefused(squatter, 'unregistered peer socket')
    await expectOnlyRealChromeReachable(chrome, squatter)
  })

  test('a registered extension socket sending a second handshake (renaming itself to chrome) is closed 1008', async () => {
    const { chrome, squatter } = await inOrder(order, extensionRenamesItselfToChrome)
    await expectRefused(squatter, 'renaming extension socket')
    await expectOnlyRealChromeReachable(chrome, squatter)
  })

  test('a fresh no-Origin WebSocket handshaking as extension chrome is refused 1008', async () => {
    const { chrome, squatter } = await inOrder(order, noOriginExtensionAsChrome)
    await expectRefused(squatter, 'no-Origin extension')
    await expectOnlyRealChromeReachable(chrome, squatter)
  })

  test('a fresh no-Origin WebSocket handshaking with explicit kind "extension" is refused 1008', async () => {
    const { chrome, squatter } = await inOrder(order, noOriginExtensionAsChromeExplicitKind)
    await expectRefused(squatter, 'no-Origin explicit extension')
    await expectOnlyRealChromeReachable(chrome, squatter)
  })
})

describe('one handshake per socket', () => {
  test('a registered extension re-sending an identical handshake is closed 1008', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.send(asChrome())
    await expectRefused(chrome, 'extension socket')
  })

  test('a registered webkit peer sending a second webkit handshake is closed 1008', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.send({ ...peer.handshake })
    await expectRefused(peer, 'peer socket')
  })

  test('a peer that unregistered cannot register again on the same socket', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.unregister()
    await eventually(async () => ((await getStatus(rig.port)).ownedBrowserCount ?? 0) === 0, { what: 'peer to be unregistered' })
    peer.send({ ...peer.handshake })
    await expectRefused(peer, 'unregistered peer socket')
    expect((await getStatus(rig.port)).ownedBrowserCount ?? 0).toBe(0)
  })
})

describe('extension handshakes need an extension-scheme Origin', () => {
  test('a no-Origin extension handshake is never listed, not even transiently', async () => {
    const stranger = await connectFakeExtension(rig.port, 'chrome', { headers: {}, skipRegistrationWait: true })
    let settled = false
    void stranger.closed.then(() => { settled = true })
    const seen: string[] = []
    const deadline = Date.now() + 1500
    while (!settled && Date.now() < deadline) {
      for (const e of (await getStatus(rig.port)).extensions) seen.push(e.browser)
      await sleep(5)
    }
    await expectRefused(stranger)
    expect(seen).toEqual([])
    expect((await getStatus(rig.port)).extensions).toEqual([])
  })

  test('a no-Origin raw socket handshaking as an extension is refused', async () => {
    const raw = await rawSocket(rig.port)
    raw.send(asChrome())
    await expectRefused(raw, 'raw no-Origin socket')
    expect((await getStatus(rig.port)).extensions).toEqual([])
  })

  test.each(['http://evil.example', 'https://evil.example'])('a web-page Origin (%s) is still refused at upgrade', async (origin) => {
    await expect(
      connectFakeExtension(rig.port, 'chrome', { headers: { Origin: origin }, skipRegistrationWait: true }),
    ).rejects.toThrow()
    const res = await rawHttp(rig.port, { path: '/', headers: upgradeHeaders({ Origin: origin }) })
    expect(res.status).toBe(403)
    expect((await getStatus(rig.port)).extensions).toEqual([])
  })
})

// ─── (f): real shapes still register ─────────────────────────────────────────

describe('real browser shapes still register', () => {
  test('Chrome with a chrome-extension Origin', async () => {
    await connectFakeExtension(rig.port, 'chrome', { headers: { Origin: CHROME_EXTENSION_ORIGIN } })
    const ext = (await getStatus(rig.port)).extensions
    expect(ext.map((e) => [e.browser, e.kind ?? 'extension'])).toEqual([['chrome', 'extension']])
  })

  test('Edge with a chrome-extension Origin', async () => {
    await connectFakeExtension(rig.port, 'edge', { headers: { Origin: CHROME_EXTENSION_ORIGIN } })
    expect((await getStatus(rig.port)).extensions.map((e) => e.browser)).toEqual(['edge'])
  })

  test('Firefox with a moz-extension Origin', async () => {
    await connectFakeExtension(rig.port, 'firefox', { headers: { Origin: FIREFOX_EXTENSION_ORIGIN } })
    expect((await getStatus(rig.port)).extensions.map((e) => e.browser)).toEqual(['firefox'])
  })

  test('a safari-web-extension Origin over WebSocket', async () => {
    await connectFakeExtension(rig.port, 'safari', { headers: { Origin: SAFARI_EXTENSION_ORIGIN } })
    expect((await getStatus(rig.port)).extensions.map((e) => e.browser)).toEqual(['safari'])
  })

  test('a no-Origin webkit peer named nostromo registers', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T }) // default: no Origin header at all
    const status = await getStatus(rig.port)
    expect(status.ownedBrowserCount).toBe(1)
    const s = await mcpSession(rig.port, T)
    const list = await s.browsers()
    expect(list.map((b) => [b.browser, b.kind])).toEqual([['nostromo', 'webkit']])
    expect((await s.callTool('set_browser', { browser: 'nostromo' })).isError).toBe(false)
    await s.callTool('get_tabs')
    expect(peer.actions()).toEqual(['getTabs'])
  })

  test('Safari registers over POST /connect with no Origin and exchanges a command over /poll and /result', async () => {
    const res = await fetch(`http://localhost:${rig.port}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'safari', version: '17.1' }),
    })
    expect(res.status).toBe(200)
    const { id } = (await res.json()) as { id: string }
    expect(id).toBeTruthy()

    const listed = (await getStatus(rig.port)).extensions.find((e) => e.id === id)
    expect(listed).toMatchObject({ browser: 'safari', version: '17.1', transport: 'http' })

    const s = await mcpSession(rig.port)
    // The server only dispatches to an HTTP extension that is already polling.
    const polling = fetch(`http://localhost:${rig.port}/poll?id=${id}`)
    await sleep(80)
    const call = s.callTool('get_tabs')
    const cmd = (await (await polling).json()) as { id: string; action: string }
    expect(cmd.action).toBe('getTabs')
    const posted = await fetch(`http://localhost:${rig.port}/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cmd.id, success: true, data: [{ id: 7, title: 'safari tab' }] }),
    })
    expect(posted.status).toBe(204)
    const r = await call
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual([{ id: 7, title: 'safari tab' }])

    await fetch(`http://localhost:${rig.port}/connect?id=${id}`, { method: 'DELETE' })
  })
})

// ─── (g): an owner session cannot be redirected to an impostor ───────────────

describe.each(ORDERS)('an owner session with a peer and a real Chrome (%s)', (order) => {
  test('set_browser("chrome") then a command reaches the real Chrome and no squatter receives anything', async () => {
    const own = await connectFakePeer(rig.port, { owner: T })

    const attacks: Array<[string, () => Promise<Squatter>]> = [
      ['peer socket re-handshaking as chrome', peerRehandshakesAsChrome],
      ['peer socket handshaking as chrome after unregister', peerUnregistersThenHandshakesAsChrome],
      ['no-Origin raw handshake as chrome', noOriginExtensionAsChrome],
    ]
    const squatters: Array<[string, Squatter]> = []
    let chrome!: FakeBrowser
    const runAttacks = async () => {
      for (const [name, attack] of attacks) squatters.push([name, await attack()])
    }
    if (order === 'real chrome first') {
      chrome = await connectFakeExtension(rig.port, 'chrome')
      await runAttacks()
    } else {
      await runAttacks()
      chrome = await connectFakeExtension(rig.port, 'chrome')
    }

    for (const [name, sq] of squatters) await expectRefused(sq, name)
    expect(await extensionsNamed('chrome')).toHaveLength(1)

    const owner = await mcpSession(rig.port, T)
    const sel = await owner.callTool('set_browser', { browser: 'chrome' })
    expect(sel.isError, sel.text).toBe(false)
    const r = await owner.callTool('get_tabs')
    expect(r.isError, r.text).toBe(false)
    expect(r.json).toEqual({ echo: 'getTabs', by: 'chrome' })

    expect(chrome.actions()).toEqual(['getTabs'])
    expect(own.actions()).toEqual([])
    for (const [name, sq] of squatters) expect(sq.actions(), `${name} must receive no commands`).toEqual([])
  })
})

// ─── (h): impostors cannot feed or finalize a capture ────────────────────────

describe('impostors cannot touch a capture started on the real Chrome', () => {
  async function startCaptureOnChrome() {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    const s = await mcpSession(rig.port)
    const r = await s.callTool('start_capture', {})
    expect(r.isError, r.text).toBe(false)
    expect(chrome.actions()).toEqual(['startCapture'])
    expect(rig.server.getCaptureSession()?.active).toBe(true)
    return chrome
  }

  async function expectCaptureUntouchedThenFedByChrome(chrome: FakeBrowser) {
    await sleep(100)
    expect(urls()).toEqual([])
    expect(rig.server.getCaptureSession()?.active).toBe(true)

    chrome.send(networkPush('https://chrome.example/real'))
    await eventually(() => urls().includes('https://chrome.example/real'), { what: 'real chrome event to be recorded' })
    await sleep(50)
    expect(urls()).toEqual(['https://chrome.example/real'])
    expect(rig.server.getCaptureSession()?.active).toBe(true)
  }

  test('a no-Origin stranger handshaking as chrome and pushing is ignored', async () => {
    const chrome = await startCaptureOnChrome()
    const stranger = await rawSocket(rig.port)
    // Sent back to back so nothing depends on how fast the server closes the socket.
    stranger.send(asChrome())
    stranger.send(networkPush('https://stranger.example/leak'))
    stranger.send({ type: 'capture_done' })

    await expectRefused(stranger, 'stranger')
    await expectCaptureUntouchedThenFedByChrome(chrome)
  })

  test('a peer socket that re-handshook as chrome and pushes is ignored', async () => {
    const chrome = await startCaptureOnChrome()
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.send(asChrome())
    peer.send(networkPush('https://peer.example/leak'))
    peer.send({ type: 'capture_done' })

    await expectRefused(peer, 'peer socket')
    await expectCaptureUntouchedThenFedByChrome(chrome)
  })

  test('a peer socket that unregistered, handshook as chrome and pushes is ignored', async () => {
    const chrome = await startCaptureOnChrome()
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.unregister()
    peer.send(asChrome())
    peer.send(networkPush('https://peer.example/leak-after-unregister'))
    peer.send({ type: 'capture_done' })

    await expectRefused(peer, 'unregistered peer socket')
    await expectCaptureUntouchedThenFedByChrome(chrome)
  })

  test('an extension that renamed itself and pushes is ignored', async () => {
    const chrome = await startCaptureOnChrome()
    const edge = await connectFakeExtension(rig.port, 'edge')
    edge.send(asChrome())
    edge.send(networkPush('https://edge.example/leak'))
    edge.send({ type: 'capture_done' })

    await expectRefused(edge, 'renaming extension')
    await expectCaptureUntouchedThenFedByChrome(chrome)
  })
})

// ─── (i): a shared name is never silently routed ─────────────────────────────

describe('set_browser by a name two extensions share', () => {
  test('fails as ambiguous, tells the caller to select by id, and routes nothing', async () => {
    const first = await connectFakeExtension(rig.port, 'chrome', { version: '1.0' })
    const second = await connectFakeExtension(rig.port, 'chrome', { version: '2.0' })
    const s = await mcpSession(rig.port)

    const r = await s.callTool('set_browser', { browser: 'chrome' })
    expect(r.isError).toBe(true)
    expect(r.message).toMatch(/ambiguous/i)
    expect(r.message).toMatch(/\bid\b/i)
    expect(first.received).toEqual([])
    expect(second.received).toEqual([])
  })

  test('selecting either one by id works and reaches exactly that extension', async () => {
    const first = await connectFakeExtension(rig.port, 'chrome', { version: '1.0' })
    const second = await connectFakeExtension(rig.port, 'chrome', { version: '2.0' })
    const a = await mcpSession(rig.port)
    const b = await mcpSession(rig.port)

    const list = await a.browsers()
    const idOf = (version: string) => list.find((e) => e.browser === 'chrome' && e.version === version).id as string

    expect((await a.callTool('set_browser', { browser: idOf('2.0') })).isError).toBe(false)
    expect((await b.callTool('set_browser', { browser: idOf('1.0') })).isError).toBe(false)
    expect((await a.callTool('get_tabs')).isError).toBe(false)
    expect((await b.callTool('get_tabs')).isError).toBe(false)

    expect(second.actions()).toEqual(['getTabs'])
    expect(first.actions()).toEqual(['getTabs'])
  })

  test('a later same-name extension never displaces or outranks an earlier one', async () => {
    const first = await connectFakeExtension(rig.port, 'chrome', { version: '1.0' })
    const bound = await mcpSession(rig.port)
    await bound.callTool('get_tabs') // implicitly binds the first chrome

    const second = await connectFakeExtension(rig.port, 'chrome', { version: '2.0' })
    const fresh = await mcpSession(rig.port)

    await bound.callTool('get_tabs')
    await fresh.callTool('get_tabs')

    expect(first.actions()).toEqual(['getTabs', 'getTabs', 'getTabs'])
    expect(second.actions()).toEqual([])
  })

  test('with exactly one match by name it still binds, including after the twin disconnects', async () => {
    const first = await connectFakeExtension(rig.port, 'chrome', { version: '1.0' })
    const edge = await connectFakeExtension(rig.port, 'edge')
    const second = await connectFakeExtension(rig.port, 'chrome', { version: '2.0' })

    const s = await mcpSession(rig.port)
    expect((await s.callTool('set_browser', { browser: 'edge' })).isError).toBe(false)
    await s.callTool('get_tabs')
    expect(edge.actions()).toEqual(['getTabs'])

    await second.close()
    const t = await mcpSession(rig.port)
    const sel = await t.callTool('set_browser', { browser: 'chrome' })
    expect(sel.isError, sel.text).toBe(false)
    await t.callTool('get_tabs')
    expect(first.actions()).toEqual(['getTabs'])
  })
})
