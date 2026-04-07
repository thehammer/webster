// Webster service worker — manages WebSocket connection to MCP server,
// receives commands and dispatches them to the browser.
import { executeCommand, setupNetworkMonitoring } from './command-handlers.js'

const DEFAULT_PORT = 3456
const KEEPALIVE_ALARM = 'webster-keepalive'
const KEEPALIVE_INTERVAL_MINUTES = 0.4 // ~24s, well under Safari's ~30s suspend threshold

let ws = null
let reconnectDelay = 1000
let reconnectTimer = null

function detectBrowser() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  if (/Edg\//.test(ua)) return 'edge'
  if (/Chrome/.test(ua)) return 'chrome'
  if (/Firefox/.test(ua)) return 'firefox'
  return 'unknown'
}

// Guard against browsers where webRequest isn't available (some Safari versions)
try {
  setupNetworkMonitoring()
} catch (e) {
  console.warn('[webster] Network monitoring unavailable:', e)
}

// Use chrome.alarms to keep the service worker alive in Safari.
// Safari aggressively suspends MV3 service workers after ~30s of inactivity,
// which kills the WebSocket. The alarm fires every ~24s to prevent suspension.
// Guard: chrome.alarms was added in Safari 16.4 — not available in older versions.
// Firefox enforces a minimum alarm interval of 1 minute — guard with try/catch.
if (chrome.alarms) {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES })
  } catch {
    // Firefox rejects sub-minute intervals; keepalive is less critical for Firefox
    // background pages anyway, but create at 1 minute as a fallback
    try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 }) } catch { /* ignore */ }
  }
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return
    if (!ws || ws.readyState === WebSocket.CLOSED) {
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

async function connect() {
  const port = await getPort()
  const url = `ws://localhost:${port}`

  let sock
  try {
    sock = new WebSocket(url)
  } catch (err) {
    await updateState({ connected: false, lastError: String(err) })
    scheduleReconnect(port)
    return
  }
  ws = sock

  // ---- Synchronous from here — no await until an event fires ----

  // Hold a Web Lock for the life of the connection so Safari doesn't suspend the SW.
  const hasLocks = typeof navigator !== 'undefined' && !!navigator.locks
  if (hasLocks) {
    navigator.locks.request('webster-connection', { mode: 'shared' }, () =>
      new Promise((resolve) => {
        sock.addEventListener('close', resolve)
        sock.addEventListener('error', resolve)
      })
    )
  }

  sock.addEventListener('open', async () => {
    console.log('[webster] Connected to MCP server')
    reconnectDelay = 1000
    sock.send(JSON.stringify({ type: 'connected', version: chrome.runtime.getManifest().version, browser: detectBrowser() }))
    await updateState({ connected: true, port, lastError: null })
  })

  sock.addEventListener('message', async (event) => {
    let command
    try {
      command = JSON.parse(event.data)
    } catch {
      console.error('[webster] Failed to parse command:', event.data)
      return
    }

    const result = await executeCommand(command)
    sock.send(JSON.stringify({ id: command.id, success: result.success, data: result.data, error: result.error }))

    const state = await chrome.storage.local.get('websterState')
    const current = state.websterState || {}
    await chrome.storage.local.set({
      websterState: { ...current, commandsExecuted: (current.commandsExecuted || 0) + 1 }
    })
  })

  sock.addEventListener('close', async () => {
    console.log('[webster] Disconnected from MCP server')
    await updateState({ connected: false })
    ws = null
    scheduleReconnect(port)
  })

  sock.addEventListener('error', async () => {
    await updateState({ connected: false, lastError: 'Connection error' })
  })
}

function scheduleReconnect(port) {
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
    connect()
  }, reconnectDelay)
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
      if (ws) { ws.close(); ws = null }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      reconnectDelay = 1000
      connect()
      sendResponse({ ok: true })
    })
    return true
  }

  return true
})

// Start connecting when service worker loads
connect()
