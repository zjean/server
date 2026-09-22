import { describe, expect, it } from 'vitest'
import { buildEditorSrc } from './diagram-embed'

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
