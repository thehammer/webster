# Webster — Browser Automation MCP Server

## What This Is

Webster is a browser automation MCP server for Claude Code. It gives Claude full control of a browser via a persistent WebSocket connection to a browser extension — navigate, click, read DOM, screenshot, monitor network, manage tabs, capture sessions with replay.

## Architecture

```
Claude Code (HTTP MCP)
      ↕
  Webster MCP Server   ← single Bun process (localhost:3456)
      ↕ WebSocket
  Browser Extension    ← MV3, auto-connects
      ↕
  Browser

  Webster Menu Bar App ← Swift, polls /api/* endpoints
  Web Dashboard        ← served at /dashboard
  Replay Viewer        ← served at /replay/{sessionId}
```

- **`src/`** — TypeScript MCP server (Bun, no build step)
- **`extension/`** — MV3 browser extension (plain JS, no bundler)
- **`menubar/`** — macOS Swift menu bar app
- **`scripts/`** — build and install scripts
- **`design/`** — icon assets

## Key Commands

```bash
bun test                              # run tests (60 tests)
bun run typecheck                     # type check
bun start                             # start MCP server manually
./scripts/build-extension.sh --all   # build extension for all browsers
./scripts/install.sh                  # install Webster as a Claude Code agent
./scripts/install-menubar.sh          # build + install menu bar app
```

## Project Structure

```
src/
  index.ts        # entry: MCP server + WebSocket startup
  server.ts       # WebSocket server, HTTP API, dispatch, session management
  tools.ts        # 40 MCP tool definitions
  protocol.ts     # WsCommand / WsResult / push event types
  capture.ts      # CaptureSession — disk-backed event + frame storage
  video.ts        # Multi-format video encoder (mp4/webm/gif via ffmpeg)
  replay.ts       # HTML replay viewer (self-contained, served at /replay/{id})
  dashboard.ts    # Web dashboard (self-contained, served at /dashboard)
  favicon.ts      # Shared favicon SVG (icon-c spider)
  mcp.ts          # MCP session manager (HTTP transport)
  __tests__/
    server.test.ts    # WebSocket round-trip + push event tests
    tools.test.ts     # tool shape and input validation tests
    capture.test.ts   # CaptureSession disk storage tests
    video.test.ts     # video encoder tests (requires ffmpeg)
    mcp.test.ts       # MCP session lifecycle tests
extension/
  manifest.json
  background/
    service-worker.js     # WS connection + command dispatch + pushToServer
    command-handlers.js   # browser commands + CDP capture + streaming
  content/
    content-script.js     # DOM operations (isolated world)
    page-script.js        # console/network/input/error capture (MAIN world)
  popup/                  # status popup
menubar/
  Package.swift           # Swift Package Manager manifest
  Sources/WebsterMenu/
    App.swift               # entry, NSApplication accessory mode
    StatusBarController.swift  # menu bar icon, menus, polling
    WebsterClient.swift     # HTTP client for /api/* endpoints
    HotkeyManager.swift     # global hotkey via Carbon API
  Resources/
    icon-template.svg       # monochrome spider for menu bar
scripts/
  build-extension.sh      # Chrome / Firefox / Safari builds
  install.sh              # Claude Code agent installer
  install-menubar.sh      # Menu bar app build + launchd install
```

## Capture System

Capture uses Chrome Debugger Protocol for full network request/response bodies. Events stream from the extension to the server in real-time via WebSocket push — no local buffering in the extension. Data is stored on disk under `~/.webster/captures/{sessionId}/`:

```
~/.webster/captures/{uuid}/
  meta.json       # session metadata, config, timestamps
  events.jsonl    # append-only, one JSON per line
  frames/         # frame_00001.jpg, frame_00002.jpg, ...
```

Event kinds: `network`, `input`, `console`, `page`. Each has a `timestamp` (epoch ms) and kind-specific fields.

Capture also records:
- Mouse/keyboard input events
- Console output (log, warn, error, info)
- JS errors and unhandled rejections
- Page state (URL, title, scroll, viewport)
- DOM cursor overlay for visible mouse in frame recordings

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Server health, connected browsers, active capture |
| GET | `/api/sessions` | List all capture sessions with metadata |
| POST | `/api/capture/start` | Start a capture session |
| POST | `/api/capture/stop` | Stop active capture |
| GET | `/api/capture/current` | Current capture snapshot |
| PATCH | `/api/sessions/{id}` | Update session (rename) |
| DELETE | `/api/sessions/{id}` | Delete a session |
| GET | `/dashboard` | Web dashboard |
| GET | `/replay/{id}` | HTML replay viewer |
| GET | `/replay/{id}/meta` | Session metadata JSON |
| GET | `/replay/{id}/events` | All events as JSON array |
| GET | `/replay/{id}/frames` | Frame listing with timestamps |
| GET | `/replay/{id}/frame/{filename}` | Individual JPEG frame |

## WebSocket Protocol

Commands flow from MCP server → extension, results flow back:

```
Server → Extension:  { id: string, action: string, ...params }
Extension → Server:  { id: string, success: boolean, data?: unknown, error?: string }
```

Push events flow unsolicited from extension → server during capture:

```
Extension → Server:  { type: 'capture_event', kind: 'network'|'input'|'frame'|'console'|'page', data: {...} }
Extension → Server:  { type: 'capture_done' }
```

Commands time out after 30 seconds. Extension auto-reconnects with exponential backoff.

## Tool Conventions

- All 40 tools use `snake_case` names matching the `mcp__webster__*` pattern
- Every tool accepts an optional `tabId` — defaults to the active tab
- Tools return the raw data on success; errors surface as MCP error responses
- Capture tools (`start_capture`, `stop_capture`, `get_capture`) read from server-side disk storage — no extension round-trip
- `get_capture` returns a summary by default; use parameters to drill into events

## Testing

Tests use real WebSocket connections against a live `WebsterServer` instance on a random port. No mocks. Video tests require ffmpeg and are skipped in CI when unavailable.

```bash
bun test                    # all tests (60)
bun test --watch            # watch mode
bun test src/__tests__/server.test.ts   # one file
```

## Menu Bar App

macOS-only Swift app that polls the server API:

- Spider icon in the system tray
- Live server + browser connection status
- Start/stop capture with configurable options
- Global hotkey: **⌃⌥R** (Ctrl+Option+R) toggles capture
- Recent sessions submenu with thumbnails and replay links
- Copy replay URL, delete sessions

Build and install:
```bash
./scripts/install-menubar.sh
```

Or run in development:
```bash
cd menubar && swift build && .build/debug/WebsterMenu
```

## Extension Build Notes

- **Chrome/Edge**: straight copy of `extension/`
- **Firefox**: adds `browser_specific_settings.gecko` to manifest
- **Safari**: bundles ES modules into a single classic SW (Safari doesn't support `type: module`), then runs `xcrun safari-web-extension-converter`
- Build output: `build/extension/{chrome,firefox,safari-src}/`
- Zips for distribution: `./scripts/build-extension.sh --all --zip`

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBSTER_PORT` | `3456` | Port for WebSocket, MCP HTTP, dashboard, and replay viewer |

## Hard Rules

- Never use `better-sqlite3` (no database in this project, but Bun-native only if added)
- Extension JS must stay plain ES modules — no bundler, no TypeScript
- Page script runs in MAIN world — don't access `chrome.*` APIs there
- Content script runs in isolated world — use `postMessage` to talk to page script
- Safari build must not use ES module syntax in service worker
- Capture data streams to server — extension never buffers events locally
