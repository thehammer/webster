import { mkdirSync, rmSync, readdirSync, statSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { CaptureEventKind } from './protocol.js'
import { writeHarToSession } from './har.js'

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

/**
 * Compile pattern source strings into case-insensitive global regexes.
 * Non-string, empty, and malformed entries are dropped and returned in
 * `invalid` rather than silently discarded — a caller must be able to see
 * exactly how many (and which) patterns didn't make it into `regexes`, since
 * `regexes.length` is what the coverage-honesty accounting keys off of.
 */
function compilePatterns(patterns: string[] | undefined): { regexes: RegExp[]; invalid: string[] } {
  const regexes: RegExp[] = []
  const invalid: string[] = []
  if (!patterns?.length) return { regexes, invalid }
  for (const p of patterns) {
    if (typeof p !== 'string' || !p) {
      invalid.push(typeof p === 'string' ? p : String(p))
      continue
    }
    try {
      // Every pattern is applied globally + case-insensitively by default
      regexes.push(new RegExp(p, 'gi'))
    } catch {
      invalid.push(p)
    }
  }
  return { regexes, invalid }
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

/**
 * Decode `bytes` as UTF-8, but only if the decode is provably lossless:
 * re-encoding the result must reproduce the input byte-for-byte. Returns null
 * for anything else — invalid UTF-8, lone surrogates, replacement-character
 * substitution. A null return means "regex cannot safely reach this data";
 * callers must report it rather than guess.
 */
function decodeLosslessUtf8(bytes: Buffer): string | null {
  const text = bytes.toString('utf-8')
  return Buffer.compare(Buffer.from(text, 'utf-8'), bytes) === 0 ? text : null
}

// A base64 responseBody ending in this marker is a truncated prefix of
// unknown byte alignment — trimming it to a decodable boundary would drop
// up to three bytes, which is corruption, not redaction. Left untouched.
const TRUNCATED_BODY_RE = /\.\.\.\[truncated, \d+ total\]$/

interface EventRedactionOutcome {
  event: CaptureEvent
  /** Encoded payload fields decoded, redacted and re-encoded losslessly. */
  covered: number
  /** Descriptors of encoded fields left untouched, e.g.
   *  'websocket.payload (base64, opcode 2)'. */
  skipped: string[]
}

/**
 * Redact a single capture event, aware of the encoded-payload fields that a
 * blind `redactObject` walk cannot safely reach: base64 response bodies
 * (network events) and base64 WebSocket frame payloads. Everything else on
 * the event — including sibling fields alongside an encoded payload — is
 * redacted exactly as before via `redactObject`.
 */
function redactCaptureEvent(event: CaptureEvent, regexes: RegExp[]): EventRedactionOutcome {
  if (!regexes.length) return { event, covered: 0, skipped: [] }

  if (event.kind === 'network' && event.responseBodyEncoding === 'base64' && typeof event.responseBody === 'string') {
    const { responseBody, ...rest } = event
    const redactedRest = redactObject(rest, regexes) as CaptureEvent

    if (TRUNCATED_BODY_RE.test(responseBody)) {
      return { event: { ...redactedRest, responseBody }, covered: 0, skipped: ['network.responseBody (base64, truncated)'] }
    }

    const text = decodeLosslessUtf8(Buffer.from(responseBody, 'base64'))
    if (text === null) {
      return { event: { ...redactedRest, responseBody }, covered: 0, skipped: ['network.responseBody (base64, not valid UTF-8)'] }
    }

    const reencoded = Buffer.from(redactString(text, regexes), 'utf-8').toString('base64')
    return { event: { ...redactedRest, responseBody: reencoded }, covered: 1, skipped: [] }
  }

  if (event.kind === 'websocket' && event.subKind === 'frame' && event.payloadEncoding === 'base64') {
    // CDP-declared binary (opcode 2). Never decoded: it's a length-sensitive
    // wire format, and regex over bytes reinterpreted as text is unverifiable.
    const { payload, ...rest } = event
    const redactedRest = redactObject(rest, regexes) as CaptureEvent
    return { event: { ...redactedRest, payload }, covered: 0, skipped: ['websocket.payload (base64, opcode 2)'] }
  }

  return { event: redactObject(event, regexes) as CaptureEvent, covered: 0, skipped: [] }
}

export function redactEvent(event: CaptureEvent, patterns: string[]): CaptureEvent {
  const { regexes } = compilePatterns(patterns)
  return redactCaptureEvent(event, regexes).event
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
  private regexes: RegExp[] = []
  private patternsInvalid: string[] = []
  private encodedPayloadsCovered = 0
  private encodedPayloadsSkipped = new Set<string>()
  private encodedPayloadsSkippedCount = 0

  constructor(id: string, config: CaptureConfig) {
    this.id = id
    this.config = config
    this.redactPatterns = Array.isArray(config.redact) ? config.redact.filter(p => typeof p === 'string' && p.length > 0) : []
    const compiled = compilePatterns(this.redactPatterns)
    this.regexes = compiled.regexes
    this.patternsInvalid = compiled.invalid
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

    const outcome = redactCaptureEvent(final, this.regexes)
    final = outcome.event
    this.encodedPayloadsCovered += outcome.covered
    for (const skip of outcome.skipped) {
      this.encodedPayloadsSkipped.add(skip)
      this.encodedPayloadsSkippedCount++
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
   *
   * When redact patterns were configured, publishes a `redaction` block
   * computed with the exact same coverage-honesty accounting as
   * `redactSessionDir`: text bodies under bodies/ and any pre-existing
   * session.har are covered here for the first time (event-level redaction
   * already happened incrementally in appendEvent). When no redact patterns
   * were configured, no `redaction` block is written at all — absence means
   * "not redacted", which is honest; a block full of zeroes would be noise.
   */
  finalize(): CaptureSnapshot {
    this._active = false
    if (!existsSync(this.dir)) return this.getSnapshot()

    const meta: Record<string, unknown> = {
      id: this.id,
      config: this.config,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'finished',
      eventCount: this.eventCount,
      frameCount: this.frameCount,
      breakdown: this.breakdown,
    }

    if (this.redactPatterns.length) {
      const events = loadEvents(this.eventsPath)
      const frameCount = countFrames(this.dir)
      const rest = finishRedaction(this.dir, events, this.regexes, this.patternsInvalid, frameCount, {
        covered: this.encodedPayloadsCovered,
        skipped: [...this.encodedPayloadsSkipped],
        skippedCount: this.encodedPayloadsSkippedCount,
      })

      const redactedAt = new Date().toISOString()
      meta.redactedAt = redactedAt
      meta.redactPatternCount = this.regexes.length
      meta.redaction = {
        redactedAt,
        eventsRedacted: this.eventCount,
        patternCount: this.regexes.length,
        ...rest,
      }
    }

    writeFileSync(this.metaPath, JSON.stringify(meta, null, 2))
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
  if (m.includes('json')) return '.json'
  if (m.includes('html')) return '.html'
  if (m.includes('xml')) return '.xml'
  if (m.includes('csv')) return '.csv'
  if (m.includes('svg')) return '.svg'
  if (m.includes('png')) return '.png'
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('gif')) return '.gif'
  if (m.includes('webp')) return '.webp'
  if (m.includes('pdf')) return '.pdf'
  if (m.includes('zip')) return '.zip'
  if (m.includes('woff2')) return '.woff2'
  if (m.includes('woff')) return '.woff'
  if (m.includes('mp4')) return '.mp4'
  if (m.includes('webm')) return '.webm'
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3'
  if (m.includes('text/plain')) return '.txt'
  return '.bin'
}

// Body file extensions that hold text a regex can safely rewrite in place.
// This is the redactable-text complement to mimeTypeToExt's mapping: every
// extension mimeTypeToExt can produce for a *binary* format (.png, .pdf,
// .zip, .woff, .mp4, …) — plus its catch-all `.bin` and extensionless files —
// is deliberately absent here and treated as binary. Applying regex to
// binary bytes doesn't reliably redact anything and can corrupt the file, so
// when in doubt this returns false and the caller reports the file as
// not covered rather than risk it.
const TEXT_BODY_EXTS = new Set(['.json', '.txt', '.html', '.htm', '.xml', '.csv', '.svg'])

function isRedactableBodyExt(filename: string): boolean {
  const idx = filename.lastIndexOf('.')
  if (idx < 0) return false
  return TEXT_BODY_EXTS.has(filename.slice(idx).toLowerCase())
}

export interface RedactionResult {
  /** Legacy field, kept for compatibility: number of events rewritten. */
  eventsRedacted: number
  /** Number of patterns that actually compiled. Was `patterns.length`. */
  patternCount: number
  /** Pattern source strings dropped as malformed, non-string, or empty. */
  patternsInvalid: string[]
  /** Text bodies under bodies/ examined and losslessly processed. */
  bodiesCovered: number
  /** Subset of bodiesCovered whose bytes actually changed. */
  bodiesChanged: number
  /** Body filenames NOT covered — binary extension, unreadable, or not losslessly decodable as UTF-8. */
  bodiesSkipped: string[]
  /** Encoded event payloads (base64 response bodies) decoded, redacted and re-encoded losslessly. */
  encodedPayloadsCovered: number
  /** Deduped descriptors of encoded event payloads left untouched, e.g. 'websocket.payload (base64, opcode 2)'. */
  encodedPayloadsSkipped: string[]
  /** Total individual event fields behind encodedPayloadsSkipped (not deduped). */
  encodedPayloadsSkippedCount: number
  /** True iff session.har existed and was regenerated from redacted events. */
  harRegenerated: boolean
  /** Number of files in frames/ — screenshots are never redactable. */
  frameCount: number
  /**
   * True only when NOTHING was left uncovered — see computeCompleteness.
   * Callers gating on "safe to share" must check this flag, not merely that
   * redaction ran.
   */
  complete: boolean
}

/**
 * The one place `complete` is decided. `complete` may be true only when
 * every artifact was either fully covered or provably contains nothing to
 * redact — any new non-coverage channel must be added to `uncovered` here,
 * never bolted on as an ad hoc boolean elsewhere.
 */
function computeCompleteness(parts: {
  bodiesSkipped: string[]
  encodedPayloadsSkipped: string[]
  frameCount: number
  harStatus: 'absent' | 'regenerated' | 'failed'
  patternsInvalid: string[]
  regexCount: number
}): { uncovered: string[]; complete: boolean } {
  const uncovered: string[] = [
    ...parts.bodiesSkipped,
    ...parts.encodedPayloadsSkipped,
    ...(parts.frameCount > 0 ? [`frames/ (${parts.frameCount} screenshots)`] : []),
    ...(parts.harStatus === 'failed' ? ['session.har (regeneration failed)'] : []),
    ...(parts.patternsInvalid.length && parts.regexCount === 0 ? ['no usable patterns'] : []),
  ]
  return { uncovered, complete: uncovered.length === 0 }
}

/** RedactionResult for the "nothing to do" early-exit paths of redactSessionDir. */
function emptyRedactionResult(frameCount: number, patternsInvalid: string[] = []): RedactionResult {
  return {
    eventsRedacted: 0,
    patternCount: 0,
    patternsInvalid,
    bodiesCovered: 0,
    bodiesChanged: 0,
    bodiesSkipped: [],
    encodedPayloadsCovered: 0,
    encodedPayloadsSkipped: [],
    encodedPayloadsSkippedCount: 0,
    harRegenerated: false,
    frameCount,
    complete: false,
  }
}

/** Encoded-payload coverage accounting handed to {@link finishRedaction}. */
interface EncodedPayloadAccounting {
  covered: number
  skipped: string[]
  skippedCount: number
}

/**
 * Finish redacting a session dir, given events that are already redacted and
 * the encoded-payload accounting for them. Covers the part of a
 * `RedactionResult` that both `redactSessionDir` and `CaptureSession.finalize`
 * need identically — bodies/, session.har, frame count, and the completeness
 * decision — whether the events were just redacted in bulk (`redactSessionDir`)
 * or redacted incrementally as they were appended (the live capture path).
 */
function finishRedaction(
  dir: string,
  events: CaptureEvent[],
  regexes: RegExp[],
  patternsInvalid: string[],
  frameCount: number,
  encodedPayloads: EncodedPayloadAccounting
): Omit<RedactionResult, 'eventsRedacted' | 'patternCount'> {
  const { bodiesCovered, bodiesChanged, bodiesSkipped } = redactBodiesDir(dir, regexes)
  const harStatus = regenerateHar(dir, events)
  const { complete } = computeCompleteness({
    bodiesSkipped,
    encodedPayloadsSkipped: encodedPayloads.skipped,
    frameCount,
    harStatus,
    patternsInvalid,
    regexCount: regexes.length,
  })

  return {
    patternsInvalid,
    bodiesCovered,
    bodiesChanged,
    bodiesSkipped,
    encodedPayloadsCovered: encodedPayloads.covered,
    encodedPayloadsSkipped: encodedPayloads.skipped,
    encodedPayloadsSkippedCount: encodedPayloads.skippedCount,
    harRegenerated: harStatus === 'regenerated',
    frameCount,
    complete,
  }
}

/**
 * Stamp meta.json with the redaction accounting: the legacy `redactedAt` /
 * `redactPatternCount` keys, plus the full `redaction` block (same fields as
 * `result`, with `redactedAt` added). No-op if meta.json is missing or corrupt.
 */
function writeRedactionMeta(metaPath: string, result: RedactionResult): void {
  if (!existsSync(metaPath)) return
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    const redactedAt = new Date().toISOString()
    meta.redactedAt = redactedAt
    meta.redactPatternCount = result.patternCount
    meta.redaction = { redactedAt, ...result }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  } catch { /* leave meta alone if corrupt */ }
}

function countFrames(dir: string): number {
  const framesDir = join(dir, 'frames')
  if (!existsSync(framesDir)) return 0
  try {
    return readdirSync(framesDir).length
  } catch {
    return 0
  }
}

/**
 * Redact text bodies under dir/bodies/ in place. Binary-extension bodies
 * (per isRedactableBodyExt) are left byte-identical and reported in
 * `bodiesSkipped`, as is any file that fails to read, or whose bytes are not
 * losslessly decodable as UTF-8 — one bad file must not abort redaction of
 * the rest of the session, and must never be corrupted by a lossy decode.
 */
function redactBodiesDir(dir: string, regexes: RegExp[]): { bodiesCovered: number; bodiesChanged: number; bodiesSkipped: string[] } {
  const bodiesDir = join(dir, 'bodies')
  const result = { bodiesCovered: 0, bodiesChanged: 0, bodiesSkipped: [] as string[] }
  if (!existsSync(bodiesDir)) return result

  let filenames: string[]
  try {
    filenames = readdirSync(bodiesDir)
  } catch {
    return result
  }

  for (const filename of filenames) {
    if (!isRedactableBodyExt(filename)) {
      result.bodiesSkipped.push(filename)
      continue
    }
    const filePath = join(bodiesDir, filename)
    let bytes: Buffer
    try {
      bytes = readFileSync(filePath)
    } catch {
      // Unreadable file — report it, don't abort the rest.
      result.bodiesSkipped.push(filename)
      continue
    }
    const text = decodeLosslessUtf8(bytes)
    if (text === null) {
      // Not losslessly decodable as UTF-8 — leave it byte-identical rather
      // than corrupt it with a lossy decode.
      result.bodiesSkipped.push(filename)
      continue
    }
    const redacted = redactString(text, regexes)
    if (redacted !== text) {
      writeFileSync(filePath, redacted, 'utf-8')
      result.bodiesChanged++
    }
    result.bodiesCovered++
  }
  return result
}

/** Regenerate dir/session.har from `events` if (and only if) it already existed. */
function regenerateHar(dir: string, events: CaptureEvent[]): 'absent' | 'regenerated' | 'failed' {
  const harPath = join(dir, 'session.har')
  if (!existsSync(harPath)) return 'absent'
  try {
    writeHarToSession(dir, events)
    return 'regenerated'
  } catch {
    return 'failed'
  }
}

/**
 * Rewrite a session directory on disk, redacting sensitive text wherever it
 * can be safely reached — including behind base64 encoding, when the decode
 * is provably lossless:
 *
 *  - events.jsonl — every event rewritten. Base64 response bodies on network
 *                   events are decoded, redacted and re-encoded when the
 *                   round trip is lossless; otherwise left byte-identical
 *                   and reported. Base64 WebSocket frame payloads (binary,
 *                   opcode 2) are NEVER decoded — a length-sensitive wire
 *                   format that regex-over-reinterpreted-bytes can't safely
 *                   touch — and are always reported.
 *  - bodies/      — text bodies (.json/.txt/.html/.htm/.xml/.csv/.svg) are
 *                   redacted in place only when their bytes are losslessly
 *                   decodable as UTF-8; binary-extension bodies (PDF, images,
 *                   zips, fonts, media) and any file that fails that decode
 *                   are left byte-identical and reported in `bodiesSkipped`.
 *  - session.har  — regenerated from the redacted events if it already
 *                   existed; never created if it didn't.
 *  - frames/      — NEVER touched. JPEG screenshots may contain PHI that no
 *                   text redaction can remove; `frameCount` reports how many
 *                   exist so a caller can decide what to do about them.
 *
 * The legacy `eventsRedacted` return field and the legacy `meta.redactedAt` /
 * `meta.redactPatternCount` keys are preserved with their original meaning.
 * A new `redaction` block on meta.json (and this function's return value)
 * carries the full accounting.
 *
 * `complete` is computed by computeCompleteness from a single accumulated
 * `uncovered` list, so a future non-coverage channel can't be forgotten. A
 * caller gating on "safe to share" must check `complete`, not just that this
 * function was called.
 *
 * Idempotent: running this twice with the same patterns is a no-op on the
 * second pass — already-redacted text has no further matches, encoded
 * payloads that were covered the first time re-decode to already-redacted
 * text, and the HAR is regenerated from already-redacted events.
 */
export function redactSessionDir(dir: string, patterns: string[]): RedactionResult {
  const frameCount = countFrames(dir)
  const eventsPath = join(dir, 'events.jsonl')
  const metaPath = join(dir, 'meta.json')

  if (!existsSync(eventsPath)) return emptyRedactionResult(frameCount)
  const { regexes, invalid: patternsInvalid } = compilePatterns(patterns)
  if (!regexes.length) return emptyRedactionResult(frameCount, patternsInvalid)

  const events = loadEvents(eventsPath)
  let encodedPayloadsCovered = 0
  const encodedPayloadsSkippedSet = new Set<string>()
  let encodedPayloadsSkippedCount = 0
  const redactedEvents = events.map(e => {
    const outcome = redactCaptureEvent(e, regexes)
    encodedPayloadsCovered += outcome.covered
    for (const skip of outcome.skipped) {
      encodedPayloadsSkippedSet.add(skip)
      encodedPayloadsSkippedCount++
    }
    return outcome.event
  })
  writeFileSync(eventsPath, serializeEvents(redactedEvents))

  const rest = finishRedaction(dir, redactedEvents, regexes, patternsInvalid, frameCount, {
    covered: encodedPayloadsCovered,
    skipped: [...encodedPayloadsSkippedSet],
    skippedCount: encodedPayloadsSkippedCount,
  })

  const result: RedactionResult = {
    eventsRedacted: redactedEvents.length,
    patternCount: regexes.length,
    ...rest,
  }

  writeRedactionMeta(metaPath, result)

  return result
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
