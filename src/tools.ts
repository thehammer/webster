import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WebsterServer } from './server.js'

interface WebsterTool extends Tool {
  execute(input: Record<string, unknown>): Promise<unknown>
}

export function createTools(server: WebsterServer): WebsterTool[] {
  function dispatch(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return server.dispatch({ action, ...params })
  }

  return [
    {
      name: 'navigate',
      description: 'Navigate the active tab (or a specific tab) to a URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          tabId: { type: 'number', description: 'Tab ID to navigate (defaults to active tab)' },
        },
        required: ['url'],
      },
      execute: (input) => dispatch('navigate', input),
    },

    {
      name: 'click',
      description: 'Click an element matching a CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of element to click' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['selector'],
      },
      execute: (input) => dispatch('click', input),
    },

    {
      name: 'type',
      description: 'Type text into an input element matching a CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of input element' },
          text: { type: 'string', description: 'Text to type' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['selector', 'text'],
      },
      execute: (input) => dispatch('type', input),
    },

    {
      name: 'read_page',
      description: 'Returns the text content of the page body or a specific element',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector (defaults to body)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: (input) => dispatch('readText', input),
    },

    {
      name: 'read_html',
      description: 'Returns the outerHTML of the page or a specific element',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector (defaults to documentElement)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: (input) => dispatch('readHtml', input),
    },

    {
      name: 'screenshot',
      description: 'Capture a screenshot of the active tab, returns base64 PNG data URL',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: (input) => dispatch('screenshot', input),
    },

    {
      name: 'eval_js',
      description: 'Evaluate JavaScript in the page context and return the result',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to evaluate' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['code'],
      },
      execute: (input) => dispatch('evalJs', input),
    },

    {
      name: 'wait_for',
      description: 'Wait for an element matching a CSS selector to appear in the DOM',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for' },
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 5000)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['selector'],
      },
      execute: (input) => dispatch('waitFor', input),
    },

    {
      name: 'get_tabs',
      description: 'Get all open browser tabs with id, url, title, active, and windowId',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: () => dispatch('getTabs'),
    },

    {
      name: 'open_tab',
      description: 'Open a new browser tab and return its id and url',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open in the new tab' },
        },
        required: ['url'],
      },
      execute: (input) => dispatch('openTab', input),
    },

    {
      name: 'close_tab',
      description: 'Close a browser tab by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'ID of the tab to close' },
        },
        required: ['tabId'],
      },
      execute: (input) => dispatch('closeTab', input),
    },

    {
      name: 'switch_tab',
      description: 'Make a tab active by its ID',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'ID of the tab to activate' },
        },
        required: ['tabId'],
      },
      execute: (input) => dispatch('switchTab', input),
    },

    {
      name: 'get_network_log',
      description: 'Get buffered network requests captured by the extension (clears buffer)',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: () => dispatch('getNetworkLog'),
    },

    {
      name: 'wait_for_network_idle',
      description: 'Wait until there are no in-flight network requests',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: { type: 'number', description: 'Timeout in milliseconds (default 5000)' },
        },
      },
      execute: (input) => dispatch('waitForNetworkIdle', input),
    },

    {
      name: 'get_cookies',
      description: 'Get cookies for the current tab URL or a specific URL',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to get cookies for (defaults to active tab URL)' },
        },
      },
      execute: (input) => dispatch('getCookies', input),
    },

    {
      name: 'get_local_storage',
      description: 'Get a localStorage value by key, or all entries if no key given',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to retrieve (returns all if omitted)' },
        },
      },
      execute: (input) => dispatch('getLocalStorage', input),
    },

    {
      name: 'set_local_storage',
      description: 'Set a localStorage entry in the active tab',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'localStorage key' },
          value: { type: 'string', description: 'Value to set' },
        },
        required: ['key', 'value'],
      },
      execute: (input) => dispatch('setLocalStorage', input),
    },

    {
      name: 'read_console',
      description: 'Get console log entries, optionally filtered by a regex pattern',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to filter entries' },
        },
      },
      execute: (input) => dispatch('readConsole', input),
    },

    {
      name: 'get_page_info',
      description: 'Get basic page info: url, title, viewportWidth, viewportHeight, readyState',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: () => dispatch('getPageInfo'),
    },

    {
      name: 'find',
      description: 'Find all elements matching a CSS selector, returns count and up to 20 element summaries',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'CSS selector to find elements' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['pattern'],
      },
      execute: (input) => dispatch('find', input),
    },

    {
      name: 'scroll_to',
      description: 'Scroll to an element or to specific x/y coordinates',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to scroll to' },
          x: { type: 'number', description: 'X coordinate to scroll to' },
          y: { type: 'number', description: 'Y coordinate to scroll to' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: (input) => dispatch('scrollTo', input),
    },

    {
      name: 'get_attribute',
      description: 'Get an attribute value from an element matching a CSS selector',
      inputSchema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the element' },
          attribute: { type: 'string', description: 'Attribute name to retrieve' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['selector', 'attribute'],
      },
      execute: (input) => dispatch('getAttribute', input),
    },
  ]
}
