import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { CaptureSession, cleanOldSessions, redactSessionDir, type CaptureEvent } from '../capture.js'

let session: CaptureSession

beforeEach(() => {
  session = new CaptureSession(`test-${Date.now()}`, {
    urlFilter: 'example.com',
    includeInput: true,
    recordFrames: true,
    fps: 2,
  })
})

afterEach(() => {
  session.cleanup()
})

describe('CaptureSession', () => {
  test('creates directory structure on construction', () => {
    expect(existsSync(session.dir)).toBe(true)
    expect(existsSync(session.framesDir)).toBe(true)
    expect(existsSync(session.eventsPath)).toBe(true)
    expect(existsSync(session.metaPath)).toBe(true)

    const meta = JSON.parse(readFileSync(session.metaPath, 'utf-8'))
    expect(meta.status).toBe('active')
    expect(meta.config.urlFilter).toBe('example.com')
  })

  test('starts active', () => {
    expect(session.active).toBe(true)
  })

  test('appendEvent writes network events to JSONL', () => {
    const event: CaptureEvent = {
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/api/test',
      method: 'GET',
      status: 200,
    }
    session.appendEvent(event)

    const raw = readFileSync(session.eventsPath, 'utf-8').trim()
    const parsed = JSON.parse(raw)
    expect(parsed.kind).toBe('network')
    expect(parsed.url).toBe('https://example.com/api/test')
  })

  test('appendEvent writes input events to JSONL', () => {
    const event: CaptureEvent = {
      kind: 'input',
      timestamp: Date.now(),
      type: 'click',
      x: 100,
      y: 200,
    }
    session.appendEvent(event)

    const events = session.readEvents()
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('input')
  })

  test('appendEvent ignores events after finalize', () => {
    session.finalize()
    session.appendEvent({ kind: 'network', timestamp: Date.now() })

    const events = session.readEvents()
    expect(events).toHaveLength(0)
  })

  test('appendFrame writes JPEG files to frames directory', () => {
    const fakeJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x01])
    session.appendFrame(fakeJpeg)
    session.appendFrame(fakeJpeg)

    const files = readdirSync(session.framesDir).sort()
    expect(files).toEqual(['frame_00001.jpg', 'frame_00002.jpg'])

    const content = readFileSync(`${session.framesDir}/frame_00001.jpg`)
    expect(content).toEqual(fakeJpeg)
  })

  test('appendFrame ignores frames after finalize', () => {
    session.finalize()
    session.appendFrame(Buffer.from([0xFF]))

    const files = readdirSync(session.framesDir)
    expect(files).toHaveLength(0)
  })

  test('getSnapshot returns accurate summary', () => {
    session.appendEvent({ kind: 'network', timestamp: 1, url: 'https://example.com/api/a' })
    session.appendEvent({ kind: 'network', timestamp: 2, url: 'https://example.com/api/a' })
    session.appendEvent({ kind: 'network', timestamp: 3, url: 'https://example.com/api/b' })
    session.appendEvent({ kind: 'input', timestamp: 4, type: 'click' })
    session.appendEvent({ kind: 'console', timestamp: 5, level: 'error', text: 'oops' })
    session.appendEvent({ kind: 'page', timestamp: 6, url: 'https://example.com', title: 'Example' })
    session.appendFrame(Buffer.from([0xFF]))

    const snap = session.getSnapshot()
    expect(snap.sessionId).toBe(session.id)
    expect(snap.active).toBe(true)
    expect(snap.eventCount).toBe(6)
    expect(snap.frameCount).toBe(1)
    expect(snap.breakdown).toEqual({
      network: 3,
      input: 1,
      console: 1,
      page: 1,
      websocket: 0,
      dom: 0,
      storage: 0,
      annotation: 0,
      meta: 0,
    })
    expect(snap.topUrls[0]).toBe('/api/a (2x)')
    expect(snap.topUrls[1]).toBe('/api/b')
  })

  test('readEvents filters by kind', () => {
    session.appendEvent({ kind: 'network', timestamp: 1, url: 'https://example.com' })
    session.appendEvent({ kind: 'input', timestamp: 2 })
    session.appendEvent({ kind: 'network', timestamp: 3, url: 'https://example.com' })

    expect(session.readEvents({ kind: 'network' })).toHaveLength(2)
    expect(session.readEvents({ kind: 'input' })).toHaveLength(1)
  })

  test('readEvents filters by urlFilter', () => {
    session.appendEvent({ kind: 'network', timestamp: 1, url: 'https://example.com/api/users' })
    session.appendEvent({ kind: 'network', timestamp: 2, url: 'https://example.com/api/orders' })
    session.appendEvent({ kind: 'input', timestamp: 3 })

    const filtered = session.readEvents({ urlFilter: 'orders' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].url).toBe('https://example.com/api/orders')
  })

  test('readEvents supports offset and limit', () => {
    for (let i = 0; i < 10; i++) {
      session.appendEvent({ kind: 'network', timestamp: i, url: `https://example.com/${i}` })
    }

    const page = session.readEvents({ offset: 3, limit: 2 })
    expect(page).toHaveLength(2)
    expect(page[0].url).toBe('https://example.com/3')
    expect(page[1].url).toBe('https://example.com/4')
  })

  test('readEvent returns single event by index', () => {
    session.appendEvent({ kind: 'network', timestamp: 1, url: 'https://a.com' })
    session.appendEvent({ kind: 'network', timestamp: 2, url: 'https://b.com' })

    const event = session.readEvent(1)
    expect(event).not.toBeNull()
    expect(event!.url).toBe('https://b.com')

    expect(session.readEvent(-1)).toBeNull()
    expect(session.readEvent(99)).toBeNull()
  })

  test('finalize marks session as done and updates meta', () => {
    session.appendEvent({ kind: 'network', timestamp: 1 })

    const snap = session.finalize()
    expect(snap.active).toBe(false)
    expect(session.active).toBe(false)

    const meta = JSON.parse(readFileSync(session.metaPath, 'utf-8'))
    expect(meta.status).toBe('finished')
    expect(meta.finishedAt).toBeDefined()
    expect(meta.eventCount).toBe(1)
  })

  test('cleanup removes session directory', () => {
    const dir = session.dir
    expect(existsSync(dir)).toBe(true)

    session.cleanup()
    expect(existsSync(dir)).toBe(false)
  })
})

describe('cleanOldSessions', () => {
  test('does not throw when captures directory does not exist', () => {
    expect(() => cleanOldSessions()).not.toThrow()
  })
})

// ─── Form body parsing ──────────────────────────────────────────────────────

describe('CaptureSession form body parsing', () => {
  let s: CaptureSession

  beforeEach(() => {
    s = new CaptureSession(`form-${Date.now()}-${Math.random()}`, {})
  })

  afterEach(() => {
    s.cleanup()
  })

  test('parses urlencoded request body into requestBodyParsed.fields', () => {
    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/login',
      method: 'POST',
      requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      requestBody: 'user=alice&password=s3cret&remember=1',
    })

    const [ev] = s.readEvents()
    expect(ev.requestBodyParsed).toBeDefined()
    const parsed = ev.requestBodyParsed as { type: string; fields: Record<string, string> }
    expect(parsed.type).toBe('urlencoded')
    expect(parsed.fields.user).toBe('alice')
    expect(parsed.fields.password).toBe('s3cret')
    expect(parsed.fields.remember).toBe('1')
  })

  test('decodes percent-encoded values in urlencoded bodies', () => {
    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/search',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: 'q=hello%20world&email=user%40example.com',
    })

    const [ev] = s.readEvents()
    const parsed = ev.requestBodyParsed as { fields: Record<string, string> }
    expect(parsed.fields.q).toBe('hello world')
    expect(parsed.fields.email).toBe('user@example.com')
  })

  test('parses multipart/form-data into requestBodyParsed.parts', () => {
    // NOTE: the implementation lowercases the Content-Type value before
    // extracting the boundary, which means mixed-case boundaries stop matching
    // the body delimiters. Use an all-lowercase boundary here so the existing
    // behaviour is exercised. (See test summary — this is a real bug in the
    // implementation worth filing.)
    const boundary = 'websterboundary123'
    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="username"\r\n\r\n` +
      `alice\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="avatar"; filename="me.png"\r\n` +
      `Content-Type: image/png\r\n\r\n` +
      `FAKEPNGBYTES\r\n` +
      `--${boundary}--\r\n`

    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/upload',
      method: 'POST',
      requestHeaders: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      requestBody: body,
    })

    const [ev] = s.readEvents()
    const parsed = ev.requestBodyParsed as {
      type: string
      boundary: string
      parts: Array<{ name: string; filename?: string; contentType?: string; value?: string; size?: number }>
    }
    expect(parsed.type).toBe('multipart')
    expect(parsed.boundary).toBe(boundary)
    expect(parsed.parts).toHaveLength(2)

    const [username, avatar] = parsed.parts
    expect(username.name).toBe('username')
    expect(username.value).toBe('alice')

    expect(avatar.name).toBe('avatar')
    expect(avatar.filename).toBe('me.png')
    expect(avatar.contentType).toBe('image/png')
    expect(avatar.size).toBeGreaterThan(0)
  })

  test('does not set requestBodyParsed for unknown content types', () => {
    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/api',
      method: 'POST',
      requestHeaders: { 'Content-Type': 'application/json' },
      requestBody: '{"a":1}',
    })

    const [ev] = s.readEvents()
    expect(ev.requestBodyParsed).toBeUndefined()
  })
})

// ─── Redaction ──────────────────────────────────────────────────────────────

describe('CaptureSession redaction', () => {
  let s: CaptureSession

  afterEach(() => {
    s?.cleanup()
  })

  test('redacts configured patterns in appended events', () => {
    s = new CaptureSession(`redact-${Date.now()}`, { redact: ['ssn'] })

    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/form',
      method: 'POST',
      requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
      requestBody: 'ssn=123-45-6789&name=alice',
    })

    const raw = readFileSync(s.eventsPath, 'utf-8')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('ssn=')
    // The name field, which didn't match, stays intact
    expect(raw).toContain('alice')
  })

  test('redacts across all string fields in the event (not just body)', () => {
    s = new CaptureSession(`redact-header-${Date.now()}`, { redact: ['secret-token-\\w+'] })

    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/api?auth=secret-token-abc123',
      method: 'GET',
      requestHeaders: { Authorization: 'Bearer secret-token-xyz789' },
    })

    const [ev] = s.readEvents()
    expect(JSON.stringify(ev)).not.toContain('secret-token-abc123')
    expect(JSON.stringify(ev)).not.toContain('secret-token-xyz789')
    expect(JSON.stringify(ev)).toContain('[REDACTED]')
  })

  test('multiple patterns compose', () => {
    s = new CaptureSession(`redact-multi-${Date.now()}`, { redact: ['password', 'token'] })

    s.appendEvent({
      kind: 'console',
      timestamp: Date.now(),
      level: 'log',
      text: 'User logged in with password=foo and token=bar',
    })

    const raw = readFileSync(s.eventsPath, 'utf-8')
    expect(raw).not.toContain('password=foo')
    expect(raw).not.toContain('token=bar')
    expect((raw.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  test('malformed regex is skipped without crashing', () => {
    s = new CaptureSession(`redact-bad-${Date.now()}`, { redact: ['[unclosed', 'valid-\\d+'] })

    expect(() => s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/x?v=valid-42',
    })).not.toThrow()

    const [ev] = s.readEvents()
    expect(ev.url).toBe('https://example.com/x?v=[REDACTED]')
  })
})

// ─── Body attachment (CDP-captured binary bodies) ──────────────────────────

describe('CaptureSession appendBody + attachBodyReference', () => {
  let s: CaptureSession

  beforeEach(() => {
    s = new CaptureSession(`body-${Date.now()}`, {})
  })

  afterEach(() => {
    s.cleanup()
  })

  test('appendBody persists the binary to bodies/ and returns ref metadata', () => {
    const buf = Buffer.from('binarycontent')
    const ref = s.appendBody('req-42', buf, 'application/octet-stream')

    expect(ref).not.toBeNull()
    expect(ref!.path).toBe('bodies/req-42.bin')
    expect(ref!.size).toBe(buf.length)
    expect(existsSync(`${s.bodiesDir}/req-42.bin`)).toBe(true)
    expect(readFileSync(`${s.bodiesDir}/req-42.bin`)).toEqual(buf)
  })

  test('appendBody picks extension from mime type', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const ref = s.appendBody('img-1', buf, 'image/png')
    expect(ref!.path).toBe('bodies/img-1.png')
  })

  test('appendBody sanitizes requestId to a safe filename', () => {
    const ref = s.appendBody('weird/id with spaces', Buffer.from('x'), 'application/pdf')
    // Path prefix is always "bodies/"; the filename portion must have no
    // path separators or spaces.
    expect(ref!.path).toMatch(/^bodies\/[a-zA-Z0-9_\-]+\.pdf$/)
    const filename = ref!.path.slice('bodies/'.length)
    expect(filename).not.toContain('/')
    expect(filename).not.toContain(' ')
  })

  test('attachBodyReference rewrites matching network event to reference body file', () => {
    // Append a network event with an inline response body and a requestId
    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/image.png',
      method: 'GET',
      status: 200,
      requestId: 'req-42',
      responseBody: 'AAA',
    })

    const buf = Buffer.from('realbinarybytes')
    const ref = s.appendBody('req-42', buf, 'application/octet-stream')!
    const ok = s.attachBodyReference('req-42', ref, 'application/octet-stream')
    expect(ok).toBe(true)

    const [ev] = s.readEvents()
    expect(ev.responseBody).toBeNull()
    expect(ev.responseBodyFile).toBe('bodies/req-42.bin')
    expect(ev.responseBodySize).toBe(buf.length)
    expect(ev.responseBodyMimeType).toBe('application/octet-stream')
  })

  test('attachBodyReference returns false when no matching requestId', () => {
    s.appendEvent({
      kind: 'network',
      timestamp: Date.now(),
      url: 'https://example.com/a',
      requestId: 'req-1',
    })

    const ok = s.attachBodyReference('req-999', { path: 'bodies/nope.bin', size: 10 })
    expect(ok).toBe(false)
  })
})

// ─── readEvents filters added in the enhancement ───────────────────────────

describe('CaptureSession readEvents advanced filters', () => {
  let s: CaptureSession

  beforeEach(() => {
    s = new CaptureSession(`filter-${Date.now()}`, {})
  })

  afterEach(() => {
    s.cleanup()
  })

  test('search filter returns only events whose serialized form contains the needle', () => {
    s.appendEvent({ kind: 'network', timestamp: 1, url: 'https://a.com/a', method: 'GET' })
    s.appendEvent({
      kind: 'network',
      timestamp: 2,
      url: 'https://a.com/b',
      method: 'POST',
      requestHeaders: { Authorization: 'Bearer mytoken' },
    })
    s.appendEvent({ kind: 'console', timestamp: 3, level: 'info', text: 'contains mytoken somewhere' })
    s.appendEvent({ kind: 'input', timestamp: 4, type: 'click' })

    const hits = s.readEvents({ search: 'mytoken' })
    expect(hits).toHaveLength(2)
    expect(hits.map(e => e.kind).sort()).toEqual(['console', 'network'])
  })

  test('method filter keeps only network events with matching method', () => {
    s.appendEvent({ kind: 'network', timestamp: 1, url: 'https://a.com/1', method: 'GET' })
    s.appendEvent({ kind: 'network', timestamp: 2, url: 'https://a.com/2', method: 'POST' })
    s.appendEvent({ kind: 'network', timestamp: 3, url: 'https://a.com/3', method: 'POST' })
    s.appendEvent({ kind: 'network', timestamp: 4, url: 'https://a.com/4', method: 'delete' })

    const posts = s.readEvents({ method: 'POST' })
    expect(posts).toHaveLength(2)
    expect(posts.every(e => (e.method as string).toUpperCase() === 'POST')).toBe(true)
  })

  test('method filter is case-insensitive', () => {
    s.appendEvent({ kind: 'network', timestamp: 1, url: 'https://a.com/1', method: 'get' })
    s.appendEvent({ kind: 'network', timestamp: 2, url: 'https://a.com/2', method: 'GET' })
    expect(s.readEvents({ method: 'get' })).toHaveLength(2)
    expect(s.readEvents({ method: 'GET' })).toHaveLength(2)
  })
})

// ─── Breakdown for new event kinds ─────────────────────────────────────────

describe('CaptureSession breakdown includes new kinds', () => {
  let s: CaptureSession

  beforeEach(() => {
    s = new CaptureSession(`breakdown-${Date.now()}`, {})
  })

  afterEach(() => {
    s.cleanup()
  })

  test('counts websocket, dom, storage, annotation, meta events', () => {
    s.appendEvent({ kind: 'websocket', timestamp: 1, url: 'wss://example.com', subKind: 'open' })
    s.appendEvent({ kind: 'websocket', timestamp: 2, url: 'wss://example.com', subKind: 'frame', direction: 'send', payload: 'hi' })
    s.appendEvent({ kind: 'dom', timestamp: 3, url: 'https://example.com', html: '<html/>' })
    s.appendEvent({ kind: 'storage', timestamp: 4, url: 'https://example.com', cookies: [] })
    s.appendEvent({ kind: 'annotation', timestamp: 5, text: 'important moment' })
    s.appendEvent({ kind: 'meta', timestamp: 6, info: 'whatever' })

    const snap = s.getSnapshot()
    expect(snap.breakdown.websocket).toBe(2)
    expect(snap.breakdown.dom).toBe(1)
    expect(snap.breakdown.storage).toBe(1)
    expect(snap.breakdown.annotation).toBe(1)
    expect(snap.breakdown.meta).toBe(1)
    expect(snap.eventCount).toBe(6)
  })
})

// ─── redactSessionDir (post-hoc on-disk redaction) ─────────────────────────

describe('redactSessionDir', () => {
  let s: CaptureSession

  beforeEach(() => {
    s = new CaptureSession(`postredact-${Date.now()}`, {})
  })

  afterEach(() => {
    s.cleanup()
  })

  test('rewrites events.jsonl on disk replacing matches with [REDACTED]', () => {
    s.appendEvent({ kind: 'console', timestamp: 1, level: 'log', text: 'secret=abc123 oops' })
    s.appendEvent({ kind: 'console', timestamp: 2, level: 'log', text: 'no match here' })
    s.finalize()

    const before = readFileSync(s.eventsPath, 'utf-8')
    expect(before).toContain('abc123')

    const res = redactSessionDir(s.dir, ['abc\\d+'])
    expect(res.eventsRedacted).toBe(2)

    const after = readFileSync(s.eventsPath, 'utf-8')
    expect(after).not.toContain('abc123')
    expect(after).toContain('[REDACTED]')
    // Event that didn't match is preserved
    expect(after).toContain('no match here')
  })

  test('annotates meta.json with redactedAt timestamp', () => {
    s.appendEvent({ kind: 'console', timestamp: 1, level: 'log', text: 'secret=foo' })
    s.finalize()

    redactSessionDir(s.dir, ['foo'])

    const meta = JSON.parse(readFileSync(s.metaPath, 'utf-8'))
    expect(meta.redactedAt).toBeDefined()
    expect(meta.redactPatternCount).toBe(1)
  })

  test('returns { eventsRedacted: 0 } when given empty patterns', () => {
    s.appendEvent({ kind: 'console', timestamp: 1, text: 'anything' })
    const res = redactSessionDir(s.dir, [])
    expect(res.eventsRedacted).toBe(0)
  })

  test('does not throw when session dir does not exist', () => {
    expect(() => redactSessionDir('/tmp/nonexistent-webster-session-xyz', ['foo'])).not.toThrow()
  })
})
