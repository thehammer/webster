import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { buildHar, writeHarToSession } from '../har.js'
import { CaptureSession, type CaptureEvent } from '../capture.js'

describe('buildHar', () => {
  test('empty event list returns valid HAR with Webster creator and no entries', () => {
    const har = buildHar([])
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('Webster')
    expect(har.log.entries).toEqual([])
    expect(har.log.pages).toHaveLength(1)
  })

  test('uses supplied creator version', () => {
    const har = buildHar([], '9.9.9')
    expect(har.log.creator.version).toBe('9.9.9')
  })

  test('network event becomes a single HAR entry with method, url, and status', () => {
    const events: CaptureEvent[] = [{
      kind: 'network',
      timestamp: Date.parse('2026-04-21T10:00:00Z'),
      url: 'https://api.example.com/users?page=2',
      method: 'GET',
      status: 200,
      duration: 42,
      requestHeaders: { Accept: 'application/json', 'X-Custom': 'val' },
      responseHeaders: { 'Content-Type': 'application/json' },
      responseBody: '{"ok":true}',
      mimeType: 'application/json',
    }]

    const har = buildHar(events)
    expect(har.log.entries).toHaveLength(1)

    const [entry] = har.log.entries
    expect(entry.request.method).toBe('GET')
    expect(entry.request.url).toBe('https://api.example.com/users?page=2')
    expect(entry.response.status).toBe(200)
    expect(entry.time).toBe(42)

    // Request headers are serialized as name/value pairs
    const acceptHeader = entry.request.headers.find(h => h.name === 'Accept')
    expect(acceptHeader?.value).toBe('application/json')

    // Query string is parsed out
    expect(entry.request.queryString).toEqual([{ name: 'page', value: '2' }])

    // Response body flows into content.text
    expect(entry.response.content.text).toBe('{"ok":true}')
    expect(entry.response.content.mimeType).toBe('application/json')
  })

  test('request body with Content-Type populates postData.text and mimeType', () => {
    const events: CaptureEvent[] = [{
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/login',
      method: 'POST',
      status: 200,
      requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      requestBody: 'u=alice&p=hunter2',
    }]

    const har = buildHar(events)
    const [entry] = har.log.entries
    expect(entry.request.postData).toBeDefined()
    expect(entry.request.postData!.mimeType).toBe('application/x-www-form-urlencoded')
    expect(entry.request.postData!.text).toBe('u=alice&p=hunter2')
    expect(entry.request.bodySize).toBe('u=alice&p=hunter2'.length)
  })

  test('request body with no Content-Type header defaults mimeType to application/octet-stream', () => {
    const events: CaptureEvent[] = [{
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/blob',
      method: 'POST',
      status: 200,
      requestBody: 'raw body without headers',
    }]

    const har = buildHar(events)
    const [entry] = har.log.entries
    expect(entry.request.postData).toBeDefined()
    expect(entry.request.postData!.mimeType).toBe('application/octet-stream')
  })

  test('websocket frame events are attached as _webSocketMessages on matching entry', () => {
    const wsUrl = 'wss://chat.example.com/socket'
    const events: CaptureEvent[] = [
      {
        kind: 'network',
        timestamp: 1000,
        url: wsUrl,
        method: 'GET',
        status: 101,
        requestHeaders: { Upgrade: 'websocket' },
      },
      {
        kind: 'websocket',
        subKind: 'frame',
        timestamp: 1010,
        url: wsUrl,
        direction: 'send',
        opcode: 1,
        payload: 'hello server',
      },
      {
        kind: 'websocket',
        subKind: 'frame',
        timestamp: 1020,
        url: wsUrl,
        direction: 'receive',
        opcode: 1,
        payload: 'hello client',
      },
      {
        // Non-frame websocket events must not be attached
        kind: 'websocket',
        subKind: 'open',
        timestamp: 1005,
        url: wsUrl,
      },
    ]

    const har = buildHar(events)
    expect(har.log.entries).toHaveLength(1)

    const [entry] = har.log.entries
    expect(entry._webSocketMessages).toBeDefined()
    expect(entry._webSocketMessages).toHaveLength(2)

    expect(entry._webSocketMessages![0]).toMatchObject({
      type: 'send',
      time: 1010,
      opcode: 1,
      data: 'hello server',
    })
    expect(entry._webSocketMessages![1]).toMatchObject({
      type: 'receive',
      time: 1020,
      data: 'hello client',
    })
  })

  test('websocket frames without matching network entry are dropped', () => {
    const events: CaptureEvent[] = [{
      kind: 'websocket',
      subKind: 'frame',
      timestamp: 1,
      url: 'wss://orphan.example.com',
      direction: 'send',
      payload: 'lonely',
    }]
    const har = buildHar(events)
    expect(har.log.entries).toEqual([])
  })

  test('non-network events are filtered out', () => {
    const events: CaptureEvent[] = [
      { kind: 'console', timestamp: 1, level: 'log', text: 'hi' },
      { kind: 'input', timestamp: 2, type: 'click' },
      { kind: 'page', timestamp: 3, url: 'https://example.com', title: 't' },
    ]
    const har = buildHar(events)
    expect(har.log.entries).toEqual([])
  })
})

describe('writeHarToSession', () => {
  let session: CaptureSession

  beforeEach(() => {
    session = new CaptureSession(`har-${Date.now()}`, {})
  })

  afterEach(() => {
    session.cleanup()
  })

  test('writes session.har to the session directory and returns its path', () => {
    session.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/x',
      method: 'GET',
      status: 200,
    })
    const events = session.readEvents()

    const outPath = writeHarToSession(session.dir, events)
    expect(outPath).toBe(`${session.dir}/session.har`)
    expect(existsSync(outPath)).toBe(true)

    const parsed = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed.log.version).toBe('1.2')
    expect(parsed.log.creator.name).toBe('Webster')
    expect(parsed.log.entries).toHaveLength(1)
    expect(parsed.log.entries[0].request.url).toBe('https://example.com/x')
  })

  test('produces valid JSON even with zero events', () => {
    const outPath = writeHarToSession(session.dir, [])
    const parsed = JSON.parse(readFileSync(outPath, 'utf-8'))
    expect(parsed.log.entries).toEqual([])
  })
})
