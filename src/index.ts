import { WebsterServer } from './server.js'
import { McpSessionManager, buildMcpServer } from './mcp.js'

const PORT = Number(process.env.WEBSTER_PORT ?? 3456)

const wsServer = new WebsterServer(PORT)
wsServer.registerSelf()

const sessionManager = new McpSessionManager(wsServer)
wsServer.setMcpHandler((req) => sessionManager.handleRequest(req))

// Optional stdio mode for backward compat (WEBSTER_MCP_MODE=stdio)
if (process.env.WEBSTER_MCP_MODE === 'stdio') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const transport = new StdioServerTransport()
  const server = buildMcpServer(wsServer)
  await server.connect(transport)
  console.error(`Webster MCP server started (ws://localhost:${PORT}, stdio MCP)`)
} else {
  console.error(`Webster MCP server started (ws://localhost:${PORT}, http://localhost:${PORT}/mcp)`)
}

process.on('SIGINT', () => { wsServer.close(); process.exit(0) })
process.on('SIGTERM', () => { wsServer.close(); process.exit(0) })
