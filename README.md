# Webster

Browser automation MCP server for Claude Code. Gives Claude full control of your browser — navigate pages, click elements, read DOM, take screenshots, inspect network traffic, manage tabs, capture input events, and more.

Supports **Chrome, Firefox, and Safari** simultaneously. Switch between browsers with a single tool call. Multiple Claude Code sessions share the same server and browser connection concurrently.

## How it works

Webster has two parts:

1. **MCP server** — a persistent local server that Claude Code connects to over HTTP
2. **Browser extension** — auto-connects to the server via WebSocket and executes browser commands

```
Claude Code Session A ──┐
Claude Code Session B ──┤── HTTP /mcp ──→ Webster Server ──→ Browser Extension ──→ Browser
Claude Code Session C ──┘    (persistent,                     (WebSocket)
                               launchd-managed)
```

Chrome and Firefox connect via WebSocket. Safari connects via HTTP long-poll (Safari's extension sandbox blocks raw sockets from service workers). All three can be active simultaneously — use `get_browsers` / `set_browser` to route between them.

## Installation

### 1. Install the MCP server

```bash
git clone https://github.com/thehammer/webster
cd webster
bun install
```

**Recommended: run as a persistent background service (launchd on macOS)**

Create `~/Library/LaunchAgents/com.yourname.webster.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yourname.webster</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/bun</string>
    <string>run</string>
    <string>/path/to/webster/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/webster</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/path/to/bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/yourname</string>
    <key>WEBSTER_PORT</key>
    <string>3456</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/yourname/.webster/webster.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/yourname/.webster/webster.log</string>
</dict>
</plist>
```

```bash
mkdir -p ~/.webster
launchctl load ~/Library/LaunchAgents/com.yourname.webster.plist
```

**Configure Claude Code** (`~/.claude.json`) to connect to the persistent server:

```json
{
  "mcpServers": {
    "webster": {
      "url": "http://localhost:3456/mcp"
    }
  }
}
```

**Alternative: stdio mode** (single session, spawned per Claude Code session):

```json
{
  "mcpServers": {
    "webster": {
      "command": "bun",
      "args": ["/path/to/webster/src/index.ts"],
      "env": { "WEBSTER_MCP_MODE": "stdio" }
    }
  }
}
```

### 2. Install the browser extension

Build for your browser(s):

```bash
./scripts/build-extension.sh --chrome    # Chrome / Edge
./scripts/build-extension.sh --firefox   # Firefox
./scripts/build-extension.sh --safari    # Safari (requires macOS + Xcode)
./scripts/build-extension.sh --all       # all three
```

**Chrome / Edge** — `build/extension/chrome/`
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select `build/extension/chrome/`

**Firefox** — `build/extension/firefox/`
1. Open `about:debugging` → **This Firefox**
2. Click **Load Temporary Add-on** → select any file in `build/extension/firefox/`

**Safari** — builds, signs, and launches automatically:
```bash
./scripts/build-extension.sh --safari --run
```
Then enable Webster in Safari → Settings → Extensions.

The extension auto-connects to the server on port 3456. The popup shows connection status and lets you add additional server ports for concurrent sessions.

## Multi-browser usage

When multiple browsers are connected, use `get_browsers` and `set_browser`:

```
get_browsers → [{ browser: "chrome", active: true }, { browser: "safari", ... }, ...]
set_browser("safari")   # all subsequent commands go to Safari
```

When only one browser is connected, it's selected automatically.

## Concurrent Claude sessions

Multiple Claude Code sessions share the same Webster server — each gets an independent MCP connection via HTTP. Use `claim_tab` / `release_tab` to coordinate tab ownership across sessions so sessions don't step on each other.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBSTER_PORT` | `3456` | Port for both the extension WebSocket and MCP HTTP clients |
| `WEBSTER_MCP_MODE` | — | Set to `stdio` to use stdio transport instead of HTTP |

Server registry: `~/.webster/registry.json`. Logs: `~/.webster/webster.log`.

## Tools (42 total)

### Navigation & interaction
| Tool | Description |
|------|-------------|
| `navigate` | Navigate to a URL |
| `click` | Click an element by CSS selector (auto-falls back to accessibility tree) |
| `type` | Type text into an input |
| `click_at` | Click at (x, y) coordinates via Chrome Debugger Protocol |
| `click_ref` | Click an element by accessibility ref |
| `hover` | Move mouse to (x, y) — triggers hover states and tooltips |
| `drag` | Click and drag between two coordinates |
| `key_press` | Press a key with optional modifiers (Enter, Tab, Ctrl+C, etc.) |
| `scroll_to` | Scroll to an element or coordinates |
| `upload_file` | Upload a file to a file input or drag-drop target |
| `resize_window` | Resize the browser window |

### Reading the page
| Tool | Description |
|------|-------------|
| `read_page` | Get text content of a page or element |
| `read_html` | Get HTML of a page or element |
| `screenshot` | Capture the visible tab as PNG |
| `get_page_info` | Get URL, title, viewport dimensions |
| `find` | Find elements matching a CSS selector |
| `get_attribute` | Get an element's attribute value |
| `eval_js` | Execute JavaScript in the page |
| `get_accessibility_tree` | Get the browser's semantic element tree |
| `find_element` | Find elements by natural language description |

### Tabs & browsers
| Tool | Description |
|------|-------------|
| `get_tabs` | List all open tabs |
| `open_tab` | Open a new tab |
| `close_tab` | Close a tab |
| `switch_tab` | Switch to a tab |
| `get_browsers` | List all connected browser extensions |
| `set_browser` | Set the active browser target |
| `claim_tab` | Mark a tab as owned by this session |
| `release_tab` | Release tab ownership |

### Network & storage
| Tool | Description |
|------|-------------|
| `get_network_log` | Get buffered network requests (URL, status, timing) |
| `wait_for_network_idle` | Wait until no in-flight requests |
| `start_capture` | Start deep network capture — full req/res bodies via Chrome Debugger |
| `stop_capture` | Stop capture and return all data |
| `get_capture` | Peek at capture buffer without stopping |
| `get_cookies` | Get cookies for a URL |
| `get_local_storage` | Read localStorage |
| `set_local_storage` | Write localStorage |

### Console & input
| Tool | Description |
|------|-------------|
| `read_console` | Get buffered console output (optional regex filter) |
| `get_input_log` | Get buffered mouse/keyboard events from the page |

### Waiting
| Tool | Description |
|------|-------------|
| `wait_for` | Wait for an element to appear in the DOM |
| `wait_for_network_idle` | Wait until network is idle |

### Recording
| Tool | Description |
|------|-------------|
| `start_recording` | Start capturing frames from the active tab |
| `stop_recording` | Stop recording and return frames |
| `export_gif` | Encode captured frames as an animated GIF |

## Development

```bash
bun test                              # run tests (34 tests)
bun run typecheck                     # type check
bun start                             # start server manually
./scripts/build-extension.sh --all   # build all browser extensions
```

## License

MIT
