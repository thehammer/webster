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

export interface WsCaptureEvent {
  type: 'capture_event'
  kind: 'network' | 'input' | 'frame' | 'console' | 'page'
  data: Record<string, unknown>
}

export interface WsCaptureDone {
  type: 'capture_done'
}

export type WsMessage = WsResult | WsEvent | WsCaptureEvent | WsCaptureDone

export function isResult(msg: WsMessage): msg is WsResult {
  return 'id' in msg
}

export function isCaptureEvent(msg: WsMessage): msg is WsCaptureEvent {
  return 'type' in msg && (msg as WsCaptureEvent).type === 'capture_event'
}

export function isCaptureDone(msg: WsMessage): msg is WsCaptureDone {
  return 'type' in msg && (msg as WsCaptureDone).type === 'capture_done'
}
