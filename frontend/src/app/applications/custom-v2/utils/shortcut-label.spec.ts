// How a modifier is spelled, and what the shortcut sheet lists.
//
// This exists because of a shipped bug in the same family: the file browser's filter printed
// "Ctrl F" on an Android phone, naming a key the device does not have (#443). The spelling
// of a hint is not cosmetic — it is a claim about the user's hardware, and it is wrong
// silently.

import { afterEach, describe, expect, it } from 'vitest'
import { modKey, shortcutGroups, withMod } from './shortcut-label'

const original = globalThis.navigator

function setPlatform(platform: string, userAgent = ''): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform, userAgent },
    configurable: true,
    writable: true
  })
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true, writable: true })
})

describe('modKey', () => {
  it('is ⌘ on a Mac', () => {
    setPlatform('MacIntel')
    expect(modKey()).toBe('⌘')
  })

  it('is ⌘ on an iPad, which reports its own platform', () => {
    setPlatform('iPad')
    expect(modKey()).toBe('⌘')
  })

  it('falls back to the user agent when the platform is empty', () => {
    // Some browsers have started emptying `navigator.platform`; the UA still says Mac.
    setPlatform('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    expect(modKey()).toBe('⌘')
  })

  it('is Ctrl everywhere else', () => {
    setPlatform('Win32')
    expect(modKey()).toBe('Ctrl')
    setPlatform('Linux x86_64')
    expect(modKey()).toBe('Ctrl')
  })
})

describe('withMod', () => {
  it('joins tight on a Mac and with a space elsewhere', () => {
    setPlatform('MacIntel')
    expect(withMod('F')).toBe('⌘F')
    setPlatform('Win32')
    // The space is what keeps "CtrlF" readable.
    expect(withMod('F')).toBe('Ctrl F')
  })
})

describe('shortcutGroups', () => {
  it('lists only shortcuts that are bound, and never an unbound palette', () => {
    setPlatform('Win32')
    const rows = shortcutGroups().flatMap((g) => g.rows)
    const keys = rows.map((r) => r.keys)

    // Every one of these is wired: the first four in LayoutV2Service / TopBarComponent, the
    // rest in FileBrowserBase.onWindowKeydown.
    expect(keys).toEqual(['Ctrl K', 'Ctrl B', 'Ctrl I', '?', 'N', 'U', 'Ctrl F', 'Ctrl A', 'Esc', 'F2', 'F', 'Ctrl ⇧S', '⌫'])
    // ⌘K focuses the search field; the plan's hint set calls it a command palette, which
    // does not exist. The label has to say what it does.
    expect(rows.find((r) => r.keys === 'Ctrl K')?.label).toBe('Search files')
  })

  it('re-reads the platform on every call', () => {
    setPlatform('MacIntel')
    expect(shortcutGroups()[0].rows[0].keys).toBe('⌘K')
    setPlatform('Win32')
    expect(shortcutGroups()[0].rows[0].keys).toBe('Ctrl K')
  })
})
