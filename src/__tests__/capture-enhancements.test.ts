import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { WebsterServer } from '../server.js'

// ─── Test harness (mirrors server.test.ts) ──────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = server.port as number
    server.stop(true)
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

async function connectAndHandshake(port: number): Promise<WebSocket> {
  const ws = await connectExtension(port)
  ws.send(JSON.stringify({ type: 'connected', version: '0.1.0' }))
  await new Promise(r => setTimeout(r, 20))
  return ws
}

// ─── /api/capture/annotate ──────────────────────────────────────────────────

describe('POST /api/capture/annotate', () => {
  test('appends an annotation event to the active capture session', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)

    const session = server.startCaptureSession({})

    const res = await fetch(`http://localhost:${port}/api/capture/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'the user clicked login' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; sessionId: string; eventCount: number }
    expect(body.success).toBe(true)
    expect(body.sessionId).toBe(session.id)
    expect(body.eventCount).toBe(1)

    const events = session.readEvents({ kind: 'annotation' })
    expect(events).toHaveLength(1)
    expect(events[0].text).toBe('the user clicked login')
    expect(events[0].timestamp).toBeDefined()

    session.cleanup()
    server.close()
  })

  test('forwards optional tag and color fields', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)

    const session = server.startCaptureSession({})

    await fetch(`http://localhost:${port}/api/capture/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'marker', tag: 'bug', color: 'red' }),
    })

    const [ev] = session.readEvents({ kind: 'annotation' })
    expect(ev.tag).toBe('bug')
    expect(ev.color).toBe('red')

    session.cleanup()
    server.close()
  })

  test('returns 400 when no capture is active', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)

    const res = await fetch(`http://localhost:${port}/api/capture/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'foo' }),
    })
    expect(res.status).toBe(400)

    server.close()
  })

  test('returns 400 when text is missing', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)

    const session = server.startCaptureSession({})

    const res = await fetch(`http://localhost:${port}/api/capture/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)

    session.cleanup()
    server.close()
  })

  test('returns 400 when capture has been stopped', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)

    const session = server.startCaptureSession({})
    session.finalize()

    const res = await fetch(`http://localhost:${port}/api/capture/annotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'too late' }),
    })
    expect(res.status).toBe(400)

    session.cleanup()
    server.close()
  })
})

// ─── capture_body WS message routing ───────────────────────────────────────

describe('capture_body WS message', () => {
  test('writes the binary body to bodies/ and rewrites the matching network event', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)
    const ws = await connectAndHandshake(port)

    const session = server.startCaptureSession({})

    // The extension pushes the network event first — this is the order observed
    // in practice, since the network event is emitted as the response completes
    // and the body is fetched via CDP afterwards.
    ws.send(JSON.stringify({
      type: 'capture_event',
      kind: 'network',
      data: {
        url: 'https://example.com/img.png',
        method: 'GET',
        status: 200,
        requestId: 'r1',
        responseBody: 'PLACEHOLDER',
        timestamp: Date.now(),
      },
    }))
    await new Promise(r => setTimeout(r, 40))

    // Now the extension pushes the real binary body.
    const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const base64 = rawBytes.toString('base64')
    ws.send(JSON.stringify({
      type: 'capture_body',
      requestId: 'r1',
      mimeType: 'image/png',
      encoding: 'base64',
      data: base64,
    }))
    await new Promise(r => setTimeout(r, 60))

    // Body file is on disk with the png extension, and contains the decoded bytes
    const expectedPath = `${session.bodiesDir}/r1.png`
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath)).toEqual(rawBytes)

    // The network event is rewritten to reference the body instead of inline data
    const [ev] = session.readEvents({ kind: 'network' })
    expect(ev.responseBody).toBeNull()
    expect(ev.responseBodyFile).toBe('bodies/r1.png')
    expect(ev.responseBodySize).toBe(rawBytes.length)
    expect(ev.responseBodyMimeType).toBe('image/png')

    session.cleanup()
    ws.close()
    server.close()
  })

  test('writes the body file even if no matching network event is present yet', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)
    const ws = await connectAndHandshake(port)

    const session = server.startCaptureSession({})

    const rawBytes = Buffer.from('hello')
    const base64 = rawBytes.toString('base64')
    ws.send(JSON.stringify({
      type: 'capture_body',
      requestId: 'r-orphan',
      mimeType: 'application/octet-stream',
      encoding: 'base64',
      data: base64,
    }))
    await new Promise(r => setTimeout(r, 40))

    expect(existsSync(`${session.bodiesDir}/r-orphan.bin`)).toBe(true)
    expect(readFileSync(`${session.bodiesDir}/r-orphan.bin`)).toEqual(rawBytes)

    session.cleanup()
    ws.close()
    server.close()
  })

  test('is ignored when no capture is active', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000)
    const ws = await connectAndHandshake(port)

    ws.send(JSON.stringify({
      type: 'capture_body',
      requestId: 'r1',
      mimeType: 'image/png',
      encoding: 'base64',
      data: Buffer.from('x').toString('base64'),
    }))
    await new Promise(r => setTimeout(r, 40))

    // No crash, no session
    expect(server.getCaptureSession()).toBeNull()

    ws.close()
    server.close()
  })
})
