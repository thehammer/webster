# Per-session browsers and native browser peers

This is the contract between the Webster server and anything that connects a
browser to it: the extensions, and native peers such as the Nostromo embedded
browser pane (`kind: "webkit"`). It covers how a Claude session picks a
browser, the registration protocol for native peers, and the network guards.

Webster is one process serving every Claude Code session on the machine. Until
BP0 it had one global "active browser". Now each MCP session has its own.

## 1. Who is calling: sessions and owners (D1)

- The unit of selection is **one MCP session** — one Claude Code process, plus
  its subagents, which share the parent's MCP connection.
- A session's **owner** is the `X-Webster-Owner` header on its `initialize`
  request. It is read once and bound for the session's life; later requests'
  headers are ignored.
  - Format: an opaque token matching `^[A-Za-z0-9_-]{32,128}$`.
  - Absent, or an empty string: **unowned**. Empty must work so a config such as
    `"headers": {"X-Webster-Owner": "${NOSTROMO_WEBSTER_OWNER:-}"}` is harmless
    outside Nostromo.
  - Present but malformed: `400 {"error":"Invalid X-Webster-Owner header"}`, no
    session is created.
- The token is a **secret**. Webster never returns it from a tool or HTTP API
  and never logs it. Logs may show `ownerFp`, the first 8 hex characters of
  `sha256(token)`.

Suggested Claude Code config for a Nostromo focus session:

```json
{
  "mcpServers": {
    "webster": {
      "type": "http",
      "url": "http://localhost:3456/mcp",
      "headers": { "X-Webster-Owner": "${NOSTROMO_WEBSTER_OWNER:-}" }
    }
  }
}
```

## 2. Which browser a command goes to (D2)

Every connected browser has an `owner`: `null` for every extension, the token
for a webkit peer. A browser is **visible** to a session iff
`browser.owner === null || browser.owner === session.owner`.

A session's binding is `null`, or `{ mode: "explicit" | "implicit", browserId,
kind, browserName, instanceId?, connectedAt, label, ... }`.

1. **No binding.** Use the *server default*: the visible, unowned browser with
   the earliest `connectedAt` that is still connected. Owned peers are never the
   default, even for their owner. If there is none, the command fails with
   `Extension not connected`. Otherwise an **implicit** binding to it is stored,
   so a session's first command fixes the browser it uses.
2. **Bound browser still connected** (and visible): use it.
3. **Otherwise** try a rebind (section 3).
4. **Otherwise** fail with the gone error (section 4). Webster **never** picks
   another browser.

`set_browser(x)` resolves `x` among **visible** browsers only: an exact id
first, then the first visible extension whose `browser` name equals `x` (webkit peers only match by name when no extension does). It stores
an **explicit** binding. With no match it fails with
`No connected extension matching '<x>'`. The same text is used for a pane that
belongs to another owner, so a pane's existence never leaks to other focuses.

`server.dispatch(command, timeoutMs?, ctx?)` without a context is the legacy
path used by `/api/capture/*`. It targets the server default each time and
stores no binding.

## 3. Rebind: the same browser coming back (D3)

A lost binding rebinds to browser `c` only if **exactly one** visible connected
`c` satisfies all of:

- `c.kind === binding.kind`
- `c.browser === binding.browserName`
- `c.connectedAt > binding.connectedAt`
- if both have an `instanceId`, they are equal
- for `kind: "webkit"`, `c.instanceId === binding.instanceId` is **required**
- `binding.closed !== true`

This covers a Chrome MV3 service-worker restart, a Safari HTTP re-connect, and a
pane reconnecting after a Nostromo daemon restart. A same-name browser that was
connected *before* the bound one never qualifies.

Residual: two profiles of the same browser, both without an `instanceId`, can't
be told apart. If both reconnect, the result is ambiguous and the gone error is
raised. The extension handshake (and `POST /connect`) accept an optional
`instanceId` so a later extension change can close this gap. No extension code
sends one yet.

## 4. No-fallback errors (D4)

`label` is an extension's `browser` name (`chrome`, `edge`, `safari`, ...). A
webkit peer's label is `nostromo, focus "<focus.name>"`.

| Situation | Text |
|---|---|
| Next command after the loss | `The selected browser is gone (<label>): call get_browsers and set_browser` |
| Same, peer gave a reason | `The selected browser is gone (<label>: <reason>): call get_browsers and set_browser` |
| In flight when the browser drops | `Extension disconnected. ` + the gone text |
| Tool the peer declared unsupported | `Not supported in the Nostromo browser (WebKit): <reason>. Use set_browser("chrome") for this.` |

Only commands sent to the browser that dropped are rejected. Commands in flight
on other browsers are untouched. An unsupported-tool error is raised before
dispatch; the peer receives nothing.

## 5. The native peer registration contract (D5)

Native peers use the same WebSocket endpoint and result protocol as extensions:
results are `{ id, success, data?, error? }`. Every peer-to-server message is a
JSON object with a `type` and **no top-level `id`**, because results are
recognised by the presence of `id`. Webkit peers are WebSocket-only; HTTP
`/connect` cannot register one.

### Handshake (must be the first message)

```json
{
  "type": "connected",
  "kind": "webkit",
  "version": "1.0.0",
  "browser": "nostromo",
  "instanceId": "pane-3f9a1c2e",
  "owner": "k3Jx9...32-to-128-url-safe-characters",
  "engine": "webkit",
  "focus": { "tag": "payments", "name": "Payments" },
  "profile": "Work",
  "driver": "agent",
  "limitations": [
    { "area": "accessibility", "missing": "no AX tree access", "tools": ["get_accessibility_tree"] }
  ],
  "toolSupport": {
    "get_accessibility_tree": { "level": "unsupported", "note": "no AX tree access" },
    "screenshot": { "level": "approximate", "note": "viewport only" }
  }
}
```

| Field | Rule |
|---|---|
| `browser` | must be `nostromo` (default); any other name is refused so a peer cannot squat an extension's name. Extensions in turn cannot register as `nostromo` (WS handshake closed 1008, `POST /connect` 400) |
| `instanceId` | `^[A-Za-z0-9_-]{8,128}$`, required, stable per pane |
| `owner` | the D1 token format, required |
| `engine` | `^[a-z0-9-]{1,32}$`, default `webkit` |
| `focus` | `{ tag, name }`, each at most 128 chars, required |
| `profile` | at most 64 chars, e.g. `Work`, `Ephemeral`, `Private` |
| `driver` | `agent`, `user` or `stopped`, required |
| `limitations` | at most 64 items, strings at most 300 chars |
| `toolSupport` | optional; `level` is `parity`, `approximate` or `unsupported` |

Webster **refuses** the registration, by closing the socket with code `1008` and
a short reason, when any of these hold:

- the upgrade request was not from loopback,
- the upgrade request carried **any** `Origin` header,
- a field fails validation,
- a **live** connection already holds the same `instanceId`.

A refused peer is never listed and receives nothing. The log line says why,
without the token. This check is always applied, even with
`WEBSTER_ALLOW_NON_LOOPBACK=1`.

A handshake without `kind`, or with `kind: "extension"`, is the extension path.
Extensions are **always** unowned: any `owner` they send is ignored.

### Later messages

- `{ "type": "peer_state", "driver"?, "profile"?, "focus"?, "limitations"?, "toolSupport"? }`
  updates what `get_browsers` shows. Validated like the handshake. Accepted only
  from a registered webkit connection; ignored from anything else.
- `{ "type": "select_for_owner" }` pins this peer as the **explicit** binding for
  every *current* session whose owner equals the peer's owner. It also records
  the pin, so sessions of that owner initialized *later* start explicitly bound.
  A session's own later `set_browser` overrides the pin for that session only.
  This is how "open request returns a browser already selected for that session"
  works.
- `{ "type": "unregister", "reason"?: "the Nostromo browser pane was closed" }`
  means "I am closing for good". The reason is capped at 200 chars with newlines
  stripped. Webster rejects the peer's in-flight commands with the D4 in-flight
  text (reason included), drops it from `get_browsers` at once, marks every
  binding to it `closed` so a reconnect with the same `instanceId` never rebinds
  them, and clears its pins.
- A plain socket close without `unregister` (daemon crash or restart) is an
  ordinary loss; rebind by `instanceId` applies.
- Unknown `type`s are logged and ignored. They are never treated as a handshake.

### Reserved, not implemented in Webster (for BP1/BP3)

- **Driver enforcement stays in the peer.** While `driver !== "agent"`, the peer
  fails action commands itself with the PRD's messages. Webster only displays
  `driver`.
- **Every command a peer receives from Webster is an agent action.** The peer
  must never count it as human input, and must never treat its own synthesized
  input as a takeover (BP1 trusted input).
- **`fidelity: "approximate"`** plus a note in result `data` is added by the peer
  (BP3). Webster passes it through untouched.
- **Captures are not scoped per owner.** See section 7. BP3 must fix this before
  pane captures exist.

## 6. Loopback, Host and Origin (D6)

Checked in `handleFetch` before routing, for every route:

- **Address.** The peer's address (`server.requestIP`) must be loopback:
  `127.0.0.0/8`, `::1` or `::ffff:127.x.x.x`. Otherwise `403`
  `Webster accepts loopback connections only`. The bind address is unchanged;
  checking the peer address avoids IPv4/IPv6 `localhost` surprises.
- **Host.** The `Host` hostname must be `localhost`, `127.0.0.1` or `[::1]`, any
  port. Otherwise `403` `Webster: unexpected Host header`. This is the
  DNS-rebinding guard.
- **Origin**, on the extension and MCP endpoints only (WebSocket upgrade,
  `POST`/`DELETE /connect`, `GET /poll`, `POST /result`, `/mcp`): `403` when an
  `Origin` is present and is either `http:`/`https:` or the literal `null`,
  because that is a web page. Extension schemes (`chrome-extension://`,
  `moz-extension://`, `safari-web-extension://`) and an absent `Origin` (Claude
  Code's MCP client, native peers) are allowed. The dashboard and replay pages
  only call `/api/*` and `/replay/*`, so those routes are not Origin-checked.
- **State-changing `/api/*` calls** (any method other than `GET`/`HEAD`) with a
  web-page `Origin` are refused unless the `Origin` is the server's own
  (same-origin, as the dashboard's fetches are). A text/plain `POST` needs no CORS
  preflight, so without this a page could start or stop captures. The request
  body of `/api/capture/start` also cannot override the command sent to the
  browser.
- **Escape hatch.** `WEBSTER_ALLOW_NON_LOOPBACK=1` disables the address and Host
  checks for every route **except** webkit peer registration. Off by default.
  It also drops owner isolation from the network: a remote caller can send any
  `X-Webster-Owner` and so act as that owner.

Known limits:

- **Not loopback-bound.** `lsof` still shows `*:3456`. Webster refuses
  non-loopback peers instead of binding loopback-only: Bun's `serve` takes one
  `hostname`, and binding `127.0.0.1` or `::1` alone breaks `localhost` for the
  other family. A LAN host can still open a TCP connection and hold it idle
  (Webster disables the HTTP idle timeout for long-polls; a WebSocket that
  never handshakes is closed after 10s); it never gets past the `403`.
- **Extension schemes are allow-listed wholesale.** Any installed extension
  (not just Webster's) with host permission for `localhost` can drive Webster.

## 7. Captures (D7)

- There is still one global capture; starting a new one finalizes the previous.
- A capture records `captureOwner`: the owner of the browser `start_capture`
  dispatched to (`null` for extensions and for `/api/capture/start`).
- `capture_event`, `capture_body` and `capture_done` pushes are accepted only
  from a currently registered browser whose owner equals `captureOwner`. A socket
  that never handshook, or a peer that sent `unregister` (its socket stays open),
  is dropped, not treated as unowned. Sockets that do not register within 10s
  are closed. Command results are likewise accepted only from the browser the
  command was sent to. HTTP-transport pushes
  (Safari) are the exception and are unowned. So an unowned reconnect still feeds an extension
  capture, while pane events never enter a Chrome capture and vice versa.
- `stop_capture` finalizes the server-side session even when the browser can't be
  told to stop, and returns the snapshot plus
  `warning: "Could not tell the browser to stop capturing: <err>"`.
- **Not done:** `get_capture`, `export_har`, `redact_capture` and `export_video`
  stay server-global. Another focus could read a pane capture. BP3 must scope
  these before pane captures exist.

## 8. `get_browsers` and `/api/status` (D8)

`get_browsers` returns the **visible** browsers only, as an array. Each entry has
`id`, `browser`, `version`, `transport`, `kind` (`extension` | `webkit`),
`engine` and `active`. `engine` is `chromium` for chrome/edge, `gecko` for
firefox, `webkit` for safari, `unknown` otherwise; a peer reports its own.

`active` is per session: true for the browser the session's next command would
reach, computed without side effects (it never creates a binding). If the
binding is gone, every entry is `active: false`.

Webkit entries also carry `focus`, `profile`, `driver`, `limitations` and
`toolSupport` when sent. They never carry the owner token or its fingerprint.

`/api/status.extensions` lists **unowned** browsers only, so the menu bar and
dashboard decoders are unchanged. There `active` means "is the server default".
Entries add `kind` and `engine`. The body also has a top-level
`ownedBrowserCount`.

## 9. Threat model (D9)

**What BP0 guarantees**

- No host on the network and no web page in any browser can reach Webster
  (address, Host and Origin checks).
- A well-behaved Claude session never sees or drives another focus's pane, and a
  pane opening or closing never changes another session's target.
- The owner token is never returned or logged by Webster.

**What a hostile process running as the same macOS user can still do**

- read the token from a Claude process's environment or config files;
- register a fake pane or fake extension over loopback;
- drive any pane with a stolen token.

Webster cannot distinguish same-user processes over a loopback socket. That
process could already read the Work profile's cookies from disk, or drive the
Mac app through Accessibility. Mitigation is outside Webster: Nostromo mints a
fresh random token per focus, injects it only into that focus's sessions, and
rotates it when the pane re-registers. Treat this as **accidental cross-talk
protection plus network and web isolation, not a same-user security boundary**.

Known gap: claiming a tab (`claim_tab`) still records the same owner for every
session, so it does not coordinate across sessions.
