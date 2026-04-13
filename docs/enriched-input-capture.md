# Design: Enriched Input Capture

**Status:** Proposed
**Owner:** @hammer
**Author:** Cody (webster-test session, 2026-04-13)
**Relates to:** [`webster-test`](../../webster-test) — natural language smoke test framework

## Problem

Webster's `get_input_log` tool captures mouse and keyboard events with coordinates and timing, but **no element context**. An entry looks like:

```json
{ "type": "click", "x": 142, "y": 88, "button": "left", "t": 1776044187310 }
```

This is enough to *replay* input events programmatically, but not enough to *understand* them. We have no idea what the user clicked — was it a nav link? A button? A device tile? Was there text on it?

This limits Webster's usefulness for anything that needs to **interpret** user actions:

- Converting a recorded session into a natural-language test (`webster-test generate --live`)
- Explaining what a user just did (for agents reviewing a session)
- Generating stable selectors from observed interactions
- Building a "session story" from captured events

## Current Workarounds and Their Limits

The `webster-test` framework tried to work around this by **polling `get_page_info`** every 1.5 seconds to detect navigation changes. This works for page-level navigation but misses:

- Mid-page interactions (clicking a dropdown, typing in a search box, toggling a tab)
- Fast navigations (back within the poll window)
- SPA route changes that don't change the URL
- Form submissions

The Chrome Debugger Protocol-based `start_capture` solves this **but only on Chrome/Edge**. Safari and Firefox users are left without a path.

## Proposal

Enrich the input events captured by `page-script.js` with DOM context at the moment the event fires. Content scripts can do this with standard DOM APIs — no debugger, no privileged access — so it works in **all browsers**.

### What Changes

In `extension/content/page-script.js`, the `click` and keyboard event listeners currently push events with only coordinates. Expand them to include:

```js
document.addEventListener('click', (e) => {
  const el = e.target
  pushInput({
    type: 'click',
    x: e.clientX,
    y: e.clientY,
    button: 'left',
    t: Date.now(),
    // ── NEW: element context ──
    element: describeElement(el),
  })
}, { capture: true, passive: true })
```

Where `describeElement` is a cheap helper returning:

```ts
interface ElementDescriptor {
  tag: string              // e.g. "A", "BUTTON", "INPUT"
  id?: string              // element id if present
  classes?: string         // className string if present (first ~100 chars)
  text?: string            // innerText trimmed and truncated to 120 chars
  href?: string            // for anchors
  role?: string            // aria role
  ariaLabel?: string       // aria-label
  name?: string            // name attribute (forms)
  placeholder?: string     // placeholder attribute
  testId?: string          // data-testid attribute
  xpath?: string           // stable XPath as last-resort selector
}
```

For `keydown` events when the target is an input/textarea, include the target's field context (name, label, placeholder) — but **not** the value being typed (privacy/security; values can come from `change` events on blur if we want them).

Add a separate `change` event handler for form fields, so we capture final values after the user finishes typing:

```js
document.addEventListener('change', (e) => {
  const el = e.target
  if (el.matches('input, textarea, select')) {
    pushInput({
      type: 'change',
      t: Date.now(),
      element: describeElement(el),
      value: safeValue(el),  // masked for password fields
    })
  }
}, { capture: true, passive: true })
```

### What Doesn't Change

- The existing input log shape (add fields; never remove or rename)
- The `get_input_log` MCP tool API (same call, richer payload)
- Event buffering limits (`MAX_INPUT` stays as-is)
- Chrome Debugger Protocol capture (orthogonal — can still layer on top)

## Implementation Sketch

### `extension/content/page-script.js`

Add a `describeElement` helper near the input buffer:

```js
const MAX_TEXT = 120
const MAX_CLASSES = 100

function describeElement(el) {
  if (!el || el.nodeType !== 1) return null
  const desc = { tag: el.tagName }
  if (el.id) desc.id = el.id
  const cls = typeof el.className === 'string' ? el.className : el.className?.baseVal
  if (cls) desc.classes = cls.slice(0, MAX_CLASSES)
  const text = el.innerText?.trim()
  if (text) desc.text = text.slice(0, MAX_TEXT)
  if (el.href) desc.href = el.href
  if (el.getAttribute('role')) desc.role = el.getAttribute('role')
  if (el.getAttribute('aria-label')) desc.ariaLabel = el.getAttribute('aria-label')
  if (el.getAttribute('data-testid')) desc.testId = el.getAttribute('data-testid')
  if (el.name) desc.name = el.name
  if (el.placeholder) desc.placeholder = el.placeholder
  desc.xpath = computeXPath(el)
  return desc
}

function computeXPath(el) {
  // Simple XPath generator — prefers id when available
  if (el.id) return `//*[@id="${el.id}"]`
  const parts = []
  let current = el
  while (current && current.nodeType === 1 && current !== document.body) {
    let sibling = current
    let index = 1
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === current.tagName) index++
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`)
    current = current.parentElement
  }
  return '/' + parts.join('/')
}

function safeValue(el) {
  if (el.type === 'password') return '***'
  const v = el.value
  if (typeof v !== 'string') return ''
  return v.slice(0, 500)  // cap length
}
```

Update the existing `click`, `mousedown`, `mouseup`, `keydown`, `keyup` handlers to attach `element: describeElement(e.target)`.

Add the new `change` handler for final form values.

**Performance:** `describeElement` is O(ancestor depth) for XPath, O(1) for the rest. Fires once per click/keydown — no measurable impact on page interaction.

### `extension/content/content-script.js`

No changes required — it just relays buffered entries through the existing `WEBSTER_INPUT_RESULT` / `WEBSTER_DRAIN_CAPTURE_RESULT` messages, which pass opaque JSON.

### `src/tools.ts`

The `get_input_log` tool description should be updated to mention that entries now include element context. No schema change needed; add a line to the description like:

> Returns events with element context (tag, text, href, role, aria-label, testid, xpath) for clicks and form interactions.

### Safari

Safari's extension runs the same content scripts via the shim in `extension/background/safari-service-worker.js`. Since `describeElement` uses only standard DOM APIs, Safari support is **free** — no additional Safari-specific code.

## Privacy & Security

- **Passwords are masked** in `change` values (`"***"` when `type === 'password'`)
- **Typed keystrokes are not captured in clear** — only the final `change` value, and only for form fields
- **Text content is truncated** to 120 chars to prevent huge payloads on content-rich elements
- **No screenshots or network data** change with this proposal

## Migration

Zero breaking changes:

- Existing consumers of `get_input_log` see the same events with additional optional fields
- `webster-test` picks up the new `element` field automatically in its generator
- Old captures without enriched data continue to work

## Testing

Add tests in `src/__tests__/tools.test.ts` or a new `extension/content/__tests__/input-enrichment.test.js`:

1. Click a button → entry has `element.tag === "BUTTON"` and `element.text`
2. Click an anchor → entry has `element.href`
3. Click an element with `data-testid` → entry includes `element.testId`
4. Click an element inside a shadow DOM (known limitation — document what happens)
5. Click an element with no id, class, or text → entry still has `element.xpath`
6. Type in a password field → `change` event has `value === "***"`
7. Type in a regular input → `change` event has actual value, capped at 500 chars

Manual smoke test: open any site, click a few things, call `get_input_log`, verify entries are human-readable.

## Out of Scope (Follow-ups)

- **Scroll tracking** — would be useful but separate feature
- **Focus/blur events** — useful for form flow analysis
- **Shadow DOM traversal** — harder; requires walking `shadowRoot` chain
- **Cross-origin iframe events** — content scripts can't reach these; document the limit

## Success Criteria

After this lands, `webster-test generate --live` on Safari should be able to:

1. Capture a user clicking "Cameras" in the nav → generate a step "Click the 'Cameras' link in the navigation"
2. Capture a user typing into a search box → generate "Type 'maisie' into the search field"
3. Capture a navigation sequence → generate accurate `Navigate to...` steps

More broadly: any Webster consumer can inspect `get_input_log` and tell a human-readable story about what the user did, without needing pixel coordinates or the Chrome Debugger Protocol.
