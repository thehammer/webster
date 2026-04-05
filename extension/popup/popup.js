const statusEl = document.getElementById('status')
const portEl = document.getElementById('port')
const commandCountEl = document.getElementById('commandCount')
const errorEl = document.getElementById('error')

function updateUI() {
  // Read storage directly — bypasses sendMessage to diagnose whether the SW
  // has ever run, independent of whether it's currently alive.
  chrome.storage.local.get('websterState', function (r) {
    const state = r.websterState
    if (!state) {
      statusEl.textContent = 'Disconnected'
      statusEl.className = 'status disconnected'
      errorEl.textContent = 'Storage empty — SW has never run'
      errorEl.hidden = false
      return
    }

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
  })
}

portEl.addEventListener('change', function () {
  const port = Number(portEl.value)
  if (port > 0 && port < 65536) {
    try {
      chrome.runtime.sendMessage({ type: 'SET_PORT', port }, function () {
        if (chrome.runtime.lastError) { /* ignore */ }
      })
    } catch (e) { /* ignore */ }
  }
})

// Render immediately, then poll for state
updateUI()
setInterval(updateUI, 2000)
