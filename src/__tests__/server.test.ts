import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
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
