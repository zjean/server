import type { ActionSheetEntry } from '../../components/action-sheet.component'
import type { ContextMenuEntry } from '../../components/context-menu.component'

export type NewEntryId = 'new-docx' | 'new-xlsx' | 'new-pptx' | 'new-folder' | 'new-text'

interface BuildOpts {
  onlyOfficeEnabled: boolean
  onSelect: (id: NewEntryId) => void
}

// Builds the items for the desktop "+ New" dropdown. The OnlyOffice trio
// is omitted entirely when the editor isn't enabled — no greyed-out rows.
// Icons are placeholders (`pencil` is the closest existing IconV2Name to
// a doc glyph); swap when the icon set grows.
export function buildNewEntryMenu(opts: BuildOpts): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = []
  if (opts.onlyOfficeEnabled) {
    items.push(
      { id: 'new-docx', label: 'Document', icon: 'pencil', action: () => opts.onSelect('new-docx') },
      { id: 'new-xlsx', label: 'Spreadsheet', icon: 'pencil', action: () => opts.onSelect('new-xlsx') },
      { id: 'new-pptx', label: 'Presentation', icon: 'pencil', action: () => opts.onSelect('new-pptx') },
      { id: 'sep-office', kind: 'divider' }
    )
  }
  items.push(
    { id: 'new-folder', label: 'Folder', icon: 'folder', action: () => opts.onSelect('new-folder') },
    { id: 'new-text', label: 'Text file', icon: 'pencil', action: () => opts.onSelect('new-text') }
  )
  return items
}

// Sheet-shaped variant for the mobile FAB. The action sheet emits a
// string id and the parent dispatches, so no inline action callback.
export function buildNewEntrySheetItems(opts: { onlyOfficeEnabled: boolean }): ActionSheetEntry[] {
  const items: ActionSheetEntry[] = []
  if (opts.onlyOfficeEnabled) {
    items.push(
      { id: 'new-docx', label: 'Document', icon: 'pencil' },
      { id: 'new-xlsx', label: 'Spreadsheet', icon: 'pencil' },
      { id: 'new-pptx', label: 'Presentation', icon: 'pencil' },
      { id: 'sep-office', kind: 'divider' }
    )
  }
  items.push({ id: 'new-folder', label: 'Folder', icon: 'plus' }, { id: 'new-text', label: 'Text file', icon: 'pencil' })
  return items
}
