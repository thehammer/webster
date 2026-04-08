import { mkdirSync, rmSync, readdirSync, statSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CaptureEvent {
  kind: 'network' | 'input' | 'console' | 'page'
  timestamp: number
  [key: string]: unknown
}

export interface CaptureConfig {
  urlFilter?: string | null
  includeInput?: boolean
  recordFrames?: boolean
  fps?: number
}

export interface CaptureSnapshot {
  sessionId: string
  active: boolean
  duration: string
  eventCount: number
  frameCount: number
  breakdown: { network: number; input: number; console: number; page: number }
  topUrls: string[]
  config: CaptureConfig
  replayUrl: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CAPTURES_DIR = join(homedir(), '.webster', 'captures')
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

// ─── Session ──────────────────────────────────────────────────────────────────

export class CaptureSession {
  readonly id: string
  readonly dir: string
  readonly framesDir: string
  readonly eventsPath: string
  readonly metaPath: string

  private eventCount = 0
  private networkCount = 0
  private inputCount = 0
  private consoleCount = 0
  private pageCount = 0
  private frameCount = 0
  private networkUrls: string[] = [] // track for topUrls summary
  private startedAt: number
  private config: CaptureConfig
  private _active = true

  constructor(id: string, config: CaptureConfig) {
    this.id = id
    this.config = config
    this.startedAt = Date.now()

    this.dir = join(CAPTURES_DIR, id)
    this.framesDir = join(this.dir, 'frames')
    this.eventsPath = join(this.dir, 'events.jsonl')
    this.metaPath = join(this.dir, 'meta.json')

    mkdirSync(this.framesDir, { recursive: true })
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

  appendEvent(event: CaptureEvent): void {
    if (!this._active) return

    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n')
    this.eventCount++

    if (event.kind === 'network') {
      this.networkCount++
      const url = (event.url as string) || ''
      if (url && this.networkUrls.length < 200) {
        this.networkUrls.push(url)
      }
    } else if (event.kind === 'input') {
      this.inputCount++
    } else if (event.kind === 'console') {
      this.consoleCount++
    } else if (event.kind === 'page') {
      this.pageCount++
    }
  }

  appendFrame(jpegBuffer: Buffer): void {
    if (!this._active) return

    this.frameCount++
    const filename = `frame_${String(this.frameCount).padStart(5, '0')}.jpg`
    writeFileSync(join(this.framesDir, filename), jpegBuffer)
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
      breakdown: { network: this.networkCount, input: this.inputCount, console: this.consoleCount, page: this.pageCount },
      topUrls,
      config: this.config,
      replayUrl: `http://localhost:${port}/replay/${this.id}`,
    }
  }

  /**
   * Read events from the JSONL file, with optional filtering.
   */
  readEvents(options?: {
    kind?: 'network' | 'input' | 'console' | 'page'
    urlFilter?: string
    offset?: number
    limit?: number
  }): CaptureEvent[] {
    if (!existsSync(this.eventsPath)) return []

    const raw = readFileSync(this.eventsPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)

    let events: CaptureEvent[] = lines.map(line => JSON.parse(line) as CaptureEvent)

    if (options?.kind) {
      events = events.filter(e => e.kind === options.kind)
    }
    if (options?.urlFilter) {
      const filter = options.urlFilter.toLowerCase()
      events = events.filter(e =>
        e.kind === 'network' && typeof e.url === 'string' && e.url.toLowerCase().includes(filter)
      )
    }

    const offset = options?.offset ?? 0
    const limit = options?.limit ?? events.length
    return events.slice(offset, offset + limit)
  }

  /**
   * Read a single event by index.
   */
  readEvent(index: number): CaptureEvent | null {
    if (!existsSync(this.eventsPath)) return null

    const raw = readFileSync(this.eventsPath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    if (index < 0 || index >= lines.length) return null
    return JSON.parse(lines[index]) as CaptureEvent
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
