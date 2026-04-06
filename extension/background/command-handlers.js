// Webster command handlers — maps action names to browser implementations.
// Service worker handles: tab management, screenshots, evalJs, network, cookies.
// Content script handles: DOM operations, localStorage, console.
//
// All handlers return { success: boolean, data?: unknown, error?: string }

// Network request ring buffer (populated by webRequest API)
const networkLog = []
const MAX_NETWORK_LOG = 500

// GIF recording state
let recordingActive = false
let recordingFrames = []
let recordingInterval = null
let recordingTabId = null

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

      // Phase 3: selector fallback via a11y tree (click only — typing into wrong element is dangerous)
      if (!result.success && result.selectorNotFound && action === 'click') {
        const keywords = command.selector
          .replace(/[#.\[\]>+~=^$*|:()]/g, ' ')
          .split(/[\s\-_]+/)
          .filter(w => w.length > 2)
          .map(w => w.toLowerCase())

        if (keywords.length === 0) return result

        const treeResult = await executeCommand({ action: 'getAccessibilityTree', tabId: command.tabId, filter: 'interactive', depth: 8 })
        if (!treeResult.success || !treeResult.data) return result

        function scoreNode(node, kws) {
          const text = `${node.name || ''} ${node.description || ''} ${node.role || ''}`.toLowerCase()
          return kws.filter(k => text.includes(k)).length
        }

        function findBestNode(node, kws, best = { score: 0, node: null }) {
          const score = scoreNode(node, kws)
          if (score > best.score) { best.score = score; best.node = node }
          if (node.children) node.children.forEach(c => findBestNode(c, kws, best))
          return best
        }

        const best = findBestNode(treeResult.data, keywords)
        if (best.score === 0 || !best.node) return result

        return executeCommand({ action: 'clickRef', ref: best.node.ref, tabId: command.tabId })
      }

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

      case 'getAccessibilityTree': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }

        // chrome.automation is Chrome/Edge only
        if (!chrome.automation) {
          return { success: false, error: 'Accessibility tree not available on this browser' }
        }

        return new Promise((resolve) => {
          chrome.automation.getTree(tab.id, (root) => {
            if (!root) {
              resolve({ success: false, error: 'Could not get accessibility tree' })
              return
            }
            const maxDepth = command.depth ?? 10
            const filterInteractive = command.filter === 'interactive'

            const INTERACTIVE_ROLES = new Set([
              'button', 'link', 'textField', 'comboBox', 'checkBox',
              'radioButton', 'menuItem', 'tab', 'slider', 'spinButton',
              'searchBox', 'listBoxOption', 'menuListOption', 'popUpButton',
              'toggleButton', 'switch'
            ])

            function serializeNode(node, depth) {
              if (depth > maxDepth) return null

              const role = node.role || 'unknown'
              const name = node.name || ''
              const loc = node.location || {}
              const bounds = {
                left: Math.round(loc.left ?? 0),
                top: Math.round(loc.top ?? 0),
                width: Math.round(loc.width ?? 0),
                height: Math.round(loc.height ?? 0),
              }
              // Deterministic ref: survives SW restarts, no stored state needed
              const ref = `${role}:${name}:${bounds.left},${bounds.top},${bounds.width},${bounds.height}`

              const children = []
              if (node.firstChild) {
                let child = node.firstChild
                while (child) {
                  const serialized = serializeNode(child, depth + 1)
                  if (serialized) children.push(serialized)
                  child = child.nextSibling
                }
              }

              // For interactive filter: include node if it has interactive role,
              // OR if any descendant does (so we keep the tree structure)
              if (filterInteractive) {
                const isInteractive = INTERACTIVE_ROLES.has(role)
                const hasInteractiveChild = children.length > 0
                if (!isInteractive && !hasInteractiveChild) return null
              }

              const result = { role, name, ref, bounds }
              if (node.description) result.description = node.description
              if (node.value !== undefined && node.value !== null && node.value !== '') result.value = String(node.value)
              if (children.length > 0) result.children = children
              return result
            }

            const tree = serializeNode(root, 0)
            resolve({ success: true, data: tree })
          })
        })
      }

      case 'clickAt': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }

        if (!chrome.debugger) {
          return { success: false, error: 'Debugger API not available on this browser' }
        }

        const target = { tabId: tab.id }
        try {
          await chrome.debugger.attach(target, '1.3')
        } catch (err) {
          // Already attached (e.g. DevTools open) — proceed anyway
        }

        try {
          const baseParams = {
            type: 'mousePressed',
            x: command.x,
            y: command.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
            pointerType: 'mouse',
          }
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...baseParams, type: 'mousePressed' })
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...baseParams, type: 'mouseReleased' })
        } finally {
          try { await chrome.debugger.detach(target) } catch { /* ignore */ }
        }

        return { success: true }
      }

      case 'clickRef': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }

        if (!chrome.automation) {
          return { success: false, error: 'Accessibility tree not available on this browser' }
        }

        // Parse the ref: "role:name:left,top,width,height"
        const ref = command.ref
        const parts = ref.split(':')
        if (parts.length < 3) return { success: false, error: `Invalid ref format: ${ref}` }
        const boundsStr = parts[parts.length - 1]
        const [left, top, width, height] = boundsStr.split(',').map(Number)
        if ([left, top, width, height].some(isNaN)) {
          return { success: false, error: `Cannot parse bounds from ref: ${ref}` }
        }

        // Click the center of the element's bounds
        const x = left + Math.round(width / 2)
        const y = top + Math.round(height / 2)

        // Delegate to clickAt logic
        return executeCommand({ ...command, action: 'clickAt', x, y })
      }

      case 'uploadFile': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, base64Content, filename, mimeType) => {
            const input = document.querySelector(selector)
            if (!input) return { success: false, error: `Element not found: ${selector}` }
            if (input.tagName !== 'INPUT' || input.type !== 'file') {
              return { success: false, error: `Element is not a file input: ${selector}` }
            }
            try {
              const byteString = atob(base64Content)
              const bytes = new Uint8Array(byteString.length)
              for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
              const file = new File([bytes], filename, { type: mimeType })
              const dt = new DataTransfer()
              dt.items.add(file)
              Object.defineProperty(input, 'files', { value: dt.files, writable: false })
              input.dispatchEvent(new Event('change', { bubbles: true }))
              input.dispatchEvent(new Event('input', { bubbles: true }))
              return { success: true }
            } catch (e) {
              return { success: false, error: String(e) }
            }
          },
          args: [command.selector, command.content, command.filename, command.mimeType || 'application/octet-stream'],
        })
        return results?.[0]?.result ?? { success: false, error: 'Script injection failed' }
      }

      case 'dragDropFile': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, x, y, base64Content, filename, mimeType) => {
            try {
              const byteString = atob(base64Content)
              const bytes = new Uint8Array(byteString.length)
              for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i)
              const file = new File([bytes], filename, { type: mimeType })
              const dt = new DataTransfer()
              dt.items.add(file)

              const target = selector
                ? document.querySelector(selector)
                : document.elementFromPoint(x, y)
              if (!target) return { success: false, error: 'Drop target not found' }

              const makeEvent = (type) => {
                const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
                return e
              }
              target.dispatchEvent(makeEvent('dragenter'))
              target.dispatchEvent(makeEvent('dragover'))
              target.dispatchEvent(makeEvent('drop'))
              return { success: true }
            } catch (e) {
              return { success: false, error: String(e) }
            }
          },
          args: [command.selector || null, command.x || 0, command.y || 0, command.content, command.filename, command.mimeType || 'application/octet-stream'],
        })
        return results?.[0]?.result ?? { success: false, error: 'Script injection failed' }
      }

      case 'resizeWindow': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        await chrome.windows.update(tab.windowId, {
          width: command.width,
          height: command.height,
        })
        return { success: true }
      }

      case 'startRecording': {
        if (recordingActive) {
          clearInterval(recordingInterval)
        }
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        recordingTabId = tab.id
        recordingFrames = []
        recordingActive = true
        const intervalMs = Math.round(1000 / (command.fps || 2))
        recordingInterval = setInterval(async () => {
          if (!recordingActive) return
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
            recordingFrames.push({ dataUrl, timestamp: Date.now() })
          } catch { /* tab may have navigated, skip frame */ }
        }, intervalMs)
        return { success: true }
      }

      case 'stopRecording': {
        if (recordingInterval) { clearInterval(recordingInterval); recordingInterval = null }
        recordingActive = false
        const frames = recordingFrames.slice()
        recordingFrames = []
        return { success: true, data: { frames } }
      }

      case 'clearRecording': {
        if (recordingInterval) { clearInterval(recordingInterval); recordingInterval = null }
        recordingActive = false
        recordingFrames = []
        return { success: true }
      }

      default:
        return { success: false, error: `Unknown action: ${action}` }
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
