# v3 copy/move + tree picker (milestone 4, phase 4.5)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — phase 4.5
**Depends on**: 4.1 (context menu, PR #32), 4.6 (confirm-dialog + toast, PR #36)
**Unblocks**: 4.7 (share dialog member picker), 4.8 (link dialog destination), future anchor-to-space

Milestone 4 §5 explicitly calls this phase out as **"design twice, code once"** because the tree picker is reused across 4.7, 4.8 and future phases. This plan takes that seriously — the primitive shape and the overwrite flow are both decisions I'd like signed off before I commit to code.

## Goal

A non-admin user can Copy or Move a file from `/v2/personal` into any folder they have write access to, without leaving v2. Progress shows in the transfers popover; the source refreshes when the operation completes.

## Non-goals for 4.5

- **Multi-select source.** One file per operation. Classic supports multi-select; v2 doesn't have a selection model yet (milestone 5 or later per §4).
- **Copy/Move _to_ Spaces or Shares as the destination.** Picker includes those roots for navigation/lookup but writes go to Personal-only in 4.5. Full Spaces destination support comes when Spaces row context menus land.
- **New-folder button inside the picker.** Can't create a folder on the fly during a move; navigate there first. Polish item for 4.3's "New folder" work.
- **Drag-to-move between rows.** Nice-to-have, not critical.

## The three design choices I want you to sign off on

### 1. Tree widget — build our own or reuse classic's

**Option A (recommended): build a small v2-native tree in ~150-200 LOC.** Flat render with a depth-based indent, `<button class="tree-node">` rows, chevron for expand/collapse, `signal`-driven state. No library.

**Option B**: reuse `@ali-hm/angular-tree-component` (already a dep, used by classic `files-tree.component.ts`). Saves tree-rendering code but brings classic styling semantics that are hard to override cleanly with v2 tokens, and adds moving parts (TreeNode, TreeModel, actionMapping).

**Option C**: embed classic `FilesTreeComponent` inside a v2 modal shell. Zero reimplementation, but visually jarring — classic uses Bootstrap + FontAwesome, v2 uses custom v2 components; inside our shell they'd look alien.

**I lean Option A.** The tree UX we need is simpler than classic's (no copy/move toolbar inside the tree — that's on the dialog footer; no navigation-on-dblclick — just single-click-to-select). A focused ~150 LOC implementation is cleaner than fighting a library to look like v2.

### 2. Overwrite handling — reuse classic dialog, or v2 it

`FilesService.copyMove` already detects name collisions via `getTreeNode(dst, true)` and opens an ngx-bootstrap overwrite dialog via `openOverwriteDialog(exist)`. Two paths:

**Option A (recommended)**: call `filesService.copyMove(...)` as-is. If there's a collision, the classic overwrite dialog appears, and the flow continues. **Visually inconsistent for 30 seconds during the conflict, but zero new code** and the rest of the flow is pure v2.

**Option B**: detect collisions ourselves, show the v2 `ConfirmDialogService.open({kind:'danger', title:'Overwrite', ...})`, then call a lower-level copyMove that skips the classic dialog. Clean but requires an upstream `mod` to `FilesService.copyMove` to accept a `skipOverwriteDialog` flag.

**I lean Option A.** v2 polish for the overwrite case can come in 4.6½ or milestone 5. For now it's a rare edge case (user has to intentionally pick a dst with a name clash) and the classic dialog still _works_.

### 3. Copy + Move both enabled, or stage in

The row context menu (4.1) stubs Share and Delete. Neither Copy nor Move exist yet — we'd be adding two new menu items. Going in one shot (both at once, same tree picker) is natural; staging (Move now, Copy later) would mean two picker-consuming PRs.

**I lean all-at-once.** Same tree picker, two action labels. Cost difference is minimal.

## Architecture

### The picker primitive

**New**: `custom-v2/components/tree-picker.service.ts` + `tree-picker.component.ts`.

Service mirrors `ConfirmDialogService`:

```ts
interface TreePickerOptions {
  title: string
  submitLabel: string
  allowSpaces?: boolean      // default true
  allowShares?: boolean      // default true
  initialPath?: string        // e.g. files/personal — seeds the expanded-path
  disabledPath?: string       // e.g. the folder you're already in — greyed out
}
interface TreePickerResult {
  path: string                // e.g. files/personal/invoices
  name: string                // e.g. invoices
  mime: string
}
treePicker.open(opts): Promise<TreePickerResult | null>
```

Component:
- Full-screen backdrop (same pattern as `confirm-dialog.component`).
- Modal 420×520 (fixed), centered.
- Header: title + ✕ close button.
- Body: tree. Roots are Personal (id 0, path `files/personal`), Spaces (id -1, path `spaces` — toggled by `allowSpaces`), Shares (id -2, path `shares` — toggled by `allowShares`).
- Footer: selected-path hint line + `Cancel` / submit button (label from opts). Submit disabled until selection satisfies `permissions.includes('ADD')` and isn't `disabledPath`.

Tree rendering: flat list, each node has `depth`, `isExpanded`, `hasChildren`, `loading`. Click to select; click chevron to toggle. Children lazy-load via `filesService.getTreeNode(path, false)` (classic endpoint, reused as-is).

Reuse `FileTree` interface from backend. No new state store needed — all state lives in the component.

Inputs flow-down / selection-bubble-up only. No global signals.

### Wiring into Personal

Add two items to the `menuItems` computed in `personal.component.ts`:

```ts
{ id: 'copy', label: 'Copy to…', icon: 'clone', action: () => this.copyTo(f) },
{ id: 'move', label: 'Move to…', icon: 'arrowRight', action: () => this.moveTo(f) }
```

Handlers:

```ts
private async copyTo(file: FileProps): Promise<void> {
  const dst = await this.treePicker.open({
    title: 'Copy file',
    submitLabel: 'Copy here',
    disabledPath: this.currentUploadRoute()
  })
  if (!dst) return
  this.filesService.copyMove([stubFileModel(file)], dst.path, FILE_OPERATION.COPY)
    .catch(console.error)
  this.pendingDropRefresh = true  // re-use the same drain-watcher pattern
  this.toast.success(`Copying "${file.name}"…`)
}
```

`moveTo` is identical except `FILE_OPERATION.MOVE` and the toast wording.

`stubFileModel(file: FileProps)` builds the same `FileModel` duck-stub we used in 4.6 — `path`, `name`, `isBeingDeleted`, plus precomputed `encodedPath` and `taskUrl`.

**Icons**: v2 icon set doesn't have `clone` or `arrowRight`. Check `icon-v2.component.ts` — we have `copy`, `arrowUp/Down`, `chevRight`. Options:
- Use `arrowDown` for Move, something else for Copy — loose mapping.
- Add `copy` and `moveTo` icons. ~40 LOC of SVG.

I'd add two new icons to be right; this is the first consumer that really needs them.

## Task breakdown

### Task 1 — Tree picker primitive

**Files**:
- Create `custom-v2/components/tree-picker.service.ts` (~30 LOC)
- Create `custom-v2/components/tree-picker.component.ts` (~180 LOC inline template + styles)
- Mount `<app-v2-tree-picker/>` in `layout-v2.component.html`
- Add imports entry in `layout-v2.component.ts`

**Behavior**:
- Opens a centered modal with roots pre-loaded.
- Expands children on chevron click via `filesService.getTreeNode(path, false)`.
- Selection visible; submit disabled until valid (permissions, not disabledPath).
- Esc/Cancel/backdrop → resolves null.
- Submit → resolves `TreePickerResult`.
- Seeding: if `initialPath` provided, auto-expand the path so the containing folder is visible.

**Commit**: `feat(v3): tree-picker primitive for v2 destination selection`

### Task 2 — Icons for Copy / Move

**Files**:
- Modify `custom-v2/icons/icon-v2.component.ts` — add `copy` and `moveTo` names
- Modify `custom-v2/icons/icon-v2.component.html` — add SVG paths

**Commit**: `feat(v3): add copy + moveTo icons`

### Task 3 — Wire Copy / Move into Personal

**Files**:
- Modify `personal.component.ts` — inject `TreePickerService`, `FilesService`; add `copyTo`, `moveTo`, `stubFileModel`; flip Copy/Move into `menuItems`.
- Modify `nl.json` / `en.json` — `v3_copying_one`, `v3_moving_one`, `Copy to…`, `Move to…`, `Copy file`, `Move file`, `Copy here`, `Move here`.

**Commit**: `feat(v3): copy/move from /v2/personal via tree picker`

## Manual test checklist

1. Open `/v2/personal`, more-menu on a file → **Copy to…** and **Move to…** visible (no "Coming soon").
2. Click **Copy to…** → tree-picker dialog opens centered, Personal root expanded, submit disabled.
3. Click a subfolder → select it, submit enables, footer shows path.
4. Submit → dialog closes, transfers popover shows a COPY task, toast `Copying "X"…` appears, source list unchanged, destination (when navigated to) contains the copy.
5. **Move to…** — same flow but file disappears from source after task completes.
6. Cancel / Esc / backdrop-click → dialog closes, no action.
7. Try picking the **same folder** as the source — submit disabled, tooltip `Can't move into the same folder`.
8. Pick a destination with a name collision (upload a file with a duplicate name first) → classic overwrite dialog appears mid-flow → confirm → proceeds. (Option A ↑; this is the visual inconsistency.)
9. Navigate to Spaces root → expand → can see spaces but writing into them works only when permitted (permission check in `checkAllowed`).
10. Dutch locale → dialog labels, toasts, menu items translate.

## Follow-ups (explicitly NOT in 4.5)

- v2-native overwrite dialog (Option B above) — can live in a later polish phase.
- Multi-select-then-move/copy — waits on a v2 selection model.
- Drag-move between rows.
- Spaces destination row menus (would bring Copy/Move on Spaces list views too).
- Tree picker consumers: 4.7 share destination, 4.8 link destination — handled in those phases.

## Open questions

1. **Build vs. reuse the tree widget** — A / B / C above, I lean A.
2. **Overwrite flow** — classic dialog mid-v2-flow (A) or build v2 overwrite now (B), I lean A.
3. **Ship Copy + Move together** — yes/no, I lean yes.
4. **Icon additions** — add `copy` + `moveTo` to the v2 icon set now, or use close-fit approximations (e.g. `arrowRight` for Move, `copy` doesn't exist — so it has to be added)? I lean add both properly.

Default: A / A / yes / add icons.
