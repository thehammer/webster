import type { CaptureSession, CaptureSnapshot } from './capture.js'

/**
 * Result shape returned by start_capture / POST /api/capture/start — the
 * server-side snapshot plus what the extension actually reported about the
 * CDP attach. `tabsAttached` is the source of truth for whether a capture
 * will record any request/response bodies at all; `null` means the
 * extension's reply didn't include the field (older extension build).
 */
export interface StartCaptureResult extends CaptureSnapshot {
  tabsAttached: number | null
  warnings: string[]
}

const ZERO_TABS_WARNING =
  'CDP attached to 0 tabs — this capture will record NO request/response bodies. ' +
  'Common cause: a chrome-extension:// iframe (password manager) in the page causes ' +
  'Chrome to refuse chrome.debugger.attach. Close the offending extension or the tab ' +
  'and restart the capture.'

/**
 * Format the error surfaced when the extension never confirmed a
 * start_capture dispatch (timeout, disconnect, etc.) — shared by the MCP
 * tool (which throws it) and the HTTP endpoint (which wraps it in a 500),
 * so the wording can't drift between the two call sites.
 */
export function startCaptureDispatchFailureMessage(e: unknown): string {
  return `start_capture failed to reach the extension: ${e instanceof Error ? e.message : String(e)}`
}

/**
 * Merge the extension's startCapture reply into the session snapshot,
 * surfacing the CDP attach count and any warnings — both a synthesized
 * zero-tab warning and any `kind: 'meta', subKind: 'warning'` events already
 * on disk (e.g. cdp_unavailable, cdp_detached). Matched by `subKind`, not an
 * enumerated list of codes, so future warning codes surface automatically.
 *
 * Never throws — a failure reading events must not fail the caller.
 */
export function buildStartCaptureResult(
  session: CaptureSession,
  reply: Record<string, unknown> | undefined
): StartCaptureResult {
  const tabsAttached = typeof reply?.tabsAttached === 'number' ? reply.tabsAttached : null

  const warnings: string[] = []
  if (tabsAttached === 0) {
    warnings.push(ZERO_TABS_WARNING)
  }

  try {
    for (const ev of session.readEvents({ kind: 'meta' })) {
      if (ev.subKind === 'warning' && typeof ev.message === 'string') {
        warnings.push(ev.message)
      }
    }
  } catch {
    // best-effort — a disk read failure here must never fail start_capture
  }

  return { ...session.getSnapshot(), tabsAttached, warnings }
}
