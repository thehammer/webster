# Webster

Browser automation MCP server for Claude Code. Gives Claude full control of your browser — navigate pages, click elements, read DOM content, take screenshots, inspect network traffic, manage tabs, and more.

## How it works

Webster consists of two parts:

1. **MCP server** — runs locally, connects to Claude Code via stdio
2. **Browser extension** — connects to the server via WebSocket, executes browser commands

When Claude calls a tool like `navigate` or `screenshot`, the server sends the command over a persistent WebSocket connection to the extension, which executes it in the browser and returns the result. No polling, no latency.

## Installation

### 1. Install the MCP server

```bash
git clone https://github.com/hammer/webster
cd webster
bun install
```

Add to your Claude Code MCP config (`~/.config/claude/claude_desktop_config.json` or `~/.claude.json`):

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

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder

The extension connects automatically when the MCP server is running.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBSTER_PORT` | `3000` | WebSocket port the extension connects to |

## Tools

| Tool | Description |
|------|-------------|
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
| `get_network_log` | Get buffered network requests |
| `wait_for_network_idle` | Wait until no in-flight requests |
| `get_cookies` | Get cookies for a URL |
| `get_local_storage` | Read localStorage |
| `set_local_storage` | Write localStorage |
| `read_console` | Get buffered console output |

## Development

```bash
bun test          # run tests
bun run typecheck # type check
bun start         # start the MCP server
```

## License

MIT
