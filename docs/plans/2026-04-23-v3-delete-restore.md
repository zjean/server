# v3 delete + restore (milestone 4, phase 4.6)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — phase 4.6
**Depends on**: 4.1 (context menu, merged as PR #32)

## The scope mismatch

The milestone-4 plan bundles four separate pieces into 4.6 at ~300 LOC:

1. Move-to-trash from list views (Personal / Spaces / Shared).
2. Permanent delete from list views.
3. Restore from `/v2/trash`.
4. Empty-trash from `/v2/trash`.

But when I opened the surfaces, items 2–4 all require a **per-bin file list view** (`/v2/trash/<alias>`) that doesn't exist in v2 yet. The current `/v2/trash` screen lists the top-level bins and, on click, punts each bin to `/spaces/trash/<alias>` (classic). The Restore button there is disabled with the tooltip *"Open a bin to restore items"* — which already admits the missing surface.

Building `/v2/trash/<alias>` — a file list that isn't Personal-shaped (columns differ: deleted-at, original-path, size; rows are `TrashedFile` not `FileProps`) — is its own ~400 LOC surface. Rolling it into 4.6 puts 4.6 closer to 700 LOC, which is too big for a clean squash-merge in this milestone's cadence.

## Proposed trim

**Keep in 4.6:**

- Confirm-dialog primitive (cross-cutting — §2 of milestone 4 already flags this).
- Delete-to-trash from `/v2/personal` context menu (wires the 4.1-introduced Delete item).
- Refresh + toast on success/error.

**Push to a new 4.6½ phase** (or defer to milestone 5, depending on your preference):

- `/v2/trash/<alias>` bin-detail view.
- Restore + permanent-delete per row.
- Empty-trash.

That gets 4.6 back to ~250 LOC (confirm primitive ~120, Delete wire-up ~80, toast stub ~50). The trashed items remain reachable via classic until the bin-detail phase lands.

## Out of scope for 4.6 entirely

- Multi-select / bulk delete. Classic has it, v2 doesn't yet; the milestone doc calls this out.
- Delete from Spaces / Shared row context menus. Those consumers don't exist yet (4.1 only wired Personal). They pick up the Delete item for free once their context menus are wired.

## Architecture

### Confirm-dialog primitive

**New component**: `custom-v2/components/confirm-dialog.component.ts`

Signature (props-driven, not template-projection — keeps the primitive trivial):

```ts
export interface ConfirmDialogOptions {
  title: string          // e.g. "Move to trash"
  message: string        // body text; supports {{name}} interpolation via translate pipe arg
  confirmLabel: string   // e.g. "Move to trash"
  cancelLabel?: string   // default "Cancel"
  kind?: 'default' | 'danger'   // danger styles the confirm red
}
```

Usage (promise-based, lives as a small helper service injecting a shared host):

```ts
const ok = await confirmDialog.open({
  title: 'Move to trash',
  message: 'Move <b>{{name}}</b> to trash?',
  confirmLabel: 'Move to trash',
  kind: 'danger'
})
if (!ok) return
```

**Mounting**: a single instance sits at the top-level v2 layout, driven by a `ConfirmDialogService` that exposes `open(opts): Promise<boolean>`. Avoid re-instantiating per consumer.

**Visual**: centered modal + backdrop, same palette as the existing Create Space modal (PR #26). Esc = cancel, backdrop-click = cancel, Enter = confirm (when focus is inside).

### Delete in the Personal row context menu

Already exists as a disabled item from 4.1. Flipping it:

```ts
{
  id: 'delete',
  label: 'Delete',
  icon: 'trash',
  kind: 'danger',
  action: () => this.confirmAndDelete(f)
}
```

`confirmAndDelete`:
1. Call `confirmDialog.open({...})`.
2. If confirmed, set `filesService.currentRoute` and build a `FileModel` stub from `FileProps`, call `filesService.delete([fileModel])`.
3. Classic `.delete()` sets `file.isBeingDeleted` and fires `http.delete(file.taskUrl)` — task appears in the transfers popover.
4. Use the same `pendingDropRefresh`-style drain-watcher introduced in 4.2 (extract it if necessary), or just refresh on `addTask` completion.

**Gotcha**: `FilesService.delete()` takes `FileModel[]`, not `FileProps[]`. Easiest path: construct a minimal `FileModel` shape with just the fields `.delete()` touches — `path` (via `taskUrl`), `name`, `isBeingDeleted` setter. Ugly but bounded.

**Cleaner path**: add a `deleteByPath(path: string, name: string)` method on `FilesService` that skips the `FileModel` construction. One line of mod; keep it if upstream-contrib potential exists.

I'd recommend the **stub FileModel** route for MVP (zero upstream touch) and switch to the `deleteByPath` approach only if the stub causes test surprises.

### Toast primitive

v2 has no toast yet. Milestone 4 §2 says "extract in 4.1 or 4.2 whichever lands first" — neither did. 4.6 is a natural home since the Delete success/error path is the first consumer.

**New component**: `custom-v2/components/toast-host.component.ts` + `toast.service.ts`. Queue of `{id, kind: 'success'|'error', message}`. Auto-dismiss after 3s. Single host mounted in the v2 layout shell.

Keep it tiny — ~80 LOC total.

## Tasks

### Task 1 — `toast` primitive

Files:
- Create `custom-v2/components/toast-host.component.ts`
- Create `custom-v2/components/toast.service.ts`
- Modify v2 layout shell to mount `<app-v2-toast-host/>`

Behavior:
- `toast.success('Moved to trash')` / `toast.error('Delete failed')`
- Top-right stack, max 3 visible; FIFO overflow.
- Esc dismisses all.

Commit: `feat(v3): toast primitive for v2 surfaces`

### Task 2 — `confirm-dialog` primitive

Files:
- Create `custom-v2/components/confirm-dialog.component.ts`
- Create `custom-v2/components/confirm-dialog.service.ts`
- Modify v2 layout shell to mount `<app-v2-confirm-dialog/>`
- Update `nl.json` with "Cancel", "Confirm" base labels (if missing).

Behavior as spec'd above.

Commit: `feat(v3): confirm-dialog primitive for v2 destructive actions`

### Task 3 — Wire Delete on `/v2/personal`

Files:
- Modify `screens/personal/personal.component.ts` — flip the Delete menu item, add `confirmAndDelete`, wire refresh after task drains.
- Modify `nl.json` — "Move to trash", "Move <b>{{name}}</b> to trash?".

Commit: `feat(v3): move-to-trash from /v2/personal row menu`

## Manual testing checklist

1. Click the `more` icon on a file row → menu opens, Delete is now **enabled** (red).
2. Click Delete → confirm dialog appears with the right title, message with filename interpolated.
3. Cancel / Esc / backdrop → dialog closes, file unchanged.
4. Confirm → file disappears from the list, toast "Moved to trash" appears, transfers popover shows a task.
5. File is now visible in classic `/spaces/trash/…` (verify by navigating there or via v2/trash → bin-row → classic).
6. Delete fails (e.g. server 500) → toast shows an error, file remains in list.
7. Delete a folder → same flow works (folder moves to trash).
8. Dutch locale → all labels translate, including the dialog title / message / confirm button.

## Follow-ups (explicitly NOT in 4.6)

- Phase 4.6½ (new): `/v2/trash/<alias>` bin-detail view, per-row Restore + Permanent-delete, bin-level Empty-trash.
- Delete from Spaces / Shared context menus — lands naturally when their context menus are wired.
- Multi-select + bulk delete — milestone 5 or later.

## Open questions

1. **Scope trim OK?** I think so — it keeps 4.6 shippable in a single tight PR and isolates the bin-detail surface as its own phase where it belongs. If you'd rather keep the bundle and land a ~700-LOC PR, say so and I'll expand.
2. **`deleteByPath` on `FilesService` vs FileModel stub?** Stub is zero-upstream-touch and keeps the blast radius local. `deleteByPath` is cleaner but a modification of an upstream file (needs `mod(files): ...` commit).
3. **Toast here or earlier?** 4.6 is the first consumer that needs it. Extracting here is fine; alternatively I can pull it into a tiny `feat/v3-toast` precursor PR if you prefer separation. Lean: keep it in 4.6, it's ~80 LOC.
