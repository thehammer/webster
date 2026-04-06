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

    {
      name: 'get_accessibility_tree',
      description: 'Get the accessibility tree of the current page — a semantic map of all elements with roles, names, and stable refs. More reliable than CSS selectors for understanding page structure. Use filter:"interactive" to get only actionable elements. Chrome/Edge only.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
          depth: { type: 'number', description: 'Max tree depth (default 10)' },
          filter: { type: 'string', enum: ['all', 'interactive'], description: 'Filter to interactive elements only (default: all)' },
        },
      },
      execute: (input) => dispatch('getAccessibilityTree', input),
    },

    {
      name: 'click_at',
      description: 'Click at specific (x, y) pixel coordinates. Use this for canvas elements, SVG, custom widgets, or anything without a reliable CSS selector. Requires Chrome/Edge.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate (pixels from left)' },
          y: { type: 'number', description: 'Y coordinate (pixels from top)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['x', 'y'],
      },
      execute: (input) => dispatch('clickAt', input),
    },

    {
      name: 'click_ref',
      description: 'Click an element identified by an accessibility tree ref (from get_accessibility_tree). More reliable than coordinates for elements that may reflow. Requires Chrome/Edge.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from get_accessibility_tree (format: "role:name:left,top,width,height")' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['ref'],
      },
      execute: (input) => dispatch('clickRef', input),
    },

    {
      name: 'find_element',
      description: 'Find page elements by natural language description (e.g. "login button", "email input field"). Returns up to 5 best matches with refs that can be used with click_ref. Requires Chrome/Edge.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language description of the element to find' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
          filter: { type: 'string', enum: ['all', 'interactive'], description: 'Filter to interactive elements (default: interactive)' },
        },
        required: ['query'],
      },
      execute: async (input) => {
        const { query, tabId, filter = 'interactive' } = input as { query: string; tabId?: number; filter?: string }

        const treeResult = await dispatch('getAccessibilityTree', { tabId, filter, depth: 10 }) as { role: string; name: string; ref: string; bounds: object; description?: string; children?: unknown[] } | null

        if (!treeResult) throw new Error('Could not get accessibility tree')

        const queryTokens = (query as string).toLowerCase().split(/[\s\-_]+/).filter(t => t.length > 1)

        interface A11yNode { role: string; name: string; ref: string; bounds: object; description?: string; value?: string; children?: A11yNode[] }
        interface ScoredNode { score: number; role: string; name: string; ref: string; bounds: object; description?: string }

        function scoreNode(node: A11yNode): number {
          const text = `${node.name || ''} ${node.description || ''} ${node.role || ''} ${node.value || ''}`.toLowerCase()
          return queryTokens.filter(t => text.includes(t)).length
        }

        function collectNodes(node: A11yNode, results: ScoredNode[]) {
          const score = scoreNode(node)
          if (score > 0) {
            results.push({ score, role: node.role, name: node.name, ref: node.ref, bounds: node.bounds, description: node.description })
          }
          if (node.children) node.children.forEach((c: A11yNode) => collectNodes(c, results))
        }

        const results: ScoredNode[] = []
        collectNodes(treeResult as unknown as A11yNode, results)
        results.sort((a, b) => b.score - a.score)

        return results.slice(0, 5)
      },
    },

    {
      name: 'upload_file',
      description: 'Upload a file to a <input type="file"> element or drag-drop target. Provide base64-encoded file content. Use selector for file inputs; use x/y coordinates for drag-drop targets.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Base64-encoded file content' },
          filename: { type: 'string', description: 'Filename (e.g. "photo.jpg")' },
          mimeType: { type: 'string', description: 'MIME type (default: application/octet-stream)' },
          selector: { type: 'string', description: 'CSS selector for <input type="file"> element' },
          x: { type: 'number', description: 'X coordinate of drag-drop target (if no selector)' },
          y: { type: 'number', description: 'Y coordinate of drag-drop target (if no selector)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['content', 'filename'],
      },
      execute: (input) => {
        const { selector } = input as { selector?: string }
        const action = selector ? 'uploadFile' : 'dragDropFile'
        return dispatch(action, input)
      },
    },

    {
      name: 'resize_window',
      description: 'Resize the browser window to specified dimensions. Useful for testing responsive layouts.',
      inputSchema: {
        type: 'object',
        properties: {
          width: { type: 'number', description: 'Window width in pixels' },
          height: { type: 'number', description: 'Window height in pixels' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['width', 'height'],
      },
      execute: (input) => dispatch('resizeWindow', input),
    },

    {
      name: 'start_recording',
      description: 'Start recording browser frames for GIF export. Captures screenshots at the specified FPS. Call stop_recording or export_gif when done.',
      inputSchema: {
        type: 'object',
        properties: {
          fps: { type: 'number', description: 'Frames per second (default: 2)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: (input) => dispatch('startRecording', input),
    },

    {
      name: 'stop_recording',
      description: 'Stop recording and return the captured frames as base64 PNG data URLs.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: (input) => dispatch('stopRecording', input),
    },

    {
      name: 'export_gif',
      description: 'Stop recording and export the captured frames as an animated GIF. Returns a base64 data URL of the GIF. Uses ffmpeg if available, pure-JS encoder otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          fps: { type: 'number', description: 'Frames per second for the GIF (default: 2)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: async (input) => {
        const result = await dispatch('stopRecording', input) as { frames: { dataUrl: string; timestamp: number }[] }
        if (!result?.frames?.length) throw new Error('No frames recorded')
        const { encodeGif } = await import('./gif.js')
        return encodeGif(result.frames, (input as { fps?: number }).fps ?? 2)
      },
    },

    {
      name: 'get_browsers',
      description: 'List all connected browser extensions. Use this to see which browsers are available before using set_browser.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => Promise.resolve(server.getBrowsers()),
    },

    {
      name: 'set_browser',
      description: 'Set the active browser target for all subsequent commands. Use get_browsers first to see available options.',
      inputSchema: {
        type: 'object',
        properties: {
          browser: { type: 'string', description: 'Browser name ("chrome", "safari", "firefox", "edge") or extension id' },
        },
        required: ['browser'],
      },
      execute: (input) => Promise.resolve(server.setBrowser(input.browser as string)),
    },
  ]
}
