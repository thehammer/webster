// Webster service worker — manages WebSocket connection to MCP server,
// receives commands and dispatches them to the browser.
import { executeCommand, setupNetworkMonitoring } from './command-handlers.js'

const DEFAULT_PORT = 3000
let ws = null
let reconnectDelay = 1000
let reconnectTimer = null

setupNetworkMonitoring()

async function getPort() {
  const result = await chrome.storage.session.get('websterPort')
  return result.websterPort || DEFAULT_PORT
}

async function updateState(partial) {
  const result = await chrome.storage.session.get('websterState')
  const current = result.websterState || { connected: false, port: DEFAULT_PORT, commandsExecuted: 0, lastError: null }
  await chrome.storage.session.set({ websterState: { ...current, ...partial } })
}

async function connect() {
  const port = await getPort()
  const url = `ws://localhost:${port}`

  try {
    ws = new WebSocket(url)
  } catch (err) {
    await updateState({ connected: false, lastError: String(err) })
    scheduleReconnect(port)
    return
  }

  ws.addEventListener('open', async () => {
    console.log('[webster] Connected to MCP server')
    reconnectDelay = 1000
    ws.send(JSON.stringify({ type: 'connected', version: chrome.runtime.getManifest().version }))
    await updateState({ connected: true, port, lastError: null })
  })

  ws.addEventListener('message', async (event) => {
    let command
    try {
      command = JSON.parse(event.data)
    } catch {
      console.error('[webster] Failed to parse command:', event.data)
      return
    }

    const result = await executeCommand(command)
    ws.send(JSON.stringify({ id: command.id, success: result.success, data: result.data, error: result.error }))

    const state = await chrome.storage.session.get('websterState')
    const current = state.websterState || {}
    await chrome.storage.session.set({
      websterState: { ...current, commandsExecuted: (current.commandsExecuted || 0) + 1 }
    })
  })

  ws.addEventListener('close', async () => {
    console.log('[webster] Disconnected from MCP server')
    await updateState({ connected: false })
    ws = null
    scheduleReconnect(port)
  })

  ws.addEventListener('error', async () => {
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
    chrome.storage.session.get('websterState').then((r) => {
      sendResponse(r.websterState || { connected: false, port: DEFAULT_PORT, commandsExecuted: 0, lastError: null })
    })
    return true
  }

  if (message.type === 'SET_PORT') {
    chrome.storage.session.set({ websterPort: message.port }).then(() => {
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
