/**
 * Bug: CDP omits request.postData for many JS-sent POSTs and sets
 * hasPostData: true instead; the extension must recover the body
 * (postDataEntries, else Network.getRequestPostData) before finalizing.
 *
 * Drives the real handleDebuggerEvent via start_capture with a stubbed chrome.
 */
import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import { resolve } from 'node:path'

const pushed: any[] = []
mock.module(resolve(import.meta.dir, '../../extension/background/service-worker.js'), () => ({
  pushToServer: (m: any) => { pushed.push(m) },
}))

type Cmd = { debuggee: any; method: string; params: any }
const sent: Cmd[] = []
let onEvent: ((source: any, method: string, params: any) => void) | null = null
let postDataImpl: (debuggee: any, params: any) => Promise<any> = async () => ({})

const noopEvent = { addListener() {}, removeListener() {} }
// Bun runs every test file in one process, so restore the global we replace.
// (mock.module above can't be undone, but it only targets the service-worker
// module, which no other test file imports.)
const hadChrome = 'chrome' in globalThis
const previousChrome = (globalThis as any).chrome
afterAll(() => {
  if (hadChrome) (globalThis as any).chrome = previousChrome
  else delete (globalThis as any).chrome
})
;(globalThis as any).chrome = {
  runtime: { lastError: undefined, sendMessage: async () => {} },
  tabs: { query: async () => [], get: async () => ({}), sendMessage: async () => {}, onCreated: noopEvent, onRemoved: noopEvent, onUpdated: noopEvent },
  webNavigation: { onBeforeNavigate: noopEvent, onCompleted: noopEvent },
  debugger: {
    attach: async () => {},
    detach: async () => {},
    onEvent: { addListener: (fn: any) => { onEvent = fn }, removeListener() {} },
    onDetach: noopEvent,
    sendCommand: (debuggee: any, method: string, params: any) => {
      sent.push({ debuggee, method, params })
      if (method === 'Network.getRequestPostData') return postDataImpl(debuggee, params)
      if (method === 'Network.getResponseBody') return Promise.resolve({ body: '{"ok":true}', base64Encoded: false })
      return Promise.resolve({})
    },
  },
} as any

// @ts-expect-error plain-JS extension module has no type declarations
const { executeCommand } = await import('../../extension/background/command-handlers.js')

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
const postCalls = () => sent.filter(c => c.method === 'Network.getRequestPostData')

async function capturePost(request: Record<string, unknown>, source: any = { tabId: 7 }) {
  await executeCommand({ action: 'startCapture' } as any)
  const requestId = 'req-1'
  onEvent!(source, 'Network.requestWillBeSent', {
    requestId, type: 'XHR', timestamp: 100,
    request: { url: 'https://app.example.com/api/save', method: 'POST', headers: {}, ...request },
  })
  onEvent!(source, 'Network.responseReceived', {
    requestId, response: { status: 200, headers: {}, mimeType: 'application/json' },
  })
  onEvent!(source, 'Network.loadingFinished', { requestId, timestamp: 100.5 })
  const start = Date.now()
  while (Date.now() - start < 1000) {
    const ev = pushed.find(m => m.type === 'capture_event' && m.kind === 'network')
    if (ev) return ev.data
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('network event never finalized')
}

beforeEach(() => {
  pushed.length = 0
  sent.length = 0
  postDataImpl = async () => ({})
})

describe('capture request bodies for POSTs', () => {
  test('records request.postData as-is when Chrome supplies it', async () => {
    const ev = await capturePost({ postData: '{"a":1}', hasPostData: true })
    expect(ev.requestBody).toBe('{"a":1}')
    expect(postCalls()).toHaveLength(0)
  })

  test('does not fetch a body when the request has no post data', async () => {
    const ev = await capturePost({ method: 'GET' })
    expect(ev.requestBody).toBeNull()
    expect(postCalls()).toHaveLength(0)
  })

  test('recovers the body from postDataEntries by base64-decoding and concatenating', async () => {
    const ev = await capturePost({
      hasPostData: true,
      postDataEntries: [{ bytes: b64('{"name":"Zoë",') }, { bytes: b64('"n":2}') }],
    })
    expect(ev.requestBody).toBe('{"name":"Zoë","n":2}')
    expect(postCalls()).toHaveLength(0)
  })

  test('decodes non-UTF-8 postDataEntries lossily (U+FFFD) instead of dropping the event', async () => {
    const ev = await capturePost({
      hasPostData: true,
      postDataEntries: [{ bytes: Buffer.from([0x61, 0xff, 0x62]).toString('base64') }],
    })
    expect(ev.requestBody).toBe('a\uFFFDb')
    expect(ev.status).toBe(200)
  })

  test('falls back to Network.getRequestPostData when hasPostData is set without postData or entries', async () => {
    // Delay so loadingFinished arrives first; finalize must wait for the body.
    postDataImpl = async () => { await new Promise(r => setTimeout(r, 25)); return { postData: '{"q":"x"}' } }
    const ev = await capturePost({ hasPostData: true })
    expect(ev.requestBody).toBe('{"q":"x"}')
    expect(postCalls()).toHaveLength(1)
    expect(postCalls()[0].params).toEqual({ requestId: 'req-1' })
    expect(postCalls()[0].debuggee).toEqual({ tabId: 7 })
  })

  test('falls back to getRequestPostData when postDataEntries is empty', async () => {
    postDataImpl = async () => ({ postData: 'from-cdp' })
    const ev = await capturePost({ hasPostData: true, postDataEntries: [] })
    expect(ev.requestBody).toBe('from-cdp')
  })

  test('sends getRequestPostData on the same session as the event source', async () => {
    postDataImpl = async () => ({ postData: 'iframe-body' })
    const ev = await capturePost({ hasPostData: true }, { tabId: 7, sessionId: 'sess-abc' })
    expect(ev.requestBody).toBe('iframe-body')
    expect(postCalls()[0].debuggee).toEqual({ tabId: 7, sessionId: 'sess-abc' })
  })

  test('still finalizes the event with a null body when getRequestPostData rejects', async () => {
    postDataImpl = async () => { throw new Error('No resource with given identifier found') }
    const ev = await capturePost({ hasPostData: true })
    expect(ev.requestBody).toBeNull()
    expect(ev.status).toBe(200)
    expect(ev.responseBody).toBe('{"ok":true}')
  })

  test('still finalizes the event when getRequestPostData throws synchronously', async () => {
    postDataImpl = () => { throw new Error('boom') }
    const ev = await capturePost({ hasPostData: true })
    expect(ev.requestBody).toBeNull()
    expect(ev.status).toBe(200)
  })

  test('a redirect entry waits for the recovered body and never carries _bodyRecovery', async () => {
    postDataImpl = async () => { await new Promise(r => setTimeout(r, 25)); return { postData: 'redirected-body' } }
    await executeCommand({ action: 'startCapture' } as any)
    const source = { tabId: 7 }
    const base = { requestId: 'req-1', type: 'XHR', timestamp: 100 }
    onEvent!(source, 'Network.requestWillBeSent', {
      ...base, request: { url: 'https://app.example.com/a', method: 'POST', headers: {}, hasPostData: true },
    })
    onEvent!(source, 'Network.requestWillBeSent', {
      ...base, timestamp: 100.1,
      request: { url: 'https://app.example.com/b', method: 'GET', headers: {} },
      redirectResponse: { status: 302, headers: {}, mimeType: 'text/html' },
    })
    const start = Date.now()
    while (!pushed.some(m => m.kind === 'network') && Date.now() - start < 1000) await new Promise(r => setTimeout(r, 5))
    const ev = pushed.find(m => m.kind === 'network').data
    expect(ev.redirectedTo).toBe('https://app.example.com/b')
    expect(ev.requestBody).toBe('redirected-body')
    expect('_bodyRecovery' in ev).toBe(false)
  })

  describe('stopping while a body lookup is in flight', () => {
    async function startAndSendPost() {
      await executeCommand({ action: 'startCapture' } as any)
      const source = { tabId: 7 }
      onEvent!(source, 'Network.requestWillBeSent', {
        requestId: 'req-1', type: 'XHR', timestamp: 100,
        request: { url: 'https://app.example.com/api/save', method: 'POST', headers: {}, hasPostData: true },
      })
      onEvent!(source, 'Network.responseReceived', {
        requestId: 'req-1', response: { status: 200, headers: {}, mimeType: 'application/json' },
      })
      onEvent!(source, 'Network.loadingFinished', { requestId: 'req-1', timestamp: 100.5 })
      await new Promise(r => setTimeout(r, 10)) // entry is finalized, now waiting on the lookup
    }
    const doneIndex = () => pushed.findIndex(m => m.type === 'capture_done')
    const networkIndex = () => pushed.findIndex(m => m.kind === 'network')

    test('pushes the finished entry, with its body, before capture_done', async () => {
      postDataImpl = async () => { await new Promise(r => setTimeout(r, 60)); return { postData: '{"late":true}' } }
      await startAndSendPost()
      expect(pushed.some(m => m.kind === 'network')).toBe(false) // still waiting on the lookup
      await executeCommand({ action: 'stopCapture' } as any)
      expect(networkIndex()).toBeGreaterThanOrEqual(0)
      expect(networkIndex()).toBeLessThan(doneIndex())
      expect(pushed[networkIndex()].data.requestBody).toBe('{"late":true}')
    })

    test('stop stays bounded when the lookup hangs, and the stale entry never reaches a newer capture', async () => {
      postDataImpl = () => new Promise(r => setTimeout(() => r({ postData: 'too-late' }), 900))
      await startAndSendPost()
      const t0 = Date.now()
      await executeCommand({ action: 'stopCapture' } as any)
      expect(Date.now() - t0).toBeLessThan(800)
      expect(doneIndex()).toBeGreaterThanOrEqual(0)
      await executeCommand({ action: 'startCapture' } as any) // a newer capture begins
      await new Promise(r => setTimeout(r, 500)) // the old lookup now settles
      expect(pushed.some(m => m.kind === 'network')).toBe(false)
      await executeCommand({ action: 'stopCapture' } as any)
    })
  })
})
