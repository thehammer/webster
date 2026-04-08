// Webster service worker — manages WebSocket connections to one or more MCP servers.
// Supports concurrent Claude sessions: each server gets its own persistent connection.
// Commands from each server are executed and responses routed back to the originating socket.
import { executeCommand, setupNetworkMonitoring } from './command-handlers.js'

const DEFAULT_PORT = 3456
const KEEPALIVE_ALARM = 'webster-keepalive'
const KEEPALIVE_INTERVAL_MINUTES = 0.4 // ~24s, well under Safari's ~30s suspend threshold

// One entry per configured server port
// { ws, reconnectDelay, reconnectTimer, commandsExecuted }
const connections = new Map()

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
if (chrome.alarms) {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES })
  } catch {
    try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 }) } catch { /* ignore */ }
  }
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return
    // Reconnect any dropped connections
    reconnectDropped()
  })
} else {
  console.warn('[webster] chrome.alarms not available — keepalive disabled (Safari < 16.4)')
}

async function getConfiguredPorts() {
  const result = await chrome.storage.local.get(['websterPort', 'websterExtraPorts'])
  const primary = result.websterPort || DEFAULT_PORT
  const extra = Array.isArray(result.websterExtraPorts) ? result.websterExtraPorts : []
  // Deduplicate
  return [...new Set([primary, ...extra])]
}

async function updateConnectionState() {
  const state = {}
  for (const [port, conn] of connections) {
    state[port] = {
      connected: conn.ws && conn.ws.readyState === WebSocket.OPEN,
      commandsExecuted: conn.commandsExecuted || 0,
      lastError: conn.lastError || null,
    }
  }
  await chrome.storage.local.set({ websterConnections: state })
}

async function connectToPort(port) {
  // Don't open a second socket to the same port
  const existing = connections.get(port)
  if (existing?.ws && existing.ws.readyState !== WebSocket.CLOSED) return

  const url = `ws://localhost:${port}`
  let sock
  try {
    sock = new WebSocket(url)
  } catch (err) {
    const conn = connections.get(port) || { commandsExecuted: 0 }
    conn.lastError = String(err)
    conn.ws = null
    connections.set(port, conn)
    scheduleReconnect(port)
    await updateConnectionState()
    return
  }

  const conn = connections.get(port) || { commandsExecuted: 0, reconnectDelay: 1000 }
  conn.ws = sock
  conn.lastError = null
  connections.set(port, conn)

  // Hold a Web Lock for the life of this connection so Safari doesn't suspend the SW.
  const hasLocks = typeof navigator !== 'undefined' && !!navigator.locks
  if (hasLocks) {
    navigator.locks.request(`webster-connection-${port}`, { mode: 'shared' }, () =>
      new Promise((resolve) => {
        sock.addEventListener('close', resolve)
        sock.addEventListener('error', resolve)
      })
    )
  }

  sock.addEventListener('open', async () => {
    console.log(`[webster] Connected to MCP server on port ${port}`)
    conn.reconnectDelay = 1000
    sock.send(JSON.stringify({ type: 'connected', version: chrome.runtime.getManifest().version, browser: detectBrowser() }))
    await updateConnectionState()
  })

  sock.addEventListener('message', async (event) => {
    let command
    try {
      command = JSON.parse(event.data)
    } catch {
      console.error('[webster] Failed to parse command:', event.data)
      return
    }
    // Keepalive ping from server — no response needed
    if (command.type === 'keepalive') return

    const result = await executeCommand(command)
    sock.send(JSON.stringify({ id: command.id, success: result.success, data: result.data, error: result.error }))

    conn.commandsExecuted = (conn.commandsExecuted || 0) + 1
    // Debounced state update — avoid hammering storage on every command
    clearTimeout(conn._stateTimer)
    conn._stateTimer = setTimeout(updateConnectionState, 500)
  })

  sock.addEventListener('close', async () => {
    console.log(`[webster] Disconnected from MCP server on port ${port}`)
    conn.ws = null
    await updateConnectionState()
    scheduleReconnect(port)
  })

  sock.addEventListener('error', async () => {
    conn.lastError = 'Connection error'
    await updateConnectionState()
  })
}

function scheduleReconnect(port) {
  const conn = connections.get(port) || { reconnectDelay: 1000 }
  connections.set(port, conn)
  if (conn.reconnectTimer) return // already scheduled
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null
    conn.reconnectDelay = Math.min((conn.reconnectDelay || 1000) * 2, 30000)
    connectToPort(port)
  }, conn.reconnectDelay || 1000)
}

function reconnectDropped() {
  getConfiguredPorts().then(ports => {
    for (const port of ports) {
      const conn = connections.get(port)
      if (!conn?.ws || conn.ws.readyState === WebSocket.CLOSED) {
        connectToPort(port)
      }
    }
  })
}

async function connectAll() {
  const ports = await getConfiguredPorts()
  for (const port of ports) {
    connectToPort(port)
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATE') {
    chrome.storage.local.get(['websterConnections', 'websterPort', 'websterExtraPorts']).then((r) => {
      sendResponse({
        connections: r.websterConnections || {},
        primaryPort: r.websterPort || DEFAULT_PORT,
        extraPorts: r.websterExtraPorts || [],
      })
    })
    return true
  }

  if (message.type === 'SET_PORT') {
    // Change primary port: close old primary connection, open new one
    chrome.storage.local.get('websterPort').then(async (r) => {
      const oldPort = r.websterPort || DEFAULT_PORT
      const newPort = message.port
      await chrome.storage.local.set({ websterPort: newPort })
      // Close old connection if it differs
      if (oldPort !== newPort) {
        const oldConn = connections.get(oldPort)
        if (oldConn?.ws) { oldConn.ws.close(); oldConn.ws = null }
        if (oldConn?.reconnectTimer) { clearTimeout(oldConn.reconnectTimer); oldConn.reconnectTimer = null }
        connections.delete(oldPort)
      }
      await connectToPort(newPort)
      sendResponse({ ok: true })
    })
    return true
  }

  if (message.type === 'ADD_SERVER') {
    const port = message.port
    chrome.storage.local.get('websterExtraPorts').then(async (r) => {
      const extra = Array.isArray(r.websterExtraPorts) ? r.websterExtraPorts : []
      if (!extra.includes(port)) {
        await chrome.storage.local.set({ websterExtraPorts: [...extra, port] })
      }
      await connectToPort(port)
      sendResponse({ ok: true })
    })
    return true
  }

  if (message.type === 'REMOVE_SERVER') {
    const port = message.port
    chrome.storage.local.get(['websterPort', 'websterExtraPorts']).then(async (r) => {
      const primary = r.websterPort || DEFAULT_PORT
      if (port === primary) { sendResponse({ ok: false, error: 'Cannot remove primary port' }); return }
      const extra = (r.websterExtraPorts || []).filter(p => p !== port)
      await chrome.storage.local.set({ websterExtraPorts: extra })
      const conn = connections.get(port)
      if (conn?.ws) { conn.ws.close(); conn.ws = null }
      if (conn?.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null }
      connections.delete(port)
      await updateConnectionState()
      sendResponse({ ok: true })
    })
    return true
  }

  return true
})

// Start connecting to all configured servers when service worker loads
connectAll()
