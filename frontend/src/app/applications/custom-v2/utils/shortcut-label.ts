/**
 * `⌘` on a Mac, `Ctrl` everywhere else.
 *
 * One spelling, because the app prints modifiers in five places (the inspector's tooltip,
 * the filter's badge, the empty state's footer, the dialog footers' `esc`, and now the
 * shortcut sheet) and a hint that names a key the user does not have is worse than no hint
 * — the same reason the touch layout drops them entirely.
 *
 * `navigator.platform` is deprecated but it is still the only thing that reports the
 * KEYBOARD rather than the OS, and every browser we serve still sets it. The userAgent
 * fallback covers the case where it is empty.
 */
export function modKey(): '⌘' | 'Ctrl' {
  if (typeof navigator === 'undefined') return 'Ctrl'
  const platform = navigator.platform || ''
  const agent = navigator.userAgent || ''
  return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac/.test(agent) ? '⌘' : 'Ctrl'
}

/** `⌘F` on a Mac, `Ctrl F` elsewhere — the space is what keeps the second readable. */
export function withMod(key: string): string {
  const mod = modKey()
  return mod === '⌘' ? `⌘${key}` : `Ctrl ${key}`
}

export interface ShortcutRow {
  keys: string
  label: string
}

export interface ShortcutGroup {
  title: string
  rows: ShortcutRow[]
}

/**
 * Every shortcut this app actually binds, in the order the sheet lists them.
 *
 * Built at call time rather than as a constant because the modifier depends on the
 * platform. **Only bound shortcuts appear here** — the plan's hint set also names a `⌘K`
 * command palette, and `⌘K` does exist, but it focuses the top bar's search field rather
 * than opening a palette. It is listed as what it does.
 */
export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      title: 'Around the app',
      rows: [
        { keys: withMod('K'), label: 'Search files' },
        { keys: withMod('B'), label: 'Toggle the sidebar' },
        { keys: withMod('I'), label: 'Toggle the details panel' },
        { keys: '?', label: 'This list' }
      ]
    },
    {
      title: 'In a folder',
      rows: [
        { keys: 'N', label: 'New' },
        { keys: 'U', label: 'Upload' },
        { keys: withMod('F'), label: 'Filter' },
        { keys: withMod('A'), label: 'Select all' },
        { keys: 'Esc', label: 'Clear the selection' }
      ]
    },
    {
      title: 'With one file selected',
      rows: [
        { keys: 'F2', label: 'Rename' },
        { keys: 'F', label: 'Favorite' },
        { keys: withMod('⇧S'), label: 'Share' },
        { keys: '⌫', label: 'Move to trash' }
      ]
    }
  ]
}
