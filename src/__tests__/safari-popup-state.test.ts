/**
 * Safari service worker <-> popup contract.
 *
 * Bug: the popup renders the reply to { type: 'GET_STATE' } as
 *   { connections: { [port]: { connected, commandsExecuted, lastError } }, primaryPort, extraPorts }
 * but the Safari service worker used to reply with the flat stored state, so the popup threw
 * and showed only the static "Add server port" form with no status rows.
 *
 * Both scripts are plain classic scripts; they are evaluated in a sandbox with a fake `chrome`.
 * Nothing touches the network or a real port.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const EXT = join(import.meta.dir, '..', '..', 'extension')
const SW_SRC = readFileSync(join(EXT, 'background', 'safari-service-worker.js'), 'utf8')
const POPUP_SRC = readFileSync(join(EXT, 'popup', 'popup.js'), 'utf8')

type Listener = (msg: any, sender: any, sendResponse: (r: any) => void) => unknown

function loadSafariSW(initialStorage: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initialStorage }
  let listener: Listener | null = null
  const chrome = {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key]
          const out: Record<string, unknown> = {}
          for (const k of keys) if (k in store) out[k] = store[k]
          return out
        },
        set: async (obj: Record<string, unknown>) => { Object.assign(store, obj) },
      },
    },
    runtime: {
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: { addListener: (fn: Listener) => { listener = fn } },
    },
  }
  // The script calls connect() on load. A never-settling fetch keeps it off the network and
  // stops it from overwriting the stored state the test seeded.
  const fetchStub = () => new Promise<never>(() => {})
  const noTimer = (() => 0) as unknown as typeof setTimeout
  new Function('chrome', 'navigator', 'fetch', 'setTimeout', 'clearTimeout', 'console', SW_SRC)(
    chrome, {}, fetchStub, noTimer, () => {}, { ...console, warn: () => {} },
  )
  if (!listener) throw new Error('safari service worker did not register an onMessage listener')
  const send = (message: any) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply to ${message.type}`)), 1000)
      listener!(message, {}, (r) => { clearTimeout(t); resolve(r) })
    })
  return { send }
}

describe('Safari service worker GET_STATE', () => {
  test('reports the connected server in the shape the popup renders', async () => {
    const sw = loadSafariSW({ websterState: { connected: true, port: 3456, commandsExecuted: 7, lastError: null } })
    const reply = await sw.send({ type: 'GET_STATE' })
    expect(reply.primaryPort).toBe(3456)
    expect(reply.extraPorts).toEqual([])
    expect(reply.connections[3456]).toEqual({ connected: true, commandsExecuted: 7, lastError: null })
  })

  test('surfaces the last error for a disconnected configured port', async () => {
    const sw = loadSafariSW({
      websterPort: 4000,
      websterState: { connected: false, port: 4000, commandsExecuted: 2, lastError: 'TypeError: fetch failed' },
    })
    const reply = await sw.send({ type: 'GET_STATE' })
    expect(reply.primaryPort).toBe(4000)
    expect(reply.connections[4000].connected).toBe(false)
    expect(reply.connections[4000].lastError).toBe('TypeError: fetch failed')
  })

  test('does not report state recorded for a different port as connected or errored', async () => {
    const sw = loadSafariSW({
      websterPort: 4000,
      websterState: { connected: true, port: 3456, commandsExecuted: 5, lastError: 'old failure' },
    })
    const reply = await sw.send({ type: 'GET_STATE' })
    expect(reply.primaryPort).toBe(4000)
    expect(reply.connections[4000].connected).toBe(false)
    expect(reply.connections[4000].lastError).toBeNull()
    expect(reply.connections[3456]).toBeUndefined()
  })

  test('replies with a disconnected default-port entry when nothing is stored', async () => {
    const sw = loadSafariSW({})
    const reply = await sw.send({ type: 'GET_STATE' })
    expect(reply.primaryPort).toBe(3456)
    expect(reply.extraPorts).toEqual([])
    expect(reply.connections[3456].connected).toBe(false)
    expect(reply.connections[3456].commandsExecuted).toBe(0)
    expect(reply.connections[3456].lastError).toBeNull()
  })

  test('uses the configured port when no state has been recorded yet', async () => {
    const sw = loadSafariSW({ websterPort: 4100 })
    const reply = await sw.send({ type: 'GET_STATE' })
    expect(reply.primaryPort).toBe(4100)
    expect(reply.connections[4100].connected).toBe(false)
  })
})

describe('Safari service worker multi-server messages', () => {
  test.each(['ADD_SERVER', 'REMOVE_SERVER'])('%s is refused with an error message instead of hanging', async (type) => {
    const sw = loadSafariSW({})
    const reply = await sw.send({ type, port: 4001 })
    expect(reply.ok).toBe(false)
    expect(typeof reply.error).toBe('string')
    expect(reply.error.length).toBeGreaterThan(0)
  })
})

// ─── Contract: the real popup renderer consumes the Safari reply ─────────────

function fakeEl() {
  const el: any = {
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    className: '',
    children: [] as any[],
    appendChild(c: any) { el.children.push(c); return c },
    addEventListener() {},
    querySelectorAll: () => [],
    click() {},
  }
  return el
}

describe('Safari popup', () => {
  test('renders a Connected row for port 3456 from the Safari service worker reply', async () => {
    const sw = loadSafariSW({ websterState: { connected: true, port: 3456, commandsExecuted: 7, lastError: null } })

    const byId: Record<string, any> = {}
    const document = {
      getElementById: (id: string) => (byId[id] ??= fakeEl()),
      createElement: () => fakeEl(),
    }
    const popupChrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (msg: any, cb: (r: any) => void) => { sw.send(msg).then(cb) },
      },
      storage: { local: { get: () => {}, set: () => {} } },
    }
    const noInterval = (() => 0) as unknown as typeof setInterval
    new Function('document', 'chrome', 'setInterval', 'setTimeout', 'clearTimeout', POPUP_SRC)(
      document, popupChrome, noInterval, () => 0, () => {},
    )

    const list = byId['servers-list']
    for (let i = 0; i < 50 && list.children.length === 0; i++) await new Promise((r) => setTimeout(r, 5))

    expect(list.children.length).toBe(1)
    const html: string = list.children[0].innerHTML
    expect(html).toContain('Connected')
    expect(html).not.toContain('Disconnected')
    expect(html).toContain('Port 3456')
    expect(html).toContain('>7<')
  })
})
