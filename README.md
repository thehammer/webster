# Webster

Browser automation MCP server for Claude Code. Gives Claude full control of your browser — navigate pages, click elements, read DOM content, take screenshots, inspect network traffic, manage tabs, and more.

Supports **Chrome, Firefox, and Safari** simultaneously. Switch between browsers with a single tool call.

## How it works

Webster consists of two parts:

1. **MCP server** — runs locally, connects to Claude Code via stdio
2. **Browser extension** — auto-connects to the server and executes browser commands

Chrome and Firefox connect via WebSocket. Safari connects via HTTP long-poll (Safari's extension sandbox blocks raw TCP sockets from service workers). All three can be connected at the same time — use `get_browsers` to see what's connected and `set_browser` to route commands to a specific one.

## Installation

### 1. Install the MCP server

```bash
git clone https://github.com/thehammer/webster
cd webster
bun install
```

Add to your Claude Code MCP config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "webster": {
      "command": "bun",
      "args": ["/path/to/webster/src/index.ts"]
    }
  }
}
```

### 2. Install the browser extension

Build the extension for your browser(s):

```bash
./scripts/build-extension.sh --chrome    # Chrome / Edge
./scripts/build-extension.sh --firefox   # Firefox
./scripts/build-extension.sh --safari    # Safari (requires macOS + Xcode)
./scripts/build-extension.sh --all       # all three
```

**Chrome / Edge** — `build/extension/chrome/`
1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `build/extension/chrome/` folder

**Firefox** — `build/extension/firefox/`
1. Open `about:debugging` → **This Firefox**
2. Click **Load Temporary Add-on** → select any file in `build/extension/firefox/`

**Safari** — run with `--run` to build, sign, and launch the app automatically:
```bash
./scripts/build-extension.sh --safari --run
```
Then enable Webster in Safari → Settings → Extensions.

The extension connects automatically when the MCP server is running.

## Multi-browser usage

When multiple browsers are connected, use `get_browsers` and `set_browser` to route commands:

```
# See what's connected
get_browsers → [{ browser: "chrome", transport: "ws", active: true }, { browser: "safari", ... }]

# Switch to Safari
set_browser("safari")

# Now all commands go to Safari
get_tabs, navigate, screenshot, ...
```

When only one browser is connected, it's selected automatically.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBSTER_PORT` | `3456` | Port the extension connects to |

## Tools

| Tool | Description |
|------|-------------|
| `get_browsers` | List all connected browser extensions |
| `set_browser` | Set the active browser target |
| `navigate` | Navigate to a URL |
| `click` | Click an element by CSS selector |
| `type` | Type text into an input |
| `read_page` | Get text content of a page or element |
| `read_html` | Get HTML of a page or element |
| `screenshot` | Capture visible tab as PNG |
| `eval_js` | Execute JavaScript in the page |
| `wait_for` | Wait for an element to appear |
| `find` | Find elements matching a selector |
| `scroll_to` | Scroll to an element or coordinates |
| `get_attribute` | Get an element attribute value |
| `get_page_info` | Get URL, title, viewport info |
| `get_tabs` | List all open tabs |
| `open_tab` | Open a new tab |
| `close_tab` | Close a tab |
| `switch_tab` | Switch to a tab |
| `get_accessibility_tree` | Get the browser's semantic element tree |
| `click_at` | Click at (x, y) coordinates via debugger |
| `click_ref` | Click an element by accessibility ref |
| `find_element` | Find elements by natural language description |
| `upload_file` | Upload a file to an input or drag-drop target |
| `resize_window` | Resize the browser window |
| `get_network_log` | Get buffered network requests |
| `wait_for_network_idle` | Wait until no in-flight requests |
| `start_capture` | Start deep network capture (full bodies via Chrome Debugger) |
| `stop_capture` | Stop capture and return all captured data |
| `get_capture` | Peek at captured data without stopping |
| `get_cookies` | Get cookies for a URL |
| `get_local_storage` | Read localStorage |
| `set_local_storage` | Write localStorage |
| `read_console` | Get buffered console output |
| `start_recording` | Start recording browser session frames |
| `stop_recording` | Stop recording and return frames |
| `export_gif` | Encode captured frames as animated GIF |

## Development

```bash
bun test                              # run tests
bun run typecheck                     # type check
bun start                             # start the MCP server
./scripts/build-extension.sh --all   # build all browser extensions
```

## License

MIT
