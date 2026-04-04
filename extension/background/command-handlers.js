// Webster command handlers — maps action names to browser implementations.
// Service worker handles: tab management, screenshots, evalJs, network, cookies.
// Content script handles: DOM operations, localStorage, console.
//
// All handlers return { success: boolean, data?: unknown, error?: string }

// Network request ring buffer (populated by webRequest API)
const networkLog = []
const MAX_NETWORK_LOG = 500

export function setupNetworkMonitoring() {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      networkLog.push({
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        startTime: details.timeStamp,
        tabId: details.tabId,
      })
      if (networkLog.length > MAX_NETWORK_LOG) networkLog.shift()
    },
    { urls: ['<all_urls>'] }
  )

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const entry = networkLog.find((e) => e.requestId === details.requestId)
      if (entry) {
        entry.statusCode = details.statusCode
        entry.endTime = details.timeStamp
        entry.duration = details.timeStamp - entry.startTime
      }
    },
    { urls: ['<all_urls>'] }
  )

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      const entry = networkLog.find((e) => e.requestId === details.requestId)
      if (entry) {
        entry.error = details.error
        entry.endTime = details.timeStamp
      }
    },
    { urls: ['<all_urls>'] }
  )
}

async function getTargetTab(tabId) {
  if (tabId) {
    return chrome.tabs.get(tabId)
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

function sendToContentScript(tabId, command) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, command, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(response)
      }
    })
  })
}

// Actions delegated to content script
const CONTENT_SCRIPT_ACTIONS = new Set([
  'readText', 'readHtml', 'click', 'type', 'waitFor',
  'scrollTo', 'getAttribute', 'getComputedStyle',
  'getLocalStorage', 'setLocalStorage', 'readConsole',
  'getNetworkDetails', 'find',
])

export async function executeCommand(command) {
  const { action } = command

  try {
    // Delegate DOM operations to content script
    if (CONTENT_SCRIPT_ACTIONS.has(action)) {
      const tab = await getTargetTab(command.tabId)
      if (!tab) return { success: false, error: 'No active tab' }
      const result = await sendToContentScript(tab.id, command)
      return result
    }

    switch (action) {
      case 'navigate': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        await chrome.tabs.update(tab.id, { url: command.url })
        await new Promise((resolve) => {
          const listener = (tabId, info) => {
            if (tabId === tab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener)
              resolve()
            }
          }
          chrome.tabs.onUpdated.addListener(listener)
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener)
            resolve()
          }, command.timeout || 10000)
        })
        return { success: true }
      }

      case 'screenshot': {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' })
        return { success: true, data: dataUrl }
      }

      case 'getTabs': {
        const tabs = await chrome.tabs.query({})
        return {
          success: true,
          data: tabs.map((t) => ({
            id: t.id,
            url: t.url,
            title: t.title,
            active: t.active,
            windowId: t.windowId,
          })),
        }
      }

      case 'openTab': {
        const newTab = await chrome.tabs.create({ url: command.url, active: true })
        return { success: true, data: { id: newTab.id, url: newTab.url } }
      }

      case 'closeTab': {
        await chrome.tabs.remove(command.tabId)
        return { success: true }
      }

      case 'switchTab': {
        await chrome.tabs.update(command.tabId, { active: true })
        return { success: true }
      }

      case 'evalJs': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (code) => {
            try { return { success: true, data: eval(code) } }
            catch (e) { return { success: false, error: String(e) } }
          },
          args: [command.code || ''],
        })
        const result = results[0]?.result
        return result?.success
          ? { success: true, data: result.data }
          : { success: false, error: result?.error || 'evalJs failed' }
      }

      case 'getPageInfo': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            url: location.href,
            title: document.title,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            readyState: document.readyState,
          }),
        })
        return { success: true, data: results[0]?.result }
      }

      case 'getNetworkLog': {
        const entries = [...networkLog]
        networkLog.length = 0
        return { success: true, data: entries }
      }

      case 'waitForNetworkIdle': {
        const timeout = command.timeout || 5000
        const idleMs = 500
        const start = Date.now()
        await new Promise((resolve) => {
          const check = () => {
            const inflight = networkLog.filter((e) => !e.endTime)
            if (inflight.length === 0) {
              setTimeout(() => {
                const stillInflight = networkLog.filter((e) => !e.endTime)
                if (stillInflight.length === 0) resolve()
                else if (Date.now() - start > timeout) resolve()
                else check()
              }, idleMs)
            } else if (Date.now() - start > timeout) {
              resolve()
            } else {
              setTimeout(check, 200)
            }
          }
          check()
        })
        const inflight = networkLog.filter((e) => !e.endTime).length
        return { success: true, data: { idle: inflight === 0 } }
      }

      case 'getCookies': {
        const targetUrl = command.url || (await getTargetTab(command.tabId))?.url
        if (!targetUrl) return { success: false, error: 'No URL available' }
        const cookies = await chrome.cookies.getAll({ url: targetUrl })
        return {
          success: true,
          data: cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
          })),
        }
      }

      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
