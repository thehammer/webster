/**
 * Tests for the stop_capture debugger-detach ordering bug in
 * extension/background/command-handlers.js.
 *
 * Bug: the `stopCapture` command handler clears the bookkeeping BEFORE it
 * asks Chrome to actually detach the debugger:
 *
 *   // extension/background/command-handlers.js:1437-1441
 *   const tabsToDetach = [...capturedTabs]
 *   capturedTabs.clear()
 *   capturedTabUrls.clear()
 *   await Promise.allSettled(tabsToDetach.map(tabId => detachDebuggerFromTab(tabId)))
 *
 * `tabsToDetach` is snapshotted first, so that part is fine — but
 * `detachDebuggerFromTab` itself guards on membership in the very set that
 * was just cleared:
 *
 *   // extension/background/command-handlers.js:165-171
 *   async function detachDebuggerFromTab(tabId) {
 *     if (!capturedTabs.has(tabId)) return
 *     try {
 *       await chrome.debugger.detach({ tabId })
 *     } catch { /* ignore *\/ }
 *     forgetCapturedTab(tabId)
 *   }
 *
 * Because `capturedTabs.clear()` ran on line 1439, every call in the
 * `.map(...)` on line 1441 sees an empty `capturedTabs`, hits the guard on
 * line 166, and returns immediately. `chrome.debugger.detach()` is never
 * called. The real CDP session is never released: Chrome's "Webster started
 * debugging this browser" infobar never goes away, and the debugger stays
 * attached to the tab indefinitely after the user believes capture has
 * stopped.
 *
 * Per repo convention (see safari-anchor-click.test.ts,
 * input-enrichment.test.ts, capture-detach.test.ts), this file mirrors the
 * relevant extension logic as pure TypeScript functions rather than
 * importing command-handlers.js — extension/*.js is plain MV3 JS built
 * around chrome.* globals and is never imported into Bun tests. The mirror
 * below IS the contract: it encodes the CORRECT ordering (detach while the
 * tab is still tracked, clear after), and the real extension code must be
 * brought to match it verbatim — not the other way around.
 *
 * Three pieces are mirrored together, not in isolation, because they
 * causally interact and a test that only exercises one at a time can miss
 * an ordering bug like this one:
 *
 *   - `detachTab`          mirrors the FIXED `detachDebuggerFromTab`
 *   - `onDetachListener`   mirrors the FIXED `chrome.debugger.onDetach`
 *                          listener (see capture-detach.test.ts, which
 *                          already encodes its `captureActive` guard as the
 *                          contract — that guard is a sibling fix Cody will
 *                          make separately, not something touched here)
 *   - `stopCaptureTeardown` mirrors the CORRECT stop sequence end to end
 *
 * `detachTab` synchronously invokes `onDetachListener` as part of detaching,
 * because `chrome.debugger.onDetach` fires as a real consequence of a real
 * `chrome.debugger.detach()` call — a mirror that skipped straight to
 * cleanup without modeling that causality would miss the exact half of this
 * bug (a naive fix that reorders the two lines but doesn't also add the
 * `captureActive` guard to the real onDetach listener would start emitting a
 * spurious `cdp_detached` warning on every clean stop).
 */

import { describe, test, expect } from 'bun:test'

// ─── Pure mirror of the stop-capture detach sequence ──────────────────────

interface CaptureState {
  captureActive: boolean
  capturedTabs: Set<number>
  capturedTabUrls: Map<number, string>
}

interface StopOutcome {
  detached: number[] // tabIds chrome.debugger.detach() was actually called for, in call order
  metaEmitted: Array<{ code: string; tabId: number }> // cdp_detached meta events emitted during the stop
}

// Mirrors the FIXED chrome.debugger.onDetach listener: only warn about a
// detach when the tab was genuinely held by an active deep-capture session.
// (This guard is the contract already pinned in capture-detach.test.ts —
// the real listener doesn't have it yet, that's a separate fix.)
function onDetachListener(state: CaptureState, tabId: number, outcome: StopOutcome): void {
  if (state.capturedTabs.has(tabId) && state.captureActive) {
    outcome.metaEmitted.push({ code: 'cdp_detached', tabId })
  }
}

// Mirrors the FIXED detachDebuggerFromTab: the guard must be checked against
// bookkeeping that is still intact at call time (the bug is that the real
// code clears it first). `simulateDetachFailure` models a rejected
// `chrome.debugger.detach()` call (e.g. "Debugger is not attached") — the
// real code's `try { await detach() } catch { /* ignore */ }` swallows this
// and falls through to cleanup unconditionally, so the mirror does too.
function detachTab(
  state: CaptureState,
  tabId: number,
  outcome: StopOutcome,
  simulateDetachFailure = false,
): void {
  if (!state.capturedTabs.has(tabId)) return

  // chrome.debugger.detach() was actually invoked for this tab — this is the
  // fundamental "capture must actually be released" assertion the whole bug
  // is about.
  outcome.detached.push(tabId)

  if (!simulateDetachFailure) {
    // A real detach() call causes Chrome to fire onDetach; a rejected call
    // never actually detached anything, so no onDetach fires from it.
    onDetachListener(state, tabId, outcome)
  }

  // Cleanup runs regardless of whether the detach call succeeded or
  // rejected — one failing tab must not leave stale bookkeeping behind, and
  // must not prevent the rest of the batch from being processed.
  state.capturedTabs.delete(tabId)
  state.capturedTabUrls.delete(tabId)
}

// Mirrors the CORRECT stop sequence: flip captureActive off, THEN detach
// each currently-tracked tab (which reads capturedTabs before it's touched),
// THEN clear both collections defensively (belt-and-suspenders — detachTab
// already removed each tab it processed individually).
function stopCaptureTeardown(state: CaptureState, failingTabs: Set<number> = new Set()): StopOutcome {
  const outcome: StopOutcome = { detached: [], metaEmitted: [] }

  state.captureActive = false

  const tabsToDetach = [...state.capturedTabs]
  for (const tabId of tabsToDetach) {
    detachTab(state, tabId, outcome, failingTabs.has(tabId))
  }

  state.capturedTabs.clear()
  state.capturedTabUrls.clear()

  return outcome
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeState(overrides: Partial<CaptureState> = {}): CaptureState {
  return {
    captureActive: true,
    capturedTabs: new Set(),
    capturedTabUrls: new Map(),
    ...overrides,
  }
}

// ─── The core bug: stop must actually release every captured tab ─────────

describe('stop_capture debugger-detach teardown', () => {
  test('stopping capture actually detaches every captured tab', () => {
    const state = makeState({
      capturedTabs: new Set([1, 2, 3]),
      capturedTabUrls: new Map([
        [1, 'https://example.com/a'],
        [2, 'https://example.com/b'],
        [3, 'https://example.com/c'],
      ]),
    })

    const outcome = stopCaptureTeardown(state)

    expect(outcome.detached).toContain(1)
    expect(outcome.detached).toContain(2)
    expect(outcome.detached).toContain(3)
    expect(outcome.detached).toHaveLength(3)
  })

  test('capturedTabs and capturedTabUrls are both empty after teardown', () => {
    const state = makeState({
      capturedTabs: new Set([1, 2, 3]),
      capturedTabUrls: new Map([
        [1, 'https://example.com/a'],
        [2, 'https://example.com/b'],
        [3, 'https://example.com/c'],
      ]),
    })

    stopCaptureTeardown(state)

    expect(state.capturedTabs.size).toBe(0)
    expect(state.capturedTabUrls.size).toBe(0)
  })

  test('a clean stop emits no spurious cdp_detached warnings', () => {
    // captureActive is flipped false before any tab is detached, so the
    // onDetach listener's guard must suppress every one of these — a naive
    // fix that only reorders the clear-vs-detach lines (without also
    // guarding the onDetach listener on captureActive) would start emitting
    // a warning here on every single clean stop.
    const state = makeState({
      capturedTabs: new Set([1, 2, 3]),
      capturedTabUrls: new Map([
        [1, 'https://example.com/a'],
        [2, 'https://example.com/b'],
        [3, 'https://example.com/c'],
      ]),
    })

    const outcome = stopCaptureTeardown(state)

    expect(outcome.detached).toHaveLength(3)
    expect(outcome.metaEmitted).toEqual([])
  })

  test('tearing down with no captured tabs is a no-op', () => {
    const state = makeState({ capturedTabs: new Set(), capturedTabUrls: new Map() })

    const outcome = stopCaptureTeardown(state)

    expect(outcome.detached).toEqual([])
    expect(outcome.metaEmitted).toEqual([])
    expect(state.capturedTabs.size).toBe(0)
  })

  test('calling teardown twice is idempotent — the second call detaches nothing new', () => {
    const state = makeState({
      capturedTabs: new Set([1, 2, 3]),
      capturedTabUrls: new Map([
        [1, 'https://example.com/a'],
        [2, 'https://example.com/b'],
        [3, 'https://example.com/c'],
      ]),
    })

    const first = stopCaptureTeardown(state)
    expect(first.detached).toHaveLength(3)

    const second = stopCaptureTeardown(state)
    expect(second.detached).toEqual([])
    expect(second.metaEmitted).toEqual([])
  })

  test('one tab whose detach rejects does not abort or block cleanup of the others', () => {
    const state = makeState({
      capturedTabs: new Set([1, 2, 3]),
      capturedTabUrls: new Map([
        [1, 'https://example.com/a'],
        [2, 'https://example.com/b'],
        [3, 'https://example.com/c'],
      ]),
    })

    // Tab 2's chrome.debugger.detach() call rejects (e.g. "Debugger is not
    // attached"); the real code's Promise.allSettled + swallowed catch means
    // this must not prevent tabs 1 and 3 from being detached and cleaned up.
    const outcome = stopCaptureTeardown(state, new Set([2]))

    expect(outcome.detached).toContain(1)
    expect(outcome.detached).toContain(3)
    expect(state.capturedTabs.has(1)).toBe(false)
    expect(state.capturedTabs.has(3)).toBe(false)
    // The failing tab's own bookkeeping is still released...
    expect(state.capturedTabs.has(2)).toBe(false)
    expect(state.capturedTabUrls.has(2)).toBe(false)
    // ...and detach() was still attempted for it (it just didn't succeed).
    expect(outcome.detached).toContain(2)
  })
})
