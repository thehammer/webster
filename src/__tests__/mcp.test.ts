import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebsterServer } from '../server.js'
import { McpSessionManager } from '../mcp.js'

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = server.port as number
    server.stop(true)
    setTimeout(() => resolve(port), 10)
  })
}

async function mcpPost(port: number, body: unknown, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  return fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  }
}

describe('McpSessionManager', () => {
  let wsServer: WebsterServer
  let sessionManager: McpSessionManager
  let port: number

  beforeEach(async () => {
    port = await findFreePort()
    wsServer = new WebsterServer(port, 500)
    sessionManager = new McpSessionManager(wsServer)
    wsServer.setMcpHandler((req) => sessionManager.handleRequest(req))
  })

  afterEach(() => {
    wsServer.close()
  })

  test('starts with 0 sessions', () => {
    expect(sessionManager.sessionCount).toBe(0)
    expect(sessionManager.getSessionIds()).toEqual([])
  })

  test('POST /mcp with initialize creates a session', async () => {
    const res = await mcpPost(port, initializeBody())
    expect(res.status).toBe(200)
    expect(sessionManager.sessionCount).toBe(1)
  })

  test('response includes mcp-session-id header', async () => {
    const res = await mcpPost(port, initializeBody())
    expect(res.headers.get('mcp-session-id')).toBeTruthy()
  })

  test('two initialize requests create two independent sessions', async () => {
    const res1 = await mcpPost(port, initializeBody())
    const res2 = await mcpPost(port, initializeBody())
    expect(sessionManager.sessionCount).toBe(2)
    const id1 = res1.headers.get('mcp-session-id')
    const id2 = res2.headers.get('mcp-session-id')
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })

  test('request with unknown session ID returns 404', async () => {
    const res = await mcpPost(port, initializeBody(), 'nonexistent-session-id')
    expect(res.status).toBe(404)
  })

  test('existing session handles subsequent requests', async () => {
    const initRes = await mcpPost(port, initializeBody())
    const sessionId = initRes.headers.get('mcp-session-id')!

    const followUp = await mcpPost(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      sessionId
    )
    expect(followUp.status).toBe(200)
  })

  test('session IDs from getSessionIds() match headers', async () => {
    const res1 = await mcpPost(port, initializeBody())
    const res2 = await mcpPost(port, initializeBody())

    const id1 = res1.headers.get('mcp-session-id')!
    const id2 = res2.headers.get('mcp-session-id')!

    const ids = sessionManager.getSessionIds()
    expect(ids).toContain(id1)
    expect(ids).toContain(id2)
    expect(ids).toHaveLength(2)
  })
})
