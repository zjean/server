import type { ActionSheetEntry } from '../../components/action-sheet.component'
import type { ContextMenuEntry } from '../../components/context-menu.component'

export type NewEntryId = 'new-docx' | 'new-xlsx' | 'new-pptx' | 'new-folder' | 'new-text' | 'new-markdown' | 'new-diagram' | 'new-download-url'

interface BuildOpts {
  onSelect: (id: NewEntryId) => void
}

// Builds the items for the desktop "+ New" dropdown. Folder leads (it's
// the only container type and matches every native file manager). The
// office trio comes next, then lightweight file types, then the
// non-creation Download-from-URL action. Office types are always shown
// even with OnlyOffice off — the file still gets created from the
// server-side sample template; the dispatcher just skips the auto-open.
export function buildNewEntryMenu(opts: BuildOpts): ContextMenuEntry[] {
  return [
    { id: 'new-folder', label: 'Folder', icon: 'folder', action: () => opts.onSelect('new-folder') },
    { id: 'sep-folder', kind: 'divider' },
    { id: 'new-docx', label: 'Document', icon: 'doc', action: () => opts.onSelect('new-docx') },
    { id: 'new-xlsx', label: 'Spreadsheet', icon: 'sheet', action: () => opts.onSelect('new-xlsx') },
    { id: 'new-pptx', label: 'Presentation', icon: 'deck', action: () => opts.onSelect('new-pptx') },
    { id: 'sep-office', kind: 'divider' },
    { id: 'new-text', label: 'Text file', icon: 'pencil', action: () => opts.onSelect('new-text') },
    { id: 'new-markdown', label: 'Markdown', icon: 'code', action: () => opts.onSelect('new-markdown') },
    { id: 'new-diagram', label: 'Diagram', icon: 'sparkle', action: () => opts.onSelect('new-diagram') },
    { id: 'sep-download', kind: 'divider' },
    { id: 'new-download-url', label: 'Download from URL', icon: 'globe', action: () => opts.onSelect('new-download-url') }
  ]
}

// Sheet-shaped variant for the mobile FAB. The action sheet emits a
// string id and the parent dispatches, so no inline action callback.
export function buildNewEntrySheetItems(): ActionSheetEntry[] {
  return [
    { id: 'new-folder', label: 'Folder', icon: 'folder' },
    { id: 'sep-folder', kind: 'divider' },
    { id: 'new-docx', label: 'Document', icon: 'doc' },
    { id: 'new-xlsx', label: 'Spreadsheet', icon: 'sheet' },
    { id: 'new-pptx', label: 'Presentation', icon: 'deck' },
    { id: 'sep-office', kind: 'divider' },
    { id: 'new-text', label: 'Text file', icon: 'pencil' },
    { id: 'new-markdown', label: 'Markdown', icon: 'code' },
    { id: 'new-diagram', label: 'Diagram', icon: 'sparkle' },
    { id: 'sep-download', kind: 'divider' },
    { id: 'new-download-url', label: 'Download from URL', icon: 'globe' }
  ]
}
