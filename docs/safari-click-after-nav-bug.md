# Bug: Safari Clicks on Hash-Nav Links Not Captured

**Status:** Reported
**Reporter:** Cody (webster-test session, 2026-04-13)
**Browser:** Safari (macOS, via Webster.app extension)
**Related:** `enriched-input-capture.md`, `input-event-subscription.md`

## Summary

After the enriched input capture and long-polling subscription API landed, live browsing sessions via `webster-test generate --live` are reliably capturing:

- ✅ Hash navigation URL changes (via `get_page_info` polling)
- ✅ The long-poll `get_input_log` bridge itself (we received events through it)
- ✅ Programmatic clicks from `mcp__webster__click` (full element context)
- ✅ Physical clicks on non-anchor elements (e.g., `<button class="bsp-back">← Dashboard</button>`)

But **failing to capture:**

- ❌ Physical clicks on `<a href="#...">` nav links that trigger SPA hash navigation

In a test session with the Maisie dashboard, the user clicked the Media, TV, Dashboard, and Cameras nav links sequentially. The framework saw the resulting hash changes (`#media`, `#tv`, `#dashboard`, `#cameras`) but received **zero click events** for those anchor clicks. A single click on a non-anchor element (a generic `div`) was captured correctly.

## What We Know Works

Earlier in the same extension install, we verified:

1. A diagnostic `document.addEventListener('click', ..., { capture: true, passive: true })` installed via `eval_js` in the main world **did fire** on the user's physical click of `<button class="bsp-back">← Dashboard</button>` — `isTrusted: true`, correct target info. This proves Safari is routing real user clicks to document-level listeners in the main world.

2. After that click, `get_input_log` returned a rich buffer with `mousedown`, `mouseup`, and `click` entries for the button press, each with full element descriptors (tag, classes, text, xpath).

3. The long-poll API (`waitFor: "new_events"` + `types: ["click","change"]` + `minTimestamp`) delivered the first captured click correctly — the bridge is functional.

So the capture infrastructure is sound. The specific failure is narrower: **physical anchor clicks that trigger hash navigation on Safari don't land in `inputBuffer`.**

## Reproduction

1. Rebuild and install the Safari extension:
   ```
   ./scripts/build-extension.sh --safari --run
   ```
2. Open Safari on any SPA that uses hash-based nav (e.g., `https://maisie.example.com`)
3. Drain the input log: programmatically call `get_input_log` with `clear: true`
4. Start polling with `get_input_log({ types: ["click"], waitFor: "new_events", minTimestamp: X })`
5. Manually click an `<a href="#something">` nav link
6. Observe: hash changes, but no click event surfaces in the poll response

For comparison, clicking a `<button>` on the same page **does** surface events.

## Likely Causes to Investigate

Ordered by what an implementer should try first:

### 1. Race between click dispatch and hash navigation on Safari

Safari may be dispatching the anchor's default navigation synchronously *before* our `{ capture: true, passive: true }` listener gets a chance to push to the buffer. The capture phase should fire first per the spec, but Safari's scheduling of synthetic history changes on anchor clicks may deviate.

**Diagnostic:** Add a `console.log` (or a buffer push to a separate `__websterDebugLog` array) as the first statement in the document-level click listener in `extension/content/page-script.js`. Click an anchor — does the log fire? If yes, the listener ran but the `pushInput` didn't reach the buffer. If no, the listener didn't fire at all on Safari for anchor clicks.

### 2. Page-script closure being torn down or replaced on hash change

Although hash changes don't reload the page, Safari content-script lifecycle may differ from Chrome. If the extension re-injects content-script on a `webNavigation.onHistoryStateUpdated`-equivalent event (SPA nav), the new page-script would have a fresh empty `inputBuffer`. Events that fired during the transition would be lost.

**Diagnostic:** Expose `inputBuffer.length` via a debug global (`window.__websterInputBufferLen = () => inputBuffer.length`). Before clicking a nav link, check the value. Click. Check immediately. If the length reset to 0 at some point, the closure was replaced.

### 3. Safari extension API not delivering the click before relaying navigation

If the content script communication is funneled through the extension messaging layer before reaching the server, Safari's messaging may reorder or drop messages when the page is mid-navigation. The click event is buffered locally in the page-script (no messaging involved for the push), but the `WEBSTER_READ_INPUT` / `WEBSTER_INPUT_RESULT` round-trip between content-script and page-script does use `postMessage`. If Safari processes a navigation at the moment the content-script is polling, messages could be dropped.

**Diagnostic:** In `extension/content/content-script.js`, log every inbound `WEBSTER_INPUT_RESULT` message with a timestamp. Have a page open, let webster-test poll, and manually click an anchor. Did the `WEBSTER_INPUT_RESULT` arrive after the click? What did it contain?

### 4. Maisie-specific handler

The app may be attaching a click handler on the nav link that calls `e.stopImmediatePropagation()` before the capture phase reaches our listener. Unlikely to defeat a `{ capture: true }` listener on `document`, but worth checking in one specific app.

**Diagnostic:** Reproduce against a non-Maisie SPA (e.g., a vanilla React Router demo with hash routing). If the bug persists, it's not Maisie. If it doesn't reproduce, it's an app-specific handler issue and we can document it as a known limit.

## Expected Behavior

When the user clicks `<a href="#cameras">Cameras</a>`, `get_input_log` (with no filter or with `types: ["click"]`) should return an entry like:

```json
{
  "type": "click",
  "x": 197, "y": 41,
  "t": 1776086035576,
  "button": "left",
  "element": {
    "tag": "A",
    "text": "Cameras",
    "href": "https://example.com/#cameras",
    "classes": "nav-link",
    "xpath": "/div[1]/div[1]/div[1]/div[1]/nav[1]/a[3]"
  }
}
```

…regardless of whether the click also triggered a hash navigation, and regardless of how fast the navigation completes after the click.

## Acceptance Criteria

After the fix, a test session like this should capture both navigations and all clicks:

```
webster-test generate --live
# user clicks Media → captured as click: "Cameras" (a) with href
# hash changes to #media → captured as navigation
# repeat for TV, Dashboard, Cameras
```

Expected: 4+ click events + 4+ navigation events. Current: 4 navigations, 1 click (the non-anchor one).

## Why This Matters

The capture-to-test generator's accuracy depends on observing every user action. Missing anchor clicks means we lose the semantic label of WHAT the user was navigating to — we see that they went to `#media` but not that they clicked something labeled "Media". Hash changes alone are recoverable but the generated tests are less intent-rich than they should be.

This is also a trust issue: if a user is manually testing a flow and Webster silently drops their anchor clicks, any session recording or reconstruction based on Webster's input log will be incomplete without warning.

## Out of Scope

- **Non-hash SPA routing (pushState without hash)** — potentially has the same bug but hasn't been tested. Worth checking after this is fixed.
- **Chrome/Firefox behavior** — unverified. If those browsers don't exhibit this issue, great; if they do, the fix should cover them too.
