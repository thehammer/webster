/**
 * Follow-ups to BP0: a command result only counts when it comes from the
 * browser the command was sent to, and MCP sessions that die without a DELETE
 * are forgotten.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  startRig, connectFakeExtension, mcpSession, rawSocket, sleep, eventually,
  type Rig,
} from './helpers/fake-browsers.js'

let rig: Rig
afterEach(() => rig.close())

describe('results are bound to the browser that received the command', () => {
  test('another registered extension cannot answer a command sent to a different browser', async () => {
    rig = await startRig(3000)
    const chrome = await connectFakeExtension(rig.port, 'chrome', { hang: true })
    const edge = await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)

    const call = s.callTool('get_tabs')
    const cmd = await chrome.waitForCommand('getTabs')
    let settled = false
    void call.then(() => { settled = true })

    edge.send({ id: cmd.id, success: true, data: { spoofed: true } })
    await sleep(120)
    expect(settled).toBe(false)

    chrome.reply(cmd, { data: { genuine: true } })
    const r = await call
    expect(r.isError).toBe(false)
    expect(r.json).toEqual({ genuine: true })
  })

  test('a spoofed result does not stop the command from timing out when the real browser never answers', async () => {
    rig = await startRig(400)
    const chrome = await connectFakeExtension(rig.port, 'chrome', { hang: true })
    const edge = await connectFakeExtension(rig.port, 'edge')
    const s = await mcpSession(rig.port)

    const call = s.callTool('get_tabs')
    const cmd = await chrome.waitForCommand('getTabs')
    edge.send({ id: cmd.id, success: true, data: { spoofed: true } })

    const r = await call
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain('spoofed')
  })

  test('an un-handshaken socket cannot answer a command either', async () => {
    rig = await startRig(3000)
    const chrome = await connectFakeExtension(rig.port, 'chrome', { hang: true })
    const stranger = await rawSocket(rig.port)
    const s = await mcpSession(rig.port)

    const call = s.callTool('get_tabs')
    const cmd = await chrome.waitForCommand('getTabs')
    stranger.send({ id: cmd.id, success: true, data: { spoofed: true } })
    await sleep(100)
    chrome.reply(cmd, { data: { genuine: true } })
    expect((await call).json).toEqual({ genuine: true })
  })
})

describe('MCP session cleanup without DELETE', () => {
  test('closing a session\'s transport removes it', async () => {
    rig = await startRig()
    await connectFakeExtension(rig.port, 'chrome')
    const keep = await mcpSession(rig.port)
    const gone = await mcpSession(rig.port)
    expect(rig.mgr.sessionCount).toBe(2)

    // Pragmatic fallback: there is no HTTP-level way to kill a transport, so reach the manager's map.
    const transport = (rig.mgr as any).sessions.get(gone.sessionId)
    expect(transport).toBeDefined()
    await transport.close()

    await eventually(() => rig.mgr.sessionCount === 1, { what: 'closed session to be dropped' })
    expect(rig.mgr.getSessionIds()).toEqual([keep.sessionId])
    expect((await gone.request({ jsonrpc: '2.0', id: 9, method: 'tools/list' })).status).toBe(404)
    expect((await keep.callTool('get_tabs')).isError).toBe(false)
    // The server-side registry forgets the context too (internal check; no public accessor).
    const registry = (rig.server as any).registry
    expect([...registry.sessions.keys()]).toEqual([keep.sessionId])
  })
})
