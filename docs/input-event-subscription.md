# Design: Input Event Subscription (Streaming API)

**Status:** Proposed
**Owner:** @hammer
**Author:** Cody (webster-test session, 2026-04-13)
**Relates to:** `enriched-input-capture.md` — builds on the element-enriched input buffer

## Problem

`get_input_log` is a **poll-and-drain** API. To observe ongoing user activity, a client must:

1. Call `get_input_log` with `clear: true` on a timer (e.g., every 1s)
2. Process whatever events came back
3. Hope no events were missed between polls

This architecture has three real problems we hit while building `webster-test generate --live` against Safari:

### 1. Silent data loss

The content-script bridge has a **1-second timeout** (see `extension/content/content-script.js` line 72-74):

```js
function getInputEntries(clear = true, opts = {}) {
  return new Promise((resolve) => {
    pendingInputResolve = resolve
    window.postMessage({ type: 'WEBSTER_READ_INPUT', clear, ...opts }, '*')
    setTimeout(() => {
      if (pendingInputResolve) { pendingInputResolve([]); pendingInputResolve = null }
    }, 1000)
  })
}
```

If the page-script is momentarily slow (heavy page, tab backgrounded, extension under load), the timeout fires and **the caller receives `[]`** — even though the buffer has events. If `clear: true` was requested, the next poll *might* still get them, but if multiple timeouts compound, events can be permanently lost.

### 2. Poll jitter loses context

The `inputBuffer` holds up to 200 entries but events are appended in real time. If the user clicks rapidly and one poll takes slightly longer than another, clicks can arrive in the buffer in batches that don't match the user's intent. Worse, if the buffer overflows (`MAX_INPUT = 200`), old events are silently dropped via `inputBuffer.shift()`.

A user clicking through a UI flow should have every click captured in order. Polling can't guarantee that.

### 3. `pendingInputResolve` is a single slot

```js
let pendingInputResolve = null
// ...
pendingInputResolve = resolve
```

If a second call comes in before the first resolves, it overwrites the resolver. The first call's resolver is leaked and will eventually timeout to `[]`. This isn't a problem for the current poll-based usage (callers wait for the previous call), but it is brittle.

## Use Case

The concrete motivation: `webster-test generate --live` wants to **observe a user browsing** and turn it into a natural-language smoke test. We need to reliably capture:

- Every navigation (URL change)
- Every click (with element context)
- Every form change (with final value)
- Any console errors

…in order, with no drops. We don't care about mousemoves or keydowns. Polling with `clear: true` every 1s is the wrong pattern — we want a stream.

## Proposal

Add a **subscription API** that pushes events to the client as they happen, in addition to the existing `get_input_log` poll API. Two shapes:

### Shape A: Long-polling `get_input_log` with a `waitFor` parameter

Small, backwards-compatible change to the existing tool:

```
get_input_log({
  clear: true,                    // existing
  waitFor: "new_events",          // NEW: block until events arrive or timeout
  waitTimeoutMs: 5000,            // NEW: max wait before returning (default 5s)
  types: ["click", "change"],     // NEW: filter by event type server-side
  minTimestamp: 1776086035576,    // NEW: only events after this ms (for catchup)
})
```

When `waitFor: "new_events"` is set, the server holds the request open until either:
- New events arrive (matching `types` filter if provided) — return immediately
- `waitTimeoutMs` elapses — return whatever's buffered (may be empty)

This eliminates the "poll at the wrong time" problem. The client makes one call, blocks, gets the events, then calls again. No gaps.

### Shape B: Full SSE subscription (`subscribe_input`)

A new tool that opens an SSE stream from the server to the client:

```
subscribe_input({
  types: ["navigation", "click", "change", "console_error"],
  includeFrames: true,  // include iframe events
})
```

Returns an SSE endpoint URL the client can connect to. Each event pushed as it arrives. Client disconnects to unsubscribe.

This is cleaner but requires more server work and a different MCP tool surface.

## Recommendation

**Ship Shape A first** (long-polling `get_input_log`). It's:

- ~30 lines of change in `src/tools.ts` + `extension/content/*`
- Fully backwards-compatible (new parameters are optional)
- Solves the `webster-test generate --live` use case today
- Leaves the door open for Shape B later if demand shows up

Specifically:

1. **`types` filter** — in `page-script.js`, filter the buffer snapshot before returning. Client specifies `types: ["click", "change"]` and gets back only those, without mousemoves/keydowns polluting the payload.

2. **`minTimestamp` filter** — return only events with `t > minTimestamp`. Clients can track the last-seen timestamp and request events strictly after it. Combined with `clear: false`, this gives a "tail -f" semantic without needing `clear: true` at all.

3. **`waitFor: "new_events"`** — in the server's `get_input_log` handler, if the initial buffer read returns no matching events, hold the request and retry in a short loop (say, 100ms intervals) until events arrive or `waitTimeoutMs` elapses. The content-script bridge doesn't need to change — the server-side retry handles the wait.

## Why This Beats the Current Poll Pattern

Today's pattern (what `webster-test generate --live` is doing):

```js
while (watching) {
  const events = await getInputLog({ clear: true })  // may time out, return []
  for (const e of events) { ... }
  await sleep(1000)  // miss events that arrive between polls
}
```

With long-polling:

```js
let lastTs = Date.now()
while (watching) {
  const events = await getInputLog({
    clear: false,
    types: ["click", "change"],
    minTimestamp: lastTs,
    waitFor: "new_events",
    waitTimeoutMs: 5000,
  })
  for (const e of events) { ... }
  if (events.length > 0) lastTs = events[events.length - 1].t
}
```

- No `clear: true` → no race where a click lands *right* as we clear
- `minTimestamp` → we never see the same event twice
- `waitFor` → we get events as they arrive, not on a timer
- `types` → payloads are small, no mousemove noise

## Implementation Sketch

### `extension/content/page-script.js`

In the `WEBSTER_READ_INPUT` handler, apply `types` and `minTimestamp` filters before returning:

```js
if (event.data?.type === 'WEBSTER_READ_INPUT') {
  const clear = event.data.clear !== false
  const types = event.data.types  // optional string[] filter
  const minTs = event.data.minTimestamp  // optional number filter

  let entries = [...inputBuffer]
  if (types) entries = entries.filter(e => types.includes(e.type))
  if (typeof minTs === 'number') entries = entries.filter(e => e.t > minTs)

  if (clear) {
    // Only clear the entries we're returning — preserve the rest
    // (so a filter-by-type client doesn't wipe out events another client might want)
    const returnedIds = new Set(entries.map(e => e.t))
    for (let i = inputBuffer.length - 1; i >= 0; i--) {
      if (returnedIds.has(inputBuffer[i].t)) inputBuffer.splice(i, 1)
    }
  }

  // ... existing cursor overlay logic ...
  window.postMessage({ type: 'WEBSTER_INPUT_RESULT', entries }, '*')
}
```

**Note the clear behavior change:** if filters are applied, only filtered events are cleared. This lets different clients subscribe to different event types without stepping on each other. Unfiltered calls clear everything (backwards-compatible).

### `src/tools.ts`

In the `get_input_log` handler, implement the `waitFor` loop server-side:

```ts
execute: async (input) => {
  const waitFor = input.waitFor as string | undefined
  const waitTimeoutMs = (input.waitTimeoutMs as number) ?? 5000
  const types = input.types as string[] | undefined
  const minTimestamp = input.minTimestamp as number | undefined

  const start = Date.now()
  const poll = () => dispatch('getInputLog', {
    ...input,
    clear: input.clear ?? true,
    types,
    minTimestamp,
  })

  if (waitFor !== 'new_events') {
    return poll()  // existing behavior
  }

  // Long-poll: retry every 100ms until events arrive or timeout
  while (Date.now() - start < waitTimeoutMs) {
    const result = await poll()
    const entries = result.entries ?? []
    if (entries.length > 0) return result
    await new Promise(r => setTimeout(r, 100))
  }
  return { entries: [] }  // timed out with nothing
}
```

### `extension/content/content-script.js`

Pass the filter parameters through — currently already spreads `...opts`, so no change needed if we include them in `opts`:

```js
window.postMessage({ type: 'WEBSTER_READ_INPUT', clear, ...opts }, '*')
```

`opts` already carries arbitrary params; `types` and `minTimestamp` flow through.

### Tool Description Update

Add to `get_input_log` description:

> Supports server-side filtering via `types` (array of event types like `["click", "change"]`) and `minTimestamp` (only events after this ms). Use `waitFor: "new_events"` to long-poll — the call blocks until new matching events arrive or `waitTimeoutMs` (default 5000) elapses. This is more efficient than client-side polling for real-time observation.

## Testing

Unit tests in `src/__tests__/input-subscription.test.ts` (or similar):

1. `get_input_log` with no filters returns all events (backwards compatible)
2. `types: ["click"]` returns only click events
3. `minTimestamp: X` returns only events with `t > X`
4. `clear: true` + `types` filter only clears matched events
5. `waitFor: "new_events"` with no new events blocks for `waitTimeoutMs` then returns `[]`
6. `waitFor: "new_events"` returns immediately when new events arrive mid-wait

Integration: a mock browser test where we inject events programmatically and verify the long-poll fires when each arrives.

## Backwards Compatibility

- All new parameters (`waitFor`, `waitTimeoutMs`, `types`, `minTimestamp`) are optional
- Existing callers using `clear: true` with no filter continue to work identically
- The partial-clear behavior only activates when a filter is specified, preserving existing semantics for unfiltered calls

## Out of Scope (Follow-ups)

- **Shape B (SSE subscription)** — only if demand shows up. Long-polling covers most use cases.
- **Cross-tab event aggregation** — today `get_input_log` is per-tab. For recording sessions that span multiple tabs, a new endpoint would be needed.
- **Event replay** — capturing an event and replaying it back as a synthetic user event. Related but separate feature.

## Success Criteria

After this ships, `webster-test generate --live` should be able to:

1. Start a long-poll loop and receive every click/change as it happens, in order
2. Never miss a click due to poll timing
3. Not be polluted by mousemove/keydown noise (filter returns only `click` and `change`)
4. Produce `.smoke.md` tests that faithfully reproduce the user's actual browsing journey

The broader benefit: any Webster consumer that wants to observe user behavior (test recorders, accessibility checkers, session analytics) can now do so reliably.
