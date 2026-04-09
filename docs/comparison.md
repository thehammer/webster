# Webster vs. Claude-in-Chrome

Comparison of Webster (open source, multi-browser MCP server) against Anthropic's official Claude-in-Chrome extension.

| Feature | Webster | Claude-in-Chrome |
|---|---|---|
| **Browser support** | Chrome, Firefox, Safari simultaneously | Chrome only |
| **Multi-browser routing** | ✅ `get_browsers` / `set_browser` | ❌ |
| **Installation** | Manual build + load unpacked | ✅ Extension marketplace |
| **Persists across restarts** | ❌ Safari/Firefox need re-enabling | ✅ |
| **Open source / self-hosted** | ✅ | ❌ Black box |
| **Embeddable in products** | ✅ | ❌ |
| **CSS selector interaction** | ✅ | ⚠️ Via accessibility refs |
| **Coordinate/pixel clicking** | ✅ `click_at` (chrome.debugger) | ✅ |
| **Accessibility tree** | ✅ `get_accessibility_tree` | ✅ |
| **Click by a11y ref** | ✅ `click_ref` | ✅ |
| **Natural language element finding** | ✅ `find_element` | ✅ |
| **Selector fallback to a11y tree** | ✅ automatic | ❌ |
| **Screenshots** | ✅ | ✅ |
| **JavaScript execution** | ✅ | ✅ |
| **wait_for (element appears)** | ✅ | ❌ |
| **wait_for_network_idle** | ✅ | ❌ |
| **localStorage read/write** | ✅ | ❌ |
| **Cookie access** | ✅ | ❌ |
| **Network log** | ✅ Ring buffer, persists across nav | ✅ Clears on domain change |
| **Console log access** | ✅ | ✅ |
| **File upload / drag-drop** | ✅ `upload_file` | ✅ |
| **GIF recording** | ✅ `start_recording` / `export_gif` | ✅ |
| **Window resize** | ✅ `resize_window` | ✅ |
| **Deep network capture** | ✅ `start_capture` — full req/res bodies via Debugger Protocol | ❌ |
| **Shortcuts / workflows** | ❌ | ✅ |
| **Plan approval flow** | ❌ | ✅ |
| **Cross-browser test automation** | ✅ | ❌ |
| **Headless / CI use** | ⚠️ Possible but not designed for it | ❌ |
| **Transport control** | ✅ Configurable, open source | ❌ Fixed |
| **Maintenance burden** | ⚠️ You own it | ✅ Anthropic maintains it |
| **Hover / mouse move** | ✅ `hover` | ❌ |
| **Drag-and-drop (mouse)** | ✅ `drag` | ❌ |
| **Keyboard key press** | ✅ `key_press` (+ modifiers) | ⚠️ Via type/form input |
| **Input event monitoring** | ✅ `get_input_log` | ❌ |
| **Concurrent session support** | ✅ HTTP MCP, shared persistent server, `claim_tab`/`release_tab` | ❌ Single session |
| **Server architecture** | ✅ Persistent launchd service, HTTP MCP transport | ❌ Subprocess per session |
| **Server registry** | ✅ `~/.webster/registry.json` | ❌ |
| **Total tools** | 40 | ~18 |

---

## Bottom line

Webster now leads on almost every functional dimension. The only things Claude-in-Chrome still has exclusively are **shortcuts/workflows** and the **plan approval flow** — both UX conveniences rather than automation capabilities.

Webster's durable advantages:
- **Multi-browser** — Chrome + Firefox + Safari simultaneously, with routing. Claude-in-Chrome is Chrome-only.
- **Concurrent sessions** — persistent HTTP MCP server handles multiple Claude Code sessions at once with shared browser access. Claude-in-Chrome spawns a new subprocess per session.
- **Automation primitives** — `wait_for`, `wait_for_network_idle`, localStorage, cookies, hover, drag, key_press. Better for building reliable agents.
- **Selector fallback** — automatically retries via a11y tree when CSS selectors fail.
- **Open source / embeddable** — ship Webster with a product. No dependency on Anthropic's extension being available.
- **Input monitoring** — `get_input_log` captures real user mouse/keyboard activity.

The main remaining risk: if Anthropic ships Firefox/Safari extensions through marketplaces, the installation friction gap disappears. The functional and architectural advantages remain.
