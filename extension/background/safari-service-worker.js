// Webster Safari service worker — manages HTTP long-poll connection to MCP server.
// Safari's extension sandbox blocks raw TCP sockets (WebSocket) from service workers,
// so we use HTTP long-polling instead.
//
// This file is concatenated with command-handlers.js during the Safari build.
// Do NOT use ES module import/export syntax here.

const DEFAULT_PORT = 3000
const KEEPALIVE_ALARM = 'webster-keepalive'
const KEEPALIVE_INTERVAL_MINUTES = 0.4 // ~24s, well under Safari's ~30s suspend threshold

let reconnectDelay = 1000
let reconnectTimer = null
let polling = false
let extensionId = null // assigned by server on connect
let lockRelease = null // releases the Web Lock when polling stops

// Guard against browsers where webRequest isn't available (some Safari versions)
try {
  setupNetworkMonitoring()
} catch (e) {
  console.warn('[webster] Network monitoring unavailable:', e)
}

// Use chrome.alarms to keep the service worker alive in Safari.
// Safari aggressively suspends MV3 service workers after ~30s of inactivity.
// Guard: chrome.alarms was added in Safari 16.4 — not available in older versions.
if (chrome.alarms) {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return
    if (!polling) {
      connect()
    }
  })
} else {
  console.warn('[webster] chrome.alarms not available — keepalive disabled (Safari < 16.4)')
}

// chrome.storage.local is used instead of chrome.storage.session because
// Safari does not reliably persist session storage across service worker restarts.
async function getPort() {
  const result = await chrome.storage.local.get('websterPort')
  return result.websterPort || DEFAULT_PORT
}

async function updateState(partial) {
  const result = await chrome.storage.local.get('websterState')
  const current = result.websterState || { connected: false, port: DEFAULT_PORT, commandsExecuted: 0, lastError: null }
  await chrome.storage.local.set({ websterState: { ...current, ...partial } })
}

function scheduleReconnect(port) {
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    connect()
  }, reconnectDelay)
}

async function connect() {
  const port = await getPort()
  const base = `http://localhost:${port}`

  try {
    const resp = await fetch(`${base}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'safari', version: chrome.runtime.getManifest().version }),
      signal: AbortSignal.timeout(5000)
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    extensionId = data.id
    reconnectDelay = 1000
    await updateState({ connected: true, port, lastError: null })
  } catch (err) {
    await updateState({ connected: false, lastError: String(err) })
    scheduleReconnect(port)
    return
  }

  // Hold a Web Lock for the life of the connection so Safari doesn't suspend the SW.
  // The lock is released when polling stops (lockRelease is called in pollLoop's finally block).
  const hasLocks = typeof navigator !== 'undefined' && !!navigator.locks
  if (hasLocks) {
    navigator.locks.request('webster-http-poll', { mode: 'shared' }, () =>
      new Promise((resolve) => { lockRelease = resolve })
    )
  }

  // Start polling loop (runs until disconnect)
  pollLoop(port, base)
}

async function pollLoop(port, base) {
  polling = true
  try {
    while (true) {
      let command
      try {
        const resp = await fetch(`${base}/poll?id=${extensionId}`, { signal: AbortSignal.timeout(28000) })
        if (!resp.ok) throw new Error(`Poll HTTP ${resp.status}`)
        command = await resp.json()
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') continue // normal timeout, poll again
        await updateState({ connected: false, lastError: String(err) })
        polling = false
        scheduleReconnect(port)
        return
      }

      if (command?.type === 'keepalive') continue

      const result = await executeCommand(command)

      try {
        await fetch(`${base}/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: command.id, success: result.success, data: result.data, error: result.error }),
          signal: AbortSignal.timeout(10000)
        })
      } catch (err) {
        console.error('[webster] Failed to send result:', err)
      }

      // Update command count
      const state = await chrome.storage.local.get('websterState')
      const current = state.websterState || {}
      await chrome.storage.local.set({ websterState: { ...current, commandsExecuted: (current.commandsExecuted || 0) + 1 } })
    }
  } finally {
    polling = false
    if (lockRelease) { lockRelease(); lockRelease = null }
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATE') {
    chrome.storage.local.get('websterState').then((r) => {
      sendResponse(r.websterState || { connected: false, port: DEFAULT_PORT, commandsExecuted: 0, lastError: null })
    })
    return true
  }

  if (message.type === 'SET_PORT') {
    chrome.storage.local.set({ websterPort: message.port }).then(() => {
      polling = false
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      reconnectDelay = 1000
      // Disconnect from the server before reconnecting on the new port
      getPort().then((oldPort) => {
        fetch(`http://localhost:${oldPort}/connect?id=${extensionId}`, { method: 'DELETE' }).catch(() => {})
      })
      connect()
      sendResponse({ ok: true })
    })
    return true
  }

  return true
})

// Start connecting when service worker loads
connect()
