import { mkdirSync, rmSync, readdirSync, statSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { CaptureEventKind } from './protocol.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CaptureEvent {
  kind: CaptureEventKind
  timestamp: number
  [key: string]: unknown
}

export interface CaptureConfig {
  urlFilter?: string | null
  includeInput?: boolean
  recordFrames?: boolean
  fps?: number
  /** Max bytes stored inline for text response bodies. Default 512 000. */
  maxBodyBytes?: number
  /** When true, binary response bodies are fetched and written to bodies/ */
  captureBinaryBodies?: boolean
  /** Trigger for DOM snapshot capture. `false` disables, `true` means onNavigate. */
  recordDom?: boolean | 'onNavigate' | 'onInput' | 'periodic'
  /** When true, emits kind:'storage' events (cookies + localStorage) */
  recordStorage?: boolean
  /** Regex patterns (source strings) to replace with [REDACTED] in all text fields */
  redact?: string[]
}

export interface CaptureBreakdown {
  network: number
  input: number
  console: number
  page: number
  websocket: number
  dom: number
  storage: number
  annotation: number
  meta: number
}

export interface CaptureSnapshot {
  sessionId: string
  active: boolean
  duration: string
  eventCount: number
  frameCount: number
  breakdown: CaptureBreakdown
  topUrls: string[]
  config: CaptureConfig
  replayUrl: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CAPTURES_DIR = join(homedir(), '.webster', 'captures')
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours
const REDACTED = '[REDACTED]'

// MIME types where parsing the postData is useful for quick inspection.
const FORM_URLENCODED = 'application/x-www-form-urlencoded'
const MULTIPART_FORM = 'multipart/form-data'

// ─── Redaction ────────────────────────────────────────────────────────────────

function compilePatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns?.length) return []
  const out: RegExp[] = []
  for (const p of patterns) {
    if (typeof p !== 'string' || !p) continue
    try {
      // Every pattern is applied globally + case-insensitively by default
      out.push(new RegExp(p, 'gi'))
    } catch {
      // Skip malformed pattern — emit nothing rather than crash the capture
    }
  }
  return out
}

function redactString(value: string, regexes: RegExp[]): string {
  if (!regexes.length) return value
  let out = value
  for (const re of regexes) {
    // Reset lastIndex so sticky/global regexes don't skip matches on reuse
    re.lastIndex = 0
    out = out.replace(re, REDACTED)
  }
  return out
}

function redactObject(value: unknown, regexes: RegExp[], depth = 0): unknown {
  if (!regexes.length || depth > 8) return value
  if (typeof value === 'string') return redactString(value, regexes)
  if (Array.isArray(value)) return value.map(v => redactObject(v, regexes, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactObject(v, regexes, depth + 1)
    }
    return out
  }
  return value
}

export function redactEvent(event: CaptureEvent, patterns: string[]): CaptureEvent {
  const regexes = compilePatterns(patterns)
  if (!regexes.length) return event
  return redactObject(event, regexes) as CaptureEvent
}

// ─── Form body parsing ────────────────────────────────────────────────────────

export interface ParsedMultipartPart {
  name: string
  filename?: string
  contentType?: string
  value?: string
  size?: number
}

export type ParsedFormBody =
  | { type: 'urlencoded'; fields: Record<string, string | string[]> }
  | { type: 'multipart'; boundary: string; parts: ParsedMultipartPart[] }

function parseUrlEncoded(body: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const pair of body.split('&')) {
    if (!pair) continue
    const idx = pair.indexOf('=')
    const rawKey = idx >= 0 ? pair.slice(0, idx) : pair
    const rawVal = idx >= 0 ? pair.slice(idx + 1) : ''
    let key: string, val: string
    try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')) } catch { key = rawKey }
    try { val = decodeURIComponent(rawVal.replace(/\+/g, ' ')) } catch { val = rawVal }
    const existing = out[key]
    if (existing === undefined) {
      out[key] = val
    } else if (Array.isArray(existing)) {
      existing.push(val)
    } else {
      out[key] = [existing, val]
    }
  }
  return out
}

function parseMultipart(body: string, boundary: string): ParsedMultipartPart[] {
  const parts: ParsedMultipartPart[] = []
  const delimiter = `--${boundary}`
  const sections = body.split(delimiter)
  for (const raw of sections) {
    const section = raw.replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    if (!section || section === '--' || section === '--\r\n') continue
    const headerEnd = section.indexOf('\r\n\r\n')
    const splitPoint = headerEnd >= 0 ? headerEnd : section.indexOf('\n\n')
    if (splitPoint < 0) continue
    const headerBlock = section.slice(0, splitPoint)
    const value = section.slice(splitPoint + (headerEnd >= 0 ? 4 : 2))
    const part: ParsedMultipartPart = { name: '' }
    for (const line of headerBlock.split(/\r?\n/)) {
      const m = line.match(/^Content-Disposition:\s*form-data;\s*(.+)$/i)
      if (m) {
        const attrs = m[1]
        const nameMatch = attrs.match(/name="([^"]*)"/i)
        if (nameMatch) part.name = nameMatch[1]
        const fileMatch = attrs.match(/filename="([^"]*)"/i)
        if (fileMatch) part.filename = fileMatch[1]
      }
      const ct = line.match(/^Content-Type:\s*(.+)$/i)
      if (ct) part.contentType = ct[1].trim()
    }
    if (part.filename !== undefined) {
      part.size = value.length
    } else {
      part.value = value
    }
    parts.push(part)
  }
  return parts
}

function readContentTypeHeader(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === 'content-type' && typeof v === 'string') return v
  }
  return null
}

export function parseRequestBody(event: CaptureEvent): ParsedFormBody | null {
  if (event.kind !== 'network') return null
  const body = event.requestBody
  if (typeof body !== 'string' || body.length === 0) return null
  const ct = readContentTypeHeader(event.requestHeaders) ?? ''
  const lower = ct.toLowerCase()

  if (lower.includes(FORM_URLENCODED)) {
    return { type: 'urlencoded', fields: parseUrlEncoded(body) }
  }
  if (lower.includes(MULTIPART_FORM)) {
    // Match case-insensitively against the original header so the boundary
    // value preserves its case — browser-generated boundaries like
    // `----WebKitFormBoundaryABC123` only match the body delimiters when
    // stored in their original case.
    const m = ct.match(/boundary=("?)([^;"\r\n]+)\1/i)
    if (!m) return null
    const boundary = m[2]
    return { type: 'multipart', boundary, parts: parseMultipart(body, boundary) }
  }
  return null
}

// ─── Config parsing ───────────────────────────────────────────────────────────

/**
 * Build a CaptureConfig from a loosely-typed record (HTTP body or MCP tool
 * input). Unknown fields are ignored; type-mismatched fields fall back to
 * their defaults so a caller can't crash the server with bad input.
 */
export function parseCaptureConfig(input: Record<string, unknown>): CaptureConfig {
  return {
    urlFilter: (input.urlFilter as string) || null,
    includeInput: !!input.includeInput,
    recordFrames: !!input.recordFrames,
    fps: (input.fps as number) || 2,
    maxBodyBytes: typeof input.maxBodyBytes === 'number' ? input.maxBodyBytes : undefined,
    captureBinaryBodies: !!input.captureBinaryBodies,
    recordDom: input.recordDom as CaptureConfig['recordDom'],
    recordStorage: !!input.recordStorage,
    redact: Array.isArray(input.redact) ? input.redact as string[] : undefined,
  }
}

// ─── Session ──────────────────────────────────────────────────────────────────

const EMPTY_BREAKDOWN = (): CaptureBreakdown => ({
  network: 0, input: 0, console: 0, page: 0,
  websocket: 0, dom: 0, storage: 0, annotation: 0, meta: 0,
})

export class CaptureSession {
  readonly id: string
  readonly dir: string
  readonly framesDir: string
  readonly bodiesDir: string
  readonly eventsPath: string
  readonly metaPath: string

  private eventCount = 0
  private breakdown: CaptureBreakdown = EMPTY_BREAKDOWN()
  private frameCount = 0
  private networkUrls: string[] = [] // track for topUrls summary
  private startedAt: number
  private config: CaptureConfig
  private _active = true
  private redactPatterns: string[] = []

  constructor(id: string, config: CaptureConfig) {
    this.id = id
    this.config = config
    this.redactPatterns = Array.isArray(config.redact) ? config.redact.filter(p => typeof p === 'string' && p.length > 0) : []
    this.startedAt = Date.now()

    this.dir = join(CAPTURES_DIR, id)
    this.framesDir = join(this.dir, 'frames')
    this.bodiesDir = join(this.dir, 'bodies')
    this.eventsPath = join(this.dir, 'events.jsonl')
    this.metaPath = join(this.dir, 'meta.json')

    mkdirSync(this.framesDir, { recursive: true })
    mkdirSync(this.bodiesDir, { recursive: true })
    writeFileSync(this.eventsPath, '')
    writeFileSync(this.metaPath, JSON.stringify({
      id,
      config,
      startedAt: new Date(this.startedAt).toISOString(),
      status: 'active',
    }, null, 2))
  }

  get active(): boolean {
    return this._active
  }

  /**
   * Append an event to the session. Redaction and form parsing are applied
   * here so any consumer of events.jsonl sees the sanitized form.
   */
  appendEvent(event: CaptureEvent): void {
    if (!this._active) return

    let final: CaptureEvent = event

    // Parse form bodies additively — only for network events with a recognised
    // content type. Kept out of redaction so redaction sees the raw form and
    // cleans it too.
    if (final.kind === 'network') {
      const parsed = parseRequestBody(final)
      if (parsed) final = { ...final, requestBodyParsed: parsed }
    }

    if (this.redactPatterns.length) {
      final = redactEvent(final, this.redactPatterns)
    }

    appendFileSync(this.eventsPath, JSON.stringify(final) + '\n')
    this.eventCount++

    const kind = final.kind
    if (kind in this.breakdown) {
      this.breakdown[kind as keyof CaptureBreakdown]++
    }

    if (kind === 'network') {
      const url = (final.url as string) || ''
      if (url && this.networkUrls.length < 200) {
        this.networkUrls.push(url)
      }
    }
  }

  appendFrame(jpegBuffer: Buffer): void {
    if (!this._active) return

    this.frameCount++
    const filename = `frame_${String(this.frameCount).padStart(5, '0')}.jpg`
    writeFileSync(join(this.framesDir, filename), jpegBuffer)
  }

  /**
   * Append a kind:'annotation' event. `text` is required; `tag` and `color`
   * are optional hints for post-hoc viewers.
   */
  appendAnnotation(text: string, tag?: string, color?: string): CaptureEvent {
    const event: CaptureEvent = {
      kind: 'annotation',
      timestamp: Date.now(),
      text,
      ...(tag ? { tag } : {}),
      ...(color ? { color } : {}),
    }
    this.appendEvent(event)
    return event
  }

  /**
   * Persist a binary response body to disk and return the relative path that
   * should replace the inline body on the corresponding network event.
   */
  appendBody(requestId: string, buffer: Buffer, mimeType?: string): { path: string; size: number } | null {
    if (!this._active) return null
    const safeId = requestId.replace(/[^a-zA-Z0-9_\-]/g, '_')
    const ext = mimeTypeToExt(mimeType)
    const filename = `${safeId}${ext}`
    writeFileSync(join(this.bodiesDir, filename), buffer)
    return { path: `bodies/${filename}`, size: buffer.length }
  }

  getSnapshot(): CaptureSnapshot {
    const elapsed = Date.now() - this.startedAt
    const seconds = Math.round(elapsed / 1000)
    const duration = seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m${seconds % 60}s`

    // Build topUrls: count occurrences, return top 10
    const urlCounts = new Map<string, number>()
    for (const url of this.networkUrls) {
      // Trim to path — strip origin and query string for readability
      let short = url
      try {
        const parsed = new URL(url)
        short = `${parsed.pathname}`
      } catch { /* keep raw url */ }
      urlCounts.set(short, (urlCounts.get(short) || 0) + 1)
    }
    const topUrls = [...urlCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([url, count]) => count > 1 ? `${url} (${count}x)` : url)

    const port = Number(process.env.WEBSTER_PORT ?? 3456)
    return {
      sessionId: this.id,
      active: this._active,
      duration,
      eventCount: this.eventCount,
      frameCount: this.frameCount,
      breakdown: { ...this.breakdown },
      topUrls,
      config: this.config,
      replayUrl: `http://localhost:${port}/replay/${this.id}`,
    }
  }

  /**
   * Read events from the JSONL file, with optional filtering.
   */
  readEvents(options?: {
    kind?: CaptureEventKind
    urlFilter?: string
    search?: string
    method?: string
    offset?: number
    limit?: number
  }): CaptureEvent[] {
    let events = loadEvents(this.eventsPath)

    if (options?.kind) {
      events = events.filter(e => e.kind === options.kind)
    }
    if (options?.urlFilter) {
      const filter = options.urlFilter.toLowerCase()
      events = events.filter(e =>
        (e.kind === 'network' || e.kind === 'websocket' || e.kind === 'dom' || e.kind === 'page' || e.kind === 'storage') &&
        typeof e.url === 'string' && e.url.toLowerCase().includes(filter)
      )
    }
    if (options?.method) {
      const method = options.method.toUpperCase()
      events = events.filter(e => e.kind !== 'network' || (typeof e.method === 'string' && e.method.toUpperCase() === method))
    }
    if (options?.search) {
      const needle = options.search.toLowerCase()
      events = events.filter(e => JSON.stringify(e).toLowerCase().includes(needle))
    }

    const offset = options?.offset ?? 0
    const limit = options?.limit ?? events.length
    return events.slice(offset, offset + limit)
  }

  /**
   * Read a single event by index.
   */
  readEvent(index: number): CaptureEvent | null {
    const events = loadEvents(this.eventsPath)
    if (index < 0 || index >= events.length) return null
    return events[index]
  }

  /**
   * Rewrite the network event whose requestId matches `requestId` so that its
   * responseBody references the body written to `bodies/` instead of inline data.
   * Returns true if the event was found and updated.
   */
  attachBodyReference(requestId: string, bodyRef: { path: string; size: number }, mimeType?: string): boolean {
    const events = loadEvents(this.eventsPath)
    let updated = false
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.kind !== 'network') continue
      if (ev.requestId !== requestId) continue
      events[i] = {
        ...ev,
        responseBody: null,
        responseBodyFile: bodyRef.path,
        responseBodySize: bodyRef.size,
        ...(mimeType ? { responseBodyMimeType: mimeType } : {}),
      }
      updated = true
      break
    }
    if (!updated) return false
    writeFileSync(this.eventsPath, serializeEvents(events))
    return true
  }

  /**
   * Mark session as done. Updates meta.json.
   */
  finalize(): CaptureSnapshot {
    this._active = false
    if (!existsSync(this.dir)) return this.getSnapshot()
    writeFileSync(this.metaPath, JSON.stringify({
      id: this.id,
      config: this.config,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'finished',
      eventCount: this.eventCount,
      frameCount: this.frameCount,
      breakdown: this.breakdown,
    }, null, 2))
    return this.getSnapshot()
  }

  /**
   * Remove session directory from disk.
   */
  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

// ─── Standalone helpers ──────────────────────────────────────────────────────

function loadEvents(path: string): CaptureEvent[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8')
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as CaptureEvent)
}

/** Serialize events back to JSONL. Empty list produces an empty string. */
function serializeEvents(events: CaptureEvent[]): string {
  if (!events.length) return ''
  return events.map(e => JSON.stringify(e)).join('\n') + '\n'
}

/**
 * Read events.jsonl from a session directory on disk. Useful for tools that
 * operate on past sessions which have no live CaptureSession instance.
 */
export function readSessionEvents(sessionDir: string): CaptureEvent[] {
  return loadEvents(join(sessionDir, 'events.jsonl'))
}

function mimeTypeToExt(mime?: string): string {
  if (!mime) return '.bin'
  const m = mime.toLowerCase()
  if (m.includes('png')) return '.png'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('gif')) return '.gif'
  if (m.includes('webp')) return '.webp'
  if (m.includes('pdf')) return '.pdf'
  if (m.includes('zip')) return '.zip'
  if (m.includes('svg')) return '.svg'
  if (m.includes('woff2')) return '.woff2'
  if (m.includes('woff')) return '.woff'
  if (m.includes('mp4')) return '.mp4'
  if (m.includes('webm')) return '.webm'
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3'
  return '.bin'
}

/**
 * Rewrite a session directory on disk, redacting events.jsonl according to
 * `patterns`. Appends a redaction marker to meta.json. Used by redact_capture.
 */
export function redactSessionDir(dir: string, patterns: string[]): { eventsRedacted: number } {
  const eventsPath = join(dir, 'events.jsonl')
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(eventsPath)) return { eventsRedacted: 0 }
  const regexes = compilePatterns(patterns)
  if (!regexes.length) return { eventsRedacted: 0 }
  const events = loadEvents(eventsPath)
  const redacted = events.map(e => redactObject(e, regexes) as CaptureEvent)
  writeFileSync(eventsPath, serializeEvents(redacted))
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      meta.redactedAt = new Date().toISOString()
      meta.redactPatternCount = patterns.length
      writeFileSync(metaPath, JSON.stringify(meta, null, 2))
    } catch { /* leave meta alone if corrupt */ }
  }
  return { eventsRedacted: events.length }
}

// ─── Lifecycle helpers ────────────────────────────────────────────────────────

/**
 * Remove capture sessions older than MAX_AGE_MS.
 * Called on server startup.
 */
export function cleanOldSessions(): void {
  if (!existsSync(CAPTURES_DIR)) return

  const now = Date.now()
  for (const entry of readdirSync(CAPTURES_DIR)) {
    const dir = join(CAPTURES_DIR, entry)
    try {
      const stat = statSync(dir)
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        rmSync(dir, { recursive: true, force: true })
      }
    } catch { /* ignore — race with another cleanup */ }
  }
}
