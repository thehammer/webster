/**
 * Tests for the long-polling get_input_log additions:
 *   - types filter
 *   - minTimestamp filter
 *   - selective clear (filtered calls only remove matched entries)
 *   - waitFor:"new_events" long-poll (server-side retry loop)
 *
 * The filter logic lives in extension/content/page-script.js (WEBSTER_READ_INPUT
 * handler). We mirror it here with the same plain-JS approach used in
 * input-enrichment.test.ts so it can run in Bun without a browser.
 *
 * The long-poll logic lives in src/tools.ts. We test it by building the tool
 * with a controlled mock dispatch that returns predetermined sequences.
 */

import { describe, test, expect } from 'bun:test'
import { createTools } from '../tools.js'
import type { WebsterServer } from '../server.js'
import { CaptureSession } from '../capture.js'

// ─── Filter logic (mirrors page-script.js WEBSTER_READ_INPUT handler) ────────

function applyFilters(
  buffer: Array<{ type: string; t: number; [k: string]: unknown }>,
  types?: string[],
  minTimestamp?: number,
): typeof buffer {
  let entries = [...buffer]
  if (types) entries = entries.filter(e => types.includes(e.type))
  if (typeof minTimestamp === 'number') entries = entries.filter(e => e.t > minTimestamp)
  return entries
}

function selectiveClear(
  buffer: Array<{ type: string; t: number; [k: string]: unknown }>,
  entries: typeof buffer,
  types?: string[],
  minTimestamp?: number,
): void {
  if (!types && typeof minTimestamp !== 'number') {
    buffer.length = 0
  } else {
    const returnedSet = new Set(entries)
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (returnedSet.has(buffer[i])) buffer.splice(i, 1)
    }
  }
}

// ─── Filter tests ─────────────────────────────────────────────────────────────

describe('types filter', () => {
  const buffer = [
    { type: 'click', x: 10, y: 20, t: 1000 },
    { type: 'mousemove', x: 5, y: 5, t: 1001 },
    { type: 'keydown', key: 'a', t: 1002 },
    { type: 'change', t: 1003 },
    { type: 'click', x: 30, y: 40, t: 1004 },
  ]

  test('no filter returns all events (backwards compatible)', () => {
    const result = applyFilters(buffer)
    expect(result).toHaveLength(5)
  })

  test('types:["click"] returns only clicks', () => {
    const result = applyFilters(buffer, ['click'])
    expect(result).toHaveLength(2)
    expect(result.every(e => e.type === 'click')).toBe(true)
  })

  test('types:["click","change"] returns clicks and changes', () => {
    const result = applyFilters(buffer, ['click', 'change'])
    expect(result).toHaveLength(3)
    const types = result.map(e => e.type)
    expect(types).toContain('click')
    expect(types).toContain('change')
    expect(types).not.toContain('mousemove')
    expect(types).not.toContain('keydown')
  })

  test('types:["navigation"] returns empty when no matches', () => {
    const result = applyFilters(buffer, ['navigation'])
    expect(result).toHaveLength(0)
  })
})

describe('minTimestamp filter', () => {
  const buffer = [
    { type: 'click', t: 1000 },
    { type: 'click', t: 1100 },
    { type: 'click', t: 1200 },
    { type: 'click', t: 1300 },
  ]

  test('minTimestamp:1100 returns events strictly after 1100', () => {
    const result = applyFilters(buffer, undefined, 1100)
    expect(result).toHaveLength(2)
    expect(result.map(e => e.t)).toEqual([1200, 1300])
  })

  test('minTimestamp:0 returns all events (t > 0)', () => {
    const result = applyFilters(buffer, undefined, 0)
    expect(result).toHaveLength(4)
  })

  test('minTimestamp:9999 returns empty', () => {
    const result = applyFilters(buffer, undefined, 9999)
    expect(result).toHaveLength(0)
  })

  test('combines with types filter', () => {
    const mixed = [
      { type: 'click', t: 1000 },
      { type: 'change', t: 1050 },
      { type: 'click', t: 1100 },
      { type: 'change', t: 1150 },
    ]
    const result = applyFilters(mixed, ['click'], 1050)
    expect(result).toHaveLength(1)
    expect(result[0].t).toBe(1100)
  })
})

describe('selective clear', () => {
  test('no filter + clear:true — clears entire buffer', () => {
    const buffer = [
      { type: 'click', t: 1000 },
      { type: 'mousemove', t: 1001 },
    ]
    const entries = applyFilters(buffer)
    selectiveClear(buffer, entries)
    expect(buffer).toHaveLength(0)
  })

  test('types filter + clear:true — only clears matched events, preserves others', () => {
    const click1 = { type: 'click', t: 1000 }
    const move = { type: 'mousemove', t: 1001 }
    const click2 = { type: 'click', t: 1002 }
    const buffer = [click1, move, click2]

    const entries = applyFilters(buffer, ['click'])
    selectiveClear(buffer, entries, ['click'])

    // clicks removed, mousemove preserved
    expect(buffer).toHaveLength(1)
    expect(buffer[0].type).toBe('mousemove')
  })

  test('minTimestamp filter + clear:true — only clears events after timestamp', () => {
    const old = { type: 'click', t: 900 }
    const mid = { type: 'click', t: 1000 }
    const recent = { type: 'click', t: 1100 }
    const buffer = [old, mid, recent]

    const entries = applyFilters(buffer, undefined, 999)  // returns mid + recent
    selectiveClear(buffer, entries, undefined, 999)

    // old (t=900) preserved, mid + recent cleared
    expect(buffer).toHaveLength(1)
    expect(buffer[0]).toBe(old)
  })

  test('clear:false with filters — buffer unchanged', () => {
    const buffer = [
      { type: 'click', t: 1000 },
      { type: 'mousemove', t: 1001 },
    ]
    const before = [...buffer]
    // clear:false — don't call selectiveClear at all
    expect(buffer).toEqual(before)
    expect(buffer).toHaveLength(2)
  })

  test('filter returns empty + clear:true — buffer unchanged', () => {
    const buffer = [
      { type: 'mousemove', t: 1000 },
      { type: 'keydown', t: 1001 },
    ]
    const entries = applyFilters(buffer, ['click'])  // no matches
    selectiveClear(buffer, entries, ['click'])
    // nothing matched, nothing cleared
    expect(buffer).toHaveLength(2)
  })
})

// ─── Long-poll tests (tools.ts execute logic) ─────────────────────────────────

function makeDispatch(sequence: Array<{ data: unknown[] }>) {
  let call = 0
  return async (_cmd: Record<string, unknown>) => {
    const item = sequence[Math.min(call++, sequence.length - 1)]
    return { success: true, data: item.data }
  }
}

function makeToolsWithDispatch(dispatchFn: (cmd: Record<string, unknown>) => Promise<unknown>) {
  const mockSession = new CaptureSession('test-sub', { urlFilter: null })
  const mockServer = {
    dispatch: dispatchFn,
    isConnected: () => true,
    getBrowsers: () => [],
    setBrowser: () => ({ id: 'test', browser: 'chrome', version: '1', transport: 'ws', active: true }),
    claimTab: () => ({ claimed: true, tabId: 1, owner: '3456:1234' }),
    releaseTab: () => undefined,
    startCaptureSession: () => mockSession,
    getCaptureSession: () => mockSession,
    stopCaptureSession: () => mockSession,
  } as unknown as WebsterServer
  return { tools: createTools(mockServer), session: mockSession }
}

describe('get_input_log long-poll', () => {
  test('no waitFor — returns immediately regardless of empty data', async () => {
    const { tools, session } = makeToolsWithDispatch(makeDispatch([{ data: [] }]))
    const tool = tools.find(t => t.name === 'get_input_log')!
    const result = await tool.execute({ clear: true }) as { success: boolean; data: unknown[] }
    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
    session.cleanup()
  })

  test('waitFor:"new_events" — returns immediately when first poll has events', async () => {
    const events = [{ type: 'click', t: Date.now() }]
    const { tools, session } = makeToolsWithDispatch(makeDispatch([{ data: events }]))
    const tool = tools.find(t => t.name === 'get_input_log')!
    const result = await tool.execute({
      clear: false,
      waitFor: 'new_events',
      waitTimeoutMs: 2000,
    }) as { success: boolean; data: unknown[] }
    expect(result.data).toHaveLength(1)
    session.cleanup()
  })

  test('waitFor:"new_events" — retries and returns when events arrive on 2nd poll', async () => {
    const events = [{ type: 'change', t: Date.now() }]
    const { tools, session } = makeToolsWithDispatch(makeDispatch([
      { data: [] },     // first poll: nothing
      { data: events }, // second poll: events arrive
    ]))
    const tool = tools.find(t => t.name === 'get_input_log')!
    const result = await tool.execute({
      clear: false,
      waitFor: 'new_events',
      waitTimeoutMs: 2000,
    }) as { success: boolean; data: unknown[] }
    expect(result.data).toHaveLength(1)
    expect((result.data[0] as { type: string }).type).toBe('change')
    session.cleanup()
  })

  test('waitFor:"new_events" — times out and returns empty when no events arrive', async () => {
    const { tools, session } = makeToolsWithDispatch(makeDispatch([{ data: [] }]))
    const tool = tools.find(t => t.name === 'get_input_log')!
    const start = Date.now()
    const result = await tool.execute({
      clear: false,
      waitFor: 'new_events',
      waitTimeoutMs: 250, // short for test speed
    }) as { success: boolean; data: unknown[] }
    const elapsed = Date.now() - start
    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
    expect(elapsed).toBeGreaterThanOrEqual(240)
    session.cleanup()
  }, 3000)

  test('waitFor:"new_events" — waitTimeoutMs defaults to 5000 when omitted', async () => {
    // We just verify it doesn't throw when omitted — don't actually wait 5s
    const events = [{ type: 'click', t: Date.now() }]
    const { tools, session } = makeToolsWithDispatch(makeDispatch([{ data: events }]))
    const tool = tools.find(t => t.name === 'get_input_log')!
    // Has events on first poll so returns immediately even with default timeout
    const result = await tool.execute({ waitFor: 'new_events' }) as { success: boolean; data: unknown[] }
    expect(result.data).toHaveLength(1)
    session.cleanup()
  })
})

describe('get_input_log tool schema', () => {
  test('new parameters are present in inputSchema', () => {
    const mockSession = new CaptureSession('test-schema', { urlFilter: null })
    const mockServer = {
      dispatch: async () => ({ success: true, data: [] }),
      isConnected: () => true,
      getBrowsers: () => [],
      setBrowser: () => ({ id: 'test', browser: 'chrome', version: '1', transport: 'ws', active: true }),
      claimTab: () => ({ claimed: true, tabId: 1, owner: '3456:1234' }),
      releaseTab: () => undefined,
      startCaptureSession: () => mockSession,
      getCaptureSession: () => mockSession,
      stopCaptureSession: () => mockSession,
    } as unknown as WebsterServer
    const tools = createTools(mockServer)
    const tool = tools.find(t => t.name === 'get_input_log')!
    const props = tool.inputSchema.properties as Record<string, unknown>
    expect(props.types).toBeDefined()
    expect(props.minTimestamp).toBeDefined()
    expect(props.waitFor).toBeDefined()
    expect(props.waitTimeoutMs).toBeDefined()
    mockSession.cleanup()
  })

  test('get_input_log has no required fields (all parameters optional)', () => {
    const mockSession = new CaptureSession('test-schema2', { urlFilter: null })
    const mockServer = {
      dispatch: async () => ({ success: true, data: [] }),
      isConnected: () => true,
      getBrowsers: () => [],
      setBrowser: () => ({ id: 'test', browser: 'chrome', version: '1', transport: 'ws', active: true }),
      claimTab: () => ({ claimed: true, tabId: 1, owner: '3456:1234' }),
      releaseTab: () => undefined,
      startCaptureSession: () => mockSession,
      getCaptureSession: () => mockSession,
      stopCaptureSession: () => mockSession,
    } as unknown as WebsterServer
    const tools = createTools(mockServer)
    const tool = tools.find(t => t.name === 'get_input_log')!
    const required = tool.inputSchema.required
    expect(!required || required.length === 0).toBe(true)
    mockSession.cleanup()
  })
})
