/**
 * BP0 D5: webkit (Nostromo) peers over the shared WebSocket endpoint — handshake,
 * refusal, visibility, peer_state, select_for_owner, unregister, tool support.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  startRig, connectFakeExtension, connectFakePeer, mcpSession, rawSocket, rawHttp, getStatus,
  eventually, closedWithin, recordConsole, sleep, token, sha256Hex, goneText, peerLabel, newInstanceId,
  type Rig, type ConsoleRecorder, type FakePeer,
} from './helpers/fake-browsers.js'

const T = token('T')
const T2 = token('U')

let rig: Rig
let con: ConsoleRecorder | null = null
beforeEach(async () => { rig = await startRig(3000) })
afterEach(() => {
  con?.restore()
  con = null
  rig.close()
})

const REASON = 'the Nostromo browser pane was closed'

describe('visibility (BP0-6, BP0-7)', () => {
  test('the owner sees its peer with kind, engine, focus, profile, driver, limitations and toolSupport', async () => {
    await connectFakeExtension(rig.port, 'chrome', { version: '120.0' })
    const limitations = [{ area: 'network', missing: 'request bodies', tools: ['get_network_log'] }]
    const toolSupport = { get_accessibility_tree: { level: 'unsupported', note: 'no AX tree access' }, read_page: { level: 'parity' } }
    const peer = await connectFakePeer(rig.port, {
      owner: T, focus: { tag: 'tab-7', name: 'Docs' }, profile: 'work', driver: 'agent', limitations, toolSupport, version: '2.1',
    })
    const s = await mcpSession(rig.port, T)

    const list = await s.browsers()
    const entry = list.find((e) => e.kind === 'webkit')
    expect(entry).toBeDefined()
    expect(entry.browser).toBe('nostromo')
    expect(entry.engine).toBe('webkit')
    expect(entry.transport).toBe('ws')
    expect(entry.version).toBe('2.1')
    expect(typeof entry.id).toBe('string')
    expect(entry.focus).toEqual({ tag: 'tab-7', name: 'Docs' })
    expect(entry.profile).toBe('work')
    expect(entry.driver).toBe('agent')
    expect(entry.limitations).toEqual(limitations)
    expect(entry.toolSupport).toEqual(toolSupport)
    expect(entry.active).toBe(false) // owned peers are never a default

    const ext = list.find((e) => e.kind === 'extension')
    expect(ext.browser).toBe('chrome')
    expect(ext.engine).toBe('chromium')
    expect(ext.active).toBe(true)
    expect(peer.received).toEqual([])
  })

  test('a peer that sent no toolSupport lists none', async () => {
    await connectFakePeer(rig.port, { owner: T })
    const s = await mcpSession(rig.port, T)
    const entry = (await s.browsers()).find((e) => e.kind === 'webkit')
    expect(entry.toolSupport === undefined || entry.toolSupport === null || Object.keys(entry.toolSupport).length === 0).toBe(true)
  })

  test('peer_state updates what get_browsers shows', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T, driver: 'agent', profile: 'default' })
    const s = await mcpSession(rig.port, T)

    peer.peerState({ driver: 'user' })
    await eventually(async () => (await s.browsers()).find((e) => e.kind === 'webkit')?.driver === 'user', { what: 'driver to become user' })

    peer.peerState({ profile: 'private', focus: { tag: 'tab-9', name: 'Inbox' }, limitations: [{ area: 'input', missing: 'trusted events' }] })
    await eventually(async () => (await s.browsers()).find((e) => e.kind === 'webkit')?.profile === 'private', { what: 'profile update' })
    const entry = (await s.browsers()).find((e) => e.kind === 'webkit')
    expect(entry.focus).toEqual({ tag: 'tab-9', name: 'Inbox' })
    expect(entry.limitations).toEqual([{ area: 'input', missing: 'trusted events' }])
    expect(entry.driver).toBe('user')
  })

  test('peer_state with an invalid driver does not change what is shown', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T, driver: 'agent' })
    const s = await mcpSession(rig.port, T)
    peer.peerState({ driver: 'bogus' })
    await sleep(100)
    const entry = (await s.browsers()).find((e) => e.kind === 'webkit')
    expect(entry?.driver ?? 'agent').toBe('agent')
  })

  test('sessions with no owner or another owner do not list the peer, cannot select it, and the peer receives nothing', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    const owner = await mcpSession(rig.port, T)
    const peerId = (await owner.browsers()).find((e) => e.kind === 'webkit').id

    for (const s of [await mcpSession(rig.port), await mcpSession(rig.port, T2)]) {
      const list = await s.browsers()
      expect(list.map((e) => e.browser)).toEqual(['chrome'])

      for (const x of [peerId, 'nostromo']) {
        const r = await s.callTool('set_browser', { browser: x })
        expect(r.isError).toBe(true)
        expect(r.message).toBe(`No connected extension matching '${x}'`)
      }
      // and the failed attempts did not rebind anything
      expect((await s.callTool('get_tabs')).json.by).toBe('chrome')
    }
    expect(peer.received).toEqual([])
    expect(chrome.actions()).toEqual(['getTabs', 'getTabs'])
  })

  test('the owner can select and drive its peer by name or id', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    const s = await mcpSession(rig.port, T)

    expect((await s.callTool('set_browser', { browser: 'nostromo' })).isError).toBe(false)
    const r = await s.callTool('navigate', { url: 'https://example.com' })
    expect(r.json).toEqual({ echo: 'navigate', by: 'nostromo' })
    expect(peer.actions()).toEqual(['navigate'])
    expect(chrome.received).toEqual([])

    const id = (await s.browsers()).find((e) => e.kind === 'webkit').id
    expect((await s.callTool('set_browser', { browser: 'chrome' })).isError).toBe(false)
    expect((await s.callTool('set_browser', { browser: id })).isError).toBe(false)
    await s.callTool('get_tabs')
    expect(peer.actions()).toEqual(['navigate', 'getTabs'])
  })

  test('/api/status excludes the peer but counts it', async () => {
    await connectFakePeer(rig.port, { owner: T })
    const status = await getStatus(rig.port)
    expect(status.extensions).toEqual([])
    expect(status.ownedBrowserCount).toBe(1)
    expect(JSON.stringify(status)).not.toContain(T)
  })
})

describe('reconnect and rebind (BP0-5)', () => {
  test('a plain close then reconnect with the same instanceId rebinds the session', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const instanceId = newInstanceId()
    const peer1 = await connectFakePeer(rig.port, { owner: T, instanceId, focus: { tag: 'a', name: 'Docs' } })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    expect((await s.callTool('get_tabs')).json.by).toBe('nostromo')

    await peer1.close()
    const lost = await s.callTool('get_tabs')
    expect(lost.message).toBe(goneText(peerLabel('Docs')))

    const peer2 = await connectFakePeer(rig.port, { owner: T, instanceId, focus: { tag: 'a', name: 'Docs' } })
    const r = await s.callTool('get_tabs')
    expect(r.isError).toBe(false)
    expect(r.json.by).toBe('nostromo')
    expect(peer2.actions()).toEqual(['getTabs'])
    expect(chrome.received).toEqual([])
  })

  test('a reconnect with a different instanceId does not rebind: gone error, nothing received', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer1 = await connectFakePeer(rig.port, { owner: T, instanceId: newInstanceId(), focus: { tag: 'a', name: 'Docs' } })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    await s.callTool('get_tabs')

    await peer1.close()
    const peer2 = await connectFakePeer(rig.port, { owner: T, instanceId: newInstanceId(), focus: { tag: 'a', name: 'Docs' } })
    const r = await s.callTool('get_tabs')
    expect(r.isError).toBe(true)
    expect(r.message).toBe(goneText(peerLabel('Docs')))
    expect(peer2.received).toEqual([])
    expect(chrome.received).toEqual([])
  })

  test('with only a peer connected, the first command of a session fails instead of using the peer', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    const s = await mcpSession(rig.port, T)
    const r = await s.callTool('get_tabs')
    expect(r.message).toBe('Extension not connected')
    expect(peer.received).toEqual([])
  })
})

describe('select_for_owner (BP0-9)', () => {
  test('pins the peer for every current and future session of that owner, and only that owner', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    const existing = await mcpSession(rig.port, T)
    const otherOwner = await mcpSession(rig.port, T2)
    const unowned = await mcpSession(rig.port)

    peer.selectForOwner()
    const active = (l: any[]) => l.find((e) => e.active)?.browser
    await eventually(async () => active(await existing.browsers()) === 'nostromo', { what: 'existing session pinned' })

    const later = await mcpSession(rig.port, T)
    expect(active(await later.browsers())).toBe('nostromo')

    expect(active(await otherOwner.browsers())).toBe('chrome')
    expect(active(await unowned.browsers())).toBe('chrome')

    // commands go to the peer without any set_browser
    expect((await existing.callTool('navigate', { url: 'https://a.example' })).json.by).toBe('nostromo')
    expect((await later.callTool('navigate', { url: 'https://b.example' })).json.by).toBe('nostromo')
    expect((await otherOwner.callTool('navigate', { url: 'https://c.example' })).json.by).toBe('chrome')
    expect((await unowned.callTool('navigate', { url: 'https://d.example' })).json.by).toBe('chrome')
    expect(peer.received.map((c) => c.url)).toEqual(['https://a.example', 'https://b.example'])
    expect(chrome.received.map((c) => c.url)).toEqual(['https://c.example', 'https://d.example'])
  })

  test('a session\'s own later set_browser overrides the pin for that session only', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    const s1 = await mcpSession(rig.port, T)
    const s2 = await mcpSession(rig.port, T)
    peer.selectForOwner()
    await eventually(async () => (await s2.browsers()).find((e) => e.active)?.browser === 'nostromo', { what: 'pin applied' })

    expect((await s1.callTool('set_browser', { browser: 'chrome' })).isError).toBe(false)
    expect((await s1.callTool('get_tabs')).json.by).toBe('chrome')
    expect((await s2.callTool('get_tabs')).json.by).toBe('nostromo')
    expect(chrome.actions()).toEqual(['getTabs'])
    expect(peer.actions()).toEqual(['getTabs'])
  })

  test('select_for_owner from an extension connection is ignored', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    const s = await mcpSession(rig.port, T)

    chrome.send({ type: 'select_for_owner' })
    await sleep(100)
    expect((await s.browsers()).find((e) => e.active)?.browser).toBe('chrome')
    expect((await s.callTool('get_tabs')).json.by).toBe('chrome')
    expect(peer.received).toEqual([])
  })
})

describe('unregister (BP0-10)', () => {
  test('rejects in-flight commands with the reason, removes the peer at once, and never rebinds the session', async () => {
    rig.close()
    rig = await startRig(8000)
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const instanceId = newInstanceId()
    const focus = { tag: 'tab-3', name: 'Docs' }
    const peer = await connectFakePeer(rig.port, { owner: T, instanceId, focus, hang: true })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })

    const inflight = s.callTool('wait_for', { selector: '#x' })
    await peer.waitForCommand('waitFor')

    const t0 = Date.now()
    peer.unregister(REASON)
    const r = await inflight
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.isError).toBe(true)
    expect(r.message).toContain(REASON)
    expect(r.message).toBe(`Extension disconnected. ${goneText(peerLabel('Docs'), REASON)}`)

    const next = await s.callTool('navigate', { url: 'https://example.com' })
    expect(next.isError).toBe(true)
    expect(next.message).toBe(goneText(peerLabel('Docs'), REASON))
    expect(chrome.received).toEqual([])

    expect((await s.browsers()).map((e) => e.browser)).toEqual(['chrome'])
    expect((await getStatus(rig.port)).ownedBrowserCount).toBe(0)

    // Same-instanceId reconnect must NOT rebind a session that saw an unregister.
    await peer.close()
    const again = await connectFakePeer(rig.port, { owner: T, instanceId, focus })
    const afterReturn = await s.callTool('navigate', { url: 'https://example.com' })
    expect(afterReturn.isError).toBe(true)
    expect(afterReturn.message).toBe(goneText(peerLabel('Docs'), REASON))
    expect(again.received).toEqual([])
    expect(chrome.received).toEqual([])
  })

  test('an unregister without a reason is reported without one', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T, focus: { tag: 'x', name: 'Docs' } })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    peer.unregister()
    await eventually(async () => (await s.browsers()).length === 0, { what: 'peer to disappear from get_browsers' })
    expect((await s.callTool('get_tabs')).message).toBe(goneText(peerLabel('Docs')))
  })

  test('a plain close (no unregister) is an ordinary loss and is rebound on reconnect, unlike unregister', async () => {
    const instanceId = newInstanceId()
    const p1 = await connectFakePeer(rig.port, { owner: T, instanceId })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    await p1.close()
    const p2 = await connectFakePeer(rig.port, { owner: T, instanceId })
    expect((await s.callTool('get_tabs')).json.by).toBe('nostromo')
    expect(p2.actions()).toEqual(['getTabs'])
  })

  test('unregister clears the owner pin: a session initialised afterwards is not bound to the old peer', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.selectForOwner()
    const s1 = await mcpSession(rig.port, T)
    await eventually(async () => (await s1.browsers()).find((e) => e.active)?.browser === 'nostromo', { what: 'pin applied' })

    peer.unregister(REASON)
    await eventually(async () => (await s1.browsers()).every((e) => e.browser !== 'nostromo'), { what: 'peer removed' })
    const s2 = await mcpSession(rig.port, T)
    const r = await s2.callTool('get_tabs')
    expect(r.isError).toBe(false)
    expect(r.json.by).toBe('chrome')
    expect(chrome.actions()).toEqual(['getTabs'])
  })
})

describe('registration refusals (BP0-11)', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, string>?]> = [
    ['owner missing', { owner: undefined }],
    ['owner malformed (too short)', { owner: 'short' }],
    ['owner malformed (illegal characters)', { owner: `${'T'.repeat(31)}!` }],
    ['owner too long', { owner: 'T'.repeat(129) }],
    ['owner not a string', { owner: 12345678901234567890123456789012 }],
    ['instanceId missing', { instanceId: undefined }],
    ['instanceId malformed (too short)', { instanceId: 'abc' }],
    ['instanceId malformed (illegal characters)', { instanceId: 'has spaces in it!!' }],
    ['invalid driver', { driver: 'bogus' }],
    ['oversized limitations list', { limitations: Array.from({ length: 65 }, (_, i) => ({ area: `a${i}`, missing: 'x' })) }],
    ['oversized limitation string', { limitations: [{ area: 'a', missing: 'x'.repeat(301) }] }],
    ['oversized focus name', { focus: { tag: 't', name: 'n'.repeat(129) } }],
    ['oversized profile', { profile: 'p'.repeat(65) }],
    ['malformed browser name', { browser: 'Not Valid!' }],
  ]

  for (const [name, overrides] of cases) {
    test(`refuses with close code 1008 when ${name}`, async () => {
      const chrome = await connectFakeExtension(rig.port, 'chrome')
      const peer = await connectFakePeer(rig.port, { owner: T, overrides, awaitRegistration: false })
      const info = await closedWithin(peer, 1500)
      expect(info).not.toBeNull()
      expect(info!.code).toBe(1008)
      expect(peer.received).toEqual([])

      expect((await getStatus(rig.port)).ownedBrowserCount).toBe(0)
      const s = await mcpSession(rig.port, T)
      expect((await s.browsers()).map((e) => e.browser)).toEqual(['chrome'])
      expect(chrome.received).toEqual([])
    })
  }

  test('an extension cannot register under the reserved peer name nostromo (WS and HTTP)', async () => {
    const raw = await rawSocket(rig.port)
    raw.send({ type: 'connected', browser: 'nostromo', version: '1' })
    expect((await closedWithin(raw, 1500))?.code).toBe(1008)
    const res = await rawHttp(rig.port, { method: 'POST', path: '/connect', headers: { 'Content-Type': 'application/json' }, body: '{"browser":"nostromo"}' })
    expect(res.status).toBe(400)
    expect((await getStatus(rig.port)).extensions).toEqual([])
  })

  test('refuses with 1008 when the upgrade carries an Origin header, even an extension origin', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T, headers: { Origin: 'chrome-extension://abcdef' }, awaitRegistration: false })
    const info = await closedWithin(peer, 1500)
    expect(info?.code).toBe(1008)
    expect((await getStatus(rig.port)).ownedBrowserCount).toBe(0)
    expect(peer.received).toEqual([])
  })

  test('never registers a peer whose upgrade carries a web-page Origin', async () => {
    let refused = false
    try {
      const peer = await connectFakePeer(rig.port, { owner: T, headers: { Origin: 'https://evil.example' }, awaitRegistration: false })
      const info = await closedWithin(peer, 1500)
      refused = info !== null
    } catch {
      refused = true // upgrade itself rejected (403)
    }
    expect(refused).toBe(true)
    expect((await getStatus(rig.port)).ownedBrowserCount).toBe(0)
  })

  test('refuses a second live connection claiming an instanceId already held; the first keeps working', async () => {
    const instanceId = newInstanceId()
    const first = await connectFakePeer(rig.port, { owner: T, instanceId, focus: { tag: 'a', name: 'First' } })
    const dup = await connectFakePeer(rig.port, { owner: T, instanceId, awaitRegistration: false })
    expect((await closedWithin(dup, 1500))?.code).toBe(1008)
    const dupOtherOwner = await connectFakePeer(rig.port, { owner: T2, instanceId, awaitRegistration: false })
    expect((await closedWithin(dupOtherOwner, 1500))?.code).toBe(1008)

    expect((await getStatus(rig.port)).ownedBrowserCount).toBe(1)
    const s = await mcpSession(rig.port, T)
    expect((await s.callTool('set_browser', { browser: 'nostromo' })).isError).toBe(false)
    expect((await s.callTool('get_tabs')).json.by).toBe('nostromo')
    expect(first.actions()).toEqual(['getTabs'])
    expect(dup.received).toEqual([])
    expect(dupOtherOwner.received).toEqual([])
    expect(await closedWithin(first, 50)).toBeNull()
  })

  test('a peer handshake without kind is the extension path: it is listed as an unowned extension and its owner field is ignored', async () => {
    const ext = await connectFakeExtension(rig.port, 'edge', { handshake: { owner: T, instanceId: newInstanceId() } })
    const status = await getStatus(rig.port)
    expect(status.ownedBrowserCount).toBe(0)
    expect(status.extensions.map((e) => e.browser)).toEqual(['edge'])
    for (const s of [await mcpSession(rig.port), await mcpSession(rig.port, T2), await mcpSession(rig.port, T)]) {
      expect((await s.browsers()).map((e) => e.browser)).toEqual(['edge'])
    }
    void ext
  })

  test('kind "extension" is the extension path and ignores any owner field', async () => {
    await connectFakeExtension(rig.port, 'firefox', { handshake: { kind: 'extension', owner: T } })
    const status = await getStatus(rig.port)
    expect(status.ownedBrowserCount).toBe(0)
    expect(status.extensions.map((e) => e.browser)).toEqual(['firefox'])
  })

  test('peer_state from an extension connection is ignored', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T, driver: 'agent', profile: 'default' })
    chrome.send({ type: 'peer_state', driver: 'user', profile: 'hijacked' })
    chrome.send({ type: 'peer_state', kind: 'webkit', owner: T, driver: 'stopped' })
    await sleep(100)

    const s = await mcpSession(rig.port, T)
    const list = await s.browsers()
    const entry = list.find((e) => e.kind === 'webkit')
    expect(entry.driver).toBe('agent')
    expect(entry.profile).toBe('default')
    const ext = list.find((e) => e.kind === 'extension')
    expect(ext.driver).toBeUndefined()
    expect(ext.profile).toBeUndefined()
    void peer
  })

  test('peer_state on a connection that never registered is ignored', async () => {
    const raw = await rawSocket(rig.port)
    raw.send({ type: 'peer_state', driver: 'user', focus: { tag: 'a', name: 'b' } })
    raw.send({ type: 'select_for_owner' })
    await sleep(100)
    const status = await getStatus(rig.port)
    expect(status.ownedBrowserCount).toBe(0)
    expect(status.extensions).toEqual([])
  })

  test('an unknown message type is never treated as a handshake', async () => {
    const raw = await rawSocket(rig.port, { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })
    raw.send({ type: 'hello_world', version: '1.0', browser: 'chrome' })
    raw.send({ type: 'registration', kind: 'webkit', version: '1', browser: 'nostromo', instanceId: newInstanceId(), owner: T, engine: 'webkit', focus: { tag: 'a', name: 'b' }, profile: 'p', driver: 'agent', limitations: [] })
    await sleep(100)
    let status = await getStatus(rig.port)
    expect(status.extensions).toEqual([])
    expect(status.ownedBrowserCount).toBe(0)

    // The socket is still usable for a real handshake afterwards.
    raw.send({ type: 'connected', version: '1.0', browser: 'chrome' })
    await eventually(async () => (await getStatus(rig.port)).extensions.length === 1, { what: 'real handshake to register' })
    status = await getStatus(rig.port)
    expect(status.extensions[0].browser).toBe('chrome')
  })

  test('HTTP /connect cannot register a webkit peer', async () => {
    const res = await rawHttp(rig.port, {
      method: 'POST', path: '/connect',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'webkit', browser: 'nostromo', version: '1', instanceId: newInstanceId(), owner: T, engine: 'webkit' }),
    })
    void res
    const status = await getStatus(rig.port)
    expect(status.ownedBrowserCount).toBe(0)
    // At most a plain, unowned extension entry; never a webkit peer.
    expect(status.extensions.some((e) => e.kind === 'webkit')).toBe(false)
    const s = await mcpSession(rig.port, T)
    expect((await s.browsers()).some((e) => e.kind === 'webkit')).toBe(false)
  })
})

describe('unsupported tools on a peer (BP0-14)', () => {
  const toolSupport = {
    get_accessibility_tree: { level: 'unsupported', note: 'no AX tree access' },
    read_html: { level: 'approximate', note: 'serialised DOM may differ' },
    read_page: { level: 'parity' },
  }

  test('a tool the peer declares unsupported fails before dispatch with the exact guidance text', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T, toolSupport })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })

    const r = await s.callTool('get_accessibility_tree', {})
    expect(r.isError).toBe(true)
    expect(r.message).toBe('Not supported in the Nostromo browser (WebKit): no AX tree access. Use set_browser("chrome") for this.')
    expect(peer.received).toEqual([])
    expect(chrome.received).toEqual([])
  })

  test('parity and approximate tools still dispatch to the peer', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T, toolSupport })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    expect((await s.callTool('read_page', {})).json).toEqual({ echo: 'readText', by: 'nostromo' })
    expect((await s.callTool('read_html', {})).json).toEqual({ echo: 'readHtml', by: 'nostromo' })
    expect((await s.callTool('get_tabs', {})).json).toEqual({ echo: 'getTabs', by: 'nostromo' })
    expect(peer.actions()).toEqual(['readText', 'readHtml', 'getTabs'])
  })

  test('the same tool is not blocked when the session targets chrome', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T, toolSupport })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'chrome' })
    const r = await s.callTool('get_accessibility_tree', {})
    expect(r.isError).toBe(false)
    expect(chrome.actions()).toEqual(['getAccessibilityTree'])
    expect(peer.received).toEqual([])
  })

  test('peer_state toolSupport updates take effect', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    expect((await s.callTool('get_accessibility_tree', {})).isError).toBe(false)

    peer.peerState({ toolSupport: { get_accessibility_tree: { level: 'unsupported', note: 'gone now' } } })
    await eventually(async () => (await s.callTool('get_accessibility_tree', {})).isError, { what: 'toolSupport update' })
    const r = await s.callTool('get_accessibility_tree', {})
    expect(r.message).toBe('Not supported in the Nostromo browser (WebKit): gone now. Use set_browser("chrome") for this.')
  })
})

describe('owner token secrecy (BP0-8)', () => {
  test('the token and its sha256 appear in no tool result, HTTP body or console line', async () => {
    con = recordConsole()
    const owner = randomOwner()
    const sha = sha256Hex(owner)
    const bodies: string[] = []

    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner, focus: { tag: 'a', name: 'Docs' }, toolSupport: { get_accessibility_tree: { level: 'unsupported', note: 'n' } } })
    // refused registrations must not log the token either
    const refusedBadId = await connectFakePeer(rig.port, { owner, overrides: { instanceId: 'x' }, awaitRegistration: false })
    const refusedLong = await connectFakePeer(rig.port, { owner: 'Z'.repeat(129), awaitRegistration: false })
    await closedWithin(refusedBadId, 1500)
    await closedWithin(refusedLong, 1500)

    const s = await mcpSession(rig.port, owner)
    bodies.push(JSON.stringify(await s.browsers()))
    bodies.push((await s.callTool('set_browser', { browser: 'nostromo' })).text)
    bodies.push((await s.callTool('get_tabs')).text)
    bodies.push((await s.callTool('get_accessibility_tree')).text)
    peer.peerState({ driver: 'user' })
    peer.selectForOwner()
    await sleep(60)
    bodies.push(JSON.stringify(await s.browsers()))
    for (const path of ['/api/status', '/api/sessions', '/api/capture/current']) {
      bodies.push(await (await fetch(`http://localhost:${rig.port}${path}`)).text())
    }
    peer.unregister(REASON)
    await sleep(60)
    bodies.push(JSON.stringify(await s.browsers()))
    bodies.push((await s.callTool('get_tabs')).text)
    await peer.close()
    await chrome.close()

    const logs = con.text()
    for (const b of bodies) {
      expect(b).not.toContain(owner)
      expect(b).not.toContain(sha)
    }
    expect(logs).not.toContain(owner)
    expect(logs).not.toContain(sha)
    expect(logs).not.toContain('Z'.repeat(129))
  })
})

function randomOwner(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(33))).toString('base64url')
}

describe('peer helper sanity', () => {
  test('connectFakePeer defaults produce a valid registration', async () => {
    const peer: FakePeer = await connectFakePeer(rig.port)
    expect((await getStatus(rig.port)).ownedBrowserCount).toBe(1)
    expect(await closedWithin(peer, 50)).toBeNull()
  })
})

describe('webkit peers cannot take an extension browser\'s name (WF-2)', () => {
  test('a handshake claiming browser "chrome" is refused with 1008 and not registered', async () => {
    const before = await getStatus(rig.port)
    const peer = await connectFakePeer(rig.port, { owner: T, browser: 'chrome', awaitRegistration: false })
    const closed = await closedWithin(peer, 1500)
    expect(closed?.code).toBe(1008)
    const after = await getStatus(rig.port)
    expect(after.ownedBrowserCount ?? 0).toBe(before.ownedBrowserCount ?? 0)
    expect(after.extensions.length).toBe(before.extensions.length)
  })

  test('browser "nostromo" and an omitted browser are both accepted', async () => {
    const a = await connectFakePeer(rig.port, { owner: T, browser: 'nostromo' })
    const b = await connectFakePeer(rig.port, { owner: T, overrides: { browser: undefined } })
    expect(await closedWithin(a, 150)).toBeNull()
    expect(await closedWithin(b, 150)).toBeNull()
    const s = await mcpSession(rig.port, T)
    expect((await s.browsers()).filter((e) => e.kind === 'webkit').map((e) => e.browser)).toEqual(['nostromo', 'nostromo'])
  })

  for (const peerFirst of [true, false]) {
    test(`set_browser("chrome") reaches the real extension, never the owner's peer (${peerFirst ? 'peer' : 'extension'} connected first)`, async () => {
      let peer!: FakePeer
      if (peerFirst) peer = await connectFakePeer(rig.port, { owner: T })
      const chrome = await connectFakeExtension(rig.port, 'chrome')
      if (!peerFirst) peer = await connectFakePeer(rig.port, { owner: T })
      const s = await mcpSession(rig.port, T)

      expect((await s.callTool('set_browser', { browser: 'chrome' })).isError).toBe(false)
      const r = await s.callTool('get_tabs')
      expect(r.json.by).toBe('chrome')
      expect(chrome.actions()).toEqual(['getTabs'])
      expect(peer.received).toEqual([])
    })
  }
})
