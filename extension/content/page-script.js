// Webster page script — injected into MAIN world for console capture and
// network interception (fetch + XHR). Communicates with content-script via
// window.postMessage using WEBSTER_* message types.
;(function () {
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

  // ─── Input event capture ──────────────────────────────────────────────────
  const inputBuffer = []
  const MAX_INPUT = 200
  let lastMouseMoveTime = 0
  const MOUSEMOVE_THROTTLE_MS = 100 // max 10 events/s

  function pushInput(entry) {
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

  document.addEventListener('mousemove', (e) => {
    const now = Date.now()
    if (now - lastMouseMoveTime < MOUSEMOVE_THROTTLE_MS) return
    lastMouseMoveTime = now
    pushInput({ type: 'mousemove', x: e.clientX, y: e.clientY, t: now })
  }, { capture: true, passive: true })

  document.addEventListener('mousedown', (e) => {
    pushInput({ type: 'mousedown', x: e.clientX, y: e.clientY, button: MOUSE_BUTTONS[e.button] ?? 'unknown', t: Date.now() })
  }, { capture: true, passive: true })

  document.addEventListener('mouseup', (e) => {
    pushInput({ type: 'mouseup', x: e.clientX, y: e.clientY, button: MOUSE_BUTTONS[e.button] ?? 'unknown', t: Date.now() })
  }, { capture: true, passive: true })

  document.addEventListener('click', (e) => {
    pushInput({ type: 'click', x: e.clientX, y: e.clientY, button: 'left', t: Date.now() })
  }, { capture: true, passive: true })

  document.addEventListener('keydown', (e) => {
    pushInput({ type: 'keydown', key: e.key, modifiers: inputModifiers(e), t: Date.now() })
  }, { capture: true, passive: true })

  document.addEventListener('keyup', (e) => {
    pushInput({ type: 'keyup', key: e.key, modifiers: inputModifiers(e), t: Date.now() })
  }, { capture: true, passive: true })

  // ─── Message handler ──────────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
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
      const entries = [...inputBuffer]
      if (clear) inputBuffer.length = 0
      window.postMessage({ type: 'WEBSTER_INPUT_RESULT', entries }, '*')
    }
  })
})()
