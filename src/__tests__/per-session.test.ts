/**
 * BP0 D2-D4 + D8: each MCP session owns its browser choice. Black-box over real
 * /mcp and real WebSocket fake extensions.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  startRig, connectFakeExtension, connectFakePeer, mcpSession, getStatus, sleep, token, goneText,
  type Rig,
} from './helpers/fake-browsers.js'

let rig: Rig
beforeEach(async () => { rig = await startRig(3000) })
afterEach(() => rig.close())

const TOOL_CALLS: Array<[string, Record<string, unknown>, string]> = [
  ['navigate', { url: 'https://example.com' }, 'navigate'],
  ['click', { selector: '#go' }, 'click'],
  ['type', { selector: '#q', text: 'hi' }, 'type'],
  ['read_page', {}, 'readText'],
  ['read_html', {}, 'readHtml'],
  ['screenshot', {}, 'screenshot'],
  ['eval_js', { code: '1+1' }, 'evalJs'],
  ['wait_for', { selector: '#x' }, 'waitFor'],
  ['get_tabs', {}, 'getTabs'],
  ['get_cookies', {}, 'getCookies'],
  ['get_page_info', {}, 'getPageInfo'],
]

describe('session start and defaults', () => {
  test('a command with no browser connected fails with "Extension not connected"', async () => {
    const s = await mcpSession(rig.port)
    const r = await s.callTool('navigate', { url: 'https://example.com' })
    expect(r.isError).toBe(true)
    expect(r.message).toBe('Extension not connected')
  })

  test('a session with no explicit choice defaults to the earliest-connected browser', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)

    const r = await s.callTool('navigate', { url: 'https://example.com' })
    expect(r.isError).toBe(false)
    expect(r.json.by).toBe('chrome')
    expect(chrome.actions()).toEqual(['navigate'])
    expect(edge.received).toEqual([])
  })

  test('set_browser by name or id targets that browser for this session', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)

    expect((await s.callTool('set_browser', { browser: 'edge' })).isError).toBe(false)
    await s.callTool('get_tabs')
    expect(edge.actions()).toEqual(['getTabs'])

    const list = await s.browsers()
    const chromeId = list.find((b) => b.browser === 'chrome').id
    expect((await s.callTool('set_browser', { browser: chromeId })).isError).toBe(false)
    await s.callTool('get_tabs')
    expect(chrome.actions()).toEqual(['getTabs'])
  })

  test('set_browser with an unknown name reports "No connected extension matching"', async () => {
    await connectFakeExtension(rig.port, 'chrome')
    const s = await mcpSession(rig.port)
    const r = await s.callTool('set_browser', { browser: 'firefox' })
    expect(r.isError).toBe(true)
    expect(r.message).toBe("No connected extension matching 'firefox'")
  })
})

describe('legacy (no session context)', () => {
  test('server.dispatch without a session targets the earliest-connected unowned browser every time', async () => {
    const peer = await connectFakePeer(rig.port, { owner: token('T') })
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')

    expect(await rig.server.dispatch({ action: 'getTabs' })).toEqual({ echo: 'getTabs', by: 'chrome' })
    expect(await rig.server.dispatch({ action: 'getTabs' })).toEqual({ echo: 'getTabs', by: 'chrome' })

    // No binding is kept: when chrome goes, the next call simply goes to the next earliest browser.
    await chrome.close()
    expect(await rig.server.dispatch({ action: 'getTabs' })).toEqual({ echo: 'getTabs', by: 'edge' })

    expect(edge.actions()).toEqual(['getTabs'])
    expect(peer.received).toEqual([])
  })

  test('server.dispatch without a session never reaches an owned peer: with only a peer connected it fails', async () => {
    const peer = await connectFakePeer(rig.port, { owner: token('T') })
    await expect(rig.server.dispatch({ action: 'getTabs' })).rejects.toThrow('Extension not connected')
    expect(peer.received).toEqual([])
  })

  test('an owned peer is never a default target, even for a session that owns it', async () => {
    const peer = await connectFakePeer(rig.port, { owner: token('T') })
    const s = await mcpSession(rig.port, token('T'))
    const r = await s.callTool('navigate', { url: 'https://example.com' })
    expect(r.isError).toBe(true)
    expect(r.message).toBe('Extension not connected')
    expect(peer.received).toEqual([])
  })

  test('/api/status lists unowned browsers only, with active = server default, and counts owned browsers', async () => {
    const peer = await connectFakePeer(rig.port, { owner: token('T') })
    const chrome = await connectFakeExtension(rig.port, 'chrome', { version: '120.0' })
    const edge = await connectFakeExtension(rig.port, 'edge', { version: '119.0' })

    const status = await getStatus(rig.port)
    expect(status.ownedBrowserCount).toBe(1)
    expect(status.extensions).toHaveLength(2)
    for (const e of status.extensions) {
      expect(typeof e.id).toBe('string')
      expect(typeof e.browser).toBe('string')
      expect(typeof e.version).toBe('string')
      expect(e.transport).toBe('ws')
      expect(typeof e.active).toBe('boolean')
      expect(e.kind).toBe('extension')
    }
    const byName = Object.fromEntries(status.extensions.map((e) => [e.browser, e]))
    expect(byName.chrome.active).toBe(true)
    expect(byName.edge.active).toBe(false)
    expect(byName.chrome.engine).toBe('chromium')
    expect(status.extensions.some((e) => e.browser === 'nostromo')).toBe(false)
    expect(peer.received).toEqual([])
    void chrome; void edge
  })
})

describe('a session never silently moves to another browser (BP0-2)', () => {
  for (const order of ['peer first', 'chrome first'] as const) {
    test(`tool calls from unowned and other-owner sessions reach chrome and never the peer (${order}), including after chrome restarts`, async () => {
      let chrome: Awaited<ReturnType<typeof connectFakeExtension>>
      let peer: Awaited<ReturnType<typeof connectFakePeer>>
      if (order === 'peer first') {
        peer = await connectFakePeer(rig.port, { owner: token('T') })
        chrome = await connectFakeExtension(rig.port, 'chrome')
      } else {
        chrome = await connectFakeExtension(rig.port, 'chrome')
        peer = await connectFakePeer(rig.port, { owner: token('T') })
      }

      const noOwner = await mcpSession(rig.port)
      const otherOwner = await mcpSession(rig.port, token('U'))

      for (const s of [noOwner, otherOwner]) {
        for (const [tool, args, action] of TOOL_CALLS) {
          const r = await s.callTool(tool, args)
          expect(r.isError, `${tool}: ${r.text}`).toBe(false)
          expect(r.text).not.toContain('Multiple browsers')
          expect(r.json).toEqual({ echo: action, by: 'chrome' })
        }
      }
      expect(chrome.received).toHaveLength(TOOL_CALLS.length * 2)
      expect(peer.received).toEqual([])

      // Service-worker restart: old chrome drops, a new chrome connects.
      await chrome.close()
      const chrome2 = await connectFakeExtension(rig.port, 'chrome')
      const fresh = await mcpSession(rig.port)
      const freshOther = await mcpSession(rig.port, token('V'))

      for (const s of [noOwner, otherOwner, fresh, freshOther]) {
        for (const [tool, args, action] of TOOL_CALLS) {
          const r = await s.callTool(tool, args)
          expect(r.isError, `${tool}: ${r.text}`).toBe(false)
          expect(r.text).not.toContain('Multiple browsers')
          expect(r.json).toEqual({ echo: action, by: 'chrome' })
        }
      }
      expect(chrome2.received).toHaveLength(TOOL_CALLS.length * 4)
      expect(peer.received).toEqual([])
    })
  }
})

describe('a lost browser is reported, never replaced (BP0-3)', () => {
  test('explicitly bound session: edge lost -> exact gone error, chrome receives nothing', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)
    await s.callTool('set_browser', { browser: 'edge' })
    expect((await s.callTool('get_tabs')).isError).toBe(false)

    await edge.close()
    const r = await s.callTool('get_tabs')
    expect(r.isError).toBe(true)
    expect(r.message).toBe(goneText('edge'))
    expect(chrome.received).toEqual([])
  })

  test('explicitly bound session that never sent a command still gets the gone error', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)
    await s.callTool('set_browser', { browser: 'edge' })

    await edge.close()
    const r = await s.callTool('navigate', { url: 'https://example.com' })
    expect(r.message).toBe(goneText('edge'))
    expect(chrome.received).toEqual([])
  })

  test('implicitly bound session behaves the same', async () => {
    const edge = await connectFakeExtension(rig.port, 'edge')
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const s = await mcpSession(rig.port)
    expect((await s.callTool('get_tabs')).json.by).toBe('edge') // first command binds implicitly to the earliest

    await edge.close()
    const r = await s.callTool('get_tabs')
    expect(r.isError).toBe(true)
    expect(r.message).toBe(goneText('edge'))
    expect(chrome.received).toEqual([])
  })

  test('the gone error persists on every later command until the session chooses again', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const edge = await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)
    await s.callTool('set_browser', { browser: 'edge' })
    await edge.close()

    for (let i = 0; i < 3; i++) {
      expect((await s.callTool('get_tabs')).message).toBe(goneText('edge'))
    }
    expect((await s.callTool('set_browser', { browser: 'chrome' })).isError).toBe(false)
    expect((await s.callTool('get_tabs')).json.by).toBe('chrome')
    expect(chrome.actions()).toEqual(['getTabs'])
  })
})

describe('in-flight commands when a browser drops (BP0-4)', () => {
  test('commands sent to the dropped browser reject within 1s; the other browser\'s command is untouched', async () => {
    rig.close()
    rig = await startRig(8000) // long timeout so a timeout can never masquerade as a prompt rejection

    const chrome = await connectFakeExtension(rig.port, 'chrome', { hang: true })
    const edge = await connectFakeExtension(rig.port, 'edge', { hang: true })

    const onChrome = await mcpSession(rig.port)
    const edgeA = await mcpSession(rig.port)
    const edgeB = await mcpSession(rig.port)
    await edgeA.callTool('set_browser', { browser: 'edge' })
    await edgeB.callTool('set_browser', { browser: 'edge' })

    let chromeSettled = false
    const pChrome = onChrome.callTool('wait_for', { selector: '#c' }).then((r) => { chromeSettled = true; return r })
    const pEdgeA = edgeA.callTool('wait_for', { selector: '#a' })
    const pEdgeB = edgeB.callTool('wait_for', { selector: '#b' })
    const chromeCmd = await chrome.waitForCommand('waitFor')
    await edge.waitForCommand('waitFor')
    await eventuallyCount(edge.received, 2)

    const t0 = Date.now()
    await edge.close()
    const [a, b] = await Promise.all([pEdgeA, pEdgeB])
    expect(Date.now() - t0).toBeLessThan(1000)

    for (const r of [a, b]) {
      expect(r.isError).toBe(true)
      expect(r.message.startsWith('Extension disconnected. The selected browser is gone (')).toBe(true)
      expect(r.message).toBe(`Extension disconnected. ${goneText('edge')}`)
    }

    await sleep(50)
    expect(chromeSettled).toBe(false)
    chrome.reply(chromeCmd, { data: { echo: 'waitFor', by: 'chrome' } })
    const c = await pChrome
    expect(c.isError).toBe(false)
    expect(c.json).toEqual({ echo: 'waitFor', by: 'chrome' })
  })
})

async function eventuallyCount(arr: unknown[], n: number) {
  const deadline = Date.now() + 2000
  while (arr.length < n) {
    if (Date.now() > deadline) throw new Error(`expected ${n} received commands, saw ${arr.length}`)
    await sleep(5)
  }
}

describe('rebinding after a browser reconnects (BP0-5)', () => {
  for (const mode of ['implicit', 'explicit'] as const) {
    test(`a ${mode}ly bound session follows a restarted chrome to the single new chrome`, async () => {
      const chrome1 = await connectFakeExtension(rig.port, 'chrome')
      const s = await mcpSession(rig.port)
      if (mode === 'explicit') await s.callTool('set_browser', { browser: 'chrome' })
      expect((await s.callTool('get_tabs')).json.by).toBe('chrome')

      await chrome1.close()
      const chrome2 = await connectFakeExtension(rig.port, 'chrome')
      const r = await s.callTool('get_tabs')
      expect(r.isError).toBe(false)
      expect(r.json.by).toBe('chrome')
      expect(chrome2.actions()).toEqual(['getTabs'])
      expect(chrome1.actions()).toEqual(['getTabs'])
    })
  }

  test('two new chromes make the rebind ambiguous -> gone error, neither receives anything', async () => {
    const chrome1 = await connectFakeExtension(rig.port, 'chrome')
    const s = await mcpSession(rig.port)
    await s.callTool('get_tabs')
    await chrome1.close()

    const chrome2 = await connectFakeExtension(rig.port, 'chrome')
    const chrome3 = await connectFakeExtension(rig.port, 'chrome')
    const r = await s.callTool('get_tabs')
    expect(r.isError).toBe(true)
    expect(r.message).toBe(goneText('chrome'))
    expect(chrome2.received).toEqual([])
    expect(chrome3.received).toEqual([])
  })

  test('a same-named browser that connected BEFORE the bound one is never adopted', async () => {
    const older = await connectFakeExtension(rig.port, 'chrome', { version: '1.0' })
    const newer = await connectFakeExtension(rig.port, 'chrome', { version: '2.0' })
    const s = await mcpSession(rig.port)
    const newerId = (await s.browsers()).find((b) => b.version === '2.0').id
    expect((await s.callTool('set_browser', { browser: newerId })).isError).toBe(false)
    expect((await s.callTool('get_tabs')).isError).toBe(false)
    expect(newer.actions()).toEqual(['getTabs'])

    await newer.close()
    const r = await s.callTool('get_tabs')
    expect(r.isError).toBe(true)
    expect(r.message).toBe(goneText('chrome'))
    expect(older.received).toEqual([])
  })

  test('a different browser name never qualifies for rebind', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const s = await mcpSession(rig.port)
    await s.callTool('get_tabs')
    await chrome.close()
    const edge = await connectFakeExtension(rig.port, 'edge')

    const r = await s.callTool('get_tabs')
    expect(r.message).toBe(goneText('chrome'))
    expect(edge.received).toEqual([])
  })

  test('rebinding is per session: a session that never used the old chrome simply defaults', async () => {
    const chrome1 = await connectFakeExtension(rig.port, 'chrome')
    const old = await mcpSession(rig.port)
    await old.callTool('get_tabs')
    await chrome1.close()
    const chrome2 = await connectFakeExtension(rig.port, 'chrome')
    const chrome3 = await connectFakeExtension(rig.port, 'chrome')

    const fresh = await mcpSession(rig.port)
    const r = await fresh.callTool('get_tabs')
    expect(r.isError).toBe(false)
    expect(chrome2.actions()).toEqual(['getTabs']) // earliest unowned
    expect(chrome3.received).toEqual([])
  })
})

describe('get_browsers (BP0-1, D8)', () => {
  test('entries carry id, browser, version, transport, kind and engine; active is per session', async () => {
    await connectFakeExtension(rig.port, 'chrome', { version: '120.0' })
    await connectFakeExtension(rig.port, 'edge', { version: '119.0' })
    const a = await mcpSession(rig.port)
    const b = await mcpSession(rig.port)
    await a.callTool('set_browser', { browser: 'edge' })

    const la = await a.browsers()
    const lb = await b.browsers()
    expect(la).toHaveLength(2)
    for (const e of la) {
      expect(typeof e.id).toBe('string')
      expect(e.transport).toBe('ws')
      expect(e.kind).toBe('extension')
      expect(typeof e.version).toBe('string')
    }
    const pick = (l: any[], n: string) => l.find((e) => e.browser === n)
    expect(pick(la, 'edge').active).toBe(true)
    expect(pick(la, 'chrome').active).toBe(false)
    expect(pick(lb, 'chrome').active).toBe(true)
    expect(pick(lb, 'edge').active).toBe(false)
  })

  test('engine is derived from the browser name', async () => {
    for (const name of ['chrome', 'edge', 'firefox', 'safari', 'brave']) {
      await connectFakeExtension(rig.port, name)
    }
    const s = await mcpSession(rig.port)
    const list = await s.browsers()
    const engine = (n: string) => list.find((e) => e.browser === n).engine
    expect(engine('chrome')).toBe('chromium')
    expect(engine('edge')).toBe('chromium')
    expect(engine('firefox')).toBe('gecko')
    expect(engine('safari')).toBe('webkit')
    expect(engine('brave')).toBe('unknown')
  })

  test('listing browsers does not bind the session', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const s = await mcpSession(rig.port)
    expect((await s.browsers()).find((e) => e.browser === 'chrome').active).toBe(true)

    await chrome.close()
    const edge = await connectFakeExtension(rig.port, 'edge')
    const r = await s.callTool('get_tabs')
    expect(r.isError).toBe(false) // had get_browsers bound to chrome, this would be a gone error
    expect(r.json.by).toBe('edge')
    expect(edge.actions()).toEqual(['getTabs'])
  })

  test('when the session\'s browser is gone no entry is active', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)
    await s.callTool('get_tabs') // binds chrome
    await chrome.close()

    const list = await s.browsers()
    expect(list.map((e) => e.browser)).toEqual(['edge'])
    expect(list.every((e) => e.active === false)).toBe(true)
  })

  test('with nothing connected the list is empty', async () => {
    const s = await mcpSession(rig.port)
    expect(await s.browsers()).toEqual([])
  })
})
