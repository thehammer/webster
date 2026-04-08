// Webster content script — handles DOM commands relayed from the service worker.
// Runs in isolated world. Injects page-script.js into MAIN world for console
// and network capture.

// Guard against double-injection (manifest auto-inject + programmatic inject)
if (window.__websterContentScriptLoaded) {
  // Already loaded — skip re-initialization
} else {
window.__websterContentScriptLoaded = true

// Inject page script for console and network interception
const script = document.createElement('script')
script.src = chrome.runtime.getURL('content/page-script.js')
;(document.head || document.documentElement).appendChild(script)
script.onload = () => script.remove()

// Pending resolve callbacks for page-script responses
let pendingConsoleResolve = null
let pendingNetworkResolve = null
let pendingInputResolve = null

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  if (event.data?.type === 'WEBSTER_CONSOLE_RESULT' && pendingConsoleResolve) {
    pendingConsoleResolve(event.data.entries)
    pendingConsoleResolve = null
  }
  if (event.data?.type === 'WEBSTER_NETWORK_RESULT' && pendingNetworkResolve) {
    pendingNetworkResolve(event.data.entries)
    pendingNetworkResolve = null
  }
  if (event.data?.type === 'WEBSTER_INPUT_RESULT' && pendingInputResolve) {
    pendingInputResolve(event.data.entries)
    pendingInputResolve = null
  }
})

function getConsoleEntries() {
  return new Promise((resolve) => {
    pendingConsoleResolve = resolve
    window.postMessage({ type: 'WEBSTER_READ_CONSOLE' }, '*')
    setTimeout(() => {
      if (pendingConsoleResolve) { pendingConsoleResolve([]); pendingConsoleResolve = null }
    }, 1000)
  })
}

function getNetworkEntries() {
  return new Promise((resolve) => {
    pendingNetworkResolve = resolve
    window.postMessage({ type: 'WEBSTER_READ_NETWORK' }, '*')
    setTimeout(() => {
      if (pendingNetworkResolve) { pendingNetworkResolve([]); pendingNetworkResolve = null }
    }, 1000)
  })
}

function getInputEntries(clear = true, opts = {}) {
  return new Promise((resolve) => {
    pendingInputResolve = resolve
    window.postMessage({ type: 'WEBSTER_READ_INPUT', clear, ...opts }, '*')
    setTimeout(() => {
      if (pendingInputResolve) { pendingInputResolve([]); pendingInputResolve = null }
    }, 1000)
  })
}

chrome.runtime.onMessage.addListener((command, sender, sendResponse) => {
  handleCommand(command).then(sendResponse)
  return true
})

async function handleCommand(cmd) {
  try {
    switch (cmd.action) {
      case 'readText': {
        const el = cmd.selector ? document.querySelector(cmd.selector) : document.body
        if (!el) return { success: false, error: `Element not found: ${cmd.selector}` }
        return { success: true, data: el.textContent || '' }
      }

      case 'readHtml': {
        const el = cmd.selector ? document.querySelector(cmd.selector) : document.documentElement
        if (!el) return { success: false, error: `Element not found: ${cmd.selector}` }
        return { success: true, data: el.outerHTML }
      }

      case 'click': {
        const el = cmd.selector ? document.querySelector(cmd.selector) : null
        if (!el) return { success: false, error: `Element not found: ${cmd.selector}`, selectorNotFound: true }
        el.click()
        return { success: true }
      }

      case 'type': {
        const el = cmd.selector ? document.querySelector(cmd.selector) : null
        if (!el) return { success: false, error: `Element not found: ${cmd.selector}`, selectorNotFound: true }
        el.focus()
        el.value = cmd.text || ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { success: true }
      }

      case 'waitFor': {
        const timeout = cmd.timeout || 5000
        const found = await new Promise((resolve) => {
          if (document.querySelector(cmd.selector || '')) return resolve(true)
          const observer = new MutationObserver(() => {
            if (document.querySelector(cmd.selector || '')) {
              observer.disconnect()
              resolve(true)
            }
          })
          observer.observe(document.body, { childList: true, subtree: true })
          setTimeout(() => { observer.disconnect(); resolve(false) }, timeout)
        })
        return { success: true, data: found }
      }

      case 'scrollTo': {
        if (cmd.selector) {
          const el = document.querySelector(cmd.selector)
          if (!el) return { success: false, error: `Element not found: ${cmd.selector}` }
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } else {
          window.scrollTo({ left: cmd.x || 0, top: cmd.y || 0, behavior: 'smooth' })
        }
        return { success: true }
      }

      case 'getAttribute': {
        const el = cmd.selector ? document.querySelector(cmd.selector) : null
        if (!el) return { success: false, error: `Element not found: ${cmd.selector}` }
        return { success: true, data: el.getAttribute(cmd.attribute || '') }
      }

      case 'getComputedStyle': {
        const el = cmd.selector ? document.querySelector(cmd.selector) : null
        if (!el) return { success: false, error: `Element not found: ${cmd.selector}` }
        const style = window.getComputedStyle(el)
        return { success: true, data: style.getPropertyValue(cmd.property || '') }
      }

      case 'getLocalStorage': {
        if (cmd.key) return { success: true, data: localStorage.getItem(cmd.key) }
        const entries = {}
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)
          entries[k] = localStorage.getItem(k)
        }
        return { success: true, data: entries }
      }

      case 'setLocalStorage': {
        localStorage.setItem(cmd.key || '', cmd.value || '')
        return { success: true }
      }

      case 'readConsole': {
        const entries = await getConsoleEntries()
        if (cmd.pattern) {
          const re = new RegExp(cmd.pattern, 'i')
          return { success: true, data: entries.filter((e) => re.test(e.text)) }
        }
        return { success: true, data: entries }
      }

      case 'getNetworkDetails': {
        const entries = await getNetworkEntries()
        return { success: true, data: entries }
      }

      case 'getInputLog': {
        const entries = await getInputEntries(cmd.clear !== false, {
          showCursor: cmd.showCursor,
          hideCursor: cmd.hideCursor,
        })
        return { success: true, data: entries }
      }

      case 'showCursor': {
        window.postMessage({ type: 'WEBSTER_SHOW_CURSOR' }, '*')
        return { success: true }
      }

      case 'hideCursor': {
        window.postMessage({ type: 'WEBSTER_HIDE_CURSOR' }, '*')
        return { success: true }
      }

      case 'find': {
        const selector = cmd.pattern || cmd.selector || '*'
        try {
          const all = Array.from(document.querySelectorAll(selector))
          const count = all.length
          const elements = all.slice(0, 20).map((el) => ({
            text: el.textContent?.trim().slice(0, 200) || '',
            href: el.href || undefined,
            value: el.value || undefined,
          }))
          return { success: true, data: { selector, count, elements } }
        } catch (e) {
          return { success: false, error: `Invalid selector: ${e}` }
        }
      }

      default:
        return { success: false, error: `Content script: unknown action ${cmd.action}` }
    }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

} // end guard
