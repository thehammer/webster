import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WebsterServer } from './server.js'
import type { VideoFormat } from './video.js'

interface WebsterTool extends Tool {
  execute(input: Record<string, unknown>): Promise<unknown>
}

export function createTools(server: WebsterServer): WebsterTool[] {
  function dispatch(action: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    return server.dispatch({ action, ...params }, timeoutMs)
  }

  const CAPTURE_TIMEOUT = 60000 // 60s — capture setup touches every tab

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
      name: 'start_capture',
      description: 'Start deep capture using Chrome Debugger Protocol. Captures FULL network request/response bodies, headers, and timing across ALL windows including popups. Capture data streams to the server in real-time — resilient to browser extension restarts. Use stop_capture to finish, get_capture to read data.',
      inputSchema: {
        type: 'object',
        properties: {
          urlFilter: { type: 'string', description: 'Only capture requests where URL contains this string (e.g. "extendedcare.com"). Omit to capture everything.' },
          includeInput: { type: 'boolean', description: 'Also capture mouse and keyboard events (clicks, moves, keypresses) alongside network traffic.' },
          recordFrames: { type: 'boolean', description: 'Also record screenshots for video/GIF export. Frames stream to server and are stored on disk.' },
          fps: { type: 'number', description: 'Frames per second for recording (default: 2). Only used when recordFrames is true.' },
        },
      },
      execute: async (input) => {
        const config = {
          urlFilter: (input.urlFilter as string) || null,
          includeInput: !!input.includeInput,
          recordFrames: !!input.recordFrames,
          fps: (input.fps as number) || 2,
        }

        // Create server-side session BEFORE telling the extension to start
        const session = server.startCaptureSession(config)

        // Tell extension to start capture + streaming
        await dispatch('startCapture', {
          ...input,
          // Signal to extension: stream events to server instead of buffering
          streamToServer: true,
        }, CAPTURE_TIMEOUT)

        return session.getSnapshot()
      },
    },

    {
      name: 'stop_capture',
      description: 'Stop capture session. Returns a summary with sessionId — use get_capture to read events, or export_video for recordings.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      execute: async () => {
        // Tell extension to stop (lightweight — no data returned)
        await dispatch('stopCapture', {}, CAPTURE_TIMEOUT)

        // Finalize server-side session
        const session = server.stopCaptureSession()
        if (!session) throw new Error('No active capture session')
        return session.getSnapshot()
      },
    },

    {
      name: 'get_capture',
      description: 'Read capture data from the server. Returns a summary by default. Use parameters to drill into specific events or filter by URL. Data is read from the server — no round-trip to the browser extension.',
      inputSchema: {
        type: 'object',
        properties: {
          events: { type: 'boolean', description: 'Include the full event list (default: false, returns summary only)' },
          kind: { type: 'string', enum: ['network', 'input', 'console', 'page'], description: 'Filter events by kind' },
          urlFilter: { type: 'string', description: 'Filter network events by URL substring' },
          event: { type: 'number', description: 'Return a single event by index (0-based)' },
          offset: { type: 'number', description: 'Skip first N events (for pagination)' },
          limit: { type: 'number', description: 'Max events to return (for pagination)' },
        },
      },
      execute: async (input) => {
        const session = server.getCaptureSession()
        if (!session) throw new Error('No capture session — call start_capture first')

        // Single event by index
        if (input.event != null) {
          const event = session.readEvent(input.event as number)
          if (!event) throw new Error(`Event ${input.event} not found`)
          return event
        }

        // Full event list with optional filters
        if (input.events) {
          return session.readEvents({
            kind: input.kind as 'network' | 'input' | undefined,
            urlFilter: input.urlFilter as string | undefined,
            offset: input.offset as number | undefined,
            limit: input.limit as number | undefined,
          })
        }

        // Default: summary only
        return session.getSnapshot()
      },
    },

    {
      name: 'export_video',
      description: 'Encode captured frames into a video file. Requires recordFrames on start_capture. Returns the file path. Supports mp4, webm, and gif formats.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['mp4', 'webm', 'gif'], description: 'Video format (default: mp4)' },
          fps: { type: 'number', description: 'Frames per second (default: 2)' },
        },
      },
      execute: async (input) => {
        const session = server.getCaptureSession()
        if (!session) throw new Error('No capture session')

        const snap = session.getSnapshot()
        if (snap.frameCount === 0) throw new Error('No frames recorded — did you set recordFrames: true on start_capture?')

        const { encodeVideo } = await import('./video.js')
        const outPath = await encodeVideo(session.framesDir, {
          format: (input.format as VideoFormat) || 'mp4',
          fps: (input.fps as number) || snap.config.fps || 2,
          outDir: session.dir,
        })

        return { path: outPath, format: input.format || 'mp4', frames: snap.frameCount }
      },
    },

    {
      name: 'hover',
      description: 'Move the mouse cursor to (x, y) coordinates without clicking. Triggers mouseover/mouseenter/mousemove events — useful for revealing tooltips, dropdown menus, and hover states.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate (pixels from left edge of viewport)' },
          y: { type: 'number', description: 'Y coordinate (pixels from top edge of viewport)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['x', 'y'],
      },
      execute: (input) => dispatch('hover', input),
    },

    {
      name: 'drag',
      description: 'Click and drag from one coordinate to another. Uses real mouse events via Chrome Debugger Protocol. Works for sliders, sortable lists, canvas drag-and-drop.',
      inputSchema: {
        type: 'object',
        properties: {
          startX: { type: 'number', description: 'Starting X coordinate' },
          startY: { type: 'number', description: 'Starting Y coordinate' },
          endX: { type: 'number', description: 'Ending X coordinate' },
          endY: { type: 'number', description: 'Ending Y coordinate' },
          steps: { type: 'number', description: 'Number of intermediate mouse move events (default 10, more = smoother)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['startX', 'startY', 'endX', 'endY'],
      },
      execute: (input) => dispatch('drag', input),
    },

    {
      name: 'key_press',
      description: 'Press a keyboard key using Chrome Debugger Protocol. Works for Enter, Tab, Escape, arrow keys, function keys, and single characters. Use modifiers for Ctrl+C, Shift+Tab, etc.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key name: "Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp/Down/Left/Right", "Home", "End", "PageUp", "PageDown", "F1"-"F12", or any single character like "a", "A", "1"' },
          modifiers: {
            type: 'array',
            items: { type: 'string', enum: ['alt', 'ctrl', 'meta', 'shift'] },
            description: 'Modifier keys to hold while pressing (e.g. ["ctrl"] for Ctrl+key, ["ctrl", "shift"] for multi-modifier)',
          },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
        required: ['key'],
      },
      execute: (input) => dispatch('keyPress', input),
    },

    {
      name: 'get_input_log',
      description: 'Return buffered user input events from the current page: mouse moves, clicks, and key presses. Useful for understanding what a user is doing or verifying that programmatic input registered correctly.',
      inputSchema: {
        type: 'object',
        properties: {
          clear: { type: 'boolean', description: 'Clear the buffer after reading (default true)' },
          tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
        },
      },
      execute: (input) => dispatch('getInputLog', input),
    },

    {
      name: 'claim_tab',
      description: 'Mark a tab as owned by this Claude session. Prevents accidental cross-session interference when multiple Claude sessions share the same browser. Use release_tab when done.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID to claim (defaults to active tab)' },
        },
      },
      execute: async (input) => {
        const tabId = input.tabId as number | undefined
        const claimed = server.claimTab(tabId)
        return claimed
      },
    },

    {
      name: 'release_tab',
      description: 'Release ownership of a tab claimed by this session. Call when done with a tab so other sessions can use it.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID to release (defaults to active tab, but only if claimed by this session)' },
        },
      },
      execute: async (input) => {
        const tabId = input.tabId as number | undefined
        server.releaseTab(tabId)
        return { released: true, tabId: tabId ?? null }
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
