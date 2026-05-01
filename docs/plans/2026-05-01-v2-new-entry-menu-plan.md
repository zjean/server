# v2 unified `+ New` entry menu — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the v2 toolbar's "New folder" / "New text file" buttons (and add space-files parity) with a single `+ New` dropdown that also creates docx/xlsx/pptx files via OnlyOffice when enabled.

**Architecture:** Pure frontend change in `frontend/src/app/applications/custom-v2/`. One shared menu spec module, used by both screens; reuses the existing `app-v2-context-menu` and `app-v2-action-sheet` components (with a small divider addition). New office files are created via the existing `POST /api/files/operation/make/<dir>/<name>` endpoint (backend already populates docx/xlsx/pptx from bundled sample templates). After creation, the file opens in the existing v2 preview overlay (`OfficeViewComponent`).

**Tech stack:** Angular 19 (standalone components, signals), TypeScript, angular-l10n. No backend changes. No new dependencies.

**Reference design:** `docs/plans/2026-04-30-v2-new-entry-menu-design.md` (committed at `b518712`).

**Working branch:** `feat/v2-new-entry-menu` (already created).

## Testing approach — read first

The v2 screens have **no Jest fixtures** (verified: `find frontend/src/app/applications/custom-v2 -name "*.spec.ts"` returns zero results). Adding unit-test scaffolding for this feature alone is out of scope (YAGNI). Verification per task is:

1. **Type check / build** — `cd frontend && npx ng build --configuration development` (or the project's standard build script). Must succeed with zero errors.
2. **Manual smoke** — at the end (Task 8), run the dev server and walk through the verification matrix.

Each task below ends in a build check + commit; no per-task `npm test`.

## Conventions (from CLAUDE.md)

- Branch is `feat/v2-new-entry-menu`. Never push to `main` directly. PR comes after Task 8.
- Commit prefix `feat(v2): ...` for new code; `mod(v2): ...` only if an upstream file is touched (none here).
- i18n: `en.json` doesn't need new keys (key === English). New keys go to `nl.json` only.
- Use `git@github-prive:...` SSH alias for any future remote ops; not relevant during local task execution.
- `rtk` is the user's git/gh proxy. Ordinary `git status`, `git add`, `git commit`, `git diff` work unmodified. If a command fails for shape reasons, retry with `rtk proxy <cmd>`.

---

## Task 1: Add divider support to ContextMenuComponent

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/components/context-menu.component.ts`

The current `ContextMenuItem` interface requires `label` + `action`. The new menu has a visual separator between the OO doc actions and the folder/text actions. Approach: extend `ContextMenuItem` to allow a `kind: 'divider'` variant that renders a thin horizontal rule and skips the button.

**Step 1: Extend the interface**

Change `ContextMenuItem` (around line 5) from a single shape into a discriminated union, OR (preferred for minimum churn) add `kind?: 'default' | 'danger' | 'divider'` and make `label` + `action` optional when `kind === 'divider'`.

The cheapest correct change: keep the existing required fields, but add an explicit divider type alias and change the `items: ContextMenuItem[]` input to `items: (ContextMenuItem | ContextMenuDivider)[]`. Concrete edit:

```ts
// Replace the existing ContextMenuItem interface block with:
export interface ContextMenuItem {
  id: string
  label: string
  icon?: IconV2Name
  kind?: 'default' | 'danger'
  disabled?: boolean
  disabledReason?: string
  action: () => void
}

export interface ContextMenuDivider {
  id: string
  kind: 'divider'
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuDivider

function isDivider(e: ContextMenuEntry): e is ContextMenuDivider {
  return (e as ContextMenuDivider).kind === 'divider'
}
```

Update the `@Input()` to `items: ContextMenuEntry[] = []`.

**Step 2: Render divider branch in the template**

Inside the `@for (item of items; track item.id)` block, wrap the existing `<button>` with an `@if (!isDivider(item))` / `@else` and emit a divider element. Concrete:

```ts
// In the template literal, replace the current @for body with:
@for (item of items; track item.id) {
  @if (isDivider(item)) {
    <div class="ctx-menu__divider" role="separator" aria-orientation="horizontal"></div>
  } @else {
    <button
      type="button"
      role="menuitem"
      class="ctx-menu__item"
      [class.ctx-menu__item--danger]="item.kind === 'danger'"
      [disabled]="item.disabled"
      [attr.title]="item.disabled && item.disabledReason ? (item.disabledReason | translate: locale.language) : null"
      (click)="onItemClick($event, item)"
    >
      @if (item.icon) {
        <app-v2-icon [name]="item.icon" [size]="14" />
      } @else {
        <span class="ctx-menu__icon-spacer"></span>
      }
      <span class="ctx-menu__label">{{ item.label | translate: locale.language }}</span>
    </button>
  }
}
```

Expose `isDivider` to the template by assigning it as a `protected` class member: `protected readonly isDivider = isDivider`.

**Step 3: Adjust `onItemClick` signature**

It currently takes `ContextMenuItem`. That stays — divider rows have no click handler, so the type is still correct.

**Step 4: Update menu-height calculation**

In the `position` getter, `MENU_ITEM_HEIGHT * items.length` needs to subtract for dividers (which are shorter). Cheapest fix: count only non-divider entries for height computation, then add a fixed `9px * dividerCount` (`8px` divider + `1px` gap from the existing `gap: 1px` style — close enough, the menu auto-clamps to viewport). Replace the line:

```ts
const menuHeight = Math.max(this.items.length, 1) * MENU_ITEM_HEIGHT + MENU_PADDING
```

with:

```ts
const itemCount = this.items.filter(i => !isDivider(i)).length
const dividerCount = this.items.length - itemCount
const menuHeight = Math.max(itemCount, 1) * MENU_ITEM_HEIGHT + dividerCount * 9 + MENU_PADDING
```

**Step 5: Add divider styles**

In the `styles: [...]` block, append:

```css
.ctx-menu__divider {
  height: 1px;
  margin: 4px 6px;
  background: var(--si-line);
}
```

**Step 6: Build and verify**

Run: `cd frontend && npx ng build --configuration development`
Expected: build completes, no type errors.

**Step 7: Commit**

```bash
git add frontend/src/app/applications/custom-v2/components/context-menu.component.ts
git commit -m "feat(v2): add divider entry support to context menu"
```

---

## Task 2: Add divider support to ActionSheetComponent

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/components/action-sheet.component.ts`

Mirrors Task 1 for the mobile FAB sheet on the personal screen.

**Step 1: Extend the item type**

Replace the existing `ActionSheetItem` interface block with:

```ts
export interface ActionSheetItem {
  id: string
  label: string
  icon: IconV2Name
  kind?: 'default' | 'danger'
  disabled?: boolean
}

export interface ActionSheetDivider {
  id: string
  kind: 'divider'
}

export type ActionSheetEntry = ActionSheetItem | ActionSheetDivider

function isDivider(e: ActionSheetEntry): e is ActionSheetDivider {
  return (e as ActionSheetDivider).kind === 'divider'
}
```

Change the `@Input() items` type to `readonly ActionSheetEntry[] = []`.

**Step 2: Render divider in template**

Replace the `@for` body with:

```ts
@for (it of items; track it.id) {
  @if (isDivider(it)) {
    <li><div class="as__divider" role="separator" aria-orientation="horizontal"></div></li>
  } @else {
    <li>
      <button type="button" class="as__item" [class.as__item--danger]="it.kind === 'danger'" [disabled]="it.disabled" (click)="onPick(it)">
        <app-v2-icon [name]="it.icon" [size]="18" class="as__icon" />
        <span class="as__label">{{ it.label | translate: locale.language }}</span>
      </button>
    </li>
  }
}
```

Add `protected readonly isDivider = isDivider` on the class.

**Step 3: Tighten `onPick` signature**

`onPick(item: ActionSheetItem)` is correct and stays — dividers don't reach this handler.

**Step 4: Add divider styles**

In the `styles: [...]` block, append:

```css
.as__divider {
  height: 1px;
  margin: 6px 12px;
  background: var(--si-line);
}
```

**Step 5: Build and verify**

Run: `cd frontend && npx ng build --configuration development`
Expected: build succeeds.

**Step 6: Commit**

```bash
git add frontend/src/app/applications/custom-v2/components/action-sheet.component.ts
git commit -m "feat(v2): add divider entry support to action sheet"
```

---

## Task 3: Create the shared menu spec

**Files:**
- Create: `frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts`

Pure module — no Angular DI. Returns the ordered list of entries given the OnlyOffice flag and a select callback. The callbacks dispatch back to the screen's existing handlers via a single `onSelect(id)` switch.

**Step 1: Write the file**

```ts
// frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts
import type { ContextMenuEntry } from '../../components/context-menu.component'
import type { ActionSheetEntry } from '../../components/action-sheet.component'

export type NewEntryId =
  | 'new-docx'
  | 'new-xlsx'
  | 'new-pptx'
  | 'new-folder'
  | 'new-text'

interface BuildOpts {
  onlyOfficeEnabled: boolean
  onSelect: (id: NewEntryId) => void
}

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

// Same set, sheet-shaped (no inline action — sheet emits id, parent dispatches).
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
  items.push(
    { id: 'new-folder', label: 'Folder', icon: 'plus' },
    { id: 'new-text', label: 'Text file', icon: 'pencil' }
  )
  return items
}
```

**Note on icons:** `IconV2Name` doesn't yet ship word/sheet/slide glyphs (verified: only `'plus'`, `'pencil'`, `'folder'`, `'file'` and friends). Using `'pencil'` for office docs is the closest reasonable fallback. If a future `add-icons` task introduces dedicated glyphs, only this file changes.

**Step 2: Build and verify**

Run: `cd frontend && npx ng build --configuration development`
Expected: build succeeds. (No callsite yet, so this just type-checks the module in isolation.)

**Step 3: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts
git commit -m "feat(v2): add shared spec for the + New entry menu"
```

---

## Task 4: Add Dutch translations for new menu labels

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts` (no — translations live in i18n JSONs)
- Modify: `frontend/src/i18n/nl.json`

`en.json` does not need changes (English string IS the key). Other locales will fall through to the literal English until a future i18n sweep — same pattern as `Document name` (verified: only present in `nl.json`).

**Step 1: Add Dutch keys to nl.json**

Open `frontend/src/i18n/nl.json` and find a sensible position near the other "New …" keys (around line 348 where `New text file` lives). Add four new entries (preserving valid JSON — no trailing commas):

```json
"Document": "Document",
"Spreadsheet": "Spreadsheet",
"Presentation": "Presentatie",
"Text file": "Tekstbestand",
```

Note: `Folder` already exists at line 358 (`"Folder": "Map"`). `New` already exists at line 357 (`"New": "Nieuw"`). Don't duplicate.

**Step 2: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('frontend/src/i18n/nl.json', 'utf8')); console.log('ok')"`
Expected: prints `ok`.

**Step 3: Commit**

```bash
git add frontend/src/i18n/nl.json
git commit -m "feat(v2): add Dutch translations for + New menu labels"
```

---

## Task 5: Wire personal screen — desktop dropdown

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.html`

Replace the two old toolbar buttons with one `+ New` button + a context-menu. Add the office file creation handler. Leave the FAB sheet wiring for Task 6.

**Step 1: Add helper imports + state**

Open `personal.component.ts`. Near the top imports, add:

```ts
import { buildNewEntryMenu, buildNewEntrySheetItems, NewEntryId } from '../files/new-entry-menu'
import type { ContextMenuAnchor, ContextMenuEntry } from '../../components/context-menu.component'
import type { ActionSheetEntry } from '../../components/action-sheet.component'
```

Inside the class body (near the existing `fabSheetOpen` signal at line ~144), add:

```ts
protected readonly newMenuOpen = signal(false)
protected readonly newMenuAnchor = signal<ContextMenuAnchor | null>(null)
protected readonly newMenuItems = computed<ContextMenuEntry[]>(() =>
  buildNewEntryMenu({
    onlyOfficeEnabled: this.store.server().fileEditors.onlyoffice,
    onSelect: id => this.dispatchNewEntry(id),
  })
)
```

`computed` and `signal` should already be imported from `@angular/core`. Verify and add `computed` if missing.

The existing `fabSheetItems: readonly { id; label; icon }[]` at line ~145 will be replaced in Task 6.

**Step 2: Add handlers**

Add these methods on the class (near `newFolder()` / `newTextFile()` around lines 659–700):

```ts
protected onNewMenuClick(btn: HTMLElement): void {
  const r = btn.getBoundingClientRect()
  this.newMenuAnchor.set({ x: r.left, y: r.bottom + 4 })
  this.newMenuOpen.set(true)
}

private dispatchNewEntry(id: NewEntryId): void {
  this.newMenuOpen.set(false)
  switch (id) {
    case 'new-folder':
      this.newFolder()
      return
    case 'new-text':
      this.newTextFile()
      return
    case 'new-docx':
      this.newOfficeFile('docx')
      return
    case 'new-xlsx':
      this.newOfficeFile('xlsx')
      return
    case 'new-pptx':
      this.newOfficeFile('pptx')
      return
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

`HttpErrorResponse` is already imported in this file (verified at line ~1). `previewOverlay` is already injected.

**Step 3: Replace toolbar HTML**

Open `personal.component.html`. Find the `@else` branch starting at line ~36 (the non-selecting toolbar). Replace lines 37–38 (the two buttons) with one `+ New` button:

```html
<app-v2-btn
  #newBtn
  kind="primary"
  size="sm"
  icon="plus"
  (click)="onNewMenuClick(newBtn.host?.nativeElement ?? newBtnFallback)"
>
  {{ 'New' | translate: locale.language }}
</app-v2-btn>
```

The simpler approach if `app-v2-btn` doesn't expose `host`/`nativeElement`: wrap it in a `span` template ref:

```html
<span #newBtnAnchor class="personal__new-anchor">
  <app-v2-btn kind="primary" size="sm" icon="plus" (click)="onNewMenuClick(newBtnAnchor)">
    {{ 'New' | translate: locale.language }}
  </app-v2-btn>
</span>
```

Use the wrapper-span approach (it's robust to `app-v2-btn`'s component shape).

**Step 4: Add the menu element near the bottom of the template**

The existing `<app-v2-context-menu>` for row right-click sits around line ~250. Add a second instance for the toolbar dropdown directly above or below it (sibling), bound to the new state:

```html
<app-v2-context-menu
  [open]="newMenuOpen()"
  [anchor]="newMenuAnchor()"
  [items]="newMenuItems()"
  (closed)="newMenuOpen.set(false)"
/>
```

**Step 5: Add minimal styles for the wrapper span**

In `personal.component.html`'s adjacent SCSS file (or inline `styles: [...]` if applicable), the wrapper just needs `display: inline-flex` so it doesn't break the toolbar's flex row. Concretely, find the project's styles file for personal (search `frontend/src/app/applications/custom-v2/screens/personal/` for `personal.component.scss` or similar):

```bash
ls frontend/src/app/applications/custom-v2/screens/personal/
```

If a `.scss` exists, append:

```scss
.personal__new-anchor {
  display: inline-flex;
}
```

If styles are inline in the `.ts` file, add the same rule to its `styles: [...]` array.

**Step 6: Build and verify**

Run: `cd frontend && npx ng build --configuration development`
Expected: build succeeds with zero type errors.

**Step 7: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts \
        frontend/src/app/applications/custom-v2/screens/personal/personal.component.html \
        frontend/src/app/applications/custom-v2/screens/personal/personal.component.scss
git commit -m "feat(v2): replace personal toolbar buttons with + New dropdown"
```

(If the SCSS path doesn't exist, drop it from the `git add`.)

---

## Task 6: Wire personal screen — mobile FAB sheet

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.html` (only if the existing items binding needs adjustment)

The FAB sheet today binds `[items]="fabSheetItems"`. Convert that constant to a computed that uses `buildNewEntrySheetItems`, plus tack on the existing `Download from URL` and `Upload` items the FAB already has.

**Step 1: Replace `fabSheetItems`**

Find the existing block at lines ~144–149:

```ts
protected readonly fabSheetItems: readonly { id: string; label: string; icon: IconV2Name }[] = [
  { id: 'new-folder', label: 'New folder', icon: 'plus' },
  { id: 'new-text', label: 'New text file', icon: 'pencil' },
  ...
]
```

Replace with:

```ts
protected readonly fabSheetItems = computed<ActionSheetEntry[]>(() => [
  ...buildNewEntrySheetItems({
    onlyOfficeEnabled: this.store.server().fileEditors.onlyoffice,
  }),
  { id: 'sep-fab', kind: 'divider' },
  { id: 'download-url', label: 'Download from URL', icon: 'globe' },
  { id: 'upload', label: 'Upload', icon: 'upload' },
])
```

(Keep the `download-url` / `upload` icons matching whatever the existing constant used — adjust if the originals differ. Read the file before this edit.)

**Step 2: Update template binding**

If the template currently binds `[items]="fabSheetItems"` (signal not yet invoked), change to `[items]="fabSheetItems()"`.

**Step 3: Extend `onFabSheetSelect` switch**

Find the switch around line ~744. Add three cases above the existing `'new-folder'`/`'new-text'` cases:

```ts
case 'new-docx':
  this.newOfficeFile('docx')
  return
case 'new-xlsx':
  this.newOfficeFile('xlsx')
  return
case 'new-pptx':
  this.newOfficeFile('pptx')
  return
```

**Step 4: Build and verify**

Run: `cd frontend && npx ng build --configuration development`
Expected: build succeeds.

**Step 5: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts \
        frontend/src/app/applications/custom-v2/screens/personal/personal.component.html
git commit -m "feat(v2): mirror + New dropdown items in personal mobile FAB sheet"
```

---

## Task 7: Wire space-files screen — desktop dropdown + add New text file

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.html`

Same desktop wiring as Task 5, plus port `newTextFile()` from personal (currently absent here). No FAB sheet on this screen, so no FAB step.

**Step 1: Port `newTextFile()`**

Open `space-files.component.ts`. Find `newFolder()` at line ~650. Add a `newTextFile()` method directly below it, copy-pasted from `personal.component.ts:679–699`:

```ts
protected async newTextFile(): Promise<void> {
  const name = await this.promptDialog.open({
    title: 'New text file',
    placeholder: 'File name',
    submitLabel: 'Create',
    initialValue: 'Untitled.txt',
    selectionRange: 'stem',
    validate: (v) => this.validateEntryName(v)
  })
  if (!name) return
  const dirPath = this.currentUploadRoute()
  this.filesService.make('file', name.trim(), dirPath, true).subscribe({
    next: () => {
      this.toast.success(`File "${name.trim()}" created`)
      this.refresh()
    },
    error: (e: HttpErrorResponse) => {
      this.toast.error(e.error?.message ?? 'File creation failed')
    }
  })
}
```

Verify space-files has `promptDialog` injected and a `validateEntryName` helper. If `validateEntryName` is missing, port it too — the personal version is at line ~724:

```ts
private validateEntryName(v: string): string | null {
  const trimmed = v.trim()
  if (!trimmed) return 'Name is required'
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'Name cannot contain slashes'
  if (trimmed === '.' || trimmed === '..') return 'Invalid name'
  const existing = this.files().some((f) => f.name.toLowerCase() === trimmed.toLowerCase())
  if (existing) return 'A file or folder with this name already exists'
  return null
}
```

**Step 2: Add `+ New` state, handlers, helpers**

Same additions as Task 5 Steps 1–2, applied to `space-files.component.ts`:

- Imports: `buildNewEntryMenu`, `NewEntryId`, `ContextMenuAnchor`, `ContextMenuEntry`, `computed` from `@angular/core` if missing.
- Signals: `newMenuOpen`, `newMenuAnchor`, `newMenuItems` computed.
- Methods: `onNewMenuClick`, `dispatchNewEntry`, `newOfficeFile`, `uniqueName` — copy-paste from Task 5, identical bodies.

**Step 3: Replace the toolbar button in the template**

In `space-files.component.html` around line ~38 the current button is:

```html
<app-v2-btn kind="primary" size="sm" icon="plus" (click)="newFolder()">{{ 'New folder' | translate: locale.language }}</app-v2-btn>
```

Replace with the same wrapper-span pattern as Task 5:

```html
<span #newBtnAnchor class="space-files__new-anchor">
  <app-v2-btn kind="primary" size="sm" icon="plus" (click)="onNewMenuClick(newBtnAnchor)">
    {{ 'New' | translate: locale.language }}
  </app-v2-btn>
</span>
```

**Step 4: Add the context-menu element**

The existing row-right-click context-menu sits around line ~247. Add a sibling for the toolbar:

```html
<app-v2-context-menu
  [open]="newMenuOpen()"
  [anchor]="newMenuAnchor()"
  [items]="newMenuItems()"
  (closed)="newMenuOpen.set(false)"
/>
```

**Step 5: Add wrapper styles**

If `space-files.component.scss` exists, append:

```scss
.space-files__new-anchor {
  display: inline-flex;
}
```

**Step 6: Build and verify**

Run: `cd frontend && npx ng build --configuration development`
Expected: build succeeds.

**Step 7: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.html \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.scss
git commit -m "feat(v2): unify space-files toolbar under + New dropdown, add New text file"
```

(Drop the SCSS path from the `git add` if it doesn't exist.)

---

## Task 8: Manual smoke test + open PR

**Files:** None modified.

**Step 1: Start dev server**

Per the repo's standard development workflow — typically:

```bash
cd frontend && npm start
```

(Or, if both backend + frontend are needed: open the backend in a separate terminal too. Read `README.md` if unsure.)

**Step 2: Verification matrix**

With OnlyOffice **enabled** in the connected backend:

- [ ] Navigate to `/v2/personal`. Toolbar shows a single `+ New` button (icon plus + label "New" + chevron-down).
- [ ] Click `+ New`. Dropdown shows: Document, Spreadsheet, Presentation, divider, Folder, Text file.
- [ ] Click Document. A toast appears (`"Untitled.docx" created`); the OnlyOffice editor opens in the preview overlay; closing the overlay reveals the new row.
- [ ] Repeat for Spreadsheet → `Untitled.xlsx`, Presentation → `Untitled.pptx`.
- [ ] Click Document twice in a row (without renaming). The second creates `Untitled (2).docx`.
- [ ] Click Folder. The existing prompt opens, creates the folder.
- [ ] Click Text file. The existing prompt opens (default `Untitled.txt`), creates the file.
- [ ] Resize to mobile width. The FAB shows. Tap. Sheet shows the same six items + Download from URL + Upload.
- [ ] Tap Document on the sheet. Same flow as desktop.
- [ ] Navigate to `/v2/spaces/<any-space>`. Same dropdown, same actions, no FAB on space-files (out of scope).

With OnlyOffice **disabled**:

- [ ] Personal toolbar: `+ New` dropdown shows Folder, Text file (only). No divider.
- [ ] Space files toolbar: same.
- [ ] FAB sheet: Folder, Text file, divider, Download from URL, Upload.

Translation:

- [ ] Switch UI language to Dutch (`nl`). Dropdown labels: Document, Spreadsheet, Presentatie, Map, Tekstbestand. Button label: "Nieuw".

**Step 3: Push branch and open PR**

```bash
git push -u origin feat/v2-new-entry-menu
gh pr create --repo zjean/server --base main --head feat/v2-new-entry-menu \
  --title "feat(v2): unified + New entry menu with OnlyOffice document creation" \
  --body "$(cat <<'EOF'
## Summary

- Replaces the v2 toolbar's `New folder` / `New text file` buttons with a single `+ New` dropdown across both `personal` and `space-files` screens.
- Adds OnlyOffice-backed document creation (Document/Spreadsheet/Presentation) when the editor is enabled. Files auto-name as `Untitled.<ext>` (deduped) and open straight in the v2 preview overlay.
- Brings space-files in line with personal by adding the missing New text file action.
- Mobile FAB sheet on personal mirrors the same item set.

No backend changes — `POST /api/files/operation/make` already populates office files from bundled sample templates.

Design: `docs/plans/2026-04-30-v2-new-entry-menu-design.md`

## Test plan

- [ ] OnlyOffice enabled: Personal — `+ New` shows 5 items + 1 divider; Document/Spreadsheet/Presentation create files and open inline.
- [ ] OnlyOffice enabled: Space files — same as personal; New text file works.
- [ ] OnlyOffice disabled: dropdown shows Folder + Text file only; no divider.
- [ ] Mobile FAB sheet on Personal mirrors the dropdown.
- [ ] Filename collision: `Untitled (2).docx` produced when `Untitled.docx` exists.
- [ ] Dutch translation: Document, Spreadsheet, Presentatie, Tekstbestand, Nieuw.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 4: Verify PR landed on the fork (not upstream)**

```bash
gh pr view --repo zjean/server
```

Expected: shows the PR against `zjean/server`, base `main`, head `feat/v2-new-entry-menu`.

If a PR accidentally opened against `Sync-in/server`: close immediately with `gh pr close <n> --repo Sync-in/server --comment "wrong repo"` and reopen against `zjean/server`.

---

## Done criteria

- All eight tasks committed on `feat/v2-new-entry-menu`.
- `npx ng build --configuration development` passes after each task.
- Manual smoke matrix in Task 8 passes.
- PR opened against `zjean/server` (the fork), `test` workflow green.
