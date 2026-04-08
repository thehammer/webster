import { WebsterServer } from './server.js'
import { McpSessionManager } from './mcp.js'

const PORT = Number(process.env.WEBSTER_PORT ?? 3456)

const wsServer = new WebsterServer(PORT)
wsServer.registerSelf()

const sessionManager = new McpSessionManager(wsServer)
wsServer.setMcpHandler((req) => sessionManager.handleRequest(req))

console.error(`Webster MCP server started (ws://localhost:${PORT}, http://localhost:${PORT}/mcp)`)

process.on('SIGINT', () => { wsServer.close(); process.exit(0) })
process.on('SIGTERM', () => { wsServer.close(); process.exit(0) })
