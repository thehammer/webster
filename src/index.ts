import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { WebsterServer } from './server.js'
import { createTools } from './tools.js'

const PORT = Number(process.env.WEBSTER_PORT ?? 3000)

// If port is already in use (orphan from a previous session), kill it and retry.
let wsServer: WebsterServer
try {
  wsServer = new WebsterServer(PORT)
} catch {
  console.error(`[webster] Port ${PORT} in use — freeing orphan process and retrying...`)
  Bun.spawnSync(['sh', '-c', `lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true`])
  await new Promise(r => setTimeout(r, 300))
  wsServer = new WebsterServer(PORT) // throws with real error if still busy
}
const tools = createTools(wsServer)

const mcpServer = new Server(
  { name: 'webster', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}))

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name)
  if (!tool) throw new Error(`Unknown tool: ${request.params.name}`)

  try {
    const result = await tool.execute((request.params.arguments ?? {}) as Record<string, unknown>)
    return {
      content: [{ type: 'text', text: result == null ? 'ok' : typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true
    }
  }
})

const transport = new StdioServerTransport()
await mcpServer.connect(transport)
console.error(`Webster MCP server started (WebSocket on ws://localhost:${PORT})`)

process.on('SIGINT', () => { wsServer.close(); process.exit(0) })
process.on('SIGTERM', () => { wsServer.close(); process.exit(0) })
