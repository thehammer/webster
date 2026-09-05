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
/**
 * Age at which a capture session becomes eligible for eviction. A session
 * older than this is not deleted on sight — it is stamped with a
 * `retentionExpiresAt` one DEFAULT_GRACE_MS in the future and only removed by
 * a later sweep. Actual retention is therefore MAX_AGE_MS + DEFAULT_GRACE_MS
 * in the worst case, and the first sweep on any machine deletes nothing.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Grace period between the eviction notice and the actual deletion. */
export const DEFAULT_GRACE_MS = 24 * 60 * 60 * 1000 // 24 hours
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
  /** Number of regex patterns applied (0 means redaction was a no-op). */
  patternCount: number
  /** Text bodies under bodies/ that were successfully redacted in place. */
  bodiesRedacted: number
  /** Body filenames NOT covered — binary format, or unreadable/undecodable. */
  bodiesSkipped: string[]
  /** True iff session.har existed and was regenerated from redacted events. */
  harRegenerated: boolean
  /** Number of files in frames/ — screenshots are never redactable. */
  frameCount: number
  /**
   * True only when every location was fully covered: no binary body was
   * skipped, no frames exist, no body file errored, and any pre-existing
   * session.har was regenerated. False means PHI may remain in bodies/ or
   * frames/ — callers that gate on "verified redacted" must check this
   * flag, not merely that redaction ran.
   */
  complete: boolean
}

/** RedactionResult for the "nothing to do" early-exit paths of redactSessionDir. */
function emptyRedactionResult(frameCount: number): RedactionResult {
  return {
    eventsRedacted: 0,
    patternCount: 0,
    bodiesRedacted: 0,
    bodiesSkipped: [],
    harRegenerated: false,
    frameCount,
    complete: false,
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
 * Redact text bodies under dir/bodies/ in place. Binary bodies (per
 * isRedactableBodyExt) are left byte-identical and reported in
 * `bodiesSkipped`, as is any file that fails to read/decode — one bad file
 * must not abort redaction of the rest of the session.
 */
function redactBodiesDir(dir: string, regexes: RegExp[]): { bodiesRedacted: number; bodiesSkipped: string[] } {
  const bodiesDir = join(dir, 'bodies')
  const result = { bodiesRedacted: 0, bodiesSkipped: [] as string[] }
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
    try {
      const content = readFileSync(filePath, 'utf-8')
      const redacted = redactString(content, regexes)
      if (redacted !== content) {
        writeFileSync(filePath, redacted)
      }
      result.bodiesRedacted++
    } catch {
      // Unreadable/undecodable file — report it, don't abort the rest.
      result.bodiesSkipped.push(filename)
    }
  }
  return result
}

/** Regenerate dir/session.har from `events` if (and only if) it already existed. */
function regenerateHar(dir: string, events: CaptureEvent[]): boolean {
  const harPath = join(dir, 'session.har')
  if (!existsSync(harPath)) return false
  try {
    writeHarToSession(dir, events)
    return true
  } catch {
    return false
  }
}

/**
 * Rewrite a session directory on disk, redacting sensitive text wherever
 * regex redaction can safely reach it:
 *
 *  - events.jsonl — every event rewritten (as before).
 *  - bodies/      — text bodies (.json/.txt/.html/.htm/.xml/.csv/.svg) are
 *                   redacted in place; binary bodies (PDF, images, zips,
 *                   fonts, media) are left byte-identical — regex cannot
 *                   safely redact bytes — and reported in `bodiesSkipped`.
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
 * `complete` is true only when nothing was left uncovered: no binary body
 * skipped, no frames present, no body errored, and any pre-existing HAR was
 * regenerated. A caller gating on "safe to share" must check `complete`, not
 * just that this function was called.
 *
 * Idempotent: running this twice with the same patterns is a no-op on the
 * second pass — already-redacted text has no further matches, and the HAR is
 * regenerated from already-redacted events.
 */
export function redactSessionDir(dir: string, patterns: string[]): RedactionResult {
  const frameCount = countFrames(dir)
  const eventsPath = join(dir, 'events.jsonl')
  const metaPath = join(dir, 'meta.json')

  if (!existsSync(eventsPath)) return emptyRedactionResult(frameCount)
  const regexes = compilePatterns(patterns)
  if (!regexes.length) return emptyRedactionResult(frameCount)

  const events = loadEvents(eventsPath)
  const redactedEvents = events.map(e => redactObject(e, regexes) as CaptureEvent)
  writeFileSync(eventsPath, serializeEvents(redactedEvents))

  const { bodiesRedacted, bodiesSkipped } = redactBodiesDir(dir, regexes)

  const hadHar = existsSync(join(dir, 'session.har'))
  const harRegenerated = hadHar ? regenerateHar(dir, redactedEvents) : false
  const harOk = !hadHar || harRegenerated

  const result: RedactionResult = {
    eventsRedacted: redactedEvents.length,
    patternCount: patterns.length,
    bodiesRedacted,
    bodiesSkipped,
    harRegenerated,
    frameCount,
    complete: bodiesSkipped.length === 0 && frameCount === 0 && harOk,
  }

  writeRedactionMeta(metaPath, result)

  return result
}

// ─── Retention ────────────────────────────────────────────────────────────────

export interface RetentionOptions {
  /** Directory to sweep. Defaults to CAPTURES_DIR (the operator's real data). */
  dir?: string
  /** Clock for the sweep, injectable so tests need no sleeps. Default Date.now(). */
  now?: number
  /** Age at which a session becomes eligible. 0 or less disables deletion entirely. */
  maxAgeMs?: number
  /** Delay between the eviction notice and the deletion. Default 24h. */
  graceMs?: number
  /** Session ids never to touch — in practice the live capture. */
  excludeIds?: string[]
}

export interface RetentionReport {
  /** Newly stamped with retentionExpiresAt this sweep. Still on disk. */
  warned: string[]
  /** Grace expired — directory removed. */
  deleted: string[]
  /** Already warned, grace not yet expired. Still on disk. */
  pending: string[]
  /** Excluded, unreadable, or not a session directory. Never deleted. */
  skipped: string[]
}

/** Parse dir/meta.json. Returns null if absent, unreadable, or not an object. */
function readSessionMeta(dir: string): Record<string, unknown> | null {
  const metaPath = join(dir, 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Write meta back verbatim. Returns false if the write failed. */
function writeSessionMeta(dir: string, meta: Record<string, unknown>): boolean {
  try {
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
    return true
  } catch {
    return false
  }
}

function formatHours(ms: number): string {
  return `${(ms / 3600_000).toFixed(1)}h`
}

/**
 * Sweep `dir` for expired capture sessions.
 *
 * Deletion is two-phase on purpose. Capture directories routinely hold PHI,
 * and this sweep is the only code path in Webster that removes them without
 * being asked. The first sweep that sees an over-age session does not delete
 * it: it stamps meta.json with `retentionExpiresAt` (now + graceMs) and logs a
 * warning. Only a later sweep, once that stamp is in the past, removes the
 * directory. That makes "the first run of this code on any machine deletes
 * nothing" true by construction rather than by convention — every existing
 * session gets a full grace window and a logged notice first.
 *
 * A directory with no meta.json, or an unparseable one, is reported as skipped
 * and never removed: a stray directory under captures/ is not a Webster
 * session and is not ours to delete.
 */
export function cleanOldSessions(options: RetentionOptions = {}): RetentionReport {
  const dir = options.dir ?? CAPTURES_DIR
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const excludeIds = new Set(options.excludeIds ?? [])

  const report: RetentionReport = { warned: [], deleted: [], pending: [], skipped: [] }

  // maxAgeMs <= 0 means "retain forever" — the operator opted out of deletion
  // (WEBSTER_RETENTION_HOURS=0). Touch nothing, not even to warn.
  if (maxAgeMs <= 0) return report
  if (!existsSync(dir)) return report

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return report
  }

  for (const entry of entries) {
    // The live capture appends with absolute paths; deleting it mid-write
    // corrupts the session in confusing ways. Never touch an excluded id.
    if (excludeIds.has(entry)) {
      report.skipped.push(entry)
      continue
    }

    const sessionDir = join(dir, entry)

    let ageMs: number
    try {
      const stat = statSync(sessionDir)
      if (!stat.isDirectory()) {
        report.skipped.push(entry)
        continue
      }
      ageMs = now - stat.mtimeMs
    } catch {
      report.skipped.push(entry) // race with another cleanup, or unreadable
      continue
    }

    const meta = readSessionMeta(sessionDir)
    if (!meta) {
      report.skipped.push(entry)
      continue
    }

    if (ageMs <= maxAgeMs) continue

    const stamp = meta.retentionExpiresAt
    const expiresAt = typeof stamp === 'string' ? Date.parse(stamp) : NaN

    // No stamp (or an unusable one): issue the eviction notice, delete nothing.
    if (!Number.isFinite(expiresAt)) {
      const expiry = new Date(now + graceMs).toISOString()
      meta.retentionWarnedAt = new Date(now).toISOString()
      meta.retentionExpiresAt = expiry
      if (!writeSessionMeta(sessionDir, meta)) {
        report.skipped.push(entry)
        continue
      }
      report.warned.push(entry)
      console.error(`Webster: capture ${entry} is ${formatHours(ageMs)} old (retention ${formatHours(maxAgeMs)}) — scheduled for deletion at ${expiry}`)
      continue
    }

    if (now > expiresAt) {
      try {
        rmSync(sessionDir, { recursive: true, force: true })
      } catch {
        report.skipped.push(entry)
        continue
      }
      report.deleted.push(entry)
      console.error(`Webster: deleted capture ${entry} — retention grace expired at ${new Date(expiresAt).toISOString()}`)
      continue
    }

    report.pending.push(entry)
  }

  return report
}
