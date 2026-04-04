const statusEl = document.getElementById('status')
const portEl = document.getElementById('port')
const commandCountEl = document.getElementById('commandCount')
const errorEl = document.getElementById('error')

async function updateUI() {
  const state = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve)
  })

  if (!state) return

  commandCountEl.textContent = state.commandsExecuted || 0

  if (state.connected) {
    statusEl.textContent = 'Connected'
    statusEl.className = 'status connected'
  } else {
    statusEl.textContent = 'Disconnected'
    statusEl.className = 'status disconnected'
  }

  if (state.port && portEl.value !== String(state.port)) {
    portEl.value = state.port
  }

  if (state.lastError) {
    errorEl.textContent = state.lastError
    errorEl.hidden = false
  } else {
    errorEl.hidden = true
  }
}

portEl.addEventListener('change', () => {
  const port = Number(portEl.value)
  if (port > 0 && port < 65536) {
    chrome.runtime.sendMessage({ type: 'SET_PORT', port })
  }
})

updateUI()
setInterval(updateUI, 2000)
