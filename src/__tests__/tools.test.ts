import { describe, test, expect } from 'bun:test'
import { createTools } from '../tools.js'
import type { WebsterServer } from '../server.js'

const mockServer = {
  dispatch: async (_cmd: Record<string, unknown>) => ({ success: true }),
  isConnected: () => true,
  getBrowsers: () => [],
  setBrowser: (_idOrName: string) => ({ id: 'test', browser: 'chrome', version: '1.0', transport: 'ws', active: true }),
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
  'get_browsers',
  'set_browser',
]

describe('createTools', () => {
  test('all 24 tools are present by name', () => {
    const names = tools.map(t => t.name)
    for (const expected of EXPECTED_TOOL_NAMES) {
      expect(names).toContain(expected)
    }
    expect(tools).toHaveLength(24)
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

  test('tools with no required fields accept empty input', () => {
    const noRequiredTools = ['screenshot', 'get_tabs', 'get_network_log', 'wait_for_network_idle',
      'get_cookies', 'get_local_storage', 'read_console', 'get_page_info', 'read_page',
      'read_html', 'scroll_to']
    for (const name of noRequiredTools) {
      const tool = tools.find(t => t.name === name)!
      expect(tool, `${name} not found`).toBeTruthy()
      const required = tool.inputSchema.required
      expect(!required || required.length === 0, `${name} has unexpected required fields`).toBe(true)
    }
  })
})
