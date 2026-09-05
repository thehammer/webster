import { describe, test, expect, afterAll } from 'bun:test'
import { createTools } from '../tools.js'
import type { WebsterServer } from '../server.js'

import { CaptureSession } from '../capture.js'

const mockSession = new CaptureSession('test-tools', { urlFilter: null })

afterAll(() => { mockSession.cleanup() })

const mockServer = {
  dispatch: async (_cmd: Record<string, unknown>) => ({ success: true }),
  isConnected: () => true,
  getBrowsers: () => [],
  setBrowser: (_idOrName: string) => ({ id: 'test', browser: 'chrome', version: '1.0', transport: 'ws', active: true }),
  claimTab: (_tabId: number | undefined) => ({ claimed: true, tabId: 1, owner: '3456:1234' }),
  releaseTab: (_tabId: number | undefined) => undefined,
  startCaptureSession: () => mockSession,
  getCaptureSession: () => mockSession,
  stopCaptureSession: () => mockSession,
} as unknown as WebsterServer

const tools = createTools(mockServer)

const EXPECTED_TOOL_NAMES = [
  'navigate',
  'click',
  'type',
  'read_page',
  'read_html',
  'screenshot',
  'eval_js',
  'wait_for',
  'get_tabs',
  'open_tab',
  'close_tab',
  'switch_tab',
  'get_network_log',
  'wait_for_network_idle',
  'get_cookies',
  'get_local_storage',
  'set_local_storage',
  'read_console',
  'get_page_info',
  'find',
  'scroll_to',
  'get_attribute',
  'get_accessibility_tree',
  'click_at',
  'click_ref',
  'find_element',
  'get_browsers',
  'set_browser',
  'upload_file',
  'resize_window',
  'start_capture',
  'stop_capture',
  'get_capture',
  'export_video',
  // Phase 10 — input dispatching & monitoring
  'hover',
  'drag',
  'key_press',
  'get_input_log',
  // Phase 9 — concurrent sessions / tab ownership
  'claim_tab',
  'release_tab',
  // Capture enhancements
  'annotate',
  'export_har',
  'redact_capture',
]

describe('createTools', () => {
  test('all expected tools are present by name', () => {
    const names = tools.map(t => t.name)
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected)
    }
    expect(tools).toHaveLength(EXPECTED_TOOL_NAMES.length)
  })

  test('all tools have description and inputSchema', () => {
    for (const tool of tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy()
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeTruthy()
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  test('all tool names follow snake_case convention', () => {
    for (const tool of tools) {
      expect(tool.name, `${tool.name} is not snake_case`).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  test('navigate requires url', () => {
    const nav = tools.find(t => t.name === 'navigate')!
    expect(nav.inputSchema.required).toContain('url')
  })

  test('click requires selector', () => {
    const click = tools.find(t => t.name === 'click')!
    expect(click.inputSchema.required).toContain('selector')
  })

  test('type requires selector and text', () => {
    const type = tools.find(t => t.name === 'type')!
    expect(type.inputSchema.required).toContain('selector')
    expect(type.inputSchema.required).toContain('text')
  })

  test('eval_js requires code', () => {
    const evalJs = tools.find(t => t.name === 'eval_js')!
    expect(evalJs.inputSchema.required).toContain('code')
  })

  test('wait_for requires selector', () => {
    const waitFor = tools.find(t => t.name === 'wait_for')!
    expect(waitFor.inputSchema.required).toContain('selector')
  })

  test('open_tab requires url', () => {
    const openTab = tools.find(t => t.name === 'open_tab')!
    expect(openTab.inputSchema.required).toContain('url')
  })

  test('close_tab requires tabId', () => {
    const closeTab = tools.find(t => t.name === 'close_tab')!
    expect(closeTab.inputSchema.required).toContain('tabId')
  })

  test('switch_tab requires tabId', () => {
    const switchTab = tools.find(t => t.name === 'switch_tab')!
    expect(switchTab.inputSchema.required).toContain('tabId')
  })

  test('find requires pattern', () => {
    const find = tools.find(t => t.name === 'find')!
    expect(find.inputSchema.required).toContain('pattern')
  })

  test('set_local_storage requires key and value', () => {
    const setLs = tools.find(t => t.name === 'set_local_storage')!
    expect(setLs.inputSchema.required).toContain('key')
    expect(setLs.inputSchema.required).toContain('value')
  })

  test('get_attribute requires selector and attribute', () => {
    const getAttr = tools.find(t => t.name === 'get_attribute')!
    expect(getAttr.inputSchema.required).toContain('selector')
    expect(getAttr.inputSchema.required).toContain('attribute')
  })

  test('hover requires x and y', () => {
    const hover = tools.find(t => t.name === 'hover')!
    expect(hover.inputSchema.required).toContain('x')
    expect(hover.inputSchema.required).toContain('y')
  })

  test('drag requires startX, startY, endX, endY', () => {
    const drag = tools.find(t => t.name === 'drag')!
    expect(drag.inputSchema.required).toContain('startX')
    expect(drag.inputSchema.required).toContain('startY')
    expect(drag.inputSchema.required).toContain('endX')
    expect(drag.inputSchema.required).toContain('endY')
  })

  test('key_press requires key', () => {
    const kp = tools.find(t => t.name === 'key_press')!
    expect(kp.inputSchema.required).toContain('key')
  })

  test('tools with no required fields accept empty input', () => {
    const noRequiredTools = ['screenshot', 'get_tabs', 'get_network_log', 'wait_for_network_idle',
      'get_cookies', 'get_local_storage', 'read_console', 'get_page_info', 'read_page',
      'read_html', 'scroll_to', 'get_input_log', 'claim_tab', 'release_tab']
    for (const name of noRequiredTools) {
      const tool = tools.find(t => t.name === name)!
      expect(tool, `${name} not found`).toBeTruthy()
      const required = tool.inputSchema.required
      expect(!required || required.length === 0, `${name} has unexpected required fields`).toBe(true)
    }
  })
})

describe('start_capture tabsAttached/warnings', () => {
  test('tabsAttached === 0 produces a non-empty warnings array mentioning 0 tabs and no bodies recorded', async () => {
    const session = new CaptureSession('test-tools-zero-tabs', { urlFilter: null })
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => ({ tabsAttached: 0, urlFilter: null }),
      startCaptureSession: () => session,
      getCaptureSession: () => session,
      stopCaptureSession: () => session,
      isConnected: () => true,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const startCapture = localTools.find(t => t.name === 'start_capture')!

    try {
      const result = await startCapture.execute({}) as { tabsAttached: number; warnings: string[] }
      expect(result.tabsAttached).toBe(0)
      expect(Array.isArray(result.warnings)).toBe(true)
      expect(result.warnings.length).toBeGreaterThan(0)
      const joined = result.warnings.join(' ').toLowerCase()
      expect(joined).toMatch(/0 tabs|no tabs/)
      expect(joined).toMatch(/bodies|body/)
    } finally {
      session.cleanup()
    }
  })

  test('tabsAttached === 3 with no meta warnings produces empty warnings array', async () => {
    const session = new CaptureSession('test-tools-three-tabs', { urlFilter: null })
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => ({ tabsAttached: 3 }),
      startCaptureSession: () => session,
      getCaptureSession: () => session,
      stopCaptureSession: () => session,
      isConnected: () => true,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const startCapture = localTools.find(t => t.name === 'start_capture')!

    try {
      const result = await startCapture.execute({}) as { tabsAttached: number; warnings: string[] }
      expect(result.tabsAttached).toBe(3)
      expect(result.warnings).toEqual([])
    } finally {
      session.cleanup()
    }
  })

  test('pre-existing cdp_unavailable meta warning is folded into warnings even with nonzero tabsAttached', async () => {
    const session = new CaptureSession('test-tools-meta-warning', { urlFilter: null })
    session.appendEvent({
      kind: 'meta',
      timestamp: Date.now(),
      subKind: 'warning',
      code: 'cdp_unavailable',
      message: 'CDP debugger unavailable on tab 42 — capture may be incomplete',
    })
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => ({ tabsAttached: 2 }),
      startCaptureSession: () => session,
      getCaptureSession: () => session,
      stopCaptureSession: () => session,
      isConnected: () => true,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const startCapture = localTools.find(t => t.name === 'start_capture')!

    try {
      const result = await startCapture.execute({}) as { tabsAttached: number; warnings: string[] }
      expect(result.tabsAttached).toBe(2)
      const joined = result.warnings.join(' ')
      expect(joined).toContain('CDP debugger unavailable on tab 42 — capture may be incomplete')
    } finally {
      session.cleanup()
    }
  })

  test('extension dispatch rejection prevents an orphaned active session and surfaces the underlying error', async () => {
    const session = new CaptureSession('test-tools-dispatch-fail', { urlFilter: null })
    let stopCalled = false
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => { throw new Error('extension not responding') },
      startCaptureSession: () => session,
      getCaptureSession: () => session,
      stopCaptureSession: () => { stopCalled = true; session.finalize(); return session },
      isConnected: () => true,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const startCapture = localTools.find(t => t.name === 'start_capture')!

    try {
      await expect(startCapture.execute({})).rejects.toThrow('extension not responding')
      expect(stopCalled).toBe(true)
    } finally {
      session.cleanup()
    }
  })
})

describe('get_capture extension probe', () => {
  test('active session + connected extension includes nested extension field from live probe', async () => {
    const session = new CaptureSession('test-tools-get-capture-probe', { urlFilter: null })
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => ({ active: true, pendingRequests: 2, tabsAttached: 4 }),
      getCaptureSession: () => session,
      isConnected: () => true,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const getCapture = localTools.find(t => t.name === 'get_capture')!

    try {
      const result = await getCapture.execute({}) as { sessionId: string; extension?: { tabsAttached: number; pendingRequests: number } }
      expect(result.extension).toBeTruthy()
      expect(result.extension!.tabsAttached).toBe(4)
      expect(result.extension!.pendingRequests).toBe(2)
    } finally {
      session.cleanup()
    }
  })

  test('probe rejection still resolves with plain snapshot, no extension field, no throw', async () => {
    const session = new CaptureSession('test-tools-get-capture-probe-fail', { urlFilter: null })
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => { throw new Error('probe timed out') },
      getCaptureSession: () => session,
      isConnected: () => true,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const getCapture = localTools.find(t => t.name === 'get_capture')!

    try {
      const result = await getCapture.execute({}) as { sessionId: string; extension?: unknown }
      expect(result.sessionId).toBe(session.id)
      expect(result.extension).toBeUndefined()
    } finally {
      session.cleanup()
    }
  })

  test('extension disconnected: no probe, no extension field, no throw', async () => {
    const session = new CaptureSession('test-tools-get-capture-disconnected', { urlFilter: null })
    let dispatchCalls = 0
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => { dispatchCalls++; return { active: true, pendingRequests: 0, tabsAttached: 1 } },
      getCaptureSession: () => session,
      isConnected: () => false,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const getCapture = localTools.find(t => t.name === 'get_capture')!

    try {
      const result = await getCapture.execute({}) as { sessionId: string; extension?: unknown }
      expect(result.sessionId).toBe(session.id)
      expect(result.extension).toBeUndefined()
      expect(dispatchCalls).toBe(0)
    } finally {
      session.cleanup()
    }
  })

  test('non-active (finished) session with connected extension: plain snapshot, no probe attempted', async () => {
    const session = new CaptureSession('test-tools-get-capture-finished', { urlFilter: null })
    session.finalize()
    let dispatchCalls = 0
    const localServer = {
      dispatch: async (_cmd: Record<string, unknown>) => { dispatchCalls++; return { active: true, pendingRequests: 0, tabsAttached: 1 } },
      getCaptureSession: () => session,
      isConnected: () => true,
    } as unknown as WebsterServer
    const localTools = createTools(localServer)
    const getCapture = localTools.find(t => t.name === 'get_capture')!

    try {
      const result = await getCapture.execute({}) as { sessionId: string; extension?: unknown }
      expect(result.sessionId).toBe(session.id)
      expect(result.extension).toBeUndefined()
      expect(dispatchCalls).toBe(0)
    } finally {
      session.cleanup()
    }
  })
})
