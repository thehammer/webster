/**
 * BP0 D7: the single global capture only accepts pushes from connections whose
 * owner matches the browser the capture was started on; stop_capture always
 * finalizes the server-side session.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { WebsterServer } from '../server.js'
import {
  startRig, connectFakeExtension, connectFakePeer, mcpSession, sleep, eventually, getStatus, token,
  rawSocket, findFreePort, closedWithin,
  type Rig,
} from './helpers/fake-browsers.js'

const T = token('T')

let rig: Rig
beforeEach(async () => { rig = await startRig(3000) })
afterEach(() => rig.close())

const networkPush = (url: string) => ({
  type: 'capture_event',
  kind: 'network',
  data: { url, method: 'GET', status: 200, timestamp: Date.now() },
})

const urls = () => (rig.server.getCaptureSession()?.readEvents({ kind: 'network' }) ?? []).map((e) => e.url)

async function startOn(session: Awaited<ReturnType<typeof mcpSession>>) {
  const r = await session.callTool('start_capture', {})
  expect(r.isError, r.text).toBe(false)
  expect(rig.server.getCaptureSession()?.active).toBe(true)
  return r
}

describe('capture started on an extension (unowned)', () => {
  test('pushes from the extension are recorded; pushes from an owned peer are not', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    const peer = await connectFakePeer(rig.port, { owner: T })
    const s = await mcpSession(rig.port)
    await startOn(s)
    expect(chrome.actions()).toEqual(['startCapture'])

    peer.send(networkPush('https://peer.example/leak'))
    await sleep(60)
    chrome.send(networkPush('https://chrome.example/ok'))
    await eventually(() => urls().includes('https://chrome.example/ok'), { what: 'chrome event to be recorded' })
    await sleep(60)

    expect(urls()).toEqual(['https://chrome.example/ok'])
    expect(peer.actions()).toEqual([])
  })

  test('a peer cannot finalize an extension capture with capture_done', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    const peer = await connectFakePeer(rig.port, { owner: T })
    await startOn(await mcpSession(rig.port))

    peer.send({ type: 'capture_done' })
    await sleep(80)
    expect(rig.server.getCaptureSession()?.active).toBe(true)
  })

  test('an unowned reconnect (service-worker restart) still feeds the capture', async () => {
    const chrome1 = await connectFakeExtension(rig.port, 'chrome')
    chrome1.setReply('startCapture', { tabsAttached: 1 })
    await startOn(await mcpSession(rig.port))
    await chrome1.close()

    const chrome2 = await connectFakeExtension(rig.port, 'chrome')
    chrome2.send(networkPush('https://chrome2.example/after-restart'))
    await eventually(() => urls().includes('https://chrome2.example/after-restart'), { what: 'reconnected extension events' })
  })

  test('HTTP-transport pushes (unowned) are recorded', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    await startOn(await mcpSession(rig.port))

    // A push over /result counts only from a registered HTTP extension, identified by its token.
    const reg = await fetch(`http://localhost:${rig.port}/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ browser: 'safari', version: '17' }),
    })
    const { token: safariToken } = (await reg.json()) as { token: string }
    const res = await fetch(`http://localhost:${rig.port}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webster-Token': safariToken }, body: JSON.stringify(networkPush('https://http.example/push')),
    })
    expect(res.status).toBe(204)
    await eventually(() => urls().includes('https://http.example/push'), { what: 'HTTP pushed event' })
  })

  test('an owner session driving chrome still starts an unowned capture that only chrome can feed', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    const peer = await connectFakePeer(rig.port, { owner: T })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'chrome' })
    await startOn(s)

    peer.send(networkPush('https://peer.example/no'))
    await sleep(60)
    chrome.send(networkPush('https://chrome.example/yes'))
    await eventually(() => urls().includes('https://chrome.example/yes'), { what: 'chrome event' })
    await sleep(60)
    expect(urls()).toEqual(['https://chrome.example/yes'])
  })
})

describe('capture started on a peer (owned)', () => {
  test('pushes from the peer are recorded; pushes from the extension and over HTTP are not', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.setReply('startCapture', { tabsAttached: 1 })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    await startOn(s)
    expect(peer.actions()).toEqual(['startCapture'])
    expect(chrome.received).toEqual([])

    chrome.send(networkPush('https://chrome.example/leak'))
    await fetch(`http://localhost:${rig.port}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(networkPush('https://http.example/leak')),
    })
    await sleep(60)
    peer.send(networkPush('https://peer.example/ok'))
    await eventually(() => urls().includes('https://peer.example/ok'), { what: 'peer event to be recorded' })
    await sleep(60)

    expect(urls()).toEqual(['https://peer.example/ok'])
  })

  test('a different peer (another owner) cannot feed the capture', async () => {
    const owner = await connectFakePeer(rig.port, { owner: T })
    owner.setReply('startCapture', { tabsAttached: 1 })
    const stranger = await connectFakePeer(rig.port, { owner: token('U') })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    await startOn(s)

    stranger.send(networkPush('https://stranger.example/no'))
    await sleep(60)
    owner.send(networkPush('https://owner.example/yes'))
    await eventually(() => urls().includes('https://owner.example/yes'), { what: 'owner peer event' })
    await sleep(60)
    expect(urls()).toEqual(['https://owner.example/yes'])
  })

  test('stop_capture tells the peer to stop and finalizes the session without a warning', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.setReply('startCapture', { tabsAttached: 1 })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    await startOn(s)

    const r = await s.callTool('stop_capture')
    expect(r.isError, r.text).toBe(false)
    expect(r.json.warning).toBeUndefined()
    expect(peer.actions()).toEqual(['startCapture', 'stopCapture'])
    expect(rig.server.getCaptureSession()?.active).toBe(false)
  })
})

describe('stop_capture when the capture\'s browser is gone', () => {
  test('still finalizes the server-side session and returns the snapshot with a warning', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    const s = await mcpSession(rig.port)
    await startOn(s)
    chrome.send(networkPush('https://chrome.example/before-drop'))
    await eventually(() => urls().includes('https://chrome.example/before-drop'), { what: 'event before drop' })
    const sessionId = rig.server.getCaptureSession()!.id

    await chrome.close()
    const r = await s.callTool('stop_capture')
    expect(r.isError, r.text).toBe(false)
    expect(r.json.sessionId).toBe(sessionId)
    expect(r.json.eventCount).toBe(1)
    expect(typeof r.json.warning).toBe('string')
    expect(r.json.warning.startsWith('Could not tell the browser to stop capturing: ')).toBe(true)
    expect(r.json.warning).toContain('The selected browser is gone')
    expect(rig.server.getCaptureSession()?.active).toBe(false)
  })

  test('a peer capture whose peer unregistered is finalized the same way', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    peer.setReply('startCapture', { tabsAttached: 1 })
    const s = await mcpSession(rig.port, T)
    await s.callTool('set_browser', { browser: 'nostromo' })
    await startOn(s)

    peer.unregister('pane closed')
    await eventually(async () => (await getStatus(rig.port)).ownedBrowserCount === 0, { what: 'peer removed' })
    const r = await s.callTool('stop_capture')
    expect(r.isError, r.text).toBe(false)
    expect(r.json.warning).toContain('Could not tell the browser to stop capturing')
    expect(rig.server.getCaptureSession()?.active).toBe(false)
  })

  test('with no capture at all stop_capture still reports that there is none', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const s = await mcpSession(rig.port)
    const r = await s.callTool('stop_capture')
    expect(r.isError).toBe(true)
    expect(r.message).toBe('No active capture session')
    void chrome
  })
})

describe('legacy /api/capture/* with a peer connected (BP0-16)', () => {
  test('start and stop reach the unowned chrome only; the peer receives nothing', async () => {
    const peer = await connectFakePeer(rig.port, { owner: T })
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })

    const start = await fetch(`http://localhost:${rig.port}/api/capture/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(start.status).toBe(200)
    const started = await start.json() as { sessionId: string; active: boolean }
    expect(started.active).toBe(true)

    chrome.send(networkPush('https://chrome.example/api-capture'))
    peer.send(networkPush('https://peer.example/api-leak'))
    await eventually(() => urls().includes('https://chrome.example/api-capture'), { what: 'chrome event' })
    await sleep(60)
    expect(urls()).toEqual(['https://chrome.example/api-capture'])

    const stop = await fetch(`http://localhost:${rig.port}/api/capture/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)
    const stopped = await stop.json() as { sessionId: string }
    expect(stopped.sessionId).toBe(started.sessionId)

    expect(chrome.actions()).toEqual(['startCapture', 'stopCapture'])
    expect(peer.received).toEqual([])
    expect(rig.server.getCaptureSession()?.active).toBe(false)
  })

  test('/api/capture/stop finalizes even when the browser has gone', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    await fetch(`http://localhost:${rig.port}/api/capture/start`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    await chrome.close()

    const stop = await fetch(`http://localhost:${rig.port}/api/capture/stop`, { method: 'POST' })
    expect(stop.status).toBe(200)
    expect(rig.server.getCaptureSession()?.active).toBe(false)
  })
})

describe('only a registered browser may push into a capture (WF-1)', () => {
  test('an un-handshaken socket cannot inject events or finalize an extension capture', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    await startOn(await mcpSession(rig.port))
    const stranger = await rawSocket(rig.port)

    stranger.send(networkPush('https://stranger.example/inject'))
    stranger.send({ type: 'capture_done' })
    await sleep(80)
    expect(urls()).toEqual([])
    expect(rig.server.getCaptureSession()?.active).toBe(true)

    chrome.send(networkPush('https://chrome.example/ok'))
    await eventually(() => urls().includes('https://chrome.example/ok'), { what: 'registered extension event' })
    expect(urls()).toEqual(['https://chrome.example/ok'])
  })

  test('a peer that unregistered (socket still open) cannot inject events or finalize an extension capture', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    const peer = await connectFakePeer(rig.port, { owner: T })
    await startOn(await mcpSession(rig.port))

    peer.unregister('pane closed')
    await eventually(async () => (await getStatus(rig.port)).ownedBrowserCount === 0, { what: 'peer removed' })
    expect(peer.ws.readyState).toBe(WebSocket.OPEN)

    peer.send(networkPush('https://peer.example/after-unregister'))
    peer.send({ type: 'capture_done' })
    await sleep(80)
    expect(urls()).toEqual([])
    expect(rig.server.getCaptureSession()?.active).toBe(true)

    chrome.send(networkPush('https://chrome.example/ok'))
    await eventually(() => urls().includes('https://chrome.example/ok'), { what: 'registered extension event' })
  })
})

describe('handshake timeout (WF-1)', () => {
  test('a socket that never registers is closed with 1008; a registered one is left alone', async () => {
    const port = await findFreePort()
    const server = new WebsterServer(port, 2000, { handshakeTimeoutMs: 200 })
    try {
      const silent = await rawSocket(port)
      const chrome = await connectFakeExtension(port, 'chrome')
      const closed = await closedWithin(silent, 1500)
      expect(closed?.code).toBe(1008)
      expect(await closedWithin({ closed: chrome.closed }, 400)).toBeNull()
      expect(chrome.ws.readyState).toBe(WebSocket.OPEN)
      await chrome.close()
    } finally {
      server.close()
    }
  })
})
