const statusEl = document.getElementById('status')
const portEl = document.getElementById('port')
const commandCountEl = document.getElementById('commandCount')
const errorEl = document.getElementById('error')

function updateUI() {
  try {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, function (state) {
      // Handle Safari/Chrome error when service worker isn't running yet
      if (chrome.runtime.lastError || !state) {
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
  } catch (e) {
    // Service worker not available yet — popup still shows, just no state
  }
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
