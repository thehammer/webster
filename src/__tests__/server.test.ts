import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WebsterServer } from '../server.js'

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = server.port as number
    server.stop(true)
    // Small delay to ensure port is released
    setTimeout(() => resolve(port), 10)
  })
}

async function connectExtension(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('WebSocket connection failed'))
    setTimeout(() => reject(new Error('Connection timeout')), 3000)
  })
  return ws
}

// Connect and send the required handshake so the server tracks this WS as the extension
async function connectAndHandshake(port: number): Promise<WebSocket> {
  const ws = await connectExtension(port)
  ws.send(JSON.stringify({ type: 'connected', version: '0.1.0' }))
  await new Promise(r => setTimeout(r, 20))
  return ws
}

describe('WebsterServer', () => {
  let server: WebsterServer
  let port: number

  beforeEach(async () => {
    port = await findFreePort()
    server = new WebsterServer(port, 500) // 500ms timeout for tests
  })

  afterEach(() => {
    server.close()
  })

  test('dispatch rejects with "Extension not connected" when no WS client', async () => {
    await expect(server.dispatch({ action: 'navigate', url: 'https://example.com' }))
      .rejects.toThrow('Extension not connected')
  })

  test('isConnected() returns false initially', () => {
    expect(server.isConnected()).toBe(false)
  })

  test('isConnected() returns true after extension connects', async () => {
    const ws = await connectAndHandshake(port)
    expect(server.isConnected()).toBe(true)
    ws.close()
  })

  test('isConnected() returns false after extension disconnects', async () => {
    const ws = await connectAndHandshake(port)
    await new Promise(r => setTimeout(r, 20))
    expect(server.isConnected()).toBe(true)

    ws.close()
    await new Promise(r => setTimeout(r, 100))
    expect(server.isConnected()).toBe(false)
  })

  test('dispatch resolves with result data when extension sends matching id back', async () => {
    const ws = await connectAndHandshake(port)
    await new Promise(r => setTimeout(r, 20))

    // Echo back a successful result
    ws.onmessage = (event) => {
      const cmd = JSON.parse(event.data)
      ws.send(JSON.stringify({ id: cmd.id, success: true, data: { url: cmd.url } }))
    }

    const result = await server.dispatch({ action: 'navigate', url: 'https://example.com' })
    expect(result).toEqual({ url: 'https://example.com' })

    ws.close()
  })

  test('dispatch rejects with error message when extension sends success: false', async () => {
    const ws = await connectAndHandshake(port)
    await new Promise(r => setTimeout(r, 20))

    ws.onmessage = (event) => {
      const cmd = JSON.parse(event.data)
      ws.send(JSON.stringify({ id: cmd.id, success: false, error: 'Tab not found' }))
    }

    await expect(server.dispatch({ action: 'navigate', url: 'https://example.com' }))
      .rejects.toThrow('Tab not found')

    ws.close()
  })

  test('dispatch times out when extension does not respond', async () => {
    const ws = await connectAndHandshake(port)
    await new Promise(r => setTimeout(r, 20))

    // Don't respond to the command
    ws.onmessage = () => {}

    await expect(server.dispatch({ action: 'navigate', url: 'https://example.com' }))
      .rejects.toThrow('Command timed out after')

    ws.close()
  }, 2000)

  test('pending commands are rejected when extension disconnects mid-flight', async () => {
    const ws = await connectAndHandshake(port)
    await new Promise(r => setTimeout(r, 20))

    // Don't respond, just close
    ws.onmessage = () => {
      setTimeout(() => ws.close(), 50)
    }

    await expect(server.dispatch({ action: 'navigate', url: 'https://example.com' }))
      .rejects.toThrow('Extension disconnected')
  }, 2000)

  test('{ type: "connected" } message from extension is handled without error', async () => {
    const ws = await connectAndHandshake(port)
    await new Promise(r => setTimeout(r, 20))

    // Send the connected handshake event
    ws.send(JSON.stringify({ type: 'connected', version: '0.1.0' }))

    // Should not throw or cause any issues — wait a bit and verify server still works
    await new Promise(r => setTimeout(r, 50))
    expect(server.isConnected()).toBe(true)

    ws.close()
  })
})

describe('capture push events', () => {
  test('routes capture_event messages to active session', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)
    const ws = await connectAndHandshake(port)

    // Start a capture session on the server
    const session = server.startCaptureSession({ urlFilter: null })

    // Extension pushes a network event
    ws.send(JSON.stringify({
      type: 'capture_event',
      kind: 'network',
      data: { url: 'https://example.com/api', method: 'GET', status: 200, timestamp: Date.now() },
    }))
    await new Promise(r => setTimeout(r, 50))

    const snap = session.getSnapshot()
    expect(snap.eventCount).toBe(1)
    expect(snap.breakdown.network).toBe(1)

    session.cleanup()
    ws.close()
    server.close()
  })

  test('routes frame events to session as JPEG files', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)
    const ws = await connectAndHandshake(port)

    const session = server.startCaptureSession({ recordFrames: true })

    // Push a fake frame (base64-encoded bytes)
    const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]).toString('base64')
    ws.send(JSON.stringify({
      type: 'capture_event',
      kind: 'frame',
      data: { jpeg: fakeJpeg },
    }))
    await new Promise(r => setTimeout(r, 50))

    expect(session.getSnapshot().frameCount).toBe(1)

    session.cleanup()
    ws.close()
    server.close()
  })

  test('capture_done finalizes the session', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)
    const ws = await connectAndHandshake(port)

    const session = server.startCaptureSession({})

    ws.send(JSON.stringify({ type: 'capture_done' }))
    await new Promise(r => setTimeout(r, 50))

    expect(session.active).toBe(false)

    session.cleanup()
    ws.close()
    server.close()
  })

  test('ignores capture events when no active session', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)
    const ws = await connectAndHandshake(port)

    // No session started — should not throw
    ws.send(JSON.stringify({
      type: 'capture_event',
      kind: 'network',
      data: { url: 'https://example.com', timestamp: Date.now() },
    }))
    await new Promise(r => setTimeout(r, 50))

    expect(server.getCaptureSession()).toBeNull()

    ws.close()
    server.close()
  })
})

describe('POST /api/capture/start', () => {
  test('returns tabsAttached and warnings alongside the existing snapshot fields', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 500)
    const ws = await connectAndHandshake(port)

    ws.onmessage = (event) => {
      const cmd = JSON.parse(event.data)
      if (cmd.action === 'startCapture') {
        ws.send(JSON.stringify({ id: cmd.id, success: true, data: { tabsAttached: 0, urlFilter: null } }))
      }
    }

    const res = await fetch(`http://localhost:${port}/api/capture/start`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    })
    const body = await res.json() as { tabsAttached: number; warnings: string[]; sessionId: string; active: boolean }

    expect(res.status).toBe(200)
    expect(body.tabsAttached).toBe(0)
    expect(Array.isArray(body.warnings)).toBe(true)
    expect(body.warnings.length).toBeGreaterThan(0)
    expect(body.sessionId).toBeTruthy()
    expect(body.active).toBe(true)

    server.getCaptureSession()?.cleanup()
    ws.close()
    server.close()
  })

  test('dispatch failure returns an error response and leaves no orphaned active session', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 500)
    const ws = await connectAndHandshake(port)

    ws.onmessage = (event) => {
      const cmd = JSON.parse(event.data)
      if (cmd.action === 'startCapture') {
        ws.send(JSON.stringify({ id: cmd.id, success: false, error: 'extension not responding' }))
      }
    }

    const res = await fetch(`http://localhost:${port}/api/capture/start`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(server.getCaptureSession()?.active).toBe(false)

    server.getCaptureSession()?.cleanup()
    ws.close()
    server.close()
  })
})

// ─── Retention (startup sweep) ──────────────────────────────────────────────
//
// SAFETY: neither test below ever points retention at the real CAPTURES_DIR.
// The first constructs a server with the retention default (must be
// disabled — this suite constructs ~14 servers via `new WebsterServer(port, ...)`
// with no retention option, and none of those may sweep real data). The
// second explicitly redirects retention at a temp directory.
//
// Implementation hook assumed: WebsterServer exposes a public boolean
// `retentionEnabled` reflecting whether a retention sweep/timer is active —
// true only when constructed with a truthy `retention` option, and flipped
// back to false once `close()` has cleared the interval. Cody: wire this up,
// or swap in whatever equivalent observable you land on and adjust the
// assertions below.

describe('WebsterServer retention', () => {
  test('a default-constructed server has retention disabled and never sweeps', async () => {
    const port = await findFreePort()
    const dir = mkdtempSync(join(tmpdir(), 'webster-retention-server-'))
    const sessionDir = join(dir, 'ancient-session')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({
      id: 'ancient-session',
      config: {},
      startedAt: new Date(0).toISOString(),
      status: 'finished',
    }))
    const ancientTime = new Date(Date.now() - 365 * 24 * 3600_000)
    utimesSync(sessionDir, ancientTime, ancientTime)

    const server = new WebsterServer(port, 500) // no retention option — the default every other test in this suite relies on

    expect(server.retentionEnabled).toBe(false)
    // This directory was never handed to the server, so it must survive
    // regardless — but if a bug ever made the default fall back to sweeping
    // "whatever dir it can find," this guards against that too.
    expect(existsSync(sessionDir)).toBe(true)

    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a server constructed with an explicit retention dir runs a startup sweep that warns (not deletes) an over-age session, and close() clears the interval', async () => {
    const port = await findFreePort()
    const dir = mkdtempSync(join(tmpdir(), 'webster-retention-server-'))
    const sessionDir = join(dir, 'over-age-session')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'meta.json'), JSON.stringify({
      id: 'over-age-session',
      config: {},
      startedAt: new Date(0).toISOString(),
      status: 'finished',
    }))
    const ancientTime = new Date(Date.now() - 365 * 24 * 3600_000)
    utimesSync(sessionDir, ancientTime, ancientTime)

    const server = new WebsterServer(port, 500, { retention: { dir } })

    expect(server.retentionEnabled).toBe(true)
    // First sweep ever on this session: warned, not deleted.
    expect(existsSync(sessionDir)).toBe(true)
    const meta = JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8'))
    expect(meta.retentionExpiresAt).toBeDefined()

    server.close()
    expect(server.retentionEnabled).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })
})
