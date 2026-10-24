import { createHash } from 'crypto'

/**
 * Pure helpers for Webster's loopback / Host / Origin checks and the owner
 * token fingerprint. See docs/browser-peers.md (D6).
 */

/** True for 127.0.0.0/8, ::1, and IPv4-mapped ::ffff:127.x.x.x. */
export function isLoopbackAddress(addr?: string | null): boolean {
  if (!addr) return false
  let a = addr.trim().toLowerCase()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  if (a === '::1') return true
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) a = mapped[1]
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((o) => o > 255)) return false
  return octets[0] === 127
}

/** The Host header's hostname must be localhost, 127.0.0.1 or [::1] (any port). */
export function isAllowedHost(hostHeader?: string | null): boolean {
  if (!hostHeader) return false
  const h = hostHeader.trim().toLowerCase()
  const m = h.match(/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/)
  return m !== null
}

/**
 * True when the Origin identifies a web page (http:/https: scheme, or the
 * literal "null"). Absent Origins and extension schemes are not web pages.
 */
export function isWebPageOrigin(origin?: string | null): boolean {
  if (origin == null) return false
  const o = origin.trim().toLowerCase()
  return o === 'null' || o.startsWith('http://') || o.startsWith('https://')
}

/**
 * True when the Origin uses a browser-extension scheme. A WebSocket from a real
 * Chrome/Edge/Firefox/Safari extension always carries one; a web page cannot
 * send one, and a plain loopback client (a native peer, a script) sends none.
 * A raw socket can still forge the header, so this is a filter, not a boundary.
 */
export function isExtensionOrigin(origin?: string | null): boolean {
  if (origin == null) return false
  const o = origin.trim().toLowerCase()
  return o.startsWith('chrome-extension://') || o.startsWith('moz-extension://') || o.startsWith('safari-web-extension://')
}

/** First 8 hex chars of sha256(token) — the only form of the token that may be logged. */
export function ownerFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

export const OWNER_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/
