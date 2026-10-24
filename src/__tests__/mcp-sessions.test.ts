/**
 * BP0 end to end: two real MCP sessions over /mcp choose browsers independently,
 * and the X-Webster-Owner header (D1) is read once at initialize.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  startRig, connectFakeExtension, connectFakePeer, mcpSession, rawInitialize, token,
  type Rig,
} from './helpers/fake-browsers.js'

let rig: Rig
beforeEach(async () => { rig = await startRig(3000) })
afterEach(() => rig.close())

describe('two sessions, independent browsers (BP0-1)', () => {
  test('one session choosing edge does not move the other session off chrome', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')
    const a = await mcpSession(rig.port)
    const b = await mcpSession(rig.port)

    expect((await a.callTool('set_browser', { browser: 'edge' })).isError).toBe(false)

    const rb = await b.callTool('navigate', { url: 'https://b.example' })
    const ra = await a.callTool('navigate', { url: 'https://a.example' })
    expect(rb.json).toEqual({ echo: 'navigate', by: 'chrome' })
    expect(ra.json).toEqual({ echo: 'navigate', by: 'edge' })
    expect(chrome.received.map((c) => c.url)).toEqual(['https://b.example'])
    expect(edge.received.map((c) => c.url)).toEqual(['https://a.example'])

    const lb = await b.browsers()
    const la = await a.browsers()
    expect(lb.find((e) => e.browser === 'chrome').active).toBe(true)
    expect(lb.find((e) => e.browser === 'edge').active).toBe(false)
    expect(la.find((e) => e.browser === 'edge').active).toBe(true)
    expect(la.find((e) => e.browser === 'chrome').active).toBe(false)
  })

  test('the order in which sessions choose does not matter', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')
    const a = await mcpSession(rig.port)
    const b = await mcpSession(rig.port)

    await b.callTool('get_tabs') // B implicitly binds chrome first
    await a.callTool('set_browser', { browser: 'edge' })
    await b.callTool('get_tabs')
    await a.callTool('get_tabs')

    expect(chrome.actions()).toEqual(['getTabs', 'getTabs'])
    expect(edge.actions()).toEqual(['getTabs'])
  })
})

describe('X-Webster-Owner (D1, BP0-12)', () => {
  const T = token('T')
  const malformed: Array<[string, string]> = [
    ['too short', 'short'],
    ['31 characters', 'T'.repeat(31)],
    ['129 characters', 'T'.repeat(129)],
    ['illegal character', `${'T'.repeat(32)}!`],
    ['space inside', `${'T'.repeat(16)} ${'T'.repeat(16)}`],
  ]

  for (const [name, value] of malformed) {
    test(`a malformed owner (${name}) is rejected with HTTP 400 and creates no session`, async () => {
      const res = await rawInitialize(rig.port, { 'X-Webster-Owner': value })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid X-Webster-Owner header' })
      expect(res.headers.get('mcp-session-id')).toBeNull()
      expect(rig.mgr.sessionCount).toBe(0)
    })
  }

  test('a valid owner creates a session', async () => {
    const res = await rawInitialize(rig.port, { 'X-Webster-Owner': T })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBeTruthy()
    expect(rig.mgr.sessionCount).toBe(1)
    await res.text()
  })

  test('the boundary lengths 32 and 128 are accepted', async () => {
    for (const len of [32, 128]) {
      const res = await rawInitialize(rig.port, { 'X-Webster-Owner': 'a'.repeat(len) })
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(rig.mgr.sessionCount).toBe(2)
  })

  test('an empty owner header and an absent header both mean unowned: neither sees an owned peer', async () => {
    await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    const empty = await mcpSession(rig.port, '')
    const absent = await mcpSession(rig.port)
    for (const s of [empty, absent]) {
      expect((await s.browsers()).map((e) => e.browser)).toEqual(['chrome'])
      const r = await s.callTool('set_browser', { browser: 'nostromo' })
      expect(r.message).toBe("No connected extension matching 'nostromo'")
    }
    expect(rig.mgr.sessionCount).toBe(2)
    expect(peer.received).toEqual([])
  })

  test('an owner header on a later request does not change the session\'s owner', async () => {
    await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    const unowned = await mcpSession(rig.port)

    // Claiming the peer's token on a later request must not grant visibility.
    expect((await unowned.browsers({ 'X-Webster-Owner': T })).map((e) => e.browser)).toEqual(['chrome'])
    const r = await unowned.callTool('set_browser', { browser: 'nostromo' }, { 'X-Webster-Owner': T })
    expect(r.message).toBe("No connected extension matching 'nostromo'")

    // And a malformed or different header on a later request neither errors nor revokes.
    const owned = await mcpSession(rig.port, T)
    expect((await owned.browsers({ 'X-Webster-Owner': token('U') })).map((e) => e.browser).sort()).toEqual(['chrome', 'nostromo'])
    expect((await owned.browsers({ 'X-Webster-Owner': 'bad' })).map((e) => e.browser).sort()).toEqual(['chrome', 'nostromo'])
    expect((await owned.callTool('set_browser', { browser: 'nostromo' }, { 'X-Webster-Owner': '' })).isError).toBe(false)
    expect((await owned.callTool('get_tabs')).json.by).toBe('nostromo')
    expect(peer.actions()).toEqual(['getTabs'])
  })

  test('sessions with the same owner share visibility of its peer; a different owner does not', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    const one = await mcpSession(rig.port, T)
    const two = await mcpSession(rig.port, T)
    const other = await mcpSession(rig.port, token('U'))
    expect((await one.browsers()).map((e) => e.browser)).toEqual(['nostromo'])
    expect((await two.browsers()).map((e) => e.browser)).toEqual(['nostromo'])
    expect(await other.browsers()).toEqual([])
    expect(peer.received).toEqual([])
  })
})
