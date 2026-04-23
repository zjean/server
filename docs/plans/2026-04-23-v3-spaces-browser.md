# v3 spaces browser (milestone 4, phase 4.14)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Status**: drafted, approved-in-chat
**Date filed**: 2026-04-23
**Milestone**: [milestone 4](./2026-04-23-v3-ui-redesign-milestone4.md) — new phase 4.14 (added post-plan)
**Depends on**: 4.1 row menu (PR #32), 4.2 upload (PR #34), 4.3 new folder, 4.4 rename, 4.5 copy/move, 4.6 delete

## Why this phase exists

The original milestone-4 plan assumed the v2 file-ops surface would stay on `/v2/personal` and Spaces would remain a classic-only browser. But phase 4.5's tree picker surfaced the gap: users can now copy/move files *into* Space subfolders, but can't navigate to them in v2 to see what landed. That's a broken loop. This phase closes it.

## Goal

Browse any Space at `/v2/spaces/<alias>/<path…>` in v2, with the same file-ops parity as `/v2/personal`: upload, drop, new folder, row menu (open/download/rename/copy/move/share-deferred/delete).

## Non-goals for 4.14

- **Space management** — members, settings, disable/enable, delete-space — stays in classic. Admin rare-path.
- **Anchor-to-space** — dropping a file from Personal and linking it rather than copying. Not critical.
- **Per-space permission UI** — buttons enabled/disabled based on the viewer's role. The server rejects unauthorized ops; errors surface in the transfers popover. Good enough for MVP; can polish in milestone 5.
- **Trash view inside a Space** — `/spaces/trash/<alias>` remains classic until the separate "4.6½ trash bin detail" phase (see the 4.6 plan).
- **Shares inside a Space** — `/spaces/shares` remains classic.

## Scope-trim decision

**Duplicate, don't refactor (yet).** The obvious move is to rename `PersonalComponent` → `FileBrowserComponent` and parameterize by route data. Cleaner but touches upstream-adjacent code that many other screens could reuse in milestone 5. For 4.14 we clone `screens/personal/**` → `screens/space/**` and tweak the ~5 places that hard-code the Personal alias. Estimated ~450 LOC (mostly carried-over). **Follow-up phase** ("flatten personal + space into one browser") is noted but not scheduled.

## Architecture

- **New route**: `/v2/spaces/<alias>` + `/v2/spaces/<alias>/<path/**>` → `SpaceFilesComponent`.
- **`SpaceFilesComponent`** at `frontend/src/app/applications/custom-v2/screens/space/space-files.component.{ts,html,scss}` — a near-identical copy of `PersonalComponent` with:
  - `alias` derived from `route.params.alias`
  - All `SPACE_ALIAS.PERSONAL` uses swapped for the alias
  - Breadcrumb root changes from `{ label: 'Personal', icon: 'folder', route: ['/', V2_PATH, V2_ROUTES.PERSONAL] }` to `{ label: <space.name or alias>, icon: 'box', route: ['/', V2_PATH, V2_ROUTES.SPACES, alias] }`
  - Router navigation for drilling into subfolders uses `/v2/spaces/<alias>/<subs>`
- **`SpacesComponent.openSpace`** changes `router.navigate(['/spaces/files', space.alias])` → `router.navigate(['/', V2_PATH, V2_ROUTES.SPACES, space.alias])`.
- **Tree picker**: already allows Spaces children as selectable destinations (roots -1/-2 disabled, children resolve their own permissions). No picker change needed.

## Tasks

### Task 1 — Clone + parameterize component

**Files**:
- Copy `screens/personal/*` to `screens/space/space-files.component.{ts,html,scss}` (rename selector to `app-v2-space-files`).
- Replace `SPACE_ALIAS.PERSONAL` references with the route-derived alias.
- Update breadcrumb root label to the space name (or alias fallback).
- Update `openEntry` router targets for subfolder navigation.

**Commit**: `feat(v3): space-files component cloned from personal`

### Task 2 — Routes + spaces list wiring

**Files**:
- Modify `custom-v2/v2.routes.ts` — add the two space-files routes.
- Modify `custom-v2/screens/spaces/spaces.component.ts` — `openSpace` routes to v2.

**Commit**: `feat(v3): route /v2/spaces/:alias/** to v2 browser`

### Task 3 — i18n

A minimal add — most strings reuse existing keys. One or two "Loading space…" / "Failed to load space." variants if needed.

**Commit**: `feat(v3): i18n for spaces browser` (fold into task 1 or 2 if tiny)

## Manual test checklist

1. `/v2/spaces` list → click a space → lands at `/v2/spaces/<alias>` v2 browser (not classic)
2. List mode shows files and subfolders
3. New folder toolbar → creates folder in the Space
4. Upload via picker → file appears
5. Drop file on body → file appears
6. More menu on a row → all 7 items; Open navigates into subfolder; Download fetches file; Rename renames; Copy to… opens tree picker; Move to… moves; Delete confirms and deletes
7. Breadcrumb shows `Spaces > <space-name> > <sub>` and each segment navigates correctly
8. Navigation into subfolder → URL reflects path, list updates
9. Attempt an op you don't have permission for → error surfaces in transfers popover, doesn't crash
10. Dutch locale translates labels

## Follow-ups (NOT in 4.14)

- **Flatten PersonalComponent + SpaceFilesComponent** into a single parameterized browser. Good milestone-5 refactor.
- **Permission-aware UI** — disable Delete/Move/New folder if user lacks perms.
- Trash-inside-space view (bundled with the 4.6½ bin-detail phase).
- Shares-inside-space browsing.

## Open questions

1. **Breadcrumb root label** — use the space name (friendly) or the alias (technical)? Lean **name** with alias as title attr.
2. **Empty-state wording** — Personal says "This folder is empty." Does a Space need something richer ("This space has no files yet — upload or drag files here")? Lean **reuse** to keep diff small.
