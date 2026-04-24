# v3 multi-select + bulk operations (milestone 5, phase 5.7)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, not approved
**Date filed**: 2026-04-24
**Milestone**: [milestone 5](./2026-04-24-v3-ui-redesign-milestone5.md) — phase 5.7
**Depends on**: milestone 4 primitives (context menu, prompt-dialog, confirm-dialog, toast, tree picker, share-dialog, link-dialog)
**Unblocks**: admin screens (5.3–5.5) reuse the checkbox primitive and selection store

## Goal

> **A v2-only user can select N files on `/v2/personal` or `/v2/spaces/:alias`, then run Download, Share, Copy, Move, or Delete once on the whole selection.**

That's the shortfall relative to classic today: v2 is single-row-only. The toolbar's `Share` button is explicitly `[disabled]` with a "Coming soon" tooltip because it doesn't know what to share. This phase fills that in.

## Non-goals for 5.7

- **Cross-directory selection.** Classic clears the selection when you navigate; we do the same.
- **Selection persistence across reloads.** Fresh load starts empty.
- **Select-and-drag.** Drag-to-move between rows is a nice-to-have, not shipping here.
- **Bulk rename / bulk link-share.** Rename is inherently per-file (different names); link-share already creates one link per file via loop if needed — not worth a dedicated bulk flow.
- **Multi-select on `/v2/recents`, `/v2/shared/*`, `/v2/search`.** Out of scope — those views don't have toolbar actions today; adding selection there is a follow-up.
- **Multi-select on `/v2/trash`.** Restore/permanent-delete are the only actions and they already work one-at-a-time via row context menu. Can add in a follow-up if reviewers push for it.

## Classic reference (read this first)

The authoritative reference is `frontend/src/app/applications/spaces/components/spaces-browser.component.ts`. The model:

| Concern | Classic approach |
|---|---|
| Selection storage | `selection: FileModel[]` on the browser component; each `FileModel` has an `isSelected` boolean. Published to a store signal `filesSelection` for the selection-sidebar consumer. |
| Plain click | `updateSelection([file])` — replaces selection with a single item. |
| Shift-click | `selectRangeFiles(file)` — adds every row between current selection bounds and the clicked row (uses `scrollView.viewPortItems` for order). |
| Ctrl/Cmd-click | `modifySelection(file)` — toggle the clicked row in/out of the selection. |
| Right-click on unselected | `updateSelection([file])` first, then open menu (selection replaces). |
| Right-click on already-selected | Keep selection as-is, open menu. |
| Escape / click-on-empty | `updateSelection([])` — clear. |
| Multi-row actions | `delete(files: FileModel[])` already takes an array; `compress()` takes a DTO with a list of names; copy/move push onto a clipboard then paste. |

V2 should match these interactions exactly — they're the keyboard/mouse idiom users expect across file browsers (Finder, Explorer, Nautilus).

## Architecture

### 1. Selection store — component-local or shared signal

**Option A (recommended): component-local signal, published to a small shared service only if another screen needs it.**

```ts
// inside PersonalComponent / SpaceFilesComponent
protected readonly selection = signal<Set<number>>(new Set())    // file.id set
protected readonly hasSelection = computed(() => this.selection().size > 0)
protected readonly selectedFiles = computed(() =>
  this.files().filter(f => this.selection().has(f.id))
)
```

**Option B**: top-level `SelectionService` used by every browser screen.

I lean A. The selection clears on navigation anyway, and `/v2/personal` + `/v2/spaces/:alias` are the only two consumers. A shared service introduces cross-screen state that Option A avoids. If admin screens (5.3/5.5) end up wanting the same shape, extract to a generic service at that point.

### 2. Selection interactions — mouse, keyboard, or both

**Option A (recommended): mouse-first with a keyboard modifier set, checkbox for discoverability.**

Exactly the classic map: plain click = replace, shift = range, ctrl/cmd = toggle. Plus a row-hover checkbox (click = toggle, no modifiers) so users who don't know the shortcut can still multi-select. A header checkbox toggles select-all-visible.

**Option B**: checkbox-only, no click-to-select. Accessible but two-hand for power users; doesn't match Finder/Explorer.

**Option C**: click-to-select only, no checkbox. Classic's behavior; fast but undiscoverable.

I lean A. The checkbox is idle 95% of the time (hover-revealed) but rescues the 5% of users who never learn shift-click.

### 3. Toolbar surface — free-floating action bar or re-enable the existing toolbar

**Option A (recommended): re-enable the existing toolbar buttons, add Delete and Download.**

The `/v2/personal` toolbar already has `Share`, `New folder`, `Upload`, `New text file`, `Download from URL`. `Share` is `[disabled]` today. When a selection exists, we:

1. Enable `Share` and make it open the share-dialog targeting the selection (single or multi).
2. Show three new ghost buttons: `Download`, `Copy to…`, `Move to…`, `Delete`.
3. Show a selection-count label (`3 items · 12.4 MB`).

When the selection is empty, the toolbar reverts to its current shape.

**Option B**: floating action bar (like Drive/Dropbox) that slides in above the content when selection is non-empty. Prettier, more work. A full redesign of the toolbar layout; adds motion concerns.

I lean A. Matches what's already there, minimal visual churn, users see the buttons *before* they know multi-select exists — which teaches the feature.

### 4. Bulk download — one-by-one or server-side archive

**Option A (recommended): one-by-one when selection ≤ 1; server-side archive when ≥ 2.**

- 1 file → `downloadWithAnchor(file.dataUrl)` — single file, no archive.
- 2+ files → `filesService.compress({ name: 'selection', extension: '.tar.gz', files: [...] })` — creates an archive task; download link piped via the transfers popover.

Classic does exactly this.

**Option B**: always single-file loop (one `<a download>` per file). Browser will block most of the anchors; user gets surprise dialogs.

I lean A. The backend already supports it; classic already does it; transfers popover already shows archive progress.

### 5. Bulk copy / move — single-tree-picker call per operation

**Option A (recommended): one tree-picker session, one operation, loop client-side per file.**

The tree picker returns a destination. The frontend loops `filesService.copyMove` once per selected file. If one fails, other calls continue; failures are collected into a single toast at the end ("2 of 5 moved; 3 failed — see transfers popover").

**Option B**: open the tree picker once per file. Unacceptable UX.

**Option C**: add a backend endpoint that takes a list. Out of scope ("no new backend this milestone").

Option A it is.

### 6. Bulk delete — confirm-once, delete-loop

Same pattern as copy/move: one confirm-dialog (shows count + total size), then loop. Trash destination (soft delete).

### 7. Bulk share — single share-dialog for whole selection

The share-dialog opens once and the create-share loop runs against each file with the same member set. Like copy/move, partial failure → summary toast.

**Tricky edge case**: shares with different existing states. If 3 of 5 files already have shares, the dialog can't meaningfully "edit" all 5 at once — each has different members. For 5.7 we **block bulk share when any selected file already has a share**, with an inline message ("Some files are already shared — select unshared files only to bulk-share, or share individually"). Bulk-edit-existing-shares is a later milestone.

### 8. Backend bulk-copy/move question

Same as 5.5's decision: backend's `copyMove` endpoint takes one src + one dst. For now, loop client-side. If bulk operations on huge selections start showing UX problems, we'd add a backend `bulkCopyMove` endpoint — but that's strictly out of scope here.

## Tasks

Order reflects dependency chain and merge friction.

1. **Checkbox primitive.** `<app-v2-checkbox>` matching the form primitives extracted in milestone 4. Tri-state (checked / unchecked / indeterminate) for the header "select all" case. ~80 LOC + styles.

2. **Selection model in `/v2/personal`.** Add `selection` signal, `onRowClick(ev, file)`, `onRowContextMenu(ev, file)` that implement the plain/shift/ctrl/cmd-click rules per §2. Keyboard: Escape clears; Cmd-A selects all visible (list/grid/gallery differ here — for grid it's all tiles; no cross-page selection since the page is the whole folder). ~200 LOC.

3. **Row checkbox in list/grid/gallery.** Hover-revealed in list rows; always-visible when any selection is non-empty. Clicking toggles (no modifier logic — that's for the row-click handler). Header checkbox in list mode for select-all. ~150 LOC.

4. **Toolbar wiring.** Enable `Share` when `hasSelection()`, add `Download`, `Copy to…`, `Move to…`, `Delete` ghost buttons, add selection-count label. All buttons hidden/disabled when selection is empty. ~120 LOC.

5. **Bulk delete.** Reuse existing `ConfirmDialogService` — title, body shows count + total size, primary = "Delete". On confirm, loop `filesService.moveToTrash` (existing from 4.6). Collect failures, summary toast. ~80 LOC.

6. **Bulk download.** Single-file → existing `download()`. Multi → open a small "Archive name" prompt-dialog (default `selection-YYYY-MM-DD.tar.gz`), then `filesService.compress({ name, extension, files })`. Task is added to the transfers popover; the user gets the download from there. ~120 LOC.

7. **Bulk copy / move.** Reuse the tree picker from 4.5. On confirm-dst, loop `filesService.copyMove` per file. Summary toast. ~140 LOC.

8. **Bulk share.** Guard: if any selected file has an existing share, show an inline blocker with a clickable "select only unshared" link that filters selection to unshared files. Otherwise open share-dialog in "multi" mode — dialog shows count in title, one member-picker, on submit loops `createShare` per file. Summary toast. ~180 LOC.

9. **Port to `/v2/spaces/:alias`.** The same selection model and toolbar shape applied to the Spaces browser. ~250 LOC (mostly copy of the selection scaffolding; toolbar shape already matches).

10. **i18n.** New strings: `Selected`, `item(s)`, `of`, `Deselect all`, `Delete N items`, `Download N items`, `Share N items`, `Copy N items to…`, `Move N items to…`, `Some files are already shared`, progress summary strings. Add to `nl.json`. ~30 LOC of JSON.

11. **Manual test pass.** See the checklist below.

## Manual test checklist

1. **Plain click replaces selection.** Click row A → only A selected. Click row B → only B selected.
2. **Shift-click range.** Click A, shift-click D → A, B, C, D selected.
3. **Cmd/Ctrl-click toggle.** A selected, cmd-click C → A and C selected; cmd-click A again → only C.
4. **Click empty area.** Clears selection.
5. **Escape.** Clears selection.
6. **Cmd/Ctrl-A.** Selects every row in the current folder.
7. **Select-all checkbox (list view).** Header checkbox is tri-state. Click → selects all; click again → clears.
8. **Row checkbox hover.** Hovering a row reveals checkbox; clicking toggles that row's membership without touching modifier rules.
9. **Toolbar reacts.** Empty selection → `Share` disabled, bulk buttons hidden. Non-empty → all bulk buttons enabled, count label shows.
10. **Bulk delete.** Select 3 files → click Delete → confirm dialog shows "Delete 3 items (12.4 MB)?" → confirm → all move to trash, toast "3 items deleted".
11. **Bulk download, single file.** One file selected → Download → browser downloads that one file.
12. **Bulk download, multi.** Three files selected → Download → archive-name prompt → confirm → transfers popover shows compress task → when done, download link available.
13. **Bulk copy.** Select 2 files → Copy to… → tree picker → pick destination → both copied; toast "2 items copied".
14. **Bulk move.** Same flow with Move to….
15. **Bulk share — no existing shares.** Select 2 unshared files → Share → dialog "Share 2 items" → add member → save → both shared; toast "2 items shared".
16. **Bulk share blocked.** Select 1 shared + 2 unshared → Share → blocker message "Some files are already shared" with "select only unshared" CTA.
17. **Partial failure.** Mock one of a 5-file delete to 403 → toast reports "4 of 5 deleted; 1 failed — see transfers popover".
18. **Cross-folder navigation clears selection.** Select 2 files → click a folder to navigate in → new folder opens with empty selection.
19. **Dutch locale.** All new labels and toasts translate.
20. **Same flows on `/v2/spaces/:alias`.** Pick any space → repeat steps 1–16. Behavior identical.

## Open questions

1. **Tri-state header checkbox in grid/gallery view?** Grid/gallery have no column header. Options: (a) show the select-all checkbox in the toolbar instead, (b) limit select-all to list view. Lean (a).
2. **Selection indicator color.** Match share-dialog's "selected member" color, or introduce a new `--v2-selection` token? Lean: match existing, no new token.
3. **Keyboard `Delete` key binding.** Should pressing Delete with a non-empty selection trigger the bulk-delete flow? Lean: yes; matches Finder. Risk: easy to fat-finger. Mitigation: the existing confirm-dialog gates the action.
4. **Archive naming default.** `selection-YYYY-MM-DD.tar.gz`, `selection.tar.gz`, or `<current-folder-name>.tar.gz`? Lean: the last — reflects what the user is archiving.
5. **Trash-view multi-select.** In scope or deferred? Plan defers it (§Non-goals). Reviewers may push back.

## Estimated LOC

~1300 across frontend (plan says 900 in the milestone doc — this plan adjusts up to account for the spaces port).

## Risks and mitigations

- **Selection-state drift on refresh.** `refresh()` replaces `files()` — stale selections reference old objects. *Mitigation*: store selection as `Set<number>` of ids, not object references; `selectedFiles` computed re-filters on each `files()` emission.
- **Keyboard modifier parity across OS.** Mac uses Cmd, Windows/Linux use Ctrl. Classic handles both (`ev.ctrlKey || ev.metaKey`). *Mitigation*: same treatment everywhere.
- **Share-dialog not designed for multi.** `<app-v2-share-dialog>` takes one `file` today. *Mitigation*: extend its input to accept `files: FileSpace[]` (array of one is the degenerate case); rename the prop without breaking callers. Loop submit per file server-side.
- **Bulk-ops on a selection where files got moved/deleted externally.** Partial failure story in step 17 covers it — UI never blocks on consistency.
- **Long-running bulk copy on 100 files.** Classic has the same behavior (loops, shows per-file progress in transfers popover). *Mitigation*: cap selection at 500, show a dialog warning at ≥100 ("this may take a while"). Optional polish.

## Verification loop — did we match classic

Before submit, the test plan's "Dutch locale" step is the automated-ish one. The more important one: **diff the classic browser's selection interactions against v2's new ones in a side-by-side tab**. Classic is at `/spaces/...`, v2 at `/v2/spaces/:alias`. Cmd/Ctrl/Shift-click behavior must feel identical — anything off is a bug to fix before PR.

Per CLAUDE.md's "classic UI as ground truth" rule, this side-by-side diff is non-optional.
