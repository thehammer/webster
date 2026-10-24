import type { BrowserKind, DriverState, Limitation, ToolSupport, WsCommand } from './protocol.js'

// The set of connected browsers and the per-session routing over it.
// Transport (sockets, polling, pending commands) stays in server.ts; this module
// only decides which browser a session's command reaches. See docs/browser-peers.md.

export interface ConnectedBrowser {
  id: string
  browser: string
  version: string
  transport: 'ws' | 'http'
  kind: BrowserKind
  /** null for every extension; the owner token for a webkit peer. Never exposed. */
  owner: string | null
  instanceId?: string
  /** Strictly increasing across connections, so ordering never ties. */
  connectedAt: number
  engine: string
  focus?: { tag: string; name: string }
  profile?: string
  driver?: DriverState
  limitations?: Limitation[]
  toolSupport?: Record<string, ToolSupport>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws?: any
  pollResolve?: ((cmd: WsCommand) => void) | null
}

/** What a session is currently pointed at. See docs/browser-peers.md (D2). */
export interface Binding {
  mode: 'explicit' | 'implicit'
  browserId: string
  kind: BrowserKind
  browserName: string
  instanceId?: string
  connectedAt: number
  label: string
  lostAt?: number
  goneReason?: string
  closed?: boolean
}

/** One MCP session (one Claude Code process, plus its subagents). */
export interface SessionContext {
  id: string
  owner: string | null
  binding: Binding | null
}

export interface BrowserInfo {
  id: string
  browser: string
  version: string
  transport: string
  active: boolean
  kind: BrowserKind
  engine: string
  focus?: { tag: string; name: string }
  profile?: string
  driver?: DriverState
  limitations?: Limitation[]
  toolSupport?: Record<string, ToolSupport>
}

const EXTENSION_ENGINES: Record<string, string> = {
  chrome: 'chromium', edge: 'chromium', firefox: 'gecko', safari: 'webkit',
}

export function engineForExtension(browser: string): string {
  return EXTENSION_ENGINES[browser] ?? 'unknown'
}

export function labelOf(b: ConnectedBrowser): string {
  return b.kind === 'webkit' ? `${b.browser}, focus "${b.focus?.name ?? ''}"` : b.browser
}

export function goneMessage(label: string, reason?: string): string {
  return `The selected browser is gone (${label}${reason ? `: ${reason}` : ''}): call get_browsers and set_browser`
}

const MAX_CLOSED_BROWSERS = 1000

export class BrowserRegistry {
  private browsers = new Map<string, ConnectedBrowser>()
  private lastConnectedAt = 0
  private sessions = new Map<string, SessionContext>()
  private ownerPins = new Map<string, string>() // owner token → pinned peer instanceId
  private closedBrowsers = new Map<string, string | undefined>() // unregistered peer id → reason

  // ─── Browsers ──────────────────────────────────────────────────────────

  /** Strictly increasing across calls, so connection order never ties. */
  nextConnectedAt(): number {
    this.lastConnectedAt = Math.max(Date.now(), this.lastConnectedAt + 1)
    return this.lastConnectedAt
  }

  add(browser: ConnectedBrowser): void {
    this.browsers.set(browser.id, browser)
  }

  remove(browser: ConnectedBrowser): void {
    this.browsers.delete(browser.id)
  }

  get(id: string): ConnectedBrowser | undefined {
    return this.browsers.get(id)
  }

  all(): ConnectedBrowser[] {
    return [...this.browsers.values()]
  }

  findByWs(ws: unknown): ConnectedBrowser | undefined {
    return this.all().find((b) => b.ws === ws)
  }

  hasWebkitInstance(instanceId: string): boolean {
    return this.all().some((b) => b.kind === 'webkit' && b.instanceId === instanceId)
  }

  /** The earliest-connected unowned browser. Owned peers are never the default. */
  serverDefault(): ConnectedBrowser | null {
    let best: ConnectedBrowser | null = null
    for (const b of this.browsers.values()) {
      if (b.owner === null && (!best || b.connectedAt < best.connectedAt)) best = b
    }
    return best
  }

  // ─── Sessions ──────────────────────────────────────────────────────────

  createSessionContext(owner: string | null): SessionContext {
    return { id: crypto.randomUUID() as string, owner, binding: null }
  }

  /** Start tracking a session; applies any pin its owner already has. */
  registerSession(ctx: SessionContext): void {
    this.sessions.set(ctx.id, ctx)
    const pinned = ctx.owner ? this.ownerPins.get(ctx.owner) : undefined
    if (!pinned) return
    const peer = this.all().find((b) => b.kind === 'webkit' && b.instanceId === pinned && b.owner === ctx.owner)
    if (peer) ctx.binding = this.makeBinding(peer, 'explicit')
  }

  forgetSession(id: string): void {
    this.sessions.delete(id)
  }

  /** A peer asked to be the selection for its owner: pin it and rebind that owner's sessions. */
  pinPeerForOwner(peer: ConnectedBrowser): void {
    if (!peer.owner || !peer.instanceId) return
    this.ownerPins.set(peer.owner, peer.instanceId)
    for (const ctx of this.sessions.values()) {
      if (ctx.owner === peer.owner) ctx.binding = this.makeBinding(peer, 'explicit')
    }
  }

  /** A peer deliberately left: remember it so nothing rebinds to it, then drop it. */
  unregisterPeer(peer: ConnectedBrowser, reason?: string): void {
    this.closedBrowsers.set(peer.id, reason)
    if (this.closedBrowsers.size > MAX_CLOSED_BROWSERS) this.closedBrowsers.delete(this.closedBrowsers.keys().next().value!)
    for (const ctx of this.sessions.values()) {
      if (ctx.binding?.browserId === peer.id) this.markClosed(ctx.binding, reason)
    }
    for (const [owner, instanceId] of this.ownerPins) {
      if (instanceId === peer.instanceId) this.ownerPins.delete(owner)
    }
    this.remove(peer)
  }

  // ─── Routing ───────────────────────────────────────────────────────────

  /** The browser this session's next command would reach, without binding anything. */
  peek(ctx: SessionContext): ConnectedBrowser | null {
    if (!ctx.binding) return this.serverDefault()
    return this.liveBound(ctx, ctx.binding) ?? this.rebindCandidate(ctx, ctx.binding)
  }

  /** Pick the browser for a command, fixing the binding on first use. Never falls back. */
  resolve(ctx: SessionContext): ConnectedBrowser {
    const binding = ctx.binding
    if (!binding) {
      const def = this.serverDefault()
      if (!def) throw new Error('Extension not connected')
      ctx.binding = this.makeBinding(def, 'implicit')
      return def
    }

    const live = this.liveBound(ctx, binding)
    if (live) {
      binding.label = labelOf(live)
      return live
    }

    if (this.closedBrowsers.has(binding.browserId) && !binding.closed) {
      this.markClosed(binding, this.closedBrowsers.get(binding.browserId))
    }
    binding.lostAt ??= Date.now()

    const next = this.rebindCandidate(ctx, binding)
    if (next) {
      ctx.binding = this.makeBinding(next, binding.mode)
      return next
    }
    throw new Error(goneMessage(binding.label, binding.goneReason))
  }

  /** Browsers visible to the session (or the unowned ones with no session), flagging the active one. */
  list(ctx?: SessionContext): BrowserInfo[] {
    const target = ctx ? this.peek(ctx) : this.serverDefault()
    return this.all()
      .filter((b) => (ctx ? this.isVisible(b, ctx) : b.owner === null))
      .map((b) => {
        const info: BrowserInfo = {
          id: b.id,
          browser: b.browser,
          version: b.version,
          transport: b.transport,
          active: b.id === target?.id,
          kind: b.kind,
          engine: b.engine,
        }
        if (b.kind === 'webkit') {
          info.focus = b.focus
          info.profile = b.profile
          info.driver = b.driver
          info.limitations = b.limitations
          if (b.toolSupport) info.toolSupport = b.toolSupport
        }
        return info
      })
  }

  /** Explicitly bind the session to a visible browser, by id or by browser name. */
  select(idOrBrowserName: string, ctx: SessionContext): BrowserInfo {
    if (!ctx) throw new Error('set_browser needs a session')
    const visible = this.all().filter((b) => this.isVisible(b, ctx))
    // Try exact id match first, then browser name match. Invisible browsers never match,
    // so a pane's existence doesn't leak to other focuses.
    const found = visible.find((b) => b.id === idOrBrowserName) ?? visible.find((b) => b.browser === idOrBrowserName)
    if (!found) {
      throw new Error(`No connected extension matching '${idOrBrowserName}'`)
    }

    ctx.binding = this.makeBinding(found, 'explicit')
    return this.list(ctx).find((b) => b.id === found.id)!
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private isVisible(browser: ConnectedBrowser, ctx: SessionContext): boolean {
    return browser.owner === null || browser.owner === ctx.owner
  }

  private makeBinding(b: ConnectedBrowser, mode: Binding['mode']): Binding {
    return {
      mode,
      browserId: b.id,
      kind: b.kind,
      browserName: b.browser,
      instanceId: b.instanceId,
      connectedAt: b.connectedAt,
      label: labelOf(b),
    }
  }

  private markClosed(binding: Binding, reason?: string): void {
    binding.closed = true
    binding.goneReason = reason
    binding.lostAt ??= Date.now()
  }

  private liveBound(ctx: SessionContext, binding: Binding): ConnectedBrowser | null {
    if (this.closedBrowsers.has(binding.browserId)) return null
    const b = this.browsers.get(binding.browserId)
    return b && this.isVisible(b, ctx) ? b : null
  }

  /**
   * The one browser a lost binding may come back to (D3), or null when there
   * is none or more than one. Pure — peek() relies on that.
   */
  private rebindCandidate(ctx: SessionContext, binding: Binding): ConnectedBrowser | null {
    if (binding.closed || this.closedBrowsers.has(binding.browserId)) return null
    const matches = this.all().filter((c) =>
      this.isVisible(c, ctx) &&
      c.kind === binding.kind &&
      c.browser === binding.browserName &&
      c.connectedAt > binding.connectedAt &&
      (binding.kind === 'webkit'
        ? binding.instanceId !== undefined && c.instanceId === binding.instanceId
        : !(binding.instanceId && c.instanceId) || binding.instanceId === c.instanceId))
    return matches.length === 1 ? matches[0] : null
  }
}
