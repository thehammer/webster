import { isResult, type WsCommand, type WsMessage } from './protocol.js'

interface PendingCommand {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtServer = Bun.Server<any>

export class WebsterServer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extension: any = null
  private pending = new Map<string, PendingCommand>()
  private server: ExtServer
  private commandTimeout: number

  constructor(port: number, commandTimeout = 30000) {
    this.commandTimeout = commandTimeout

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.server = (Bun.serve as any)({
      port,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch(req: Request, server: any) {
        if (server.upgrade(req)) return undefined as unknown as Response
        return new Response('Webster MCP server', { status: 200 })
      },
      websocket: {
        open: (ws: unknown) => this.handleOpen(ws),
        message: (ws: unknown, data: string | Buffer) => this.handleMessage(ws, data),
        close: (ws: unknown) => this.handleClose(ws),
      },
    })
  }

  get port(): number {
    return this.server.port as number
  }

  private handleOpen(_ws: unknown) {
    // Don't track yet — wait for the { type: 'connected' } handshake message.
    // This prevents test clients or stray connections from hijacking the slot.
  }

  private handleMessage(ws: unknown, data: string | Buffer) {
    let msg: WsMessage
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString())
    } catch {
      console.error('Webster: failed to parse message', data)
      return
    }

    if (!isResult(msg)) {
      // It's a WsEvent — the extension identifying itself
      if (this.extension && this.extension !== ws) {
        // Close the previously tracked connection cleanly
        try { (this.extension as { close(): void }).close() } catch { /* ignore */ }
      }
      this.extension = ws
      console.error(`Webster: extension v${msg.version} connected`)
      return
    }

    const pending = this.pending.get(msg.id)
    if (!pending) return

    clearTimeout(pending.timeoutHandle)
    this.pending.delete(msg.id)

    if (msg.success) {
      pending.resolve(msg.data)
    } else {
      pending.reject(new Error(msg.error ?? 'Command failed'))
    }
  }

  private handleClose(_ws: unknown) {
    this.extension = null
    console.error('Extension disconnected')

    // Reject all pending commands
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeoutHandle)
      pending.reject(new Error('Extension disconnected'))
      this.pending.delete(id)
    }
  }

  dispatch(command: Omit<WsCommand, 'id'>): Promise<unknown> {
    if (!this.extension) {
      return Promise.reject(new Error('Extension not connected'))
    }

    const id = crypto.randomUUID() as string
    const msg: WsCommand = { id, ...command } as WsCommand

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Command timed out after 30s'))
      }, this.commandTimeout)

      this.pending.set(id, { resolve, reject, timeoutHandle })
      this.extension!.send(JSON.stringify(msg))
    })
  }

  isConnected(): boolean {
    return this.extension !== null
  }

  close(): void {
    this.server.stop(true)
  }
}
