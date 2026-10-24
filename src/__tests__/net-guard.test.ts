/**
 * BP0 D6: loopback / Host / Origin guard. Pure helpers first, then HTTP-level
 * behaviour driven over raw TCP so Host and Origin are fully controlled.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import { isLoopbackAddress, isAllowedHost, isWebPageOrigin, ownerFingerprint } from '../net-guard.js'
import {
  startRig, rawHttp, upgradeHeaders, rawSocket, connectFakePeer, getStatus, closedWithin,
  type Rig,
} from './helpers/fake-browsers.js'

describe('isLoopbackAddress', () => {
  test.each(['127.0.0.1', '127.1.2.3', '127.255.255.255', '::1', '::ffff:127.0.0.1', '::ffff:127.9.9.9'])('accepts %s', (a) => {
    expect(isLoopbackAddress(a)).toBe(true)
  })
  test.each(['192.168.1.5', '10.0.0.1', '0.0.0.0', '128.0.0.1', '::ffff:10.0.0.1', 'fe80::1', '2001:db8::1', 'localhost', ''])('rejects %p', (a) => {
    expect(isLoopbackAddress(a)).toBe(false)
  })
  test('rejects absent addresses', () => {
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress(null)).toBe(false)
  })
})

describe('isAllowedHost', () => {
  test.each(['localhost', 'localhost:3456', '127.0.0.1', '127.0.0.1:80', '[::1]', '[::1]:3456'])('accepts %s', (h) => {
    expect(isAllowedHost(h)).toBe(true)
  })
  test.each(['evil.example', 'evil.example:3456', 'localhost.evil.example', 'evil.example/localhost', '127.0.0.1.evil.example', '192.168.1.5:3456', '0.0.0.0:3456', 'localhost@evil.example', ''])('rejects %p', (h) => {
    expect(isAllowedHost(h)).toBe(false)
  })
})

describe('isWebPageOrigin', () => {
  test.each(['http://evil.example', 'https://evil.example', 'https://localhost:3456', 'null'])('treats %s as a web page', (o) => {
    expect(isWebPageOrigin(o)).toBe(true)
  })
  test.each(['chrome-extension://abc', 'moz-extension://abc', 'safari-web-extension://abc'])('does not treat %s as a web page', (o) => {
    expect(isWebPageOrigin(o)).toBe(false)
  })
  test('does not treat an absent Origin as a web page', () => {
    expect(isWebPageOrigin(undefined)).toBe(false)
    expect(isWebPageOrigin(null)).toBe(false)
  })
})

describe('ownerFingerprint', () => {
  test('is the first 8 hex chars of the token\'s sha256', () => {
    const t = 'T'.repeat(32)
    const fp = ownerFingerprint(t)
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    expect(fp).toBe(createHash('sha256').update(t).digest('hex').slice(0, 8))
    expect(ownerFingerprint(t)).toBe(fp)
    expect(ownerFingerprint('U'.repeat(32))).not.toBe(fp)
  })
})

describe('HTTP guard', () => {
  let rig: Rig | null = null
  const saved = process.env.WEBSTER_ALLOW_NON_LOOPBACK
  afterEach(() => {
    rig?.close()
    rig = null
    if (saved === undefined) delete process.env.WEBSTER_ALLOW_NON_LOOPBACK
    else process.env.WEBSTER_ALLOW_NON_LOOPBACK = saved
  })

  const initBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  })
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

  describe('Host header', () => {
    test('a foreign Host is refused with 403 on /api/status, /mcp and a WebSocket upgrade', async () => {
      rig = await startRig()
      const evil = `evil.example:${rig.port}`

      const status = await rawHttp(rig.port, { path: '/api/status', headers: { Host: evil } })
      expect(status.status).toBe(403)
      expect(status.body).toContain('Webster: unexpected Host header')

      const mcp = await rawHttp(rig.port, { method: 'POST', path: '/mcp', headers: { Host: evil, ...mcpHeaders }, body: initBody })
      expect(mcp.status).toBe(403)
      expect(rig.mgr.sessionCount).toBe(0)

      const ws = await rawHttp(rig.port, { path: '/', headers: upgradeHeaders({ Host: evil }) })
      expect(ws.status).toBe(403)
    })

    test('a foreign Host cannot register a browser over WebSocket', async () => {
      rig = await startRig()
      const res = await rawHttp(rig.port, { path: '/', headers: upgradeHeaders({ Host: 'evil.example' }) })
      expect(res.status).toBe(403)
      expect((await getStatus(rig.port)).extensions).toEqual([])
    })

    test.each(['localhost', '127.0.0.1', '[::1]'])('Host %s (with port) is allowed', async (h) => {
      rig = await startRig()
      const res = await rawHttp(rig.port, { path: '/api/status', headers: { Host: `${h}:${rig.port}` } })
      expect(res.status).toBe(200)
    })

    test('the guard covers /dashboard and /api/sessions too', async () => {
      rig = await startRig()
      for (const path of ['/dashboard', '/api/sessions', '/api/capture/current']) {
        const res = await rawHttp(rig.port, { path, headers: { Host: 'evil.example' } })
        expect(res.status, path).toBe(403)
      }
    })
  })

  describe('Origin header', () => {
    const webOrigins = ['https://evil.example', 'http://evil.example', 'null']

    for (const origin of webOrigins) {
      test(`Origin ${origin} is refused with 403 on WS upgrade, /connect, /poll, /result and /mcp`, async () => {
        rig = await startRig()
        const h = { Origin: origin }

        expect((await rawHttp(rig.port, { path: '/', headers: upgradeHeaders(h) })).status).toBe(403)
        expect((await rawHttp(rig.port, { method: 'POST', path: '/connect', headers: { ...h, 'Content-Type': 'application/json' }, body: '{"browser":"chrome"}' })).status).toBe(403)
        expect((await rawHttp(rig.port, { method: 'DELETE', path: '/connect?id=nope', headers: h })).status).toBe(403)
        expect((await rawHttp(rig.port, { path: '/poll?id=nope', headers: h })).status).toBe(403)
        expect((await rawHttp(rig.port, { method: 'POST', path: '/result', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403)
        expect((await rawHttp(rig.port, { method: 'POST', path: '/mcp', headers: { ...h, ...mcpHeaders }, body: initBody })).status).toBe(403)

        expect(rig.mgr.sessionCount).toBe(0)
        expect((await getStatus(rig.port)).extensions).toEqual([])
      })
    }

    test.each(['chrome-extension://abcdef', 'moz-extension://abcdef', 'safari-web-extension://abcdef'])('extension Origin %s is accepted on WS upgrade, /connect and /mcp', async (origin) => {
      rig = await startRig()
      const h = { Origin: origin }

      expect((await rawHttp(rig.port, { path: '/', headers: upgradeHeaders(h) })).status).toBe(101)

      const connect = await rawHttp(rig.port, { method: 'POST', path: '/connect', headers: { ...h, 'Content-Type': 'application/json' }, body: '{"browser":"safari","version":"1"}' })
      expect(connect.status).toBe(200)
      expect(JSON.parse(connect.body).id).toBeTruthy()

      expect((await rawHttp(rig.port, { method: 'POST', path: '/mcp', headers: { ...h, ...mcpHeaders }, body: initBody })).status).toBe(200)
    })

    test('a real WebSocket with a chrome-extension Origin can register as an extension', async () => {
      rig = await startRig()
      const raw = await rawSocket(rig.port, { Origin: 'chrome-extension://abcdef' })
      raw.send({ type: 'connected', version: '1.0', browser: 'chrome' })
      const deadline = Date.now() + 2000
      while ((await getStatus(rig.port)).extensions.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect((await getStatus(rig.port)).extensions.map((e) => e.browser)).toEqual(['chrome'])
    })

    test('a request with no Origin is accepted on /connect and /mcp', async () => {
      rig = await startRig()
      expect((await rawHttp(rig.port, { method: 'POST', path: '/connect', headers: { 'Content-Type': 'application/json' }, body: '{"browser":"safari"}' })).status).toBe(200)
      expect((await rawHttp(rig.port, { method: 'POST', path: '/mcp', headers: mcpHeaders, body: initBody })).status).toBe(200)
    })

    test('/dashboard, /api/status and /api/sessions are not Origin-checked', async () => {
      rig = await startRig()
      for (const path of ['/dashboard', '/api/status', '/api/sessions']) {
        expect((await rawHttp(rig.port, { path })).status, `${path} without Origin`).toBe(200)
        expect((await rawHttp(rig.port, { path, headers: { Origin: 'https://evil.example' } })).status, `${path} with web Origin`).toBe(200)
      }
    })

    test('/replay/* is not Origin-checked', async () => {
      rig = await startRig()
      const res = await rawHttp(rig.port, { path: '/replay/does-not-exist/meta', headers: { Origin: 'https://evil.example' } })
      expect(res.status).not.toBe(403)
    })
  })

  describe('webkit peers are always loopback-only and Origin-free', () => {
    test('a peer with any Origin is refused even with WEBSTER_ALLOW_NON_LOOPBACK=1', async () => {
      process.env.WEBSTER_ALLOW_NON_LOOPBACK = '1'
      rig = await startRig()
      const peer = await connectFakePeer(rig.port, { owner: 'T'.repeat(32), headers: { Origin: 'chrome-extension://abc' }, awaitRegistration: false })
      expect((await closedWithin(peer, 1500))?.code).toBe(1008)
      expect((await getStatus(rig.port)).ownedBrowserCount).toBe(0)
    })
  })

  describe('WEBSTER_ALLOW_NON_LOOPBACK=1', () => {
    test('disables the Host check', async () => {
      process.env.WEBSTER_ALLOW_NON_LOOPBACK = '1'
      rig = await startRig()
      const res = await rawHttp(rig.port, { path: '/api/status', headers: { Host: 'evil.example' } })
      expect(res.status).toBe(200)
    })

    test('does not disable the Origin check', async () => {
      process.env.WEBSTER_ALLOW_NON_LOOPBACK = '1'
      rig = await startRig()
      const res = await rawHttp(rig.port, { method: 'POST', path: '/connect', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })
      expect(res.status).toBe(403)
    })
  })
})
