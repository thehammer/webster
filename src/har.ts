import { writeFileSync } from 'fs'
import { join } from 'path'
import type { CaptureEvent } from './capture.js'

// HAR 1.2 subset. Only the fields that are meaningful from a captured session.
// See https://w3c.github.io/web-performance/specs/HAR/Overview.html

interface HarNameValue { name: string; value: string }

interface HarRequest {
  method: string
  url: string
  httpVersion: string
  cookies: HarNameValue[]
  headers: HarNameValue[]
  queryString: HarNameValue[]
  postData?: { mimeType: string; text: string }
  headersSize: number
  bodySize: number
}

interface HarResponse {
  status: number
  statusText: string
  httpVersion: string
  cookies: HarNameValue[]
  headers: HarNameValue[]
  content: { size: number; mimeType: string; text?: string; encoding?: string }
  redirectURL: string
  headersSize: number
  bodySize: number
}

interface HarEntry {
  startedDateTime: string
  time: number
  request: HarRequest
  response: HarResponse
  cache: Record<string, unknown>
  timings: { send: number; wait: number; receive: number }
  serverIPAddress?: string
  _webSocketMessages?: Array<{ type: 'send' | 'receive'; time: number; opcode?: number; data: string }>
  _tabId?: number
  _error?: string
}

export interface Har {
  log: {
    version: '1.2'
    creator: { name: 'Webster'; version: string }
    pages: Array<{ startedDateTime: string; id: string; title: string; pageTimings: Record<string, number> }>
    entries: HarEntry[]
  }
}

function headersToHar(obj: unknown): HarNameValue[] {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj as Record<string, unknown>).map(([name, value]) => ({
    name,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }))
}

function extractQueryString(rawUrl: string): HarNameValue[] {
  try {
    const u = new URL(rawUrl)
    return [...u.searchParams.entries()].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

function networkToEntry(event: CaptureEvent): HarEntry {
  const url = typeof event.url === 'string' ? event.url : ''
  const method = typeof event.method === 'string' ? event.method : 'GET'
  const status = typeof event.status === 'number' ? event.status : 0
  const mime = typeof event.mimeType === 'string' ? event.mimeType : ''
  const duration = typeof event.duration === 'number' ? event.duration : 0
  const timestamp = typeof event.timestamp === 'number' ? event.timestamp : Date.now()

  const reqHeaders = headersToHar(event.requestHeaders)
  const resHeaders = headersToHar(event.responseHeaders)

  let postData: { mimeType: string; text: string } | undefined
  if (typeof event.requestBody === 'string' && event.requestBody.length > 0) {
    const reqMime = reqHeaders.find(h => h.name.toLowerCase() === 'content-type')?.value ?? 'application/octet-stream'
    postData = { mimeType: reqMime, text: event.requestBody }
  }

  const bodyText = typeof event.responseBody === 'string' ? event.responseBody : ''
  const encoding = event.responseBodyEncoding === 'base64' ? 'base64' : undefined

  return {
    startedDateTime: new Date(timestamp).toISOString(),
    time: duration,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: reqHeaders,
      queryString: extractQueryString(url),
      postData,
      headersSize: -1,
      bodySize: postData ? postData.text.length : -1,
    },
    response: {
      status,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: resHeaders,
      content: {
        size: typeof event.responseBodySize === 'number' ? event.responseBodySize : bodyText.length,
        mimeType: mime,
        text: bodyText || undefined,
        encoding,
      },
      redirectURL: typeof event.redirectedTo === 'string' ? event.redirectedTo : '',
      headersSize: -1,
      bodySize: bodyText.length,
    },
    cache: {},
    timings: { send: 0, wait: duration, receive: 0 },
    _tabId: typeof event.tabId === 'number' ? event.tabId : undefined,
    _error: typeof event.error === 'string' ? event.error : undefined,
  }
}

/**
 * Merge websocket frames into the entry for their opening HTTP request.
 * HAR 1.2 has no spec for WS frames; DevTools Network panel uses
 * `_webSocketMessages` (underscore-prefixed = custom extension).
 */
function attachWebSocketFrames(entries: HarEntry[], events: CaptureEvent[]): void {
  const byUrl = new Map<string, HarEntry>()
  for (const e of entries) {
    if (e.response.status === 101 || /^wss?:/.test(e.request.url)) {
      byUrl.set(e.request.url, e)
    }
  }
  for (const ev of events) {
    if (ev.kind !== 'websocket') continue
    if (ev.subKind !== 'frame') continue
    const url = typeof ev.url === 'string' ? ev.url : ''
    const entry = byUrl.get(url)
    if (!entry) continue
    entry._webSocketMessages ??= []
    entry._webSocketMessages.push({
      type: ev.direction === 'send' ? 'send' : 'receive',
      time: typeof ev.timestamp === 'number' ? ev.timestamp : Date.now(),
      opcode: typeof ev.opcode === 'number' ? ev.opcode : undefined,
      data: typeof ev.payload === 'string' ? ev.payload : '',
    })
  }
}

export function buildHar(events: CaptureEvent[], creatorVersion = '0.1.0'): Har {
  const networkEntries = events.filter(e => e.kind === 'network').map(networkToEntry)
  attachWebSocketFrames(networkEntries, events)

  const firstTs = events.length ? (events[0].timestamp ?? Date.now()) : Date.now()
  return {
    log: {
      version: '1.2',
      creator: { name: 'Webster', version: creatorVersion },
      pages: [{
        startedDateTime: new Date(firstTs).toISOString(),
        id: 'webster-session',
        title: 'Webster capture',
        pageTimings: {},
      }],
      entries: networkEntries,
    },
  }
}

export function writeHarToSession(sessionDir: string, events: CaptureEvent[], creatorVersion?: string): string {
  const har = buildHar(events, creatorVersion)
  const out = join(sessionDir, 'session.har')
  writeFileSync(out, JSON.stringify(har, null, 2))
  return out
}
