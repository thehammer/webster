# Webster Session Notes — 2026-04-08

## What We Did

1. **Set up launchd service** (`com.hammer.webster`) for persistent background server
   - Plist: `~/Library/LaunchAgents/com.hammer.webster.plist`
   - Logs: `~/.webster/webster.log`
   - Had to allow "Jarred Sumner" (Bun's code signing identity) in macOS security

2. **Updated Claude Code MCP config** to use persistent HTTP transport
   - `~/.claude.json` → `{ "type": "http", "url": "http://localhost:3456/mcp" }`
   - Note: `"type": "http"` is required — bare `"url"` fails schema validation

3. **Fixed start_capture hang** on undebugable tabs
   - Broadened URL scheme filter (extension://, devtools://, about:, data:, etc.)
   - Added per-tab 3s timeout on debugger.attach
   - Removed Target.setAutoAttach (added latency, marginal benefit)

4. **Added unified capture** — `start_capture` accepts `includeInput` and `recordGif` flags
   - Network + input events returned in a single time-sorted array with `kind` field
   - GIF frames captured alongside, encoded server-side via ffmpeg

5. **Fixed CDP timestamp bug** — monotonic seconds were being treated as Unix epoch (1970 dates)
   - Now calibrates on first event: records wall-clock offset, converts all subsequent timestamps

6. **Fixed GIF encoder** to handle JPEG frames (capture uses JPEG quality 30 for smaller payloads)

## Known Issues / Not Yet Fixed

### MV3 Service Worker Instability
The biggest ongoing issue. Edge's MV3 service worker is fragile during capture sessions:

- **`setInterval` with async callbacks crashes the SW.** Fixed by switching to self-scheduling `setTimeout` chains with `.then()/.catch()/.finally()`.

- **`stop_capture` must have ZERO `await` calls.** Any await gives Edge an opportunity to kill the SW before the response is sent. The handler is now fully synchronous — builds the response, returns it, then schedules debugger detach via `setTimeout`.

- **Periodic input draining crashes the SW.** The original design drained input events from content scripts every 2s via `setInterval` + `sendToContentScript`. This reliably crashed the SW. Currently disabled — input events accumulate in page-script buffers and are drained once on `get_capture` only. `stop_capture` does NOT drain (zero-await constraint).

- **Large payloads can kill the SW.** PNG screenshots at full resolution (~500KB-1MB each) caused OOM on `sock.send()`. Switched to JPEG quality 30 (~30-50KB per frame). This is adequate for GIF but reduces quality.

- **Server restart invalidates MCP sessions.** After `launchctl stop/start`, Claude Code must be restarted to establish a new MCP session. The `Streamable HTTP error: Session not found` error means this happened.

### Input Capture Gaps

- **`tabsAttached: 0` after extension reconnect.** If the SW dies and restarts during a capture session, all in-memory state (captureBuffer, recordingFrames, capturedTabs) is lost. The debugger attachments may persist at the browser level, but the event listeners are gone. When `stop_capture` runs on the fresh SW, buffers are empty.

- **Content script double-injection.** Programmatic injection (`chrome.scripting.executeScript`) on top of manifest auto-injection caused issues. Added guards (`window.__websterContentScriptLoaded` / `window.__websterPageScriptLoaded`) to prevent double-init.

- **Input drain only happens on `get_capture`, not `stop_capture`.** This means the final ~2s of input events before stop are lost. Could be recovered by calling `get_capture` immediately before `stop_capture` from the MCP tool layer.

### Architecture Observations

- The fundamental tension is: MV3 service workers are designed for short-lived, stateless operations, but capture sessions need long-lived, stateful connections. The WebSocket + Web Lock + chrome.alarms keepalive works most of the time, but Edge is more aggressive than Chrome about killing SWs.

- A more robust approach might be to move capture state to `chrome.storage.session` (persists across SW restarts within a browser session) or to the server side. The server could poll the extension for events rather than the extension pushing them.

- The HTTP long-poll transport (for Safari) might actually be MORE reliable than WebSocket for this use case, since each poll is a fresh request that keeps the SW alive.

## Deployment Checklist

After making changes:
1. `./scripts/build-extension.sh --chrome` — rebuild extension
2. Reload extension in Edge (`edge://extensions` → reload button)
3. If server-side code changed: `launchctl stop com.hammer.webster` (auto-restarts via KeepAlive)
4. If tool schemas changed: restart Claude Code
5. If extension is in crash loop: remove and re-add extension in Edge to clear bad SW state
