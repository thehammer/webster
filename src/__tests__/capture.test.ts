import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { CaptureSession, cleanOldSessions, type CaptureEvent } from '../capture.js'

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
    session.appendFrame(Buffer.from([0xFF]))

    const snap = session.getSnapshot()
    expect(snap.sessionId).toBe(session.id)
    expect(snap.active).toBe(true)
    expect(snap.eventCount).toBe(4)
    expect(snap.frameCount).toBe(1)
    expect(snap.breakdown).toEqual({ network: 3, input: 1 })
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
