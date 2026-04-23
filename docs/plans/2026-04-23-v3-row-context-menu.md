# v3 row context menu

> **Superseded by [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md), where this is phase 4.1.**
> The milestone-4 plan folds this into the broader file-ops theme alongside upload / rename / copy-move / delete so the context-menu items can be built against real handlers instead of stubs. The tasks below still capture the initial primitive spec and stay a useful reference — keep them in mind when executing 4.1 — but the up-to-date roadmap lives in the milestone-4 doc.

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: superseded by milestone 4, phase 4.1
**Date filed**: 2026-04-23
**Related**: [milestone-3 plan](./2026-04-23-v3-ui-redesign-milestone3.md) — this gap was not in §1 of the plan

## Goal

Make the per-row `<app-v2-icon-btn iconName="more">` button in every v2 list surface open a context menu with at least Open / Download / Share / Delete actions. Today that button is decorative on every screen — clicking it does nothing.

## User-visible symptom

User reported: _"have no right click menu"_. The ellipsis button on file rows looks interactive but clicking it is a no-op. The browser's native right-click on a row also opens the OS menu, not an app menu.

## Affected surfaces

Every v2 list/table with a `more` icon-button in the row template. Search for `iconName="more"` in `frontend/src/app/applications/custom-v2/**` and you'll find them in:

- `screens/personal/personal.component.html` — list / grid / gallery file rows
- `screens/spaces/spaces.component.html` — space rows
- `screens/shared/shared.component.html` — share rows
- `screens/trash/trash.component.html` — bin rows
- `screens/file-detail/file-detail.component.html` — toolbar more button (different — opens a menu about the current file, not a row)

Personal is the primary consumer (files). Spaces/Shared/Trash have fewer relevant actions (maybe just Open). Start with Personal.

## Architecture

Build one reusable primitive and one consumer in this PR. Other surfaces adopt in follow-ups.

**New component**: `custom-v2/components/context-menu.component.ts`
- Inputs: `items: ContextMenuItem[]`, `open: boolean`, `anchor: { x: number; y: number } | null`
- Output: `closed: EventEmitter<void>`, plus each item has its own `(click)` handler
- `ContextMenuItem = { id: string; label: string; icon?: IconV2Name; kind?: 'default' | 'danger'; disabled?: boolean; action: () => void }`
- Renders a positioned overlay (`position: fixed` at `{x,y}`), outside-click dismiss + Esc dismiss (same pattern as `transfers-popover.component.ts`)
- ~120 LOC inline template + scss

**Wire into Personal rows** (list view first, then grid / gallery):
- Track a `menu` signal on the component: `{ file: FileProps; x: number; y: number } | null`
- Click on `<more>` icon button → stopPropagation, compute anchor from `MouseEvent.clientX/clientY`, set the signal
- Right-click on row (optional) → `(contextmenu)="openMenu($event, f)"` with `event.preventDefault()`
- Menu items (use the pattern from classic `frontend/src/app/applications/files/components/files-menu.component.ts`):
  - **Open** — dispatch to `openEntry(file)` (already exists)
  - **Download** — build `${API_FILES_OPERATION}/${encodeUrl(fullPath)}` and `window.open(...)`
  - **Share** — disabled for now with `[title]="'Coming soon'"`
  - **Delete** — disabled for now (destructive, wants confirm dialog)
- Wrap the wired items in `translate: locale.language` pipes and add Dutch translations to `nl.json`

## Out of scope

- Spaces / Shared / Trash row menus — wire in follow-ups once Personal is proven
- File-detail toolbar more menu — different semantics (single file, header context), spec separately
- Delete + Share handlers — need a confirm dialog primitive and share modal that don't exist yet in v2
- Keyboard navigation within the menu (arrow keys, Enter) — nice-to-have, skip for v1

---

## Task 1: Build `context-menu.component`

**Files:**
- Create: `frontend/src/app/applications/custom-v2/components/context-menu.component.ts`

**Shape:**
```ts
export interface ContextMenuItem {
  id: string
  label: string       // English-as-key; template pipes through translate
  icon?: IconV2Name
  kind?: 'default' | 'danger'
  disabled?: boolean
  action: () => void
}
```

**Behaviour:**
- Renders nothing when `open === false`
- When open, renders at `[style.left.px]="anchor?.x"` and `[style.top.px]="anchor?.y"` — clamp to viewport so a menu near the right/bottom edge flips
- `@HostListener('document:click')` + `@HostListener('window:keydown.escape')` emit `closed`
- Each item row is a `<button>` with icon + label; click fires `item.action()` then emits `closed`

**Commit:**
```bash
git add frontend/src/app/applications/custom-v2/components/context-menu.component.ts
git commit -m "feat(v3): reusable context menu primitive for v2 rows"
```

---

## Task 2: Wire into Personal

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.html`

**Component changes:**
- Import `ContextMenuComponent`, add to `imports`
- Add `menu = signal<{ file: FileProps; x: number; y: number } | null>(null)`
- Add `menuItems = computed<ContextMenuItem[]>(() => ...)` that builds items for `menu()?.file`
- Method `openRowMenu(ev: MouseEvent, f: FileProps)` that sets the signal from `ev.clientX/clientY`
- Method `closeMenu()` that clears the signal

**Template changes:**
- Replace the decorative `<app-v2-icon-btn iconName="more" [size]="26" />` in file-row with a click handler: `(click)="openRowMenu($event, f); $event.stopPropagation()"`
- Optionally add `(contextmenu)="openRowMenu($event, f); $event.preventDefault()"` to the row `<button>` itself
- Mount `<app-v2-context-menu [items]="menuItems()" [open]="menu() !== null" [anchor]="menu()" (closed)="closeMenu()" />` at the end of the template

**i18n:** Add keys to `nl.json` for any new strings (Open, Download already exist; Delete, Share already exist).

**Commit:**
```bash
git add frontend/src/app/applications/custom-v2/screens/personal/ frontend/src/i18n/nl.json
git commit -m "feat(v3): row context menu on /v2/personal with Open + Download"
```

---

## Manual testing checklist

After both tasks:

1. **Click `more` icon on a file row** — menu opens near the cursor with Open / Download (Share / Delete disabled with tooltip "Coming soon")
2. **Click Open** — navigates to file-detail (or viewer for images) for the right file
3. **Click Download** — browser begins downloading the right file
4. **Right-click a file row** (if contextmenu handler wired) — same menu opens, native OS menu suppressed
5. **Outside-click / Esc** — menu closes
6. **Menu near right edge of viewport** — doesn't clip off screen (flips or clamps)
7. **Clicking disabled item** — no-op
8. **Dutch locale** — all visible labels translate

## Follow-ups (out of scope here)

- Spaces / Shared / Trash row menus — minor effort once the primitive exists; each has a different action set
- File-detail toolbar more menu — single-file header context; different shape (probably a real dropdown under the more button, not a positioned overlay)
- Wire Share action — requires v2 share modal (none exists yet)
- Wire Delete action — requires v2 confirm dialog primitive (none exists yet)
- Keyboard navigation in the menu (arrow keys, Enter, Home/End)
