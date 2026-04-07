const statusEl = document.getElementById('status')
const portEl = document.getElementById('port')
const commandCountEl = document.getElementById('commandCount')
const errorEl = document.getElementById('error')

function updateUI() {
  // Read storage directly — bypasses sendMessage to diagnose whether the SW
  // has ever run, independent of whether it's currently alive.
  chrome.storage.local.get(['websterState', 'websterPort'], function (r) {
    const state = r.websterState
    // Port source of truth is websterPort, not websterState.port
    const port = r.websterPort || (state && state.port) || 3456

    // Update port display from storage, but don't clobber while user is typing
    if (portEl !== document.activeElement && portEl.value !== String(port)) {
      portEl.value = port
    }

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

    if (state.lastError) {
      errorEl.textContent = state.lastError
      errorEl.hidden = false
    } else {
      errorEl.hidden = true
    }
  })
}

let portDebounce = null
portEl.addEventListener('input', function () {
  clearTimeout(portDebounce)
  portDebounce = setTimeout(function () {
    const port = Number(portEl.value)
    if (port > 0 && port < 65536) {
      try {
        // Save immediately so updateUI reads the new value
        chrome.storage.local.set({ websterPort: port })
        chrome.runtime.sendMessage({ type: 'SET_PORT', port }, function () {
          if (chrome.runtime.lastError) { /* ignore */ }
        })
      } catch (e) { /* ignore */ }
    }
  }, 500)
})

// Render immediately, then poll for state
updateUI()
setInterval(updateUI, 2000)
