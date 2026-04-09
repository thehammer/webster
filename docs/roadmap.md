# Webster Feature Roadmap

Goal: functional parity with (and superiority over) Anthropic's Claude-in-Chrome extension, while preserving Webster's unique strengths — multi-browser routing, CSS selector automation, `wait_for`, localStorage, cookies, network ring buffer.

Marketplace/distribution improvements are explicitly out of scope for now.

> **Status:** All phases complete. ✅ (40 tools, persistent HTTP MCP server, consolidated Webster.app)

---

## Phase 1 — Accessibility Tree ✅ *(foundation for phases 2–4)*

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

## Phase 2 — Coordinate/Pixel Clicking ✅

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

## Phase 3 — Selector Fallback ✅

**What:** When a CSS selector fails, automatically fall back to the accessibility tree. Improves reliability of existing `click` and `type` tools on complex SPAs without changing their interface.

**Files changed:**
- `extension/background/command-handlers.js` — when content script returns `selector_not_found`, attempt a11y tree search
- `extension/content/content-script.js` — return structured `selector_not_found` error code

**No new tools** — this makes existing `click` and `type` more resilient. Optionally expose `fallback?: boolean` parameter to opt in/out.

**Fallback strategy:** strip `#`/`.` from selector, split on `-_`, use as search tokens against a11y tree node names. Click the best-scoring match via `clickCoordinate`.

---

## Phase 4 — Natural Language Element Finding ✅

**What:** Find elements by description ("the login button", "email input") without knowing CSS selectors. Builds on Phase 1 — queries the a11y tree and scores nodes by token overlap against the query.

**Files changed:**
- `src/tools.ts` only — pure server-side post-processing on `getAccessibilityTree` output

**New tool:** `find_element`
- Parameters: `query: string`, `tabId?`, `filter?: "interactive" | "all"`
- Returns top 5 matches with `ref`, `role`, `name`, `bounds`
- Scoring: token overlap between query words and node name/description/role

**Important:** No LLM calls inside Webster. Simple token matching is sufficient — the MCP caller (Claude) already does language understanding and can reason over 5 candidates.

---

## Phase 5 — File Upload ✅

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

## Phase 6 — Window Resize ✅

**What:** Resize the browser window. `chrome.windows` is already available — this is a one-handler addition.

**Files changed:**
- `extension/background/command-handlers.js` — add `resizeWindow` case using `chrome.windows.update()`
- `src/tools.ts` — add `resize_window` tool

**New tool:** `resize_window`
- Parameters: `width: number`, `height: number`, `tabId?`

**No new manifest permissions** — `chrome.windows` is covered by the existing `"tabs"` permission.

---

## Phase 7 — GIF Recording ✅

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

## Phase 8 — Deep Network Capture ✅

**What:** Full request/response body capture using the Chrome Debugger Protocol. Unlike `get_network_log` (which only records URL/status/timing from `webRequest`), deep capture attaches `chrome.debugger` to all tabs and uses `Network.getResponseBody` to capture complete request and response payloads.

**Files changed:**
- `extension/manifest.json` — add `"webNavigation"` permission
- `extension/background/command-handlers.js` — add capture state machine, debugger event handler, auto-attach to new tabs/popups
- `src/tools.ts` — add `start_capture`, `stop_capture`, `get_capture` tools

**New tools:**
- `start_capture` — parameters: `urlFilter?: string` — attach debugger to all tabs, start recording
- `stop_capture` — detach all debuggers, return captured entries
- `get_capture` — peek at current capture buffer without stopping

**Key implementation notes:**
- Auto-attaches to new tabs and popups via `chrome.tabs.onCreated`, `chrome.webNavigation.onBeforeNavigate`, and `Target.setAutoAttach`
- Request IDs namespaced by tabId (they're only unique per-tab)
- Handles redirects, binary content (metadata only), loading failures
- Response bodies truncated at 500KB, buffer capped at 2000 entries
- Shows Chrome's "debugging" infobar on captured tabs — this is intentional and cannot be suppressed

---

## Implementation Order

| Phase | Feature | New Tools | Depends On | Manifest Change | Status |
|---|---|---|---|---|---|
| 1 | Accessibility tree | `get_accessibility_tree` | — | `+accessibility` | ✅ |
| 2 | Coordinate clicking | `click_at`, `click_ref` | Phase 1 | `+debugger` | ✅ |
| 3 | Selector fallback | none | Phase 1 | — | ✅ |
| 4 | Natural language find | `find_element` | Phase 1 | — | ✅ |
| 5 | File upload | `upload_file` | — | — | ✅ |
| 6 | Window resize | `resize_window` | — | — | ✅ |
| 7 | GIF recording | `start_recording`, `stop_recording`, `export_gif` | — | — | ✅ |
| 8 | Deep network capture | `start_capture`, `stop_capture`, `get_capture` | — | `+webNavigation` | ✅ |

---

---

## Phase 9 — Concurrent Claude Sessions

**Goal:** Multiple Claude sessions (separate `webster` MCP processes) can run simultaneously, each targeting different tabs without stepping on each other.

**Architecture:** Each `webster` process writes its port to a shared registry file (`~/.webster/registry.json`). The extension connects to all registered servers simultaneously. Tabs can be claimed by a session; commands to unclaimed tabs are routed to whichever server sent the command.

### Phase 9-A — Registry File

**Files changed:**
- `src/server.ts` — on startup, write `{ port, pid, started }` to `~/.webster/registry.json` (append to array); on shutdown, remove own entry
- `src/index.ts` — call `wsServer.registerSelf()` after construction, `wsServer.deregisterSelf()` in SIGINT/SIGTERM

**Details:**
- Registry lives at `~/.webster/registry.json` (create dir if needed)
- On startup: read existing array, filter out dead PIDs (kill -0 check), append own entry, write back
- On shutdown: read, filter out own port, write back
- File lock: use a `.lock` file with `O_EXCL` to prevent races

---

### Phase 9-B — Tab Ownership

**Files changed:**
- `src/server.ts` — add `tabOwnership: Map<number, string>` (tabId → ownerPort); expose `claimTab(tabId)`, `releaseTab(tabId)`, `isOwned(tabId)` methods
- `src/tools.ts` — add `claim_tab` and `release_tab` tools

**New tools:**
- `claim_tab` — parameters: `tabId?: number` (defaults to active tab) — marks tab as owned by this server; returns `{ tabId, port }`
- `release_tab` — parameters: `tabId?: number` — releases ownership

**Ownership rules:**
- Commands to an owned tab from a different server are rejected with `{ error: "tab owned by port XXXX" }`
- Unowned tabs: first-come-first-served (no rejection)
- `open_tab` automatically claims the new tab for the calling server

---

### Phase 9-C — Multi-Server Extension Connection

**Files changed:**
- `extension/background/service-worker.js` — read registry on connect, maintain a `Map<port, WebSocket>` of server connections; route command responses back to originating connection
- `extension/background/safari-service-worker.js` — same for HTTP long-poll

**Details:**
- On extension startup: read `~/.webster/registry.json` (via `fetch('http://localhost:3456/registry')` — each server exposes `/registry` endpoint)
- Actually simpler: extension hard-connects to a known range or the user configures multiple ports
- **Preferred approach:** Extension connects to a single "primary" server; primary server proxies to other servers when tab ownership requires it. Keeps extension simple.

---

### Phase 9-D — Popup Update

**Files changed:**
- `extension/popup/popup.js` — show active session count, which tabs are claimed and by which port
- `extension/popup/popup.html` — add sessions panel

---

## Phase 10 — Input Dispatching & Monitoring

**Goal:** Expose mouse hover, drag-and-drop, and keyboard press as first-class tools. Capture all user input events (mouse moves, clicks, key presses) into a ring buffer for inspection.

### Phase 10-A — `withDebugger` Helper Refactor

**Files changed:**
- `extension/background/command-handlers.js` — extract `withDebugger(tabId, fn)` helper used by `clickAt`, `clickRef`, and Phase 8 capture

**Why first:** Hover, drag, and key_press all need debugger attachment. Centralizing avoids duplicating attach/detach logic.

```js
async function withDebugger(tabId, fn) {
  // If capture is active and already attached, skip attach/detach
  if (captureState.active && captureState.attachedTabs.has(tabId)) {
    return fn({ tabId })
  }
  await chrome.debugger.attach({ tabId }, '1.3')
  try {
    return await fn({ tabId })
  } finally {
    await chrome.debugger.detach({ tabId })
  }
}
```

---

### Phase 10-B — `hover` and `drag` Tools

**Files changed:**
- `extension/background/command-handlers.js` — add `hover` and `drag` cases
- `src/tools.ts` — add `hover` and `drag` tools

**New tools:**
- `hover` — parameters: `x: number`, `y: number`, `tabId?` — dispatches `mouseMoved` via CDP
- `drag` — parameters: `startX: number`, `startY: number`, `endX: number`, `endY: number`, `steps?: number` (default 10), `tabId?` — dispatches `mousePressed` → N `mouseMoved` → `mouseReleased`

**Implementation:** `Input.dispatchMouseEvent` with types `mouseMoved`, `mousePressed`, `mouseReleased`. For drag, interpolate coordinates across `steps` moves.

---

### Phase 10-C — `key_press` Tool

**Files changed:**
- `extension/background/command-handlers.js` — add `keyPress` case using `Input.dispatchKeyEvent`
- `src/tools.ts` — add `key_press` tool

**New tool:**
- `key_press` — parameters: `key: string` (e.g. `"Enter"`, `"Tab"`, `"ArrowDown"`), `modifiers?: string[]` (e.g. `["ctrl", "shift"]`), `tabId?`

**Implementation:** dispatch `keyDown` + `keyUp` events. Map modifier strings to CDP `modifiers` bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8).

---

### Phase 10-D — Input Monitoring (`get_input_log`)

**Files changed:**
- `extension/content/page-script.js` — add listeners for `mousemove`, `mousedown`, `mouseup`, `click`, `keydown`, `keyup`; push to ring buffer (max 200 entries, throttle mousemove to 10/s)
- `extension/content/content-script.js` — forward `GET_INPUT_LOG` message to page script, return buffer
- `extension/background/command-handlers.js` — add `getInputLog` case
- `src/tools.ts` — add `get_input_log` tool

**New tool:**
- `get_input_log` — parameters: `clear?: boolean` (default true), `tabId?` — returns array of input events with timestamps

**Entry format:**
```json
{ "type": "click", "x": 450, "y": 320, "button": "left", "t": 1234567890 }
{ "type": "keydown", "key": "Enter", "modifiers": [], "t": 1234567891 }
{ "type": "mousemove", "x": 451, "y": 321, "t": 1234567892 }
```

---

## Phase 9-10 Implementation Order

| Phase | Feature | New Tools | Key File | Status |
|---|---|---|---|---|
| 9-A | Registry file | — | `src/server.ts` | ✅ |
| 9-B | Tab ownership | `claim_tab`, `release_tab` | `src/tools.ts` | ✅ |
| 9-C | Multi-server extension | — | `service-worker.js` | ✅ |
| 9-D | Popup update | — | `popup/popup.js` | ✅ |
| 10-A | `withDebugger` refactor | — | `command-handlers.js` | ✅ |
| 10-B | hover + drag | `hover`, `drag` | `tools.ts` + handlers | ✅ |
| 10-C | key_press | `key_press` | `tools.ts` + handlers | ✅ |
| 10-D | Input monitoring | `get_input_log` | `page-script.js` | ✅ |

---

---

## Phase 11 — Persistent HTTP MCP Transport ✅

**What:** Replace the per-session stdio subprocess model with a single persistent server that handles multiple Claude Code sessions concurrently over HTTP. Each Claude Code session gets an independent MCP connection; all share the same browser extension connection.

**Architecture change:**
```
Before: Claude Code → forks bun subprocess (stdio) → WebSocket → extension
After:  Claude Code → HTTP POST /mcp → persistent server (launchd) → WebSocket → extension
```

**Files changed:**
- `src/mcp.ts` (new) — `McpSessionManager` class manages one `WebStandardStreamableHTTPServerTransport` + `Server` per MCP client session; sessions tracked by `mcp-session-id` header, cleaned up on close
- `src/server.ts` — add `setMcpHandler()` and `/mcp` route
- `src/index.ts` — remove orphan-killer; wire `McpSessionManager` into HTTP server; keep `WEBSTER_MCP_MODE=stdio` for backward compat
- `src/__tests__/mcp.test.ts` (new) — 7 tests covering session lifecycle, 404 on unknown session, independent sessions

**Claude Code config** changed from `command/args` (stdio) to `url: http://localhost:3456/mcp`.

**Key implementation notes:**
- Uses `WebStandardStreamableHTTPServerTransport` from MCP SDK 1.29+ — native Bun support, no Node.js compatibility shim needed
- Stateful mode: each `initialize` request creates a new session with a UUID; subsequent requests carry `mcp-session-id` header
- `onsessionclosed` callback cleans up sessions on DELETE or disconnect
- `WEBSTER_MCP_MODE=stdio` env var preserves backward compat for single-session stdio usage

**Phase 11 implementation table:**

| Phase | Feature | New Files | Status |
|---|---|---|---|
| 11-A | `McpSessionManager` | `src/mcp.ts` | ✅ |
| 11-B | `/mcp` HTTP route in server | `src/server.ts` | ✅ |
| 11-C | Simplified index.ts | `src/index.ts` | ✅ |
| 11-D | HTTP MCP session tests | `src/__tests__/mcp.test.ts` | ✅ |

---

---

## Phase 12 — Consolidated Webster.app ✅

**What:** Merge the standalone menu bar app (WebsterMenu) into the Safari extension host (Webster.app) so there is only one thing to run. Webster.app now does three jobs: hosts the Safari extension, spawns and manages the bun MCP server as a subprocess, and provides the full menu bar UI.

**Motivation:** Previously three separate processes needed to be running (bun server via launchd, Webster.app Safari host, WebsterMenu menu bar app). Consolidation reduces this to one app and one launchd entry.

**Architecture after Phase 12:**
```
launchd → Webster.app
              ├── spawns bun server (src/index.ts) as child Process
              ├── hosts Safari Web Extension
              └── menu bar UI (StatusBarController, WebsterClient, HotkeyManager)
```

**Files changed:**
- `scripts/safari-patches/AppDelegate.swift` — replaces minimal AppDelegate with one that spawns bun via `Process()` and creates `StatusBarController`
- `scripts/safari-patches/StatusBarController.swift` — full menu bar UI (copied from `menubar/`)
- `scripts/safari-patches/WebsterClient.swift` — HTTP client for `/api/*` (copied from `menubar/`)
- `scripts/safari-patches/HotkeyManager.swift` — global hotkey ⌃⌥R (copied from `menubar/`)
- `scripts/safari-patches/patch-pbxproj.py` (new) — wires new Swift files into generated Xcode project, adds Carbon framework, disables app sandbox so bun can be spawned, removes `SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor` (incompatible with Carbon C callbacks)
- `scripts/build-extension.sh` — patch section updated to copy new files and run `patch-pbxproj.py`
- `~/Library/LaunchAgents/com.hammer.webster.plist` — consolidated to one entry pointing at `Webster.app/Contents/MacOS/Webster` with `WEBSTER_BUN_PATH` and `WEBSTER_PROJECT_DIR` env vars

**Key env vars read by Webster.app at launch:**
- `WEBSTER_BUN_PATH` — explicit path to bun binary (falls back to scanning common locations)
- `WEBSTER_PROJECT_DIR` — path to the webster repo (required for `bun run src/index.ts`)
- `WEBSTER_PORT` — server port (default 3456)

**Platform note:** On Linux/Windows there is no Safari extension requirement. The equivalent setup is a systemd/Task Scheduler service running `bun start` directly, plus an optional Electron/Tauri tray app for the UI.

| Sub-task | Status |
|---|---|
| AppDelegate spawns bun subprocess | ✅ |
| StatusBarController + WebsterClient + HotkeyManager patches | ✅ |
| patch-pbxproj.py (idempotent, deterministic UUIDs) | ✅ |
| build-extension.sh updated | ✅ |
| launchd consolidated to one plist | ✅ |

---

## What NOT To Do

- **No persistent debugger attachment** — attach per-command, detach immediately. Exception: `start_capture` intentionally holds persistent attachment for the duration of the capture session (shows warning banner to user).
- **No a11y tree in content scripts** — `chrome.automation` is service-worker-only.
- **No replacing CSS selectors** — they work for 95% of cases. A11y tree and coordinates are supplements, not replacements.
- **No LLM calls inside Webster** — natural language matching is pure token scoring. The MCP caller already handles language understanding.
- **No TypeScript/bundler in the extension** — plain ES modules only, per project rules.
- **No always-on frame capture** — only capture when `start_recording` is called. Background capture is a significant CPU/memory cost.
- **No gif.js in the extension** — encode server-side in `src/gif.ts`.
