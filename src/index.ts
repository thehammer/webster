import { WebsterServer } from './server.js'
import { McpSessionManager } from './mcp.js'
import { DEFAULT_GRACE_MS } from './capture.js'

const PORT = Number(process.env.WEBSTER_PORT ?? 3456)

// Capture retention. Sessions older than this become eligible for eviction;
// they are warned first and deleted one grace period later. 0 (or a negative /
// unparseable value) disables deletion entirely — retain forever.
const RETENTION_HOURS = Number(process.env.WEBSTER_RETENTION_HOURS ?? 24)
const maxAgeMs = Number.isFinite(RETENTION_HOURS) && RETENTION_HOURS > 0
  ? RETENTION_HOURS * 60 * 60 * 1000
  : 0

// The one production entry point — and the only place retention is turned on.
const wsServer = new WebsterServer(PORT, undefined, { retention: maxAgeMs > 0 ? { maxAgeMs } : false })
wsServer.registerSelf()

const sessionManager = new McpSessionManager(wsServer)
wsServer.setMcpHandler((req) => sessionManager.handleRequest(req))

console.error(`Webster MCP server started (ws://localhost:${PORT}, http://localhost:${PORT}/mcp)`)
const graceHours = DEFAULT_GRACE_MS / (60 * 60 * 1000)
console.error(`Webster: capture retention ${maxAgeMs > 0 ? `${RETENTION_HOURS}h (plus a ${graceHours}h grace notice before deletion)` : 'disabled — captures are retained indefinitely'}`)

process.on('SIGINT', () => { wsServer.close(); process.exit(0) })
process.on('SIGTERM', () => { wsServer.close(); process.exit(0) })
