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

export type BrowserKind = 'extension' | 'webkit'
export type DriverState = 'agent' | 'user' | 'stopped'

export interface Limitation {
  area: string
  missing: string
  tools?: string[]
}

export type ToolSupportLevel = 'parity' | 'approximate' | 'unsupported'

export interface ToolSupport {
  level: ToolSupportLevel
  note?: string
}

export interface WsEvent {
  type: 'connected'
  version: string
  browser?: string
  // Optional fields. Extensions may send `instanceId`; the rest are the native
  // (kind: 'webkit') peer handshake — see docs/browser-peers.md.
  kind?: BrowserKind
  instanceId?: string
  owner?: string
  engine?: string
  focus?: { tag: string; name: string }
  profile?: string
  driver?: DriverState
  limitations?: Limitation[]
  toolSupport?: Record<string, ToolSupport>
}

/** Peer → server: update the fields shown in get_browsers. */
export interface WsPeerState {
  type: 'peer_state'
  driver?: DriverState
  profile?: string
  focus?: { tag: string; name: string }
  limitations?: Limitation[]
  toolSupport?: Record<string, ToolSupport>
}

/** Peer → server: pin this peer for every session of its owner. */
export interface WsSelectForOwner {
  type: 'select_for_owner'
}

/** Peer → server: closing for good. */
export interface WsUnregister {
  type: 'unregister'
  reason?: string
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

export type WsMessage =
  | WsResult | WsEvent | WsCaptureEvent | WsCaptureDone | WsCaptureBody
  | WsPeerState | WsSelectForOwner | WsUnregister

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

export function isConnectedEvent(msg: WsMessage): msg is WsEvent {
  return 'type' in msg && (msg as WsEvent).type === 'connected'
}

export function isPeerState(msg: WsMessage): msg is WsPeerState {
  return 'type' in msg && (msg as WsPeerState).type === 'peer_state'
}

export function isSelectForOwner(msg: WsMessage): msg is WsSelectForOwner {
  return 'type' in msg && (msg as WsSelectForOwner).type === 'select_for_owner'
}

export function isUnregister(msg: WsMessage): msg is WsUnregister {
  return 'type' in msg && (msg as WsUnregister).type === 'unregister'
}
