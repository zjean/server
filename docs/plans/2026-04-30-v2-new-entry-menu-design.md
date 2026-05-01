# v2 unified `+ New` entry menu — design

**Date:** 2026-04-30
**Scope:** v2 custom UI only (`frontend/src/app/applications/custom-v2/`). Classic Angular UI is not touched.

## Problem

Today the v2 toolbars expose creation actions as a row of standalone buttons:

| Screen | Toolbar buttons today | Mobile FAB sheet |
|---|---|---|
| Personal (`/v2/personal`) | New folder, New text file | New folder, New text file, Download from URL, Upload |
| Space files (`/v2/spaces/<space>/...`) | **New folder only** | (no FAB) |

Two problems:

1. The two-button toolbar will not scale once we add OnlyOffice document creation — three more buttons (`Document`, `Spreadsheet`, `Presentation`) would crowd the bar and bury the actions visually.
2. Space-files lacks "New text file" — an unintentional asymmetry with personal.

## Goal

Replace the existing toolbar buttons in both screens with a single `+ New` button that opens a dropdown. When OnlyOffice is enabled (`store.server().fileEditors.onlyoffice === true`), the dropdown also offers `Document` (`.docx`), `Spreadsheet` (`.xlsx`), and `Presentation` (`.pptx`). Selecting an office type creates an auto-named `Untitled.<ext>` (deduped against the current directory) and opens the file in the v2 OnlyOffice preview overlay — no filename prompt up front; the user renames inside OnlyOffice if they want.

## Non-goals

- No backend changes. The existing `POST /api/files/operation/make/<dir>/<name>` endpoint already populates `.docx/.xlsx/.pptx` from the bundled sample templates (`backend/src/applications/files/services/files-manager.service.ts:281` `mkFile`, samples at `backend/src/applications/files/assets/samples/sample.{docx,xlsx,pptx,...}`).
- No changes to classic UI screens.
- No support for `.odt/.ods/.odp/.rtf` document creation. OnlyOffice still opens those when uploaded; we just don't promote them as a creation path.
- No filename prompt for office files. The user renames inside OnlyOffice if they want; otherwise `Untitled.docx` is fine.
- No subscribe-to-server-config-changes. The OnlyOffice flag is read from `StoreService` at render time; if an admin toggles it mid-session, the user sees stale state until next page load.

## UX

The dropdown, in order:

```
+ New ▾
 ├─ Document          (docx)      ← only if OO enabled
 ├─ Spreadsheet       (xlsx)      ← only if OO enabled
 ├─ Presentation      (pptx)      ← only if OO enabled
 ├─ ──────────                    ← only if OO enabled
 ├─ Folder
 └─ Text file
```

Office types come first because they are the headline actions; folder and text are the always-available primitives.

### Per-action behaviour

| Action | Flow |
|---|---|
| `Document` / `Spreadsheet` / `Presentation` | Compute unique name `Untitled.<ext>` → `filesService.make('file', name, dirPath, true)` → on success: `toast.success('"<name>" created')`, fire-and-forget `refresh()`, `previewOverlay.open(fullPath)` (overlay loads its own metadata, mounts `OfficeViewComponent`). |
| `Folder` | Existing `newFolder()` — prompt for name, create, refresh. Unchanged. |
| `Text file` | Existing `newTextFile()` — prompt with `Untitled.txt` default, create, refresh. Unchanged. |

### Filename collision

Client-side dedupe against the current `files()` signal:

```ts
private uniqueName(stem: string, ext: string): string {
  const taken = new Set(this.files().map(f => f.name.toLowerCase()))
  const base = `${stem}.${ext}`
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i}).${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${stem}-${Date.now()}.${ext}`
}
```

If a cross-tab race causes a 409 anyway, the toast surfaces it and no overlay opens.

## Implementation

### File map

**New file:**

- `custom-v2/screens/files/new-entry-menu.ts` — pure module, no Angular. Exports `buildNewEntryMenu({ onlyOfficeEnabled, onSelect })` returning `ContextMenuItem[]` and the `NewEntryId` type. Reused by every callsite.

**Modified files:**

- `custom-v2/components/context-menu.component.ts` — add `kind: 'divider'` rendering branch (renders `<div class="ctx-menu__divider" />`, no button).
- `custom-v2/components/action-sheet.component.ts` — same divider addition.
- `custom-v2/screens/personal/personal.component.{ts,html}` — replace the two toolbar buttons with one `+ New` button + `app-v2-context-menu`. Replace `fabSheetItems` constant with a `computed()` that reuses `buildNewEntryMenu`. Add `newOfficeFile(ext)` private method. Extend `onFabSheetSelect` switch with three new cases.
- `custom-v2/screens/space/space-files.component.{ts,html}` — same toolbar replacement. Port `newTextFile()` from personal (currently missing here). Add `newOfficeFile(ext)` private method.

**Shared resource (additive only):**

- `frontend/src/i18n/en.json`, `frontend/src/i18n/nl.json` — add keys: `New`, `Document`, `Spreadsheet`, `Presentation`. Existing keys (`Folder`, `Text file`, `"<name>" created`) remain unchanged.

**Untouched:**

- `OfficeViewComponent`, `previewOverlay.service`, `filesService.make` — reused as-is.
- Backend.
- Classic Angular `/files` screens.

### Shared menu spec

```ts
// custom-v2/screens/files/new-entry-menu.ts
import type { ContextMenuItem } from '../../components/context-menu.component'

export type NewEntryId =
  | 'new-docx' | 'new-xlsx' | 'new-pptx'
  | 'new-folder' | 'new-text'

export function buildNewEntryMenu(opts: {
  onlyOfficeEnabled: boolean
  onSelect: (id: NewEntryId) => void
}): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  if (opts.onlyOfficeEnabled) {
    items.push(
      { id: 'new-docx', label: 'Document',     icon: 'file-text', action: () => opts.onSelect('new-docx') },
      { id: 'new-xlsx', label: 'Spreadsheet',  icon: 'sheet',     action: () => opts.onSelect('new-xlsx') },
      { id: 'new-pptx', label: 'Presentation', icon: 'slides',    action: () => opts.onSelect('new-pptx') },
      { id: 'sep-1',    kind: 'divider' } as ContextMenuItem,
    )
  }
  items.push(
    { id: 'new-folder', label: 'Folder',    icon: 'folder', action: () => opts.onSelect('new-folder') },
    { id: 'new-text',   label: 'Text file', icon: 'pencil', action: () => opts.onSelect('new-text')   },
  )
  return items
}
```

Icon names (`'file-text'`, `'sheet'`, `'slides'`) are placeholders — pick from the existing `IconV2Name` set during implementation; if a sheet/slide glyph is missing, fall back to a generic `'file'` for those entries (label conveys the type either way).

### Per-screen wiring

```ts
// state
protected readonly newMenuOpen = signal(false)
protected readonly newMenuAnchor = signal<ContextMenuAnchor | null>(null)
protected readonly newMenuItems = computed(() => buildNewEntryMenu({
  onlyOfficeEnabled: this.store.server().fileEditors.onlyoffice,
  onSelect: id => this.dispatchNewEntry(id),
}))

// click handler
protected onNewMenuClick(btn: HTMLElement): void {
  const r = btn.getBoundingClientRect()
  this.newMenuAnchor.set({ x: r.left, y: r.bottom + 4 })
  this.newMenuOpen.set(true)
}

// dispatch
private dispatchNewEntry(id: NewEntryId): void {
  this.newMenuOpen.set(false)
  switch (id) {
    case 'new-folder': this.newFolder(); return
    case 'new-text':   this.newTextFile(); return
    case 'new-docx':   this.newOfficeFile('docx'); return
    case 'new-xlsx':   this.newOfficeFile('xlsx'); return
    case 'new-pptx':   this.newOfficeFile('pptx'); return
  }
}

private async newOfficeFile(ext: 'docx' | 'xlsx' | 'pptx'): Promise<void> {
  const dirPath = this.currentUploadRoute()
  const name = this.uniqueName('Untitled', ext)
  const fullPath = `${dirPath}/${name}`

  this.filesService.make('file', name, dirPath, true).subscribe({
    next: () => {
      this.toast.success(`"${name}" created`)
      this.refresh()
      this.previewOverlay.open(fullPath)
    },
    error: (e: HttpErrorResponse) => {
      this.toast.error(e.error?.message ?? 'File creation failed')
    },
  })
}
```

### i18n

Keys added to `en.json` and `nl.json`:

| Key | en | nl |
|---|---|---|
| `New` | New | Nieuw |
| `Document` | Document | Document |
| `Spreadsheet` | Spreadsheet | Spreadsheet |
| `Presentation` | Presentation | Presentatie |

`Folder`, `Text file`, and `"<name>" created` toast string are already present.

## Risks

1. **Sample template missing at runtime.** Backend `mkFile` copies `assets/samples/sample.<ext>` for known office extensions. Assets are verified present in this repo. If a future deployment strips them, the user sees a 500 toast on creation — handled, no overlay opens.
2. **OnlyOffice flag staleness.** Loaded once at session start. If an admin toggles OO off mid-session, the dropdown still shows the office options; selecting one fails with a 404 from `/only-office/settings`. Session refresh fixes it. Out of scope.
3. **Filename uniqueness race.** Local dedupe against `files()` plus a 409 toast fallback on the server side. One wasted click in the worst case.

## Verification (manual, post-implementation)

- OnlyOffice enabled, Personal: `+ New` shows 5 items + 1 divider; clicking Document creates `Untitled.docx` and opens the OO editor inline; closing the overlay reveals the new row.
- Same on Space files.
- OnlyOffice disabled: `+ New` shows 2 items (Folder, Text file), no divider.
- Personal mobile FAB: same items as desktop dropdown.
- Creating a second `Untitled.docx` while the first exists in the same dir produces `Untitled (2).docx`.
- All keys translate in both `en` and `nl`.

## Out of scope (future)

- ODF (`.odt/.ods/.odp`) creation.
- Per-user "default doc format" preference.
- Subscribe-to-server-config so OnlyOffice toggle takes effect mid-session.
