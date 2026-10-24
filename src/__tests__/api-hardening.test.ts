import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { startRig, connectFakeExtension, eventually, type Rig } from './helpers/fake-browsers.js'

// State-changing /api routes must not be drivable from a web page, and a
// request body must never choose the command sent to the browser.

let rig: Rig
beforeEach(async () => { rig = await startRig(3000) })
afterEach(() => rig.close())

const api = (path: string, init: RequestInit = {}) => fetch(`http://localhost:${rig.port}${path}`, init)

describe('cross-origin state-changing /api calls', () => {
  test('a web-page Origin on POST /api/capture/start is refused and nothing reaches the browser', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    const res = await api('/api/capture/start', {
      method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{}',
    })
    expect(res.status).toBe(403)
    expect(chrome.received).toEqual([])
    expect(rig.server.getCaptureSession()).toBeNull()
  })

  test('Origin: null is refused on POST /api/capture/stop', async () => {
    const res = await api('/api/capture/stop', { method: 'POST', headers: { Origin: 'null' } })
    expect(res.status).toBe(403)
  })

  test('the dashboard\'s own same-origin POST is allowed', async () => {
    const res = await api('/api/capture/stop', { method: 'POST', headers: { Origin: `http://localhost:${rig.port}` } })
    expect(res.status).toBe(400) // reached the handler: "No active capture"
  })

  test('GETs are not Origin-checked', async () => {
    const res = await api('/api/status', { headers: { Origin: 'https://evil.example' } })
    expect(res.status).toBe(200)
  })
})

describe('/api/capture/start body cannot choose the action', () => {
  test('a body carrying action:"eval_js" still sends startCapture', async () => {
    const chrome = await connectFakeExtension(rig.port, 'chrome')
    chrome.setReply('startCapture', { tabsAttached: 1 })
    const res = await api('/api/capture/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'eval_js', code: 'document.cookie' }),
    })
    expect(res.status).toBe(200)
    await eventually(() => chrome.received.length > 0, { what: 'command' })
    expect(chrome.received.map((c: { action: string }) => c.action)).toEqual(['startCapture'])
  })
})
