export interface WsCommand {
  id: string
  action: string
  [key: string]: unknown
}

export interface WsResult {
  id: string
  success: boolean
  data?: unknown
  error?: string
}

export interface WsEvent {
  type: 'connected'
  version: string
  browser?: string
}

export type WsMessage = WsResult | WsEvent

export function isResult(msg: WsMessage): msg is WsResult {
  return 'id' in msg
}
