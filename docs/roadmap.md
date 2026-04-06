# Webster Feature Roadmap

Goal: functional parity with (and superiority over) Anthropic's Claude-in-Chrome extension, while preserving Webster's unique strengths — multi-browser routing, CSS selector automation, `wait_for`, localStorage, cookies, network ring buffer.

Marketplace/distribution improvements are explicitly out of scope for now.

---

## Phase 1 — Accessibility Tree *(foundation for phases 2–4)*

**What:** Expose the browser's built-in semantic element tree — the same structure screen readers use. Every element gets a role, name, state, bounds, and a stable ref string. More reliable than CSS selectors for understanding what's interactive.

**Files changed:**
- `extension/manifest.json` — add `"accessibility"` permission
- `extension/background/command-handlers.js` — add `getAccessibilityTree` case using `chrome.automation.getTree(tabId, callback)`
- `src/tools.ts` — add `get_accessibility_tree` tool

**New tool:** `get_accessibility_tree`
- Parameters: `tabId?`, `depth?` (default 10), `filter?: "all" | "interactive"`
- `"interactive"` filter prunes to buttons, links, inputs, combos, checkboxes, etc.

**Key implementation notes:**
- `AutomationNode` objects are live references — serialize immediately, don't store them
- Ref encoding: `role:name:left,top,width,height` — deterministic, survives SW restarts
- Chrome/Edge only — Safari and Firefox return `{success: false, error: "not supported on this browser"}` gracefully

---

## Phase 2 — Coordinate/Pixel Clicking

**What:** Click at (x, y) coordinates using `chrome.debugger` to dispatch real mouse events at the OS level. Works on canvas, SVG, WebGL, and anything without a DOM selector.

**Files changed:**
- `extension/manifest.json` — add `"debugger"` permission
- `extension/background/command-handlers.js` — add `clickCoordinate` and `clickRef` cases
- `src/tools.ts` — add `click_at` and `click_ref` tools

**New tools:**
- `click_at` — parameters: `x: number`, `y: number`, `tabId?`
- `click_ref` — parameters: `ref: string` (from accessibility tree), `tabId?` — re-walks tree, clicks center of matching node's bounds

**Implementation:** attach `chrome.debugger` per-command, dispatch `mousePressed` + `mouseReleased`, detach immediately. Never hold a persistent debugger attachment (shows warning banner to user, breaks DevTools).

---

## Phase 3 — Selector Fallback

**What:** When a CSS selector fails, automatically fall back to the accessibility tree. Improves reliability of existing `click` and `type` tools on complex SPAs without changing their interface.

**Files changed:**
- `extension/background/command-handlers.js` — when content script returns `selector_not_found`, attempt a11y tree search
- `extension/content/content-script.js` — return structured `selector_not_found` error code

**No new tools** — this makes existing `click` and `type` more resilient. Optionally expose `fallback?: boolean` parameter to opt in/out.

**Fallback strategy:** strip `#`/`.` from selector, split on `-_`, use as search tokens against a11y tree node names. Click the best-scoring match via `clickCoordinate`.

---

## Phase 4 — Natural Language Element Finding

**What:** Find elements by description ("the login button", "email input") without knowing CSS selectors. Builds on Phase 1 — queries the a11y tree and scores nodes by token overlap against the query.

**Files changed:**
- `src/tools.ts` only — pure server-side post-processing on `getAccessibilityTree` output

**New tool:** `find_element`
- Parameters: `query: string`, `tabId?`, `filter?: "interactive" | "all"`
- Returns top 5 matches with `ref`, `role`, `name`, `bounds`
- Scoring: token overlap between query words and node name/description/role

**Important:** No LLM calls inside Webster. Simple token matching is sufficient — the MCP caller (Claude) already does language understanding and can reason over 5 candidates.

---

## Phase 5 — File Upload

**What:** Upload files to `<input type="file">` elements and drag-drop targets.

**Files changed:**
- `extension/background/command-handlers.js` — add `uploadFile` and `dragDropFile` cases
- `src/tools.ts` — add `upload_file` tool

**New tool:** `upload_file`
- Parameters: `selector?: string` (CSS selector for file input), `coordinate?: [number, number]` (for drag-drop), `content: string` (base64), `filename: string`, `mimeType?: string`, `tabId?`

**Implementation:**
- File input path: create `File` from base64, set `input.files` via `Object.defineProperty`, dispatch `change`/`input` events
- Drag-drop path: create `DataTransfer` with the file, dispatch `dragenter`/`dragover`/`drop` on the target element

---

## Phase 6 — Window Resize

**What:** Resize the browser window. `chrome.windows` is already available — this is a one-handler addition.

**Files changed:**
- `extension/background/command-handlers.js` — add `resizeWindow` case using `chrome.windows.update()`
- `src/tools.ts` — add `resize_window` tool

**New tool:** `resize_window`
- Parameters: `width: number`, `height: number`, `tabId?`

**No new manifest permissions** — `chrome.windows` is covered by the existing `"tabs"` permission.

---

## Phase 7 — GIF Recording

**What:** Record browser automation sessions as animated GIFs.

**Architecture:** Extension captures frames (base64 PNG via `captureVisibleTab`) on a timer. On stop, frames are returned to the server over the transport. Server encodes the GIF (ffmpeg if available, pure-JS fallback). Keeps the extension lean — no bundled encoder.

**Files changed:**
- `extension/background/command-handlers.js` — add `startRecording`, `stopRecording`, `clearRecording` cases
- `src/tools.ts` — add `start_recording`, `stop_recording`, `export_gif` tools
- `src/gif.ts` (new) — server-side GIF encoding via ffmpeg or fallback JS encoder

**New tools:**
- `start_recording` — parameters: `fps?: number` (default 2), `tabId?`
- `stop_recording` — stops capture, returns frames
- `export_gif` — parameters: `filename?: string`, `fps?: number`; encodes and returns base64 GIF or writes to path

**Frame budget:** ~20 frames at 2fps for a 10s recording ≈ 2MB over localhost. Acceptable.

---

## Implementation Order

| Phase | Feature | New Tools | Depends On | Manifest Change |
|---|---|---|---|---|
| 1 | Accessibility tree | `get_accessibility_tree` | — | `+accessibility` |
| 2 | Coordinate clicking | `click_at`, `click_ref` | Phase 1 | `+debugger` |
| 3 | Selector fallback | none | Phase 1 | — |
| 4 | Natural language find | `find_element` | Phase 1 | — |
| 5 | File upload | `upload_file` | — | — |
| 6 | Window resize | `resize_window` | — | — |
| 7 | GIF recording | `start_recording`, `stop_recording`, `export_gif` | — | — |

Phases 5, 6, 7 are independent and can be done in any order. Phases 2, 3, 4 each require Phase 1 first.

---

## What NOT To Do

- **No persistent debugger attachment** — attach per-command, detach immediately. Persistent attachment shows a warning banner and breaks DevTools.
- **No a11y tree in content scripts** — `chrome.automation` is service-worker-only.
- **No replacing CSS selectors** — they work for 95% of cases. A11y tree and coordinates are supplements, not replacements.
- **No LLM calls inside Webster** — natural language matching is pure token scoring. The MCP caller already handles language understanding.
- **No TypeScript/bundler in the extension** — plain ES modules only, per project rules.
- **No always-on frame capture** — only capture when `start_recording` is called. Background capture is a significant CPU/memory cost.
- **No gif.js in the extension** — encode server-side in `src/gif.ts`.
