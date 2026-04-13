// Webster page script — injected into MAIN world for console capture and
// network interception (fetch + XHR). Communicates with content-script via
// window.postMessage using WEBSTER_* message types.
;(function () {
  // Guard against double-injection
  if (window.__websterPageScriptLoaded) return
  window.__websterPageScriptLoaded = true
  // ─── Console capture ──────────────────────────────────────────────────────
  const consoleBuffer = []
  const MAX_CONSOLE = 200
  const origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  }

  for (const level of ['log', 'warn', 'error', 'info']) {
    console[level] = function (...args) {
      origConsole[level](...args)
      consoleBuffer.push({
        level,
        text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        time: new Date().toISOString(),
      })
      if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.shift()
    }
  }

  // ─── Network interception ─────────────────────────────────────────────────
  const networkBuffer = []
  const MAX_NETWORK = 500

  function truncate(str, max) {
    if (typeof str !== 'string') return str
    return str.length > max ? str.slice(0, max) + `...[${str.length} chars]` : str
  }

  function pushNetwork(entry) {
    networkBuffer.push(entry)
    if (networkBuffer.length > MAX_NETWORK) networkBuffer.shift()
  }

  // Intercept fetch()
  const origFetch = window.fetch
  window.fetch = async function (input, init) {
    const url =
      typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : input?.url || String(input)
    const method = init?.method || (input instanceof Request ? input.method : 'GET')
    const reqHeaders = {}
    const headerSource = init?.headers || (input instanceof Request ? input.headers : null)
    if (headerSource) {
      const entries = headerSource instanceof Headers ? headerSource : new Headers(headerSource)
      entries.forEach((v, k) => { reqHeaders[k] = v })
    }
    let reqBody = null
    if (init?.body) {
      try {
        reqBody = typeof init.body === 'string'
          ? truncate(init.body, 2000)
          : `[${init.body.constructor?.name || 'body'}]`
      } catch { reqBody = '[unreadable]' }
    }
    const startTime = Date.now()
    const entry = {
      type: 'fetch', url, method: method.toUpperCase(),
      requestHeaders: reqHeaders, requestBody: reqBody,
      startTime: new Date().toISOString(),
      status: null, responseHeaders: {}, responseBody: null, duration: null, error: null,
    }
    try {
      const response = await origFetch.call(window, input, init)
      entry.status = response.status
      entry.duration = Date.now() - startTime
      response.headers.forEach((v, k) => { entry.responseHeaders[k] = v })
      try { entry.responseBody = truncate(await response.clone().text(), 4000) }
      catch { entry.responseBody = '[unreadable]' }
      pushNetwork(entry)
      return response
    } catch (err) {
      entry.error = String(err)
      entry.duration = Date.now() - startTime
      pushNetwork(entry)
      throw err
    }
  }

  // Intercept XMLHttpRequest
  const origXHROpen = XMLHttpRequest.prototype.open
  const origXHRSend = XMLHttpRequest.prototype.send
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._webster = {
      type: 'xhr', method: method.toUpperCase(), url: String(url),
      requestHeaders: {}, requestBody: null, startTime: null,
      status: null, responseHeaders: {}, responseBody: null, duration: null, error: null,
    }
    return origXHROpen.call(this, method, url, ...rest)
  }

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._webster) this._webster.requestHeaders[name] = value
    return origXHRSetHeader.call(this, name, value)
  }

  XMLHttpRequest.prototype.send = function (body) {
    if (this._webster) {
      this._webster.startTime = new Date().toISOString()
      if (body) {
        try {
          this._webster.requestBody = typeof body === 'string'
            ? truncate(body, 2000)
            : `[${body.constructor?.name || 'body'}]`
        } catch { this._webster.requestBody = '[unreadable]' }
      }
      const startMs = Date.now()
      this.addEventListener('loadend', () => {
        if (!this._webster) return
        const entry = this._webster
        entry.status = this.status
        entry.duration = Date.now() - startMs
        try {
          this.getAllResponseHeaders().split('\r\n').forEach((line) => {
            const idx = line.indexOf(':')
            if (idx > 0) entry.responseHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
          })
        } catch {}
        try { entry.responseBody = truncate(this.responseText, 4000) }
        catch { entry.responseBody = '[unreadable]' }
        pushNetwork(entry)
      })
      this.addEventListener('error', () => {
        if (!this._webster) return
        this._webster.error = 'Network error'
        this._webster.duration = Date.now() - startMs
        pushNetwork(this._webster)
      })
    }
    return origXHRSend.call(this, body)
  }

  // ─── Cursor overlay for capture recordings ────────────────────────────────
  // When enabled, renders a visible cursor in the DOM so captureVisibleTab
  // includes it in screenshots. The OS cursor is never captured by the API.
  let cursorOverlay = null

  function showCursorOverlay() {
    if (cursorOverlay) return
    cursorOverlay = document.createElement('div')
    cursorOverlay.id = '__webster_cursor'
    // Pointer SVG as inline data URI — 20x20 classic arrow cursor
    cursorOverlay.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
      <path d="M2 1 L2 17 L6.5 12.5 L10.5 19 L13 18 L9 11 L15 11 Z" fill="white" stroke="black" stroke-width="1.2"/>
    </svg>`
    Object.assign(cursorOverlay.style, {
      position: 'fixed',
      top: '0px',
      left: '0px',
      width: '20px',
      height: '20px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transform: 'translate(-2px, -1px)',
      filter: 'drop-shadow(1px 1px 1px rgba(0,0,0,0.3))',
    })
    document.documentElement.appendChild(cursorOverlay)
  }

  function hideCursorOverlay() {
    if (cursorOverlay) {
      cursorOverlay.remove()
      cursorOverlay = null
    }
  }

  function moveCursorOverlay(x, y) {
    if (!cursorOverlay) return
    cursorOverlay.style.left = x + 'px'
    cursorOverlay.style.top = y + 'px'
  }

  // ─── JS error capture ─────────────────────────────────────────────────────
  const errorBuffer = []
  const MAX_ERRORS = 50

  window.addEventListener('error', (e) => {
    errorBuffer.push({
      level: 'exception',
      text: e.message || String(e),
      source: e.filename || null,
      line: e.lineno || null,
      col: e.colno || null,
      stack: e.error?.stack || null,
      time: new Date().toISOString(),
      t: Date.now(),
    })
    if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift()
  })

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    errorBuffer.push({
      level: 'unhandledrejection',
      text: reason?.message || String(reason),
      stack: reason?.stack || null,
      time: new Date().toISOString(),
      t: Date.now(),
    })
    if (errorBuffer.length > MAX_ERRORS) errorBuffer.shift()
  })

  // ─── Input event capture ──────────────────────────────────────────────────
  const inputBuffer = []
  const MAX_INPUT = 200
  let lastMouseMoveTime = 0
  const MOUSEMOVE_THROTTLE_MS = 100 // max 10 events/s
  let lastScrollTime = 0
  const SCROLL_THROTTLE_MS = 100 // max 10 events/s

  // Safari anchor-click recovery: on Safari, clicking <a href="#..."> can
  // dispatch hashchange BEFORE (or instead of) the click event. We track the
  // last mousedown on an anchor so hashchange can emit the click if click never
  // fires. The emitted flag prevents a duplicate if click does fire afterwards.
  let pendingAnchorClick = null

  // When running inside an iframe, relay events to the top frame rather than
  // buffering locally. The top frame aggregates all iframe events.
  const IS_FRAME = window !== window.top
  const FRAME_URL = IS_FRAME ? location.href : null
  const FRAME_ORIGIN = IS_FRAME ? location.origin : null

  function pushInput(entry) {
    if (IS_FRAME) {
      try {
        window.top.postMessage({
          type: 'WEBSTER_FRAME_INPUT',
          frame: { url: FRAME_URL, origin: FRAME_ORIGIN },
          entry,
        }, '*')
      } catch {
        // Sandboxed iframe may block access to window.top — discard
      }
      return
    }
    inputBuffer.push(entry)
    if (inputBuffer.length > MAX_INPUT) inputBuffer.shift()
  }

  function inputModifiers(e) {
    const mods = []
    if (e.altKey) mods.push('alt')
    if (e.ctrlKey) mods.push('ctrl')
    if (e.metaKey) mods.push('meta')
    if (e.shiftKey) mods.push('shift')
    return mods
  }

  const MOUSE_BUTTONS = ['left', 'middle', 'right']

  // ─── Element context helpers ──────────────────────────────────────────────
  const MAX_TEXT = 120
  const MAX_CLASSES = 100

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return null
    const desc = { tag: el.tagName }
    if (el.id) desc.id = el.id
    const cls = typeof el.className === 'string' ? el.className : el.className?.baseVal
    if (cls) desc.classes = cls.slice(0, MAX_CLASSES)
    const text = el.innerText?.trim()
    if (text) desc.text = text.slice(0, MAX_TEXT)
    if (el.href) desc.href = el.href
    if (el.getAttribute('role')) desc.role = el.getAttribute('role')
    if (el.getAttribute('aria-label')) desc.ariaLabel = el.getAttribute('aria-label')
    if (el.getAttribute('data-testid')) desc.testId = el.getAttribute('data-testid')
    if (el.name) desc.name = el.name
    if (el.placeholder) desc.placeholder = el.placeholder
    desc.xpath = computeXPath(el)
    // Shadow DOM: record the host element so consumers know which component owns this target
    const root = el.getRootNode()
    if (root instanceof ShadowRoot) {
      desc.shadowHost = describeElement(root.host)
    }
    return desc
  }

  function computeXPath(el) {
    if (el.id) return `//*[@id="${el.id}"]`
    const parts = []
    let current = el
    while (current && current.nodeType === 1 && current !== document.body) {
      let sibling = current
      let index = 1
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName === current.tagName) index++
      }
      parts.unshift(`${current.tagName.toLowerCase()}[${index}]`)
      current = current.parentElement
    }
    return '/' + parts.join('/')
  }

  function safeValue(el) {
    if (el.type === 'password') return '***'
    const v = el.value
    if (typeof v !== 'string') return ''
    return v.slice(0, 500)
  }

  document.addEventListener('mousemove', (e) => {
    moveCursorOverlay(e.clientX, e.clientY)
    const now = Date.now()
    if (now - lastMouseMoveTime < MOUSEMOVE_THROTTLE_MS) return
    lastMouseMoveTime = now
    pushInput({ type: 'mousemove', x: e.clientX, y: e.clientY, t: now })
  }, { capture: true, passive: true })

  document.addEventListener('mousedown', (e) => {
    const el = e.composedPath()[0] ?? e.target
    // Track anchor mousedowns for Safari hash-nav recovery (see hashchange handler below)
    const anchor = el.closest?.('a') ?? null
    pendingAnchorClick = anchor
      ? { el: anchor, x: e.clientX, y: e.clientY, t: Date.now(), emitted: false }
      : null
    pushInput({ type: 'mousedown', x: e.clientX, y: e.clientY, button: MOUSE_BUTTONS[e.button] ?? 'unknown', t: Date.now(), element: describeElement(el) })
  }, { capture: true, passive: true })

  document.addEventListener('mouseup', (e) => {
    const el = e.composedPath()[0] ?? e.target
    pushInput({ type: 'mouseup', x: e.clientX, y: e.clientY, button: MOUSE_BUTTONS[e.button] ?? 'unknown', t: Date.now(), element: describeElement(el) })
  }, { capture: true, passive: true })

  document.addEventListener('click', (e) => {
    // If hashchange already emitted this click (Safari fired hashchange first),
    // skip it to avoid a duplicate entry, then clear the pending state.
    if (pendingAnchorClick?.emitted) {
      pendingAnchorClick = null
      return
    }
    pendingAnchorClick = null
    const el = e.composedPath()[0] ?? e.target
    pushInput({ type: 'click', x: e.clientX, y: e.clientY, button: 'left', t: Date.now(), element: describeElement(el) })
  }, { capture: true, passive: true })

  // Safari fix: emit the anchor click from the last mousedown when hashchange fires
  // before (or instead of) the click event. The 1-second window covers any reasonable
  // click-to-navigation latency; emitted flag prevents a duplicate if click also fires.
  window.addEventListener('hashchange', () => {
    const pending = pendingAnchorClick
    if (pending && !pending.emitted && Date.now() - pending.t < 1000) {
      pending.emitted = true
      pushInput({
        type: 'click',
        x: pending.x,
        y: pending.y,
        button: 'left',
        t: pending.t,
        element: describeElement(pending.el),
      })
    }
  }, { passive: true })

  document.addEventListener('keydown', (e) => {
    const el = e.composedPath()[0] ?? e.target
    pushInput({ type: 'keydown', key: e.key, modifiers: inputModifiers(e), t: Date.now(), element: describeElement(el) })
  }, { capture: true, passive: true })

  document.addEventListener('keyup', (e) => {
    const el = e.composedPath()[0] ?? e.target
    pushInput({ type: 'keyup', key: e.key, modifiers: inputModifiers(e), t: Date.now(), element: describeElement(el) })
  }, { capture: true, passive: true })

  document.addEventListener('change', (e) => {
    const el = e.composedPath()[0] ?? e.target
    if (el.matches('input, textarea, select')) {
      pushInput({ type: 'change', t: Date.now(), element: describeElement(el), value: safeValue(el) })
    }
  }, { capture: true, passive: true })

  document.addEventListener('scroll', (e) => {
    const now = Date.now()
    if (now - lastScrollTime < SCROLL_THROTTLE_MS) return
    lastScrollTime = now
    const target = e.target
    const isDoc = target === document || target === document.documentElement || target === document.body
    const entry = {
      type: 'scroll',
      x: isDoc ? window.scrollX : target.scrollLeft,
      y: isDoc ? window.scrollY : target.scrollTop,
      t: now,
    }
    if (!isDoc) entry.element = describeElement(target)
    pushInput(entry)
  }, { capture: true, passive: true })

  document.addEventListener('focusin', (e) => {
    const el = e.composedPath()[0] ?? e.target
    pushInput({ type: 'focusin', t: Date.now(), element: describeElement(el) })
  }, { capture: true, passive: true })

  document.addEventListener('focusout', (e) => {
    const el = e.composedPath()[0] ?? e.target
    pushInput({ type: 'focusout', t: Date.now(), element: describeElement(el) })
  }, { capture: true, passive: true })

  // ─── Message handler ──────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    // Relay from child iframes — must come before the same-window guard.
    // Frames send WEBSTER_FRAME_INPUT via window.top.postMessage so event.source
    // is the iframe window, not this window.
    if (!IS_FRAME && event.data?.type === 'WEBSTER_FRAME_INPUT') {
      const { frame, entry } = event.data
      if (entry && typeof entry === 'object') {
        entry.frame = frame
        inputBuffer.push(entry)
        if (inputBuffer.length > MAX_INPUT) inputBuffer.shift()
      }
      return
    }

    if (event.source !== window) return

    if (event.data?.type === 'WEBSTER_READ_CONSOLE') {
      const entries = [...consoleBuffer]
      consoleBuffer.length = 0
      window.postMessage({ type: 'WEBSTER_CONSOLE_RESULT', entries }, '*')
    }

    if (event.data?.type === 'WEBSTER_READ_NETWORK') {
      const entries = [...networkBuffer]
      networkBuffer.length = 0
      window.postMessage({ type: 'WEBSTER_NETWORK_RESULT', entries }, '*')
    }

    if (event.data?.type === 'WEBSTER_READ_INPUT') {
      const clear = event.data.clear !== false
      const types = event.data.types    // optional string[] — filter by event type
      const minTs = event.data.minTimestamp  // optional number — only events with t > minTs

      let entries = [...inputBuffer]
      if (types) entries = entries.filter(e => types.includes(e.type))
      if (typeof minTs === 'number') entries = entries.filter(e => e.t > minTs)

      if (clear) {
        if (!types && typeof minTs !== 'number') {
          // No filters — clear entire buffer (backwards-compatible behaviour)
          inputBuffer.length = 0
        } else {
          // Filters active — only remove the specific entries we're returning so
          // events of other types (or earlier timestamps) remain for other callers.
          const returnedSet = new Set(entries)
          for (let i = inputBuffer.length - 1; i >= 0; i--) {
            if (returnedSet.has(inputBuffer[i])) inputBuffer.splice(i, 1)
          }
        }
      }

      // Auto-show cursor overlay on first input drain (capture is active and recording)
      if (event.data.showCursor && !cursorOverlay) {
        showCursorOverlay()
      }
      if (event.data.hideCursor) {
        hideCursorOverlay()
      }
      window.postMessage({ type: 'WEBSTER_INPUT_RESULT', entries }, '*')
    }

    // Unified drain for capture sessions — returns all buffered data + page state in one message
    if (event.data?.type === 'WEBSTER_DRAIN_CAPTURE') {
      const input = [...inputBuffer]
      inputBuffer.length = 0

      const console_ = [...consoleBuffer]
      consoleBuffer.length = 0

      const errors = [...errorBuffer]
      errorBuffer.length = 0

      const page = {
        url: location.href,
        title: document.title,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        t: Date.now(),
      }

      if (event.data.showCursor && !cursorOverlay) {
        showCursorOverlay()
      }
      if (event.data.hideCursor) {
        hideCursorOverlay()
      }

      window.postMessage({
        type: 'WEBSTER_DRAIN_CAPTURE_RESULT',
        input, console: console_, errors, page,
      }, '*')
    }

    if (event.data?.type === 'WEBSTER_SHOW_CURSOR') {
      showCursorOverlay()
    }

    if (event.data?.type === 'WEBSTER_HIDE_CURSOR') {
      hideCursorOverlay()
    }
  })
})()
