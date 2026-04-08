// Webster command handlers — maps action names to browser implementations.
// Service worker handles: tab management, screenshots, evalJs, network, cookies.
// Content script handles: DOM operations, localStorage, console.
//
// All handlers return { success: boolean, data?: unknown, error?: string }

import { pushToServer } from './service-worker.js'

// Network request ring buffer (populated by webRequest API)
const networkLog = []
const MAX_NETWORK_LOG = 500

// ─── Deep capture state (Chrome Debugger API) ──────────────────────────────
// Captures full request/response bodies across ALL windows including popups.
// Events stream to the server in real-time via pushToServer() — the extension
// does NOT buffer capture data. This makes capture resilient to SW restarts.
let captureActive = false
let capturePending = new Map()   // requestId -> partial entry (waiting for response body)
let capturedTabs = new Set()     // tabIds with debugger attached
let captureUrlFilter = null      // only capture URLs containing this string
let captureInputEnabled = false  // when true, periodically drain input events from tabs
let captureInputInterval = null  // interval handle for input draining
let captureStartWallMs = 0       // Date.now() at capture start — used to convert CDP monotonic timestamps
let captureStartMonotonic = 0    // first CDP timestamp seen — used with captureStartWallMs for conversion
let captureMonotonicCalibrated = false
let captureRecordingFrames = false // true when recordFrames is active — tells drainInputEvents to show cursor
let captureCursorShown = false     // true once we've sent showCursor to content scripts
const MAX_CAPTURE_BODY = 512000  // 500KB max per response body
const INPUT_DRAIN_INTERVAL_MS = 2000

function matchesCaptureFilter(url) {
  if (!captureUrlFilter) return true
  return url.toLowerCase().includes(captureUrlFilter.toLowerCase())
}

// CDP timestamps are monotonic seconds (like performance.now()/1000), not Unix epoch.
// We calibrate on the first event: record both Date.now() and the CDP timestamp,
// then compute wall-clock time for all subsequent events via offset.
function cdpTimestampToIso(cdpTimestamp) {
  if (!captureMonotonicCalibrated) {
    captureStartMonotonic = cdpTimestamp
    captureStartWallMs = Date.now()
    captureMonotonicCalibrated = true
  }
  const offsetMs = (cdpTimestamp - captureStartMonotonic) * 1000
  return new Date(captureStartWallMs + offsetMs).toISOString()
}

function cdpTimestampToEpochMs(cdpTimestamp) {
  if (!captureMonotonicCalibrated) {
    captureStartMonotonic = cdpTimestamp
    captureStartWallMs = Date.now()
    captureMonotonicCalibrated = true
  }
  return captureStartWallMs + (cdpTimestamp - captureStartMonotonic) * 1000
}

// Tabs with these URL schemes can't be debugged — attach will hang or throw
const UNDEBUGABLE_SCHEMES = [
  'chrome://', 'chrome-extension://', 'edge://', 'extension://',
  'devtools://', 'about:', 'data:', 'view-source:',
]

function isDebugable(url) {
  if (!url) return false
  return !UNDEBUGABLE_SCHEMES.some(scheme => url.startsWith(scheme))
}

// Race a promise against a timeout — prevents a single tab from hanging the whole batch
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ])
}

async function attachDebuggerToTab(tabId) {
  if (capturedTabs.has(tabId)) return
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!isDebugable(tab.url)) return
    await withTimeout(chrome.debugger.attach({ tabId }, '1.3'), 3000)
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {})
    capturedTabs.add(tabId)
  } catch (e) {
    // Already attached, not debuggable, or timed out — skip
  }
}

async function detachDebuggerFromTab(tabId) {
  if (!capturedTabs.has(tabId)) return
  try {
    await chrome.debugger.detach({ tabId })
  } catch { /* ignore */ }
  capturedTabs.delete(tabId)
}

function onCaptureTabCreated(tab) {
  if (captureActive && tab.id) {
    attachDebuggerToTab(tab.id)
  }
}

// Also catch tabs via webNavigation — fires earlier than onCreated for popups
function onCaptureNavigation(details) {
  if (captureActive && details.tabId && details.frameId === 0) {
    attachDebuggerToTab(details.tabId)
  }
}

// Chrome Debugger Protocol events
function handleDebuggerEvent(source, method, params) {
  if (!captureActive) return
  const tabId = source.tabId

  // Handle auto-attached targets (popups opened from a debugged tab)
  if (method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = params
    if (targetInfo?.type === 'page' && sessionId) {
      // Enable network monitoring on the new target and resume it
      try {
        chrome.debugger.sendCommand({ tabId }, 'Network.enable', {})
        chrome.debugger.sendCommand({ tabId }, 'Runtime.runIfWaitingForDebugger', {})
      } catch { /* ignore */ }
    }
    return
  }

  // Namespace requestId by tabId — requestIds are only unique per tab
  const key = `${tabId}:${params.requestId}`

  if (method === 'Network.requestWillBeSent') {
    const { request, type, timestamp, redirectResponse } = params
    if (!matchesCaptureFilter(request.url)) return

    // If this is a redirect, stream the redirect entry to server (don't use finalizeEntry
    // — it deletes the key, but we're about to set a new pending entry for the same key)
    if (redirectResponse && capturePending.has(key)) {
      const prev = capturePending.get(key)
      prev.status = redirectResponse.status
      prev.responseHeaders = redirectResponse.headers || {}
      prev.mimeType = redirectResponse.mimeType
      prev.responseBody = null // redirects have no body
      prev.endTime = timestamp
      prev.duration = Math.round((timestamp - prev._startTimestamp) * 1000)
      prev.redirectedTo = request.url
      prev.kind = 'network'
      prev.timestamp = cdpTimestampToEpochMs(prev._startTimestamp)
      delete prev._startTimestamp
      delete prev._requestId
      pushToServer({ type: 'capture_event', kind: 'network', data: prev })
    }

    capturePending.set(key, {
      tabId,
      url: request.url,
      method: request.method,
      type,
      requestHeaders: request.headers || {},
      requestBody: request.postData || null,
      status: null,
      responseHeaders: {},
      responseBody: null,
      mimeType: null,
      startTime: cdpTimestampToIso(timestamp),
      _startTimestamp: timestamp,
      _requestId: params.requestId,
      endTime: null,
      duration: null,
      error: null,
    })
  }

  if (method === 'Network.responseReceived') {
    const entry = capturePending.get(key)
    if (!entry) return
    entry.status = params.response.status
    entry.responseHeaders = params.response.headers || {}
    entry.mimeType = params.response.mimeType
  }

  if (method === 'Network.loadingFinished') {
    const { timestamp } = params
    const entry = capturePending.get(key)
    if (!entry) return
    entry.endTime = cdpTimestampToIso(timestamp)
    entry.duration = Math.round((timestamp - entry._startTimestamp) * 1000)

    // Fetch response body — only for text-based content
    const mime = (entry.mimeType || '').toLowerCase()
    const isText = mime.includes('json') || mime.includes('html') || mime.includes('xml') ||
                   mime.includes('text') || mime.includes('javascript') || mime.includes('css') ||
                   mime.includes('form') || mime.includes('svg')

    if (isText && tabId) {
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
        .then((result) => {
          if (result?.body) {
            entry.responseBody = result.body.length > MAX_CAPTURE_BODY
              ? result.body.slice(0, MAX_CAPTURE_BODY) + `...[truncated, ${result.body.length} total]`
              : result.body
          }
          if (result?.base64Encoded) entry.responseBodyEncoding = 'base64'
          finalizeEntry(key, entry)
        })
        .catch(() => {
          // Body may not be available (e.g. cached, opaque) — finalize without it
          finalizeEntry(key, entry)
        })
    } else {
      // Binary content — record metadata only, skip body
      entry.responseBody = `[binary: ${mime}, not captured]`
      finalizeEntry(key, entry)
    }
  }

  if (method === 'Network.loadingFailed') {
    const { errorText, timestamp } = params
    const entry = capturePending.get(key)
    if (!entry) return
    entry.error = errorText
    entry.endTime = cdpTimestampToIso(timestamp)
    entry.duration = Math.round((timestamp - entry._startTimestamp) * 1000)
    finalizeEntry(key, entry)
  }
}

function finalizeEntry(key, entry) {
  capturePending.delete(key)
  // Convert _startTimestamp (CDP monotonic) to wall-clock epoch ms
  const timestamp = cdpTimestampToEpochMs(entry._startTimestamp)
  delete entry._startTimestamp
  delete entry._requestId
  entry.kind = 'network'
  entry.timestamp = timestamp

  // Stream to server immediately — no local buffering
  pushToServer({ type: 'capture_event', kind: 'network', data: entry })
}

// Drain all capture data from all captured tabs and stream to server.
// Collects input events, console output, JS errors, and page state in one round-trip.
// Each tab gets a 1.5s budget — if the content script doesn't respond, skip it.
async function drainCaptureData() {
  if (!captureInputEnabled || !captureActive) return
  const wantCursor = captureRecordingFrames
  if (wantCursor) captureCursorShown = true
  const tabs = [...capturedTabs]
  await Promise.allSettled(tabs.map(async (tabId) => {
    try {
      const result = await withTimeout(
        sendToContentScript(tabId, {
          action: 'drainCapture',
          ...(wantCursor ? { showCursor: true } : {}),
        }),
        1500
      )
      if (!result?.success || !result.data) return
      const { input, console: consoleLogs, errors, page } = result.data

      // Stream input events
      if (Array.isArray(input)) {
        for (const evt of input) {
          pushToServer({
            type: 'capture_event',
            kind: 'input',
            data: {
              tabId,
              inputType: evt.type,
              x: evt.x,
              y: evt.y,
              key: evt.key,
              button: evt.button,
              modifiers: evt.modifiers,
              timestamp: evt.t,
              time: new Date(evt.t).toISOString(),
            },
          })
        }
      }

      // Stream console events
      if (Array.isArray(consoleLogs)) {
        for (const entry of consoleLogs) {
          pushToServer({
            type: 'capture_event',
            kind: 'console',
            data: {
              tabId,
              level: entry.level,
              text: entry.text,
              timestamp: new Date(entry.time).getTime(),
              time: entry.time,
            },
          })
        }
      }

      // Stream JS errors
      if (Array.isArray(errors)) {
        for (const err of errors) {
          pushToServer({
            type: 'capture_event',
            kind: 'console',
            data: {
              tabId,
              level: err.level,
              text: err.text,
              source: err.source,
              line: err.line,
              col: err.col,
              stack: err.stack,
              timestamp: err.t,
              time: err.time,
            },
          })
        }
      }

      // Stream page state snapshot
      if (page) {
        pushToServer({
          type: 'capture_event',
          kind: 'page',
          data: {
            tabId,
            url: page.url,
            title: page.title,
            scrollX: page.scrollX,
            scrollY: page.scrollY,
            viewportWidth: page.viewportWidth,
            viewportHeight: page.viewportHeight,
            timestamp: page.t,
            time: new Date(page.t).toISOString(),
          },
        })
      }
    } catch {
      // Tab closed, content script not injected, or timed out — skip
    }
  }))
}

function startInputDraining() {
  stopInputDraining()
  captureInputEnabled = true
  // With streaming, we CAN use periodic draining — events push to the server
  // immediately, so even if the SW restarts, data already sent is safe.
  // Use self-scheduling setTimeout chain (not setInterval) for MV3 safety.
  function drainLoop() {
    if (!captureInputEnabled || !captureActive) return
    drainCaptureData()
      .catch(() => {})
      .finally(() => {
        if (captureInputEnabled && captureActive) {
          captureInputInterval = setTimeout(drainLoop, INPUT_DRAIN_INTERVAL_MS)
        }
      })
  }
  captureInputInterval = setTimeout(drainLoop, INPUT_DRAIN_INTERVAL_MS)
}

function stopInputDraining() {
  captureInputEnabled = false
  if (captureInputInterval) {
    clearInterval(captureInputInterval)
    captureInputInterval = null
  }
}

// Clean up when a debugged tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  capturedTabs.delete(tabId)
})

// Clean up when debugger is detached (user clicked "cancel" on infobar, or DevTools opened)
if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    capturedTabs.delete(source.tabId)
  })
}

// GIF recording state
let recordingActive = false
let recordingFrames = []
let recordingInterval = null
let recordingTabId = null

// ─── withDebugger helper ──────────────────────────────────────────────────────
// Attaches the Chrome Debugger Protocol to a tab, runs fn(target), then detaches.
// If deep capture is already holding a persistent attachment to this tab, skips
// attach/detach so we don't interfere with the ongoing capture session.
async function withDebugger(tabId, fn) {
  if (!chrome.debugger) {
    return { success: false, error: 'Debugger API not available on this browser' }
  }
  const target = { tabId }
  const alreadyAttached = captureActive && capturedTabs.has(tabId)
  if (!alreadyAttached) {
    try {
      await chrome.debugger.attach(target, '1.3')
    } catch {
      // Already attached (e.g. DevTools open) — proceed anyway
    }
  }
  try {
    return await fn(target)
  } finally {
    if (!alreadyAttached) {
      try { await chrome.debugger.detach(target) } catch { /* ignore */ }
    }
  }
}

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
// Note: getInputLog is handled directly in the switch (needs command.clear param)

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
        return withDebugger(tab.id, async (target) => {
          const base = { x: command.x, y: command.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' }
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
          return { success: true }
        })
      }

      case 'hover': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        return withDebugger(tab.id, async (target) => {
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: command.x, y: command.y, button: 'none', buttons: 0, pointerType: 'mouse',
          })
          return { success: true }
        })
      }

      case 'drag': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        const steps = Math.max(1, command.steps || 10)
        return withDebugger(tab.id, async (target) => {
          // Press at start position
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: command.startX, y: command.startY,
            button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse',
          })
          // Interpolate through intermediate positions
          for (let i = 1; i <= steps; i++) {
            const x = Math.round(command.startX + (command.endX - command.startX) * i / steps)
            const y = Math.round(command.startY + (command.endY - command.startY) * i / steps)
            await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse',
            })
          }
          // Release at end position
          await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: command.endX, y: command.endY,
            button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse',
          })
          return { success: true }
        })
      }

      case 'keyPress': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
        const modifierMap = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, shift: 8 }
        const modifiers = (command.modifiers || []).reduce((acc, m) => acc | (modifierMap[m.toLowerCase()] || 0), 0)
        const key = command.key || ''
        // Map named keys to Windows virtual key codes for CDP
        const keyCodeMap = {
          Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
          ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
          Home: 36, End: 35, PageUp: 33, PageDown: 34,
          F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
          F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
        }
        const windowsVirtualKeyCode = keyCodeMap[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0)
        return withDebugger(tab.id, async (target) => {
          const params = { key, windowsVirtualKeyCode, modifiers, nativeVirtualKeyCode: windowsVirtualKeyCode }
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...params, type: 'keyDown' })
          await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { ...params, type: 'keyUp' })
          return { success: true }
        })
      }

      case 'getInputLog': {
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        const result = await sendToContentScript(tab.id, { action: 'getInputLog', clear: command.clear !== false })
        return result
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

      case 'startCapture': {
        if (captureActive) {
          // Stop existing capture first
          stopInputDraining()
          for (const tabId of capturedTabs) {
            await detachDebuggerFromTab(tabId)
          }
          chrome.tabs.onCreated.removeListener(onCaptureTabCreated)
        }

        captureActive = true
        capturePending = new Map()
        capturedTabs = new Set()
        captureUrlFilter = command.urlFilter || null
        captureMonotonicCalibrated = false
        captureRecordingFrames = false
        captureCursorShown = false
        captureStartWallMs = 0
        captureStartMonotonic = 0

        // Register the debugger event handler (remove first to avoid double-registering)
        try { chrome.debugger.onEvent.removeListener(handleDebuggerEvent) } catch { /* ignore */ }
        chrome.debugger.onEvent.addListener(handleDebuggerEvent)

        // Listen for new tabs and navigations (catches popups)
        chrome.tabs.onCreated.removeListener(onCaptureTabCreated)
        chrome.tabs.onCreated.addListener(onCaptureTabCreated)
        if (chrome.webNavigation) {
          chrome.webNavigation.onBeforeNavigate.removeListener(onCaptureNavigation)
          chrome.webNavigation.onBeforeNavigate.addListener(onCaptureNavigation)
        }

        // Attach debugger + inject input scripts in one parallel pass per tab.
        // Each tab gets an 8s budget — if attach or injection stalls, skip it.
        const allTabs = await chrome.tabs.query({})
        const wantInput = !!command.includeInput
        await Promise.allSettled(allTabs.map(tab => withTimeout((async () => {
          await attachDebuggerToTab(tab.id)
          // Ensure content + page scripts are present for input capture.
          // The manifest auto-injects on new page loads, but tabs open before
          // the extension loaded (or before this capture started) may not have them.
          if (wantInput && capturedTabs.has(tab.id)) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                files: ['content/page-script.js'],
              })
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/content-script.js'],
              })
            } catch { /* tab may not support script injection — skip */ }
          }
        })(), 8000)))

        if (wantInput) {
          startInputDraining()
        }

        // Start frame recording if requested — stream frames to server immediately.
        // Uses a self-scheduling setTimeout chain (not setInterval) for MV3 safety.
        if (command.recordFrames) {
          const tab = await getTargetTab(command.tabId)
          if (tab) {
            recordingTabId = tab.id
            recordingFrames = []
            recordingActive = true
            const intervalMs = Math.round(1000 / (command.fps || 2))
            if (recordingInterval) clearTimeout(recordingInterval)

            // Cursor overlay will be activated on the first input drain
            // (piggybacks on sendToContentScript which works on CSP-strict pages)
            captureRecordingFrames = true
            captureCursorShown = false

            function captureFrame() {
              if (!recordingActive) return
              chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 30 })
                .then((dataUrl) => {
                  // Strip data URL prefix and stream raw base64 to server
                  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
                  pushToServer({ type: 'capture_event', kind: 'frame', data: { jpeg: base64 } })
                })
                .catch(() => { /* tab may have navigated, skip frame */ })
                .finally(() => {
                  if (recordingActive) {
                    recordingInterval = setTimeout(captureFrame, intervalMs)
                  }
                })
            }
            recordingInterval = setTimeout(captureFrame, intervalMs)
          }
        }

        return { success: true, data: { tabsAttached: capturedTabs.size, urlFilter: captureUrlFilter, includeInput: !!command.includeInput, recordFrames: !!command.recordFrames } }
      }

      case 'stopCapture': {
        // Lightweight stop — all data already streamed to server.
        // No more zero-await constraint since we don't return data.
        stopInputDraining()
        captureActive = false
        chrome.tabs.onCreated.removeListener(onCaptureTabCreated)
        if (chrome.webNavigation) {
          chrome.webNavigation.onBeforeNavigate.removeListener(onCaptureNavigation)
        }

        // Stop frame recording and hide cursor overlay
        if (recordingActive) {
          if (recordingInterval) { clearTimeout(recordingInterval); recordingInterval = null }
          recordingActive = false
          recordingFrames = []
          captureRecordingFrames = false
          // Hide cursor overlay via a final drain (also flushes remaining events)
          if (captureCursorShown) {
            const allTabs = [...capturedTabs]
            await Promise.allSettled(allTabs.map(tabId =>
              sendToContentScript(tabId, { action: 'drainCapture', hideCursor: true }).catch(() => {})
            ))
            captureCursorShown = false
          }
        }

        // Flush remaining pending entries (incomplete requests) to server
        for (const [key, entry] of capturePending) {
          entry.kind = 'network'
          entry.timestamp = cdpTimestampToEpochMs(entry._startTimestamp)
          delete entry._startTimestamp
          delete entry._requestId
          entry.responseBody = entry.responseBody || '[incomplete — capture stopped]'
          pushToServer({ type: 'capture_event', kind: 'network', data: entry })
        }
        capturePending.clear()

        // Signal server that capture is done
        pushToServer({ type: 'capture_done' })

        // Detach debuggers — can now safely await since we don't return data
        const tabsToDetach = [...capturedTabs]
        capturedTabs.clear()
        await Promise.allSettled(tabsToDetach.map(tabId => detachDebuggerFromTab(tabId)))

        return { success: true, data: { stopped: true } }
      }

      case 'getCapture': {
        // Server has all the data — just report extension-side status
        return { success: true, data: { active: captureActive, pendingRequests: capturePending.size, tabsAttached: capturedTabs.size } }
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
          clearTimeout(recordingInterval)
        }
        const tab = await getTargetTab(command.tabId)
        if (!tab) return { success: false, error: 'No active tab' }
        recordingTabId = tab.id
        recordingFrames = []
        recordingActive = true
        const intervalMs = Math.round(1000 / (command.fps || 2))
        function captureRecordingFrame() {
          if (!recordingActive) return
          chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 30 })
            .then((dataUrl) => {
              recordingFrames.push({ dataUrl, timestamp: Date.now() })
            })
            .catch(() => { /* tab may have navigated, skip frame */ })
            .finally(() => {
              if (recordingActive) {
                recordingInterval = setTimeout(captureRecordingFrame, intervalMs)
              }
            })
        }
        recordingInterval = setTimeout(captureRecordingFrame, intervalMs)
        return { success: true }
      }

      case 'stopRecording': {
        if (recordingInterval) { clearTimeout(recordingInterval); recordingInterval = null }
        recordingActive = false
        const frames = recordingFrames.slice()
        recordingFrames = []
        return { success: true, data: { frames } }
      }

      case 'clearRecording': {
        if (recordingInterval) { clearTimeout(recordingInterval); recordingInterval = null }
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
