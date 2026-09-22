import { describe, expect, it } from 'vitest'
import {
  buildEditorSrc,
  buildPrintDocument,
  isAllowedExportDataUrl,
  isForbiddenSvgAttribute,
  isForbiddenSvgElement,
  printNonce
} from './diagram-embed'

describe('buildEditorSrc', () => {
  it('arms autosave and leaves the editor chrome in place for a writable file', () => {
    const src = buildEditorSrc('https://embed.diagrams.net', true)
    expect(src).toBe('https://embed.diagrams.net?embed=1&spin=1&proto=json&autosave=1&keepmodified=1&dark=1')
  })

  it('mounts the viewer and drops autosave for a read-only file', () => {
    const src = buildEditorSrc('https://embed.diagrams.net', false)
    expect(src).toBe('https://embed.diagrams.net?embed=1&spin=1&proto=json&chrome=0&keepmodified=1&dark=1')
  })

  it('keeps the two switches mutually exclusive', () => {
    // A URL carrying both would leave drawio editable while the host believes
    // it is showing a viewer — the exact shape of #497.
    for (const writable of [true, false]) {
      const src = buildEditorSrc('https://drawio.internal', writable)
      expect(src.includes('autosave=1') && src.includes('chrome=0')).toBe(false)
    }
  })

  it('preserves a self-hosted editor base URL verbatim', () => {
    expect(buildEditorSrc('https://drawio.internal/webapp', true)).toMatch(/^https:\/\/drawio\.internal\/webapp\?/)
  })
})

// #498. drawio hands the host an export payload over postMessage and the host
// feeds it to a same-origin sink. What is pinned below is the POLICY — which
// schemes, elements and attributes are refused. The DOM walk that applies it
// (DiagramViewComponent.sanitizeSvg) cannot be pinned here: these specs run in
// `environment: node`, which has no DOMParser.
describe('isAllowedExportDataUrl', () => {
  it.each([
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:application/pdf;base64,JVBERi0=',
    'data:text/plain;charset=utf-8,hello',
    'data:,bare'
  ])('accepts %s', (url) => {
    expect(isAllowedExportDataUrl(url)).toBe(true)
  })

  it.each([
    // The report's payload: an anchor click on this runs in our origin.
    'javascript:alert(origin)',
    '  javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'https://evil.example/exfil',
    'blob:https://evil.example/1234',
    'about:blank',
    ''
  ])('refuses %s', (url) => {
    expect(isAllowedExportDataUrl(url)).toBe(false)
  })

  // The payload is JSON.parse of a cross-origin message: TYPED, not validated.
  // A number is truthy, so it passed the caller's `if (!data.data) return`
  // guard and reached `value.trim()`, throwing a TypeError out of the
  // `window:message` handler.
  it.each([42, 0, true, null, undefined, {}, [], ['data:image/png;base64,x']])('refuses the non-string %s without throwing', (value) => {
    expect(() => isAllowedExportDataUrl(value as never)).not.toThrow()
    expect(isAllowedExportDataUrl(value as never)).toBe(false)
  })
})

describe('svg sanitiser policy', () => {
  it.each(['script', 'SCRIPT', 'iframe', 'object', 'embed', 'base', 'animate', 'set'])('drops <%s>', (tag) => {
    expect(isForbiddenSvgElement(tag)).toBe(true)
  })

  // A stylesheet is an execution surface the attribute scrub never looks at —
  // its CSS TEXT is a child node, not an attribute — and drawio's SVG export
  // does not need one (presentation is inlined as attributes).
  it.each(['style', 'STYLE'])('drops <%s>, whose text no attribute check inspects', (tag) => {
    expect(isForbiddenSvgElement(tag)).toBe(true)
  })

  it('keeps foreignObject — drawio draws HTML labels with it, and its subtree is scrubbed instead', () => {
    expect(isForbiddenSvgElement('foreignObject')).toBe(false)
    expect(isForbiddenSvgElement('g')).toBe(false)
    expect(isForbiddenSvgElement('text')).toBe(false)
    expect(isForbiddenSvgElement('img')).toBe(false)
  })

  it.each(['onerror', 'onload', 'onclick', 'ONMOUSEOVER', 'onanything'])('drops the %s attribute whatever its value', (name) => {
    expect(isForbiddenSvgAttribute(name, 'anything')).toBe(true)
  })

  it.each([
    ['href', 'javascript:alert(1)'],
    ['xlink:href', ' javascript:alert(1)'],
    ['href', 'JAVASCRIPT:alert(1)'],
    ['src', 'data:text/html,<script>alert(1)</script>'],
    ['action', 'vbscript:msgbox(1)']
  ])('drops %s when it carries %s', (name, value) => {
    expect(isForbiddenSvgAttribute(name, value)).toBe(true)
  })

  it.each([
    ['href', 'https://example.com/'],
    ['xlink:href', '#clip-3'],
    ['src', 'data:image/png;base64,iVBORw0KGgo='],
    ['fill', '#ff0000'],
    ['d', 'M0 0 L10 10'],
    ['transform', 'translate(4,4)']
  ])('keeps %s=%s', (name, value) => {
    expect(isForbiddenSvgAttribute(name, value)).toBe(false)
  })
})

describe('buildPrintDocument', () => {
  const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef'

  it('locks the popup down with a nonce’d CSP', () => {
    const html = buildPrintDocument('diagram', '<svg/>', NONCE)
    // about:blank inherits our origin AND our header CSP, which carries
    // 'unsafe-inline'. This second policy is what stops an injected inline
    // script from running there.
    expect(html).toContain(`script-src 'nonce-${NONCE}'`)
    expect(html).toContain(`object-src 'none'`)
  })

  it('denies by default and allows back only what a printed diagram needs', () => {
    const html = buildPrintDocument('diagram', '<svg/>', NONCE)
    const csp = /content="([^"]+)"/.exec(html)?.[1] ?? ''
    // `default-src 'none'` is what closes the off-origin stylesheet route — the
    // one thing a <style> smuggled in on the SVG could have reached for, and
    // the reason the element is dropped as well.
    expect(csp).toContain(`default-src 'none'`)
    expect(csp).toContain('img-src data: blob:')
    expect(csp).toContain(`style-src 'unsafe-inline'`)
    // No network fetch of any kind from a print document.
    expect(csp).not.toMatch(/connect-src|frame-src/)
  })

  it('carries the nonce on its own script and on no other', () => {
    const html = buildPrintDocument('diagram', '<svg><script>alert(1)</script></svg>', NONCE)
    const scriptTags = html.match(/<script[^>]*>/g) ?? []
    // Two: the injected one (left inert by the CSP) and the print harness.
    expect(scriptTags.filter((t) => t.includes(`nonce="${NONCE}"`))).toHaveLength(1)
  })

  it('escapes the document title', () => {
    const html = buildPrintDocument('</title><script>alert(1)</script>', '<svg/>', NONCE)
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('</title><script>')
  })

  it('still inlines the svg so the browser vectorises it at print DPI', () => {
    expect(buildPrintDocument('d', '<svg id="x"/>', NONCE)).toContain('<svg id="x"/>')
  })
})

describe('printNonce', () => {
  it('is long, hex and different every time', () => {
    const a = printNonce()
    const b = printNonce()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})
