import type { DriverState, Limitation, ToolSupport, WsEvent, WsPeerState } from './protocol.js'
import { OWNER_TOKEN_RE } from './net-guard.js'

/**
 * Validation for the native (kind: 'webkit') peer messages — the handshake and
 * `peer_state`. Pure: no server state. Returned values are fresh copies that
 * contain only known fields. Failure reasons never echo input (the handshake
 * carries the owner token, which must never reach a log line).
 */

export const INSTANCE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const ENGINE_RE = /^[a-z0-9-]{1,32}$/
const TOOL_NAME_RE = /^[A-Za-z0-9_]{1,64}$/

const MAX_NAME = 128
const MAX_PROFILE = 64
const MAX_LIMITATIONS = 64
const MAX_STR = 300
const MAX_TOOLS_PER_LIMITATION = 64
const MAX_TOOL_SUPPORT = 256
export const MAX_REASON = 200

const DRIVERS: readonly DriverState[] = ['agent', 'user', 'stopped']
const LEVELS = ['parity', 'approximate', 'unsupported']

export interface PeerFields {
  focus: { tag: string; name: string }
  profile: string
  driver: DriverState
  limitations: Limitation[]
  toolSupport?: Record<string, ToolSupport>
}

export interface PeerRegistration extends PeerFields {
  version: string
  browser: string
  engine: string
  instanceId: string
  owner: string
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: string }

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null
}

function parseFocus(v: unknown): { tag: string; name: string } | null {
  if (!isObject(v)) return null
  const tag = str(v.tag, MAX_NAME)
  const name = str(v.name, MAX_NAME)
  return tag === null || name === null ? null : { tag, name }
}

function parseLimitations(v: unknown): Limitation[] | null {
  if (!Array.isArray(v) || v.length > MAX_LIMITATIONS) return null
  const out: Limitation[] = []
  for (const item of v) {
    if (!isObject(item)) return null
    const area = str(item.area, MAX_STR)
    const missing = str(item.missing, MAX_STR)
    if (area === null || missing === null) return null
    const lim: Limitation = { area, missing }
    if (item.tools !== undefined) {
      if (!Array.isArray(item.tools) || item.tools.length > MAX_TOOLS_PER_LIMITATION) return null
      const tools: string[] = []
      for (const t of item.tools) {
        const s = str(t, MAX_STR)
        if (s === null) return null
        tools.push(s)
      }
      lim.tools = tools
    }
    out.push(lim)
  }
  return out
}

function parseToolSupport(v: unknown): Record<string, ToolSupport> | null {
  if (!isObject(v)) return null
  const entries = Object.entries(v)
  if (entries.length > MAX_TOOL_SUPPORT) return null
  const out: Record<string, ToolSupport> = {}
  for (const [name, entry] of entries) {
    if (!TOOL_NAME_RE.test(name) || !isObject(entry)) return null
    if (typeof entry.level !== 'string' || !LEVELS.includes(entry.level)) return null
    const support: ToolSupport = { level: entry.level as ToolSupport['level'] }
    if (entry.note !== undefined) {
      const note = str(entry.note, MAX_STR)
      if (note === null) return null
      support.note = note
    }
    out[name] = support
  }
  return out
}

/** Validate a kind:'webkit' handshake. Owner, instanceId, focus and driver are required. */
export function validateWebkitHandshake(msg: WsEvent): Result<PeerRegistration> {
  const m = msg as unknown as Record<string, unknown>

  const version = str(m.version, 64)
  if (version === null) return fail('invalid version')

  // Webkit peers are always `nostromo`: they must not squat an extension browser's name.
  const browser = m.browser === undefined ? 'nostromo' : m.browser
  if (browser !== 'nostromo') return fail('invalid browser name')

  if (typeof m.instanceId !== 'string' || !INSTANCE_ID_RE.test(m.instanceId)) return fail('invalid instanceId')
  if (typeof m.owner !== 'string' || !OWNER_TOKEN_RE.test(m.owner)) return fail('invalid owner')

  const engine = m.engine === undefined ? 'webkit' : m.engine
  if (typeof engine !== 'string' || !ENGINE_RE.test(engine)) return fail('invalid engine')

  const focus = parseFocus(m.focus)
  if (!focus) return fail('invalid focus')

  const profile = m.profile === undefined ? '' : str(m.profile, MAX_PROFILE)
  if (profile === null) return fail('invalid profile')

  if (typeof m.driver !== 'string' || !DRIVERS.includes(m.driver as DriverState)) return fail('invalid driver')

  const limitations = m.limitations === undefined ? [] : parseLimitations(m.limitations)
  if (limitations === null) return fail('invalid limitations')

  const value: PeerRegistration = {
    version, browser, engine,
    instanceId: m.instanceId, owner: m.owner,
    focus, profile, driver: m.driver as DriverState, limitations,
  }
  if (m.toolSupport !== undefined) {
    const toolSupport = parseToolSupport(m.toolSupport)
    if (toolSupport === null) return fail('invalid toolSupport')
    value.toolSupport = toolSupport
  }
  return { ok: true, value }
}

/** Validate a peer_state patch: only the provided fields, each validated like the handshake. */
export function validatePeerState(msg: WsPeerState): Result<Partial<PeerFields>> {
  const m = msg as unknown as Record<string, unknown>
  const patch: Partial<PeerFields> = {}

  if (m.driver !== undefined) {
    if (typeof m.driver !== 'string' || !DRIVERS.includes(m.driver as DriverState)) return fail('invalid driver')
    patch.driver = m.driver as DriverState
  }
  if (m.profile !== undefined) {
    const profile = str(m.profile, MAX_PROFILE)
    if (profile === null) return fail('invalid profile')
    patch.profile = profile
  }
  if (m.focus !== undefined) {
    const focus = parseFocus(m.focus)
    if (!focus) return fail('invalid focus')
    patch.focus = focus
  }
  if (m.limitations !== undefined) {
    const limitations = parseLimitations(m.limitations)
    if (limitations === null) return fail('invalid limitations')
    patch.limitations = limitations
  }
  if (m.toolSupport !== undefined) {
    const toolSupport = parseToolSupport(m.toolSupport)
    if (toolSupport === null) return fail('invalid toolSupport')
    patch.toolSupport = toolSupport
  }
  return { ok: true, value: patch }
}

/** Clean an `unregister` reason: strip newlines, cap at 200 chars. Non-strings yield undefined. */
export function sanitizeReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined
  const cleaned = reason.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_REASON)
  return cleaned === '' ? undefined : cleaned
}
