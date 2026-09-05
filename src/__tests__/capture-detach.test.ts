/**
 * Tests for the CDP detach-during-capture meta event in
 * extension/background/command-handlers.js.
 *
 * Bug this guards against: when Chrome's debugger attaches successfully for a
 * deep-capture session and then LATER detaches (user dismisses the "Webster is
 * debugging this browser" infobar, DevTools is opened, the tab crashes, or the
 * tab closes), the extension's `chrome.debugger.onDetach` listener silently
 * removes the tab from `capturedTabs` and emits nothing. A capture that has
 * quietly stopped recording network data for that tab then looks byte-for-byte
 * identical to a healthy capture — there is no signal anywhere in the capture
 * stream that anything went wrong. This already happened once in production
 * and cost four months of misdiagnosis before anyone noticed the recording was
 * incomplete.
 *
 * The fix makes a mid-capture detach emit a `meta`/`cdp_detached` event into
 * the capture stream, mirroring the existing `cdp_unavailable` event emitted
 * when *attach* fails outright (see emitCaptureMeta at
 * extension/background/command-handlers.js:94-108, used at :144-146).
 *
 * `chrome.debugger.onDetach` fires globally for ANY debugger detach in the
 * browser — including the one-shot attach/detach performed by `withDebugger`
 * for commands like screenshot capture, which happens independently of
 * whether a deep-capture session is running. The listener must NOT emit for
 * those detaches; it must only emit when the detaching tab was actually held
 * by an active deep-capture session. Getting that guard wrong means either
 * silence on a real capture failure (the original bug) or noise on every
 * screenshot (a new, different bug) — this file pins both directions.
 *
 * `detachDecision` below mirrors the decision logic the real onDetach listener
 * must implement. It is pure and lives entirely in this test file per repo
 * convention (see safari-anchor-click.test.ts, input-enrichment.test.ts) —
 * extension/*.js is plain MV3 JS using chrome.* globals and isn't imported
 * into Bun tests. This function's behavior IS the contract; the extension
 * implementation must match it verbatim.
 */

import { describe, test, expect } from 'bun:test'

// ─── Pure decision logic (mirrors chrome.debugger.onDetach handling) ──────────

interface DetachState {
  captureActive: boolean
  capturedTabs: Set<number>
  capturedTabUrls: Map<number, string>
}

interface DetachEvent {
  code: string
  tabId: number
  url: string | null
  reason: string
}

interface DetachResult {
  emit: boolean
  event?: DetachEvent
}

// Mutates `state` directly (removes the tab from capturedTabs/capturedTabUrls
// when it was held) rather than returning removal instructions — this mirrors
// how the real listener owns those module-level collections directly, and
// keeps the test assertions simple: call once, then inspect the same objects.
function detachDecision(
  state: DetachState,
  source: { tabId: number },
  reason: string,
): DetachResult {
  const { tabId } = source

  // A detach on a tab that deep-capture never held (or no longer holds) is the
  // withDebugger one-shot attach/detach case — never emit for it, regardless
  // of whether some OTHER capture is active right now. This is the guard the
  // whole fix hinges on.
  if (!state.capturedTabs.has(tabId)) {
    return { emit: false }
  }

  // Tab was held, but capture has already been stopped (or a stale entry
  // survived a stop) — nothing live to warn about, so stay silent, but still
  // clean up the stale bookkeeping.
  if (!state.captureActive) {
    state.capturedTabs.delete(tabId)
    state.capturedTabUrls.delete(tabId)
    return { emit: false }
  }

  const url = state.capturedTabUrls.get(tabId) ?? null
  state.capturedTabs.delete(tabId)
  state.capturedTabUrls.delete(tabId)

  return {
    emit: true,
    event: { code: 'cdp_detached', tabId, url, reason },
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeState(overrides: Partial<DetachState> = {}): DetachState {
  return {
    captureActive: true,
    capturedTabs: new Set(),
    capturedTabUrls: new Map(),
    ...overrides,
  }
}

// ─── Held tab, capture active — the core "record the detach" case ────────────

describe('mid-capture detach on a held tab', () => {
  test('emits cdp_detached with reason canceled_by_user (infobar dismissed)', () => {
    const state = makeState({
      capturedTabs: new Set([7]),
      capturedTabUrls: new Map([[7, 'https://example.com/dashboard']]),
    })

    const result = detachDecision(state, { tabId: 7 }, 'canceled_by_user')

    expect(result.emit).toBe(true)
    expect(result.event).toEqual({
      code: 'cdp_detached',
      tabId: 7,
      url: 'https://example.com/dashboard',
      reason: 'canceled_by_user',
    })
  })

  test('emits cdp_detached with reason replaced_with_devtools (DevTools opened)', () => {
    const state = makeState({
      capturedTabs: new Set([12]),
      capturedTabUrls: new Map([[12, 'https://example.com/checkout']]),
    })

    const result = detachDecision(state, { tabId: 12 }, 'replaced_with_devtools')

    expect(result.emit).toBe(true)
    expect(result.event?.code).toBe('cdp_detached')
    expect(result.event?.reason).toBe('replaced_with_devtools')
    expect(result.event?.tabId).toBe(12)
    expect(result.event?.url).toBe('https://example.com/checkout')
  })

  test('passes through target_closed and render_process_gone reasons verbatim', () => {
    for (const reason of ['target_closed', 'render_process_gone']) {
      const state = makeState({
        capturedTabs: new Set([1]),
        capturedTabUrls: new Map([[1, 'https://example.com/']]),
      })
      const result = detachDecision(state, { tabId: 1 }, reason)
      expect(result.event?.reason).toBe(reason)
    }
  })

  test('removes the tab from capturedTabs and capturedTabUrls after detach', () => {
    const state = makeState({
      capturedTabs: new Set([7, 9]),
      capturedTabUrls: new Map([[7, 'https://example.com/a'], [9, 'https://example.com/b']]),
    })

    detachDecision(state, { tabId: 7 }, 'canceled_by_user')

    expect(state.capturedTabs.has(7)).toBe(false)
    expect(state.capturedTabUrls.has(7)).toBe(false)
    // Untouched tab is unaffected
    expect(state.capturedTabs.has(9)).toBe(true)
    expect(state.capturedTabUrls.get(9)).toBe('https://example.com/b')
  })

  test('held tab with no recorded URL emits url: null, not undefined or omitted', () => {
    const state = makeState({
      capturedTabs: new Set([3]),
      capturedTabUrls: new Map(), // tab attached but URL was never recorded
    })

    const result = detachDecision(state, { tabId: 3 }, 'target_closed')

    expect(result.emit).toBe(true)
    expect(result.event).toBeDefined()
    expect('url' in (result.event as DetachEvent)).toBe(true)
    expect(result.event?.url).toBeNull()
  })
})

// ─── The critical safety guard: withDebugger one-shot detaches must never emit ──

describe('one-shot withDebugger detach (not part of an active deep-capture session)', () => {
  test('tab not in capturedTabs — never emits, even while a capture is active elsewhere', () => {
    // This is the single most important case: chrome.debugger.onDetach fires
    // globally, so a screenshot's temporary attach/detach on tab 99 must not
    // be mistaken for a deep-capture failure, even though captureActive is
    // true because some OTHER tab (42) is genuinely being captured.
    const state = makeState({
      captureActive: true,
      capturedTabs: new Set([42]),
      capturedTabUrls: new Map([[42, 'https://example.com/other-tab']]),
    })

    const result = detachDecision(state, { tabId: 99 }, 'target_closed')

    expect(result.emit).toBe(false)
    expect(result.event).toBeUndefined()
    // The genuinely-captured tab's bookkeeping must be untouched.
    expect(state.capturedTabs.has(42)).toBe(true)
    expect(state.capturedTabUrls.get(42)).toBe('https://example.com/other-tab')
  })

  test('tab not in capturedTabs and no capture running — never emits', () => {
    const state = makeState({ captureActive: false, capturedTabs: new Set() })

    const result = detachDecision(state, { tabId: 5 }, 'canceled_by_user')

    expect(result.emit).toBe(false)
    expect(result.event).toBeUndefined()
  })
})

// ─── Capture inactive entirely — never emit even with stale bookkeeping ───────

describe('detach when capture is not active', () => {
  test('captureActive is false — no emit even if tab is (stale) in capturedTabs', () => {
    const state = makeState({
      captureActive: false,
      capturedTabs: new Set([7]),
      capturedTabUrls: new Map([[7, 'https://example.com/stale']]),
    })

    const result = detachDecision(state, { tabId: 7 }, 'target_closed')

    expect(result.emit).toBe(false)
    expect(result.event).toBeUndefined()
  })

  test('stale bookkeeping is still cleaned up even though nothing is emitted', () => {
    const state = makeState({
      captureActive: false,
      capturedTabs: new Set([7]),
      capturedTabUrls: new Map([[7, 'https://example.com/stale']]),
    })

    detachDecision(state, { tabId: 7 }, 'target_closed')

    expect(state.capturedTabs.has(7)).toBe(false)
    expect(state.capturedTabUrls.has(7)).toBe(false)
  })
})

// ─── Distinguishing cdp_detached from its attach-failure sibling cdp_unavailable ──

describe('cdp_detached vs cdp_unavailable — different failure modes', () => {
  test('a mid-capture detach is coded cdp_detached, never cdp_unavailable', () => {
    const state = makeState({
      capturedTabs: new Set([1]),
      capturedTabUrls: new Map([[1, 'https://example.com/']]),
    })

    const result = detachDecision(state, { tabId: 1 }, 'canceled_by_user')

    expect(result.event?.code).toBe('cdp_detached')
    expect(result.event?.code).not.toBe('cdp_unavailable')
  })

  test('cdp_unavailable (attach never worked) and cdp_detached (attach revoked later) are distinct codes', () => {
    // cdp_unavailable is emitted from attachDebuggerToTab when both attach()
    // and Network.enable() fail outright — the session never had bodies for
    // that tab in the first place. cdp_detached means capture WAS working and
    // then stopped. Downstream analysis (e.g. "was this capture ever healthy
    // for this tab?") depends on telling these apart.
    const attachFailureCode = 'cdp_unavailable'
    const state = makeState({
      capturedTabs: new Set([1]),
      capturedTabUrls: new Map([[1, 'https://example.com/']]),
    })
    const detachResult = detachDecision(state, { tabId: 1 }, 'replaced_with_devtools')

    expect(detachResult.event?.code).not.toBe(attachFailureCode)
    expect(detachResult.event?.code).toBe('cdp_detached')
  })
})
