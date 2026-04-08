const serversList = document.getElementById('servers-list')
const addPortEl = document.getElementById('add-port')
const addBtn = document.getElementById('add-btn')
const errorEl = document.getElementById('error')

function renderServers(connections, primaryPort, extraPorts) {
  const allPorts = [...new Set([primaryPort, ...extraPorts])]
  serversList.innerHTML = ''

  for (const port of allPorts) {
    const state = connections[port] || {}
    const connected = state.connected || false
    const cmds = state.commandsExecuted || 0
    const isPrimary = port === primaryPort

    const div = document.createElement('div')
    div.className = 'server-row'
    div.innerHTML = `
      <div class="server-header">
        <span class="status ${connected ? 'connected' : 'disconnected'}">${connected ? 'Connected' : 'Disconnected'}</span>
        <span class="port-label">Port ${port}${isPrimary ? ' <em>(primary)</em>' : ''}</span>
        ${!isPrimary ? `<button class="remove-btn" data-port="${port}">✕</button>` : ''}
      </div>
      <div class="server-stats">
        <span class="stat-label">Commands</span>
        <span class="stat-value">${cmds}</span>
        ${isPrimary ? `<span class="stat-label" style="margin-left:8px">Port</span>
        <input class="port-input" type="number" value="${port}" min="1" max="65535" data-port="${port}">` : ''}
      </div>
      ${state.lastError ? `<div class="server-error">${state.lastError}</div>` : ''}
    `
    serversList.appendChild(div)
  }

  // Attach events
  serversList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const port = Number(btn.dataset.port)
      chrome.runtime.sendMessage({ type: 'REMOVE_SERVER', port }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      })
    })
  })

  let portDebounce = null
  serversList.querySelectorAll('.port-input').forEach(input => {
    input.addEventListener('input', () => {
      clearTimeout(portDebounce)
      portDebounce = setTimeout(() => {
        const port = Number(input.value)
        if (port > 0 && port < 65536) {
          chrome.storage.local.set({ websterPort: port })
          chrome.runtime.sendMessage({ type: 'SET_PORT', port }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          })
        }
      }, 500)
    })
  })
}

function updateUI() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // SW not yet running — read storage directly
      chrome.storage.local.get(['websterConnections', 'websterPort', 'websterExtraPorts'], (r) => {
        const port = r.websterPort || 3456
        const extra = r.websterExtraPorts || []
        const conns = r.websterConnections || {}
        renderServers(conns, port, extra)
        if (!r.websterConnections) {
          errorEl.textContent = 'Storage empty — SW has never run'
          errorEl.hidden = false
        } else {
          errorEl.hidden = true
        }
      })
      return
    }
    errorEl.hidden = true
    renderServers(response.connections, response.primaryPort, response.extraPorts)
  })
}

addBtn.addEventListener('click', () => {
  const port = Number(addPortEl.value)
  if (port > 0 && port < 65536) {
    chrome.runtime.sendMessage({ type: 'ADD_SERVER', port }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    })
    addPortEl.value = ''
  }
})

addPortEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBtn.click()
})

// Render immediately, then poll
updateUI()
setInterval(updateUI, 2000)
