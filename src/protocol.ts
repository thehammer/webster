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

export type CaptureEventKind =
  | 'network'
  | 'input'
  | 'frame'
  | 'console'
  | 'page'
  | 'websocket'
  | 'dom'
  | 'storage'
  | 'annotation'
  | 'meta'

export interface WsCaptureEvent {
  type: 'capture_event'
  kind: CaptureEventKind
  data: Record<string, unknown>
}

// Extension signals that a binary response body has been captured and is
// enclosed inline as base64. The server persists the body to the session's
// bodies/ directory and rewrites the network event with a path reference.
export interface WsCaptureBody {
  type: 'capture_body'
  requestId: string
  tabId?: number
  mimeType?: string
  encoding: 'base64'
  data: string
}

export interface WsCaptureDone {
  type: 'capture_done'
}

export type WsMessage = WsResult | WsEvent | WsCaptureEvent | WsCaptureDone | WsCaptureBody

export function isResult(msg: WsMessage): msg is WsResult {
  return 'id' in msg
}

export function isCaptureEvent(msg: WsMessage): msg is WsCaptureEvent {
  return 'type' in msg && (msg as WsCaptureEvent).type === 'capture_event'
}

export function isCaptureDone(msg: WsMessage): msg is WsCaptureDone {
  return 'type' in msg && (msg as WsCaptureDone).type === 'capture_done'
}

export function isCaptureBody(msg: WsMessage): msg is WsCaptureBody {
  return 'type' in msg && (msg as WsCaptureBody).type === 'capture_body'
}

/** True for any extension→server push event related to an active capture. */
export function isCapturePush(msg: WsMessage): msg is WsCaptureEvent | WsCaptureDone | WsCaptureBody {
  return isCaptureEvent(msg) || isCaptureDone(msg) || isCaptureBody(msg)
}
