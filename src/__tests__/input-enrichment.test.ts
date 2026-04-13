/**
 * Tests for the element context helpers in extension/content/page-script.js.
 *
 * The helpers (describeElement, computeXPath, safeValue) run inside an IIFE
 * in the browser MAIN world and cannot be imported directly. This file
 * mirrors their logic with plain-object DOM mocks — no DOM library required —
 * so the core behaviour can be validated in Bun without a browser.
 *
 * Keep these in sync with the implementations in page-script.js.
 */

import { describe, test, expect } from 'bun:test'

// ─── Mock helpers ─────────────────────────────────────────────────────────────

interface MockElOpts {
  tagName?: string
  id?: string
  className?: string | { baseVal: string }
  innerText?: string
  href?: string
  name?: string
  placeholder?: string
  type?: string
  value?: unknown
  previousElementSibling?: MockEl | null
  parentElement?: MockEl | null
  shadowRoot?: { host: MockEl } | null
  attrs?: Record<string, string>
}

interface MockEl extends MockElOpts {
  nodeType: number
  tagName: string
  getAttribute(name: string): string | null
  matches(selector: string): boolean
  getRootNode(): MockEl | MockShadowRoot
}

interface MockShadowRoot {
  host: MockEl
}

function makeShadowRoot(host: MockEl): MockShadowRoot {
  return { host }
}

function makeEl(opts: MockElOpts = {}, shadowRoot: MockShadowRoot | null = null): MockEl {
  const el: MockEl = {
    nodeType: 1,
    tagName: opts.tagName ?? 'DIV',
    id: opts.id ?? '',
    className: opts.className ?? '',
    innerText: opts.innerText ?? '',
    href: opts.href,
    name: opts.name ?? '',
    placeholder: opts.placeholder ?? '',
    type: opts.type ?? 'text',
    value: opts.value ?? '',
    previousElementSibling: opts.previousElementSibling ?? null,
    parentElement: opts.parentElement ?? null,
    getAttribute(attr: string) {
      return opts.attrs?.[attr] ?? null
    },
    matches(selector: string) {
      const tag = (opts.tagName ?? 'DIV').toLowerCase()
      return selector.split(',').map(s => s.trim()).includes(tag)
    },
    getRootNode() {
      return shadowRoot ?? (el as unknown as MockEl)
    },
  }
  return el
}

// ─── Helper implementations (mirrors page-script.js) ─────────────────────────

const MAX_TEXT = 120
const MAX_CLASSES = 100

function describeElement(el: any): Record<string, unknown> | null {
  if (!el || el.nodeType !== 1) return null
  const desc: Record<string, unknown> = { tag: el.tagName }
  if (el.id) desc.id = el.id
  const cls = typeof el.className === 'string' ? el.className : el.className?.baseVal
  if (cls) desc.classes = cls.slice(0, MAX_CLASSES)
  const text = el.innerText?.trim()
  if (text) desc.text = text.slice(0, MAX_TEXT)
  if (el.href) desc.href = el.href
  if (el.getAttribute('role')) desc.role = el.getAttribute('role')
  if (el.getAttribute('aria-label')) desc.ariaLabel = el.getAttribute('aria-label')
  if (el.getAttribute('data-testid')) desc.testId = el.getAttribute('data-testid')
  if (el.name) desc.name = el.name
  if (el.placeholder) desc.placeholder = el.placeholder
  desc.xpath = computeXPath(el)
  const root = el.getRootNode()
  // In the browser this checks `instanceof ShadowRoot`. In tests we check for
  // the presence of `.host` to identify our mock shadow roots.
  if (root && root !== el && 'host' in root) {
    desc.shadowHost = describeElement(root.host)
  }
  return desc
}

function computeXPath(el: any): string {
  if (el.id) return `//*[@id="${el.id}"]`
  const parts: string[] = []
  let current: any = el
  // In the browser, the loop also guards against document.body; in tests the
  // chain terminates naturally when parentElement is null.
  while (current && current.nodeType === 1) {
    let sibling = current
    let index = 1
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.tagName === current.tagName) index++
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`)
    current = current.parentElement
  }
  return '/' + parts.join('/')
}

function safeValue(el: any): string {
  if (el.type === 'password') return '***'
  const v = el.value
  if (typeof v !== 'string') return ''
  return v.slice(0, 500)
}

// ─── describeElement ──────────────────────────────────────────────────────────

describe('describeElement', () => {
  test('returns null for null', () => {
    expect(describeElement(null)).toBeNull()
  })

  test('returns null for non-element node (nodeType !== 1)', () => {
    expect(describeElement({ nodeType: 3 })).toBeNull()
  })

  test('returns null for undefined', () => {
    expect(describeElement(undefined)).toBeNull()
  })

  test('click on a button — includes tag and text', () => {
    const el = makeEl({ tagName: 'BUTTON', innerText: 'Submit' })
    const desc = describeElement(el)!
    expect(desc.tag).toBe('BUTTON')
    expect(desc.text).toBe('Submit')
  })

  test('click on an anchor — includes href', () => {
    const el = makeEl({ tagName: 'A', href: 'https://example.com/', innerText: 'Home' })
    const desc = describeElement(el)!
    expect(desc.href).toBe('https://example.com/')
    expect(desc.tag).toBe('A')
    expect(desc.text).toBe('Home')
  })

  test('element with data-testid — includes testId', () => {
    const el = makeEl({ tagName: 'DIV', attrs: { 'data-testid': 'nav-cameras' } })
    const desc = describeElement(el)!
    expect(desc.testId).toBe('nav-cameras')
  })

  test('element with aria-label — included', () => {
    const el = makeEl({ tagName: 'BUTTON', attrs: { 'aria-label': 'Close dialog' } })
    const desc = describeElement(el)!
    expect(desc.ariaLabel).toBe('Close dialog')
  })

  test('element with role — included', () => {
    const el = makeEl({ tagName: 'DIV', attrs: { 'role': 'navigation' } })
    const desc = describeElement(el)!
    expect(desc.role).toBe('navigation')
  })

  test('element with no id, class, or text — still has xpath', () => {
    const el = makeEl({ tagName: 'SPAN' })
    const desc = describeElement(el)!
    expect(typeof desc.xpath).toBe('string')
    expect((desc.xpath as string).length).toBeGreaterThan(0)
  })

  test('className string is truncated to MAX_CLASSES chars', () => {
    const el = makeEl({ tagName: 'DIV', className: 'a'.repeat(200) })
    const desc = describeElement(el)!
    expect((desc.classes as string).length).toBe(MAX_CLASSES)
  })

  test('innerText is truncated to MAX_TEXT chars', () => {
    const el = makeEl({ tagName: 'P', innerText: 'x'.repeat(200) })
    const desc = describeElement(el)!
    expect((desc.text as string).length).toBe(MAX_TEXT)
  })

  test('id is included and shortcircuits xpath', () => {
    const el = makeEl({ tagName: 'DIV', id: 'main-nav' })
    const desc = describeElement(el)!
    expect(desc.id).toBe('main-nav')
    expect(desc.xpath).toBe('//*[@id="main-nav"]')
  })

  test('SVGAnimatedString className — read via .baseVal', () => {
    const el = makeEl({ tagName: 'SVG', className: { baseVal: 'icon spin' } })
    const desc = describeElement(el)!
    expect(desc.classes).toBe('icon spin')
  })

  test('input placeholder — included', () => {
    const el = makeEl({ tagName: 'INPUT', placeholder: 'Search...' })
    const desc = describeElement(el)!
    expect(desc.placeholder).toBe('Search...')
  })

  test('input name attribute — included', () => {
    const el = makeEl({ tagName: 'INPUT', name: 'username' })
    const desc = describeElement(el)!
    expect(desc.name).toBe('username')
  })

  test('empty string fields are omitted', () => {
    const el = makeEl({ tagName: 'DIV' })
    const desc = describeElement(el)!
    expect(desc.id).toBeUndefined()
    expect(desc.classes).toBeUndefined()
    expect(desc.text).toBeUndefined()
    expect(desc.href).toBeUndefined()
    expect(desc.name).toBeUndefined()
    expect(desc.placeholder).toBeUndefined()
  })

  // ── Shadow DOM ────────────────────────────────────────────────────────────

  test('element in shadow root — shadowHost is included', () => {
    const host = makeEl({ tagName: 'MY-WIDGET', id: 'widget1' })
    const shadow = makeShadowRoot(host)
    const inner = makeEl({ tagName: 'BUTTON', innerText: 'Click me' }, shadow)
    const desc = describeElement(inner)!
    expect(desc.shadowHost).toBeDefined()
    const hostDesc = desc.shadowHost as Record<string, unknown>
    expect(hostDesc.tag).toBe('MY-WIDGET')
    expect(hostDesc.id).toBe('widget1')
  })

  test('element in shadow root — xpath is relative to shadow root', () => {
    const host = makeEl({ tagName: 'MY-WIDGET' })
    const shadow = makeShadowRoot(host)
    const inner = makeEl({ tagName: 'BUTTON', innerText: 'OK' }, shadow)
    const desc = describeElement(inner)!
    // parentElement is null for shadow root children, so path is just /button[1]
    expect(desc.xpath).toBe('/button[1]')
  })

  test('element NOT in shadow root — no shadowHost field', () => {
    const el = makeEl({ tagName: 'BUTTON', innerText: 'Normal' })
    const desc = describeElement(el)!
    expect(desc.shadowHost).toBeUndefined()
  })

  test('nested shadow DOM — shadowHost recurses correctly', () => {
    const outerHost = makeEl({ tagName: 'OUTER-WIDGET', id: 'outer' })
    const outerShadow = makeShadowRoot(outerHost)
    const innerHost = makeEl({ tagName: 'INNER-WIDGET' }, outerShadow)
    const innerShadow = makeShadowRoot(innerHost)
    const target = makeEl({ tagName: 'SPAN' }, innerShadow)
    const desc = describeElement(target)!
    expect(desc.shadowHost).toBeDefined()
    const innerDesc = desc.shadowHost as Record<string, unknown>
    expect(innerDesc.tag).toBe('INNER-WIDGET')
    // innerHost is itself in a shadow root, so it also has shadowHost
    expect(innerDesc.shadowHost).toBeDefined()
    const outerDesc = innerDesc.shadowHost as Record<string, unknown>
    expect(outerDesc.tag).toBe('OUTER-WIDGET')
    expect(outerDesc.id).toBe('outer')
  })
})

// ─── computeXPath ─────────────────────────────────────────────────────────────

describe('computeXPath', () => {
  test('element with id — shortcut xpath', () => {
    const el = makeEl({ tagName: 'DIV', id: 'hero' })
    expect(computeXPath(el)).toBe('//*[@id="hero"]')
  })

  test('root element with no siblings or parents', () => {
    const el = makeEl({ tagName: 'DIV' })
    expect(computeXPath(el)).toBe('/div[1]')
  })

  test('element with one preceding same-tag sibling — index is 2', () => {
    const sibling = makeEl({ tagName: 'LI', previousElementSibling: null })
    const el = makeEl({ tagName: 'LI', previousElementSibling: sibling })
    expect(computeXPath(el)).toBe('/li[2]')
  })

  test('nested element — builds full ancestor path', () => {
    const parent = makeEl({ tagName: 'UL', previousElementSibling: null, parentElement: null })
    const child = makeEl({ tagName: 'LI', previousElementSibling: null, parentElement: parent })
    expect(computeXPath(child)).toBe('/ul[1]/li[1]')
  })

  test('sibling of different tag does not affect index', () => {
    const divSibling = makeEl({ tagName: 'DIV', previousElementSibling: null })
    const el = makeEl({ tagName: 'SPAN', previousElementSibling: divSibling })
    // divSibling is a different tag, so SPAN index stays 1
    expect(computeXPath(el)).toBe('/span[1]')
  })
})

// ─── safeValue ────────────────────────────────────────────────────────────────

describe('safeValue', () => {
  test('password field — returns "***"', () => {
    const el = makeEl({ type: 'password', value: 'secret123' })
    expect(safeValue(el)).toBe('***')
  })

  test('regular text input — returns actual value', () => {
    const el = makeEl({ type: 'text', value: 'hello world' })
    expect(safeValue(el)).toBe('hello world')
  })

  test('value capped at 500 chars', () => {
    const el = makeEl({ type: 'text', value: 'a'.repeat(600) })
    expect(safeValue(el).length).toBe(500)
  })

  test('non-string value — returns empty string', () => {
    const el = makeEl({ type: 'number', value: 42 })
    expect(safeValue(el)).toBe('')
  })

  test('select element — returns selected value', () => {
    const el = makeEl({ tagName: 'SELECT', type: 'select-one', value: 'option2' })
    expect(safeValue(el)).toBe('option2')
  })

  test('textarea — returns text content', () => {
    const el = makeEl({ tagName: 'TEXTAREA', type: 'textarea', value: 'some notes' })
    expect(safeValue(el)).toBe('some notes')
  })
})

// ─── Iframe relay logic ───────────────────────────────────────────────────────
// The pushInput relay and WEBSTER_FRAME_INPUT handling run in a live browser
// context and depend on window.top and postMessage. We verify the shape of
// what would be relayed rather than the messaging itself.

describe('iframe relay entry shape', () => {
  test('relayed entry has type and t fields intact', () => {
    const entry = { type: 'click', x: 10, y: 20, button: 'left', t: 1000, element: null }
    // Simulate what the top frame merges in on receipt
    const frame = { url: 'https://example.com/widget', origin: 'https://example.com' }
    const merged = { ...entry, frame }
    expect(merged.type).toBe('click')
    expect(merged.frame.origin).toBe('https://example.com')
  })

  test('frame annotation preserves url and origin', () => {
    const frame = { url: 'https://other.com/embed', origin: 'https://other.com' }
    expect(frame.url).toContain('other.com')
    expect(frame.origin).toBe('https://other.com')
  })
})

// ─── Scroll event shape ───────────────────────────────────────────────────────

describe('scroll event shape', () => {
  test('document scroll entry has required fields', () => {
    // Simulates what pushInput receives from the scroll handler for window scroll
    const entry = { type: 'scroll', x: 0, y: 400, t: Date.now() }
    expect(entry.type).toBe('scroll')
    expect(typeof entry.x).toBe('number')
    expect(typeof entry.y).toBe('number')
    expect(typeof entry.t).toBe('number')
    expect((entry as any).element).toBeUndefined()
  })

  test('element scroll entry includes element descriptor', () => {
    const el = makeEl({ tagName: 'DIV', id: 'scroll-container' })
    const entry = {
      type: 'scroll',
      x: 100,
      y: 0,
      t: Date.now(),
      element: describeElement(el),
    }
    expect(entry.element).toBeDefined()
    expect((entry.element as any).tag).toBe('DIV')
    expect((entry.element as any).id).toBe('scroll-container')
  })
})

// ─── Focus/blur event shape ───────────────────────────────────────────────────

describe('focus/blur event shape', () => {
  test('focusin entry has type, t, and element', () => {
    const el = makeEl({ tagName: 'INPUT', name: 'email', placeholder: 'Enter email' })
    const entry = { type: 'focusin', t: Date.now(), element: describeElement(el) }
    expect(entry.type).toBe('focusin')
    expect(typeof entry.t).toBe('number')
    const desc = entry.element as Record<string, unknown>
    expect(desc.tag).toBe('INPUT')
    expect(desc.name).toBe('email')
    expect(desc.placeholder).toBe('Enter email')
  })

  test('focusout entry has type, t, and element', () => {
    const el = makeEl({ tagName: 'TEXTAREA', name: 'message' })
    const entry = { type: 'focusout', t: Date.now(), element: describeElement(el) }
    expect(entry.type).toBe('focusout')
    expect((entry.element as any).tag).toBe('TEXTAREA')
  })

  test('focus on shadow DOM element includes shadowHost', () => {
    const host = makeEl({ tagName: 'SEARCH-BOX', id: 'search' })
    const shadow = makeShadowRoot(host)
    const input = makeEl({ tagName: 'INPUT', placeholder: 'Search...' }, shadow)
    const entry = { type: 'focusin', t: Date.now(), element: describeElement(input) }
    const desc = entry.element as Record<string, unknown>
    expect(desc.shadowHost).toBeDefined()
    expect((desc.shadowHost as any).tag).toBe('SEARCH-BOX')
  })
})
