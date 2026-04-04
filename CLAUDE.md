# Webster — Browser Automation MCP Server

## What This Is

Webster is a browser automation MCP server for Claude Code. It gives Claude full control of a browser via a persistent WebSocket connection to a browser extension — navigate, click, read DOM, screenshot, monitor network, manage tabs, capture console output.

## Architecture

```
Claude Code (stdio MCP)
      ↕
  Webster MCP Server   ← single Bun process
      ↕ WebSocket (localhost:3000)
  Browser Extension    ← MV3, auto-connects
      ↕
  Browser
```

- **`src/`** — TypeScript MCP server (Bun, no build step)
- **`extension/`** — MV3 browser extension (plain JS, no bundler)
- **`scripts/`** — build and install scripts

## Key Commands

```bash
bun test                              # run tests
bun run typecheck                     # type check
bun start                             # start MCP server manually
./scripts/build-extension.sh --all   # build extension for all browsers
./scripts/install.sh                  # install Webster as a Claude Code agent
```

## Project Structure

```
src/
  index.ts      # entry: MCP server + WebSocket startup
  server.ts     # WebSocket server, pending command map, dispatch
  tools.ts      # 22 MCP tool definitions
  protocol.ts   # WsCommand / WsResult types
  __tests__/
    server.test.ts   # real WebSocket round-trip tests
    tools.test.ts    # tool shape and input validation tests
extension/
  manifest.json
  background/
    service-worker.js     # WS connection + command dispatch
    command-handlers.js   # browser command implementations
  content/
    content-script.js     # DOM operations (isolated world)
    page-script.js        # console + network capture (MAIN world)
  popup/                  # status popup
scripts/
  build-extension.sh      # Chrome / Firefox / Safari builds
  install.sh              # Claude Code agent installer
agent/
  webster.md              # agent definition (copy to ~/.claude/agents/)
```

## WebSocket Protocol

Commands flow from MCP server → extension, results flow back:

```
Server → Extension:  { id: string, action: string, ...params }
Extension → Server:  { id: string, success: boolean, data?: unknown, error?: string }
```

Commands time out after 30 seconds. Extension auto-reconnects with exponential backoff.

## Tool Conventions

- All 22 tools use `snake_case` names matching the `mcp__webster__*` pattern
- Every tool accepts an optional `tabId` — defaults to the active tab
- Tools return the raw data on success; errors surface as MCP error responses
- `get_network_log` clears the buffer on read (ring buffer, max 500 entries)
- `read_console` accepts an optional `pattern` regex to filter output

## Testing

Tests use real WebSocket connections against a live `WebsterServer` instance on a random port. No mocks. The `commandTimeout` constructor parameter is exposed for tests to use short timeouts without waiting 30s.

```bash
bun test                    # all tests
bun test --watch            # watch mode
bun test src/__tests__/server.test.ts   # one file
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
| `WEBSTER_PORT` | `3000` | WebSocket port the extension connects to |

## Hard Rules

- Never use `better-sqlite3` (no database in this project, but Bun-native only if added)
- Extension JS must stay plain ES modules — no bundler, no TypeScript
- Page script runs in MAIN world — don't access `chrome.*` APIs there
- Content script runs in isolated world — use `postMessage` to talk to page script
- Safari build must not use ES module syntax in service worker
